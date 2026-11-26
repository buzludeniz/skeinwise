import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allowAgent } from '../../src/mcp/access.ts';
import { memoryServer } from '../../src/mcp/commands.ts';
import { MAX_CALL_BYTES } from '../../src/mcp/frame.ts';
import type { McpServer } from '../../src/mcp/protocol.ts';
import type { Caller } from '../../src/mcp/session.ts';
import { finishRun, startRun } from '../../src/organiser/runs.ts';
import { openDb } from '../../src/store/db.ts';
import { type EntryInput, Store } from '../../src/store/store.ts';
import { call, context, demoRecord, initialize } from './helpers.ts';

// What a big record asks of the memory server: a hub with more members than one call can carry comes a page at a time,
// and a server process builds its record view once, again only after the record changes.

const LATER = '2026-11-21T09:00:00.000Z';

let dir: string;
let home: string;
let store: Store;
let server: McpServer<Caller>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'skeinwise-mcp-scale-'));
  home = join(dir, 'home');
  store = demoRecord(dir, home);
  const { token } = allowAgent(home, 'claude-code', LATER, 'write');
  server = memoryServer(context(home, store, { now: () => LATER, token }).ctx);
  await initialize(server, 'claude-code');
});
afterEach(() => {
  vi.restoreAllMocks();
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** `count` notes in a source of their own; returns the source's id and the notes' ids. */
function notes(location: string, count: number, word = 'bulk'): { sourceId: number; ids: number[] } {
  const entries: EntryInput[] = Array.from({ length: count }, (_, n) => ({
    externalId: `${location}-${n}.md`,
    kind: 'note',
    speaker: 'you',
    title: `${word} ${n}`,
    createdAt: '2025-03-01T00:00:00.000Z',
    body: `A ${word} note, number ${n}.`,
  }));
  store.ingest({ source: { kind: 'notes', label: location, location }, threads: [], entries });
  const sourceId = (store.db.prepare('SELECT id FROM sources WHERE location = ?').get(location) as { id: number }).id;
  const ids = (store.db.prepare('SELECT id FROM entries WHERE source_id = ? ORDER BY id').all(sourceId) as { id: number }[]).map((r) => r.id);
  return { sourceId, ids };
}

/** A live hub holding `members`, the organiser's own, with a point citing the first of them. */
function hub(members: number[]): number {
  const run = startRun(store.db, { task: 'hub', engine: 'none', model: null, scope: 'all', mark: 0, now: LATER });
  const sections = { in_short: [{ text: 'Bulk notes, kept for later.', entryId: members[0]!, date: '2025-03-01' }], what_you_found: [], open_ends: [] };
  const hubId = Number(store.db.prepare('INSERT INTO hubs (name, sections, run_id) VALUES (?, ?, ?)').run('bulk', JSON.stringify(sections), run).lastInsertRowid);
  const add = store.db.prepare('INSERT INTO hub_entries (hub_id, entry_id, run_id, score) VALUES (?, ?, ?, 1)');
  for (const id of members) add.run(hubId, id, run);
  finishRun(store.db, run, { counts: {}, tokensIn: 0, tokensOut: 0, now: LATER });
  return hubId;
}

describe('read_hub on a hub bigger than one call', () => {
  // 7,000 four- and five-digit ids are over 32 KB on their own, so the hub's whole list could never go out.
  let shown: number[];
  let hidden: number[];
  let hubId: number;

  beforeEach(() => {
    shown = notes('/bulk/shown', 7000).ids;
    const other = notes('/bulk/hidden', 300);
    hidden = other.ids;
    hubId = hub([...hidden.slice(0, 150), ...shown, ...hidden.slice(150)]);
    store.setSourceStatus(other.sourceId, 'out');
  });

  it("returns the hub's name, its points and a first page of the ids the record shows, with how many there are", async () => {
    const res = await call(server, 'read_hub', { hub_id: hubId });
    expect(res.isError).toBe(false);
    expect(Buffer.byteLength(res.text)).toBeLessThanOrEqual(MAX_CALL_BYTES);
    expect(res.json.truncated).toBe(false);
    expect(res.json.entries).toHaveLength(1);
    const got = res.json.entries[0];
    expect(got).toMatchObject({ id: hubId, name: 'bulk', entry_count: shown.length, offset: 0, next_offset: 1000 });
    expect(got.sections.in_short).toHaveLength(0); // its point cites a hidden note
    expect(got.entry_ids).toEqual(shown.slice(0, 1000));
  });

  it('pages through every id it shows exactly once, in order, and never a hidden one', async () => {
    const seen: number[] = [];
    let offset: number | null = 0;
    let calls = 0;
    while (offset !== null) {
      const res: { json: { truncated: boolean; entries: { entry_ids: number[]; next_offset: number | null }[] } } = await call(server, 'read_hub', {
        hub_id: hubId,
        offset,
        limit: 2000,
      });
      expect(res.json.truncated).toBe(false);
      const got = res.json.entries[0]!;
      expect(got).toMatchObject({ entry_count: shown.length, offset });
      seen.push(...got.entry_ids);
      offset = got.next_offset;
      calls++;
    }
    expect(calls).toBe(4);
    expect(seen).toEqual(shown);
    expect(seen.filter((id) => hidden.includes(id))).toEqual([]);
  });

  it('answers past the end with no ids, and checks its arguments', async () => {
    const past = await call(server, 'read_hub', { hub_id: hubId, offset: 7000 });
    expect(past.json.entries[0]).toMatchObject({ entry_count: 7000, offset: 7000, next_offset: null, entry_ids: [] });
    expect((await call(server, 'read_hub', { hub_id: hubId, limit: 2001 })).text).toBe('limit must be a whole number from 1 to 2000.');
    expect((await call(server, 'read_hub', { hub_id: hubId, offset: -1 })).isError).toBe(true);
  });
});

describe('ask in one server process', () => {
  const question = 'when did I first mention quincewood';
  const ask = async () => {
    const res = await call(server, 'ask', { question });
    expect(res.isError).toBe(false);
    return res.json.entries.map((e: { id: number }) => e.id) as number[];
  };

  it("builds its record view once while the record doesn't change, and again after any write, another process's too", async () => {
    // A note in the notes folder, so each call's read of the folder has a file to compare and must find it unchanged.
    expect((await call(server, 'write_note', { title: 'Shed', body: 'Paint the shed.' })).isError).toBe(false);
    const builds = vi.spyOn(store, 'allEntries');
    expect(await ask()).toEqual([]);
    expect(await ask()).toEqual([]);
    expect(builds).toHaveBeenCalledTimes(1);

    // Another connection to the record, as another Skeinwise process has: an import there shows in the next ask.
    const other = new Store(openDb(join(home, 'record.db')), () => LATER);
    try {
      const { sourceId, ids } = (() => {
        other.ingest({
          source: { kind: 'notes', label: 'elsewhere', location: '/elsewhere' },
          threads: [],
          entries: [{ externalId: 'quince.md', kind: 'note', speaker: 'you', title: 'Quincewood', createdAt: '2025-04-01T00:00:00.000Z', body: 'The quincewood handle split.' }],
        });
        const source = (other.db.prepare("SELECT id FROM sources WHERE location = '/elsewhere'").get() as { id: number }).id;
        return { sourceId: source, ids: (other.db.prepare('SELECT id FROM entries WHERE source_id = ?').all(source) as { id: number }[]).map((r) => r.id) };
      })();
      expect(await ask()).toEqual(ids);
      expect(await ask()).toEqual(ids);
      expect(builds).toHaveBeenCalledTimes(2);

      // A hide there takes it out again.
      other.setSourceStatus(sourceId, 'out');
      expect(await ask()).toEqual([]);
      expect(builds).toHaveBeenCalledTimes(3);
    } finally {
      other.db.close();
    }

    // And a write through this server's own connection.
    const mine = await call(server, 'write_note', { title: 'Quincewood again', body: 'A new quincewood handle.' });
    expect(await ask()).toEqual([mine.json.entry_id]);
    expect(builds).toHaveBeenCalledTimes(4);
  });
});
