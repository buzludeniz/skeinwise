import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.ts';
import { UsageError } from '../src/errors.ts';
import { openDb } from '../src/store/db.ts';
import { projectFilter, Store } from '../src/store/store.ts';

// `--project`: a blank one is a usage mistake, and on Windows the folder match ignores case, as Windows folders do.

const FOLDERS = ['/home/Mara/Code/Plotline', 'C:\\Users\\Mara\\Code\\Plotline\\Web', '/home/mara/code/ledger', '/home/mara/ÉCOLE'];

describe('search --project', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(openDb(':memory:'), () => '2026-01-01T00:00:00.000Z');
    store.ingest({
      source: { kind: 'claude-code', label: 'Claude Code', location: '/p' },
      threads: FOLDERS.map((project, n) => ({
        externalId: `s${n}`,
        title: `s${n}`,
        entries: [{ externalId: `s${n}:0`, kind: 'message' as const, speaker: 'you', createdAt: '2025-01-01T10:00:00.000Z', body: 'reminders go out', project }],
      })),
    });
  });

  /** The folders a project matches on that platform, by the filter's own SQL. */
  const matched = (project: string, platform: NodeJS.Platform) => {
    const f = projectFilter(project, platform);
    return (store.db.prepare(`SELECT e.project FROM entries e WHERE ${f.sql} ORDER BY e.id`).all(f.param) as { project: string }[]).map((r) => r.project);
  };
  const plotline = FOLDERS.slice(0, 2);

  it('refuses a blank or whitespace-only project as a usage mistake, whatever the words', () => {
    for (const blank of ['', ' ', '\t \n', ' / ', '\\\\']) {
      expect(() => store.search('reminders', { project: blank }), JSON.stringify(blank)).toThrow(UsageError);
      expect(() => store.search('', { project: blank })).toThrow('Give a project: a folder name or a path.');
    }
  });

  it('ignores case on Windows, by name or by full path', () => {
    expect(matched('plotline', 'win32')).toEqual(plotline);
    expect(matched('PLOTLINE', 'win32')).toEqual(plotline);
    expect(matched('code\\PLOTLINE', 'win32')).toEqual(plotline);
    expect(matched('c:\\users\\mara\\code\\plotline', 'win32')).toEqual([plotline[1]]);
    expect(matched('C:/USERS/MARA/CODE/PLOTLINE/WEB/', 'win32')).toEqual([plotline[1]]);
    expect(matched('/HOME/MARA', 'win32')).toEqual([FOLDERS[0], FOLDERS[2], FOLDERS[3]]);
    // Still whole folder names only.
    expect(matched('PLOT', 'win32')).toEqual([]);
    // A to Z fold on both sides alike, so a folder with other letters still matches as written; those keep their case.
    expect(matched('ÉCOLE', 'win32')).toEqual([FOLDERS[3]]);
    expect(matched('ÉcolE', 'win32')).toEqual([FOLDERS[3]]);
    expect(matched('école', 'win32')).toEqual([]);
  });

  it('keeps case elsewhere, as macOS and Linux folders can differ by it', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(matched('Plotline', platform)).toEqual(plotline);
      expect(matched('plotline', platform)).toEqual([]);
      expect(matched('/home/mara', platform)).toEqual([FOLDERS[2], FOLDERS[3]]);
      expect(matched('ÉCOLE', platform)).toEqual([FOLDERS[3]]);
    }
  });

  it('search follows the platform it runs on', () => {
    const hits = store.search('reminders', { project: 'PLOTLINE' }).map((h) => h.project);
    expect(hits.sort()).toEqual(process.platform === 'win32' ? [...plotline].sort() : []);
    expect(store.search('reminders', { project: 'Plotline' }).map((h) => h.project).sort()).toEqual([...plotline].sort());
  });
});

describe('a blank --project on the command line', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'skeinwise-project-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('is a usage mistake (exit 2) for search and ask alike', async () => {
    for (const argv of [['search', 'reminders'], ['ask', 'reminders', '--engine', 'none']]) {
      for (const blank of ['', '   ']) {
        let err = '';
        const code = await main([...argv, '--project', blank], { out: () => {}, err: (t) => (err += t), env: { SKEINWISE_HOME: join(dir, 'home') } });
        expect(code, `${argv[0]} --project ${JSON.stringify(blank)}`).toBe(2);
        expect(err).toContain('Give a project: a folder name or a path.');
      }
    }
  });
});
