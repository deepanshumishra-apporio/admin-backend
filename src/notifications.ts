// The staff inbox: what happened that someone should look at, each with a link to the record. Sources call
// `notify()` with a key that names the event, so the same event is never sent twice (a re-scan, a re-read of NSE).
// A notification goes to everyone holding its permission, or to one person (a ticket assigned to them).
import { audit, authenticate, staffNames } from './auth.ts';
import { all, nowIso, one, run } from './db.ts';
import { HttpError, uuidParam, type Router } from './http.ts';
import { iso } from './map.ts';
import { newId } from './security.ts';
import { lists } from './upstream.ts';

export const NotificationKinds = ['HUF', 'Compliance', 'Support', 'Investor', 'Mandate', 'Portfolio'] as const;
export type NotificationKind = (typeof NotificationKinds)[number];
export type NotificationSeverity = 'HIGH' | 'MEDIUM' | 'LOW';

export type Notice = {
  /** Names the event, e.g. `huf:<id>:consent`. A second notice with the same key is dropped. */
  key: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  detail: string;
  href: string;
  /** Who sees it: holders of this permission. Null with `staffId` set means that person only. */
  permission: string | null;
  staffId?: string | null;
};

/** Records a notice once. Never throws: a notification must not break what raised it. */
export async function notify(n: Notice): Promise<void> {
  try {
    await run(
      `INSERT INTO notifications (id, key, kind, severity, title, detail, href, permission, staff_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (key) DO NOTHING`,
      newId(), n.key.slice(0, 300), n.kind, n.severity, n.title.slice(0, 200), n.detail.slice(0, 1000), n.href, n.permission, n.staffId ?? null, nowIso(),
    );
  } catch (error) {
    console.error('[notifications] could not record', n.key, (error as Error).message);
  }
}

// --- HUFs ---------------------------------------------------------------------------------------------------

type HufRef = { id: string; huf_name: string; client_code: string };

const hufNotices: Record<string, (h: HufRef, note: string | null) => Omit<Notice, 'key' | 'kind' | 'permission' | 'href'> | null> = {
  CONSENT_GIVEN: (h) => ({ severity: 'MEDIUM', title: `Karta gave consent: ${h.huf_name}`, detail: `${h.client_code} is ready for a second person to approve and send to NSE.` }),
  NSE_FAILED: (h, note) => ({ severity: 'HIGH', title: `NSE refused ${h.huf_name}`, detail: note ?? 'The registration failed on NSE. Open the HUF to see why and try again.' }),
  ACTIVE: (h) => ({ severity: 'LOW', title: `${h.huf_name} is active on NSE`, detail: `${h.client_code} can invest now.` }),
  IMPORTED: (h) => ({ severity: 'LOW', title: `HUF synced from NSE: ${h.huf_name}`, detail: `${h.client_code} was registered on NSE directly and is now in the admin.` }),
  PURCHASE_FAILED: (h, note) => ({ severity: 'HIGH', title: `NSE refused an order for ${h.huf_name}`, detail: note ?? 'The purchase was refused.' }),
  SIP_FAILED: (h, note) => ({ severity: 'HIGH', title: `NSE refused a SIP for ${h.huf_name}`, detail: note ?? 'The SIP was refused.' }),
  MANDATE_FAILED: (h, note) => ({ severity: 'HIGH', title: `NSE refused a mandate for ${h.huf_name}`, detail: note ?? 'The mandate was refused.' }),
};

/** A HUF event worth telling the HUF team about. Each event happens once, so its key is the event's own id. */
export async function hufEventNotice(eventId: string, hufId: string, type: string, note: string | null): Promise<void> {
  const make = hufNotices[type];
  if (!make) return;
  const h = await one<HufRef>('SELECT id, huf_name, client_code FROM hufs WHERE id = ?', hufId);
  const n = h && make(h, note);
  if (!n) return;
  await notify({ ...n, key: `huf-event:${eventId}`, kind: 'HUF', permission: 'hufs.manage', href: `/onboarding/hufs/${hufId}` });
}

type FatcaRegistrars = { cams?: { status?: string; remark?: string | null }; kfin?: { status?: string; remark?: string | null } } | null | undefined;

/** A registrar newly rejecting a HUF's FATCA, seen on a status refresh. */
export async function hufFatcaNotice(h: HufRef, before: FatcaRegistrars, after: FatcaRegistrars): Promise<void> {
  for (const [key, name] of [['cams', 'CAMS'], ['kfin', 'KFin']] as const) {
    const now = after?.[key];
    if (now?.status !== 'REJECTED' || before?.[key]?.status === 'REJECTED') continue;
    await notify({
      key: `huf:${h.id}:fatca-rejected:${key}:${now.remark ?? ''}`, kind: 'HUF', severity: 'HIGH', permission: 'hufs.manage', href: `/onboarding/hufs/${h.id}`,
      title: `${name} rejected ${h.huf_name}'s FATCA`, detail: `${h.client_code}: ${now.remark ?? 'no reason given'}. Orders fail until FATCA is accepted.`,
    });
  }
}

type InvestmentsLike = {
  allotments: { orderId: string; schemeName: string; amount: number | null; units: number }[];
  sips: { registrationNo: string; status: string; schemeName: string; amount: number | null }[];
  mandates: { mandateId: string; status: string; amount: number | null; remark: string | null }[];
};

const rupees = (n: number | null) => (n === null ? '' : `₹${n.toLocaleString('en-IN')}`);

/** What changed on NSE between two reads of a HUF's investments: units allotted, SIPs gone live, mandates decided. */
export async function hufInvestmentNotices(h: HufRef, before: InvestmentsLike | null, after: InvestmentsLike): Promise<void> {
  // The first read finds history, not news.
  if (!before) return;
  const base = { kind: 'HUF' as const, permission: 'hufs.manage', href: `/onboarding/hufs/${h.id}?tab=transactions` };
  const allotted = new Set(before.allotments.map((a) => a.orderId));
  for (const a of after.allotments) {
    if (allotted.has(a.orderId)) continue;
    await notify({ ...base, key: `huf:${h.id}:allotted:${a.orderId}`, severity: 'LOW', title: `Units allotted for ${h.huf_name}`, detail: `${a.schemeName}: ${a.units} units for ${rupees(a.amount)} (order ${a.orderId}).` });
  }
  const sipWas = new Map(before.sips.map((s) => [s.registrationNo, s.status]));
  for (const s of after.sips) {
    if (!/ACTIVE|LIVE/.test(s.status) || /ACTIVE|LIVE/.test(sipWas.get(s.registrationNo) ?? '')) continue;
    await notify({ ...base, key: `huf:${h.id}:sip-live:${s.registrationNo}`, severity: 'LOW', title: `SIP live for ${h.huf_name}`, detail: `${s.schemeName}: ${rupees(s.amount)} a month (${s.registrationNo}).` });
  }
  const mandateWas = new Map(before.mandates.map((m) => [m.mandateId, m.status]));
  for (const m of after.mandates) {
    if (mandateWas.get(m.mandateId) === m.status) continue;
    if (m.status === 'APPROVED') {
      await notify({ ...base, key: `huf:${h.id}:mandate:${m.mandateId}:approved`, kind: 'Mandate', severity: 'MEDIUM', title: `Mandate approved for ${h.huf_name}`, detail: `Mandate ${m.mandateId} (up to ${rupees(m.amount)}) is approved by the bank. SIPs can use it now.` });
    } else if (/REJECT|FAIL|CANCEL/.test(m.status)) {
      await notify({ ...base, key: `huf:${h.id}:mandate:${m.mandateId}:${m.status}`, kind: 'Mandate', severity: 'HIGH', title: `Mandate ${m.status.toLowerCase()} for ${h.huf_name}`, detail: `Mandate ${m.mandateId}${m.remark ? `: ${m.remark}` : ''}. Register another for the HUF's SIPs.` });
    }
  }
}

// --- checks that run on a clock --------------------------------------------------------------------------------

const DayMs = 86_400_000;
const SystemActor = 'system:notifications';
const istDate = (at = Date.now()) => new Date(at + 5.5 * 3_600_000).toISOString().slice(0, 10);

/** Tickets due within two hours, for the person they're assigned to. */
async function ticketsDueSoon(): Promise<void> {
  const now = Date.now();
  const due = await all<{ id: string; seq: number; subject: string; assignee_id: string; sla_due_at: string }>(
    "SELECT id, seq, subject, assignee_id, sla_due_at FROM tickets WHERE status NOT IN ('RESOLVED', 'CLOSED') AND assignee_id IS NOT NULL AND sla_due_at > ? AND sla_due_at <= ?",
    new Date(now).toISOString(), new Date(now + 2 * 3_600_000).toISOString(),
  );
  for (const t of due) {
    const minutes = Math.max(1, Math.round((Date.parse(t.sla_due_at) - now) / 60_000));
    await notify({
      key: `ticket:${t.id}:due:${t.sla_due_at}`, kind: 'Support', severity: 'MEDIUM', permission: null, staffId: t.assignee_id, href: `/support/${t.id}`,
      title: `Ticket #${t.seq} is due in ${minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`}`, detail: t.subject,
    });
  }
}

/** HUFs whose karta hasn't acted on NSE's link for three days. */
async function hufsWaiting(): Promise<void> {
  const cut = new Date(Date.now() - 3 * DayMs).toISOString();
  const rows = await all<HufRef & { since: string }>(
    "SELECT id, huf_name, client_code, COALESCE(approved_at, created_at) AS since FROM hufs WHERE status = 'AWAITING_KARTA' AND COALESCE(approved_at, created_at) < ?", cut,
  );
  for (const h of rows) {
    const days = Math.floor((Date.now() - Date.parse(h.since)) / DayMs);
    await notify({
      key: `huf:${h.id}:waiting`, kind: 'HUF', severity: 'MEDIUM', permission: 'hufs.manage', href: `/onboarding/hufs/${h.id}`,
      title: `${h.huf_name} has waited ${days} days on the karta`, detail: `${h.client_code}: the karta hasn't authorised the account on NSE yet. Resend NSE's link or call them.`,
    });
  }
}

/** Once a day: yesterday's sign-ups, and investors ready to invest who haven't for a week. */
async function dailyDigest(): Promise<void> {
  const today = istDate();
  if (await one('SELECT 1 FROM notifications WHERE key = ?', `digest:${today}:signups`)) return;
  // After 9 AM IST, so it lands at the start of the working day.
  if (new Date(Date.now() + 5.5 * 3_600_000).getUTCHours() < 9) return;
  const { investors } = await lists(SystemActor);
  const yesterday = istDate(Date.now() - DayMs);
  const at = (v: unknown) => Date.parse(iso(v) ?? '');
  const signedUp = investors.filter((i) => istDate(at(i.signed_up_at)) === yesterday);
  const weekAgo = Date.now() - 7 * DayMs;
  const idle = investors.filter((i) => i.onboarded_at && at(i.onboarded_at) < weekAgo && !i.orders);
  await notify({
    key: `digest:${today}:signups`, kind: 'Investor', severity: 'LOW', permission: 'investors.read', href: '/investors',
    title: `${signedUp.length} new sign-up${signedUp.length === 1 ? '' : 's'} yesterday`,
    detail: signedUp.length ? `${signedUp.slice(0, 3).map((i) => i.name || 'Unnamed').join(', ')}${signedUp.length > 3 ? ` and ${signedUp.length - 3} more` : ''}.` : 'No one signed up yesterday.',
  });
  if (idle.length) {
    await notify({
      key: `digest:${today}:idle`, kind: 'Investor', severity: 'MEDIUM', permission: 'investors.read', href: '/investors?stage=READY_TO_INVEST',
      title: `${idle.length} investor${idle.length === 1 ? ' is' : 's are'} ready but haven't invested`,
      detail: 'Onboarded more than a week ago with no order yet. A nudge or a call may help.',
    });
  }
}

/** Every 10 minutes: tickets coming due and HUFs waiting; the daily digest once a day after 9 AM IST. */
export function startNotificationLoop(): void {
  const tick = async () => {
    for (const [name, check] of [['tickets', ticketsDueSoon], ['hufs', hufsWaiting], ['digest', dailyDigest]] as const) {
      await check().catch((error) => console.error(`[notifications] ${name} check failed:`, (error as Error).message));
    }
  };
  setTimeout(() => void tick(), 60_000).unref();
  setInterval(() => void tick(), 10 * 60_000).unref();
}

// --- the feed ------------------------------------------------------------------------------------------------

type NotificationRow = {
  id: string; kind: string; severity: string; title: string; detail: string; href: string; created_at: string; staff_id: string | null; read_at: string | null;
};

const Limit = 100;

export function notificationRoutes(router: Router): void {
  const full = authenticate('full');

  /** The signed-in person's notifications, newest first: those for their permissions and those for them. */
  router.get('/notifications', full, async (ctx) => {
    const me = ctx.staff!;
    const perms = [...me.permissions];
    const visible = `(n.staff_id = ? OR (n.staff_id IS NULL AND n.permission IS NOT NULL AND n.permission = ANY(?::text[])))`;
    const rows = await all<NotificationRow>(
      `SELECT n.id, n.kind, n.severity, n.title, n.detail, n.href, n.created_at, n.staff_id, r.read_at
         FROM notifications n LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.staff_id = ?
        WHERE ${visible} ORDER BY n.created_at DESC LIMIT ${Limit}`,
      me.id, me.id, perms,
    );
    const unread = await one<{ n: string }>(
      `SELECT COUNT(*) AS n FROM notifications n WHERE ${visible} AND NOT EXISTS (SELECT 1 FROM notification_reads r WHERE r.notification_id = n.id AND r.staff_id = ?)`,
      me.id, perms, me.id,
    );
    const names = await staffNames();
    return {
      items: rows.map((r) => ({
        id: r.id, kind: r.kind, severity: r.severity, title: r.title, detail: r.detail, href: r.href, createdAt: r.created_at,
        read: r.read_at !== null, forYou: r.staff_id === me.id, assignee: r.staff_id ? names.get(r.staff_id) ?? null : null,
      })),
      unread: Number(unread?.n ?? 0),
    };
  });

  /** Marks one read (or unread again, with `{ read: false }`). */
  router.post('/notifications/:id/read', full, async (ctx) => {
    const id = uuidParam(ctx, 'id');
    if (!(await one('SELECT 1 FROM notifications WHERE id = ?', id))) throw HttpError.notFound('That notification could not be found.');
    if (ctx.body?.read === false) await run('DELETE FROM notification_reads WHERE notification_id = ? AND staff_id = ?', id, ctx.staff!.id);
    else await run('INSERT INTO notification_reads (notification_id, staff_id, read_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', id, ctx.staff!.id, nowIso());
    return { ok: true };
  });

  /** Marks everything the person can see as read. */
  router.post('/notifications/read-all', full, async (ctx) => {
    const me = ctx.staff!;
    await run(
      `INSERT INTO notification_reads (notification_id, staff_id, read_at)
       SELECT n.id, ?, ? FROM notifications n
        WHERE (n.staff_id = ? OR (n.staff_id IS NULL AND n.permission IS NOT NULL AND n.permission = ANY(?::text[])))
       ON CONFLICT DO NOTHING`,
      me.id, nowIso(), me.id, [...me.permissions],
    );
    await audit(ctx, 'notifications.read_all', me.id);
    return { ok: true };
  });
}
