// GET /api/ask/stream's handler (src/server/ask-stream.ts) on a server of the test's own, port 0: the entries first,
// the answer as it is written, the model stopped when the page goes, and the entries alone when no model answers.
// The model is a fake fetch; nothing leaves this computer.

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setConfigValue } from '../../src/config.ts';
import { DEMO_NOW, writeDemo } from '../../src/demo/demo.ts';
import { openHome } from '../../src/home.ts';
import { readImports } from '../../src/importers/detect.ts';
import { listRuns } from '../../src/organiser/runs.ts';
import { type AskStreamEvent, streamAsk } from '../../src/server/ask-stream.ts';
import type { Store } from '../../src/store/store.ts';

const QUESTION = 'what did I decide about sqlite';

let dir: string;
let home: string;
let store: Store;
let server: Server;
let base: string;
/** The model server's stand-in, swapped per test. */
let model: typeof fetch;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'skeinwise-ask-stream-'));
  home = join(dir, 'home');
  store = openHome(home, () => DEMO_NOW);
  const exports = join(dir, 'exports');
  writeDemo(exports);
  for (const p of ['chatgpt', 'claude', 'claude-code', 'notes']) for (const b of readImports(join(exports, p))) store.ingest(b);
  setConfigValue(home, 'engine', 'local');
  setConfigValue(home, 'localUrl', 'http://127.0.0.1:9/v1'); // never reached: `model` answers instead
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const deps = { fetch: (...a: Parameters<typeof fetch>) => model(...a), env: {}, home };
    streamAsk(res, { store, home, question: url.searchParams.get('q') ?? '', engine: url.searchParams.get('engine') ?? undefined, deps }).catch((err: Error) => {
      res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: err.message }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The events in a stream's text. */
const events = (text: string): AskStreamEvent[] =>
  text
    .split('\n\n')
    .filter(Boolean)
    .map((block) => JSON.parse(block.replace(/^data: /, '')) as AskStreamEvent);

/** A model stream: the pieces, then (when given) a wait for the request to be stopped before the end. */
function sse(pieces: string[], signal?: AbortSignal | null, holdAfter?: number): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(c) {
        for (const [i, p] of pieces.entries()) {
          c.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`));
          if (holdAfter === i && signal) {
            await new Promise((r) => signal.addEventListener('abort', r));
            return c.error(signal.reason);
          }
        }
        c.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 300, completion_tokens: 25 } })}\n\ndata: [DONE]\n\n`));
        c.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

const listsModel = (input: string | URL | Request) => String(input).endsWith('/models') && Response.json({ data: [{ id: 'fake-4b' }] });

describe('GET /api/ask/stream', () => {
  it('sends the entries, what the model is doing, the answer as it is written, then the checked answer', async () => {
    model = (async (input: string | URL | Request) =>
      listsModel(input) || sse(['{"answer": "Plotline went on SQLite', ' in March 2025, then Post', 'gres in April 2026.", "cites": ["E1", "E2"]}'])) as typeof fetch;
    const res = await fetch(`${base}/?q=${encodeURIComponent(QUESTION)}`);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    const list = events(await res.text());
    expect(list.map((e) => e.type)).toEqual(['hits', 'status', 'status', 'status', 'text', 'text', 'text', 'done']);
    const hits = list[0] as Extract<AskStreamEvent, { type: 'hits' }>;
    expect(hits.result.hits).toHaveLength(4);
    expect(hits.result.answer).toBeNull();
    const done = list.at(-1) as Extract<AskStreamEvent, { type: 'done' }>;
    expect(done.result).toMatchObject({ answer: 'Plotline went on SQLite in March 2025, then Postgres in April 2026.', engine: 'local', model: 'fake-4b' });
    expect(list.flatMap((e) => (e.type === 'text' ? [e.text] : [])).join('')).toBe(done.result.answer);
  });

  it('stops the model when the page goes, and records the run as stopped', async () => {
    let stopped: AbortSignal | null = null;
    model = (async (input: string | URL | Request, init?: RequestInit) => {
      const listed = listsModel(input);
      if (listed) return listed;
      stopped = init?.signal ?? null;
      return sse(['{"answer": "Plotline went on', ' SQLite', ' first'], init?.signal, 0);
    }) as typeof fetch;
    const page = new AbortController();
    const res = await fetch(`${base}/?q=${encodeURIComponent(QUESTION)}`, { signal: page.signal });
    const reader = res.body!.getReader();
    let text = '';
    while (!text.includes('"type":"text"')) text += new TextDecoder().decode((await reader.read()).value);
    page.abort();
    const deadline = Date.now() + 3000;
    while (listRuns(store.db)[0]?.status !== 'failed' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect((stopped as AbortSignal | null)?.aborted).toBe(true);
    expect(listRuns(store.db)[0]).toMatchObject({ task: 'ask', status: 'failed', message: 'Stopped during the answer.' });
  });

  it('ends with the entries alone, and says why, when no model answers', async () => {
    model = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const list = events(await (await fetch(`${base}/?q=${encodeURIComponent(QUESTION)}`)).text());
    expect(list.map((e) => e.type)).toEqual(['hits', 'status', 'done']);
    const done = list.at(-1) as Extract<AskStreamEvent, { type: 'done' }>;
    expect(done.result.hits).toHaveLength(4);
    expect(done.result.answer).toBeNull();
    expect(done.result.message).toMatch(/^The local model didn't answer, so these are your entries alone\. No model server answers at http:\/\/127\.0\.0\.1:9\/v1/);
  });

  it('refuses before streaming: an empty question, an unknown engine', async () => {
    model = (async () => {
      throw new Error('not asked');
    }) as typeof fetch;
    for (const path of ['/?q=%20%3F', `/?q=${encodeURIComponent(QUESTION)}&engine=cloud`]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/Ask a question|Unknown engine "cloud"/);
    }
  });
});
