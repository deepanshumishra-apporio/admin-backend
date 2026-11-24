// Total AUM: every holding across investors (a scheme in a folio), valued at the last NAV by the valuation job, with the
// totals on top: AUM, investors holding anything, folios, schemes. Nothing here calls FP; it reads the last valuation.
import { audit, authenticate, need } from '../auth.ts';
import { Csv, listParam, page, pageParams, toCsv, type Ctx, type Router } from '../http.ts';
import { snapshot } from '../investors.ts';
import { istDate, money0 } from '../map.ts';
import { AssetClasses, AssetClassLabels, currentBreakdowns, valuationAsOf, type HoldingLine } from '../valuation.ts';

const Sorts = ['value_desc', 'value_asc', 'gain_desc', 'gain_asc', 'investor'] as const;

type Row = HoldingLine & { investor: { id: string; name: string | null; pan: string | null } };

async function rowsOf(ctx: Ctx): Promise<Row[]> {
  const snap = await snapshot(ctx);
  const out: Row[] = [];
  for (const [userId, b] of currentBreakdowns()) {
    const f = snap.byExtId.get(String(userId));
    if (!f || f.status === 'DELETED') continue;
    for (const h of b.holdings ?? []) out.push({ ...h, investor: { id: f.id, name: f.up.name, pan: f.up.pan_masked } });
  }
  return out;
}

const gainPct = (r: Row): number | null => (r.invested && r.invested > 0 ? ((r.current - r.invested) / r.invested) * 100 : null);

function filtered(rows: Row[], q: URLSearchParams): Row[] {
  const search = q.get('search')?.trim().toLowerCase();
  const classes = listParam(q, 'assetClass', AssetClasses);
  const amc = q.get('amc')?.trim();
  const out = rows.filter((r) => {
    if (classes.length && !classes.includes(r.assetClass)) return false;
    if (amc && r.amc !== amc) return false;
    if (search && ![r.investor.name, r.investor.pan, r.folio, r.scheme, r.isin, r.amc].filter(Boolean).join(' ').toLowerCase().includes(search)) return false;
    return true;
  });
  const sort = (Sorts as readonly string[]).includes(q.get('sort') ?? '') ? q.get('sort') : 'value_desc';
  const g = (r: Row) => gainPct(r) ?? -Infinity;
  return out.sort((a, b) =>
    sort === 'value_asc' ? a.current - b.current
      : sort === 'gain_desc' ? g(b) - g(a)
        : sort === 'gain_asc' ? g(a) - g(b)
          : sort === 'investor' ? (a.investor.name ?? '').localeCompare(b.investor.name ?? '') || b.current - a.current
            : b.current - a.current);
}

const view = (r: Row) => ({
  investor: r.investor,
  folio: r.folio,
  scheme: r.scheme,
  isin: r.isin,
  amc: r.amc,
  assetClass: r.assetClass,
  units: r.units.toFixed(3),
  invested: r.invested === null ? null : money0(r.invested),
  current: money0(r.current),
  gainPercent: gainPct(r) === null ? null : Math.round(gainPct(r)! * 100) / 100,
  navDate: r.navDate,
});

export function aumRoutes(router: Router): void {
  const full = authenticate('full');
  const read = need('dashboard.read');

  /** The cards: AUM, investors with AUM, folios and schemes, for the filters shown (all holdings with none). */
  router.get('/aum/summary', full, read, async (ctx) => {
    const all = await rowsOf(ctx);
    const rows = filtered(all, ctx.query);
    return {
      aum: money0(rows.reduce((s, r) => s + r.current, 0)),
      invested: money0(rows.reduce((s, r) => s + (r.invested ?? 0), 0)),
      investors: new Set(rows.map((r) => r.investor.id)).size,
      folios: new Set(rows.map((r) => `${r.investor.id}:${r.folio}`)).size,
      schemes: new Set(rows.map((r) => r.isin)).size,
      amcs: [...new Set(all.map((r) => r.amc).filter((a): a is string => !!a))].sort(),
      assetClasses: AssetClasses.map((key) => ({ key, label: AssetClassLabels[key] })),
      valuedAt: valuationAsOf(),
    };
  });

  router.get('/aum', full, read, async (ctx) => {
    const rows = filtered(await rowsOf(ctx), ctx.query);
    const { offset, limit } = pageParams(ctx.query, 10, 100);
    const result = page(rows, offset, limit);
    return { items: result.items.map(view), total: rows.length, offset, nextCursor: result.nextCursor };
  });

  router.get('/aum/export', full, read, async (ctx) => {
    const rows = filtered(await rowsOf(ctx), ctx.query).map((r) => {
      const v = view(r);
      return { ...v, investor: r.investor.name ?? '', pan: r.investor.pan ?? '', assetClass: AssetClassLabels[r.assetClass] };
    });
    await audit(ctx, 'aum.exported', null, { rows: rows.length, filters: Object.fromEntries(ctx.query) });
    return new Csv(`risips-aum-${istDate(Date.now())}.csv`, toCsv([
      { key: 'investor', label: 'Investor' }, { key: 'pan', label: 'PAN (masked)' }, { key: 'folio', label: 'Folio' },
      { key: 'scheme', label: 'Scheme' }, { key: 'isin', label: 'ISIN' }, { key: 'amc', label: 'AMC' }, { key: 'assetClass', label: 'Asset class' },
      { key: 'units', label: 'Units' }, { key: 'invested', label: 'Invested (₹)' }, { key: 'current', label: 'Current value (₹)' },
      { key: 'gainPercent', label: 'Gain / loss (%)' }, { key: 'navDate', label: 'NAV date' },
    ], rows));
  });
}
