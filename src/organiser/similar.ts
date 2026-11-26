// `similar <entry>`: the entries in other threads that read most like one. It asks the record's full-text index (the
// one `search` uses) for the entry's own key words, any of them, and ranks what comes back by bm25: words rare in the
// record count for more, and a long entry doesn't win by length. The score is that rank as a share of the entry's
// own, so 1 reads like the entry itself. Nothing tokenizes the record per call, so it keeps to the 1 s budget at
// 50,000 entries (plan 7.2), where scoring every entry took about 4 s (82b86de kept the scores of the entry index;
// the full-text index is what makes the budget).

import { UsageError } from '../errors.ts';
import type { Store } from '../store/store.ts';
import type { AskHit } from './ask.ts';
import { day } from './plan.ts';
import { entryText, unlink } from './record.ts';
import { keyWords, sentences } from './text.ts';
import { VISIBLE_ENTRIES } from './views.ts';

/** How many of the entry's words go into the query. More finds more, and costs more on a large record. */
const QUERY_WORDS = 32;
const MIN_SCORE = 0.05;
const QUOTE_CHARS = 300;

export type SimilarHit = AskHit & { score: number };

export function similarEntries(store: Store, entryId: number, limit: number): SimilarHit[] {
  const entry = store.visibleEntry(entryId);
  if (!entry) throw new UsageError(`No entry ${entryId} in the record (or its source is excluded).`);
  const words = keyWords(entryText(entry), QUERY_WORDS);
  if (!words.length || limit < 1) return [];
  // Each word quoted: they are letters and digits only, so the quotes make them plain terms, never query syntax.
  const match = words.map((w) => `"${w}"`).join(' OR ');
  const self = store.db.prepare('SELECT bm25(entry_search) AS score FROM entry_search WHERE entry_search MATCH ? AND rowid = ?').get(match, entryId) as
    | { score: number }
    | undefined;
  // bm25 is negative, and lower is closer. The entry always matches its own words, unless its index row is missing.
  if (!self || !(self.score < 0)) return [];
  const rows = store.db
    .prepare(
      `SELECT e.id, bm25(entry_search) AS score FROM entry_search JOIN entries e ON e.id = entry_search.rowid ${VISIBLE_ENTRIES}
         AND entry_search MATCH ? AND e.id <> ? AND (? IS NULL OR e.thread_id IS NOT ?)
       ORDER BY score, e.id LIMIT ?`,
    )
    .all(match, entryId, entry.threadId, entry.threadId, limit) as { id: number; score: number }[];

  const hits: SimilarHit[] = [];
  for (const { id, score } of rows) {
    const share = Math.min(1, score / self.score);
    if (share < MIN_SCORE) break;
    const e = store.visibleEntry(id)!;
    const prose = sentences(unlink(e.body.replace(/^#+\s.*$/gm, '')));
    const first = (prose.length ? prose : sentences(unlink(e.body)))[0] ?? e.body.trim();
    const quote = first.length > QUOTE_CHARS ? `${first.slice(0, QUOTE_CHARS - 1)}…` : first;
    hits.push({ entryId: e.id, date: day(e.createdAt), speaker: e.speaker, where: e.title ?? e.threadTitle, quote, why: null, score: Math.round(share * 1000) / 1000 });
  }
  return hits;
}
