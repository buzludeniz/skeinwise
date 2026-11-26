// The model timings bench (bench/model.ts): it refuses a server that isn't its own, times each request through the
// app's client code, and reads llama-server's own timings. A fake server stands in for the model.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkUrl, median, modelBench, printModelReport, serverTimings, spread, type Timing, timedFetch } from '../bench/model.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skeinwise-bench-model-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const TIMINGS = { prompt_n: 400, cache_n: 0, prompt_per_second: 800, predicted_n: 40, predicted_per_second: 25 };

/** A fake llama-server: lists one model, answers an ask with a cited answer and anything else with an empty object. */
function fakeServer() {
  const urls: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'fake-4b' }] });
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    const user = body.messages.at(-1)!.content;
    const content = user.startsWith('My question:') ? JSON.stringify({ answer: 'You wrote about it in E1.', cites: ['E1'] }) : '{}';
    return Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 400, completion_tokens: 40 }, timings: TIMINGS });
  }) as typeof globalThis.fetch;
  return { fetch, urls };
}

describe('model bench', () => {
  it('only talks to a server of its own on this computer', () => {
    expect(checkUrl('http://127.0.0.1:8741/v1/')).toBe('http://127.0.0.1:8741/v1');
    expect(() => checkUrl('http://127.0.0.1:8731/v1')).toThrow(/a running Skeinwise uses/);
    expect(() => checkUrl('http://localhost:7319')).toThrow(/a running Skeinwise uses/);
    expect(() => checkUrl('https://models.example.com/v1')).toThrow(/not on this computer/);
    expect(() => checkUrl('not a url')).toThrow(/not a URL/);
  });

  it('reads the timings llama-server sends, in a body or at the end of a stream', () => {
    expect(serverTimings(JSON.stringify({ choices: [], timings: TIMINGS }), false)).toEqual(TIMINGS);
    const stream = ['data: {"choices":[{"delta":{"content":"a"}}]}', 'data: {"choices":[{"delta":{}}],"timings":{"predicted_n":7}}', 'data: [DONE]', ''].join('\n\n');
    expect(serverTimings(stream, true)).toEqual({ predicted_n: 7 });
    expect(serverTimings('not json', false)).toBeNull();
  });

  it('times the first token of a stream when its first answer text arrives, not its first byte', async () => {
    const encoder = new TextEncoder();
    const events = ['data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\n', 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n', 'data: [DONE]\n\n'];
    const base = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(c) {
            for (const e of events) {
              c.enqueue(encoder.encode(e));
              await new Promise((r) => setTimeout(r, 30));
            }
            c.close();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      )) as typeof fetch;
    const log: Timing[] = [];
    const res = await timedFetch(base, log, () => 'ask')('http://127.0.0.1:1/v1/chat/completions', { method: 'POST', body: '{"messages":[{"content":"q"}]}' });
    expect(await res.text()).toBe(events.join(''));
    expect(log).toHaveLength(1);
    expect(log[0]!).toMatchObject({ feature: 'ask', streamed: true, purpose: 'q' });
    // The role-only event came first; the token came one event later.
    expect(log[0]!.ttftMs).toBeGreaterThanOrEqual(25);
    expect(log[0]!.totalMs).toBeGreaterThan(log[0]!.ttftMs);
  });

  it('picks the first, the last and requests evenly between', () => {
    expect(spread(0, 3)).toEqual([]);
    expect(spread(2, 3)).toEqual([0, 1]);
    expect(spread(10, 3)).toEqual([0, 5, 9]);
    expect(spread(10, 1)).toEqual([0]);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it('times every question and a sample of each task against the server it was given, and no other', async () => {
    const server = fakeServer();
    const report = await modelBench({ url: 'http://127.0.0.1:8741/v1', dir: join(dir, 'run'), entries: 1_000, sample: 2, label: 'test', seed: 7, tasks: ['layer', 'hub', 'review'], fetch: server.fetch });
    expect(new Set(server.urls.map((u) => new URL(u).origin))).toEqual(new Set(['http://127.0.0.1:8741']));
    expect(report.model).toBe('fake-4b');
    expect(report.ask).toHaveLength(3);
    const ask = report.features.find((f) => f.feature === 'ask')!;
    expect(ask.timings.length).toBeGreaterThan(0);
    expect(ask.timings[0]).toMatchObject({ outTokens: 40, outPerSec: 25, promptTokens: 400, streamed: false });
    for (const task of ['layer', 'hub', 'review']) {
      const f = report.features.find((x) => x.feature === task)!;
      expect(f.error).toBeUndefined();
      expect(f.timings.length).toBe(Math.min(2, f.requests));
    }
    const text = printModelReport(report);
    expect(text).toMatch(/^Skeinwise model timings \(test\): 1,000 entries, fake-4b at http:\/\/127\.0\.0\.1:8741\/v1/);
    expect(text).toMatch(/\nlayer {5}\d+/);
    // It builds and imports a 1000-entry record: a couple of seconds alone, longer beside the whole suite.
  }, 60_000);

  it('refuses a folder the bench did not make', async () => {
    await expect(modelBench({ url: 'http://127.0.0.1:8741/v1', dir: process.cwd(), entries: 1_000, sample: 1, label: 'x', seed: 1, tasks: [], fetch: fakeServer().fetch })).rejects.toThrow(
      /not empty|real home/,
    );
  });
});
