// Current values for the dashboard and investor list. Holdings are only available per investor and live from FP
// (slow), so a background job values every invested investor every 15 minutes and keeps just the totals in memory.
import { config } from './config.ts';
import { lists, mapLimit, portfolio } from './upstream.ts';

const SystemActor = 'system:valuation';
let values = new Map<number, number>();
let valuedAt: string | null = null;
let running: Promise<void> | null = null;

export const currentValues = (): Map<number, number> => values;
export const valuationAsOf = (): string | null => valuedAt;

async function refresh(): Promise<void> {
  const { investors, orders } = await lists(SystemActor, { fresh: true });
  const invested = new Set(orders.filter((o) => o.state === 'successful').map((o) => o.user_id));
  const targets = investors.filter((i) => invested.has(i.id));
  const next = new Map<number, number>();
  await mapLimit(targets, 3, async (investor) => {
    try {
      const p = await portfolio(investor.id, SystemActor);
      next.set(investor.id, Number(p.summary.current ?? 0));
    } catch (error) {
      const previous = values.get(investor.id);
      if (previous !== undefined) next.set(investor.id, previous);
      console.error('[valuation] skipped an investor:', (error as Error).message);
    }
  });
  values = next;
  valuedAt = new Date().toISOString();
}

export function refreshValuations(): Promise<void> {
  running ??= refresh().finally(() => (running = null));
  return running;
}

export function startValuationLoop(): void {
  const tick = () => refreshValuations().catch((error) => console.error('[valuation] failed:', (error as Error).message));
  setTimeout(tick, 5_000).unref();
  setInterval(tick, config.valuationIntervalMs).unref();
}
