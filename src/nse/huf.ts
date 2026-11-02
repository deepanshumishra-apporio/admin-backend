// Onboarding a HUF (Hindu Undivided Family) on NSE Invest: the rules, the request bodies and the reads.
// Same endpoints as an individual, different values. Ported from the NSE sip-flow project (src/huf.js, tested on
// UAT on 2 Nov 2026); its HUF-FLOW.md explains every value. The order:
//   duplicate check by PAN -> UCC (CLIENTCOMMON, tax status 03) -> FATCA_COMMON with the karta as beneficial owner
//   -> NSE's bank check -> the karta opens the CL_ACT link and confirms with an OTP.
// No eLog: NSE's ELOG API answers "available for Individual client only" for a HUF. The karta's consent IP and
// time go in FATCA's log_name instead, as on the live HUFs.
import { config } from '../config.ts';
import { nsePost, trim } from './client.ts';

export type Coparcener = { name: string; relationship: string; dateOfBirth: string | null };

/** Everything needed to register a HUF. Kept encrypted in the admin database. Dates are yyyy-mm-dd. */
export type HufDetails = {
  clientCode: string;
  hufName: string;
  pan: string;
  formedOn: string;
  placeOfFormation: string;
  natureOfBusiness: string;
  /** 31 below 1 L, 32 1-5 L, 33 5-10 L, 34 10-25 L, 35 25 L-1 Cr, 36 above 1 Cr. */
  incomeSlab: string;
  netWorthLakhs: string;
  netWorthDate: string;
  /** The karta's: NSE sends every authorisation link and OTP there. */
  email: string;
  mobile: string;
  accountType: 'SB' | 'CB';
  accountNo: string;
  ifsc: string;
  bankHolderName: string;
  address1: string;
  address2: string;
  address3: string;
  city: string;
  /** NSE's UCC state code, e.g. MA Maharashtra, UC Uttaranchal. */
  state: string;
  pincode: string;
  karta: { name: string; pan: string; dateOfBirth: string; gender: 'M' | 'F' | 'O'; fatherName: string };
  coparceners: Coparcener[];
};

export const IncomeSlabs = ['31', '32', '33', '34', '35', '36'] as const;
const HufPan = /^[A-Z]{3}H[A-Z][0-9]{4}[A-Z]$/;
const PersonPan = /^[A-Z]{3}P[A-Z][0-9]{4}[A-Z]$/;
const Ifsc = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const Mobile = /^[6-9][0-9]{9}$/;
const Email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IsoDate = /^\d{4}-\d{2}-\d{2}$/;

/** UCC state codes -> the ISO-style codes FATCA's UBO_STATE wants (UAT rejects "MA": "Invalid UBO State Code"). */
export const UccStates: Record<string, { name: string; fatca: string }> = {
  AN: { name: 'Andaman and Nicobar', fatca: 'AN' }, AP: { name: 'Andhra Pradesh', fatca: 'AP' }, AR: { name: 'Arunachal Pradesh', fatca: 'AR' },
  AS: { name: 'Assam', fatca: 'AS' }, BH: { name: 'Bihar', fatca: 'BR' }, CH: { name: 'Chandigarh', fatca: 'CH' },
  CG: { name: 'Chhattisgarh', fatca: 'CT' }, DL: { name: 'Delhi', fatca: 'DL' }, GO: { name: 'Goa', fatca: 'GA' },
  GU: { name: 'Gujarat', fatca: 'GJ' }, HA: { name: 'Haryana', fatca: 'HR' }, HP: { name: 'Himachal Pradesh', fatca: 'HP' },
  JM: { name: 'Jammu and Kashmir', fatca: 'JK' }, JK: { name: 'Jharkhand', fatca: 'JH' }, KA: { name: 'Karnataka', fatca: 'KA' },
  KE: { name: 'Kerala', fatca: 'KL' }, LA: { name: 'Ladakh', fatca: 'LA' }, MP: { name: 'Madhya Pradesh', fatca: 'MP' },
  MA: { name: 'Maharashtra', fatca: 'MH' }, MN: { name: 'Manipur', fatca: 'MN' }, ME: { name: 'Meghalaya', fatca: 'ML' },
  MI: { name: 'Mizoram', fatca: 'MZ' }, NA: { name: 'Nagaland', fatca: 'NL' }, OR: { name: 'Odisha', fatca: 'OR' },
  PO: { name: 'Puducherry', fatca: 'PY' }, PU: { name: 'Punjab', fatca: 'PB' }, RA: { name: 'Rajasthan', fatca: 'RJ' },
  SI: { name: 'Sikkim', fatca: 'SK' }, TN: { name: 'Tamil Nadu', fatca: 'TN' }, TG: { name: 'Telangana', fatca: 'TG' },
  TR: { name: 'Tripura', fatca: 'TR' }, UP: { name: 'Uttar Pradesh', fatca: 'UP' }, UC: { name: 'Uttarakhand', fatca: 'UK' },
  WB: { name: 'West Bengal', fatca: 'WB' },
};

const up = (v: unknown): string => String(v ?? '').trim().toUpperCase();
const text = (v: unknown, max = 70): string => String(v ?? '').trim().slice(0, max);
const sameName = (a: string, b: string) => up(a).replace(/[^A-Z0-9]/g, '') === up(b).replace(/[^A-Z0-9]/g, '');
/** yyyy-mm-dd or dd/mm/yyyy -> yyyy-mm-dd, or '' when it isn't a real date. */
function isoDate(v: unknown): string {
  const raw = String(v ?? '').trim();
  const dmy = raw.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/);
  const iso = dmy ? `${dmy[3]}-${dmy[2]}-${dmy[1]}` : raw;
  if (!IsoDate.test(iso)) return '';
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : '';
}
/** yyyy-mm-dd -> DD/MM/YYYY, as NSE's registration APIs want. */
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const todayIso = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
function age(iso: string): number {
  const [y, m, d] = todayIso().split('-').map(Number) as [number, number, number];
  const [by, bm, bd] = iso.split('-').map(Number) as [number, number, number];
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

/**
 * Normalises a submitted HUF and checks it against everything NSE, the registrars and the bank check later, so a
 * mistake shows here rather than as a KFin rejection a day later. Returns the clean details and field errors.
 */
export function readHuf(body: any, { accountNoConfirm }: { accountNoConfirm?: unknown } = {}): { details: HufDetails; errors: Record<string, string> } {
  const b = body ?? {};
  const k = b.karta ?? {};
  const details: HufDetails = {
    clientCode: up(b.clientCode),
    hufName: up(b.hufName).replace(/\s+/g, ' '),
    pan: up(b.pan),
    formedOn: isoDate(b.formedOn),
    placeOfFormation: up(b.placeOfFormation).slice(0, 60),
    natureOfBusiness: up(b.natureOfBusiness).slice(0, 30),
    incomeSlab: String(b.incomeSlab ?? ''),
    netWorthLakhs: String(b.netWorthLakhs ?? '').trim(),
    netWorthDate: isoDate(b.netWorthDate),
    email: text(b.email, 100).toLowerCase(),
    mobile: String(b.mobile ?? '').replace(/\D/g, ''),
    accountType: b.accountType === 'CB' ? 'CB' : 'SB',
    accountNo: String(b.accountNo ?? '').replace(/\s/g, ''),
    ifsc: up(b.ifsc),
    bankHolderName: up(b.bankHolderName),
    address1: up(b.address1).slice(0, 40),
    address2: up(b.address2).slice(0, 40),
    address3: up(b.address3).slice(0, 40),
    city: up(b.city).slice(0, 35),
    state: up(b.state),
    pincode: String(b.pincode ?? '').trim(),
    karta: {
      name: up(k.name).replace(/\s+/g, ' ').slice(0, 70),
      pan: up(k.pan),
      dateOfBirth: isoDate(k.dateOfBirth),
      gender: (['M', 'F', 'O'].includes(up(k.gender)) ? up(k.gender) : '') as 'M',
      fatherName: up(k.fatherName).slice(0, 50),
    },
    coparceners: (Array.isArray(b.coparceners) ? b.coparceners : []).slice(0, 30).map((m: any) => ({
      name: up(m?.name).slice(0, 70), relationship: up(m?.relationship).slice(0, 30), dateOfBirth: isoDate(m?.dateOfBirth) || null,
    })),
  };
  const d = details;
  const errors: Record<string, string> = {};
  if (!/^[A-Z0-9]{1,10}$/.test(d.clientCode)) errors['clientCode'] = 'Client code must be 1-10 letters or digits (the HUF series is RSPH000001…).';
  if (!/ HUF$/.test(d.hufName)) errors['hufName'] = 'Write the name as on the HUF PAN card, ending in "HUF" (e.g. RAJESH KUMAR HUF).';
  if (!HufPan.test(d.pan)) errors['pan'] = "This must be the HUF's own PAN, with H as the 4th character.";
  if (!d.formedOn || d.formedOn > todayIso()) errors['formedOn'] = 'Enter the date the HUF was formed (a past date).';
  if (!d.placeOfFormation) errors['placeOfFormation'] = 'Enter the city where the HUF was formed.';
  if (!d.natureOfBusiness) errors['natureOfBusiness'] = 'Enter the nature of business (e.g. BUSINESS, PHARMACY).';
  if (!(IncomeSlabs as readonly string[]).includes(d.incomeSlab)) errors['incomeSlab'] = 'Choose an income slab.';
  if (!/^\d{1,13}(\.\d{1,2})?$/.test(d.netWorthLakhs)) errors['netWorthLakhs'] = 'Enter the net worth in lakhs (e.g. 40 or 56.95).';
  if (!d.netWorthDate || d.netWorthDate > todayIso()) errors['netWorthDate'] = 'Enter the date of the net worth figure (usually 31 March).';
  if (!Email.test(d.email)) errors['email'] = "Enter the karta's email: NSE sends every authorisation link there.";
  if (!Mobile.test(d.mobile)) errors['mobile'] = "Enter the karta's 10-digit mobile: NSE sends every OTP there.";
  if (!/^\d{6,18}$/.test(d.accountNo)) errors['accountNo'] = 'Enter the bank account number (6-18 digits).';
  else if (accountNoConfirm !== undefined && String(accountNoConfirm ?? '').replace(/\s/g, '') !== d.accountNo) errors['accountNoConfirm'] = 'The two account numbers do not match.';
  if (!Ifsc.test(d.ifsc)) errors['ifsc'] = 'Enter a valid IFSC, like HDFC0001234.';
  if (!d.bankHolderName || !sameName(d.bankHolderName, d.hufName)) {
    errors['bankHolderName'] = "The account must be in the HUF's name. NSE's bank check and every payment fail on the karta's personal account.";
  }
  if (!d.address1) errors['address1'] = 'Enter the address.';
  if (!d.city) errors['city'] = 'Enter the city.';
  if (!UccStates[d.state]) errors['state'] = 'Choose a state.';
  if (!/^\d{6}$/.test(d.pincode)) errors['pincode'] = 'Enter the 6-digit pincode.';
  if (!d.karta.name) errors['karta.name'] = "Enter the karta's name.";
  if (!PersonPan.test(d.karta.pan)) errors['karta.pan'] = "Enter the karta's personal PAN (P as the 4th character).";
  else if (d.karta.pan === d.pan) errors['karta.pan'] = "The karta's PAN must differ from the HUF's.";
  if (!d.karta.dateOfBirth || age(d.karta.dateOfBirth) < 18) errors['karta.dateOfBirth'] = 'The karta must be an adult. Enter their date of birth.';
  if (!d.karta.gender) errors['karta.gender'] = "Choose the karta's gender.";
  d.coparceners.forEach((m, i) => {
    if (!m.name || !m.relationship) errors[`coparceners.${i}`] = `Co-parcener ${i + 1} needs a name and a relationship.`;
  });
  return { details, errors };
}

/** The karta's consent, recorded on the consent page: their own IP and the moment they agreed. */
export type Consent = { ip: string; at: string };

/** India time parts for NSE's formats. */
function ist(at: string) {
  const d = new Date(Date.parse(at) + 5.5 * 3_600_000).toISOString();
  return { dd: d.slice(8, 10), mm: d.slice(5, 7), yy: d.slice(2, 4), hhmm: d.slice(11, 16) };
}
/** FATCA log_name (max 30): "<IP> DD-MM-YY HH:MM", as on the live HUFs. */
export function fatcaLogName(consent: Consent): string {
  const p = ist(consent.at);
  return `${consent.ip} ${p.dd}-${p.mm}-${p.yy} ${p.hhmm}`.slice(0, 30);
}

const UccColumns = 'client_code primary_holder_first_name primary_holder_middle_name primary_holder_last_name tax_status gender primary_holder_dob_incorporation occupation_code holding_nature second_holder_first_name second_holder_middle_name second_holder_last_name third_holder_first_name third_holder_middle_name third_holder_last_name second_holder_dob third_holder_dob guardian_first_name guardian_middle_name guardian_last_name guardian_dob primary_holder_pan_exempt second_holder_pan_exempt third_holder_pan_exempt guardian_pan_exempt primary_holder_pan second_holder_pan third_holder_pan guardian_pan primary_holder_exempt_category second_holder_exempt_category third_holder_exempt_category guardian_exempt_category client_type pms default_dp cdsl_dpid cdslcltid cmbp_id nsdldpid nsdlcltid account_type_1 account_no_1 micr_no_1 ifsc_code_1 default_bank_flag_1 account_type_2 account_no_2 micr_no_2 ifsc_code_2 default_bank_flag_2 account_type_3 account_no_3 micr_no_3 ifsc_code_3 default_bank_flag_3 account_type_4 account_no_4 micr_no_4 ifsc_code_4 default_bank_flag_4 account_type_5 account_no_5 micr_no_5 ifsc_code_5 default_bank_flag_5 cheque_name div_pay_mode address_1 address_2 address_3 city state pincode country resi_phone resi_fax office_phone office_fax email communication_mode foreign_address_1 foreign_address_2 foreign_address_3 foreign_address_city foreign_address_pincode foreign_address_state foreign_address_country foreign_address_resi_phone foreign_address_fax foreign_address_off_phone foreign_address_off_fax indian_mobile_no primary_holder_kyc_type primary_holder_ckyc_number second_holder_kyc_type second_holder_ckyc_number third_holder_kyc_type third_holder_ckyc_number guardian_kyc_type guardian_ckyc_number primary_holder_kra_exempt_ref_no second_holder_kra_exempt_ref_no third_holder_kra_exempt_ref_no guardian_exempt_ref_no aadhaar_updated mapin_id paperless_flag lei_no lei_validity mobile_declaration_flag email_declaration_flag second_holder_email second_holder_email_declaration second_holder_mobile second_holder_mobile_declaration third_holder_email third_holder_email_declaration third_holder_mobile third_holder_mobile_declaration guardian_relation nomination_opt nomination_authentication nominee_1_name nominee_1_relationship nominee_1_applicable nominee_1_minor_flag nominee_1_dob nominee_1_guardian nominee_1_guardian_pan nominee_1_identity_type nominee_1_identity_number nominee_1_email nominee_1_mobile nominee_1_address1 nominee_1_address2 nominee_1_address3 nominee_1_city nominee_1_pin nominee_1_country nominee_2_name nominee_2_relationship nominee_2_applicable nominee_2_dob nominee_2_minor_flag nominee_2_guardian nominee_2_guardian_pan nominee_2_identity_type nominee_2_identity_number nominee_2_email nominee_2_mobile nominee_2_address1 nominee_2_address2 nominee_2_address3 nominee_2_city nominee_2_pin nominee_2_country nominee_3_name nominee_3_relationship nominee_3_applicable nominee_3_dob nominee_3_minor_flag nominee_3_guardian nominee_3_guardian_pan nominee_3_identity_type nominee_3_identity_number nominee_3_email nominee_3_mobile nominee_3_address1 nominee_3_address2 nominee_3_address3 nominee_3_city nominee_3_pin nominee_3_country nominee_soa'.split(' ');

/** CLIENTCOMMON for a HUF: every column present (unused ones blank), values as on the live HUFs. */
export function hufUcc(d: HufDetails): Record<string, string> {
  const row: Record<string, string> = Object.fromEntries(UccColumns.map((c) => [c, '']));
  return Object.assign(row, {
    client_code: d.clientCode,
    primary_holder_first_name: d.hufName, // the full HUF name, middle and last blank
    tax_status: '03', // HUF
    gender: '', // not a person
    primary_holder_dob_incorporation: dmy(d.formedOn), // NSE's DOB field holds the formation date
    occupation_code: '01', // Business
    holding_nature: 'SI', // the karta acts alone; no joint holders
    primary_holder_pan_exempt: 'N',
    primary_holder_pan: d.pan,
    client_type: 'P', // non-demat
    pms: 'N',
    account_type_1: d.accountType, account_no_1: d.accountNo, ifsc_code_1: d.ifsc, default_bank_flag_1: 'Y',
    div_pay_mode: '02',
    address_1: d.address1, address_2: d.address2, address_3: d.address3, city: d.city, state: d.state, pincode: d.pincode, country: 'INDIA',
    email: d.email.toUpperCase(), communication_mode: 'E', indian_mobile_no: d.mobile,
    primary_holder_kyc_type: 'K', // KRA KYC on the HUF PAN
    aadhaar_updated: 'Y', paperless_flag: 'Z',
    mobile_declaration_flag: 'SE', email_declaration_flag: 'SE',
    nomination_opt: 'N', // a HUF cannot nominate
    nomination_authentication: 'O',
  });
}

/**
 * FATCA_COMMON for a HUF, with the karta as beneficial owner. The live HUFs went with ubo_appl N and ubo_df blank,
 * which the spec reads as a listed company, so KFin rejected RSPH000001: "MISSING/INVALID UBO_EXCH".
 * NSE accepted this body on UAT (2 Nov 2026); whether KFin accepts it shows on the first prod HUF.
 */
export function hufFatca(d: HufDetails, consent: Consent) {
  const k = d.karta;
  const state = UccStates[d.state]?.fatca ?? d.state;
  return {
    pan_rp: d.pan, pekrn: '', inv_name: d.hufName, dob: dmy(d.formedOn), fr_name: '', sp_name: '',
    tax_status: '03', data_src: 'E', addr_type: '1', po_bir_inc: d.placeOfFormation, co_bir_inc: 'IN',
    tax_res1: 'IN', tpin1: d.pan, id1_type: 'C',
    tax_res2: '', tpin2: '', id2_type: '', tax_res3: '', tpin3: '', id3_type: '', tax_res4: '', tpin4: '', id4_type: '',
    srce_wealt: '02', corp_servs: '04', inc_slab: d.incomeSlab, net_worth: d.netWorthLakhs, nw_date: dmy(d.netWorthDate),
    pep_flag: 'N', occ_code: '01', occ_type: 'B',
    exemp_code: 'N', ffi_drnfe: 'NA', giin_no: '', spr_entity: '', giin_na: '',
    giin_exemc: '', // "0" is rejected by the API although reports show it
    nffe_catg: 'A', act_nfe_sc: '01', // active non-financial entity
    nature_bus: d.natureOfBusiness, rel_listed: '', exch_name: 'O',
    ubo_appl: 'Y', ubo_count: '1', sdf_flag: 'Y', ubo_df: 'Y',
    aadhaar_rp: '', new_change: 'N', log_name: fatcaLogName(consent),
    ubo_exch: '', ubo_isin: '', ubo_rel_li: '', // listed companies only
    npo_form: 'N', npo_dcl: '', npo_rgno: '',
    ubo_details: [{
      ubo_name: k.name, ubo_pan: k.pan, ubo_nation: 'IN',
      // UAT rejects a blank second line ("UBO Address 2 is required"); a one-line address repeats the city.
      ubo_add1: d.address1, ubo_add2: d.address2 || d.city, ubo_add3: d.address3 || d.city,
      ubo_city: d.city, ubo_pin: d.pincode, ubo_state: state, ubo_cntry: 'IN',
      ubo_add_ty: '1', ubo_ctr: 'IN', ubo_tin: k.pan, ubo_id_ty: 'C', ubo_cob: 'IN',
      ubo_dob: dmy(k.dateOfBirth), ubo_gender: k.gender, ubo_fr_nam: k.fatherName,
      ubo_occ: '01', ubo_occ_ty: 'B', ubo_tel: '', ubo_mobile: d.mobile, ubo_code: config.nse.hufUboCode,
      ubo_hol_pc: '', ubo_categ: 'UBO', ubo_pep_fl: 'N', ubo_email: d.email.toUpperCase().slice(0, 30), ubo_smo_de: '',
    }],
  };
}

// --- NSE calls ---------------------------------------------------------------------------------

export type NseResult = { ok: boolean; status: string; remark: string | null };

const regResult = (body: any, key: string): NseResult => {
  const r = Array.isArray(body?.[key]) ? body[key][0] : null;
  if (!r) return { ok: false, status: 'NO_RESPONSE', remark: 'NSE sent an unexpected response.' };
  return { ok: trim(r.reg_status) === 'REG_SUCCESS', status: trim(r.reg_status), remark: trim(r.reg_remark) || null };
};

const rows = (body: any): any[] => (Array.isArray(body?.report_data) ? body.report_data : []);

/** Client codes NSE already has for a PAN ("No record(s) found." is an empty list). */
export async function clientCodesForPan(pan: string): Promise<string[]> {
  const body = await nsePost('reports/client_master_report', { pan });
  return [...new Set(rows(body).map((r) => up(r.client_code)).filter(Boolean))];
}

export const registerUcc = async (d: HufDetails): Promise<NseResult> =>
  regResult(await nsePost('registration/CLIENTCOMMON', { reg_details: [hufUcc(d)] }), 'reg_details');

export const uploadFatca = async (d: HufDetails, consent: Consent): Promise<NseResult> =>
  regResult(await nsePost('registration/FATCA_COMMON', { reg_details: [hufFatca(d, consent)] }), 'reg_details');

export async function authorisationLink(clientCode: string): Promise<{ link: string | null; error: string | null }> {
  const body = await nsePost('reports/GET_LINK', { productType: 'CL_ACT', productRefId: clientCode });
  const link = trim(body?.firstHolderLink) || null;
  return { link, error: link ? null : trim(body?.errorMessage) || 'NSE returned no link yet.' };
}

export async function resendAuthorisation(clientCode: string): Promise<NseResult> {
  const body = await nsePost('registration/RESEND_COMM', { productType: 'CL_ACT', productRefId: clientCode });
  const ok = trim(body?.response_status) === 'S';
  return { ok, status: ok ? 'S' : 'F', remark: trim(body?.error_remark) || null };
}

export type RegistrarStatus = { status: 'NOT_SENT' | 'PENDING' | 'ACCEPTED' | 'REJECTED'; remark: string | null };

/** One registrar's FATCA status from a FATCA_REPORT row. */
export function registrarStatus(upload: unknown, response: unknown, remark: unknown): RegistrarStatus {
  const u = up(upload);
  const r = up(response);
  const status = /REJECT|FAIL|INVALID/.test(r) ? 'REJECTED'
    : /ACCEPT|SUCCESS|PROCESSED/.test(r) ? 'ACCEPTED'
      : !u || u === 'NOT UPLOADED' ? 'NOT_SENT' : 'PENDING';
  return { status, remark: trim(remark) || null };
}

export type NseStatus = {
  bankStatus: string | null;
  bankRemark: string | null;
  fatca: { cams: RegistrarStatus; kfin: RegistrarStatus } | null;
  /** Null when unknown: NSE's CLIENT_AUTHORIZATION report returns no rows for HUFs, even active ones. */
  authorised: boolean | null;
  checkedAt: string;
};

/** "02/11/2026 11:50:12 AM" -> sortable number. */
function fatcaTime(value: unknown): number {
  const m = trim(value).match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2}) ?(AM|PM)?/i);
  if (!m) return 0;
  const hour = m[7] ? (Number(m[4]) % 12) + (/PM/i.test(m[7]) ? 12 : 0) : Number(m[4]);
  return Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), hour, Number(m[5]), Number(m[6]));
}

/** Where a registered HUF stands: NSE's bank check, each registrar's FATCA result, the karta's authorisation. */
export async function readStatus(clientCode: string, pan: string): Promise<NseStatus> {
  const today = new Date(Date.now() + 5.5 * 3_600_000);
  const ddmmyyyy = (d: Date) => d.toISOString().slice(0, 10).split('-').reverse().join('-');
  const [master, auth, fatca] = await Promise.all([
    nsePost('reports/client_master_report', { client_code: clientCode, PAN: '', from_date: '', to_date: '' }),
    nsePost('reports/CLIENT_AUTHORIZATION', { from_date: ddmmyyyy(new Date(today.getTime() - 7 * 86_400_000)), to_date: ddmmyyyy(today), client_code: clientCode }),
    nsePost('reports/FATCA_REPORT', { pan_pkern_no: pan, from_date: '', to_date: '' }),
  ]);
  const mine = (list: any[]) => list.find((r) => up(r.client_code) === clientCode) ?? null;
  const m = mine(rows(master));
  const a = mine(rows(auth));
  const f = rows(fatca).filter((r) => up(r.pan_rp) === pan).sort((x, y) => fatcaTime(y.createddatetime) - fatcaTime(x.createddatetime))[0];
  const authStatus = a ? trim(a.auth_status) : '';
  return {
    bankStatus: (m ? trim(m.bank_1_status) : a ? trim(a.bank1_status) : '') || null,
    bankRemark: (m ? trim(m.bank_1_status_remarks) : a ? trim(a.bank1_rejection_remarks) : '') || null,
    fatca: f ? {
      cams: registrarStatus(f.camsuploadstatus, f.camsresponsestatus, f.camsremarks),
      kfin: registrarStatus(f.kfinuploadstatus, f.kfinresponsestatus, f.kfinremarks),
    } : null,
    authorised: authStatus ? /SUCCESS|AUTHORI[SZ]E/i.test(authStatus) : null,
    checkedAt: new Date().toISOString(),
  };
}
