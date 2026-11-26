// The record's own commands from the store's track: bringing back an old version of an entry. src/cli.ts wires them
// in as it does SYNC_COMMANDS: STORE_FLAGS into its flags, STORE_HELP into its help, STORE_COMMANDS into its table.
import type { Ctx } from '../cli-organiser.ts';
import { needId, UsageError } from '../errors.ts';

type Command = (ctx: Ctx) => number | Promise<number>;

/** None of its own: `--json` is the CLI's. */
export const STORE_FLAGS = {} as const;

const line = (command: string, text: string) => `  ${command.padEnd(26)}${text}\n`;

export const STORE_HELP =
  line('restore <entry> <version>', 'Bring back an old version of an entry (see history <entry>). It is') +
  line('', 'saved as a new version, so the ones in between are kept');

const restore: Command = (ctx) => {
  const [entryArg, versionArg, ...extra] = ctx.args;
  if (!entryArg || !versionArg || extra.length) {
    throw new UsageError('Give an entry and a version: skeinwise restore <entry> <version>. "skeinwise history <entry>" lists them.');
  }
  const id = needId(entryArg, 'entry');
  const n = needId(versionArg, 'version');
  const before = ctx.store.getEntry(id);
  if (!before) throw new UsageError(`No entry ${id}.`);
  const last = ctx.store.history(id).at(-1)!.version;
  if (n > last) throw new UsageError(`Entry ${id} has no version ${n}: it has 1 to ${last}.`);
  const saved = ctx.store.restoreVersion(id, n, { editor: 'you' });
  const changed = saved.version !== before.version;
  if (ctx.values.json) ctx.json({ entry: id, restored: n, version: saved.version, changed });
  else if (changed) ctx.io.out(`Entry ${id} reads as version ${n} again, saved as version ${saved.version}. Every version is kept.\n`);
  else ctx.io.out(`Entry ${id} already reads as version ${n}. Nothing changed.\n`);
  return 0;
};

/** The commands, by name, for the CLI's command table. */
export const STORE_COMMANDS: Record<string, Command> = { restore };
