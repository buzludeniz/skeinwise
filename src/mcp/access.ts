// Which agents may use the record through the memory server, what each may do, and the lock that stops them all. They
// live in agents.json in the record folder, so the app, the command line and every running server see the same answer;
// each tool call reads the file again, so allowing, denying and locking take effect on the agent's next call.
//
// An agent is known by its token (MCP-2). `skeinwise mcp allow <agent>` makes one and shows it once; the agent's MCP
// config passes it to the server as SKEINWISE_AGENT_TOKEN, and agents.json keeps only its SHA-256. The name a client
// gives itself (clientInfo.name) is a label for the log and nothing more: any program can claim any name.
//
// Each agent has a scope (MCP-3). Read is the default; write, which adds the note and tag tools, needs --write.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UsageError } from '../errors.ts';

export const ACCESS_FILE = 'agents.json';
/** The environment variable an agent's MCP config sets to the token `mcp allow` printed. */
export const TOKEN_ENV = 'SKEINWISE_AGENT_TOKEN';

export type Scope = 'read' | 'write';

export interface Grant {
  scope: Scope;
  /** When the agent was allowed, or its token last replaced. */
  since: string;
  /** The SHA-256 of the agent's token, in hex. Null for an agent allowed before tokens: it must be allowed again. */
  tokenHash: string | null;
}

export interface Access {
  locked: boolean;
  agents: Record<string, Grant>;
}

/** Who is calling, once the token has been checked. */
export interface Session {
  agent: string;
  scope: Scope;
}

/** A tool refused because of the lock, the token or the scope: the agent sees the message, the record is untouched. */
export class AccessError extends Error {}

/** Names that already mean something as a version's editor. */
const RESERVED = new Set(['you', 'import', 'review']);
const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._@+/-]{0,63}$/;
const HASH = /^[0-9a-f]{64}$/;

/** The agent's name as given, checked: one line of plain characters, and not a name Skeinwise uses itself. */
export function checkAgentName(name: unknown): string {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n) throw new UsageError("Give the agent's name, for example claude-code.");
  if (!NAME.test(n)) {
    throw new UsageError(`"${n}" can't be an agent's name here: use up to 64 letters, digits, spaces and . _ @ + / -, starting with a letter or digit.`);
  }
  if (RESERVED.has(n.toLowerCase())) throw new UsageError(`"${n}" is how Skeinwise names its own edits, so no agent can use it.`);
  return n;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function newToken(): string {
  return `swa_${randomBytes(32).toString('base64url')}`;
}

function grantOf(value: unknown, file: string, name: string): Grant {
  // Before tokens, agents.json held `allowed: {name: date}`: such an agent keeps its place but has no token yet.
  if (typeof value === 'string') return { scope: 'read', since: value, tokenHash: null };
  const g = (value ?? {}) as Partial<Grant>;
  if ((g.scope !== 'read' && g.scope !== 'write') || typeof g.since !== 'string' || !(g.tokenHash === null || (typeof g.tokenHash === 'string' && HASH.test(g.tokenHash)))) {
    throw new Error(`${file} has a broken entry for "${name}". Fix or delete it; deleting it locks out every agent until you allow them again.`);
  }
  return { scope: g.scope, since: g.since, tokenHash: g.tokenHash };
}

export function readAccess(home: string): Access {
  const file = join(home, ACCESS_FILE);
  if (!existsSync(file)) return { locked: false, agents: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file} isn't valid JSON (${(err as Error).message}). Fix or delete it; deleting it locks out every agent until you allow them again.`);
  }
  const r = (raw ?? {}) as { locked?: unknown; agents?: Record<string, unknown>; allowed?: Record<string, unknown> };
  const agents: Record<string, Grant> = {};
  for (const [name, value] of Object.entries({ ...(r.allowed ?? {}), ...(r.agents ?? {}) })) agents[name] = grantOf(value, file, name);
  return { locked: r.locked === true, agents };
}

function writeAccess(home: string, access: Access): void {
  const file = join(home, ACCESS_FILE);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(access, null, 2)}\n`, { mode: 0o600 });
  chmodSync(`${file}.tmp`, 0o600);
  renameSync(`${file}.tmp`, file);
}

/** The allowed name matching this one, ignoring case. */
function find(names: Record<string, unknown>, name: string): string | undefined {
  return Object.keys(names).find((k) => k.toLowerCase() === name.toLowerCase());
}

export interface Allowed {
  name: string;
  scope: Scope;
  /** The new token. Only this answer ever holds it; agents.json keeps its hash. */
  token: string;
  /** The agent was allowed already, and its earlier token stops working now. */
  replaced: boolean;
}

/** Allows an agent with a new token, replacing any token it had. The scope is read unless `write` is given. */
export function allowAgent(home: string, name: string, now: string, scope: Scope = 'read'): Allowed {
  const n = checkAgentName(name);
  const access = readAccess(home);
  const known = find(access.agents, n);
  const token = newToken();
  if (known) delete access.agents[known];
  access.agents[known ?? n] = { scope, since: now, tokenHash: hashToken(token) };
  writeAccess(home, access);
  return { name: known ?? n, scope, token, replaced: known !== undefined };
}

/** Takes an agent's allowance and token back. */
export function denyAgent(home: string, name: string): string {
  const n = checkAgentName(name);
  const access = readAccess(home);
  const known = find(access.agents, n);
  if (!known) throw new UsageError(`"${n}" isn't allowed, so there is nothing to take back. "skeinwise mcp agents" lists the allowed agents.`);
  delete access.agents[known];
  writeAccess(home, access);
  return known;
}

export function setLocked(home: string, locked: boolean): boolean {
  const access = readAccess(home);
  const was = access.locked;
  if (was !== locked) writeAccess(home, { ...access, locked });
  return was;
}

export function isLocked(home: string): boolean {
  return readAccess(home).locked;
}

/** The agent whose token this is, or undefined. Every hash is compared, in constant time. */
export function agentOfToken(access: Access, token: string): string | undefined {
  const presented = Buffer.from(hashToken(token), 'hex');
  let match: string | undefined;
  for (const [name, grant] of Object.entries(access.agents)) {
    if (grant.tokenHash && timingSafeEqual(presented, Buffer.from(grant.tokenHash, 'hex')) && match === undefined) match = name;
  }
  return match;
}

/** The clients `skeinwise connect` knows, for the refusal messages. */
const CONNECT_HINT = 'skeinwise connect claude-code (or codex, cursor, claude-desktop)';

/**
 * Lets a tool call through, or throws an AccessError the agent can show the user. The lock comes first, then the
 * token; `label` (the client's own name for itself) only makes the message clearer.
 */
export function checkAccess(home: string, token: string | null | undefined, label: string | null = null): Session {
  const access = readAccess(home);
  if (access.locked) throw new AccessError('Skeinwise is locked, so its tools are stopped. Unlock with: skeinwise mcp unlock');
  const called = label ? ` (it calls itself "${label.slice(0, 64)}")` : '';
  if (typeof token !== 'string' || !token.trim()) {
    throw new AccessError(
      `This agent${called} has no Skeinwise token, so Skeinwise can't tell which agent is asking. Connect it with: ${CONNECT_HINT}. Or run "skeinwise mcp allow <name>" and give its token to the agent's MCP config as ${TOKEN_ENV}.`,
    );
  }
  const agent = token.length <= 200 ? agentOfToken(access, token.trim()) : undefined;
  if (!agent) {
    throw new AccessError(`This agent's Skeinwise token${called} isn't allowed: it was taken back or replaced, or it is mistyped. Connect the agent again with: ${CONNECT_HINT}.`);
  }
  return { agent, scope: access.agents[agent]!.scope };
}

/** The name as one shell argument. */
export function quoteArg(name: string): string {
  return /^[A-Za-z0-9._@+/-]+$/.test(name) ? name : `'${name.replace(/'/g, "'\\''")}'`;
}
