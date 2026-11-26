// Changes an agent may ask for but not make alone (MCP-3). Marking a thread not mine hides it from every read, and
// undoing a run removes what the run made: an agent misled by text in the record could do either to hide something
// from the user. So not_mine and undo_run only file a request here, and nothing changes until the user confirms it,
// with `skeinwise mcp confirm <n>` or from the app (which calls confirmRequest). `skeinwise mcp refuse <n>` drops one.
//
// Requests sit in mcp-requests.json (0600) in the record folder, so every server and the app see the same list. A
// request waits seven days at most; an agent asking twice for the same change gets the waiting request back.

import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UsageError } from '../errors.ts';
import { getRun, undoRun } from '../organiser/runs.ts';
import type { Store } from '../store/store.ts';
import { AGENT_ENGINE } from './tags.ts';

export const REQUESTS_FILE = 'mcp-requests.json';
export const KEEP_DAYS = 7;

export type RequestKind = 'not_mine' | 'undo_run';

export interface McpRequest {
  id: number;
  /** The allowed agent that asked, from its token. */
  agent: string;
  tool: RequestKind;
  /** The thread (not_mine) or run (undo_run). */
  target: number;
  /** What confirming does, in words, for the list. */
  what: string;
  at: string;
}

interface Saved {
  next: number;
  requests: McpRequest[];
}

function load(home: string, now: string): Saved {
  const file = join(home, REQUESTS_FILE);
  if (!existsSync(file)) return { next: 1, requests: [] };
  let raw: Partial<Saved>;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Saved>;
  } catch (err) {
    throw new Error(`${file} isn't valid JSON (${(err as Error).message}). Delete it to drop every waiting agent request.`);
  }
  const cutoff = Date.parse(now) - KEEP_DAYS * 24 * 60 * 60 * 1000;
  const requests = (Array.isArray(raw.requests) ? raw.requests : []).filter(
    (r) => Number.isInteger(r.id) && (r.tool === 'not_mine' || r.tool === 'undo_run') && Number.isInteger(r.target) && Date.parse(r.at) >= cutoff,
  );
  const next = Math.max(Number.isInteger(raw.next) ? raw.next! : 1, ...requests.map((r) => r.id + 1));
  return { next, requests };
}

function save(home: string, saved: Saved): void {
  const file = join(home, REQUESTS_FILE);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
  chmodSync(`${file}.tmp`, 0o600);
  renameSync(`${file}.tmp`, file);
}

/** Files a request, or returns the same agent's waiting request for the same change. */
export function fileRequest(home: string, request: Omit<McpRequest, 'id' | 'at'>, now: string): McpRequest {
  const saved = load(home, now);
  const same = saved.requests.find((r) => r.agent === request.agent && r.tool === request.tool && r.target === request.target);
  if (same) return same;
  const made: McpRequest = { id: saved.next, ...request, at: now };
  save(home, { next: saved.next + 1, requests: [...saved.requests, made] });
  return made;
}

/** The requests waiting for the user, oldest first. */
export function pendingRequests(home: string, now: string): McpRequest[] {
  return load(home, now).requests;
}

function take(home: string, id: number, now: string): McpRequest {
  const saved = load(home, now);
  const found = saved.requests.find((r) => r.id === id);
  if (!found) throw new UsageError(`No agent request ${id} is waiting. "skeinwise mcp pending" lists them.`);
  save(home, { ...saved, requests: saved.requests.filter((r) => r.id !== id) });
  return found;
}

/** Checks that an agent may ask to undo this run: it exists, it is the agent's own, and it can still be undone. */
export function checkUndo(store: Store, agent: string, runId: number): void {
  const run = getRun(store.db, runId);
  if (!run) throw new UsageError(`There is no run ${runId}.`);
  if (run.engine !== AGENT_ENGINE || run.model?.toLowerCase() !== agent.toLowerCase()) {
    throw new UsageError(`Run ${runId} wasn't made by ${agent}, so ${agent} can't undo it.`);
  }
  if (run.status === 'undone') throw new UsageError(`Run ${runId} is already undone.`);
}

export interface Confirmed {
  request: McpRequest;
  result: Record<string, unknown>;
}

/**
 * Makes the change a request asked for, as the user's own decision. The request goes either way: a change that can no
 * longer be made (the thread is gone, the run undone) is refused with the reason.
 */
export function confirmRequest(home: string, store: Store, id: number, now: string): Confirmed {
  const request = take(home, id, now);
  if (request.tool === 'not_mine') {
    if (!store.visibleThread(request.target)) throw new UsageError(`Thread ${request.target} is already left out or gone, so request ${id} is dropped.`);
    store.setNotMine(request.target, true);
    return { request, result: { thread_id: request.target, not_mine: true } };
  }
  checkUndo(store, request.agent, request.target);
  const undone = undoRun(store.db, request.target, home, store.now);
  return { request, result: { run_id: request.target, status: undone.run.status, removed: undone.removed } };
}

/** Drops a request without making its change. */
export function refuseRequest(home: string, id: number, now: string): McpRequest {
  return take(home, id, now);
}
