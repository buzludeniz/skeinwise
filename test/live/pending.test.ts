// LS-03: `skeinwise live pending`, `live accept <n>` and `live reject <n>`, run as the CLI runs them (LIVE_COMMANDS
// with the words after the subcommand). The capture side, Downloads going to pending, is in downloads.test.ts.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Values } from '../../src/cli-organiser.ts';
import { UsageError } from '../../src/errors.ts';
import { openHome } from '../../src/home.ts';
import { LIVE_COMMANDS, LIVE_FLAGS } from '../../src/live/pending.ts';
import type { ImportBatch, Store } from '../../src/store/store.ts';

let dir: string;
let home: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skeinwise-pending-'));
  home = join(dir, 'home');
  store = openHome(home, () => '2026-11-25T10:00:00.000Z');
});
afterEach(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const ORIGIN = { path: '/Users/me/Downloads/conversations.json', sha256: 'a'.repeat(64) };

function exported(sha256 = ORIGIN.sha256): ImportBatch {
  return {
    source: { kind: 'claude', label: 'Claude', location: '' },
    origin: { ...ORIGIN, sha256 },
    threads: [
      {
        externalId: 'c1',
        title: 'Bread',
        entries: [
          { externalId: 'm1', kind: 'message', speaker: 'you', body: 'Rye or spelt?', createdAt: '2026-11-01T00:00:00Z' },
          { externalId: 'm2', kind: 'message', speaker: 'assistant', body: 'Spelt, for the crust.', createdAt: '2026-11-01T00:00:05Z' },
        ],
      },
    ],
  };
}

async function live(args: string[], values: Values & { all?: boolean } = {}): Promise<{ code: number; out: string; json: unknown }> {
  let out = '';
  let json: unknown;
  const [command, ...rest] = args;
  const code = await LIVE_COMMANDS[command!]!({
    io: { out: (t) => (out += t), err: () => {}, env: {} },
    home,
    store,
    values,
    args: rest,
    json: (v) => (json = v),
  });
  return { code, out, json };
}

describe('live pending, accept and reject', () => {
  it('says when nothing waits', async () => {
    expect(await live(['pending'])).toMatchObject({ code: 0, out: 'Nothing waits for your yes.\n' });
  });

  it('lists what waits, with where it came from and why it waits', async () => {
    expect(store.ingest(exported(), { trusted: false }).pendingId).toBe(1);
    const { code, out } = await live(['pending']);
    expect(code).toBe(0);
    expect(out).toBe(
      [
        '1 import waits for your yes:',
        '  #1  Claude · 1 chat, 2 entries to add or change',
        '      from /Users/me/Downloads/conversations.json, seen 2026-11-25 10:00',
        '      found, not chosen by you',
        'Take one into the record: skeinwise live accept <n>',
        'Leave one out for good: skeinwise live reject <n>',
        '',
      ].join('\n'),
    );
    expect((await live(['pending'], { json: true })).json).toEqual(store.pendingItems());
  });

  it('accepts and rejects by number; --all shows the decided ones too', async () => {
    store.ingest(exported(), { trusted: false });
    store.ingest({ ...exported('b'.repeat(64)), threads: [{ externalId: 'c2', title: 'Bikes', entries: [{ externalId: 'm3', kind: 'message', speaker: 'you', body: 'Chain wax', createdAt: '2026-11-02T00:00:00Z' }] }] }, { trusted: false });
    expect(store.stats().entries).toBe(0);

    expect(await live(['accept', '1'])).toMatchObject({
      code: 0,
      out: 'Took #1 into the record: 2 new, 0 changed (Claude). Each change keeps the version before it.\n',
    });
    expect(store.stats().entries).toBe(2);
    expect((await live(['reject', '2'], { json: true })).json).toEqual({ id: 2, status: 'rejected' });
    expect(store.search('Chain wax')).toEqual([]);

    expect((await live(['pending'])).out).toBe('Nothing waits for your yes.\n');
    const all = (await live(['pending'], { all: true })).out;
    expect(all).toMatch(/^2 imports proposed, 0 waiting:\n/);
    expect(all).toContain('  #1  Claude · 1 chat, 2 entries to add or change · accepted 2026-11-25 10:00\n');
    expect(all).toContain('  #2  Claude · 1 chat, 1 entry to add or change · rejected 2026-11-25 10:00\n');
    expect(all).not.toContain('skeinwise live accept');
  });

  it('refuses a number that is missing, unknown or already decided, and changes nothing', async () => {
    store.ingest(exported(), { trusted: false });
    await live(['reject', '1']);
    const refusal = async (args: string[]) => {
      try {
        await live(args);
      } catch (error) {
        expect(error).toBeInstanceOf(UsageError);
        return (error as Error).message;
      }
      throw new Error(`live ${args.join(' ')} did not refuse`);
    };
    expect(await refusal(['accept'])).toBe('Give one number from "skeinwise live pending", for example: skeinwise live accept 1');
    expect(await refusal(['reject', '1', '2'])).toBe('Give one number from "skeinwise live pending", for example: skeinwise live reject 1');
    expect(await refusal(['accept', 'one'])).toBe('Give a pending item number, for example: 12');
    expect(await refusal(['accept', '9'])).toBe('No pending item 9. See them with: skeinwise live pending');
    expect(await refusal(['accept', '1'])).toBe('#1 was already rejected (2026-11-25 10:00).');
    expect(await refusal(['pending', 'now'])).toMatch(/^live pending takes no words/);
    expect(store.stats().entries).toBe(0);
  });

  it('declares the one flag the CLI must parse for them', () => {
    expect(LIVE_FLAGS).toEqual({ all: { type: 'boolean' } });
  });
});
