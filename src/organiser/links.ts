// The link task. Cross links join an entry to the entries most like it in other threads; note links are the [[links]]
// you wrote, joined to the note they name. Both come from word statistics with every engine: a model adds nothing here.

import type { DatabaseSync } from 'node:sqlite';
import { direct, type Plan, type TaskContext } from './plan.ts';
import { linkTargets } from './record.ts';
import { replacedRuns } from './runs.ts';
import { cosine, tokenize } from './text.ts';

/** How many cross links an entry gets at most, and how alike two entries must be. */
const PER_ENTRY = 3;
const MIN_SIM = 0.35;
/** Entries with fewer words than this get no cross links: too short to say what they are about. */
const MIN_WORDS = 5;
/** Two entries this alike are copies, not related entries. */
const SAME = 0.999;

interface NewLink {
  from: number;
  to: number;
  kind: 'cross' | 'note';
  score: number;
}

export function planLinks(ctx: TaskContext): Plan {
  return direct(() => {
    // Links this run would hide don't count as already there.
    const live = liveKeys(ctx.db, replacedRuns(ctx.db, 'link', null, ctx.scope));
    const made = new Set<string>();
    const links: NewLink[] = [];
    const add = (l: NewLink) => {
      const key = linkKey(l);
      if (live.has(key) || made.has(key)) return;
      made.add(key);
      links.push(l);
    };
    for (const l of crossLinks(ctx)) add(l);
    let unresolved = 0;
    for (const e of ctx.entries) {
      for (const target of linkTargets(e.body)) {
        const note = ctx.record.resolveLink(target);
        if (!note) unresolved++;
        else if (note.id !== e.id) add({ from: e.id, to: note.id, kind: 'note', score: 1 });
      }
    }
    const cross = links.filter((l) => l.kind === 'cross').length;
    return {
      counts: { cross, note: links.length - cross, unresolved },
      message: `Links come from word statistics with every engine.${unresolved ? ` ${unresolved} [[link(s)]] name no note.` : ''}`,
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
  const out: NewLink[] = [];
  for (const e of ctx.entries) {
    const v = vectors.get(e.id);
    if (!v) continue;
    const unit = record.unitOf(e.id);
    const best: { id: number; sim: number }[] = [];
    for (const other of candidates) {
      if (other.id === e.id || record.unitOf(other.id) === unit) continue;
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

/** Cross links have no direction, so one key serves both ways round; note links keep theirs. */
function linkKey(l: { from: number; to: number; kind: string }): string {
  return l.kind === 'cross' ? `cross:${Math.min(l.from, l.to)}:${Math.max(l.from, l.to)}` : `note:${l.from}:${l.to}`;
}

function liveKeys(db: DatabaseSync, hidden: number[]): Set<string> {
  const rows = db
    .prepare(
      `SELECT from_entry AS "from", to_entry AS "to", kind FROM links
       WHERE run_id IN (SELECT id FROM live_runs) AND run_id NOT IN (${hidden.join(',') || 0})`,
    )
    .all() as { from: number; to: number; kind: string }[];
  return new Set(rows.map(linkKey));
}
