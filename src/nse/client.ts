// NSE Invest (NMF II) API client: the "Common Authentication for All APIs" and the connection rules NSE publishes
// ("Connection level pre-requisite for API connection of NSEINVEST"): TLS 1.3 only, and browser-like headers on
// every call, or NSE's firewall drops the request as a bot. Ported from the NSE sip-flow project (nseAuth.js,
// nseClient.js), which is tested on UAT and prod.
import { createCipheriv, pbkdf2Sync, randomBytes, randomInt } from 'node:crypto';
import { Agent, request } from 'node:https';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';

import { config, nseIsLive } from '../config.ts';

const ApiPrefix = '/nsemfdesk/api/v2';

export class NseError extends Error {
  readonly status: number | null;
  readonly body: unknown;
  constructor(message: string, status: number | null = null, body: unknown = null) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/**
 * encrypted = base64(hex(iv) + "::" + hex(salt) + "::" + AES-128-CBC(PBKDF2-SHA1(apiKeyMember, salt, 1000), secret|random))
 * A byte-for-byte port of the Postman pre-request script.
 */
export function encryptPassword(apiKeyMember: string, apiSecretUser: string, random = randomInt(1, 10_000_000_000)): string {
  const iv = randomBytes(16);
  const salt = randomBytes(16);
  const key = pbkdf2Sync(Buffer.from(apiKeyMember, 'utf8'), salt, 1000, 16, 'sha1');
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  const text = Buffer.concat([cipher.update(`${apiSecretUser}|${random}`, 'utf8'), cipher.final()]).toString('base64');
  return Buffer.from(`${iv.toString('hex')}::${salt.toString('hex')}::${text}`, 'utf8').toString('base64');
}

export const nseConfigured = (): boolean =>
  Boolean(config.nse.memberCode && config.nse.apiKeyMember && config.nse.apiSecretUser && config.nse.loginUserId);

// Its own agent: TLS 1.3 only, and NSE is reached directly (never through HTTPS_PROXY), because NSE whitelists
// this machine's IP.
const agent = new Agent({ keepAlive: true, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' });

type Transport = (path: string, body: unknown) => Promise<{ status: number; body: unknown }>;

async function httpsTransport(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const url = new URL(config.nse.baseUrl + ApiPrefix + '/' + path);
  const payload = JSON.stringify(body ?? {});
  const encrypted = encryptPassword(config.nse.apiKeyMember, config.nse.apiSecretUser);
  const headers = {
    memberId: config.nse.memberCode,
    Authorization: 'Basic ' + Buffer.from(`${config.nse.loginUserId}:${encrypted}`, 'utf8').toString('base64'),
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(payload)),
    'User-Agent': 'PostmanRuntime/7.43.0',
    Accept: '*/*',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'en-US',
    Connection: 'keep-alive',
    Referer: 'www.google.com',
  };
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', agent, headers, timeout: config.nse.timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          const raw = Buffer.concat(chunks);
          const encoding = String(res.headers['content-encoding'] ?? '');
          const text = (encoding.includes('gzip') ? gunzipSync(raw) : encoding.includes('deflate') ? inflateSync(raw)
            : encoding.includes('br') ? brotliDecompressSync(raw) : raw).toString('utf8');
          let parsed: unknown = text;
          try { parsed = JSON.parse(text); } catch { /* not JSON */ }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`NSE did not answer in ${config.nse.timeoutMs} ms (blocked by its firewall, or this IP is not whitelisted)`)));
    req.on('error', reject);
    req.end(payload);
  });
}

let transport: Transport = httpsTransport;

/** Tests swap in a fake NSE. */
export function setNseTransport(next: Transport | null): void {
  transport = next ?? httpsTransport;
}

/** POSTs to NSE. HTTP 200 doesn't mean success: callers read reg_status / response_status themselves. */
export async function nsePost(path: string, body: unknown): Promise<any> {
  if (transport === httpsTransport && !nseConfigured()) {
    throw new NseError('NSE is not configured on this server (NSE_MEMBER_CODE, NSE_API_KEY_MEMBER, NSE_API_SECRET_USER).');
  }
  if (nseIsLive() && !config.nse.allowProd) {
    throw new NseError("NSE_BASE_URL is NSE's live account, and NSE_ALLOW_PROD is not set. Writes there need Akash's OK.");
  }
  let res: { status: number; body: unknown };
  try {
    res = await transport(path, body);
  } catch (error) {
    const message = (error as Error).message;
    throw new NseError(/EPROTO|alert|secure channel/i.test(message) ? `${message} (NSE accepts TLS 1.3 only)` : message);
  }
  if (res.status === 403) throw new NseError('NSE refused the call (403): wrong API keys, or this IP is not whitelisted.', 403, res.body);
  if (res.status >= 400) throw new NseError(`NSE answered HTTP ${res.status}.`, res.status, res.body);
  return res.body;
}

/** NSE pads strings with a space. */
export const trim = (value: unknown): string => String(value ?? '').trim();
