import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_NOW, importDemo } from '../src/demo/demo.ts';
import { type RunOptions, runSteps, steps } from '../src/organiser/organise.ts';
import { RecordView } from '../src/organiser/record.ts';
import { findSchema, liveHubs, liveTags, openReviewItems } from '../src/organiser/views.ts';
import { openDb } from '../src/store/db.ts';
import { Store } from '../src/store/store.ts';

// LS-23: the demo record is about 600 invented entries in 8 hubs, the same on every build, with few review items and
// one plainly wrong tag to undo.

const NONE: Omit<RunOptions, 'task'> = { scope: { kind: 'all' }, engine: 'none', yes: false, budget: 0, progress: () => {} };

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** The demo as `skeinwise demo` builds it, then organised with the No-AI engine. */
async function organisedDemo() {
  const dir = mkdtempSync(join(tmpdir(), 'skeinwise-demo-'));
  dirs.push(dir);
  const store = new Store(openDb(':memory:'), () => DEMO_NOW);
  const start = performance.now();
  const built = importDemo(store, dir);
  const ms = performance.now() - start;
  await runSteps(store, new RecordView(store), steps(store, 'all'), NONE);
  return { dir, store, built, ms };
}

function noteId(store: Store, title: string): number {
  const row = store.db.prepare("SELECT id FROM entries WHERE kind = 'note' AND title = ?").get(title) as { id: number } | undefined;
  if (!row) throw new Error(`No note "${title}" in the demo`);
  return row.id;
}

/**
 * Real people and names the demo must never carry: the owner, the team and their handles, their employer, and the
 * app that inspired Skeinwise. Each is the SHA-256 of the lowercased name, so the names never enter the repo.
 */
const DENYLIST = new Set([
  'bb7c3c159685e879e90e657a0675cafb2ff2312266375c11bfce3fd537f196d7',
  '166c554abc5b9b5534793b46fd3fec22d3a2ad9e0ba764458ce4b94c6f6875f6',
  '284816c4fa0682b32406e104b6de9d6cad11229ac97370c0ce030369b491ccfe',
  '4c871bd14c560d2632c33a24981daf67ca31f3547b31f0671e7e33c332769887',
  '519ec30131d63d2a977aaa77a613bf055b6aea6a67dc2178171dc2c58d7b9a15',
  '043ccc0426d6d4c8c403de8ca94477fe1a9ca5728163d08f3f1867f7c20a3993',
  'e889a38cbc1f66d879c62d6d22d70f62536f9d7479271cae4008aee9cde9fc76',
  'bac09cd999f852bd46580f18852ff98924025f90a0cd15f9fa3c1106d4806c81',
  '7ff26ca7636fecde95757c88c79117cd5733344dce935994ba0683bd8ae30471',
  '5800968f85738ac4927e74ebe83ec19c2e03682850be8c9dce4c4a4e976d18ce',
  'f893be9b54729993e7476d672eb8475b7bcd20c22efb3928d94a5d098c1785ca',
  'e0e55fc53fd31e8fe88203e5b2f1d4515ee12e6acc13767a67768f0135b25289',
  '5611f3f3b5cd056f0d0354ca701c4d736d3ac8d26f0ce80befbfe1864fc1cbb0',
  'afb08ef56aa62c43de5781427cffeb57b7997bd78aa234519f5d61c61b5bcbd6',
  'fe858d01b2859e4fc45fcf07ecc70a6de208d7fd2ac6952f470e7c816bd32e0c',
  '1cde48a225ceb31a23a730036134111d9c934d42050e080998f55730bb077ab8',
  'ff4da50e74d1f28b1e7ff7f2aef9a88609e6880e50ea3a7632f0693cf2f64be2',
  '144ee77b3ff1a60f922ee16bbc6feb5ae79b04eeacfada3931698719621106ea',
  'a6d6f4f8111c726ae30112ebbb64f86bf41cef154e4820fa787b96147ced12d5',
  '6797779828dd910b5ccb995ad0536e25e1780054a76824f64f179cacd4b17c4a',
  '1d358acca59a6bfe21ee30fb1616b3d243afa5e1f882aed8594fb47ae0e43d1c',
  'a253f3f984b8ee9d47acf254556499e555f8f527a4b9a1e27c9a1dc5db8c6865',
  'e5c49e885dd61c63f8fbc6828c38058cf6074408e79caad803c45c2fb329cebf',
  '2a87b76a5e048ee27f960211fd14d08ddc3034d4f938a572b0bb045ef02ee61f',
  '7cffb68463788e79cf38873c3f2603a89e829f2cf4e38207cbac4f47ee0acf5f',
  '807950c4fb8edda64b09ca36456b61683bab85202f56f4b1e5eaa85437780b18',
  'cdf78da151b27489c29a27dd1b45cd9cd46e2fe028ff780867706cfb58ea6663',
  '2f52b7dd3fce87dd618ed9383c0f3554039b9d609ea30db89ceb218d85b19667',
  'dca0fd5b708ac610c0c3611083119e463a56b07879b7beda363434d3b5150800',
]);

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** Every word, and every two words together (spaced and joined), of `text` whose hash is in `list`. */
function namesIn(text: string, list: Set<string>): string[] {
  const words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const found = new Set<string>();
  words.forEach((word, i) => {
    const next = words[i + 1];
    for (const c of next ? [word, `${word} ${next}`, `${word}${next}`] : [word]) if (list.has(sha(c))) found.add(c);
  });
  return [...found];
}

describe('the demo record', () => {
  let demo: Awaited<ReturnType<typeof organisedDemo>>;
  beforeAll(async () => {
    demo = await organisedDemo();
  });

  it('builds about 600 entries in under a second', () => {
    expect(demo.ms).toBeLessThan(1000);
    const added = demo.built.results.reduce((n, r) => n + r.added, 0);
    expect(added).toBeGreaterThanOrEqual(550);
    expect(added).toBeLessThanOrEqual(650);
    expect(demo.built.summary.threads).toBeGreaterThan(100);
  });

  it('groups into the same 8 hubs on every build', async () => {
    const names = liveHubs(demo.store.db).map((h) => h.name);
    expect(names).toHaveLength(8);
    expect(names.some((n) => /Plotline/.test(n))).toBe(true);
    const again = await organisedDemo();
    expect(liveHubs(again.store.db).map((h) => h.name)).toEqual(names);
  });

  it('flags 3 notes or fewer for review: the two Plotline notes the waiting list story overtook', () => {
    const titles = openReviewItems(demo.store.db).map((i) => demo.store.getEntry(i.noteEntry)!.title);
    expect(titles.length).toBeLessThanOrEqual(3);
    expect(titles.sort()).toEqual(['Plotline', 'Plotline waiting list rules']);
  });

  it('tags "Sourdough schedule" finance, the wrong tag kept for showing undo', () => {
    const areas = findSchema(demo.store.db, 'Areas')!;
    const finance = liveTags(demo.store.db, areas.id).find((t) => t.name === 'finance')!;
    expect(finance.entryIds).toContain(noteId(demo.store, 'Sourdough schedule'));
  });

  it('carries no real name, email address or home folder', () => {
    // The check itself: one word, two words, and two words run together.
    const invented = new Set([sha('okafor'), sha('wend lane'), sha('platform9')]);
    expect(namesIn('Dr Okafor walked down Wend  Lane to Platform 9.', invented).sort()).toEqual(['okafor', 'platform9', 'wend lane']);

    const files = readdirSync(demo.dir, { recursive: true, withFileTypes: true })
      .filter((f) => f.isFile())
      .map((f) => join(f.parentPath, f.name));
    expect(files.length).toBeGreaterThan(10);
    const sources = ['content.ts', 'demo.ts'].map((f) => join(import.meta.dirname, '..', 'src', 'demo', f));
    for (const file of [...files, ...sources]) {
      const text = readFileSync(file, 'utf8');
      expect(namesIn(text, DENYLIST), file).toEqual([]);
      expect(text.match(/[\w.+-]+@[\w-]+\.[a-z]{2,}/gi), file).toBeNull();
      expect(text.match(/\/(?:Users|home)\/(?!demo\/)[\w.-]+/g), file).toBeNull();
    }
  });
});
