// Support tickets, kept in the admin database. Staff log phone and email requests and work them here.
// Investors' in-app tickets and Risip Bot chats live in the app backend, which does not share them yet:
// the chat endpoints answer with an empty queue until it does.
import { audit, authenticate, need, refOf, staffNames, staffWith, type StaffNames } from '../auth.ts';
import { all, nowIso, one, tx, TicketSeq, type Db } from '../db.ts';
import { HttpError, oneOf, page, pageParams, str, uuidParam, listParam, type Ctx, type Router } from '../http.ts';
import { investorExtId, snapshot, type Snapshot } from '../investors.ts';
import { supportInvestor } from '../map.ts';
import { newId } from '../security.ts';

const Statuses = ['OPEN', 'IN_PROGRESS', 'WAITING_ON_INVESTOR', 'RESOLVED', 'CLOSED'] as const;
const Priorities = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
const Categories = ['KYC', 'SIP_MANDATE', 'ORDER', 'REDEMPTION', 'PAYMENT', 'STATEMENT', 'ACCOUNT', 'OTHER'] as const;
const Channels = ['APP', 'CHAT', 'PHONE', 'EMAIL'] as const;
const SlaHours: Record<(typeof Priorities)[number], number> = { URGENT: 4, HIGH: 8, NORMAL: 24, LOW: 72 };
const Open = new Set(['OPEN', 'IN_PROGRESS', 'WAITING_ON_INVESTOR']);

type TicketRow = {
  id: string; seq: number; user_ext_id: string; subject: string; category: string; priority: string; status: string; channel: string;
  assignee_id: string | null; opened_by: string | null; related_type: string | null; related_id: string | null; sla_due_at: string;
  awaiting_staff: number; first_response_at: string | null; resolved_at: string | null; closed_at: string | null; last_message_at: string; created_at: string;
};

const reference = (seq: number) => `TKT-${String(seq).padStart(5, '0')}`;
const overdue = (t: TicketRow) => (t.status === 'OPEN' || t.status === 'IN_PROGRESS') && Date.parse(t.sla_due_at) < Date.now();

function listItem(t: TicketRow, snap: Snapshot, names: StaffNames) {
  return {
    id: t.id,
    reference: reference(t.seq),
    subject: t.subject,
    category: t.category,
    priority: t.priority,
    status: t.status,
    channel: t.channel,
    investor: supportInvestor(snap.byExtId.get(t.user_ext_id), t.user_ext_id),
    assignee: refOf(names, t.assignee_id),
    slaDueAt: t.sla_due_at,
    overdue: overdue(t),
    awaitingStaff: t.awaiting_staff === 1 && Open.has(t.status),
    lastMessageAt: t.last_message_at,
    createdAt: t.created_at,
  };
}

async function detail(id: string, snap: Snapshot) {
  const t = await one<TicketRow>('SELECT * FROM tickets WHERE id = ?', id);
  if (!t) throw HttpError.notFound('That ticket could not be found.');
  const names = await staffNames();
  const messages = (await all<{ id: string; author: string; staff_id: string | null; body: string; internal: number; created_at: string }>(
    'SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY created_at', id,
  )).map((m) => ({ id: m.id, author: m.author, staffName: refOf(names, m.staff_id)?.name ?? null, body: m.body, internal: m.internal === 1, createdAt: m.created_at }));
  const events = (await all<{ id: string; type: string; actor: string; staff_id: string | null; from_value: string | null; to_value: string | null; created_at: string }>(
    'SELECT * FROM ticket_events WHERE ticket_id = ? ORDER BY created_at', id,
  )).map((e) => ({ id: e.id, type: e.type, actor: e.actor, staffName: refOf(names, e.staff_id)?.name ?? null, from: e.from_value, to: e.to_value, createdAt: e.created_at }));
  return {
    ...listItem(t, snap, names),
    related: t.related_type && t.related_id ? { type: t.related_type, id: t.related_id } : null,
    chatConversationId: null,
    firstResponseAt: t.first_response_at,
    resolvedAt: t.resolved_at,
    closedAt: t.closed_at,
    openedBy: refOf(names, t.opened_by),
    messages,
    events,
  };
}

const event = (q: Db, ticketId: string, ctx: Ctx, type: string, from: string | null, to: string | null) =>
  q.run('INSERT INTO ticket_events (id, ticket_id, type, actor, staff_id, from_value, to_value, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    newId(), ticketId, type, 'STAFF', ctx.staff!.id, from, to, nowIso());

/** Moves a ticket to `status`, stamping when it was resolved or closed. */
async function setStatus(q: Db, t: TicketRow, status: string, ctx: Ctx): Promise<void> {
  if (status === t.status) return;
  const at = nowIso();
  await q.run('UPDATE tickets SET status = ?, resolved_at = ?, closed_at = ?, updated_at = ? WHERE id = ?',
    status, status === 'RESOLVED' ? at : status === 'CLOSED' ? t.resolved_at ?? at : null, status === 'CLOSED' ? at : null, at, t.id);
  await event(q, t.id, ctx, 'STATUS_CHANGED', t.status, status);
}

export function supportRoutes(router: Router): void {
  const full = authenticate('full');
  const manage = need('support.manage');

  router.get('/support/agents', full, manage, () => staffWith('support.manage'));

  router.get('/support/tickets', full, manage, async (ctx) => {
    const q = ctx.query;
    const statuses = listParam(q, 'status', Statuses);
    const priorities = listParam(q, 'priority', Priorities);
    const categories = listParam(q, 'category', Categories);
    const assignee = q.get('assignee');
    const onlyOverdue = q.get('overdue') === 'true';
    const search = q.get('search')?.trim().toLowerCase();
    const [snap, names, rows] = await Promise.all([snapshot(ctx), staffNames(), all<TicketRow>('SELECT * FROM tickets ORDER BY last_message_at DESC')]);
    const items = rows
      .filter((t) => (!statuses.length || statuses.includes(t.status as never)) && (!priorities.length || priorities.includes(t.priority as never)) &&
        (!categories.length || categories.includes(t.category as never)) && (!onlyOverdue || overdue(t)))
      .filter((t) => !assignee || (assignee === 'unassigned' ? !t.assignee_id : t.assignee_id === (assignee === 'me' ? ctx.staff!.id : assignee)))
      .map((t) => listItem(t, snap, names))
      .filter((t) => !search || [t.reference, t.subject, t.investor.name, t.investor.email, t.investor.phone].filter(Boolean).join(' ').toLowerCase().includes(search));
    const open = rows.filter((t) => Open.has(t.status));
    const { offset, limit } = pageParams(q);
    return {
      ...page(items, offset, limit),
      total: items.length,
      summary: {
        open: open.length,
        unassigned: open.filter((t) => !t.assignee_id).length,
        overdue: rows.filter(overdue).length,
        awaitingStaff: open.filter((t) => t.awaiting_staff === 1).length,
        waitingOnInvestor: rows.filter((t) => t.status === 'WAITING_ON_INVESTOR').length,
        mine: open.filter((t) => t.assignee_id === ctx.staff!.id).length,
      },
    };
  });

  router.post('/support/tickets', full, manage, async (ctx) => {
    const userExtId = await investorExtId(ctx, String(ctx.body?.userId ?? '').toLowerCase());
    const subject = str(ctx.body, 'subject', { max: 200, required: true })!;
    const body = str(ctx.body, 'body', { max: 10_000, required: true })!;
    const category = ctx.body?.category ? oneOf(ctx.body.category, Categories, 'category') : 'OTHER';
    const priority = ctx.body?.priority ? oneOf(ctx.body.priority, Priorities, 'priority') : 'NORMAL';
    const channel = ctx.body?.channel ? oneOf(ctx.body.channel, Channels, 'channel') : 'PHONE';
    const id = newId();
    const at = nowIso();
    await tx(async (q) => {
      const seq = Number((await q.one<{ n: string }>('SELECT nextval(?::regclass) AS n', TicketSeq))!.n);
      await q.run(`INSERT INTO tickets (id, seq, user_ext_id, subject, category, priority, status, channel, assignee_id, opened_by, sla_due_at, awaiting_staff, last_message_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, 1, ?, ?, ?)`,
        id, seq, userExtId, subject, category, priority, channel, ctx.staff!.id, ctx.staff!.id,
        new Date(Date.now() + SlaHours[priority] * 3_600_000).toISOString(), at, at, at);
      // What the investor asked for, as logged by the staff member who took the call or email.
      await q.run('INSERT INTO ticket_messages (id, ticket_id, author, staff_id, body, internal, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)', newId(), id, 'INVESTOR', null, body, at);
      await event(q, id, ctx, 'CREATED', null, 'OPEN');
    });
    await audit(ctx, 'ticket.created', id);
    return detail(id, await snapshot(ctx));
  });

  router.get('/support/tickets/:ticketId', full, manage, async (ctx) => detail(uuidParam(ctx, 'ticketId'), await snapshot(ctx)));

  router.patch('/support/tickets/:ticketId', full, manage, async (ctx) => {
    const id = uuidParam(ctx, 'ticketId');
    const t = await one<TicketRow>('SELECT * FROM tickets WHERE id = ?', id);
    if (!t) throw HttpError.notFound('That ticket could not be found.');
    const status = ctx.body?.status ? oneOf(ctx.body.status, Statuses, 'status') : t.status;
    const priority = ctx.body?.priority ? oneOf(ctx.body.priority, Priorities, 'priority') : t.priority;
    const category = ctx.body?.category ? oneOf(ctx.body.category, Categories, 'category') : t.category;
    const assigneeId = ctx.body && 'assigneeId' in ctx.body ? (ctx.body.assigneeId ? String(ctx.body.assigneeId) : null) : t.assignee_id;
    if (assigneeId && !(await staffWith('support.manage')).some((s) => s.id === assigneeId)) throw HttpError.badRequest('That person cannot handle support tickets.');
    const names = await staffNames();
    await tx(async (q) => {
      if (priority !== t.priority) {
        const sla = new Date(Date.parse(t.created_at) + SlaHours[priority as (typeof Priorities)[number]] * 3_600_000).toISOString();
        await q.run('UPDATE tickets SET priority = ?, sla_due_at = ? WHERE id = ?', priority, sla, id);
        await event(q, id, ctx, 'PRIORITY_CHANGED', t.priority, priority);
      }
      if (category !== t.category) {
        await q.run('UPDATE tickets SET category = ? WHERE id = ?', category, id);
        await event(q, id, ctx, 'CATEGORY_CHANGED', t.category, category);
      }
      if (assigneeId !== t.assignee_id) {
        await q.run('UPDATE tickets SET assignee_id = ? WHERE id = ?', assigneeId, id);
        await event(q, id, ctx, 'ASSIGNED', refOf(names, t.assignee_id)?.name ?? null, refOf(names, assigneeId)?.name ?? null);
      }
      await setStatus(q, t, status, ctx);
      await q.run('UPDATE tickets SET updated_at = ? WHERE id = ?', nowIso(), id);
    });
    await audit(ctx, 'ticket.updated', id);
    return detail(id, await snapshot(ctx));
  });

  router.post('/support/tickets/:ticketId/messages', full, manage, async (ctx) => {
    const id = uuidParam(ctx, 'ticketId');
    const t = await one<TicketRow>('SELECT * FROM tickets WHERE id = ?', id);
    if (!t) throw HttpError.notFound('That ticket could not be found.');
    if (t.status === 'CLOSED') throw HttpError.conflict('This ticket is closed. Reopen it to reply.');
    const body = str(ctx.body, 'body', { max: 10_000, required: true })!;
    const internal = ctx.body?.internal === true;
    const status = ctx.body?.status ? oneOf(ctx.body.status, Statuses, 'status') : null;
    const at = nowIso();
    await tx(async (q) => {
      await q.run('INSERT INTO ticket_messages (id, ticket_id, author, staff_id, body, internal, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        newId(), id, 'STAFF', ctx.staff!.id, body, internal ? 1 : 0, at);
      if (!internal) {
        await q.run('UPDATE tickets SET awaiting_staff = 0, last_message_at = ?, first_response_at = COALESCE(first_response_at, ?), updated_at = ? WHERE id = ?', at, at, at, id);
      }
      await setStatus(q, t, status ?? (!internal && t.status === 'OPEN' ? 'IN_PROGRESS' : t.status), ctx);
    });
    await audit(ctx, internal ? 'ticket.note' : 'ticket.replied', id);
    return detail(id, await snapshot(ctx));
  });

  // --- Risip Bot chats: not shared by the app backend yet -------------------------------------------
  router.get('/support/chats', full, manage, () => ({ items: [], summary: { live: 0, waiting: 0, mine: 0, bot: 0 } }));
  const noChats = () => {
    throw HttpError.notFound('Chats with Ri live in the app backend, which does not share them with the admin yet.');
  };
  router.get('/support/chats/:chatId', full, manage, noChats);
  for (const action of ['take-over', 'hand-back', 'messages', 'close', 'escalate']) router.post(`/support/chats/:chatId/${action}`, full, manage, noChats);
}
