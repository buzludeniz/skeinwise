// Growing Claude Code sessions, read from where the last read stopped (L6). A session file only ever grows by whole
// lines, so once a read has covered it up to a newline, a later read that finds the same first bytes and the same bytes
// before that point needs only what came after. What it saves must equal what a whole read would save: the same thread,
// title, entry ids and order. Whenever a tail can't promise that, the answer is a whole read.

import { createHash } from 'node:crypto';
import { parseClaudeCodeSession } from '../importers/chats.ts';
import { FileReport, firstLine, parseJsonl } from '../importers/util.ts';
import { type EntryInput, normalizeText, type ThreadInput } from '../store/store.ts';

/** Bytes fingerprinted at the start of the file and before the read offset. */
export const WINDOW = 4096;

/** Reads `length` bytes at `start` (fewer at the end of the file). */
export type ReadAt = (start: number, length: number) => Buffer;

/** What a later read of a session needs from the one before it. */
export interface SessionCursor {
  /** The thread's id and title as the last whole read gave them. */
  thread: string;
  title: string;
  /** Usable entries read so far: the next entry's place in the thread. */
  entries: number;
  /** Whether the title came from a `summary` line, which a later one doesn't change. */
  summaryTitle: boolean;
  /** Whether any entry so far is the user's, whose first line names an untitled session. */
  hasYou: boolean;
}

export interface SessionState {
  /** Bytes covered, up to and including the last newline. */
  offset: number;
  head: string;
  tail: string;
  session: SessionCursor;
}

export type TailRead =
  | { kind: 'same' }
  | { kind: 'whole'; why: 'shrunk' | 'rewritten' | 'torn' | 'summary' | 'fallback id' | 'session id' | 'title' | 'warning' }
  | { kind: 'tail'; thread: ThreadInput; state: SessionState };

const sha = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');
const usable = (entries: EntryInput[]) => entries.filter((e) => normalizeText(e.body).length > 0);

/** The fingerprints of the first bytes and of the bytes before `offset`. */
export function fingerprints(read: ReadAt, offset: number): { head: string; tail: string } {
  const from = Math.max(0, offset - WINDOW);
  return { head: sha(read(0, Math.min(WINDOW, offset))), tail: sha(read(from, offset - from)) };
}

/** A {@link ReadAt} over bytes already in memory. */
export function bufferReader(buf: Buffer): ReadAt {
  return (start, length) => buf.subarray(start, start + length);
}

/**
 * The state a whole read of a session leaves for the next one, or null when the next read must be whole too: the file
 * doesn't end with a newline (a line was still being written).
 */
export function stateAfterWholeRead(buf: Buffer, thread: ThreadInput): SessionState | null {
  if (!buf.length || buf[buf.length - 1] !== 0x0a) return null;
  const firstYou = thread.entries.find((e) => e.speaker === 'you');
  return {
    offset: buf.length,
    ...fingerprints(bufferReader(buf), buf.length),
    session: {
      thread: thread.externalId,
      title: thread.title,
      entries: usable(thread.entries).length,
      // The parser's title is the first summary, else the user's first line, else a stock name.
      summaryTitle: thread.title !== (firstLine(firstYou?.body ?? '') || 'Coding session'),
      hasYou: firstYou !== undefined,
    },
  };
}

/** Reads what a session gained since `state`, or says why it must be read whole. */
export function readTail(read: ReadAt, size: number, state: SessionState, fallbackId: string): TailRead {
  if (size < state.offset) return { kind: 'whole', why: 'shrunk' };
  const now = fingerprints(read, state.offset);
  if (now.head !== state.head || now.tail !== state.tail) return { kind: 'whole', why: 'rewritten' };
  if (size === state.offset) return { kind: 'same' };

  const chunk = read(state.offset, size - state.offset);
  // A line still being written: a whole read takes it as the parser does, and waits for the newline to keep a state.
  if (chunk[chunk.length - 1] !== 0x0a) return { kind: 'whole', why: 'torn' };
  const text = chunk.toString('utf8');
  const { session } = state;
  if (!session.summaryTitle && parseJsonl(text).some((l) => l.type === 'summary')) return { kind: 'whole', why: 'summary' };

  const report = new FileReport(`${fallbackId}.jsonl`);
  const parsed = parseClaudeCodeSession(text, fallbackId, report);
  // A line skipped or kept without its time is named by its line number, which only a whole read knows.
  if (report.skipped + report.untimed > 0) return { kind: 'whole', why: 'warning' };
  // Ids made from a line's place in the file differ when counted from the offset.
  const placeId = new RegExp(`^${fallbackId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\d+$`);
  if (parsed.entries.some((e) => placeId.test(e.externalId))) return { kind: 'whole', why: 'fallback id' };
  // A session first read before any line named it takes its id from the first line that does.
  if (session.thread === fallbackId && parsed.externalId !== fallbackId) return { kind: 'whole', why: 'session id' };
  const added = usable(parsed.entries);
  const you = added.some((e) => e.speaker === 'you');
  if (!session.summaryTitle && !session.hasYou && you) return { kind: 'whole', why: 'title' };

  return {
    kind: 'tail',
    thread: {
      externalId: session.thread,
      title: session.title,
      entries: added.map((e, i) => ({ ...e, seq: session.entries + i })),
    },
    state: {
      offset: size,
      ...fingerprints(read, size),
      session: { ...session, entries: session.entries + added.length, hasYou: session.hasYou || you },
    },
  };
}
