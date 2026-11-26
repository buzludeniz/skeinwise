import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx, Values } from '../../src/cli-organiser.ts';
import { DEMO_NOW } from '../../src/demo/demo.ts';
import { newNote } from '../../src/notes.ts';
import { main } from '../../src/cli.ts';
import { EXPORT_PLAIN_TEXT, phraseGrid, type SecretIo, SYNC_COMMANDS, SYNC_EXPERIMENTAL, SYNC_FLAGS, SYNC_HELP } from '../../src/sync/commands.ts';
import { readState } from '../../src/sync/sync.ts';
import { closeRecords, openRecord } from './fixture.ts';

// The export and sync commands as the CLI will call them, with a Ctx built here and a fake hidden prompt. These run
// scrypt on its real settings. Every passphrase here is made up for the test.

const PASS = 'made-up test passphrase';

let dir: string;
let n = 0;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'skeinwise-sync-cmd-'));
});
afterAll(() => {
  closeRecords();
  rmSync(dir, { recursive: true, force: true });
});

interface Run {
  code: number;
  out: string;
  err: string;
  json: unknown;
  asked: string[];
}

/** A record folder (a computer) and a way to run a command in it. */
function computer(name = `c${++n}`) {
  const home = join(dir, name);
  const store = openRecord(home);
  const run = async (args: string[], values: Values & Record<string, unknown> = {}, answers: (string | null)[] = [], asked: string[] = []): Promise<Run> => {
    let out = '';
    let err = '';
    let json: unknown;
    const io: SecretIo = {
      out: (t) => (out += t),
      err: (t) => (err += t),
      env: {},
      askSecret: async (prompt) => {
        asked.push(prompt);
        return answers.length ? answers.shift()! : null;
      },
    };
    const [command, ...rest] = args;
    // Sync is experimental: every run here says --experimental unless the test says otherwise.
    const flags: Values & Record<string, unknown> = { experimental: true, ...values };
    const ctx: Ctx = { io, home, store, values: flags, args: rest, json: (v) => (json = v) };
    const code = await SYNC_COMMANDS[command!]!(ctx);
    return { code, out, err, json, asked };
  };
  return { home, store, run };
}

describe('the sync commands', () => {
  // Real scrypt settings take seconds of CPU, more on a loaded machine: this checks the round trip, not the speed.
  it('init, join, restore and status, end to end on the real scrypt settings', async () => {
    const a = computer();
    newNote(a.store, a.home, 'Made-up note', new Date(DEMO_NOW));
    const folder = join(dir, 'cloud');

    const init = await a.run(['sync', 'init', folder], {}, [PASS, PASS]);
    expect(init.code).toBe(0);
    expect(init.asked).toEqual(['Passphrase for the sync (14 or more characters, or 5 or more words): ', 'The same passphrase again: ']);
    expect(init.out).toMatch(/Syncing through .*cloud\. The first bundle holds 1 entries/);
    expect(init.out).toMatch(/shown only this once/);
    const grid = init.out.match(/^ {2}( ?\d{1,2} [a-z]+ *)+$/gm)!;
    expect(grid).toHaveLength(6);
    const phrase = [...grid.join('\n').matchAll(/(\d{1,2}) ([a-z]+)/g)].sort((x, y) => Number(x[1]) - Number(y[1])).map((m) => m[2]).join(' ');
    expect(phrase.split(' ')).toHaveLength(24);
    expect(init.out).not.toContain(PASS);

    const status = await a.run(['sync', 'status']);
    expect(status.out).toMatch(/This computer last pushed or joined push 1.*\nThe folder holds push 1, the newest\./);

    const b = computer();
    const join1 = await b.run(['sync', 'join', folder], {}, [PASS]);
    expect(join1).toMatchObject({ code: 0, asked: ['Passphrase: '] });
    expect(join1.out).toMatch(/now a copy of push 1 .*: 1 entries and 1 notes/);

    const c = computer();
    const phraseFile = join(dir, 'phrase.txt');
    writeFileSync(phraseFile, `${phrase}\n`);
    const restore = await c.run(['sync', 'restore', folder], { 'phrase-file': phraseFile });
    expect(restore).toMatchObject({ code: 0, asked: [] });
    expect(restore.out).toMatch(/The passphrase is unchanged/);

    const push = await b.run(['sync', 'push'], { json: true });
    expect(push.json).toMatchObject({ seq: 2, entries: 1, replaced: null });
    expect((await a.run(['sync', 'status'], { json: true })).json).toMatchObject({ behind: true, folderSeq: 2 });
  }, 30_000);

  it('init with --json gives the phrase to the program that asked, and reads a passphrase file', async () => {
    const a = computer();
    const file = join(dir, 'pass.txt');
    writeFileSync(file, `${PASS}\n`);
    const r = await a.run(['sync', 'init', join(dir, 'cloud-json')], { json: true, 'passphrase-file': file });
    expect(r.asked).toEqual([]);
    expect((r.json as { recoveryPhrase: string }).recoveryPhrase.split(' ')).toHaveLength(24);
    expect(readState(a.home)).toMatchObject({ seq: 1 });
  });

  it('says plainly what is wrong, before asking for anything it would not use', async () => {
    const a = computer();
    await expect(a.run(['sync', 'init', join(dir, 'x1')], {}, [PASS, `${PASS}!`])).rejects.toThrow(/two passphrases differ/);
    await expect(a.run(['sync', 'init', join(dir, 'x2')], {}, [])).rejects.toThrow(/no terminal.*--passphrase-file/);
    await expect(a.run(['sync', 'init', join(dir, 'x3')], {}, ['short'])).rejects.toThrow(/at least 14 characters, or 5 or more words/);
    for (const x of ['x1', 'x2', 'x3']) expect(existsSync(join(dir, x))).toBe(false);
    await expect(a.run(['sync', 'join', join(dir, 'cloud')], { 'phrase-file': 'f' })).rejects.toThrow(/sync join doesn't take --phrase-file.*sync restore/);
    await expect(a.run(['sync', 'push'], { 'passphrase-file': 'f' })).rejects.toThrow(/doesn't take --passphrase-file/);
    await expect(a.run(['sync'])).rejects.toThrow(/Give one of, each with --experimental: skeinwise sync init/);
    await expect(a.run(['sync', 'init'])).rejects.toThrow(/Give one folder/);
    await expect(a.run(['sync', 'push', 'extra'])).rejects.toThrow(/takes no more words/);
    await expect(a.run(['sync', 'push'])).rejects.toThrow(/does not sync yet/);
    await expect(a.run(['sync', 'restore', join(dir, 'cloud')], { 'phrase-file': join(dir, 'missing.txt') })).rejects.toThrow(/Could not read the recovery phrase file/);

    // A record that isn't empty is refused before the passphrase is asked for.
    newNote(a.store, a.home, 'Mine', new Date(DEMO_NOW));
    const asked: string[] = [];
    await expect(a.run(['sync', 'join', join(dir, 'cloud')], {}, [PASS], asked)).rejects.toThrow(/not empty/);
    expect(asked).toEqual([]);
  });

  it('export writes the zip it says it wrote', async () => {
    const a = computer();
    newNote(a.store, a.home, 'Made-up note', new Date(DEMO_NOW));
    const file = join(dir, 'e.zip');
    const r = await a.run(['export', file]);
    expect(r.out).toContain(`Wrote ${file} (`);
    expect(r.out).toMatch(/\): 0 chats, 0 other entries and 1 notes as Markdown/);
    // L18: every export says it is plain text, on stderr so --json output stays one JSON value. The zip is owner-only.
    expect(r.err).toBe(`${EXPORT_PLAIN_TEXT}\n`);
    expect(EXPORT_PLAIN_TEXT).toMatch(/plain text, not encrypted/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const asJson = await a.run(['export', join(dir, 'e2.zip')], { json: true });
    expect(asJson.out).toBe('');
    expect(asJson.err).toContain('not encrypted');
    expect(asJson.json).toMatchObject({ file: join(dir, 'e2.zip') });
    await expect(a.run(['export', file])).rejects.toThrow(/already exists/);
    expect((await a.run(['export', file], { force: true })).code).toBe(0);
    await expect(a.run(['export', 'one', 'two'])).rejects.toThrow(/at most one file/);
  });

  it('exports its flags and help for the CLI', () => {
    expect(SYNC_FLAGS).toEqual({ 'passphrase-file': { type: 'string' }, 'phrase-file': { type: 'string' }, experimental: { type: 'boolean' } });
    expect(SYNC_HELP).toContain('every sync command needs --experimental');
    for (const c of ['export [<file>]', 'sync init <folder>', 'sync push', 'sync join <folder>', 'sync restore <folder>', 'sync status']) expect(SYNC_HELP).toContain(c);
    expect(phraseGrid(Array.from({ length: 24 }, (_, i) => `w${i + 1}`).join(' ')).split('\n')[0]).toBe('   1 w1          7 w7         13 w13        19 w19');
  });
});

// M16 / LS-28: sync stays in v1 as an experiment. It says so and why before it does anything, and a new sync needs a
// passphrase that can hold out against offline guessing at the key file beside the bundle.
describe('sync as an experiment', () => {
  it('refuses every sync command without --experimental, says why, and writes nothing', async () => {
    const a = computer();
    const folder = join(dir, 'gated');
    for (const args of [['sync', 'init', folder], ['sync', 'push'], ['sync', 'join', folder], ['sync', 'restore', folder], ['sync', 'status'], ['sync']]) {
      await expect(a.run(args, { experimental: false }, [PASS, PASS])).rejects.toThrow(/experimental in this version, so it runs only with --experimental/);
    }
    expect(existsSync(folder)).toBe(false);
    for (const limit of ['one sync key for good', 'beside the bundle', 'guess', 'built in memory', 'docs/sync.md']) expect(SYNC_EXPERIMENTAL).toContain(limit);
    // Export is not sync: it needs no flag.
    expect((await a.run(['export', join(dir, 'gated.zip')], { experimental: false })).code).toBe(0);
  });

  it('is not on the command line in 1.0 at all (ruling 5a), so nothing is made', async () => {
    let err = '';
    const io = { out: () => {}, err: (t: string) => void (err += t), env: { SKEINWISE_HOME: join(dir, 'gated-cli') } };
    expect(await main(['sync', 'init', join(dir, 'gated-cli-folder')], io)).toBe(2);
    expect(err).toMatch(/^skeinwise: Unknown command: sync\./);
    expect(existsSync(join(dir, 'gated-cli-folder'))).toBe(false);
  });

  it('refuses a passphrase of 10 or 13 characters, and takes 14 characters or 5 words', async () => {
    const a = computer();
    const file = join(dir, 'short-pass.txt');
    for (const short of ['ten chars!', 'thirteen char']) {
      writeFileSync(file, `${short}\n`);
      await expect(a.run(['sync', 'init', join(dir, `short-${short.length}`)], { 'passphrase-file': file })).rejects.toThrow(/at least 14 characters/);
      expect(existsSync(join(dir, `short-${short.length}`))).toBe(false);
    }
    writeFileSync(file, 'fourteen chars');
    expect((await a.run(['sync', 'init', join(dir, 'fourteen')], { 'passphrase-file': file })).code).toBe(0);
  });
});
