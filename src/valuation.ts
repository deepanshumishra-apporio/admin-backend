// Current values for the dashboard and investor list. Holdings are only available per investor and live from FP
// (slow), so a background job values every invested investor every 15 minutes and keeps just the totals in memory.
import { config } from './config.ts';
import { lists, mapLimit, portfolio, type UpFund, type UpHolding } from './upstream.ts';

export const AssetClasses = ['EQUITY', 'HYBRID', 'DEBT', 'OTHER'] as const;
export type AssetClass = (typeof AssetClasses)[number];
export const AssetClassLabels: Record<AssetClass, string> = { EQUITY: 'Equity', HYBRID: 'Hybrid', DEBT: 'Debt', OTHER: 'Other' };

/**
 * A fund's asset class from its AMFI category. Index funds go by what they track; solution-oriented funds
 * (retirement, children's) count as hybrid; fund of funds and commodity funds are "other".
 */
export function assetClassOf(fund: UpFund | null | undefined): AssetClass {
  const category = (fund?.category ?? '').toLowerCase();
  const sub = (fund?.sub_category ?? '').toLowerCase();
  if (category === 'equity') return 'EQUITY';
  if (category === 'debt') return 'DEBT';
  if (category === 'hybrid' || category === 'solution') return 'HYBRID';
  if (category === 'index') return /debt/.test(sub) ? 'DEBT' : /hybrid/.test(sub) ? 'HYBRID' : 'EQUITY';
  return 'OTHER';
}

export const isElss = (fund: UpFund | null | undefined): boolean => /elss|tax saver/i.test(`${fund?.sub_category ?? ''} ${fund?.name ?? ''}`);

/** One holding as the Total AUM page lists it: a scheme in a folio, valued at the last NAV. */
export type HoldingLine = {
  isin: string; folio: string; scheme: string; amc: string | null; assetClass: AssetClass;
  units: number; invested: number | null; current: number; navDate: string | null;
};

/**
 * What one investor holds, from the last valuation: the split by asset class, whether any of it is ELSS, the folios,
 * and each holding.
 */
export type Breakdown = { byClass: Record<AssetClass, number>; elss: boolean; folios: string[]; holdings: HoldingLine[] };

function breakdownOf(holdings: UpHolding[]): Breakdown {
  const byClass: Record<AssetClass, number> = { EQUITY: 0, HYBRID: 0, DEBT: 0, OTHER: 0 };
  let elss = false;
  const folios = new Set<string>();
  const lines: HoldingLine[] = [];
  for (const h of holdings) {
    const value = Number(h.current ?? 0);
    if (!(value > 0)) continue;
    const assetClass = assetClassOf(h.fund);
    byClass[assetClass] += value;
    if (isElss(h.fund)) elss = true;
    if (h.folio) folios.add(h.folio);
    lines.push({
      isin: h.isin, folio: h.folio, scheme: h.fund?.name ?? h.isin, amc: h.fund?.amc_short ?? h.fund?.amc ?? null, assetClass,
      units: Number(h.units ?? 0), invested: h.invested === null || h.invested === undefined ? null : Number(h.invested), current: value, navDate: h.nav_date ?? null,
    });
  }
  return { byClass, elss, folios: [...folios], holdings: lines };
}

const SystemActor = 'system:valuation';
let values = new Map<number, number>();
let breakdowns = new Map<number, Breakdown>();
let valuedAt: string | null = null;
let running: Promise<void> | null = null;

export const currentValues = (): Map<number, number> => values;
export const valuationAsOf = (): string | null => valuedAt;
export const currentBreakdowns = (): Map<number, Breakdown> => breakdowns;

async function refresh(): Promise<void> {
  const { investors, orders } = await lists(SystemActor, { fresh: true });
  const invested = new Set(orders.filter((o) => o.state === 'successful').map((o) => o.user_id));
  const targets = investors.filter((i) => invested.has(i.id));
  const next = new Map<number, number>();
  const nextBreakdowns = new Map<number, Breakdown>();
  await mapLimit(targets, 3, async (investor) => {
    try {
      const p = await portfolio(investor.id, SystemActor);
      next.set(investor.id, Number(p.summary?.current ?? 0));
      nextBreakdowns.set(investor.id, breakdownOf(p.holdings ?? []));
    } catch (error) {
      const previous = values.get(investor.id);
      if (previous !== undefined) next.set(investor.id, previous);
      const previousBreakdown = breakdowns.get(investor.id);
      if (previousBreakdown) nextBreakdowns.set(investor.id, previousBreakdown);
      console.error('[valuation] skipped an investor:', (error as Error).message);
    }
  });
  values = next;
  breakdowns = nextBreakdowns;
  valuedAt = new Date().toISOString();
}

export function refreshValuations(): Promise<void> {
  running ??= refresh().finally(() => (running = null));
  return running;
}

export function startValuationLoop(): void {
  const tick = () => refreshValuations().catch((error) => console.error('[valuation] failed:', (error as Error).message));
  setTimeout(tick, 5_000).unref();
  setInterval(tick, config.valuationIntervalMs).unref();
}
