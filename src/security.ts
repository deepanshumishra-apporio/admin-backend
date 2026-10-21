// Passwords, session tokens, TOTP and the stable UUIDs handed to the dashboard.
import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';

import { one, run } from './db.ts';

// --- passwords -----------------------------------------------------------------------

const ScryptParams = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, ScryptParams);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = scryptSync(password, Buffer.from(salt, 'base64'), expected.length, ScryptParams);
  return timingSafeEqual(actual, expected);
}

/** Why a new password is refused, or null when it is acceptable. */
export function passwordProblem(password: string, email: string): string | null {
  if (password.length < 12) return 'Use at least 12 characters.';
  if (password.length > 128) return 'Use at most 128 characters.';
  if (!/[a-z]/i.test(password) || !/\d/.test(password)) return 'Use letters and at least one number.';
  if (password.toLowerCase().includes(email.split('@')[0]!.toLowerCase())) return 'Do not use your email in the password.';
  return null;
}

const Alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** A one-time password for a new or reset account: 16 characters, always with a digit. */
export function temporaryPassword(): string {
  for (;;) {
    const bytes = randomBytes(16);
    const value = [...bytes].map((b) => Alphabet[b % Alphabet.length]).join('');
    if (/\d/.test(value) && /[a-z]/i.test(value)) return value;
  }
}

// --- session tokens ---------------------------------------------------------------------

export const newToken = (): string => randomBytes(32).toString('base64url');
/** Sessions are stored by the token's hash, so a database copy cannot be replayed. */
export const tokenId = (token: string): string => createHash('sha256').update(token).digest('hex');

// --- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ------------------------------------------------

const Base32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function newTotpSecret(): string {
  const bytes = randomBytes(20);
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) out += Base32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function base32Decode(secret: string): Buffer {
  let bits = '';
  for (const ch of secret.replace(/=+$/, '').toUpperCase()) {
    const index = Base32.indexOf(ch);
    if (index >= 0) bits += index.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function totpAt(secret: string, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', base32Decode(secret)).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

/** Accepts the current code and one step either side, for clock drift. */
export function verifyTotp(secret: string, code: string): boolean {
  const counter = Math.floor(Date.now() / 30_000);
  return [-1, 0, 1].some((drift) => {
    const expected = Buffer.from(totpAt(secret, counter + drift));
    const given = Buffer.from(code.padEnd(6).slice(0, 6));
    return timingSafeEqual(expected, given);
  });
}

export const otpauthUri = (secret: string, email: string): string =>
  `otpauth://totp/${encodeURIComponent(`RiSips Admin:${email}`)}?secret=${secret}&issuer=${encodeURIComponent('RiSips Admin')}&algorithm=SHA1&digits=6&period=30`;

// --- stable ids for app-backend objects -----------------------------------------------------
// The dashboard accepts only UUIDs in its URLs, while the app backend uses numbers (investors) and FP ids (orders).
// Each object gets a UUID derived from its kind and id, remembered so the dashboard's UUID can be mapped back.

export type IdKind = 'investor' | 'order' | 'plan' | 'holding' | 'payment' | 'bank' | 'profile';

// The mapping is pure, so it is computed in memory; ids are also written to the database (in batches, once each)
// so a UUID from a bookmarked link still resolves after a restart.
const forward = new Map<string, string>();
const backward = new Map<string, { kind: IdKind; extId: string }>();
const unsaved: { uuid: string; kind: IdKind; extId: string }[] = [];
let flushing: Promise<void> | null = null;

async function flush(): Promise<void> {
  while (unsaved.length) {
    const batch = unsaved.splice(0, 500);
    const values = batch.map(() => '(?, ?, ?)').join(', ');
    try {
      await run(`INSERT INTO id_map (uuid, kind, ext_id) VALUES ${values} ON CONFLICT DO NOTHING`, ...batch.flatMap((b) => [b.uuid, b.kind, b.extId]));
    } catch (error) {
      console.error('[id_map] could not save ids, will retry:', (error as Error).message);
      unsaved.push(...batch);
      return;
    }
  }
}

/** Resolves once every id handed out so far is saved. */
export function flushIds(): Promise<void> {
  flushing ??= flush().finally(() => (flushing = null));
  return flushing;
}

export function uuidFor(kind: IdKind, extId: string | number): string {
  const key = `${kind}:${extId}`;
  const cached = forward.get(key);
  if (cached) return cached;
  const hex = createHash('sha256').update(`risips-admin:${key}`).digest('hex');
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  forward.set(key, uuid);
  backward.set(uuid, { kind, extId: String(extId) });
  unsaved.push({ uuid, kind, extId: String(extId) });
  if (unsaved.length === 1) setImmediate(() => void flushIds());
  return uuid;
}

/** The app backend's id behind a UUID this server handed out, or null. */
export async function extIdOf(kind: IdKind, uuid: string): Promise<string | null> {
  const id = uuid.toLowerCase();
  const known = backward.get(id);
  if (known) return known.kind === kind ? known.extId : null;
  const row = await one<{ ext_id: string }>('SELECT ext_id FROM id_map WHERE uuid = ? AND kind = ?', id, kind);
  if (row) backward.set(id, { kind, extId: row.ext_id });
  return row?.ext_id ?? null;
}

export const newId = (): string => randomUUID();
