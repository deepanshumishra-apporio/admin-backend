// The staff inbox: who sees which notification, each event once, read and unread, and the HUF changes that raise
// them. Uses DATABASE_URL in a throwaway schema.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

process.env['DB_SCHEMA'] = `admin_test_${randomBytes(4).toString('hex')}`;
process.env['ADMIN_DATA_KEY'] = randomBytes(32).toString('base64');

const { closeDb, migrate, run, all } = await import('../src/db.ts');
const { seedRoles } = await import('../src/auth.ts');
const { handle, Router } = await import('../src/http.ts');
const { newToken, tokenId, newId } = await import('../src/security.ts');
const { notify, notificationRoutes, hufInvestmentNotices, hufFatcaNotice, hufEventNotice } = await import('../src/notifications.ts');

let server: Server;
let base = '';
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};

async function staff(name: string, role: string) {
  const id = newId();
  const now = new Date().toISOString();
  await run('INSERT INTO staff (id, email, full_name, password_hash, must_change_password, created_at) VALUES (?, ?, ?, ?, 0, ?)', id, `${name}@risips.test`, name, 'x', now);
  await run('INSERT INTO staff_roles (staff_id, role_key) VALUES (?, ?)', id, role);
  const token = newToken();
  await run("INSERT INTO sessions (id, staff_id, mfa_state, created_at, expires_at, last_seen_at) VALUES (?, ?, 'VERIFIED', ?, ?, ?)", tokenId(token), id, now, new Date(Date.now() + 3_600_000).toISOString(), now);
  tokens[name] = token;
  ids[name] = id;
}

async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api/v1/admin${path}`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}` }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

before(async () => {
  await migrate();
  await seedRoles();
  await staff('ops', 'OPERATIONS');
  await staff('support', 'SUPPORT');
  const router = new Router();
  notificationRoutes(router);
  server = createServer((req, res) => void handle(router, '/api/v1/admin', req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  server.close();
  await run(`DROP SCHEMA ${process.env['DB_SCHEMA']} CASCADE`);
  await closeDb();
});

test('a notice reaches the permission it names, or the one person; each event once', async () => {
  const huf = { key: 'huf:x:consent', kind: 'HUF' as const, severity: 'MEDIUM' as const, title: 'Karta gave consent: A HUF', detail: 'Ready.', href: '/onboarding/hufs/x', permission: 'hufs.manage' };
  await notify(huf);
  await notify({ ...huf, title: 'a repeat' });
  await notify({ key: 'ticket:1:assigned', kind: 'Support', severity: 'HIGH', title: 'Ticket #1 assigned to you', detail: 'Refund', href: '/support/1', permission: null, staffId: ids['support']! });

  const ops = (await call('ops', 'GET', '/notifications')).json.data;
  assert.deepEqual(ops.items.map((i: any) => i.title), ['Karta gave consent: A HUF'], 'once, and not the ticket meant for support');
  assert.equal(ops.unread, 1);
  const sup = (await call('support', 'GET', '/notifications')).json.data;
  assert.deepEqual(sup.items.map((i: any) => [i.title, i.forYou, i.assignee]), [['Ticket #1 assigned to you', true, 'support']], 'support has no hufs.manage');

  const id = ops.items[0].id;
  assert.equal((await call('ops', 'POST', `/notifications/${id}/read`)).status, 200);
  assert.equal((await call('ops', 'GET', '/notifications')).json.data.unread, 0);
  assert.equal((await call('support', 'GET', '/notifications')).json.data.unread, 1, 'reads are per person');
  await call('ops', 'POST', `/notifications/${id}/read`, { read: false });
  assert.equal((await call('ops', 'GET', '/notifications')).json.data.items[0].read, false);
  await call('support', 'POST', '/notifications/read-all');
  assert.equal((await call('support', 'GET', '/notifications')).json.data.unread, 0);
});

test('HUF changes: events, a FATCA rejection, units allotted, a SIP live, a mandate decided', async () => {
  const hufId = newId();
  const now = new Date().toISOString();
  await run(`INSERT INTO hufs (id, client_code, huf_name, pan_masked, pan_hash, karta_name, details, status, steps, created_at, updated_at)
    VALUES (?, 'RSPH000009', 'SHARMA HUF', 'x', 'x', 'K', 'x', 'AWAITING_KARTA', '{}', ?, ?)`, hufId, now, now);
  const h = { id: hufId, huf_name: 'SHARMA HUF', client_code: 'RSPH000009' };

  await hufEventNotice('ev1', hufId, 'NSE_FAILED', 'FATCA: invalid UBO');
  await hufEventNotice('ev2', hufId, 'EDITED', null);
  await hufFatcaNotice(h, { kfin: { status: 'PENDING' } }, { kfin: { status: 'REJECTED', remark: 'MISSING UBO_EXCH' } });
  await hufFatcaNotice(h, { kfin: { status: 'REJECTED' } }, { kfin: { status: 'REJECTED', remark: 'MISSING UBO_EXCH' } });

  const before = { allotments: [], sips: [{ registrationNo: 'S1', status: 'PENDING', schemeName: 'NIFTY', amount: 500 }], mandates: [{ mandateId: 'M1', status: 'PENDING', amount: 100000, remark: null }] };
  const later = {
    allotments: [{ orderId: 'O1', schemeName: 'NIFTY', amount: 5000, units: 130.9 }],
    sips: [{ registrationNo: 'S1', status: 'ACTIVE', schemeName: 'NIFTY', amount: 500 }],
    mandates: [{ mandateId: 'M1', status: 'APPROVED', amount: 100000, remark: null }, { mandateId: 'M2', status: 'REJECTED', amount: 50000, remark: 'Account closed' }],
  };
  await hufInvestmentNotices(h, null, later);
  assert.equal((await all("SELECT 1 FROM notifications WHERE key LIKE ?", `huf:${hufId}:allotted%`)).length, 0, 'the first read is history, not news');
  await hufInvestmentNotices(h, before, later);
  await hufInvestmentNotices(h, later, later);

  const titles = (await call('ops', 'GET', '/notifications')).json.data.items.map((i: any) => i.title).filter((t: string) => t.includes('SHARMA'));
  assert.deepEqual(titles.sort(), [
    'KFin rejected SHARMA HUF\'s FATCA',
    'Mandate approved for SHARMA HUF',
    'Mandate rejected for SHARMA HUF',
    'NSE refused SHARMA HUF',
    'SIP live for SHARMA HUF',
    'Units allotted for SHARMA HUF',
  ]);
});

test('compliance: HUFs onboarded here are checked for FATCA, bank, AOF and mandates', async () => {
  const { hufDetections } = await import('../src/routes/compliance.ts');
  const now = new Date().toISOString();
  const add = async (code: string, nse: unknown, extra: { documents?: unknown; investments?: unknown; status?: string } = {}) => {
    const id = newId();
    await run(`INSERT INTO hufs (id, client_code, huf_name, pan_masked, pan_hash, karta_name, details, status, steps, nse_status, documents, investments, created_at, updated_at)
      VALUES (?, ?, ?, 'x', ?, 'K', 'x', ?, '{}', ?, ?, ?, ?, ?)`, id, code, `${code} HUF`, `h${code}`, extra.status ?? 'ACTIVE', JSON.stringify(nse),
      extra.documents ? JSON.stringify(extra.documents) : null, extra.investments ? JSON.stringify(extra.investments) : null, now, now);
    return id;
  };
  const accepted = { cams: { status: 'ACCEPTED' }, kfin: { status: 'ACCEPTED' } };
  const clean = await add('RSPH000101', { bankStatus: 'ACTIVE', fatca: accepted, aof: accepted });
  const bad = await add('RSPH000102', { bankStatus: 'REJECTED', bankRemark: 'NAME MISMATCH', fatca: { cams: { status: 'ACCEPTED' }, kfin: { status: 'REJECTED', remark: 'MISSING/INVALID UBO_EXCH' } }, aof: null }, {
    investments: { mandates: [
      { mandateId: 'M1', status: 'REJECTED', amount: 100000, registeredOn: '01/11/2026', remark: 'Account closed' },
      { mandateId: 'M2', status: 'PENDING', amount: 50000, registeredOn: '01/01/2026', remark: null },
      { mandateId: 'M3', status: 'APPROVED', amount: 50000, registeredOn: '01/01/2026', remark: null },
    ] },
  });
  await add('RSPH000103', { bankStatus: 'REJECTED' }, { status: 'DRAFT' });

  const found = await hufDetections();
  assert.equal(found.filter((d) => d.entity?.id === clean).length, 0, 'a HUF NSE has accepted raises nothing');
  assert.ok(!found.some((d) => d.detail.includes('RSPH000103')), 'a draft is not on NSE yet');
  const mine = found.filter((d) => d.entity?.id === bad).map((d) => [d.kind, d.severity]).sort();
  assert.deepEqual(mine, [['AOF_MISSING', 'MEDIUM'], ['FATCA_REJECTED', 'HIGH'], ['MANDATE_PENDING', 'MEDIUM'], ['MANDATE_REJECTED', 'HIGH'], ['PAYOUT_BANK_UNVERIFIED', 'HIGH']]);
  assert.match(found.find((d) => d.kind === 'FATCA_REJECTED')!.detail, /karta as beneficial owner/);
});
