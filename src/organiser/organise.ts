// The runner. A task plans everything first (the model requests it needs, if any); the runner then shows the plan
// (--preview), checks its size and the monthly budget, checks the model server answers, makes the calls one by one,
// and saves what the task made in one transaction with the run's "done" status. Any failure marks the run failed and
// saves nothing.

import { UsageError } from '../errors.ts';
import { inTransaction } from '../store/db.ts';
import type { Store } from '../store/store.ts';
import { planFolders } from './folders.ts';
import { planHubs } from './hubs.ts';
import { planLayers } from './layers.ts';
import { planLinks } from './links.ts';
import type { ModelClient, Plan, TaskContext } from './plan.ts';
import type { RecordView } from './record.ts';
import { planReview } from './review.ts';
import {
  assertNoRunning,
  currentMark,
  failRun,
  finishRun,
  getRun,
  type Run,
  remoteTokensThisMonth,
  type Scope,
  scopeEntries,
  scopeText,
  startRun,
  type Task,
  TASKS,
} from './runs.ts';
import { planTags } from './tags.ts';
import { schemas, type Schema } from './views.ts';

/** A model run over more entries than this needs --yes, after an estimate of its size. */
export const CONFIRM_ENTRIES = 500;

export interface RunOptions {
  task: Task;
  scope: Scope;
  /** For the tag task: one schema. Without it, `run tag` runs every schema in turn. */
  schema?: Schema;
  engine: 'none' | 'local' | 'remote';
  /** Needed unless the engine is none. */
  client?: ModelClient;
  yes: boolean;
  /** The monthly token budget for an outside model. */
  budget: number;
  /** Progress lines, for stderr. */
  progress: (line: string) => void;
}

export interface PreviewItem {
  purpose: string;
  system: string;
  user: string;
  maxTokens: number;
}

export interface Preview {
  task: Task;
  schema: string | null;
  scope: string;
  engine: string;
  model: string | null;
  entries: number;
  requests: PreviewItem[];
  /** Rough tokens: what the requests send (characters / 4) plus the most they may get back. */
  estimate: number;
}

interface Planned {
  ctx: TaskContext;
  plan: Plan;
  /** The link task uses no model with any engine, so its runs record the No-AI engine. */
  engine: 'none' | 'local' | 'remote';
}

function planTask(store: Store, record: RecordView, options: RunOptions): Planned {
  const { task, scope } = options;
  if (options.engine !== 'none' && !options.client) throw new Error(`The ${options.engine} engine needs a model client.`);
  const engine = task === 'link' ? 'none' : options.engine;
  const schemaId = options.schema?.id ?? null;
  const ctx: TaskContext = {
    db: store.db,
    record,
    scope,
    entries: scopeEntries(store.db, record, scope, task, schemaId),
    model: engine !== 'none',
    engine,
    modelName: engine !== 'none' ? options.client!.model : null,
    now: store.now(),
  };
  const plan = (() => {
    switch (task) {
      case 'tag':
        if (!options.schema) throw new Error('The tag task needs a schema.');
        return planTags(ctx, options.schema);
      case 'file':
        return planFolders(ctx);
      case 'link':
        return planLinks(ctx);
      case 'hub':
        return planHubs(ctx);
      case 'layer':
        return planLayers(ctx);
      case 'review':
        return planReview(ctx);
    }
  })();
  return { ctx, plan, engine };
}

function estimate(planned: Planned, client: ModelClient | undefined): number {
  if (!client) return 0;
  return planned.plan.requests.reduce((n, r) => {
    const sent = client.prepare(r);
    return n + Math.ceil((sent.system.length + sent.user.length) / 4) + r.maxTokens;
  }, 0);
}

/** What a run would send, without sending anything or saving a run. */
export function previewRun(store: Store, record: RecordView, options: RunOptions): Preview {
  const planned = planTask(store, record, options);
  const client = planned.engine === 'none' ? undefined : options.client;
  return {
    task: options.task,
    schema: options.schema?.name ?? null,
    scope: scopeText(options.scope),
    engine: planned.engine,
    model: client?.model ?? null,
    entries: planned.ctx.entries.length,
    requests: client ? planned.plan.requests.map((r) => ({ purpose: r.purpose, ...client.prepare(r), maxTokens: r.maxTokens })) : [],
    estimate: estimate(planned, client),
  };
}

/** Runs one task (one schema, for tags) and returns the finished run. */
export async function runTask(store: Store, record: RecordView, options: RunOptions): Promise<Run> {
  assertNoRunning(store.db);
  const planned = planTask(store, record, options);
  const { ctx, plan, engine } = planned;
  const client = engine === 'none' ? undefined : options.client;
  const label = options.schema ? `tag (${options.schema.name})` : options.task;
  if (client && plan.requests.length) {
    const size = estimate(planned, client);
    if (ctx.entries.length > CONFIRM_ENTRIES && !options.yes) {
      throw new UsageError(
        `${label} would send ${plan.requests.length} requests about ${ctx.entries.length} entries to ${client.model}: ` +
          `about ${size} tokens. Add --yes to go ahead, or narrow it with --scope.`,
      );
    }
    if (client.engine === 'remote') checkBudget(store, options.budget, size, label);
    await client.probe();
  }

  const runId = startRun(store.db, {
    task: options.task,
    engine,
    model: client?.model ?? null,
    scope: scopeText(options.scope),
    schemaId: options.schema?.id ?? null,
    mark: currentMark(store.db),
    now: store.now(),
  });
  let tokensIn = 0;
  let tokensOut = 0;
  try {
    const answers: unknown[] = [];
    for (const [i, request] of plan.requests.entries()) {
      options.progress(`${label}: ${request.purpose} (${i + 1}/${plan.requests.length})`);
      const reply = await client!.send(request);
      tokensIn += reply.tokensIn;
      tokensOut += reply.tokensOut;
      if (client!.engine === 'remote') checkBudget(store, options.budget, 0, label, tokensIn + tokensOut);
      answers.push(request.check(reply.answer));
    }
    const product = plan.finish(answers);
    inTransaction(store.db, () => {
      product.save(store.db, runId);
      finishRun(store.db, runId, {
        counts: product.counts,
        ...(product.message ? { message: product.message } : {}),
        tokensIn,
        tokensOut,
        now: store.now(),
      });
    });
  } catch (err) {
    if (getRun(store.db, runId)?.status === 'running') failRun(store.db, runId, (err as Error).message, tokensIn, tokensOut, store.now());
    throw err;
  }
  return getRun(store.db, runId)!;
}

/** Refuses when an outside model's tokens this month, plus what this run needs or has used, pass the budget. */
function checkBudget(store: Store, budget: number, need: number, label: string, used = 0): void {
  const spent = remoteTokensThisMonth(store.db, store.now());
  if (spent + used + need <= budget) return;
  const left = Math.max(0, budget - spent);
  throw new UsageError(
    used
      ? `${label} stopped: it used ${used} tokens and the outside model's monthly budget of ${budget} is spent. Nothing was saved. Raise it with: skeinwise config budget <tokens>`
      : `${label} needs about ${need} tokens, and ${left} of the outside model's monthly budget of ${budget} is left. Raise it with: skeinwise config budget <tokens>`,
  );
}

/** The steps `run all` and `run tag` take: one per task, and one per schema for tags. */
export interface Step {
  task: Task;
  schema?: Schema;
}

export function steps(store: Store, task: Task | 'all', schema?: Schema): Step[] {
  const tasks = task === 'all' ? TASKS : [task];
  return tasks.flatMap((t): Step[] => (t === 'tag' ? (schema ? [schema] : schemas(store.db)).map((s) => ({ task: t, schema: s })) : [{ task: t }]));
}

/** Runs the steps in order and stops at the first failure, which the error carries. */
export async function runSteps(store: Store, record: RecordView, list: Step[], options: Omit<RunOptions, 'task' | 'schema'>): Promise<Run[]> {
  const done: Run[] = [];
  for (const step of list) {
    done.push(await runTask(store, record, { ...options, task: step.task, ...(step.schema ? { schema: step.schema } : {}) }));
  }
  return done;
}
