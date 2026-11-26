// LS-03: `skeinwise live pending`, `live accept <n>` and `live reject <n>`, run as the CLI runs them (LIVE_COMMANDS
// with the words after the subcommand). The capture side, Downloads going to pending, is in downloads.test.ts.

import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Values } from '../../src/cli-organiser.ts';
import { UsageError } from '../../src/errors.ts';
import { openHome } from '../../src/home.ts';
import { readImports } from '../../src/importers/detect.ts';
import { LIVE_COMMANDS, LIVE_FLAGS } from '../../src/live/pending.ts';
import type { ImportBatch, Store } from '../../src/store/store.ts';

let dir: string;
let home: string;
let downloads: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skeinwise-pending-'));
  home = join(dir, 'home');
  downloads = join(dir, 'Downloads');
  mkdirSync(downloads);
  store = openHome(home, () => '2026-11-25T10:00:00.000Z');
});
afterEach(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const BREAD = [
  {
    uuid: 'c1',
    name: 'Bread',
    created_at: '2026-11-01T00:00:00Z',
    chat_messages: [
      { uuid: 'm1', sender: 'human', text: 'Rye or spelt?', created_at: '2026-11-01T00:00:00Z' },
      { uuid: 'm2', sender: 'assistant', text: 'Spelt, for the crust.', created_at: '2026-11-01T00:00:05Z' },
    ],
  },
];
const BIKES = [
  { uuid: 'c2', name: 'Bikes', created_at: '2026-11-02T00:00:00Z', chat_messages: [{ uuid: 'm3', sender: 'human', text: 'Chain wax', created_at: '2026-11-02T00:00:00Z' }] },
];

/** A Claude export saved in Downloads, read as live reads it. Accepting reads the file again. */
function exported(name = 'conversations.json', convs: object[] = BREAD): ImportBatch {
  const path = join(downloads, name);
  writeFileSync(path, JSON.stringify(convs));
  return readImports(path)[0]!;
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
        `      from ${join(downloads, 'conversations.json')}, seen 2026-11-25 10:00`,
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
    store.ingest(exported('conversations (1).json', BIKES), { trusted: false });
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

  it('reads a file held alone again on accept, and refuses it once it changed or is gone (H1)', async () => {
    const batch = exported();
    store.ingest(batch, { trusted: false });
    store.ingest(exported('conversations (1).json', BIKES), { trusted: false });
    const refusal = async (args: string[]) => {
      try {
        await live(args);
      } catch (error) {
        expect(error).toBeInstanceOf(UsageError);
        return (error as Error).message;
      }
      throw new Error(`live ${args.join(' ')} did not refuse`);
    };
    const path = batch.origin!.path;
    writeFileSync(path, JSON.stringify([{ ...BREAD[0], name: 'Bread, edited' }]));
    expect(await refusal(['accept', '1'])).toBe(
      `${path} changed after it was proposed as #1. Nothing was imported: live proposes the file as it is now on its next pass. To drop #1: skeinwise live reject 1`,
    );
    renameSync(join(downloads, 'conversations (1).json'), join(dir, 'moved.json'));
    expect(await refusal(['accept', '2'])).toBe(
      `#2's file is gone: ${join(downloads, 'conversations (1).json')}. Nothing was imported. To drop #2: skeinwise live reject 2`,
    );
    expect(store.stats().entries).toBe(0);
    expect(store.pendingItems().map((p) => p.status)).toEqual(['pending', 'pending']);

    // The same bytes back: accepted, with the file's origin on each version.
    exported();
    expect((await live(['accept', '1'])).code).toBe(0);
    expect(store.history(store.search('Spelt')[0]!.id)[0]).toMatchObject({ origin: batch.origin });
  });

  it('accepts a proposal that keeps its batch (a row from before H1) without reading any file', async () => {
    const id = store.propose(exported(), { reason: 'unconfirmed' })!;
    renameSync(join(downloads, 'conversations.json'), join(dir, 'moved.json'));
    expect(store.pendingItem(id)).toMatchObject({ held: true });
    expect((await live(['pending'])).out).toContain('  #1  Claude · 1 chat, 2 entries to add or change\n');
    expect(await live(['accept', String(id)])).toMatchObject({
      code: 0,
      out: 'Took #1 into the record: 2 new, 0 changed (Claude). Each change keeps the version before it.\n',
    });
    expect(store.stats().entries).toBe(2);
  });

  it('declares the one flag the CLI must parse for them', () => {
    expect(LIVE_FLAGS).toEqual({ all: { type: 'boolean' } });
  });
});
