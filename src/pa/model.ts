// The assistant on a model. A model brief adds a few written lines to the No-AI brief, each citing the entries it
// rests on. A model reading of loops goes through your sentences that haven't been read yet, a chunk at a time, and
// keeps its verdict for each (src/pa/loops.ts prefers it over the cues). Each is one run with task 'ask' and detail
// {pa}, so it shows in the run list and counts against the outside model's budget like a question does. When the
// model can't be reached or its answer doesn't fit, the No-AI reading stands and the message says why; a spent
// budget is the one failure that stops instead.

import { UsageError } from '../errors.ts';
import { checkBudget } from '../organiser/organise.ts';
import { AnswerError, cited, invalid, isRecord, type ModelClient, type ModelRequest, text } from '../organiser/plan.ts';
import type { RecordView } from '../organiser/record.ts';
import { currentMark, failRun, finishRun, startRun } from '../organiser/runs.ts';
import { inTransaction } from '../store/db.ts';
import type { Store } from '../store/store.ts';
import { type Brief, type BriefBody, briefBody, briefChanges, briefWindow, type BriefOptions, saveBrief } from './brief.ts';
import { type LoopKind, loopKind, TODO_MARK } from './cues.ts';
import { findLoops, LOOP_DAYS, type Loop, type LoopOptions, loopEntries, saidIn, type Said } from './loops.ts';
import { assertPaReady, checkDay } from './tasks.ts';

export interface PaEngine {
  engine: 'none' | 'local' | 'remote';
  client?: ModelClient;
  /** The outside model's monthly token budget. */
  budget: number;
}

const BRIEF_ENTRIES = 40;
const BRIEF_CHARS = 400;
const BRIEF_LINES = 5;
export const LOOP_CHUNK = 30;
/** Sentences one loops run reads at most; the next run goes on from there. */
export const LOOP_READ_MAX = 300;
const KINDS: readonly LoopKind[] = ['promise', 'todo', 'waiting', 'reminder'];
/** Sentences that could be a loop at all: worth a model's look, with every sentence the cue lists pick. */
const MAYBE_LOOP =
  /\b(?:i|i'll|i'd|i'm|we|we'll|let's|need|must|should|have to|got to|gotta|remind|waiting|wait for|owe|owes|promised|will|going to|todo|to-do|follow up|due)\b/i;

/** Runs a model's requests as one 'ask' run, then saves inside the transaction that marks it done. */
async function modelRun<T>(
  store: Store,
  client: ModelClient,
  budget: number,
  pa: 'brief' | 'loops',
  requests: ModelRequest[],
  save: (answers: unknown[], runId: number) => { counts: Record<string, number>; value: T },
): Promise<T> {
  const label = pa === 'brief' ? 'The brief' : 'Reading loops';
  if (client.engine === 'remote') {
    const need = requests.reduce((n, r) => {
      const sent = client.prepare(r);
      return n + Math.ceil((sent.system.length + sent.user.length) / 4) + r.maxTokens;
    }, 0);
    checkBudget(store, budget, need, label);
  }
  await client.probe();
  const runId = startRun(store.db, { task: 'ask', engine: client.engine, model: client.model, scope: 'all', mark: currentMark(store.db), detail: { pa }, now: store.now() });
  let tokensIn = 0;
  let tokensOut = 0;
  try {
    const answers: unknown[] = [];
    for (const request of requests) {
      const reply = await client.send(request).catch((err: unknown) => {
        if (err instanceof AnswerError) {
          tokensIn += err.tokensIn;
          tokensOut += err.tokensOut;
        }
        throw err;
      });
      tokensIn += reply.tokensIn;
      tokensOut += reply.tokensOut;
      answers.push(request.check(reply.answer));
      if (client.engine === 'remote') checkBudget(store, budget, 0, label, tokensIn + tokensOut);
    }
    return inTransaction(store.db, () => {
      const { counts, value } = save(answers, runId);
      finishRun(store.db, runId, { counts, tokensIn, tokensOut, now: store.now() });
      return value;
    });
  } catch (err) {
    failRun(store.db, runId, (err as Error).message, tokensIn, tokensOut, store.now());
    throw err;
  }
}

function stops(error: unknown): boolean {
  return error instanceof UsageError && /budget|cap/i.test(error.message);
}

function why(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The brief.

export function briefRequest(record: RecordView, options: BriefOptions, body: BriefBody): { request: ModelRequest; shown: number } | null {
  const win = briefWindow(record.store.db, options);
  const { changed } = briefChanges(record, win, options.now);
  const picked = changed.filter((c) => c.fresh.length).slice(-BRIEF_ENTRIES);
  if (!picked.length) return null;
  const known = new Map(picked.map((c, i) => [`E${i + 1}`, c.entry.id]));
  const lines = picked.map((c, i) => {
    const said = c.fresh.join(' ').replace(/\s+/g, ' ');
    const more = said.length > BRIEF_CHARS ? `${said.slice(0, BRIEF_CHARS)}…` : said;
    const where = c.entry.threadTitle ?? c.entry.title;
    return `E${i + 1} (${c.entry.createdAt.slice(0, 10)}, ${c.entry.speaker === 'you' ? 'me' : c.entry.speaker}${where ? `, "${where}"` : ''}${c.edited ? ', added to' : ''}): ${more}`;
  });
  const t = body.tasks;
  const purpose = 'the brief';
  const user = [
    `What came into my notes and chats since ${body.since.slice(0, 16).replace('T', ' ')} UTC:`,
    ...lines,
    '',
    `I have ${t.open} open tasks (${t.overdue} overdue) and ${body.followUps} open loops to follow up.`,
    '',
    'Write my brief. Answer with JSON only: {"lines": [{"text": "...", "cites": ["E1"]}]}',
    `- lines: two to ${BRIEF_LINES} plain sentences: what I worked on, what I decided, what I said I would do, what is still open;`,
    '- each line cites the entries it rests on;',
    '- say only what the entries say; address me as "you".',
  ].join('\n');
  const check = (answer: unknown) => {
    if (!isRecord(answer)) invalid(purpose, 'expected a JSON object');
    const items = Array.isArray(answer.lines) ? answer.lines : invalid(purpose, '"lines" must be a list');
    if (items.length > BRIEF_LINES + 1) invalid(purpose, `"lines" has more than ${BRIEF_LINES + 1} lines`);
    return items.map((item, i) => {
      if (!isRecord(item)) invalid(purpose, `line ${i + 1} must be an object`);
      const cites = cited(purpose, item.cites, `lines[${i}].cites`, 'E', known);
      if (!cites.length) invalid(purpose, `line ${i + 1} cites no entry`);
      return { text: text(purpose, item.text, `lines[${i}].text`, 300), cites };
    });
  };
  return {
    request: {
      purpose,
      system: "You write a short daily brief for one person from their own new notes and chats. You only use what the entries say. You answer with JSON only.",
      user,
      maxTokens: 500,
      check,
    },
    shown: picked.length,
  };
}

/**
 * A brief on the engine asked for. With a model, its lines are added to the No-AI brief; if the model fails, the
 * No-AI brief is kept and the message says why. A spent budget stops with nothing saved.
 */
export async function makeBriefWith(record: RecordView, options: BriefOptions, engine: PaEngine): Promise<{ brief: Brief; message: string | null }> {
  const store = record.store;
  assertPaReady(store.db);
  const win = briefWindow(store.db, options);
  const body = briefBody(record, win, options.now);
  const plain = () => saveBrief(store.db, { win, body, engine: 'none', now: options.now });
  if (engine.engine === 'none') return { brief: plain(), message: null };
  if (!engine.client) throw new Error(`The ${engine.engine} engine needs a model client.`);
  const built = briefRequest(record, options, body);
  if (!built) return { brief: plain(), message: 'Nothing new to write about, so this brief is the No-AI one.' };
  const client = engine.client;
  try {
    const brief = await modelRun(store, client, engine.budget, 'brief', [built.request], ([lines], runId) => {
      const value = saveBrief(store.db, { win, body: { ...body, lines: lines as BriefBody['lines'] }, engine: client.engine, model: client.model, runId, now: options.now });
      return { counts: { entries: built.shown, lines: value.body.lines.length }, value };
    });
    return { brief, message: null };
  } catch (error) {
    if (stops(error)) throw error;
    return { brief: plain(), message: `The ${engine.engine} model didn't write the brief, so this is the No-AI one. ${why(error)}` };
  }
}

// Loops.

/** Your sentences in the window that a model hasn't read yet and that could be a loop, newest first. */
export function unreadSentences(record: RecordView, now: string, days: number | null = LOOP_DAYS): Said[] {
  const read = new Set(
    (record.store.db.prepare("SELECT DISTINCT f.key FROM pa_found f JOIN runs r ON r.id = f.run_id WHERE r.status = 'done'").all() as { key: string }[]).map((r) => r.key),
  );
  const out: Said[] = [];
  for (const e of [...loopEntries(record, now, days)].reverse()) {
    for (const said of saidIn(e)) {
      const s = said.sentence.trim();
      if (read.has(said.key) || s.length < 8 || s.length > 280) continue;
      if (MAYBE_LOOP.test(s) || TODO_MARK.test(s) || loopKind(s, e.kind === 'message')) out.push(said);
    }
  }
  return out;
}

interface Found {
  key: string;
  kind: LoopKind;
  what: string;
  who: string | null;
  dueDay: string | null;
}

function nullish(v: unknown): boolean {
  return v === null || v === undefined || v === '' || (typeof v === 'string' && /^(?:null|none|n\/a|-)$/i.test(v.trim()));
}

export function loopsRequest(chunk: Said[], n: number, of: number): ModelRequest {
  const purpose = `loops ${n} of ${of}`;
  const known = new Map(chunk.map((s, i) => [`S${i + 1}`, i]));
  const user = [
    'Sentences I wrote, each with the day I wrote it:',
    ...chunk.map((s, i) => `S${i + 1} (${s.entry.createdAt.slice(0, 10)}): ${s.sentence.replace(/\s+/g, ' ')}`),
    '',
    'Which of these are open loops: something I said I would do, a to-do, a reminder I asked for, or something I am waiting on from someone?',
    'Not loops: things already done, wishes, plans with no action, and requests to an assistant in a chat.',
    'Answer with JSON only: {"loops": [{"s": "S1", "kind": "promise", "what": "...", "who": null, "due": null}]}',
    '- kind: promise (I said I would), todo, reminder (I asked to be reminded) or waiting (I wait on someone);',
    '- what: the action as a short task title, like "Send Ana the report";',
    '- who: the person it involves, or null; due: the day it is due as YYYY-MM-DD, worked out from the day written, or null.',
    'Leave out every sentence that is not an open loop. If none is: {"loops": []}.',
  ].join('\n');
  const check = (answer: unknown): Found[] => {
    if (!isRecord(answer)) invalid(purpose, 'expected a JSON object');
    const items = Array.isArray(answer.loops) ? answer.loops : invalid(purpose, '"loops" must be a list');
    const seen = new Set<string>();
    const out: Found[] = [];
    items.forEach((item, i) => {
      if (!isRecord(item)) invalid(purpose, `loop ${i + 1} must be an object`);
      const [idx] = cited(purpose, [item.s], `loops[${i}].s`, 'S', known);
      const said = chunk[idx!]!;
      if (seen.has(said.key)) return;
      seen.add(said.key);
      const kind = item.kind as LoopKind;
      if (!KINDS.includes(kind)) invalid(purpose, `loop ${i + 1} has kind ${JSON.stringify(item.kind)}`);
      let due: string | null = null;
      if (!nullish(item.due)) {
        try {
          due = checkDay(typeof item.due === 'string' ? item.due.trim() : String(item.due));
        } catch {
          invalid(purpose, `loop ${i + 1} has due ${JSON.stringify(item.due)}, which is not a day`);
        }
      }
      out.push({
        key: said.key,
        kind,
        what: text(purpose, item.what, `loops[${i}].what`, 200),
        who: nullish(item.who) ? null : text(purpose, item.who, `loops[${i}].who`, 60),
        dueDay: due,
      });
    });
    return out;
  };
  return {
    purpose,
    system: "You find the open loops in one person's own sentences: what they said they would do or are waiting on. You answer with JSON only.",
    user,
    maxTokens: 900,
    check,
  };
}

export interface LoopRead {
  read: number;
  loops: number;
  /** Sentences still unread after this run. */
  left: number;
  runId: number | null;
}

/** A model reads up to LOOP_READ_MAX of your unread sentences and keeps its verdict on each. */
export async function readLoops(record: RecordView, now: string, engine: PaEngine & { engine: 'local' | 'remote' }, days: number | null = LOOP_DAYS): Promise<LoopRead> {
  const store = record.store;
  assertPaReady(store.db);
  if (!engine.client) throw new Error(`The ${engine.engine} engine needs a model client.`);
  const unread = unreadSentences(record, now, days);
  const take = unread.slice(0, LOOP_READ_MAX);
  if (!take.length) return { read: 0, loops: 0, left: 0, runId: null };
  const chunks: Said[][] = [];
  for (let i = 0; i < take.length; i += LOOP_CHUNK) chunks.push(take.slice(i, i + LOOP_CHUNK));
  const requests = chunks.map((c, i) => loopsRequest(c, i + 1, chunks.length));
  return modelRun(store, engine.client, engine.budget, 'loops', requests, (answers, runId) => {
    const insert = store.db.prepare(
      'INSERT INTO pa_found (run_id, key, entry_id, is_loop, kind, what, who, due_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    let loops = 0;
    chunks.forEach((chunk, i) => {
      const found = new Map((answers[i] as Found[]).map((f) => [f.key, f]));
      for (const said of chunk) {
        const f = found.get(said.key);
        if (f) loops++;
        insert.run(runId, said.key, said.entry.id, f ? 1 : 0, f?.kind ?? null, f?.what ?? null, f?.who ?? null, f?.dueDay ?? null);
      }
    });
    return { counts: { read: take.length, loops }, value: { read: take.length, loops, left: unread.length - take.length, runId } };
  });
}

/**
 * Open loops on the engine asked for: with a model, it first reads the sentences it hasn't; if it fails, the cue
 * reading stands and the message says why. A spent budget stops instead.
 */
export async function findLoopsWith(
  record: RecordView,
  options: LoopOptions,
  engine: PaEngine,
): Promise<{ loops: Loop[]; read: LoopRead | null; message: string | null }> {
  if (engine.engine === 'none') return { loops: findLoops(record, options), read: null, message: null };
  let read: LoopRead | null = null;
  let message: string | null = null;
  try {
    read = await readLoops(record, options.now, engine as PaEngine & { engine: 'local' | 'remote' }, options.days === undefined ? LOOP_DAYS : options.days);
    if (read.left) message = `The model read ${read.read} sentences; ${read.left} more are still to read. Run it again to go on.`;
  } catch (error) {
    if (stops(error)) throw error;
    message = `The ${engine.engine} model didn't read your sentences, so these loops are from the cue lists alone. ${why(error)}`;
  }
  return { loops: findLoops(record, options), read, message };
}
