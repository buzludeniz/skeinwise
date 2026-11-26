import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '../src/cli.ts';
import { loadConfig, saveConfig } from '../src/config.ts';
import { DEMO_NOW, writeDemo } from '../src/demo/demo.ts';
import { openHome } from '../src/home.ts';
import { readImports } from '../src/importers/detect.ts';
import { newNote, notesDir, readNotes, rewriteNoteFile } from '../src/notes.ts';
import { defineTag, deleteHub, findFolder, mergeFolders, removeTag, renameHub, resolveReview } from '../src/organiser/corrections.ts';
import { type RunOptions, runSteps, runTask, steps } from '../src/organiser/organise.ts';
import { RecordView } from '../src/organiser/record.ts';
import { currentMark, finishRun, getRun, startRun, undoRun } from '../src/organiser/runs.ts';
import { definedTags, findSchema, getLiveHub, getReviewItem, heldEntries, liveFolders, liveHubs, liveTags, openReviewItems } from '../src/organiser/views.ts';
import { startServer } from '../src/server/serve.ts';
import { openDb } from '../src/store/db.ts';
import { Store } from '../src/store/store.ts';

const NONE: Omit<RunOptions, 'task'> = { scope: { kind: 'all' }, engine: 'none', yes: false, budget: 0, progress: () => {} };

describe('corrections and the review queue on the demo record', () => {
  let dir: string;
  let store: Store;
  let record: RecordView;
  // The record folder is elsewhere, so the demo's own notes folder is an import like any other.
  const home = join(tmpdir(), 'skeinwise-fix-home');

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'skeinwise-fix-'));
    writeDemo(dir);
    // The demo flags only its two Plotline notes. Two older notes of the test's own give the queue an item to skip and
    // one to edit under the review. Later demo entries overtake each: a decision that names the note and says what it
    // doesn't (review.ts cueFlag; a decision the note already holds only confirms it).
    const old = (title: string, created: string, body: string) =>
      writeFileSync(join(dir, 'notes', `${title.toLowerCase().replaceAll(' ', '-')}.md`), `---\ntitle: ${title}\ncreated: ${created}\n---\n# ${title}\n\n${body}\n`);
    old('River cleaner', '2024-02-10', 'The river cleaner is a Python script: it reads the samples, drops the bad rows and writes the nitrate table.');
    old('Market loaves', '2024-04-02', 'The market stall could sell spelt and a seeded loaf.');
    store = new Store(openDb(':memory:'), () => DEMO_NOW);
    for (const p of ['chatgpt', 'claude', 'claude-code', 'notes']) for (const b of readImports(join(dir, p))) store.ingest(b);
    record = new RecordView(store);
    await runSteps(store, record, steps(store, 'all'), NONE);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('merge-folders folds one folder into another, keeps its name as an alias, and undoes', () => {
    const [into, from] = liveFolders(store.db).filter((f) => f.name !== 'Inbox');
    const before = liveFolders(store.db);
    const merged = mergeFolders(store, from!.name.toUpperCase(), String(into!.id));
    expect(getRun(store.db, merged.runId)).toMatchObject({ task: 'correction', engine: 'you', status: 'done' });
    const after = liveFolders(store.db);
    expect(after.find((f) => f.id === from!.id)).toBeUndefined();
    const grown = after.find((f) => f.id === into!.id)!;
    expect(grown.aliases).toContain(from!.name);
    expect(grown.entryIds.length).toBe(new Set([...into!.entryIds, ...from!.entryIds]).size);
    expect(() => findFolder(store, from!.name)).toThrow(`was merged into folder ${into!.id}`);
    expect(() => mergeFolders(store, String(into!.id), into!.name)).toThrow(/same folder/);
    undoRun(store.db, merged.runId);
    expect(liveFolders(store.db)).toEqual(before);
  });

  it('rename-hub and delete-hub are undone in the reverse order they were made', () => {
    const hub = liveHubs(store.db).find((h) => /Plotline/.test(h.name))!;
    const renamed = renameHub(store, hub.id, '  The   allotment app ');
    expect(getLiveHub(store.db, hub.id)!.name).toBe('The allotment app');
    const deleted = deleteHub(store, hub.id);
    expect(getLiveHub(store.db, hub.id)).toBeUndefined();
    expect(() => renameHub(store, hub.id, 'x')).toThrow(`No hub ${hub.id}`);
    expect(() => undoRun(store.db, renamed.runId)).toThrow(`Run ${deleted.runId} changed the same thing later`);
    expect(() => undoRun(store.db, hub.runId)).toThrow(/build on what run/);
    undoRun(store.db, deleted.runId);
    expect(getLiveHub(store.db, hub.id)!.name).toBe('The allotment app');
    undoRun(store.db, renamed.runId);
    expect(getLiveHub(store.db, hub.id)!.name).toBe(hub.name);
  });

  it('define-tag adds tags to a schema of your own, which the tag task then uses', async () => {
    expect(() => defineTag(store, 'topics', 'bread', '')).toThrow(/makes Topics from your entries/);
    const made = defineTag(store, 'Kitchen', 'bread', 'sourdough rye loaf starter');
    expect(made).toMatchObject({ change: 'new schema', schema: { name: 'Kitchen', builtin: false, description: 'Your own tags.' } });
    expect(defineTag(store, 'kitchen', 'Bread', 'sourdough rye loaf starter crumb').change).toBe('described');
    expect(() => defineTag(store, 'Kitchen', 'bread', '')).toThrow(/already has the tag "bread"/);
    const schema = findSchema(store.db, 'Kitchen')!;
    const run = await runTask(store, record, { ...NONE, task: 'tag', schema });
    const tagged = liveTags(store.db, schema.id);
    expect(tagged.map((t) => t.name)).toEqual(['bread']);
    expect(tagged[0]!.entryIds.length).toBeGreaterThan(3);
    expect(() => removeTag(store, 'Kitchen', 'bread')).toThrow(`Runs ${run.id} tagged entries "bread"`);
    undoRun(store.db, run.id);
    expect(removeTag(store, 'Kitchen', 'BREAD').change).toBe('removed');
    expect(definedTags(store.db, schema.id)).toEqual([]);
    // A run used the schema, so it stays for that run's history.
    expect(findSchema(store.db, 'Kitchen')).toBeDefined();
    defineTag(store, 'Scratch', 'x', '');
    removeTag(store, 'Scratch', 'x');
    expect(findSchema(store.db, 'Scratch')).toBeUndefined();
  });

  it('refuses to update a note that changed after its review', () => {
    const item = openReviewItems(store.db).find((i) => store.getEntry(i.noteEntry)!.title === 'River cleaner')!;
    const note = store.getEntry(item.noteEntry)!;
    store.editEntry(note.id, `${note.body}\n\nOne more line.`, 'you');
    expect(() => resolveReview(store, home, item.id, 'update', true)).toThrow(/changed after review run/);
  });

  it('review answers: update shows a diff and saves with yes; holds and skip set items aside', () => {
    const items = openReviewItems(store.db);
    const plotline = items.find((i) => store.getEntry(i.noteEntry)!.title === 'Plotline')!;
    expect(items.map((i) => store.getEntry(i.noteEntry)!.title).sort()).toEqual(['Market loaves', 'Plotline', 'Plotline waiting list rules', 'River cleaner']);
    const shown = resolveReview(store, home, plotline.id, 'update', false);
    expect(shown.saved).toBe(false);
    expect(shown.diff).toContain('+ ## Updates');
    expect(shown.diff.some((l) => l.startsWith('+ - 2026-04-05:'))).toBe(true);
    expect(getReviewItem(store.db, plotline.id)!.status).toBe('open');

    const saved = resolveReview(store, home, plotline.id, 'update', true);
    expect(saved).toMatchObject({ saved: true, version: 2, file: null });
    expect(store.getEntry(plotline.noteEntry)!.body).toBe(plotline.proposed.trim());
    expect(store.history(plotline.noteEntry)[0]!.body).not.toContain('## Updates');

    const [held, skipped] = items.filter((i) => i.id !== plotline.id);
    resolveReview(store, home, held!.id, 'holds', false);
    resolveReview(store, home, skipped!.id, 'skip', false);
    expect(openReviewItems(store.db).map((i) => i.id)).not.toContain(held!.id);
    expect([...heldEntries(store.db, held!.noteEntry)]).toEqual(held!.reasons.map((r) => r.entryId));
    expect(() => resolveReview(store, home, 99_999, 'holds', false)).toThrow(/No review item 99999/);
  });

  it('undoing the review run puts back the note its accepted update changed (M12)', () => {
    const id = store.allEntries().find((e) => e.kind === 'note' && e.title === 'Plotline')!.id;
    const [original, update] = store.history(id);
    const runId = update!.runId!;
    expect(getRun(store.db, runId)!.task).toBe('review');
    expect(update!.editor).toBe('you');
    const undone = undoRun(store.db, runId, home);
    expect(undone.restored).toEqual([id]);
    expect(undone.removed.review_items).toBeGreaterThan(0);
    expect(store.getEntry(id)!.body).toBe(original!.body);
    // The update stays in history; putting it back is a new version of its own, by you, in no run.
    expect(store.history(id).map((v) => [v.version, v.runId])).toEqual([[1, null], [2, runId], [3, null]]);
  });
});

describe('undoing a review update to a note in the record folder', () => {
  const now = () => DEMO_NOW;

  /** A finished review run that updated the note the way accepting does (corrections.ts resolveReview). */
  function accept(store: Store, file: string, entryId: number, body: string): number {
    const run = startRun(store.db, { task: 'review', engine: 'none', model: null, scope: 'all', mark: 0, now: DEMO_NOW });
    finishRun(store.db, run, { counts: {}, tokensIn: 0, tokensOut: 0, now: DEMO_NOW });
    rewriteNoteFile(file, body);
    store.editEntry(entryId, body, { editor: 'you', runId: run });
    return run;
  }

  it('puts back the file as well, and needs the record folder to do it', () => {
    const home = mkdtempSync(join(tmpdir(), 'skeinwise-undo-'));
    try {
      const store = new Store(openDb(':memory:'), now);
      const note = newNote(store, home, 'Garden plan', new Date(DEMO_NOW));
      const before = readFileSync(note.path, 'utf8');
      const run = accept(store, note.path, note.entryId, '# Garden plan\n\nRaised beds by May.');
      expect(readFileSync(note.path, 'utf8')).toContain('Raised beds');

      expect(() => undoRun(store.db, run)).toThrow(/needs the record's folder/);
      expect(getRun(store.db, run)!.status).toBe('done');
      expect(undoRun(store.db, run, home).restored).toEqual([note.entryId]);
      expect(readFileSync(note.path, 'utf8')).toBe(before);
      expect(store.getEntry(note.entryId)!.body).toBe('# Garden plan');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('refuses a note changed since, until it reads as before', () => {
    const home = mkdtempSync(join(tmpdir(), 'skeinwise-undo-'));
    try {
      const store = new Store(openDb(':memory:'), now);
      const note = newNote(store, home, 'Garden plan', new Date(DEMO_NOW));
      const before = readFileSync(note.path, 'utf8');
      const run = accept(store, note.path, note.entryId, '# Garden plan\n\nRaised beds by May.');
      // Every change to a note of the record folder writes its file too (a record-only change would be undone by the
      // next read of the file), so the edit is made in the file and read in.
      rewriteNoteFile(note.path, '# Garden plan\n\nRaised beds by June.');
      readNotes(store, home);

      expect(() => undoRun(store.db, run, home)).toThrow(
        `Note #${note.entryId} changed after run ${run} updated it. Bring back the version you want with "skeinwise restore ${note.entryId} 1", then undo run ${run}.`,
      );
      expect(store.getEntry(note.entryId)!.body).toContain('June');
      // As `skeinwise restore` does it: the file first, then the record.
      rewriteNoteFile(note.path, store.history(note.entryId)[0]!.body);
      store.restoreVersion(note.entryId, 1);
      expect(undoRun(store.db, run, home)).toMatchObject({ restored: [], run: { status: 'undone' } });
      expect(store.history(note.entryId).length).toBe(4);
      expect(readFileSync(note.path, 'utf8')).toBe(before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('never writes over an edit made in the file that the record has not read yet', () => {
    const home = mkdtempSync(join(tmpdir(), 'skeinwise-undo-'));
    try {
      const store = new Store(openDb(':memory:'), now);
      const note = newNote(store, home, 'Garden plan', new Date(DEMO_NOW));
      const run = accept(store, note.path, note.entryId, '# Garden plan\n\nRaised beds by May.');
      // Edited in an editor after the update was accepted; nothing has read the notes folder since.
      rewriteNoteFile(note.path, '# Garden plan\n\nRaised beds by May. Beans along the fence.');

      expect(() => undoRun(store.db, run, home)).toThrow(`Note #${note.entryId} changed after run ${run} updated it.`);
      expect(readFileSync(note.path, 'utf8')).toContain('Beans along the fence.');
      expect(store.getEntry(note.entryId)!.body).toContain('Beans along the fence.');
      expect(getRun(store.db, run)!.status).toBe('done');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // A file opened for writing as root ignores its mode, so the failure can't be staged there.
  it.skipIf(process.getuid?.() === 0)('a file it cannot write leaves the note as the run left it, and the undo runs again', () => {
    const home = mkdtempSync(join(tmpdir(), 'skeinwise-undo-'));
    try {
      const store = new Store(openDb(':memory:'), now);
      const note = newNote(store, home, 'Garden plan', new Date(DEMO_NOW));
      const before = readFileSync(note.path, 'utf8');
      const run = accept(store, note.path, note.entryId, '# Garden plan\n\nRaised beds by May.');
      chmodSync(note.path, 0o444);

      expect(() => undoRun(store.db, run, home)).toThrow();
      expect(readFileSync(note.path, 'utf8')).toContain('Raised beds by May.');
      expect(store.getEntry(note.entryId)!.body).toContain('Raised beds by May.');
      expect(store.history(note.entryId).length).toBe(2);
      expect(getRun(store.db, run)!.status).toBe('done');

      chmodSync(note.path, 0o644);
      expect(undoRun(store.db, run, home).restored).toEqual([note.entryId]);
      expect(readFileSync(note.path, 'utf8')).toBe(before);
      expect(store.getEntry(note.entryId)!.body).toBe('# Garden plan');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('a note kept as a Word document', () => {
  /** A one-paragraph Word document: a zip of XML parts, which Markdown written over it would ruin. */
  function docx(text: string): Uint8Array {
    return zipSync({
      '_rels/.rels': strToU8(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
          '</Relationships>',
      ),
      'word/document.xml': strToU8(
        `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
      ),
    });
  }

  it('is never written: accepting a review update and undoing it change only the record, and say so', async () => {
    const home = mkdtempSync(join(tmpdir(), 'skeinwise-word-'));
    try {
      const store = openHome(home, () => DEMO_NOW);
      const path = join(notesDir(home), 'Garden plan.docx');
      writeFileSync(path, docx('Beans by the fence.'));
      const bytes = readFileSync(path);
      readNotes(store, home);
      const note = store.allEntries().find((e) => e.kind === 'note')!;
      const original = note.body;
      const run = startRun(store.db, { task: 'review', engine: 'none', model: null, scope: 'all', mark: currentMark(store.db), now: DEMO_NOW });
      finishRun(store.db, run, { counts: {}, tokensIn: 0, tokensOut: 0, now: DEMO_NOW });
      const item = Number(
        store.db
          .prepare('INSERT INTO review_items (note_entry, reasons, proposed, run_id) VALUES (?, ?, ?, ?)')
          .run(note.id, '[]', `${original}\n\nPeas by the shed.`, run).lastInsertRowid,
      );
      store.db.close();
      const sw = async (...argv: string[]) => {
        let out = '';
        let err = '';
        const code = await main(argv, { out: (t) => (out += t), err: (t) => (err += t), env: { SKEINWISE_HOME: home }, now: () => DEMO_NOW });
        return { code, out, err };
      };
      // The record's "/" path (pathInside), on Windows too.
      const shown = 'notes/Garden plan.docx';

      const saved = await sw('review', '--resolve', String(item), 'update', '--yes');
      expect(saved).toMatchObject({ code: 0, err: '' });
      expect(saved.out).toContain(`Saved note #${note.id} as version 2. The text before stays in its history`);
      expect(saved.out).toContain(`${shown} is a Word document, which Skeinwise doesn't write, so it doesn't have this update.\n`);
      expect(readFileSync(path)).toEqual(bytes);

      const undone = await sw('undo', String(run));
      expect(undone).toMatchObject({ code: 0, err: '' });
      expect(undone.out).toContain(`Put back the text of #${note.id}.`);
      expect(undone.out).toContain(`${shown} is a Word document, which Skeinwise doesn't write, so it was left as it is.\n`);
      expect(readFileSync(path)).toEqual(bytes);

      // Anything that calls rewriteNoteFile on one later fails loudly instead.
      expect(() => rewriteNoteFile(path, 'Peas by the shed.')).toThrow(`${path} is a Word document, which Skeinwise doesn't write. Nothing was saved.`);
      expect(readFileSync(path)).toEqual(bytes);

      const after = openHome(home, () => DEMO_NOW);
      try {
        expect(after.history(note.id).map((v) => v.body)).toEqual([original, `${original}\n\nPeas by the shed.`, original]);
      } finally {
        after.db.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("is never written by an edit in the app: PUT /api/entries/:id saves a version only, and names the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skeinwise-word-put-'));
    const home = join(dir, 'home');
    try {
      const store = openHome(home, () => DEMO_NOW);
      const path = join(notesDir(home), 'Report.docx');
      writeFileSync(path, docx('Quarterly report.'));
      const bytes = readFileSync(path);
      readNotes(store, home);
      const note = store.allEntries().find((e) => e.kind === 'note')!;
      store.db.close();
      // No-AI, and a pretend home directory for the app's live capture.
      saveConfig(home, { ...loadConfig(home), engine: 'none' });
      mkdirSync(join(dir, 'scan'));
      const app = await startServer({ home, port: 0, webDir: null, scanRoot: join(dir, 'scan') });
      try {
        const res = await fetch(`http://127.0.0.1:${app.port}/api/entries/${note.id}`, {
          method: 'PUT',
          headers: { 'X-Skeinwise-Token': app.token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: 'Edited in the app' }),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ wroteFile: false, word: 'notes/Report.docx', version: { version: 2, editor: 'you' } });
      } finally {
        await app.close();
      }
      expect(readFileSync(path)).toEqual(bytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
