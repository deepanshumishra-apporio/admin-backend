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
  /**
   * Shared with the dashboard (its ADMIN_API_PROXY_KEY). When the dashboard reaches this API through Caddy, Caddy
   * replaces X-Forwarded-For with the dashboard server's own address; the dashboard then also sends the visitor's IP
   * in X-RiSips-Client-IP with this key, and only then is that IP believed. A HUF consent needs it in production.
   */
  dashboardProxyKey: env('DASHBOARD_PROXY_KEY', ''),

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

  /**
   * NSE Invest (NMF II), for onboarding HUFs. UAT unless NSE_BASE_URL says otherwise; the live account
   * (www.nseinvest.com) is refused unless NSE_ALLOW_PROD=true. This machine's IP must be whitelisted by NSE.
   */
  nse: {
    baseUrl: env('NSE_BASE_URL', 'https://nseinvestuat.nseindia.com').replace(/\/+$/, ''),
    memberCode: env('NSE_MEMBER_CODE', ''),
    loginUserId: env('NSE_LOGIN_USER_ID', 'ADMIN'),
    /** The "Member API Key" (…94BD…): the PBKDF2 passphrase. */
    apiKeyMember: env('NSE_API_KEY_MEMBER', ''),
    /** The "API Secret" (…94BE…): the value that gets encrypted. Swapping the two gives 403. */
    apiSecretUser: env('NSE_API_SECRET_USER', ''),
    allowProd: env('NSE_ALLOW_PROD', 'false') === 'true',
    timeoutMs: Number(env('NSE_TIMEOUT_MS', '60000')),
    /** FATCA UBO_CODE for the karta. Not in NSE's doc; C01 is NSE's own sample value. */
    hufUboCode: env('NSE_HUF_UBO_CODE', 'C01'),
  },
  /** A second staff member must approve a HUF before it is sent to NSE. Only turn off for a one-person test setup. */
  hufSecondApprover: env('HUF_SECOND_APPROVER', 'true') !== 'false',
  /** How often HUFs still waiting on NSE (bank check, registrars, the karta) are re-read. */
  hufStatusIntervalMs: Number(env('HUF_STATUS_INTERVAL_MS', String(30 * 60_000))),
  /**
   * 32 bytes, base64: encrypts what a HUF registration needs in full (PANs, bank account, dates of birth, address).
   * Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   */
  get dataKey(): Buffer {
    const key = Buffer.from(required('ADMIN_DATA_KEY'), 'base64');
    if (key.length !== 32) throw new Error('ADMIN_DATA_KEY must be 32 bytes, base64.');
    return key;
  },
};

export const nseIsLive = (): boolean => /(^|\/\/)(www\.)?nseinvest\.com/i.test(config.nse.baseUrl);
