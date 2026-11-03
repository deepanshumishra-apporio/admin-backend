// HUF onboarding on NSE Invest. Staff prepare a HUF; the karta confirms the details and gives consent on a public
// page (their own IP and time go to NSE as evidence); a second staff member approves; this server then registers it:
// duplicate check -> UCC -> FATCA with the karta as beneficial owner. NSE's bank check and the karta's own
// authorisation (CL_ACT link + OTP) follow, read back with "Refresh". See src/nse/huf.ts.
//
// DRAFT -> AWAITING_CONSENT -> CONSENTED -> (approve) -> AWAITING_KARTA -> ACTIVE
//                                              \-> NSE_FAILED (fix, or approve again: finished steps are skipped)
// Editing before the UCC is in clears the consent: the karta agreed to the details as they were.
import { createHash, createHmac, randomBytes } from 'node:crypto';

import { audit, authenticate, need, refOf, staffNames, type StaffNames } from '../auth.ts';
import { config, nseIsLive } from '../config.ts';
import { all, nowIso, one, run } from '../db.ts';
import { HttpError, listParam, page, pageParams, uuidParam, type Ctx, type Router } from '../http.ts';
import { NseError, nseConfigured } from '../nse/client.ts';
import {
  authorisationLink, clientCodesForPan, detailsFromNse, DocumentKinds, DocumentTypes, fatcaRowsFor, hufClientsOnNse, IncomeSlabs, nseCreatedAt,
  readHuf, readStatus, registerUcc, resendAuthorisation, UccStates, uploadDocument, uploadFatca,
  type Consent, type DocumentKind, type HufDetails, type NseResult, type NseStatus,
} from '../nse/huf.ts';
import { newId, seal, unseal } from '../security.ts';

export const Statuses = ['DRAFT', 'AWAITING_CONSENT', 'CONSENTED', 'SUBMITTING', 'NSE_FAILED', 'AWAITING_KARTA', 'ACTIVE', 'CANCELLED'] as const;
type Status = (typeof Statuses)[number];
const ConsentDays = 7;
const DayMs = 86_400_000;

type Step = (NseResult & { at: string }) | null;
type Steps = { duplicateCheck: { at: string; codes: string[] } | null; ucc: Step; fatca: Step };

type Row = {
  id: string; client_code: string; huf_name: string; pan_masked: string; pan_hash: string; karta_name: string; details: string; status: Status;
  consent_token_hash: string | null; consent_expires_at: string | null; consent_ip: string | null; consent_at: string | null;
  consent_user_agent: string | null; steps: string; nse_status: string | null; auth_link: string | null; auth_link_error: string | null;
  last_error: string | null; created_by: string | null; approved_by: string | null; approved_at: string | null; created_at: string; updated_at: string;
  documents: string | null;
  /** ADMIN: prepared here. NSE: registered on NSE directly (e.g. on its portal) and found by the sync. */
  source: 'ADMIN' | 'NSE';
};

/** The last copy of each signed document sent to NSE. The file itself is not kept: only what identifies it. */
type DocumentRecord = NseResult & { fileName: string; contentType: string; bytes: number; sha256: string; uploadedAt: string; uploadedBy: string };
type Documents = Partial<Record<DocumentKind, DocumentRecord>>;
const documentsOf = (r: Row): Documents => (r.documents ? (JSON.parse(r.documents) as Documents) : {});
const MaxDocumentBytes = 3 * 1024 * 1024;
/** What each accepted file type starts with, so a renamed file of another type is refused. */
const Signatures: Record<string, (b: Buffer) => boolean> = {
  pdf: (b) => b.subarray(0, 4).toString('latin1') === '%PDF',
  jpg: (b) => b[0] === 0xff && b[1] === 0xd8,
  png: (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  tif: (b) => ['49492a00', '4d4d002a'].includes(b.subarray(0, 4).toString('hex')),
};

/** Loopback and private-network addresses: never a karta's own address on the internet. */
export const privateIp = (ip: string): boolean =>
  /^(::1$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|f[cd][0-9a-f]{2}:|fe80:)/i.test(ip.replace(/^::ffff:/i, ''));

const mask = (value: string, keep = 4) => (value.length > keep ? `${'•'.repeat(value.length - keep)}${value.slice(-keep)}` : value);
/** Finds a PAN again without storing it in the clear. */
const panHash = (pan: string) => createHmac('sha256', config.dataKey).update(`huf-pan:${pan}`).digest('hex');
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const stepsOf = (r: Row): Steps => JSON.parse(r.steps) as Steps;
const onNse = (r: Row) => Boolean(stepsOf(r).ucc?.ok);

function consentOf(r: Row) {
  if (r.consent_at) return { state: 'GIVEN' as const, at: r.consent_at, ip: r.consent_ip, expiresAt: null };
  if (r.consent_token_hash && r.consent_expires_at) {
    return { state: Date.parse(r.consent_expires_at) > Date.now() ? 'PENDING' as const : 'EXPIRED' as const, at: null, ip: null, expiresAt: r.consent_expires_at };
  }
  return { state: 'NONE' as const, at: null, ip: null, expiresAt: null };
}

function listItem(r: Row, names: StaffNames) {
  const nse = r.nse_status ? (JSON.parse(r.nse_status) as NseStatus) : null;
  return {
    id: r.id,
    clientCode: r.client_code,
    hufName: r.huf_name,
    pan: r.pan_masked,
    kartaName: r.karta_name,
    status: r.status,
    source: r.source,
    bankStatus: nse?.bankStatus ?? null,
    fatca: nse?.fatca ? { cams: nse.fatca.cams.status, kfin: nse.fatca.kfin.status } : null,
    createdBy: refOf(names, r.created_by),
    approvedBy: refOf(names, r.approved_by),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Once a HUF is on NSE its details are shown masked: they can't be edited any more. */
function shownDetails(d: HufDetails, full: boolean) {
  if (full) return d;
  return { ...d, pan: mask(d.pan), accountNo: mask(d.accountNo), karta: { ...d.karta, pan: mask(d.karta.pan), dateOfBirth: d.karta.dateOfBirth.slice(0, 4) } };
}

/** What still stands between this HUF and an active NSE account, worded for the person who has to act. */
function problems(r: Row, nse: NseStatus | null): string[] {
  const out: string[] = [];
  if (r.last_error && r.status === 'NSE_FAILED') out.push(r.last_error);
  const bank = nse?.bankStatus?.toUpperCase();
  if (bank && bank !== 'ACTIVE' && bank !== 'PENDING') {
    out.push(`NSE's bank check: ${nse!.bankStatus}${nse!.bankRemark ? ` (${nse!.bankRemark})` : ''}. The account must be in the HUF's name.`);
  }
  for (const [name, s] of Object.entries(nse?.fatca ?? {})) {
    if (s.status === 'REJECTED') out.push(`${name === 'kfin' ? 'KFin' : 'CAMS'} rejected the FATCA declaration${s.remark ? `: ${s.remark}` : ''}.`);
  }
  const docs = documentsOf(r);
  if ((r.status === 'AWAITING_KARTA' || r.status === 'ACTIVE') && !docs.AOF?.ok) {
    out.push("Upload the AOF signed by the karta. For a non-demat order NSE checks an eLog or AOF is on file, and a HUF can't have an eLog.");
  }
  for (const [name, s] of Object.entries(nse?.aof ?? {})) {
    if (typeof s === 'object' && s && 'status' in s && s.status === 'REJECTED') {
      out.push(`${name === 'kfin' ? 'KFin' : 'CAMS'} rejected the AOF${s.remark ? `: ${s.remark}` : ''}. Upload a corrected one.`);
    }
  }
  return out;
}

async function detail(id: string, ctx: Ctx) {
  const r = await one<Row>('SELECT * FROM hufs WHERE id = ?', id);
  if (!r) throw HttpError.notFound('That HUF could not be found.');
  const names = await staffNames();
  const nse = r.nse_status ? (JSON.parse(r.nse_status) as NseStatus) : null;
  const events = (await all<{ id: string; type: string; staff_id: string | null; note: string | null; created_at: string }>(
    'SELECT * FROM huf_events WHERE huf_id = ? ORDER BY created_at DESC', id,
  )).map((e) => ({ id: e.id, type: e.type, staffName: refOf(names, e.staff_id)?.name ?? null, note: e.note, createdAt: e.created_at }));
  const consent = consentOf(r);
  const registered = onNse(r);
  return {
    ...listItem(r, names),
    details: shownDetails(unseal<HufDetails>(r.details), !registered),
    consent,
    steps: stepsOf(r),
    nse,
    authLink: r.auth_link,
    authLinkError: r.auth_link_error,
    documents: documentsOf(r),
    canUploadDocuments: registered && r.status !== 'CANCELLED',
    lastError: r.last_error,
    problems: problems(r, nse),
    approvedAt: r.approved_at,
    canEdit: !registered && r.status !== 'CANCELLED' && r.status !== 'SUBMITTING',
    canCancel: !registered && r.status !== 'CANCELLED' && r.status !== 'SUBMITTING',
    canRequestConsent: !registered && (r.status === 'DRAFT' || r.status === 'AWAITING_CONSENT'),
    approval: approvalBlock(r, ctx),
    events,
  };
}

/** Why this staff member can't approve now, or null when they can. */
function approvalBlock(r: Row, ctx: Ctx): string | null {
  if (r.status !== 'CONSENTED' && r.status !== 'NSE_FAILED') return null;
  if (!r.consent_at) return "The karta hasn't given consent yet.";
  if (config.hufSecondApprover && r.created_by === ctx.staff!.id) return 'A colleague has to approve: you prepared this HUF.';
  if (!nseConfigured()) return 'NSE is not configured on this server.';
  if (nseIsLive() && !config.nse.allowProd) return "This server points at NSE's live account, which is switched off (NSE_ALLOW_PROD).";
  return null;
}

async function event(hufId: string, type: string, staffId: string | null, note: string | null = null): Promise<void> {
  await run('INSERT INTO huf_events (id, huf_id, type, staff_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?)', newId(), hufId, type, staffId, note, nowIso());
}

/** Reads and checks a submitted HUF; a clash with another HUF here is reported on the field. */
async function readValid(ctx: Ctx, exceptId: string | null): Promise<HufDetails> {
  const { details, errors } = readHuf(ctx.body, { accountNoConfirm: ctx.body?.accountNoConfirm });
  if (!errors['clientCode']) {
    const clash = await one<{ id: string }>('SELECT id FROM hufs WHERE client_code = ? AND id <> ?', details.clientCode, exceptId ?? '');
    if (clash) errors['clientCode'] = 'Another HUF here already uses this client code.';
  }
  if (!errors['pan']) {
    const clash = await one<{ id: string; client_code: string }>(
      "SELECT id, client_code FROM hufs WHERE pan_hash = ? AND id <> ? AND status <> 'CANCELLED'", panHash(details.pan), exceptId ?? '',
    );
    if (clash) errors['pan'] = `This HUF PAN is already being onboarded here (${clash.client_code}).`;
  }
  if (Object.keys(errors).length) throw HttpError.badRequest('Some details need fixing.', { fields: errors });
  return details;
}

/** RSPH000001 and RSPH000002 were onboarded on NSE's portal before this; the series continues after them. */
async function nextClientCode(): Promise<string> {
  const codes = await all<{ client_code: string }>("SELECT client_code FROM hufs WHERE client_code LIKE 'RSPH%'");
  const highest = Math.max(2, ...codes.map((c) => Number(c.client_code.slice(4)) || 0));
  return `RSPH${String(highest + 1).padStart(6, '0')}`;
}

/** Runs the NSE steps that haven't succeeded yet. Never throws for an NSE answer: the outcome is saved on the row. */
async function submit(r: Row, ctx: Ctx, allowNewClientCode: boolean): Promise<void> {
  const d = unseal<HufDetails>(r.details);
  const consent: Consent = { ip: r.consent_ip!, at: r.consent_at! };
  const steps = stepsOf(r);
  const save = (status: Status, error: string | null) => run(
    'UPDATE hufs SET steps = ?, status = ?, last_error = ?, updated_at = ? WHERE id = ?', JSON.stringify(steps), status, error, nowIso(), r.id,
  );
  const fail = async (step: string, message: string) => {
    await save('NSE_FAILED', message);
    await event(r.id, 'NSE_FAILED', ctx.staff!.id, `${step}: ${message}`);
  };
  try {
    // One PAN can already have a client code on NSE (the team has duplicates). Reuse it rather than add another.
    if (!steps.ucc?.ok) {
      const codes = await clientCodesForPan(d.pan);
      steps.duplicateCheck = { at: nowIso(), codes };
      if (codes.length && !codes.includes(d.clientCode) && !allowNewClientCode) {
        return await fail('Duplicate check', `NSE already has this HUF PAN as ${codes.join(', ')}. Use that code, or approve again choosing to create a new one.`);
      }
      const ucc = await registerUcc(d);
      // Our own earlier attempt may have gone through without us hearing back.
      const exists = !ucc.ok && /ALREADY|EXIST/i.test(ucc.remark ?? '') && codes.includes(d.clientCode);
      steps.ucc = { ...ucc, ok: ucc.ok || exists, at: nowIso() };
      await event(r.id, steps.ucc.ok ? 'UCC_REGISTERED' : 'UCC_FAILED', ctx.staff!.id, ucc.remark);
      if (!steps.ucc.ok) return await fail('Client registration (UCC)', ucc.remark ?? ucc.status);
    }
    // FATCA straight after the UCC: NSE sends the karta's authorisation email only once FATCA exists for the PAN.
    if (!steps.fatca?.ok) {
      const fatca = await uploadFatca(d, consent);
      steps.fatca = { ...fatca, at: nowIso() };
      await event(r.id, fatca.ok ? 'FATCA_UPLOADED' : 'FATCA_FAILED', ctx.staff!.id, fatca.remark);
      if (!fatca.ok) return await fail('FATCA', fatca.remark ?? fatca.status);
    }
    await save('AWAITING_KARTA', null);
  } catch (error) {
    if (!(error instanceof NseError)) throw error;
    await fail('NSE', error.message);
    return;
  }
  await fetchLink(r.id, d.clientCode);
}

/** The karta's CL_ACT link. NSE has none until the authorisation email has gone out, which can take a minute. */
async function fetchLink(id: string, clientCode: string): Promise<void> {
  try {
    const { link, error } = await authorisationLink(clientCode);
    await run('UPDATE hufs SET auth_link = COALESCE(?, auth_link), auth_link_error = ? WHERE id = ?', link, link ? null : error, id);
  } catch (error) {
    if (!(error instanceof NseError)) throw error;
    await run('UPDATE hufs SET auth_link_error = ? WHERE id = ?', error.message, id);
  }
}

/** Reads a registered HUF's status from NSE and saves it; NSE reporting the karta's authorisation makes it active. */
async function refreshOne(r: Row): Promise<void> {
  const d = unseal<HufDetails>(r.details);
  const status = await readStatus(d.clientCode, d.pan);
  const next: Status = status.authorised ? 'ACTIVE' : r.status;
  await run('UPDATE hufs SET nse_status = ?, status = ?, updated_at = ? WHERE id = ?', JSON.stringify(status), next, nowIso(), r.id);
  if (next === 'ACTIVE' && r.status !== 'ACTIVE') await event(r.id, 'ACTIVE', null, 'NSE reports the karta has authorised the account.');
  if (stepsOf(r).fatca?.ok && !r.auth_link) await fetchLink(r.id, d.clientCode);
}

/** HUF clients have existed on NSE for this member since October 2026; the first sync reads from then. */
const SyncFrom = new Date(`${config.hufSyncFrom}T00:00:00Z`);
const DailyMs = 24 * 3_600_000;
let syncing: Promise<{ found: number; imported: string[] }> | null = null;

/**
 * Finds HUFs registered on NSE without this admin (RSPH000001 and RSPH000002 were made on NSE's portal) and adds
 * them, so every HUF on NSE shows here and is kept in sync. Ones already here are left as they are.
 */
export function syncFromNse(since: Date = SyncFrom): Promise<{ found: number; imported: string[] }> {
  syncing ??= (async () => {
    const clients = await hufClientsOnNse(since, new Date());
    const known = new Set((await all<{ client_code: string }>('SELECT client_code FROM hufs')).map((r) => r.client_code));
    const fresh = clients.filter((c) => !known.has(trim(c.client_code).toUpperCase()));
    const fatca = fresh.length ? await fatcaRowsFor([...new Set(fresh.map((c) => trim(c.primary_holder_pan).toUpperCase()))]) : [];
    const imported: string[] = [];
    for (const c of fresh) {
      const pan = trim(c.primary_holder_pan).toUpperCase();
      const d = detailsFromNse(c, fatca.find((f) => trim(f.pan_rp).toUpperCase() === pan) ?? null);
      const at = nseCreatedAt(c.created_at) ?? nowIso();
      const f = fatca.find((x) => trim(x.pan_rp).toUpperCase() === pan);
      const steps: Steps = {
        duplicateCheck: null,
        ucc: { ok: true, status: 'ON_NSE', remark: 'Registered on NSE directly, not through this admin.', at },
        fatca: f ? { ok: true, status: 'ON_NSE', remark: null, at: nseCreatedAt(f.createddatetime) ?? at } : null,
      };
      const id = newId();
      const added = await run(
        `INSERT INTO hufs (id, client_code, huf_name, pan_masked, pan_hash, karta_name, details, status, steps, created_by, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'AWAITING_KARTA', ?, NULL, 'NSE', ?, ?) ON CONFLICT (client_code) DO NOTHING`,
        id, d.clientCode, d.hufName, mask(d.pan), panHash(d.pan), d.karta.name, seal(d), JSON.stringify(steps), at, nowIso(),
      );
      if (!added) continue;
      imported.push(d.clientCode);
      await event(id, 'IMPORTED', null, `Found on NSE: ${d.clientCode}, created there ${c.created_at ? trim(c.created_at) : ''}`.trim());
      const row = await one<Row>('SELECT * FROM hufs WHERE id = ?', id);
      await refreshOne(row!).catch((error) => console.error(`[hufs] refresh ${d.clientCode} failed:`, (error as Error).message));
    }
    await run("INSERT INTO jobs (name, last_run_at, last_result) VALUES ('huf-sync', ?, ?) ON CONFLICT (name) DO UPDATE SET last_run_at = excluded.last_run_at, last_result = excluded.last_result",
      nowIso(), JSON.stringify({ found: clients.length, imported }));
    return { found: clients.length, imported };
  })().finally(() => (syncing = null));
  return syncing;
}

const trim = (value: unknown): string => String(value ?? '').trim();

/** Whether a HUF still has something on NSE's side to wait for: the bank check, a registrar, or the AOF. */
function stillWaiting(r: Row): boolean {
  if (r.status === 'AWAITING_KARTA') return true;
  if (r.status !== 'ACTIVE') return false;
  const nse = r.nse_status ? (JSON.parse(r.nse_status) as NseStatus) : null;
  const settled = (s: { status: string } | undefined) => s?.status === 'ACCEPTED' || s?.status === 'REJECTED';
  return !nse || nse.bankStatus?.toUpperCase() === 'PENDING' || !settled(nse.fatca?.kfin) || !settled(nse.fatca?.cams) ||
    (Boolean(documentsOf(r).AOF?.ok) && (!settled(nse.aof?.kfin) || !settled(nse.aof?.cams)));
}

/**
 * Every 30 min, re-reads the HUFs still waiting on NSE (bank check, registrars, the karta), so staff don't have to
 * press Refresh. Nothing is read, and the database isn't touched, when no HUF is waiting.
 */
export function startHufStatusLoop(): void {
  const tick = async () => {
    if (!nseConfigured() || (nseIsLive() && !config.nse.allowProd)) return;
    // Once a day, pick up HUFs made on NSE directly in the last two weeks (the first run reads from the start).
    const last = await one<{ last_run_at: string }>("SELECT last_run_at FROM jobs WHERE name = 'huf-sync'");
    if (!last || Date.now() - Date.parse(last.last_run_at) > DailyMs) {
      await syncFromNse(last ? new Date(Date.now() - 14 * DailyMs) : SyncFrom)
        .catch((error) => console.error('[hufs] sync from NSE failed:', (error as Error).message));
    }
    const waiting = (await all<Row>("SELECT * FROM hufs WHERE status IN ('AWAITING_KARTA', 'ACTIVE')")).filter(stillWaiting);
    for (const r of waiting) {
      await refreshOne(r).catch((error) => console.error(`[hufs] refresh ${r.client_code} failed:`, (error as Error).message));
    }
  };
  const run_ = () => void tick().catch((error) => console.error('[hufs] status loop failed:', (error as Error).message));
  setTimeout(run_, 60_000).unref();
  setInterval(run_, config.hufStatusIntervalMs).unref();
}

// --- the karta's consent page (public) ------------------------------------------------------------------------

/** What the karta sees before agreeing: enough to recognise the HUF, never a full PAN or account number. */
async function consentRow(token: string): Promise<Row> {
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) throw HttpError.notFound('This link is not valid.');
  const r = await one<Row>('SELECT * FROM hufs WHERE consent_token_hash = ?', tokenHash(token));
  if (!r || r.status === 'CANCELLED') throw HttpError.notFound('This link is not valid any more. Ask RiSips for a new one.');
  return r;
}

function consentView(r: Row) {
  const d = unseal<HufDetails>(r.details);
  const consent = consentOf(r);
  return {
    state: consent.state,
    agreedAt: consent.at,
    expiresAt: r.consent_expires_at,
    huf: {
      name: d.hufName, pan: mask(d.pan), formedOn: d.formedOn, kartaName: d.karta.name, kartaPan: mask(d.karta.pan),
      email: d.email, mobile: mask(d.mobile, 4), bank: { ifsc: d.ifsc, accountNo: mask(d.accountNo), holder: d.bankHolderName },
      address: [d.address1, d.address2, d.address3, d.city, UccStates[d.state]?.name, d.pincode].filter(Boolean).join(', '),
      coparceners: d.coparceners.map((m) => ({ name: m.name, relationship: m.relationship })),
    },
  };
}

export function hufRoutes(router: Router): void {
  const full = authenticate('full');
  const manage = need('hufs.manage');

  router.get('/hufs/options', full, manage, async () => ({
    nextClientCode: await nextClientCode(),
    states: Object.entries(UccStates).map(([code, s]) => ({ code, name: s.name })).sort((a, b) => a.name.localeCompare(b.name)),
    incomeSlabs: IncomeSlabs.map((code, i) => ({ code, label: ['Below ₹1 lakh', '₹1-5 lakh', '₹5-10 lakh', '₹10-25 lakh', '₹25 lakh-1 crore', 'Above ₹1 crore'][i]! })),
    nse: { environment: nseIsLive() ? 'LIVE' : 'UAT', configured: nseConfigured(), liveAllowed: config.nse.allowProd },
    lastSyncAt: (await one<{ last_run_at: string }>("SELECT last_run_at FROM jobs WHERE name = 'huf-sync'"))?.last_run_at ?? null,
    secondApprover: config.hufSecondApprover,
  }));

  /** Adds HUFs registered on NSE directly. Also runs once a day on its own. */
  router.post('/hufs/sync', full, manage, async (ctx) => {
    if (!nseConfigured() || (nseIsLive() && !config.nse.allowProd)) throw HttpError.unavailable('NSE is not configured on this server.');
    try {
      const result = await syncFromNse();
      await audit(ctx, 'huf.synced', null, result);
      return result;
    } catch (error) {
      if (error instanceof NseError) throw new HttpError(502, 'NSE_UNAVAILABLE', `Couldn't read from NSE: ${error.message}`);
      throw error;
    }
  });

  router.get('/hufs', full, manage, async (ctx) => {
    const statuses = listParam(ctx.query, 'status', Statuses);
    const search = ctx.query.get('search')?.trim().toLowerCase();
    const [rows, names] = await Promise.all([all<Row>('SELECT * FROM hufs ORDER BY updated_at DESC'), staffNames()]);
    const items = rows
      .filter((r) => !statuses.length || statuses.includes(r.status))
      .filter((r) => !search || [r.huf_name, r.client_code, r.karta_name, r.pan_masked].join(' ').toLowerCase().includes(search))
      .map((r) => listItem(r, names));
    const { offset, limit } = pageParams(ctx.query);
    return { ...page(items, offset, limit), counts: Object.fromEntries(Statuses.map((s) => [s, rows.filter((r) => r.status === s).length])) };
  });

  router.post('/hufs', full, manage, async (ctx) => {
    const d = await readValid(ctx, null);
    const id = newId();
    const now = nowIso();
    const empty: Steps = { duplicateCheck: null, ucc: null, fatca: null };
    await run(
      `INSERT INTO hufs (id, client_code, huf_name, pan_masked, pan_hash, karta_name, details, status, steps, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)`,
      id, d.clientCode, d.hufName, mask(d.pan), panHash(d.pan), d.karta.name, seal(d), JSON.stringify(empty), ctx.staff!.id, now, now,
    );
    await event(id, 'CREATED', ctx.staff!.id);
    await audit(ctx, 'huf.created', id, { clientCode: d.clientCode });
    return detail(id, ctx);
  });

  router.get('/hufs/:id', full, manage, (ctx) => detail(uuidParam(ctx, 'id'), ctx));

  router.put('/hufs/:id', full, manage, async (ctx) => {
    const id = uuidParam(ctx, 'id');
    const r = await one<Row>('SELECT * FROM hufs WHERE id = ?', id);
    if (!r) throw HttpError.notFound('That HUF could not be found.');
    if (onNse(r)) throw HttpError.conflict('This HUF is already registered on NSE. Changing it needs a UCC modification, which this screen does not do yet.');
    if (r.status === 'CANCELLED' || r.status === 'SUBMITTING') throw HttpError.conflict('This HUF cannot be changed now.');
    const d = await readValid(ctx, id);
    // The karta agreed to the details as they were; changed details need their consent again.
    const hadConsent = Boolean(r.consent_at || r.consent_token_hash);
    await run(
      `UPDATE hufs SET client_code = ?, huf_name = ?, pan_masked = ?, pan_hash = ?, karta_name = ?, details = ?, status = 'DRAFT',
         consent_token_hash = NULL, consent_expires_at = NULL, consent_ip = NULL, consent_at = NULL, consent_user_agent = NULL,
         last_error = NULL, updated_at = ? WHERE id = ?`,
      d.clientCode, d.hufName, mask(d.pan), panHash(d.pan), d.karta.name, seal(d), nowIso(), id,
    );
    await event(id, 'EDITED', ctx.staff!.id, hadConsent ? "Details changed: the karta's consent was cleared and is needed again." : null);
    await audit(ctx, 'huf.edited', id);
    return detail(id, ctx);
  });

  /** A new consent link for the karta. The token is returned once; only its hash is kept. */
  router.post('/hufs/:id/consent-link', full, manage, async (ctx) => {
    const id = uuidParam(ctx, 'id');
    const r = await one<Row>('SELECT * FROM hufs WHERE id = ?', id);
    if (!r) throw HttpError.notFound('That HUF could not be found.');
    if (r.status !== 'DRAFT' && r.status !== 'AWAITING_CONSENT') throw HttpError.conflict('The karta has already given consent, or the HUF is past that step.');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + ConsentDays * DayMs).toISOString();
    await run("UPDATE hufs SET consent_token_hash = ?, consent_expires_at = ?, status = 'AWAITING_CONSENT', updated_at = ? WHERE id = ?",
      tokenHash(token), expiresAt, nowIso(), id);
    await event(id, 'CONSENT_LINK', ctx.staff!.id, `Valid until ${expiresAt}`);
    await audit(ctx, 'huf.consent_link', id);
    return { token, expiresAt };
  });

  router.post('/hufs/:id/approve', full, manage, async (ctx) => {
    const id = uuidParam(ctx, 'id');
    const r = await one<Row>('SELECT * FROM hufs WHERE id = ?', id);
    if (!r) throw HttpError.notFound('That HUF could not be found.');
    if (r.status !== 'CONSENTED' && r.status !== 'NSE_FAILED') throw HttpError.conflict('Only a HUF the karta has consented to can be sent to NSE.');
    const blocked = approvalBlock(r, ctx);
    if (blocked) throw HttpError.forbidden(blocked);
    // Claim it, so two approvals at once can't both register it.
    const claimed = await run("UPDATE hufs SET status = 'SUBMITTING', approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ? AND status IN ('CONSENTED', 'NSE_FAILED')",
      ctx.staff!.id, nowIso(), nowIso(), id);
    if (!claimed) throw HttpError.conflict('Someone else is sending this HUF to NSE right now.');
    await event(id, 'APPROVED', ctx.staff!.id, nseIsLive() ? 'Sent to NSE (live)' : 'Sent to NSE UAT');
    await audit(ctx, 'huf.approved', id, { environment: nseIsLive() ? 'LIVE' : 'UAT' });
    try {
      await submit(r, ctx, ctx.body?.allowNewClientCode === true);
    } catch (error) {
      await run("UPDATE hufs SET status = 'NSE_FAILED', last_error = ? WHERE id = ? AND status = 'SUBMITTING'", 'Something went wrong while sending to NSE. Check the HUF on NSE before trying again.', id);
      throw error;
    }
    return detail(id, ctx);
  });

  router.post('/hufs/:id/refresh', full, manage, async (ctx) => {
    const id = uuidParam(ctx, 'id');
    const r = await one<Row>('SELECT * FROM hufs WHERE id = ?', id);
    if (!r) throw HttpError.notFound('That HUF could not be found.');
    if (!onNse(r)) throw HttpError.conflict('This HUF is not on NSE yet.');
    try {
      await refreshOne(r);
    } catch (error) {
      if (error instanceof NseError) throw new HttpError(502, 'NSE_UNAVAILABLE', `Couldn't read from NSE: ${error.message}`);
      throw error;
    }
    return detail(id, ctx);
  });

  /**
   * A signed document, sent to NSE as it is: the AOF (needed before the HUF can invest), the FATCA form, or a
   * cancelled cheque of the HUF's account (when NSE's bank check fails). Only its name, size and fingerprint are kept.
   */
  router.post('/hufs/:id/documents', full, manage, async (ctx) => {
    const id = uuidParam(ctx, 'id');
    const r = await one<Row>('SELECT * FROM hufs WHERE id = ?', id);
    if (!r) throw HttpError.notFound('That HUF could not be found.');
    if (!onNse(r) || r.status === 'CANCELLED') throw HttpError.conflict('Documents go to NSE once the HUF is registered there.');
    const kind = ctx.body?.kind as DocumentKind;
    if (!(DocumentKinds as readonly string[]).includes(kind)) throw HttpError.badRequest('Choose which document this is.');
    const contentType = String(ctx.body?.contentType ?? '');
    const ext = DocumentTypes[contentType];
    if (!ext) throw HttpError.badRequest('Upload a PDF, JPG, PNG or TIFF.');
    const data = typeof ctx.body?.data === 'string' ? ctx.body.data : '';
    const file = Buffer.from(data, 'base64');
    if (!file.length) throw HttpError.badRequest('The file is empty.');
    if (file.length > MaxDocumentBytes) throw HttpError.badRequest('The file is over 3 MB. Scan it at a lower resolution, or as a PDF.');
    if (!Signatures[ext]!(file)) throw HttpError.badRequest(`That file is not really a ${ext.toUpperCase()}.`);
    const d = unseal<HufDetails>(r.details);
    // NSE allows 40 characters; the client code and kind make the name findable on NSE's side.
    const fileName = `${d.clientCode}_${kind}_${Date.now()}.${ext}`;
    let result: NseResult;
    try {
      result = await uploadDocument(kind, d, fileName, file.toString('base64'));
    } catch (error) {
      if (error instanceof NseError) throw new HttpError(502, 'NSE_UNAVAILABLE', `Couldn't reach NSE: ${error.message}`);
      throw error;
    }
    const record: DocumentRecord = {
      ...result, fileName, contentType, bytes: file.length, sha256: createHash('sha256').update(file).digest('hex'),
      uploadedAt: nowIso(), uploadedBy: ctx.staff!.id,
    };
    // A failed attempt is recorded too, but never replaces a copy NSE already accepted.
    const docs = documentsOf(r);
    if (result.ok || !docs[kind]?.ok) docs[kind] = record;
    await run('UPDATE hufs SET documents = ?, updated_at = ? WHERE id = ?', JSON.stringify(docs), nowIso(), id);
    await event(id, result.ok ? `${kind}_UPLOADED` : `${kind}_FAILED`, ctx.staff!.id, result.remark);
    await audit(ctx, 'huf.document', id, { kind, ok: result.ok, bytes: file.length, sha256: record.sha256 });
    if (!result.ok) throw HttpError.conflict(`NSE did not accept it: ${result.remark ?? result.status}.`);
    return detail(id, ctx);
  });

  router.post('/hufs/:id/resend-link', full, manage, async (ctx) => {
    const id = uuidParam(ctx, 'id');
    const r = await one<Row>('SELECT * FROM hufs WHERE id = ?', id);
    if (!r) throw HttpError.notFound('That HUF could not be found.');
    if (!stepsOf(r).fatca?.ok) throw HttpError.conflict('NSE sends the karta a link only once the UCC and FATCA are in.');
    let result: NseResult;
    try {
      result = await resendAuthorisation(r.client_code);
    } catch (error) {
      if (error instanceof NseError) throw new HttpError(502, 'NSE_UNAVAILABLE', `Couldn't reach NSE: ${error.message}`);
      throw error;
    }
    if (!result.ok) throw HttpError.conflict(`NSE did not resend it: ${result.remark ?? 'no reason given'}.`);
    await event(id, 'LINK_RESENT', ctx.staff!.id);
    await fetchLink(id, r.client_code);
    return detail(id, ctx);
  });

  router.post('/hufs/:id/mark-active', full, manage, async (ctx) => {
    // NSE's authorisation report is empty for HUFs, so staff confirm it once an order has been accepted.
    const id = uuidParam(ctx, 'id');
    const note = typeof ctx.body?.note === 'string' ? ctx.body.note.trim().slice(0, 500) : '';
    if (!note) throw HttpError.badRequest('Say how you know the karta has authorised it (e.g. an accepted order number).');
    const done = await run("UPDATE hufs SET status = 'ACTIVE', updated_at = ? WHERE id = ? AND status = 'AWAITING_KARTA'", nowIso(), id);
    if (!done) throw HttpError.conflict('Only a HUF waiting on the karta can be marked active.');
    await event(id, 'ACTIVE', ctx.staff!.id, note);
    await audit(ctx, 'huf.marked_active', id, { note });
    return detail(id, ctx);
  });

  router.post('/hufs/:id/cancel', full, manage, async (ctx) => {
    const id = uuidParam(ctx, 'id');
    const r = await one<Row>('SELECT * FROM hufs WHERE id = ?', id);
    if (!r) throw HttpError.notFound('That HUF could not be found.');
    if (onNse(r)) throw HttpError.conflict('This HUF is already registered on NSE and cannot be cancelled here.');
    const done = await run("UPDATE hufs SET status = 'CANCELLED', consent_token_hash = NULL, updated_at = ? WHERE id = ? AND status NOT IN ('CANCELLED', 'SUBMITTING')", nowIso(), id);
    if (!done) throw HttpError.conflict('This HUF cannot be cancelled now.');
    await event(id, 'CANCELLED', ctx.staff!.id);
    await audit(ctx, 'huf.cancelled', id);
    return detail(id, ctx);
  });

  // The karta's page. No staff session: the unguessable token is the key, it expires, and it can't be reused.
  router.get('/public/huf-consent/:token', async (ctx) => consentView(await consentRow(ctx.params['token'] ?? '')));

  router.post('/public/huf-consent/:token', async (ctx) => {
    const r = await consentRow(ctx.params['token'] ?? '');
    const state = consentOf(r).state;
    if (state === 'GIVEN') return consentView(r);
    if (state !== 'PENDING') throw HttpError.conflict('This link has expired. Ask RiSips for a new one.');
    if (ctx.body?.agree !== true) throw HttpError.badRequest('Tick the box to agree.');
    // The IP goes to NSE as the karta's consent evidence. On the server it must be theirs, never Caddy's, the
    // dashboard's or Vercel's: in production only an IP the dashboard vouches for with DASHBOARD_PROXY_KEY counts.
    if (!ctx.ip || (config.production && (!ctx.ipFromDashboard || privateIp(ctx.ip)))) {
      throw HttpError.badRequest('Your connection could not be identified. Try again.');
    }
    const at = nowIso();
    const done = await run(
      "UPDATE hufs SET consent_ip = ?, consent_at = ?, consent_user_agent = ?, status = 'CONSENTED', updated_at = ? WHERE id = ? AND status = 'AWAITING_CONSENT' AND consent_at IS NULL",
      ctx.ip, at, ctx.userAgent, at, r.id,
    );
    if (!done) throw HttpError.conflict('This link is not valid any more. Ask RiSips for a new one.');
    await event(r.id, 'CONSENT_GIVEN', null, `From ${ctx.ip}`);
    return consentView((await one<Row>('SELECT * FROM hufs WHERE id = ?', r.id))!);
  });
}
