// Creates a staff account, or resets an existing one's password, from the command line.
//
//   STAFF_EMAIL=akash@example.com STAFF_NAME="Akash Saxena" npm run staff:create
//
// Optional: STAFF_ROLE (default SUPER_ADMIN), STAFF_PASSWORD (default: a generated one-time password, printed once).
// The person must choose a new password at first sign-in either way.
import { seedRoles } from '../src/auth.ts';
import { closeDb, migrate, nowIso, one, tx } from '../src/db.ts';
import { hashPassword, newId, temporaryPassword } from '../src/security.ts';

const email = process.env['STAFF_EMAIL']?.trim().toLowerCase();
const fullName = process.env['STAFF_NAME']?.trim();
const role = process.env['STAFF_ROLE']?.trim() || 'SUPER_ADMIN';
const password = process.env['STAFF_PASSWORD'] || temporaryPassword();

if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !fullName) {
  console.error('Set STAFF_EMAIL and STAFF_NAME.');
  process.exit(1);
}

await migrate();
await seedRoles();
if (!(await one('SELECT 1 FROM roles WHERE key = ?', role))) {
  console.error(`Unknown role ${role}.`);
  await closeDb();
  process.exit(1);
}

const existing = await one<{ id: string }>('SELECT id FROM staff WHERE email = ?', email);
await tx(async (q) => {
  if (existing) {
    await q.run("UPDATE staff SET password_hash = ?, must_change_password = 1, failed_attempts = 0, locked_until = NULL, status = 'ACTIVE' WHERE id = ?",
      hashPassword(password), existing.id);
    await q.run('INSERT INTO staff_roles (staff_id, role_key) VALUES (?, ?) ON CONFLICT DO NOTHING', existing.id, role);
  } else {
    const id = newId();
    await q.run("INSERT INTO staff (id, email, full_name, status, password_hash, must_change_password, created_at) VALUES (?, ?, ?, 'ACTIVE', ?, 1, ?)",
      id, email, fullName, hashPassword(password), nowIso());
    await q.run('INSERT INTO staff_roles (staff_id, role_key) VALUES (?, ?)', id, role);
  }
  await q.run('INSERT INTO audit_log (staff_id, action, target, detail, at) VALUES (NULL, ?, ?, ?, ?)',
    existing ? 'staff.password_reset_cli' : 'staff.created_cli', email, JSON.stringify({ role }), nowIso());
});
await closeDb();

console.log(`${existing ? 'Reset' : 'Created'} ${email} (${role}).`);
if (!process.env['STAFF_PASSWORD']) console.log(`One-time password: ${password}`);
console.log('They will be asked to choose a new password at first sign-in.');
