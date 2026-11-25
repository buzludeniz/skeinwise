// The layer task: readings of an entry kept beside it, never in place of it. Cleaned drops spoken filler. Digest is
// the entry in a few sentences, Ideas the ideas and plans in it, and Expanded the entry written out in full sentences.
// A model writes Digest, Ideas and Expanded for your longer entries; the No-AI engine picks Digest and Ideas from your
// own sentences and writes no Expanded layer, since that needs new words.

import { FILLER, IDEA_CUES } from './cues.ts';
import { invalid, isRecord, list, type ModelRequest, type Plan, type TaskContext, text } from './plan.ts';
import type { Entry } from '../store/store.ts';
import { unlink } from './record.ts';
import { sentences, summarize } from './text.ts';
import type { LayerName } from './views.ts';

/** Your entries go to a model when they are at least this many words and at most this many characters. */
const MODEL_MIN_WORDS = 20;
const MODEL_MAX_CHARS = 3000;
/** A request holds at most this many entries and characters. */
const BATCH_ENTRIES = 8;
const BATCH_CHARS = 4000;
/** The No-AI digest: this many sentences, for entries of at least DIGEST_FROM sentences (headings left out). */
const DIGEST_SENTENCES = 3;
const DIGEST_FROM = 6;

interface NewLayer {
  entryId: number;
  layer: LayerName;
  body: string;
  byModel: boolean;
}

/** The body with spoken filler taken out. Only lines with filler change, so code and lists keep their shape. */
export function cleaned(body: string): string {
  return body
    .split('\n')
    .map((line) => {
      const out = line.replace(FILLER, '');
      if (out === line) return line;
      const lead = /^\s*/.exec(line)![0];
      const tidy = out.trim().replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1');
      return lead + tidy.charAt(0).toUpperCase() + tidy.slice(1);
    })
    .join('\n');
}

/** The No-AI Digest and Ideas of an entry (either may be missing). */
export function extractLayers(ctx: TaskContext, e: Entry): NewLayer[] {
  const out: NewLayer[] = [];
  const prose = unlink(e.body.replace(/^#+\s.*$/gm, ''));
  if (sentences(prose).length >= DIGEST_FROM) {
    out.push({ entryId: e.id, layer: 'digest', body: summarize(ctx.record.entryIndex, prose, DIGEST_SENTENCES).join(' '), byModel: false });
  }
  const ideas = sentences(prose).filter((s) => IDEA_CUES.test(s));
  if (ideas.length) out.push({ entryId: e.id, layer: 'ideas', body: ideas.map((s) => `- ${s}`).join('\n'), byModel: false });
  return out;
}

export function planLayers(ctx: TaskContext): Plan {
  const forModel = ctx.model
    ? ctx.entries.filter((e) => e.speaker === 'you' && e.body.split(/\s+/).length >= MODEL_MIN_WORDS && e.body.length <= MODEL_MAX_CHARS)
    : [];
  const batches = batch(forModel);
  const requests = batches.map((b, i) => layerRequest(b, `layers ${i + 1} of ${batches.length}`));
  return {
    requests,
    finish: (answers) => {
      const sent = new Set(forModel.map((e) => e.id));
      const layers: NewLayer[] = [];
      for (const e of ctx.entries) {
        const clean = cleaned(e.body);
        if (clean !== e.body) layers.push({ entryId: e.id, layer: 'cleaned', body: clean, byModel: false });
        if (!sent.has(e.id)) layers.push(...extractLayers(ctx, e));
      }
      for (const a of answers) layers.push(...(a as NewLayer[]));
      const count = (name: LayerName) => layers.filter((l) => l.layer === name).length;
      return {
        counts: {
          entries: ctx.entries.length,
          cleaned: count('cleaned'),
          expanded: count('expanded'),
          digest: count('digest'),
          ideas: count('ideas'),
          byModel: new Set(layers.filter((l) => l.byModel).map((l) => l.entryId)).size,
        },
        ...(ctx.model ? {} : { message: 'The No-AI engine writes no Expanded layer: that needs a model.' }),
        save: (db, runId) => {
          const insert = db.prepare('INSERT INTO layers (entry_id, layer, body, engine, model, run_id) VALUES (?, ?, ?, ?, ?, ?)');
          for (const l of layers) {
            insert.run(l.entryId, l.layer, l.body, l.byModel ? ctx.engine : 'none', l.byModel ? ctx.modelName : null, runId);
          }
        },
      };
    },
  };
}

function batch(entries: Entry[]): Entry[][] {
  const out: Entry[][] = [];
  let current: Entry[] = [];
  let chars = 0;
  for (const e of entries) {
    if (current.length && (current.length >= BATCH_ENTRIES || chars + e.body.length > BATCH_CHARS)) {
      out.push(current);
      current = [];
      chars = 0;
    }
    current.push(e);
    chars += e.body.length;
  }
  if (current.length) out.push(current);
  return out;
}

function layerRequest(entries: Entry[], purpose: string): ModelRequest {
  const known = new Map(entries.map((e) => [`E${e.id}`, e]));
  const user = [
    'Entries from my own notes and chats:',
    ...entries.map((e) => `E${e.id}:\n${e.body.trim()}\n`),
    'For each entry, answer with:',
    '- expanded: the entry written out in full, plain sentences, keeping every point and adding nothing new;',
    '- digest: the entry in one to three sentences, or "" if it is already that short;',
    '- ideas: the ideas, plans or next steps in it, each a short sentence; [] if none.',
    'Answer with JSON only: {"entries": [{"id": "E1", "expanded": "...", "digest": "...", "ideas": ["..."]}]}, one item per entry.',
  ].join('\n');
  const check = (answer: unknown): NewLayer[] => {
    if (!isRecord(answer)) invalid(purpose, 'expected a JSON object');
    const out: NewLayer[] = [];
    const answered = new Set<string>();
    for (const it of list(purpose, answer.entries, 'entries')) {
      if (!isRecord(it)) invalid(purpose, 'each "entries" item must be an object');
      const raw = String(it.id ?? '').trim().toUpperCase();
      const key = /^\d+$/.test(raw) ? `E${raw}` : raw;
      const e = known.get(key);
      if (!e) invalid(purpose, `answers for an entry it wasn't shown: ${JSON.stringify(it.id)}`);
      if (answered.has(key)) invalid(purpose, `answers for ${key} twice`);
      answered.add(key);
      out.push({ entryId: e.id, layer: 'expanded', body: text(purpose, it.expanded, 'expanded', 8000), byModel: true });
      if (typeof it.digest !== 'string') invalid(purpose, '"digest" must be text');
      if (it.digest.trim()) out.push({ entryId: e.id, layer: 'digest', body: text(purpose, it.digest, 'digest', 1500), byModel: true });
      const ideas = list(purpose, it.ideas, 'ideas').map((x) => text(purpose, x, 'ideas', 400));
      if (ideas.length > 10) invalid(purpose, `lists ${ideas.length} ideas for ${key}; at most 10`);
      if (ideas.length) out.push({ entryId: e.id, layer: 'ideas', body: ideas.map((x) => `- ${x}`).join('\n'), byModel: true });
    }
    const missing = [...known.keys()].filter((k) => !answered.has(k));
    if (missing.length) invalid(purpose, `gives no answer for ${missing.join(', ')}`);
    return out;
  };
  const chars = entries.reduce((n, e) => n + e.body.length, 0);
  return {
    purpose,
    system: "You rewrite one person's own notes faithfully. You never add facts. You answer with JSON only.",
    user,
    maxTokens: Math.ceil(chars / 2) + 200 * entries.length,
    check,
  };
}
