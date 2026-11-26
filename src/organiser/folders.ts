// The file task: every unit (a thread or a loose note) goes in one folder. Folders come from the same groups as hubs
// and topics, named by two words each (or by a model); units that fit no group go to the Inbox. A run over new entries
// adds them to the folders already there, and makes new folders only for what fits none.

import type { Entry } from '../store/store.ts';
import { type Existing, type Group, groupName, groupUnits, namingRequest } from './groups.ts';
import type { Plan, TaskContext } from './plan.ts';
import type { Unit } from './record.ts';
import { type Folder, liveFolders } from './views.ts';

export const INBOX = 'Inbox';

interface Filing {
  /** An existing folder's id, or the name of a folder this run makes. */
  folder: number | string;
  entries: Entry[];
}

export function planFolders(ctx: TaskContext): Plan {
  const { record } = ctx;
  const live = ctx.scope.kind === 'new' ? liveFolders(ctx.db) : [];
  const inbox = live.find((f) => f.name === INBOX);
  const existing: Existing[] = live.filter((f) => f !== inbox).map((f) => ({ id: f.id, name: f.name, entryIds: f.entryIds }));
  const { groups, loose } = groupUnits(record, ctx.entries, existing);
  const fresh = groups.filter((g) => !g.existing);
  const request = ctx.model && fresh.length ? namingRequest(record, fresh, 'folder', 'one to three words', 'folder names') : undefined;
  const noModelNames = () => fresh.map((g) => groupName(record, g, 2));
  return {
    requests: request ? [request] : [],
    fallback: noModelNames,
    finish: (answers) => {
      const names = request ? (answers[0] as string[]) : noModelNames();
      const filings = file(groups, fresh, names, live, loose, inbox?.id, ctx);
      const already = new Map(live.map((f) => [f.id, new Set(f.entryIds)]));
      const rows = filings.map((f) => ({
        ...f,
        entries: typeof f.folder === 'number' ? f.entries.filter((e) => !already.get(f.folder as number)?.has(e.id)) : f.entries,
      }));
      const made = rows.filter((f) => typeof f.folder === 'string');
      const grown = rows.filter((f) => typeof f.folder === 'number' && f.entries.length);
      return {
        counts: {
          folders: made.length,
          grown: grown.length,
          filed: rows.reduce((n, f) => n + f.entries.length, 0),
          inbox: loose.reduce((n, u) => n + inScope(u, ctx).length, 0),
        },
        save: (db, runId) => {
          const insertFolder = db.prepare('INSERT INTO folders (name, run_id) VALUES (?, ?)');
          const insert = db.prepare('INSERT INTO entry_folders (entry_id, folder_id, run_id) VALUES (?, ?, ?)');
          for (const f of rows) {
            if (!f.entries.length) continue;
            const id = typeof f.folder === 'number' ? f.folder : Number(insertFolder.run(f.folder, runId).lastInsertRowid);
            for (const e of f.entries) insert.run(e.id, id, runId);
          }
        },
      };
    },
  };
}

/**
 * Where each group's entries go. A new group named like a live folder joins it; two new groups with one name share a
 * folder; loose units go to the Inbox.
 */
function file(
  groups: Group[],
  fresh: Group[],
  names: string[],
  live: Folder[],
  loose: Unit[],
  inboxId: number | undefined,
  ctx: TaskContext,
): Filing[] {
  const byKey = new Map<string, Filing>();
  const add = (folder: number | string, entries: Entry[]) => {
    const key = typeof folder === 'number' ? `#${folder}` : folder.toLowerCase();
    const had = byKey.get(key);
    if (had) had.entries.push(...entries);
    else byKey.set(key, { folder, entries: [...entries] });
  };
  for (const g of groups) {
    if (g.existing) {
      add(g.existing.id, g.entries);
      continue;
    }
    const name = names[fresh.indexOf(g)]!;
    const lower = name.toLowerCase();
    const same = live.find((f) => [f.name, ...f.aliases].some((n) => n.toLowerCase() === lower));
    add(same ? same.id : name, g.entries);
  }
  const looseEntries = loose.flatMap((u) => inScope(u, ctx));
  if (looseEntries.length) add(inboxId ?? INBOX, looseEntries);
  return [...byKey.values()];
}

function inScope(unit: Unit, ctx: TaskContext): Entry[] {
  const ids = new Set(ctx.entries.map((e) => e.id));
  return unit.entries.filter((e) => ids.has(e.id));
}
