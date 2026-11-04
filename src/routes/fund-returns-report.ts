// The "Fund returns by AMC" report: 1 month to 10 year returns of every mutual fund, by fund house or fund by fund,
// with multi-select filters, on screen and as Excel or PDF (audited, like every report download).
import { audit, authenticate, need } from '../auth.ts';
import { Download, HttpError, type Router } from '../http.ts';
import { istDate } from '../map.ts';
import { pdf, xlsx, type ExportCell, type ExportColumn } from '../export-files.ts';
import {
  Basis, byAmc, facets, FilterKeys, fundReturns, matches, Periods, sortRows, type FilterKey, type FundReturn, type ReturnsQuery,
} from '../fund-returns.ts';

const FilterLabels: Record<FilterKey, string> = {
  fundHouse: 'AMC', assetClass: 'Asset class', category: 'Category', plan: 'Plan', option: 'Option', structure: 'Structure',
};

/** Filters arrive as `amc=A|B`; each value is checked against what the data has, so nothing odd gets through. */
function queryOf(q: URLSearchParams): ReturnsQuery {
  const filters: ReturnsQuery['filters'] = {};
  for (const k of FilterKeys) {
    const values = (q.get(k) ?? '').split('|').map((v) => v.trim()).filter(Boolean).slice(0, 200);
    if (values.length) filters[k] = values;
  }
  const sort = q.get('sort') ?? '';
  return {
    filters,
    group: q.get('group') === 'fund' ? 'fund' : 'amc',
    sort: Periods.some((p) => p.key === sort) ? sort : 'name',
    dir: q.get('dir') === 'desc' ? 'desc' : 'asc',
  };
}

async function load() {
  try {
    return await fundReturns();
  } catch (error) {
    throw new HttpError(502, 'AMFI_UNAVAILABLE', `AMFI's NAV data couldn't be read just now (${(error as Error).message}). Try again in a few minutes.`);
  }
}

function rowsFor(funds: FundReturn[], q: ReturnsQuery) {
  const chosen = funds.filter((f) => matches(f, q.filters));
  if (q.group === 'fund') {
    return { chosen, amcs: null, funds: sortRows(chosen, (f) => `${f.fundHouse} ${f.name}`, q.sort, q.dir) };
  }
  return { chosen, amcs: sortRows(byAmc(chosen), (r) => r.fundHouse, q.sort, q.dir), funds: null };
}

/** "AMC: HDFC, SBI · Plan: Direct": the filters in force, for the file's notes. */
const filterNote = (q: ReturnsQuery) =>
  FilterKeys.filter((k) => q.filters[k]?.length).map((k) => `${FilterLabels[k]}: ${q.filters[k]!.join(', ')}`).join(' · ') || 'All funds';

export function fundReturnsReportRoutes(router: Router): void {
  const full = authenticate('full');
  const read = need('reports.read');

  router.get('/reports/fund-returns', full, read, async (ctx) => {
    const q = queryOf(ctx.query);
    const { asOf, funds } = await load();
    const { chosen, amcs, funds: list } = rowsFor(funds, q);
    return {
      asOf, basis: Basis, query: q, periods: Periods.map((p) => ({ key: p.key, label: p.label })),
      totalFunds: chosen.length, totalAmcs: new Set(chosen.map((f) => f.fundHouse)).size,
      facets: facets(funds, q.filters),
      amcs,
      // A fund-by-fund view of every fund is a few thousand rows; the screen shows the first 500, the files have all.
      funds: list ? list.slice(0, 500) : null,
      truncated: list ? list.length > 500 : false,
    };
  });

  router.get('/reports/fund-returns/export', full, read, async (ctx) => {
    const q = queryOf(ctx.query);
    const format = ctx.query.get('format') === 'pdf' ? 'pdf' : 'xlsx';
    const { asOf, funds } = await load();
    const { chosen, amcs, funds: list } = rowsFor(funds, q);
    const percent = (label: string): ExportColumn => ({ label, kind: 'percent', width: 10 });
    const periods = Periods.map((p) => percent(p.label));
    let columns: ExportColumn[];
    let rows: ExportCell[][];
    if (amcs) {
      columns = [{ label: 'S No', kind: 'count', width: 6 }, { label: 'AMC', kind: 'text', width: 34 }, { label: 'Funds', kind: 'count', width: 7 }, ...periods];
      rows = amcs.map((r, i) => [i + 1, r.fundHouse, r.funds, ...Periods.map((p) => r.returns[p.key])]);
    } else {
      columns = [
        { label: 'S No', kind: 'count', width: 6 }, { label: 'Fund', kind: 'text', width: 40 }, { label: 'AMC', kind: 'text', width: 22 },
        { label: 'Category', kind: 'text', width: 18 }, { label: 'Plan', kind: 'text', width: 8 }, { label: 'Option', kind: 'text', width: 8 }, ...periods,
      ];
      rows = list!.map((f, i) => [i + 1, f.name, f.fundHouse, f.category, f.plan, f.option, ...Periods.map((p) => f.returns[p.key])]);
    }
    const title = amcs ? 'Fund returns by AMC' : 'Fund returns, fund by fund';
    const notes = [
      title,
      `NAVs as of ${asOf}. ${chosen.length} funds${amcs ? ` across ${amcs.length} AMCs` : ''}. ${filterNote(q)}.`,
      Basis,
    ];
    await audit(ctx, 'report.exported', 'fund-returns', { format, group: q.group, rows: rows.length, filters: q.filters });
    const name = `risips-fund-returns-${q.group === 'fund' ? 'by-fund' : 'by-amc'}-${istDate(Date.now())}`;
    return format === 'pdf'
      ? new Download(`${name}.pdf`, 'application/pdf', pdf(title, notes.slice(1), columns, rows))
      : new Download(`${name}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xlsx(amcs ? 'By AMC' : 'By fund', notes, columns, rows));
  });
}
