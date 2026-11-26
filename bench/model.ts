// Model timings: for each feature that asks a model (ask, layers, hubs and review), the time to first token, tokens
// per second and total time, on a seeded synthetic record, against one OpenAI-compatible server on this computer
// (llama-server reports its own timings, which give the token rates).
//
//   node bench/model.ts --url http://127.0.0.1:8741/v1 --dir <new folder> [--entries 10400] [--sample 3] [--label before]
//
// It never starts or stops a model server: whoever runs it starts one and stops it after. It refuses a URL that isn't
// on this computer, and the ports of a running Skeinwise (8731, the model server `model serve` starts, and 7319, the
// web app), so it can't reach someone's own record or server. The record, the corpus and a stand-in home all live in
// --dir, which must be new or empty. Nothing in it is a real history.
//
// Each request goes through the same client code the app uses (src/organiser/model.ts), with a fetch that notes when
// each answer's first token and last byte arrive. For ask, the whole question is timed too, as the page sees it: the
// streamed ask (src/server/ask-stream.ts) on a server of the bench's own (127.0.0.1, a free port), from the question
// to the entries, to the answer's first word and to the checked answer. For the organiser tasks, a few of a run's requests are sent (the
// first, the middle and the last by default) and the run's total is projected from them: a full run on a 4B model at
// 10k entries takes hours, which says nothing a sample doesn't.

import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cpus, loadavg, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { main } from '../src/cli.ts';
import { configPath, loadConfig } from '../src/config.ts';
import { openHome } from '../src/home.ts';
import { createModel, type ModelDeps } from '../src/organiser/model.ts';
import { previewRun } from '../src/organiser/organise.ts';
import { RecordView } from '../src/organiser/record.ts';
import { parseScope, type Task } from '../src/organiser/runs.ts';
import { type AskStreamEvent, streamAsk } from '../src/server/ask-stream.ts';
import type { Store } from '../src/store/store.ts';
import { writeCorpus } from './corpus.ts';
import { prepare, QUESTIONS } from './run.ts';

/** Ports a running Skeinwise uses: its model server and its web app. The bench never sends anything there. */
export const FORBIDDEN_PORTS = ['8731', '7319'];

/** One model request as the server answered it. */
export interface Timing {
  feature: string;
  purpose: string;
  /** From sending the request to the first answer token (a non-streamed answer: its first byte, so the whole answer). */
  ttftMs: number;
  /** From sending the request to the answer's last byte. */
  totalMs: number;
  streamed: boolean;
  /** From the server's own timings, when it reports them (llama-server does). */
  promptTokens: number | null;
  /** Prompt tokens the server took from its cache instead of reading again. */
  cachedTokens: number | null;
  promptPerSec: number | null;
  outTokens: number | null;
  outPerSec: number | null;
}

/** One question, end to end. */
export interface AskTiming {
  question: string;
  /** From the question to the first entry the user could see. */
  hitsMs: number;
  /** From the question to the first answer token on screen; the whole answer when nothing streams. */
  firstTokenMs: number;
  totalMs: number;
  answered: boolean;
  message: string | null;
}

export interface FeatureReport {
  feature: string;
  /** Model requests a full run would send; 1 for an ask. */
  requests: number;
  timings: Timing[];
  /** A full run's model time, projected from the sampled requests: the median total times the requests. */
  projectedMs: number | null;
  error?: string;
}

export interface ModelBenchReport {
  label: string;
  url: string;
  model: string;
  entries: number;
  machine: string;
  ask: AskTiming[];
  features: FeatureReport[];
}

/** Refuses a model URL the bench may not use. */
export function checkUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`--url ${url} is not a URL.`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error(`--url ${url} is not on this computer; the bench only talks to a server here.`);
  if (FORBIDDEN_PORTS.includes(u.port)) throw new Error(`--url ${url} is a port a running Skeinwise uses (${FORBIDDEN_PORTS.join(', ')}); start a server of the bench's own on another port.`);
  return url.replace(/\/+$/, '');
}

/** The timings llama-server sends with an answer: in the body, or in the last event of a stream. */
export function serverTimings(body: string, streamed: boolean): Record<string, number> | null {
  const pick = (o: unknown) => (o && typeof o === 'object' && 'timings' in o ? ((o as { timings: Record<string, number> }).timings ?? null) : null);
  if (!streamed) {
    try {
      return pick(JSON.parse(body));
    } catch {
      return null;
    }
  }
  let last: Record<string, number> | null = null;
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      last = pick(JSON.parse(data)) ?? last;
    } catch {
      // a line cut by the chunking: the timings come whole in the last event
    }
  }
  return last;
}

/**
 * A fetch that times every chat completion: when the first answer token arrives (for a stream, the first event with
 * answer text; otherwise the first byte, since the server sends the answer only once it is written) and when the
 * last byte does. The body passes through unchanged.
 */
export function timedFetch(base: typeof fetch, log: Timing[], feature: () => string): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const start = performance.now();
    const res = await base(input, init);
    if (!url.endsWith('/chat/completions') || !res.body) return res;
    const streamed = (res.headers.get('content-type') ?? '').includes('text/event-stream');
    let purpose = '';
    try {
      const sent = JSON.parse(String(init?.body ?? '{}')) as { messages?: { content?: string }[] };
      purpose = (sent.messages?.at(-1)?.content ?? '').slice(0, 60).replace(/\s+/g, ' ');
    } catch {
      // not ours to judge
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let first: number | null = null;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          const end = performance.now();
          const t = serverTimings(text, streamed);
          const num = (k: string) => (t && typeof t[k] === 'number' ? t[k] : null);
          log.push({
            feature: feature(),
            purpose,
            ttftMs: (first ?? end) - start,
            totalMs: end - start,
            streamed,
            promptTokens: num('prompt_n'),
            cachedTokens: num('cache_n'),
            promptPerSec: num('prompt_per_second'),
            outTokens: num('predicted_n'),
            outPerSec: num('predicted_per_second'),
          });
          controller.close();
          return;
        }
        text += decoder.decode(value, { stream: true });
        if (first === null && (!streamed || /"content":"(?!")/.test(text))) first = performance.now();
        controller.enqueue(value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  }) as typeof fetch;
}

/** Up to n indexes spread over a list of length: the first, the last, and evenly between. */
export function spread(length: number, n: number): number[] {
  if (length <= 0 || n <= 0) return [];
  if (length <= n) return [...Array(length).keys()];
  if (n === 1) return [0];
  return [...new Set(Array.from({ length: n }, (_, i) => Math.round((i * (length - 1)) / (n - 1))))];
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export interface ModelBenchOptions {
  url: string;
  dir: string;
  entries: number;
  sample: number;
  label: string;
  seed: number;
  /** The organiser tasks to time. */
  tasks: Task[];
  /** The network; the global fetch when not given (tests pass a fake server's). */
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

/** One question through the streamed ask, read the way the page reads it, on a server that lives for this question. */
async function timeAsk(store: Store, home: string, question: string, deps: ModelDeps): Promise<AskTiming> {
  const server = createServer((_req, res) => {
    streamAsk(res, { store, home, question, engine: 'local', deps }).catch((e: Error) => res.writeHead(500).end(e.message));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const start = performance.now();
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    if (!res.ok || !res.body) throw new Error(`the streamed ask answered ${res.status}: ${await res.text()}`);
    const decoder = new TextDecoder();
    let buffer = '';
    let hitsMs: number | null = null;
    let firstTokenMs: number | null = null;
    let done: Extract<AskStreamEvent, { type: 'done' }> | null = null;
    let error: string | null = null;
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let cut: number;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const event = JSON.parse(buffer.slice(0, cut).replace(/^data: /, '')) as AskStreamEvent;
        buffer = buffer.slice(cut + 2);
        const now = performance.now() - start;
        if (event.type === 'hits') hitsMs ??= now;
        else if (event.type === 'text') firstTokenMs ??= now;
        else if (event.type === 'restart') firstTokenMs = null;
        else if (event.type === 'done') done = event;
        else if (event.type === 'error') error = event.message;
      }
    }
    const totalMs = performance.now() - start;
    const result = done?.result;
    return {
      question,
      hitsMs: hitsMs ?? totalMs,
      firstTokenMs: firstTokenMs ?? totalMs,
      totalMs,
      answered: !!result?.answer,
      message: error ?? result?.message ?? null,
    };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** Builds the record, then times every feature against the model server. */
export async function modelBench(opts: ModelBenchOptions): Promise<ModelBenchReport> {
  const url = checkUrl(opts.url);
  const say = opts.log ?? (() => {});
  prepare(opts.dir);
  const home = join(opts.dir, 'home');
  const user = join(opts.dir, 'user');
  mkdirSync(home, { recursive: true });
  mkdirSync(user, { recursive: true });
  // The local engine, pointed at the bench's own server only.
  writeFileSync(configPath(home), `${JSON.stringify({ engine: 'local', localUrl: url, localModel: '' })}\n`);
  const config = loadConfig(home);
  if (config.localUrl.replace(/\/+$/, '') !== url) throw new Error(`The bench record's localUrl is ${config.localUrl}, not ${url}; refusing to run.`);
  const env = { SKEINWISE_HOME: home, HOME: user, USERPROFILE: user, NO_COLOR: '1' };

  say(`writing ${opts.entries} entries (seed ${opts.seed}) and importing them`);
  const corpus = writeCorpus(join(opts.dir, 'corpus'), opts.entries, opts.seed);
  let err = '';
  if ((await main(['import', ...corpus.paths], { out: () => {}, err: (t) => void (err += t), env })) !== 0) throw new Error(`import failed: ${err.trim()}`);

  const timings: Timing[] = [];
  let feature = '';
  const deps: ModelDeps = { fetch: timedFetch(opts.fetch ?? fetch, timings, () => feature), env, home };
  const store = openHome(home);
  try {
    const client = createModel(config, 'local', deps);
    await client.probe();
    const report: ModelBenchReport = { label: opts.label, url, model: client.model, entries: opts.entries, machine: machine(), ask: [], features: [] };

    feature = 'ask';
    const askStart = timings.length;
    for (const question of QUESTIONS) {
      say(`ask: ${question}`);
      report.ask.push(await timeAsk(store, home, question, deps));
    }
    report.features.push({ feature: 'ask', requests: 1, timings: timings.slice(askStart), projectedMs: median(timings.slice(askStart).map((t) => t.totalMs)) });

    // Review reads hubs: the No-AI hubs give it some, without the model.
    if (opts.tasks.includes('review')) {
      say('hubs without the model, for review to read');
      if ((await main(['run', 'hub', '--engine', 'none'], { out: () => {}, err: (t) => void (err += t), env })) !== 0) throw new Error(`run hub --engine none failed: ${err.trim()}`);
    }
    const record = new RecordView(store);
    for (const task of opts.tasks) {
      feature = task;
      say(`${task}: planning`);
      const from = timings.length;
      try {
        const preview = previewRun(store, record, { task, scope: parseScope(undefined), engine: 'local', client, yes: true, budget: config.budget, progress: () => {} });
        const picked = spread(preview.requests.length, opts.sample);
        for (const i of picked) {
          const r = preview.requests[i]!;
          say(`${task}: ${r.purpose}`);
          // A failed check is still a timed answer: the timing is the point here, not the content.
          await client.send({ purpose: r.purpose, system: r.system, user: r.user, maxTokens: r.maxTokens, check: (a) => a }).catch(() => {});
        }
        const sampled = timings.slice(from);
        const mid = median(sampled.map((t) => t.totalMs));
        report.features.push({ feature: task, requests: preview.requests.length, timings: sampled, projectedMs: mid === null ? null : mid * preview.requests.length });
      } catch (e) {
        report.features.push({ feature: task, requests: 0, timings: timings.slice(from), projectedMs: null, error: (e as Error).message });
      }
    }
    return report;
  } finally {
    store.db.close();
  }
}

function machine(): string {
  const [one, five] = loadavg();
  return `${cpus().length} cores, ${Math.round(totalmem() / 2 ** 30)} GB, load ${one!.toFixed(0)} (5 min ${five!.toFixed(0)})`;
}

const ms = (v: number | null) => (v === null ? '-' : v >= 10_000 ? `${(v / 1000).toFixed(0)} s` : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
const rate = (v: number | null) => (v === null ? '-' : `${v.toFixed(1)}/s`);

/** The report as plain lines (no colour, no box drawing). */
export function printModelReport(r: ModelBenchReport): string {
  const lines = [
    `Skeinwise model timings (${r.label}): ${r.entries.toLocaleString('en')} entries, ${r.model} at ${r.url}. ${r.machine}.`,
    '',
    'Ask, end to end:',
    `${'Question'.padEnd(46)}${'Entries'.padEnd(10)}${'1st token'.padEnd(11)}${'Total'.padEnd(10)}Answer`,
  ];
  for (const a of r.ask) lines.push(`${a.question.slice(0, 44).padEnd(46)}${ms(a.hitsMs).padEnd(10)}${ms(a.firstTokenMs).padEnd(11)}${ms(a.totalMs).padEnd(10)}${a.answered ? 'yes' : `no: ${(a.message ?? '').slice(0, 80)}`}`);
  lines.push('', 'Per model request (medians of the sampled requests):');
  lines.push(`${'Feature'.padEnd(10)}${'Requests'.padEnd(10)}${'Sampled'.padEnd(9)}${'1st token'.padEnd(11)}${'Total'.padEnd(9)}${'Out tok/s'.padEnd(11)}${'Prompt tok/s'.padEnd(14)}${'Prompt'.padEnd(8)}${'Cached'.padEnd(8)}Run (projected)`);
  for (const f of r.features) {
    if (f.error) {
      lines.push(`${f.feature.padEnd(10)}failed: ${f.error.slice(0, 160)}`);
      continue;
    }
    const m = (pick: (t: Timing) => number | null) => median(f.timings.map(pick).filter((v): v is number => v !== null));
    lines.push(
      `${f.feature.padEnd(10)}${String(f.requests).padEnd(10)}${String(f.timings.length).padEnd(9)}${ms(m((t) => t.ttftMs)).padEnd(11)}${ms(m((t) => t.totalMs)).padEnd(9)}` +
        `${rate(m((t) => t.outPerSec)).padEnd(11)}${rate(m((t) => t.promptPerSec)).padEnd(14)}${String(m((t) => t.promptTokens) ?? '-').padEnd(8)}${String(m((t) => t.cachedTokens) ?? '-').padEnd(8)}${ms(f.projectedMs)}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        url: { type: 'string' },
        dir: { type: 'string' },
        entries: { type: 'string' },
        sample: { type: 'string' },
        label: { type: 'string' },
        seed: { type: 'string' },
        tasks: { type: 'string' },
        json: { type: 'string' },
      },
    });
    if (!values.url || !values.dir) throw new Error('Give --url (a model server of the bench\'s own) and --dir (a new folder).');
    const entries = Number(values.entries ?? 10_400);
    const sample = Number(values.sample ?? 3);
    if (!Number.isInteger(entries) || entries < 1_000) throw new Error('--entries must be a whole number of 1000 or more.');
    if (!Number.isInteger(sample) || sample < 1) throw new Error('--sample must be a whole number of 1 or more.');
    const report = await modelBench({
      url: values.url,
      dir: resolve(values.dir),
      entries,
      sample,
      label: values.label ?? 'run',
      seed: Number(values.seed ?? 42),
      tasks: (values.tasks ?? 'layer,hub,review').split(',') as Task[],
      log: (line) => process.stderr.write(`model bench: ${line}\n`),
    });
    process.stdout.write(printModelReport(report));
    if (values.json) writeFileSync(values.json, `${JSON.stringify(report, null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`model bench: ${(err as Error).message}\n`);
    process.exitCode = 2;
  }
}
