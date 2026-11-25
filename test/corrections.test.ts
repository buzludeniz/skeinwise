import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_NOW, writeDemo } from '../src/demo/demo.ts';
import { readImports } from '../src/importers/detect.ts';
import { defineTag, deleteHub, findFolder, mergeFolders, removeTag, renameHub, resolveReview } from '../src/organiser/corrections.ts';
import { type RunOptions, runSteps, runTask, steps } from '../src/organiser/organise.ts';
import { RecordView } from '../src/organiser/record.ts';
import { getRun, undoRun } from '../src/organiser/runs.ts';
import { definedTags, findSchema, getLiveHub, getReviewItem, heldEntries, liveFolders, liveHubs, liveTags, openReviewItems } from '../src/organiser/views.ts';
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

  it('review answers: update shows a diff and saves with yes; holds and skip set items aside', () => {
    const items = openReviewItems(store.db);
    const plotline = items.find((i) => i.noteEntry === 420)!;
    const shown = resolveReview(store, home, plotline.id, 'update', false);
    expect(shown.saved).toBe(false);
    expect(shown.diff).toContain('+ ## Updates');
    expect(shown.diff.some((l) => l.startsWith('+ - 2026-04-05:'))).toBe(true);
    expect(getReviewItem(store.db, plotline.id)!.status).toBe('open');

    const saved = resolveReview(store, home, plotline.id, 'update', true);
    expect(saved).toMatchObject({ saved: true, version: 2, file: null });
    expect(store.getEntry(420)!.body).toBe(plotline.proposed.trim());
    expect(store.history(420)[0]!.body).not.toContain('## Updates');

    const [held, skipped] = items.filter((i) => i.id !== plotline.id);
    resolveReview(store, home, held!.id, 'holds', false);
    resolveReview(store, home, skipped!.id, 'skip', false);
    expect(openReviewItems(store.db).map((i) => i.id)).not.toContain(held!.id);
    expect([...heldEntries(store.db, held!.noteEntry)]).toEqual(held!.reasons.map((r) => r.entryId));
    expect(() => resolveReview(store, home, 99_999, 'holds', false)).toThrow(/No review item 99999/);
  });

  it('refuses to update a note that changed after its review', () => {
    const item = openReviewItems(store.db)[0]!;
    const note = store.getEntry(item.noteEntry)!;
    store.editEntry(note.id, `${note.body}\n\nOne more line.`, 'you');
    expect(() => resolveReview(store, home, item.id, 'update', true)).toThrow(/changed after review run/);
  });
});
