// Fund returns by AMC: every mutual fund's 1 month to 10 year return, from AMFI's NAVs, grouped by fund house.
// AMFI publishes every fund's NAV for a date range in one file, so the NAV on each anniversary (today, 1M, 3M, 6M,
// 1Y, 3Y, 5Y, 10Y ago) is eight small downloads a day instead of one per fund. Public data only: nothing about an
// investor is sent or used.
import { amfiDirectory, getText, isoDate, minusMonths, type AmfiFund } from './amfi.ts';

const DayMs = 86_400_000;
const HistoryUrl = (from: string, to: string) => `https://portal.amfiindia.com/DownloadNAVHistoryReport_Po.aspx?frmdt=${amfiDay(from)}&todt=${amfiDay(to)}`;
const Months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 2026-11-03 -> 03-Nov-2026, AMFI's date format. */
const amfiDay = (iso: string) => `${iso.slice(8, 10)}-${Months[Number(iso.slice(5, 7)) - 1]}-${iso.slice(0, 4)}`;
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DayMs).toISOString().slice(0, 10);

export const Periods = [
  { key: '1M', label: '1 month', months: 1 }, { key: '3M', label: '3 months', months: 3 }, { key: '6M', label: '6 months', months: 6 },
  { key: '1Y', label: '1 Year', months: 12 }, { key: '3Y', label: '3 Years', months: 36 }, { key: '5Y', label: '5 Years', months: 60 },
  { key: '10Y', label: '10 Years', months: 120 },
] as const;
export type PeriodKey = (typeof Periods)[number]['key'];

/**
 * NAVs from AMFI's history file for a date range: `code;name;plan;option;isin;isin;nav;date` rows between heading
 * lines. For each scheme, the last NAV on or before `onOrBefore` (a weekend or holiday has none).
 */
export function navsOn(text: string, onOrBefore: string): Map<string, { nav: number; date: string }> {
  const out = new Map<string, { nav: number; date: string }>();
  for (const line of String(text).split(/\r?\n/)) {
    const c = line.split(';');
    if (c.length < 8 || !/^\d+$/.test(c[0]!.trim())) continue;
    const nav = Number(String(c[6]).replace(/,/g, '').trim());
    const date = isoDate(c[7]?.trim());
    if (!date || date > onOrBefore || !Number.isFinite(nav) || nav <= 0) continue;
    const code = c[0]!.trim();
    const seen = out.get(code);
    if (!seen || seen.date < date) out.set(code, { nav, date });
  }
  return out;
}

export type FundReturn = {
  amfiCode: string; name: string; fundHouse: string; assetClass: string; category: string; structure: string;
  plan: 'Direct' | 'Regular'; option: 'Growth' | 'IDCW'; nav: number; navDate: string;
  returns: Record<PeriodKey, number | null>;
};

/** Up to a year: the change in NAV. Beyond: compounded a year. Null when the fund is younger than the period. */
export function periodReturn(start: number | undefined, end: number, months: number): number | null {
  if (!start || start <= 0) return null;
  const r = months > 12 ? (Math.pow(end / start, 12 / months) - 1) * 100 : (end / start - 1) * 100;
  // A segregated portfolio or a unit-split shows as an absurd jump; it isn't a return.
  return Number.isFinite(r) && r > -100 && r < 5000 ? Math.round(r * 100) / 100 : null;
}

/** Every fund AMFI lists with a NAV in the last month, once each (AMFI lists a fund under two ISINs for IDCW). */
export function fundsOf(directory: Map<string, AmfiFund>, asOf: string): AmfiFund[] {
  const cut = addDays(asOf, -31);
  const byCode = new Map<string, AmfiFund>();
  for (const f of directory.values()) if (f.nav && f.navDate && f.navDate >= cut) byCode.set(f.amfiCode, f);
  return [...byCode.values()];
}

export function buildReturns(funds: AmfiFund[], navsByPeriod: Map<PeriodKey, Map<string, { nav: number; date: string }>>): FundReturn[] {
  return funds.map((f) => ({
    amfiCode: f.amfiCode, name: f.name, fundHouse: f.fundHouse, assetClass: f.assetClass, category: f.category, structure: f.structure,
    plan: f.plan && /direct/i.test(f.plan) ? 'Direct' : /direct/i.test(f.name) ? 'Direct' : 'Regular',
    option: /IDCW|dividend|payout|reinvest|bonus/i.test(`${f.option ?? ''} ${f.option ? '' : f.name}`) ? 'IDCW' : 'Growth',
    nav: f.nav!, navDate: f.navDate!,
    returns: Object.fromEntries(Periods.map((p) => [p.key, periodReturn(navsByPeriod.get(p.key)?.get(f.amfiCode)?.nav, f.nav!, p.months)])) as Record<PeriodKey, number | null>,
  }));
}

let cache: { day: string; asOf: string; funds: FundReturn[] } | null = null;
let loading: Promise<{ asOf: string; funds: FundReturn[] }> | null = null;

/**
 * Every fund's returns as of AMFI's latest NAV date, worked out once a day (about 20 seconds). Each period reads a
 * week of NAVs ending on its anniversary, so a holiday on the day itself still finds the NAV before it. Yesterday's
 * figures are served while today's are worked out, so a page never waits on AMFI once the first run is done.
 */
export function fundReturns(): Promise<{ asOf: string; funds: FundReturn[] }> {
  const today = new Date().toISOString().slice(0, 10);
  if (cache && cache.day === today) return Promise.resolve(cache);
  const refresh = refreshReturns(today);
  return cache ? Promise.resolve(cache) : refresh;
}

function refreshReturns(today: string): Promise<{ asOf: string; funds: FundReturn[] }> {
  loading ??= (async () => {
    const directory = await amfiDirectory();
    const asOf = [...directory.values()].map((f) => f.navDate ?? '').sort().at(-1) ?? today;
    const funds = fundsOf(directory, asOf);
    const navsByPeriod = new Map<PeriodKey, Map<string, { nav: number; date: string }>>();
    // Two at a time: each file is 1-6 MB.
    const queue = [...Periods];
    await Promise.all([0, 1].map(async () => {
      for (let p = queue.shift(); p; p = queue.shift()) {
        const on = minusMonths(asOf, p.months);
        navsByPeriod.set(p.key, navsOn(await getText(HistoryUrl(addDays(on, -6), on), 90_000), on));
      }
    }));
    const result = { day: today, asOf, funds: buildReturns(funds, navsByPeriod) };
    cache = result;
    return result;
  })().finally(() => (loading = null));
  // A failed refresh keeps yesterday's figures; the next request tries again.
  loading.catch((error: Error) => console.error('[fund-returns] refresh failed:', error.message));
  return loading;
}

/** Works the returns out shortly after start and again each day, before anyone opens the report. */
export function startFundReturnsLoop(): void {
  const go = () => void fundReturns().catch(() => undefined);
  setTimeout(go, 20_000).unref();
  setInterval(go, 3_600_000).unref();
}

// --- the report ---------------------------------------------------------------------------------------------------

export const FilterKeys = ['fundHouse', 'assetClass', 'category', 'plan', 'option', 'structure'] as const;
export type FilterKey = (typeof FilterKeys)[number];
export type ReturnsQuery = { filters: Partial<Record<FilterKey, string[]>>; group: 'amc' | 'fund'; sort: string; dir: 'asc' | 'desc' };

export type AmcRow = { fundHouse: string; funds: number; returns: Record<PeriodKey, number | null>; counts: Record<PeriodKey, number> };

const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 100) / 100 : null);

/** One row per fund house: the simple average of its funds' returns, each period over the funds old enough for it. */
export function byAmc(funds: FundReturn[]): AmcRow[] {
  const groups = new Map<string, FundReturn[]>();
  for (const f of funds) groups.set(f.fundHouse, [...(groups.get(f.fundHouse) ?? []), f]);
  return [...groups].map(([fundHouse, list]) => {
    const returns = {} as Record<PeriodKey, number | null>;
    const counts = {} as Record<PeriodKey, number>;
    for (const p of Periods) {
      const xs = list.map((f) => f.returns[p.key]).filter((x): x is number => x !== null);
      returns[p.key] = mean(xs);
      counts[p.key] = xs.length;
    }
    return { fundHouse, funds: list.length, returns, counts };
  });
}

export function matches(f: FundReturn, filters: ReturnsQuery['filters'], skip?: FilterKey): boolean {
  return FilterKeys.every((k) => k === skip || !filters[k]?.length || filters[k]!.includes(String(f[k])));
}

/** Each value with how many funds have it, given the other filters: what the dashboard's multi-selects offer. */
export function facets(funds: FundReturn[], filters: ReturnsQuery['filters']) {
  return Object.fromEntries(FilterKeys.map((k) => {
    const counts = new Map<string, number>();
    for (const f of funds) if (matches(f, filters, k)) counts.set(String(f[k]), (counts.get(String(f[k])) ?? 0) + 1);
    // Keep a chosen value even when the other filters leave it no funds.
    for (const v of filters[k] ?? []) if (!counts.has(v)) counts.set(v, 0);
    return [k, [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name))];
  })) as Record<FilterKey, { name: string; count: number }[]>;
}

/** Sorts by a period's return (nulls last either way) or by name. */
export function sortRows<T extends { returns: Record<PeriodKey, number | null> }>(rows: T[], name: (r: T) => string, sort: string, dir: 'asc' | 'desc'): T[] {
  const period = Periods.find((p) => p.key === sort)?.key;
  const sign = dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    if (period) {
      const x = a.returns[period];
      const y = b.returns[period];
      if (x === null || y === null) return x === y ? name(a).localeCompare(name(b)) : x === null ? 1 : -1;
      if (x !== y) return (x - y) * sign;
    }
    return name(a).localeCompare(name(b)) * (period ? 1 : sign);
  });
}

export const Basis = 'Up to 1 year: the change in NAV. 3, 5 and 10 years: compounded a year (CAGR). An AMC’s figure is the simple average of its funds’ returns, each period over the funds old enough for it. Source: AMFI NAVs.';
