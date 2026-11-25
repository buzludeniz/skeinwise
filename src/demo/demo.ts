// Writes the demo record as real export files (ChatGPT, Claude, Claude Code, Markdown notes), so the demo goes
// through the same importers as a person's own data. Everything is invented and seeded: the same seed gives the
// same files.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type DemoTopic, TOPICS } from './content.ts';
import { mulberry32 } from '../random.ts';

/** The demo's "today": nothing in the record is dated after it. */
export const DEMO_NOW = '2026-11-20T18:00:00.000Z';

export { mulberry32 };

interface Msg {
  you: boolean;
  text: string;
  at: Date;
}

interface DemoThread {
  topic: string;
  source: 'chatgpt' | 'claude' | 'claude-code';
  id: string;
  title: string;
  started: Date;
  messages: Msg[];
}

export interface DemoSummary {
  dir: string;
  threads: number;
  messages: number;
  notes: number;
  files: string[];
}

function months(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number) as [number, number];
  const [ty, tm] = to.split('-').map(Number) as [number, number];
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

class Rng {
  readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.next() * list.length)]!;
  }
  /** A stable, UUID-shaped id. */
  uuid(): string {
    const hex = Array.from({ length: 32 }, () => Math.floor(this.next() * 16).toString(16)).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
  }
}

const NOW_MS = Date.parse(DEMO_NOW);

/** A moment in a month: a day, a waking hour, never after the demo's today. */
function momentIn(rng: Rng, month: string): Date {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const at = new Date(Date.UTC(y, m - 1, rng.int(1, days), rng.int(7, 22), rng.int(0, 59), rng.int(0, 59)));
  return at.getTime() > NOW_MS ? new Date(NOW_MS - rng.int(1, 20) * 86400000) : at;
}

/** Picks a month with a peak in the middle of the window, so each topic rises and falls like a tide. */
function tideMonth(rng: Rng, window: string[]): string {
  const x = (rng.next() + rng.next() + rng.next()) / 3;
  return window[Math.min(window.length - 1, Math.floor(x * window.length))]!;
}

function conversation(rng: Rng, topic: DemoTopic, start: Date, opener?: string): Msg[] {
  const msgs: Msg[] = [];
  let t = start.getTime();
  const turns = opener ? 1 : rng.int(1, 3);
  const used = new Set<string>();
  const fresh = (pool: string[]) => {
    let line = rng.pick(pool);
    for (let tries = 0; used.has(line) && tries < 8; tries++) line = rng.pick(pool);
    used.add(line);
    return line;
  };
  for (let i = 0; i < turns; i++) {
    const you = opener && i === 0 ? opener : fresh(topic.you);
    msgs.push({ you: true, text: you, at: new Date(t) });
    t += rng.int(20, 90) * 1000;
    msgs.push({ you: false, text: fresh(topic.assistant), at: new Date(t) });
    t += rng.int(2, 9) * 60000;
  }
  return msgs;
}

/** "Decided with Mara: four days, coast to coast…" becomes "Four days, coast to coast…". */
function decisionTitle(text: string): string {
  const core = text.replace(/^(Decided|Decided with [^:]+|We finished the ride|Changing my mind on [^:]+):\s*/, '');
  const first = core.split(/(?<=\.)\s/)[0]!.replace(/\.$/, '');
  const title = first.charAt(0).toUpperCase() + first.slice(1);
  return title.length > 60 ? `${title.slice(0, 59).trimEnd()}…` : title;
}

export function buildThreads(seed = 7): DemoThread[] {
  const rng = new Rng(seed);
  const threads: DemoThread[] = [];
  for (const topic of TOPICS) {
    const window = months(topic.window[0], topic.window[1]);
    for (let i = 0; i < topic.threads; i++) {
      const started = momentIn(rng, tideMonth(rng, window));
      threads.push({
        topic: topic.key,
        source: rng.pick(topic.sources),
        id: rng.uuid(),
        title: rng.pick(topic.titles),
        started,
        messages: conversation(rng, topic, started),
      });
    }
    for (const d of topic.decisions) {
      const started = momentIn(rng, d.month);
      threads.push({
        topic: topic.key,
        source: topic.sources.includes('claude') ? 'claude' : topic.sources[0]!,
        id: rng.uuid(),
        title: decisionTitle(d.text),
        started,
        messages: conversation(rng, topic, started, d.text),
      });
    }
  }
  return threads.sort((a, b) => a.started.getTime() - b.started.getTime());
}

const secs = (d: Date) => d.getTime() / 1000;

function chatgptExport(threads: DemoThread[]): unknown[] {
  return threads.map((th) => {
    const mapping: Record<string, unknown> = {};
    const rootId = `${th.id}-root`;
    mapping[rootId] = { id: rootId, message: null, parent: null, children: [] as string[] };
    let parent = rootId;
    th.messages.forEach((m, i) => {
      const id = `${th.id}-${i}`;
      (mapping[parent] as { children: string[] }).children.push(id);
      mapping[id] = {
        id,
        parent,
        children: [] as string[],
        message: {
          id,
          author: { role: m.you ? 'user' : 'assistant' },
          create_time: secs(m.at),
          content: { content_type: 'text', parts: [m.text] },
          metadata: {},
        },
      };
      parent = id;
    });
    return {
      title: th.title,
      create_time: secs(th.started),
      update_time: secs(th.messages.at(-1)!.at),
      conversation_id: th.id,
      current_node: parent,
      mapping,
    };
  });
}

function claudeExport(threads: DemoThread[]): unknown[] {
  return threads.map((th) => ({
    uuid: th.id,
    name: th.title,
    created_at: th.started.toISOString(),
    updated_at: th.messages.at(-1)!.at.toISOString(),
    chat_messages: th.messages.map((m, i) => ({
      uuid: `${th.id}-${i}`,
      sender: m.you ? 'human' : 'assistant',
      text: m.text,
      content: [{ type: 'text', text: m.text }],
      created_at: m.at.toISOString(),
    })),
  }));
}

function claudeCodeSession(th: DemoThread): string {
  const lines = th.messages.map((m, i) =>
    JSON.stringify({
      type: m.you ? 'user' : 'assistant',
      sessionId: th.id,
      uuid: `${th.id}-${i}`,
      parentUuid: i ? `${th.id}-${i - 1}` : null,
      timestamp: m.at.toISOString(),
      cwd: '/home/demo/code/plotline',
      message: m.you ? { role: 'user', content: m.text } : { role: 'assistant', content: [{ type: 'text', text: m.text }] },
    }),
  );
  return [JSON.stringify({ type: 'summary', summary: th.title }), ...lines].join('\n') + '\n';
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

const DAILY_LINES = [
  (t: string) => `Morning block on [[${t}]].`,
  (t: string) => `Picked [[${t}]] back up after a few days away.`,
  (t: string) => `Wrote down the next step for [[${t}]] before stopping.`,
  (t: string) => `Short session on [[${t}]]; more questions than answers.`,
];

/** Writes the demo exports into `dir`. Returns what was written. */
export function writeDemo(dir: string, seed = 7): DemoSummary {
  const rng = new Rng(seed + 1);
  const threads = buildThreads(seed);
  const files: string[] = [];
  const write = (rel: string, text: string) => {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, text);
    files.push(rel);
  };

  write('chatgpt/conversations.json', JSON.stringify(chatgptExport(threads.filter((t) => t.source === 'chatgpt')), null, 1));
  write('claude/conversations.json', JSON.stringify(claudeExport(threads.filter((t) => t.source === 'claude')), null, 1));
  for (const th of threads.filter((t) => t.source === 'claude-code')) {
    write(`claude-code/projects/-home-demo-code-plotline/${th.id}.jsonl`, claudeCodeSession(th));
  }

  let notes = 0;
  for (const topic of TOPICS) {
    const window = months(topic.window[0], topic.window[1]);
    topic.notes.forEach((note, i) => {
      const created = momentIn(rng, window[Math.min(i, window.length - 1)]!).toISOString().slice(0, 10);
      const front = ['---', `title: ${note.title}`, `created: ${created}`, `tags: [${note.tags.join(', ')}]`, '---', ''];
      write(`notes/${slug(note.title)}.md`, `${front.join('\n')}# ${note.title}\n\n${note.body}\n`);
      notes += 1;
    });
  }

  // Daily notes on days with chats, pointing at that topic's first note.
  const days = new Map<string, DemoThread>();
  for (const th of threads) if (rng.next() < 0.25) days.set(th.started.toISOString().slice(0, 10), th);
  for (const [day, th] of days) {
    const topic = TOPICS.find((t) => t.key === th.topic)!;
    const line = rng.pick(DAILY_LINES)(topic.notes[0]!.title);
    write(`notes/daily/${day}.md`, `# ${day}\n\n${line}\n`);
    notes += 1;
  }

  return {
    dir,
    threads: threads.length,
    messages: threads.reduce((n, t) => n + t.messages.length, 0),
    notes,
    files,
  };
}
