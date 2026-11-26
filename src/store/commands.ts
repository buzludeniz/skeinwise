// The record's own commands from the store's track: bringing back an old version of an entry, and search's project
// filter. src/cli.ts wires them in as it does SYNC_COMMANDS: STORE_FLAGS into its flags, STORE_HELP into its help,
// STORE_COMMANDS into its table.
import { extname, relative } from 'node:path';
import type { Ctx } from '../cli-organiser.ts';
import { needId, UsageError } from '../errors.ts';
import { readTextSafe, type UnsafeReason, UnsafeFileError } from '../fsafe.ts';
import { parseFrontMatter } from '../importers/notes.ts';
import { homeNoteFile, notesDir, rewriteNoteFile } from '../notes.ts';
import { type Entry, hashText, type Version } from './store.ts';

type Command = (ctx: Ctx) => number | Promise<number>;

/** `--project <name>` for search and ask: spread into the CLI's flags, and pass `values.project` to `store.search`. */
export const STORE_FLAGS = { project: { type: 'string' } } as const;

const line = (command: string, text: string) => `  ${command.padEnd(26)}${text}\n`;

/** The help line for `--project`, to sit under search's flags and ask's. */
export const STORE_SEARCH_HELP = `      --project <name>      Only coding sessions run in that folder (a name or a path)\n`;

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
  const history = ctx.store.history(id);
  const latest = history.at(-1)!;
  const target = history.find((v) => v.version === n);
  if (!target) throw new UsageError(`Entry ${id} has no version ${n}: it has 1 to ${latest.version}.`);
  // The note's file goes first, as undo does it: if it can't be written, the record is as it was.
  const word = restoreNoteFile(ctx, before, latest, target);
  const saved = ctx.store.restoreVersion(id, n, { editor: 'you' });
  const changed = saved.version !== before.version;
  if (ctx.values.json) ctx.json({ entry: id, restored: n, version: saved.version, changed });
  else if (changed) ctx.io.out(`Entry ${id} reads as version ${n} again, saved as version ${saved.version}. Every version is kept.\n`);
  else ctx.io.out(`Entry ${id} already reads as version ${n}. Nothing changed.\n`);
  if (word && changed && !ctx.values.json) {
    ctx.io.out(`Its file ${word} is a Word document, which Skeinwise doesn't write, so it still holds the newer text.\n`);
  }
  return 0;
};

const UNSAFE: Record<UnsafeReason, string> = {
  symlink: "is a link, and Skeinwise doesn't write through links in the notes folder",
  'not-a-file': 'is not a regular file',
  outside: 'leads out of the notes folder',
  'too-big': 'is too big to read',
  zip: 'is not a note',
};

/**
 * Puts the file of a note kept in the record folder back to `target`'s text before the record changes, as undo puts
 * back a review run's update (runs.ts restoreEdits). Without it the file kept the newer text, so the record and the
 * file disagreed, and the next edit made in the file carried the newer text forward over the restore. Nothing is
 * written when the file holds an edit the record hasn't read yet, which would be lost, or when it is a link. The file
 * keeps its front matter (rewriteNoteFile). A file that already reads as `target` (an earlier restore wrote it and
 * stopped before the record) is left as it is, and a file that is gone has nothing to put back. Returns the file's
 * path in the record folder when it is a Word document, which is only ever read, and so is left as it is too.
 */
function restoreNoteFile(ctx: Ctx, entry: Entry, latest: Version, target: Version): string | null {
  const file = homeNoteFile(ctx.store, ctx.home, entry);
  if (!file) return null;
  const shown = relative(ctx.home, file);
  if (extname(file).toLowerCase() === '.docx') return shown;
  let text: string;
  try {
    text = readTextSafe(file, { root: notesDir(ctx.home) });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof UnsafeFileError) throw new UsageError(`${shown} ${UNSAFE[error.reason]}. Nothing was restored.`);
    throw error;
  }
  const hash = hashText(parseFrontMatter(text).body);
  if (hash === target.contentHash) return null;
  if (hash !== latest.contentHash) {
    throw new UsageError(
      `${shown} holds an edit the record hasn't read yet, so it stays as it is. Nothing was restored. "skeinwise run" or ` +
        `"skeinwise ask" reads it in as a version of entry ${entry.id}; then restore the version you want.`,
    );
  }
  rewriteNoteFile(file, target.body);
  return null;
}

/** The commands, by name, for the CLI's command table. */
export const STORE_COMMANDS: Record<string, Command> = { restore };
