// Turns the Admin API's records into the shapes the dashboard renders (admin-risips/src/types/admin-api.types.ts).
// Money and units go out as decimal strings, dates as ISO strings, ids as the UUIDs from `uuidFor`.
import { config } from './config.ts';
import { uuidFor } from './security.ts';
import type { Lists, UpDetailResponse, UpFund, UpHolding, UpInvestor, UpOrder, UpPortfolio } from './upstream.ts';

// --- vocabularies ------------------------------------------------------------------------------

export const KycStatuses = ['NOT_STARTED', 'PAN_CHECK_FAILED', 'IN_PROGRESS', 'FAILED', 'EXPIRED', 'COMPLETED'] as const;
export type KycStatus = (typeof KycStatuses)[number];
export const JourneyStages = ['SIGNED_UP', 'KYC', 'KYC_COMPLETED', 'PROFILE', 'ACCOUNT_SETUP', 'READY_TO_INVEST', 'INVESTED'] as const;
export type JourneyStage = (typeof JourneyStages)[number];
export type KycNextStep = 'PROVIDE_DETAILS' | 'FETCH_PROOF' | 'UPLOAD_SIGNATURE' | 'ESIGN' | 'WAITING_ON_PROVIDER';
export const KycNextSteps: KycNextStep[] = ['PROVIDE_DETAILS', 'FETCH_PROOF', 'UPLOAD_SIGNATURE', 'ESIGN', 'WAITING_ON_PROVIDER'];

export const KycStatusLabels: Record<KycStatus, string> = {
  NOT_STARTED: 'Not started',
  PAN_CHECK_FAILED: 'PAN check not passed',
  IN_PROGRESS: 'In progress',
  FAILED: 'Failed',
  EXPIRED: 'Expired',
  COMPLETED: 'Completed',
};
export const StageLabels: Record<JourneyStage, string> = {
  SIGNED_UP: 'Signed up',
  KYC: 'KYC pending',
  KYC_COMPLETED: 'KYC completed',
  PROFILE: 'Profile created',
  ACCOUNT_SETUP: 'Account setup',
  READY_TO_INVEST: 'Ready to invest',
  INVESTED: 'Invested',
};
export const NextStepLabels: Record<KycNextStep, string> = {
  PROVIDE_DETAILS: 'Filling details',
  FETCH_PROOF: 'Aadhaar (DigiLocker)',
  UPLOAD_SIGNATURE: 'Signature',
  ESIGN: 'e-Sign',
  WAITING_ON_PROVIDER: 'Waiting on KRA / provider',
};

/** The app's onboarding steps (risips backend `nextStep`) → the dashboard's journey stages. */
const StepStage: Record<string, JourneyStage> = {
  mobile: 'SIGNED_UP',
  pin: 'SIGNED_UP',
  pan: 'KYC',
  'pan-confirm': 'KYC',
  aadhaar: 'KYC',
  'selfie-intro': 'KYC',
  occupation: 'PROFILE',
  income: 'PROFILE',
  marital: 'PROFILE',
  father: 'PROFILE',
  address: 'PROFILE',
  bank: 'ACCOUNT_SETUP',
  'signature-consent': 'ACCOUNT_SETUP',
  nominee: 'ACCOUNT_SETUP',
  esign: 'ACCOUNT_SETUP',
};

export const KycStalledHours = 72;
const HourMs = 3_600_000;
export const IstOffsetMs = 5.5 * HourMs;

export const humanise = (value: string): string => {
  const text = value.toLowerCase().replaceAll('_', ' ').replaceAll('-', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

// --- primitives ------------------------------------------------------------------------------------

/** The Admin API mixes "2026-10-21 04:34:20" (UTC, no zone) with full ISO strings. */
export function iso(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const normalised = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const time = Date.parse(normalised);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

export const ms = (value: unknown): number => {
  const text = iso(value);
  return text ? Date.parse(text) : 0;
};

const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
export const money = (value: unknown): string | null => {
  const n = num(value);
  return n === null ? null : n.toFixed(2);
};
export const money0 = (value: unknown): string => money(value) ?? '0.00';
export const unitsOf = (value: unknown): string | null => {
  const n = num(value);
  return n === null ? null : n.toFixed(4);
};
const navOf = (value: unknown): string | null => {
  const n = num(value);
  return n === null ? null : n.toFixed(4);
};
const textOf = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/** yyyy-mm-dd in India for an instant. */
export function istDate(instantMs: number): string {
  return new Date(instantMs + IstOffsetMs).toISOString().slice(0, 10);
}

// --- orders and plans -------------------------------------------------------------------------------

export const PlanKinds = { sip: 'SIP', stp: 'STP', swp: 'SWP' } as const;
export const OrderKinds = { purchase: 'PURCHASE', redemption: 'REDEMPTION', switch: 'SWITCH' } as const;
export type PlanKind = (typeof PlanKinds)[keyof typeof PlanKinds];
export type OrderKind = (typeof OrderKinds)[keyof typeof OrderKinds];

export const isPlan = (o: UpOrder): boolean => o.kind in PlanKinds;
export const isOrder = (o: UpOrder): boolean => o.kind in OrderKinds;
const ActivePlanStates = new Set(['active', 'confirmed', 'awaiting_payment']);
export const planActive = (p: UpOrder): boolean => ActivePlanStates.has(p.state);
const TerminalStates = new Set(['successful', 'failed', 'cancelled', 'reversed']);
export const inFlight = (o: UpOrder): boolean => !TerminalStates.has(o.state);

const FailureLabels: Record<string, string> = {
  fp_payment_url_unused: 'The investor never used the payment link',
  payment_failed_by_user: 'The investor did not complete the payment',
  pg_payment_expired: 'The payment expired',
  order_failure_at_gateway: 'Rejected by the fund house',
  order_processing_error: 'Processing error at the exchange (ONDC)',
  pan_kyc_incomplete: "The investor's KYC is not complete",
  amount_not_available: 'Cancelled after the first payment failed',
};
export const failureReason = (o: UpOrder): string | null => {
  const code = o.failure_code ?? textOf(o.reason);
  if (!code) return null;
  return FailureLabels[code] ?? humanise(code);
};

const schemeName = (fund: UpFund | null | undefined, isin: string): string => fund?.name ?? isin;

/** Plan instalments as orders, when the Admin API includes them on a plan. */
function installmentOrders(plan: UpOrder): Record<string, unknown>[] {
  return Array.isArray(plan.installments) ? plan.installments : [];
}

export function toOrder(o: UpOrder) {
  const kind = OrderKinds[o.kind as keyof typeof OrderKinds] ?? 'PURCHASE';
  const done = o.state === 'successful';
  return {
    id: uuidFor('order', o.id),
    kind,
    source: 'ONE_TIME' as const,
    scheme: schemeName(o.fund, o.isin),
    toScheme: o.fund_to ? o.fund_to.name : null,
    amount: money(o.amount),
    units: null,
    processedAmount: done ? money(o.amount) : null,
    processedUnits: unitsOf(o.units),
    price: navOf(o.nav),
    folioNumber: o.folio ?? null,
    state: o.state,
    failureReason: failureReason(o),
    placedAt: iso(o.created_at)!,
    completedAt: done ? iso(o.succeeded_at) ?? iso(o.updated_at) : null,
  };
}

/** One instalment of a plan, as an order row. */
function installmentToOrder(plan: UpOrder, i: Record<string, unknown>, index: number) {
  const kind: OrderKind = plan.kind === 'swp' ? 'REDEMPTION' : plan.kind === 'stp' ? 'SWITCH' : 'PURCHASE';
  const state = textOf(i['state']) ?? 'pending';
  const id = textOf(i['id']) ?? `${plan.id}#${index}`;
  return {
    id: uuidFor('order', id),
    kind,
    source: PlanKinds[plan.kind as keyof typeof PlanKinds],
    scheme: schemeName(plan.fund, plan.isin),
    toScheme: plan.fund_to ? plan.fund_to.name : null,
    amount: money(i['amount'] ?? plan.amount),
    units: null,
    processedAmount: state === 'successful' ? money(i['amount'] ?? plan.amount) : null,
    processedUnits: unitsOf(i['units'] ?? i['units_out']),
    price: navOf(i['nav']),
    folioNumber: textOf(i['folio']) ?? plan.folio ?? null,
    state,
    failureReason: textOf(i['failure_code']) ? FailureLabels[i['failure_code'] as string] ?? humanise(i['failure_code'] as string) : null,
    placedAt: iso(i['created_at']) ?? iso(i['scheduled_on']) ?? iso(plan.created_at)!,
    completedAt: state === 'successful' ? iso(i['traded_on']) ?? iso(i['scheduled_on']) : null,
  };
}

export function toPlan(p: UpOrder) {
  const installments = installmentOrders(p);
  const succeeded = installments.filter((i) => i['state'] === 'successful').length;
  const pause = (p['pause'] ?? null) as Record<string, unknown> | null;
  const cancelled = p.state === 'cancelled';
  return {
    id: uuidFor('plan', p.id),
    kind: PlanKinds[p.kind as keyof typeof PlanKinds],
    scheme: schemeName(p.fund, p.isin),
    toScheme: p.fund_to ? p.fund_to.name : null,
    amount: money(p.amount),
    units: unitsOf(p['plan_units']),
    frequency: p.frequency ?? 'monthly',
    installmentDay: num(p.installment_day),
    state: p.state,
    startDate: iso(p.start_date),
    endDate: iso(p['end_date']),
    nextInstallmentDate: iso(p.next_debit ?? p.next_installment_date),
    previousInstallmentDate: iso(p.previous_installment_date),
    totalInstallments: num(p.number_of_installments) ?? 0,
    remainingInstallments: num(p.remaining_installments),
    installmentsPlaced: installments.length,
    installmentsSucceeded: num(p['paid_count']) ?? succeeded,
    pause: pause ? { state: 'PAUSED', from: iso(pause['from']), to: iso(pause['to']) } : null,
    mandate: null,
    folioNumber: p.folio ?? null,
    createdAt: iso(p.created_at)!,
    cancelledAt: cancelled ? iso(p.updated_at) : null,
    reason: failureReason(p),
  };
}

export function planInstallments(p: UpOrder) {
  return installmentOrders(p).map((i, index) => installmentToOrder(p, i, index));
}

// --- investor facts (derived once per list fetch) ---------------------------------------------------

export type Facts = {
  up: UpInvestor;
  id: string;
  stage: JourneyStage;
  status: string;
  kycStatus: KycStatus;
  kycCompletedVia: 'KRA' | 'KYC_FORM' | null;
  kycNextStep: KycNextStep | null;
  kycStalled: boolean;
  invested: boolean;
  investedAmount: number;
  currentValue: number;
  activeSips: number;
  sipMonthlyAmount: number;
  nextSipDate: string | null;
  lastActivityAt: string;
  orders: UpOrder[];
  plans: UpOrder[];
};

export function kycStatusOf(up: UpInvestor, checks?: Record<string, unknown>): KycStatus {
  if (up.kyc_compliant) return 'COMPLETED';
  if (up.stage === 'mobile' || up.stage === 'pin') return 'NOT_STARTED';
  const readiness = checks?.['pan_readiness'];
  if (typeof readiness === 'string' && readiness !== 'verified') return 'PAN_CHECK_FAILED';
  return 'IN_PROGRESS';
}

function stageOf(up: UpInvestor, invested: boolean): JourneyStage {
  if (up.onboarded_at || up.stage === 'active') return invested ? 'INVESTED' : 'READY_TO_INVEST';
  return StepStage[up.stage] ?? (up.kyc_compliant ? 'PROFILE' : 'SIGNED_UP');
}

const statusOf = (up: UpInvestor): string =>
  up.stage === 'deletion_requested' ? 'DELETION_REQUESTED' : up.stage === 'deleted' ? 'DELETED' : 'ACTIVE';

/** Net amount bought: successful purchases (lumpsum and SIP instalments) less successful redemptions. */
function investedAmountOf(orders: UpOrder[], plans: UpOrder[]): number {
  let total = 0;
  for (const o of orders) {
    if (o.state !== 'successful') continue;
    if (o.kind === 'purchase') total += Number(o.amount ?? 0);
    if (o.kind === 'redemption') total -= Number(o.amount ?? 0);
  }
  for (const p of plans) {
    if (p.kind !== 'sip') continue;
    for (const i of installmentOrders(p)) if (i['state'] === 'successful') total += Number(i['amount'] ?? p.amount ?? 0);
  }
  return Math.max(0, total);
}

export function factsFor(up: UpInvestor, all: UpOrder[], values: Map<number, number>, checks?: Record<string, unknown>): Facts {
  const orders = all.filter(isOrder);
  const plans = all.filter(isPlan);
  const invested = orders.some((o) => o.kind === 'purchase' && o.state === 'successful') ||
    plans.some((p) => installmentOrders(p).some((i) => i['state'] === 'successful'));
  const kycStatus = kycStatusOf(up, checks);
  const activeSips = plans.filter((p) => p.kind === 'sip' && planActive(p));
  const nextDates = activeSips.map((p) => iso(p.next_debit ?? p.next_installment_date)).filter((d): d is string => !!d).sort();
  const investedAmount = investedAmountOf(orders, plans);
  const activity = [up.signed_up_at, up.onboarded_at, ...all.map((o) => o.updated_at)].map(ms).filter(Boolean);
  const stalled = (kycStatus === 'IN_PROGRESS' || kycStatus === 'NOT_STARTED') && Date.now() - ms(up.signed_up_at) > KycStalledHours * HourMs;
  return {
    up,
    id: uuidFor('investor', up.id),
    stage: stageOf(up, invested),
    status: statusOf(up),
    kycStatus,
    kycCompletedVia: kycStatus === 'COMPLETED' ? 'KRA' : null,
    kycNextStep: kycStatus === 'IN_PROGRESS' ? (up.stage === 'aadhaar' ? 'FETCH_PROOF' : 'PROVIDE_DETAILS') : null,
    kycStalled: stalled,
    invested,
    investedAmount,
    currentValue: values.get(up.id) ?? investedAmount,
    activeSips: activeSips.length,
    sipMonthlyAmount: activeSips.reduce((sum, p) => sum + Number(p.amount ?? 0), 0),
    nextSipDate: nextDates[0] ?? null,
    lastActivityAt: new Date(Math.max(...activity)).toISOString(),
    orders,
    plans,
  };
}

export function allFacts(lists: Lists, values: Map<number, number>): Facts[] {
  const byUser = new Map<number, UpOrder[]>();
  for (const o of lists.orders) {
    const list = byUser.get(o.user_id) ?? [];
    list.push(o);
    byUser.set(o.user_id, list);
  }
  return lists.investors
    .map((up) => factsFor(up, byUser.get(up.id) ?? [], values))
    .sort((a, b) => ms(b.up.signed_up_at) - ms(a.up.signed_up_at));
}

export function listItem(f: Facts) {
  return {
    id: f.id,
    name: f.up.name,
    email: f.up.email,
    phone: f.up.mobile ?? '',
    status: f.status,
    pan: f.up.pan_masked,
    stage: f.stage,
    kycStatus: f.kycStatus,
    kycCompletedVia: f.kycCompletedVia,
    kycNextStep: f.kycNextStep,
    investedAmount: money0(f.investedAmount),
    currentValue: money0(f.currentValue),
    activeSips: f.activeSips,
    sipMonthlyAmount: money0(f.sipMonthlyAmount),
    nextSipDate: f.nextSipDate,
    signedUpAt: iso(f.up.signed_up_at)!,
    lastLoginAt: null,
    lastActivityAt: f.lastActivityAt,
  };
}

export const supportInvestor = (f: Facts | undefined, extId: string) => ({
  id: uuidFor('investor', extId),
  name: f?.up.name ?? null,
  phone: f?.up.mobile ?? null,
  email: f?.up.email ?? null,
  pan: f?.up.pan_masked ?? null,
});

// --- transaction monitoring ------------------------------------------------------------------------

export type OrderFlag = 'FAILED' | 'PAID_NOT_CONFIRMED' | 'NOT_SUBMITTED' | 'STUCK_AT_RTA' | 'AWAITING_INVESTOR';
export const OrderFlags: OrderFlag[] = ['FAILED', 'PAID_NOT_CONFIRMED', 'NOT_SUBMITTED', 'STUCK_AT_RTA', 'AWAITING_INVESTOR'];
export const FlagLabels: Record<OrderFlag, string> = {
  FAILED: 'Failed',
  PAID_NOT_CONFIRMED: 'Paid, not confirmed',
  NOT_SUBMITTED: 'Confirmed, not submitted',
  STUCK_AT_RTA: 'Stuck at RTA',
  AWAITING_INVESTOR: 'Waiting on investor',
};

/** The same rules as the original API, timed from `updated_at` (the Admin API has no per-state timestamps). */
export function flagOf(o: UpOrder, now = Date.now()): OrderFlag | null {
  const since = now - ms(o.updated_at);
  const placed = now - ms(o.created_at);
  if (o.state === 'failed' || o.state === 'reversed') return 'FAILED';
  if (o.kind === 'purchase' && (o.state === 'pending' || o.state === 'under_review') && o.payment?.status === 'SUCCESS' && since > HourMs) {
    return 'PAID_NOT_CONFIRMED';
  }
  if (o.state === 'confirmed' && since > 24 * HourMs) return 'NOT_SUBMITTED';
  if (o.state === 'submitted' && since > 72 * HourMs) return 'STUCK_AT_RTA';
  if ((o.state === 'pending' || o.state === 'under_review') && placed > 24 * HourMs) return 'AWAITING_INVESTOR';
  return null;
}

export const MonitorStates = ['UNDER_REVIEW', 'PENDING', 'CONFIRMED', 'SUBMITTED', 'SUCCESSFUL', 'FAILED', 'CANCELLED', 'REVERSED'] as const;
export const OrderTypes = ['PURCHASE', 'SIP_INSTALLMENT', 'REDEMPTION', 'SWP_INSTALLMENT', 'SWITCH', 'STP_INSTALLMENT'] as const;

export function toMonitored(o: UpOrder, f: Facts | undefined) {
  const flag = flagOf(o);
  const paymentDone = o.payment && (o.payment.status === 'SUCCESS' || o.payment.status === 'FAILED');
  return {
    id: uuidFor('order', o.id),
    kind: o.kind as 'purchase' | 'redemption' | 'switch',
    type: OrderKinds[o.kind as keyof typeof OrderKinds],
    investor: { id: uuidFor('investor', o.user_id), name: f?.up.name ?? null, pan: f?.up.pan_masked ?? null },
    scheme: schemeName(o.fund, o.isin),
    toScheme: o.fund_to ? o.fund_to.name : null,
    folio: o.folio ?? null,
    amount: money(o.amount),
    units: unitsOf(o.units),
    state: o.state.toUpperCase() as (typeof MonitorStates)[number],
    gateway: config.orderGateway,
    payment: o.payment ? { status: o.payment.status, at: paymentDone ? iso(o.updated_at) : null } : null,
    flag,
    failureReason: failureReason(o),
    placedAt: iso(o.created_at)!,
    updatedAt: iso(o.updated_at)!,
    completedAt: o.state === 'successful' ? iso(o.succeeded_at) ?? iso(o.updated_at) : null,
  };
}

// --- holdings, payments, an investor's money -----------------------------------------------------

export function schemeFacts(fund: UpFund | null | undefined, isin: string) {
  const name = fund?.name ?? isin;
  return {
    isin,
    name,
    amc: fund?.amc ?? '',
    category: fund?.category ?? '',
    subCategory: fund?.sub_category ?? null,
    planType: /direct/i.test(name) ? 'DIRECT' : 'REGULAR',
    option: /idcw|dividend/i.test(name) ? 'IDCW' : 'GROWTH',
    latestNav: navOf(fund?.nav),
    latestNavDate: iso(fund?.nav_date),
    expenseRatio: null,
    exitLoadPercent: null,
    lockInDays: null,
  };
}

export const holdingKey = (userId: number | string, h: { isin: string; folio: string }) => `${userId}:${h.isin}:${h.folio}`;

export function toHolding(userId: number | string, h: UpHolding) {
  return {
    id: uuidFor('holding', holdingKey(userId, h)),
    scheme: schemeName(h.fund, h.isin),
    isin: h.isin,
    folioNumber: h.folio,
    units: unitsOf(h.units) ?? '0.0000',
    redeemableUnits: null,
    nav: navOf(h.nav),
    navAsOn: iso(h.nav_date),
    currentValue: money(h.current),
    investedValue: money(h.invested),
    gain: money(h.gain),
  };
}

type PaymentGroup = { up: NonNullable<UpOrder['payment']>; orders: UpOrder[] };

export function paymentGroups(orders: UpOrder[]): PaymentGroup[] {
  const groups = new Map<number, PaymentGroup>();
  for (const o of orders) {
    if (!o.payment) continue;
    const group = groups.get(o.payment.id) ?? { up: o.payment, orders: [] };
    group.orders.push(o);
    groups.set(o.payment.id, group);
  }
  return [...groups.values()];
}

export function toPayment(g: PaymentGroup) {
  const first = g.orders.reduce((a, b) => (ms(a.created_at) <= ms(b.created_at) ? a : b));
  const last = g.orders.reduce((a, b) => (ms(a.updated_at) >= ms(b.updated_at) ? a : b));
  return {
    id: uuidFor('payment', g.up.id),
    type: 'LUMPSUM',
    method: null,
    status: g.up.status,
    amount: money0(g.orders.reduce((sum, o) => sum + Number(o.amount ?? 0), 0)),
    failureReason: g.up.status === 'FAILED' ? failureReason(first) : null,
    createdAt: iso(first.created_at)!,
    settledAt: g.up.status === 'SUCCESS' ? iso(last.updated_at) : null,
  };
}

export function investments(userId: number, orders: UpOrder[], plans: UpOrder[], port: UpPortfolio | null) {
  const holdings = (port?.holdings ?? []).map((h) => toHolding(userId, h));
  const folios = new Map<string, { number: string; amcCode: string | null; holdingPattern: string | null; isins: Set<string> }>();
  for (const item of [...(port?.holdings ?? []), ...orders.filter((o) => o.folio)]) {
    const number = (item as { folio: string }).folio;
    const fund = (item as { fund?: UpFund | null }).fund;
    const entry = folios.get(number) ?? { number, amcCode: fund?.amc_short ?? null, holdingPattern: null, isins: new Set<string>() };
    entry.isins.add(item.isin);
    folios.set(number, entry);
  }
  const sips = plans.filter((p) => p.kind === 'sip');
  const active = sips.filter(planActive);
  const nextDates = active.map((p) => iso(p.next_debit ?? p.next_installment_date)).filter((d): d is string => !!d).sort();
  const nextDate = nextDates[0] ?? null;
  const onNext = active.filter((p) => iso(p.next_debit ?? p.next_installment_date) === nextDate);
  const sum = (list: UpOrder[], kind: string) =>
    list.filter((o) => o.kind === kind && o.state === 'successful').reduce((s, o) => s + Number(o.amount ?? 0), 0);
  const current = port?.summary.current ?? 0;
  const investedValue = port?.summary.invested ?? 0;
  const asOf = (port?.holdings ?? []).map((h) => h.nav_date).filter((d): d is string => !!d).sort().at(-1) ?? null;
  return {
    portfolio: {
      currentValue: money0(current),
      investedValue: money0(investedValue),
      gain: money0(current - investedValue),
      gainPercent: investedValue ? ((current - investedValue) / investedValue * 100).toFixed(2) : null,
      asOf: iso(asOf),
      holdings,
    },
    folios: [...folios.values()].map((f) => ({ number: f.number, amcCode: f.amcCode, holdingPattern: f.holdingPattern, schemes: f.isins.size })),
    plans: {
      sips: sips.map(toPlan),
      swps: plans.filter((p) => p.kind === 'swp').map(toPlan),
      stps: plans.filter((p) => p.kind === 'stp').map(toPlan),
    },
    summary: {
      activeSips: active.length,
      sipMonthlyAmount: money0(active.reduce((s, p) => s + Number(p.amount ?? 0), 0)),
      activeSwps: plans.filter((p) => p.kind === 'swp' && planActive(p)).length,
      activeStps: plans.filter((p) => p.kind === 'stp' && planActive(p)).length,
      nextSip: nextDate ? { date: nextDate, amount: money0(onNext.reduce((s, p) => s + Number(p.amount ?? 0), 0)), count: onNext.length } : null,
    },
    upcoming: plans
      .filter(planActive)
      .map((p) => ({ p, date: iso(p.next_debit ?? p.next_installment_date) }))
      .filter((x): x is { p: UpOrder; date: string } => !!x.date)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(({ p, date }) => ({
        planId: uuidFor('plan', p.id),
        kind: PlanKinds[p.kind as keyof typeof PlanKinds],
        scheme: schemeName(p.fund, p.isin),
        toScheme: p.fund_to ? p.fund_to.name : null,
        date,
        amount: money(p.amount),
        units: null,
        mandateReady: null,
        paused: Boolean(p['pause']),
      })),
    orders: [...orders.map(toOrder), ...plans.flatMap(planInstallments)].sort((a, b) => b.placedAt.localeCompare(a.placedAt)),
    orderTotals: {
      purchased: money0(sum(orders, 'purchase')),
      redeemed: money0(sum(orders, 'redemption')),
      switched: money0(sum(orders, 'switch')),
      inFlight: orders.filter(inFlight).length,
      failed: orders.filter((o) => o.state === 'failed').length,
    },
    payments: paymentGroups(orders).map(toPayment).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  };
}

export function timeline(up: UpInvestor, orders: UpOrder[], plans: UpOrder[]) {
  const events: { at: string; event: string }[] = [{ at: iso(up.signed_up_at)!, event: 'Signed up' }];
  if (up.onboarded_at) events.push({ at: iso(up.onboarded_at)!, event: 'Finished onboarding (e-sign consent)' });
  for (const o of orders) {
    const what = `${humanise(o.kind)} ${o.ref ?? ''} · ₹${money0(o.amount)} in ${schemeName(o.fund, o.isin)}`.replace('  ', ' ');
    events.push({ at: iso(o.created_at)!, event: `${what} placed` });
    if (o.state === 'successful') events.push({ at: iso(o.succeeded_at) ?? iso(o.updated_at)!, event: `${what} allotted` });
    if (o.state === 'failed') events.push({ at: iso(o.updated_at)!, event: `${what} failed: ${failureReason(o) ?? 'no reason given'}` });
  }
  for (const p of plans) {
    events.push({ at: iso(p.created_at)!, event: `${PlanKinds[p.kind as keyof typeof PlanKinds]} of ₹${money0(p.amount)} in ${schemeName(p.fund, p.isin)} registered` });
    if (p.state === 'cancelled') events.push({ at: iso(p.updated_at)!, event: `${PlanKinds[p.kind as keyof typeof PlanKinds]} cancelled` });
  }
  return events.sort((a, b) => b.at.localeCompare(a.at));
}

export function investorDetail(resp: UpDetailResponse, port: UpPortfolio | null, values: Map<number, number>) {
  const up = resp.investor;
  const checks = up.checks ?? {};
  const plans = [...(resp.sips ?? []), ...(resp.stps ?? []), ...(resp.swps ?? [])];
  const facts = factsFor(up, [...resp.orders, ...plans], port ? new Map([[up.id, port.summary.current]]) : values, checks);
  const nominee = up.nominee;
  return {
    summary: listItem(facts),
    user: {
      emailVerifiedAt: checks['email_verified'] ? iso(up.signed_up_at) : null,
      phoneVerifiedAt: checks['mobile_verified'] ? iso(up.signed_up_at) : null,
      createdAt: iso(up.signed_up_at)!,
    },
    kyc: {
      panCheck: up.pan_masked
        ? {
            at: iso(up.signed_up_at)!,
            readinessStatus: textOf(checks['pan_readiness']),
            readinessCode: null,
            readinessReason: null,
            pan: { status: checks['pan_verified'] ? 'verified' : 'failed', code: null },
            name: { status: null, code: null },
            dateOfBirth: { status: null, code: null },
          }
        : null,
      forms: [],
    },
    profile: {
      id: uuidFor('profile', up.id),
      name: up.name,
      dateOfBirth: up.dob ?? null,
      gender: up.gender ?? null,
      occupation: up.occupation ?? null,
      taxStatus: null,
      incomeSlab: up.income_slab ?? null,
      addresses: up.address
        ? [{ city: up.address.city ?? null, state: up.address.state ?? null, postalCode: up.address.pincode ?? '', country: 'IN' }]
        : [],
    },
    bankAccounts: up.bank
      ? [{
          id: uuidFor('bank', up.id),
          bankName: up.bank.bank_name,
          accountNumber: up.bank.account_masked,
          ifscCode: up.bank.ifsc,
          type: 'unknown',
          isPayout: true,
          verificationStatus: up.bank.verified ? 'verified' : 'pending',
          verificationConfidence: null,
          verifiedAt: null,
        }]
      : [],
    nomination: {
      optedOut: Boolean(up.nominee_opted_out),
      nominees: nominee
        ? [{
            name: String(nominee['name'] ?? ''),
            relationship: String(nominee['relationship'] ?? nominee['relation'] ?? ''),
            allocationPercentage: String(nominee['allocation_percentage'] ?? nominee['allocation'] ?? '100'),
          }]
        : [],
    },
    mandates: [],
    investments: investments(up.id, resp.orders, plans, port),
    timeline: timeline(up, resp.orders, plans),
  };
}

export const orderEvents = (o: UpOrder) => {
  const events = [{ at: iso(o.created_at)!, label: 'Placed' }];
  if (o.payment) events.push({ at: iso(o.updated_at)!, label: `Payment ${o.payment.status.toLowerCase()}` });
  if (o.traded_on) events.push({ at: iso(o.traded_on)!, label: 'Traded' });
  if (o.state === 'successful') events.push({ at: iso(o.succeeded_at) ?? iso(o.updated_at)!, label: 'Units allotted' });
  else events.push({ at: iso(o.updated_at)!, label: o.status ?? humanise(o.state) });
  return events.sort((a, b) => a.at.localeCompare(b.at));
};
