// The app backend's read-only Admin API: the only source of investor, order and plan data.
// Every call carries the staff member it is for (`x-admin-actor`), which the app backend writes to its audit log.
import { config } from './config.ts';
import { HttpError } from './http.ts';

// --- the Admin API's shapes (snake_case, as it sends them) ------------------------------------

export type UpFund = {
  isin: string;
  name: string;
  short_name?: string;
  amc?: string;
  amc_short?: string;
  amc_id?: number;
  category?: string;
  sub_category?: string;
  nav?: number | null;
  nav_date?: string | null;
};

export type UpInvestor = {
  id: number;
  name: string | null;
  email: string | null;
  mobile: string | null;
  stage: string;
  kyc_compliant: boolean;
  pan_masked: string | null;
  signed_up_at: string;
  onboarded_at: string | null;
  orders: number;
  plans: number;
};

export type UpInvestorDetail = UpInvestor & {
  dob?: string | null;
  gender?: string | null;
  occupation?: string | null;
  income_slab?: string | null;
  marital_status?: string | null;
  father_name?: string | null;
  address?: { line1?: string; line2?: string; pincode?: string; city?: string; state?: string } | null;
  aadhaar_masked?: string | null;
  bank?: { account_masked: string; ifsc: string; bank_name: string | null; branch?: string | null; verified: boolean } | null;
  nominee?: Record<string, unknown> | null;
  nominee_opted_out?: boolean;
  checks?: Record<string, unknown>;
  deletion?: Record<string, unknown> | null;
};

/** An order or a plan (the Admin API lists both under /orders; `kind` tells them apart). */
export type UpOrder = {
  id: string;
  ref?: string | null;
  kind: string;
  isin: string;
  fund?: UpFund | null;
  fund_to?: UpFund | null;
  amount: number | null;
  units: number | null;
  units_in?: number | null;
  /** True when the investor redeemed or switched their whole holding; amount is null then. */
  all_units?: boolean;
  /** Open all-units orders only: units held × latest NAV. */
  estimated_amount?: number | null;
  /** What the fund house actually processed (a purchase is net of stamp duty). Null until allotted. */
  processed_amount?: number | null;
  processed_units?: number | null;
  nav: number | null;
  state: string;
  status?: string | null;
  failure_code?: string | null;
  folio?: string | null;
  payment?: { id: number; status: string; reference?: string | null } | null;
  created_at: string;
  updated_at: string;
  succeeded_at?: string | null;
  traded_on?: string | null;
  fp_id?: string | null;
  fp_old_id?: number | null;
  user_id: number;
  // plan fields (sip/stp/swp), when present
  frequency?: string | null;
  installment_day?: number | null;
  start_date?: string | null;
  next_installment_date?: string | null;
  next_debit?: string | null;
  previous_installment_date?: string | null;
  number_of_installments?: number | null;
  remaining_installments?: number | null;
  installments?: Record<string, unknown>[];
  reason?: string | null;
  mandate_id?: string | number | null;
  [key: string]: unknown;
};

export type UpDetailResponse = { investor: UpInvestorDetail; orders: UpOrder[]; sips: UpOrder[]; stps: UpOrder[]; swps: UpOrder[] };

export type UpHolding = {
  isin: string;
  folio: string;
  fund?: UpFund | null;
  units: number;
  nav: number | null;
  nav_date: string | null;
  current: number | null;
  invested: number | null;
  redeemable?: number | null;
  gain: number | null;
  gain_pct?: number | null;
};

export type UpPortfolio = {
  summary: { current: number; invested: number; gain: number; gain_pct: number | null; xirr?: number | null };
  holdings: UpHolding[];
};

type UpList<T> = { total: number; limit: number; offset: number; data: T[] };

// --- the client -----------------------------------------------------------------------------------

const TimeoutMs = 20_000;
const PortfolioTimeoutMs = 45_000;

export async function upstream<T>(path: string, actor: string, timeoutMs = TimeoutMs): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${config.upstreamUrl}${path}`, {
      headers: { accept: 'application/json', 'x-admin-key': config.upstreamKey, 'x-admin-actor': actor },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    console.error('[upstream] unreachable', path, (cause as Error).message);
    throw new HttpError(503, 'UPSTREAM_UNREACHABLE', "Can't reach the RiSips app backend right now. Try again in a moment.");
  }
  const payload = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (response.ok && payload) return payload;
  if (response.status === 404) throw HttpError.notFound();
  if (response.status === 401 || response.status === 403) {
    console.error('[upstream] refused', response.status, path, payload?.error);
    throw new HttpError(502, 'UPSTREAM_REFUSED', 'The app backend refused this admin server (its key or address is not allowed).');
  }
  console.error('[upstream] error', response.status, path, payload?.error);
  throw new HttpError(502, 'UPSTREAM_ERROR', 'The app backend could not answer. Try again in a moment.');
}

/** Every row of a list endpoint, 200 at a time. */
async function listAll<T>(path: string, actor: string): Promise<T[]> {
  const rows: T[] = [];
  const join = path.includes('?') ? '&' : '?';
  for (let offset = 0; ; offset += 200) {
    const page = await upstream<UpList<T>>(`${path}${join}limit=200&offset=${offset}`, actor);
    rows.push(...page.data);
    if (page.data.length < 200 || rows.length >= page.total) return rows;
  }
}

// --- short per-actor caches: one page render makes several calls that need the same lists ------------

type Entry<T> = { at: number; value: Promise<T> };
const cache = new Map<string, Entry<unknown>>();

function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key) as Entry<T> | undefined;
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value;
}

/**
 * The app keeps a SIP at `awaiting_payment` until its up-front instalment is allotted, a day or two after the investor
 * paid, although it already reports `first_payment_received`. Once the money is in, the SIP is running: show it active.
 */
export function settledPlan(o: UpOrder): UpOrder {
  return o.state === 'awaiting_payment' && o['first_payment_received'] === true ? { ...o, state: 'active' } : o;
}

export type Lists = { investors: UpInvestor[]; orders: UpOrder[]; fetchedAt: string };

/** All investors and all orders and plans, as one staff member (or system job) sees them now. */
export function lists(actor: string, { fresh = false } = {}): Promise<Lists> {
  return cached(`lists:${actor}`, fresh ? 0 : config.listCacheMs, async () => {
    const [investors, orders] = await Promise.all([listAll<UpInvestor>('/investors', actor), listAll<UpOrder>('/orders', actor)]);
    return { investors, orders: orders.map(settledPlan), fetchedAt: new Date().toISOString() };
  });
}

export const investorDetail = (id: string | number, actor: string) =>
  cached(`investor:${id}:${actor}`, config.listCacheMs, async () => {
    const resp = await upstream<UpDetailResponse>(`/investors/${encodeURIComponent(String(id))}`, actor);
    return { ...resp, sips: (resp.sips ?? []).map(settledPlan) };
  });

export const portfolio = (id: string | number, actor: string) =>
  cached(`portfolio:${id}:${actor}`, 5 * 60_000, () =>
    upstream<UpPortfolio>(`/investors/${encodeURIComponent(String(id))}/portfolio`, actor, PortfolioTimeoutMs),
  );

export const orderById = async (id: string, actor: string) => settledPlan(await upstream<UpOrder>(`/orders/${encodeURIComponent(id)}`, actor));

/** Runs `fn` over `items`, at most `limit` at a time. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}
