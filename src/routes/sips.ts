// Active SIPs: every SIP across investors in one list, with the SIP book (monthly amount, average per client, bounced)
// on top, and one SIP in full. Built from the same snapshot as the dashboard.
// Staff with sips.manage can also pause, resume, change or cancel a SIP, or redeem from its fund, for the investor: the
// app backend sends the investor an OTP, the investor reads it out, and the app backend runs the app's own code with
// it (its ADMIN_API_ACTIONS). Nothing here reaches FP directly.
import { actorOf, audit, authenticate, need } from '../auth.ts';
import { Csv, HttpError, listParam, page, pageParams, toCsv, uuidParam, type Ctx, type Router } from '../http.ts';
import { snapshot, type Snapshot } from '../investors.ts';
import { iso, istDate, money, money0, ms, planActive, unitsOf } from '../map.ts';
import { uuidFor } from '../security.ts';
import { investorDetail, upstreamPost, type UpOrder } from '../upstream.ts';

/** What staff can do to a SIP. Each is also the OTP action the app backend sends the investor a code for. */
export const SipActions = ['sip_pause', 'sip_resume', 'sip_modify', 'sip_cancel', 'redeem'] as const;
type SipAction = (typeof SipActions)[number];
const ActionLabels: Record<SipAction, string> = {
  sip_pause: 'Pause SIP', sip_resume: 'Resume SIP', sip_modify: 'Modify SIP', sip_cancel: 'Cancel SIP', redeem: 'Redeem',
};
const CancelCodes = ['amount_not_available', 'investment_returns_not_as_expected', 'amc_support_not_satisfactory', 'exit_load_not_as_expected',
  'switch_to_other_scheme', 'fund_manager_changed', 'investment_goal_complete', 'mandate_not_ready', 'invest_later', 'customer_support_not_satisfactory'] as const;

export const SipStatuses = ['ACTIVE', 'PAUSED', 'BOUNCED', 'AWAITING_PAYMENT', 'CANCELLED', 'COMPLETED', 'FAILED'] as const;
export type SipStatus = (typeof SipStatuses)[number];
/** Running: a live plan, whatever its last instalment did. */
const Running = new Set<SipStatus>(['ACTIVE', 'PAUSED', 'BOUNCED', 'AWAITING_PAYMENT']);
export const SipFrequencies = ['daily', 'weekly', 'fortnightly', 'monthly', 'quarterly'] as const;
const Sorts = ['next', 'amount', 'start', 'investor'] as const;

/** How many times a year each frequency debits, to put every SIP on a monthly footing. */
const PerYear: Record<string, number> = { daily: 250, weekly: 52, fortnightly: 26, monthly: 12, quarterly: 4, half_yearly: 2, yearly: 1 };
const monthly = (amount: number, frequency: string) => (amount * (PerYear[frequency] ?? 12)) / 12;

type Instalment = Record<string, unknown>;
const instalments = (p: UpOrder): Instalment[] => (Array.isArray(p.installments) ? p.installments : []);
const when = (i: Instalment) => ms(i['scheduled_on'] ?? i['traded_on'] ?? i['created_at']);

/**
 * Where a SIP stands, as staff think of it. Bounced: live, but its latest instalment failed. Paused: skipping
 * instalments now. Awaiting payment: registered, first instalment not paid yet.
 */
export function sipStatusOf(p: UpOrder): SipStatus {
  if (p.state === 'cancelled') return 'CANCELLED';
  if (p.state === 'completed' || p.state === 'expired') return 'COMPLETED';
  if (!planActive(p)) return 'FAILED';
  if (p['pause']) return 'PAUSED';
  const latest = instalments(p).filter((i) => i['state'] !== 'cancelled').sort((a, b) => when(b) - when(a))[0];
  if (latest?.['state'] === 'failed') return 'BOUNCED';
  if (p.state === 'awaiting_payment') return 'AWAITING_PAYMENT';
  return 'ACTIVE';
}

function rowsOf(snap: Snapshot) {
  return snap.orders
    .filter((p) => p.kind === 'sip')
    .map((p) => {
      const investor = snap.byExtId.get(String(p.user_id));
      const list = instalments(p);
      const paid = Number(p['paid_count'] ?? list.filter((i) => i['state'] === 'successful').length);
      const folio = p.folio ?? (list.find((i) => typeof i['folio'] === 'string' && i['folio'])?.['folio'] as string | undefined) ?? null;
      const frequency = p.frequency ?? 'monthly';
      return {
        id: uuidFor('plan', p.id),
        reference: p.ref ?? p.id,
        investor: investor ? { id: investor.id, name: investor.up.name, pan: investor.up.pan_masked } : null,
        folio,
        scheme: p.fund?.name ?? p.isin,
        isin: p.isin,
        amc: p.fund?.amc_short ?? p.fund?.amc ?? null,
        amount: money0(p.amount),
        frequency,
        startDate: p.start_date || p.created_at ? istDate(ms(p.start_date ?? p.created_at)) : null,
        nextInstallmentDate: Running.has(sipStatusOf(p)) ? iso(p.next_debit ?? p.next_installment_date) : null,
        installmentsPaid: paid,
        /** Null for a SIP that runs until cancelled. */
        installmentsTotal: Number(p.number_of_installments) > 0 && Number(p.number_of_installments) < 1200 ? Number(p.number_of_installments) : null,
        status: sipStatusOf(p),
        createdAt: iso(p.created_at),
        _userId: p.user_id,
        _monthly: monthly(Number(p.amount ?? 0), frequency),
      };
    });
}
type Row = ReturnType<typeof rowsOf>[number];

function filtered(rows: Row[], q: URLSearchParams): Row[] {
  const search = q.get('search')?.trim().toLowerCase();
  const statuses = listParam(q, 'status', SipStatuses);
  const frequencies = listParam(q, 'frequency', SipFrequencies);
  const amc = q.get('amc')?.trim();
  // With no status asked for, the list shows running SIPs: that is what "Active SIPs" means.
  const wanted = statuses.length ? new Set(statuses) : Running;
  const out = rows.filter((r) => {
    if (!wanted.has(r.status)) return false;
    if (frequencies.length && !frequencies.includes(r.frequency as never)) return false;
    if (amc && r.amc !== amc) return false;
    if (search) {
      const hay = [r.reference, r.investor?.name, r.investor?.pan, r.folio, r.scheme, r.isin, r.amc].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
  const sort = (Sorts as readonly string[]).includes(q.get('sort') ?? '') ? q.get('sort') : 'next';
  const far = '9999-12-31';
  return out.sort((a, b) => {
    if (sort === 'amount') return Number(b.amount) - Number(a.amount);
    if (sort === 'start') return (b.startDate ?? '').localeCompare(a.startDate ?? '');
    if (sort === 'investor') return (a.investor?.name ?? '').localeCompare(b.investor?.name ?? '');
    return (a.nextInstallmentDate ?? far).localeCompare(b.nextInstallmentDate ?? far);
  });
}

const publicRow = ({ _userId, _monthly, ...row }: Row) => row;

const ExportColumns = [
  { key: 'reference', label: 'SIP ID' },
  { key: 'investor', label: 'Investor' },
  { key: 'pan', label: 'PAN (masked)' },
  { key: 'folio', label: 'Folio' },
  { key: 'scheme', label: 'Scheme' },
  { key: 'amc', label: 'AMC' },
  { key: 'amount', label: 'SIP amount (₹)' },
  { key: 'frequency', label: 'Frequency' },
  { key: 'startDate', label: 'Start date' },
  { key: 'nextInstallmentDate', label: 'Next instalment' },
  { key: 'instalments', label: 'Instalments (paid / total)' },
  { key: 'status', label: 'Status' },
];

const InstalmentStatus: Record<string, string> = {
  successful: 'SUCCESS', failed: 'FAILED', cancelled: 'CANCELLED', reversed: 'FAILED', skipped: 'SKIPPED',
};

/** One SIP in full: the plan, its investor, every instalment (newest first) and the AutoPay mandate it debits. */
async function findPlan(ctx: Ctx, id: string, fresh = false): Promise<{ snap: Snapshot; plan: UpOrder }> {
  const snap = await snapshot(ctx, { fresh });
  const plan = snap.orders.find((o) => o.kind === 'sip' && uuidFor('plan', o.id) === id);
  if (!plan) throw HttpError.notFound('That SIP could not be found.');
  return { snap, plan };
}

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], name: string): T => {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  throw HttpError.badRequest(`${name} must be one of ${allowed.join(', ')}.`);
};
const whole = (value: unknown, name: string, min: number, max: number): number => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw HttpError.badRequest(`${name} must be a whole number from ${min} to ${max}.`);
  return n;
};
const otpOf = (value: unknown): string => {
  const code = String(value ?? '').trim();
  if (!/^\d{4,8}$/.test(code)) throw HttpError.badRequest("Enter the code the investor received.");
  return code;
};

/** The app backend call for one action, with the app's own body. */
function actionCall(plan: UpOrder, action: SipAction, b: Record<string, unknown>, otp: string): { path: string; body: Record<string, unknown>; summary: string } {
  const sip = `/investors/${plan.user_id}/sips/${encodeURIComponent(plan.id)}`;
  switch (action) {
    case 'sip_pause': {
      const months = whole(b['months'], 'months', 1, 2);
      return { path: `${sip}/pause`, body: { months, otp }, summary: `Paused for ${months} month${months > 1 ? 's' : ''}` };
    }
    case 'sip_resume':
      return { path: `${sip}/resume`, body: { otp }, summary: 'Resumed' };
    case 'sip_modify': {
      const amount = whole(b['amount'], 'amount', 100, 10_000_000);
      const day = whole(b['day'], 'day', 1, 28);
      return { path: `${sip}/modify`, body: { amount, day, otp }, summary: `Changed to ₹${amount.toLocaleString('en-IN')} on day ${day}` };
    }
    case 'sip_cancel': {
      const code = oneOf(b['code'] ?? 'invest_later', CancelCodes, 'code');
      return { path: `${sip}/cancel`, body: { code, otp }, summary: `Cancelled (${code.replaceAll('_', ' ')})` };
    }
    case 'redeem': {
      if (!plan.folio) throw HttpError.badRequest('This SIP has no folio yet, so there is nothing to redeem.');
      const all = b['all'] === true;
      const amount = all ? undefined : whole(b['amount'], 'amount', 100, 100_000_000);
      return {
        path: `/investors/${plan.user_id}/redeem`,
        body: { isin: plan.isin, folio: plan.folio, all, ...(all ? {} : { amount }), otp },
        summary: all ? 'Redeemed all units' : `Redeemed ₹${amount!.toLocaleString('en-IN')}`,
      };
    }
  }
}

async function sipDetail(ctx: Ctx, id: string) {
  const { snap, plan } = await findPlan(ctx, id);
  const row = rowsOf({ ...snap, orders: [plan] })[0]!;
  const detail = await investorDetail(plan.user_id, actorOf(ctx)).catch(() => null);
  const mandate = detail?.investor.mandate ?? null;
  const bank = detail?.investor.bank ?? null;
  const list = instalments(plan)
    .map((i, n) => ({
      number: n + 1,
      date: iso(i['traded_on'] ?? i['scheduled_on'] ?? i['created_at'])?.slice(0, 10) ?? null,
      amount: money(i['amount'] ?? plan.amount),
      units: unitsOf(i['units'] ?? i['allotted_units']),
      status: InstalmentStatus[String(i['state'])] ?? 'PENDING',
      reason: typeof i['failure_reason'] === 'string' ? i['failure_reason'] : typeof i['failure_code'] === 'string' ? i['failure_code'] : null,
    }))
    .reverse();
  const pause = (plan['pause'] ?? null) as Record<string, unknown> | null;
  const running = Running.has(row.status);
  if (running && row.nextInstallmentDate) {
    list.unshift({ number: list.length + 1, date: row.nextInstallmentDate, amount: money(plan.amount), units: null, status: 'UPCOMING', reason: null });
  }
  return {
    ...publicRow(row),
    endDate: iso(plan['end_date'])?.slice(0, 10) ?? null,
    sipDay: plan.installment_day ?? null,
    pause: pause ? { from: iso(pause['from'])?.slice(0, 10) ?? null, to: iso(pause['to'])?.slice(0, 10) ?? null } : null,
    cancelledAt: plan.state === 'cancelled' ? iso(plan.updated_at) : null,
    instalments: list,
    mandate: mandate
      ? {
          id: mandate.umrn_masked ?? mandate.id,
          status: mandate.status,
          type: mandate.type,
          maxAmount: money(mandate.limit),
          validFrom: iso(mandate.valid_from)?.slice(0, 10) ?? null,
          validUntil: iso(mandate.valid_to)?.slice(0, 10) ?? null,
        }
      : null,
    bank: bank ? { bankName: bank.bank_name, accountMasked: bank.account_masked, ifsc: bank.ifsc } : null,
  };
}

export function sipRoutes(router: Router): void {
  const full = authenticate('full');
  const read = need('transactions.read');

  /** The SIP book: running SIPs, their monthly value, the average per investor with one, and how many bounced. */
  router.get('/sips/summary', full, read, async (ctx) => {
    const rows = rowsOf(await snapshot(ctx));
    const running = rows.filter((r) => Running.has(r.status));
    const book = running.reduce((s, r) => s + r._monthly, 0);
    const investors = new Set(running.map((r) => r._userId)).size;
    return {
      activeSips: running.length,
      monthlyBook: money0(book),
      averagePerInvestor: money0(investors ? book / investors : 0),
      investors,
      bounced: running.filter((r) => r.status === 'BOUNCED').length,
      paused: running.filter((r) => r.status === 'PAUSED').length,
      amcs: [...new Set(rows.map((r) => r.amc).filter((a): a is string => !!a))].sort(),
      generatedAt: new Date().toISOString(),
    };
  });

  router.get('/sips', full, read, async (ctx) => {
    const rows = filtered(rowsOf(await snapshot(ctx)), ctx.query);
    const { offset, limit } = pageParams(ctx.query, 10, 100);
    const result = page(rows, offset, limit);
    return { items: result.items.map(publicRow), total: rows.length, offset, nextCursor: result.nextCursor };
  });

  router.get('/sips/export', full, read, async (ctx: Ctx) => {
    const rows = filtered(rowsOf(await snapshot(ctx)), ctx.query).map((r) => ({
      ...publicRow(r),
      investor: r.investor?.name ?? '',
      pan: r.investor?.pan ?? '',
      instalments: `${r.installmentsPaid} / ${r.installmentsTotal ?? 'until cancelled'}`,
    }));
    await audit(ctx, 'sips.exported', null, { rows: rows.length, filters: Object.fromEntries(ctx.query) });
    return new Csv(`risips-sips-${istDate(Date.now())}.csv`, toCsv(ExportColumns, rows));
  });

  router.get('/sips/:id', full, read, async (ctx) => {
    const id = uuidParam(ctx, 'id');
    const out = await sipDetail(ctx, id);
    await audit(ctx, 'sip.viewed', null, { sip: out.reference });
    return out;
  });

  const manage = need('sips.manage');

  /** Step 1: the app backend sends the investor the OTP for this action (SMS / email). The code never comes here. */
  router.post('/sips/:id/otp', full, manage, async (ctx) => {
    const { plan } = await findPlan(ctx, uuidParam(ctx, 'id'));
    const action = oneOf(ctx.body?.action, SipActions, 'action');
    const sent = await upstreamPost<{ expires_in: number; resend_in: number; sent_to: { mobile: string | null; email: string | null } }>(
      `/investors/${plan.user_id}/otp`, actorOf(ctx), { action },
    );
    await audit(ctx, 'sip.otp_sent', null, { sip: plan.ref ?? plan.id, action });
    return { action, expiresIn: sent.expires_in, resendIn: sent.resend_in, sentTo: sent.sent_to };
  });

  /** Step 2: the action, with the code the investor read out. The app backend checks it and runs the app's own code. */
  router.post('/sips/:id/actions', full, manage, async (ctx) => {
    const id = uuidParam(ctx, 'id');
    const { plan } = await findPlan(ctx, id);
    const b = (ctx.body ?? {}) as Record<string, unknown>;
    const action = oneOf(b['action'], SipActions, 'action');
    const call = actionCall(plan, action, b, otpOf(b['otp']));
    const result = await upstreamPost<{ sip?: { id?: string }; order?: { id?: string; ref?: string } }>(call.path, actorOf(ctx), call.body);
    await audit(ctx, 'sip.action', null, { sip: plan.ref ?? plan.id, action, summary: call.summary });
    await snapshot(ctx, { fresh: true }).catch(() => null);
    // A modified SIP is a new plan: open that one next.
    const newPlan = action === 'sip_modify' && result.sip?.id ? uuidFor('plan', result.sip.id) : null;
    return { action, label: ActionLabels[action], summary: call.summary, sipId: newPlan ?? id, orderRef: result.order?.ref ?? result.order?.id ?? null };
  });
}
