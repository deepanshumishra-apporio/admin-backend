// Shared lookups over the Admin API for the route modules.
import { actorOf } from './auth.ts';
import { HttpError, type Ctx } from './http.ts';
import { allFacts, type Facts } from './map.ts';
import { extIdOf } from './security.ts';
import { lists, type Lists } from './upstream.ts';
import { currentValues } from './valuation.ts';

export type Snapshot = Lists & { facts: Facts[]; byExtId: Map<string, Facts> };

const built = new WeakMap<Lists, Snapshot>();

/** Every investor with their orders and plans, as this staff member sees them (cached ~30 s). */
export async function snapshot(ctx: Ctx | string, options: { fresh?: boolean } = {}): Promise<Snapshot> {
  const data = await lists(typeof ctx === 'string' ? ctx : actorOf(ctx), options);
  const hit = built.get(data);
  if (hit) return hit;
  const facts = allFacts(data, currentValues());
  const snap = { ...data, facts, byExtId: new Map(facts.map((f) => [String(f.up.id), f])) };
  built.set(data, snap);
  return snap;
}

/** The app backend's investor id behind a dashboard UUID. */
export async function investorExtId(ctx: Ctx, uuid: string): Promise<string> {
  const known = await extIdOf('investor', uuid);
  if (known) return known;
  // Not seen yet (e.g. a fresh database): list investors once, which registers every id.
  await snapshot(ctx);
  const found = await extIdOf('investor', uuid);
  if (!found) throw HttpError.notFound('That investor could not be found.');
  return found;
}
