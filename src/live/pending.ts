// `skeinwise live pending`, `live accept <n>` and `live reject <n>` (LS-03): the imports nobody started, waiting for
// the person's yes. Live sends what it finds in Downloads here (with liveDownloads on), and the store sends an export
// whose account differs from the one its source already has. Nothing reaches the record until it is accepted; a
// rejected file is remembered by its hash and never proposed again.
//
// The CLI routes `live <subcommand>` to LIVE_COMMANDS with the words after the subcommand as ctx.args, and adds
// LIVE_FLAGS to its parser.

import type { Ctx } from '../cli-organiser.ts';
import { needId, UsageError } from '../errors.ts';
import { minute } from '../format.ts';
import type { PendingItem, PendingReason } from '../store/store.ts';

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

const accept: Command = (ctx) => {
  const item = waitingItem(ctx, 'accept');
  const r = ctx.store.acceptPending(item.id);
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
