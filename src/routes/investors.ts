// Dashboard, the investor list and one investor's full record.
import { actorOf, audit, authenticate, need } from '../auth.ts';
import { Csv, HttpError, listParam, page, pageParams, toCsv, uuidParam, type Router } from '../http.ts';
import { investorExtId, snapshot, type Snapshot } from '../investors.ts';
import {
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
import { currentValues, valuationAsOf } from '../valuation.ts';

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

function summary(snap: Snapshot) {
  const f = snap.facts;
  const today = istStartOfToday();
  const signups = f.map((x) => ms(x.up.signed_up_at));
  const kycValues = f.map((x) => x.kycStatus);
  const ready = f.filter((x) => x.stage === 'READY_TO_INVEST' || x.stage === 'INVESTED').length;
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
    funnel: [
      { key: 'SIGNED_UP', label: 'Signed up', count: f.length },
      { key: 'KYC_STARTED', label: 'Started KYC', count: f.filter((x) => x.kycStatus !== 'NOT_STARTED').length },
      { key: 'KYC_COMPLETED', label: 'KYC completed', count: kycValues.filter((k) => k === 'COMPLETED').length },
      { key: 'PROFILE', label: 'Profile created', count: f.filter((x) => ['ACCOUNT_SETUP', 'READY_TO_INVEST', 'INVESTED'].includes(x.stage)).length },
      { key: 'INVESTMENT_ACCOUNT', label: 'Investment account', count: ready },
      { key: 'READY_TO_INVEST', label: 'Ready to invest', count: ready },
      { key: 'INVESTED', label: 'Invested', count: f.filter((x) => x.stage === 'INVESTED').length },
    ],
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
  const stalled = query.get('kycStalled') === 'true';
  const sipDue = query.get('sipDueDays') ? Number(query.get('sipDueDays')) : null;
  const attention = query.get('attention');
  const dueBy = sipDue !== null ? istDate(Date.now() + sipDue * DayMs) : null;
  return snap.facts.filter((f) => {
    if (search) {
      const hay = [f.up.name, f.up.email, f.up.mobile, f.up.pan_masked, String(f.up.id), f.id].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(search)) return false;
    }
    if (stages.length && !stages.includes(f.stage)) return false;
    if (kyc.length && !kyc.includes(f.kycStatus)) return false;
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

  router.get('/dashboard/summary', full, need('dashboard.read'), async (ctx) => summary(await snapshot(ctx)));

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

    if (type === 'holding') {
      const port = await portfolio(extId, actor);
      const h = port.holdings.find((x) => uuidFor('holding', holdingKey(extId, x)) === itemId);
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
          fpId: p.fp_id ?? p.id,
          gateway: null,
          requestedActivationDate: null,
          activatedAt: null,
          completedAt: p.state === 'completed' ? iso(p.updated_at) : null,
          failedAt: p.state === 'failed' ? iso(p.updated_at) : null,
          autoCancelled: null,
          cancellationCode: p.state === 'cancelled' ? p.failure_code ?? null : null,
          cancellationScheduledOn: null,
          consentAt: null,
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
          consent: null,
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
