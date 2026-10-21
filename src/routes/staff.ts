// Staff accounts and roles.
import { audit, authenticate, need, PermissionKeys, Permissions, type Permission } from '../auth.ts';
import { all, nowIso, one, run, tx, type Db } from '../db.ts';
import { HttpError, oneOf, str, uuidParam, type Ctx, type Router } from '../http.ts';
import { hashPassword, newId, temporaryPassword } from '../security.ts';

type StaffRow = {
  id: string;
  email: string;
  full_name: string;
  phone: string | null;
  status: string;
  mfa_enrolled: number;
  locked_until: string | null;
  must_change_password: number;
  last_login_at: string | null;
  created_at: string;
  created_by: string | null;
  deactivated_at: string | null;
};

const rolesOf = (staffId: string, q: Db = { all, one, run }) =>
  q.all<{ key: string; name: string }>('SELECT r.key, r.name FROM staff_roles sr JOIN roles r ON r.key = sr.role_key WHERE sr.staff_id = ? ORDER BY r.name', staffId);

async function permissionsOfRoles(keys: string[]): Promise<Set<string>> {
  const set = new Set<string>();
  for (const key of keys) {
    const role = await one<{ permissions: string }>('SELECT permissions FROM roles WHERE key = ?', key);
    for (const p of JSON.parse(role?.permissions ?? '[]') as string[]) set.add(p);
  }
  return set;
}

async function listItem(row: StaffRow) {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    phone: row.phone,
    status: row.status,
    roles: await rolesOf(row.id),
    mfaEnrolled: row.mfa_enrolled === 1,
    locked: Boolean(row.locked_until && Date.parse(row.locked_until) > Date.now()),
    mustChangePassword: row.must_change_password === 1,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
  };
}

const staffRow = (id: string) => one<StaffRow>('SELECT * FROM staff WHERE id = ?', id);

async function detail(id: string) {
  const row = await staffRow(id);
  if (!row) throw HttpError.notFound('That staff member could not be found.');
  const creator = row.created_by ? await one<{ id: string; full_name: string }>('SELECT id, full_name FROM staff WHERE id = ?', row.created_by) : undefined;
  const activeSessions = (await one<{ n: number }>(
    'SELECT COUNT(*)::int AS n FROM sessions WHERE staff_id = ? AND revoked_at IS NULL AND expires_at > ?', id, nowIso(),
  ))!.n;
  const recentLogins = (await all<{ outcome: string; ip: string | null; user_agent: string | null; at: string }>(
    'SELECT outcome, ip, user_agent, at FROM login_events WHERE staff_id = ? ORDER BY at DESC LIMIT 20', id,
  )).map((e) => ({ outcome: e.outcome, ipAddress: e.ip, userAgent: e.user_agent, at: e.at }));
  return {
    ...(await listItem(row)),
    createdBy: creator ? { id: creator.id, fullName: creator.full_name } : null,
    deactivatedAt: row.deactivated_at,
    activeSessions,
    recentLogins,
  };
}

/** Nobody can hand out, or act on someone holding, permissions they don't hold themselves. */
async function assertCanGrant(ctx: Ctx, roleKeys: string[]): Promise<void> {
  for (const p of await permissionsOfRoles(roleKeys)) {
    if (!ctx.staff!.permissions.has(p)) throw HttpError.forbidden('You cannot give someone a permission you do not have.');
  }
}
async function assertCanManage(ctx: Ctx, targetId: string): Promise<void> {
  if (targetId === ctx.staff!.id) throw HttpError.forbidden('Ask another administrator to change your own account.');
  await assertCanGrant(ctx, (await rolesOf(targetId)).map((r) => r.key));
}

async function validRoleKeys(value: unknown): Promise<string[]> {
  if (!Array.isArray(value) || value.length === 0) throw HttpError.badRequest('Choose at least one role.');
  const keys = [...new Set(value.map(String))];
  for (const key of keys) if (!(await one('SELECT 1 FROM roles WHERE key = ?', key))) throw HttpError.badRequest(`Unknown role: ${key}.`);
  return keys;
}

const activeSuperAdmins = async (q: Db) =>
  (await q.one<{ n: number }>("SELECT COUNT(*)::int AS n FROM staff s JOIN staff_roles sr ON sr.staff_id = s.id WHERE sr.role_key = 'SUPER_ADMIN' AND s.status = 'ACTIVE'"))!.n;

async function roleView(key: string) {
  const r = await one<{ key: string; name: string; description: string | null; is_system: number; permissions: string }>('SELECT * FROM roles WHERE key = ?', key);
  if (!r) throw HttpError.notFound('That role could not be found.');
  const staffCount = (await one<{ n: number }>('SELECT COUNT(*)::int AS n FROM staff_roles WHERE role_key = ?', key))!.n;
  return { key: r.key, name: r.name, description: r.description, isSystem: r.is_system === 1, permissions: JSON.parse(r.permissions) as Permission[], staffCount };
}

function validPermissions(value: unknown): Permission[] {
  if (!Array.isArray(value) || value.length === 0) throw HttpError.badRequest('Choose at least one permission.');
  const list = [...new Set(value.map(String))];
  for (const p of list) if (!(PermissionKeys as string[]).includes(p)) throw HttpError.badRequest(`Unknown permission: ${p}.`);
  return list as Permission[];
}

export function staffRoutes(router: Router): void {
  const full = authenticate('full');
  const manageStaff = need('staff.manage');
  const manageRoles = need('roles.manage');

  // --- roles ---------------------------------------------------------------------------------
  router.get('/roles', full, need('staff.manage', 'roles.manage'), async () =>
    Promise.all((await all<{ key: string }>('SELECT key FROM roles ORDER BY is_system DESC, name')).map((r) => roleView(r.key))));

  router.get('/permissions', full, manageRoles, () => Permissions.map((p) => ({ key: p.key, description: p.description })));

  router.post('/roles', full, manageRoles, async (ctx) => {
    const name = str(ctx.body, 'name', { max: 60, required: true })!;
    const description = str(ctx.body, 'description', { max: 300 });
    const permissions = validPermissions(ctx.body?.permissions);
    for (const p of permissions) if (!ctx.staff!.permissions.has(p)) throw HttpError.forbidden('You cannot give a role a permission you do not have.');
    const key = name.toUpperCase().replace(/[^A-Z]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
    if (!/^[A-Z][A-Z_]{0,39}$/.test(key)) throw HttpError.badRequest('Give the role a name that starts with a letter.');
    if (await one('SELECT 1 FROM roles WHERE key = ? OR lower(name) = lower(?)', key, name)) throw HttpError.conflict('A role with that name already exists.');
    await run('INSERT INTO roles (key, name, description, is_system, permissions, created_at) VALUES (?, ?, ?, 0, ?, ?)', key, name, description, JSON.stringify(permissions), nowIso());
    await audit(ctx, 'role.created', key, { permissions });
    return roleView(key);
  });

  router.patch('/roles/:key', full, manageRoles, async (ctx) => {
    const current = await roleView(ctx.params.key!);
    if (current.key === 'SUPER_ADMIN') throw HttpError.forbidden('The super admin role always has every permission.');
    const permissions = ctx.body?.permissions !== undefined ? validPermissions(ctx.body.permissions) : current.permissions;
    for (const p of permissions) if (!ctx.staff!.permissions.has(p)) throw HttpError.forbidden('You cannot give a role a permission you do not have.');
    const name = current.isSystem ? current.name : str(ctx.body, 'name', { max: 60 }) ?? current.name;
    const description = current.isSystem ? current.description : ctx.body?.description !== undefined ? str(ctx.body, 'description', { max: 300 }) : current.description;
    await run('UPDATE roles SET name = ?, description = ?, permissions = ? WHERE key = ?', name, description, JSON.stringify(permissions), current.key);
    await audit(ctx, 'role.updated', current.key, { permissions });
    return roleView(current.key);
  });

  router.delete('/roles/:key', full, manageRoles, async (ctx) => {
    const role = await roleView(ctx.params.key!);
    if (role.isSystem) throw HttpError.forbidden('Built-in roles cannot be deleted.');
    if (role.staffCount > 0) throw HttpError.conflict('Take this role off everyone who has it first.');
    await run('DELETE FROM roles WHERE key = ?', role.key);
    await audit(ctx, 'role.deleted', role.key);
    return undefined;
  });

  // --- staff ---------------------------------------------------------------------------------
  router.get('/staff', full, manageStaff, async () => Promise.all((await all<StaffRow>('SELECT * FROM staff ORDER BY full_name')).map(listItem)));

  router.post('/staff', full, manageStaff, async (ctx) => {
    const email = (str(ctx.body, 'email', { max: 254, required: true }) ?? '').toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw HttpError.badRequest('Enter a valid work email.');
    const fullName = str(ctx.body, 'fullName', { max: 120, required: true })!;
    const phone = str(ctx.body, 'phone', { max: 20 });
    const roleKeys = await validRoleKeys(ctx.body?.roleKeys);
    await assertCanGrant(ctx, roleKeys);
    if (await one('SELECT 1 FROM staff WHERE email = ?', email)) throw HttpError.conflict('Someone already has an account with that email.');
    const id = newId();
    const password = temporaryPassword();
    await tx(async (q) => {
      await q.run('INSERT INTO staff (id, email, full_name, phone, status, password_hash, must_change_password, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
        id, email, fullName, phone, 'ACTIVE', hashPassword(password), ctx.staff!.id, nowIso());
      for (const key of roleKeys) await q.run('INSERT INTO staff_roles (staff_id, role_key) VALUES (?, ?)', id, key);
    });
    await audit(ctx, 'staff.created', id, { email, roleKeys });
    return { staff: await listItem((await staffRow(id))!), temporaryPassword: password };
  });

  router.get('/staff/:staffId', full, manageStaff, (ctx) => detail(uuidParam(ctx, 'staffId')));

  router.patch('/staff/:staffId', full, manageStaff, async (ctx) => {
    const id = uuidParam(ctx, 'staffId');
    if (!(await staffRow(id))) throw HttpError.notFound('That staff member could not be found.');
    const fullName = str(ctx.body, 'fullName', { max: 120, required: true })!;
    const phone = str(ctx.body, 'phone', { max: 20 });
    const roleKeys = ctx.body?.roleKeys !== undefined ? await validRoleKeys(ctx.body.roleKeys) : null;
    if (roleKeys) {
      await assertCanManage(ctx, id);
      await assertCanGrant(ctx, roleKeys);
    }
    await tx(async (q) => {
      await q.run('UPDATE staff SET full_name = ?, phone = ? WHERE id = ?', fullName, phone, id);
      if (roleKeys) {
        const wasSuper = (await rolesOf(id, q)).some((r) => r.key === 'SUPER_ADMIN');
        await q.run('DELETE FROM staff_roles WHERE staff_id = ?', id);
        for (const key of roleKeys) await q.run('INSERT INTO staff_roles (staff_id, role_key) VALUES (?, ?)', id, key);
        if (wasSuper && !roleKeys.includes('SUPER_ADMIN') && (await activeSuperAdmins(q)) === 0) throw HttpError.conflict('Keep at least one active super admin.');
      }
    });
    await audit(ctx, 'staff.updated', id, { roleKeys });
    return detail(id);
  });

  router.post('/staff/:staffId/status', full, manageStaff, async (ctx) => {
    const id = uuidParam(ctx, 'staffId');
    const row = await staffRow(id);
    if (!row) throw HttpError.notFound('That staff member could not be found.');
    await assertCanManage(ctx, id);
    const status = oneOf(ctx.body?.status, ['ACTIVE', 'SUSPENDED', 'DEACTIVATED'] as const, 'status');
    if (row.status === 'DEACTIVATED' && status !== 'DEACTIVATED') throw HttpError.conflict('A deactivated account cannot be brought back. Create a new one.');
    await tx(async (q) => {
      await q.run('UPDATE staff SET status = ?, deactivated_at = ? WHERE id = ?', status, status === 'DEACTIVATED' ? nowIso() : null, id);
      if (status !== 'ACTIVE') await q.run('UPDATE sessions SET revoked_at = ? WHERE staff_id = ? AND revoked_at IS NULL', nowIso(), id);
      if ((await activeSuperAdmins(q)) === 0) throw HttpError.conflict('Keep at least one active super admin.');
    });
    await audit(ctx, 'staff.status', id, { status });
    return detail(id);
  });

  router.post('/staff/:staffId/reset-password', full, manageStaff, async (ctx) => {
    const id = uuidParam(ctx, 'staffId');
    if (!(await staffRow(id))) throw HttpError.notFound('That staff member could not be found.');
    await assertCanManage(ctx, id);
    const password = temporaryPassword();
    await tx(async (q) => {
      await q.run('UPDATE staff SET password_hash = ?, must_change_password = 1, failed_attempts = 0, locked_until = NULL WHERE id = ?', hashPassword(password), id);
      await q.run('UPDATE sessions SET revoked_at = ? WHERE staff_id = ? AND revoked_at IS NULL', nowIso(), id);
    });
    await audit(ctx, 'staff.password_reset', id);
    return { staff: await listItem((await staffRow(id))!), temporaryPassword: password };
  });

  router.post('/staff/:staffId/reset-mfa', full, manageStaff, async (ctx) => {
    const id = uuidParam(ctx, 'staffId');
    if (!(await staffRow(id))) throw HttpError.notFound('That staff member could not be found.');
    await assertCanManage(ctx, id);
    await tx(async (q) => {
      await q.run('UPDATE staff SET mfa_secret = NULL, mfa_enrolled = 0 WHERE id = ?', id);
      await q.run('UPDATE sessions SET revoked_at = ? WHERE staff_id = ? AND revoked_at IS NULL', nowIso(), id);
    });
    await audit(ctx, 'staff.mfa_reset', id);
    return detail(id);
  });

  router.post('/staff/:staffId/revoke-sessions', full, manageStaff, async (ctx) => {
    const id = uuidParam(ctx, 'staffId');
    if (!(await staffRow(id))) throw HttpError.notFound('That staff member could not be found.');
    await assertCanManage(ctx, id);
    await run('UPDATE sessions SET revoked_at = ? WHERE staff_id = ? AND revoked_at IS NULL', nowIso(), id);
    await audit(ctx, 'staff.sessions_revoked', id);
    return detail(id);
  });
}
