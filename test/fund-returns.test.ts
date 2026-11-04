// Fund returns by AMC: NAVs from AMFI's history files, returns per period, the AMC averages, filters and sorting, and
// the Excel and PDF files. AMFI is faked; no database.
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { test } from 'node:test';

const { navsOn, periodReturn, byAmc, sortRows, facets, matches, buildReturns, fundsOf } = await import('../src/fund-returns.ts');
const { xlsx, pdf, zip } = await import('../src/export-files.ts');
const { parseNavAll } = await import('../src/amfi.ts');

test("NAVs from a history file: each scheme's last NAV on or before the day, bad rows skipped", () => {
  const text = [
    'Scheme Code;NAV Name;Plan;Option;ISIN Div Payout/ISIN Growth;ISIN Div Reinvestment;Net Asset Value;Date',
    '',
    'Open Ended Schemes ( Equity Scheme - Large Cap Fund )',
    '100;A Fund;Direct Plan;Growth;INF000000001;;10.0000;01-Oct-2026',
    '100;A Fund;Direct Plan;Growth;INF000000001;;10.5000;03-Oct-2026',
    '100;A Fund;Direct Plan;Growth;INF000000001;;11.0000;05-Oct-2026',
    '200;B Fund;;;INF000000002;;N.A.;03-Oct-2026',
    '300;C Fund;;;INF000000003;;0;03-Oct-2026',
  ].join('\n');
  const m = navsOn(text, '2026-10-04');
  assert.deepEqual(m.get('100'), { nav: 10.5, date: '2026-10-03' }, 'the 5th is after the day');
  assert.equal(m.has('200'), false);
  assert.equal(m.has('300'), false);
});

test('returns: absolute up to a year, compounded beyond; null when too young or absurd', () => {
  assert.equal(periodReturn(100, 110, 1), 10);
  assert.equal(periodReturn(100, 121, 12), 21);
  assert.equal(periodReturn(100, 133.1, 36), 10);
  assert.equal(periodReturn(undefined, 110, 12), null);
  assert.equal(periodReturn(0.01, 500, 12), null, 'a 50,000% jump is a split, not a return');
});

const directory = parseNavAll([
  'Open Ended Schemes(Equity Scheme - Large Cap Fund)', 'Alpha Mutual Fund',
  '1;INF000000011;-;Alpha Large Cap Fund;Direct Plan;Growth Option;120.0000;03-Nov-2026',
  '2;INF000000012;-;Alpha Large Cap Fund;Regular Plan;IDCW Option;110.0000;03-Nov-2026',
  'Open Ended Schemes(Debt Scheme - Liquid Fund)', 'Beta Mutual Fund',
  '3;INF000000013;-;Beta Liquid Fund;Direct Plan;Growth Option;105.0000;03-Nov-2026',
  '4;INF000000014;-;Beta Old Fund;Direct Plan;Growth Option;50.0000;01-Jan-2026',
].join('\n'));

test('AMC rows average their funds per period; filters, facets and sorting', () => {
  const funds = fundsOf(directory, '2026-11-03');
  assert.deepEqual(funds.map((f) => f.amfiCode).sort(), ['1', '2', '3'], 'a fund with no NAV for a month is gone');
  const navs = new Map([
    ['1M', new Map([['1', { nav: 100, date: '' }], ['2', { nav: 100, date: '' }], ['3', { nav: 100, date: '' }]])],
    ['1Y', new Map([['1', { nav: 100, date: '' }]])],
  ]) as never;
  const rows = buildReturns(funds, navs);
  const alpha = rows.filter((f) => f.fundHouse === 'Alpha Mutual Fund');
  assert.deepEqual(alpha.map((f) => [f.plan, f.option]).sort(), [['Direct', 'Growth'], ['Regular', 'IDCW']]);

  const amcs = byAmc(rows);
  const a = amcs.find((r) => r.fundHouse === 'Alpha Mutual Fund')!;
  assert.equal(a.funds, 2);
  assert.equal(a.returns['1M'], 15, '(20 + 10) / 2');
  assert.equal(a.returns['1Y'], 20, 'only the fund old enough for it');
  assert.equal(a.counts['1Y'], 1);
  assert.equal(a.returns['10Y'], null);

  assert.deepEqual(sortRows(amcs, (r) => r.fundHouse, '1M', 'desc').map((r) => r.fundHouse), ['Alpha Mutual Fund', 'Beta Mutual Fund']);
  assert.deepEqual(sortRows(amcs, (r) => r.fundHouse, '1Y', 'asc').map((r) => r.fundHouse), ['Alpha Mutual Fund', 'Beta Mutual Fund'], 'a missing return sorts last');
  assert.deepEqual(sortRows(amcs, (r) => r.fundHouse, 'name', 'desc').map((r) => r.fundHouse), ['Beta Mutual Fund', 'Alpha Mutual Fund']);

  const filters = { plan: ['Direct'], assetClass: ['Equity'] };
  assert.deepEqual(rows.filter((f) => matches(f, filters)).map((f) => f.amfiCode), ['1']);
  const fc = facets(rows, filters);
  assert.deepEqual(fc.plan, [{ name: 'Direct', count: 1 }, { name: 'Regular', count: 1 }], 'a facet ignores its own filter');
  assert.deepEqual(fc.fundHouse, [{ name: 'Alpha Mutual Fund', count: 1 }]);
});

/** Reads a stored file back out of our own zip (enough to check the xlsx parts). */
function unzip(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i + 30 <= buf.length && buf.readUInt32LE(i) === 0x04034b50;) {
    const size = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString('utf8');
    const start = i + 30 + nameLen;
    out.set(name, inflateRawSync(buf.subarray(start, start + size)).toString('utf8'));
    i = start + size;
  }
  return out;
}

test('Excel: a valid workbook with the header, numbers as numbers and text escaped', () => {
  const book = xlsx('By AMC', ['Fund returns by AMC'], [
    { label: 'AMC', kind: 'text', width: 30 }, { label: '1 Year', kind: 'percent', width: 10 },
  ], [['Tata & Sons <AMC>', 12.5], ['Beta', null]]);
  const parts = unzip(book);
  assert.deepEqual([...parts.keys()].sort(), ['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']);
  const sheet = parts.get('xl/worksheets/sheet1.xml')!;
  assert.match(sheet, /Tata &amp; Sons &lt;AMC&gt;/);
  assert.match(sheet, /<c r="B4" s="3"><v>12.5<\/v><\/c>/);
  assert.match(sheet, /<c r="B5" s="3"\/>/, 'a missing return is an empty cell');
  assert.equal(zip([]).length, 22, 'an empty archive is just its end record');
});

test('PDF: a well-formed file with every row, typographic characters made safe', () => {
  const rows = Array.from({ length: 80 }, (_, i) => [i + 1, `AMC (${i}) – fund’s`, i % 2 ? -1.5 : 2.25]);
  const file = pdf('Fund returns by AMC', ['Notes'], [
    { label: 'S No', kind: 'count', width: 6 }, { label: 'AMC', kind: 'text', width: 40 }, { label: '1 Year', kind: 'percent', width: 10 },
  ], rows).toString('latin1');
  assert.ok(file.startsWith('%PDF-1.4') && file.trimEnd().endsWith('%%EOF'));
  assert.match(file, /\/Count 3 /, '80 rows run to three pages');
  assert.match(file, /AMC \\\(79\\\) - fund's/);
  assert.match(file, /-1\.50%/);
  assert.match(file, /\+2\.25%/);
  const xref = Number(file.match(/startxref\n(\d+)/)![1]);
  assert.equal(file.slice(xref, xref + 4), 'xref', 'the cross-reference offset points at the table');
});
