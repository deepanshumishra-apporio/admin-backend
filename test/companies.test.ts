// Company onboarding (tax status 04) against a fake NSE: the rules, the UCC and FATCA bodies NSE UAT accepted on
// 24 Nov 2026 (owners, a senior managing official, a listed company), the flow through the same routes as a HUF,
// the sync from NSE, and NEFT payment. Uses DATABASE_URL in a throwaway schema; NSE itself is never called.
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
process.env['DASHBOARD_PROXY_KEY'] = 'test-dashboard-key';
process.env['HUF_SYNC_FROM'] = '2026-11-20';

const { closeDb, migrate, run, one } = await import('../src/db.ts');
const { seedRoles } = await import('../src/auth.ts');
const { handle, Router } = await import('../src/http.ts');
const { hufRoutes, syncFromNse } = await import('../src/routes/hufs.ts');
const { newToken, tokenId, unseal } = await import('../src/security.ts');
const { setNseTransport } = await import('../src/nse/client.ts');
const { readHuf, hufUcc, hufFatca } = await import('../src/nse/huf.ts');
const { payByNeft } = await import('../src/nse/invest.ts');

const owner = (name: string, pan: string, holdingPct: string) => ({ name, pan, dateOfBirth: '1980-05-10', gender: 'M', fatherName: 'Mohan Sharma', category: 'UBO', holdingPct });
const company = {
  entityType: 'COMPANY', clientCode: 'RSPC000002', hufName: 'Testco  Private Limited', pan: 'aaact1878z', cin: 'U72200MH2015PTC123456',
  formedOn: '2015-04-01', placeOfFormation: 'Mumbai', natureOfBusiness: 'Software services', incomeSlab: '35', netWorthLakhs: '250', netWorthDate: '2026-03-31',
  email: 'Signatory@Testco.example', mobile: '9000000001', accountType: 'SB', accountNo: '50202519928667', accountNoConfirm: '50202519928667',
  ifsc: 'HDFC0000060', bankHolderName: 'TESTCO PRIVATE LIMITED', address1: '21 Business Park', address2: 'Andheri East', address3: '', city: 'Mumbai', state: 'MA', pincode: '400069',
  karta: { name: 'Ravi Sharma', pan: 'ABCPS1234K', dateOfBirth: '1980-05-10', gender: 'M', fatherName: 'Mohan Sharma' },
  signatoryDesignation: 'Director',
  owners: [owner('Ravi Sharma', 'ABCPS1234K', '40'), owner('Priya Mehta', 'BCDPM2345L', '35'), owner('Arun Nair', 'CDEPN3456M', '25')],
};
const consent = { ip: '203.0.113.10', at: '2026-11-24T05:00:00Z' };

// --- the fake NSE -------------------------------------------------------------------------------
const calls: { path: string; body: any }[] = [];
function fakeNse(path: string, body: any) {
  calls.push({ path, body });
  const reply = (b: unknown) => Promise.resolve({ status: 200, body: b });
  switch (path) {
    case 'reports/client_master_report':
      if (body.from_date) {
        return reply(body.from_date === '20-11-2026'
          ? { response_status: 'S', report_data: [
            { client_code: 'RSPC000001 ', tax_status: 'COMPANY', primary_holder_first_name: 'PORTAL CO PRIVATE LIMITED', primary_holder_pan: 'BBBCB1234B',
              primary_holder_dob_incorporation: '01/04/2010', account_type_1: 'CB', account_no_1: '1234567890', ifsc_code_1: 'HDFC0000060',
              address_1: '5 MAIN ROAD', city: 'MUMBAI', state: 'MAHARASHTRA', pincode: '400001', email: 'CO@EXAMPLE.COM', indian_mobile_no: '9999911111', created_at: '20/11/2026 02:11:33 PM' },
          ] }
          : { response_status: 'F', error_remark: 'No record(s) found.' });
      }
      if (body.pan) return reply({ response_status: 'F', error_remark: 'No record(s) found.' });
      return reply({ response_status: 'S', report_data: [{ client_code: body.client_code, bank_1_status: 'PENDING ' }] });
    case 'registration/CLIENTCOMMON': return reply({ reg_details: [{ reg_status: 'REG_SUCCESS', reg_remark: ' ' }] });
    case 'registration/FATCA_COMMON': return reply({ reg_details: [{ reg_status: 'REG_SUCCESS', reg_remark: 'FATCA DETAILS UPLOADED SUCCESSFULLY' }] });
    case 'reports/GET_LINK': return reply({ firstHolderLink: '', errorMessage: 'Invalid productType or productRefId.' });
    case 'reports/CLIENT_AUTHORIZATION': return reply({ response_status: 'S', error_remark: 'No record(s) found.' });
    case 'reports/FATCA_REPORT': return reply({ response_status: 'S', report_data: [
      { pan_rp: 'BBBCB1234B', createddatetime: '20/11/2026 03:00:00 PM', ubo_appl: 'Y', ubo_name: 'OWNER ONE', ubo_pan: 'AAAPO1111A', ubo_hol_pc: '60', ubo_categ: 'UBO', ubo_dob: '01/01/1970', ubo_gender: 'M',
        camsuploadstatus: 'NOT UPLOADED', camsresponsestatus: 'PENDING', kfinuploadstatus: 'NOT UPLOADED', kfinresponsestatus: 'PENDING' },
      { pan_rp: 'BBBCB1234B', createddatetime: '20/11/2026 03:00:00 PM', ubo_appl: 'Y', ubo_name: 'OWNER TWO', ubo_pan: 'AAAPT2222B', ubo_hol_pc: '40', ubo_categ: 'UBO', ubo_dob: '01/01/1975', ubo_gender: 'F',
        camsuploadstatus: 'NOT UPLOADED', camsresponsestatus: 'PENDING', kfinuploadstatus: 'NOT UPLOADED', kfinresponsestatus: 'PENDING' },
    ] });
    case 'reports/AOF_IMAGE_UPLOAD_REPORT': return reply({ response_status: 'F', error_remark: 'No record(s) found.' });
    case 'payments/purchase_payment': return reply({ ...body, status: 'Success', remark: 'Payment details updated.' });
    default: return Promise.reject(new Error(`unexpected NSE call ${path}`));
  }
}

let server: Server;
let base = '';
const tokens: Record<string, string> = {};
async function staff(name: string): Promise<void> {
  const id = randomBytes(8).toString('hex');
  const now = new Date().toISOString();
  await run('INSERT INTO staff (id, email, full_name, password_hash, must_change_password, created_at) VALUES (?, ?, ?, ?, 0, ?)', id, `${name}@risips.test`, name, 'x', now);
  await run("INSERT INTO staff_roles (staff_id, role_key) VALUES (?, 'OPERATIONS')", id);
  const token = newToken();
  await run("INSERT INTO sessions (id, staff_id, mfa_state, created_at, expires_at, last_seen_at) VALUES (?, ?, 'VERIFIED', ?, ?, ?)",
    tokenId(token), id, now, new Date(Date.now() + 3_600_000).toISOString(), now);
  tokens[name] = token;
}
async function call(who: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/api/v1/admin${path}`, {
    method, headers: { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: res.status === 204 ? null : ((await res.json()) as any) };
}

before(async () => {
  await migrate();
  await seedRoles();
  await staff('asha');
  await staff('vikram');
  setNseTransport(fakeNse as never);
  const router = new Router();
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

test('company rules: C PAN, current account in its name, signatory, 1-4 owners with holdings', () => {
  const ok = readHuf(company, { accountNoConfirm: company.accountNoConfirm });
  assert.deepEqual(ok.errors, {});
  assert.equal(ok.details.accountType, 'CB', 'a company banks on a current account');
  assert.equal(ok.details.hufName, 'TESTCO PRIVATE LIMITED');
  assert.equal(ok.details.coparceners.length, 0);

  const bad = readHuf({ ...company, pan: 'AAAPT1878Z', hufName: 'TESTCO HUF', bankHolderName: 'RAVI SHARMA', signatoryDesignation: '', cin: 'X1' });
  assert.deepEqual(Object.keys(bad.errors).sort(), ['bankHolderName', 'cin', 'hufName', 'pan', 'signatoryDesignation']);

  assert.ok(readHuf({ ...company, owners: [] }).errors['owners'], 'owners are required');
  const five = ['A', 'B', 'C', 'D', 'E'].map((l, i) => owner(`Owner ${l}`, `ABCP${l}123${i}K`, '20'));
  assert.match(readHuf({ ...company, owners: five }).errors['owners']!, /at most 4/);
  assert.match(readHuf({ ...company, owners: [owner('A', 'ABCPA1234K', '70'), owner('B', 'ABCPB1234K', '40')] }).errors['owners']!, /110%/);
  const smoAndOwner = [owner('A', 'ABCPA1234K', '30'), { ...owner('B', 'ABCPB1234K', ''), category: 'SMO', designation: 'MD' }];
  assert.match(readHuf({ ...company, owners: smoAndOwner }).errors['owners']!, /not both/);
  assert.ok(readHuf({ ...company, owners: [owner('A', 'AAACA1234K', '30')] }).errors['owners.0.pan'], "an owner's PAN is a person's");
  assert.deepEqual(readHuf({ ...company, owners: [{ ...owner('Sunil Verma', 'ABCPV1234K', ''), category: 'SMO', designation: 'Managing Director' }] }).errors, {});
  assert.deepEqual(readHuf({ ...company, owners: [], listed: { exchange: 'N', isin: 'INE002A01018' } }).errors, {});
  assert.ok(readHuf({ ...company, listed: { exchange: 'N', isin: 'XYZ' } }).errors['listed.isin']);
});

test('UCC and FATCA bodies for a company, as NSE UAT accepted them', () => {
  const { details } = readHuf(company);
  const ucc = hufUcc(details);
  assert.equal(ucc['tax_status'], '04');
  assert.equal(ucc['account_type_1'], 'CB');
  assert.equal(ucc['primary_holder_first_name'], 'TESTCO PRIVATE LIMITED');
  assert.equal(ucc['primary_holder_dob_incorporation'], '01/04/2015');
  const fatca = hufFatca(details, consent);
  assert.equal(fatca.tax_status, '04');
  assert.equal(fatca.addr_type, '4', 'registered office');
  assert.equal(fatca.ubo_appl, 'Y');
  assert.equal(fatca.ubo_count, '3');
  assert.deepEqual(fatca.ubo_details.map((u) => [u.ubo_pan, u.ubo_hol_pc, u.ubo_categ]), [['ABCPS1234K', '40', 'UBO'], ['BCDPM2345L', '35', 'UBO'], ['CDEPN3456M', '25', 'UBO']]);
  assert.equal(fatca.ubo_details[0]!.ubo_state, 'MH');

  const smo = hufFatca(readHuf({ ...company, owners: [{ ...owner('Sunil Verma', 'ABCPV1234K', ''), category: 'SMO', designation: 'Managing Director' }] }).details, consent);
  assert.equal(smo.ubo_details[0]!.ubo_categ, 'SMO');
  assert.equal(smo.ubo_details[0]!.ubo_smo_de, 'MANAGING DIRECTOR');
  assert.equal(smo.ubo_details[0]!.ubo_hol_pc, '');

  const listed = hufFatca(readHuf({ ...company, owners: [], listed: { exchange: 'N', isin: 'INE002A01018' } }).details, consent);
  assert.equal(listed.ubo_appl, 'N');
  assert.equal(listed.ubo_df, 'N');
  assert.equal(listed.ubo_exch, 'N');
  assert.equal(listed.ubo_isin, 'INE002A01018');
  assert.equal(listed.ubo_details.length, 0);

  // A HUF is unchanged: the karta is its one owner.
  const hufFatcaBody = hufFatca(readHuf({ ...company, entityType: 'HUF', hufName: 'XYZ HUF', pan: 'AAAHA1234A', bankHolderName: 'XYZ HUF' }).details, consent);
  assert.equal(hufFatcaBody.tax_status, '03');
  assert.equal(hufFatcaBody.addr_type, '1');
  assert.equal(hufFatcaBody.ubo_count, '1');
});

test('a company goes through the same onboarding: RSPC code, signatory consent, owners sent to NSE', async () => {
  let r = await call('asha', 'GET', '/hufs/options');
  assert.equal(r.json.data.nextClientCodes.COMPANY, 'RSPC000002', 'RSPC000001 was made on NSE’s portal');
  assert.equal(r.json.data.nextClientCodes.HUF, 'RSPH000003');

  r = await call('asha', 'POST', '/hufs', company);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const id = r.json.data.id;
  assert.equal(r.json.data.entityType, 'COMPANY');
  assert.equal(r.json.data.details.owners.length, 3);

  r = await call('asha', 'GET', '/hufs?type=COMPANY');
  assert.deepEqual(r.json.data.items.map((x: any) => x.clientCode), ['RSPC000002']);
  assert.equal((await call('asha', 'GET', '/hufs?type=HUF')).json.data.items.length, 0);
  assert.equal(r.json.data.counts.DRAFT, 1, 'counts are for companies only');
  assert.equal((await call('asha', 'GET', '/hufs?type=HUF')).json.data.counts.DRAFT, 0);

  r = await call('vikram', 'POST', `/hufs/${id}/approve`);
  assert.equal(r.status, 409);
  assert.match(r.json.error.message, /signatory/);

  const token = (await call('asha', 'POST', `/hufs/${id}/consent-link`)).json.data.token as string;
  r = await call(null, 'GET', `/public/huf-consent/${token}`);
  assert.equal(r.json.data.huf.entityType, 'COMPANY');
  assert.deepEqual(r.json.data.huf.owners.map((o: any) => [o.name, o.holdingPct]), [['RAVI SHARMA', '40'], ['PRIYA MEHTA', '35'], ['ARUN NAIR', '25']]);
  assert.ok(r.json.data.huf.owners.every((o: any) => o.pan.startsWith('•')), 'owner PANs are masked');
  await call(null, 'POST', `/public/huf-consent/${token}`, { agree: true }, { 'x-forwarded-for': '198.51.100.7' });

  r = await call('vikram', 'POST', `/hufs/${id}/approve`);
  assert.equal(r.json.data.status, 'AWAITING_KARTA', JSON.stringify(r.json));
  const ucc = calls.find((c) => c.path === 'registration/CLIENTCOMMON')!.body.reg_details[0];
  assert.equal(ucc.tax_status, '04');
  assert.equal(ucc.client_code, 'RSPC000002');
  const fatca = calls.find((c) => c.path === 'registration/FATCA_COMMON')!.body.reg_details[0];
  assert.equal(fatca.ubo_count, '3');
  assert.equal(fatca.ubo_details.length, 3);
  assert.equal(r.json.data.details.owners[0].pan, '••••••234K', 'masked once on NSE');

  r = await call('asha', 'POST', `/hufs/${id}/refresh`);
  // NSE refuses a company's order without the AOF (UAT 24 Nov 2026), so once it's on NSE that shows as a problem.
  assert.ok(r.json.data.problems.some((p: string) => /AOF signed by the authorised signatory/.test(p)), JSON.stringify(r.json.data.problems));
});

test('a company registered on NSE directly is found with its owners', async () => {
  const result = await syncFromNse(new Date('2026-11-20T00:00:00Z'));
  assert.deepEqual(result.imported, ['RSPC000001']);
  const row = await one<{ entity_type: string; details: string }>("SELECT entity_type, details FROM hufs WHERE client_code = 'RSPC000001'");
  assert.equal(row!.entity_type, 'COMPANY');
  const d = unseal<any>(row!.details);
  assert.equal(d.entityType, 'COMPANY');
  assert.deepEqual(d.owners.map((o: any) => [o.name, o.holdingPct]), [['OWNER ONE', '60'], ['OWNER TWO', '40']]);
  assert.equal(d.karta.name, '', 'the signatory is not in NSE’s reports');
});

test("NEFT payment sends NSE's accepted mode value and the UTR", async () => {
  const paid = await payByNeft('RSPC000002', '462960000631', 'HDFCR52026112412345678');
  assert.equal(paid.ok, true);
  const body = calls.filter((c) => c.path === 'payments/purchase_payment').at(-1)!.body;
  assert.equal(body.payment_mode, 'NEFT', 'UAT refuses RTGS/NEFT');
  assert.equal(body.neft_rtgs_utr_no, 'HDFCR52026112412345678');
  assert.equal(body.order_ids, '462960000631');
});
