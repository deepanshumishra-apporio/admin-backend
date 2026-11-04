// The compliance scan against a fake app backend: the 2FA consent, AutoPay mandate, fresh KYC and job-freshness
// fields the app's Admin API sends, and that an older app backend without them raises nothing new.
// Uses DATABASE_URL in a throwaway schema; the app backend is faked.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';

process.env['DB_SCHEMA'] = `admin_test_${randomBytes(4).toString('hex')}`;
process.env['ADMIN_DATA_KEY'] = randomBytes(32).toString('base64');
process.env['ADMIN_API_BASE_URL'] = 'http://app.fake.test/admin/v1';
process.env['ADMIN_API_KEY'] = 'test-key-0123456789abcdef0123';

const { closeDb, migrate, all, run } = await import('../src/db.ts');
const { seedRoles } = await import('../src/auth.ts');
const { scan, monitoringDetections } = await import('../src/routes/compliance.ts');

const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString().replace('T', ' ').slice(0, 19);
const Day = 86_400_000;

const investor = (id: number, extra: Record<string, unknown> = {}) => ({
  id, name: `Investor ${id}`, email: `i${id}@x.in`, mobile: '9', stage: 'active', kyc_compliant: true, pan_masked: '******123A',
  signed_up_at: iso(30 * Day), onboarded_at: iso(25 * Day), orders: 1, plans: 1, nominee_opted_out: true, ...extra,
});
const order = (id: string, userId: number, extra: Record<string, unknown>) => ({
  id, ref: id, kind: 'purchase', isin: 'INF000000001', fund: { name: 'A Fund' }, amount: 5000, units: null, nav: null, state: 'successful',
  created_at: iso(5 * Day), updated_at: iso(4 * Day), user_id: userId, ...extra,
});

let app: { investors: unknown[]; orders: unknown[]; details: Record<number, unknown>; summary: unknown } = { investors: [], orders: [], details: {}, summary: {} };
const realFetch = globalThis.fetch;

before(async () => {
  await migrate();
  await seedRoles();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.host !== 'app.fake.test') return realFetch(input, init);
    const path = url.pathname.replace('/admin/v1', '');
    const page = (rows: unknown[]) => Response.json({ total: rows.length, limit: 200, offset: 0, data: rows });
    if (path === '/investors') return page(app.investors);
    if (path === '/orders') return page(app.orders);
    if (path === '/summary') return Response.json(app.summary);
    const m = path.match(/^\/investors\/(\d+)$/);
    if (m && app.details[Number(m[1])]) return Response.json(app.details[Number(m[1])]);
    return Response.json({ error: 'not found' }, { status: 404 });
  }) as typeof fetch;
});
after(async () => {
  globalThis.fetch = realFetch;
  await run(`DROP SCHEMA ${process.env['DB_SCHEMA']} CASCADE`);
  await closeDb();
});

const open = async () => (await all<{ kind: string; severity: string; dedupe_key: string }>("SELECT kind, severity, dedupe_key FROM alerts WHERE status = 'OPEN' ORDER BY dedupe_key"))
  .map((a) => `${a.kind}/${a.severity}/${a.dedupe_key}`);

test("an older app backend (no consent, mandate, kyc or freshness fields) raises none of the new alerts", async () => {
  app = {
    investors: [investor(1)],
    orders: [order('mfp_old', 1, {})],
    details: { 1: { investor: investor(1), orders: [], sips: [], stps: [], swps: [] } },
    summary: { investors: {}, orders: {} },
  };
  await scan(true);
  assert.deepEqual(await open(), []);
});

test('2FA consent, AutoPay mandates, a failed fresh KYC and a stopped job each raise their alert', async () => {
  const sip = order('mfpp_sip', 12, { kind: 'sip', state: 'active', consent: { at: iso(5 * Day), via: 'otp' } });
  app = {
    investors: [investor(11), investor(12), investor(13)],
    orders: [
      order('mfp_signed', 11, { consent: { at: iso(5 * Day), via: 'otp' } }),
      order('mfp_unsigned', 11, { consent: null }),
      order('mfp_unsigned_pending', 11, { consent: null, state: 'pending' }),
      order('mfp_before_2fa', 11, { consent: null, created_at: '2026-09-20 10:00:00' }),
      sip,
    ],
    details: {
      11: { investor: { ...investor(11), mandate: { id: '9', status: 'REJECTED', type: 'E_MANDATE', limit: 50000, umrn_masked: null, valid_from: null, valid_to: null, created_at: iso(10 * Day) } }, orders: [], sips: [], stps: [], swps: [] },
      12: { investor: { ...investor(12), mandate: { id: '10', status: 'CREATED', type: 'UPI', limit: 10000, umrn_masked: null, valid_from: null, valid_to: null, created_at: iso(5 * Day) } }, orders: [], sips: [sip], stps: [], swps: [] },
      13: { investor: { ...investor(13), kyc: { fresh: true, form_status: 'failed', form_reason: 'Signature unclear', submitted_at: null, expires_at: null, kra_checked_at: null, kra_approved_at: null } }, orders: [], sips: [], stps: [], swps: [] },
    },
    summary: { freshness: {
      last_order_update_at: iso(Day), last_webhook_at: null, started_at: new Date(now - 10 * Day).toISOString(),
      jobs: [
        { name: 'kyc-approvals', every_ms: 30 * 60_000, last_ok_at: new Date(now - 5 * 60_000).toISOString(), last_error_at: null },
        { name: 'sip-first-payments', every_ms: 10 * 60_000, last_ok_at: new Date(now - 6 * 3_600_000).toISOString(), last_error_at: new Date(now - 60_000).toISOString() },
      ],
    } },
  };
  await scan(true);
  assert.deepEqual(await open(), [
    'CONSENT_MISSING/HIGH/consent_missing:mfp_unsigned',
    'KYC_FAILED/HIGH/kyc_form:13',
    'MANDATE_PENDING/MEDIUM/mandate_pending:10',
    'MANDATE_REJECTED/MEDIUM/mandate_rejected:9',
    'MONITORING_STALE/HIGH/monitoring:sip-first-payments',
  ]);
});

test('a job is given three runs after the app restarts before it counts as stopped', () => {
  const started = new Date(Date.now() - 20 * 60_000).toISOString();
  assert.deepEqual(monitoringDetections({ last_order_update_at: null, last_webhook_at: null, started_at: started,
    jobs: [{ name: 'kyc-approvals', every_ms: 30 * 60_000, last_ok_at: null, last_error_at: null }] }), []);
  assert.deepEqual(monitoringDetections(undefined), []);
});
