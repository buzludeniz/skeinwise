// The grouping step of `run all` timed on an invented record held in memory: no import, no database, no model.
// `file`, `hubs` and `tag` all start from groupUnits (src/organiser/groups.ts), and at 50,000 entries it once ran for
// most of an hour. CPU only, so it needs no heavy-job turn.
//
//   node bench/grouping.ts                  # 50,000 entries
//   node bench/grouping.ts 3000 --seed 7    # another size or record
//   node bench/grouping.ts --bound 60       # exits 1 when grouping takes longer than 60 s
//
// It prints one JSON line: the seconds each step took, the groups made, and a fingerprint of them, so two versions of
// the code can be checked against each other on the same record.

import { createHash } from 'node:crypto';
import { loadavg } from 'node:os';
import { parseArgs } from 'node:util';
import { planFolders } from '../src/organiser/folders.ts';
import { type Grouping, groupUnits } from '../src/organiser/groups.ts';
import { RecordView } from '../src/organiser/record.ts';
import { mulberry32 } from '../src/random.ts';
import type { Entry, Store } from '../src/store/store.ts';

const SYLLABLES = 'ka lo mi ne ru sa ti vo ze ba do fi gu he ja ku le mo nu pi ri so tu va wi yo'.split(' ');

/**
 * About n invented entries in the shape of the bench's corpus (bench/corpus.ts), which is where `run all` hung: 60%
 * chat messages in conversations of about 24, 30% agent sessions of 40, and 10% notes, 18% of them daily notes, each
 * note linking three others. A text is one word in ten its topic (one of 40), the rest from 230 common words, or 150
 * developer words in a session; so most units share most terms, the hardest case for grouping. The words are made up.
 * The same n and seed give the same entries.
 */
export function inventedEntries(n: number, seed = 42): Entry[] {
  const rand = mulberry32(seed);
  const int = (k: number) => Math.floor(rand() * k);
  const pick = <T>(list: readonly T[]): T => list[int(list.length)]!;
  const words = (count: number) => [...new Set(Array.from({ length: count * 2 }, () => Array.from({ length: 2 + int(3) }, () => pick(SYLLABLES)).join('')))].slice(0, count);
  const [topics, common, dev] = [words(40), words(230), words(150)];
  const text = (topic: string, chars: number, list = common) => {
    let out = '';
    while (out.length < chars) out += Array.from({ length: 8 + int(14) }, () => (rand() < 0.1 ? topic : pick(list))).join(' ') + '. ';
    return out.trim();
  };

  const plan = { notes: Math.round(n * 0.1), sessions: Math.round(n * 0.3) };
  const chats = n - plan.notes - plan.sessions;
  const entries: Entry[] = [];
  const at = (i: number) => new Date(Date.UTC(2023, 0, 1) + i * 600_000).toISOString();
  const add = (e: Pick<Entry, 'sourceKind' | 'threadId' | 'threadTitle' | 'externalId' | 'kind' | 'speaker' | 'title' | 'seq' | 'body'>) =>
    entries.push({ ...e, id: entries.length + 1, sourceId: ['chatgpt', 'claude-code', 'note'].indexOf(e.sourceKind) + 1, sourceLabel: e.sourceKind, version: 1, createdAt: at(entries.length) });

  let threadId = 0;
  for (let left = chats; left > 0; ) {
    const topic = pick(topics);
    const length = Math.min(left, Math.max(2, Math.round(24 * (0.3 + rand() * 1.4))));
    left -= length;
    const id = ++threadId;
    for (let seq = 0; seq < length; seq++) {
      const user = seq % 2 === 0;
      add({ sourceKind: 'chatgpt', threadId: id, threadTitle: `${topic} ${pick(common)}`, externalId: `c${id}/${seq}`, kind: 'message', speaker: user ? 'user' : 'assistant', title: null, seq, body: text(topic, user ? 80 + int(400) : 600 + int(2400)) });
    }
  }
  for (let left = plan.sessions; left > 0; ) {
    const topic = pick(topics);
    const length = Math.min(left, 40);
    left -= length;
    const id = ++threadId;
    for (let seq = 0; seq < length; seq++) {
      add({ sourceKind: 'claude-code', threadId: id, threadTitle: `proj${id % 20}`, externalId: `s${id}/${seq}`, kind: 'message', speaker: seq % 2 ? 'assistant' : 'user', title: null, seq, body: text(topic, 300 + int(900), dev) });
    }
  }
  const daily = Math.round(plan.notes * 0.18);
  const names = Array.from({ length: plan.notes }, (_, i) => (i < daily ? new Date(Date.UTC(2022, 0, 1) + i * 86_400_000).toISOString().slice(0, 10) : `${pick(topics)} ${pick(common)} ${i}`));
  names.forEach((name, i) => {
    const topic = pick(topics);
    const links = `Related: [[${pick(names)}]], [[${pick(names)}|see this]] and [[${pick(names)}#Heading]].`;
    add({ sourceKind: 'note', threadId: null, threadTitle: null, externalId: i < daily ? `daily/${name}.md` : `notes/${name}.md`, kind: 'note', speaker: 'you', title: name, seq: 0, body: `${text(topic, i < daily ? 100 + int(600) : 200 + int(800))}\n\n${links}` });
  });
  return entries;
}

/** A record over these entries, as the organiser reads one, with no store behind it. */
export function inventedRecord(entries: Entry[]): RecordView {
  return new RecordView({ allEntries: () => entries } as unknown as Store);
}

/** Which units each group holds, as a short hash: equal for equal groupings. */
export function fingerprint(grouping: Grouping): string {
  const lines = [...grouping.groups.map((g) => g.units.map((u) => u.pos).join(',')), `loose ${grouping.loose.map((u) => u.pos).join(',')}`];
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
}

export interface GroupingTimes {
  entries: number;
  units: number;
  /** Seconds to build the unit term index (the first use of the record). */
  index: number;
  /** Seconds for groupUnits over everything, as `run all` does. */
  group: number;
  /** Seconds for planFolders and its No-AI names, which groups again. */
  folders: number;
  groups: number;
  loose: number;
  fingerprint: string;
}

export function timeGrouping(n: number, seed = 42): GroupingTimes {
  const entries = inventedEntries(n, seed);
  const record = inventedRecord(entries);
  const secs = (from: number) => Math.round((performance.now() - from) / 10) / 100;
  let t = performance.now();
  void record.unitIndex;
  const index = secs(t);
  t = performance.now();
  const grouping = groupUnits(record, entries);
  const group = secs(t);
  t = performance.now();
  const plan = planFolders({ db: undefined as never, record, scope: { kind: 'all' }, entries, model: false, engine: 'none', modelName: null, now: new Date().toISOString() });
  plan.fallback(0);
  const folders = secs(t);
  return { entries: entries.length, units: record.units.length, index, group, folders, groups: grouping.groups.length, loose: grouping.loose.length, fingerprint: fingerprint(grouping) };
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { seed: { type: 'string' }, bound: { type: 'string' } } });
  const n = Number(positionals[0] ?? 50_000);
  const times = timeGrouping(n, values.seed ? Number(values.seed) : 42);
  console.log(JSON.stringify({ ...times, load: loadavg().map((l) => Math.round(l * 10) / 10) }));
  if (values.bound && times.group > Number(values.bound)) {
    console.error(`Grouping took ${times.group} s, over the bound of ${values.bound} s.`);
    process.exitCode = 1;
  }
}
