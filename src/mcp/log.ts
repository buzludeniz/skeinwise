// What every agent asked the memory server and what it got back (MCP-7). Each tool call, served or refused, adds one
// JSON line to mcp-log.jsonl in the record folder: when, which agent (from its token) and what it called itself, the
// tool, its arguments (redacted and shortened), the ids of the entries or hubs it was sent, the bytes, and whether the
// result was cut. `skeinwise mcp log` reads it back. The file is 0600 like the record; past MAX_LOG_BYTES it moves to
// mcp-log.1.jsonl, replacing the one before, so the log keeps between one and two of those.

import { appendFileSync, chmodSync, existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Redactor } from '../organiser/redact.ts';

export const LOG_FILE = 'mcp-log.jsonl';
export const OLD_LOG_FILE = 'mcp-log.1.jsonl';
export const MAX_LOG_BYTES = 2 * 1024 * 1024;
/** How much of each string argument the log keeps. */
const ARG_CHARS = 200;

export type Outcome = 'ok' | 'refused' | 'error';

export interface LogRecord {
  at: string;
  /** The allowed agent its token named, or null when the call was refused before that was known. */
  agent: string | null;
  /** The name the client gave itself, which proves nothing. */
  label: string | null;
  tool: string;
  args: Record<string, unknown>;
  /** What went out: entry ids, or hub ids for the hub tools. */
  entry_ids?: number[];
  hub_ids?: number[];
  bytes: number;
  truncated: boolean;
  outcome: Outcome;
  /** Why a call was refused or failed: the message the agent saw. */
  reason?: string;
}

/** The arguments as the log keeps them: secrets redacted, long strings shortened, at most 20 items per list. */
export function logArgs(args: Record<string, unknown>): Record<string, unknown> {
  const redactor = new Redactor([], { personal: false });
  const keep = (value: unknown, depth: number): unknown => {
    if (typeof value === 'string') {
      const r = redactor.redact(value.length > ARG_CHARS * 4 ? value.slice(0, ARG_CHARS * 4) : value);
      return r.length > ARG_CHARS ? `${r.slice(0, ARG_CHARS)}… (${value.length} characters)` : r;
    }
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
    if (depth > 2) return '…';
    if (Array.isArray(value)) return value.slice(0, 20).map((v) => keep(v, depth + 1));
    if (typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 20).map(([k, v]) => [k.slice(0, 64), keep(v, depth + 1)]));
    }
    return null;
  };
  return keep(args, 0) as Record<string, unknown>;
}

/** The log couldn't be written. `code` is the system's error code; the message names the file but not its path. */
export class LogError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Skeinwise couldn't write its MCP log (${LOG_FILE}: ${code}), so it sent no result.`);
    this.code = code;
  }
}

/** Adds one record. Throws a LogError when the log can't be written, so no read's result goes out unlogged. */
export function logCall(home: string, record: LogRecord): void {
  const file = join(home, LOG_FILE);
  try {
    if (existsSync(file) && statSync(file).size >= MAX_LOG_BYTES) renameSync(file, join(home, OLD_LOG_FILE));
    const fresh = !existsSync(file);
    appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    if (fresh) chmodSync(file, 0o600);
  } catch (err) {
    // The agent sees this, so it names the file and the error code but not the path, which holds the user's name.
    throw new LogError((err as NodeJS.ErrnoException).code ?? 'unknown error');
  }
}

function readLines(file: string): LogRecord[] {
  if (!existsSync(file)) return [];
  const out: LogRecord[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LogRecord);
    } catch {
      // a line cut off by a crash mid-write: the rest of the log still reads
    }
  }
  return out;
}

/** The last `limit` records, oldest first. */
export function readLog(home: string, limit: number): LogRecord[] {
  const current = readLines(join(home, LOG_FILE));
  const all = current.length >= limit ? current : [...readLines(join(home, OLD_LOG_FILE)), ...current];
  return all.slice(-limit);
}
