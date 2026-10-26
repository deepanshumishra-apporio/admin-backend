// How SIP, SWP and STP instalments reach the dashboard: plan state, the up-front payment and the transactions rows.
// Pure mapping, so no database and no Admin API; the settings below only satisfy config.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env['DATABASE_URL'] ??= 'postgres://test:test@127.0.0.1:1/test';
process.env['ADMIN_API_BASE_URL'] ??= 'http://127.0.0.1:1';
process.env['ADMIN_API_KEY'] ??= 'test';

const { firstPayment, settledPlan } = await import('../src/upstream.ts');
const { findInstallment, monitorInstallments } = await import('../src/map.ts');
type UpOrder = import('../src/upstream.ts').UpOrder;

// The shape of a real SIP from the Admin API (23 Oct 2026), its first ₹100 paid by UPI up front.
const sip = (state: string, flags: { received?: boolean; failed?: boolean }, planState = 'awaiting_payment'): UpOrder => ({
  id: 'mfpp_test',
  kind: 'sip',
  isin: 'INF109K01Z48',
  fund: null,
  amount: 100,
  units: null,
  nav: null,
  state: planState,
  first_payment_received: flags.received ?? false,
  first_payment_failed: flags.failed ?? false,
  created_at: '2026-10-23 07:19:16',
  updated_at: '2026-10-23 09:15:36',
  user_id: 7,
  installments: [{ id: 'mfp_test', state, amount: 100, scheduled_on: '2026-10-23', traded_on: null, upfront: true }],
});
const paymentOf = (plan: UpOrder) => monitorInstallments(plan, undefined)[0]!.view.payment?.status ?? null;

test("the up-front payment follows the instalment's own state, not the app's flags", () => {
  assert.equal(firstPayment(sip('pending', {})), 'PENDING');
  assert.equal(firstPayment(sip('pending', { received: true })), 'SUCCESS'); // paid, FP not moved on yet
  assert.equal(firstPayment(sip('submitted', { received: true })), 'SUCCESS');
  // The app clears first_payment_received once the instalment is allotted: still paid.
  assert.equal(firstPayment(sip('successful', { received: false }, 'active')), 'SUCCESS');
  assert.equal(firstPayment(sip('confirmed', {})), 'SUCCESS');
  assert.equal(firstPayment(sip('failed', { failed: true })), 'FAILED');
  assert.equal(firstPayment(sip('pending', { failed: true })), 'FAILED');
  // Paid, then the order failed at the fund house: the payment itself still went through.
  assert.equal(firstPayment(sip('failed', { received: true })), 'SUCCESS');
  assert.equal(firstPayment({ ...sip('pending', {}), installments: [] }), null);
});

test('a paid SIP shows active, an unpaid one keeps waiting', () => {
  assert.equal(settledPlan(sip('submitted', { received: true })).state, 'active');
  assert.equal(settledPlan(sip('submitted', { received: false })).state, 'active');
  assert.equal(settledPlan(sip('pending', {})).state, 'awaiting_payment');
  assert.equal(settledPlan(sip('failed', { failed: true }, 'failed')).state, 'failed');
});

test('the transactions row shows the up-front payment the same way', () => {
  assert.equal(paymentOf(sip('successful', { received: false }, 'active')), 'SUCCESS');
  assert.equal(paymentOf(sip('submitted', { received: true })), 'SUCCESS');
  assert.equal(paymentOf(sip('pending', {})), 'PENDING');
  assert.equal(paymentOf(sip('failed', { failed: true })), 'FAILED');
  // Mandate instalments carry no payment of their own.
  const mandate = { ...sip('successful', {}, 'active'), installments: [{ id: 'mfp_later', state: 'pending', amount: 100, scheduled_on: '2026-11-24' }] };
  assert.equal(paymentOf(mandate), null);
});

test('instalments become typed rows that can be found and refreshed through their plan', () => {
  const plan = sip('successful', {}, 'active');
  const [row] = monitorInstallments(plan, undefined);
  assert.equal(row!.view.type, 'SIP_INSTALLMENT');
  assert.equal(row!.view.kind, 'purchase');
  assert.equal(row!.view.state, 'SUCCESSFUL');
  assert.equal(row!.refreshId, 'mfpp_test');
  assert.equal(findInstallment([plan], row!.view.id)?.installment['id'], 'mfp_test');

  const swp = { ...plan, id: 'mfrp_test', kind: 'swp', installments: [{ id: 'mfr_test', state: 'pending', amount: 100, scheduled_on: '2026-10-01' }] };
  const [withdrawal] = monitorInstallments(swp, undefined, Date.parse('2026-10-05T00:00:00Z'));
  assert.equal(withdrawal!.view.type, 'SWP_INSTALLMENT');
  assert.equal(withdrawal!.view.kind, 'redemption');
  // Nobody waits on the investor for a scheduled withdrawal.
  assert.equal(withdrawal!.view.flag, null);
});
