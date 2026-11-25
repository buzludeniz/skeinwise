import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { notesDir } from '../../src/notes.ts';
import { ACCESS_FILE, allowAgent, denyAgent, type Scope, setLocked } from '../../src/mcp/access.ts';
import { memoryServer } from '../../src/mcp/commands.ts';
import { FRAME_CLOSE, FRAME_OPEN, MAX_CALL_BYTES, MAX_SESSION_BYTES } from '../../src/mcp/frame.ts';
import type { McpServer } from '../../src/mcp/protocol.ts';
import type { Caller } from '../../src/mcp/session.ts';
import { AGENT_SCHEMA } from '../../src/mcp/tags.ts';
import { type RunOptions, runSteps, steps } from '../../src/organiser/organise.ts';
import { RecordView } from '../../src/organiser/record.ts';
import { getRun, listRuns } from '../../src/organiser/runs.ts';
import { findSchema, liveHubs, liveTags } from '../../src/organiser/views.ts';
import type { Store } from '../../src/store/store.ts';
import { keyShaped } from '../samples.ts';
import { call, context, demoRecord, initialize, MODERN_VERSION, rpc } from './helpers.ts';

// The memory server's twelve tools, called as an agent would, against a record holding the demo. The agent is the one
// whose token its environment carries; the name its client gives is only a label.

const LATER = '2026-11-21T09:00:00.000Z';
const NONE: Omit<RunOptions, 'task'> = { scope: { kind: 'all' }, engine: 'none', yes: false, budget: 0, progress: () => {} };

let dir: string;
let home: string;
let store: Store;
let server: McpServer<Caller>;

/** A session for `agent`, allowed with `scope`, its client calling itself `label`. */
async function open(agent: string | null, scope: Scope = 'read', label: string | null = agent, token?: string): Promise<McpServer<Caller>> {
  const t = token ?? (agent === null ? undefined : allowAgent(home, agent, LATER, scope).token);
  const s = memoryServer(context(home, store, { now: () => LATER, ...(t ? { token: t } : {}) }).ctx);
  await initialize(s, label);
  return s;
}

const READ_TOOLS = ['search', 'ask', 'read_entry', 'read_thread', 'timeline', 'list_hubs', 'read_hub'];
const WRITE_TOOLS = ['write_note', 'append_daily_note', 'tag_entries', 'not_mine', 'undo_run'];
const listed = async (s: McpServer<Caller>) => ((await rpc(s, 'tools/list')).result as { tools: { name: string }[] }).tools.map((t) => t.name);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'skeinwise-mcp-'));
  home = join(dir, 'home');
  store = demoRecord(dir, home);
  server = await open('claude-code', 'write');
});
afterEach(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function firstHit(query: string): Promise<{ id: number; thread: { id: number } | null }> {
  const res = await call(server, 'search', { query });
  expect(res.isError).toBe(false);
  expect(res.json.entries.length).toBeGreaterThan(0);
  return res.json.entries[0];
}

describe('who may use the tools', () => {
  it("refuses every call without a token, whatever name the client gives", async () => {
    const spoof = await open(null, 'read', 'claude-code');
    for (const [name, args] of [
      ['search', { query: 'starter' }],
      ['read_entry', { entry_id: 1 }],
      ['write_note', { title: 'x', body: 'y' }],
    ] as const) {
      const res = await call(spoof, name, args);
      expect(res).toMatchObject({ isError: true });
      expect(res.text).toMatch(/^This agent \(it calls itself "claude-code"\) has no Skeinwise token/);
      expect(res.text).toContain('skeinwise connect claude-code');
    }
    expect(existsSync(join(notesDir(home), 'x.md'))).toBe(false);
  });

  it('refuses a token it does not know', async () => {
    const res = await call(await open(null, 'read', 'claude-code', `swa_${'A'.repeat(43)}`), 'search', { query: 'starter' });
    expect(res).toMatchObject({ isError: true });
    expect(res.text).toMatch(/^This agent's Skeinwise token \(it calls itself "claude-code"\) isn't allowed/);
  });

  it("takes the agent from the token, not the client's name", async () => {
    const cursor = await open('cursor', 'write', 'claude-code');
    const made = await call(cursor, 'write_note', { title: 'Who wrote this', body: 'Cursor did.' });
    expect(made.isError).toBe(false);
    expect(readFileSync(join(home, 'notes', 'who-wrote-this.md'), 'utf8')).toContain('agent: cursor');
    expect(store.history(made.json.entry_id).map((v) => v.editor)).toEqual(['cursor']);
  });

  it('stops a denied agent on its next call, and a new token replaces the old one', async () => {
    expect((await call(server, 'search', { query: 'starter' })).isError).toBe(false);
    denyAgent(home, 'claude-code');
    expect((await call(server, 'search', { query: 'starter' })).text).toMatch(/token .*isn't allowed/);
    const first = allowAgent(home, 'claude-code', LATER, 'read');
    const second = allowAgent(home, 'claude-code', LATER, 'read');
    expect(second.replaced).toBe(true);
    expect((await call(await open(null, 'read', 'claude-code', first.token), 'search', { query: 'starter' })).isError).toBe(true);
    expect((await call(await open(null, 'read', 'claude-code', second.token), 'search', { query: 'starter' })).isError).toBe(false);
  });

  it('gives a read-scope token the read tools only', async () => {
    const reader = await open('codex');
    expect(await listed(reader)).toEqual(READ_TOOLS);
    expect((await call(reader, 'search', { query: 'starter' })).isError).toBe(false);
    for (const name of WRITE_TOOLS) {
      const res = await call(reader, name, { title: 'x', body: 'y', text: 'z', entry_ids: [1], tag: 't', thread_id: 1, run_id: 1 });
      expect(res).toMatchObject({ isError: true });
      expect(res.text).toMatch(/^not allowed: read scope\. codex may only read the record/);
      expect(res.text).toContain('skeinwise mcp allow codex --write');
    }
    expect(existsSync(join(notesDir(home), 'x.md'))).toBe(false);
    expect(await listed(server)).toEqual([...READ_TOOLS, ...WRITE_TOOLS]);
    expect(await listed(await open(null))).toEqual(READ_TOOLS);
  });

  it('asks an agent allowed before tokens to connect again', async () => {
    writeFileSync(join(home, ACCESS_FILE), JSON.stringify({ locked: false, allowed: { 'claude-code': LATER }, asked: {} }));
    const res = await call(server, 'search', { query: 'starter' });
    expect(res.text).toMatch(/token .*isn't allowed.*skeinwise connect claude-code/);
  });

  it('stops every tool while locked, from the next call on', async () => {
    setLocked(home, true);
    for (const [name, args] of [
      ['search', { query: 'starter' }],
      ['write_note', { title: 'x', body: 'y' }],
      ['list_hubs', {}],
    ] as const) {
      const res = await call(server, name, args);
      expect(res).toMatchObject({ isError: true });
      expect(res.text).toMatch(/^Skeinwise is locked, so its tools are stopped/);
    }
    expect(existsSync(join(notesDir(home), 'x.md'))).toBe(false);
    setLocked(home, false);
    expect((await call(server, 'search', { query: 'starter' })).isError).toBe(false);
  });

  it('serves the newer protocol with no handshake, the token deciding and the name only a label', async () => {
    const token = allowAgent(home, 'codex', LATER).token;
    const fresh = memoryServer(context(home, store, { token }).ctx);
    const meta = (name?: string) => ({ 'io.modelcontextprotocol/protocolVersion': MODERN_VERSION, ...(name ? { 'io.modelcontextprotocol/clientInfo': { name, version: '1' } } : {}) });
    expect((await call(fresh, 'search', { query: 'starter' }, meta('claude-code'))).isError).toBe(false);
    expect((await call(fresh, 'search', { query: 'starter' }, meta())).isError).toBe(false);
    expect((await call(fresh, 'write_note', { title: 'x', body: 'y' }, meta('claude-code'))).text).toMatch(/^not allowed: read scope\. codex /);
  });

  it('keeps a broken access file from letting anyone in', async () => {
    writeFileSync(join(home, ACCESS_FILE), '{not json');
    const res = await call(server, 'search', { query: 'starter' });
    expect(res.isError).toBe(true);
  });
});

describe('reading the record', () => {
  it('lists the twelve tools to a write-scope agent, the reads marked read-only', async () => {
    const reply = await rpc(server, 'tools/list');
    const tools = (reply.result as { tools: { name: string; annotations: { readOnlyHint: boolean } }[] }).tools;
    expect(tools.map((t) => t.name)).toEqual([
      'search',
      'ask',
      'read_entry',
      'read_thread',
      'timeline',
      'list_hubs',
      'read_hub',
      'write_note',
      'append_daily_note',
      'tag_entries',
      'not_mine',
      'undo_run',
    ]);
    expect(tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name)).toEqual([
      'search',
      'ask',
      'read_entry',
      'read_thread',
      'timeline',
      'list_hubs',
      'read_hub',
    ]);
  });

  it('search finds entries with a snippet, and checks its arguments', async () => {
    const res = await call(server, 'search', { query: 'sourdough starter', limit: 3 });
    expect(res.isError).toBe(false);
    expect(res.json).toMatchObject({ untrusted: true, source: 'skeinwise/search', query: 'sourdough starter', truncated: false });
    expect(res.json.entries.length).toBeLessThanOrEqual(3);
    expect(res.json.entries[0]).toMatchObject({ id: expect.any(Number), date: expect.any(String), speaker: expect.any(String), snippet: expect.any(String) });
    const mine = await call(server, 'search', { query: 'starter', speaker: 'you' });
    expect(mine.json.entries.every((h: { speaker: string }) => h.speaker === 'you')).toBe(true);
    expect((await call(server, 'search', { query: 'starter', limit: 0 })).text).toBe('limit must be a whole number from 1 to 20.');
    expect((await call(server, 'search', { query: 'starter', limit: 21 })).text).toBe('limit must be a whole number from 1 to 20.');
    expect((await call(server, 'search', {})).text).toBe('Give query.');
    expect((await call(server, 'search', { query: 'starter', from: 'last tuesday' })).text).toMatch(/^from must be a date/);
  });

  it('ask returns dated quotes from the entries, with no model', async () => {
    const res = await call(server, 'ask', { question: 'When did I first mention my sourdough starter?' });
    expect(res.isError).toBe(false);
    expect(res.json.question).toBe('When did I first mention my sourdough starter?');
    expect(res.json.entries.length).toBeGreaterThan(0);
    expect(res.json.entries[0]).toMatchObject({ id: expect.any(Number), date: expect.any(String), quote: expect.any(String) });
  });

  it("read_entry gives the whole text with each version's editor; read_thread pages through the conversation", async () => {
    const hit = await firstHit('starter');
    const entry = await call(server, 'read_entry', { entry_id: hit.id });
    const body = store.getEntry(hit.id)!.body;
    expect(entry.json.entries).toEqual([
      expect.objectContaining({ id: hit.id, body, body_length: body.length, body_offset: 0, versions: [{ version: 1, editor: expect.any(String), date: expect.any(String) }] }),
    ]);
    expect((await call(server, 'read_entry', { entry_id: hit.id, body_offset: 5 })).json.entries[0].body).toBe(body.slice(5));
    const threadId = (await firstHit('starter')).thread?.id ?? store.allEntries().find((e) => e.threadId !== null)!.threadId!;
    const total = store.threadEntries(threadId).length;
    const first = await call(server, 'read_thread', { thread_id: threadId, limit: 1 });
    expect(first.json).toMatchObject({ thread: { id: threadId, messages: total }, offset: 0 });
    expect(first.json.entries).toHaveLength(1);
    expect(first.json.next_offset).toBe(total > 1 ? 1 : null);
    expect((await call(server, 'read_entry', { entry_id: 999_999 })).text).toBe('There is no entry 999999 in the record.');
    expect((await call(server, 'read_entry', { entry_id: 'one' })).text).toBe('Give entry_id as a whole number.');
  });

  it('timeline lists entries by date, a bare day reaching to its end', async () => {
    const all = store.allEntries().map((e) => e.createdAt).sort();
    const day = all[0]!.slice(0, 10);
    const res = await call(server, 'timeline', { from: day, to: day, limit: 20 });
    const expected = all.filter((d) => d.slice(0, 10) === day).slice(0, 20);
    expect(res.json.entries.map((e: { date: string }) => e.date)).toEqual(expected);
    const newest = await call(server, 'timeline', { newest_first: true, limit: 2 });
    expect(newest.json.entries.map((e: { date: string }) => e.date)).toEqual([...all].reverse().slice(0, 2));
    expect(newest.json.next_offset).toBe(2);
  });

  it("list_hubs and read_hub show the organiser's hubs, each point citing an entry", async () => {
    expect((await call(server, 'list_hubs')).json).toEqual({
      untrusted: true,
      source: 'skeinwise/list_hubs',
      hubs: 0,
      offset: 0,
      next_offset: null,
      truncated: false,
      entries: [],
    });
    await runSteps(store, new RecordView(store), steps(store, 'all'), NONE);
    const hubs = liveHubs(store.db);
    expect(hubs.length).toBeGreaterThan(0);
    const listed = await call(server, 'list_hubs');
    expect(listed.json.entries.map((h: { id: number }) => h.id)).toEqual(hubs.slice(0, 20).map((h) => h.id));
    const hub = await call(server, 'read_hub', { hub_id: hubs[0]!.id });
    expect(hub.json.entries[0]).toMatchObject({ id: hubs[0]!.id, name: hubs[0]!.name, sections: { in_short: expect.any(Array) } });
    expect(hub.json.entries[0].entry_ids.length).toBeGreaterThan(0);
    expect((await call(server, 'read_hub', { hub_id: 999_999 })).text).toBe('There is no hub 999999. list_hubs names them.');
  });
});

describe('writing to the record', () => {
  it("write_note saves a note marked with the agent, each save a version under the agent's name", async () => {
    const made = await call(server, 'write_note', { title: 'Rye plan', body: 'Try 80% hydration.' });
    expect(made.json).toMatchObject({ file: join('notes', 'rye-plan.md'), created: true, version: 1 });
    expect(readFileSync(join(home, 'notes', 'rye-plan.md'), 'utf8')).toContain('agent: claude-code');
    const again = await call(server, 'write_note', { title: 'Rye plan', body: 'Try 78% hydration.' });
    expect(again.json).toMatchObject({ entry_id: made.json.entry_id, created: false, version: 2 });
    const read = (await call(server, 'read_entry', { entry_id: made.json.entry_id })).json.entries[0];
    expect(read).toMatchObject({ speaker: 'claude-code', body: '# Rye plan\n\nTry 78% hydration.' });
    expect(read.versions.map((v: { editor: string }) => v.editor)).toEqual(['claude-code', 'claude-code']);
    expect((await call(server, 'search', { query: 'hydration' })).json.entries.map((h: { id: number }) => h.id)).toContain(made.json.entry_id);
  });

  it("write_note can't change a note of yours", async () => {
    writeFileSync(join(notesDir(home), 'bread.md'), '# Bread\n\nMy own words.\n');
    const res = await call(server, 'write_note', { title: 'Bread', body: 'Mine now.' });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("is your note, and agents can't change your notes");
    expect(readFileSync(join(notesDir(home), 'bread.md'), 'utf8')).toBe('# Bread\n\nMy own words.\n');
  });

  it("append_daily_note adds a line under the agent's name", async () => {
    const res = await call(server, 'append_daily_note', { text: 'Reminded you to feed the starter.' });
    expect(res.json).toMatchObject({ created: true, version: 1 });
    expect(readFileSync(join(home, res.json.file), 'utf8')).toMatch(/\n- claude-code: Reminded you to feed the starter\.\n$/);
    expect(store.history(res.json.entry_id).map((v) => v.editor)).toEqual(['claude-code']);
  });

  it('tag_entries makes one run under the agent, which only that agent can undo', async () => {
    const a = (await firstHit('starter')).id;
    const b = (await firstHit('rye')).id;
    const tagged = await call(server, 'tag_entries', { entry_ids: [a, b, a], tag: ' to  bake ' });
    expect(tagged.json).toMatchObject({ schema: AGENT_SCHEMA, tag: 'to bake', run_id: expect.any(Number), tagged: 2, already_tagged: 0 });
    const run = getRun(store.db, tagged.json.run_id)!;
    expect(run).toMatchObject({ task: 'tag', engine: 'agent', model: 'claude-code', scope: 'agent', status: 'done' });
    const schema = findSchema(store.db, AGENT_SCHEMA)!;
    expect(liveTags(store.db, schema.id).map((t) => [t.name, t.entryIds.sort()])).toEqual([['to bake', [a, b].sort()]]);

    const again = await call(server, 'tag_entries', { entry_ids: [a], tag: 'TO BAKE' });
    expect(again.json).toMatchObject({ run_id: null, tagged: 0, already_tagged: 1 });

    const other = await open('cursor', 'write');
    const refused = await call(other, 'undo_run', { run_id: run.id });
    expect(refused.text).toBe(`Run ${run.id} wasn't made by cursor, so cursor can't undo it.`);

    const undone = await call(server, 'undo_run', { run_id: run.id });
    expect(undone.json).toMatchObject({ run_id: run.id, status: 'undone' });
    expect(liveTags(store.db, schema.id)).toEqual([]);
  });

  it("tag_entries keeps to schemas an agent may add to, and to entries the record shows", async () => {
    const a = (await firstHit('starter')).id;
    expect((await call(server, 'tag_entries', { entry_ids: [a], tag: 'x', schema: 'Topics' })).text).toMatch(/^The organiser makes Topics/);
    expect((await call(server, 'tag_entries', { entry_ids: [a], tag: 'x', schema: 'Nope' })).text).toMatch(/^There is no schema "Nope"/);
    expect((await call(server, 'tag_entries', { entry_ids: [999_999], tag: 'x' })).text).toBe('There is no entry 999999 in the record. Nothing was tagged.');
    expect((await call(server, 'tag_entries', { entry_ids: 'all', tag: 'x' })).text).toBe('entry_ids must be a list of entry ids.');
    expect(listRuns(store.db)).toEqual([]);
    const moods = await call(server, 'tag_entries', { entry_ids: [a], tag: 'hopeful', schema: 'moods' });
    expect(moods.json).toMatchObject({ schema: 'Moods', tagged: 1 });
  });

  it("undo_run won't take back the organiser's own runs", async () => {
    await runSteps(store, new RecordView(store), steps(store, 'tag'), NONE);
    const run = listRuns(store.db)[0]!;
    expect((await call(server, 'undo_run', { run_id: run.id })).text).toBe(`Run ${run.id} wasn't made by claude-code, so claude-code can't undo it.`);
    expect(getRun(store.db, run.id)!.status).toBe('done');
  });

  it('not_mine leaves a thread out of every read', async () => {
    const hit = await firstHit('starter');
    const threadId = hit.thread?.id ?? store.allEntries().find((e) => e.threadId !== null)!.threadId!;
    const entryId = store.threadEntries(threadId)[0]!.id;
    const res = await call(server, 'not_mine', { thread_id: threadId });
    expect(res.json).toMatchObject({ thread_id: threadId, not_mine: true });
    expect(res.json.message).toContain(`skeinwise not-mine ${threadId} --undo`);
    expect((await call(server, 'read_entry', { entry_id: entryId })).isError).toBe(true);
    expect((await call(server, 'read_thread', { thread_id: threadId })).text).toBe(`There is no thread ${threadId} in the record.`);
    expect((await call(server, 'not_mine', { thread_id: threadId })).isError).toBe(true);
  });
});

describe('what a session gets back', () => {
  it('frames every tool result as untrusted data from the record', async () => {
    const hit = await firstHit('starter');
    for (const [name, args] of [
      ['search', { query: 'starter' }],
      ['ask', { question: 'When did I first mention my sourdough starter?' }],
      ['read_entry', { entry_id: hit.id }],
      ['timeline', { limit: 2 }],
      ['list_hubs', {}],
      ['write_note', { title: 'Framed', body: 'Yes.' }],
    ] as const) {
      const res = await call(server, name, args);
      expect(res.isError).toBe(false);
      expect(res.text.split('\n')).toEqual([FRAME_OPEN, expect.any(String), FRAME_CLOSE]);
      expect(res.json).toMatchObject({ untrusted: true, source: `skeinwise/${name}`, truncated: false, entries: expect.any(Array) });
    }
  });

  it('redacts a key planted in an entry', async () => {
    const key = keyShaped('gh', 'p_', 'Zq4mW8rT2xK9bN3vL6pY1sD5fH7jC0aE3gU8');
    const made = await call(server, 'write_note', { title: 'Deploy notes', body: `The deploy token is ${key}, keep it safe.` });
    const read = await call(server, 'read_entry', { entry_id: made.json.entry_id });
    expect(read.text).not.toContain(key);
    expect(read.json.entries[0].body).toMatch(/The deploy token is \[SECRET_\d+\], keep it safe\./);
    const found = await call(server, 'search', { query: 'deploy token' });
    expect(found.text).not.toContain(key);
  });

  it('cuts a 33 KB entry to 32 KB with truncated: true, and reads on from body_offset', async () => {
    const body = 'Rye starter log. '.repeat(Math.ceil((33 * 1024) / 17));
    const made = await call(server, 'write_note', { title: 'Long log', body });
    const read = await call(server, 'read_entry', { entry_id: made.json.entry_id });
    expect(Buffer.byteLength(read.text)).toBeLessThanOrEqual(MAX_CALL_BYTES);
    expect(read.json.truncated).toBe(true);
    const got = read.json.entries[0].body.slice(0, -1) as string;
    const rest = await call(server, 'read_entry', { entry_id: made.json.entry_id, body_offset: got.length });
    expect(rest.json.truncated).toBe(false);
    expect(got + rest.json.entries[0].body).toBe(store.getEntry(made.json.entry_id)!.body);
  });

  it('refuses a session its 501st KB', async () => {
    const made = await call(server, 'write_note', { title: 'Big', body: 'B'.repeat(40_000) });
    const reader = await open('reader');
    let total = 0;
    let calls = 0;
    for (;;) {
      const res = await call(reader, 'read_entry', { entry_id: made.json.entry_id });
      if (res.isError) {
        expect(res.text).toMatch(/^This session has had 500 KB of the record/);
        break;
      }
      total += Buffer.byteLength(res.text);
      calls += 1;
      expect(calls).toBeLessThan(40);
    }
    expect(total).toBeLessThanOrEqual(MAX_SESSION_BYTES);
    expect(total).toBeGreaterThan(MAX_SESSION_BYTES - 1024);
    expect((await call(reader, 'search', { query: 'starter' })).text).toMatch(/^This session has had 500 KB/);
    expect((await call(await open('another'), 'search', { query: 'starter' })).isError).toBe(false);
  });
});
