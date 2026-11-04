// A HUF's investments, read from NSE, and new ones placed from the admin: a lumpsum purchase (the karta confirms
// and pays on NSE's page), an eNACH mandate (the karta approves it with their bank), and a monthly SIP on an
// approved mandate (the karta approves it on NSE). Staff only start these; NSE needs the karta for each.
import { randomBytes } from 'node:crypto';

import { amfiDirectory, amfiDirectoryOrEmpty, isoDate, navHistory, returnsOf, thin, type AmfiFund } from '../amfi.ts';
import { audit, authenticate, need, refOf, staffNames } from '../auth.ts';
import { config, nseIsLive } from '../config.ts';
import { all, nowIso, one, run } from '../db.ts';
import { HttpError, uuidParam, type Ctx, type Router } from '../http.ts';
import { NseError, nseConfigured } from '../nse/client.ts';
import { hufInvestmentNotices } from '../notifications.ts';
import type { HufDetails, NseStatus } from '../nse/huf.ts';
import {
  placePurchase, productLink, purchaseProblem, readInvestments, readMandates, registerMandate, registerXsip,
  schemesFromNse, searchSchemes, sipProblem, type Investments, type Scheme,
} from '../nse/invest.ts';
import { unseal } from '../security.ts';
import { documentsOf, event, type Row } from './hufs.ts';

type InvestRow = Row & { investments: string | null; investments_read_at: string | null; requests: string | null };

/** Something started from here, with NSE's link for the karta. */
type Request = {
  id: string;
  kind: 'PURCHASE' | 'MANDATE' | 'SIP';
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
  if (!nseConfigured() || (nseIsLive() && !config.nse.allowProd)) return 'NSE is not configured on this server.';
  if (r.status !== 'ACTIVE' && r.status !== 'AWAITING_KARTA') return 'The HUF has to be registered on NSE first.';
  const nse = r.nse_status ? (JSON.parse(r.nse_status) as NseStatus) : null;
  if (nse?.bankStatus?.toUpperCase() !== 'ACTIVE') return "NSE hasn't verified the HUF's bank account yet. Refresh its status, or upload a cancelled cheque.";
  const aofAccepted = nse.aof && [nse.aof.cams.status, nse.aof.kfin.status].includes('ACCEPTED');
  if (!documentsOf(r).AOF?.ok && !aofAccepted) return 'Upload the AOF signed by the karta first: NSE needs it before a HUF can invest.';
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
    approvedMandates: (inv?.mandates ?? []).filter((m) => m.status === 'APPROVED').map((m) => ({ mandateId: m.mandateId, amount: m.amount, endDate: m.endDate, bankName: m.bankName })),
    folios: [...new Map((inv?.holdings ?? []).filter((h) => h.folio).map((h) => [`${h.schemeCode}|${h.folio}`, { schemeCode: h.schemeCode, folio: h.folio! }])).values()],
  };
}

async function record(r: InvestRow, q: Request): Promise<void> {
  const list = requestsOf(r);
  list.push(q);
  await run('UPDATE hufs SET requests = ?, updated_at = ? WHERE id = ?', JSON.stringify(list.slice(-200)), nowIso(), r.id);
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
    const placed = await placePurchase(d, { scheme: s, amount, folio }, id).catch(nseFailure);
    const link = placed.ok && placed.orderId ? await productLink('PUR', placed.orderId).catch((e: Error) => ({ link: null, error: e.message })) : { link: null, error: null };
    await record(r, {
      id, kind: 'PURCHASE', nseId: placed.orderId, ok: placed.ok, status: placed.status, remark: placed.remark, schemeCode: s.schemeCode, schemeName: s.name,
      amount, detail: { folio, buyType: folio ? 'ADDITIONAL' : 'FRESH' }, link: link.link, linkError: link.error, at: nowIso(), by: ctx.staff!.id,
    });
    await event(r.id, placed.ok ? 'PURCHASE_PLACED' : 'PURCHASE_FAILED', ctx.staff!.id, `${s.name}, ₹${amount}${placed.orderId ? `, order ${placed.orderId}` : ''}${placed.remark ? `: ${placed.remark}` : ''}`);
    await audit(ctx, 'huf.purchase', r.id, { schemeCode: s.schemeCode, amount, orderId: placed.orderId, ok: placed.ok, live: nseIsLive() });
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
    const reg = await registerMandate(d, amount, id).catch(nseFailure);
    const link = reg.ok && reg.id ? await productLink('MANDATE_AUTH', reg.id).catch((e: Error) => ({ link: null, error: e.message })) : { link: null, error: null };
    await record(r, {
      id, kind: 'MANDATE', nseId: reg.id, ok: reg.ok, status: reg.status, remark: reg.remark, schemeCode: null, schemeName: null, amount,
      detail: { type: 'eNACH', endDate: reg.endDate, account: `${d.accountNo.slice(-4)} · ${d.ifsc}` }, link: link.link, linkError: link.error, at: nowIso(), by: ctx.staff!.id,
    });
    await event(r.id, reg.ok ? 'MANDATE_REGISTERED' : 'MANDATE_FAILED', ctx.staff!.id, `₹${amount} eNACH${reg.id ? `, mandate ${reg.id}` : ''}${reg.remark ? `: ${reg.remark}` : ''}`);
    await audit(ctx, 'huf.mandate', r.id, { amount, mandateId: reg.id, ok: reg.ok, live: nseIsLive() });
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
    const reg = await registerXsip(d, input, id).catch(nseFailure);
    const link = reg.ok && reg.id ? await productLink('XSIP_REG', reg.id).catch((e: Error) => ({ link: null, error: e.message })) : { link: null, error: null };
    await record(r, {
      id, kind: 'SIP', nseId: reg.id, ok: reg.ok, status: reg.status, remark: reg.remark, schemeCode: s.schemeCode, schemeName: s.name, amount,
      detail: { startDate, installments, mandateId: mandate.mandateId, frequency: 'MONTHLY' }, link: link.link, linkError: link.error, at: nowIso(), by: ctx.staff!.id,
    });
    await event(r.id, reg.ok ? 'SIP_REGISTERED' : 'SIP_FAILED', ctx.staff!.id, `${s.name}, ₹${amount} a month from ${startDate}, ${installments} instalments${reg.id ? `, ${reg.id}` : ''}${reg.remark ? `: ${reg.remark}` : ''}`);
    await audit(ctx, 'huf.sip', r.id, { schemeCode: s.schemeCode, amount, installments, startDate, regId: reg.id, ok: reg.ok, live: nseIsLive() });
    if (!reg.ok) throw HttpError.conflict(`NSE refused the SIP: ${reg.remark ?? reg.status}`);
    return view(await load(r.id));
  });

  /** NSE's link for something started here, fetched again (NSE may issue it a little later). */
  router.post('/hufs/:id/requests/:requestId/link', full, manage, async (ctx) => {
    const r = await load(uuidParam(ctx, 'id'));
    const list = requestsOf(r);
    const q = list.find((x) => x.id === ctx.params['requestId']);
    if (!q || !q.ok || !q.nseId) throw HttpError.notFound('That request could not be found.');
    const type = q.kind === 'PURCHASE' ? 'PUR' : q.kind === 'MANDATE' ? 'MANDATE_AUTH' : 'XSIP_REG';
    const link = await productLink(type, q.nseId).catch(nseFailure);
    q.link = link.link ?? q.link;
    q.linkError = link.link ? null : link.error;
    await run('UPDATE hufs SET requests = ? WHERE id = ?', JSON.stringify(list), r.id);
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
