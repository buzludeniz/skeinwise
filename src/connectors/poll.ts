// Pulling from the connections: open each service with its token from the Keychain, run one incremental pull into the
// record through the store's ingest(), and save where it stopped. `pollConnectors` is what `skeinwise live` calls on
// its loop: it never throws for a service's trouble (signed out, slow down, down), it turns it into a status line.

import type { Store } from '../store/store.ts';
import { calendar } from './calendar.ts';
import { gmail } from './gmail.ts';
import { Api, type Dialect } from './http.ts';
import { type Keychain, keychainItems, macKeychain } from './keychain.ts';
import { renewToken } from './oauth.ts';
import { slack } from './slack.ts';
import { type Connection, loadConnections, updateConnection } from './state.ts';
import { todoist } from './todoist.ts';
import { type Client, type Connector, ConnectorError, type FailureKind, type PullContext, type ServiceName, type Token } from './types.ts';

export const CONNECTORS: Record<ServiceName, Connector> = { gmail, calendar, todoist, slack };

const DIALECT: Record<ServiceName, Dialect> = { gmail: 'google', calendar: 'google', todoist: 'todoist', slack: 'slack' };

/** Minutes between pulls of one connection; one when a pull left more to read. */
export const POLL_MINUTES = 5;
const BACKLOG_MINUTES = 1;

export interface ConnectorDeps {
  fetch: typeof fetch;
  keychain: Keychain;
  now: () => string;
  platform: NodeJS.Platform;
}

export function supported(platform: NodeJS.Platform): boolean {
  return platform === 'darwin';
}

export function sourceFor(connection: Pick<Connection, 'service' | 'account'>) {
  return { kind: connection.service, label: `${connection.service}:${connection.account}`, location: connection.account };
}

export function parseToken(raw: string): Token {
  let t: unknown;
  try {
    t = JSON.parse(raw);
  } catch {
    t = null;
  }
  const token = t as Partial<Token> | null;
  if (!token || typeof token.access !== 'string' || !token.access) {
    throw new ConnectorError('signed-out', 'the token in the Keychain is not one Skeinwise wrote; connect again');
  }
  const out: Token = { access: token.access };
  if (typeof token.refresh === 'string') out.refresh = token.refresh;
  if (typeof token.expiresAt === 'string') out.expiresAt = token.expiresAt;
  return out;
}

/** An Api for a token, renewing through the person's own client and keeping each new token in the Keychain. */
export function apiFor(service: ServiceName, token: Token, client: Client, home: string, deps: ConnectorDeps): Api {
  const connector = CONNECTORS[service];
  const items = keychainItems(home, service);
  const signIn = connector.signIn;
  return new Api({
    dialect: DIALECT[service],
    label: connector.label,
    token,
    fetch: deps.fetch,
    now: deps.now,
    ...(signIn.kind === 'oauth'
      ? { renew: (t: Token) => renewToken(signIn.provider, client, t, deps.fetch, deps.now(), connector.label) }
      : {}),
    onToken: (t) => deps.keychain.set(items.token, JSON.stringify(t)),
  });
}

/** The connection's token and client secret from the Keychain. */
export async function credentials(home: string, connection: Connection, deps: ConnectorDeps): Promise<{ token: Token; client: Client }> {
  const items = keychainItems(home, connection.service);
  const raw = await deps.keychain.get(items.token);
  if (raw === null) {
    throw new ConnectorError('signed-out', `${CONNECTORS[connection.service].label} has no token in the Keychain; connect again`);
  }
  const secret = await deps.keychain.get(items.clientSecret);
  const client: Client = {};
  if (connection.clientId) client.id = connection.clientId;
  if (secret) client.secret = secret;
  return { token: parseToken(raw), client };
}

export interface PullCounts {
  added: number;
  versioned: number;
  deleted: number;
  /** Items the service has that a later pull will read (Gmail's queue). */
  more: number;
}

/** One pull of one connection into the record. Throws what the service said; pollConnectors turns it into a line. */
export async function pullOne(store: Store, home: string, connection: Connection, deps: ConnectorDeps): Promise<PullCounts> {
  const connector = CONNECTORS[connection.service];
  const { token, client } = await credentials(home, connection, deps);
  const api = apiFor(connection.service, token, client, home, deps);
  const source = sourceFor(connection);
  const counts: PullCounts = { added: 0, versioned: 0, deleted: 0, more: 0 };
  let cursor = connection.cursor;
  const ctx: PullContext = {
    api,
    account: connection.account,
    cursor,
    picks: connection.picks,
    since: connection.since,
    ...(connection.lastOkAt ? { lastPulledAt: connection.lastOkAt } : {}),
    emit: (threads) => {
      if (!threads.some((t) => t.entries.length)) return;
      const r = store.ingest({ source, threads });
      counts.added += r.added;
      counts.versioned += r.versioned;
    },
    save: (next) => {
      cursor = next;
      updateConnection(home, connection.service, (c) => {
        c.cursor = next;
      });
    },
    deleted: (n) => {
      counts.deleted += n;
    },
  };
  await connector.pull(ctx);
  counts.more = backlog(cursor);
  return counts;
}

/** What a cursor says is left to read: Gmail's queue of message IDs, or a calendar's unfinished listing. */
function backlog(cursor: unknown): number {
  const c = cursor as { pending?: unknown; calendars?: Record<string, { pageToken?: unknown }> } | null;
  if (Array.isArray(c?.pending)) return c.pending.length;
  if (c?.calendars && Object.values(c.calendars).some((x) => typeof x?.pageToken === 'string')) return 1;
  return 0;
}

export interface PollReport {
  service: ServiceName;
  account: string;
  /** Whether this call pulled (false: not due yet, signed out, or left out). */
  pulled: boolean;
  ok: boolean;
  failure?: FailureKind;
  added: number;
  versioned: number;
  deleted: number;
  /** One plain line for the live status. */
  line: string;
}

export interface PollOptions {
  fetch?: typeof fetch;
  keychain?: Keychain;
  now?: () => string;
  platform?: NodeJS.Platform;
  /** Pull every connection now, even one not due or signed out. */
  force?: boolean;
  /** Only this service. */
  only?: ServiceName;
}

export function depsFrom(options: PollOptions, store?: Store): ConnectorDeps {
  return {
    fetch: options.fetch ?? ((...args) => fetch(...args)),
    keychain: options.keychain ?? macKeychain(),
    now: options.now ?? store?.now ?? (() => new Date().toISOString()),
    platform: options.platform ?? process.platform,
  };
}

/**
 * Pulls every connection that is due, one after another, and returns a line for each. A service's trouble is saved
 * as the connection's status and comes back as a line; nothing here throws for it.
 */
export async function pollConnectors(store: Store, home: string, options: PollOptions = {}): Promise<PollReport[]> {
  const deps = depsFrom(options, store);
  const reports: PollReport[] = [];
  for (const connection of loadConnections(home)) {
    if (options.only && connection.service !== options.only) continue;
    reports.push(await pollOne(store, home, connection, deps, options.force ?? false));
  }
  return reports;
}

async function pollOne(store: Store, home: string, c: Connection, deps: ConnectorDeps, force: boolean): Promise<PollReport> {
  const label = CONNECTORS[c.service].label;
  const name = `${label} (${c.account})`;
  const now = deps.now();
  const base = { service: c.service, account: c.account, added: 0, versioned: 0, deleted: 0 };
  const idle = (line: string, ok: boolean): PollReport => ({ ...base, pulled: false, ok, ...(c.failure ? { failure: c.failure } : {}), line });

  if (!supported(deps.platform)) return idle(`${name}: not pulled, connectors work only on macOS for now`, false);
  const source = store.sources().find((s) => s.kind === c.service && s.location === c.account);
  if (source?.status === 'out') return idle(`${name}: left out, so not pulled (skeinwise include ${source.id} to read it again)`, true);
  if (!force && c.failure === 'signed-out') return idle(c.status ?? `${name}: signed out; run: skeinwise connect ${c.service}`, false);
  if (!force && c.nextPollAt && c.nextPollAt > now) {
    return idle(c.status ? `${c.status} · next pull ${relative(now, c.nextPollAt)}` : `${name}: next pull ${relative(now, c.nextPollAt)}`, !c.failure);
  }

  try {
    const counts = await pullOne(store, home, c, deps);
    const done = deps.now();
    const next = new Date(Date.parse(done) + (counts.more ? BACKLOG_MINUTES : POLL_MINUTES) * 60_000).toISOString();
    const line = `${name}: ${countsLine(counts, label)}`;
    updateConnection(home, c.service, (x) => {
      x.lastPollAt = done;
      x.lastOkAt = done;
      x.nextPollAt = next;
      x.status = line;
      delete x.failure;
    });
    return { ...base, pulled: true, ok: true, added: counts.added, versioned: counts.versioned, deleted: counts.deleted, line };
  } catch (error) {
    const failure = error instanceof ConnectorError ? error.kind : 'failed';
    const message = (error as Error).message;
    const done = deps.now();
    let next: string | undefined = new Date(Date.parse(done) + POLL_MINUTES * 60_000).toISOString();
    let line: string;
    if (failure === 'signed-out') {
      next = undefined;
      line = `${name}: ${message}. Run: skeinwise connect ${c.service}`;
    } else if (failure === 'rate-limited') {
      const retry = error instanceof ConnectorError && error.retryAt ? error.retryAt : next;
      next = retry;
      line = `${name}: ${message}; what was read so far is saved, trying again ${relative(done, retry)}`;
    } else {
      line = `${name}: ${message}; trying again ${relative(done, next)}`;
    }
    updateConnection(home, c.service, (x) => {
      x.lastPollAt = done;
      if (next) x.nextPollAt = next;
      else delete x.nextPollAt;
      x.status = line;
      x.failure = failure;
    });
    return { ...base, pulled: true, ok: false, failure, line };
  }
}

export function countsLine(c: PullCounts, label: string): string {
  const parts: string[] = [];
  if (c.added) parts.push(`${c.added} new`);
  if (c.versioned) parts.push(`${c.versioned} changed`);
  if (c.deleted) parts.push(`${c.deleted} deleted in ${label} (kept here)`);
  const head = parts.length ? parts.join(', ') : 'nothing new';
  return c.more ? `${head}; more to read on the next pull` : head;
}

/** "in 5 minutes", "in 1 hour", "now". */
export function relative(fromIso: string, toIso: string): string {
  const mins = Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60_000);
  if (mins <= 0) return 'now';
  if (mins < 90) return `in ${mins} minute${mins === 1 ? '' : 's'}`;
  const hours = Math.round(mins / 60);
  return `in ${hours} hour${hours === 1 ? '' : 's'}`;
}
