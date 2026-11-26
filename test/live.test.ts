import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { defaultTargets, LiveCapture, statusLines, type Target } from '../src/live/capture.ts';
import { LIVE_COMMANDS } from '../src/live/pending.ts';
import { readFilesUnder, readImports } from '../src/importers/detect.ts';
import { openDb } from '../src/store/db.ts';
import { Store } from '../src/store/store.ts';

let dir: string;
let projects: string;
let downloads: string;
let notes: string;

const line = (type: 'user' | 'assistant', i: number, text: string) =>
  JSON.stringify({
    type,
    sessionId: 's1',
    uuid: `u${i}`,
    timestamp: `2026-11-20T10:0${i}:00.000Z`,
    message: type === 'user' ? { role: 'user', content: text } : { role: 'assistant', content: [{ type: 'text', text }] },
  }) + '\n';

function capture(store: Store, targets: Target[], onSaved?: () => void) {
  return new LiveCapture(store, targets, { statusFile: join(dir, 'live.json'), debounceMs: 50, onSaved });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skeinwise-live-'));
  projects = join(dir, 'projects');
  downloads = join(dir, 'Downloads');
  notes = join(dir, 'vault');
  mkdirSync(join(projects, '-home-me-code'), { recursive: true });
  mkdirSync(downloads);
  mkdirSync(notes);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readFilesUnder', () => {
  it('imports changed files under the folder’s own source, with the ids a full import gives', () => {
    writeFileSync(join(notes, 'a.md'), 'first');
    mkdirSync(join(notes, '.obsidian'));
    writeFileSync(join(notes, '.obsidian', 'b.md'), 'hidden');
    const full = readImports(notes);
    const some = readFilesUnder(notes, ['a.md', '.obsidian/b.md', 'gone.md', '../outside.md']);
    expect(some.map((b) => b.source)).toEqual(full.map((b) => b.source));
    expect(some[0]!.entries!.map((e) => e.externalId)).toEqual(full[0]!.entries!.map((e) => e.externalId));
    expect(readFilesUnder(notes, ['gone.md'])).toEqual([]);
  });
});

describe('live capture', () => {
  it('catches up a growing agent session without duplicating its source', () => {
    const store = new Store(openDb(':memory:'));
    const session = join(projects, '-home-me-code', 's1.jsonl');
    writeFileSync(session, line('user', 1, 'Plan the allotment map') + line('assistant', 2, 'Start with the plots'));
    store.ingest(readImports(projects)[0]!); // an earlier manual import of the whole folder

    const live = capture(store, [{ kind: 'tree', path: projects }]);
    appendFileSync(session, line('user', 3, 'Add the water taps'));
    const status = live.scan(new Date(0));
    expect(status.caught).toEqual([{ label: 'Claude Code', kind: 'claude-code', threads: 1, added: 1, versioned: 0 }]);
    expect(store.sources()).toHaveLength(1);
    expect(store.stats().entries).toBe(3);
    expect(statusLines(status, new Date(Date.parse(status.lastSavedAt!) + 120_000))).toEqual([
      'saved 2 minutes ago',
      'caught up 1 chat from Claude Code',
    ]);

    // The next pass only looks at files changed since the last one.
    utimesSync(session, new Date(0), new Date(0));
    expect(live.scan().caught).toEqual(status.caught);
    expect(store.stats().entries).toBe(3);
  });

  it('proposes chat exports from Downloads for the person’s yes, and nothing else', () => {
    const store = new Store(openDb(':memory:'));
    const claude = [
      { uuid: 'c1', name: 'Bread', created_at: '2026-11-01T00:00:00Z', chat_messages: [{ uuid: 'm1', sender: 'human', text: 'Rye or spelt?', created_at: '2026-11-01T00:00:00Z' }] },
      { uuid: 'c2', name: 'Bikes', created_at: '2026-11-02T00:00:00Z', chat_messages: [{ uuid: 'm2', sender: 'human', text: 'Chain wax', created_at: '2026-11-02T00:00:00Z' }] },
    ];
    writeFileSync(join(downloads, 'export.zip'), zipSync({ 'conversations.json': strToU8(JSON.stringify(claude)) }));
    writeFileSync(join(downloads, 'slides.zip'), zipSync({ 'readme.md': strToU8('not a chat export') }));
    writeFileSync(join(downloads, 'broken.json'), '{ nope');
    const warnings: string[] = [];
    const live = new LiveCapture(store, [{ kind: 'downloads', path: downloads }], { statusFile: join(dir, 'live.json'), onWarning: (w) => warnings.push(w) });
    const first = live.scan(new Date(0));
    // Nothing saved: the export waits as one item, the zip of slides and the broken file aren't proposed.
    expect(first.caught).toEqual([]);
    expect(first.errors).toEqual([]);
    expect(store.stats().entries).toBe(0);
    expect(store.pendingItems().map((p) => [p.sourceKind, p.threads, p.entries, p.origin?.path])).toEqual([['claude', 2, 2, join(downloads, 'export.zip')]]);
    expect(statusLines(first)[1]).toBe('up to date · 1 import waits for your yes: skeinwise live pending');
    expect(warnings).toEqual([`${join(downloads, 'export.zip')}: 2 changes to Claude wait for your yes as #1: skeinwise live pending`]);

    // The record holds none of it until the yes, which reads the zip again (H1).
    expect(store.pendingItem(1)).toMatchObject({ held: false, bytes: 0 });
    expect(store.search('Chain wax')).toEqual([]);
    let out = '';
    const ctx = { io: { out: (t: string) => (out += t), err: () => {}, env: {} }, home: dir, store, values: {}, args: ['1'], json: () => {} };
    expect(LIVE_COMMANDS.accept!(ctx)).toBe(0);
    expect(out).toBe('Took #1 into the record: 2 new, 0 changed (Claude). Each change keeps the version before it.\n');
    expect(store.history(store.search('Chain wax')[0]!.id)[0]).toMatchObject({ origin: { path: join(downloads, 'export.zip') } });
    expect(live.scan(new Date(0)).waiting).toBe(0);

    // A newer export with one changed chat proposes that one change, not the whole export again.
    claude[1]!.chat_messages.push({ uuid: 'm3', sender: 'human', text: 'And the tyres', created_at: '2026-11-03T00:00:00Z' });
    writeFileSync(join(downloads, 'export (1).zip'), zipSync({ 'conversations.json': strToU8(JSON.stringify(claude)) }));
    const second = live.scan(new Date(0));
    expect(second.caught).toEqual([]);
    expect(store.pendingItems().map((p) => [p.id, p.threads, p.entries])).toEqual([[2, 1, 1]]);
    expect(store.stats().entries).toBe(2);
  });

  it('leaves excluded sources out and counts notes as notes', () => {
    const store = new Store(openDb(':memory:'));
    writeFileSync(join(notes, 'plan.md'), 'Plot 12 gets the shed.');
    const live = capture(store, [{ kind: 'tree', path: notes, owner: 'Mara' }]);
    const status = live.scan(new Date(0));
    expect(statusLines(status)[1]).toBe('caught up 1 note from vault');
    const entry = store.allEntries()[0]!;
    expect(entry.speaker).toBe('Mara');

    store.setSourceStatus(store.sources()[0]!.id, 'out');
    writeFileSync(join(notes, 'plan.md'), 'Plot 12 gets the shed and a bench.');
    expect(live.scan(new Date(0)).caught).toEqual(status.caught); // nothing new saved
    expect(store.history(entry.id)).toHaveLength(1);
  });

  it('catches a Word document in a watched folder, and leaves Word’s lock file beside it alone', () => {
    const store = new Store(openDb(':memory:'));
    const w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const doc = `<?xml version="1.0"?><w:document xmlns:w="${w}"><w:body><w:p><w:r><w:t>Plot 12 gets the compost bays.</w:t></w:r></w:p></w:body></w:document>`;
    writeFileSync(join(notes, 'plan.docx'), zipSync({ 'word/document.xml': strToU8(doc) }));
    writeFileSync(join(notes, '~$plan.docx'), 'Mara'); // what Word leaves beside a document it has open: not a zip
    const live = capture(store, [{ kind: 'tree', path: notes }]);
    const status = live.scan(new Date(0));
    expect(status.errors).toEqual([]);
    expect(statusLines(status)[1]).toBe('caught up 1 note from vault');
    expect(store.search('compost').map((e) => e.title)).toEqual(['plan']);
  });

  it('watches folders and imports a change once things go quiet', async () => {
    const store = new Store(openDb(':memory:'));
    let saved = 0;
    const live = capture(store, [{ kind: 'tree', path: notes }], () => (saved += 1));
    live.start();
    try {
      await new Promise((r) => setTimeout(r, 100));
      writeFileSync(join(notes, 'idea.md'), 'A tool shed rota.');
      const deadline = Date.now() + 5000;
      while (!saved && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    } finally {
      live.stop();
    }
    expect(saved).toBe(1);
    expect(store.search('rota')).toHaveLength(1);
  });

  it('only watches places that exist', () => {
    expect(defaultTargets([{ path: notes }], join(dir, 'nohome'))).toEqual([{ kind: 'tree', path: notes, owner: undefined }]);
  });
});
