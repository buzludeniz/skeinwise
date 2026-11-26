// `similar <entry>`: the entries in other threads that read most like one. The scores are the same TF-IDF cosine the
// organiser's entry index gives (buildIndex's term window, idf and weights), worked out in one pass over the record
// without building that index: it keeps no word forms and no vector for an entry that shares no term with this one.
// At 50,000 entries that is the difference between about 4 s and the 1 s budget (plan 7.2).

import { UsageError } from '../errors.ts';
import type { Store } from '../store/store.ts';
import type { AskHit } from './ask.ts';
import { day } from './plan.ts';
import { entryText, unlink } from './record.ts';
import { dfWindow, idfOf, sentences, termWeight, tokenize } from './text.ts';
import { VISIBLE_ENTRIES } from './views.ts';

const MIN_SCORE = 0.05;
const QUOTE_CHARS = 300;

export type SimilarHit = AskHit & { score: number };

function counts(text: string): Map<string, number> {
  const c = new Map<string, number>();
  for (const t of tokenize(text)) c.set(t, (c.get(t) ?? 0) + 1);
  return c;
}

export function similarEntries(store: Store, entryId: number, limit: number): SimilarHit[] {
  const entry = store.visibleEntry(entryId);
  if (!entry) throw new UsageError(`No entry ${entryId} in the record (or its source is excluded).`);
  const own = counts(entryText(entry));
  if (!own.size) return [];

  // Every visible entry counts towards document frequencies; only those that share a term can score.
  const df = new Map<string, number>();
  const sharing: { id: number; terms: Map<string, number> }[] = [];
  let n = 0;
  const rows = store.db
    .prepare(`SELECT e.id, e.thread_id AS threadId, e.title, v.body FROM entries e JOIN versions v ON v.entry_id = e.id AND v.version = e.version ${VISIBLE_ENTRIES}`)
    .iterate() as Iterable<{ id: number; threadId: number | null; title: string | null; body: string }>;
  for (const row of rows) {
    n++;
    const terms = counts(unlink(`${row.title ?? ''}\n${row.body}`));
    for (const t of terms.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    if (row.id === entryId || (entry.threadId !== null && row.threadId === entry.threadId)) continue;
    for (const t of terms.keys()) {
      if (own.has(t)) {
        sharing.push({ id: row.id, terms });
        break;
      }
    }
  }

  const { minDf, maxDf } = dfWindow(n);
  const idf = new Map<string, number>();
  const weightOf = (t: string): number => {
    let w = idf.get(t);
    if (w === undefined) {
      const d = df.get(t) ?? 0;
      w = d >= minDf && d <= maxDf ? idfOf(n, d) : 0;
      idf.set(t, w);
    }
    return w;
  };
  /** The entry's normalised weights for the terms it shares with this one, and nothing else. */
  const vector = (terms: Map<string, number>, keep: (t: string) => boolean): Map<string, number> => {
    let sum = 0;
    const v = new Map<string, number>();
    for (const [t, c] of terms) {
      const w = weightOf(t);
      if (!w) continue;
      const x = termWeight(c, w);
      sum += x * x;
      if (keep(t)) v.set(t, x);
    }
    const norm = Math.sqrt(sum);
    for (const [t, x] of v) v.set(t, x / norm);
    return v;
  };
  const mine = vector(own, () => true);
  if (!mine.size) return [];

  const scored: { id: number; score: number }[] = [];
  for (const { id, terms } of sharing) {
    const v = vector(terms, (t) => mine.has(t));
    let dot = 0;
    for (const [t, x] of v) dot += x * mine.get(t)!;
    if (dot >= MIN_SCORE) scored.push({ id, score: dot });
  }
  scored.sort((a, b) => b.score - a.score || a.id - b.id);

  return scored.slice(0, limit).map(({ id, score }) => {
    const e = store.visibleEntry(id)!;
    const prose = sentences(unlink(e.body.replace(/^#+\s.*$/gm, '')));
    const first = (prose.length ? prose : sentences(unlink(e.body)))[0] ?? e.body.trim();
    const quote = first.length > QUOTE_CHARS ? `${first.slice(0, QUOTE_CHARS - 1)}…` : first;
    return { entryId: e.id, date: day(e.createdAt), speaker: e.speaker, where: e.title ?? e.threadTitle, quote, why: null, score: Math.round(score * 1000) / 1000 };
  });
}
