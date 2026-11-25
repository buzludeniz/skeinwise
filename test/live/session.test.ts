// L6: a growing Claude Code session is read from where the last read stopped, and what that saves equals what a
// whole read saves. Built from the audit's PoC 16 (a 30,000-line session, then one line appended at a time).

import { describe, expect, it } from 'vitest';
import { parseClaudeCodeSession } from '../../src/importers/chats.ts';
import { bufferReader, type ReadAt, readTail, type SessionState, stateAfterWholeRead, WINDOW } from '../../src/live/session.ts';
import { openDb } from '../../src/store/db.ts';
import { Store } from '../../src/store/store.ts';

const ID = 'e3b0c442-session';

function line(type: 'user' | 'assistant', i: number, text: string, extra: Record<string, unknown> = {}): string {
  return (
    JSON.stringify({
      type,
      sessionId: ID,
      uuid: `u${i}`,
      timestamp: new Date(Date.UTC(2026, 10, 20, 10, 0, i)).toISOString(),
      message: type === 'user' ? { role: 'user', content: text } : { role: 'assistant', content: [{ type: 'text', text }] },
      ...extra,
    }) + '\n'
  );
}

function session(n: number, from = 0): string {
  let text = '';
  for (let i = from; i < from + n; i++) text += line(i % 2 ? 'assistant' : 'user', i, `Message ${i} about the allotment.`);
  return text;
}

function whole(text: string): { thread: ReturnType<typeof parseClaudeCodeSession>; state: SessionState | null } {
  const buf = Buffer.from(text);
  const thread = parseClaudeCodeSession(text, ID);
  return { thread, state: stateAfterWholeRead(buf, thread) };
}

function tail(text: string, state: SessionState) {
  const buf = Buffer.from(text);
  return readTail(bufferReader(buf), buf.length, state, ID);
}

const SOURCE = { kind: 'claude-code', label: 'Claude Code', location: '/projects' };

/** The thread title and the entries a store holds, in thread order. */
function saved(store: Store) {
  return store
    .allEntries()
    .sort((a, b) => a.seq - b.seq)
    .map((e) => ({ id: e.externalId, seq: e.seq, body: e.body, thread: e.threadTitle, at: e.createdAt }));
}

describe('a growing session', () => {
  it('is read from its offset, and saves exactly what a whole read saves', () => {
    const first = session(40);
    const grown = first + session(3, 40);
    const before = whole(first);
    const read = tail(grown, before.state!);
    expect(read.kind).toBe('tail');
    if (read.kind !== 'tail') return;
    expect(read.thread.entries.map((e) => [e.externalId, e.seq])).toEqual([
      ['u40', 40],
      ['u41', 41],
      ['u42', 42],
    ]);
    expect(read.state.offset).toBe(Buffer.byteLength(grown));

    const byTail = new Store(openDb(':memory:'));
    byTail.ingest({ source: SOURCE, threads: [before.thread] });
    byTail.ingest({ source: SOURCE, threads: [read.thread] });
    const byWhole = new Store(openDb(':memory:'));
    byWhole.ingest({ source: SOURCE, threads: [parseClaudeCodeSession(grown, ID)] });
    expect(saved(byTail)).toEqual(saved(byWhole));
    expect(saved(byTail)).toHaveLength(43);

    // And again from the new state.
    const again = tail(grown + session(1, 43), read.state);
    expect(again.kind === 'tail' && again.thread.entries.map((e) => [e.externalId, e.seq])).toEqual([['u43', 43]]);
  });

  it('reads only the appended bytes and the fingerprints, however big the session (PoC 16)', () => {
    const big = session(3000);
    const { state } = whole(big);
    const grown = big + line('user', 3000, 'One more line.');
    const buf = Buffer.from(grown);
    let bytes = 0;
    const counting: ReadAt = (start, length) => {
      const part = buf.subarray(start, start + length);
      bytes += part.length;
      return part;
    };
    const read = readTail(counting, buf.length, state!, ID);
    expect(read.kind).toBe('tail');
    const appended = buf.length - Buffer.byteLength(big);
    expect(bytes).toBeLessThanOrEqual(appended + 4 * WINDOW);
    expect(buf.length).toBeGreaterThan(20 * (appended + 4 * WINDOW));
  });

  it('with nothing new is the same; a line still being written means a whole read', () => {
    const text = session(5);
    const { state } = whole(text);
    expect(tail(text, state!)).toEqual({ kind: 'same' });
    const torn = text + line('user', 5, 'Half a line').slice(0, 30);
    expect(tail(torn, state!)).toEqual({ kind: 'whole', why: 'torn' });
    // A whole read of a file mid-line keeps no state, so the next read is whole too.
    expect(whole(torn).state).toBeNull();
  });

  it('cut short or rewritten is read whole', () => {
    const text = session(200);
    const { state } = whole(text);
    expect(tail(text.slice(0, 1000), state!)).toEqual({ kind: 'whole', why: 'shrunk' });
    expect(tail(text.replace('Message 0 ', 'Message 9 ') + session(1, 200), state!)).toEqual({ kind: 'whole', why: 'rewritten' });
    expect(tail(text.replace('Message 199 ', 'Message 991 ') + session(1, 200), state!)).toEqual({ kind: 'whole', why: 'rewritten' });
  });

  it('is read whole when a tail line has no id of its own', () => {
    const text = session(4);
    const { state } = whole(text);
    const noUuid = JSON.stringify({ type: 'user', sessionId: ID, timestamp: '2026-11-20T11:00:00.000Z', message: { role: 'user', content: 'No uuid here.' } }) + '\n';
    expect(tail(text + noUuid, state!)).toEqual({ kind: 'whole', why: 'fallback id' });
  });

  it('keeps the title a whole read would give', () => {
    // Titled by the user's first line: a summary arriving later retitles it, so that tail is read whole.
    const text = session(4);
    const { state, thread } = whole(text);
    expect(thread.title).toBe('Message 0 about the allotment.');
    expect(state!.session.summaryTitle).toBe(false);
    const summary = JSON.stringify({ type: 'summary', summary: 'Allotment planning' }) + '\n';
    expect(tail(text + summary, state!)).toEqual({ kind: 'whole', why: 'summary' });

    // Titled by a summary: a later summary changes nothing.
    const titled = summary + text;
    const t = whole(titled);
    expect(t.thread.title).toBe('Allotment planning');
    const later = tail(titled + JSON.stringify({ type: 'summary', summary: 'Other' }) + '\n' + session(1, 4), t.state!);
    expect(later.kind === 'tail' && later.thread.title).toBe('Allotment planning');

    // No user line yet: the first one names the session.
    const untitled = line('assistant', 0, 'Ready when you are.');
    const u = whole(untitled);
    expect(u.thread.title).toBe('Coding session');
    expect(tail(untitled + line('user', 1, 'Plan the beds.'), u.state!)).toEqual({ kind: 'whole', why: 'title' });
  });

  it('first read before any line named it takes the id from the first line that does', () => {
    const empty = JSON.stringify({ type: 'file-history-snapshot', messageId: 'x' }) + '\n';
    const thread = parseClaudeCodeSession(empty, ID);
    const state = stateAfterWholeRead(Buffer.from(empty), thread)!;
    expect(state.session.thread).toBe(ID);
    const named = empty + line('user', 0, 'Hello.', { sessionId: 'another-session' });
    expect(readTail(bufferReader(Buffer.from(named)), Buffer.byteLength(named), state, ID)).toEqual({ kind: 'whole', why: 'session id' });
  });
});
