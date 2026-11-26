// The organiser's commands: runs and undo, questions, what the runs made, your notes, corrections and settings.
// Each takes the opened record and the parsed command line, prints text (or JSON with --json) and returns the exit
// code. Mistakes in the call throw a UsageError, which the CLI turns into exit code 2.

import type { Io } from './cli.ts';
import { type Config, configPath, DEFAULT_CONFIG, ENGINES, type EngineName, loadConfig, setConfigValue, unsetConfigValue } from './config.ts';
import { needId, UsageError } from './errors.ts';
import { countsText, entryBrief, entryHeader, engineLabel, indent, minute, oneLine } from './format.ts';
import { modelCommand } from './model-commands.ts';
import { appendDailyNote, newNote, readNotes } from './notes.ts';
import { type AskKind, ask } from './organiser/ask.ts';
import { defineTag, deleteHub, mergeFolders, REVIEW_ACTIONS, type ReviewAction, removeTag, renameHub, resolveReview } from './organiser/corrections.ts';
import { createModel } from './organiser/model.ts';
import { type Preview, previewRun, type RunOptions, runTask, steps } from './organiser/organise.ts';
import type { ModelClient } from './organiser/plan.ts';
import { RecordView } from './organiser/record.ts';
import { listRuns, parseScope, type Run, type Task, TASKS, undoRun } from './organiser/runs.ts';
import { similarEntries } from './organiser/similar.ts';
import {
  definedTags,
  entryLayers,
  findSchema,
  getLiveHub,
  hubEntryIds,
  hubsOfEntry,
  type HubItem,
  LAYER_NAMES,
  liveFolders,
  liveHubs,
  liveLinks,
  liveTags,
  openReviewItems,
  type Schema,
  schemas,
} from './organiser/views.ts';
import type { Entry, Store } from './store/store.ts';

/** The options the organiser's commands read. */
export interface Values {
  json?: boolean;
  limit?: string;
  engine?: string;
  scope?: string;
  schema?: string;
  yes?: boolean;
  preview?: boolean;
  layer?: string;
  resolve?: string;
  unset?: boolean;
  remove?: boolean;
  run?: boolean;
  /** `--project` (STORE_FLAGS): ask keeps to coding sessions run in that folder. */
  project?: string;
}

export interface Ctx {
  io: Io;
  /** The record folder. */
  home: string;
  store: Store;
  values: Values;
  /** The words after the command. */
  args: string[];
  json: (value: unknown) => void;
}

type Command = (ctx: Ctx) => number | Promise<number>;

function limit(ctx: Ctx, fallback: number): number {
  return ctx.values.limit ? needId(ctx.values.limit, 'limit') : fallback;
}

function say(ctx: Ctx, text: string): void {
  ctx.io.out(text.endsWith('\n') ? text : `${text}\n`);
}

// Engines

interface Engine {
  engine: EngineName;
  client?: ModelClient;
  config: Config;
}

/** The engine from --engine or the settings. A model engine with missing settings fails here, before anything runs. */
function pickEngine(ctx: Ctx): Engine {
  const config = loadConfig(ctx.home);
  const name = ctx.values.engine ?? config.engine;
  if (!(ENGINES as string[]).includes(name)) throw new UsageError(`Unknown engine "${name}". Use local, remote or none.`);
  if (name === 'none') return { engine: 'none', config };
  const engine = name as 'local' | 'remote';
  return { engine, config, client: createModel(config, engine, { fetch: ctx.io.fetch ?? fetch, env: ctx.io.env, home: ctx.home }) };
}

// Runs

function schemaNames(store: Store): Map<number, string> {
  return new Map(schemas(store.db).map((s) => [s.id, s.name]));
}

function runWhat(run: Run, names: Map<number, string>): string {
  return run.task === 'tag' && run.schemaId !== null ? `tag ${names.get(run.schemaId) ?? `schema ${run.schemaId}`}` : run.task;
}

function runLine(run: Run, names: Map<number, string>): string {
  const counts = countsText(run.counts);
  const tokens = run.tokensIn || run.tokensOut ? ` · tokens ${run.tokensIn} in, ${run.tokensOut} out` : '';
  const head = `Run ${run.id}: ${runWhat(run, names)} · ${engineLabel(run.engine, run.model)} · scope ${run.scope} · ${run.status}`;
  return `${head}${counts ? ` · ${counts}` : ''}${tokens}${run.message ? `\n    ${run.message}` : ''}`;
}

const run: Command = async (ctx) => {
  const [what, ...extra] = ctx.args;
  if (!what) throw new UsageError(`Give a task to run: ${TASKS.join(', ')} or all.`);
  if (extra.length) throw new UsageError(`run takes one task, not "${ctx.args.join(' ')}".`);
  if (what !== 'all' && !(TASKS as string[]).includes(what)) throw new UsageError(`Unknown task "${what}". Use ${TASKS.join(', ')} or all.`);
  const scope = parseScope(ctx.values.scope);
  let schema: Schema | undefined;
  if (ctx.values.schema !== undefined) {
    if (what !== 'tag' && what !== 'all') throw new UsageError(`--schema is for the tag task, for example: skeinwise run tag --schema Moods`);
    schema = findSchema(ctx.store.db, ctx.values.schema);
    if (!schema) throw new UsageError(`No schema "${ctx.values.schema}". Known: ${schemas(ctx.store.db).map((s) => s.name).join(', ')}.`);
  }
  const { engine, client, config } = pickEngine(ctx);
  readNotes(ctx.store, ctx.home);
  const record = new RecordView(ctx.store);
  const list = steps(ctx.store, what as Task | 'all', schema);
  const options: Omit<RunOptions, 'task'> = {
    scope,
    engine,
    ...(client ? { client } : {}),
    yes: ctx.values.yes === true,
    budget: config.budget,
    progress: (line) => ctx.io.err(`${line}\n`),
  };
  const withStep = (step: (typeof list)[number]): RunOptions => ({ ...options, task: step.task, ...(step.schema ? { schema: step.schema } : {}) });

  if (ctx.values.preview) {
    const previews = list.map((step) => {
      try {
        return previewRun(ctx.store, record, withStep(step));
      } catch (err) {
        if (err instanceof UsageError) return { task: step.task, schema: step.schema?.name ?? null, error: err.message };
        throw err;
      }
    });
    if (ctx.values.json) ctx.json(previews);
    else printPreviews(ctx, previews, list.length > 1);
    return 0;
  }

  const names = schemaNames(ctx.store);
  const done: Run[] = [];
  try {
    for (const step of list) {
      const finished = await runTask(ctx.store, record, withStep(step));
      done.push(finished);
      if (!ctx.values.json) say(ctx, runLine(finished, names));
    }
  } catch (err) {
    if (done.length && err instanceof Error) {
      err.message += `\nRun${done.length > 1 ? 's' : ''} ${done.map((r) => r.id).join(', ')} finished before this and ${done.length > 1 ? 'are' : 'is'} kept.`;
    }
    throw err;
  }
  if (ctx.values.json) ctx.json(done);
  else say(ctx, '\nUndo a run with: skeinwise undo <run>');
  return 0;
};

function printPreviews(ctx: Ctx, previews: (Preview | { task: Task; schema: string | null; error: string })[], several: boolean): void {
  let total = 0;
  for (const p of previews) {
    const what = p.schema ? `${p.task} (${p.schema})` : p.task;
    if ('error' in p) {
      say(ctx, `${what}: can't run now. ${p.error}\n`);
      continue;
    }
    total += p.estimate;
    const head = `${what} · ${p.engine === 'none' ? 'No-AI' : `${p.engine} model ${p.model}`} · scope ${p.scope} · ${p.entries} entries`;
    if (!p.requests.length) {
      say(ctx, `${head}\n    Nothing goes to a model: ${p.engine === 'none' ? 'the No-AI engine works on this computer' : 'this task needs no model requests here'}.\n`);
      continue;
    }
    say(ctx, `${head} · ${p.requests.length} request${p.requests.length === 1 ? '' : 's'}, about ${p.estimate} tokens`);
    for (const [i, r] of p.requests.entries()) {
      say(ctx, `\n--- request ${i + 1} of ${p.requests.length}: ${r.purpose} (answer up to ${r.maxTokens} tokens) ---`);
      say(ctx, `[system]\n${r.system}\n\n[user]\n${r.user}`);
    }
    say(ctx, '');
  }
  if (several) say(ctx, 'Each step is shown against the record as it is now; in a real run, later steps also see what earlier ones made.');
  say(ctx, `Nothing was sent or saved.${total ? ` About ${total} tokens in all.` : ''}`);
}

const runs: Command = (ctx) => {
  const list = listRuns(ctx.store.db, limit(ctx, 20));
  if (ctx.values.json) ctx.json(list);
  else if (!list.length) say(ctx, 'No runs yet. Organise the record with: skeinwise run all');
  else {
    const names = schemaNames(ctx.store);
    for (const r of list) say(ctx, `${minute(r.startedAt)}  ${runLine(r, names)}`);
  }
  return 0;
};

const MADE: Record<string, string> = {
  entry_tags: 'tags on entries',
  tags: 'tags',
  entry_folders: 'entries filed',
  folders: 'folders',
  links: 'links',
  hub_entries: 'entries in hubs',
  hubs: 'hubs',
  layers: 'layers',
  review_items: 'review items',
  notes: 'notes an agent started',
};

const undo: Command = (ctx) => {
  const id = needId(ctx.args[0], 'run');
  const result = undoRun(ctx.store.db, id, ctx.home, ctx.store.now);
  if (ctx.values.json) ctx.json(result);
  else if (result.run.task === 'correction') say(ctx, `Undid run ${id}, your correction: ${result.run.message ?? ''}`);
  else {
    const removed = Object.entries(result.removed).map(([table, n]) => `${n} ${MADE[table] ?? table}`);
    const back = result.restored.length ? ` Put back the text of ${result.restored.map((n) => `#${n}`).join(', ')}.` : '';
    say(ctx, `Undid run ${id} (${runWhat(result.run, schemaNames(ctx.store))}). Removed ${removed.length ? removed.join(', ') : 'nothing'}.${back}`);
    for (const file of result.word) say(ctx, `${file} is a Word document, which Skeinwise doesn't write, so it was left as it is.`);
  }
  return 0;
};

// Questions

const HEADINGS: Record<AskKind, (topic: string) => string> = {
  first: (t) => `Earliest mentions of "${t}":`,
  decided: (t) => `What you decided about "${t}", oldest first:`,
  changed: (t) => `How your thinking on "${t}" moved, oldest first:`,
  any: (t) => `Entries for "${t}":`,
};

const askCommand: Command = async (ctx) => {
  const question = ctx.args.join(' ').trim();
  if (!question) throw new UsageError('Ask a question, for example: skeinwise ask "what did I decide about sqlite"');
  const { engine, client, config } = pickEngine(ctx);
  readNotes(ctx.store, ctx.home);
  const record = new RecordView(ctx.store);
  const result = await ask(ctx.store, record, question, {
    engine,
    ...(client ? { client } : {}),
    budget: config.budget,
    limit: limit(ctx, 10),
    project: ctx.values.project,
  });
  if (ctx.values.json) {
    ctx.json(result);
    return 0;
  }
  if (result.answer) {
    say(ctx, `${result.answer}\n    (${engineLabel(result.engine, result.model)}, citing ${result.cites.map((c) => `#${c}`).join(', ')})\n`);
  }
  if (result.message) say(ctx, `${result.message}${result.hits.length ? '\n' : ''}`);
  if (!result.hits.length) return 0;
  say(ctx, HEADINGS[result.kind](result.topic));
  for (const h of result.hits) {
    say(ctx, `#${h.entryId}  ${h.date}  ${h.speaker}${h.where ? ` · ${oneLine(h.where, 60)}` : ''}${h.why ? `  [${h.why}]` : ''}\n    ${oneLine(h.quote, 300)}`);
  }
  return 0;
};

const similar: Command = (ctx) => {
  const id = needId(ctx.args[0], 'entry');
  const list = similarEntries(ctx.store, id, limit(ctx, 10));
  if (ctx.values.json) ctx.json(list);
  else if (!list.length) say(ctx, `Nothing in other threads reads like #${id}.`);
  else {
    say(ctx, `Entries in other threads that read like ${entryBrief(ctx.store.visibleEntry(id)!)}:`);
    for (const h of list) say(ctx, `#${h.entryId}  ${h.date}  ${h.speaker}${h.where ? ` · ${oneLine(h.where, 60)}` : ''}  (${h.score})\n    ${oneLine(h.quote, 200)}`);
  }
  return 0;
};

// What the runs made

const hubs: Command = (ctx) => {
  const list = liveHubs(ctx.store.db);
  if (ctx.values.json) ctx.json(list);
  else if (!list.length) say(ctx, 'No hubs yet. Make them with: skeinwise run hub');
  else for (const h of list) say(ctx, `${String(h.id).padStart(4)}  ${h.name}  (${h.entries} entries)`);
  return 0;
};

function hubItems(title: string, items: HubItem[]): string {
  const lines = items.map((i) => `  - ${i.text}  (${(i.cites ?? [i.entryId]).map((c) => `#${c}`).join(', ')}, ${i.date})`);
  return `${title}\n${lines.length ? lines.join('\n') : '  (nothing here)'}\n`;
}

const hub: Command = (ctx) => {
  const id = needId(ctx.args[0], 'hub');
  const found = getLiveHub(ctx.store.db, id);
  if (!found) throw new UsageError(`No hub ${id}. Run "skeinwise hubs" for the list.`);
  const ids = hubEntryIds(ctx.store.db, id);
  if (ctx.values.json) {
    ctx.json({ ...found, entryIds: ids });
    return 0;
  }
  say(ctx, `${found.name}\nHub ${id} · ${found.entries} entries · made by run ${found.runId}\n`);
  say(ctx, hubItems('In short', found.sections.in_short));
  say(ctx, hubItems('What you found', found.sections.what_you_found));
  say(ctx, hubItems('Open ends', found.sections.open_ends));
  const shown = limit(ctx, 20);
  say(ctx, 'Entries:');
  for (const entryId of ids.slice(0, shown)) {
    const e = ctx.store.getEntry(entryId);
    if (!e) throw new Error(`Hub ${id} holds entry ${entryId}, which is not in the record.`);
    say(ctx, `  ${entryBrief(e)}`);
  }
  if (ids.length > shown) say(ctx, `  … and ${ids.length - shown} more (--limit ${ids.length} shows them all)`);
  return 0;
};

const LAYER_TITLES: Record<string, string> = { original: 'Original', cleaned: 'Cleaned', expanded: 'Expanded', digest: 'Digest', ideas: 'Ideas' };

const layers: Command = (ctx) => {
  const id = needId(ctx.args[0], 'entry');
  const entry = ctx.store.getEntry(id);
  if (!entry) throw new UsageError(`No entry ${id}.`);
  const all = [{ layer: 'original', body: entry.body, engine: null as string | null, model: null as string | null, runId: null as number | null }, ...entryLayers(ctx.store.db, id)];
  const want = ctx.values.layer?.toLowerCase();
  if (want !== undefined && !['original', ...LAYER_NAMES].includes(want)) {
    throw new UsageError(`Unknown layer "${ctx.values.layer}". Use original, cleaned, expanded, digest or ideas.`);
  }
  const shown = want ? all.filter((l) => l.layer === want) : all;
  if (!shown.length) {
    const how = want === 'expanded' ? 'Only a model writes Expanded: skeinwise run layer --engine local' : 'Make layers with: skeinwise run layer';
    throw new UsageError(`Entry ${id} has no ${LAYER_TITLES[want!]} layer yet. ${how}`);
  }
  if (ctx.values.json) {
    ctx.json(shown);
    return 0;
  }
  say(ctx, entryHeader(entry));
  for (const l of shown) {
    const made = l.runId === null ? '' : `  (${engineLabel(l.engine!, l.model)}, run ${l.runId})`;
    say(ctx, `\n${LAYER_TITLES[l.layer]}${made}\n${indent(l.body)}`);
  }
  if (!want && all.length === 1) say(ctx, '\nNo layers yet. Make them with: skeinwise run layer');
  return 0;
};

const tags: Command = (ctx) => {
  let list = schemas(ctx.store.db);
  if (ctx.values.schema !== undefined) {
    const one = findSchema(ctx.store.db, ctx.values.schema);
    if (!one) throw new UsageError(`No schema "${ctx.values.schema}". Known: ${list.map((s) => s.name).join(', ')}.`);
    list = [one];
  }
  const full = ctx.values.schema !== undefined;
  const views = list.map((schema) => ({ schema, tags: liveTags(ctx.store.db, schema.id), defined: definedTags(ctx.store.db, schema.id) }));
  if (ctx.values.json) {
    ctx.json(views);
    return 0;
  }
  for (const v of views) {
    say(ctx, `${v.schema.name}: ${v.schema.description}`);
    const unused = full ? v.defined.filter((d) => !v.tags.some((t) => t.name.toLowerCase() === d.name.toLowerCase())) : [];
    const width = Math.max(0, ...v.tags.map((t) => t.name.length), ...unused.map((d) => d.name.length));
    const shown = full ? v.tags : v.tags.slice(0, 10);
    for (const t of shown) say(ctx, `  ${t.name.padEnd(width)}  ${t.entryIds.length}`);
    for (const d of unused) say(ctx, `  ${d.name.padEnd(width)}  0  (yours: ${d.description || 'no words yet'})`);
    if (shown.length < v.tags.length) say(ctx, `  … ${v.tags.length - shown.length} more: skeinwise tags --schema ${v.schema.name}`);
    if (!v.tags.length && !unused.length) say(ctx, `  (no entries tagged yet${v.defined.length ? `; ${v.defined.length} tags defined` : ''})`);
    say(ctx, '');
  }
  return 0;
};

const folders: Command = (ctx) => {
  const list = liveFolders(ctx.store.db);
  if (ctx.values.json) ctx.json(list);
  else if (!list.length) say(ctx, 'No folders yet. Make them with: skeinwise run file');
  else for (const f of list) say(ctx, `${String(f.id).padStart(4)}  ${f.name}  (${f.entryIds.length} entries)${f.aliases.length ? `  also: ${f.aliases.join(', ')}` : ''}`);
  return 0;
};

const LINE_KINDS = [
  ['threadLine', 'thread line', 'each entry to the next in its chat, session or note'],
  ['crossLink', 'cross link', 'entries in different threads that read alike'],
  ['noteLink', 'note link', "a note's [[link]] to the note it names"],
  ['hubSpoke', 'hub spoke', 'a hub to each entry it holds'],
  ['timeChain', 'time chain', 'each entry to the next one in time'],
] as const;

const links: Command = (ctx) => {
  const record = new RecordView(ctx.store);
  if (!ctx.args.length) {
    const perThread = new Map<number, number>();
    for (const e of record.entries) if (e.threadId !== null) perThread.set(e.threadId, (perThread.get(e.threadId) ?? 0) + 1);
    const all = liveLinks(ctx.store.db);
    const counts = {
      threadLine: [...perThread.values()].reduce((n, c) => n + c - 1, 0),
      crossLink: all.filter((l) => l.kind === 'cross').length,
      noteLink: all.filter((l) => l.kind === 'note').length,
      hubSpoke: liveHubs(ctx.store.db).reduce((n, h) => n + h.entries, 0),
      timeChain: Math.max(0, record.entries.length - 1),
    };
    if (ctx.values.json) ctx.json(counts);
    else {
      say(ctx, 'Lines between your entries:');
      for (const [key, name, what] of LINE_KINDS) say(ctx, `  ${name.padEnd(11)} ${String(counts[key]).padStart(6)}  ${what}`);
    }
    return 0;
  }
  const id = needId(ctx.args[0], 'entry');
  const entry = record.byId.get(id);
  if (!entry) {
    if (ctx.store.getEntry(id)) throw new UsageError(`Entry ${id} is left out of the map: its source is excluded or its thread is not yours.`);
    throw new UsageError(`No entry ${id}.`);
  }
  const at = (list: Entry[]) => list.findIndex((e) => e.id === id);
  const thread = entry.threadId === null ? [] : record.entries.filter((e) => e.threadId === entry.threadId);
  const neighbours = (list: Entry[]) => ({ before: list[at(list) - 1]?.id ?? null, after: list[at(list) + 1]?.id ?? null });
  const found = {
    entry: id,
    threadLine: thread.length ? neighbours(thread) : { before: null, after: null },
    crossLink: liveLinks(ctx.store.db, id)
      .filter((l) => l.kind === 'cross')
      .map((l) => ({ entry: l.from === id ? l.to : l.from, score: l.score })),
    noteLink: liveLinks(ctx.store.db, id)
      .filter((l) => l.kind === 'note')
      .map((l) => ({ entry: l.from === id ? l.to : l.from, direction: l.from === id ? 'to' : 'from' })),
    hubSpoke: hubsOfEntry(ctx.store.db, id).map((h) => ({ hub: h.id, name: h.name })),
    timeChain: neighbours(record.entries),
  };
  if (ctx.values.json) {
    ctx.json(found);
    return 0;
  }
  const brief = (n: number) => {
    const e = record.byId.get(n) ?? ctx.store.getEntry(n);
    return e ? entryBrief(e) : `#${n}`;
  };
  const lines: string[] = [];
  const pair = (name: string, p: { before: number | null; after: number | null }) => {
    if (p.before !== null) lines.push(`  ${name.padEnd(11)} before ${brief(p.before)}`);
    if (p.after !== null) lines.push(`  ${name.padEnd(11)} after  ${brief(p.after)}`);
  };
  pair('thread line', found.threadLine);
  for (const c of found.crossLink) lines.push(`  cross link  ${c.score.toFixed(2).padStart(6)} ${brief(c.entry)}`);
  for (const n of found.noteLink) lines.push(`  note link   ${n.direction.padEnd(6)} ${brief(n.entry)}`);
  for (const h of found.hubSpoke) lines.push(`  hub spoke   hub ${h.hub}: ${h.name}`);
  pair('time chain', found.timeChain);
  say(ctx, `${entryHeader(entry)}\n${lines.join('\n')}`);
  return 0;
};

// The review queue

const review: Command = (ctx) => {
  if (ctx.values.resolve !== undefined) {
    const id = needId(ctx.values.resolve, 'review item');
    const action = ctx.args[0];
    if (!action || ctx.args.length > 1 || !(REVIEW_ACTIONS as readonly string[]).includes(action)) {
      throw new UsageError(`Answer with update, holds or skip, for example: skeinwise review --resolve ${id} holds`);
    }
    const res = resolveReview(ctx.store, ctx.home, id, action as ReviewAction, ctx.values.yes === true);
    if (ctx.values.json) {
      ctx.json(res);
      return 0;
    }
    const note = res.item.noteEntry;
    if (action === 'holds') say(ctx, `Review item ${id}: note #${note} still holds. The entries behind this item won't flag it again.`);
    else if (action === 'skip') say(ctx, `Review item ${id} is set aside until the next review run.`);
    else {
      say(ctx, `Note #${note}, as the update would change it:\n${res.diff.join('\n')}\n`);
      if (!res.saved) say(ctx, `Nothing is saved yet. Save it with: skeinwise review --resolve ${id} update --yes`);
      else say(ctx, `Saved note #${note} as version ${res.version}${res.file ? `, and wrote ${res.file}` : ''}. The text before stays in its history: skeinwise history ${note}`);
      if (res.saved && res.word) say(ctx, `${res.word} is a Word document, which Skeinwise doesn't write, so it doesn't have this update.`);
    }
    return 0;
  }
  if (ctx.args.length) throw new UsageError('review lists the queue. To answer an item: skeinwise review --resolve <item> update|holds|skip');
  const items = openReviewItems(ctx.store.db);
  if (ctx.values.json) {
    ctx.json(items);
    return 0;
  }
  if (!items.length) {
    say(ctx, 'Nothing to review. A review run looks for notes that later entries overtook: skeinwise run review');
    return 0;
  }
  for (const item of items) {
    const note = ctx.store.getEntry(item.noteEntry);
    if (!note) throw new Error(`Review item ${item.id} points at entry ${item.noteEntry}, which is not in the record.`);
    say(ctx, `Item ${item.id}: ${entryBrief(note)} may be out of date. Later entries:`);
    for (const r of item.reasons) say(ctx, `  ${r.date}  #${r.entryId}: "${oneLine(r.quote, 160)}"${r.why ? `\n      ${oneLine(r.why, 200)}` : ''}`);
    say(ctx, `  Answer: skeinwise review --resolve ${item.id} update|holds|skip\n`);
  }
  return 0;
};

// Your notes

const note: Command = (ctx) => {
  const written = appendDailyNote(ctx.store, ctx.home, ctx.args.join(' '), new Date(ctx.store.now()));
  if (ctx.values.json) ctx.json(written);
  else say(ctx, `${written.created ? 'Started' : 'Added to'} ${written.path} (entry #${written.entryId}).`);
  return 0;
};

const newNoteCommand: Command = (ctx) => {
  const written = newNote(ctx.store, ctx.home, ctx.args.join(' '), new Date(ctx.store.now()));
  if (ctx.values.json) ctx.json(written);
  else say(ctx, `Started ${written.path} (entry #${written.entryId}). Write in it with any editor; the next note, run or question reads your changes.`);
  return 0;
};

// Corrections

function corrected(ctx: Ctx, done: { runId: number; message: string }): number {
  if (ctx.values.json) ctx.json({ runId: done.runId, message: done.message });
  else say(ctx, `${done.message}\nUndo with: skeinwise undo ${done.runId}`);
  return 0;
}

const mergeFoldersCommand: Command = (ctx) => {
  if (ctx.args.length !== 2) throw new UsageError('Give two folders, each a number or a name: skeinwise merge-folders <from> <into> (quote names with spaces)');
  return corrected(ctx, mergeFolders(ctx.store, ctx.args[0]!, ctx.args[1]!));
};

const renameHubCommand: Command = (ctx) => corrected(ctx, renameHub(ctx.store, needId(ctx.args[0], 'hub'), ctx.args.slice(1).join(' ')));

const deleteHubCommand: Command = (ctx) => {
  if (ctx.args.length > 1) throw new UsageError('delete-hub takes one hub number.');
  return corrected(ctx, deleteHub(ctx.store, needId(ctx.args[0], 'hub')));
};

// Settings

function shown(value: unknown): string {
  if (Array.isArray(value)) {
    if (!value.length) return '(none)';
    // Live folders: the path, and whose words it holds when that isn't you.
    return value.map((v) => (v && typeof v === 'object' && 'path' in v ? `${v.path}${v.owner ? ` (${v.owner})` : ''}` : String(v))).join(', ');
  }
  if (value && typeof value === 'object') return JSON.stringify(value);
  if (value === '') return '(not set)';
  return String(value);
}

const KEYS = Object.keys(DEFAULT_CONFIG) as (keyof Config)[];

function isKey(key: string): key is keyof Config {
  return (KEYS as string[]).includes(key);
}

const config: Command = (ctx) => {
  const [key, ...rest] = ctx.args;
  if (key !== undefined && !isKey(key)) throw new UsageError(`Unknown setting "${key}". Known: ${KEYS.join(', ')}.`);
  if (ctx.values.unset) {
    if (!key || rest.length) throw new UsageError('Give one setting to reset, for example: skeinwise config localModel --unset');
    const after = unsetConfigValue(ctx.home, key);
    if (ctx.values.json) ctx.json(after);
    else say(ctx, `${key} is back to its default: ${shown(after[key])}`);
    return 0;
  }
  if (key && rest.length) {
    const after = setConfigValue(ctx.home, key, rest.join(' '));
    if (ctx.values.json) ctx.json(after);
    else say(ctx, `${key} = ${shown(after[key])}`);
    return 0;
  }
  const current = loadConfig(ctx.home);
  if (key) {
    if (ctx.values.json) ctx.json({ [key]: current[key] });
    else say(ctx, shown(current[key]));
    return 0;
  }
  if (ctx.values.json) {
    ctx.json(current);
    return 0;
  }
  say(ctx, `Settings (${configPath(ctx.home)}):`);
  for (const k of KEYS) {
    const changed = JSON.stringify(current[k]) !== JSON.stringify(DEFAULT_CONFIG[k]);
    const keyState = k === 'apiKeyEnv' && current.apiKeyEnv ? (ctx.io.env[current.apiKeyEnv] ? '  (set in this shell)' : '  (not set in this shell)') : '';
    say(ctx, `  ${k.padEnd(13)} ${shown(current[k])}${changed ? '  (changed)' : ''}${keyState}`);
  }
  return 0;
};

const defineTagCommand: Command = (ctx) => {
  const [schemaName, tagName, ...words] = ctx.args;
  if (!schemaName || !tagName) throw new UsageError('Give a schema and a tag, for example: skeinwise define-tag Moods calm calm quiet rested steady');
  if (ctx.values.remove) {
    if (words.length) throw new UsageError('--remove takes a schema and a tag, nothing more.');
    const removed = removeTag(ctx.store, schemaName, tagName);
    const gone = !findSchema(ctx.store.db, removed.schema.name);
    if (ctx.values.json) ctx.json({ ...removed, schemaRemoved: gone });
    else say(ctx, `Removed "${removed.tag.name}" from ${removed.schema.name}.${gone ? ` ${removed.schema.name} had no other tags and no runs, so it is gone too.` : ''}`);
    return 0;
  }
  const made = defineTag(ctx.store, schemaName, tagName, words.join(' '));
  if (ctx.values.json) {
    ctx.json(made);
    return 0;
  }
  const what = {
    'new schema': `Made the schema ${made.schema.name} with the tag "${made.tag.name}".`,
    'new tag': `Added "${made.tag.name}" to ${made.schema.name}.`,
    described: `"${made.tag.name}" in ${made.schema.name} now reads: ${made.tag.description}`,
    removed: '',
  }[made.change];
  const hint = made.tag.description ? '' : ` Without words, an entry needs the tag's own name to get it; add words with: skeinwise define-tag ${made.schema.name} ${made.tag.name} <words>`;
  say(ctx, `${what}${hint}\nTag your entries with it: skeinwise run tag --schema ${made.schema.name}`);
  return 0;
};

/** The organiser's commands by name. */
export const ORGANISER_COMMANDS: Record<string, Command> = {
  run,
  runs,
  undo,
  ask: askCommand,
  similar,
  hubs,
  hub,
  layers,
  tags,
  folders,
  links,
  review,
  note,
  'new-note': newNoteCommand,
  'merge-folders': mergeFoldersCommand,
  'rename-hub': renameHubCommand,
  'delete-hub': deleteHubCommand,
  config,
  'define-tag': defineTagCommand,
  model: modelCommand,
};
