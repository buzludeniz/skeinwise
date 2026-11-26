// The review task: notes of yours that newer entries may have overtaken. A note is checked against your entries dated
// a day or more after it last changed that sit in one of its hubs or name it, leaving out any that claims a date after
// the run (`vouched`, H1: a planted export dates itself ahead to pass as your latest word). A model reads them and says
// whether the note is out of date, why, and how it would read updated. The No-AI engine flags a note when such an entry
// turns from it ("changing my mind", "no longer", "instead", "switch to", "move to") near the note, or says "decided"
// about the note by name and adds something the note doesn't say; it proposes the note with those sentences added
// under "Updates". Either way, at most 3 notes per hub go to the queue, the clearest first (LS-14: it flagged 12 of
// the demo's 12 notes).

import { UsageError } from '../errors.ts';
import type { Entry, Store } from '../store/store.ts';
import { CHANGE_CUES, TURN_CUES } from './cues.ts';
import { day, invalid, isRecord, list, type ModelRequest, type Plan, type TaskContext, text } from './plan.ts';
import { entryText, isDailyNote, type RecordView, unlink, vouched } from './record.ts';
import { cosine, sentences, tokenize, vectorize } from './text.ts';
import { heldEntries, hubEntryIds, liveHubs, type Reason } from './views.ts';

/** How many newer entries a model sees per note, and how much of each. */
const MODEL_ENTRIES = 8;
const ENTRY_CHARS = 600;
const NOTE_CHARS = 4000;
/** How close a cue sentence must be to the note, when it doesn't name the note. */
const MIN_RELEVANCE = 0.1;
/** An entry written within a day of the note's last change is the same sitting, not news that overtakes it. */
const MIN_GAP_MS = 24 * 60 * 60 * 1000;
/** The share of a "decided" sentence's words the note must not already hold, for it to be news about the note. */
const MIN_NEW_WORDS = 0.5;
/** The most notes per hub that go to the queue in one run. */
const MAX_PER_HUB = 3;

export interface Check {
  note: Entry;
  since: string;
  newer: Entry[];
  /** The live hubs the note is in. */
  hubs: number[];
}

interface Flag {
  note: Entry;
  hubs: number[];
  reasons: Reason[];
  proposed: string;
  /** Which flags go first when a hub has more than MAX_PER_HUB. */
  rank: number;
}

/** `checks` is for tests that weigh another way of finding them. */
export function planReview(ctx: TaskContext, checks: Check[] = reviewChecks(ctx)): Plan {
  const asks = ctx.model ? checks.filter((c) => c.newer.length).map((c, i, all) => ({ check: c, ...reviewRequest(ctx.record, c, i + 1, all.length) })) : [];
  return {
    requests: asks.map((a) => a.request),
    // A note without the model's answer gets the No-AI check.
    fallback: () => null,
    finish: (answers) => {
      const found: Flag[] = ctx.model
        ? asks.flatMap((a, i) => {
            const answer = answers[i] as ReviewAnswer | null;
            if (!answer) return cueFlag(ctx.record, a.check);
            if (!answer.stale) return [];
            const reasons = answer.reasons.map((r) => reasonFor(ctx.record, a.check, a.shown[r.index]!, r.why));
            return [{ note: a.check.note, hubs: a.check.hubs, reasons, proposed: answer.proposed, rank: reasons.length }];
          })
        : checks.flatMap((c) => cueFlag(ctx.record, c));
      const flags = perHub(found);
      const capped = found.length - flags.length;
      return {
        counts: {
          notes: checks.length,
          flagged: flags.length,
          reasons: flags.reduce((n, f) => n + f.reasons.length, 0),
          ...(capped ? { capped } : {}),
        },
        ...(capped
          ? { message: `${capped} more note${capped > 1 ? 's' : ''} may be out of date; review keeps ${MAX_PER_HUB} per hub, the clearest first.` }
          : {}),
        save: (db, runId) => {
          const insert = db.prepare('INSERT INTO review_items (note_entry, reasons, proposed, run_id) VALUES (?, ?, ?, ?)');
          for (const f of flags) insert.run(f.note.id, JSON.stringify(f.reasons), f.proposed, runId);
        },
      };
    },
  };
}

/** Your notes in live hubs (in scope, or in a hub that an entry in scope touches), with the newer entries to weigh. */
export function reviewChecks(ctx: TaskContext): Check[] {
  const { record, db } = ctx;
  const hubs = liveHubs(db);
  if (!hubs.length) throw new UsageError('Review reads hubs, and there are none yet. Run the hub task first: skeinwise run hub');
  const hubsOf = new Map<number, number[]>();
  for (const h of hubs) for (const id of hubEntryIds(db, h.id)) hubsOf.set(id, [...(hubsOf.get(id) ?? []), h.id]);
  const scoped = new Set(ctx.entries.map((e) => e.id));
  const touched = new Set(ctx.entries.flatMap((e) => hubsOf.get(e.id) ?? []));
  const notes = record.entries.filter(
    (e) =>
      e.kind === 'note' &&
      e.speaker === 'you' &&
      !isDailyNote(e) &&
      hubsOf.has(e.id) &&
      (ctx.scope.kind === 'all' || scoped.has(e.id) || hubsOf.get(e.id)!.some((h) => touched.has(h))),
  );
  // Each entry's time and body are read once, not once for every note: that took tens of minutes at 50,000 entries.
  // Only the stems of note titles are kept from the bodies.
  const yours = record.entries.flatMap((e) => (e.speaker === 'you' && vouched(e, ctx.now) ? [{ e, at: Date.parse(e.createdAt) }] : []));
  const names = new Map(notes.map((n) => [n.id, titleStems(n)]));
  const holding = bodiesHolding(yours.map((y) => y.e), new Set([...names.values()].flat()));
  // A note weighs only your entries that share one of its hubs or hold every stem of its title, from `after` on. So
  // they are listed by hub and by stem, each list in time order, and a note visits its own lists from `after`, not all
  // your entries: 5,000 notes × 28,000 entries took 33 s of a run all at 50,000.
  const byTime = (list: number[]) => list.sort((a, b) => yours[a]!.at - yours[b]!.at);
  const inHub = new Map<number, number[]>();
  yours.forEach(({ e }, i) => {
    for (const h of hubsOf.get(e.id) ?? []) {
      const list = inHub.get(h);
      if (list) list.push(i);
      else inHub.set(h, [i]);
    }
  });
  for (const list of inHub.values()) byTime(list);
  for (const held of holding.values()) byTime(held.list);
  /** The first place in a time-ordered list dated `after` or later (none when `after` doesn't parse). */
  const from = (list: number[], after: number) => {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (yours[list[mid]!]!.at >= after) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };
  return notes.map((note) => {
    const since = lastChanged(record.store, note);
    const held = heldEntries(db, note.id);
    const own = new Set(hubsOf.get(note.id));
    const name = names.get(note.id)!;
    const after = Date.parse(since) + MIN_GAP_MS;
    const found = new Set<number>();
    for (const h of own) {
      const list = inHub.get(h) ?? [];
      for (let k = from(list, after); k < list.length; k++) found.add(list[k]!);
    }
    const stems = name.map((s) => holding.get(s));
    if (stems.length > 0 && stems.every((s) => s !== undefined)) {
      // Every stem must be held, so the stem fewest entries hold names the candidates.
      const rarest = stems.reduce((a, b) => (b.list.length < a.list.length ? b : a));
      for (let k = from(rarest.list, after); k < rarest.list.length; k++) {
        const i = rarest.list[k]!;
        if (stems.every((s) => s.has.has(i))) found.add(i);
      }
    }
    // In record order, as the scan over all your entries gave them.
    const newer = [...found]
      .sort((a, b) => a - b)
      .flatMap((i) => {
        const { e } = yours[i]!;
        return e.id !== note.id && !held.has(e.id) ? [e] : [];
      });
    return { note, since, newer, hubs: [...own] };
  });
}

/** The flags that go to the queue: at most MAX_PER_HUB in any hub, the highest ranked first, kept in note order. */
function perHub(flags: Flag[]): Flag[] {
  const taken = new Map<number, number>();
  const kept = new Set<Flag>();
  for (const f of [...flags].sort((a, b) => b.rank - a.rank)) {
    if (f.hubs.some((h) => (taken.get(h) ?? 0) >= MAX_PER_HUB)) continue;
    for (const h of f.hubs) taken.set(h, (taken.get(h) ?? 0) + 1);
    kept.add(f);
  }
  return flags.filter((f) => kept.has(f));
}

/** The share of a sentence's words that the note doesn't hold. */
function newShare(words: string[], noteWords: Set<string>): number {
  const set = new Set(words);
  if (!set.size) return 0;
  let fresh = 0;
  for (const w of set) if (!noteWords.has(w)) fresh++;
  return fresh / set.size;
}

/** When the note last changed: its newest version's date, or the date it was written if it never changed. */
function lastChanged(store: Store, note: Entry): string {
  if (note.version <= 1) return note.createdAt;
  return store.history(note.id).at(-1)!.editedAt;
}

function titleStems(note: Entry): string[] {
  return [...new Set(tokenize(note.title ?? ''))];
}

/** For each of these stems, the entries whose body holds it, by their place in `entries`: as a list and as a set. */
function bodiesHolding(entries: Entry[], stems: Set<string>): Map<string, { list: number[]; has: Set<number> }> {
  const out = new Map<string, { list: number[]; has: Set<number> }>();
  if (!stems.size) return out;
  entries.forEach((e, i) => {
    for (const s of tokenize(e.body)) {
      if (!stems.has(s)) continue;
      const held = out.get(s);
      if (!held) out.set(s, { list: [i], has: new Set([i]) });
      else if (!held.has.has(i)) {
        held.list.push(i);
        held.has.add(i);
      }
    }
  });
  return out;
}

/**
 * The No-AI flag. A sentence that turns from something counts when it names the note or is close to it. A decision
 * alone may only confirm the note ("Decided: two loaves only" under a note that says so), so it counts when it names
 * the note and at least half of its words are new to it.
 */
function cueFlag(record: RecordView, check: Check): Flag[] {
  const noteVector = record.entryVector(check.note.id);
  const name = titleStems(check.note);
  const noteWords = new Set(tokenize(entryText(check.note)));
  const reasons: Reason[] = [];
  const quoted = new Set<string>();
  let rank = 0;
  for (const e of check.newer) {
    const hit = sentences(unlink(e.body))
      .filter((s) => CHANGE_CUES.test(s))
      .map((s) => {
        const words = tokenize(s);
        const named = name.length > 0 && name.every((n) => words.includes(n));
        return { s, words, named, turn: TURN_CUES.test(s), sim: cosine(vectorize(record.entryIndex, s), noteVector) };
      })
      .filter((x) => (x.turn ? x.named || x.sim > MIN_RELEVANCE : x.named && newShare(x.words, noteWords) >= MIN_NEW_WORDS))
      .map((x) => ({ ...x, score: (x.turn ? 2 : 0) + (x.named ? 1 : 0) + x.sim }))
      .sort((a, b) => b.score - a.score)[0];
    // The same sentence written again (a template, a pasted line) is one reason, at its first date.
    if (!hit || quoted.has(hit.s.toLowerCase())) continue;
    quoted.add(hit.s.toLowerCase());
    rank = Math.max(rank, hit.score);
    const cue = (hit.turn ? TURN_CUES : CHANGE_CUES).exec(hit.s)![0];
    reasons.push({
      entryId: e.id,
      date: day(e.createdAt),
      quote: hit.s,
      why: `Says "${cue.toLowerCase()}" after the note last changed (${day(check.since)}).`,
    });
  }
  if (!reasons.length) return [];
  return [{ note: check.note, hubs: check.hubs, reasons, proposed: withUpdates(check.note.body, reasons), rank }];
}

/** The note with dated lines under an "Updates" heading, added to the one already there if it is last. */
export function withUpdates(body: string, reasons: Reason[]): string {
  const lines = reasons.map((r) => `- ${r.date}: ${r.quote} (entry #${r.entryId})`).join('\n');
  const trimmed = body.trimEnd();
  const last = trimmed.lastIndexOf('\n## ');
  const hasSection = /(^|\n)## Updates\s*(\n|$)/.test(trimmed.slice(last < 0 ? 0 : last));
  return hasSection ? `${trimmed}\n${lines}\n` : `${trimmed}\n\n## Updates\n\n${lines}\n`;
}

/** The sentence of an entry that best shows why it matters to the note. */
function reasonFor(record: RecordView, check: Check, e: Entry, why: string): Reason {
  const noteVector = record.entryVector(check.note.id);
  const list = sentences(unlink(e.body));
  const best = list
    .map((s) => ({ s, score: cosine(vectorize(record.entryIndex, s), noteVector) + (CHANGE_CUES.test(s) ? 1 : 0) }))
    .sort((a, b) => b.score - a.score)[0];
  return { entryId: e.id, date: day(e.createdAt), quote: best?.s ?? e.body.slice(0, 200), why };
}

type ReviewAnswer = { stale: boolean; reasons: { index: number; why: string }[]; proposed: string };

function reviewRequest(record: RecordView, check: Check, n: number, of: number): { request: ModelRequest; shown: Entry[] } {
  const purpose = `review ${n} of ${of}`;
  const noteVector = record.entryVector(check.note.id);
  const shown = [...check.newer]
    .map((e) => ({ e, score: cosine(record.entryVector(e.id), noteVector) + (CHANGE_CUES.test(e.body) ? 1 : 0) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MODEL_ENTRIES)
    .map((x) => x.e)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
  const known = new Map(shown.map((e, i) => [`E${e.id}`, i]));
  const user = [
    `My note "${check.note.title ?? 'untitled'}", last changed ${day(check.since)}:`,
    '"""',
    check.note.body.slice(0, NOTE_CHARS),
    '"""',
    '',
    'Entries I wrote after that, oldest first:',
    ...shown.map((e) => `E${e.id} (${day(e.createdAt)}): ${e.body.replace(/\s+/g, ' ').slice(0, ENTRY_CHARS)}`),
    '',
    'Do any of these entries show that something in the note is no longer true or no longer my plan?',
    'Answer with JSON only: {"stale": true, "reasons": [{"entry": "E1", "why": "..."}], "proposed": "..."}',
    '- reasons: each entry that overtakes the note, with one sentence on what changed;',
    '- proposed: the whole note rewritten to match, in my words, changing only what the entries change.',
    'If nothing is out of date: {"stale": false, "reasons": [], "proposed": ""}.',
  ].join('\n');
  const check_ = (answer: unknown): ReviewAnswer => {
    if (!isRecord(answer)) invalid(purpose, 'expected a JSON object');
    if (typeof answer.stale !== 'boolean') invalid(purpose, '"stale" must be true or false');
    const items = list(purpose, answer.reasons, 'reasons');
    if (!answer.stale) return { stale: false, reasons: [], proposed: '' };
    if (!items.length) invalid(purpose, 'says the note is out of date but gives no reasons');
    const reasons = items.map((it) => {
      if (!isRecord(it)) invalid(purpose, 'each "reasons" item must be an object');
      const raw = String(it.entry ?? '').trim().toUpperCase();
      const index = known.get(/^\d+$/.test(raw) ? `E${raw}` : raw);
      if (index === undefined) invalid(purpose, `cites ${JSON.stringify(it.entry)}, which it wasn't shown`);
      return { index, why: text(purpose, it.why, 'why', 400) };
    });
    return { stale: true, reasons, proposed: text(purpose, answer.proposed, 'proposed', 20000, 'block') };
  };
  return {
    request: {
      purpose,
      system: "You keep one person's notes up to date from what they wrote later. You only use what they wrote. You answer with JSON only.",
      user,
      maxTokens: Math.ceil(Math.min(check.note.body.length, NOTE_CHARS) / 2) + 500,
      check: check_,
    },
    shown,
  };
}
