// A HUF's investments against a fake NSE: scheme masters, holdings from allotments less redemptions, and placing a
// purchase, a mandate and a SIP. Uses DATABASE_URL in a throwaway schema; NSE itself is never called.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

process.env['DB_SCHEMA'] = `admin_test_${randomBytes(4).toString('hex')}`;
process.env['ADMIN_DATA_KEY'] = randomBytes(32).toString('base64');
process.env['NSE_BASE_URL'] = 'https://nseinvestuat.nseindia.com';
process.env['NSE_MEMBER_CODE'] = '1003364';
process.env['NSE_API_KEY_MEMBER'] = 'test-member-key';
process.env['NSE_API_SECRET_USER'] = 'test-secret';
process.env['NSE_EUIN'] = 'E696775';

const { closeDb, migrate, run } = await import('../src/db.ts');
const { seedRoles } = await import('../src/auth.ts');
const { handle, Router } = await import('../src/http.ts');
const { hufRoutes } = await import('../src/routes/hufs.ts');
const { hufInvestRoutes } = await import('../src/routes/huf-invest.ts');
const { newToken, tokenId, seal, newId } = await import('../src/security.ts');
const { setNseTransport } = await import('../src/nse/client.ts');
const { readHuf } = await import('../src/nse/huf.ts');
const { buildSchemes, sipProblem } = await import('../src/nse/invest.ts');

const Sch = [
  'UNIQUE SR NO|SCHEME CODE|RTA SCHEME CODE|AMC SCHEME CODE|ISIN|AMC CODE|SCHEME TYPE|PLAN TYPE|SCHEME NAME|PURCHASE ALLOWED|PURCHASE TRANSACTION MODE|NEW PURCHASE MIN AMOUNT|ADDITIONAL PURCHASE MIN AMOUNT|ADDITIONAL PURCHASE MAX AMOUNT|PURCHASE AMOUNT MULTIPLIER|PURCHASE CUTOFF TIME|REDEMPTION ALLOWED|REDEMPTION TRANSACTION MODE|REDEMPTION MIN QTY|REDEMPTION QTY MULTIPLIER|REDEMPTION MAX QTY|REDEMPTION MIN AMOUNT|REDEMPTION MAX AMOUNT|REDEMPTION AMOUNT MULTIPLIER|REDEMPTION CUTOFF TIME|RTA AGENT CODE|AMC ACTIVE FLAG|DIV REINVEST FLAG|SIP ALLOWED',
  '21596|RMFSCBP-GR|NFGP|NFGP|INF204K01IE3|NIPPONINDIAMUTUALFUND_MF|EQUITY|NORMAL|NIPPON INDIA INDEX FUND - NIFTY 50 PLAN - GROWTH OPTION|Y|DP|100|100|0|1|14:30:00|Y|DP|.001|.001|0|100|0|1|15:00:00|KARVY|Y|Z|Y',
  '23255|RMFSCBP-GR-L1|NFGP|NFGP|INF204K01IE3|NIPPONINDIAMUTUALFUND_MF|EQUITY|NORMAL|NIPPON INDIA INDEX FUND - NIFTY 50 PLAN - GROWTH OPTION|Y|DP|200000|200000|0|1|14:30:00|N|DP|.001|.001|0|100|0|1|15:00:00|KARVY|Y|Z|Y',
].join('\n');
const Nav = '2026-11-02|RMFSCBP-GR|NIPPON INDIA INDEX FUND - NIFTY 50 PLAN - GROWTH OPTION|NFGP|Z|INF204K01IE3|40.0000|KARVY';
const Sip = [
  'AMC_CODE|AMC_NAME|SCHEME_CODE|SCHEME_NAME|SCHEME_ISIN|SIP_TRANSACTION_MODE|SIP_FREQUENCY|SIP_DATES|SIP_MINIMUM_GAP|SIP_STATUS|SIP_MINIMUM_INSTALLMENT_AMOUNT|SIP_MAXIMUM_INSTALLMENT_AMOUNT|SIP_MULTIPLIER_AMOUNT|SIP_MINIMUM_INSTALLMENT_NUMBERS|SIP_MAXIMUM_INSTALLMENT_NUMBERS',
  'NIPPONINDIAMUTUALFUND_MF|NIPPON|RMFSCBP-GR|NIFTY 50|INF204K01IE3|DP|MONTHLY|1,5,10,15,20,25|7|Active|100|99999999|1|6|999',
].join('\n');

const calls: { path: string; body: any }[] = [];
let mandateStatus = 'PENDING';
function fakeNse(path: string, body: any) {
  calls.push({ path, body });
  const reply = (b: unknown) => Promise.resolve({ status: 200, body: b });
  const none = { response_status: 'F', error_remark: 'No record(s) found.' };
  switch (path) {
    case 'reports/MASTER_DOWNLOAD': return reply(body.file_type === 'SCH' ? Sch : body.file_type === 'NAV' ? Nav : Sip);
    case 'reports/ORDER_STATUS': return reply(body.from_date <= '2026-10-30' && body.to_date >= '2026-10-30'
      ? { response_status: 'S', report_data: [{ order_id: '463020217893', request_date: '30/10/2026', scheme_code: 'RMFSCBP-GR', scheme_name: 'NIPPON INDIA INDEX FUND', transaction_type: 'P', amount: '100', quantity: '-', folio_no: '477509747671', order_status: 'VALID', order_remark: 'ALLOTMENT DONE', order_type: 'NRM' }] }
      : none);
    case 'reports/ALLOTMENT_STATEMENT': return reply(body.from_date.endsWith('10-2026') || body.to_date.endsWith('10-2026') || body.to_date.endsWith('11-2026')
      ? { response_status: 'S', report_data: calls.filter((c) => c.path === 'reports/ALLOTMENT_STATEMENT').length === 1 ? [
        { orderno: '463020217893', orderdate: '2026-10-30', schemecode: 'RMFSCBP-GR', schemename: 'NIPPON INDIA INDEX FUND', foliono: '477509747671', allottednav: '39.1906', allottedqty: '2.5520', allotmentamt: '100.00', validflag: 'Y' },
        { orderno: '463020217894', orderdate: '2026-10-31', schemecode: 'RMFSCBP-GR', schemename: 'NIPPON INDIA INDEX FUND', foliono: '477509747671', allottednav: '39.0000', allottedqty: '1.0000', allotmentamt: '39.00', validflag: 'N' },
      ] : [] } : none);
    case 'reports/REDEMPTION_STATEMENT': return reply(none);
    case 'reports/XSIP_REG_REPORT': return reply(none);
    case 'reports/MANDATE_STATUS': return reply(calls.some((c) => c.path === 'registration/product/MANDATE')
      ? { response_status: 'S', report_data: [{ mandateId: '2026110310001', clientCode: 'RSPH000001', amount: '100000', status: mandateStatus, endDate: '01/11/2066', bankName: 'IOB' }] }
      : none);
    case 'transaction/NORMAL': return reply({ transaction_details: [{ trxn_status: 'TRXN SUCCESS', trxn_order_id: '463099999999', trxn_remark: ' ' }] });
    case 'registration/product/MANDATE': return reply({ reg_data: [{ reg_status: 'REG_SUCCESS', reg_id: '2026110310001', reg_remark: ' ' }] });
    case 'registration/product/XSIP': return reply({ reg_data: [{ reg_status: 'REG_SUCCESS', reg_id: '202611031000001', reg_remark: ' ' }] });
    case 'reports/GET_LINK': return reply({ firstHolderLink: `https://nseinvest.com/mf/${body.productType.toLowerCase()}`, errorMessage: '' });
    default: return Promise.reject(new Error(`unexpected NSE call ${path}`));
  }
}

let server: Server;
let base = '';
let token = '';
let hufId = '';

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api/v1/admin${path}`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

before(async () => {
  await migrate();
  await seedRoles();
  const staffId = randomBytes(8).toString('hex');
  const now = new Date().toISOString();
  await run('INSERT INTO staff (id, email, full_name, password_hash, must_change_password, created_at) VALUES (?, ?, ?, ?, 0, ?)', staffId, 'ops@risips.test', 'Ops', 'x', now);
  await run("INSERT INTO staff_roles (staff_id, role_key) VALUES (?, 'OPERATIONS')", staffId);
  token = newToken();
  await run("INSERT INTO sessions (id, staff_id, mfa_state, created_at, expires_at, last_seen_at) VALUES (?, ?, 'VERIFIED', ?, ?, ?)", tokenId(token), staffId, now, new Date(Date.now() + 3_600_000).toISOString(), now);
  const { details } = readHuf({
    clientCode: 'RSPH000001', hufName: 'PORTAL FAMILY HUF', pan: 'DDDHD1234D', formedOn: '2007-01-15', placeOfFormation: 'DELHI', natureOfBusiness: 'BUSINESS',
    incomeSlab: '34', netWorthLakhs: '40', netWorthDate: '2026-03-31', email: 'k@example.com', mobile: '9999911111', accountType: 'SB', accountNo: '1234567890',
    ifsc: 'IOBA0001234', bankHolderName: 'PORTAL FAMILY HUF', address1: '5 ROAD', city: 'DELHI', state: 'DL', pincode: '110001',
    karta: { name: 'KARTA', pan: 'DDDPD1234E', dateOfBirth: '1970-01-01', gender: 'M', fatherName: '' }, coparceners: [],
  });
  hufId = newId();
  const steps = { duplicateCheck: null, ucc: { ok: true, status: 'ON_NSE', remark: null, at: '2026-10-27T08:41:33.000Z' }, fatca: null };
  await run(`INSERT INTO hufs (id, client_code, huf_name, pan_masked, pan_hash, karta_name, details, status, steps, nse_status, source, created_at, updated_at)
    VALUES (?, 'RSPH000001', 'PORTAL FAMILY HUF', 'x', 'x', 'KARTA', ?, 'AWAITING_KARTA', ?, ?, 'NSE', '2026-10-27T08:41:33.000Z', ?)`,
    hufId, seal(details), JSON.stringify(steps), JSON.stringify({ bankStatus: 'PENDING', bankRemark: null, fatca: null, authorised: null, checkedAt: now }), now);
  setNseTransport(fakeNse as never);
  const router = new Router();
  hufInvestRoutes(router);
  hufRoutes(router);
  server = createServer((req, res) => void handle(router, '/api/v1/admin', req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  setNseTransport(null);
  server.close();
  await run(`DROP SCHEMA ${process.env['DB_SCHEMA']} CASCADE`);
  await closeDb();
});

test('scheme masters: L1 variants left out, NAV and SIP rules attached', () => {
  const s = buildSchemes(Sch, Nav, Sip);
  assert.equal(s.size, 1);
  const n = s.get('RMFSCBP-GR')!;
  assert.equal(n.minFresh, 100);
  assert.equal(n.nav, 40);
  assert.deepEqual(n.sip['MONTHLY']!.dates, [1, 5, 10, 15, 20, 25]);
  const soon = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  assert.match(sipProblem({ scheme: n, amount: 500, startDate: soon, installments: 12, mandateId: '1', mandateAmount: 100000, mandateEnd: null })!, /at least 7 days/);
  const ok = new Date(Date.now() + 40 * 86_400_000);
  ok.setUTCDate(10);
  assert.equal(sipProblem({ scheme: n, amount: 500, startDate: ok.toISOString().slice(0, 10), installments: 12, mandateId: '1', mandateAmount: 100000, mandateEnd: '2066-11-01' }), null);
  assert.match(sipProblem({ scheme: n, amount: 500, startDate: ok.toISOString().slice(0, 10), installments: 3, mandateId: '1', mandateAmount: 100000, mandateEnd: null })!, /At least 6/);
});

test('scheme search needs three letters and finds by name', async () => {
  assert.deepEqual((await call('GET', '/hufs/schemes?search=ni')).json.data, []);
  const r = await call('GET', '/hufs/schemes?search=nippon nifty');
  assert.equal(r.json.data[0].schemeCode, 'RMFSCBP-GR');
});

test("investments: orders and holdings from NSE's reports; investing waits for the bank check and the AOF", async () => {
  let r = await call('POST', `/hufs/${hufId}/investments/refresh`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const inv = r.json.data.investments;
  assert.equal(inv.orders[0].orderId, '463020217893');
  assert.equal(inv.holdings.length, 1, 'the invalid allotment is left out');
  assert.equal(inv.holdings[0].units, 2.552);
  assert.equal(inv.holdings[0].value, 102.08);
  assert.ok(calls.filter((c) => c.path === 'reports/ORDER_STATUS').every((c) => (Date.parse(c.body.to_date) - Date.parse(c.body.from_date)) / 86_400_000 <= 6));
  assert.match(r.json.data.block, /bank account/);
  assert.equal((await call('POST', `/hufs/${hufId}/purchase`, { schemeCode: 'RMFSCBP-GR', amount: 500 })).status, 409);

  await run('UPDATE hufs SET nse_status = ? WHERE id = ?', JSON.stringify({ bankStatus: 'ACTIVE', bankRemark: null, fatca: null, authorised: null,
    aof: { cams: { status: 'ACCEPTED', remark: null }, kfin: { status: 'ACCEPTED', remark: null }, uploadedAt: null }, checkedAt: new Date().toISOString() }), hufId);
  r = await call('GET', `/hufs/${hufId}/investments`);
  assert.equal(r.json.data.block, null);
});

test('a purchase: checked against the scheme, placed, and the karta gets the payment link', async () => {
  let r = await call('POST', `/hufs/${hufId}/purchase`, { schemeCode: 'RMFSCBP-GR', amount: 50 });
  assert.equal(r.status, 400);
  assert.match(r.json.error.message, /minimum first purchase/);
  r = await call('POST', `/hufs/${hufId}/purchase`, { schemeCode: 'RMFSCBP-GR', amount: 500 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const order = calls.filter((c) => c.path === 'transaction/NORMAL').at(-1)!.body.transaction_details[0];
  assert.equal(order.client_code, 'RSPH000001');
  assert.equal(order.trxn_type, 'P');
  assert.equal(order.buy_sell_type, 'FRESH');
  assert.equal(order.demat_physical, 'P');
  assert.equal(order.euin_number, 'E696775');
  assert.ok(order.member_unique_id.length <= 20);
  const placed = r.json.data.requests[0];
  assert.equal(placed.kind, 'PURCHASE');
  assert.equal(placed.nseId, '463099999999');
  assert.equal(placed.link, 'https://nseinvest.com/mf/pur');
  r = await call('POST', `/hufs/${hufId}/purchase`, { schemeCode: 'RMFSCBP-GR', amount: 500, folio: '477509747671' });
  assert.equal(calls.filter((c) => c.path === 'transaction/NORMAL').at(-1)!.body.transaction_details[0].buy_sell_type, 'ADDITIONAL');
});

test('a SIP needs an approved mandate; the mandate is eNACH on the HUF account', async () => {
  let r = await call('POST', `/hufs/${hufId}/mandate`, { amount: 100000 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const m = calls.filter((c) => c.path === 'registration/product/MANDATE').at(-1)!.body.reg_data[0];
  assert.equal(m.mandate_type, 'E');
  assert.equal(m.account_no, '1234567890');
  assert.equal(r.json.data.requests[0].link, 'https://nseinvest.com/mf/mandate_auth');

  const start = new Date(Date.now() + 40 * 86_400_000);
  start.setUTCDate(10);
  const sip = { schemeCode: 'RMFSCBP-GR', amount: 500, startDate: start.toISOString().slice(0, 10), installments: 12, mandateId: '2026110310001' };
  r = await call('POST', `/hufs/${hufId}/sip`, sip);
  assert.equal(r.status, 400, 'not approved by the bank yet');
  mandateStatus = 'APPROVED';
  r = await call('POST', `/hufs/${hufId}/sip`, sip);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const x = calls.filter((c) => c.path === 'registration/product/XSIP').at(-1)!.body.reg_data[0];
  assert.equal(x.xsip_mandate_id, '2026110310001');
  assert.equal(x.installment_no, '12');
  assert.equal(x.frequency_type, 'MONTHLY');
  assert.equal(r.json.data.requests[0].kind, 'SIP');
  assert.equal(r.json.data.requests[0].link, 'https://nseinvest.com/mf/xsip_reg');
});
