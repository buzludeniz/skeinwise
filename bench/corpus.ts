// Seeded synthetic corpora for `pnpm bench`, from the generators the judges used on the beta: a heavy user's ChatGPT
// export, an Obsidian-style vault with links, aliases and callouts, and Claude Code sessions. Invented text only. The
// same size and seed give the same files.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mulberry32 } from '../src/random.ts';

const TOPICS = [
  'postgres', 'kubernetes', 'sourdough', 'marathon', 'rust', 'typescript', 'gardening', 'mortgage', 'pension', 'thesis',
  'violin', 'photography', 'climbing', 'espresso', 'sqlite', 'embedding', 'llama', 'zettelkasten', 'budget', 'italy',
  'japanese', 'chess', 'woodwork', 'beekeeping', 'cycling', 'react', 'graphql', 'kafka', 'terraform', 'tax', 'therapy',
  'reading', 'novel', 'podcast', 'startup', 'hiring', 'pricing', 'design', 'kayak', 'guitar',
];

const WORDS = (
  'the of and to in that it with as for on was is be at by this had not are but from or have an they which one you ' +
  'were all there would their we been has when who will more no if out so said what up its about into than them can ' +
  'only other new some could time these two may then do first any my now such like our over even most made after also ' +
  'did many before must through back years where much your way well down should because each just those people how ' +
  'too little state good very make world still own see work long get here between both life being under never day ' +
  'same another know while last might great old year off come since against go came right used take three decided ' +
  'switch plan idea question tradeoff latency index migration schema query cache deploy'
).split(' ');

const DEV_WORDS = (
  'migration postgres sqlite index cache redis queue worker deploy rollback schema column backfill retry timeout ' +
  'webhook invoice refund token auth session cookie csrf cors header proxy docker compose bucket upload thumbnail ' +
  'resize transcode chapter epub pdf render markdown parser lexer visitor plugin hook config env cron scheduler ' +
  'backoff jitter mutex lock deadlock transaction isolation replica failover benchmark profile flamegraph allocation ' +
  'leak heap pointer struct trait generic closure async await promise stream buffer chunk encoder decoder unicode ' +
  'regex glob path symlink watcher debounce throttle signal store reducer effect hydration loader route bundle lazy ' +
  'type infer narrow union tuple enum schema validate error boundary trace span metric alert incident'
).split(' ');

class Gen {
  readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  pick<T>(list: readonly T[]): T {
    return list[this.int(list.length)]!;
  }
  uuid(): string {
    const hex = Array.from({ length: 32 }, () => this.int(16).toString(16)).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
  }
  /** A sentence of 8 to 21 words, about one word in ten the topic. */
  sentence(topic: string, words = WORDS): string {
    const n = 8 + this.int(14);
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(this.next() < 0.1 ? topic : this.pick(words));
    const s = out.join(' ');
    return `${s[0]!.toUpperCase()}${s.slice(1)}.`;
  }
  /** Sentences up to about `chars` characters. */
  text(topic: string, chars: number, words = WORDS): string {
    let s = '';
    while (s.length < chars) s += `${this.sentence(topic, words)} `;
    return s.trim();
  }
}

/** How many entries of each kind a corpus holds. */
export interface CorpusPlan {
  chatgpt: number;
  claudeCode: number;
  notes: number;
}

export interface Corpus {
  /** The three folders to import: the ChatGPT export, the Claude Code projects and the vault. */
  paths: string[];
  plan: CorpusPlan;
  /** Characters of message and note text written. */
  chars: number;
}

/** The split of a corpus: most of a heavy user's record is ChatGPT, then agent sessions, then notes. */
export function planCorpus(entries: number): CorpusPlan {
  const notes = Math.round(entries * 0.1);
  const claudeCode = Math.round(entries * 0.3);
  return { chatgpt: entries - notes - claudeCode, claudeCode, notes };
}

/** Writes a corpus of about `entries` entries into `dir`. */
export function writeCorpus(dir: string, entries: number, seed = 42): Corpus {
  const plan = planCorpus(entries);
  const gen = new Gen(seed);
  let chars = 0;
  chars += writeChatgpt(join(dir, 'chatgpt'), plan.chatgpt, gen, Date.UTC(2023, 0, 1));
  chars += writeSessions(join(dir, 'claude-code'), plan.claudeCode, gen, Date.UTC(2025, 0, 1));
  chars += writeVault(join(dir, 'vault'), plan.notes, gen);
  return { paths: ['chatgpt', 'claude-code', 'vault'].map((p) => join(dir, p)), plan, chars };
}

/**
 * A small ChatGPT export of `entries` new messages, dated after the corpus: what arrives between two organiser runs.
 * Returns its folder.
 */
export function writeIncrement(dir: string, entries: number, seed = 4242): string {
  const folder = join(dir, 'increment');
  writeChatgpt(folder, entries, new Gen(seed), Date.UTC(2026, 10, 1), 'new');
  return folder;
}

/** A ChatGPT export (conversations.json) with `messages` messages in conversations of about 24. */
function writeChatgpt(folder: string, messages: number, gen: Gen, from: number, prefix = 'conv'): number {
  const convs: unknown[] = [];
  let chars = 0;
  let left = messages;
  for (let c = 0; left > 0; c++) {
    const topic = gen.pick(TOPICS);
    const start = from / 1000 + c * 25_000 + gen.int(20_000);
    const n = Math.min(left, Math.max(2, Math.round(24 * (0.3 + gen.next() * 1.4))));
    left -= n;
    const root = `${prefix}-${c}-root`;
    const mapping: Record<string, { id: string; parent: string | null; children: string[]; message: unknown }> = {
      [root]: { id: root, parent: null, children: [], message: null },
    };
    let parent = root;
    for (let i = 0; i < n; i++) {
      const id = `${prefix}-${c}-${i}`;
      const role = i % 2 ? 'assistant' : 'user';
      const body = role === 'user' ? gen.text(topic, 80 + gen.int(400)) : gen.text(topic, 600 + gen.int(2400));
      chars += body.length;
      const message = { id, author: { role }, create_time: start + i * 40, content: { content_type: 'text', parts: [body] }, metadata: {} };
      mapping[id] = { id, parent, children: [], message };
      mapping[parent]!.children.push(id);
      parent = id;
    }
    const title = `About ${topic} ${c}`;
    convs.push({ id: `${prefix}-${c}`, conversation_id: `${prefix}-${c}`, title, create_time: start, update_time: start + n * 40, mapping, current_node: parent });
  }
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'conversations.json'), JSON.stringify(convs));
  return chars;
}

/** Claude Code sessions of 40 messages, in 20 projects, as ~/.claude/projects holds them. */
function writeSessions(folder: string, messages: number, gen: Gen, from: number): number {
  let chars = 0;
  let t = from;
  let left = messages;
  for (let s = 0; left > 0; s++) {
    const project = `-home-bench-code-proj${s % 20}`;
    const sid = gen.uuid();
    const n = Math.min(left, 40);
    left -= n;
    const lines: string[] = [];
    for (let m = 0; m < n; m++) {
      t += 30_000 + gen.int(600_000);
      const user = m % 2 === 0;
      const topic = gen.pick(DEV_WORDS);
      const text = user
        ? `Decided: use ${gen.sentence(topic, DEV_WORDS).toLowerCase()}`
        : gen.text(topic, 300 + gen.int(900), DEV_WORDS);
      chars += text.length;
      const message = { role: user ? 'user' : 'assistant', content: user ? text : [{ type: 'text', text }] };
      lines.push(
        JSON.stringify({
          type: user ? 'user' : 'assistant',
          sessionId: sid,
          uuid: gen.uuid(),
          timestamp: new Date(t).toISOString(),
          cwd: `/home/bench/code/proj${s % 20}`,
          gitBranch: 'main',
          message,
        }),
      );
    }
    mkdirSync(join(folder, 'projects', project), { recursive: true });
    writeFileSync(join(folder, 'projects', project, `${sid}.jsonl`), `${lines.join('\n')}\n`);
  }
  return chars;
}

const FOLDERS = ['Areas/Work', 'Areas/Health', 'Projects/Active', 'Projects/Archive', 'Resources/Books', 'Zettel', 'Inbox'];

/** A vault of `notes` notes: daily notes first, then notes in folders, each linking three others. */
function writeVault(folder: string, notes: number, gen: Gen): number {
  const day = (i: number) => new Date(Date.UTC(2019, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
  const daily = Math.round(notes * 0.18);
  const list = Array.from({ length: notes }, (_, i) => {
    const topic = gen.pick(TOPICS);
    const inDaily = i < daily;
    const name = inDaily ? day(i) : `${topic[0]!.toUpperCase()}${topic.slice(1)} note ${i}`;
    return { name, topic, folder: inDaily ? 'Daily' : gen.pick(FOLDERS) };
  });
  // Two notes with the same name in different folders, and one with a name outside ASCII, as real vaults have.
  if (notes > 300) {
    list[daily + 10]!.name = 'Index';
    list[daily + 20]!.name = 'Index';
    list[daily + 30]!.name = 'Café ☕ ideas';
  }
  let chars = 0;
  mkdirSync(join(folder, '.obsidian'), { recursive: true });
  writeFileSync(join(folder, '.obsidian', 'app.json'), '{}');
  list.forEach((n, i) => {
    const [a, b, c] = [gen.pick(list), gen.pick(list), gen.pick(list)];
    const body = [
      '---',
      `created: ${day(i)} 0${i % 10}:15`,
      `aliases: [${n.topic}-${i}]`,
      'tags:',
      `  - ${n.topic}`,
      `  - project/${gen.pick(['alpha', 'beta', 'gamma'])}`,
      `status: ${gen.pick(['draft', 'evergreen', 'done'])}`,
      '---',
      '',
      `# ${n.name}`,
      '',
      gen.text(n.topic, 200 + gen.int(800)),
      '',
      `Related: [[${a.name}]], [[${b.name}|see this]] and [[${c.name}#Heading]].`,
      '',
      '> [!note] Callout',
      `> ${gen.sentence(n.topic)}`,
      '',
      `- [ ] follow up on #${n.topic}`,
      '',
      gen.text(n.topic, 100 + gen.int(600)),
    ].join('\n');
    chars += body.length;
    mkdirSync(join(folder, n.folder), { recursive: true });
    writeFileSync(join(folder, n.folder, `${n.name}.md`), body);
  });
  return chars;
}
