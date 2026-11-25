// What Skeinwise remembers about each connection, in <record folder>/connections.json (owner-only): the account, the
// person's client ID, what they picked, where the last pull stopped and how it went. Never a token or a secret: those
// live only in the Keychain.

import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type FailureKind, isService, type ServiceName } from './types.ts';

export interface Connection {
  service: ServiceName;
  /** The email address or workspace the connection reads. */
  account: string;
  /** The person's own OAuth client ID (Gmail, Calendar, Todoist). Not a secret. */
  clientId?: string;
  /** The loopback port registered with the person's Todoist app. */
  port?: number;
  /** Slack channels or calendars to read. */
  picks: string[];
  /** How far back the first pull reached (ISO). */
  since: string;
  /** Where the last pull stopped; null until the first one finishes a step. */
  cursor: unknown;
  connectedAt: string;
  lastPollAt?: string;
  /** When the last pull that worked ended. */
  lastOkAt?: string;
  /** No pull before this time (the poll interval, or a service's "slow down"). */
  nextPollAt?: string;
  /** How the last pull went, as one plain line. */
  status?: string;
  failure?: FailureKind;
}

interface ConnectionsFile {
  version: 1;
  connections: Connection[];
}

export function connectionsPath(home: string): string {
  return join(home, 'connections.json');
}

export function loadConnections(home: string): Connection[] {
  const path = connectionsPath(home);
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${path} is not valid JSON. Fix or delete it (your tokens are in the Keychain, not in this file).`);
  }
  const file = parsed as Partial<ConnectionsFile> | null;
  if (!file || file.version !== 1 || !Array.isArray(file.connections)) throw new Error(`${path} is not a connections file Skeinwise knows.`);
  return file.connections.filter((c) => isService(c?.service) && typeof c.account === 'string');
}

/** Writes the whole file at once (a new file renamed over the old), owner-only. */
export function saveConnections(home: string, connections: Connection[]): void {
  const path = connectionsPath(home);
  const next = `${path}.new`;
  const file: ConnectionsFile = { version: 1, connections };
  writeFileSync(next, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  chmodSync(next, 0o600);
  renameSync(next, path);
}

export function findConnection(home: string, service: ServiceName): Connection | undefined {
  return loadConnections(home).find((c) => c.service === service);
}

/** Replaces the service's connection (one per service), or removes it when `connection` is null. */
export function putConnection(home: string, service: ServiceName, connection: Connection | null): void {
  const rest = loadConnections(home).filter((c) => c.service !== service);
  saveConnections(home, connection ? [...rest, connection] : rest);
}

/** Changes one connection in place, re-reading the file first so two pulls never undo each other's cursor. */
export function updateConnection(home: string, service: ServiceName, change: (c: Connection) => void): Connection | undefined {
  const all = loadConnections(home);
  const c = all.find((x) => x.service === service);
  if (!c) return undefined;
  change(c);
  saveConnections(home, all);
  return c;
}
