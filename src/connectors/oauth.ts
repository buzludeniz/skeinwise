// Signing in with OAuth from the command line: the browser shows the service's own consent page, and the service
// sends the browser back to a one-off listener on 127.0.0.1 with a code, which is swapped for a token. PKCE (RFC 7636)
// binds the code to this run, and a random state rejects any request this run didn't start. The person brings their
// own OAuth client; nothing here ships with a client ID or secret.

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { UsageError } from '../errors.ts';
import { ConnectorError, type Client, type Token } from './types.ts';

export interface OAuthProvider {
  /** "Google": how messages name it. */
  name: string;
  authorizeUrl: string;
  tokenUrl: string;
  pkce: boolean;
  /** 0: any free port (Google's desktop clients accept any loopback port). Otherwise the port registered with the app. */
  port: number;
  /** Extra authorization parameters, e.g. Google's offline access for a refresh token. */
  extra: Record<string, string>;
  scopeSeparator: string;
  /** Whether the person's client needs a secret for the code exchange. */
  secret: 'optional' | 'required';
}

export const GOOGLE: OAuthProvider = {
  name: 'Google',
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  pkce: true,
  port: 0,
  // offline: a refresh token, so a pull an hour later needs no new sign-in. consent: Google shows the scopes every time.
  extra: { access_type: 'offline', prompt: 'consent' },
  scopeSeparator: ' ',
  secret: 'optional',
};

export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

export const TODOIST: OAuthProvider = {
  name: 'Todoist',
  authorizeUrl: 'https://app.todoist.com/oauth/authorize',
  tokenUrl: 'https://api.todoist.com/oauth/access_token',
  pkce: false,
  port: 8735,
  extra: { response_type: 'code' },
  scopeSeparator: ',',
  secret: 'required',
};

export function redirectUri(port: number): string {
  return `http://127.0.0.1:${port}/`;
}

export interface SignInOptions {
  provider: OAuthProvider;
  client: Client;
  scopes: string[];
  fetch: typeof fetch;
  now: () => string;
  /** Opens the sign-in page in the browser. Tests pass a fake browser that follows the redirect itself. */
  openUrl: (url: string) => Promise<void>;
  say: (line: string) => void;
  /** Overrides the provider's port (0 for any). */
  port?: number;
  /** How long to wait for the browser to come back (default 5 minutes). */
  timeoutMs?: number;
}

export interface SignedIn {
  token: Token;
  /** The scopes the service says it granted, when it says. */
  granted: string[] | null;
}

const b64url = (bytes: Buffer) => bytes.toString('base64url');

/** Runs the whole sign-in: listener, browser, code, token. The listener is closed whatever happens. */
export async function signIn(o: SignInOptions): Promise<SignedIn> {
  const { provider } = o;
  if (!o.client.id) throw new UsageError(`${provider.name} sign-in needs your OAuth client ID (--client-id).`);
  if (provider.secret === 'required' && !o.client.secret) throw new UsageError(`${provider.name} sign-in needs your client secret.`);
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(16));
  const server = createServer();
  try {
    const port = await listen(server, o.port ?? provider.port);
    const redirect = redirectUri(port);
    const code = waitForCode(server, state, provider.name, o.timeoutMs ?? 5 * 60_000);
    const params = new URLSearchParams({
      client_id: o.client.id,
      redirect_uri: redirect,
      scope: o.scopes.join(provider.scopeSeparator),
      state,
      ...provider.extra,
    });
    if (provider.pkce) {
      params.set('code_challenge', b64url(createHash('sha256').update(verifier).digest()));
      params.set('code_challenge_method', 'S256');
    }
    if (provider.extra.response_type === undefined) params.set('response_type', 'code');
    const url = `${provider.authorizeUrl}?${params}`;
    o.say(`Opening ${provider.name}'s sign-in page in your browser. If it doesn't open, visit:\n  ${url}`);
    o.openUrl(url).catch(() => o.say("Couldn't open a browser here: open the address above yourself."));
    const form: Record<string, string> = { grant_type: 'authorization_code', code: await code, redirect_uri: redirect, client_id: o.client.id };
    if (o.client.secret) form.client_secret = o.client.secret;
    if (provider.pkce) form.code_verifier = verifier;
    const res = await formPost(o.fetch, provider.tokenUrl, form, provider.name);
    if (res.status !== 200) throw new UsageError(`${provider.name} refused the sign-in: ${describe(res.body)}. Nothing was connected.`);
    return tokenFrom(res.body, o.now(), undefined, provider.name);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

/** Swaps a refresh token for a new access token. A refresh token that was revoked or ran out means "connect again". */
export async function renewToken(
  provider: OAuthProvider,
  client: Client,
  token: Token,
  fetchFn: typeof fetch,
  now: string,
  label: string,
): Promise<Token> {
  if (!token.refresh || !client.id) throw new ConnectorError('signed-out', `${label} needs a new sign-in; connect again`);
  const form: Record<string, string> = { grant_type: 'refresh_token', refresh_token: token.refresh, client_id: client.id };
  if (client.secret) form.client_secret = client.secret;
  let res: { status: number; body: unknown };
  try {
    res = await formPost(fetchFn, provider.tokenUrl, form, provider.name);
  } catch (error) {
    throw new ConnectorError('unavailable', (error as Error).message);
  }
  if (res.status >= 500) throw new ConnectorError('unavailable', `${provider.name} is having trouble (HTTP ${res.status})`);
  if (res.status !== 200) {
    throw new ConnectorError('signed-out', `${label} signed Skeinwise out (${describe(res.body)}); connect again`);
  }
  // Google keeps the refresh token; Todoist sends a new one each time, and the old one stops working.
  return tokenFrom(res.body, now, token.refresh, provider.name).token;
}

/** A form POST that is not to a connector's API: the token, renew and revoke endpoints. */
export async function formPost(
  fetchFn: typeof fetch,
  url: string,
  form: Record<string, string>,
  name: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...headers },
      body: new URLSearchParams(form),
    });
  } catch (error) {
    throw new Error(`couldn't reach ${name}: ${(error as Error).message}`);
  }
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: keep the text for the message.
  }
  return { status: res.status, body };
}

function describe(body: unknown): string {
  const b = body as { error?: unknown; error_description?: string } | null;
  if (b && typeof b.error === 'string') return b.error_description ? `${b.error} (${b.error_description})` : b.error;
  return typeof body === 'string' && body ? body.slice(0, 120) : 'no reason given';
}

function tokenFrom(body: unknown, now: string, keepRefresh: string | undefined, name: string): SignedIn {
  const b = body as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown } | null;
  if (!b || typeof b.access_token !== 'string' || !b.access_token) throw new Error(`${name} sent no access token.`);
  const token: Token = { access: b.access_token };
  const refresh = typeof b.refresh_token === 'string' && b.refresh_token ? b.refresh_token : keepRefresh;
  if (refresh) token.refresh = refresh;
  if (typeof b.expires_in === 'number' && b.expires_in > 0) token.expiresAt = new Date(Date.parse(now) + b.expires_in * 1000).toISOString();
  const granted = typeof b.scope === 'string' ? b.scope.split(/[\s,]+/).filter(Boolean) : null;
  return { token, granted };
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((done, fail) => {
    server.once('error', (error: NodeJS.ErrnoException) =>
      fail(error.code === 'EADDRINUSE' ? new UsageError(`Port ${port} on 127.0.0.1 is in use, so the sign-in can't come back to Skeinwise. Free it and try again.`) : error),
    );
    // 127.0.0.1 only: nothing else on the network can reach the listener.
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      done(typeof address === 'object' && address ? address.port : port);
    });
  });
}

const PAGE = (text: string) =>
  `<!doctype html><meta charset="utf-8"><title>Skeinwise</title><body style="font:16px system-ui;margin:3em">${text}</body>`;

/** The code the browser brings back. Requests without this run's state are turned away and the wait goes on. */
function waitForCode(server: Server, state: string, name: string, timeoutMs: number): Promise<string> {
  return new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new UsageError(`No answer from ${name}'s sign-in page within ${Math.round(timeoutMs / 60000)} minutes. Nothing was connected.`)), timeoutMs);
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const send = (status: number, text: string) => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
        res.end(PAGE(text));
      };
      if (url.pathname !== '/' || url.searchParams.get('state') !== state) {
        send(400, 'This page was not opened by the Skeinwise sign-in. You can close it.');
        return;
      }
      clearTimeout(timer);
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      if (error || !code) {
        send(200, 'Skeinwise was not connected. You can close this tab.');
        fail(new UsageError(`${name}'s sign-in ended without access (${error ?? 'no code'}). Nothing was connected.`));
        return;
      }
      send(200, 'Skeinwise can now read what you allowed. You can close this tab and go back to the terminal.');
      done(code);
    });
  });
}
