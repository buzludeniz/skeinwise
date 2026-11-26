// Drawing a view: the local model turns a request ("my garden notes, month by month") into a view spec. Only the
// local engine draws, so a request and the record's values it names never leave this computer. The model's answer is
// untrusted: it goes through checkSpecValue and resolveSpec like any other input. When the engine is off, the model
// can't be reached, another run is going, or the spec doesn't pass, the closest built-in view stands in and the
// result says why. The call is recorded as an "ask" run with detail {view: true}, as `model check` records its own.

import { loadConfig } from '../config.ts';
import { UsageError } from '../errors.ts';
import { createModel, type ModelDeps } from '../organiser/model.ts';
import { AnswerError, type ModelClient, type ModelRequest } from '../organiser/plan.ts';
import { currentMark, failRun, finishRun, startRun } from '../organiser/runs.ts';
import { safeLine } from '../safe-text.ts';
import { type EntryRow, tableValue } from '../server/buckets.ts';
import { TABLE_FORMS, TABLE_PROPS } from '../server/config.ts';
import { entryRows } from '../server/queries.ts';
import type { Store } from '../store/store.ts';
import { closestBuiltin } from './builtins.ts';
import { resolveSpec } from './data.ts';
import { checkSpecValue, KINDS, type Salvage, SPEC_LIMITS, type ViewSpec, WHERE_PROPS } from './spec.ts';

export const REQUEST_LIMIT = 300;
export const NO_AI_NOTE = 'Drawing a new view needs the local model. Skeinwise is set to No-AI, so only the built-in views exist.';
export const REMOTE_NOTE = 'Drawing a new view needs the local model. Views never go to a remote model, and the engine is set to remote.';

/** Whether this record can draw views now, and if not, the plain reason. */
export function drawState(home: string): { draws: boolean; engine: string; note: string | null } {
  const engine = loadConfig(home).engine;
  if (engine === 'local') return { draws: true, engine, note: null };
  return { draws: false, engine, note: engine === 'none' ? NO_AI_NOTE : REMOTE_NOTE };
}

export interface Drawn {
  spec: ViewSpec;
  /** True when the model's own spec is shown; false when a built-in view stands in. */
  drawn: boolean;
  /** The built-in view that stands in, by id. */
  builtin: string | null;
  /** Why the built-in stands in. Empty when drawn. */
  why: string[];
  model: string | null;
  runId: number | null;
}

const VALUES_PER_PROP = 20;

/** The record's most common values for each property, as the model may use them in filters. */
function vocabulary(rows: readonly EntryRow[]): string[] {
  const lines: string[] = [];
  for (const prop of TABLE_PROPS) {
    const counts = new Map<string, number>();
    for (const r of rows) {
      const v = tableValue(r, prop);
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    if (prop === 'time') {
      const months = [...counts.keys()].sort();
      if (months.length) lines.push(`- time: months from ${months[0]} to ${months.at(-1)}`);
      continue;
    }
    const top = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, VALUES_PER_PROP)
      .map(([v]) => JSON.stringify([...safeLine(v)].slice(0, 60).join('')));
    if (top.length) lines.push(`- ${prop}: ${top.join(', ')}`);
  }
  return lines;
}

export function viewRequest(request: string, rows: readonly EntryRow[]): ModelRequest {
  const user = [
    `My request: ${request}`,
    '',
    'Answer with one JSON object and nothing else, in one of these two shapes:',
    '{"v": 1, "title": "Garden by month", "show": "chart", "form": "bars", "x": "time", "where": [{"prop": "project", "is": "Garden"}]}',
    '{"v": 1, "title": "Recent notes", "show": "list", "sort": "newest", "limit": 50, "where": [{"prop": "kind", "is": "note"}]}',
    '- title: a short plain name for the view.',
    '- show: "chart" counts entries; "list" lists them.',
    `- A chart has form (one of ${TABLE_FORMS.join(', ')}), x (what runs along the bottom) and, if the request splits it, y (one colour per value). x and y are each one of ${TABLE_PROPS.join(', ')}, and differ. A chart has no sort or limit.`,
    `- A list has sort ("newest" or "oldest") and limit (1 to ${SPEC_LIMITS.list}). A list has no form, x or y.`,
    `- where is optional: up to ${SPEC_LIMITS.where} filters that all hold, at most one per prop. prop is one of ${WHERE_PROPS.join(', ')}. For time, "is" is a month like "2025-03"; for kind, one of ${KINDS.join(', ')}; otherwise one of the values below.`,
    '- from and to are optional dates like "2025-03" or "2025-03-14".',
    '- Leave out what the request does not need. No other fields.',
    '',
    'Values in my record:',
    ...vocabulary(rows),
  ].join('\n');
  return {
    purpose: 'the view',
    system: "You turn one person's request for a chart or a list of their own notes and chats into a small JSON view spec. You answer with JSON only.",
    user,
    maxTokens: 300,
    // The answer is checked by checkSpecValue after send, with reasons the page can show.
    check: (answer) => answer,
  };
}

function standIn(salvage: Salvage, request: string, why: string[], extra: Partial<Drawn> = {}): Drawn {
  const b = closestBuiltin(salvage, request);
  return { spec: b.spec, drawn: false, builtin: b.id, why, model: null, runId: null, ...extra };
}

function errorText(error: unknown): string {
  return safeLine(error instanceof Error ? error.message : String(error)).slice(0, 300);
}

/** Draws a view for a request, or gives the closest built-in view and why. */
export async function drawView(store: Store, home: string, request: unknown, deps: ModelDeps): Promise<Drawn> {
  if (typeof request !== 'string') throw new UsageError('Describe the view you want, in a few words.');
  const text = safeLine(request).trim();
  if (!text) throw new UsageError('Describe the view you want, in a few words.');
  if ([...text].length > REQUEST_LIMIT) throw new UsageError(`Describe the view in ${REQUEST_LIMIT} characters or fewer.`);

  const state = drawState(home);
  if (!state.draws) return standIn({}, text, [state.note!]);
  let client: ModelClient;
  try {
    // The record folder holds the local server's key: never the one HOME or the environment would point at.
    client = createModel(loadConfig(home), 'local', { ...deps, home });
    await client.probe();
  } catch (error) {
    return standIn({}, text, [`The local model didn't answer: ${errorText(error)}`]);
  }

  const rows = entryRows(store.db);
  const req = viewRequest(text, rows);
  let runId: number;
  try {
    runId = startRun(store.db, { task: 'ask', engine: 'local', model: client.model, scope: 'all', mark: currentMark(store.db), detail: { view: true }, now: store.now() });
  } catch (error) {
    if (error instanceof UsageError) return standIn({}, text, [`Another run is going, so the model wasn't asked. ${errorText(error)}`]);
    throw error;
  }
  const meta = { model: client.model, runId };
  let reply: Awaited<ReturnType<ModelClient['send']>>;
  try {
    reply = await client.send(req);
  } catch (error) {
    const spent = error instanceof AnswerError ? error : { tokensIn: 0, tokensOut: 0 };
    failRun(store.db, runId, errorText(error), spent.tokensIn, spent.tokensOut, store.now());
    // What the local server can go wrong with: unreachable or slow (UsageError), a bad status, or an answer that isn't
    // JSON. Anything else is a fault here, and is thrown.
    if (error instanceof AnswerError || error instanceof UsageError || /^\S+ answered \d{3} /.test(errorText(error))) {
      return standIn({}, text, [`The model's answer couldn't be used: ${errorText(error)}`], meta);
    }
    throw error;
  }
  const { tokensIn, tokensOut } = reply;
  const checked = checkSpecValue(reply.answer);
  if (!checked.ok) {
    failRun(store.db, runId, `The view didn't pass: ${checked.reasons.join(' ')}`.slice(0, 1000), tokensIn, tokensOut, store.now());
    return standIn(checked.salvage, text, ["The model's view didn't pass the check:", ...checked.reasons], meta);
  }
  const resolved = resolveSpec(checked.spec, rows);
  if (!resolved.ok) {
    failRun(store.db, runId, `The view names what the record lacks: ${resolved.reasons.join(' ')}`.slice(0, 1000), tokensIn, tokensOut, store.now());
    const s = checked.spec;
    const salvage: Salvage = { title: s.title, show: s.show, ...(s.show === 'chart' ? { form: s.form, x: s.x, ...(s.y ? { y: s.y } : {}) } : { sort: s.sort }) };
    return standIn(salvage, text, ["The model's view filters on something your record doesn't have:", ...resolved.reasons], meta);
  }
  finishRun(store.db, runId, { counts: { views: 1 }, message: text.slice(0, 200), tokensIn, tokensOut, now: store.now() });
  return { spec: resolved.spec, drawn: true, builtin: null, why: [], ...meta };
}
