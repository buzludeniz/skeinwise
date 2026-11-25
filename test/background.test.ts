import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.ts';
import { loadConfig, setConfigValue } from '../src/config.ts';
import { DEMO_NOW, writeDemo } from '../src/demo/demo.ts';
import { openHome } from '../src/home.ts';
import { readImports } from '../src/importers/detect.ts';
import { readStatus, statusLines } from '../src/live/capture.ts';
import { Background, type BackgroundOptions, parsePmset } from '../src/live/organise.ts';
import { type RunOptions, runSteps, steps } from '../src/organiser/organise.ts';
import { RecordView } from '../src/organiser/record.ts';
import { listRuns } from '../src/organiser/runs.ts';
import type { Store } from '../src/store/store.ts';

const NONE: Omit<RunOptions, 'task'> = { scope: { kind: 'all' }, engine: 'none', yes: false, budget: 0, progress: () => {} };
const LATER = '2026-11-21T09:00:00.000Z'; // after the demo's today, so new entries sort last

let dir: string;
let home: string;
let store: Store;
let clock: string;

function background(extra: Partial<BackgroundOptions> = {}): Background {
  return new Background({ store, home, statusFile: join(home, 'live.json'), fetch, env: {}, busy: null, ...extra });
}

/** Adds one note about sourdough, as a capture would. */
function addNote(name: string, text: string): void {
  const vault = join(dir, 'vault');
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, name), text);
  for (const batch of readImports(vault)) store.ingest(batch);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skeinwise-bg-'));
  home = join(dir, 'home');
  clock = DEMO_NOW;
  store = openHome(home, () => clock);
  const exports = join(dir, 'exports');
  writeDemo(exports);
  for (const p of ['chatgpt', 'claude', 'claude-code', 'notes']) for (const b of readImports(join(exports, p))) store.ingest(b);
  setConfigValue(home, 'engine', 'none');
});
afterEach(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('background organising', () => {
  it('leaves a record that was never organised to a first full run', async () => {
    const result = await background().pass();
    expect(result.runs).toEqual([]);
    expect(result.notStarted).toEqual(['tag', 'file', 'link', 'hub', 'review']);
    expect(listRuns(store.db)).toEqual([]);
    expect(statusLines(readStatus(join(home, 'live.json')))[1]).toBe('up to date · not organised yet: run "skeinwise run all" once to start');
  });

  it('organises only what is new, as ordinary runs over scope new', async () => {
    await runSteps(store, new RecordView(store), steps(store, 'all'), NONE);
    const before = listRuns(store.db).length;
    clock = LATER;
    addNote('starter.md', 'Fed the sourdough starter twice today; the rye flour made it rise faster.');

    const result = await background().pass();
    const runs = listRuns(store.db).slice(0, result.runs.length);
    expect(result.entries).toBe(1);
    expect(result.runs.length).toBeGreaterThan(0);
    expect(listRuns(store.db)).toHaveLength(before + result.runs.length);
    expect(runs.every((r) => r.scope === 'new' && r.engine === 'none' && r.status === 'done')).toBe(true);
    expect(new Set(runs.map((r) => r.task))).toEqual(new Set(['tag', 'file', 'link', 'hub', 'review']));
    expect(statusLines(readStatus(join(home, 'live.json')))[1]).toBe('up to date · organised 1 new entry');

    // Nothing new: no runs, and the last useful line stays.
    expect((await background().pass()).runs).toEqual([]);
    expect(statusLines(readStatus(join(home, 'live.json')))[1]).toBe('up to date · organised 1 new entry');
  });

  it('waits while the computer is busy, then tries again', async () => {
    await runSteps(store, new RecordView(store), steps(store, 'all'), NONE);
    addNote('loaf.md', 'The spelt loaf collapsed; shorter proof next time.');
    let reason: string | null = 'the battery is at 12%';
    const passes: string[] = [];
    const bg = background({ busy: () => reason, retryMs: 20, onDone: (o) => passes.push(o.waiting ?? `ran ${o.runs.length}`) });
    bg.trigger();
    await bg.idle();
    expect(passes).toEqual(['the battery is at 12%']);
    expect(statusLines(readStatus(join(home, 'live.json')))[1]).toBe('up to date · organising waits: the battery is at 12%');

    reason = null;
    const deadline = Date.now() + 3000;
    while (passes.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    await bg.idle();
    bg.stop();
    expect(passes[1]).toMatch(/^ran [1-9]/);
  });

  it('runs one more pass, not one per trigger, when captures arrive during a pass', async () => {
    await runSteps(store, new RecordView(store), steps(store, 'all'), NONE);
    let passes = 0;
    const bg = background({ onDone: () => (passes += 1) });
    bg.trigger();
    bg.trigger();
    bg.trigger();
    await bg.idle();
    expect(passes).toBe(2);
  });

  it('keeps an outside model out of the background unless liveRemote is on', async () => {
    await runSteps(store, new RecordView(store), steps(store, 'all'), NONE);
    setConfigValue(home, 'engine', 'remote');
    const result = await background().pass();
    expect(result.waiting).toMatch(/skeinwise config liveRemote on/);
    expect(result.runs).toEqual([]);
  });

  it('stops and says so when the local model server does not answer', async () => {
    await runSteps(store, new RecordView(store), steps(store, 'all'), NONE);
    addNote('crumb.md', 'Open crumb on the third bake.');
    setConfigValue(home, 'engine', 'local');
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const result = await background({ fetch: down }).pass();
    expect(result.error).toMatch(/No model server answers at http:\/\/127\.0\.0\.1:8731\/v1/);
    expect(statusLines(readStatus(join(home, 'live.json')))[1]).toBe(
      'up to date · organising stopped: No model server answers at http://127.0.0.1:8731/v1',
    );
    expect(listRuns(store.db).every((r) => r.status === 'done')).toBe(true);
  });
});

describe('stopping live mid-run', () => {
  it('marks the cut-off run failed, so the next run is not blocked', async () => {
    await runSteps(store, new RecordView(store), steps(store, 'all'), NONE);
    clock = LATER;
    // Close enough to the sourdough hub that refreshing its summary needs the model.
    addNote('levain.md', 'My sourdough starter doubled overnight after I switched to rye flour; the levain is ready in six hours now.');
    setConfigValue(home, 'engine', 'local');
    let asked = false;
    const hanging = (async (input: string | URL | Request) => {
      if (String(input).endsWith('/models')) return Response.json({ data: [{ id: 'models/fake-4b.gguf' }] });
      asked = true;
      return new Promise<Response>(() => {}); // the model never answers
    }) as typeof fetch;
    const bg = background({ fetch: hanging });
    bg.trigger();
    const deadline = Date.now() + 3000;
    while (!asked && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(asked).toBe(true);
    expect(listRuns(store.db)[0]!.status).toBe('running');
    bg.stop();
    expect(listRuns(store.db)[0]).toMatchObject({ status: 'failed', message: expect.stringMatching(/^Stopped: skeinwise live was closed/) });
  });
});

describe('the battery reading', () => {
  it('reads pmset', () => {
    expect(parsePmset("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=4653155)\t15%; discharging; 1:02 remaining present: true")).toEqual({
      percent: 15,
      discharging: true,
    });
    expect(parsePmset("Now drawing from 'AC Power'\n -InternalBattery-0 (id=4653155)\t100%; charged; 0:00 remaining present: true")).toEqual({
      percent: 100,
      discharging: false,
    });
    expect(parsePmset("Now drawing from 'AC Power'")).toBeNull();
  });
});

describe('live settings', () => {
  it('takes folders as paths or JSON, and switches as on or off', () => {
    setConfigValue(home, 'liveFolders', 'notes, mara');
    expect(loadConfig(home).liveFolders).toEqual([{ path: join(process.cwd(), 'notes') }, { path: join(process.cwd(), 'mara') }]);
    setConfigValue(home, 'liveFolders', '[{"path": "mara", "owner": "Mara"}]');
    expect(loadConfig(home).liveFolders).toEqual([{ path: join(process.cwd(), 'mara'), owner: 'Mara' }]);
    expect(() => setConfigValue(home, 'liveFolders', '[{"owner": "Mara"}]')).toThrow(/a list of folders/);
    setConfigValue(home, 'liveOrganise', 'off');
    setConfigValue(home, 'liveRemote', 'yes');
    expect(loadConfig(home)).toMatchObject({ liveOrganise: false, liveRemote: true });
    expect(() => setConfigValue(home, 'liveRemote', 'maybe')).toThrow(/true or false/);
  });
});

describe('skeinwise live --once', () => {
  it('catches up, organises what is new, and reports both', async () => {
    const userHome = join(dir, 'me');
    const projects = join(userHome, '.claude', 'projects', '-home-me-bread');
    mkdirSync(projects, { recursive: true });
    const session = join(projects, 's1.jsonl');
    const line = (i: number, text: string) =>
      JSON.stringify({ type: 'user', sessionId: 's1', uuid: `u${i}`, timestamp: `2026-11-21T10:0${i}:00.000Z`, message: { role: 'user', content: text } }) + '\n';
    writeFileSync(session, line(1, 'Should the sourdough starter live in the fridge between bakes?'));
    store.db.close();

    let out = '';
    const live = () =>
      main(['live', '--once'], { out: (t) => (out += t), err: () => {}, env: { SKEINWISE_HOME: home, HOME: userHome }, now: () => LATER });
    expect(await live()).toBe(0);
    expect(out).toMatch(/caught up 1 chat from Claude Code · not organised yet/);

    store = openHome(home, () => LATER);
    await runSteps(store, new RecordView(store), steps(store, 'all'), NONE);
    store.db.close();

    out = '';
    appendFileSync(session, line(2, 'Kept it in the fridge; it needs two feeds to wake up.'));
    expect(await live()).toBe(0);
    expect(out).toMatch(/caught up 1 chat from Claude Code · organised 1 new entry/);
    expect(JSON.parse(readFileSync(join(home, 'live.json'), 'utf8')).organised.runs.length).toBeGreaterThan(0);
    store = openHome(home, () => LATER); // for afterEach
  });
});
