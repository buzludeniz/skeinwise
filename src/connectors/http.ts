// The one way a connector reaches its service: GET (and Todoist's read-only sync POST) with the token in the
// Authorization header, never in the URL. It renews an expiring token, and turns the services' ways of saying "signed
// out", "slow down" and "down" into a ConnectorError with a plain message, so a pull never crashes on them.

import { ConnectorError, type Token } from './types.ts';

/** Google, Todoist and Slack each say "slow down" and "signed out" differently. */
export type Dialect = 'google' | 'todoist' | 'slack';

/** A reply the dialect doesn't explain, e.g. Gmail's 404 for a history that is too old or Calendar's 410. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export type Query = Record<string, string | number | boolean | string[] | undefined>;

export interface ApiOptions {
  dialect: Dialect;
  /** "Gmail": how errors name the service. */
  label: string;
  token: Token;
  fetch: typeof fetch;
  now: () => string;
  /** Renews the token with its refresh token. Absent when the service's tokens don't expire. */
  renew?: (token: Token) => Promise<Token>;
  /** Called with every renewed token, so the Keychain keeps the newest. */
  onToken?: (token: Token) => Promise<void>;
}

/** How long to wait when a service says "slow down" without saying for how long. */
const DEFAULT_WAIT_S = 60;
/** Renew a token this long before it runs out. */
const RENEW_EARLY_MS = 60_000;

/** When to try again, from a Retry-After header (seconds or a date). */
export function retryAt(header: string | null, now: string, fallbackS = DEFAULT_WAIT_S): string {
  const base = Date.parse(now);
  if (header) {
    if (/^\d+$/.test(header.trim())) return new Date(base + Number(header.trim()) * 1000).toISOString();
    const at = Date.parse(header);
    if (!Number.isNaN(at)) return new Date(Math.max(at, base)).toISOString();
  }
  return new Date(base + fallbackS * 1000).toISOString();
}

function googleReason(body: unknown): string {
  const error = (body as { error?: { errors?: { reason?: string }[]; status?: string } } | null)?.error;
  return error?.errors?.[0]?.reason ?? error?.status ?? '';
}

function serviceMessage(body: unknown): string {
  if (typeof body === 'string') return body.slice(0, 200);
  const b = body as { error?: unknown; error_description?: string; message?: string } | null;
  if (!b) return '';
  if (typeof b.error === 'string') return b.error_description ? `${b.error}: ${b.error_description}` : b.error;
  const nested = b.error as { message?: string } | undefined;
  return nested?.message ?? b.message ?? '';
}

const SLACK_SIGNED_OUT = new Set(['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive']);

export class Api {
  private token: Token;
  private readonly options: ApiOptions;

  constructor(options: ApiOptions) {
    this.options = options;
    this.token = options.token;
  }

  get currentToken(): Token {
    return this.token;
  }

  async get(url: string, query: Query = {}): Promise<unknown> {
    return (await this.request('GET', withQuery(url, query))).body;
  }

  /** Like get(), and gives the response headers too (Slack names a token's scopes in one). */
  async getWithHeaders(url: string, query: Query = {}): Promise<{ body: unknown; headers: Headers }> {
    return this.request('GET', withQuery(url, query));
  }

  /** A form POST that reads (Todoist's sync without commands). */
  async postForm(url: string, form: Record<string, string>): Promise<unknown> {
    return (await this.request('POST', url, new URLSearchParams(form))).body;
  }

  private async request(method: string, url: string, form?: URLSearchParams): Promise<{ body: unknown; headers: Headers }> {
    const { label } = this.options;
    if (this.expiring()) await this.renew();
    let renewed = false;
    for (;;) {
      let res: Response;
      try {
        res = await this.options.fetch(url, {
          method,
          headers: { authorization: `Bearer ${this.token.access}`, accept: 'application/json' },
          ...(form ? { body: form } : {}),
        });
      } catch (error) {
        throw new ConnectorError('unavailable', `couldn't reach ${label}: ${(error as Error).message}`);
      }
      const body = await readBody(res);
      if (res.status === 401 && this.options.dialect !== 'slack' && this.options.renew && this.token.refresh && !renewed) {
        await this.renew();
        renewed = true;
        continue;
      }
      this.check(res, body);
      return { body, headers: res.headers };
    }
  }

  private expiring(): boolean {
    const at = this.token.expiresAt ? Date.parse(this.token.expiresAt) : NaN;
    return Boolean(this.options.renew && this.token.refresh) && !Number.isNaN(at) && at - RENEW_EARLY_MS <= Date.parse(this.options.now());
  }

  private async renew(): Promise<void> {
    if (!this.options.renew) return;
    this.token = await this.options.renew(this.token);
    await this.options.onToken?.(this.token);
  }

  /** Throws a ConnectorError for the replies every connector treats alike, an ApiError for any other failure. */
  private check(res: Response, body: unknown): void {
    const { dialect, label, now } = this.options;
    const reconnect = `${label} signed Skeinwise out (the access was revoked or ran out); connect again`;
    if (res.status === 429) {
      throw new ConnectorError('rate-limited', `${label} asked Skeinwise to slow down`, retryAt(res.headers.get('retry-after'), now()));
    }
    if (dialect === 'slack' && res.ok) {
      const b = body as { ok?: boolean; error?: string } | null;
      if (b?.ok === false) {
        const code = b.error ?? 'unknown_error';
        if (SLACK_SIGNED_OUT.has(code)) throw new ConnectorError('signed-out', reconnect);
        if (code === 'ratelimited') throw new ConnectorError('rate-limited', `${label} asked Skeinwise to slow down`, retryAt(res.headers.get('retry-after'), now()));
        throw new ApiError(200, body, `${label} said ${code}`);
      }
      return;
    }
    if (res.ok) return;
    if (res.status === 401) throw new ConnectorError('signed-out', reconnect);
    if (dialect === 'google' && res.status === 403 && /rateLimitExceeded|userRateLimitExceeded|RESOURCE_EXHAUSTED/.test(googleReason(body))) {
      throw new ConnectorError('rate-limited', `${label} asked Skeinwise to slow down`, retryAt(res.headers.get('retry-after'), now()));
    }
    if (res.status === 403 && dialect !== 'google') throw new ConnectorError('signed-out', reconnect);
    if (res.status >= 500) throw new ConnectorError('unavailable', `${label} is having trouble (HTTP ${res.status})`);
    const said = serviceMessage(body);
    throw new ApiError(res.status, body, `${label} answered HTTP ${res.status}${said ? `: ${said}` : ''}`);
  }
}

function withQuery(url: string, query: Query): string {
  const u = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) u.searchParams.append(key, v);
    else u.searchParams.set(key, String(value));
  }
  return u.toString();
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
