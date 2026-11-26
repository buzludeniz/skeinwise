// Changes an agent may ask for but not make alone (MCP-3). Marking a thread not mine hides it from every read, and
// undoing a run removes what the run made: an agent misled by text in the record could do either to hide something
// from the user. So not_mine and undo_run only file a request here, and nothing changes until the user confirms it,
// with `skeinwise mcp confirm <n>` or from the app (which calls confirmRequest). `skeinwise mcp refuse <n>` drops one.
//
// Requests sit in mcp-requests.json (0600) in the record folder, so every server and the app see the same list. A
// request waits seven days at most; an agent asking twice for the same change gets the waiting request back.
//
// Each agent's server, the CLI and the app are separate processes, so filing, confirming and dropping a request take
// turns through mcp-requests.json.lock, held from the list's read to its write: two requests never get the same id, and
// none is written over. A lock whose process has died, or that is older than any holder keeps it, is freed.

import { randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, linkSync, lstatSync, openSync, readFileSync, renameSync, type Stats, unlinkSync, writeSync } from 'node:fs';
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

/** O_NOFOLLOW where the system has it. Windows has none; there a name already taken counts as taken (see takeLock). */
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const CREATE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW;

function save(home: string, saved: Saved): void {
  const file = join(home, REQUESTS_FILE);
  // A new name of this writer's own: never another writer's half-written file, and never a link planted at a known name.
  const tmp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  const fd = openSync(tmp, CREATE, 0o600);
  try {
    writeSync(fd, `${JSON.stringify(saved, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, file);
  } catch (err) {
    unlinkSync(tmp);
    throw err;
  }
}

/** How long a process waits for another's lock before it gives up. */
const LOCK_WAIT_MS = 5000;
/** A lock older than this is a dead holder's, whatever its pid says: a holder keeps it for milliseconds. */
const LOCK_STALE_MS = 30_000;

/** Runs fn while this process holds the requests' lock. */
function withLock<T>(home: string, fn: () => T): T {
  const lock = join(home, `${REQUESTS_FILE}.lock`);
  const mine = JSON.stringify({ pid: process.pid, nonce: randomBytes(8).toString('hex') });
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (!takeLock(lock, mine)) {
    if (freeDeadLock(lock)) continue;
    if (Date.now() >= deadline) {
      throw new UsageError(`Another Skeinwise process held ${lock} for over ${LOCK_WAIT_MS / 1000} seconds, so no agent request changed. Try again in a moment.`);
    }
    pause(10 + Math.random() * 20);
  }
  try {
    return fn();
  } finally {
    if (readLock(lock) === mine) unlinkSync(lock);
  }
}

function takeLock(lock: string, mine: string): boolean {
  // Without O_NOFOLLOW (Windows), O_EXCL follows a dangling link and creates its target, so any name there is taken.
  if (!NO_FOLLOW && lstatSync(lock, { throwIfNoEntry: false })) return false;
  let fd: number;
  try {
    fd = openSync(lock, CREATE, 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    writeSync(fd, mine);
  } finally {
    closeSync(fd);
  }
  return true;
}

/** Frees the lock when its holder has died; true when the lock is gone (try again), false when it is held. */
function freeDeadLock(lock: string): boolean {
  const seen = lstatSync(lock, { throwIfNoEntry: false });
  if (!seen) return true;
  if (!seen.isFile()) {
    throw new UsageError(`${lock} is ${seen.isSymbolicLink() ? 'a link' : 'not a file'}, so Skeinwise won't use it as the agent requests' lock. Move it away and try again.`);
  }
  const text = readLock(lock);
  if (text === null) return true;
  if (Date.now() - seen.mtimeMs < LOCK_STALE_MS && holderAlive(text)) return false;
  // Move the dead lock aside under a name of our own, then check it is the one judged dead: another waiter may have freed
  // it and taken the lock since, and that live lock goes back.
  const aside = `${lock}.${randomBytes(8).toString('hex')}.dead`;
  try {
    renameSync(lock, aside);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw err;
  }
  if (!sameLock(seen, text, aside)) {
    try {
      linkSync(aside, lock);
    } catch (err) {
      // EEXIST: a third process took the free name meanwhile. The holder moved aside still releases only its own lock.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  unlinkSync(aside);
  return true;
}

function sameLock(seen: Stats, text: string, moved: string): boolean {
  const now = lstatSync(moved);
  return now.ino === seen.ino && now.mtimeMs === seen.mtimeMs && readLock(moved) === text;
}

/** The lock's text, or null once it is gone. */
function readLock(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Whether the process named in a lock still runs. A lock not yet written (or not ours to read) counts as held. */
function holderAlive(text: string): boolean {
  let pid: unknown;
  try {
    pid = (JSON.parse(text) as { pid?: unknown }).pid;
  } catch {
    return true; // its holder is writing it now; the age check frees it if the holder died mid-write
  }
  if (!Number.isInteger(pid) || (pid as number) <= 0) return true;
  if (pid === process.pid) return true;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));
function pause(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

/** Files a request, or returns the same agent's waiting request for the same change. */
export function fileRequest(home: string, request: Omit<McpRequest, 'id' | 'at'>, now: string): McpRequest {
  return withLock(home, () => {
    const saved = load(home, now);
    const same = saved.requests.find((r) => r.agent === request.agent && r.tool === request.tool && r.target === request.target);
    if (same) return same;
    const made: McpRequest = { id: saved.next, ...request, at: now };
    save(home, { next: saved.next + 1, requests: [...saved.requests, made] });
    return made;
  });
}

/** The requests waiting for the user, oldest first. */
export function pendingRequests(home: string, now: string): McpRequest[] {
  return load(home, now).requests;
}

function take(home: string, id: number, now: string): McpRequest {
  return withLock(home, () => {
    const saved = load(home, now);
    const found = saved.requests.find((r) => r.id === id);
    if (!found) throw new UsageError(`No agent request ${id} is waiting. "skeinwise mcp pending" lists them.`);
    save(home, { ...saved, requests: saved.requests.filter((r) => r.id !== id) });
    return found;
  });
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
