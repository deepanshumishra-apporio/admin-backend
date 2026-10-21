// Staff sessions and permissions. A session token is only ever held by the dashboard's server, in an httpOnly cookie.
import { config } from './config.ts';
import { all, nowIso, one, run } from './db.ts';
import { HttpError, type Ctx, type Handler, type Staff } from './http.ts';
import { tokenId } from './security.ts';

export const Permissions = [
  { key: 'dashboard.read', description: 'See the dashboard: sign-ups, KYC, journey and investment totals.' },
  { key: 'investors.read', description: 'Search investors and open their full record, holdings and orders.' },
  { key: 'reports.read', description: 'Preview reports and download them as CSV.' },
  { key: 'transactions.read', description: 'Monitor every order across investors.' },
  { key: 'support.manage', description: 'Handle support tickets and live chats.' },
  { key: 'compliance.manage', description: 'Work compliance alerts: acknowledge, assign, resolve, dismiss.' },
  { key: 'announcements.manage', description: 'Write announcements and approve colleagues’ ones.' },
  { key: 'portfolios.manage', description: 'Curate model portfolios.' },
  { key: 'meetings.manage', description: 'Record review meetings with investors.' },
  { key: 'staff.manage', description: 'Create staff accounts, reset passwords and 2FA, suspend people.' },
  { key: 'roles.manage', description: 'Create and change roles and what they allow.' },
] as const;
export type Permission = (typeof Permissions)[number]['key'];
export const PermissionKeys = Permissions.map((p) => p.key) as Permission[];

/** The built-in roles, created on first start. Their permissions can change; their names and keys cannot. */
export const SystemRoles: { key: string; name: string; description: string; permissions: Permission[] }[] = [
  { key: 'SUPER_ADMIN', name: 'Super admin', description: 'Everything, including staff and roles.', permissions: PermissionKeys },
  {
    key: 'OPERATIONS',
    name: 'Operations',
    description: 'Investors, transactions, reports and compliance.',
    permissions: ['dashboard.read', 'investors.read', 'transactions.read', 'reports.read', 'compliance.manage'],
  },
  { key: 'SUPPORT', name: 'Support', description: 'Tickets and chats, with read access to investors.', permissions: ['investors.read', 'support.manage', 'transactions.read'] },
  { key: 'COMPLIANCE', name: 'Compliance', description: 'Compliance alerts and reports.', permissions: ['dashboard.read', 'investors.read', 'compliance.manage', 'reports.read', 'transactions.read'] },
  { key: 'VIEWER', name: 'Viewer', description: 'Read-only dashboard and investors.', permissions: ['dashboard.read', 'investors.read'] },
];

/** Creates the built-in roles if missing. Super admin always gets every permission, including new ones. */
export async function seedRoles(): Promise<void> {
  for (const role of SystemRoles) {
    await run(
      'INSERT INTO roles (key, name, description, is_system, permissions, created_at) VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT (key) DO NOTHING',
      role.key, role.name, role.description, JSON.stringify(role.permissions), nowIso(),
    );
  }
  await run("UPDATE roles SET permissions = ? WHERE key = 'SUPER_ADMIN'", JSON.stringify(PermissionKeys));
}

type StaffRow = {
  id: string;
  email: string;
  full_name: string;
  status: string;
  must_change_password: number;
  last_login_at: string | null;
};

export async function loadStaff(staffId: string): Promise<Staff | null> {
  const row = await one<StaffRow>('SELECT id, email, full_name, status, must_change_password, last_login_at FROM staff WHERE id = ?', staffId);
  if (!row) return null;
  const roles = await all<{ key: string; name: string; permissions: string }>(
    'SELECT r.key, r.name, r.permissions FROM staff_roles sr JOIN roles r ON r.key = sr.role_key WHERE sr.staff_id = ? ORDER BY r.name',
    staffId,
  );
  const permissions = new Set<string>();
  for (const role of roles) for (const p of JSON.parse(role.permissions) as string[]) permissions.add(p);
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    status: row.status,
    mustChangePassword: row.must_change_password === 1,
    permissions,
    roles: roles.map((r) => ({ key: r.key, name: r.name })),
    lastLoginAt: row.last_login_at,
  };
}

type SessionRow = { id: string; staff_id: string; mfa_state: string; expires_at: string; last_seen_at: string; revoked_at: string | null };

const Unauthorized = () => new HttpError(401, 'UNAUTHORIZED', 'Your session has ended. Sign in again.');

/**
 * Checks the Bearer token. `level`:
 *  - 'any': a session that may still be waiting on its MFA code (the MFA and sign-out calls)
 *  - 'mfa': MFA done; a password that must still be changed is allowed (/me, /me/password)
 *  - 'full': everything else
 */
export function authenticate(level: 'any' | 'mfa' | 'full'): Handler {
  return async (ctx: Ctx) => {
    if (!ctx.token) throw Unauthorized();
    const session = await one<SessionRow>(
      'SELECT id, staff_id, mfa_state, expires_at, last_seen_at, revoked_at FROM sessions WHERE id = ?', tokenId(ctx.token),
    );
    const now = Date.now();
    if (!session || session.revoked_at || Date.parse(session.expires_at) <= now) throw Unauthorized();
    if (session.mfa_state === 'VERIFIED' && now - Date.parse(session.last_seen_at) > config.sessionIdleMinutes * 60_000) {
      await run('UPDATE sessions SET revoked_at = ? WHERE id = ?', nowIso(), session.id);
      throw Unauthorized();
    }
    const staff = await loadStaff(session.staff_id);
    if (!staff || staff.status !== 'ACTIVE') {
      await run('UPDATE sessions SET revoked_at = ? WHERE id = ?', nowIso(), session.id);
      throw Unauthorized();
    }
    if (level !== 'any' && session.mfa_state !== 'VERIFIED') {
      throw new HttpError(403, 'MFA_REQUIRED', 'Enter the code from your authenticator app first.');
    }
    if (level === 'full' && staff.mustChangePassword) {
      throw new HttpError(403, 'PASSWORD_CHANGE_REQUIRED', 'Choose a new password before you continue.');
    }
    // Only touch the row once a minute: page renders make many calls.
    if (now - Date.parse(session.last_seen_at) > 60_000) await run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', nowIso(), session.id);
    ctx.sessionId = session.id;
    ctx.mfaState = session.mfa_state;
    ctx.staff = staff;
  };
}

export const need = (...permissions: Permission[]): Handler => (ctx) => {
  if (!permissions.some((p) => ctx.staff!.permissions.has(p))) throw HttpError.forbidden();
};

/** What the app backend's audit log records as the person behind each Admin API call. */
export const actorOf = (ctx: Ctx): string => ctx.staff!.email;

export async function audit(ctx: Ctx | null, action: string, target: string | null, detail: Record<string, unknown> = {}): Promise<void> {
  await run(
    'INSERT INTO audit_log (staff_id, action, target, detail, ip, at) VALUES (?, ?, ?, ?, ?, ?)',
    ctx?.staff?.id ?? null, action, target, JSON.stringify(detail), ctx?.ip ?? null, nowIso(),
  );
}

export type StaffRef = { id: string; name: string };
export type StaffNames = Map<string, string>;

/** Every staff member's name by id: one small query per request instead of one per name shown. */
export async function staffNames(): Promise<StaffNames> {
  return new Map((await all<{ id: string; full_name: string }>('SELECT id, full_name FROM staff')).map((s) => [s.id, s.full_name]));
}

export const refOf = (names: StaffNames, id: string | null | undefined): StaffRef | null =>
  id && names.has(id) ? { id, name: names.get(id)! } : null;

/** Active staff holding a permission, for assignee pickers. */
export async function staffWith(permission: Permission): Promise<StaffRef[]> {
  const rows = await all<{ id: string; full_name: string; permissions: string }>(
    `SELECT s.id, s.full_name, r.permissions FROM staff s
       JOIN staff_roles sr ON sr.staff_id = s.id JOIN roles r ON r.key = sr.role_key
      WHERE s.status = 'ACTIVE' ORDER BY s.full_name`,
  );
  const seen = new Map<string, string>();
  for (const row of rows) if ((JSON.parse(row.permissions) as string[]).includes(permission)) seen.set(row.id, row.full_name);
  return [...seen].map(([id, name]) => ({ id, name }));
}
