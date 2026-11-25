// Asking the record a question. Three kinds of question get their own search: "when did I first …" lists the earliest
// entries that mention it, "what did I decide about …" the sentences where you settled it, and "what changed in my
// thinking on …" the first mention followed by every decision and change of course, all oldest first. Any other
// question is a ranked search, your own words first. With a model, a short answer is added that cites the entries
// it rests on; the No-AI engine shows the entries alone.

import { UsageError } from '../errors.ts';
import type { Entry, SearchHit, Store } from '../store/store.ts';
import { CHANGE_CUES, DECISION_CUES } from './cues.ts';
import { checkBudget } from './organise.ts';
import { AnswerError, cited, day, invalid, isRecord, type ModelClient, type ModelRequest } from './plan.ts';
import { type RecordView, unlink } from './record.ts';
import { currentMark, failRun, finishRun, startRun } from './runs.ts';
import { cosine, sentences, tokenize } from './text.ts';

export type AskKind = 'first' | 'decided' | 'changed' | 'any';

export interface AskHit {
  entryId: number;
  date: string;
  speaker: string;
  /** The entry's title, or its thread's. */
  where: string | null;
  /** The sentence that answers, or the one closest to it. */
  quote: string;
  /** Why it is listed, for the question kinds that pick entries by what they say. */
  why: 'first mention' | 'decision' | 'change' | null;
}

export interface AskResult {
  question: string;
  kind: AskKind;
  /** The words searched for. */
  topic: string;
  hits: AskHit[];
  /** The model's answer, or null without a model (or when no entry matched). */
  answer: string | null;
  /** The entries the answer cites. */
  cites: number[];
  engine: 'none' | 'local' | 'remote';
  model: string | null;
  /** The run that records a model's answer and its tokens. */
  runId: number | null;
  message: string | null;
}

export interface AskOptions {
  engine: 'none' | 'local' | 'remote';
  client?: ModelClient;
  budget: number;
  limit: number;
}

/** A model sees at most this many entries, and this much of each. */
const MODEL_HITS = 12;
const HIT_CHARS = 500;
const QUOTE_CHARS = 300;

const PATTERNS: { kind: Exclude<AskKind, 'any'>; re: RegExp }[] = [
  { kind: 'first', re: /^when did i first\s+(.+)$/i },
  { kind: 'decided', re: /^what (?:did|have) i decided?\s+(?:about|on|for|regarding)\s+(.+)$/i },
  { kind: 'changed', re: /^what changed in my (?:thinking|mind|views?|opinions?)\s+(?:on|about)\s+(.+)$/i },
  { kind: 'changed', re: /^how (?:has|did) my (?:thinking|mind|views?|opinions?)\s+(?:on|about)\s+(.+?)\s+changed?$/i },
];

/** Verbs that only say how something came up: "when did I first mention X" searches for X. */
const SAYING = /^(?:mention(?:ed)?|talk(?:ed)?|write|wrote|think|thought|say|said|use[d]?|start(?:ed)?|hear[d]?|read|tr(?:y|ied)|look(?:ed)?|ask(?:ed)?|bring up|brought up)\s+(?:about\s+|of\s+|on\s+|into\s+|at\s+|with\s+)?/i;

export function parseQuestion(question: string): { kind: AskKind; topic: string } {
  const q = question.trim().replace(/[?.!\s]+$/, '');
  if (!q) throw new UsageError('Ask a question, for example: skeinwise ask "what did I decide about sqlite"');
  for (const { kind, re } of PATTERNS) {
    const m = re.exec(q);
    if (!m) continue;
    const topic = kind === 'first' ? m[1]!.replace(SAYING, '').trim() || m[1]!.trim() : m[1]!.trim();
    return { kind, topic };
  }
  return { kind: 'any', topic: q };
}

/** The entries that answer a question, found with search and word cues. */
export function findAnswers(store: Store, record: RecordView, kind: AskKind, topic: string, limit: number): AskHit[] {
  const stems = [...new Set(tokenize(topic))];
  const hasStem = (s: string) => {
    const words = new Set(tokenize(s));
    return stems.some((t) => words.has(t));
  };
  const visible = (hits: SearchHit[]) => hits.map((h) => record.byId.get(h.id)).filter((e): e is Entry => !!e);
  const oldestFirst = (a: Entry, b: Entry) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id;
  // Every entry holding all the words: the oldest ones matter here, not the best-ranked.
  const all = (speaker?: string) => visible(store.search(topic, { strict: true, limit: 100_000, ...(speaker ? { speaker } : {}) })).sort(oldestFirst);

  if (kind === 'any') {
    return visible(store.search(topic, { limit })).map((e) => hit(e, quote(e, hasStem), null));
  }
  if (kind === 'first') {
    const yours = all('you');
    return (yours.length ? yours : all()).slice(0, limit).map((e) => hit(e, quote(e, hasStem), 'first mention'));
  }
  const yours = all('you');
  const out: AskHit[] = [];
  if (kind === 'changed' && yours.length) out.push(hit(yours[0]!, quote(yours[0]!, hasStem), 'first mention'));
  for (const e of yours) {
    const said = prose(e).filter((s) => hasStem(s));
    const decision = said.find((s) => DECISION_CUES.test(s));
    // For "what changed", a change of course is named as one even when it also settles something.
    const change = kind === 'changed' ? said.find((s) => CHANGE_CUES.test(s) && !/^decided\b/i.test(s)) : undefined;
    const why = change ? 'change' : decision ? 'decision' : null;
    if (!why || out.some((h) => h.entryId === e.id)) continue;
    out.push(hit(e, clip(change ?? decision!), why));
  }
  return out.slice(0, kind === 'changed' ? limit + 1 : limit);
}

function hit(e: Entry, q: string, why: AskHit['why']): AskHit {
  return { entryId: e.id, date: day(e.createdAt), speaker: e.speaker, where: e.title ?? e.threadTitle, quote: q, why };
}

function clip(s: string): string {
  return s.length > QUOTE_CHARS ? `${s.slice(0, QUOTE_CHARS - 1)}…` : s;
}

/** An entry's sentences, headings left out (a note's title heading says nothing new). */
function prose(e: Entry): string[] {
  const list = sentences(unlink(e.body.replace(/^#+\s.*$/gm, '')));
  return list.length ? list : sentences(unlink(e.body));
}

/** The first sentence that mentions the topic, or the entry's first sentence. */
function quote(e: Entry, hasStem: (s: string) => boolean): string {
  const list = prose(e);
  return clip(list.find(hasStem) ?? list[0] ?? e.body.trim());
}

/** The entries most like one entry, from other threads, by their words. */
export function similarEntries(record: RecordView, entryId: number, limit: number): (AskHit & { score: number })[] {
  const entry = record.byId.get(entryId);
  if (!entry) throw new UsageError(`No entry ${entryId} in the record (or its source is excluded).`);
  const v = record.entryVector(entryId);
  if (!v.size) return [];
  return record.entries
    .filter((e) => e.id !== entryId && (entry.threadId === null || e.threadId !== entry.threadId))
    .map((e) => ({ e, score: cosine(v, record.entryVector(e.id)) }))
    .filter((x) => x.score >= 0.05)
    .sort((a, b) => b.score - a.score || a.e.id - b.e.id)
    .slice(0, limit)
    .map(({ e, score }) => ({ ...hit(e, clip(prose(e)[0] ?? e.body.trim()), null), score: Math.round(score * 1000) / 1000 }));
}

export async function ask(store: Store, record: RecordView, question: string, options: AskOptions): Promise<AskResult> {
  const { kind, topic } = parseQuestion(question);
  const hits = findAnswers(store, record, kind, topic, options.limit);
  const base: AskResult = { question, kind, topic, hits, answer: null, cites: [], engine: options.engine, model: null, runId: null, message: null };
  if (!hits.length) return { ...base, message: `Nothing in your record matches "${topic}".` };
  if (options.engine === 'none') return base;
  const client = options.client;
  if (!client) throw new Error(`The ${options.engine} engine needs a model client.`);

  const request = answerRequest(store, question, hits.slice(0, MODEL_HITS));
  if (client.engine === 'remote') {
    const sent = client.prepare(request);
    checkBudget(store, options.budget, Math.ceil((sent.system.length + sent.user.length) / 4) + request.maxTokens, 'ask');
  }
  await client.probe();
  const runId = startRun(store.db, { task: 'ask', engine: client.engine, model: client.model, scope: 'all', mark: currentMark(store.db), now: store.now() });
  let tokensIn = 0;
  let tokensOut = 0;
  try {
    const reply = await client.send(request).catch((err: unknown) => {
      if (err instanceof AnswerError) {
        tokensIn = err.tokensIn;
        tokensOut = err.tokensOut;
      }
      throw err;
    });
    tokensIn = reply.tokensIn;
    tokensOut = reply.tokensOut;
    const answer = request.check(reply.answer) as { text: string; cites: number[] };
    finishRun(store.db, runId, {
      counts: { hits: hits.length, cites: answer.cites.length },
      message: question.slice(0, 200),
      tokensIn,
      tokensOut,
      now: store.now(),
    });
    return {
      ...base,
      engine: client.engine,
      model: client.model,
      runId,
      answer: answer.text || null,
      cites: answer.cites,
      message: answer.text ? null : 'The model found no answer in these entries.',
    };
  } catch (err) {
    failRun(store.db, runId, (err as Error).message, tokensIn, tokensOut, store.now());
    throw err;
  }
}

function answerRequest(store: Store, question: string, hits: AskHit[]): ModelRequest {
  const purpose = 'the answer';
  const known = new Map(hits.map((h, i) => [`E${i + 1}`, h.entryId]));
  const lines = hits.map((h, i) => {
    const body = (store.getEntry(h.entryId)?.body ?? '').replace(/\s+/g, ' ');
    const more = body.length > HIT_CHARS ? `${body.slice(0, HIT_CHARS)}…` : body;
    return `E${i + 1} (${h.date}, ${h.speaker === 'you' ? 'me' : h.speaker}${h.where ? `, "${h.where}"` : ''}): ${more}`;
  });
  const user = [
    `My question: ${question}`,
    '',
    'Entries from my notes and chats that may answer it:',
    ...lines,
    '',
    'Answer with JSON only: {"answer": "...", "cites": ["E1"]}',
    '- answer: one to three plain sentences that answer the question from these entries, with dates where they matter;',
    '- cites: the entries the answer rests on.',
    'If the entries do not answer it: {"answer": "", "cites": []}.',
  ].join('\n');
  const check = (answer: unknown) => {
    if (!isRecord(answer)) invalid(purpose, 'expected a JSON object');
    if (typeof answer.answer !== 'string') invalid(purpose, '"answer" must be text');
    const text = answer.answer.trim();
    if (text.length > 800) invalid(purpose, '"answer" is longer than 800 characters');
    const cites = cited(purpose, answer.cites, 'cites', 'E', known);
    if (text && !cites.length) invalid(purpose, 'answers without citing an entry');
    if (!text && cites.length) invalid(purpose, 'cites entries but gives no answer');
    return { text, cites };
  };
  return {
    purpose,
    system: "You answer one person's questions from their own notes and chats. You only use what the entries say. You answer with JSON only.",
    user,
    maxTokens: 300,
    check,
  };
}
