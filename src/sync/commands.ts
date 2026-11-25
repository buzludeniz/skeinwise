// The export and sync commands. The CLI wires SYNC_COMMANDS into its command table and SYNC_FLAGS into its parser;
// each command takes the same Ctx as the organiser's. A passphrase or recovery phrase comes from a hidden prompt or
// from a file (--passphrase-file, --phrase-file), never from a flag's value, which would sit in the shell's history.
// Sync is experimental in v1: every sync command needs --experimental, and the refusal says why (docs/sync.md).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import type { Io } from '../cli.ts';
import type { Ctx } from '../cli-organiser.ts';
import { UsageError } from '../errors.ts';
import { day, minute } from '../format.ts';
import { gigabytes } from '../model-commands.ts';
import { writeExport } from './export.ts';
import { checkPassphrase, MIN_PASSPHRASE, MIN_PASSPHRASE_WORDS, PHRASE_WORDS } from './keys.ts';
import { checkJoin, checkStart, joinSync, pushSync, startSync, syncStatus } from './sync.ts';

type Command = (ctx: Ctx) => number | Promise<number>;

/** The flags these commands read, for the CLI's parseArgs options (--json and --force it has already). */
export const SYNC_FLAGS = {
  'passphrase-file': { type: 'string' },
  'phrase-file': { type: 'string' },
  experimental: { type: 'boolean' },
} as const;

interface SyncValues {
  json?: boolean;
  force?: boolean;
  experimental?: boolean;
  'passphrase-file'?: string;
  'phrase-file'?: string;
}

export const SYNC_HELP = `Export and sync (the bundle is encrypted; nothing goes to any server):
  export [<file>]           Write a zip of the record: chats, entries and notes as Markdown, and
                            the tags, folders, hubs and runs as JSON (--force to replace the file)
  Sync is experimental: every sync command needs --experimental. Its limits are in docs/sync.md.
  sync init <folder>        Sync through a folder, such as one in a cloud drive: asks for a
                            passphrase, shows a ${PHRASE_WORDS}-word recovery phrase once, writes the first bundle
      --passphrase-file <file>  Read the passphrase from a file instead of asking
  sync push                 Write a fresh bundle of the whole record to the folder
      --force               Replace a bundle another computer pushed since this one last did
  sync join <folder>        Make this computer's empty record a copy of the folder's (passphrase)
  sync restore <folder>     The same with the recovery phrase (--phrase-file <file> to read it)
  sync status               The folder, the last push, and whether another computer pushed since
`;

/** A CLI's Io may bring its own hidden prompt (tests do); otherwise the terminal is asked, with typing hidden. */
export interface SecretIo extends Io {
  askSecret?: (prompt: string) => Promise<string | null>;
}

/** Asks on the terminal without showing what is typed. Null when there is no terminal to ask on. */
async function askHidden(prompt: string): Promise<string | null> {
  if (!process.stdin.isTTY) return null;
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) process.stderr.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  const stop = new AbortController();
  rl.on('SIGINT', () => stop.abort());
  try {
    const answer = rl.question(prompt, { signal: stop.signal }); // writes the prompt before returning
    muted = true;
    return await answer;
  } catch (err) {
    if (stop.signal.aborted) throw new UsageError('Stopped. Nothing was written.');
    throw err;
  } finally {
    process.stderr.write('\n');
    rl.close();
  }
}

function ask(ctx: Ctx): (prompt: string) => Promise<string | null> {
  return (ctx.io as SecretIo).askSecret ?? askHidden;
}

/** A secret from a file: its text without the final line break an editor adds. */
function readSecretFile(path: string, what: string): string {
  let text: string;
  try {
    text = readFileSync(resolve(path), 'utf8');
  } catch {
    throw new UsageError(`Could not read the ${what} file ${path}.`);
  }
  return text.replace(/\r?\n$/, '');
}

const NO_TERMINAL = 'There is no terminal to ask on. Give the passphrase in a file instead: --passphrase-file <file>';

/** The passphrase for a new sync: from the file, or asked twice. */
async function newPassphrase(ctx: Ctx): Promise<string> {
  const file = (ctx.values as SyncValues)['passphrase-file'];
  if (file) return checkPassphrase(readSecretFile(file, 'passphrase'));
  const first = await ask(ctx)(`Passphrase for the sync (${MIN_PASSPHRASE} or more characters, or ${MIN_PASSPHRASE_WORDS} or more words): `);
  if (first === null) throw new UsageError(NO_TERMINAL);
  const pass = checkPassphrase(first);
  const again = await ask(ctx)('The same passphrase again: ');
  if (again === null) throw new UsageError(NO_TERMINAL);
  if (again.normalize('NFC') !== pass) throw new UsageError('The two passphrases differ. Nothing was written.');
  return pass;
}

async function passphrase(ctx: Ctx): Promise<string> {
  const file = (ctx.values as SyncValues)['passphrase-file'];
  if (file) return readSecretFile(file, 'passphrase');
  const pass = await ask(ctx)('Passphrase: ');
  if (pass === null) throw new UsageError(NO_TERMINAL);
  return pass;
}

async function recoveryPhrase(ctx: Ctx): Promise<string> {
  const file = (ctx.values as SyncValues)['phrase-file'];
  if (file) return readSecretFile(file, 'recovery phrase');
  const phrase = await ask(ctx)(`Recovery phrase (${PHRASE_WORDS} words): `);
  if (phrase === null) throw new UsageError('There is no terminal to ask on. Give the recovery phrase in a file instead: --phrase-file <file>');
  return phrase;
}

/** The phrase as a numbered grid, read down each column: how it is easiest to copy onto paper. */
export function phraseGrid(phrase: string): string {
  const words = phrase.split(' ');
  const rows = Math.ceil(words.length / 4);
  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    const cells: string[] = [];
    for (let c = 0; c < 4; c++) {
      const i = c * rows + r;
      if (i < words.length) cells.push(`${String(i + 1).padStart(2)} ${words[i]!.padEnd(8)}`);
    }
    lines.push(`  ${cells.join('   ').trimEnd()}`);
  }
  return `${lines.join('\n')}\n`;
}

// export

const exportCommand: Command = (ctx) => {
  if (ctx.args.length > 1) throw new UsageError('Give at most one file to write, for example: skeinwise export ~/skeinwise.zip');
  const file = resolve(ctx.args[0] ?? `skeinwise-export-${day(ctx.store.now())}.zip`);
  const r = writeExport(ctx.store, ctx.home, file, { force: (ctx.values as SyncValues).force });
  if (ctx.values.json) ctx.json(r);
  else {
    ctx.io.out(`Wrote ${r.file} (${gigabytes(r.bytes)}): ${r.chats} chats, ${r.entries} other entries and ${r.notes} notes as Markdown,\n`);
    ctx.io.out(`with ${r.hubs} hubs, ${r.runs} runs, and the tags and folders as JSON.\n`);
  }
  return 0;
};

// sync

function noWords(rest: string[], usage: string): void {
  if (rest.length) throw new UsageError(`${usage} takes no more words.`);
}

function oneFolder(rest: string[], usage: string): string {
  if (rest.length !== 1) throw new UsageError(`Give one folder, for example: skeinwise ${usage} ~/Dropbox/skeinwise`);
  return rest[0]!;
}

function onlyFlag(ctx: Ctx, allowed: keyof SyncValues | null, what: string): void {
  const v = ctx.values as SyncValues;
  for (const flag of ['passphrase-file', 'phrase-file'] as const) {
    if (v[flag] && flag !== allowed) {
      const hint = flag === 'phrase-file' ? ' To open the sync with the recovery phrase: skeinwise sync restore <folder> --phrase-file <file> --experimental' : '';
      throw new UsageError(`${what} doesn't take --${flag}.${hint}`);
    }
  }
}

async function init(ctx: Ctx, folder: string): Promise<number> {
  onlyFlag(ctx, 'passphrase-file', 'sync init');
  checkStart(ctx.home, folder);
  const pass = await newPassphrase(ctx);
  const s = startSync(ctx.store, ctx.home, folder, pass);
  if (ctx.values.json) {
    ctx.json({ folder: s.folder, seq: s.seq, entries: s.entries, bytes: s.bytes, recoveryPhrase: s.phrase });
    return 0;
  }
  ctx.io.out(`Syncing through ${s.folder}. The first bundle holds ${s.entries} entries (${gigabytes(s.bytes)}).\n\n`);
  ctx.io.out('Your recovery phrase. It is shown only this once:\n\n');
  ctx.io.out(phraseGrid(s.phrase));
  ctx.io.out(
    '\nWrite it down and keep it away from this computer. If the passphrase is ever lost, the phrase opens the sync:\n' +
      `  skeinwise sync restore ${s.folder} --experimental\n` +
      'Skeinwise keeps neither. Without both, the bundle can never be opened again.\n\n' +
      `On another computer: skeinwise sync join ${s.folder} --experimental\nAfter changes here: skeinwise sync push --experimental\n`,
  );
  return 0;
}

function push(ctx: Ctx): number {
  onlyFlag(ctx, null, 'sync push');
  const p = pushSync(ctx.store, ctx.home, { force: (ctx.values as SyncValues).force });
  if (ctx.values.json) ctx.json(p);
  else {
    if (p.replaced) ctx.io.out(`Replaced push ${p.replaced.seq} from another computer (${minute(p.replaced.createdAt)}).\n`);
    ctx.io.out(`Pushed ${p.entries} entries to ${p.folder} (push ${p.seq}, ${gigabytes(p.bytes)}).\n`);
  }
  return 0;
}

async function join(ctx: Ctx, folder: string, by: 'passphrase' | 'phrase'): Promise<number> {
  onlyFlag(ctx, by === 'passphrase' ? 'passphrase-file' : 'phrase-file', by === 'passphrase' ? 'sync join' : 'sync restore');
  checkJoin(ctx.store, ctx.home, folder);
  const secret = by === 'passphrase' ? { passphrase: await passphrase(ctx) } : { phrase: await recoveryPhrase(ctx) };
  const j = joinSync(ctx.store, ctx.home, folder, secret);
  if (ctx.values.json) {
    ctx.json(j);
    return 0;
  }
  ctx.io.out(`This record is now a copy of push ${j.seq} (${minute(j.pushedAt)}) in ${j.folder}: ${j.entries} entries and ${j.notes} notes.\n`);
  if (j.wrote.length) ctx.io.out(`Brought over: ${j.wrote.join(', ')}.\n`);
  if (j.kept.length) ctx.io.out(`Kept this computer's own ${j.kept.join(' and ')}.\n`);
  if (by === 'phrase') ctx.io.out('The passphrase is unchanged: other computers still join with it, or with the recovery phrase.\n');
  ctx.io.out('After changes here: skeinwise sync push --experimental\n');
  return 0;
}

function status(ctx: Ctx): number {
  onlyFlag(ctx, null, 'sync status');
  const s = syncStatus(ctx.home);
  if (ctx.values.json) ctx.json(s);
  else if (!s.syncing) ctx.io.out('This record does not sync. Start with: skeinwise sync init <folder> --experimental\n');
  else {
    ctx.io.out(`Syncing through ${s.folder}. This computer last pushed or joined push ${s.seq} (${minute(s.at!)}).\n`);
    if (s.problem) ctx.io.out(`But ${s.problem}\n`);
    else if (s.behind) ctx.io.out(`Another computer pushed since: push ${s.folderSeq} (${minute(s.folderAt!)}). A push from here would replace it.\n`);
    else ctx.io.out(`The folder holds push ${s.folderSeq}, the newest.\n`);
  }
  return 0;
}

/** Why sync runs only with --experimental: what it doesn't do yet, said before it does anything. */
export const SYNC_EXPERIMENTAL = `Sync is experimental in this version, so it runs only with --experimental. Its limits:
  - one sync key for good: it can't be changed, and a lost computer can't be shut out;
  - the key file sits in the folder beside the bundle, so anyone who can read the folder can guess
    passphrases offline (a quarter of a second each), and only a long passphrase holds out;
  - every push is the whole record, built in memory.
Details: docs/sync.md. To go ahead: skeinwise sync <command> --experimental`;

const syncCommand: Command = async (ctx) => {
  if (!(ctx.values as SyncValues).experimental) throw new UsageError(SYNC_EXPERIMENTAL);
  const [what, ...rest] = ctx.args;
  switch (what) {
    case 'init':
      return init(ctx, oneFolder(rest, 'sync init'));
    case 'push':
      noWords(rest, 'sync push');
      return push(ctx);
    case 'join':
      return join(ctx, oneFolder(rest, 'sync join'), 'passphrase');
    case 'restore':
      return join(ctx, oneFolder(rest, 'sync restore'), 'phrase');
    case 'status':
      noWords(rest, 'sync status');
      return status(ctx);
    default:
      throw new UsageError('Give one of, each with --experimental: skeinwise sync init <folder>, sync push, sync join <folder>, sync restore <folder>, sync status');
  }
};

/** The commands, by name, for the CLI's command table. */
export const SYNC_COMMANDS: Record<string, Command> = {
  export: exportCommand,
  sync: syncCommand,
};
