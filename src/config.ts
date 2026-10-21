// Server configuration, read from the environment (.env is loaded by `node --env-file-if-exists`).

function env(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  return value;
}

export const config = {
  port: Number(env('PORT', '3005')),
  host: env('HOST', '127.0.0.1'),
  production: env('NODE_ENV', 'development') === 'production',

  /** PostgreSQL (Neon). The pooled endpoint works: queries name their schema, so no session settings are needed. */
  get databaseUrl(): string {
    return required('DATABASE_URL');
  },
  dbSchema: env('DB_SCHEMA', 'admin'),
  dbPoolMax: Number(env('DB_POOL_MAX', '5')),

  /** The app backend's Admin API, e.g. https://api.15-252-244-218.sslip.io/admin/v1. No trailing slash. */
  get upstreamUrl(): string {
    return required('ADMIN_API_BASE_URL').replace(/\/+$/, '');
  },
  get upstreamKey(): string {
    return required('ADMIN_API_KEY');
  },

  /** Authenticator-app step at sign-in. Off by default, like the original API. */
  mfaEnabled: env('STAFF_MFA_ENABLED', 'false') === 'true',
  /**
   * Who may set X-Forwarded-For, comma-separated: "loopback" (the dashboard on the same machine), IP addresses of the
   * dashboard's server (e.g. "3.110.2.48"), or "none". The dashboard passes the staff member's own IP so lockouts and
   * login history see it.
   */
  trustProxy: env('TRUST_PROXY', 'loopback'),

  sessionHours: Number(env('STAFF_SESSION_HOURS', '12')),
  sessionIdleMinutes: Number(env('STAFF_SESSION_IDLE_MINUTES', '60')),
  mfaPendingMinutes: 10,

  /** How long one staff member's investor/order lists are reused between calls (keeps page renders to one fetch). */
  listCacheMs: Number(env('UPSTREAM_LIST_CACHE_MS', '30000')),
  /**
   * Every 30 min by default. A scan whose findings haven't changed doesn't touch the database, so Neon's compute can
   * go to sleep between staff visits (free-tier compute hours run out if something queries it every few minutes).
   */
  complianceIntervalMs: Number(env('COMPLIANCE_SCAN_INTERVAL_MS', String(30 * 60_000))),
  valuationIntervalMs: Number(env('VALUATION_INTERVAL_MS', String(15 * 60_000))),
  /** All orders on this FP tenant go through ONDC; the Admin API doesn't say per order. */
  orderGateway: env('ORDER_GATEWAY', 'ondc'),
};
