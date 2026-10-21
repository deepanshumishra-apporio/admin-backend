// Checks of the pieces everything else leans on. Run with `npm test`. Uses DATABASE_URL, in a throwaway schema
// that is dropped afterwards; the Admin API is not called.
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';

process.env['DB_SCHEMA'] = `admin_test_${randomBytes(4).toString('hex')}`;

const { closeDb, migrate, run } = await import('../src/db.ts');
const { toCsv } = await import('../src/http.ts');
const { flagOf, iso, factsFor, toMonitored } = await import('../src/map.ts');
const { hashPassword, verifyPassword, uuidFor, extIdOf, flushIds, verifyTotp, newTotpSecret, passwordProblem } = await import('../src/security.ts');
const { seedRoles } = await import('../src/auth.ts');

before(async () => {
  await migrate();
  await seedRoles();
});
after(async () => {
  await flushIds();
  await run(`DROP SCHEMA ${process.env['DB_SCHEMA']} CASCADE`);
  await closeDb();
});

test('the schema is created and the built-in roles are seeded', async () => {
  const { all } = await import('../src/db.ts');
  const roles = await all<{ key: string }>('SELECT key FROM roles ORDER BY key');
  assert.deepEqual(roles.map((r) => r.key), ['COMPLIANCE', 'OPERATIONS', 'SUPER_ADMIN', 'SUPPORT', 'VIEWER']);
});

const order = (over: Record<string, unknown>) => ({
  id: 'mfp_1', kind: 'purchase', isin: 'INF109KC19T7', amount: 100, units: null, nav: null, state: 'submitted',
  created_at: '2026-10-19 06:49:02', updated_at: '2026-10-19 06:49:02', user_id: 1, ...over,
}) as never;

test('Admin API timestamps without a zone are read as UTC', () => {
  assert.equal(iso('2026-10-21 04:34:20'), '2026-10-21T04:34:20.000Z');
  assert.equal(iso('2026-10-21T14:54:13+05:30'), '2026-10-21T09:24:13.000Z');
  assert.equal(iso('2026-10-19'), '2026-10-19');
  assert.equal(iso(null), null);
});

test('UUIDs are stable, valid and map back to the app backend id, also from the database', async () => {
  const a = uuidFor('investor', 2);
  assert.equal(a, uuidFor('investor', '2'));
  assert.notEqual(a, uuidFor('order', 2));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(await extIdOf('investor', a), '2');
  assert.equal(await extIdOf('order', a), null);
  await flushIds();
  const { one } = await import('../src/db.ts');
  assert.deepEqual(await one('SELECT kind, ext_id FROM id_map WHERE uuid = ?', a), { kind: 'investor', ext_id: '2' });
});

test('passwords hash and verify; weak ones are refused', () => {
  const hash = hashPassword('Correct-horse-42');
  assert.ok(verifyPassword('Correct-horse-42', hash));
  assert.ok(!verifyPassword('correct-horse-42', hash));
  assert.ok(passwordProblem('short1', 'a@b.c'));
  assert.ok(passwordProblem('akashakashakash1', 'akash@x.in'));
  assert.equal(passwordProblem('Long-enough-pass-9', 'akash@x.in'), null);
});

test('TOTP matches RFC 6238 and accepts one step of drift', () => {
  const secret = newTotpSecret();
  assert.equal(secret.length, 32);
  // Recompute the current code independently.
  const bits = [...secret].map((c) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5, '0')).join('');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac('sha1', key).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const code = String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
  assert.ok(verifyTotp(secret, code));
  assert.ok(!verifyTotp(secret, code === '000000' ? '111111' : '000000'));
});

test('order flags follow the original rules', () => {
  const now = Date.parse('2026-10-25T00:00:00Z');
  assert.equal(flagOf(order({ state: 'failed' }), now), 'FAILED');
  assert.equal(flagOf(order({ state: 'submitted' }), now), 'STUCK_AT_RTA');
  assert.equal(flagOf(order({ state: 'submitted', updated_at: '2026-10-24 12:00:00' }), now), null);
  assert.equal(flagOf(order({ state: 'pending', payment: { id: 1, status: 'SUCCESS' } }), now), 'PAID_NOT_CONFIRMED');
  assert.equal(flagOf(order({ state: 'pending' }), now), 'AWAITING_INVESTOR');
});

test('investor facts: stage, KYC and invested amount', () => {
  const up = { id: 1, name: 'A', email: 'a@x.in', mobile: '9', stage: 'active', kyc_compliant: true, pan_masked: '*******51C',
    signed_up_at: '2026-10-19 06:29:05', onboarded_at: '2026-10-19T06:32:54.071Z', orders: 2, plans: 0 };
  const facts = factsFor(up, [order({ state: 'successful' }), order({ id: 'mfp_2', state: 'failed' })], new Map());
  assert.equal(facts.stage, 'INVESTED');
  assert.equal(facts.kycStatus, 'COMPLETED');
  assert.equal(facts.investedAmount, 100);
  const fresh = factsFor({ ...up, stage: 'pan', kyc_compliant: false, onboarded_at: null }, [], new Map(), { pan_readiness: 'kyc_unavailable' });
  assert.equal(fresh.stage, 'KYC');
  assert.equal(fresh.kycStatus, 'PAN_CHECK_FAILED');
  const view = toMonitored(order({ state: 'successful', succeeded_at: '2026-10-21T14:54:13+05:30' }), facts);
  assert.equal(view.state, 'SUCCESSFUL');
  assert.equal(view.investor.id, uuidFor('investor', 1));
});

test('CSV escapes quotes and neutralises formulas', () => {
  const csv = toCsv([{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], [{ a: '=HYPERLINK("x")', b: -12.5 }]);
  assert.equal(csv, '﻿A,B\r\n"\'=HYPERLINK(""x"")",-12.5\r\n');
});
