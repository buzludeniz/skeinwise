import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageError } from '../../src/errors.ts';
import { deleteView, listViews, MAX_SAVED, saveView, slugFor, ViewNotFound, viewsDir } from '../../src/viewspec/saved.ts';
import { SPEC_LIMITS } from '../../src/viewspec/spec.ts';

const posix = process.platform !== 'win32';
const chart = { v: 1, title: 'Projects over time', show: 'chart', form: 'heatmap', x: 'time', y: 'project' } as const;
let dir: string;
let home: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skeinwise-views-'));
  home = join(dir, 'home');
  mkdirSync(home, { mode: 0o700 });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('slugFor', () => {
  it('makes an id from letters and digits only', () => {
    expect(slugFor('Café & garden, 2025!')).toBe('cafe-garden-2025');
    expect(slugFor('../../etc/passwd')).toBe('etc-passwd');
    expect(slugFor('日本語')).toBe('view');
    expect(slugFor(`${'a'.repeat(31)} b c`)).toBe('a'.repeat(31));
    expect(slugFor('x'.repeat(80))).toHaveLength(32);
  });
});

describe('saving and listing views', () => {
  it('saves a checked spec as a private file named by its title, and lists it', () => {
    const saved = saveView(home, chart);
    expect(saved).toMatchObject({ id: 'projects-over-time', spec: chart });
    const file = join(viewsDir(home), 'projects-over-time.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(chart);
    if (posix) {
      expect(statSync(viewsDir(home)).mode & 0o777).toBe(0o700);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(listViews(home)).toEqual({ views: [{ id: 'projects-over-time', spec: chart, savedAt: saved.savedAt }], broken: [] });
  });

  it('gives a second view with the same title its own id, and never writes over one', () => {
    saveView(home, chart);
    expect(saveView(home, { ...chart, form: 'lines' }).id).toBe('projects-over-time-2');
    expect(saveView(home, chart).id).toBe('projects-over-time-3');
    expect(JSON.parse(readFileSync(join(viewsDir(home), 'projects-over-time.json'), 'utf8')).form).toBe('heatmap');
  });

  // Making a link needs extra rights on Windows.
  it.skipIf(!posix)('never writes through a link that sits where the file would go', () => {
    mkdirSync(viewsDir(home), { mode: 0o700 });
    const outside = join(dir, 'outside.txt');
    writeFileSync(outside, 'keep me');
    symlinkSync(outside, join(viewsDir(home), 'projects-over-time.json'));
    expect(saveView(home, chart).id).toBe('projects-over-time-2');
    expect(readFileSync(outside, 'utf8')).toBe('keep me');
  });

  it('refuses a spec that does not pass, with the reasons', () => {
    expect(() => saveView(home, { ...chart, form: 'pie' })).toThrow(UsageError);
    expect(() => saveView(home, { ...chart, id: '../../escape' })).toThrow(/no field "id"/);
    expect(() => saveView(home, { ...chart, title: 'x'.repeat(SPEC_LIMITS.text) })).toThrow(/longer than/);
    expect(existsSync(viewsDir(home))).toBe(false);
  });

  it(`keeps at most ${MAX_SAVED} views`, () => {
    mkdirSync(viewsDir(home), { mode: 0o700 });
    for (let i = 0; i < MAX_SAVED; i++) writeFileSync(join(viewsDir(home), `v${i}.json`), JSON.stringify({ ...chart, title: `V${i}` }));
    expect(() => saveView(home, chart)).toThrow(/200 saved views/);
    expect(listViews(home).views).toHaveLength(MAX_SAVED);
  });

  it('lists the files that fail with their reasons, and skips names it would never make', () => {
    const views = viewsDir(home);
    mkdirSync(views, { mode: 0o700 });
    writeFileSync(join(views, 'not-json.json'), '{"v":1,');
    writeFileSync(join(views, 'extra.json'), JSON.stringify({ ...chart, onload: 'alert(1)' }));
    writeFileSync(join(views, 'huge.json'), JSON.stringify({ ...chart, title: 'x'.repeat(SPEC_LIMITS.text) }));
    mkdirSync(join(views, 'folder.json'));
    writeFileSync(join(dir, 'elsewhere.json'), JSON.stringify(chart));
    if (posix) symlinkSync(join(dir, 'elsewhere.json'), join(views, 'link.json'));
    writeFileSync(join(views, 'Upper.json'), JSON.stringify(chart));
    writeFileSync(join(views, '.hidden.json'), JSON.stringify(chart));
    writeFileSync(join(views, 'notes.txt'), 'hello');
    const { views: good, broken } = listViews(home);
    expect(good).toEqual([]);
    expect(Object.fromEntries(broken.map((b) => [b.id, b.reasons.join(' ')]))).toEqual({
      extra: expect.stringMatching(/no field "onload"/),
      folder: expect.stringMatching(/isn't a plain file/),
      huge: expect.stringMatching(/larger than 8192 bytes/),
      ...(posix ? { link: expect.stringMatching(/isn't a plain file/) } : {}),
      'not-json': "The view isn't JSON.",
    });
  });

  it('lists nothing when there is no views folder', () => {
    expect(listViews(home)).toEqual({ views: [], broken: [] });
  });

  it.skipIf(!posix)('refuses a views folder that is a link', () => {
    mkdirSync(join(dir, 'real'), { mode: 0o700 });
    symlinkSync(join(dir, 'real'), viewsDir(home));
    expect(() => listViews(home)).toThrow(/isn't a plain folder/);
    expect(() => saveView(home, chart)).toThrow(/isn't a plain folder/);
  });
});

describe('deleting views', () => {
  it('deletes by id, and says when there is no such view', () => {
    saveView(home, chart);
    deleteView(home, 'projects-over-time');
    expect(listViews(home).views).toEqual([]);
    expect(() => deleteView(home, 'projects-over-time')).toThrow(ViewNotFound);
  });

  it('takes only ids the server would make, so no path reaches the disk', () => {
    writeFileSync(join(dir, 'victim.json'), 'keep me');
    saveView(home, chart);
    for (const id of ['../victim', '..', 'A', '', 'a/b', 'a.json', `${'a'.repeat(41)}`, '-a', 'a-']) {
      expect(() => deleteView(home, id), id).toThrow(ViewNotFound);
    }
    expect(readFileSync(join(dir, 'victim.json'), 'utf8')).toBe('keep me');
  });

  it.skipIf(!posix)('removes a link, never what it points at', () => {
    mkdirSync(viewsDir(home), { mode: 0o700 });
    writeFileSync(join(dir, 'target.json'), JSON.stringify(chart));
    symlinkSync(join(dir, 'target.json'), join(viewsDir(home), 'linked.json'));
    deleteView(home, 'linked');
    expect(existsSync(join(viewsDir(home), 'linked.json'))).toBe(false);
    expect(existsSync(join(dir, 'target.json'))).toBe(true);
  });
});
