// The link task. Cross links join an entry to the entries most like it in other threads, from word statistics with
// every engine: a model adds nothing here. The [[links]] you wrote are not the run's: they are read from your text as
// it stands (views.ts writtenLinks), so undo leaves them (LS-14). The run counts the ones that name no note.

import type { DatabaseSync } from 'node:sqlite';
import { direct, type Plan, type TaskContext } from './plan.ts';
import { linkTargets } from './record.ts';
import { replacedRuns } from './runs.ts';
import { cosine, Postings, tokenize } from './text.ts';

/** How many cross links an entry gets at most, and how alike two entries must be. */
const PER_ENTRY = 3;
const MIN_SIM = 0.35;
/** Entries with fewer words than this get no cross links: too short to say what they are about. */
const MIN_WORDS = 5;
/** Two entries this alike are copies, not related entries. */
const SAME = 0.999;
/** Far more than the index's sums can differ from cosine's, far less than any difference that matters. */
const EPS = 1e-9;

interface NewLink {
  from: number;
  to: number;
  kind: 'cross';
  score: number;
}

export function planLinks(ctx: TaskContext): Plan {
  return direct(() => {
    // Links this run would hide don't count as already there.
    const live = liveKeys(ctx.db, replacedRuns(ctx.db, 'link', null, ctx.scope));
    const links: NewLink[] = [];
    for (const l of crossLinks(ctx)) {
      const key = linkKey(l);
      if (live.has(key)) continue;
      live.add(key);
      links.push(l);
    }
    let yours = 0;
    let unresolved = 0;
    for (const e of ctx.entries) {
      for (const target of linkTargets(e.body)) {
        const note = ctx.record.resolveLink(target);
        if (!note) unresolved++;
        else if (note.id !== e.id) yours++;
      }
    }
    const written = yours
      ? ` The ${yours} [[link${yours > 1 ? 's' : ''}]] you wrote ${yours > 1 ? 'are' : 'is'} read from your notes as they stand, not made by this run, so undo leaves ${yours > 1 ? 'them' : 'it'}.`
      : '';
    return {
      counts: { cross: links.length, unresolved },
      message: `Links come from word statistics with every engine.${written}${unresolved ? ` ${unresolved} [[link${unresolved > 1 ? 's' : ''}]] name${unresolved > 1 ? '' : 's'} no note.` : ''}`,
      save: (db, runId) => {
        const insert = db.prepare('INSERT INTO links (from_entry, to_entry, kind, score, run_id) VALUES (?, ?, ?, ?, ?)');
        for (const l of links) insert.run(l.from, l.to, l.kind, l.score, runId);
      },
    };
  });
}

function crossLinks(ctx: TaskContext): NewLink[] {
  const { record } = ctx;
  const candidates = record.entries.filter((e) => tokenize(e.body).length >= MIN_WORDS);
  const vectors = new Map(candidates.map((e) => [e.id, record.entryVector(e.id)]));
  // Comparing every pair took most of an hour at 50,000 entries. Only entries that share terms can reach MIN_SIM, and
  // the index finds those with its own sums, within EPS of cosine. Cosine scores only the ones that can still make an
  // entry's top PER_ENTRY, so the links are exactly the ones comparing every pair gives.
  const postings = new Postings(candidates.map((e) => vectors.get(e.id)!));
  const out: NewLink[] = [];
  for (const e of ctx.entries) {
    const v = vectors.get(e.id);
    if (!v) continue;
    const unit = record.unitOf(e.id);
    const close = postings.near(v, MIN_SIM - EPS).filter(({ i }) => candidates[i]!.id !== e.id && record.unitOf(candidates[i]!.id) !== unit);
    // PER_ENTRY entries clear of both limits make the cut, so nothing more than EPS below the last of them can.
    const floor = kthLargest(close.flatMap((c) => (c.dot >= MIN_SIM + EPS && c.dot < SAME - EPS ? [c.dot] : [])), PER_ENTRY) - EPS;
    const best: { id: number; sim: number }[] = [];
    for (const c of close) {
      if (c.dot < floor) continue;
      const other = candidates[c.i]!;
      const sim = cosine(v, vectors.get(other.id)!);
      if (sim < MIN_SIM || sim >= SAME) continue;
      best.push({ id: other.id, sim });
    }
    best.sort((a, b) => b.sim - a.sim || a.id - b.id);
    for (const b of best.slice(0, PER_ENTRY)) {
      out.push({ from: Math.min(e.id, b.id), to: Math.max(e.id, b.id), kind: 'cross', score: Math.round(b.sim * 1000) / 1000 });
    }
  }
  return out;
}

/** The k-th largest value, or -Infinity when there are fewer than k. */
function kthLargest(values: number[], k: number): number {
  const top: number[] = [];
  for (const x of values) {
    if (top.length === k && x <= top[k - 1]!) continue;
    let at = top.findIndex((y) => x > y);
    if (at < 0) at = top.length;
    top.splice(at, 0, x);
    if (top.length > k) top.pop();
  }
  return top.length === k ? top[k - 1]! : -Infinity;
}

/** Cross links have no direction, so one key serves both ways round. */
function linkKey(l: { from: number; to: number }): string {
  return `${Math.min(l.from, l.to)}:${Math.max(l.from, l.to)}`;
}

function liveKeys(db: DatabaseSync, hidden: number[]): Set<string> {
  const rows = db
    .prepare(
      `SELECT from_entry AS "from", to_entry AS "to" FROM links
       WHERE kind = 'cross' AND run_id IN (SELECT id FROM live_runs) AND run_id NOT IN (${hidden.join(',') || 0})`,
    )
    .all() as { from: number; to: number }[];
  return new Set(rows.map(linkKey));
}
