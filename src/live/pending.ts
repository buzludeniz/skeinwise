// `skeinwise live pending`, `live accept <n>` and `live reject <n>` (LS-03): the imports nobody started, waiting for
// the person's yes. Live sends what it finds in Downloads here (with liveDownloads on), and the store sends an export
// whose account differs from the one its source already has. Nothing reaches the record until it is accepted; a
// rejected file is remembered by its hash and never proposed again. What live found waits as its file's path and
// SHA-256 alone, so none of its text is in the record either (H1): accept reads the file again and takes it only when
// its bytes are the ones proposed.
//
// The CLI routes `live <subcommand>` to LIVE_COMMANDS with the words after the subcommand as ctx.args, and adds
// LIVE_FLAGS to its parser.

import { createHash } from 'node:crypto';
import { closeSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Ctx } from '../cli-organiser.ts';
import { needId, UsageError } from '../errors.ts';
import { minute } from '../format.ts';
import { openSafe, readRange, UnsafeFileError } from '../fsafe.ts';
import { readImports } from '../importers/detect.ts';
import type { ImportBatch, Origin, PendingItem, PendingReason } from '../store/store.ts';

type Command = (ctx: Ctx) => number | Promise<number>;

/** The flags these commands read, for the CLI's parseArgs options (--json it has already). */
export const LIVE_FLAGS = {
  all: { type: 'boolean' },
} as const;

export const LIVE_HELP = `  live pending              Imports waiting for your yes: what live found in Downloads, and exports
                            from another account than their source's (--all for the decided ones too)
  live accept <n>           Take a waiting import into the record
  live reject <n>           Leave a waiting import out for good: the same file is never proposed again`;

const REASONS: Record<PendingReason, string> = {
  unconfirmed: 'found, not chosen by you',
  account: "from another account than this source's",
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function describe(item: PendingItem): string {
  const what = [item.threads ? plural(item.threads, 'chat', 'chats') : '', plural(item.entries, 'entry', 'entries')].filter(Boolean).join(', ');
  const decided = item.status === 'pending' ? '' : ` · ${item.status} ${minute(item.decidedAt ?? item.observedAt)}`;
  const lines = [`  #${item.id}  ${item.sourceLabel} · ${what} to add or change${decided}`];
  lines.push(`      ${item.origin ? `from ${item.origin.path}, ` : ''}seen ${minute(item.observedAt)}`);
  lines.push(`      ${REASONS[item.reason] ?? item.reason}`);
  return lines.join('\n');
}

/** The number after `live accept` or `live reject`, for an item still waiting. */
function waitingItem(ctx: Ctx, verb: string): PendingItem {
  if (ctx.args.length !== 1) throw new UsageError(`Give one number from "skeinwise live pending", for example: skeinwise live ${verb} 1`);
  const id = needId(ctx.args[0], 'pending item');
  const item = ctx.store.pendingItem(id);
  if (!item) throw new UsageError(`No pending item ${id}. See them with: skeinwise live pending`);
  if (item.status !== 'pending') throw new UsageError(`#${id} was already ${item.status} (${minute(item.decidedAt ?? item.observedAt)}).`);
  return item;
}

const pending: Command = (ctx) => {
  if (ctx.args.length) throw new UsageError('live pending takes no words; to decide one: skeinwise live accept <n> or skeinwise live reject <n>');
  const all = (ctx.values as { all?: boolean }).all === true;
  const items = ctx.store.pendingItems({ all });
  if (ctx.values.json) {
    ctx.json(items);
    return 0;
  }
  const waiting = items.filter((i) => i.status === 'pending').length;
  if (!items.length) {
    ctx.io.out('Nothing waits for your yes.\n');
    return 0;
  }
  const head = all ? `${plural(items.length, 'import', 'imports')} proposed, ${waiting} waiting:` : `${plural(waiting, 'import waits', 'imports wait')} for your yes:`;
  ctx.io.out(`${head}\n${items.map(describe).join('\n')}\n`);
  if (waiting) ctx.io.out('Take one into the record: skeinwise live accept <n>\nLeave one out for good: skeinwise live reject <n>\n');
  return 0;
};

/**
 * A proposal the record holds no copy of (H1: a capture nobody started), read again from its file. The file is read
 * once and those bytes are hashed; they must be the bytes that were proposed. The same bytes go to a private copy that
 * readImports reads, so what is imported is what was hashed, whatever happens to the file meanwhile (a zip is read
 * twice, once to hash it and once to inflate it).
 */
function readAgain(ctx: Ctx, item: PendingItem, origin: Origin): ImportBatch {
  const drop = `To drop #${item.id}: skeinwise live reject ${item.id}`;
  let bytes: Buffer;
  try {
    const { fd, stat } = openSafe(origin.path, { root: dirname(origin.path) });
    try {
      bytes = readRange(fd, stat.size, 0);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new UsageError(`#${item.id}'s file is gone: ${origin.path}. Nothing was imported. ${drop}`);
    if (error instanceof UnsafeFileError) throw new UsageError(`#${item.id}: ${error.message}. Nothing was imported. ${drop}`);
    throw error;
  }
  if (createHash('sha256').update(bytes).digest('hex') !== origin.sha256) {
    throw new UsageError(
      `${origin.path} changed after it was proposed as #${item.id}. Nothing was imported: live proposes the file as it is now on its next pass. ${drop}`,
    );
  }
  const dir = mkdtempSync(join(tmpdir(), 'skeinwise-accept-'));
  try {
    const copy = join(dir, basename(origin.path));
    writeFileSync(copy, bytes, { mode: 0o600, flag: 'wx' });
    // A warning names the file where the person put it, not the private copy.
    const here = (message: string) => [realpathSync(dir), dir].reduce((m, d) => m.split(d).join(dirname(origin.path)), message);
    const batches = readImports(copy, { onWarning: (message) => ctx.io.err(`skeinwise: ${here(message)}\n`) });
    const batch = batches.find((b) => b.source.kind === item.sourceKind);
    if (!batch) throw new UsageError(`${origin.path} no longer reads as a ${item.sourceLabel} export. Nothing was imported. ${drop}`);
    return batch;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const accept: Command = (ctx) => {
  const item = waitingItem(ctx, 'accept');
  const batch = item.held ? undefined : item.origin ? readAgain(ctx, item, item.origin) : undefined;
  const r = ctx.store.acceptPending(item.id, { batch });
  if (ctx.values.json) ctx.json({ id: item.id, ...r });
  else ctx.io.out(`Took #${item.id} into the record: ${r.added} new, ${r.versioned} changed (${item.sourceLabel}). Each change keeps the version before it.\n`);
  return 0;
};

const reject: Command = (ctx) => {
  const item = waitingItem(ctx, 'reject');
  ctx.store.rejectPending(item.id);
  if (ctx.values.json) ctx.json({ id: item.id, status: 'rejected' });
  else ctx.io.out(`Left #${item.id} out for good. Nothing from it reached the record, and the same file won't be proposed again.\n`);
  return 0;
};

/** `live`'s subcommands by name. */
export const LIVE_COMMANDS: Record<string, Command> = { pending, accept, reject };
