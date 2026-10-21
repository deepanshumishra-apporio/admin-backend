// A small router on node:http. Responses use the envelope the dashboard expects:
// success `{ data }`, failure `{ error: { code, message, ...details } }`, 204 for no content.
import type { IncomingMessage, ServerResponse } from 'node:http';

import { config } from './config.ts';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
  static badRequest = (message: string, details?: Record<string, unknown>) => new HttpError(400, 'VALIDATION_ERROR', message, details);
  static notFound = (message = 'Not found.') => new HttpError(404, 'NOT_FOUND', message);
  static forbidden = (message = 'You do not have access to this.') => new HttpError(403, 'FORBIDDEN', message);
  static conflict = (message: string) => new HttpError(409, 'CONFLICT', message);
  /** A dashboard feature the app backend's read-only Admin API cannot support yet. */
  static unavailable = (message: string) => new HttpError(501, 'NOT_AVAILABLE', message);
}

export type Staff = {
  id: string;
  email: string;
  fullName: string;
  status: string;
  mustChangePassword: boolean;
  permissions: Set<string>;
  roles: { key: string; name: string }[];
  lastLoginAt: string | null;
};

export type Ctx = {
  req: IncomingMessage;
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
  ip: string | null;
  userAgent: string | null;
  token: string | null;
  sessionId?: string;
  mfaState?: string;
  staff?: Staff;
};

/** A CSV download instead of JSON. */
export class Csv {
  readonly filename: string;
  readonly content: string;
  constructor(filename: string, content: string) {
    this.filename = filename;
    this.content = content;
  }
}

export type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

type Route = { method: string; parts: string[]; handlers: Handler[] };

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, ...handlers: Handler[]): void {
    this.routes.push({ method, parts: pattern.split('/').filter(Boolean), handlers });
  }
  get = (pattern: string, ...handlers: Handler[]) => this.add('GET', pattern, ...handlers);
  post = (pattern: string, ...handlers: Handler[]) => this.add('POST', pattern, ...handlers);
  put = (pattern: string, ...handlers: Handler[]) => this.add('PUT', pattern, ...handlers);
  patch = (pattern: string, ...handlers: Handler[]) => this.add('PATCH', pattern, ...handlers);
  delete = (pattern: string, ...handlers: Handler[]) => this.add('DELETE', pattern, ...handlers);

  match(method: string, path: string): { handlers: Handler[]; params: Record<string, string> } | 'method' | null {
    const parts = path.split('/').filter(Boolean);
    let pathMatched = false;
    for (const route of this.routes) {
      if (route.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      const ok = route.parts.every((part, i) => {
        if (part.startsWith(':')) {
          params[part.slice(1)] = decodeURIComponent(parts[i]!);
          return true;
        }
        return part === parts[i];
      });
      if (!ok) continue;
      pathMatched = true;
      if (route.method === method) return { handlers: route.handlers, params };
    }
    return pathMatched ? 'method' : null;
  }
}

const MaxBody = 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<any> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MaxBody) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'The request is too large.');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw HttpError.badRequest('The request body is not valid JSON.');
  }
}

const isLoopback = (address: string | undefined) =>
  address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';

const trustedProxies = new Set(config.trustProxy.split(',').map((v) => v.trim()).filter((v) => v && v !== 'loopback' && v !== 'none'));
const trustLoopback = config.trustProxy.split(',').map((v) => v.trim()).includes('loopback');

/** The staff member's IP: the forwarded one only when the dashboard's own server sent it. */
function clientIp(req: IncomingMessage): string | null {
  const remote = req.socket.remoteAddress?.replace(/^::ffff:/, '');
  const forwarded = req.headers['x-forwarded-for'];
  const trusted = (trustLoopback && isLoopback(remote)) || (remote !== undefined && trustedProxies.has(remote));
  if (trusted && typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',').at(-1)!.trim();
  return remote ?? null;
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

export async function handle(router: Router, prefix: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (url.pathname === '/health') return send(res, 200, { data: { ok: true } });
    if (!url.pathname.startsWith(prefix)) throw HttpError.notFound();
    const path = url.pathname.slice(prefix.length) || '/';
    const method = req.method ?? 'GET';
    const found = router.match(method, path);
    if (found === null) throw HttpError.notFound();
    if (found === 'method') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');

    const auth = req.headers.authorization;
    const ctx: Ctx = {
      req,
      method,
      path,
      params: found.params,
      query: url.searchParams,
      body: await readBody(req),
      ip: clientIp(req),
      userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 400) : null,
      token: auth?.startsWith('Bearer ') ? auth.slice(7).trim() || null : null,
    };

    let result: unknown;
    for (const handler of found.handlers) result = await handler(ctx);

    if (result instanceof Csv) {
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${result.filename}"`,
        'cache-control': 'no-store',
      });
      res.end(result.content);
      return;
    }
    if (result === undefined) {
      res.writeHead(204, { 'cache-control': 'no-store' });
      res.end();
      return;
    }
    send(res, 200, { data: result });
  } catch (error) {
    if (error instanceof HttpError) {
      send(res, error.status, { error: { code: error.code, message: error.message, ...error.details } });
      return;
    }
    console.error('[http] unhandled', req.method, url.pathname, error);
    send(res, 500, { error: { code: 'INTERNAL', message: 'Something went wrong on the admin server.' } });
  }
}

// --- input helpers -------------------------------------------------------------------------

export const Uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuidParam(ctx: Ctx, name: string): string {
  const value = ctx.params[name] ?? '';
  if (!Uuid.test(value)) throw HttpError.notFound();
  return value.toLowerCase();
}

/** A comma-separated query value restricted to `allowed`. */
export function listParam<T extends string>(query: URLSearchParams, name: string, allowed: readonly T[]): T[] {
  const raw = query.get(name);
  if (!raw) return [];
  return raw.split(',').map((v) => v.trim()).filter((v): v is T => (allowed as readonly string[]).includes(v));
}

export function pageParams(query: URLSearchParams, fallback = 50, max = 200): { offset: number; limit: number } {
  const limit = Math.min(max, Math.max(1, Number(query.get('limit')) || fallback));
  const offset = Math.max(0, Number(query.get('cursor')) || 0);
  return { offset, limit };
}

export function page<T>(items: T[], offset: number, limit: number): { items: T[]; nextCursor: string | null } {
  const slice = items.slice(offset, offset + limit);
  return { items: slice, nextCursor: offset + limit < items.length ? String(offset + limit) : null };
}

export function str(body: any, name: string, { max = 2000, required = false } = {}): string | null {
  const value = body?.[name];
  if (value === undefined || value === null || value === '') {
    if (required) throw HttpError.badRequest(`${name} is required.`);
    return null;
  }
  if (typeof value !== 'string') throw HttpError.badRequest(`${name} must be text.`);
  const trimmed = value.trim();
  if (required && !trimmed) throw HttpError.badRequest(`${name} is required.`);
  if (trimmed.length > max) throw HttpError.badRequest(`${name} is too long (at most ${max} characters).`);
  return trimmed || null;
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  throw HttpError.badRequest(`${name} must be one of ${allowed.join(', ')}.`);
}

// --- CSV --------------------------------------------------------------------------------------

/** One CSV cell. A leading = + - @ is neutralised so a spreadsheet won't run it as a formula. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(columns: { key: string; label: string }[], rows: Record<string, unknown>[]): string {
  const lines = [columns.map((c) => cell(c.label)).join(',')];
  for (const row of rows) lines.push(columns.map((c) => cell(row[c.key])).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}
