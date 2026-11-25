// What every connector shares: the services, the token kept in the Keychain, the ways a pull can fail, and the shape
// of a connector. A connector only reads: no call it makes sends, marks, moves or posts anything.

import type { ThreadInput } from '../store/store.ts';
import type { Api } from './http.ts';
import type { OAuthProvider } from './oauth.ts';

export const SERVICES = ['gmail', 'calendar', 'todoist', 'slack'] as const;
export type ServiceName = (typeof SERVICES)[number];

export function isService(name: string | undefined): name is ServiceName {
  return (SERVICES as readonly string[]).includes(name ?? '');
}

/** What a service gave us to read with. Kept in the Keychain as one item, never on disk or in a log. */
export interface Token {
  access: string;
  refresh?: string;
  /** When the access token stops working (ISO); absent when it doesn't expire. */
  expiresAt?: string;
}

/**
 * Why a pull stopped. `signed-out`: the token was revoked or expired and can't be renewed, so the person has to
 * connect again. `rate-limited`: the service asked us to slow down until `retryAt`. `unavailable`: the network or the
 * service is down. `failed`: anything else, with the service's own words.
 */
export type FailureKind = 'signed-out' | 'rate-limited' | 'unavailable' | 'failed';

export class ConnectorError extends Error {
  readonly kind: FailureKind;
  /** For `rate-limited`: when to try again (ISO). */
  readonly retryAt: string | undefined;

  constructor(kind: FailureKind, message: string, retryAt?: string) {
    super(message);
    this.kind = kind;
    this.retryAt = retryAt;
  }
}

export interface Scope {
  scope: string;
  /** Why the connector needs it, in a few plain words. */
  why: string;
}

export interface PullContext {
  api: Api;
  /** The account the connection reads (an email address or a workspace name). */
  account: string;
  /** What the last pull saved; null on the first pull. Each connector keeps its own shape. */
  cursor: unknown;
  /** The channels or calendars the person picked. */
  picks: string[];
  /** How far back a first pull reaches (ISO). */
  since: string;
  /** When the last pull that worked ended (ISO), for a connector that has to list again; absent before one has. */
  lastPulledAt?: string;
  /** Saves threads at once, through the store's ingest(). */
  emit: (threads: ThreadInput[]) => void;
  /** Saves the cursor. Called only after everything it covers has been emitted. */
  save: (cursor: unknown) => void;
  /** Counts items the service deleted. The record keeps what it already read. */
  deleted: (n: number) => void;
}

export interface Connector {
  service: ServiceName;
  /** How the person knows it: "Gmail". */
  label: string;
  /** What it reads, in one sentence for the consent screen. */
  reads: string;
  scopes: Scope[];
  /** OAuth with a loopback redirect, or a token the person pastes (Slack). */
  signIn: { kind: 'oauth'; provider: OAuthProvider } | { kind: 'token'; how: string };
  /** What the person picks: Slack channels or calendars. */
  picks?: { flag: string; what: string; fallback?: string[] };
  /** The account name for the source label (`gmail:<account>`). */
  identify(api: Api): Promise<string>;
  /** One incremental pull from the saved cursor. */
  pull(ctx: PullContext): Promise<void>;
  /** Revokes the token at the service, where the service allows it. */
  revoke(ctx: RevokeContext): Promise<void>;
}

export interface RevokeContext {
  api: Api;
  token: Token;
  client: Client;
  fetch: typeof fetch;
}

/** The person's own OAuth client. The ID sits in connections.json; a secret, if any, only in the Keychain. */
export interface Client {
  id?: string;
  secret?: string;
}
