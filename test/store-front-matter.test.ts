// A note whose front matter changed and whose text didn't: the version hash covers only the text, so the edit was lost.
// It is a new version now, except on a record from before notes kept their front matter, which is filled in place.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readImports } from '../src/importers/detect.ts';
import { openDb } from '../src/store/db.ts';
import { Store } from '../src/store/store.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skeinwise-front-matter-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const TEXT = '# Garden plan\n\nRaised beds by May.\n';

function write(front: string): void {
  writeFileSync(join(dir, 'garden-plan.md'), `${front ? `---\n${front}\n---\n\n` : ''}${TEXT}`);
}

function capture(store: Store) {
  const results = readImports(dir).map((batch) => store.ingest(batch, 'you'));
  return results.reduce((n, r) => ({ versioned: n.versioned + r.versioned, unchanged: n.unchanged + r.unchanged }), { versioned: 0, unchanged: 0 });
}

const entryId = (store: Store) => (store.db.prepare("SELECT id FROM entries WHERE external_id = 'garden-plan.md'").get() as { id: number }).id;

describe('a front-matter-only edit', () => {
  it('becomes a new version with the same text and the new properties', () => {
    const store = new Store(openDb(':memory:'));
    write('status: draft\ntags: [garden]');
    capture(store);
    const id = entryId(store);

    write('status: done\ntags: [garden, beds]');
    expect(capture(store)).toEqual({ versioned: 1, unchanged: 0 });
    const history = store.history(id);
    expect(history.map((v) => [v.version, v.properties])).toEqual([
      [1, { status: 'draft', tags: ['garden'] }],
      [2, { status: 'done', tags: ['garden', 'beds'] }],
    ]);
    expect(history[1]!.contentHash).toBe(history[0]!.contentHash);

    // The same file again, and front matter taken away and put back, each change once.
    expect(capture(store)).toEqual({ versioned: 0, unchanged: 1 });
    write('');
    expect(capture(store)).toEqual({ versioned: 1, unchanged: 0 });
    expect(store.history(id).at(-1)!.properties).toBeNull();
    expect(capture(store)).toEqual({ versioned: 0, unchanged: 1 });
    expect(store.history(id)).toHaveLength(3);
  });

  it('takes a new title from the front matter with it', () => {
    const store = new Store(openDb(':memory:'));
    write('title: Beds');
    capture(store);
    write('title: Raised beds');
    capture(store);
    expect(store.getEntry(entryId(store))!.title).toBe('Raised beds');
  });

  it('gives a record from before notes kept their front matter no new versions, only the properties', () => {
    const store = new Store(openDb(':memory:'));
    write('status: draft\ntags: [garden]');
    capture(store);
    const id = entryId(store);
    // What a record captured before properties were kept holds (migration 5 left them null).
    store.db.exec('UPDATE versions SET properties = NULL');

    expect(capture(store)).toEqual({ versioned: 0, unchanged: 1 });
    expect(store.history(id).map((v) => [v.version, v.properties])).toEqual([[1, { status: 'draft', tags: ['garden'] }]]);
    expect(capture(store)).toEqual({ versioned: 0, unchanged: 1 });
    expect(store.history(id)).toHaveLength(1);
  });

  it('keeps front matter taken away and later put back as two versions, not one rewritten in place', () => {
    const store = new Store(openDb(':memory:'));
    write('status: draft');
    capture(store);
    const id = entryId(store);
    write('');
    capture(store);

    write('status: done');
    expect(capture(store)).toEqual({ versioned: 1, unchanged: 0 });
    expect(store.history(id).map((v) => [v.version, v.properties])).toEqual([
      [1, { status: 'draft' }],
      [2, null],
      [3, { status: 'done' }],
    ]);
  });

  it("carries a note's properties into an edit of its text, so reading the file back adds no version", () => {
    const store = new Store(openDb(':memory:'));
    write('status: draft');
    capture(store);
    const id = entryId(store);
    const edited = '# Garden plan\n\nRaised beds by June.';
    store.editEntry(id, edited, 'you');
    expect(store.history(id).at(-1)!.properties).toEqual({ status: 'draft' });

    // The file as a save writes it: the new text under the same front matter.
    writeFileSync(join(dir, 'garden-plan.md'), `---\nstatus: draft\n---\n\n${edited}\n`);
    expect(capture(store)).toEqual({ versioned: 0, unchanged: 1 });
    expect(store.history(id)).toHaveLength(2);
  });

  it('changes nothing when the text is an older version', () => {
    const store = new Store(openDb(':memory:'));
    write('status: draft');
    capture(store);
    const id = entryId(store);
    store.editEntry(id, '# Garden plan\n\nRaised beds by June.', { editor: 'you' });

    write('status: done');
    expect(capture(store)).toEqual({ versioned: 0, unchanged: 1 });
    // The edit carried the note's properties; the file's older text took none of its front matter in.
    expect(store.history(id).map((v) => v.properties)).toEqual([{ status: 'draft' }, { status: 'draft' }]);
  });
});
