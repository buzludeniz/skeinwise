import { spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../../src/cli.ts';
import { DEMO_NOW } from '../../src/demo/demo.ts';
import { allowAgent } from '../../src/mcp/access.ts';
import { memoryServer } from '../../src/mcp/commands.ts';
import { BUSY, type McpServer } from '../../src/mcp/protocol.ts';
import { confirmRequest } from '../../src/mcp/requests.ts';
import type { Caller } from '../../src/mcp/session.ts';
import { notesDir, rewriteNoteFile, writeAgentNote } from '../../src/notes.ts';
import { findSchema } from '../../src/organiser/views.ts';
import { currentMark, finishRun, getRun, listRuns, startRun, undoRun } from '../../src/organiser/runs.ts';
import { entryDetail } from '../../src/server/queries.ts';
import { Store } from '../../src/store/store.ts';
import { call, context, demoRecord, initialize } from './helpers.ts';

// MCP-5: an agent's save through the memory server is a run of its own. Its version names the agent (`agent:<name>`)
// and carries the run's id, and `skeinwise undo <run>`, or undo_run once `mcp confirm` lets it, takes the save back: a
// note the run started goes, file and entry; a note it changed gets its earlier text. A file goes only while it is the
// one the run made, not a link, and holds what the run wrote; anything else is refused with nothing removed.

const LATER = '2026-11-21T09:00:00.000Z';

let dir: string;
let home: string;
let store: Store;
let server: McpServer<Caller>;

async function open(agent: string): Promise<McpServer<Caller>> {
  const { token } = allowAgent(home, agent, LATER, 'write');
  const s = memoryServer(context(home, store, { now: () => LATER, token }).ctx);
  await initialize(s, agent);
  return s;
}

/** A skeinwise command run as a person runs it, on the same record folder. */
async function sw(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await main(argv, { out: (t) => (out += t), err: (t) => (err += t), env: { SKEINWISE_HOME: home }, now: () => LATER });
  return { code, out, err };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'skeinwise-note-runs-'));
  home = join(dir, 'home');
  store = demoRecord(dir, home);
  server = await open('claude-code');
});
afterEach(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function writeNote(title: string, body: string): Promise<{ entryId: number; runId: number; file: string }> {
  const res = await call(server, 'write_note', { title, body });
  expect(res.isError).toBe(false);
  return { entryId: res.json.entry_id, runId: res.json.run_id, file: join(home, res.json.file) };
}

/** What a note still has in the record: its entry, its versions, and the run that saved it. */
function kept(note: { entryId: number; runId: number; file: string }) {
  return { entry: !!store.getEntry(note.entryId), file: existsSync(note.file), status: getRun(store.db, note.runId)!.status };
}

describe("an agent's save is a run of its own", () => {
  it('write_note, then history names the agent and the run, then `skeinwise undo <run>` removes the note', async () => {
    const note = await writeNote('Rye plan', 'Try 80% hydration.');
    expect(getRun(store.db, note.runId)).toMatchObject({
      task: 'note',
      engine: 'agent',
      model: 'claude-code',
      scope: 'agent',
      status: 'done',
      counts: { versions: 1 },
      message: `claude-code started note #${note.entryId}.`,
    });

    const history = await sw('history', String(note.entryId));
    expect(history.out).toMatch(/^v1 .* by agent:claude-code /);
    expect(JSON.parse((await sw('history', String(note.entryId), '--json')).out)).toMatchObject([{ editor: 'agent:claude-code', runId: note.runId }]);
    expect((await sw('runs')).out).toContain(`Run ${note.runId}: note · agent claude-code · scope agent · done`);
    // The Reader's "Edited by an agent (…)" names the agent, not its editor string.
    expect(entryDetail(store, note.entryId)?.editedByAgent).toBe('claude-code');

    const undone = await sw('undo', String(note.runId));
    expect(undone).toEqual({ code: 0, err: '', out: `Undid run ${note.runId} (note). Removed 1 notes an agent started.\n` });
    expect(kept(note)).toEqual({ entry: false, file: false, status: 'undone' });
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM versions WHERE entry_id = ? OR run_id = ?').get(note.entryId, note.runId)).toEqual({ n: 0 });
    expect((await call(server, 'search', { query: 'hydration' })).json.entries.map((h: { id: number }) => h.id)).not.toContain(note.entryId);
    expect((await sw('undo', String(note.runId))).err).toMatch(new RegExp(`Run ${note.runId} is already undone`));
  });

  it('append_daily_note is a run too, and undoing it removes the daily note it started', async () => {
    const res = await call(server, 'append_daily_note', { text: 'Reminded you to feed the starter.' });
    const note = { entryId: res.json.entry_id, runId: res.json.run_id, file: join(home, res.json.file) };
    expect(store.history(note.entryId).map((v) => [v.editor, v.runId])).toEqual([['agent:claude-code', note.runId]]);
    expect(undoRun(store.db, note.runId, home, () => LATER).removed).toEqual({ notes: 1 });
    expect(kept(note)).toEqual({ entry: false, file: false, status: 'undone' });
  });

  it('undo_run asks first; once confirmed, a changed note gets its earlier text back, and then the note goes', async () => {
    const first = await writeNote('Rye plan', 'Try 80% hydration.');
    const written = readFileSync(first.file, 'utf8');
    const second = await writeNote('Rye plan', 'Try 78% hydration.');
    expect(second).toMatchObject({ entryId: first.entryId, file: first.file });
    expect(getRun(store.db, second.runId)!.message).toBe(`claude-code changed note #${first.entryId}.`);

    const asked = await call(server, 'undo_run', { run_id: second.runId });
    expect(asked.json).toMatchObject({ run_id: second.runId, status: 'waiting for confirm', request: 1 });
    expect(readFileSync(first.file, 'utf8')).toContain('78%');
    expect(confirmRequest(home, store, 1, LATER).result).toMatchObject({ run_id: second.runId, status: 'undone', removed: {} });
    expect(readFileSync(first.file, 'utf8')).toBe(written);
    // The text put back is a version of yours, dated by the record's clock (the demo's here), not the wall clock.
    expect(store.history(first.entryId).map((v) => [v.editor, v.runId])).toEqual([
      ['agent:claude-code', first.runId],
      ['agent:claude-code', second.runId],
      ['you', null],
    ]);
    expect(store.history(first.entryId).at(-1)!.editedAt).toBe(DEMO_NOW);

    await call(server, 'undo_run', { run_id: first.runId });
    expect(confirmRequest(home, store, 2, LATER).result).toMatchObject({ run_id: first.runId, status: 'undone', removed: { notes: 1 } });
    expect(kept(first)).toEqual({ entry: false, file: false, status: 'undone' });
  });

  it("lets an agent change its note again once an undo puts back the agent's own text, but not after your edit", async () => {
    const first = await writeNote('Rye plan', 'Try 80% hydration.');
    const second = await writeNote('Rye plan', 'Try 78% hydration.');
    expect((await sw('undo', String(second.runId))).code).toBe(0);
    expect(store.history(first.entryId).at(-1)!.editor).toBe('you');

    // The undo is yours, but the text it put back is claude-code's: no words of yours are in the way.
    const third = await writeNote('Rye plan', 'Try 75% hydration.');
    expect(third).toMatchObject({ entryId: first.entryId, file: first.file });
    expect(readFileSync(first.file, 'utf8')).toContain('75%');

    // Your own words still close the note to it.
    writeFileSync(first.file, readFileSync(first.file, 'utf8').replace('75%', '70%'));
    const refused = await call(server, 'write_note', { title: 'Rye plan', body: 'Try 72% hydration.' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('was changed by you after claude-code wrote it');
    expect(readFileSync(first.file, 'utf8')).toContain('70%');
  });

  it("counts an agent's saves from before runs, which name it without agent:, as its own", () => {
    const now = new Date(LATER);
    const made = writeAgentNote(store, home, 'claude-code', 'Rye notes', 'Hydration 75%', now);
    store.db.prepare("UPDATE versions SET editor = 'claude-code', run_id = NULL WHERE entry_id = ?").run(made.entryId);
    expect(writeAgentNote(store, home, 'claude-code', 'Rye notes', 'Hydration 78%', now)).toMatchObject({ entryId: made.entryId, created: false });
    expect(() => writeAgentNote(store, home, 'cursor', 'Rye notes', 'Mine now', now)).toThrow(/only claude-code can change it/);
    expect(store.history(made.entryId).map((v) => v.editor)).toEqual(['claude-code', 'agent:claude-code']);
  });
});

describe('undo removes only the file the run made, as the run left it', () => {
  it('refuses a note changed after the run, in the record or only in its file, and removes nothing', async () => {
    const edited = await writeNote('Rye plan', 'Try 80% hydration.');
    writeFileSync(edited.file, readFileSync(edited.file, 'utf8').replace('80%', '85%'));
    expect(() => undoRun(store.db, edited.runId, home, () => LATER)).toThrow(
      `Note #${edited.entryId} changed after run ${edited.runId} wrote it. Undo the later change first ("skeinwise history ${edited.entryId}" lists them), or keep the note.`,
    );
    expect(kept(edited)).toEqual({ entry: true, file: true, status: 'done' });
    expect(readFileSync(edited.file, 'utf8')).toContain('85%');

    // A change the record doesn't count (a blank line at the end) still makes the file not the run's.
    const touched = await writeNote('Bread log', 'Day one.');
    writeFileSync(touched.file, `${readFileSync(touched.file, 'utf8')}\n\n`);
    const before = readFileSync(touched.file, 'utf8');
    expect(() => undoRun(store.db, touched.runId, home, () => LATER)).toThrow(
      `bread-log.md changed after run ${touched.runId} wrote it, so it stays. Nothing was removed.`,
    );
    expect(kept(touched)).toEqual({ entry: true, file: true, status: 'done' });
    expect(readFileSync(touched.file, 'utf8')).toBe(before);
    expect(store.history(touched.entryId)).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')('refuses a link where the file was, and leaves the link and what it points at', async () => {
    const note = await writeNote('Rye plan', 'Try 80% hydration.');
    const elsewhere = join(dir, 'elsewhere.md');
    writeFileSync(elsewhere, readFileSync(note.file));
    unlinkSync(note.file);
    symlinkSync(elsewhere, note.file);
    expect(() => undoRun(store.db, note.runId, home, () => LATER)).toThrow(
      `rye-plan.md is now a link or not a file, so it isn't what run ${note.runId} wrote. Nothing was removed.`,
    );
    expect(lstatSync(note.file).isSymbolicLink()).toBe(true);
    expect(readFileSync(elsewhere, 'utf8')).toContain('80%');
    expect(kept(note)).toEqual({ entry: true, file: true, status: 'done' });
  });

  it("refuses a run that didn't make the file it saved into, or recorded another one", async () => {
    const note = await writeNote('Rye plan', 'Try 80% hydration.');
    const detail = (d: object) => store.db.prepare('UPDATE runs SET detail = ? WHERE id = ?').run(JSON.stringify(d), note.runId);
    const refusal = `Run ${note.runId} saved note #${note.entryId}, but not into a file it made and recorded, so nothing was removed.`;
    const { sha256 } = getRun(store.db, note.runId)!.detail as { sha256: string };
    detail({ file: 'rye-plan.md', created: false, sha256 });
    expect(() => undoRun(store.db, note.runId, home, () => LATER)).toThrow(refusal);
    detail({ file: '../record.db', created: true, sha256 });
    expect(() => undoRun(store.db, note.runId, home, () => LATER)).toThrow(refusal);
    detail({ file: 'rye-plan.md', created: true });
    expect(() => undoRun(store.db, note.runId, home, () => LATER)).toThrow(refusal);
    expect(() => undoRun(store.db, note.runId)).toThrow(`Run ${note.runId} changed notes, so undoing it needs the record's folder to put their files back.`);
    expect(kept(note)).toEqual({ entry: true, file: true, status: 'done' });
    expect(existsSync(join(home, 'record.db'))).toBe(true);
  });

  it("removes a note the assistant found a loop in and made a task from: the loop goes, your task stays unlinked", async () => {
    const note = await writeNote('Call plan', 'Call the baker on Friday.');
    const ask = startRun(store.db, { task: 'ask', engine: 'none', model: null, scope: 'all', mark: currentMark(store.db), now: LATER });
    store.db
      .prepare("INSERT INTO pa_found (run_id, key, entry_id, is_loop, kind, what) VALUES (?, 'baker', ?, 1, 'promise', 'Call the baker')")
      .run(ask, note.entryId);
    store.db.prepare("INSERT INTO pa_loops (key, entry_id, status, updated_at) VALUES ('baker', ?, 'snoozed', ?)").run(note.entryId, LATER);
    const task = store.db
      .prepare("INSERT INTO pa_tasks (title, entry_id, loop_key, created_at, updated_at) VALUES ('Call the baker', ?, 'baker', ?, ?)")
      .run(note.entryId, LATER, LATER).lastInsertRowid;
    const count = (table: string) => (store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE entry_id = ?`).get(note.entryId) as { n: number }).n;

    expect(undoRun(store.db, note.runId, home, () => LATER).removed).toEqual({ notes: 1 });
    expect(kept(note)).toEqual({ entry: false, file: false, status: 'undone' });
    expect([count('pa_found'), count('pa_loops')]).toEqual([0, 0]);
    expect({ ...(store.db.prepare('SELECT title, entry_id AS entryId FROM pa_tasks WHERE id = ?').get(task) as object) }).toEqual({
      title: 'Call the baker',
      entryId: null,
    });
    expect(() => undoRun(store.db, note.runId, home, () => LATER)).toThrow(`Run ${note.runId} is already undone.`);
  });

  it.skipIf(process.platform === 'win32')("keeps the whole note when its file can't be removed, and the next undo removes both", async () => {
    const note = await writeNote('Rye plan', 'Try 80% hydration.');
    chmodSync(dirname(note.file), 0o500);
    try {
      expect(() => undoRun(store.db, note.runId, home, () => LATER)).toThrow(/unlink/);
    } finally {
      chmodSync(dirname(note.file), 0o700);
    }
    expect(kept(note)).toEqual({ entry: true, file: true, status: 'done' });
    expect(store.history(note.entryId)).toHaveLength(1);
    undoRun(store.db, note.runId, home, () => LATER);
    expect(kept(note)).toEqual({ entry: false, file: false, status: 'undone' });
  });
});

describe('note runs alongside organiser runs', () => {
  /** An organiser tag run that is still running, as live's is while it tags new entries. */
  function organiserRun(): number {
    const schema = findSchema(store.db, 'Topics')!;
    return startRun(store.db, { task: 'tag', engine: 'none', model: null, scope: 'all', schemaId: schema.id, mark: currentMark(store.db), now: LATER });
  }

  function tag(runId: number, entryIds: number[]): void {
    const schema = findSchema(store.db, 'Topics')!;
    const tagId = Number(store.db.prepare('INSERT INTO tags (schema_id, name, run_id) VALUES (?, ?, ?)').run(schema.id, 'baking', runId).lastInsertRowid);
    for (const e of entryIds) store.db.prepare('INSERT INTO entry_tags (entry_id, tag_id, run_id, score) VALUES (?, ?, ?, 1)').run(e, tagId, runId);
  }

  const tagged = (runId: number) => store.db.prepare('SELECT entry_id AS e FROM entry_tags WHERE run_id = ? ORDER BY entry_id').all(runId).map((r) => r.e);

  it('saves a note while an organiser run is running, and either run then undoes cleanly, in either order', async () => {
    const organiser = organiserRun();
    const early = await writeNote('Rye plan', 'Try 80% hydration.');
    const late = await writeNote('Bread log', 'Day one.');
    expect(getRun(store.db, organiser)!.status).toBe('running');
    const other = (await call(server, 'search', { query: 'starter' })).json.entries[0].id as number;
    tag(organiser, [early.entryId, late.entryId, other]);
    finishRun(store.db, organiser, { counts: { entry_tags: 3 }, tokensIn: 0, tokensOut: 0, now: LATER });

    // The note first: its entry goes, and with it the organiser's tag on it; the organiser run keeps the rest.
    expect(undoRun(store.db, early.runId, home, () => LATER).removed).toEqual({ notes: 1 });
    expect(kept(early)).toEqual({ entry: false, file: false, status: 'undone' });
    expect(tagged(organiser)).toEqual([late.entryId, other].sort((a, b) => a - b));

    // The organiser run next, then the other note.
    expect(undoRun(store.db, organiser, home, () => LATER).removed).toEqual({ entry_tags: 2, tags: 1 });
    expect(undoRun(store.db, late.runId, home, () => LATER).removed).toEqual({ notes: 1 });
    expect(kept(late)).toEqual({ entry: false, file: false, status: 'undone' });
    expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it("refuses to undo a note an organiser run changed after it, until that run's change is undone", async () => {
    const note = await writeNote('Rye plan', 'Try 80% hydration.');
    const written = readFileSync(note.file, 'utf8');
    // A review run's proposal, accepted the way resolveReview does it: the file first, then the version.
    const review = startRun(store.db, { task: 'review', engine: 'none', model: null, scope: 'all', mark: currentMark(store.db), now: LATER });
    const proposed = '# Rye plan\n\nTry 80% hydration, and a longer bulk.';
    rewriteNoteFile(note.file, proposed);
    store.editEntry(note.entryId, proposed, { editor: 'you', runId: review });
    finishRun(store.db, review, { counts: {}, tokensIn: 0, tokensOut: 0, now: LATER });

    expect(() => undoRun(store.db, note.runId, home, () => LATER)).toThrow(`Note #${note.entryId} changed after run ${note.runId} wrote it.`);
    expect(kept(note)).toEqual({ entry: true, file: true, status: 'done' });
    expect(readFileSync(note.file, 'utf8')).toContain('longer bulk');

    expect(undoRun(store.db, review, home, () => LATER).restored).toEqual([note.entryId]);
    expect(readFileSync(note.file, 'utf8')).toBe(written);
    expect(undoRun(store.db, note.runId, home, () => LATER).removed).toEqual({ notes: 1 });
    expect(kept(note)).toEqual({ entry: false, file: false, status: 'undone' });
  });
});

/**
 * Another process (live capture, say) holding the record's write lock for `ms`, from its own connection, with a write
 * of its own in the transaction. `locked` once it holds the lock; `done` when it has committed and exited.
 */
function holdLock(file: string, ms: number): { locked: Promise<void>; done: Promise<{ code: number | null; out: string }> } {
  const script = `
    import { writeSync } from 'node:fs';
    import { DatabaseSync } from 'node:sqlite';
    const [file, ms] = process.argv.slice(1);
    const db = new DatabaseSync(file);
    db.exec('BEGIN IMMEDIATE');
    db.exec("INSERT INTO sources (kind, label, location, added_at) VALUES ('notes', 'Live capture', '/live-capture', '2026-11-21')");
    writeSync(1, 'locked\\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(ms));
    db.exec('COMMIT');
    db.close();
  `;
  const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', script, file, String(ms)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let markLocked = () => {};
  const locked = new Promise<void>((resolve) => (markLocked = resolve));
  child.stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString('utf8');
    if (out.startsWith('locked')) markLocked();
  });
  child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  const done = new Promise<{ code: number | null; out: string }>((resolve) => child.on('close', (code) => resolve({ code, out })));
  void done.then(markLocked);
  return { locked, done };
}

describe('an agent writing while another process writes to the record', () => {
  it("waits out the other write (the record's busy wait) and saves the note under the agent", async () => {
    const holder = holdLock(join(home, 'record.db'), 600);
    await holder.locked;
    const started = Date.now();
    const note = await writeNote('Rye plan', 'Try 80% hydration.');
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
    expect(await holder.done).toEqual({ code: 0, out: 'locked\n' });
    expect(store.history(note.entryId).map((v) => [v.editor, v.runId])).toEqual([['agent:claude-code', note.runId]]);
    expect(getRun(store.db, note.runId)!.status).toBe('done');
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM sources WHERE location = '/live-capture'").get()).toEqual({ n: 1 });
  });

  it('puts the file back when another write takes the record between the file and its save, so a retry still works', async () => {
    // Another connection takes the write lock at the moment the agent's file has been written and its save is about to
    // begin: the one window where the file would be left behind and read later as yours.
    const contents = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : null);
    let watched: { file: string; before: string | null } | undefined;
    let holder: DatabaseSync | undefined;
    const db = new Proxy(store.db, {
      get(target, key) {
        if (key === 'exec') {
          return (sql: string) => {
            if (sql.startsWith('BEGIN') && watched && !holder && contents(watched.file) !== watched.before) {
              holder = new DatabaseSync(join(home, 'record.db'));
              holder.exec('BEGIN IMMEDIATE');
            }
            return target.exec(sql);
          };
        }
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const { token } = allowAgent(home, 'claude-code', LATER, 'write');
    const agent = memoryServer(context(home, new Store(db, store.now), { now: () => LATER, token }).ctx);
    await initialize(agent, 'claude-code');
    const daily = join(home, (await call(agent, 'append_daily_note', { text: 'Fed the starter.' })).json.file);
    const bread = await call(agent, 'write_note', { title: 'Bread log', body: 'Day one.' });
    const runs = listRuns(store.db).length;
    store.db.exec('PRAGMA busy_timeout = 50');

    for (const [tool, args, file] of [
      ['write_note', { title: 'Rye plan', body: 'Try 80% hydration.' }, join(notesDir(home), 'rye-plan.md')],
      ['write_note', { title: 'Bread log', body: 'Day two.' }, join(home, bread.json.file)],
      ['append_daily_note', { text: 'Shaped the loaf.' }, daily],
    ] as const) {
      watched = { file, before: contents(file) };
      expect(await call(agent, tool, args)).toMatchObject({ isError: true, text: BUSY });
      expect(holder).toBeDefined();
      holder!.exec('ROLLBACK');
      holder!.close();
      holder = undefined;
      expect(contents(file)).toBe(watched.before);
    }
    watched = undefined;
    expect(listRuns(store.db)).toHaveLength(runs);

    store.db.exec('PRAGMA busy_timeout = 5000');
    const retried = await call(agent, 'write_note', { title: 'Rye plan', body: 'Try 80% hydration.' });
    expect(store.history(retried.json.entry_id).map((v) => v.editor)).toEqual(['agent:claude-code']);
    expect((await call(agent, 'write_note', { title: 'Bread log', body: 'Day two.' })).json).toMatchObject({ entry_id: bread.json.entry_id, version: 2 });
    expect((await call(agent, 'append_daily_note', { text: 'Shaped the loaf.' })).isError).toBe(false);
    expect(readFileSync(daily, 'utf8').match(/^- claude-code: /gm)).toHaveLength(2);
  });
});
