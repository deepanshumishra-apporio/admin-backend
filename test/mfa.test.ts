// Staff two-factor sign-in end to end: password -> authenticator setup (QR secret) -> the code -> ten recovery codes;
// later sign-ins with the app's code or a recovery code (once each), a reused code refused, new recovery codes from
// the profile, and an administrator's reset. Uses DATABASE_URL in a throwaway schema.
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

process.env['DB_SCHEMA'] = `admin_test_${randomBytes(4).toString('hex')}`;
process.env['ADMIN_DATA_KEY'] = randomBytes(32).toString('base64');
process.env['STAFF_MFA_ENABLED'] = 'true';

const { closeDb, migrate, run, one } = await import('../src/db.ts');
const { seedRoles } = await import('../src/auth.ts');
const { handle, Router } = await import('../src/http.ts');
const { sessionRoutes } = await import('../src/routes/sessions.ts');
const { staffRoutes } = await import('../src/routes/staff.ts');
const { hashPassword, newToken, tokenId } = await import('../src/security.ts');
/** A super admin's signed-in session, for Roles & access. */
const adminToken = newToken();

const Password = 'Correct-horse-battery-9';
let server: Server;
let base = '';

async function call(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${base}/api/v1/admin${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: res.status === 204 ? null : ((await res.json()) as any) };
}

/** The authenticator app's code for a base32 secret, `steps` periods from now (RFC 6238, computed independently). */
function appCode(secret: string, steps = 0): string {
  const bits = [...secret].map((c) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5, '0')).join('');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + steps));
  const digest = createHmac('sha1', key).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

const signIn = async () => {
  const r = await call('POST', '/sessions', { email: 'meera@risips.test', password: Password });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.data as { accessToken: string; mfa: string };
};

before(async () => {
  await migrate();
  await seedRoles();
  await run("INSERT INTO staff (id, email, full_name, password_hash, must_change_password, created_at) VALUES ('0e6c1d8e-5f2a-4c3b-9a7d-111111111111', 'meera@risips.test', 'Meera', ?, 0, ?)",
    hashPassword(Password), new Date().toISOString());
  await run("INSERT INTO staff_roles (staff_id, role_key) VALUES ('0e6c1d8e-5f2a-4c3b-9a7d-111111111111', 'OPERATIONS')");
  const now = new Date().toISOString();
  await run("INSERT INTO staff (id, email, full_name, password_hash, must_change_password, created_at) VALUES ('0e6c1d8e-5f2a-4c3b-9a7d-222222222222', 'admin@risips.test', 'Admin', 'x', 0, ?)", now);
  await run("INSERT INTO staff_roles (staff_id, role_key) VALUES ('0e6c1d8e-5f2a-4c3b-9a7d-222222222222', 'SUPER_ADMIN')");
  await run("INSERT INTO sessions (id, staff_id, mfa_state, created_at, expires_at, last_seen_at) VALUES (?, '0e6c1d8e-5f2a-4c3b-9a7d-222222222222', 'VERIFIED', ?, ?, ?)",
    tokenId(adminToken), now, new Date(Date.now() + 3_600_000).toISOString(), now);
  const router = new Router();
  sessionRoutes(router);
  staffRoutes(router);
  server = createServer((req, res) => void handle(router, '/api/v1/admin', req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  server.close();
  await run(`DROP SCHEMA ${process.env['DB_SCHEMA']} CASCADE`);
  await closeDb();
});

let secret = '';
let codes: string[] = [];

test('first sign-in: set up the authenticator, prove it with a code, get ten recovery codes', async () => {
  const s = await signIn();
  assert.equal(s.mfa, 'SETUP_REQUIRED');
  // nothing past sign-in works until the second step is done
  assert.equal((await call('GET', '/me', undefined, s.accessToken)).status, 403);

  const setup = await call('POST', '/sessions/mfa/setup', undefined, s.accessToken);
  secret = setup.json.data.secret;
  assert.match(setup.json.data.otpauthUri, /^otpauth:\/\/totp\/RiSips%20Admin%3Ameera%40risips\.test\?secret=/);
  const stored = await one<{ pending_secret: string }>("SELECT pending_secret FROM sessions WHERE staff_id = '0e6c1d8e-5f2a-4c3b-9a7d-111111111111'");
  assert.ok(stored!.pending_secret.startsWith('v1.') && !stored!.pending_secret.includes(secret), 'the secret is stored sealed');

  assert.equal((await call('POST', '/sessions/mfa/verify', { code: '000000' === appCode(secret) ? '111111' : '000000' }, s.accessToken)).status, 400);
  const r = await call('POST', '/sessions/mfa/verify', { code: appCode(secret) }, s.accessToken);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.data.mfa, 'VERIFIED');
  codes = r.json.data.recoveryCodes;
  assert.equal(codes.length, 10);
  assert.ok(codes.every((c) => /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(c)));
  assert.equal(new Set(codes).size, 10);
  const kept = await one<{ n: string }>("SELECT COUNT(*) AS n FROM staff_recovery_codes WHERE staff_id = '0e6c1d8e-5f2a-4c3b-9a7d-111111111111'");
  assert.equal(Number(kept!.n), 10);
  assert.ok(!JSON.stringify(await one("SELECT * FROM staff_recovery_codes WHERE staff_id = '0e6c1d8e-5f2a-4c3b-9a7d-111111111111'")).includes(codes[0]!.replace('-', '')), 'only HMACs are kept');

  const me = await call('GET', '/me', undefined, s.accessToken);
  assert.deepEqual(me.json.data.mfa, { serverOn: true, required: true, enrolled: true, recoveryCodesLeft: 10 });
});

test('later sign-ins: the same app code works only once; a recovery code works once, in any case or spacing', async () => {
  let s = await signIn();
  assert.equal(s.mfa, 'VERIFY_REQUIRED');
  // A code already used can't sign in again. The last used step is pinned to the next one, so the check doesn't
  // depend on a 30-second boundary falling mid-test.
  const step = Math.floor(Date.now() / 30_000);
  await run("UPDATE staff SET mfa_last_counter = ? WHERE id = '0e6c1d8e-5f2a-4c3b-9a7d-111111111111'", step + 1);
  let r = await call('POST', '/sessions/mfa/verify', { code: appCode(secret, 1) }, s.accessToken);
  assert.equal(r.status, 400);
  assert.match(r.json.error.message, /already been used/);
  await run("UPDATE staff SET mfa_last_counter = ? WHERE id = '0e6c1d8e-5f2a-4c3b-9a7d-111111111111'", step - 2);
  r = await call('POST', '/sessions/mfa/verify', { code: appCode(secret) }, s.accessToken);
  assert.equal(r.status, 200, 'a code not used before does');
  assert.equal(r.json.data.recoveryCodes, undefined, 'recovery codes are only shown at setup');

  s = await signIn();
  const typed = codes[0]!.toLowerCase().replace('-', ' ');
  r = await call('POST', '/sessions/mfa/verify', { code: typed }, s.accessToken);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  s = await signIn();
  r = await call('POST', '/sessions/mfa/verify', { code: codes[0] }, s.accessToken);
  assert.equal(r.status, 400);
  assert.match(r.json.error.message, /already been used/);
  r = await call('POST', '/sessions/mfa/verify', { code: 'ABCD-EFGH' }, s.accessToken);
  assert.equal(r.status, 400);
  const outcomes = (await one<{ list: string }>("SELECT string_agg(outcome, ',' ORDER BY at) AS list FROM login_events WHERE staff_id = '0e6c1d8e-5f2a-4c3b-9a7d-111111111111'"))!.list;
  assert.match(outcomes, /SUCCESS_RECOVERY_CODE/);
});

test('new recovery codes need the current app code and replace the old ones; an admin reset clears them', async () => {
  const s = await signIn();
  let r = await call('POST', '/sessions/mfa/verify', { code: codes[1] }, s.accessToken);
  assert.equal(r.status, 200);
  assert.equal((await call('GET', '/me', undefined, s.accessToken)).json.data.mfa.recoveryCodesLeft, 8);

  assert.equal((await call('POST', '/me/recovery-codes', { code: '12345' }, s.accessToken)).status, 400);
  // (the earlier sign-in used the next step's code; start this check from a clean slate, whatever the clock did)
  await run("UPDATE staff SET mfa_last_counter = NULL WHERE id = '0e6c1d8e-5f2a-4c3b-9a7d-111111111111'");
  r = await call('POST', '/me/recovery-codes', { code: appCode(secret) }, s.accessToken);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  // the same code can't make another set
  assert.equal((await call('POST', '/me/recovery-codes', { code: appCode(secret) }, s.accessToken)).status, 400);
  const fresh = r.json.data.recoveryCodes as string[];
  assert.equal(fresh.length, 10);
  assert.equal((await call('GET', '/me', undefined, s.accessToken)).json.data.mfa.recoveryCodesLeft, 10);

  const old = await signIn();
  r = await call('POST', '/sessions/mfa/verify', { code: codes[2] }, old.accessToken);
  assert.equal(r.status, 400, 'old codes stopped working');

  // what Roles & access "Reset two-factor" does (staff.ts): set up again at the next sign-in, no codes left
  await run("UPDATE staff SET mfa_secret = NULL, mfa_enrolled = 0, mfa_last_counter = NULL WHERE id = '0e6c1d8e-5f2a-4c3b-9a7d-111111111111'");
  await run("DELETE FROM staff_recovery_codes WHERE staff_id = '0e6c1d8e-5f2a-4c3b-9a7d-111111111111'");
  assert.equal((await signIn()).mfa, 'SETUP_REQUIRED');
});

test("an administrator can turn two-factor off for one person, and back on", async () => {
  // set up again first (the previous test reset it)
  let s = await signIn();
  const setup = await call('POST', '/sessions/mfa/setup', undefined, s.accessToken);
  secret = setup.json.data.secret;
  assert.equal((await call('POST', '/sessions/mfa/verify', { code: appCode(secret) }, s.accessToken)).status, 200);

  // the setting must be said plainly
  const meera = (await call('GET', '/staff', undefined, adminToken)).json.data.find((m: any) => m.email === 'meera@risips.test');
  assert.equal(meera.mfaRequired, true);
  assert.equal((await call('POST', `/staff/${meera.id}/mfa`, { required: 'no' }, adminToken)).status, 400);

  let r = await call('POST', `/staff/${meera.id}/mfa`, { required: false }, adminToken);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.data.mfaRequired, false);
  assert.equal(r.json.data.mfaOffForPerson, true);
  s = await signIn();
  assert.equal(s.mfa, 'VERIFIED', 'off: the password alone signs in');
  assert.deepEqual((await call('GET', '/me', undefined, s.accessToken)).json.data.mfa, { serverOn: true, required: false, enrolled: true, recoveryCodesLeft: 10 });

  r = await call('POST', `/staff/${meera.id}/mfa`, { required: true }, adminToken);
  assert.equal(r.json.data.mfaRequired, true);
  assert.equal((await call('GET', '/me', undefined, s.accessToken)).status, 401, 'turning it on ends their sessions');
  assert.equal((await signIn()).mfa, 'VERIFY_REQUIRED', 'on again: the same authenticator, no new setup');
});
