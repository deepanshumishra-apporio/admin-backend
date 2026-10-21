// The admin database (PostgreSQL): staff, roles, sessions, audit, tickets, alerts, announcements, meetings.
// Investor data never lands here. Investors are referenced by the app backend's id (`user_ext_id`) only.
// Everything lives in its own schema (DB_SCHEMA, default "admin"), so the database can be shared safely.
import pg from 'pg';

import { config } from './config.ts';

const schema = config.dbSchema;
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('DB_SCHEMA must be a plain lower-case identifier.');

const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.dbPoolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
});
pool.on('error', (error) => console.error('[db] idle client error:', error.message));

export type Row = Record<string, unknown>;

const Tables = [
  'roles', 'staff', 'staff_roles', 'sessions', 'login_events', 'audit_log', 'id_map', 'tickets', 'ticket_messages',
  'ticket_events', 'alerts', 'alert_events', 'jobs', 'announcements', 'meetings',
];
// Neon's pooled endpoint (PgBouncer) refuses a per-connection search_path, so queries name the schema themselves:
// a table after FROM / JOIN / INTO / UPDATE is written `schema.table`.
const TableRef = new RegExp(`\\b(FROM|JOIN|INTO|UPDATE)\\s+(${Tables.join('|')})\\b`, 'gi');

/** The ticket number sequence, schema-qualified. */
export const TicketSeq = `${schema}.ticket_seq`;

/** Qualifies table names, and turns the `?` placeholders used throughout into Postgres's `$1, $2, ...`. */
function prepare(text: string): string {
  let n = 0;
  return text.replace(TableRef, `$1 ${schema}.$2`).replace(/\?/g, () => `$${++n}`);
}

type Runner = { query: (text: string, params: unknown[]) => Promise<pg.QueryResult> };

export type Db = {
  all: <T = Row>(sql: string, ...params: unknown[]) => Promise<T[]>;
  one: <T = Row>(sql: string, ...params: unknown[]) => Promise<T | undefined>;
  run: (sql: string, ...params: unknown[]) => Promise<number>;
};

function bind(runner: Runner): Db {
  return {
    all: async <T>(sql: string, ...params: unknown[]) => (await runner.query(prepare(sql), params)).rows as T[],
    one: async <T>(sql: string, ...params: unknown[]) => (await runner.query(prepare(sql), params)).rows[0] as T | undefined,
    run: async (sql: string, ...params: unknown[]) => (await runner.query(prepare(sql), params)).rowCount ?? 0,
  };
}

export const db = bind(pool);
export const { all, one, run } = db;

/** Runs `fn` in one transaction on one connection; a throw rolls it back. */
export async function tx<T>(fn: (q: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(bind(client));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export const nowIso = (): string => new Date().toISOString();

// Times are ISO-8601 text (UTC), compared as strings. Flags are 0/1 integers.
// Sent as one simple-protocol batch, i.e. one transaction on one server connection, so SET LOCAL and the
// transaction-scoped lock hold for all of it even through the pooler.
const Schema = `
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('${schema}:migrate'));
CREATE SCHEMA IF NOT EXISTS ${schema};
SET LOCAL search_path = ${schema};
CREATE TABLE IF NOT EXISTS roles (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  is_system INTEGER NOT NULL DEFAULT 0,
  permissions TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS staff (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  password_hash TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  mfa_secret TEXT,
  mfa_enrolled INTEGER NOT NULL DEFAULT 0,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  deactivated_at TEXT
);
CREATE TABLE IF NOT EXISTS staff_roles (
  staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  role_key TEXT NOT NULL REFERENCES roles(key) ON DELETE CASCADE,
  PRIMARY KEY (staff_id, role_key)
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  mfa_state TEXT NOT NULL,
  mfa_attempts INTEGER NOT NULL DEFAULT 0,
  pending_secret TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS sessions_staff ON sessions(staff_id);
CREATE TABLE IF NOT EXISTS login_events (
  id BIGSERIAL PRIMARY KEY,
  staff_id TEXT,
  email TEXT,
  outcome TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS login_events_staff ON login_events(staff_id, at);
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  staff_id TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  ip TEXT,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS id_map (
  uuid TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  ext_id TEXT NOT NULL,
  UNIQUE (kind, ext_id)
);
CREATE SEQUENCE IF NOT EXISTS ticket_seq;
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  user_ext_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  category TEXT NOT NULL,
  priority TEXT NOT NULL,
  status TEXT NOT NULL,
  channel TEXT NOT NULL,
  assignee_id TEXT REFERENCES staff(id),
  opened_by TEXT REFERENCES staff(id),
  related_type TEXT,
  related_id TEXT,
  sla_due_at TEXT NOT NULL,
  awaiting_staff INTEGER NOT NULL DEFAULT 1,
  first_response_at TEXT,
  resolved_at TEXT,
  closed_at TEXT,
  last_message_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ticket_messages (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  staff_id TEXT REFERENCES staff(id),
  body TEXT NOT NULL,
  internal INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ticket_events (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  staff_id TEXT REFERENCES staff(id),
  from_value TEXT,
  to_value TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  user_ext_id TEXT,
  entity_type TEXT,
  entity_id TEXT,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  assignee_id TEXT REFERENCES staff(id),
  first_detected_at TEXT NOT NULL,
  last_detected_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT REFERENCES staff(id),
  resolution TEXT,
  auto_resolved INTEGER NOT NULL DEFAULT 0,
  last_reminded_at TEXT
);
CREATE TABLE IF NOT EXISTS alert_events (
  id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  staff_id TEXT REFERENCES staff(id),
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  name TEXT PRIMARY KEY,
  last_run_at TEXT,
  last_result TEXT
);
CREATE TABLE IF NOT EXISTS announcements (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  audience TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  send_notification INTEGER NOT NULL,
  show_banner INTEGER NOT NULL,
  tag TEXT,
  banner_title TEXT,
  banner_body TEXT,
  highlight TEXT,
  cta_label TEXT,
  cta_action TEXT,
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  created_by TEXT REFERENCES staff(id),
  approved_by TEXT REFERENCES staff(id),
  submitted_at TEXT,
  approved_at TEXT,
  rejection_reason TEXT,
  cancelled_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  user_ext_id TEXT NOT NULL,
  conducted_by TEXT NOT NULL REFERENCES staff(id),
  recorded_by TEXT NOT NULL REFERENCES staff(id),
  mode TEXT NOT NULL,
  meeting_date TEXT NOT NULL,
  current_profile TEXT NOT NULL,
  recommended_profile TEXT NOT NULL,
  status TEXT NOT NULL,
  notes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
COMMIT;
`;

let ready: Promise<void> | null = null;

/** Creates the schema and tables if they are missing. Idempotent; called once at start-up. */
export function migrate(): Promise<void> {
  ready ??= pool.query(Schema).then(() => undefined);
  return ready;
}

export const closeDb = (): Promise<void> => pool.end();
