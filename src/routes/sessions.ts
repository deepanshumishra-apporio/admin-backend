// Sign-in, the authenticator step, the signed-in staff member, password change and sign-out.
import { audit, authenticate } from '../auth.ts';
import { config } from '../config.ts';
import { nowIso, one, run, tx, type Db } from '../db.ts';
import { HttpError, str, type Ctx, type Router } from '../http.ts';
import {
  hashPassword, looksLikeRecoveryCode, newRecoveryCodes, newTotpSecret, newToken, openSecret, otpauthUri, passwordProblem, recoveryCodeHash,
  sealSecret, tokenId, totpCounter, verifyPassword,
} from '../security.ts';

const MaxFailures = 5;
const LockMinutes = 15;
const MaxMfaAttempts = 5;

// Sign-in attempts per IP: 20 in 10 minutes.
const attempts = new Map<string, number[]>();
function rateLimit(ip: string | null): void {
  const key = ip ?? 'unknown';
  const now = Date.now();
  const recent = (attempts.get(key) ?? []).filter((t) => now - t < 10 * 60_000);
  recent.push(now);
  attempts.set(key, recent);
  if (recent.length > 20) throw new HttpError(429, 'RATE_LIMITED', 'Too many attempts. Wait a minute and try again.');
}

const loginEvent = (ctx: Ctx, staffId: string | null, email: string, outcome: string) =>
  run('INSERT INTO login_events (staff_id, email, outcome, ip, user_agent, at) VALUES (?, ?, ?, ?, ?, ?)',
    staffId, email, outcome, ctx.ip, ctx.userAgent, nowIso());

type StaffAuthRow = {
  id: string;
  email: string;
  status: string;
  password_hash: string;
  failed_attempts: number;
  locked_until: string | null;
  mfa_enrolled: number;
  mfa_required: number;
  must_change_password: number;
};

/** Swaps the staff member's recovery codes for new ones (stored as HMACs only). */
async function replaceRecoveryCodes(q: Db, staffId: string, codes: string[]): Promise<void> {
  await q.run('DELETE FROM staff_recovery_codes WHERE staff_id = ?', staffId);
  const at = nowIso();
  for (const code of codes) await q.run('INSERT INTO staff_recovery_codes (code_hash, staff_id, created_at) VALUES (?, ?, ?)', recoveryCodeHash(code), staffId, at);
}

const recoveryCodesLeft = async (staffId: string): Promise<number> =>
  Number((await one<{ n: number | string }>('SELECT COUNT(*) AS n FROM staff_recovery_codes WHERE staff_id = ? AND used_at IS NULL', staffId))?.n ?? 0);

// A fixed hash so an unknown email costs the same time as a wrong password.
const DummyHash = hashPassword('not-a-real-password-0');

/** What the second step asks for: nothing when two-factor is off on this server or for this person. */
function mfaStateOf(enrolled: boolean, required: boolean): string {
  if (!config.mfaEnabled || !required) return 'VERIFIED';
  return enrolled ? 'VERIFY_REQUIRED' : 'SETUP_REQUIRED';
}

async function sessionState(sessionId: string) {
  const s = (await one<{ expires_at: string; mfa_state: string; staff_id: string }>('SELECT expires_at, mfa_state, staff_id FROM sessions WHERE id = ?', sessionId))!;
  const staff = (await one<{ must_change_password: number }>('SELECT must_change_password FROM staff WHERE id = ?', s.staff_id))!;
  return { expiresAt: s.expires_at, mfa: s.mfa_state, mustChangePassword: staff.must_change_password === 1 };
}

export function sessionRoutes(router: Router): void {
  router.post('/sessions', async (ctx) => {
    rateLimit(ctx.ip);
    const email = (str(ctx.body, 'email', { max: 254, required: true }) ?? '').toLowerCase();
    const password = typeof ctx.body?.password === 'string' ? ctx.body.password : '';
    if (!password) throw HttpError.badRequest('Enter your email and password.');

    const staff = await one<StaffAuthRow>(
      'SELECT id, email, status, password_hash, failed_attempts, locked_until, mfa_enrolled, mfa_required, must_change_password FROM staff WHERE email = ?',
      email,
    );
    // One answer for an unknown email, a wrong password and a locked account, so the sign-in page can't be used to
    // find out which emails are staff accounts, or which ones someone else has locked.
    const wrong = () => new HttpError(401, 'INVALID_CREDENTIALS',
      `That email and password do not match. After ${MaxFailures} wrong tries an account is locked for ${LockMinutes} minutes.`);
    if (!staff) {
      verifyPassword(password, DummyHash);
      await loginEvent(ctx, null, email, 'UNKNOWN_EMAIL');
      throw wrong();
    }
    if (staff.locked_until && Date.parse(staff.locked_until) > Date.now()) {
      await loginEvent(ctx, staff.id, email, 'LOCKED');
      verifyPassword(password, staff.password_hash); // the same time as any other answer
      throw wrong();
    }
    if (!verifyPassword(password, staff.password_hash)) {
      const failures = staff.failed_attempts + 1;
      const lock = failures >= MaxFailures ? new Date(Date.now() + LockMinutes * 60_000).toISOString() : null;
      await run('UPDATE staff SET failed_attempts = ?, locked_until = ? WHERE id = ?', lock ? 0 : failures, lock, staff.id);
      await loginEvent(ctx, staff.id, email, lock ? 'LOCKED' : 'WRONG_PASSWORD');
      throw wrong();
    }
    if (staff.status !== 'ACTIVE') {
      await loginEvent(ctx, staff.id, email, staff.status);
      throw new HttpError(403, 'ACCOUNT_DISABLED', 'This account is not active. Ask an administrator.');
    }

    const token = newToken();
    const mfa = mfaStateOf(staff.mfa_enrolled === 1, staff.mfa_required !== 0);
    const lifeMs = mfa === 'VERIFIED' ? config.sessionHours * 3_600_000 : config.mfaPendingMinutes * 60_000;
    const expiresAt = new Date(Date.now() + lifeMs).toISOString();
    await tx(async (q) => {
      await q.run('INSERT INTO sessions (id, staff_id, mfa_state, ip, user_agent, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        tokenId(token), staff.id, mfa, ctx.ip, ctx.userAgent, nowIso(), expiresAt, nowIso());
      if (mfa === 'VERIFIED') await q.run('UPDATE staff SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?', nowIso(), staff.id);
      else await q.run('UPDATE staff SET failed_attempts = 0, locked_until = NULL WHERE id = ?', staff.id);
    });
    await loginEvent(ctx, staff.id, email, mfa === 'VERIFIED' ? 'SUCCESS' : 'PASSWORD_OK_MFA_PENDING');
    return { accessToken: token, tokenType: 'Bearer', expiresAt, mfa };
  });

  router.get('/sessions/current', authenticate('any'), (ctx) => sessionState(ctx.sessionId!));

  router.delete('/sessions/current', authenticate('any'), async (ctx) => {
    await run('UPDATE sessions SET revoked_at = ? WHERE id = ?', nowIso(), ctx.sessionId);
    return undefined;
  });

  const requireMfaPending = (ctx: Ctx) => {
    if (ctx.mfaState === 'VERIFIED') throw new HttpError(409, 'MFA_ALREADY_VERIFIED', 'This session is already verified.');
  };

  router.post('/sessions/mfa/setup', authenticate('any'), requireMfaPending, async (ctx) => {
    if (ctx.mfaState !== 'SETUP_REQUIRED') throw new HttpError(409, 'MFA_ALREADY_ENROLLED', 'Your authenticator is already set up. Enter its code.');
    const secret = newTotpSecret();
    await run('UPDATE sessions SET pending_secret = ? WHERE id = ?', sealSecret(secret), ctx.sessionId);
    return { secret, otpauthUri: otpauthUri(secret, ctx.staff!.email) };
  });

  /**
   * The second step: a 6-digit code from the authenticator, or (once set up) one of the recovery codes. Setting up
   * returns the ten recovery codes, the only time they are shown.
   */
  router.post('/sessions/mfa/verify', authenticate('any'), requireMfaPending, async (ctx) => {
    const code = String(ctx.body?.code ?? '').replace(/\s+/g, '');
    const enrolling = ctx.mfaState === 'SETUP_REQUIRED';
    const recovery = !enrolling && looksLikeRecoveryCode(code);
    if (!/^\d{6}$/.test(code) && !recovery) {
      throw HttpError.badRequest(enrolling
        ? 'Enter the 6-digit code from your authenticator app.'
        : 'Enter the 6-digit code from your authenticator app, or one of your recovery codes.');
    }
    const session = (await one<{ mfa_attempts: number; pending_secret: string | null }>('SELECT mfa_attempts, pending_secret FROM sessions WHERE id = ?', ctx.sessionId))!;
    const staff = (await one<{ mfa_secret: string | null; mfa_last_counter: string | number | null }>('SELECT mfa_secret, mfa_last_counter FROM staff WHERE id = ?', ctx.staff!.id))!;
    const stored = enrolling ? session.pending_secret : staff.mfa_secret;
    if (!stored) throw HttpError.badRequest('Start the authenticator setup first.');
    const secret = openSecret(stored);

    const wrongCode = async (message: string): Promise<never> => {
      const tries = session.mfa_attempts + 1;
      if (tries >= MaxMfaAttempts) {
        await run('UPDATE sessions SET revoked_at = ?, mfa_attempts = ? WHERE id = ?', nowIso(), tries, ctx.sessionId);
        await loginEvent(ctx, ctx.staff!.id, ctx.staff!.email, 'MFA_LOCKED');
        throw new HttpError(401, 'UNAUTHORIZED', 'Too many wrong codes. Sign in again.');
      }
      await run('UPDATE sessions SET mfa_attempts = ? WHERE id = ?', tries, ctx.sessionId);
      await loginEvent(ctx, ctx.staff!.id, ctx.staff!.email, 'MFA_WRONG_CODE');
      throw new HttpError(400, 'INVALID_CODE', message);
    };

    let counter: number | null = null;
    if (recovery) {
      // Each recovery code works once: the update only succeeds for an unused one.
      const used = await run('UPDATE staff_recovery_codes SET used_at = ? WHERE staff_id = ? AND code_hash = ? AND used_at IS NULL',
        nowIso(), ctx.staff!.id, recoveryCodeHash(code));
      if (!used) await wrongCode('That recovery code is not right, or it has already been used.');
    } else {
      counter = totpCounter(secret, code);
      // A code is good for 90 seconds; once used it can't sign anyone in again.
      const reused = counter !== null && staff.mfa_last_counter !== null && counter <= Number(staff.mfa_last_counter);
      if (counter === null || reused) {
        await wrongCode(reused
          ? 'That code has already been used. Wait for the next one in your authenticator app.'
          : 'That code is not right. Check the time on your phone and try again.');
      }
    }

    const recoveryCodes = enrolling ? newRecoveryCodes() : null;
    const expiresAt = new Date(Date.now() + config.sessionHours * 3_600_000).toISOString();
    await tx(async (q) => {
      if (counter !== null) {
        // Sealed on enrolment, and older plain secrets are sealed the next time they are used.
        await q.run('UPDATE staff SET mfa_secret = ?, mfa_enrolled = 1, mfa_last_counter = ? WHERE id = ?', sealSecret(secret), counter, ctx.staff!.id);
      }
      if (recoveryCodes) await replaceRecoveryCodes(q, ctx.staff!.id, recoveryCodes);
      await q.run("UPDATE sessions SET mfa_state = 'VERIFIED', pending_secret = NULL, expires_at = ?, last_seen_at = ? WHERE id = ?", expiresAt, nowIso(), ctx.sessionId);
      await q.run('UPDATE staff SET last_login_at = ? WHERE id = ?', nowIso(), ctx.staff!.id);
    });
    await loginEvent(ctx, ctx.staff!.id, ctx.staff!.email, recovery ? 'SUCCESS_RECOVERY_CODE' : 'SUCCESS');
    if (recovery) await audit(ctx, 'staff.mfa_recovery_code_used', ctx.staff!.id, { left: await recoveryCodesLeft(ctx.staff!.id) });
    return { ...(await sessionState(ctx.sessionId!)), ...(recoveryCodes ? { recoveryCodes } : {}) };
  });

  /**
   * Ten new recovery codes for the signed-in staff member; the old ones stop working. Needs a current authenticator
   * code, so a session left open on someone's desk can't be used to take over their second factor.
   */
  router.post('/me/recovery-codes', authenticate('mfa'), async (ctx) => {
    const code = String(ctx.body?.code ?? '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(code)) throw HttpError.badRequest('Enter the 6-digit code from your authenticator app.');
    const staff = (await one<{ mfa_secret: string | null; mfa_enrolled: number; mfa_last_counter: string | number | null }>(
      'SELECT mfa_secret, mfa_enrolled, mfa_last_counter FROM staff WHERE id = ?', ctx.staff!.id))!;
    if (staff.mfa_enrolled !== 1 || !staff.mfa_secret) throw HttpError.conflict('Set up two-factor sign-in first.');
    const counter = totpCounter(openSecret(staff.mfa_secret), code);
    if (counter === null || (staff.mfa_last_counter !== null && counter <= Number(staff.mfa_last_counter))) {
      throw new HttpError(400, 'INVALID_CODE', 'That code is not right, or it has already been used. Enter the current code from your authenticator app.');
    }
    const recoveryCodes = newRecoveryCodes();
    await tx(async (q) => {
      await q.run('UPDATE staff SET mfa_last_counter = ? WHERE id = ?', counter, ctx.staff!.id);
      await replaceRecoveryCodes(q, ctx.staff!.id, recoveryCodes);
    });
    await audit(ctx, 'staff.mfa_recovery_codes_renewed', ctx.staff!.id);
    return { recoveryCodes };
  });

  router.get('/me', authenticate('mfa'), async (ctx) => {
    const s = ctx.staff!;
    const row = await one<{ mfa_enrolled: number; mfa_required: number }>('SELECT mfa_enrolled, mfa_required FROM staff WHERE id = ?', s.id);
    const enrolled = row?.mfa_enrolled === 1;
    return {
      id: s.id,
      email: s.email,
      fullName: s.fullName,
      roles: s.roles,
      permissions: [...s.permissions].sort(),
      mustChangePassword: s.mustChangePassword,
      lastLoginAt: s.lastLoginAt,
      /** Two-factor sign-in: whether this server asks for it, whether it is set up, and recovery codes still unused. */
      mfa: { serverOn: config.mfaEnabled, required: config.mfaEnabled && row?.mfa_required !== 0, enrolled, recoveryCodesLeft: enrolled ? await recoveryCodesLeft(s.id) : 0 },
    };
  });

  router.post('/me/password', authenticate('mfa'), async (ctx) => {
    const current = typeof ctx.body?.currentPassword === 'string' ? ctx.body.currentPassword : '';
    const next = typeof ctx.body?.newPassword === 'string' ? ctx.body.newPassword : '';
    const row = (await one<{ password_hash: string }>('SELECT password_hash FROM staff WHERE id = ?', ctx.staff!.id))!;
    if (!verifyPassword(current, row.password_hash)) throw new HttpError(400, 'WRONG_PASSWORD', 'Your current password is not right.');
    const problem = passwordProblem(next, ctx.staff!.email);
    if (problem) throw HttpError.badRequest(problem);
    if (verifyPassword(next, row.password_hash)) throw HttpError.badRequest('Choose a password you have not used here.');
    await tx(async (q) => {
      await q.run('UPDATE staff SET password_hash = ?, must_change_password = 0 WHERE id = ?', hashPassword(next), ctx.staff!.id);
      // Every other session ends; this one carries on.
      await q.run('UPDATE sessions SET revoked_at = ? WHERE staff_id = ? AND id != ? AND revoked_at IS NULL', nowIso(), ctx.staff!.id, ctx.sessionId);
    });
    await audit(ctx, 'staff.password_changed', ctx.staff!.id);
    return undefined;
  });
}
