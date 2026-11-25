// Shared by the connector tests: a temp record, an in-memory Keychain, a fake network that answers only the calls a
// test lists (anything else throws), and a fake browser that only ever comes back to 127.0.0.1. No test reaches a real
// service, the real Keychain or a browser.

import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Keychain, keychainItems } from '../../src/connectors/keychain.ts';
import { type Connection, putConnection } from '../../src/connectors/state.ts';
import type { ServiceName, Token } from '../../src/connectors/types.ts';
import { openHome } from '../../src/home.ts';
import type { Store } from '../../src/store/store.ts';

export const NOW = '2026-11-25T12:00:00.000Z';

export function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'connectors', name), 'utf8')) as T;
}

export interface Clock {
  now: () => string;
  set: (iso: string) => void;
  /** Moves the clock on by some minutes. */
  add: (minutes: number) => void;
}

export function clock(start = NOW): Clock {
  let t = start;
  return {
    now: () => t,
    set: (iso) => (t = iso),
    add: (minutes) => (t = new Date(Date.parse(t) + minutes * 60_000).toISOString()),
  };
}

export function tempHome(now: () => string): { home: string; store: Store } {
  const home = join(mkdtempSync(join(tmpdir(), 'skeinwise-connectors-')), 'home');
  return { home, store: openHome(home, now) };
}

export class FakeKeychain implements Keychain {
  readonly items = new Map<string, string>();
  async get(item: string) {
    return this.items.get(item) ?? null;
  }
  async set(item: string, secret: string) {
    this.items.set(item, secret);
  }
  async delete(item: string) {
    return this.items.delete(item);
  }
}

export interface Call {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
}

/** Answers a call, or returns undefined to let the next route try. */
export type Route = (call: Call) => Response | undefined | Promise<Response | undefined>;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** A fetch that answers from `routes` and records every call; an unknown call is a test failure, never the network. */
export function fakeFetch(routes: Route[]): typeof fetch & { calls: Call[]; routes: Route[] } {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const body = init?.body instanceof URLSearchParams ? init.body.toString() : typeof init?.body === 'string' ? init.body : '';
    const call: Call = { method: init?.method ?? 'GET', url, headers: new Headers(init?.headers), body };
    calls.push(call);
    for (const route of f.routes) {
      const res = await route(call);
      if (res) return res;
    }
    throw new Error(`No network in this test, but something fetched ${call.method} ${url.origin}${url.pathname}`);
  }) as typeof fetch & { calls: Call[]; routes: Route[] };
  f.calls = calls;
  f.routes = routes;
  return f;
}

/** A route for one method and path (query ignored), answering with `reply`. */
export function on(method: string, url: string, reply: (call: Call) => Response | Promise<Response>): Route {
  const want = new URL(url);
  return (call) =>
    call.method === method && call.url.origin === want.origin && call.url.pathname === want.pathname ? reply(call) : undefined;
}

/** Saves a connection and its token as `connect` would have. */
export async function seedConnection(
  home: string,
  keychain: FakeKeychain,
  connection: Partial<Connection> & { service: ServiceName; account: string },
  token: Token,
  clientSecret?: string,
): Promise<void> {
  putConnection(home, connection.service, { picks: [], since: '2026-09-01T00:00:00.000Z', cursor: null, connectedAt: NOW, ...connection });
  const items = keychainItems(home, connection.service);
  await keychain.set(items.token, JSON.stringify(token));
  if (clientSecret) await keychain.set(items.clientSecret, clientSecret);
}

/** Every file under the record folder, read as text, so a test can check a secret is in none of them. */
export function allFilesText(dir: string): string {
  let text = '';
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    text += statSync(path).isDirectory() ? allFilesText(path) : readFileSync(path).toString('latin1');
  }
  return text;
}

/** A fake browser: follows the sign-in page straight back to the loopback listener, as the person approving would. */
export function approvingBrowser(code = 'test-auth-code', seen: string[] = []): (url: string) => Promise<void> {
  return async (url) => {
    seen.push(url);
    const u = new URL(url);
    const back = new URL(u.searchParams.get('redirect_uri')!);
    back.searchParams.set('code', code);
    back.searchParams.set('state', u.searchParams.get('state')!);
    // The real network, but only to 127.0.0.1: the listener this run opened.
    if (back.hostname !== '127.0.0.1') throw new Error(`The sign-in tried to come back to ${back.hostname}`);
    await globalThis.fetch(back);
  };
}
