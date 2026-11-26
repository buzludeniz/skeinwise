// A streamed ask: the entries come first, the answer's text arrives cleaned as the model writes it, a bad answer is
// asked for again with the text so far voided, and the caller can stop the model. A fake server stands in for it.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { DEMO_NOW, writeDemo } from '../src/demo/demo.ts';
import { readImports } from '../src/importers/detect.ts';
import { answerSoFar, ask, type AskLive } from '../src/organiser/ask.ts';
import { createModel, ModelCancelledError } from '../src/organiser/model.ts';
import { RecordView } from '../src/organiser/record.ts';
import { listRuns } from '../src/organiser/runs.ts';
import { safeBlock } from '../src/safe-text.ts';
import { openDb } from '../src/store/db.ts';
import { Store } from '../src/store/store.ts';

describe('answerSoFar', () => {
  it('reads the answer text out of JSON that is still arriving', () => {
    expect(answerSoFar('')).toEqual({ text: '', ended: false });
    expect(answerSoFar('{"answ')).toEqual({ text: '', ended: false });
    expect(answerSoFar('{"answer": "In Ma')).toEqual({ text: 'In Ma', ended: false });
    expect(answerSoFar('{"answer":"In March.", "cites": ["E1"]}')).toEqual({ text: 'In March.', ended: true });
    expect(answerSoFar('{"cites": ["E1"], "answer" : "Rye."}')).toEqual({ text: 'Rye.', ended: true });
  });

  it('decodes escapes, and waits for one that is cut off', () => {
    expect(answerSoFar('{"answer": "a \\"b\\" \\\\ c\\nd\\t\\/')).toEqual({ text: 'a "b" \\ c\nd\t/', ended: false });
    expect(answerSoFar('{"answer": "x\\')).toEqual({ text: 'x', ended: false });
    expect(answerSoFar('{"answer": "x\\u00')).toEqual({ text: 'x', ended: false });
    expect(answerSoFar('{"answer": "x\\u00e9')).toEqual({ text: 'xé', ended: false });
    expect(answerSoFar('{"answer": "\\ud83d\\ude00"')).toEqual({ text: '😀', ended: true });
    // Not JSON: the checked answer decides what it was.
    expect(answerSoFar('{"answer": "x\\q more')).toEqual({ text: 'x', ended: true });
    expect(answerSoFar('{"answer": "x\\uzz12')).toEqual({ text: 'x', ended: true });
  });
});

/**
 * A server-sent event stream of chat completion pieces, as llama-server writes it. With `hold`, it waits after the
 * second piece; a request stopped meanwhile fails its body, as fetch does.
 */
function sse(pieces: string[], usage = { prompt_tokens: 300, completion_tokens: 25 }, hold?: { until: Promise<void>; signal?: AbortSignal | null }): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(c) {
        for (const [i, p] of pieces.entries()) {
          c.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`));
          if (hold && i === 1) {
            await hold.until;
            if (hold.signal?.aborted) return c.error(hold.signal.reason);
          }
        }
        c.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage })}\n\ndata: [DONE]\n\n`));
        c.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

/** Cuts a text into pieces of the given sizes, then the rest. */
function cut(text: string, sizes: number[]): string[] {
  const out: string[] = [];
  let i = 0;
  for (const n of sizes) {
    out.push(text.slice(i, i + n));
    i += n;
  }
  return [...out, text.slice(i)];
}

describe('a streamed ask', () => {
  let dir: string;
  let store: Store;
  let record: RecordView;
  const QUESTION = 'what did I decide about sqlite';

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'skeinwise-ask-stream-'));
    writeDemo(dir);
    store = new Store(openDb(':memory:'), () => DEMO_NOW);
    for (const p of ['chatgpt', 'claude', 'claude-code', 'notes']) for (const b of readImports(join(dir, p))) store.ingest(b);
    record = new RecordView(store);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** Every event the ask reported, in order. */
  function recorder(extra: Partial<AskLive> = {}) {
    const events: string[] = [];
    let text = '';
    const live: AskLive = {
      onHits: (r) => events.push(`hits ${r.hits.length}`),
      onStatus: (line) => events.push(`status ${line}`),
      onText: (piece) => {
        if (!events.at(-1)?.startsWith('text')) events.push('text');
        text += piece;
      },
      onRestart: () => {
        events.push('restart');
        text = '';
      },
      ...extra,
    };
    return { live, events, text: () => text };
  }

  it('shows the entries before the model is asked, then the answer as it is written', async () => {
    const asked: string[] = [];
    // An escape cut between pieces, and a terminal escape the model should never have written.
    const answer = 'Plotline went on SQLite in March 2025, \\"for now\\", \\u001b[31mthen\\u001b[0m Postgres in April 2026.';
    const json = `{"answer": "${answer}", "cites": ["E1", "E2"]}`;
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      asked.push(String(input).replace(/^.*\/v1/, ''));
      if (String(input).endsWith('/models')) return Response.json({ data: [{ id: 'models/fake-4b.gguf' }] });
      expect(JSON.parse(String(init!.body))).toMatchObject({ stream: true });
      return sse(cut(json, [5, 9, 3, 40, 1, 1, 6, 2]));
    }) as typeof globalThis.fetch;
    const client = createModel(DEFAULT_CONFIG, 'local', { fetch, env: {} });
    const seen = recorder({ onHits: (r) => seen.events.push(`hits ${r.hits.length} after ${asked.length} requests`) });
    const r = await ask(store, record, QUESTION, { engine: 'local', client, budget: 0, limit: 5 }, seen.live);

    expect(seen.events).toEqual([
      'hits 4 after 0 requests',
      'status Looking for the model',
      'status models/fake-4b.gguf is reading 4 entries',
      'status Writing the answer',
      'text',
    ]);
    // What was shown is what the checked answer says.
    expect(r.answer).toBe('Plotline went on SQLite in March 2025, "for now", then Postgres in April 2026.');
    expect(seen.text()).toBe(r.answer);
    expect(r.cites).toHaveLength(2);
    expect(listRuns(store.db).find((x) => x.id === r.runId)).toMatchObject({ task: 'ask', status: 'done', tokensIn: 300, tokensOut: 25 });
  });

  it('voids the text shown when the answer is asked for again', async () => {
    let chats = 0;
    const fetch = (async (input: string | URL | Request) => {
      if (String(input).endsWith('/models')) return Response.json({ data: [{ id: 'fake-4b' }] });
      chats += 1;
      if (chats === 1) return sse(cut('{"answer": "It moved to MySQL.", "cites": ["E9"]}', [12, 8]));
      return sse(cut('{"answer": "It moved to Postgres.", "cites": ["E2"]}', [14, 7]));
    }) as typeof globalThis.fetch;
    const client = createModel(DEFAULT_CONFIG, 'local', { fetch, env: {} });
    const seen = recorder();
    const r = await ask(store, record, QUESTION, { engine: 'local', client, budget: 0, limit: 5 }, seen.live);
    expect(chats).toBe(2);
    expect(seen.events).toEqual([
      'hits 4',
      'status Looking for the model',
      'status fake-4b is reading 4 entries',
      'status Writing the answer',
      'text',
      'restart',
      "status Asking again: that answer couldn't be used",
      'status Writing the answer',
      'text',
    ]);
    expect(seen.text()).toBe('It moved to Postgres.');
    expect(r.answer).toBe('It moved to Postgres.');
  });

  it('stops the model when asked, and records what it used', async () => {
    const stop = new AbortController();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/models')) return Response.json({ data: [{ id: 'fake-4b' }] });
      init?.signal?.addEventListener('abort', () => release());
      return sse(cut('{"answer": "Plotline went on SQLite first, then', [12]), undefined, { until: held, signal: init?.signal });
    }) as typeof globalThis.fetch;
    const client = createModel(DEFAULT_CONFIG, 'local', { fetch, env: {} });
    const seen = recorder({
      onText: (piece) => {
        seen.events.push(`text ${piece}`);
        stop.abort();
      },
      signal: stop.signal,
    });
    const before = listRuns(store.db).length;
    const err = await ask(store, record, QUESTION, { engine: 'local', client, budget: 0, limit: 5 }, seen.live).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelCancelledError);
    expect((err as Error).message).toBe('Stopped during the answer.');
    expect(seen.events.slice(0, 2)).toEqual(['hits 4', 'status Looking for the model']);
    expect(seen.events).toContain('text Plotline went on SQLite first, then');
    const runs = listRuns(store.db);
    expect(runs).toHaveLength(before + 1);
    expect(runs[0]).toMatchObject({ task: 'ask', status: 'failed', message: 'Stopped during the answer.' });
    expect(runs[0]!.tokensIn).toBeGreaterThan(0);
  });

  it('gives the same answer as an ask that does not stream', async () => {
    const content = JSON.stringify({ answer: 'SQLite in March 2025, then Postgres in April 2026.', cites: ['E1', 'E2'] });
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/models')) return Response.json({ data: [{ id: 'fake-4b' }] });
      if (JSON.parse(String(init!.body)).stream) return sse(cut(content, [3, 3, 3]));
      return Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 300, completion_tokens: 25 } });
    }) as typeof globalThis.fetch;
    const client = createModel(DEFAULT_CONFIG, 'local', { fetch, env: {} });
    const plain = await ask(store, record, QUESTION, { engine: 'local', client, budget: 0, limit: 5 });
    const seen = recorder();
    const streamed = await ask(store, record, QUESTION, { engine: 'local', client, budget: 0, limit: 5 }, seen.live);
    expect({ ...streamed, runId: 0 }).toEqual({ ...plain, runId: 0 });
    expect(seen.text()).toBe(safeBlock(plain.answer!));
  });
});
