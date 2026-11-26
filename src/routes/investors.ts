// Dashboard, the investor list and one investor's full record.
import { actorOf, audit, authenticate, need } from '../auth.ts';
import { all } from '../db.ts';
import { Csv, HttpError, listParam, page, pageParams, toCsv, uuidParam, type Router } from '../http.ts';
import { investorExtId, snapshot, type Snapshot } from '../investors.ts';
import {
  AccountTypeLabels,
  AccountTypes,
  findInstallment,
  installmentToOrder,
  investorDetail,
  isOrder,
  istDate,
  IstOffsetMs,
  JourneyStages,
  KycNextSteps,
  KycStatuses,
  KycStatusLabels,
  listItem,
  money0,
  ms,
  NextStepLabels,
  orderEvents,
  paymentGroups,
  planActive,
  planInstallments,
  schemeFacts,
  StageLabels,
  toHolding,
  toOrder,
  toPayment,
  toPlan,
  holdingKey,
  iso,
  type Facts,
  type JourneyStage,
} from '../map.ts';
import { uuidFor } from '../security.ts';
import { investorDetail as fetchDetail, portfolio, type UpDetailResponse, type UpOrder } from '../upstream.ts';
import { AssetClasses, AssetClassLabels, currentBreakdowns, currentValues, valuationAsOf } from '../valuation.ts';
import { monitored } from './transactions.ts';
import type { Ctx } from '../http.ts';

const DayMs = 86_400_000;

/** A SIP, SWP or STP instalment opened from a transactions or orders row: it lives on its plan, not as an order. */
function installmentItem(plans: UpOrder[], itemId: string, type: string, bank: UpDetailResponse['investor']['bank']) {
  const found = findInstallment(plans, itemId);
  if (!found) throw HttpError.notFound('That order could not be found.');
  const { plan, installment: i, index } = found;
  const order = installmentToOrder(plan, i, index);
  if (order.kind.toLowerCase() !== type) throw HttpError.notFound('That order could not be found.');
  const text = (key: string) => (typeof i[key] === 'string' && i[key] ? (i[key] as string) : null);
  return {
    type: 'order',
    order: {
      ...order,
      fpId: text('id') ?? plan.id,
      sourceRefId: null,
      gateway: null,
      subtype: i['upfront'] === true ? 'first_instalment' : null,
      failureCode: text('failure_code'),
      navDate: text('traded_on'),
      scheduledOn: text('scheduled_on'),
      tradedOn: text('traded_on'),
      initiatedBy: null,
      initiatedVia: null,
      consent: null,
      payoutAccount: plan.kind === 'swp' && bank ? { accountNumber: bank.account_masked, ifsc: bank.ifsc } : null,
      plan: { id: uuidFor('plan', plan.id), kind: toPlan(plan).kind, scheme: order.scheme },
      payments: [],
      events: [],
      schemeFacts: schemeFacts(plan.fund, plan.isin),
    },
  };
}

const SetupStages = new Set<JourneyStage>(['KYC_COMPLETED', 'PROFILE', 'ACCOUNT_SETUP']);

function istStartOfToday(): number {
  const now = Date.now() + IstOffsetMs;
  return now - (now % DayMs) - IstOffsetMs;
}

function count<K extends string>(keys: readonly K[], labels: Record<K, string>, values: K[]) {
  return keys.map((key) => ({ key, label: labels[key], count: values.filter((v) => v === key).length }));
}

/** Each milestone counted on its own, as a count of everyone in `f`. A HUF's KYC is the KRA check on the HUF PAN. */
function funnelOf(f: Facts[]) {
  const ready = f.filter((x) => x.stage === 'READY_TO_INVEST' || x.stage === 'INVESTED').length;
  return [
    { key: 'SIGNED_UP', label: 'Signed up', count: f.length },
    { key: 'KYC_STARTED', label: 'Started KYC', count: f.filter((x) => x.kycStatus !== 'NOT_STARTED').length },
    { key: 'KYC_COMPLETED', label: 'KYC completed', count: f.filter((x) => x.kycStatus === 'COMPLETED').length },
    { key: 'PROFILE', label: 'Profile created', count: f.filter((x) => ['ACCOUNT_SETUP', 'READY_TO_INVEST', 'INVESTED'].includes(x.stage)).length },
    { key: 'INVESTMENT_ACCOUNT', label: 'Investment account', count: ready },
    { key: 'READY_TO_INVEST', label: 'Ready to invest', count: ready },
    { key: 'INVESTED', label: 'Invested', count: f.filter((x) => x.stage === 'INVESTED').length },
  ];
}

function summary(snap: Snapshot) {
  const f = snap.facts;
  const today = istStartOfToday();
  const signups = f.map((x) => ms(x.up.signed_up_at));
  const kycValues = f.map((x) => x.kycStatus);
  const purchases = snap.orders.filter((o) => o.kind === 'purchase' && o.state === 'successful');
  const activeSips = snap.orders.filter((o) => o.kind === 'sip' && planActive(o));
  const statuses = [...new Set(f.map((x) => x.status))];
  return {
    generatedAt: new Date().toISOString(),
    dataAsOf: snap.fetchedAt,
    signups: {
      total: f.length,
      today: signups.filter((t) => t >= today).length,
      last7Days: signups.filter((t) => t >= Date.now() - 7 * DayMs).length,
      last30Days: signups.filter((t) => t >= Date.now() - 30 * DayMs).length,
    },
    usersByStatus: statuses.map((s) => ({ key: s, label: s.charAt(0) + s.slice(1).toLowerCase().replaceAll('_', ' '), count: f.filter((x) => x.status === s).length })),
    kyc: {
      byStatus: count(KycStatuses, KycStatusLabels, kycValues),
      completed: kycValues.filter((k) => k === 'COMPLETED').length,
      completedVia: { kra: f.filter((x) => x.kycCompletedVia === 'KRA').length, kycForm: 0 },
      inProgressByStep: count(KycNextSteps, NextStepLabels, f.map((x) => x.kycNextStep).filter((s): s is NonNullable<typeof s> => !!s)),
    },
    journey: { byStage: count(JourneyStages, StageLabels, f.map((x) => x.stage)) },
    accountTypes: count(AccountTypes, AccountTypeLabels, f.map((x) => x.accountType)),
    funnel: funnelOf(f),
    funnelByAccountType: Object.fromEntries(AccountTypes.map((t) => [t, funnelOf(f.filter((x) => x.accountType === t))])),
    attention: {
      kycStalled: f.filter((x) => x.kycStalled).length,
      kycFailedOrExpired: f.filter((x) => x.kycStatus === 'FAILED' || x.kycStatus === 'EXPIRED').length,
      panCheckFailed: f.filter((x) => x.kycStatus === 'PAN_CHECK_FAILED').length,
      accountNotReady: f.filter((x) => SetupStages.has(x.stage)).length,
    },
    investments: {
      investedInvestors: f.filter((x) => x.invested).length,
      successfulPurchases: purchases.length,
      purchasedAmount: money0(purchases.reduce((s, o) => s + Number(o.amount ?? 0), 0)),
      currentValue: money0(f.reduce((s, x) => s + x.currentValue, 0)),
      activeSips: activeSips.length,
      activeSipMonthlyAmount: money0(activeSips.reduce((s, o) => s + Number(o.amount ?? 0), 0)),
      mandatesByStatus: [],
    },
  };
}

/** The India-local month ('YYYY-MM') of an instant, and the last `n` months ending with this one, oldest first. */
const istMonth = (at: number): string => istDate(at).slice(0, 7);
function lastMonths(n: number): string[] {
  const [y, m] = istMonth(Date.now()).split('-').map(Number) as [number, number];
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - (n - 1 - i), 1));
    return d.toISOString().slice(0, 7);
  });
}
/** The first instant after an India-local month ends. */
const monthEndMs = (month: string): number => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return Date.UTC(y, m, 1) - IstOffsetMs;
};

const EndedPlanStates = new Set(['cancelled', 'completed', 'expired']);
const OpenTicketStates = ['OPEN', 'IN_PROGRESS', 'WAITING_ON_INVESTOR'];

/** Money that moved, with when: successful lumpsum purchases, SIP instalments and redemptions. */
function flows(snap: Snapshot) {
  const out: { at: number; kind: 'LUMPSUM' | 'SIP' | 'REDEMPTION'; amount: number }[] = [];
  for (const o of snap.orders) {
    if (o.state !== 'successful' || (o.kind !== 'purchase' && o.kind !== 'redemption')) continue;
    const at = ms(o.succeeded_at ?? o.traded_on ?? o.created_at);
    const amount = Number(o.processed_amount ?? o.amount ?? 0);
    if (at && amount) out.push({ at, kind: o.kind === 'purchase' ? 'LUMPSUM' : 'REDEMPTION', amount });
  }
  for (const p of snap.orders) {
    if (p.kind !== 'sip' || !Array.isArray(p.installments)) continue;
    for (const i of p.installments) {
      if (i['state'] !== 'successful') continue;
      const at = ms(i['succeeded_at'] ?? i['traded_on'] ?? i['scheduled_on'] ?? i['created_at']);
      const amount = Number(i['amount'] ?? p.amount ?? 0);
      if (at && amount) out.push({ at, kind: 'SIP', amount });
    }
  }
  return out;
}

/**
 * The overview the dashboard's first screen shows: business, investor and support figures, the AUM split by asset
 * class, SIP and AUM trends, the work queues and the newest investors. Support and flagged-transaction counts are
 * null for staff who can't see those areas.
 */
async function overview(snap: Snapshot, ctx: Ctx) {
  const f = snap.facts.filter((x) => x.status !== 'DELETED');
  const breakdowns = currentBreakdowns();
  const now = Date.now();
  const thisMonth = istMonth(now);
  const active = (x: (typeof f)[number]) => x.currentValue > 0 || x.activeSips > 0;
  const aum = f.reduce((s, x) => s + x.currentValue, 0);

  const byClass = Object.fromEntries(AssetClasses.map((k) => [k, 0])) as Record<(typeof AssetClasses)[number], number>;
  for (const x of f) {
    const b = breakdowns.get(x.up.id);
    if (b) for (const k of AssetClasses) byClass[k] += b.byClass[k];
  }
  const classified = AssetClasses.reduce((s, k) => s + byClass[k], 0);

  const hufRows = await all<{ n: number }>("SELECT COUNT(*) AS n FROM hufs WHERE client_code LIKE 'RSPH%'");

  // SIPs: started in each month, and running at its end (registered by then and not yet cancelled or finished).
  const sips = snap.orders.filter((o) => o.kind === 'sip' && o.state !== 'failed' && o.state !== 'created');
  const money = flows(snap);
  const sipMonths = lastMonths(6).map((month) => {
    const end = monthEndMs(month);
    const inMonth = (at: number) => at > 0 && istMonth(at) === month;
    return {
      month,
      started: sips.filter((p) => inMonth(ms(p.created_at))).length,
      running: sips.filter((p) => ms(p.created_at) < end && (planActive(p) || (EndedPlanStates.has(p.state) && ms(p.updated_at) >= end))).length,
      sipAmount: money0(money.filter((m) => m.kind === 'SIP' && inMonth(m.at)).reduce((s, m) => s + m.amount, 0)),
      lumpsumAmount: money0(money.filter((m) => m.kind === 'LUMPSUM' && inMonth(m.at)).reduce((s, m) => s + m.amount, 0)),
    };
  });

  // Past months: the net amount invested by each month's end (no market values were kept then). This month: AUM.
  const aumMonths = lastMonths(12).map((month) => {
    if (month === thisMonth) return { month, value: money0(aum), basis: 'MARKET_VALUE' as const };
    const end = monthEndMs(month);
    const net = money.filter((m) => m.at < end).reduce((s, m) => s + (m.kind === 'REDEMPTION' ? -m.amount : m.amount), 0);
    return { month, value: money0(Math.max(0, net)), basis: 'NET_INVESTED' as const };
  });

  const perms = ctx.staff!.permissions;
  let support: { open: number; escalated: number } | null = null;
  if (perms.has('support.manage')) {
    const tickets = await all<{ priority: string; sla_due_at: string }>(
      `SELECT priority, sla_due_at FROM tickets WHERE status IN (${OpenTicketStates.map(() => '?').join(', ')})`, ...OpenTicketStates,
    );
    support = {
      open: tickets.length,
      escalated: tickets.filter((t) => t.priority === 'URGENT' || Date.parse(t.sla_due_at) < now).length,
    };
  }

  const flagged = perms.has('transactions.read') ? monitored(snap).filter((r) => r.view.flag).length : null;
  const monthAgo = now - 30 * DayMs;
  let failedSipDebits = 0;
  for (const p of snap.orders) {
    if (p.kind !== 'sip' || !Array.isArray(p.installments)) continue;
    for (const i of p.installments) {
      if (i['state'] === 'failed' && ms(i['failed_at'] ?? i['scheduled_on'] ?? i['updated_at'] ?? p.updated_at) >= monthAgo) failedSipDebits += 1;
    }
  }

  const folioOf = (x: (typeof f)[number]) =>
    breakdowns.get(x.up.id)?.folios[0] ?? [...x.orders, ...x.plans].find((o) => o.folio)?.folio ?? null;

  return {
    business: {
      aum: money0(aum),
      activeSips: f.reduce((s, x) => s + x.activeSips, 0),
      activeInvestors: f.filter(active).length,
    },
    investors: {
      total: f.length,
      newThisMonth: f.filter((x) => istMonth(ms(x.up.signed_up_at)) === thisMonth).length,
      newLast30Days: f.filter((x) => ms(x.up.signed_up_at) >= monthAgo).length,
      pendingKyc: f.filter((x) => x.kycStatus === 'NOT_STARTED' || x.kycStatus === 'IN_PROGRESS').length,
      kycRejections: f.filter((x) => x.kycStatus === 'FAILED' || x.kycStatus === 'EXPIRED' || x.kycStatus === 'PAN_CHECK_FAILED').length,
      families: f.filter((x) => x.accountType === 'HUF').length + Number(hufRows[0]?.n ?? 0),
      elssInvestors: f.filter((x) => breakdowns.get(x.up.id)?.elss).length,
      active: f.filter(active).length,
      inactive: f.filter((x) => !active(x)).length,
    },
    support,
    assetClasses: AssetClasses.map((key) => ({
      key,
      label: AssetClassLabels[key],
      value: money0(byClass[key]),
      share: classified > 0 ? Math.round((byClass[key] / classified) * 1000) / 10 : 0,
    })),
    sipMonths,
    aumMonths,
    queues: {
      failedSipDebits,
      kycPending: f.filter((x) => x.kycStatus === 'NOT_STARTED' || x.kycStatus === 'IN_PROGRESS').length,
      flaggedTransactions: flagged,
    },
    recentInvestors: [...f]
      .sort((a, b) => ms(b.up.signed_up_at) - ms(a.up.signed_up_at))
      .slice(0, 5)
      .map((x) => ({
        id: x.id,
        name: x.up.name,
        pan: x.up.pan_masked,
        folio: folioOf(x),
        aum: money0(x.currentValue),
        status: x.status === 'DELETION_REQUESTED' ? 'DELETION_REQUESTED' : active(x) ? 'ACTIVE' : 'INACTIVE',
        signedUpAt: iso(x.up.signed_up_at),
      })),
    valuedAt: valuationAsOf(),
  };
}

function bucketStart(date: string, bucket: string): string {
  if (bucket === 'month') return `${date.slice(0, 7)}-01`;
  if (bucket === 'week') {
    const d = new Date(`${date}T00:00:00Z`);
    const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DayMs);
    return monday.toISOString().slice(0, 10);
  }
  return date;
}

function filtered(snap: Snapshot, query: URLSearchParams): Facts[] {
  const search = query.get('search')?.trim().toLowerCase();
  const stages = listParam(query, 'stage', JourneyStages);
  const kyc = listParam(query, 'kycStatus', KycStatuses);
  const types = listParam(query, 'accountType', AccountTypes);
  const stalled = query.get('kycStalled') === 'true';
  const sipDue = query.get('sipDueDays') ? Number(query.get('sipDueDays')) : null;
  const attention = query.get('attention');
  const dueBy = sipDue !== null ? istDate(Date.now() + sipDue * DayMs) : null;
  // The dashboard's cards (active / inactive, new, ELSS investors), counted the same way as there.
  const activity = query.get('active');
  const joined = query.get('joined');
  const elss = query.get('elss') === 'true';
  const thisMonth = istMonth(Date.now());
  const since30 = Date.now() - 30 * DayMs;
  const breakdowns = elss ? currentBreakdowns() : null;
  return snap.facts.filter((f) => {
    if ((activity || joined || elss) && f.status === 'DELETED') return false;
    const isActive = f.currentValue > 0 || f.activeSips > 0;
    if (activity === 'true' && !isActive) return false;
    if (activity === 'false' && isActive) return false;
    if (breakdowns && !breakdowns.get(f.up.id)?.elss) return false;
    if (joined === 'month' && istMonth(ms(f.up.signed_up_at)) !== thisMonth) return false;
    if (joined === '30d' && !(ms(f.up.signed_up_at) >= since30)) return false;
    if (search) {
      const hay = [f.up.name, f.up.email, f.up.mobile, f.up.pan_masked, String(f.up.id), f.id].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(search)) return false;
    }
    if (stages.length && !stages.includes(f.stage)) return false;
    if (kyc.length && !kyc.includes(f.kycStatus)) return false;
    if (types.length && !types.includes(f.accountType)) return false;
    if (stalled && !f.kycStalled) return false;
    if (dueBy && (!f.nextSipDate || f.nextSipDate > dueBy)) return false;
    if (attention === 'KYC' && f.stage !== 'KYC') return false;
    if (attention === 'SETUP' && !SetupStages.has(f.stage)) return false;
    return true;
  });
}

const ExportColumns = [
  { key: 'name', label: 'Name' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Mobile' },
  { key: 'pan', label: 'PAN (masked)' },
  { key: 'accountType', label: 'Account type' },
  { key: 'stage', label: 'Stage' },
  { key: 'kycStatus', label: 'KYC' },
  { key: 'investedAmount', label: 'Invested (₹)' },
  { key: 'currentValue', label: 'Current value (₹)' },
  { key: 'activeSips', label: 'Active SIPs' },
  { key: 'sipMonthlyAmount', label: 'SIP per month (₹)' },
  { key: 'nextSipDate', label: 'Next SIP' },
  { key: 'signedUpAt', label: 'Signed up' },
];

export function investorRoutes(router: Router): void {
  const full = authenticate('full');

  router.get('/dashboard/summary', full, need('dashboard.read'), async (ctx) => {
    const snap = await snapshot(ctx);
    return { ...summary(snap), overview: await overview(snap, ctx) };
  });

  router.get('/dashboard/signups', full, need('dashboard.read'), async (ctx) => {
    const snap = await snapshot(ctx);
    const bucket = ['day', 'week', 'month'].includes(ctx.query.get('bucket') ?? '') ? ctx.query.get('bucket')! : 'day';
    const to = /^\d{4}-\d{2}-\d{2}$/.test(ctx.query.get('to') ?? '') ? ctx.query.get('to')! : istDate(Date.now());
    const from = /^\d{4}-\d{2}-\d{2}$/.test(ctx.query.get('from') ?? '') ? ctx.query.get('from')! : istDate(Date.parse(to) - 29 * DayMs);
    const points = new Map<string, { date: string; signups: number; kycCompleted: number }>();
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DayMs) {
      const key = bucketStart(new Date(t).toISOString().slice(0, 10), bucket);
      if (!points.has(key)) points.set(key, { date: key, signups: 0, kycCompleted: 0 });
    }
    for (const f of snap.facts) {
      const day = istDate(ms(f.up.signed_up_at));
      if (day < from || day > to) continue;
      const point = points.get(bucketStart(day, bucket));
      if (!point) continue;
      point.signups += 1;
      // The PAN/KRA check happens minutes after sign-up, so a compliant investor's KYC is counted on their sign-up day.
      if (f.kycStatus === 'COMPLETED') point.kycCompleted += 1;
    }
    return { bucket, from, to, points: [...points.values()] };
  });

  router.get('/investors', full, need('investors.read'), async (ctx) => {
    const rows = filtered(await snapshot(ctx), ctx.query);
    const { offset, limit } = pageParams(ctx.query);
    const { items, nextCursor } = page(rows, offset, limit);
    return { items: items.map(listItem), total: rows.length, nextCursor };
  });

  router.get('/investors/overview', full, need('investors.read'), async (ctx) => {
    const f = (await snapshot(ctx)).facts;
    const dueBy = istDate(Date.now() + 7 * DayMs);
    const byStage = Object.fromEntries(JourneyStages.map((s) => [s, f.filter((x) => x.stage === s).length]));
    return {
      total: f.length,
      byStage,
      byAccountType: Object.fromEntries(AccountTypes.map((t) => [t, f.filter((x) => x.accountType === t).length])),
      kycPending: f.filter((x) => x.kycStatus !== 'COMPLETED').length,
      kycStalled: f.filter((x) => x.kycStalled).length,
      attention: { KYC: f.filter((x) => x.stage === 'KYC').length, SETUP: f.filter((x) => SetupStages.has(x.stage)).length },
      activeSips: f.reduce((s, x) => s + x.activeSips, 0),
      sipDueIn7Days: f.filter((x) => x.nextSipDate && x.nextSipDate <= dueBy).length,
    };
  });

  router.post('/investors/nudge', full, need('investors.read'), () => {
    throw HttpError.unavailable('Reminders reach investors through the app backend, which does not offer them to the admin yet.');
  });

  router.get('/investors/export', full, need('investors.read'), async (ctx) => {
    const rows = filtered(await snapshot(ctx), ctx.query).map(listItem);
    await audit(ctx, 'investors.exported', null, { rows: rows.length, filters: Object.fromEntries(ctx.query) });
    return new Csv(`risips-investors-${istDate(Date.now())}.csv`, toCsv(ExportColumns, rows));
  });

  router.get('/investors/:userId', full, need('investors.read'), async (ctx) => {
    const extId = await investorExtId(ctx, uuidParam(ctx, 'userId'));
    const actor = actorOf(ctx);
    const [resp, port] = await Promise.all([fetchDetail(extId, actor), portfolio(extId, actor).catch(() => null)]);
    return investorDetail(resp, port, currentValues());
  });

  router.get('/investors/:userId/items/:type/:itemId', full, need('investors.read'), async (ctx) => {
    const extId = await investorExtId(ctx, uuidParam(ctx, 'userId'));
    const itemId = uuidParam(ctx, 'itemId');
    const type = ctx.params.type!;
    const actor = actorOf(ctx);
    const resp = await fetchDetail(extId, actor);
    const plans = [...(resp.sips ?? []), ...(resp.stps ?? []), ...(resp.swps ?? [])];
    const bank = resp.investor.bank;
    const mandate = resp.investor.mandate ?? null;

    if (type === 'holding') {
      const port = await portfolio(extId, actor);
      const h = (port.holdings ?? []).find((x) => uuidFor('holding', holdingKey(extId, x)) === itemId);
      if (!h) throw HttpError.notFound('That holding could not be found.');
      const related = resp.orders.filter((o) => o.isin === h.isin && (!o.folio || o.folio === h.folio));
      return {
        type: 'holding',
        holding: {
          ...toHolding(extId, h),
          unitsAsOn: iso(h.nav_date),
          currentValueAsOn: iso(h.nav_date),
          investedValueAsOn: iso(h.nav_date),
          payoutAmount: null,
          schemeFacts: schemeFacts(h.fund, h.isin),
          folio: { number: h.folio, amcCode: h.fund?.amc_short ?? null, holdingPattern: null },
          orders: related.map(toOrder),
          plans: plans.filter((p) => p.isin === h.isin).map((p) => {
            const plan = toPlan(p);
            return { id: plan.id, kind: plan.kind, state: plan.state, amount: plan.amount, frequency: plan.frequency, nextInstallmentDate: plan.nextInstallmentDate };
          }),
        },
      };
    }

    if (type === 'sip' || type === 'swp' || type === 'stp') {
      const p = plans.find((x) => x.kind === type && uuidFor('plan', x.id) === itemId);
      if (!p) throw HttpError.notFound('That plan could not be found.');
      return {
        type: 'plan',
        plan: {
          ...toPlan(p),
          // A SIP's mandate in full on its own panel (the UMRN comes masked from the app).
          mandate: p.kind === 'sip' && mandate ? { type: mandate.type ?? 'unknown', status: mandate.status ?? 'UNKNOWN', umrn: mandate.umrn_masked } : null,
          fpId: p.fp_id ?? p.id,
          gateway: null,
          requestedActivationDate: null,
          activatedAt: null,
          completedAt: p.state === 'completed' ? iso(p.updated_at) : null,
          failedAt: p.state === 'failed' ? iso(p.updated_at) : null,
          autoCancelled: null,
          cancellationCode: p.state === 'cancelled' ? p.failure_code ?? null : null,
          cancellationScheduledOn: null,
          consentAt: iso(p.consent?.at),
          paymentMethod: p.kind === 'sip' ? 'mandate' : null,
          purpose: null,
          installments: planInstallments(p),
          events: [{ at: iso(p.created_at)!, label: 'Registered' }, ...(p.state !== 'active' ? [{ at: iso(p.updated_at)!, label: p.status ?? p.state }] : [])],
          schemeFacts: schemeFacts(p.fund, p.isin),
        },
      };
    }

    if (type === 'purchase' || type === 'redemption' || type === 'switch') {
      const o = resp.orders.find((x) => x.kind === type && uuidFor('order', x.id) === itemId);
      if (!o) return installmentItem(plans, itemId, type, bank);
      const payments = paymentGroups(resp.orders).filter((g) => g.orders.some((x) => x.id === o.id)).map(toPayment);
      return {
        type: 'order',
        order: {
          ...toOrder(o),
          fpId: o.fp_id ?? o.id,
          sourceRefId: o.ref ?? null,
          gateway: null,
          subtype: null,
          failureCode: o.failure_code ?? null,
          navDate: o.traded_on ?? null,
          scheduledOn: null,
          tradedOn: o.traded_on ?? null,
          initiatedBy: null,
          initiatedVia: null,
          // The investor's 2FA OTP for this order: when, and how. The app never sends the mobile or email it went to.
          consent: o.consent ? { at: iso(o.consent.at)!, via: o.consent.via } : null,
          payoutAccount: o.kind === 'redemption' && bank ? { accountNumber: bank.account_masked, ifsc: bank.ifsc } : null,
          plan: null,
          payments,
          events: orderEvents(o),
          schemeFacts: schemeFacts(o.fund, o.isin),
        },
      };
    }

    if (type === 'payment') {
      const g = paymentGroups(resp.orders).find((x) => uuidFor('payment', x.up.id) === itemId);
      if (!g) throw HttpError.notFound('That payment could not be found.');
      const sorted = [...g.orders].sort((a: UpOrder, b: UpOrder) => ms(a.created_at) - ms(b.created_at));
      return {
        type: 'payment',
        payment: {
          ...toPayment(g),
          fpId: g.up.id,
          provider: null,
          debitDate: null,
          failureCode: g.up.status === 'FAILED' ? sorted[0]!.failure_code ?? null : null,
          lateAuth: null,
          refund: null,
          mandate: null,
          bankAccount: bank ? { bankName: bank.bank_name, accountNumber: bank.account_masked } : null,
          purchases: sorted.filter(isOrder).map(toOrder),
          events: [
            { at: iso(sorted[0]!.created_at)!, label: 'Payment started' },
            { at: iso(sorted.at(-1)!.updated_at)!, label: `Payment ${g.up.status.toLowerCase()}` },
          ],
        },
      };
    }

    throw HttpError.notFound();
  });

  // How fresh the dashboard's current values are (not part of the original API; handy when checking the job).
  router.get('/valuations', full, need('dashboard.read'), () => ({ valuedAt: valuationAsOf(), investors: currentValues().size }));
}
