import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lineDiff } from '../src/diff.ts';
import { appendDailyNote, homeNoteFile, newNote, notesDir, slugify } from '../src/notes.ts';
import { resolveReview } from '../src/organiser/corrections.ts';
import { currentMark, finishRun, startRun } from '../src/organiser/runs.ts';
import { openDb } from '../src/store/db.ts';
import { Store } from '../src/store/store.ts';

describe('notes in the record folder', () => {
  let home: string;
  let store: Store;
  const now = new Date(2026, 10, 25, 10, 30);

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'skeinwise-notes-'));
    store = new Store(openDb(':memory:'), () => '2026-11-25T10:30:00.000Z');
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('note appends to one daily note per day, each save a version in your name', () => {
    const first = appendDailyNote(store, home, 'Fed the starter at 18:00', now);
    const second = appendDailyNote(store, home, '  Rye proof took\nfour hours  ', now);
    expect(first).toMatchObject({ path: join(notesDir(home), 'daily', '2026-11-25.md'), created: true });
    expect(second).toMatchObject({ path: first.path, created: false, entryId: first.entryId });
    expect(readFileSync(first.path, 'utf8')).toBe('# 2026-11-25\n\n- Fed the starter at 18:00\n- Rye proof took\n  four hours\n');
    expect(statSync(first.path).mode & 0o777).toBe(0o600);
    const entry = store.getEntry(first.entryId)!;
    expect(entry).toMatchObject({ speaker: 'you', kind: 'note', title: '2026-11-25', createdAt: '2026-11-25T09:00:00.000Z', version: 2 });
    expect(store.history(entry.id).map((v) => v.editor)).toEqual(['you', 'you']);
    expect(() => appendDailyNote(store, home, '   ', now)).toThrow(/Give the text/);
  });

  it('new-note starts a titled note and never overwrites one', () => {
    const made = newNote(store, home, '  Garden   plan: beds & paths ', now);
    expect(made.path).toBe(join(notesDir(home), 'garden-plan-beds-paths.md'));
    expect(readFileSync(made.path, 'utf8')).toBe(`---\ncreated: ${now.toISOString()}\n---\n\n# Garden plan: beds & paths\n`);
    expect(store.getEntry(made.entryId)).toMatchObject({ title: 'Garden plan: beds & paths', createdAt: now.toISOString(), body: '# Garden plan: beds & paths' });
    expect(() => newNote(store, home, 'garden plan beds paths', now)).toThrow(/already exists/);
    expect(() => newNote(store, home, '!!!', now)).toThrow(/no letters or digits/);
    expect(slugify('Café Ölçek 2026')).toBe('cafe-olcek-2026');
  });

  it('an edit made in an editor becomes a version of the same entry on the next write', () => {
    const made = newNote(store, home, 'Plan', now);
    writeFileSync(made.path, `${readFileSync(made.path, 'utf8')}\nBeds first, paths after.\n`);
    appendDailyNote(store, home, 'Dug the beds', now);
    expect(store.getEntry(made.entryId)!.body).toBe('# Plan\n\nBeds first, paths after.');
  });

  it('updating a reviewed note rewrites its file below the front matter', () => {
    const made = newNote(store, home, 'Bread', now);
    const note = store.getEntry(made.entryId)!;
    expect(homeNoteFile(store, home, note)).toBe(made.path);
    const runId = startRun(store.db, { task: 'review', engine: 'none', model: null, scope: 'all', mark: currentMark(store.db), now: store.now() });
    const proposed = '# Bread\n\n## Updates\n\n- 2026-11-24: Rye only from now on. (entry #9)\n';
    store.db.prepare("INSERT INTO review_items (note_entry, reasons, proposed, run_id) VALUES (?, '[]', ?, ?)").run(note.id, proposed, runId);
    finishRun(store.db, runId, { counts: {}, tokensIn: 0, tokensOut: 0, now: store.now() });
    const itemId = (store.db.prepare('SELECT id FROM review_items').get() as { id: number }).id;

    const shown = resolveReview(store, home, itemId, 'update', false);
    expect(shown).toMatchObject({ saved: false, version: null });
    expect(shown.diff).toEqual(['  # Bread', '+ ', '+ ## Updates', '+ ', '+ - 2026-11-24: Rye only from now on. (entry #9)']);
    expect(store.getEntry(note.id)!.version).toBe(1);

    const saved = resolveReview(store, home, itemId, 'update', true);
    expect(saved).toMatchObject({ saved: true, version: 2, file: made.path, item: { status: 'updated' } });
    expect(readFileSync(made.path, 'utf8')).toBe(`---\ncreated: ${now.toISOString()}\n---\n\n${proposed}`);
    expect(store.getEntry(note.id)!.body).toBe(proposed.trim());
    // Reading the folder again finds the same text: no further version.
    appendDailyNote(store, home, 'x', now);
    expect(store.getEntry(note.id)!.version).toBe(2);
    expect(() => resolveReview(store, home, itemId, 'skip', false)).toThrow(/already answered \(updated\)/);
  });
});

describe('lineDiff', () => {
  it('marks removed and added lines and cuts long unchanged stretches', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc')).toEqual(['  a', '- b', '+ B', '  c']);
    const before = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 6', 'line six');
    expect(lineDiff(before, after)).toEqual(['  …', '  line 4', '  line 5', '- line 6', '+ line six', '  line 7', '  line 8', '  …']);
    expect(lineDiff('same', 'same')).toEqual([]);
  });
});
