// Transaction monitoring: every order across investors (one-time orders and SIP/SWP/STP instalments), with the flags
// that need a look.
import { actorOf, audit, authenticate, need } from '../auth.ts';
import { Csv, Download, HttpError, listParam, page, pageParams, toCsv, uuidParam, type Ctx, type Router } from '../http.ts';
import { pdf, xlsx } from '../export-files.ts';
import { snapshot, type Snapshot } from '../investors.ts';
import {
  FlagLabels,
  findInstallment,
  iso,
  isOrder,
  isPlan,
  istDate,
  ms,
  monitorInstallments,
  monitorOrder,
  MonitorStates,
  OrderFlags,
  OrderTypes,
  toMonitored,
  type MonitorRow,
} from '../map.ts';
import { extIdOf, uuidFor } from '../security.ts';
import { orderById, upstreamPost } from '../upstream.ts';

const DayMs = 86_400_000;
const Terminal = new Set(['SUCCESSFUL', 'FAILED', 'CANCELLED', 'REVERSED']);

export function monitored(snap: Snapshot): MonitorRow[] {
  const facts = (userId: number) => snap.byExtId.get(String(userId));
  return [
    ...snap.orders.filter(isOrder).map((o) => monitorOrder(o, facts(o.user_id))),
    ...snap.orders.filter(isPlan).flatMap((p) => monitorInstallments(p, facts(p.user_id))),
  ].sort((a, b) => b.placedMs - a.placedMs);
}

/** The list's filters (type, state, flag, attention, from / to as India dates, search), shared by the list and export. */
function filtered(rows: MonitorRow[], q: URLSearchParams): MonitorRow[] {
  const types = listParam(q, 'type', OrderTypes);
  const states = listParam(q, 'state', MonitorStates);
  const flags = listParam(q, 'flag', OrderFlags);
  const attention = q.get('attention') === 'true';
  const from = q.get('from');
  const to = q.get('to');
  const search = q.get('search')?.trim().toLowerCase();
  return rows.filter(({ view, placedMs, search: hay }) => {
    if (types.length && !types.includes(view.type)) return false;
    if (states.length && !states.includes(view.state)) return false;
    if (flags.length && (!view.flag || !flags.includes(view.flag))) return false;
    if (attention && !view.flag) return false;
    const day = istDate(placedMs);
    if (from && day < from) return false;
    if (to && day > to) return false;
    if (search && !hay.includes(search)) return false;
    return true;
  }).sort(sorter(q.get('sort')));
}

/** `sort`: latest (the default), oldest, amount_desc, amount_asc. */
const sorter = (sort: string | null) => (a: MonitorRow, b: MonitorRow): number =>
  sort === 'oldest' ? a.placedMs - b.placedMs
    : sort === 'amount_desc' ? b.amount - a.amount || b.placedMs - a.placedMs
      : sort === 'amount_asc' ? a.amount - b.amount || b.placedMs - a.placedMs
        : b.placedMs - a.placedMs;

const InFlightStates = new Set(['UNDER_REVIEW', 'PENDING', 'CONFIRMED', 'SUBMITTED']);

/**
 * The list's cards, for every filter but the status one (so picking "Failed" doesn't empty the other cards):
 * how many, the value of the successful ones, how many are still in progress, how many failed or were reversed.
 */
function totalsOf(rows: MonitorRow[]) {
  return {
    count: rows.length,
    value: rows.filter((r) => r.view.state === 'SUCCESSFUL').reduce((s, r) => s + r.amount, 0).toFixed(2),
    pending: rows.filter((r) => InFlightStates.has(r.view.state)).length,
    failed: rows.filter((r) => r.view.state === 'FAILED' || r.view.state === 'REVERSED').length,
  };
}

const ExportFormats = ['csv', 'xlsx', 'pdf'] as const;
export const ExportRanges = ['current', 'today', 'last7', 'last30', 'thisMonth', 'fy', 'all'] as const;
type ExportRange = (typeof ExportRanges)[number];
const RangeLabels: Record<ExportRange, string> = {
  current: 'current filter', today: 'today', last7: 'last 7 days', last30: 'last 30 days', thisMonth: 'this month', fy: 'this financial year', all: 'all time',
};
/** A file is built in memory: past this, narrow the filters. */
const MaxExportRows = 50_000;
const oneOfOr = <T extends string>(v: string | null, allowed: readonly T[], fallback: T): T => ((allowed as readonly string[]).includes(v ?? '') ? (v as T) : fallback);

/** India-local dates for a range; null keeps the list's own dates. */
export function rangeDates(range: ExportRange, now = Date.now()): { from: string | null; to: string | null } | null {
  const today = istDate(now);
  const daysAgo = (n: number) => istDate(now - n * DayMs);
  switch (range) {
    case 'current': return null;
    case 'today': return { from: today, to: today };
    case 'last7': return { from: daysAgo(6), to: today };
    case 'last30': return { from: daysAgo(29), to: today };
    case 'thisMonth': return { from: `${today.slice(0, 7)}-01`, to: today };
    case 'fy': {
      const [y, m] = today.split('-').map(Number) as [number, number];
      return { from: `${m >= 4 ? y : y - 1}-04-01`, to: today };
    }
    case 'all': return { from: null, to: null };
  }
}

const TypeLabels: Record<string, string> = {
  PURCHASE: 'Purchase', SIP_INSTALLMENT: 'SIP instalment', REDEMPTION: 'Redemption', SWP_INSTALLMENT: 'SWP instalment',
  SWITCH: 'Switch', STP_INSTALLMENT: 'STP instalment',
};
const ist = (isoText: string | null) =>
  isoText ? new Date(isoText).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : null;
const num = (v: string | null) => (v === null || v === '' ? null : Number(v));
const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replaceAll('_', ' ');

/** Export columns. `summary` ones are the list's own; widths are relative, for the PDF. */
const ExportColumns: { label: string; summary: boolean; numeric?: boolean; width: number; value: (r: MonitorRow) => string | number | null }[] = [
  { label: 'Transaction ID', summary: true, width: 11, value: (r) => r.reference },
  { label: 'Date and time', summary: true, width: 11, value: (r) => ist(r.view.placedAt) },
  { label: 'Investor', summary: true, width: 11, value: (r) => r.view.investor.name },
  { label: 'PAN (masked)', summary: false, width: 8, value: (r) => r.view.investor.pan },
  { label: 'Scheme', summary: true, width: 22, value: (r) => r.view.scheme },
  { label: 'To scheme', summary: false, width: 16, value: (r) => r.view.toScheme },
  { label: 'Folio', summary: false, width: 9, value: (r) => r.view.folio },
  { label: 'Type', summary: true, width: 9, value: (r) => TypeLabels[r.view.type] ?? r.view.type },
  { label: 'Amount (₹)', summary: true, numeric: true, width: 8, value: (r) => num(r.view.amount) ?? num(r.view.estimatedAmount) },
  { label: 'Units', summary: false, numeric: true, width: 7, value: (r) => num(r.view.processedUnits) ?? num(r.view.units) },
  { label: 'Payment mode', summary: true, width: 7, value: (r) => r.paymentMode },
  { label: 'Payment status', summary: false, width: 7, value: (r) => (r.view.payment ? titleCase(r.view.payment.status) : null) },
  { label: 'Status', summary: true, width: 8, value: (r) => titleCase(r.view.state) },
  { label: 'Problem', summary: false, width: 10, value: (r) => (r.view.flag ? FlagLabels[r.view.flag] : null) },
  { label: 'Failure reason', summary: false, width: 14, value: (r) => r.view.failureReason },
  { label: 'Completed', summary: false, width: 11, value: (r) => ist(r.view.completedAt) },
];

/** A transactions row and the app backend's own record behind it (the order, or the instalment on its plan). */
async function findRow(ctx: Ctx, id: string): Promise<{ row: MonitorRow; raw: Record<string, unknown> }> {
  const snap = await snapshot(ctx);
  const row = monitored(snap).find((r) => r.view.id === id);
  if (!row) throw HttpError.notFound('That transaction could not be found.');
  const order = snap.orders.find((o) => o.id === row.refreshId);
  if (order && isOrder(order)) return { row, raw: order as unknown as Record<string, unknown> };
  const found = findInstallment(snap.orders.filter(isPlan), id);
  return { row, raw: { ...(found?.plan ?? {}), ...(found?.installment ?? {}), plan_id: found?.plan.id } };
}

const at = (v: unknown) => (typeof v === 'string' && v ? iso(v) : null);

/**
 * The page's facts and its status timeline. Each step is what the app backend recorded: placed, paid, sent to the
 * fund house (RTA), then allotted / failed / reversed. Steps not reached yet are left out; a step known to have
 * happened without a time keeps a null `at`.
 */
function detailOf(row: MonitorRow, raw: Record<string, unknown>) {
  const v = row.view;
  const byAdmin = raw['by_admin'] as { actor?: string } | undefined;
  const placedBy = byAdmin?.actor ? `RiSips support (${byAdmin.actor})` : row.paymentMode === 'AutoPay' ? 'AutoPay schedule' : 'Investor, in the app';
  const steps: { key: string; label: string; at: string | null; by: string | null; tone: 'done' | 'failed' | 'pending' }[] = [
    { key: 'placed', label: 'Order placed', at: v.placedAt, by: placedBy, tone: 'done' },
  ];
  const pay = v.payment?.status ?? null;
  if (pay === 'SUCCESS') steps.push({ key: 'paid', label: row.paymentMode === 'AutoPay' ? 'Debited via AutoPay' : 'Payment received', at: v.payment?.at ?? null, by: row.paymentMode ?? null, tone: 'done' });
  if (pay === 'FAILED') steps.push({ key: 'paid', label: 'Payment failed', at: v.payment?.at ?? null, by: row.paymentMode ?? null, tone: 'failed' });
  const submitted = at(raw['submitted_at']);
  const final = ['SUCCESSFUL', 'FAILED', 'REVERSED', 'CANCELLED'].includes(v.state);
  if (submitted || v.state === 'SUBMITTED' || (v.state === 'SUCCESSFUL' && v.kind !== 'purchase') || at(raw['traded_on'])) {
    steps.push({ key: 'rta', label: 'Sent to RTA', at: submitted ?? at(raw['traded_on']), by: 'Fund platform (FP)', tone: 'done' });
  }
  if (v.state === 'SUCCESSFUL') steps.push({ key: 'done', label: v.kind === 'redemption' ? 'Units redeemed' : v.kind === 'switch' ? 'Switch completed' : 'Units allotted', at: v.completedAt, by: 'Fund house', tone: 'done' });
  else if (v.state === 'FAILED') steps.push({ key: 'done', label: v.kind === 'purchase' ? 'Allotment failed' : 'Failed', at: at(raw['failed_at']) ?? v.updatedAt, by: v.failureReason ?? 'Fund house', tone: 'failed' });
  else if (v.state === 'REVERSED') steps.push({ key: 'done', label: 'Reversed', at: v.updatedAt, by: 'Fund house', tone: 'failed' });
  else if (v.state === 'CANCELLED') steps.push({ key: 'done', label: 'Cancelled', at: v.updatedAt, by: null, tone: 'failed' });
  if (!final) steps.push({ key: 'next', label: v.state === 'SUBMITTED' ? 'Waiting for allotment' : 'In progress', at: null, by: null, tone: 'pending' });
  // The payment's time is the order's last update (the app backend keeps no separate one), so it can land after a
  // later step. A time that does is not shown rather than shown out of order.
  for (let i = 0; i < steps.length - 1; i++) {
    const here = steps[i]!.at;
    const next = steps.slice(i + 1).find((s) => s.at)?.at;
    if (here && next && here > next) steps[i]!.at = null;
  }

  const retry: { kind: 'refresh' | 'redeem' | 'none'; reason: string | null } = !final
    ? { kind: 'refresh', reason: null }
    : v.state === 'FAILED' && v.type === 'REDEMPTION' && v.folio
      ? { kind: 'redeem', reason: null }
      : v.state === 'FAILED' && (v.type === 'PURCHASE' || v.type === 'SIP_INSTALLMENT')
        ? { kind: 'none', reason: 'A purchase is paid by the investor, so only the investor can place it again (from the app).' }
        : { kind: 'none', reason: v.state === 'SUCCESSFUL' ? 'This transaction went through.' : 'This transaction can not be retried from here.' };

  const nav = raw['nav'] ?? raw['purchased_price'] ?? raw['redeemed_price'];
  return {
    order: v,
    reference: row.reference,
    paymentMode: row.paymentMode,
    paymentReference: (raw['payment'] as { reference?: string } | undefined)?.reference ?? null,
    nav: nav === null || nav === undefined || nav === '' ? null : Number(nav).toFixed(4),
    isin: typeof raw['isin'] === 'string' ? raw['isin'] : null,
    userId: Number(raw['user_id']) || null,
    timeline: steps,
    retry,
  };
}

export function transactionRoutes(router: Router): void {
  const full = authenticate('full');
  const read = need('transactions.read');

  router.get('/transactions/summary', full, read, async (ctx) => {
    const rows = monitored(await snapshot(ctx));
    const today = istDate(Date.now());
    const on = (at: number, day: string) => at > 0 && istDate(at) === day;
    const placedToday = rows.filter((r) => on(r.placedMs, today));
    const flags = new Map<string, number>();
    for (const r of rows) if (r.view.flag) flags.set(r.view.flag, (flags.get(r.view.flag) ?? 0) + 1);
    const paymentsToday = new Map<number, { status: string; amount: number }>();
    for (const r of rows) {
      const p = r.payment;
      if (!p || !on(r.updatedMs, today)) continue;
      const entry = paymentsToday.get(p.id) ?? { status: p.status, amount: 0 };
      entry.amount += r.amount;
      paymentsToday.set(p.id, entry);
    }
    const payments = [...paymentsToday.values()];
    const failures = new Map<string, number>();
    for (const r of rows) {
      if (r.view.state !== 'FAILED') continue;
      const reason = r.view.failureReason ?? 'No reason given';
      failures.set(reason, (failures.get(reason) ?? 0) + 1);
    }
    const daily = Array.from({ length: 14 }, (_, i) => istDate(Date.now() - (13 - i) * DayMs)).map((date) => ({
      date,
      placed: rows.filter((r) => on(r.placedMs, date)).length,
      successful: rows.filter((r) => r.view.state === 'SUCCESSFUL' && on(ms(r.view.completedAt) || r.updatedMs, date)).length,
      failed: rows.filter((r) => r.view.state === 'FAILED' && on(r.updatedMs, date)).length,
    }));
    return {
      generatedAt: new Date().toISOString(),
      today: {
        placed: placedToday.length,
        successful: daily.at(-1)!.successful,
        failed: daily.at(-1)!.failed,
        purchaseAmount: placedToday.filter((r) => r.view.kind === 'purchase').reduce((s, r) => s + r.amount, 0).toFixed(2),
        redemptionAmount: placedToday.filter((r) => r.view.kind === 'redemption').reduce((s, r) => s + r.amount, 0).toFixed(2),
      },
      inFlight: rows.filter((r) => !Terminal.has(r.view.state)).length,
      attention: OrderFlags.map((key) => ({ key, label: FlagLabels[key], count: flags.get(key) ?? 0 })),
      paymentsToday: {
        successful: payments.filter((p) => p.status === 'SUCCESS').length,
        failed: payments.filter((p) => p.status === 'FAILED').length,
        pending: payments.filter((p) => p.status !== 'SUCCESS' && p.status !== 'FAILED').length,
        amountCollected: payments.filter((p) => p.status === 'SUCCESS').reduce((s, p) => s + p.amount, 0).toFixed(2),
      },
      topFailures: [...failures].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 5),
      daily,
    };
  });

  router.get('/transactions', full, read, async (ctx) => {
    const all = monitored(await snapshot(ctx));
    const rows = filtered(all, ctx.query);
    const { offset, limit } = pageParams(ctx.query);
    const result = page(rows, offset, limit);
    const anyState = new URLSearchParams(ctx.query);
    anyState.delete('state');
    return {
      items: result.items.map((r) => ({ ...r.view, reference: r.reference, paymentMode: r.paymentMode })),
      total: rows.length,
      offset,
      totals: totalsOf(filtered(all, anyState)),
      nextCursor: result.nextCursor,
    };
  });

  /**
   * Export: the transactions the list's filters match, as CSV, Excel or PDF. `range` replaces the list's own dates
   * (`current` keeps them); `columns=summary` gives the list's columns, `all` every field. Audited.
   */
  router.get('/transactions/export', full, read, async (ctx) => {
    const q = new URLSearchParams(ctx.query);
    const format = oneOfOr(q.get('format'), ExportFormats, 'csv');
    const range = oneOfOr(q.get('range'), ExportRanges, 'current');
    const set = oneOfOr(q.get('columns'), ['all', 'summary'] as const, 'all');
    const dates = rangeDates(range);
    if (dates) {
      q.delete('from');
      q.delete('to');
      if (dates.from) q.set('from', dates.from);
      if (dates.to) q.set('to', dates.to);
    }
    const rows = filtered(monitored(await snapshot(ctx)), q);
    if (rows.length > MaxExportRows) {
      throw HttpError.badRequest(`${rows.length.toLocaleString('en-IN')} transactions match: narrow the filters or the date range to ${MaxExportRows.toLocaleString('en-IN')} or fewer.`);
    }
    const columns = set === 'all' ? ExportColumns : ExportColumns.filter((c) => c.summary);
    const cells = rows.map((r) => columns.map((c) => c.value(r)));
    const name = `risips-transactions-${istDate(Date.now())}`;
    await audit(ctx, 'transactions.exported', null, { format, range, columns: set, rows: rows.length, filters: Object.fromEntries(q) });
    if (format === 'csv') {
      return new Csv(`${name}.csv`, toCsv(columns.map((c) => ({ key: c.label, label: c.label })), cells.map((row) => Object.fromEntries(row.map((v, i) => [columns[i]!.label, v])))));
    }
    const title = 'RiSips transactions';
    const notes = [
      title,
      `${rows.length.toLocaleString('en-IN')} transactions - ${RangeLabels[range]}${q.get('from') ? ` - from ${q.get('from')}` : ''}${q.get('to') ? ` to ${q.get('to')}` : ''}`,
      `Exported ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST. Amounts in rupees.`,
    ];
    const cols = columns.map((c) => ({ label: c.label, kind: c.numeric ? ('count' as const) : ('text' as const), width: c.width }));
    return format === 'pdf'
      ? new Download(`${name}.pdf`, 'application/pdf', pdf(title, notes.slice(1), cols, cells))
      : new Download(`${name}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xlsx('Transactions', notes, cols, cells));
  });

  /** One transaction in full, for its page: the row, the raw facts (NAV, references), and a status timeline. */
  router.get('/transactions/:orderId/detail', full, read, async (ctx) => {
    const { row, raw } = await findRow(ctx, uuidParam(ctx, 'orderId'));
    return detailOf(row, raw);
  });

  /** A one-page PDF receipt to send to the investor. Audited. */
  router.get('/transactions/:orderId/receipt', full, read, async (ctx) => {
    const { row, raw } = await findRow(ctx, uuidParam(ctx, 'orderId'));
    const d = detailOf(row, raw);
    const inr = (v: string | null) => (v === null ? null : `Rs ${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    const lines: [string, string | null][] = [
      ['Transaction ID', d.reference],
      ['Type', TypeLabels[d.order.type] ?? d.order.type],
      ['Status', titleCase(d.order.state)],
      ['Investor', d.order.investor.name],
      ['PAN', d.order.investor.pan],
      ['Scheme', d.order.scheme],
      ...(d.order.toScheme ? ([['Switched to', d.order.toScheme]] as [string, string][]) : []),
      ['Folio', d.order.folio],
      ['Amount', inr(d.order.processedAmount ?? d.order.amount ?? d.order.estimatedAmount)],
      ['Units', d.order.processedUnits ?? d.order.units],
      ['NAV', d.nav],
      ['Payment mode', d.paymentMode],
      ['Payment reference', d.paymentReference],
      ['Placed on', ist(d.order.placedAt)],
      ['Completed on', ist(d.order.completedAt)],
      ...(d.order.failureReason ? ([['Reason', d.order.failureReason]] as [string, string][]) : []),
    ];
    await audit(ctx, 'transaction.receipt', d.reference, {});
    const notes = [
      `Generated ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST by RiSips (Arthasuta Finedu Private Limited, AMFI registered mutual fund distributor).`,
      'Units and NAV are as confirmed by the fund house. Mutual fund investments are subject to market risks; read all scheme related documents carefully.',
    ];
    return new Download(`risips-receipt-${d.reference.replace(/[^\w-]/g, '')}.pdf`, 'application/pdf',
      pdf(`Transaction receipt ${d.reference}`, notes, [{ label: 'Detail', kind: 'text', width: 1 }, { label: 'Value', kind: 'text', width: 3 }], lines.map(([k, v]) => [k, v ?? '-'])));
  });

  // Retry a failed redemption for the investor, with their OTP (the app backend's ADMIN_API_ACTIONS), as on a SIP page.
  const act = need('sips.manage');
  const redemptionToRetry = async (ctx: Ctx) => {
    const { row, raw } = await findRow(ctx, uuidParam(ctx, 'orderId'));
    const d = detailOf(row, raw);
    if (d.retry.kind !== 'redeem' || !d.userId || !d.isin) throw HttpError.badRequest(d.retry.reason ?? 'Only a failed redemption can be placed again from here.');
    return d;
  };
  router.post('/transactions/:orderId/otp', full, act, async (ctx) => {
    const d = await redemptionToRetry(ctx);
    const sent = await upstreamPost<{ expires_in: number; resend_in: number; sent_to: { mobile: string | null; email: string | null } }>(
      `/investors/${d.userId}/otp`, actorOf(ctx), { action: 'redeem' },
    );
    await audit(ctx, 'transaction.retry_otp_sent', d.reference, {});
    return { expiresIn: sent.expires_in, resendIn: sent.resend_in, sentTo: sent.sent_to };
  });
  router.post('/transactions/:orderId/retry', full, act, async (ctx) => {
    const d = await redemptionToRetry(ctx);
    const otp = String(ctx.body?.otp ?? '').trim();
    if (!/^\d{4,8}$/.test(otp)) throw HttpError.badRequest('Enter the code the investor received.');
    const all = d.order.allUnits;
    const amount = all ? undefined : Math.floor(Number(d.order.amount));
    if (!all && !(amount! >= 100)) throw HttpError.badRequest('This redemption has no amount to place again.');
    const result = await upstreamPost<{ order?: { id?: string; ref?: string } }>(`/investors/${d.userId}/redeem`, actorOf(ctx), {
      isin: d.isin, folio: d.order.folio, all, ...(all ? {} : { amount }), otp,
    });
    await audit(ctx, 'transaction.retried', d.reference, { newOrder: result.order?.ref ?? result.order?.id ?? null });
    await snapshot(ctx, { fresh: true }).catch(() => null);
    const newId = result.order?.id ? uuidFor('order', result.order.id) : null;
    return { orderRef: result.order?.ref ?? result.order?.id ?? null, orderId: newId };
  });

  router.get('/transactions/:orderId', full, read, async (ctx) => {
    const id = uuidParam(ctx, 'orderId');
    const found = monitored(await snapshot(ctx)).find((r) => r.view.id === id);
    if (!found) throw HttpError.notFound('That order could not be found.');
    return found.view;
  });

  // The app backend is the only one that talks to FP, so "refresh" re-reads the order from it. An instalment has no
  // order of its own at the app backend: its plan is re-read instead, and the instalment picked out of it.
  router.post('/transactions/:orderId/refresh', full, read, async (ctx) => {
    const id = uuidParam(ctx, 'orderId');
    const known = monitored(await snapshot(ctx)).find((r) => r.view.id === id);
    const extId = known?.refreshId ?? (await extIdOf('order', id));
    if (!extId) throw HttpError.notFound('That order could not be found.');
    const fresh = await orderById(extId, actorOf(ctx));
    const snap = await snapshot(ctx, { fresh: true });
    await audit(ctx, 'transaction.refreshed', extId);
    const facts = snap.byExtId.get(String(fresh.user_id));
    if (!isPlan(fresh)) return toMonitored(fresh, facts);
    const row = monitorInstallments(fresh, facts).find((r) => r.view.id === id);
    if (!row) throw HttpError.notFound('That instalment could not be found.');
    return row.view;
  });
}
