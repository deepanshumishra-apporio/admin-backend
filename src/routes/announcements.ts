// Announcements, with maker-checker approval. They are written and approved here; showing them in the app needs the
// app backend to read them (not built yet), so delivery counts stay at zero until then.
import { audit, authenticate, need, refOf, staffNames, type StaffNames } from '../auth.ts';
import { all, nowIso, one, run } from '../db.ts';
import { HttpError, listParam, oneOf, str, uuidParam, type Ctx, type Router } from '../http.ts';
import { snapshot, type Snapshot } from '../investors.ts';
import { newId } from '../security.ts';

const Categories = ['PROMOTIONAL', 'INFORMATIONAL'] as const;
const Audiences = ['ALL_INVESTORS', 'KYC_PENDING', 'READY_NOT_INVESTED', 'INVESTED', 'ACTIVE_SIP', 'NO_SIP'] as const;
const Statuses = ['DRAFT', 'PENDING_APPROVAL', 'REJECTED', 'SCHEDULED', 'LIVE', 'COMPLETED', 'CANCELLED'] as const;
const CtaActions = ['start_sip', 'invest', 'sips', 'none'] as const;

type Row = {
  id: string; name: string; category: string; audience: string; status: string; title: string; body: string; send_notification: number;
  show_banner: number; tag: string | null; banner_title: string | null; banner_body: string | null; highlight: string | null;
  cta_label: string | null; cta_action: string | null; starts_at: string; ends_at: string | null; created_by: string | null;
  approved_by: string | null; submitted_at: string | null; approved_at: string | null; rejection_reason: string | null;
  cancelled_at: string | null; ended_at: string | null; created_at: string;
};

/** SCHEDULED and LIVE move on with the clock. */
function statusOf(r: Row): string {
  const now = Date.now();
  if ((r.status === 'SCHEDULED' || r.status === 'LIVE') && r.ends_at && Date.parse(r.ends_at) <= now) return 'COMPLETED';
  if (r.status === 'SCHEDULED' && Date.parse(r.starts_at) <= now) return 'LIVE';
  return r.status;
}

function listItem(r: Row, names: StaffNames) {
  return {
    id: r.id, name: r.name, category: r.category, audience: r.audience, status: statusOf(r), title: r.title,
    sendNotification: r.send_notification === 1, showBanner: r.show_banner === 1, startsAt: r.starts_at, endsAt: r.ends_at,
    createdBy: refOf(names, r.created_by), approvedBy: refOf(names, r.approved_by),
    sentAt: null, deliveredCount: 0, createdAt: r.created_at,
  };
}

function audienceMatch(snap: Snapshot, audience: string): number {
  const f = snap.facts.filter((x) => x.status === 'ACTIVE');
  switch (audience) {
    case 'KYC_PENDING': return f.filter((x) => x.kycStatus !== 'COMPLETED').length;
    case 'READY_NOT_INVESTED': return f.filter((x) => x.stage === 'READY_TO_INVEST').length;
    case 'INVESTED': return f.filter((x) => x.invested).length;
    case 'ACTIVE_SIP': return f.filter((x) => x.activeSips > 0).length;
    case 'NO_SIP': return f.filter((x) => (x.stage === 'READY_TO_INVEST' || x.stage === 'INVESTED') && x.activeSips === 0).length;
    default: return f.length;
  }
}

async function detail(id: string, ctx: Ctx, snap: Snapshot) {
  const r = await one<Row>('SELECT * FROM announcements WHERE id = ?', id);
  if (!r) throw HttpError.notFound('That announcement could not be found.');
  const status = statusOf(r);
  const mine = r.created_by === ctx.staff!.id;
  return {
    ...listItem(r, await staffNames()),
    body: r.body, tag: r.tag, bannerTitle: r.banner_title, bannerBody: r.banner_body, highlight: r.highlight, ctaLabel: r.cta_label,
    ctaAction: r.cta_action, submittedAt: r.submitted_at, approvedAt: r.approved_at, rejectionReason: r.rejection_reason, cancelledAt: r.cancelled_at,
    stats: { targeted: audienceMatch(snap, r.audience), delivered: 0, optedOut: 0, capped: 0, read: 0, bannerSeen: 0, bannerClicked: 0 },
    can: {
      edit: status === 'DRAFT' || status === 'REJECTED',
      submit: status === 'DRAFT' || status === 'REJECTED',
      approve: status === 'PENDING_APPROVAL' && !mine,
      reject: status === 'PENDING_APPROVAL' && !mine,
      cancel: ['DRAFT', 'PENDING_APPROVAL', 'REJECTED', 'SCHEDULED'].includes(status),
      end: status === 'LIVE',
    },
  };
}

function input(body: any) {
  const category = oneOf(body?.category, Categories, 'category');
  const audience = oneOf(body?.audience, Audiences, 'audience');
  const sendNotification = body?.sendNotification === true;
  const showBanner = body?.showBanner === true;
  if (!sendNotification && !showBanner) throw HttpError.badRequest('Send it as a notification, a banner, or both.');
  const startsAt = typeof body?.startsAt === 'string' && !Number.isNaN(Date.parse(body.startsAt)) ? new Date(body.startsAt).toISOString() : null;
  if (!startsAt) throw HttpError.badRequest('Choose when it starts.');
  const endsAt = body?.endsAt ? (Number.isNaN(Date.parse(body.endsAt)) ? null : new Date(body.endsAt).toISOString()) : null;
  if (body?.endsAt && !endsAt) throw HttpError.badRequest('The end time is not a valid date.');
  if (endsAt && endsAt <= startsAt) throw HttpError.badRequest('It has to end after it starts.');
  const ctaAction = body?.ctaAction ? oneOf(body.ctaAction, CtaActions, 'ctaAction') : null;
  return {
    name: str(body, 'name', { max: 120, required: true })!,
    category, audience,
    title: str(body, 'title', { max: 120, required: true })!,
    body: str(body, 'body', { max: 1000, required: true })!,
    sendNotification, showBanner,
    tag: str(body, 'tag', { max: 30 }),
    bannerTitle: str(body, 'bannerTitle', { max: 120 }),
    bannerBody: str(body, 'bannerBody', { max: 300 }),
    highlight: str(body, 'highlight', { max: 60 }),
    ctaLabel: str(body, 'ctaLabel', { max: 40 }),
    ctaAction, startsAt, endsAt,
  };
}

async function announcementList(ctx: Ctx) {
  const statuses = listParam(ctx.query, 'status', Statuses);
  const names = await staffNames();
  const rows = (await all<Row>('SELECT * FROM announcements ORDER BY created_at DESC')).map((r) => listItem(r, names));
  const items = statuses.length ? rows.filter((r) => statuses.includes(r.status as never)) : rows;
  return {
    items,
    summary: {
      drafts: rows.filter((r) => r.status === 'DRAFT' || r.status === 'REJECTED').length,
      awaitingApproval: rows.filter((r) => r.status === 'PENDING_APPROVAL').length,
      scheduled: rows.filter((r) => r.status === 'SCHEDULED').length,
      live: rows.filter((r) => r.status === 'LIVE').length,
    },
  };
}

export function announcementRoutes(router: Router): void {
  const full = authenticate('full');
  const manage = need('announcements.manage');

  router.get('/announcements', full, manage, (ctx) => announcementList(ctx));

  router.get('/announcements/reach', full, manage, async (ctx) => {
    const audience = oneOf(ctx.query.get('audience'), Audiences, 'audience');
    const matched = audienceMatch(await snapshot(ctx), audience);
    return { matched, optedOut: 0, reachable: matched };
  });

  router.post('/announcements', full, manage, async (ctx) => {
    const v = input(ctx.body);
    const id = newId();
    const at = nowIso();
    await run(`INSERT INTO announcements (id, name, category, audience, status, title, body, send_notification, show_banner, tag, banner_title, banner_body,
           highlight, cta_label, cta_action, starts_at, ends_at, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, v.name, v.category, v.audience, v.title, v.body, v.sendNotification ? 1 : 0, v.showBanner ? 1 : 0, v.tag, v.bannerTitle, v.bannerBody,
      v.highlight, v.ctaLabel, v.ctaAction, v.startsAt, v.endsAt, ctx.staff!.id, at, at);
    await audit(ctx, 'announcement.created', id);
    return detail(id, ctx, await snapshot(ctx));
  });

  router.get('/announcements/:announcementId', full, manage, async (ctx) => detail(uuidParam(ctx, 'announcementId'), ctx, await snapshot(ctx)));

  router.put('/announcements/:announcementId', full, manage, async (ctx) => {
    const id = uuidParam(ctx, 'announcementId');
    const r = await one<Row>('SELECT * FROM announcements WHERE id = ?', id);
    if (!r) throw HttpError.notFound('That announcement could not be found.');
    if (r.status !== 'DRAFT' && r.status !== 'REJECTED') throw HttpError.conflict('Only drafts and rejected announcements can be edited.');
    const v = input(ctx.body);
    await run(`UPDATE announcements SET name = ?, category = ?, audience = ?, title = ?, body = ?, send_notification = ?, show_banner = ?, tag = ?, banner_title = ?,
           banner_body = ?, highlight = ?, cta_label = ?, cta_action = ?, starts_at = ?, ends_at = ?, updated_at = ? WHERE id = ?`,
      v.name, v.category, v.audience, v.title, v.body, v.sendNotification ? 1 : 0, v.showBanner ? 1 : 0, v.tag, v.bannerTitle, v.bannerBody,
      v.highlight, v.ctaLabel, v.ctaAction, v.startsAt, v.endsAt, nowIso(), id);
    await audit(ctx, 'announcement.updated', id);
    return detail(id, ctx, await snapshot(ctx));
  });

  router.post('/announcements/:announcementId/actions', full, manage, async (ctx) => {
    const id = uuidParam(ctx, 'announcementId');
    const r = await one<Row>('SELECT * FROM announcements WHERE id = ?', id);
    if (!r) throw HttpError.notFound('That announcement could not be found.');
    const status = statusOf(r);
    const action = String(ctx.body?.action ?? '');
    const at = nowIso();
    const mine = r.created_by === ctx.staff!.id;
    switch (action) {
      case 'submit':
        if (status !== 'DRAFT' && status !== 'REJECTED') throw HttpError.conflict('Only a draft can be sent for approval.');
        await run("UPDATE announcements SET status = 'PENDING_APPROVAL', submitted_at = ?, rejection_reason = NULL, updated_at = ? WHERE id = ?", at, at, id);
        break;
      case 'approve':
        if (status !== 'PENDING_APPROVAL') throw HttpError.conflict('This is not waiting for approval.');
        if (mine) throw HttpError.forbidden('A colleague has to approve it, not its author.');
        if (r.ends_at && Date.parse(r.ends_at) <= Date.now()) throw HttpError.conflict('Its end time has passed. Edit the dates first.');
        await run("UPDATE announcements SET status = 'SCHEDULED', approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?", ctx.staff!.id, at, at, id);
        break;
      case 'reject': {
        if (status !== 'PENDING_APPROVAL') throw HttpError.conflict('This is not waiting for approval.');
        if (mine) throw HttpError.forbidden('A colleague has to review it, not its author.');
        const reason = str(ctx.body, 'reason', { max: 500, required: true });
        await run("UPDATE announcements SET status = 'REJECTED', rejection_reason = ?, updated_at = ? WHERE id = ?", reason, at, id);
        break;
      }
      case 'cancel':
        if (!['DRAFT', 'PENDING_APPROVAL', 'REJECTED', 'SCHEDULED'].includes(status)) throw HttpError.conflict('This can no longer be cancelled.');
        await run("UPDATE announcements SET status = 'CANCELLED', cancelled_at = ?, updated_at = ? WHERE id = ?", at, at, id);
        break;
      case 'end':
        if (status !== 'LIVE') throw HttpError.conflict('Only a live announcement can be ended.');
        await run("UPDATE announcements SET status = 'COMPLETED', ended_at = ?, ends_at = ?, updated_at = ? WHERE id = ?", at, at, at, id);
        break;
      default:
        throw HttpError.badRequest('Unknown action.');
    }
    await audit(ctx, `announcement.${action}`, id);
    return detail(id, ctx, await snapshot(ctx));
  });
}
