// Fund returns by AMC: the 1 month to 10 year return of every fund RiSips sells through FintechPrimitives (the app
// backend's `/admin/v1/funds`), from AMFI's NAVs, grouped by fund house. AMFI publishes every fund's NAV for a date
// range in one file, so the NAV on each anniversary (today, 1M, 3M, 6M, 1Y, 3Y, 5Y, 10Y ago) is eight small downloads
// a day instead of one per fund. Public data only: nothing about an investor is sent or used.
import { amfiDirectory, classify, getText, isoDate, minusMonths, type AmfiFund } from './amfi.ts';
import { HttpError } from './http.ts';
import { upstream, type UpCatalogFund } from './upstream.ts';

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
  amfiCode: string; isin: string | null; name: string; fundHouse: string; assetClass: string; category: string; structure: string;
  plan: 'Direct' | 'Regular'; option: 'Growth' | 'IDCW'; nav: number; navDate: string;
  /** The first NAV the app has for the fund (FP funds only). */
  since: string | null;
  returns: Record<PeriodKey, number | null>;
};

/** A fund to work returns out for: AMFI's record of it, with the ISIN FP sells it under. */
export type ReportFund = AmfiFund & { isin: string | null; since: string | null };

/** Up to a year: the change in NAV. Beyond: compounded a year. Null when the fund is younger than the period. */
export function periodReturn(start: number | undefined, end: number, months: number): number | null {
  if (!start || start <= 0) return null;
  const r = months > 12 ? (Math.pow(end / start, 12 / months) - 1) * 100 : (end / start - 1) * 100;
  // A segregated portfolio or a unit-split shows as an absurd jump; it isn't a return.
  return Number.isFinite(r) && r > -100 && r < 5000 ? Math.round(r * 100) / 100 : null;
}

/** Every fund AMFI lists with a NAV in the last month, once each (AMFI lists a fund under two ISINs for IDCW). */
export function fundsOf(directory: Map<string, AmfiFund>, asOf: string): ReportFund[] {
  const cut = addDays(asOf, -31);
  const byCode = new Map<string, ReportFund>();
  for (const f of directory.values()) if (f.nav && f.navDate && f.navDate >= cut) byCode.set(f.amfiCode, { ...f, isin: null, since: null });
  return [...byCode.values()];
}

/**
 * The funds FP sells (the app backend's list), each matched to AMFI by ISIN for its fund house, SEBI category and
 * latest NAV. A fund AMFI doesn't list under that ISIN keeps FP's own details and AMFI code.
 */
export function fpFundsOf(fp: UpCatalogFund[], directory: Map<string, AmfiFund>): ReportFund[] {
  const byCode = new Map<string, ReportFund>();
  for (const f of fp) {
    const a = directory.get(String(f.isin).toUpperCase());
    const amfiCode = a?.amfiCode ?? String(f.amfi_code ?? '');
    if (!/^\d+$/.test(amfiCode) || byCode.has(amfiCode)) continue;
    const kind = a ?? classify(`Open Ended Schemes(${f.category ?? 'Other'} Scheme - ${f.sub_category ?? f.category ?? 'Other'})`);
    byCode.set(amfiCode, {
      amfiCode, name: f.name, fundHouse: a?.fundHouse || f.amc || 'Other',
      structure: kind.structure, assetClass: kind.assetClass, category: kind.category,
      plan: f.plan ?? a?.plan ?? null, option: f.option ?? a?.option ?? null,
      // AMFI's NAV is published each evening; FP's list carries the NAV from when the app last refreshed it.
      nav: a?.nav ?? f.nav ?? null, navDate: a?.navDate ?? f.nav_date ?? null,
      isin: f.isin, since: f.since ?? null,
    });
  }
  return [...byCode.values()].filter((f) => f.nav && f.navDate);
}

/**
 * A fund's NAV on each anniversary, newest first, must chain: a fund house that changed the face value (₹1,000 to
 * ₹10, as Navi Liquid did) or consolidated units shows as a fall of 99% or a jump of 50x between two anniversaries.
 * That isn't a return, so that period and every longer one are left out.
 */
export function chainedStarts(nav: number, starts: (number | undefined)[]): (number | undefined)[] {
  let newer = nav;
  let broken = false;
  return starts.map((start) => {
    if (broken || !start) return undefined;
    const ratio = newer / start;
    if (ratio < 0.25 || ratio > 8) {
      broken = true;
      return undefined;
    }
    newer = start;
    return start;
  });
}

export function buildReturns(funds: ReportFund[], navsByPeriod: Map<PeriodKey, Map<string, { nav: number; date: string }>>): FundReturn[] {
  return funds.map((f) => {
    const starts = chainedStarts(f.nav!, Periods.map((p) => navsByPeriod.get(p.key)?.get(f.amfiCode)?.nav));
    return {
      amfiCode: f.amfiCode, isin: f.isin, name: f.name, fundHouse: f.fundHouse, assetClass: f.assetClass, category: f.category, structure: f.structure,
      plan: f.plan && /direct/i.test(f.plan) ? 'Direct' : /direct/i.test(f.name) ? 'Direct' : 'Regular',
      option: /IDCW|dividend|payout|reinvest|bonus/i.test(`${f.option ?? ''} ${f.option ? '' : f.name}`) ? 'IDCW' : 'Growth',
      nav: f.nav!, navDate: f.navDate!, since: f.since,
      returns: Object.fromEntries(Periods.map((p, i) => [p.key, periodReturn(starts[i], f.nav!, p.months)])) as Record<PeriodKey, number | null>,
    };
  });
}

/** Which funds the report covers: FP's (normal), or every AMFI fund while the app backend has no fund list yet. */
export type FundSource = 'fp' | 'amfi';
export type Returns = { asOf: string; source: FundSource; funds: FundReturn[] };

/** FP's funds from the app backend; null from an app backend too old to have `/funds`. */
async function fpFunds(): Promise<UpCatalogFund[] | null> {
  try {
    return (await upstream<{ data: UpCatalogFund[] }>('/funds', 'system:fund-returns', 60_000)).data;
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return null;
    throw error;
  }
}

/** A real week of AMFI history has thousands of funds; fewer means AMFI sent an empty or cut-off file. */
export const MinFundsInHistory = 1_000;

/**
 * Each fund's NAV on or before `on`, from the week ending that day. AMFI sometimes answers 200 with an empty or cut-off
 * file: that is tried again, then refused, so a bad answer never becomes a day of blank columns (yesterday's stay).
 */
async function navsAround(on: string, tries = 3): Promise<Map<string, { nav: number; date: string }>> {
  let last = '';
  for (let i = 1; i <= tries; i++) {
    try {
      const navs = navsOn(await getText(HistoryUrl(addDays(on, -6), on), 120_000), on);
      if (navs.size >= MinFundsInHistory) return navs;
      last = `only ${navs.size} funds in AMFI's history for ${on}`;
    } catch (error) {
      last = (error as Error).message;
    }
    if (i < tries) await new Promise((resolve) => setTimeout(resolve, 5_000 * i));
  }
  throw new Error(last);
}

let cache: (Returns & { day: string }) | null = null;
let loading: Promise<Returns> | null = null;

/**
 * Every fund's returns as of AMFI's latest NAV date, worked out once a day (about a minute). Each period reads a
 * week of NAVs ending on its anniversary, so a holiday on the day itself still finds the NAV before it. Yesterday's
 * figures are served while today's are worked out, so a page never waits on AMFI once the first run is done.
 */
export function fundReturns(): Promise<Returns> {
  const today = new Date().toISOString().slice(0, 10);
  if (cache && cache.day === today) return Promise.resolve(cache);
  const refresh = refreshReturns(today);
  return cache ? Promise.resolve(cache) : refresh;
}

function refreshReturns(today: string): Promise<Returns> {
  loading ??= (async () => {
    const [directory, fp] = await Promise.all([amfiDirectory(), fpFunds()]);
    const asOf = [...directory.values()].map((f) => f.navDate ?? '').sort().at(-1) ?? today;
    if (!fp) console.warn('[fund-returns] the app backend has no /funds yet: showing every AMFI fund');
    const source: FundSource = fp ? 'fp' : 'amfi';
    const funds = fp ? fpFundsOf(fp, directory) : fundsOf(directory, asOf);
    const navsByPeriod = new Map<PeriodKey, Map<string, { nav: number; date: string }>>();
    // Two at a time: each file is 1-6 MB.
    const queue = [...Periods];
    await Promise.all([0, 1].map(async () => {
      for (let p = queue.shift(); p; p = queue.shift()) {
        const on = minusMonths(asOf, p.months);
        navsByPeriod.set(p.key, await navsAround(on));
      }
    }));
    const result = { day: today, asOf, source, funds: buildReturns(funds, navsByPeriod) };
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

export type AmcRow = {
  fundHouse: string; funds: number; returns: Record<PeriodKey, number | null>; counts: Record<PeriodKey, number>;
  /** The earliest first NAV among its funds (FP funds only): why a long period can have no figure. */
  since: string | null;
};

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
    const since = list.map((f) => f.since).filter((d): d is string => !!d).sort()[0] ?? null;
    return { fundHouse, funds: list.length, returns, counts, since };
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

/** How the figures are worked out, for the screen and the files. */
export const basis = (source: FundSource) =>
  `${source === 'fp' ? 'Funds: every fund RiSips sells through FintechPrimitives.' : 'Funds: every fund AMFI lists (the app backend sent no fund list).'} `
  + 'Up to 1 year: the change in NAV. 3, 5 and 10 years: compounded a year (CAGR). An AMC’s figure is the simple average of its funds’ returns, each period over the funds old enough for it. Source: AMFI NAVs.';
