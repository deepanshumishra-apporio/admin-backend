// A HUF's investments, read from NSE, and new ones placed from the admin: a lumpsum purchase (the karta confirms
// and pays on NSE's page), an eNACH mandate (the karta approves it with their bank), and a monthly SIP on an
// approved mandate (the karta approves it on NSE). Staff only start these; NSE needs the karta for each.
import { randomBytes } from 'node:crypto';

import { amfiDirectory, amfiDirectoryOrEmpty, isoDate, navHistory, returnsOf, thin, type AmfiFund } from '../amfi.ts';
import { audit, authenticate, need, refOf, staffNames } from '../auth.ts';
import { config, nseIsLive } from '../config.ts';
import { all, nowIso, one, run, tx } from '../db.ts';
import { HttpError, uuidParam, type Ctx, type Router } from '../http.ts';
import { NseError, nseConfigured } from '../nse/client.ts';
import { hufInvestmentNotices } from '../notifications.ts';
import { entityWord, type HufDetails, type NseStatus } from '../nse/huf.ts';
import {
  cancelXsip, payByNeft, placePurchase, placeRedemption, productLink, purchaseProblem, readInvestments, readMandates, redeemProblem,
  registerMandate, registerXsip, schemesFromNse, searchSchemes, SipCancelReasons, sipProblem, type Investments, type ProductType, type Scheme,
} from '../nse/invest.ts';
import { unseal } from '../security.ts';
import { documentsOf, event, type Row } from './hufs.ts';

type InvestRow = Row & { investments: string | null; investments_read_at: string | null; requests: string | null };

/** Something started from here, with NSE's link for the karta. */
type Request = {
  id: string;
  kind: 'PURCHASE' | 'MANDATE' | 'SIP' | 'REDEMPTION' | 'SIP_CANCEL';
  nseId: string | null;
  ok: boolean;
  status: string;
  remark: string | null;
  schemeCode: string | null;
  schemeName: string | null;
  amount: number;
  detail: Record<string, unknown>;
  link: string | null;
  linkError: string | null;
  at: string;
  by: string;
  /** A purchase paid by NEFT/RTGS: the UTR sent to NSE and its answer. */
  neft?: { utr: string; ok: boolean; status: string; remark: string | null; at: string; by: string } | null;
  /** The form's one-time key (see sendOnce): the same form can't be sent twice. */
  key?: string | null;
};

const requestsOf = (r: InvestRow): Request[] => (r.requests ? (JSON.parse(r.requests) as Request[]) : []);
const DayMs = 86_400_000;

async function load(id: string): Promise<InvestRow> {
  const r = await one<InvestRow>('SELECT * FROM hufs WHERE id = ?', id);
  if (!r) throw HttpError.notFound('That HUF could not be found.');
  return r;
}

const nseFailure = (error: unknown): never => {
  if (error instanceof NseError) throw new HttpError(502, 'NSE_UNAVAILABLE', `NSE: ${error.message}`);
  throw error;
};

/**
 * Why this HUF can't invest yet, or null. NSE refuses a non-demat order without an AOF (a HUF has no eLog), and
 * money can only come from the HUF's own account, which NSE must have verified.
 */
function investBlock(r: InvestRow): string | null {
  const word = entityWord(unseal<HufDetails>(r.details));
  const who = word === 'company' ? 'signatory' : 'karta';
  if (!nseConfigured() || (nseIsLive() && !config.nse.allowProd)) return 'NSE is not configured on this server.';
  if (r.status !== 'ACTIVE' && r.status !== 'AWAITING_KARTA') return `The ${word} has to be registered on NSE first.`;
  const nse = r.nse_status ? (JSON.parse(r.nse_status) as NseStatus) : null;
  if (nse?.bankStatus?.toUpperCase() !== 'ACTIVE') return `NSE hasn't verified the ${word}'s bank account yet. Refresh its status, or upload a cancelled cheque.`;
  const aofAccepted = nse.aof && [nse.aof.cams.status, nse.aof.kfin.status].includes('ACCEPTED');
  if (nse.kyc?.failed) return `NSE's KYC check on the ${word}'s PAN says "${nse.kyc.status}"${nse.kyc.remark ? ` (${nse.kyc.remark})` : ''}. NSE takes orders only once KYC is verified.`;
  if (!documentsOf(r).AOF?.ok && !aofAccepted) return `Upload the AOF signed by the ${who} first: NSE refuses a ${word}'s order without it ("AOF IMAGE IS NOT PRESENT OR NOT VALID OR NOT VERIFIED").`;
  return null;
}

/** The HUF's history on NSE starts when it was registered; reading earlier would only cost calls. */
const readFrom = (r: InvestRow) => new Date(Math.max(Date.parse(`${config.hufSyncFrom}T00:00:00Z`), Date.parse(r.created_at) - DayMs));

/** Reads the HUF's orders, allotments, SIPs and mandates from NSE and keeps them, so the page needs no NSE call. */
export async function refreshInvestments(r: InvestRow): Promise<Investments> {
  const d = unseal<HufDetails>(r.details);
  const inv = await readInvestments(d.clientCode, readFrom(r));
  await run('UPDATE hufs SET investments = ?, investments_read_at = ? WHERE id = ?', JSON.stringify(inv), inv.readAt, r.id);
  await hufInvestmentNotices(r, r.investments ? (JSON.parse(r.investments) as Investments) : null, inv);
  return inv;
}

async function view(r: InvestRow) {
  const names = await staffNames();
  const inv = r.investments ? (JSON.parse(r.investments) as Investments) : null;
  return {
    investments: inv,
    readAt: r.investments_read_at,
    requests: requestsOf(r).map((q) => ({ ...q, by: refOf(names, q.by)?.name ?? null })).reverse(),
    block: investBlock(r),
    live: nseIsLive(),
    sipCancelReasons: SipCancelReasons,
    approvedMandates: (inv?.mandates ?? []).filter((m) => m.status === 'APPROVED').map((m) => ({ mandateId: m.mandateId, amount: m.amount, endDate: m.endDate, bankName: m.bankName })),
    folios: [...new Map((inv?.holdings ?? []).filter((h) => h.folio).map((h) => [`${h.schemeCode}|${h.folio}`, { schemeCode: h.schemeCode, folio: h.folio! }])).values()],
  };
}

/**
 * Changes the HUF's request list under a row lock, so two actions at once can't overwrite each other's entries (each
 * reads the list fresh inside the lock, not the copy it loaded before a slow NSE call). `change` returns false to
 * leave the list as it was.
 */
async function changeRequests(hufId: string, change: (list: Request[]) => boolean | void): Promise<void> {
  await tx(async (q) => {
    const row = await q.one<{ requests: string | null }>('SELECT requests FROM hufs WHERE id = ? FOR UPDATE', hufId);
    const list: Request[] = row?.requests ? (JSON.parse(row.requests) as Request[]) : [];
    if (change(list) === false) return;
    await q.run('UPDATE hufs SET requests = ?, updated_at = ? WHERE id = ?', JSON.stringify(list.slice(-200)), nowIso(), hufId);
  });
}

const updateRequest = (hufId: string, id: string, patch: Partial<Request>): Promise<void> =>
  changeRequests(hufId, (list) => {
    const q = list.find((x) => x.id === id);
    if (!q) return false;
    Object.assign(q, patch);
  });

/** How long a request NSE never answered blocks an identical one: time to Refresh and see whether NSE has it. */
const NoAnswerHoldMs = 15 * 60_000;
export const NoAnswerRemark =
  'NSE did not answer, so this may or may not have reached NSE. Press Refresh in a few minutes and check the orders before placing it again.';

/** The form's one-time key, generated when the form is shown. */
const requestKey = (ctx: Ctx): string | null => {
  const key = ctx.body?.requestKey;
  return typeof key === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(key) ? key : null;
};

const istTime = (at: string) => new Date(at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });

type Outcome = { ok: boolean; status: string; remark: string | null; nseId: string | null; detail?: Record<string, unknown> };
type Draft = Pick<Request, 'id' | 'kind' | 'schemeCode' | 'schemeName' | 'amount' | 'detail'>;

/**
 * Sends one order, mandate, SIP or cancellation to NSE at most once (these move real money on live NSE):
 * - the request is saved as SENDING before NSE is called, so a timeout leaves a record ("NO_ANSWER"), not nothing;
 * - the same form (its requestKey) can't be sent twice: a double click or a retry is refused;
 * - an identical request still SENDING, or that NSE never answered, blocks another for 15 minutes.
 */
async function sendOnce(r: InvestRow, ctx: Ctx, draft: Draft, linkType: ProductType, send: () => Promise<Outcome>): Promise<Outcome & { link: string | null; linkError: string | null }> {
  const key = requestKey(ctx);
  const same = (q: Request) =>
    q.kind === draft.kind && q.schemeCode === draft.schemeCode && q.amount === draft.amount && JSON.stringify(q.detail) === JSON.stringify(draft.detail);
  let refusal: string | null = null;
  await changeRequests(r.id, (list) => {
    if (key && list.some((q) => q.key === key)) {
      refusal = 'This was already sent: see "Started from here" on the Transactions tab. Reload the page before starting another.';
      return false;
    }
    const stuck = list.find((q) => (q.status === 'SENDING' || q.status === 'NO_ANSWER') && same(q) && Date.now() - Date.parse(q.at) < NoAnswerHoldMs);
    if (stuck) {
      refusal = `The same request sent at ${istTime(stuck.at)} has no answer from NSE yet. Press Refresh to see whether NSE has it; it can be sent again 15 minutes after the first.`;
      return false;
    }
    list.push({ ...draft, key, nseId: null, ok: false, status: 'SENDING', remark: null, link: null, linkError: null, at: nowIso(), by: ctx.staff!.id });
  });
  if (refusal) throw HttpError.conflict(refusal);

  let result: Outcome;
  try {
    result = await send();
  } catch (error) {
    await updateRequest(r.id, draft.id, { status: 'NO_ANSWER', remark: NoAnswerRemark });
    if (error instanceof NseError) throw new HttpError(502, 'NSE_NO_ANSWER', `${NoAnswerRemark} (NSE: ${error.message})`);
    throw error;
  }
  const link = result.ok && result.nseId
    ? await productLink(linkType, result.nseId).catch((e: Error) => ({ link: null, error: e.message }))
    : { link: null, error: null };
  await updateRequest(r.id, draft.id, {
    nseId: result.nseId, ok: result.ok, status: result.status, remark: result.remark, link: link.link, linkError: link.error,
    ...(result.detail ? { detail: { ...draft.detail, ...result.detail } } : {}),
  });
  return { ...result, link: link.link, linkError: link.error };
}

/** A unique id for NSE (member_unique_id / member mandate no / bank ref no): at most 20 characters. */
const uniqueId = (prefix: string) => `${prefix}${Date.now().toString(36).toUpperCase()}${randomBytes(2).toString('hex').toUpperCase()}`.slice(0, 20);

async function scheme(code: unknown): Promise<Scheme> {
  const s = (await schemesFromNse()).get(String(code ?? '').trim().toUpperCase());
  if (!s) throw HttpError.badRequest('Choose a scheme from the search.');
  return s;
}

const amountOf = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || Math.round(n * 100) !== n * 100) throw HttpError.badRequest('Enter the amount in rupees.');
  return n;
};

const schemeView = (s: Scheme) => ({
  schemeCode: s.schemeCode, name: s.name, isin: s.isin, type: s.type, amcCode: s.amcCode, amcName: s.amcName, rta: s.rta, plan: s.plan,
  minFresh: s.minFresh, minAdditional: s.minAdditional, multiplier: s.multiplier, cutoff: s.cutoff, nav: s.nav, navDate: s.navDate,
  purchaseAllowed: s.purchaseAllowed, redemptionAllowed: s.redemptionAllowed, redemptionMinAmount: s.redemptionMinAmount,
  exitLoad: s.exitLoad, lockInDays: s.lockInDays, launchedOn: s.launchedOn, openEnded: s.openEnded, settlement: s.settlement,
  sipAllowed: s.sipAllowed, sipMonthly: s.sip['MONTHLY'] ?? null,
});

/** Direct or Regular, Growth or IDCW: from AMFI when it lists the fund, else from NSE's scheme name. */
const planOf = (s: Scheme, a: AmfiFund | undefined) => (a?.plan ? (/direct/i.test(a.plan) ? 'Direct' : 'Regular') : /DIRECT/.test(s.name) ? 'Direct' : 'Regular');
const optionOf = (s: Scheme, a: AmfiFund | undefined) => (/IDCW|DIVIDEND|PAYOUT|REINVEST/i.test(a ? a.option ?? '' : s.name) ? 'IDCW' : 'Growth');

/** NSE's NAV date ("02-11-2026", "02-Nov-2026" or ISO) as ISO, for comparing with AMFI's. */
const isoOfNse = (v: string) => isoDate(v) ?? v;

/** A scheme with what AMFI adds: its SEBI category, fund house and AMFI code (for its NAV history). */
const fundView = (s: Scheme, a: AmfiFund | undefined) => ({
  ...schemeView(s),
  amcName: a?.fundHouse || s.amcName,
  amfiCode: a?.amfiCode ?? null,
  // AMFI's "Axis Children's Fund", against NSE's "AXIS CHILDREN'S FUND - DIRECT PLAN - GROWTH".
  displayName: a?.name || null,
  assetClass: a?.assetClass ?? null,
  category: a?.category ?? null,
  structure: a?.structure ?? null,
  planName: planOf(s, a),
  option: optionOf(s, a),
  // AMFI's NAV is often a day newer than NSE's master.
  ...(a?.nav && a.navDate && (!s.navDate || a.navDate >= isoOfNse(s.navDate)) ? { nav: a.nav, navDate: a.navDate } : {}),
});
type FundView = ReturnType<typeof fundView>;

const word = (v: string | null | undefined) => String(v ?? '').trim();
/** Each value once, with how many funds have it, most common first. */
const facet = (values: string[]) =>
  [...values.reduce((m, v) => (v ? m.set(v, (m.get(v) ?? 0) + 1) : m), new Map<string, number>())]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

export function hufInvestRoutes(router: Router): void {
  const full = authenticate('full');
  const manage = need('hufs.manage');

  router.get('/hufs/schemes', full, manage, async (ctx) => {
    const q = ctx.query.get('search')?.trim() ?? '';
    if (q.length < 3) return [];
    try {
      return (await searchSchemes(q, 25)).map(schemeView);
    } catch (error) {
      return nseFailure(error);
    }
  });

  /**
   * Every fund open for purchase on NSE, with AMFI's category: searchable by name, code, ISIN or fund house and
   * filtered by asset class, category, fund house, plan, option and SIP. Each facet counts what the other filters leave.
   */
  router.get('/hufs/funds', full, manage, async (ctx) => {
    const q = ctx.query;
    const words = word(q.get('search')).toUpperCase().split(/\s+/).filter(Boolean).slice(0, 8);
    const want = {
      assetClass: word(q.get('assetClass')), category: word(q.get('category')), fundHouse: word(q.get('fundHouse')),
      plan: word(q.get('plan')), option: word(q.get('option')),
    };
    const sipOnly = q.get('sip') === '1';
    const pageSize = Math.min(50, Math.max(5, Number(q.get('limit')) || 25));
    const page = Math.max(1, Math.floor(Number(q.get('page')) || 1));
    const [schemes, amfi] = await Promise.all([schemesFromNse().catch(nseFailure), amfiDirectoryOrEmpty()]);
    const all = [...schemes.values()].filter((s) => s.purchaseAllowed).map((s) => fundView(s, amfi.get(s.isin)));
    const matches = (f: FundView, ...skip: (keyof typeof want)[]) =>
      (!words.length || words.every((w) => `${f.schemeCode} ${f.name} ${f.isin} ${f.amcName.toUpperCase()}`.includes(w))) &&
      (!sipOnly || Boolean(f.sipMonthly)) &&
      (skip.includes('assetClass') || !want.assetClass || f.assetClass === want.assetClass) &&
      (skip.includes('category') || !want.category || f.category === want.category) &&
      (skip.includes('fundHouse') || !want.fundHouse || f.amcName === want.fundHouse) &&
      (skip.includes('plan') || !want.plan || f.planName === want.plan) &&
      (skip.includes('option') || !want.option || f.option === want.option);
    const hits = all.filter((f) => matches(f)).sort((a, b) => a.name.localeCompare(b.name));
    const facetOf = (keys: (keyof typeof want)[], value: (f: FundView) => string | null) => facet(all.filter((f) => matches(f, ...keys)).map((f) => value(f) ?? ''));
    return {
      items: hits.slice((page - 1) * pageSize, page * pageSize),
      total: hits.length,
      page,
      pageSize,
      catalogue: all.length,
      categorised: amfi.size > 0,
      facets: {
        assetClasses: facetOf(['assetClass', 'category'], (f) => f.assetClass),
        categories: facetOf(['category'], (f) => f.category),
        fundHouses: facetOf(['fundHouse'], (f) => f.amcName),
        plans: facetOf(['plan'], (f) => f.planName),
        options: facetOf(['option'], (f) => f.option),
      },
    };
  });

  /** One fund as NSE's masters describe it, with AMFI's category: the fund screen's "about" and its purchase and SIP rules. */
  router.get('/hufs/schemes/:code', full, manage, async (ctx) => {
    const s = (await schemesFromNse().catch(nseFailure)).get(String(ctx.params['code'] ?? '').toUpperCase());
    if (!s) throw HttpError.notFound('NSE has no scheme with that code.');
    return fundView(s, (await amfiDirectoryOrEmpty()).get(s.isin));
  });

  /** A fund's NAV history (thinned for a chart) and its returns, from AMFI's NAVs. */
  router.get('/hufs/schemes/:code/history', full, manage, async (ctx) => {
    const s = (await schemesFromNse().catch(nseFailure)).get(String(ctx.params['code'] ?? '').toUpperCase());
    if (!s) throw HttpError.notFound('NSE has no scheme with that code.');
    const a = (await amfiDirectory().catch(() => new Map<string, AmfiFund>())).get(s.isin);
    if (!a) return { amfiCode: null, points: [], returns: returnsOf([]), error: "AMFI doesn't list this fund's ISIN, so there's no NAV history for it." };
    try {
      const points = await navHistory(a.amfiCode);
      return { amfiCode: a.amfiCode, points: thin(points), returns: returnsOf(points), error: points.length ? null : 'No NAV history yet.' };
    } catch (error) {
      return { amfiCode: a.amfiCode, points: [], returns: returnsOf([]), error: `NAV history couldn't be read just now (${(error as Error).message}).` };
    }
  });

  router.get('/hufs/:id/investments', full, manage, async (ctx) => view(await load(uuidParam(ctx, 'id'))));

  router.post('/hufs/:id/investments/refresh', full, manage, async (ctx) => {
    const r = await load(uuidParam(ctx, 'id'));
    if (r.status !== 'ACTIVE' && r.status !== 'AWAITING_KARTA') throw HttpError.conflict('The HUF is not on NSE yet.');
    await refreshInvestments(r).catch(nseFailure);
    return view(await load(r.id));
  });

  /** A lumpsum purchase. NSE sends the karta a link to confirm it (OTP) and pay from the HUF's own account. */
  router.post('/hufs/:id/purchase', full, manage, async (ctx: Ctx) => {
    const r = await load(uuidParam(ctx, 'id'));
    const blocked = investBlock(r);
    if (blocked) throw HttpError.conflict(blocked);
    const s = await scheme(ctx.body?.schemeCode).catch(nseFailure);
    const amount = amountOf(ctx.body?.amount);
    const folio = typeof ctx.body?.folio === 'string' && ctx.body.folio.trim() ? ctx.body.folio.trim() : null;
    const problem = purchaseProblem({ scheme: s, amount, folio });
    if (problem) throw HttpError.badRequest(problem);
    const d = unseal<HufDetails>(r.details);
    const id = uniqueId('HP');
    const draft = { id, kind: 'PURCHASE' as const, schemeCode: s.schemeCode, schemeName: s.name, amount, detail: { folio, buyType: folio ? 'ADDITIONAL' : 'FRESH' } };
    const placed = await sendOnce(r, ctx, draft, 'PUR', async () => {
      const p = await placePurchase(d, { scheme: s, amount, folio }, id);
      return { ok: p.ok, status: p.status, remark: p.remark, nseId: p.orderId };
    });
    await event(r.id, placed.ok ? 'PURCHASE_PLACED' : 'PURCHASE_FAILED', ctx.staff!.id, `${s.name}, ₹${amount}${placed.nseId ? `, order ${placed.nseId}` : ''}${placed.remark ? `: ${placed.remark}` : ''}`);
    await audit(ctx, 'huf.purchase', r.id, { schemeCode: s.schemeCode, amount, orderId: placed.nseId, ok: placed.ok, live: nseIsLive() });
    if (!placed.ok) throw HttpError.conflict(`NSE refused the order: ${placed.remark ?? placed.status}`);
    return view(await load(r.id));
  });

  /** An eNACH mandate on the HUF's account, needed for SIPs. The karta approves it with their bank. */
  router.post('/hufs/:id/mandate', full, manage, async (ctx) => {
    const r = await load(uuidParam(ctx, 'id'));
    const blocked = investBlock(r);
    if (blocked) throw HttpError.conflict(blocked);
    const amount = amountOf(ctx.body?.amount);
    if (amount < 500 || amount > 10_000_000) throw HttpError.badRequest('The mandate limit is the most one debit can take: between ₹500 and ₹1 crore (₹1 lakh is usual).');
    const d = unseal<HufDetails>(r.details);
    const id = uniqueId('HM');
    const draft = { id, kind: 'MANDATE' as const, schemeCode: null, schemeName: null, amount, detail: { type: 'eNACH', account: `${d.accountNo.slice(-4)} · ${d.ifsc}` } };
    const reg = await sendOnce(r, ctx, draft, 'MANDATE_AUTH', async () => {
      const m = await registerMandate(d, amount, id);
      return { ok: m.ok, status: m.status, remark: m.remark, nseId: m.id, detail: { endDate: m.endDate } };
    });
    await event(r.id, reg.ok ? 'MANDATE_REGISTERED' : 'MANDATE_FAILED', ctx.staff!.id, `₹${amount} eNACH${reg.nseId ? `, mandate ${reg.nseId}` : ''}${reg.remark ? `: ${reg.remark}` : ''}`);
    await audit(ctx, 'huf.mandate', r.id, { amount, mandateId: reg.nseId, ok: reg.ok, live: nseIsLive() });
    if (!reg.ok) throw HttpError.conflict(`NSE refused the mandate: ${reg.remark ?? reg.status}`);
    return view(await load(r.id));
  });

  /** A monthly SIP on an approved mandate. NSE sends the karta a link to approve it. */
  router.post('/hufs/:id/sip', full, manage, async (ctx) => {
    const r = await load(uuidParam(ctx, 'id'));
    const blocked = investBlock(r);
    if (blocked) throw HttpError.conflict(blocked);
    const s = await scheme(ctx.body?.schemeCode).catch(nseFailure);
    const amount = amountOf(ctx.body?.amount);
    const installments = Number(ctx.body?.installments);
    const startDate = String(ctx.body?.startDate ?? '');
    const d = unseal<HufDetails>(r.details);
    // Read fresh: a mandate must be APPROVED by the bank, which happens outside this admin.
    const mandates = await readMandates(d.clientCode).catch(nseFailure);
    const mandate = mandates.find((m) => m.mandateId === String(ctx.body?.mandateId ?? '') && m.status === 'APPROVED');
    if (!mandate) throw HttpError.badRequest('Choose an approved mandate. A new one needs the karta to approve it with their bank first.');
    const input = { scheme: s, amount, startDate, installments, mandateId: mandate.mandateId, mandateAmount: mandate.amount, mandateEnd: mandate.endDate };
    const problem = sipProblem(input);
    if (problem) throw HttpError.badRequest(problem);
    const id = uniqueId('HS');
    const draft = { id, kind: 'SIP' as const, schemeCode: s.schemeCode, schemeName: s.name, amount, detail: { startDate, installments, mandateId: mandate.mandateId, frequency: 'MONTHLY' } };
    const reg = await sendOnce(r, ctx, draft, 'XSIP_REG', async () => {
      const x = await registerXsip(d, input, id);
      return { ok: x.ok, status: x.status, remark: x.remark, nseId: x.id };
    });
    await event(r.id, reg.ok ? 'SIP_REGISTERED' : 'SIP_FAILED', ctx.staff!.id, `${s.name}, ₹${amount} a month from ${startDate}, ${installments} instalments${reg.nseId ? `, ${reg.nseId}` : ''}${reg.remark ? `: ${reg.remark}` : ''}`);
    await audit(ctx, 'huf.sip', r.id, { schemeCode: s.schemeCode, amount, installments, startDate, regId: reg.nseId, ok: reg.ok, live: nseIsLive() });
    if (!reg.ok) throw HttpError.conflict(`NSE refused the SIP: ${reg.remark ?? reg.status}`);
    return view(await load(r.id));
  });

  /**
   * Sells units from a folio: an amount, a number of units, or everything. NSE sends the investor a link (RED) to
   * authorise it; the money goes to the registered bank account.
   */
  router.post('/hufs/:id/redeem', full, manage, async (ctx) => {
    const r = await load(uuidParam(ctx, 'id'));
    const blocked = investBlock(r);
    if (blocked) throw HttpError.conflict(blocked);
    const s = await scheme(ctx.body?.schemeCode).catch(nseFailure);
    const folio = String(ctx.body?.folio ?? '').trim();
    if (!folio) throw HttpError.badRequest('Choose the folio to redeem from.');
    const all = ctx.body?.all === true;
    const by = ctx.body?.by === 'units' ? 'units' : 'amount';
    const units = !all && by === 'units' ? Number(ctx.body?.units) : null;
    if (units !== null && (!Number.isFinite(units) || units <= 0)) throw HttpError.badRequest('Enter the number of units (up to 3 decimals).');
    const amount = !all && by === 'amount' ? amountOf(ctx.body?.amount) : null;
    // Holdings as NSE last reported them (refreshed daily and on Refresh); NSE checks the units itself too.
    const inv = r.investments ? (JSON.parse(r.investments) as Investments) : null;
    const holding = inv?.holdings.find((h) => h.schemeCode === s.schemeCode && h.folio === folio);
    const input = { scheme: s, folio, amount, units: units === null ? null : Math.round(units * 1000) / 1000, all };
    const problem = redeemProblem(input, holding);
    if (problem) throw HttpError.badRequest(problem);
    const d = unseal<HufDetails>(r.details);
    const id = uniqueId('HR');
    const what = all ? 'all units' : input.units !== null ? `${input.units} units` : `₹${amount}`;
    const draft = { id, kind: 'REDEMPTION' as const, schemeCode: s.schemeCode, schemeName: s.name, amount: amount ?? 0, detail: { folio, all, units: input.units, by: all ? 'all' : by } };
    const placed = await sendOnce(r, ctx, draft, 'RED', async () => {
      const p = await placeRedemption(d, input, id);
      return { ok: p.ok, status: p.status, remark: p.remark, nseId: p.orderId };
    });
    await event(r.id, placed.ok ? 'REDEMPTION_PLACED' : 'REDEMPTION_FAILED', ctx.staff!.id, `${s.name}, ${what} from folio ${folio}${placed.nseId ? `, order ${placed.nseId}` : ''}${placed.remark ? `: ${placed.remark}` : ''}`);
    await audit(ctx, 'huf.redemption', r.id, { schemeCode: s.schemeCode, folio, amount, units: input.units, all, orderId: placed.nseId, ok: placed.ok, live: nseIsLive() });
    if (!placed.ok) throw HttpError.conflict(`NSE refused the redemption: ${placed.remark ?? placed.status}`);
    return view(await load(r.id));
  });

  /** Stops a SIP. NSE sends the investor a link (XSIP_CAN) to authorise the cancellation. */
  router.post('/hufs/:id/sips/:regNo/cancel', full, manage, async (ctx) => {
    const r = await load(uuidParam(ctx, 'id'));
    const regNo = String(ctx.params['regNo'] ?? '').trim();
    const inv = r.investments ? (JSON.parse(r.investments) as Investments) : null;
    const sip = inv?.sips.find((x) => x.registrationNo === regNo);
    if (!sip) throw HttpError.notFound('That SIP could not be found. Refresh the investments and try again.');
    if (/CANCEL|CEASE|CLOSE|EXPIRE/i.test(sip.status)) throw HttpError.conflict(`This SIP is already ${sip.status.toLowerCase()}.`);
    const reason = String(ctx.body?.reason ?? '');
    if (!SipCancelReasons[reason]) throw HttpError.badRequest('Choose why the SIP is being stopped.');
    const other = String(ctx.body?.other ?? '').trim();
    if (reason === '13' && other.length < 3) throw HttpError.badRequest('Write the reason.');
    const d = unseal<HufDetails>(r.details);
    const draft = {
      id: uniqueId('HC'), kind: 'SIP_CANCEL' as const, schemeCode: null, schemeName: sip.schemeName, amount: sip.amount ?? 0,
      detail: { regNo, reason: SipCancelReasons[reason], other: reason === '13' ? other : null },
    };
    const result = await sendOnce(r, ctx, draft, 'XSIP_CAN', async () => {
      const c = await cancelXsip(d.clientCode, regNo, reason, other);
      return { ok: c.ok, status: c.status, remark: c.remark, nseId: regNo };
    });
    await event(r.id, result.ok ? 'SIP_CANCEL_REQUESTED' : 'SIP_CANCEL_FAILED', ctx.staff!.id, `${sip.schemeName}, SIP ${regNo}${result.remark ? `: ${result.remark}` : ''}`);
    await audit(ctx, 'huf.sip_cancel', r.id, { regNo, reason, ok: result.ok, live: nseIsLive() });
    if (!result.ok) throw HttpError.conflict(`NSE refused the cancellation: ${result.remark ?? result.status}`);
    return view(await load(r.id));
  });

  /**
   * Pays a placed purchase by NEFT/RTGS with the bank's UTR, after the investor has transferred the money from its
   * registered account. The way a company pays (NSE has no corporate net banking); a HUF can too.
   */
  router.post('/hufs/:id/requests/:requestId/neft', full, manage, async (ctx) => {
    const r = await load(uuidParam(ctx, 'id'));
    const requestId = String(ctx.params['requestId'] ?? '');
    const utr = String(ctx.body?.utr ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9]{12,30}$/.test(utr)) throw HttpError.badRequest('Enter the UTR from the bank: 12 to 30 letters and digits (NEFT 16, RTGS 22).');
    // Claimed under the row lock before NSE is called, so two submits at once can't both send a payment.
    let orderId: string | null = null;
    let refusal: HttpError | null = null;
    await changeRequests(r.id, (list) => {
      const q = list.find((x) => x.id === requestId);
      if (!q || q.kind !== 'PURCHASE' || !q.ok || !q.nseId) { refusal = HttpError.notFound('That purchase could not be found.'); return false; }
      if (q.neft?.ok) { refusal = HttpError.conflict(`This order is already paid by NEFT (UTR ${q.neft.utr}).`); return false; }
      if ((q.neft?.status === 'SENDING' || q.neft?.status === 'NO_ANSWER') && Date.now() - Date.parse(q.neft.at) < NoAnswerHoldMs) {
        refusal = HttpError.conflict(`UTR ${q.neft.utr} was sent at ${istTime(q.neft.at)} and NSE hasn't answered yet. Press Refresh before sending it again.`);
        return false;
      }
      orderId = q.nseId;
      q.neft = { utr, ok: false, status: 'SENDING', remark: null, at: nowIso(), by: ctx.staff!.id };
    });
    if (refusal) throw refusal;
    const d = unseal<HufDetails>(r.details);
    const setNeft = (neft: NonNullable<Request['neft']>) => changeRequests(r.id, (list) => {
      const q = list.find((x) => x.id === requestId);
      if (!q) return false;
      q.neft = neft;
    });
    let paid: Awaited<ReturnType<typeof payByNeft>>;
    try {
      paid = await payByNeft(d.clientCode, orderId!, utr);
    } catch (error) {
      await setNeft({ utr, ok: false, status: 'NO_ANSWER', remark: NoAnswerRemark, at: nowIso(), by: ctx.staff!.id });
      if (error instanceof NseError) throw new HttpError(502, 'NSE_NO_ANSWER', `${NoAnswerRemark} (NSE: ${error.message})`);
      throw error;
    }
    await setNeft({ utr, ok: paid.ok, status: paid.status, remark: paid.remark, at: nowIso(), by: ctx.staff!.id });
    const q = { nseId: orderId };
    await event(r.id, paid.ok ? 'NEFT_SUBMITTED' : 'NEFT_FAILED', ctx.staff!.id, `Order ${q.nseId}, UTR ${utr}${paid.remark ? `: ${paid.remark}` : ''}`);
    await audit(ctx, 'huf.neft', r.id, { orderId: q.nseId, ok: paid.ok, live: nseIsLive() });
    if (!paid.ok) throw HttpError.conflict(`NSE refused the payment: ${paid.remark ?? paid.status}`);
    return view(await load(r.id));
  });

  /** NSE's link for something started here, fetched again (NSE may issue it a little later). */
  router.post('/hufs/:id/requests/:requestId/link', full, manage, async (ctx) => {
    const r = await load(uuidParam(ctx, 'id'));
    const list = requestsOf(r);
    const q = list.find((x) => x.id === ctx.params['requestId']);
    if (!q || !q.ok || !q.nseId) throw HttpError.notFound('That request could not be found.');
    const types: Record<Request['kind'], ProductType> = { PURCHASE: 'PUR', REDEMPTION: 'RED', MANDATE: 'MANDATE_AUTH', SIP: 'XSIP_REG', SIP_CANCEL: 'XSIP_CAN' };
    const type = types[q.kind];
    const link = await productLink(type, q.nseId).catch(nseFailure);
    await updateRequest(r.id, q.id, { link: link.link ?? q.link, linkError: link.link ? null : link.error });
    return view(await load(r.id));
  });
}

/**
 * Once a day per HUF, re-reads its investments from NSE, so the page is current without anyone pressing Refresh.
 * Checked hourly; a HUF read in the last day is skipped.
 */
export function startInvestmentLoop(): void {
  const tick = async () => {
    if (!nseConfigured() || (nseIsLive() && !config.nse.allowProd)) return;
    const rows = await all<InvestRow>("SELECT * FROM hufs WHERE status IN ('ACTIVE', 'AWAITING_KARTA')");
    for (const r of rows) {
      if (r.investments_read_at && Date.now() - Date.parse(r.investments_read_at) < DayMs) continue;
      await refreshInvestments(r).catch((error) => console.error(`[hufs] investments ${r.client_code} failed:`, (error as Error).message));
    }
  };
  const go = () => void tick().catch((error) => console.error('[hufs] investment loop failed:', (error as Error).message));
  setTimeout(go, 5 * 60_000).unref();
  setInterval(go, 3_600_000).unref();
}
