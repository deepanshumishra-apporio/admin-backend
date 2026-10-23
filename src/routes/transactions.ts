// Transaction monitoring: every order across investors (one-time orders and SIP/SWP/STP instalments), with the flags
// that need a look.
import { actorOf, audit, authenticate, need } from '../auth.ts';
import { HttpError, listParam, page, pageParams, uuidParam, type Router } from '../http.ts';
import { snapshot, type Snapshot } from '../investors.ts';
import {
  FlagLabels,
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
import { extIdOf } from '../security.ts';
import { orderById } from '../upstream.ts';

const DayMs = 86_400_000;
const Terminal = new Set(['SUCCESSFUL', 'FAILED', 'CANCELLED', 'REVERSED']);

function monitored(snap: Snapshot): MonitorRow[] {
  const facts = (userId: number) => snap.byExtId.get(String(userId));
  return [
    ...snap.orders.filter(isOrder).map((o) => monitorOrder(o, facts(o.user_id))),
    ...snap.orders.filter(isPlan).flatMap((p) => monitorInstallments(p, facts(p.user_id))),
  ].sort((a, b) => b.placedMs - a.placedMs);
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
    const q = ctx.query;
    const types = listParam(q, 'type', OrderTypes);
    const states = listParam(q, 'state', MonitorStates);
    const flags = listParam(q, 'flag', OrderFlags);
    const attention = q.get('attention') === 'true';
    const from = q.get('from');
    const to = q.get('to');
    const search = q.get('search')?.trim().toLowerCase();
    const rows = monitored(await snapshot(ctx)).filter(({ view, placedMs, search: hay }) => {
      if (types.length && !types.includes(view.type)) return false;
      if (states.length && !states.includes(view.state)) return false;
      if (flags.length && (!view.flag || !flags.includes(view.flag))) return false;
      if (attention && !view.flag) return false;
      const day = istDate(placedMs);
      if (from && day < from) return false;
      if (to && day > to) return false;
      if (search && !hay.includes(search)) return false;
      return true;
    });
    const { offset, limit } = pageParams(q);
    const result = page(rows, offset, limit);
    return { items: result.items.map((r) => r.view), nextCursor: result.nextCursor };
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
