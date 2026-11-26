// The per-file state behind live capture (LS-04), one row per watched file in the record's live_files table: the
// version of the file last looked at, how far it was read, and its last error. One file's failure never moves another
// file's state, a failed file is tried again on a schedule (or at once when it changes), and a growing session is
// read from where the last read stopped.

import type { DatabaseSync } from 'node:sqlite';
import type { SessionCursor } from './session.ts';

/** What only live keeps about a file, as JSON in the row's `extra`. */
export interface FileExtra {
  /** SHA-256 of the first bytes and of the bytes before the offset (see `session.ts`): a later read that still finds
   * both is an append, so it can start at the offset. Set only for a Claude Code session. */
  head?: string;
  tail?: string;
  session?: SessionCursor;
}

export interface FileRow {
  path: string;
  /** The watched folder the file was found under. */
  target: string;
  /** The version of the file last looked at, read or failed. */
  size: number | null;
  mtimeMs: number | null;
  /** SHA-256 of the whole file at its last full read; null for a session read from its offset. */
  sha256: string | null;
  /** Bytes read: for a session, up to the end of its last complete line. */
  offset: number;
  lastOkAt: string | null;
  /** When reading this file last saved something new or changed. */
  savedAt: string | null;
  lastError: string | null;
  /** Failures in a row. */
  attempts: number;
  nextTryAt: string | null;
  extra: FileExtra;
}

/** Waits after the 1st, 2nd and 3rd failure in a row; hourly after that. */
const RETRY_MS = [60_000, 5 * 60_000, 30 * 60_000];
const HOURLY = 60 * 60_000;

export function retryDelayMs(attempts: number): number {
  return RETRY_MS[attempts - 1] ?? HOURLY;
}

const SELECT = `SELECT path, target, size, mtime_ms AS mtimeMs, sha256, byte_offset AS offset, last_ok_at AS lastOkAt,
  saved_at AS savedAt, last_error AS lastError, attempts, next_try_at AS nextTryAt, extra FROM live_files`;

type Raw = Omit<FileRow, 'extra'> & { extra: string | null };

function toRow(raw: Raw): FileRow {
  let extra: FileExtra = {};
  if (raw.extra) {
    try {
      extra = JSON.parse(raw.extra) as FileExtra;
    } catch {
      // Unreadable: the file is read whole next time, which rewrites it.
    }
  }
  return { ...raw, extra };
}

export interface ReadOk {
  size: number;
  mtimeMs: number;
  sha256: string | null;
  offset: number;
  extra: FileExtra;
  /** Whether this read saved something new or changed. */
  saved: boolean;
}

export class FileTable {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  get(path: string): FileRow | undefined {
    const raw = this.db.prepare(`${SELECT} WHERE path = ?`).get(path) as Raw | undefined;
    return raw ? toRow(raw) : undefined;
  }

  /** The rows under the given watched folders, by path. */
  under(targets: string[]): FileRow[] {
    if (!targets.length) return [];
    const marks = targets.map(() => '?').join(', ');
    return (this.db.prepare(`${SELECT} WHERE target IN (${marks}) ORDER BY path`).all(...targets) as Raw[]).map(toRow);
  }

  /** A read that worked: the file's new state, and its error cleared. */
  ok(path: string, target: string, read: ReadOk, now: string): void {
    this.db
      .prepare(
        `INSERT INTO live_files (path, target, size, mtime_ms, sha256, byte_offset, last_ok_at, saved_at, last_error, attempts, next_try_at, extra)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, ?)
         ON CONFLICT(path) DO UPDATE SET target = excluded.target, size = excluded.size, mtime_ms = excluded.mtime_ms,
           sha256 = excluded.sha256, byte_offset = excluded.byte_offset, last_ok_at = excluded.last_ok_at,
           saved_at = COALESCE(excluded.saved_at, live_files.saved_at), last_error = NULL, attempts = 0, next_try_at = NULL,
           extra = excluded.extra`,
      )
      .run(path, target, read.size, read.mtimeMs, read.sha256, read.offset, now, read.saved ? now : null, JSON.stringify(read.extra));
  }

  /**
   * A read that failed: the error, and when to try again. What was read before (offset, hash, session) stays, so the
   * next read picks up from the same place. The version that failed is kept, so a change to the file is tried at once.
   */
  fail(path: string, target: string, version: { size: number; mtimeMs: number }, error: string, now: Date): FileRow {
    const attempts = (this.get(path)?.attempts ?? 0) + 1;
    const next = new Date(now.getTime() + retryDelayMs(attempts)).toISOString();
    this.db
      .prepare(
        `INSERT INTO live_files (path, target, size, mtime_ms, byte_offset, last_error, attempts, next_try_at)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET target = excluded.target, size = excluded.size, mtime_ms = excluded.mtime_ms,
           last_error = excluded.last_error, attempts = excluded.attempts, next_try_at = excluded.next_try_at`,
      )
      .run(path, target, version.size, version.mtimeMs, error, attempts, next);
    return this.get(path)!;
  }

  /** When reading a file under the given folders last saved something, or null. */
  lastSavedAt(targets: string[]): string | null {
    if (!targets.length) return null;
    const marks = targets.map(() => '?').join(', ');
    const row = this.db.prepare(`SELECT MAX(saved_at) AS at FROM live_files WHERE target IN (${marks})`).get(...targets) as { at: string | null };
    return row.at;
  }

  /** Forgets a file: it is gone, or no longer under a watched folder. */
  remove(path: string): void {
    this.db.prepare('DELETE FROM live_files WHERE path = ?').run(path);
  }

  /** Forgets every file under a folder that is no longer watched. */
  removeTargetsExcept(targets: string[]): void {
    const marks = targets.map(() => '?').join(', ');
    this.db.prepare(targets.length ? `DELETE FROM live_files WHERE target NOT IN (${marks})` : 'DELETE FROM live_files').run(...targets);
  }
}
