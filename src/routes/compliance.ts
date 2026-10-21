// Compliance alerts: conditions a scan finds in the app backend's data, and what staff did about them.
// Alerts live here (the admin database); they carry investor ids only, and names are looked up when shown.
import { audit, authenticate, need, refOf, staffNames, staffWith, type StaffNames } from '../auth.ts';
import { config } from '../config.ts';
import { all, nowIso, one, run, tx } from '../db.ts';
import { HttpError, listParam, page, pageParams, uuidParam, type Ctx, type Router } from '../http.ts';
import { snapshot, type Snapshot } from '../investors.ts';
import { flagOf, isOrder, isPlan, ms, money0, supportInvestor, type Facts } from '../map.ts';
import { newId, uuidFor } from '../security.ts';
import { investorDetail, mapLimit } from '../upstream.ts';

export const Kinds = [
  'KYC_STALLED', 'KYC_FAILED', 'SIP_FAILURES', 'MANDATE_REJECTED', 'MANDATE_PENDING', 'PAID_NOT_ALLOTTED', 'ORDER_STUCK', 'NOMINEE_MISSING',
  'REDEMPTION_PAYOUT_PENDING', 'REFUND_PENDING', 'CONSENT_MISSING', 'KYC_NOT_COMPLIANT', 'PEP_INVESTOR', 'LARGE_TRANSACTION', 'RAPID_ROUND_TRIP',
  'COMPLAINT_OVERDUE', 'PAYOUT_BANK_UNVERIFIED', 'CONTACT_MISSING', 'MONITORING_STALE',
] as const;
type Kind = (typeof Kinds)[number];
const Severities = ['HIGH', 'MEDIUM', 'LOW'] as const;
const Statuses = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED'] as const;

export const KindLabels: Record<Kind, string> = {
  KYC_STALLED: 'KYC stalled',
  KYC_FAILED: 'KYC / PAN check failed',
  SIP_FAILURES: 'SIP instalments failing',
  MANDATE_REJECTED: 'Mandate rejected',
  MANDATE_PENDING: 'Mandate not authorised',
  PAID_NOT_ALLOTTED: 'Paid, not allotted',
  ORDER_STUCK: 'Order stuck',
  NOMINEE_MISSING: 'Nominee missing',
  REDEMPTION_PAYOUT_PENDING: 'Redemption payout pending',
  REFUND_PENDING: 'Refund pending',
  CONSENT_MISSING: 'Consent missing',
  KYC_NOT_COMPLIANT: 'KYC not compliant',
  PEP_INVESTOR: 'Politically exposed investor',
  LARGE_TRANSACTION: 'Large transaction',
  RAPID_ROUND_TRIP: 'Quick round trip',
  COMPLAINT_OVERDUE: 'Complaint overdue',
  PAYOUT_BANK_UNVERIFIED: 'Payout bank not verified',
  CONTACT_MISSING: 'Contact details missing',
  MONITORING_STALE: 'Monitoring data stale',
};

type Detection = {
  kind: Kind;
  severity: (typeof Severities)[number];
  dedupeKey: string;
  userExtId: string | null;
  entity: { type: 'order' | 'plan' | 'mandate' | 'account' | 'ticket'; id: string } | null;
  title: string;
  detail: string;
};

const HourMs = 3_600_000;
const DayMs = 24 * HourMs;
const LargeAmount = Number(process.env['LARGE_TRANSACTION_AMOUNT'] ?? 500_000);
/** Checks that need each investor's full record run at most this often on the timer (always on "Run checks now"). */
const DeepEveryMs = 6 * HourMs;
const DeepKinds = new Set<Kind>(['KYC_FAILED', 'NOMINEE_MISSING', 'PAYOUT_BANK_UNVERIFIED', 'COMPLAINT_OVERDUE']);
const SystemActor = 'system:compliance-scan';

const scheme = (o: { fund?: { name: string } | null; isin: string }) => o.fund?.name ?? o.isin;

function lightDetections(snap: Snapshot): Detection[] {
  const found: Detection[] = [];
  const now = Date.now();
  const account = (f: Facts) => ({ type: 'account' as const, id: f.id });

  for (const f of snap.facts) {
    const userExtId = String(f.up.id);
    if (f.kycStalled) {
      found.push({ kind: 'KYC_STALLED', severity: 'MEDIUM', dedupeKey: `kyc_stalled:${userExtId}`, userExtId, entity: account(f),
        title: `KYC not finished after ${Math.floor((now - ms(f.up.signed_up_at)) / DayMs)} days`,
        detail: `Signed up ${new Date(ms(f.up.signed_up_at)).toISOString().slice(0, 10)} and has not finished KYC (step: ${f.up.stage}).` });
    }
    if (f.up.onboarded_at && (!f.up.email || !f.up.mobile)) {
      found.push({ kind: 'CONTACT_MISSING', severity: 'LOW', dedupeKey: `contact_missing:${userExtId}`, userExtId, entity: account(f),
        title: 'Email or mobile missing', detail: 'An onboarded investor has no email or no mobile number on record, so statements and OTPs cannot reach them.' });
    }
  }

  for (const o of snap.orders.filter(isOrder)) {
    const userExtId = String(o.user_id);
    const entity = { type: 'order' as const, id: uuidFor('order', o.id) };
    const ref = o.ref ?? o.id;
    const paid = o.kind === 'purchase' && o.payment?.status === 'SUCCESS';
    if (paid && o.state === 'failed') {
      found.push({ kind: 'REFUND_PENDING', severity: 'HIGH', dedupeKey: `refund:${o.id}`, userExtId, entity,
        title: `Paid ₹${money0(o.amount)}, order failed`,
        detail: `${ref} in ${scheme(o)} was paid but failed (${o.failure_code ?? 'no reason given'}). Make sure the investor gets the refund.` });
    }
    if (paid && ['pending', 'under_review', 'confirmed', 'submitted'].includes(o.state) && now - ms(o.updated_at) > 48 * HourMs) {
      found.push({ kind: 'PAID_NOT_ALLOTTED', severity: 'HIGH', dedupeKey: `paid_not_allotted:${o.id}`, userExtId, entity,
        title: `Paid ₹${money0(o.amount)}, no units after 2 days`,
        detail: `${ref} in ${scheme(o)} was paid and is still "${o.status ?? o.state}". Chase it with FP.` });
    }
    const flag = flagOf(o);
    if (!paid && (flag === 'STUCK_AT_RTA' || flag === 'NOT_SUBMITTED')) {
      found.push({ kind: 'ORDER_STUCK', severity: 'MEDIUM', dedupeKey: `order_stuck:${o.id}`, userExtId, entity,
        title: `${o.kind.charAt(0).toUpperCase()}${o.kind.slice(1)} ${ref} stuck`, detail: `${ref} in ${scheme(o)} has been "${o.status ?? o.state}" since ${o.updated_at}.` });
    }
    if (Number(o.amount ?? 0) >= LargeAmount && o.state !== 'failed' && o.state !== 'cancelled') {
      found.push({ kind: 'LARGE_TRANSACTION', severity: 'MEDIUM', dedupeKey: `large:${o.id}`, userExtId, entity,
        title: `${o.kind} of ₹${money0(o.amount)}`, detail: `${ref} in ${scheme(o)} is at or above ₹${money0(LargeAmount)}. Review it under the AML policy.` });
    }
    if (o.kind === 'redemption' && o.state !== 'failed') {
      const bought = snap.orders.find((p) => p.kind === 'purchase' && p.user_id === o.user_id && p.isin === o.isin && p.state === 'successful' &&
        ms(o.created_at) - ms(p.succeeded_at ?? p.updated_at) < 7 * DayMs && ms(o.created_at) >= ms(p.created_at));
      if (bought) {
        found.push({ kind: 'RAPID_ROUND_TRIP', severity: 'MEDIUM', dedupeKey: `round_trip:${o.id}`, userExtId, entity,
          title: 'Redeemed within a week of buying', detail: `${ref} redeems ${scheme(o)} bought in ${bought.ref ?? bought.id} less than 7 days earlier.` });
      }
    }
  }

  for (const p of snap.orders.filter(isPlan)) {
    const failed = (p.installments ?? []).filter((i) => i['state'] === 'failed').length;
    if (p.kind === 'sip' && (failed >= 2 || p['first_payment_failed'])) {
      found.push({ kind: 'SIP_FAILURES', severity: 'HIGH', dedupeKey: `sip_failures:${p.id}`, userExtId: String(p.user_id),
        entity: { type: 'plan', id: uuidFor('plan', p.id) }, title: `SIP of ₹${money0(p.amount)}: ${failed || 1} failed instalment${failed === 1 ? '' : 's'}`,
        detail: `The SIP in ${scheme(p)} keeps failing. Check the investor's mandate and bank balance.` });
    }
  }

  return found;
}

/** Checks that need each investor's full record, or the admin database. */
async function deepDetections(snap: Snapshot): Promise<Detection[]> {
  const found: Detection[] = [];
  for (const t of await all<{ id: string; seq: number; user_ext_id: string; subject: string; sla_due_at: string }>(
    "SELECT id, seq, user_ext_id, subject, sla_due_at FROM tickets WHERE status IN ('OPEN', 'IN_PROGRESS') AND sla_due_at < ?", nowIso(),
  )) {
    found.push({ kind: 'COMPLAINT_OVERDUE', severity: 'MEDIUM', dedupeKey: `ticket_overdue:${t.id}`, userExtId: t.user_ext_id,
      entity: { type: 'ticket', id: t.id }, title: `Ticket TKT-${String(t.seq).padStart(5, '0')} past its SLA`, detail: `"${t.subject}" was due ${t.sla_due_at}.` });
  }
  const targets = snap.facts.filter((f) => f.up.onboarded_at || (!f.up.kyc_compliant && ['pan', 'pan-confirm'].includes(f.up.stage)));
  await mapLimit(targets, 3, async (f) => {
    const userExtId = String(f.up.id);
    const resp = await investorDetail(f.up.id, SystemActor).catch(() => null);
    if (!resp) return;
    const d = resp.investor;
    const readiness = d.checks?.['pan_readiness'];
    if (!d.kyc_compliant && typeof readiness === 'string' && readiness !== 'verified') {
      found.push({ kind: 'KYC_FAILED', severity: 'HIGH', dedupeKey: `kyc_failed:${userExtId}`, userExtId, entity: { type: 'account', id: f.id },
        title: 'PAN check not passed', detail: `The KRA check for this PAN came back "${readiness}". The investor cannot onboard until it is fixed.` });
    }
    if (d.onboarded_at && !d.nominee && !d.nominee_opted_out) {
      found.push({ kind: 'NOMINEE_MISSING', severity: 'LOW', dedupeKey: `nominee_missing:${userExtId}`, userExtId, entity: { type: 'account', id: f.id },
        title: 'No nominee and no opt-out', detail: 'SEBI requires a nomination or an explicit opt-out for every folio.' });
    }
    if (d.onboarded_at && d.bank && !d.bank.verified) {
      found.push({ kind: 'PAYOUT_BANK_UNVERIFIED', severity: 'MEDIUM', dedupeKey: `bank_unverified:${userExtId}`, userExtId, entity: { type: 'account', id: f.id },
        title: 'Payout bank account not verified', detail: `Redemptions pay out to ${d.bank.bank_name ?? 'a bank'} ${d.bank.account_masked}, which is not verified.` });
    }
  });
  return found;
}

let scanning: Promise<unknown> | null = null;
// What the last scan that wrote to the database found. A timer scan that finds exactly the same doesn't touch the
// database at all, so Neon's compute can sleep; the 6-hourly deep scan always writes.
let lastFingerprint: string | null = null;
let lastDeepAt: number | null = null;
let lastScanAt: string | null = null;

export async function scan(deepRequested: boolean) {
  if (scanning) return { mode: 'skipped' as const, detected: 0, raised: 0, reopened: 0, autoResolved: 0, at: nowIso() };
  const job = (async () => {
    if (lastDeepAt === null) {
      const row = await one<{ last_run_at: string }>("SELECT last_run_at FROM jobs WHERE name = 'compliance-deep'");
      lastDeepAt = row ? Date.parse(row.last_run_at) : 0;
    }
    const deep = deepRequested || Date.now() - lastDeepAt > DeepEveryMs;
    const snap = await snapshot(SystemActor, { fresh: true });
    const detections = [...lightDetections(snap), ...(deep ? await deepDetections(snap) : [])];
    const at = nowIso();
    const unique = [...new Map(detections.map((d) => [d.dedupeKey, d])).values()];
    const fingerprint = JSON.stringify(unique.map((d) => [d.dedupeKey, d.severity, d.title, d.detail]).sort());
    if (!deep && fingerprint === lastFingerprint) {
      lastScanAt = at;
      return { mode: 'ran' as const, detected: unique.length, raised: 0, reopened: 0, autoResolved: 0, at };
    }
    let raised = 0;
    let reopened = 0;
    let autoResolved = 0;
    await tx(async (q) => {
      const seen = new Set(unique.map((d) => d.dedupeKey));
      for (const d of unique) {
        const existing = await q.one<{ id: string; status: string }>('SELECT id, status FROM alerts WHERE dedupe_key = ?', d.dedupeKey);
        if (!existing) {
          const id = newId();
          await q.run(`INSERT INTO alerts (id, kind, severity, status, dedupe_key, user_ext_id, entity_type, entity_id, title, detail, first_detected_at, last_detected_at)
               VALUES (?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?, ?)`,
            id, d.kind, d.severity, d.dedupeKey, d.userExtId, d.entity?.type ?? null, d.entity?.id ?? null, d.title, d.detail, at, at);
          await q.run("INSERT INTO alert_events (id, alert_id, type, note, created_at) VALUES (?, ?, 'RAISED', NULL, ?)", newId(), id, at);
          raised++;
          continue;
        }
        await q.run('UPDATE alerts SET last_detected_at = ?, title = ?, detail = ?, severity = ? WHERE id = ?', at, d.title, d.detail, d.severity, existing.id);
        if (existing.status === 'RESOLVED') {
          await q.run("UPDATE alerts SET status = 'OPEN', resolved_at = NULL, resolved_by = NULL, resolution = NULL, auto_resolved = 0 WHERE id = ?", existing.id);
          await q.run("INSERT INTO alert_events (id, alert_id, type, note, created_at) VALUES (?, ?, 'REOPENED', 'Detected again by the checks', ?)", newId(), existing.id, at);
          reopened++;
        }
      }
      const open = await q.all<{ id: string; kind: Kind; dedupe_key: string }>("SELECT id, kind, dedupe_key FROM alerts WHERE status IN ('OPEN', 'ACKNOWLEDGED')");
      for (const alert of open) {
        if (seen.has(alert.dedupe_key) || (!deep && DeepKinds.has(alert.kind))) continue;
        await q.run("UPDATE alerts SET status = 'RESOLVED', resolved_at = ?, auto_resolved = 1, resolution = 'The condition cleared by itself.' WHERE id = ?", at, alert.id);
        await q.run("INSERT INTO alert_events (id, alert_id, type, note, created_at) VALUES (?, ?, 'AUTO_RESOLVED', 'The condition cleared by itself.', ?)", newId(), alert.id, at);
        autoResolved++;
      }
      await q.run("INSERT INTO jobs (name, last_run_at, last_result) VALUES ('compliance', ?, ?) ON CONFLICT (name) DO UPDATE SET last_run_at = excluded.last_run_at, last_result = excluded.last_result",
        at, JSON.stringify({ detected: seen.size, raised, reopened, autoResolved, deep }));
      if (deep) await q.run("INSERT INTO jobs (name, last_run_at) VALUES ('compliance-deep', ?) ON CONFLICT (name) DO UPDATE SET last_run_at = excluded.last_run_at", at);
    });
    // A light scan can't see deep findings, so the fingerprint it compares against is always a light one.
    lastFingerprint = deep ? JSON.stringify(unique.filter((d) => !DeepKinds.has(d.kind)).map((d) => [d.dedupeKey, d.severity, d.title, d.detail]).sort()) : fingerprint;
    if (deep) lastDeepAt = Date.now();
    lastScanAt = at;
    return { mode: 'ran' as const, detected: unique.length, raised, reopened, autoResolved, at };
  })();
  scanning = job;
  try {
    return await job;
  } finally {
    scanning = null;
  }
}

export function startComplianceLoop(): void {
  const tick = () => scan(false).catch((error) => console.error('[compliance] scan failed:', (error as Error).message));
  setTimeout(tick, 30_000).unref();
  setInterval(tick, config.complianceIntervalMs).unref();
}

// --- views -------------------------------------------------------------------------------------

type AlertRow = {
  id: string; kind: Kind; severity: string; status: string; user_ext_id: string | null; entity_type: string | null; entity_id: string | null;
  title: string; detail: string; assignee_id: string | null; first_detected_at: string; last_detected_at: string; resolved_at: string | null;
  resolved_by: string | null; resolution: string | null; auto_resolved: number; last_reminded_at: string | null;
};

function item(a: AlertRow, snap: Snapshot, names: StaffNames) {
  return {
    id: a.id,
    kind: a.kind,
    severity: a.severity,
    status: a.status,
    title: a.title,
    detail: a.detail,
    investor: a.user_ext_id ? supportInvestor(snap.byExtId.get(a.user_ext_id), a.user_ext_id) : null,
    entity: a.entity_type && a.entity_id ? { type: a.entity_type, id: a.entity_id } : null,
    assignee: refOf(names, a.assignee_id),
    firstDetectedAt: a.first_detected_at,
    lastDetectedAt: a.last_detected_at,
    ageDays: Math.floor((Date.now() - Date.parse(a.first_detected_at)) / DayMs),
    resolvedAt: a.resolved_at,
    autoResolved: a.auto_resolved === 1,
  };
}

async function summary(rows: AlertRow[]) {
  const open = rows.filter((a) => a.status === 'OPEN' || a.status === 'ACKNOWLEDGED');
  const closed = rows.filter((a) => a.status === 'RESOLVED' && a.resolved_at && Date.now() - Date.parse(a.resolved_at) < 30 * DayMs);
  const hours = closed.map((a) => (Date.parse(a.resolved_at!) - Date.parse(a.first_detected_at)) / HourMs).sort((x, y) => x - y);
  const median = hours.length ? (hours.length % 2 ? hours[(hours.length - 1) / 2]! : (hours[hours.length / 2 - 1]! + hours[hours.length / 2]!) / 2) : null;
  const byKind = Kinds.map((key) => ({ key, label: KindLabels[key], count: open.filter((a) => a.kind === key).length })).filter((k) => k.count > 0);
  const stored = (await one<{ last_run_at: string }>("SELECT last_run_at FROM jobs WHERE name = 'compliance'"))?.last_run_at ?? null;
  return {
    open: open.length,
    high: open.filter((a) => a.severity === 'HIGH').length,
    ageingOver7Days: open.filter((a) => Date.now() - Date.parse(a.first_detected_at) > 7 * DayMs).length,
    unassigned: open.filter((a) => !a.assignee_id).length,
    byKind,
    resolvedLast30Days: closed.length,
    medianHoursToClose: median === null ? null : Math.round(median * 10) / 10,
    // A scan that found nothing new doesn't write, so this process may know of a later one.
    lastScanAt: [stored, lastScanAt].filter((t): t is string => !!t).sort().at(-1) ?? null,
  };
}

async function detail(id: string, snap: Snapshot) {
  const a = await one<AlertRow>('SELECT * FROM alerts WHERE id = ?', id);
  if (!a) throw HttpError.notFound('That alert could not be found.');
  const names = await staffNames();
  const events = (await all<{ id: string; type: string; staff_id: string | null; note: string | null; created_at: string }>(
    'SELECT * FROM alert_events WHERE alert_id = ? ORDER BY created_at DESC', id,
  )).map((e) => ({ id: e.id, type: e.type, staffName: refOf(names, e.staff_id)?.name ?? null, note: e.note, createdAt: e.created_at }));
  return { ...item(a, snap, names), resolution: a.resolution, resolvedBy: refOf(names, a.resolved_by), lastRemindedAt: a.last_reminded_at, canRemind: false, events };
}

export function complianceRoutes(router: Router): void {
  const full = authenticate('full');
  const manage = need('compliance.manage');

  router.get('/compliance/alerts', full, manage, async (ctx) => {
    const q = ctx.query;
    const statuses = listParam(q, 'status', Statuses);
    const kinds = listParam(q, 'kind', Kinds);
    const severities = listParam(q, 'severity', Severities);
    const assignee = q.get('assignee');
    const search = q.get('search')?.trim().toLowerCase();
    const [snap, names, all_] = await Promise.all([snapshot(ctx), staffNames(), all<AlertRow>('SELECT * FROM alerts ORDER BY last_detected_at DESC')]);
    const rank = (s: string) => Severities.indexOf(s as never);
    const rows = all_
      .filter((a) => (!statuses.length || statuses.includes(a.status as never)) && (!kinds.length || kinds.includes(a.kind)) &&
        (!severities.length || severities.includes(a.severity as never)))
      .filter((a) => !assignee || (assignee === 'unassigned' ? !a.assignee_id : a.assignee_id === (assignee === 'me' ? ctx.staff!.id : assignee)))
      .map((a) => item(a, snap, names))
      .filter((a) => !search || [a.title, a.detail, a.investor?.name, a.investor?.email, a.investor?.phone].filter(Boolean).join(' ').toLowerCase().includes(search))
      .sort((x, y) => rank(x.severity) - rank(y.severity) || y.lastDetectedAt.localeCompare(x.lastDetectedAt));
    const { offset, limit } = pageParams(q);
    return { ...page(rows, offset, limit), summary: await summary(all_) };
  });

  router.post('/compliance/scan', full, manage, async (ctx) => {
    const result = await scan(true);
    await audit(ctx, 'compliance.scan', null, result);
    return result;
  });

  router.get('/compliance/assignees', full, manage, () => staffWith('compliance.manage'));

  router.get('/compliance/alerts/:alertId', full, manage, async (ctx) => detail(uuidParam(ctx, 'alertId'), await snapshot(ctx)));

  router.post('/compliance/alerts/:alertId/actions', full, manage, async (ctx: Ctx) => {
    const id = uuidParam(ctx, 'alertId');
    const a = await one<AlertRow>('SELECT * FROM alerts WHERE id = ?', id);
    if (!a) throw HttpError.notFound('That alert could not be found.');
    const type = String(ctx.body?.type ?? '');
    const note = typeof ctx.body?.note === 'string' ? ctx.body.note.trim().slice(0, 2000) : '';
    const closed = a.status === 'RESOLVED' || a.status === 'DISMISSED';
    const at = nowIso();
    const assignees = type === 'assign' ? await staffWith('compliance.manage') : [];

    await tx(async (q) => {
      const event = (eventType: string, text: string | null) =>
        q.run('INSERT INTO alert_events (id, alert_id, type, staff_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?)', newId(), id, eventType, ctx.staff!.id, text, at);
      switch (type) {
        case 'acknowledge':
          if (a.status !== 'OPEN') throw HttpError.conflict('Only an open alert can be acknowledged.');
          await q.run("UPDATE alerts SET status = 'ACKNOWLEDGED', assignee_id = COALESCE(assignee_id, ?) WHERE id = ?", ctx.staff!.id, id);
          await event('ACKNOWLEDGED', null);
          break;
        case 'assign': {
          const assigneeId = ctx.body?.assigneeId ? String(ctx.body.assigneeId) : null;
          const person = assignees.find((s) => s.id === assigneeId);
          if (assigneeId && !person) throw HttpError.badRequest('That person cannot work compliance alerts.');
          await q.run('UPDATE alerts SET assignee_id = ? WHERE id = ?', assigneeId, id);
          await event('ASSIGNED', person ? `Assigned to ${person.name}` : 'Unassigned');
          break;
        }
        case 'resolve':
        case 'dismiss':
          if (!note) throw HttpError.badRequest('Say how this was handled; it is the compliance record.');
          if (closed) throw HttpError.conflict('This alert is already closed.');
          await q.run('UPDATE alerts SET status = ?, resolved_at = ?, resolved_by = ?, resolution = ?, auto_resolved = 0 WHERE id = ?',
            type === 'resolve' ? 'RESOLVED' : 'DISMISSED', at, ctx.staff!.id, note, id);
          await event(type === 'resolve' ? 'RESOLVED' : 'DISMISSED', note);
          break;
        case 'reopen':
          if (!closed) throw HttpError.conflict('This alert is not closed.');
          await q.run("UPDATE alerts SET status = 'OPEN', resolved_at = NULL, resolved_by = NULL, resolution = NULL, auto_resolved = 0 WHERE id = ?", id);
          await event('REOPENED', note || null);
          break;
        case 'note':
          if (!note) throw HttpError.badRequest('Write the note first.');
          await event('NOTE', note);
          break;
        case 'remind':
          throw HttpError.unavailable('Reminders reach investors through the app backend, which does not offer them to the admin yet.');
        default:
          throw HttpError.badRequest('Unknown action.');
      }
    });
    await audit(ctx, `compliance.${type}`, id);
    return detail(id, await snapshot(ctx));
  });
}
