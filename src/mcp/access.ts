// Which agents may use the record through the memory and window servers, and the lock that stops them all. Both live in
// agents.json in the record folder, so the app, the command line and every running server see the same answer; each
// tool call reads the file again, so allowing, revoking and locking take effect at once.
//
// An agent is known by the name its MCP client gives (clientInfo.name). That name is a consent gate against an agent
// you never meant to connect, not a password: any program you run as yourself can claim any name.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UsageError } from '../errors.ts';

export const ACCESS_FILE = 'agents.json';

export interface Access {
  locked: boolean;
  /** Allowed agents' names, each with when it was allowed. */
  allowed: Record<string, string>;
  /** Agents that asked and haven't been allowed, each with when it last asked. */
  asked: Record<string, string>;
}

/** A tool refused because of the lock or a missing allowance: the agent sees the message, the record is untouched. */
export class AccessError extends Error {}

/** Names that already mean something as a version's editor. */
const RESERVED = new Set(['you', 'import']);
const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._@+/-]{0,63}$/;

/** The agent's name as given, checked: one line of plain characters, and not a name Skeinwise uses itself. */
export function checkAgentName(name: unknown): string {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n) throw new UsageError('Give the agent\'s name, as its MCP client reports it (for example claude-code).');
  if (!NAME.test(n)) {
    throw new UsageError(`"${n}" can't be an agent's name here: use up to 64 letters, digits, spaces and . _ @ + / -, starting with a letter or digit.`);
  }
  if (RESERVED.has(n.toLowerCase())) throw new UsageError(`"${n}" is how Skeinwise names its own edits, so no agent can use it.`);
  return n;
}

export function readAccess(home: string): Access {
  const file = join(home, ACCESS_FILE);
  if (!existsSync(file)) return { locked: false, allowed: {}, asked: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file} isn't valid JSON (${(err as Error).message}). Fix or delete it; deleting it locks out every agent until you allow them again.`);
  }
  const r = (raw ?? {}) as Partial<Access>;
  return { locked: r.locked === true, allowed: { ...(r.allowed ?? {}) }, asked: { ...(r.asked ?? {}) } };
}

function writeAccess(home: string, access: Access): void {
  const file = join(home, ACCESS_FILE);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(access, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

/** The allowed name matching this one, ignoring case. */
function find(names: Record<string, string>, name: string): string | undefined {
  return Object.keys(names).find((k) => k.toLowerCase() === name.toLowerCase());
}

export function allowAgent(home: string, name: string, now: string): { name: string; already: boolean } {
  const n = checkAgentName(name);
  const access = readAccess(home);
  const known = find(access.allowed, n);
  if (known) return { name: known, already: true };
  access.allowed[n] = now;
  const asked = find(access.asked, n);
  if (asked) delete access.asked[asked];
  writeAccess(home, access);
  return { name: n, already: false };
}

export function revokeAgent(home: string, name: string): string {
  const n = checkAgentName(name);
  const access = readAccess(home);
  const known = find(access.allowed, n);
  if (!known) throw new UsageError(`"${n}" isn't allowed, so there is nothing to revoke. "skeinwise mcp agents" lists the allowed agents.`);
  delete access.allowed[known];
  writeAccess(home, access);
  return known;
}

export function setLocked(home: string, locked: boolean): boolean {
  const access = readAccess(home);
  const was = access.locked;
  if (was !== locked) writeAccess(home, { ...access, locked });
  return was;
}

/**
 * Lets a tool call through, or throws an AccessError the agent can show you. A name that isn't allowed is remembered
 * as having asked, so "skeinwise mcp agents" and the app can offer to allow it.
 */
export function checkAccess(home: string, agent: string | null, now: string): string {
  const access = readAccess(home);
  if (access.locked) throw new AccessError('Skeinwise is locked, so its tools are stopped. Unlock it in the app, or run: skeinwise mcp unlock');
  if (!agent) {
    throw new AccessError("This MCP client didn't give a name (clientInfo.name), so Skeinwise can't tell which agent is asking. Set a client name and connect again.");
  }
  const n = checkAgentName(agent);
  const known = find(access.allowed, n);
  if (known) return known;
  access.asked[find(access.asked, n) ?? n] = now;
  writeAccess(home, access);
  throw new AccessError(`Skeinwise hasn't allowed "${n}" to read or write your record yet. Allow it in the app, or run: skeinwise mcp allow ${quoteArg(n)}`);
}

/** The name as one shell argument. */
export function quoteArg(name: string): string {
  return /^[A-Za-z0-9._@+/-]+$/.test(name) ? name : `'${name.replace(/'/g, "'\\''")}'`;
}
