// Transaction monitoring: every one-time order across investors, with the flags that need a look.
import { actorOf, audit, authenticate, need } from '../auth.ts';
import { HttpError, listParam, page, pageParams, uuidParam, type Router } from '../http.ts';
import { snapshot, type Snapshot } from '../investors.ts';
import { FlagLabels, failureReason, inFlight, isOrder, istDate, ms, MonitorStates, OrderFlags, OrderTypes, toMonitored } from '../map.ts';
import { extIdOf, uuidFor } from '../security.ts';
import { orderById } from '../upstream.ts';

const DayMs = 86_400_000;
const TypeKind: Record<string, string> = { PURCHASE: 'purchase', REDEMPTION: 'redemption', SWITCH: 'switch' };

function monitored(snap: Snapshot) {
  return snap.orders
    .filter(isOrder)
    .map((o) => ({ up: o, view: toMonitored(o, snap.byExtId.get(String(o.user_id))) }))
    .sort((a, b) => b.view.placedAt.localeCompare(a.view.placedAt));
}

export function transactionRoutes(router: Router): void {
  const full = authenticate('full');
  const read = need('transactions.read');

  router.get('/transactions/summary', full, read, async (ctx) => {
    const rows = monitored(await snapshot(ctx));
    const today = istDate(Date.now());
    const on = (value: string | null | undefined, day: string) => !!value && istDate(ms(value)) === day;
    const placedToday = rows.filter((r) => on(r.up.created_at, today));
    const flags = new Map<string, number>();
    for (const r of rows) if (r.view.flag) flags.set(r.view.flag, (flags.get(r.view.flag) ?? 0) + 1);
    const paymentsToday = new Map<number, { status: string; amount: number }>();
    for (const r of rows) {
      const p = r.up.payment;
      if (!p || !on(r.up.updated_at, today)) continue;
      const entry = paymentsToday.get(p.id) ?? { status: p.status, amount: 0 };
      entry.amount += Number(r.up.amount ?? 0);
      paymentsToday.set(p.id, entry);
    }
    const payments = [...paymentsToday.values()];
    const failures = new Map<string, number>();
    for (const r of rows) {
      if (r.up.state !== 'failed') continue;
      const reason = failureReason(r.up) ?? 'No reason given';
      failures.set(reason, (failures.get(reason) ?? 0) + 1);
    }
    const daily = Array.from({ length: 14 }, (_, i) => istDate(Date.now() - (13 - i) * DayMs)).map((date) => ({
      date,
      placed: rows.filter((r) => on(r.up.created_at, date)).length,
      successful: rows.filter((r) => r.up.state === 'successful' && on(r.up.succeeded_at ?? r.up.updated_at, date)).length,
      failed: rows.filter((r) => r.up.state === 'failed' && on(r.up.updated_at, date)).length,
    }));
    return {
      generatedAt: new Date().toISOString(),
      today: {
        placed: placedToday.length,
        successful: daily.at(-1)!.successful,
        failed: daily.at(-1)!.failed,
        purchaseAmount: placedToday.filter((r) => r.up.kind === 'purchase').reduce((s, r) => s + Number(r.up.amount ?? 0), 0).toFixed(2),
        redemptionAmount: placedToday.filter((r) => r.up.kind === 'redemption').reduce((s, r) => s + Number(r.up.amount ?? 0), 0).toFixed(2),
      },
      inFlight: rows.filter((r) => inFlight(r.up)).length,
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
    const rows = monitored(await snapshot(ctx)).filter(({ up, view }) => {
      if (types.length && !types.some((t) => TypeKind[t] === up.kind)) return false;
      if (states.length && !states.includes(view.state)) return false;
      if (flags.length && (!view.flag || !flags.includes(view.flag))) return false;
      if (attention && !view.flag) return false;
      const day = istDate(ms(up.created_at));
      if (from && day < from) return false;
      if (to && day > to) return false;
      if (search) {
        const hay = [up.ref, up.id, up.isin, up.folio, view.scheme, view.investor.name, view.investor.pan].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });
    const { offset, limit } = pageParams(q);
    const result = page(rows, offset, limit);
    return { items: result.items.map((r) => r.view), nextCursor: result.nextCursor };
  });

  router.get('/transactions/:orderId', full, read, async (ctx) => {
    const id = uuidParam(ctx, 'orderId');
    const snap = await snapshot(ctx);
    const found = snap.orders.find((o) => isOrder(o) && uuidFor('order', o.id) === id);
    if (!found) throw HttpError.notFound('That order could not be found.');
    return toMonitored(found, snap.byExtId.get(String(found.user_id)));
  });

  // The app backend is the only one that talks to FP, so "refresh" re-reads the order from it.
  router.post('/transactions/:orderId/refresh', full, read, async (ctx) => {
    const id = uuidParam(ctx, 'orderId');
    let extId = await extIdOf('order', id);
    if (!extId) {
      const snap = await snapshot(ctx);
      extId = snap.orders.find((o) => uuidFor('order', o.id) === id)?.id ?? null;
    }
    if (!extId) throw HttpError.notFound('That order could not be found.');
    const fresh = await orderById(extId, actorOf(ctx));
    const snap = await snapshot(ctx, { fresh: true });
    await audit(ctx, 'transaction.refreshed', extId);
    return toMonitored(fresh, snap.byExtId.get(String(fresh.user_id)));
  });
}
