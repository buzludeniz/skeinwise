// `skeinwise restore <entry> <version>`: STORE_COMMANDS, run the way src/cli.ts runs SYNC_COMMANDS.
import { describe, expect, it } from 'vitest';
import type { Ctx, Values } from '../src/cli-organiser.ts';
import { UsageError } from '../src/errors.ts';
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

  it('exports its help line and no flags of its own', () => {
    expect(STORE_FLAGS).toEqual({});
    expect(STORE_HELP).toMatch(/^ {2}restore <entry> <version> +Bring back an old version/);
    expect(Object.keys(STORE_COMMANDS)).toEqual(['restore']);
  });
});
