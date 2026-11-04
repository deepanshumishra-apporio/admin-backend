// What NSE's scheme master doesn't say about a fund: its SEBI category and fund house (from AMFI's daily NAV file,
// matched to NSE's schemes by ISIN) and its NAV history, for the fund screen's chart and returns. AMFI publishes
// no history API, so history comes from mfapi.in, a free mirror of AMFI's NAVs keyed by AMFI's scheme code.
// Both are public data; nothing about a HUF or an investor is sent.

const DayMs = 86_400_000;
const NavAllUrl = 'https://portal.amfiindia.com/spages/NAVAll.txt';
const HistoryUrl = (code: string) => `https://api.mfapi.in/mf/${encodeURIComponent(code)}`;

export type AmfiFund = {
  amfiCode: string; name: string; fundHouse: string; structure: string; assetClass: string; category: string;
  plan: string | null; option: string | null; nav: number | null; navDate: string | null;
};

/** "Equity Scheme - Large Cap Fund" -> Equity / Large Cap Fund. AMFI's headings vary over the years; this folds them. */
export function classify(heading: string): { structure: string; assetClass: string; category: string } {
  const m = heading.match(/^(.*?)\s*Schemes?\s*\((.*)\)\s*$/i);
  const structure = (m?.[1] ?? '').replace(/ Fund$/i, '').trim() || 'Open Ended';
  const inner = (m?.[2] ?? heading).replace(/\*+/g, '').replace(/\s+/g, ' ').trim();
  const [head = '', ...rest] = inner.split(' - ');
  let category = (rest.join(' - ') || head).replace(/-\s*Tax Saver Fund/i, '(tax saver)').replace(/\s+/g, ' ').trim();
  if (/^ELSS/i.test(category)) category = 'ELSS (tax saver)';
  const assetClass =
    /ETF/i.test(inner) ? 'ETFs'
      : /Index Fund/i.test(inner) ? 'Index funds'
        : /Fund of Funds|FoF/i.test(inner) ? 'Fund of funds'
          : /Solution|Children|Retirement|Life Cycle/i.test(inner) ? 'Solution oriented'
            : /^Equity|^ELSS|^Growth/i.test(head) ? 'Equity'
              : /^Debt|^Income|^Gilt/i.test(head) ? 'Debt'
                : /^Hybrid/i.test(head) ? 'Hybrid'
                  : 'Other';
  return { structure, assetClass, category };
}

const amfiNum = (v: string | undefined): number | null => {
  const n = Number(String(v ?? '').replace(/,/g, '').trim());
  return v && Number.isFinite(n) && n > 0 ? n : null;
};

const Months: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

/** "02-Nov-2026" or "02-11-2026" -> 2026-11-02. */
export function isoDate(v: string | undefined): string | null {
  const m = String(v ?? '').trim().match(/^(\d{1,2})-([A-Za-z]{3}|\d{2})-(\d{4})$/);
  if (!m) return null;
  const month = /^\d+$/.test(m[2]!) ? m[2]! : Months[m[2]!.toLowerCase()];
  return month ? `${m[3]}-${month}-${m[1]!.padStart(2, '0')}` : null;
}

/**
 * AMFI's NAVAll.txt: a heading line per category ("Open Ended Schemes(Equity Scheme - Large Cap Fund)"), then a
 * fund house line, then `code;isin growth/payout;isin reinvest;name;plan;option;nav;date` rows. Keyed by ISIN.
 */
export function parseNavAll(text: string): Map<string, AmfiFund> {
  const out = new Map<string, AmfiFund>();
  let heading = classify('Open Ended Schemes(Other)');
  let fundHouse = '';
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('Scheme Code;')) continue;
    if (!line.includes(';')) {
      if (/Schemes?\s*\(/i.test(line)) heading = classify(line);
      else fundHouse = line;
      continue;
    }
    const c = line.split(';').map((x) => x.trim());
    // Older rows have no plan/option columns: code;isin;isin;name;nav;date.
    const wide = c.length >= 8;
    const fund: AmfiFund = {
      amfiCode: c[0] ?? '', name: c[3] ?? '', fundHouse, ...heading,
      plan: wide ? c[4] || null : null, option: wide ? c[5] || null : null,
      nav: amfiNum(wide ? c[6] : c[4]), navDate: isoDate(wide ? c[7] : c[5]),
    };
    if (!/^\d+$/.test(fund.amfiCode)) continue;
    for (const isin of [c[1], c[2]]) if (isin && /^INF[A-Z0-9]{9}$/i.test(isin)) out.set(isin.toUpperCase(), fund);
  }
  return out;
}

let directory: { at: number; byIsin: Map<string, AmfiFund> } | null = null;
let loadingDirectory: Promise<Map<string, AmfiFund>> | null = null;

export async function getText(url: string, timeoutMs = 30_000): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'text/plain, application/json' } });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.text();
}

/** AMFI's directory, by ISIN, downloaded at most once a day. An outage keeps yesterday's. */
export function amfiDirectory(): Promise<Map<string, AmfiFund>> {
  if (directory && Date.now() - directory.at < DayMs) return Promise.resolve(directory.byIsin);
  loadingDirectory ??= getText(NavAllUrl)
    .then((text) => {
      const byIsin = parseNavAll(text);
      if (!byIsin.size) throw new Error('AMFI sent an empty NAV file.');
      directory = { at: Date.now(), byIsin };
      return byIsin;
    })
    .catch((error: Error) => {
      if (directory) return directory.byIsin;
      throw error;
    })
    .finally(() => (loadingDirectory = null));
  return loadingDirectory;
}

/** The directory if it's already loaded or loads in time; an empty map otherwise, so a page never waits on AMFI. */
export async function amfiDirectoryOrEmpty(waitMs = 8_000): Promise<Map<string, AmfiFund>> {
  const empty = new Map<string, AmfiFund>();
  return Promise.race([amfiDirectory().catch(() => empty), new Promise<Map<string, AmfiFund>>((resolve) => setTimeout(() => resolve(empty), waitMs).unref())]);
}

// --- NAV history ------------------------------------------------------------------------------------------

/** [ISO date, NAV], oldest first. */
export type NavPoint = [string, number];

const histories = new Map<string, { at: number; points: NavPoint[] }>();
const HistoryTtlMs = 6 * 3_600_000;
const HistoryCacheSize = 300;

/** mfapi.in's answer, newest first, as points oldest first. Bad or duplicate dates are dropped. */
export function parseHistory(body: any): NavPoint[] {
  const seen = new Map<string, number>();
  for (const r of Array.isArray(body?.data) ? body.data : []) {
    const date = isoDate(r?.date);
    const nav = amfiNum(String(r?.nav ?? ''));
    if (date && nav) seen.set(date, nav);
  }
  return [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/** A fund's daily NAVs since launch, cached six hours. */
export async function navHistory(amfiCode: string): Promise<NavPoint[]> {
  const hit = histories.get(amfiCode);
  if (hit && Date.now() - hit.at < HistoryTtlMs) return hit.points;
  const points = parseHistory(JSON.parse(await getText(HistoryUrl(amfiCode), 15_000)));
  histories.delete(amfiCode);
  histories.set(amfiCode, { at: Date.now(), points });
  while (histories.size > HistoryCacheSize) histories.delete(histories.keys().next().value!);
  return points;
}

export type Returns = {
  /** Absolute % for periods up to a year, compounded yearly % beyond; null when the fund is younger. */
  periods: { key: string; label: string; percent: number | null; annualised: boolean }[];
  sinceLaunch: { percent: number; annualised: boolean; from: string } | null;
  high52: { nav: number; date: string } | null;
  low52: { nav: number; date: string } | null;
};

const Periods = [
  { key: '1M', label: '1 month', months: 1 }, { key: '3M', label: '3 months', months: 3 }, { key: '6M', label: '6 months', months: 6 },
  { key: '1Y', label: '1 year', months: 12 }, { key: '3Y', label: '3 years', months: 36 }, { key: '5Y', label: '5 years', months: 60 },
  { key: '10Y', label: '10 years', months: 120 },
] as const;

export const minusMonths = (iso: string, months: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
};
const round2 = (n: number) => Math.round(n * 100) / 100;
const growth = (from: number, to: number, years: number) => (years > 1 ? (Math.pow(to / from, 1 / years) - 1) * 100 : (to / from - 1) * 100);

/** The NAV on `date`, or the last one before it (a holiday); null when history starts after it. */
function navOn(points: NavPoint[], date: string): NavPoint | null {
  if (!points.length || points[0]![0] > date) return null;
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (points[mid]![0] <= date) lo = mid;
    else hi = mid - 1;
  }
  return points[lo]!;
}

export function returnsOf(points: NavPoint[]): Returns {
  const last = points.at(-1);
  if (!last) return { periods: Periods.map((p) => ({ key: p.key, label: p.label, percent: null, annualised: p.months > 12 })), sinceLaunch: null, high52: null, low52: null };
  const periods = Periods.map((p) => {
    const start = navOn(points, minusMonths(last[0], p.months));
    return { key: p.key, label: p.label, percent: start ? round2(growth(start[1], last[1], p.months / 12)) : null, annualised: p.months > 12 };
  });
  const first = points[0]!;
  const years = (Date.parse(last[0]) - Date.parse(first[0])) / (365.25 * DayMs);
  const yearAgo = minusMonths(last[0], 12);
  let high: NavPoint | null = null;
  let low: NavPoint | null = null;
  for (const p of points) {
    if (p[0] < yearAgo) continue;
    if (!high || p[1] > high[1]) high = p;
    if (!low || p[1] < low[1]) low = p;
  }
  return {
    periods,
    sinceLaunch: first[0] < last[0] ? { percent: round2(growth(first[1], last[1], years)), annualised: years > 1, from: first[0] } : null,
    high52: high ? { nav: high[1], date: high[0] } : null,
    low52: low ? { nav: low[1], date: low[0] } : null,
  };
}

/** At most `max` points for a chart: every day of the last year, then thinned evenly before it. */
export function thin(points: NavPoint[], max = 1500): NavPoint[] {
  if (points.length <= max) return points;
  const last = points.at(-1)![0];
  const cut = minusMonths(last, 12);
  const recent = points.filter((p) => p[0] >= cut);
  const older = points.filter((p) => p[0] < cut);
  const room = Math.max(50, max - recent.length);
  const step = older.length / room;
  const picked: NavPoint[] = [];
  for (let i = 0; i < older.length; i += step) picked.push(older[Math.floor(i)]!);
  return [...picked, ...recent];
}
