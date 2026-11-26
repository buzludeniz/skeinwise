// The organiser seen from the app: what its runs made, runs started from the page, questions, and the lines between
// entries. Every read and change goes through src/organiser/; this file only shapes the results for the JSON API and
// keeps the state of a run the page started, so the page can follow a long model run.

import type { DatabaseSync } from 'node:sqlite';
import { ENGINES, type EngineName, loadConfig } from '../config.ts';
import { UsageError } from '../errors.ts';
import { readNotes } from '../notes.ts';
import { ask, type AskResult } from '../organiser/ask.ts';
import { collectGarbage } from '../organiser/gc.ts';
import { createModel, type ModelDeps } from '../organiser/model.ts';
import { previewRun, runTask, steps } from '../organiser/organise.ts';
import type { ModelClient } from '../organiser/plan.ts';
import { RecordView } from '../organiser/record.ts';
import { getRun, LIVE, listRuns, parseScope, type Run, type Task, TASKS } from '../organiser/runs.ts';
import {
  entryLayers,
  getLiveHub,
  type Hub,
  hubEntryIds,
  hubsOfEntry,
  type Layer,
  liveFolders,
  liveHubs,
  liveLinks,
  liveTags,
  openReviewItems,
  schemas,
} from '../organiser/views.ts';
import type { Store } from '../store/store.ts';
import { CliOnly } from './config.ts';
import { brief, type Brief, organiserReady } from './queries.ts';

export interface Engine {
  engine: EngineName;
  client?: ModelClient;
  budget: number;
}

/** The engine a request names, or the one in the settings. A model engine with missing settings fails here. */
export function pickEngine(home: string, wanted: unknown, deps: ModelDeps): Engine {
  const config = loadConfig(home);
  const name = wanted === undefined || wanted === null || wanted === '' ? config.engine : wanted;
  if (typeof name !== 'string' || !(ENGINES as readonly string[]).includes(name)) {
    throw new UsageError(`Unknown engine "${String(name)}". Use local, remote or none.`);
  }
  if (name === 'none') return { engine: 'none', budget: config.budget };
  // A request may pick the local model or none, never the outside one the terminal didn't choose (SETTINGS-1).
  if (name === 'remote' && config.engine !== 'remote') {
    throw new CliOnly('The outside model reads your words only when the terminal chose it: skeinwise config engine remote', 'skeinwise config engine remote');
  }
  const engine = name as 'local' | 'remote';
  return { engine, client: createModel(config, engine, deps), budget: config.budget };
}

/** Everything the Navigator, the hub panel and the review list read, in one call. */
export function organiserState(db: DatabaseSync) {
  return {
    ready: organiserReady(db),
    hubs: liveHubs(db),
    folders: liveFolders(db),
    runs: listRuns(db, 100),
    review: openReviewItems(db),
    schemas: schemas(db).map((s) => ({ id: s.id, name: s.name })),
  };
}

export type OrganiserState = ReturnType<typeof organiserState>;

/** One hub with the run that wrote it and the entries it holds. */
export function hubDetail(store: Store, id: number, limit = 300): { hub: Hub; run: Run | null; total: number; entries: Brief[] } | undefined {
  const hub = getLiveHub(store.db, id);
  if (!hub) return undefined;
  const ids = hubEntryIds(store.db, id);
  const entries = ids.slice(0, limit).flatMap((entryId) => {
    const e = store.getEntry(entryId);
    return e ? [brief(e)] : [];
  });
  return { hub, run: getRun(store.db, hub.runId) ?? null, total: ids.length, entries };
}

/** An entry's layers with the run behind each, and the hubs that hold it. */
export function entryOrganised(db: DatabaseSync, id: number): { layers: Layer[]; hubs: { id: number; name: string }[] } {
  return { layers: entryLayers(db, id), hubs: hubsOfEntry(db, id) };
}

export type HubDetail = NonNullable<ReturnType<typeof hubDetail>>;
export type EntryOrganised = ReturnType<typeof entryOrganised>;

// Lines

/** How many lines of each kind join the record's entries, as `skeinwise links` counts them. */
export function lineCounts(store: Store): Record<'threadLine' | 'crossLink' | 'noteLink' | 'hubSpoke' | 'timeChain', number> {
  const record = new RecordView(store);
  const perThread = new Map<number, number>();
  for (const e of record.entries) if (e.threadId !== null) perThread.set(e.threadId, (perThread.get(e.threadId) ?? 0) + 1);
  const all = liveLinks(store.db);
  return {
    threadLine: [...perThread.values()].reduce((n, c) => n + c - 1, 0),
    crossLink: all.filter((l) => l.kind === 'cross').length,
    noteLink: all.filter((l) => l.kind === 'note').length,
    hubSpoke: liveHubs(store.db).reduce((n, h) => n + h.entries, 0),
    timeChain: Math.max(0, record.entries.length - 1),
  };
}

/** The lines at one entry, as `skeinwise links <entry>` lists them. */
export function entryLines(store: Store, id: number) {
  const record = new RecordView(store);
  const entry = record.byId.get(id);
  if (!entry) {
    if (store.getEntry(id)) throw new UsageError(`Entry ${id} is left out of the map: its source is excluded or its thread is not yours.`);
    throw new UsageError(`No entry ${id}.`);
  }
  const near = (list: { id: number }[]) => {
    const at = list.findIndex((e) => e.id === id);
    return { before: list[at - 1]?.id ?? null, after: list[at + 1]?.id ?? null };
  };
  const thread = entry.threadId === null ? [] : record.entries.filter((e) => e.threadId === entry.threadId);
  const links = liveLinks(store.db, id);
  return {
    entry: id,
    threadLine: thread.length ? near(thread) : { before: null, after: null },
    crossLink: links.filter((l) => l.kind === 'cross').map((l) => ({ entry: l.from === id ? l.to : l.from, score: l.score })),
    noteLink: links.filter((l) => l.kind === 'note').map((l) => ({ entry: l.from === id ? l.to : l.from, direction: l.from === id ? 'to' : 'from' })),
    hubSpoke: hubsOfEntry(store.db, id).map((h) => ({ hub: h.id, name: h.name })),
    timeChain: near(record.entries),
  };
}

export type LineCounts = ReturnType<typeof lineCounts>;
export type EntryLines = ReturnType<typeof entryLines>;

// What the brain and the views group by

export interface Grouping {
  /** Folder name by entry, once a file run has filed the record; null before that. */
  folderOf: Map<number, string> | null;
  /** The first Projects tag by entry. */
  projectOf: Map<number, string>;
  /** The first hub by entry. */
  hubOf: Map<number, string>;
  /** The first Topics tag by entry. */
  tagOf: Map<number, string>;
}

function firstBy(groups: { name: string; entryIds: number[] }[]): Map<number, string> {
  const map = new Map<number, string>();
  for (const g of groups) for (const id of g.entryIds) if (!map.has(id)) map.set(id, g.name);
  return map;
}

/** The organiser's groups for each entry, from live runs only. Empty maps when nothing has run. */
export function grouping(db: DatabaseSync): Grouping {
  if (!organiserReady(db)) return { folderOf: null, projectOf: new Map(), hubOf: new Map(), tagOf: new Map() };
  const folders = liveFolders(db);
  const byName = new Map(schemas(db).map((s) => [s.name, s.id]));
  const tagsOf = (name: string) => {
    const id = byName.get(name);
    return id === undefined ? new Map<number, string>() : firstBy(liveTags(db, id));
  };
  const hubs = liveHubs(db).map((h) => ({ name: h.name, entryIds: hubEntryIds(db, h.id) }));
  return { folderOf: folders.length ? firstBy(folders) : null, projectOf: tagsOf('Projects'), hubOf: firstBy(hubs), tagOf: tagsOf('Topics') };
}

/** The share of visible entries the organiser has tagged, filed and summarised; null until something has run. */
export function progress(db: DatabaseSync, visible: Set<number>): { tagged: number; filed: number; summarised: number } | null {
  if (!organiserReady(db) || !listRuns(db, 1).length || !visible.size) return null;
  const tagged = new Set<number>();
  for (const s of schemas(db)) for (const t of liveTags(db, s.id)) for (const id of t.entryIds) if (visible.has(id)) tagged.add(id);
  const filed = new Set<number>();
  for (const f of liveFolders(db)) for (const id of f.entryIds) if (visible.has(id)) filed.add(id);
  const digests = db.prepare(`SELECT DISTINCT entry_id AS id FROM layers WHERE layer = 'digest' AND run_id IN ${LIVE}`).all() as { id: number }[];
  const summarised = digests.filter((d) => visible.has(d.id)).length;
  return { tagged: tagged.size / visible.size, filed: filed.size / visible.size, summarised: summarised / visible.size };
}

// Runs the page starts

export interface OrganiseJob {
  task: Task | 'all';
  engine: EngineName;
  scope: string;
  startedAt: string;
  finished: boolean;
  /** The runs that finished, in order. */
  runs: Run[];
  /** Why it stopped, when it failed. */
  error: string | null;
  /** True when the run is too big to start without a yes. */
  needsYes: boolean;
  /** The newest progress line. */
  line: string | null;
}

export interface OrganiseRequest {
  task?: unknown;
  engine?: unknown;
  scope?: unknown;
  yes?: unknown;
  preview?: unknown;
}

function taskOf(value: unknown): Task | 'all' {
  const task = value === undefined ? 'all' : value;
  if (task !== 'all' && !(TASKS as readonly unknown[]).includes(task)) throw new UsageError(`Unknown task "${String(task)}". Use ${TASKS.join(', ')} or all.`);
  return task as Task | 'all';
}

/** A run's would-be requests, nothing sent or saved. */
export function previewOrganise(store: Store, home: string, body: OrganiseRequest, deps: ModelDeps) {
  const task = taskOf(body.task);
  const scope = parseScope(typeof body.scope === 'string' ? body.scope : undefined);
  const { engine, client, budget } = pickEngine(home, body.engine, deps);
  readNotes(store, home);
  const record = new RecordView(store);
  return steps(store, task).map((step) => {
    try {
      const p = previewRun(store, record, { task: step.task, ...(step.schema ? { schema: step.schema } : {}), scope, engine, ...(client ? { client } : {}), yes: false, budget, progress: () => undefined });
      return { task: p.task, schema: p.schema, engine: p.engine, model: p.model, entries: p.entries, requests: p.requests.length, estimate: p.estimate };
    } catch (error) {
      if (error instanceof UsageError) return { task: step.task, schema: step.schema?.name ?? null, error: error.message };
      throw error;
    }
  });
}

/**
 * Starts a run the way `skeinwise run` does, one run per step, and keeps going after the request returns. The job
 * object fills in as it goes; a failure stops it and keeps the runs before it.
 */
export function startOrganise(store: Store, home: string, body: OrganiseRequest, deps: ModelDeps): { job: OrganiseJob; done: Promise<void> } {
  const task = taskOf(body.task);
  const scopeText = typeof body.scope === 'string' ? body.scope : 'all';
  const scope = parseScope(scopeText);
  const { engine, client, budget } = pickEngine(home, body.engine, deps);
  const job: OrganiseJob = { task, engine, scope: scopeText, startedAt: store.now(), finished: false, runs: [], error: null, needsYes: false, line: null };
  const done = (async () => {
    try {
      readNotes(store, home);
      const record = new RecordView(store);
      for (const step of steps(store, task)) {
        // Between steps over the whole record: src/organiser/gc.ts says why.
        if (job.runs.length) collectGarbage();
        const run = await runTask(store, record, {
          task: step.task,
          ...(step.schema ? { schema: step.schema } : {}),
          scope,
          engine,
          ...(client ? { client } : {}),
          yes: body.yes === true,
          budget,
          progress: (line) => {
            job.line = line;
          },
        });
        job.runs.push(run);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The organiser asks the CLI for --yes; the page asks with a button.
      job.needsYes = /Add --yes/.test(message);
      job.error = message.replace(/\s*Add --yes to go ahead, or narrow it with --scope\.?/, '');
      if (!(error instanceof UsageError)) process.stderr.write(`skeinwise serve: organise: ${error instanceof Error ? (error.stack ?? message) : message}\n`);
    } finally {
      job.finished = true;
    }
  })();
  return { job, done };
}

// Questions

/**
 * A question answered by the organiser's ask, with the engine in the settings. When the model can't be reached, the
 * answer falls back to the No-AI reading and says why, so the entries still show.
 */
export async function askQuestion(store: Store, home: string, question: string, wanted: unknown, deps: ModelDeps, limit = 20): Promise<AskResult> {
  const { engine, client, budget } = pickEngine(home, wanted, deps);
  readNotes(store, home);
  const record = new RecordView(store);
  if (engine === 'none') return ask(store, record, question, { engine, budget, limit });
  try {
    return await ask(store, record, question, { engine, ...(client ? { client } : {}), budget, limit });
  } catch (error) {
    if (error instanceof UsageError && /budget|cap/i.test(error.message)) throw error;
    const why = error instanceof Error ? error.message : String(error);
    const plain = await ask(store, record, question, { engine: 'none', budget, limit });
    return { ...plain, message: `The ${engine} model didn't answer, so these are your entries alone. ${why}` };
  }
}
