// `skeinwise restore <entry> <version>`: STORE_COMMANDS, run the way src/cli.ts runs SYNC_COMMANDS.
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Ctx, Values } from '../src/cli-organiser.ts';
import { UsageError } from '../src/errors.ts';
import { newNote, notesDir, readNotes, rewriteNoteFile } from '../src/notes.ts';
import { STORE_COMMANDS, STORE_FLAGS, STORE_HELP } from '../src/store/commands.ts';
import { openDb } from '../src/store/db.ts';
import { Store } from '../src/store/store.ts';

function record() {
  const store = new Store(openDb(':memory:'));
  store.ingest({
    source: { kind: 'notes', label: 'Notes' },
    threads: [],
    entries: [{ externalId: 'plan.md', kind: 'note', speaker: 'you', createdAt: '2026-03-01T10:00:00.000Z', body: 'We picked Postgres.' }],
  });
  store.editEntry(1, 'We picked MongoDB.', { editor: 'you' });
  store.editEntry(1, 'We picked SQLite.', { editor: 'you' });
  const run = (args: string[], values: Values = {}) => {
    let out = '';
    let json: unknown;
    const ctx: Ctx = { io: { out: (t) => (out += t), err: () => {}, env: {} }, home: '/nowhere', store, values, args, json: (v) => (json = v) };
    const code = STORE_COMMANDS.restore!(ctx);
    return { code, out, json };
  };
  return { store, run };
}

describe('restore', () => {
  it('brings an old version back as a new one and keeps every version', () => {
    const { store, run } = record();
    expect(run(['1', '1'])).toEqual({ code: 0, out: 'Entry 1 reads as version 1 again, saved as version 4. Every version is kept.\n', json: undefined });
    expect(store.getEntry(1)!.body).toBe('We picked Postgres.');
    expect(store.history(1).map((v) => [v.version, v.body, v.editor])).toEqual([
      [1, 'We picked Postgres.', 'import'],
      [2, 'We picked MongoDB.', 'you'],
      [3, 'We picked SQLite.', 'you'],
      [4, 'We picked Postgres.', 'you'],
    ]);
    expect(run(['1', '4']).out).toBe('Entry 1 already reads as version 4. Nothing changed.\n');
    expect(run(['1', '2'], { json: true }).json).toEqual({ entry: 1, restored: 2, version: 5, changed: true });
  });

  it('refuses what it cannot do, in words', () => {
    const { store, run } = record();
    expect(() => run([])).toThrow(UsageError);
    expect(() => run(['1'])).toThrow('Give an entry and a version');
    expect(() => run(['1', '2', '3'])).toThrow('Give an entry and a version');
    expect(() => run(['x', '1'])).toThrow(/entry number/);
    expect(() => run(['1', '0'])).toThrow(/version number/);
    expect(() => run(['9', '1'])).toThrow('No entry 9.');
    expect(() => run(['1', '7'])).toThrow('Entry 1 has no version 7: it has 1 to 3.');
    expect(store.history(1)).toHaveLength(3);
  });

  describe('a note kept in the record folder', () => {
    let home: string;
    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'skeinwise-restore-'));
    });
    afterEach(() => {
      rmSync(home, { recursive: true, force: true });
    });

    /** A note at version 3 in its file and the record: started, then edited twice in the file and read in each time. */
    function note() {
      const store = new Store(openDb(':memory:'));
      const made = newNote(store, home, 'Garden plan', new Date('2026-11-25T09:00:00Z'));
      for (const month of ['May', 'June']) {
        rewriteNoteFile(made.path, `# Garden plan\n\nRaised beds by ${month}.`);
        readNotes(store, home);
      }
      const run = (args: string[]) => {
        let out = '';
        const ctx: Ctx = { io: { out: (t) => (out += t), err: () => {}, env: {} }, home, store, values: {}, args, json: () => {} };
        return { code: STORE_COMMANDS.restore!(ctx), out };
      };
      const front = readFileSync(made.path, 'utf8').split('# Garden plan')[0]!;
      return { store, id: made.entryId, path: made.path, front, run };
    }

    it('writes the file too, so a capture after it keeps the restored text', () => {
      const { store, id, path, front, run } = note();
      expect(store.history(id).map((v) => v.version)).toEqual([1, 2, 3]);
      expect(run([String(id), '2']).out).toBe(`Entry ${id} reads as version 2 again, saved as version 4. Every version is kept.\n`);
      // The front matter stays as it was; the text below it is version 2's.
      expect(readFileSync(path, 'utf8')).toBe(`${front}# Garden plan\n\nRaised beds by May.\n`);

      readNotes(store, home);
      expect(store.history(id)).toHaveLength(4);
      expect(store.getEntry(id)!.body).toBe('# Garden plan\n\nRaised beds by May.');
      // The next edit in the file builds on the restored text, not on June's.
      writeFileSync(path, `${readFileSync(path, 'utf8')}Paths of bark.\n`);
      readNotes(store, home);
      expect(store.getEntry(id)!.body).toBe('# Garden plan\n\nRaised beds by May.\nPaths of bark.');
      expect(store.history(id)).toHaveLength(5);
    });

    it('refuses a file changed since the record last read it, and writes nothing', () => {
      const { store, id, path, front, run } = note();
      const edited = `${front}# Garden plan\n\nRaised beds by July.\n`;
      writeFileSync(path, edited);
      expect(() => run([String(id), '2'])).toThrow(
        `notes/garden-plan.md holds an edit the record hasn't read yet, so it stays as it is. Nothing was restored.`,
      );
      expect(readFileSync(path, 'utf8')).toBe(edited);
      expect(store.history(id)).toHaveLength(3);

      // A file that already reads as the version asked for (a restore that stopped before the record) goes on.
      writeFileSync(path, `${front}# Garden plan\n\nRaised beds by May.\n`);
      expect(run([String(id), '2']).code).toBe(0);
      expect(store.getEntry(id)!.body).toBe('# Garden plan\n\nRaised beds by May.');
      expect(readFileSync(path, 'utf8')).toBe(`${front}# Garden plan\n\nRaised beds by May.\n`);
    });

    it('refuses a link at the note path, and writes through nothing', () => {
      const { store, id, path, run } = note();
      const outside = join(home, 'outside.md');
      writeFileSync(outside, '# Garden plan\n\nRaised beds by June.\n');
      unlinkSync(path);
      symlinkSync(outside, path);
      expect(() => run([String(id), '1'])).toThrow(
        "notes/garden-plan.md is a link, and Skeinwise doesn't write through links in the notes folder. Nothing was restored.",
      );
      expect(readFileSync(outside, 'utf8')).toBe('# Garden plan\n\nRaised beds by June.\n');
      expect(store.history(id)).toHaveLength(3);
    });

    it('restores the record alone when the file is gone, or is a Word document it only reads', () => {
      const { store, id, path, run } = note();
      unlinkSync(path);
      expect(run([String(id), '2']).code).toBe(0);
      expect(store.getEntry(id)!.body).toBe('# Garden plan\n\nRaised beds by May.');

      store.ingest({
        source: { kind: 'notes', label: 'Notes', location: notesDir(home) },
        threads: [],
        entries: [{ externalId: 'budget.docx', kind: 'note', speaker: 'you', createdAt: '2026-11-25T09:00:00.000Z', body: 'Seeds: 40.' }],
      });
      const word = store.db.prepare("SELECT id FROM entries WHERE external_id = 'budget.docx'").get() as { id: number };
      store.editEntry(word.id, 'Seeds: 55.', { editor: 'you' });
      const docx = join(notesDir(home), 'budget.docx');
      writeFileSync(docx, 'PK\u0003\u0004 not text');
      expect(run([String(word.id), '1']).out).toBe(
        `Entry ${word.id} reads as version 1 again, saved as version 3. Every version is kept.\n` +
          "Its file notes/budget.docx is a Word document, which Skeinwise doesn't write, so it still holds the newer text.\n",
      );
      expect(readFileSync(docx, 'utf8')).toBe('PK\u0003\u0004 not text');
    });
  });

  it('exports its help line and the --project flag', () => {
    expect(STORE_FLAGS).toEqual({ project: { type: 'string' } });
    expect(STORE_HELP).toMatch(/^ {2}restore <entry> <version> +Bring back an old version/);
    expect(Object.keys(STORE_COMMANDS)).toEqual(['restore']);
  });
});
