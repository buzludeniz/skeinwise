// A Projects tag goes on its note and every entry that links to it. An entry that only names the project gets it when
// the name's words stand side by side, in order, and the name stands out in the record: rare, or written as a name.
// A note called "Work" used to tag every entry that said "work".
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_NOW, importDemo } from '../src/demo/demo.ts';
import { readImports } from '../src/importers/detect.ts';
import { type RunOptions, runTask } from '../src/organiser/organise.ts';
import { RecordView } from '../src/organiser/record.ts';
import { nameUses } from '../src/organiser/tags.ts';
import { findSchema, liveTags } from '../src/organiser/views.ts';
import { openDb } from '../src/store/db.ts';
import { Store } from '../src/store/store.ts';

const NONE: Omit<RunOptions, 'task'> = { scope: { kind: 'all' }, engine: 'none', yes: false, budget: 0, progress: () => {} };

/** Each Projects tag (lower-cased) → the titles of the entries it tags, sorted. */
async function projects(store: Store): Promise<Map<string, string[]>> {
  await runTask(store, new RecordView(store), { ...NONE, task: 'tag', schema: findSchema(store.db, 'Projects')! });
  const title = new Map(store.allEntries().map((e) => [e.id, e.title ?? `#${e.id}`]));
  return new Map(liveTags(store.db, findSchema(store.db, 'Projects')!.id).map((t) => [t.name.toLowerCase(), t.entryIds.map((id) => title.get(id)!).sort()]));
}

describe('Projects name matches', () => {
  let dir: string;
  let store: Store;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skeinwise-project-names-'));
    store = new Store(openDb(':memory:'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const notes = (files: Record<string, string>) => {
    for (const [title, body] of Object.entries(files)) writeFileSync(join(dir, `${title}.md`), `# ${title}\n\n${body}\n`);
    for (const b of readImports(dir)) store.ingest(b, 'you');
  };

  it('a common word written in lowercase tags only its note and the entries that link to it', async () => {
    notes({
      Work: 'Hours, the commute, the standing desk.',
      Monday: 'Plan the week for [[Work]].',
      Payslips: 'Filed under [[Work]].',
      Fence: 'The work on the fence took all day.',
      Peas: 'Sowing is slow work in cold soil.',
      Bread: 'The dough needs more work before it rests.',
      Bike: 'The gears work again after the clean.',
    });
    expect((await projects(store)).get('work')).toEqual(['Monday', 'Payslips', 'Work']);
  });

  it('a name only matches its words side by side and in order', async () => {
    notes({
      'Wend river survey': 'Counts of eels and water voles, monthly.',
      June: 'Notes for the [[Wend river survey]].',
      July: 'More for the [[Wend river survey]].',
      Eels: 'Eels counted for the Wend river survey at the weir.',
      Voles: 'Two voles seen on the Wend river survey this week.',
      Kit: 'Waders packed for the Wend river survey.',
      Scattered: 'The river was high, so the survey of Wend waited.',
    });
    expect((await projects(store)).get('wend river survey')).toEqual(['Eels', 'July', 'June', 'Kit', 'Voles', 'Wend river survey']);
  });

  it('a name that opens a sentence or a line is not counted as written as a name', async () => {
    notes({
      Garden: 'Beds, paths and the shed.',
      Spring: 'Dig over the [[Garden]].',
      Autumn: 'Rake the [[Garden]].',
      Rain: 'Garden paths flooded. Garden beds too! Garden shed dry?',
      Wind: 'Garden fence down again.\nGarden gate off its hinge.',
      List: 'To do:\n- Garden gate\n- Garden tap\n- Garden lights\n1. Garden bench',
      Week: 'Garden on Monday.\nGarden on Friday.\n\nGarden all of Sunday.',
      Shed: 'The garden shed leaks.',
      Hose: 'A new hose for the garden.',
      Slugs: 'Slugs all over the garden.',
    });
    const record = new RecordView(store);
    const [garden] = nameUses(record.entries, ['Garden'], new Map());
    // Thirteen capitals, every one opening a sentence or a line, and three lowercase uses mid-sentence: counting the
    // openers would make it 13 in 16, written as a name.
    expect(garden).toMatchObject({ mid: 3, asTitle: 0 });
    expect((await projects(store)).get('garden')).toEqual(['Autumn', 'Garden', 'Spring']);
  });

  it("a number in a name is part of it: one numbered note doesn't name the others", async () => {
    notes({
      'Hiring note 12': 'Two interviews booked.',
      'Hiring note 13': 'One offer out.',
      'Hiring note 14': 'Nobody this week.',
      Monday: 'See [[Hiring note 12]].',
      Tuesday: 'More in [[Hiring note 12]].',
    });
    expect((await projects(store)).get('hiring note 12')).toEqual(['Hiring note 12', 'Monday', 'Tuesday']);
  });

  it('Plotline still tags the demo entries that name it without linking to it', async () => {
    const demo = new Store(openDb(':memory:'), () => DEMO_NOW);
    importDemo(demo, dir);
    const tagged = (await projects(demo)).get('plotline')!;
    const crash = demo.allEntries().find((e) => e.body.startsWith('Plotline crashed last night'))!;
    expect(crash.body).not.toContain('[[');
    expect(tagged).toContain(crash.title ?? `#${crash.id}`);
    const backup = demo.allEntries().find((e) => /^Write the deploy checklist for Plotline/.test(e.body))!;
    expect(tagged).toContain(backup.title ?? `#${backup.id}`);
  });
});
