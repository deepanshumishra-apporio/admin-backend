// A HUF's money on NSE Invest: what it holds and has ordered (read from NSE's reports, since NSE has no holdings
// API), and new investments placed from the admin (lumpsum, eNACH mandate, XSIP). Ported from the NSE sip-flow
// project (sipFlow.js placeLumpsum / registerMandate / buildSipRequest / holdings), tested there on UAT and prod.
//
// Nothing here moves money by itself: NSE sends the karta a link for every order, mandate and SIP, and only the
// karta's OTP (and, for a purchase, their payment from the HUF's own bank account) completes it.
import { config } from '../config.ts';
import { nsePost, trim } from './client.ts';
import type { HufDetails, NseResult } from './huf.ts';

const up = (v: unknown): string => String(v ?? '').trim().toUpperCase();
const num = (v: unknown): number | null => {
  const n = Number(String(v ?? '').replace(/,/g, '').trim());
  return String(v ?? '').trim() !== '' && String(v).trim() !== '-' && Number.isFinite(n) ? n : null;
};
const DayMs = 86_400_000;
const istToday = () => new Date(Date.now() + 5.5 * 3_600_000);
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const dmyDash = (d: Date) => ymd(d).split('-').reverse().join('-');
const dmySlash = (d: Date) => ymd(d).split('-').reverse().join('/');
const rows = (body: any): any[] => (Array.isArray(body?.report_data) ? body.report_data : []);

// --- scheme masters (NSE's own files, refreshed once a day) ----------------------------------------------

export type SipRule = { dates: number[]; minAmount: number | null; maxAmount: number | null; multiplier: number | null; minInstallments: number | null; maxInstallments: number | null; minGapDays: number | null };
export type Scheme = {
  schemeCode: string; name: string; isin: string; amcCode: string; type: string; rta: string;
  purchaseAllowed: boolean; minFresh: number | null; minAdditional: number | null; multiplier: number | null; cutoff: string;
  sipAllowed: boolean; nav: number | null; navDate: string | null; sip: Record<string, SipRule>;
};

let masters: { at: number; schemes: Map<string, Scheme> } | null = null;
let loading: Promise<Map<string, Scheme>> | null = null;

function parseTable(text: string): Record<string, string>[] {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim());
  const headers = (lines[0] ?? '').split('|').map((h) => h.trim().toUpperCase());
  return lines.slice(1).map((l) => Object.fromEntries(l.split('|').map((c, i) => [headers[i] ?? String(i), c.trim()])));
}

const days = (s: string): number[] => {
  const out = new Set<number>();
  for (const part of String(s).split(/[,;\s]+/)) {
    const range = part.match(/^(\d{1,2})-(\d{1,2})$/);
    if (range) for (let i = Number(range[1]); i <= Number(range[2]); i++) out.add(i);
    else if (/^\d{1,2}$/.test(part)) out.add(Number(part));
  }
  return [...out].filter((n) => n >= 1 && n <= 31).sort((a, b) => a - b);
};

/** Builds the scheme list from NSE's SCH, NAV and SIP masters. `-L1` rows (₹2 lakh liquid variants) are left out. */
export function buildSchemes(sch: string, nav: string, sip: string): Map<string, Scheme> {
  const schemes = new Map<string, Scheme>();
  for (const r of parseTable(sch)) {
    const code = up(r['SCHEME CODE']);
    if (!code || /-L\d$/.test(code) || r['AMC ACTIVE FLAG'] === 'N') continue;
    schemes.set(code, {
      schemeCode: code, name: up(r['SCHEME NAME']), isin: up(r['ISIN']), amcCode: up(r['AMC CODE']), type: up(r['SCHEME TYPE']), rta: up(r['RTA AGENT CODE']),
      purchaseAllowed: r['PURCHASE ALLOWED'] === 'Y', minFresh: num(r['NEW PURCHASE MIN AMOUNT']), minAdditional: num(r['ADDITIONAL PURCHASE MIN AMOUNT']),
      multiplier: num(r['PURCHASE AMOUNT MULTIPLIER']), cutoff: trim(r['PURCHASE CUTOFF TIME']), sipAllowed: r['SIP ALLOWED'] === 'Y',
      nav: null, navDate: null, sip: {},
    });
  }
  // The NAV file has no header: date|scheme code|name|rta code|div flag|isin|nav|rta.
  for (const line of String(nav).split(/\r?\n/)) {
    const c = line.split('|');
    const s = schemes.get(up(c[1]));
    if (s && num(c[6]) !== null) { s.nav = num(c[6]); s.navDate = trim(c[0]) || null; }
  }
  for (const r of parseTable(sip)) {
    const s = schemes.get(up(r['SCHEME_CODE']));
    if (!s || !/ACTIVE/i.test(r['SIP_STATUS'] ?? '')) continue;
    s.sip[up(r['SIP_FREQUENCY']) || 'MONTHLY'] = {
      dates: days(r['SIP_DATES'] ?? ''), minAmount: num(r['SIP_MINIMUM_INSTALLMENT_AMOUNT']), maxAmount: num(r['SIP_MAXIMUM_INSTALLMENT_AMOUNT']),
      multiplier: num(r['SIP_MULTIPLIER_AMOUNT']), minInstallments: num(r['SIP_MINIMUM_INSTALLMENT_NUMBERS']),
      maxInstallments: num(r['SIP_MAXIMUM_INSTALLMENT_NUMBERS']), minGapDays: num(r['SIP_MINIMUM_GAP']),
    };
  }
  return schemes;
}

/** The scheme list, downloaded from NSE at most once a day (each master is a few MB). */
export function schemesFromNse(): Promise<Map<string, Scheme>> {
  if (masters && Date.now() - masters.at < DayMs) return Promise.resolve(masters.schemes);
  loading ??= (async () => {
    const [sch, nav, sip] = await Promise.all(['SCH', 'NAV', 'SIP'].map(async (file_type) => {
      const body = await nsePost('reports/MASTER_DOWNLOAD', { file_type });
      if (typeof body !== 'string') throw new Error(`NSE sent no ${file_type} master: ${trim(body?.response_status_remarks) || 'unexpected answer'}`);
      return body;
    })) as [string, string, string];
    const schemes = buildSchemes(sch, nav, sip);
    masters = { at: Date.now(), schemes };
    return schemes;
  })().finally(() => (loading = null));
  return loading;
}

/** Schemes whose name or code has every word searched for, purchasable first. */
export async function searchSchemes(query: string, limit = 25): Promise<Scheme[]> {
  const words = up(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out: Scheme[] = [];
  for (const s of (await schemesFromNse()).values()) {
    const hay = `${s.schemeCode} ${s.name} ${s.isin}`;
    if (s.purchaseAllowed && words.every((w) => hay.includes(w))) out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

// --- what the HUF has on NSE -----------------------------------------------------------------------------

export type Order = {
  orderId: string; date: string | null; time: string | null; schemeCode: string; schemeName: string; type: string; amount: number | null;
  units: number | null; folio: string | null; status: string; remark: string; orderType: string; sipRegistrationNo: string | null;
};
export type Allotment = { orderId: string; date: string | null; schemeCode: string; schemeName: string; folio: string | null; nav: number | null; units: number; amount: number | null };
export type Redemption = { orderId: string; date: string | null; schemeCode: string; schemeName: string; folio: string | null; units: number; amount: number | null };
export type Sip = {
  registrationNo: string; status: string; schemeName: string; amount: number | null; frequency: string; startDate: string | null;
  endDate: string | null; installments: number | null; mandateId: string | null; registeredOn: string | null;
};
export type Mandate = {
  mandateId: string; status: string; amount: number | null; bankName: string | null; umrn: string | null; registeredOn: string | null;
  approvedOn: string | null; endDate: string | null; remark: string | null;
};
export type Holding = { schemeCode: string; schemeName: string; folio: string | null; units: number; invested: number; nav: number | null; navDate: string | null; value: number | null };

export type Investments = {
  orders: Order[]; allotments: Allotment[]; redemptions: Redemption[]; sips: Sip[]; mandates: Mandate[]; holdings: Holding[];
  totals: { invested: number; value: number | null; activeSips: number; sipMonthly: number };
  readFrom: string; readAt: string;
};

const dashOrNull = (v: unknown) => (trim(v) && trim(v) !== '-' ? trim(v) : null);

/** Windows of `size` days from `from` to today, oldest first. */
function windows(from: Date, size: number): [Date, Date][] {
  const out: [Date, Date][] = [];
  const today = istToday();
  for (let s = new Date(from); s <= today; s = new Date(s.getTime() + size * DayMs)) out.push([s, new Date(Math.min(s.getTime() + (size - 1) * DayMs, today.getTime()))]);
  return out;
}

/**
 * Reads everything a HUF has done on NSE since `from`: orders (ORDER_STATUS, 7-day windows), allotments and
 * redemptions (30-day windows), SIPs and mandates. Holdings are allotted units less redeemed ones, per scheme and
 * folio, valued at the latest NAV from the scheme master.
 */
export async function readInvestments(clientCode: string, from: Date): Promise<Investments> {
  const orders: Order[] = [];
  for (const [a, b] of windows(from, 7)) {
    const body = await nsePost('reports/ORDER_STATUS', {
      from_date: ymd(a), to_date: ymd(b), trans_type: 'ALL', order_type: 'ALL', sub_order_type: 'ALL', client_code: clientCode, order_ids: '',
    });
    for (const r of rows(body)) {
      orders.push({
        orderId: trim(r.order_id), date: dashOrNull(r.request_date), time: dashOrNull(r.order_time), schemeCode: up(r.scheme_code), schemeName: up(r.scheme_name),
        type: up(r.transaction_type) === 'R' ? 'REDEMPTION' : 'PURCHASE', amount: num(r.amount), units: num(r.quantity), folio: dashOrNull(r.folio_no),
        status: up(r.order_status), remark: up(r.order_remark), orderType: up(r.order_type), sipRegistrationNo: dashOrNull(r.sip_registration_no),
      });
    }
  }
  const allotments: Allotment[] = [];
  const redemptions: Redemption[] = [];
  for (const [a, b] of windows(from, 30)) {
    const range = { order_ids: '', from_date: dmyDash(a), to_date: dmyDash(b), order_type: 'ALL', sub_order_type: 'ALL', client_code: clientCode };
    const [allot, red] = await Promise.all([
      nsePost('reports/ALLOTMENT_STATEMENT', { ...range, transaction_type: '', order_status: '', settlement_type: '', date_type: 'ORD_DATE', member_unique_ids: '' }),
      nsePost('reports/REDEMPTION_STATEMENT', { ...range, transaction_type: '', order_status: '', settlement_type: '', member_unique_ids: '' }),
    ]);
    for (const r of rows(allot)) {
      if (up(r.validflag || 'Y') !== 'Y' || !num(r.allottedqty)) continue;
      allotments.push({ orderId: trim(r.orderno), date: dashOrNull(r.orderdate), schemeCode: up(r.schemecode), schemeName: up(r.schemename), folio: dashOrNull(r.foliono), nav: num(r.allottednav), units: num(r.allottedqty)!, amount: num(r.allotmentamt) ?? num(r.amount) });
    }
    for (const r of rows(red)) {
      if (up(r.validflag || 'Y') !== 'Y') continue;
      const units = num(r.allottedqty) ?? num(r.qty);
      if (!units) continue;
      redemptions.push({ orderId: trim(r.orderno), date: dashOrNull(r.orderdate), schemeCode: up(r.schemecode), schemeName: up(r.scheme_name ?? r.schemename), folio: dashOrNull(r.foliono), units, amount: num(r.allottedamt) ?? num(r.amount) });
    }
  }
  const [sipBody, mandates] = await Promise.all([
    nsePost('reports/XSIP_REG_REPORT', { xsip_reg_id: '', client_code: clientCode, from_date: '', to_date: '', member_unique_ids: '' }),
    readMandates(clientCode),
  ]);
  const sips: Sip[] = rows(sipBody).filter((r) => up(r.client_code) === clientCode).map((r) => ({
    registrationNo: trim(r.xsip_registration_no), status: up(r.status), schemeName: up(r.scheme_name), amount: num(r.installments_amount),
    frequency: up(r.frequency_type), startDate: dashOrNull(r.start_date), endDate: dashOrNull(r.end_date), installments: num(r.no_of_installments),
    mandateId: dashOrNull(r.nse_mandate_id), registeredOn: dashOrNull(r.xsip_registration_date),
  }));

  let schemes: Map<string, Scheme> | null = null;
  try { schemes = await schemesFromNse(); } catch { /* holdings show without a value */ }
  const byKey = new Map<string, Holding>();
  const key = (code: string, folio: string | null) => `${code}|${folio ?? ''}`;
  for (const a of allotments) {
    const h = byKey.get(key(a.schemeCode, a.folio)) ?? { schemeCode: a.schemeCode, schemeName: a.schemeName, folio: a.folio, units: 0, invested: 0, nav: null, navDate: null, value: null };
    h.units += a.units;
    h.invested += a.amount ?? 0;
    byKey.set(key(a.schemeCode, a.folio), h);
  }
  for (const r of redemptions) {
    const h = byKey.get(key(r.schemeCode, r.folio)) ?? [...byKey.values()].find((x) => x.schemeCode === r.schemeCode);
    if (!h) continue;
    const share = h.units ? Math.min(1, r.units / h.units) : 1;
    h.invested -= h.invested * share;
    h.units -= r.units;
  }
  const holdings = [...byKey.values()].filter((h) => h.units > 0.0005).map((h) => {
    const s = schemes?.get(h.schemeCode);
    const nav = s?.nav ?? null;
    return { ...h, units: Math.round(h.units * 10_000) / 10_000, invested: Math.round(h.invested * 100) / 100, nav, navDate: s?.navDate ?? null, value: nav ? Math.round(h.units * nav * 100) / 100 : null };
  });
  const active = sips.filter((s) => /ACTIVE|LIVE|REGISTERED/.test(s.status));
  return {
    orders: [...new Map(orders.map((o) => [o.orderId, o])).values()].sort((a, b) => b.orderId.localeCompare(a.orderId)),
    allotments, redemptions, sips, mandates, holdings,
    totals: {
      invested: Math.round(holdings.reduce((s, h) => s + h.invested, 0) * 100) / 100,
      value: holdings.every((h) => h.value !== null) ? Math.round(holdings.reduce((s, h) => s + (h.value ?? 0), 0) * 100) / 100 : null,
      activeSips: active.length,
      sipMonthly: active.filter((s) => s.frequency === 'MONTHLY').reduce((s, x) => s + (x.amount ?? 0), 0),
    },
    readFrom: ymd(from), readAt: new Date().toISOString(),
  };
}

/** The HUF's mandates and where each stands (APPROVED, REJECTED, …). */
export async function readMandates(clientCode: string): Promise<Mandate[]> {
  const body = await nsePost('reports/MANDATE_STATUS', { mandate_id: '', client_code: clientCode, from_date: '', to_date: '', memberMandateIds: '' });
  return rows(body).filter((r) => up(r.clientCode ?? r.client_code) === clientCode).map((r) => ({
    mandateId: trim(r.mandateId), status: up(r.status), amount: num(r.amount), bankName: dashOrNull(r.bankName), umrn: dashOrNull(r.umrnNo),
    registeredOn: dashOrNull(r.registrationDate), approvedOn: dashOrNull(r.approvedDate), endDate: isoFromDmy(dashOrNull(r.endDate)),
    remark: dashOrNull(r.remarks) ?? dashOrNull(r.rejectReason),
  }));
}

/** "31/12/2050" -> 2050-12-31. */
export const isoFromDmy = (v: string | null): string | null => {
  const m = String(v ?? '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

// --- investing ---------------------------------------------------------------------------------------------

const euin = () => (/^E\d{6}$/.test(config.nse.euin) ? config.nse.euin : '');

export type PurchaseInput = { scheme: Scheme; amount: number; folio: string | null };

/** Why NSE would refuse this purchase, checked against the scheme master first; null when it looks fine. */
export function purchaseProblem({ scheme, amount, folio }: PurchaseInput): string | null {
  if (!scheme.purchaseAllowed) return `${scheme.name} isn't open for purchase.`;
  const min = folio ? scheme.minAdditional : scheme.minFresh;
  if (!(amount > 0)) return 'Enter the amount.';
  if (min && amount < min) return `The minimum ${folio ? 'additional' : 'first'} purchase in ${scheme.name} is ₹${min}.`;
  if (scheme.multiplier && scheme.multiplier > 1 && amount % scheme.multiplier !== 0) return `The amount must be a multiple of ₹${scheme.multiplier}.`;
  return null;
}

/** transaction/NORMAL, a purchase; then NSE's payment link (PUR), where the karta confirms and pays from the HUF's account. */
export async function placePurchase(d: HufDetails, input: PurchaseInput, uniqueId: string): Promise<NseResult & { orderId: string | null }> {
  const e = euin();
  const body = await nsePost('transaction/NORMAL', { transaction_details: [{
    order_ref_number: '', scheme_code: input.scheme.schemeCode, trxn_type: 'P', buy_sell_type: input.folio ? 'ADDITIONAL' : 'FRESH',
    client_code: d.clientCode, demat_physical: 'P', order_amount: String(input.amount), folio_no: input.folio ?? '',
    remarks: 'HUF PURCHASE VIA RISIPS ADMIN', kyc_flag: 'Y', sub_broker_code: '', euin_number: e, euin_declaration: e ? 'Y' : 'N',
    min_redemption_flag: 'N', dpc_flag: 'Y', all_units: 'N', redemption_units: '', sub_broker_arn: config.nse.subBrokerArn,
    bank_ref_no: '', account_no: '', mobile_no: d.mobile, email: d.email.toUpperCase(), mandate_id: '', filler1: '', member_unique_id: uniqueId,
  }] });
  const r = Array.isArray(body?.transaction_details) ? body.transaction_details[0] : null;
  if (!r) return { ok: false, status: 'NO_RESPONSE', remark: 'NSE sent an unexpected response.', orderId: null };
  const orderId = trim(r.trxn_order_id) || null;
  return { ok: trim(r.trxn_status) === 'TRXN SUCCESS' && Boolean(orderId), status: trim(r.trxn_status), remark: trim(r.trxn_remark) || null, orderId };
}

/** NSE's link for a product: PUR (order id), MANDATE_AUTH (mandate id), XSIP_REG (registration id). */
export async function productLink(productType: 'PUR' | 'MANDATE_AUTH' | 'XSIP_REG', ref: string): Promise<{ link: string | null; error: string | null }> {
  const body = await nsePost('reports/GET_LINK', { productType, productRefId: ref });
  const link = trim(body?.firstHolderLink) || null;
  return { link, error: link ? null : trim(body?.errorMessage) || 'NSE returned no link yet.' };
}

const regResult = (body: any): NseResult & { id: string | null } => {
  const r = Array.isArray(body?.reg_data) ? body.reg_data[0] : null;
  if (!r) return { ok: false, status: 'NO_RESPONSE', remark: 'NSE sent an unexpected response.', id: null };
  return { ok: trim(r.reg_status) === 'REG_SUCCESS', status: trim(r.reg_status), remark: trim(r.reg_remark) || null, id: trim(String(r.reg_id ?? '')) || null };
};

/**
 * An eNACH mandate on the HUF's own account, for SIPs: the karta approves it with their bank through NSE's
 * MANDATE_AUTH link. 40 years is NSE's maximum; a SIP must end before its mandate does.
 */
export async function registerMandate(d: HufDetails, amount: number, uniqueId: string): Promise<NseResult & { id: string | null; endDate: string }> {
  const start = istToday();
  const end = new Date(start.getTime() + (40 * 365 - 1) * DayMs);
  const result = regResult(await nsePost('registration/product/MANDATE', { reg_data: [{
    client_code: d.clientCode, amount: String(amount), mandate_type: 'E', account_no: d.accountNo, ac_type: d.accountType,
    ifsc_code: d.ifsc, micr_code: '', start_date: dmySlash(start), end_date: dmySlash(end), member_mandate_no: uniqueId,
  }] }));
  return { ...result, endDate: ymd(end) };
}

export type SipInput = { scheme: Scheme; amount: number; startDate: string; installments: number; mandateId: string; mandateAmount: number | null; mandateEnd: string | null };

/** Why NSE would refuse this SIP, from the SIP master and the mandate; null when it looks fine. */
export function sipProblem(i: SipInput): string | null {
  const rule = i.scheme.sip['MONTHLY'];
  if (!i.scheme.sipAllowed || !rule) return `${i.scheme.name} doesn't take monthly SIPs.`;
  if (!(i.amount > 0)) return 'Enter the monthly amount.';
  if (rule.minAmount && i.amount < rule.minAmount) return `The minimum SIP in this scheme is ₹${rule.minAmount}.`;
  if (rule.maxAmount && i.amount > rule.maxAmount) return `The maximum SIP in this scheme is ₹${rule.maxAmount}.`;
  if (rule.multiplier && rule.multiplier > 1 && i.amount % rule.multiplier !== 0) return `The amount must be a multiple of ₹${rule.multiplier}.`;
  if (i.mandateAmount && i.amount > i.mandateAmount) return `The SIP is more than the mandate allows (₹${i.mandateAmount}).`;
  const start = new Date(`${i.startDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return 'Choose the start date.';
  const gap = Math.max(rule.minGapDays ?? 0, 7);
  if (start.getTime() < Date.parse(ymd(istToday())) + gap * DayMs) return `The first instalment must be at least ${gap} days away.`;
  if (rule.dates.length && !rule.dates.includes(start.getUTCDate())) return `This scheme takes SIPs on these days only: ${rule.dates.join(', ')}.`;
  if (!Number.isInteger(i.installments) || i.installments < 1) return 'Enter the number of instalments.';
  if (rule.minInstallments && i.installments < rule.minInstallments) return `At least ${rule.minInstallments} instalments.`;
  if (rule.maxInstallments && i.installments > rule.maxInstallments) return `At most ${rule.maxInstallments} instalments.`;
  if (i.mandateEnd) {
    const last = new Date(start);
    last.setUTCMonth(last.getUTCMonth() + i.installments - 1);
    if (ymd(last) > i.mandateEnd) return 'The SIP would run past the end of its mandate. Use fewer instalments.';
  }
  return null;
}

/** registration/product/XSIP on an approved mandate. The karta then approves it through NSE's XSIP_REG link. */
export async function registerXsip(d: HufDetails, i: SipInput, uniqueId: string): Promise<NseResult & { id: string | null }> {
  const e = euin();
  return regResult(await nsePost('registration/product/XSIP', { reg_data: [{
    amc_code: i.scheme.amcCode, sch_code: i.scheme.schemeCode, client_code: d.clientCode, trans_mode: 'P', dp_txn_mode: 'P',
    start_date: dmySlash(new Date(`${i.startDate}T00:00:00Z`)), frequency_type: 'MONTHLY', frequency_allowed: '1',
    installment_amount: String(i.amount), status: '1', member_code: config.nse.memberCode, folio_no: '', sip_remarks: 'HUF SIP VIA RISIPS ADMIN',
    installment_no: String(i.installments), sub_broker_code: '', euin_number: e, euin_declaration: e ? 'Y' : 'N', dpc_flag: 'Y',
    first_order_today: 'N', sub_broker_arn: config.nse.subBrokerArn, end_date: '', primary_holder_mobile: d.mobile,
    primary_holder_email: d.email.toUpperCase(), step_up_required: 'N', step_up_start_date: '', step_up_end_date: '', step_up_frequency: '',
    step_up_amount: '', filler_1: '', filler_2: '', filler_3: '', filler_4: '', filler_5: '',
    bank_ref_no: uniqueId, convenience_fee: '0', xsip_mandate_id: i.mandateId, isip_mandate: '',
  }] }));
}
