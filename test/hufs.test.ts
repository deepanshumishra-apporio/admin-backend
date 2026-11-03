// HUF onboarding end to end against a fake NSE: draft -> consent link -> the karta agrees -> a colleague approves ->
// UCC + FATCA -> refresh. Uses DATABASE_URL in a throwaway schema; NSE itself is never called.
import assert from 'node:assert/strict';
import { createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

process.env['DB_SCHEMA'] = `admin_test_${randomBytes(4).toString('hex')}`;
process.env['ADMIN_DATA_KEY'] = randomBytes(32).toString('base64');
process.env['NSE_BASE_URL'] = 'https://nseinvestuat.nseindia.com';
process.env['NSE_MEMBER_CODE'] = '1003364';
process.env['NSE_API_KEY_MEMBER'] = 'test-member-key';
process.env['NSE_API_SECRET_USER'] = 'test-secret';
process.env['DASHBOARD_PROXY_KEY'] = 'test-dashboard-key';

const { closeDb, migrate, run, one } = await import('../src/db.ts');
const { seedRoles } = await import('../src/auth.ts');
const { handle, Router } = await import('../src/http.ts');
const { hufRoutes } = await import('../src/routes/hufs.ts');
const { newToken, tokenId, seal, unseal } = await import('../src/security.ts');
const { encryptPassword, setNseTransport } = await import('../src/nse/client.ts');
const { readHuf, hufUcc, hufFatca, fatcaLogName, registrarStatus } = await import('../src/nse/huf.ts');

const huf = {
  clientCode: 'RSPH000003', hufName: 'Xyz  Huf', pan: 'aaaha1234a', formedOn: '2007-01-15', placeOfFormation: 'Haldwani',
  natureOfBusiness: 'Business', incomeSlab: '34', netWorthLakhs: '40', netWorthDate: '2026-03-31',
  email: 'Karta@Example.com', mobile: '99999 99999', accountType: 'SB', accountNo: '123456789012', accountNoConfirm: '123456789012',
  ifsc: 'hdfc0000001', bankHolderName: 'XYZ HUF', address1: '1 Main Road', address2: '', address3: '', city: 'Haldwani', state: 'UC', pincode: '263139',
  karta: { name: 'Ram Kumar', pan: 'AAAPK1234B', dateOfBirth: '1970-06-15', gender: 'M', fatherName: 'Mohan Kumar' },
  coparceners: [{ name: 'Sita Kumar', relationship: 'Wife' }],
};

// --- the fake NSE -------------------------------------------------------------------------------
const calls: { path: string; body: any }[] = [];
let fatcaAnswer = { reg_status: 'REG_SUCCESS', reg_remark: 'FATCA DETAILS UPLOADED SUCCESSFULLY' };
let existingCodes: string[] = [];
let uploadAnswer: Record<string, string> = { status: '100', message: 'Image Uploaded Successfully.' };
/** The smallest real PDF header, padded: enough for the file-signature check. */
const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(200, 32)]).toString('base64');
function fakeNse(path: string, body: any) {
  calls.push({ path, body });
  const reply = (b: unknown) => Promise.resolve({ status: 200, body: b });
  switch (path) {
    case 'reports/client_master_report':
      if (body.pan) return reply(existingCodes.length ? { response_status: 'S', report_data: existingCodes.map((c) => ({ client_code: c })) } : { response_status: 'F', error_remark: 'No record(s) found.' });
      return reply({ response_status: 'S', report_data: [{ client_code: 'RSPH000003 ', bank_1_status: 'ACTIVE ', bank_1_status_remarks: ' ' }] });
    case 'registration/CLIENTCOMMON': return reply({ reg_details: [{ reg_status: 'REG_SUCCESS', reg_remark: ' ', reg_id: '1' }] });
    case 'registration/FATCA_COMMON': return reply({ reg_details: [fatcaAnswer] });
    case 'reports/GET_LINK': return reply({ firstHolderLink: 'https://nse.example/auth/abc', errorMessage: '' });
    case 'reports/CLIENT_AUTHORIZATION': return reply({ response_status: 'S', error_remark: 'No record(s) found.' });
    case 'reports/FATCA_REPORT': return reply({ response_status: 'S', report_data: [{ pan_rp: 'AAAHA1234A', createddatetime: '02/11/2026 11:50:12 AM',
      camsuploadstatus: 'UPLOADED', camsresponsestatus: 'ACCEPTED', camsremarks: ' ', kfinuploadstatus: 'UPLOADED', kfinresponsestatus: 'REJECTED', kfinremarks: 'TEST REMARK' }] });
    case 'registration/RESEND_COMM': return reply({ response_status: 'S', error_remark: '' });
    case 'fileupload/AOFIMG': return reply(uploadAnswer);
    case 'fileupload/FATCAIMG': return reply(uploadAnswer);
    case 'fileupload/CANCELCHEQUE': return reply({ status: '100', message: 'Cheque Uploaded Successfully.' });
    case 'reports/AOF_IMAGE_UPLOAD_REPORT': return reply(calls.some((c) => c.path === 'fileupload/AOFIMG')
      ? { response_status: 'S', report_data: [{ client_code: 'RSPH000003', created_at: '03/11/2026 11:58 AM', cams_status: 'Uploaded - Ready to invest', cams_reason: ' ', kfin_status: 'Under review', kfin_reason: ' ' }] }
      : { response_status: 'F', error_remark: 'No record(s) found.' });
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

test('NSE password encryption round-trips with the Postman algorithm', () => {
  const encrypted = Buffer.from(encryptPassword('member-key', 'secret', 42), 'base64').toString('utf8');
  const [iv, salt, body] = encrypted.split('::') as [string, string, string];
  const key = pbkdf2Sync(Buffer.from('member-key'), Buffer.from(salt, 'hex'), 1000, 16, 'sha1');
  const decipher = createDecipheriv('aes-128-cbc', key, Buffer.from(iv, 'hex'));
  assert.equal(Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString(), 'secret|42');
});

test('sealed details only open with the key', () => {
  const sealed = seal({ pan: 'AAAHA1234A' });
  assert.ok(!sealed.includes('AAAHA1234A'));
  assert.deepEqual(unseal(sealed), { pan: 'AAAHA1234A' });
});

test('HUF rules: own PAN, adult karta, bank in the HUF name, matching account numbers', () => {
  const { errors } = readHuf({ ...huf, pan: 'AAAPA1234A', bankHolderName: 'RAM KUMAR', karta: { ...huf.karta, dateOfBirth: '2015-01-01' } }, { accountNoConfirm: '1' });
  assert.deepEqual(Object.keys(errors).sort(), ['accountNoConfirm', 'bankHolderName', 'karta.dateOfBirth', 'pan']);
  assert.deepEqual(readHuf(huf, { accountNoConfirm: huf.accountNoConfirm }).errors, {});
});

test('UCC and FATCA bodies carry the HUF values and the karta as beneficial owner', () => {
  const { details } = readHuf(huf);
  const ucc = hufUcc(details);
  assert.equal(Object.keys(ucc).length, 175);
  assert.equal(ucc['tax_status'], '03');
  assert.equal(ucc['gender'], '');
  assert.equal(ucc['occupation_code'], '01');
  assert.equal(ucc['primary_holder_first_name'], 'XYZ HUF');
  assert.equal(ucc['primary_holder_dob_incorporation'], '15/01/2007');
  assert.equal(ucc['nomination_opt'], 'N');
  const fatca = hufFatca(details, { ip: '203.0.113.10', at: '2026-10-27T07:40:05Z' });
  assert.equal(fatca.ubo_appl, 'Y');
  assert.equal(fatca.ubo_df, 'Y');
  assert.equal(fatca.log_name, '203.0.113.10 27-10-26 13:10');
  const ubo = fatca.ubo_details[0]!;
  assert.equal(ubo.ubo_pan, 'AAAPK1234B');
  assert.equal(ubo.ubo_state, 'UK');
  assert.equal(ubo.ubo_add2, 'HALDWANI');
  assert.equal(ubo.ubo_dob, '15/06/1970');
  assert.equal(fatcaLogName({ ip: '2001:db8:85a3::8a2e:370:7334', at: '2026-10-27T07:40:05Z' }).length, 30);
  assert.equal(registrarStatus('NOT UPLOADED', 'PENDING', ' ').status, 'NOT_SENT');
});

test('a HUF from draft to waiting on the karta', async () => {
  let r = await call('asha', 'POST', '/hufs', { ...huf, accountNoConfirm: '1' });
  assert.equal(r.status, 400);
  assert.ok(r.json.error.fields.accountNoConfirm);

  r = await call('asha', 'POST', '/hufs', huf);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const id = r.json.data.id;
  assert.equal(r.json.data.status, 'DRAFT');
  assert.equal(r.json.data.pan, '••••••234A');
  const stored = await one<{ details: string }>('SELECT details FROM hufs WHERE id = ?', id);
  assert.ok(!stored!.details.includes('AAAHA1234A') && !stored!.details.includes('123456789012'));

  // the same PAN can't be started twice
  r = await call('vikram', 'POST', '/hufs', { ...huf, clientCode: 'RSPH000009' });
  assert.equal(r.status, 400);
  assert.ok(r.json.error.fields.pan);

  // nobody can approve before the karta's consent
  r = await call('vikram', 'POST', `/hufs/${id}/approve`);
  assert.equal(r.status, 409);

  r = await call('asha', 'POST', `/hufs/${id}/consent-link`);
  const token = r.json.data.token as string;
  assert.equal((await call('asha', 'GET', `/hufs/${id}`)).json.data.status, 'AWAITING_CONSENT');

  // the karta's page: masked details, then consent from their own IP (forwarded by the dashboard on loopback)
  r = await call(null, 'GET', `/public/huf-consent/${token}`);
  assert.equal(r.json.data.state, 'PENDING');
  assert.equal(r.json.data.huf.bank.accountNo, '••••••••9012');
  assert.equal((await call(null, 'GET', '/public/huf-consent/not-a-real-token-but-long-enough-to-look-like-one-xx')).status, 404);
  r = await call(null, 'POST', `/public/huf-consent/${token}`, { agree: true }, { 'x-forwarded-for': '198.51.100.7' });
  assert.equal(r.json.data.state, 'GIVEN');
  r = await call('asha', 'GET', `/hufs/${id}`);
  assert.equal(r.json.data.status, 'CONSENTED');
  assert.equal(r.json.data.consent.ip, '198.51.100.7');

  // Through Caddy, X-Forwarded-For is the dashboard server's address: only the vouched-for header carries the karta's.
  const { token: token2 } = await (async () => {
    const other = await call('asha', 'POST', '/hufs', { ...huf, clientCode: 'RSPH000005', pan: 'CCCHC1234C' });
    return (await call('asha', 'POST', `/hufs/${other.json.data.id}/consent-link`)).json.data as { token: string };
  })();
  r = await call(null, 'POST', `/public/huf-consent/${token2}`, { agree: true },
    { 'x-forwarded-for': '76.76.21.9', 'x-risips-client-ip': '203.0.113.50', 'x-risips-proxy-key': 'wrong-key' });
  assert.equal((await one<{ consent_ip: string }>("SELECT consent_ip FROM hufs WHERE client_code = 'RSPH000005'"))!.consent_ip, '76.76.21.9');
  await run("UPDATE hufs SET consent_ip = NULL, consent_at = NULL, status = 'AWAITING_CONSENT' WHERE client_code = 'RSPH000005'");
  r = await call(null, 'POST', `/public/huf-consent/${token2}`, { agree: true },
    { 'x-forwarded-for': '76.76.21.9', 'x-risips-client-ip': '203.0.113.50', 'x-risips-proxy-key': 'test-dashboard-key' });
  assert.equal((await one<{ consent_ip: string }>("SELECT consent_ip FROM hufs WHERE client_code = 'RSPH000005'"))!.consent_ip, '203.0.113.50');

  // the person who prepared it can't approve it
  r = await call('asha', 'POST', `/hufs/${id}/approve`);
  assert.equal(r.status, 403);

  // FATCA fails first time: the UCC goes in once, and a second approval only re-sends FATCA
  fatcaAnswer = { reg_status: 'REG_FAILED', reg_remark: 'UBO Address 2 is required' };
  r = await call('vikram', 'POST', `/hufs/${id}/approve`);
  assert.equal(r.json.data.status, 'NSE_FAILED');
  assert.match(r.json.data.lastError, /UBO Address 2/);
  assert.equal(calls.filter((c) => c.path === 'registration/CLIENTCOMMON').length, 1);
  const fatcaBody = calls.find((c) => c.path === 'registration/FATCA_COMMON')!.body.reg_details[0];
  assert.equal(fatcaBody.log_name, fatcaLogName({ ip: '198.51.100.7', at: r.json.data.consent.at }));

  // once on NSE, the details are locked and shown masked
  assert.equal((await call('asha', 'PUT', `/hufs/${id}`, huf)).status, 409);
  assert.equal(r.json.data.details.accountNo, '••••••••9012');

  fatcaAnswer = { reg_status: 'REG_SUCCESS', reg_remark: 'FATCA DETAILS UPLOADED SUCCESSFULLY' };
  r = await call('vikram', 'POST', `/hufs/${id}/approve`);
  assert.equal(r.json.data.status, 'AWAITING_KARTA');
  assert.equal(r.json.data.authLink, 'https://nse.example/auth/abc');
  assert.equal(calls.filter((c) => c.path === 'registration/CLIENTCOMMON').length, 1);
  assert.equal(calls.filter((c) => c.path === 'registration/FATCA_COMMON').length, 2);

  // refresh: bank active, KFin's rejection surfaces, authorisation unknown (NSE's report is empty for HUFs)
  r = await call('asha', 'POST', `/hufs/${id}/refresh`);
  assert.equal(r.json.data.nse.bankStatus, 'ACTIVE');
  assert.equal(r.json.data.nse.authorised, null);
  assert.equal(r.json.data.status, 'AWAITING_KARTA');
  assert.ok(r.json.data.problems.some((p: string) => /KFin rejected.*TEST REMARK/.test(p)));

  // Until the signed AOF is on NSE, the HUF can't invest: it shows as a problem.
  assert.ok(r.json.data.problems.some((p: string) => /AOF signed by the karta/.test(p)));

  // Documents: only real PDF/JPG/PNG/TIFF under 3 MB; NSE's refusal is reported and kept, and doesn't count as done.
  r = await call('asha', 'POST', `/hufs/${id}/documents`, { kind: 'AOF', contentType: 'application/pdf', data: Buffer.from('not a pdf').toString('base64') });
  assert.equal(r.status, 400);
  assert.match(r.json.error.message, /not really a PDF/);
  r = await call('asha', 'POST', `/hufs/${id}/documents`, { kind: 'AOF', contentType: 'application/zip', data: pdf });
  assert.equal(r.status, 400);
  uploadAnswer = { status: '101', message: 'Invalid file' };
  r = await call('asha', 'POST', `/hufs/${id}/documents`, { kind: 'AOF', contentType: 'application/pdf', data: pdf });
  assert.equal(r.status, 409);
  assert.match(r.json.error.message, /Invalid file/);
  uploadAnswer = { status: '100', message: 'Image Uploaded Successfully.' };
  r = await call('asha', 'POST', `/hufs/${id}/documents`, { kind: 'AOF', contentType: 'application/pdf', data: pdf });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.data.documents.AOF.ok, true);
  assert.ok(!r.json.data.problems.some((p: string) => /AOF signed by the karta/.test(p)));
  const aofCall = calls.filter((c) => c.path === 'fileupload/AOFIMG').at(-1)!.body;
  assert.equal(aofCall.client_code, 'RSPH000003');
  assert.equal(aofCall.document_type, 'NRM');
  assert.ok(aofCall.file_name.length <= 40);
  r = await call('asha', 'POST', `/hufs/${id}/documents`, { kind: 'CANCELLED_CHEQUE', contentType: 'application/pdf', data: pdf });
  assert.equal(r.json.data.documents.CANCELLED_CHEQUE.ok, true);
  assert.equal(calls.filter((c) => c.path === 'fileupload/CANCELCHEQUE').at(-1)!.body.account_no, '123456789012');
  const docsRow = await one<{ documents: string }>('SELECT documents FROM hufs WHERE id = ?', id);
  assert.ok(!docsRow!.documents.includes(pdf.slice(0, 20)), 'the file itself is not stored');

  // The registrars' verdict on the AOF comes back with the status.
  r = await call('asha', 'POST', `/hufs/${id}/refresh`);
  assert.equal(r.json.data.nse.aof.cams.status, 'ACCEPTED');
  assert.equal(r.json.data.nse.aof.kfin.status, 'PENDING');

  assert.equal((await call('asha', 'POST', `/hufs/${id}/resend-link`)).status, 200);
  assert.equal((await call('asha', 'POST', `/hufs/${id}/mark-active`, {})).status, 400);
  r = await call('asha', 'POST', `/hufs/${id}/mark-active`, { note: 'Order 463020217893 accepted' });
  assert.equal(r.json.data.status, 'ACTIVE');
});

test("a loopback or private address is never taken as the karta's", async () => {
  const { privateIp } = await import('../src/routes/hufs.ts');
  for (const ip of ['::1', '127.0.0.1', '::ffff:127.0.0.1', '10.0.0.4', '192.168.1.9', '172.20.1.1', 'fd12:3456::1']) assert.equal(privateIp(ip), true, ip);
  for (const ip of ['198.51.100.7', '74.225.175.227', '172.32.0.1', '2001:db8::1']) assert.equal(privateIp(ip), false, ip);
});

test('a PAN NSE already knows stops at the duplicate check', async () => {
  existingCodes = ['RSPH000001'];
  let r = await call('asha', 'POST', '/hufs', { ...huf, clientCode: 'RSPH000004', pan: 'BBBHB1234B', bankHolderName: 'XYZ HUF' });
  const id = r.json.data.id;
  const token = (await call('asha', 'POST', `/hufs/${id}/consent-link`)).json.data.token;
  await call(null, 'POST', `/public/huf-consent/${token}`, { agree: true });
  const before = calls.length;
  r = await call('vikram', 'POST', `/hufs/${id}/approve`);
  assert.equal(r.json.data.status, 'NSE_FAILED');
  assert.match(r.json.data.lastError, /RSPH000001/);
  assert.equal(calls.slice(before).filter((c) => c.path === 'registration/CLIENTCOMMON').length, 0);
  // editing clears the consent
  r = await call('asha', 'PUT', `/hufs/${id}`, { ...huf, clientCode: 'RSPH000004', pan: 'BBBHB1234B' });
  assert.equal(r.json.data.status, 'DRAFT');
  assert.equal(r.json.data.consent.state, 'NONE');
  existingCodes = [];
});
