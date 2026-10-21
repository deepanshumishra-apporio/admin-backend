// Review meetings with investors: when they happened, who ran them, and the risk profile they recommend.
// Marking a meeting "profile updated" records that the change was made; the profile itself lives in the app backend.
import { audit, authenticate, need, refOf, staffNames, staffWith, type StaffNames } from '../auth.ts';
import { all, nowIso, one, run } from '../db.ts';
import { HttpError, listParam, oneOf, page, pageParams, uuidParam, type Router } from '../http.ts';
import { investorExtId, snapshot, type Snapshot } from '../investors.ts';
import { supportInvestor } from '../map.ts';
import { newId } from '../security.ts';

const Modes = ['IN_PERSON', 'VIDEO', 'PHONE'] as const;
const Profiles = ['CONSERVATIVE', 'MODERATE', 'AGGRESSIVE'] as const;
const Statuses = ['SCHEDULED', 'CAPTURED', 'PROFILE_UPDATED'] as const;
const Next: Record<string, string[]> = { SCHEDULED: ['CAPTURED', 'PROFILE_UPDATED'], CAPTURED: ['PROFILE_UPDATED'], PROFILE_UPDATED: [] };

type Row = {
  id: string; user_ext_id: string; conducted_by: string; recorded_by: string; mode: string; meeting_date: string; current_profile: string;
  recommended_profile: string; status: string; notes: string; created_at: string; updated_at: string;
};

const view = (m: Row, snap: Snapshot, names: StaffNames) => ({
  id: m.id,
  investor: supportInvestor(snap.byExtId.get(m.user_ext_id), m.user_ext_id),
  conductedBy: refOf(names, m.conducted_by)!,
  recordedBy: refOf(names, m.recorded_by)!,
  mode: m.mode,
  meetingDate: m.meeting_date,
  currentProfile: m.current_profile,
  recommendedProfile: m.recommended_profile,
  status: m.status,
  notes: m.notes,
  createdAt: m.created_at,
  updatedAt: m.updated_at,
});

const viewOf = async (id: string, snap: Snapshot) => view((await one<Row>('SELECT * FROM meetings WHERE id = ?', id))!, snap, await staffNames());

export function meetingRoutes(router: Router): void {
  const full = authenticate('full');
  const manage = need('meetings.manage');

  router.get('/review-meetings', full, manage, async (ctx) => {
    const statuses = listParam(ctx.query, 'status', Statuses);
    const [rows, snap, names] = await Promise.all([all<Row>('SELECT * FROM meetings ORDER BY meeting_date DESC, created_at DESC'), snapshot(ctx), staffNames()]);
    const items = rows.filter((m) => !statuses.length || statuses.includes(m.status as never)).map((m) => view(m, snap, names));
    const { offset, limit } = pageParams(ctx.query);
    return {
      ...page(items, offset, limit),
      counts: Object.fromEntries(Statuses.map((s) => [s, rows.filter((m) => m.status === s).length])),
    };
  });

  router.get('/review-meetings/conductors', full, manage, () => staffWith('meetings.manage'));

  router.get('/review-meetings/investors', full, manage, async (ctx) => {
    const search = ctx.query.get('search')?.trim().toLowerCase() ?? '';
    if (search.length < 2) return [];
    return (await snapshot(ctx)).facts
      .filter((f) => [f.up.name, f.up.email, f.up.mobile].filter(Boolean).join(' ').toLowerCase().includes(search))
      .slice(0, 20)
      .map((f) => ({ id: f.id, name: f.up.name, phone: f.up.mobile }));
  });

  router.post('/review-meetings', full, manage, async (ctx) => {
    const userExtId = await investorExtId(ctx, String(ctx.body?.userId ?? '').toLowerCase());
    const mode = oneOf(ctx.body?.mode, Modes, 'mode');
    const currentProfile = oneOf(ctx.body?.currentProfile, Profiles, 'currentProfile');
    const recommendedProfile = oneOf(ctx.body?.recommendedProfile, Profiles, 'recommendedProfile');
    const meetingDate = String(ctx.body?.meetingDate ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(meetingDate) || Number.isNaN(Date.parse(meetingDate))) throw HttpError.badRequest('Choose the meeting date.');
    const conductedBy = ctx.body?.conductedByStaffId ? String(ctx.body.conductedByStaffId) : ctx.staff!.id;
    if (!(await staffWith('meetings.manage')).some((s) => s.id === conductedBy)) throw HttpError.badRequest('That person cannot run review meetings.');
    const notes = typeof ctx.body?.notes === 'string' ? ctx.body.notes.trim().slice(0, 10_000) : '';
    const id = newId();
    const at = nowIso();
    await run(`INSERT INTO meetings (id, user_ext_id, conducted_by, recorded_by, mode, meeting_date, current_profile, recommended_profile, status, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, userExtId, conductedBy, ctx.staff!.id, mode, meetingDate, currentProfile, recommendedProfile, notes ? 'CAPTURED' : 'SCHEDULED', notes, at, at);
    await audit(ctx, 'meeting.recorded', id);
    return viewOf(id, await snapshot(ctx));
  });

  router.patch('/review-meetings/:meetingId', full, manage, async (ctx) => {
    const id = uuidParam(ctx, 'meetingId');
    const m = await one<Row>('SELECT * FROM meetings WHERE id = ?', id);
    if (!m) throw HttpError.notFound('That meeting could not be found.');
    const status = oneOf(ctx.body?.status, Statuses, 'status');
    if (m.status === 'PROFILE_UPDATED') throw HttpError.conflict('This record is final.');
    if (status !== m.status && !Next[m.status]!.includes(status)) throw HttpError.conflict('That change cannot be made.');
    const notes = typeof ctx.body?.notes === 'string' ? ctx.body.notes.trim().slice(0, 10_000) : m.notes;
    await run('UPDATE meetings SET status = ?, notes = ?, updated_at = ? WHERE id = ?', status, notes, nowIso(), id);
    await audit(ctx, 'meeting.updated', id, { status });
    return viewOf(id, await snapshot(ctx));
  });
}
