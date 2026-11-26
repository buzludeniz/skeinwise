import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type Config, DEFAULT_CONFIG } from '../src/config.ts';
import { UsageError } from '../src/errors.ts';
import { BadAnswerError, createModel, ModelCancelledError, ModelTimeoutError, parseAnswer, REQUEST_MS, serverKeyPath } from '../src/organiser/model.ts';
import { text } from '../src/organiser/plan.ts';
import { previewRun, type RunOptions, runTask } from '../src/organiser/organise.ts';
import { keyShaped } from './samples.ts';
import { RecordView } from '../src/organiser/record.ts';
import { Redactor } from '../src/organiser/redact.ts';
import { listRuns } from '../src/organiser/runs.ts';
import { entryLayers, liveHubs } from '../src/organiser/views.ts';
import { openDb } from '../src/store/db.ts';
import { Store } from '../src/store/store.ts';

const NOW = '2026-05-10T12:00:00.000Z';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: { model: string; messages: { role: string; content: string }[]; [k: string]: unknown } | null;
}

/** A fake OpenAI-compatible server. `answer` gets each chat request's user text and returns the reply content. */
function fakeServer(answer: (user: string) => string, opts: { models?: string[]; usage?: { prompt_tokens: number; completion_tokens: number }; down?: boolean } = {}) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    calls.push(call);
    if (opts.down) throw new TypeError('fetch failed');
    if (url.endsWith('/models')) return Response.json({ object: 'list', data: (opts.models ?? ['models/fake-4b.gguf']).map((id) => ({ id })) });
    const user = call.body!.messages.find((m) => m.role === 'user')!.content;
    return Response.json({
      choices: [{ message: { role: 'assistant', content: answer(user) }, finish_reason: 'stop' }],
      usage: opts.usage ?? { prompt_tokens: 100, completion_tokens: 20 },
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls, chats: () => calls.filter((c) => c.method === 'POST') };
}

/** A hub answer that cites the first sentences it was shown and names the subject after a word in them. */
function hubAnswer(user: string, extra: { inShort?: string; cites?: string[] } = {}): string {
  const name = /rye|sourdough|loaf/.test(user) ? 'Rye baking' : 'River samples';
  return JSON.stringify({
    name,
    in_short: [{ text: extra.inShort ?? `Notes on ${name.toLowerCase()}.`, cites: extra.cites ?? ['S1', 'S2'] }],
    found: ['S2'],
    open_ends: [],
  });
}

describe('organising with a model', () => {
  let store: Store;

  function add(id: string, body: string, title = id) {
    store.ingest({
      source: { kind: 'notes', label: 'notes', location: '/n' },
      threads: [],
      entries: [{ externalId: id, kind: 'note', speaker: 'you', title, createdAt: `2025-01-${String(store.allEntries().length + 1).padStart(2, '0')}T00:00:00.000Z`, body }],
    });
  }

  beforeEach(() => {
    store = new Store(openDb(':memory:'), () => NOW);
    for (const [i, w] of ['rye loaf', 'sourdough starter', 'rye proof', 'starter feeding', 'sourdough crumb', 'rye flour'].entries()) {
      add(`bread${i}.md`, `Notes on the ${w}. The ${w} and the oven matter for the loaf, and the dough too.`, `Bread ${i}`);
    }
    for (const [i, w] of ['nitrate samples', 'river samples', 'nitrate rain', 'river outflow', 'outflow nitrate', 'river rain'].entries()) {
      add(`river${i}.md`, `Notes on the ${w}. The ${w} at the site after the storm, and the flow too.`, `River ${i}`);
    }
  });

  const config = (over: Partial<Config> = {}): Config => ({ ...DEFAULT_CONFIG, ...over });
  const options = (task: RunOptions['task'], client: RunOptions['client'], over: Partial<RunOptions> = {}): RunOptions => ({
    task,
    scope: { kind: 'all' },
    engine: client?.engine ?? 'none',
    ...(client ? { client } : {}),
    yes: false,
    budget: 1_000_000,
    progress: () => {},
    ...over,
  });

  it('saves a valid answer, with the model, the engine and the tokens on the run', async () => {
    const server = fakeServer((u) => hubAnswer(u));
    const client = createModel(config(), 'local', { fetch: server.fetch, env: {} });
    const run = await runTask(store, new RecordView(store), options('hub', client));

    expect(run).toMatchObject({ status: 'done', engine: 'local', model: 'models/fake-4b.gguf', tokensIn: 200, tokensOut: 40 });
    const hubs = liveHubs(store.db);
    expect(hubs.map((h) => h.name).sort()).toEqual(['River samples', 'Rye baking']);
    const rye = hubs.find((h) => h.name === 'Rye baking')!;
    expect(rye.sections.in_short[0]).toMatchObject({ text: 'Notes on rye baking.' });
    expect(rye.sections.in_short[0]!.cites?.length).toBeGreaterThan(0);
    expect(rye.sections.what_you_found).toHaveLength(1);

    expect(server.calls[0]).toMatchObject({ method: 'GET', url: 'http://127.0.0.1:8731/v1/models' });
    const body = server.chats()[0]!.body!;
    expect(body).toMatchObject({ model: 'models/fake-4b.gguf', temperature: 0, response_format: { type: 'json_object' }, chat_template_kwargs: { enable_thinking: false }, cache_prompt: true });
    expect(body.stream).toBeUndefined();
    expect(server.chats()[0]!.headers.authorization).toBeUndefined();
  });

  it('makes a hub without the model when its answer is not JSON, or does not fit, after one repair', async () => {
    const prose = fakeServer(() => 'Sure! The subject is rye baking.');
    const client = createModel(config(), 'local', { fetch: prose.fetch, env: {} });
    const progress: string[] = [];
    const run = await runTask(store, new RecordView(store), options('hub', client, { progress: (l) => progress.push(l) }));
    // Each hub was asked once more with what was wrong, then made without the model: every answer's tokens count.
    expect(prose.chats()).toHaveLength(4);
    expect(run).toMatchObject({ status: 'done', tokensIn: 400, tokensOut: 80, counts: { hubs: 2, unanswered: 2 } });
    expect(run.message).toMatch(/answers for 2 requests \(hub 1 of 2, hub 2 of 2\) were still unusable after one repair/);
    expect(progress.join('\n')).toMatch(/answer for hub 1 of 2 is not JSON: Sure!/);
    const made = liveHubs(store.db).map((h) => ({ name: h.name, sections: h.sections }));
    // They are the No-AI hubs.
    await runTask(store, new RecordView(store), options('hub', undefined));
    expect(liveHubs(store.db).map((h) => ({ name: h.name, sections: h.sections }))).toEqual(made);

    const unshown = fakeServer((u) => hubAnswer(u).replace('"S2"]', '"S99"]'));
    const cited = await runTask(store, new RecordView(store), options('hub', createModel(config(), 'local', { fetch: unshown.fetch, env: {} })));
    expect(cited).toMatchObject({ status: 'done', counts: { unanswered: 2 } });
    expect(liveHubs(store.db).map((h) => ({ name: h.name, sections: h.sections }))).toEqual(made);
  });

  it('asks once more after a bad answer, with the answer and what was wrong, and uses the second', async () => {
    let n = 0;
    const server = fakeServer((u) => (n++ === 0 ? hubAnswer(u).replace('"S2"]', '"S99"]') : hubAnswer(u)));
    const client = createModel(config(), 'local', { fetch: server.fetch, env: {} });
    const run = await runTask(store, new RecordView(store), options('hub', client));
    expect(run).toMatchObject({ status: 'done', tokensIn: 300, tokensOut: 60 });
    expect(liveHubs(store.db)).toHaveLength(2);
    expect(server.chats()).toHaveLength(3);
    const repair = server.chats()[1]!.body!.messages;
    expect(repair.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(repair.slice(0, 2)).toEqual(server.chats()[0]!.body!.messages);
    expect(repair[2]!.content).toContain('"S99"');
    expect(repair[3]!.content).toMatch(/^That answer can't be used: "in_short\.cites" cites "S99", which it wasn't shown\. Answer again with only the JSON object/);
  });

  it('throws a BadAnswerError after a second bad answer, and does not ask a third time', async () => {
    const server = fakeServer(() => '{"name": ""}');
    const client = createModel(config(), 'local', { fetch: server.fetch, env: {} });
    await client.probe();
    const err = await client.send({ purpose: 'p', system: 's', user: 'u', maxTokens: 50, check: (a) => text('p', (a as { name?: unknown }).name, 'name') }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadAnswerError);
    expect((err as BadAnswerError).message).toMatch(/"name" must be non-empty text/);
    expect(err).toMatchObject({ tokensIn: 200, tokensOut: 40 });
    expect(server.chats()).toHaveLength(2);
    // A stream is told when its text so far is void.
    const restarts: string[] = [];
    await client.stream({ purpose: 'p', system: 's', user: 'u', maxTokens: 50, check: (a) => text('p', (a as { name?: unknown }).name, 'name') }, { onRestart: (why) => restarts.push(why) }).catch(() => {});
    expect(restarts).toEqual([expect.stringMatching(/"name" must be non-empty text/)]);
  });

  it('streams the answer text as it comes, and reads the usage at the end', async () => {
    const events = ['{"ans', 'wer": "Rye', ' loaf"}'].map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c }, finish_reason: null }] })}\n\n`);
    events.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 70, completion_tokens: 9 } })}\n\n`, 'data: [DONE]\n\n');
    const sent: { stream?: unknown }[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/models')) return Response.json({ data: [{ id: 'm' }] });
      sent.push(JSON.parse(String(init!.body)));
      const encoder = new TextEncoder();
      // Cut mid-line, to show lines are put back together.
      const bytes = encoder.encode(events.join(''));
      return new Response(new ReadableStream({ start: (c) => { c.enqueue(bytes.slice(0, 17)); c.enqueue(bytes.slice(17)); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof globalThis.fetch;
    const client = createModel(config(), 'local', { fetch, env: {} });
    await client.probe();
    const pieces: string[] = [];
    const reply = await client.stream({ purpose: 'p', system: 's', user: 'u', maxTokens: 50, check: (a) => a }, { onText: (p) => pieces.push(p) });
    expect(sent[0]).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(pieces).toEqual(['{"ans', 'wer": "Rye', ' loaf"}']);
    expect(reply).toEqual({ answer: { answer: 'Rye loaf' }, tokensIn: 70, tokensOut: 9 });
  });

  it('stops a streamed request when its signal fires, and counts what was written', async () => {
    const stop = new AbortController();
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/models')) return Response.json({ data: [{ id: 'm' }] });
      const signal = init!.signal!;
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"answer": "the first eight' } }] })}\n\n`));
            signal.addEventListener('abort', () => c.error(signal.reason));
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }) as typeof globalThis.fetch;
    const client = createModel(config(), 'local', { fetch, env: {} });
    await client.probe();
    const err = await client.stream({ purpose: 'the answer', system: 's', user: 'u', maxTokens: 50, check: (a) => a }, { onText: () => stop.abort(), signal: stop.signal }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelCancelledError);
    expect(err).toMatchObject({ message: 'Stopped during the answer.', tokensOut: 7 });
  });

  // The views fuzz (Nov 26): AbortSignal.timeout kept every request's ten-minute timer and signal after the answer.
  it("drops a request's deadline once it is answered, fails or is stopped, and still times out by it", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const during: number[] = [];
      const fetchWith = (chat: (init: RequestInit) => Response | Promise<Response>, models = () => Response.json({ data: [{ id: 'm' }] })) =>
        (async (input: string | URL | Request, init?: RequestInit) => {
          during.push(vi.getTimerCount());
          return String(input).endsWith('/models') ? models() : chat(init!);
        }) as typeof globalThis.fetch;
      const request = { purpose: 'p', system: 's', user: 'u', maxTokens: 50, check: (a: unknown) => a };
      const answered = () => Response.json({ choices: [{ message: { content: '{"answer": "ok"}' }, finish_reason: 'stop' }] });
      const streamed = (open: boolean, signal?: AbortSignal | null) =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"answer": "ok"}' }, finish_reason: 'stop' }] })}\n\n`));
              if (!open) c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
              if (!open) c.close();
              signal?.addEventListener('abort', () => c.error(signal.reason));
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      const left = async (fetch: typeof globalThis.fetch, call: (client: ReturnType<typeof createModel>) => Promise<unknown>) => {
        const client = createModel(config(), 'local', { fetch, env: {} });
        const outcome = await call(client).then(() => 'answered', (e: unknown) => (e as Error).constructor.name);
        return [outcome, vi.getTimerCount()];
      };

      expect(await left(fetchWith(answered), async (c) => { await c.probe(); await c.send(request); })).toEqual(['answered', 0]);
      expect(await left(fetchWith(() => streamed(false)), async (c) => { await c.probe(); await c.stream(request, { onText: () => {} }); })).toEqual(['answered', 0]);
      expect(await left(fetchWith(() => new Response('busy', { status: 503 })), async (c) => { await c.probe(); await c.send(request); })).toEqual(['Error', 0]);
      expect(await left(fetchWith(() => { throw new TypeError('fetch failed'); }), async (c) => { await c.probe(); await c.send(request); })).toEqual(['UsageError', 0]);
      expect(await left(fetchWith(answered, () => new Response('{}', { status: 401 })), (c) => c.probe())).toEqual(['UsageError', 0]);
      const stop = new AbortController();
      expect(await left(fetchWith((init) => streamed(true, init.signal)), async (c) => { await c.probe(); await c.stream(request, { onText: () => stop.abort(), signal: stop.signal }); })).toEqual(['ModelCancelledError', 0]);
      // Each request had its deadline as a timer while it was out: one at a time, the probe's gone before the chat's.
      expect(during.length).toBe(11);
      expect(new Set(during)).toEqual(new Set([1]));

      const hanging = fetchWith((init) => new Promise<Response>((_answer, fail) => init.signal!.addEventListener('abort', () => fail(init.signal!.reason))));
      const slow = createModel(config(), 'local', { fetch: hanging, env: {} });
      await slow.probe();
      const late = slow.send(request).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(REQUEST_MS);
      expect(await late).toMatchObject({ message: expect.stringMatching(/^The model server took longer than 10 minutes during p\./) });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not stream the remote engine: its text has placeholders until the answer is whole', async () => {
    const server = fakeServer(() => '{"answer": "ok"}');
    const client = createModel(config({ remoteUrl: 'https://models.example.com/v1', remoteModel: 'big-1', apiKeyEnv: 'SKEINWISE_REMOTE_API_KEY', remoteHosts: ['models.example.com'] }), 'remote', {
      fetch: server.fetch,
      env: { SKEINWISE_REMOTE_API_KEY: keyShaped('s', 'k-test-made-up-0123456789abcdef') },
    });
    const pieces: string[] = [];
    await client.stream({ purpose: 'p', system: 's', user: 'u', maxTokens: 50, check: (a) => a }, { onText: (p) => pieces.push(p) });
    expect(pieces).toEqual([]);
    expect(server.chats()[0]!.body!.stream).toBeUndefined();
  });

  it('reads an answer wrapped in a thinking block or a code fence, and nothing looser', () => {
    expect(parseAnswer('x', '<think>hmm</think>\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(() => parseAnswer('x', 'Here: {"a": 1}')).toThrow(/not JSON/);
  });

  it('says how to start a local model when none answers, and starts no run', async () => {
    const server = fakeServer(() => '{}', { down: true });
    const client = createModel(config(), 'local', { fetch: server.fetch, env: {} });
    const err = await runTask(store, new RecordView(store), options('hub', client)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect((err as Error).message).toMatch(/No model server answers at http:\/\/127\.0\.0\.1:8731\/v1/);
    expect((err as Error).message).toMatch(/llama-server -m <model>\.gguf --port 8731/);
    expect((err as Error).message).toMatch(/--engine none/);
    expect(listRuns(store.db)).toHaveLength(0);
  });

  it('checks the local model name against the server, and keeps the local engine on this computer', async () => {
    const server = fakeServer(() => '{}', { models: ['qwen3:4b'] });
    const client = createModel(config({ localModel: 'llama3' }), 'local', { fetch: server.fetch, env: {} });
    await expect(client.probe()).rejects.toThrow(/no model "llama3". It has: qwen3:4b/);
    expect(() => createModel(config({ localUrl: 'http://192.168.1.20:8731/v1' }), 'local', { fetch: server.fetch, env: {} })).toThrow(/not on this computer/);
  });

  it('redacts what goes to an outside server and puts it back in the answer', async () => {
    add('call.md', 'Called Sam about the rye loaf, write to sam@example.com or +44 20 7946 0958. The sourdough starter needs Sam.', 'Bread call');
    const server = fakeServer((u) => {
      const name = /\[NAME_\d+\]/.exec(u)?.[0] ?? 'nobody';
      // Cites the sentence that names the person, since a hub line must stand on what it cites.
      const naming = /^(S\d+) .*\[NAME_\d+\]/m.exec(u)?.[1];
      return hubAnswer(u, naming ? { inShort: `Baking with ${name}.`, cites: [naming] } : { inShort: 'River notes.' });
    });
    const client = createModel(config({ remoteUrl: 'https://models.example.net/v1', remoteModel: 'big-1', apiKeyEnv: 'SKEINWISE_TEST_KEY', remoteHosts: ['models.example.net'], names: ['Sam'] }), 'remote', {
      fetch: server.fetch,
      env: { SKEINWISE_TEST_KEY: 'secret-key-123' },
    });
    expect(client.redacts).toBe(true);
    const run = await runTask(store, new RecordView(store), options('hub', client));
    expect(run).toMatchObject({ status: 'done', engine: 'remote', model: 'big-1' });

    const sent = server.chats().map((c) => JSON.stringify(c.body)).join('\n');
    expect(sent).not.toMatch(/Sam|sam@example|7946/);
    expect(sent).toMatch(/\[NAME_1\]/);
    expect(sent).toMatch(/placeholders like \[NAME_1\]/);
    expect(server.chats()[0]!.headers.authorization).toBe('Bearer secret-key-123');
    expect(server.calls.some((c) => c.url.endsWith('/models'))).toBe(false);

    const said = liveHubs(store.db).flatMap((h) => h.sections.in_short.map((i) => i.text));
    expect(said).toContain('Baking with Sam.');
    expect(said.join(' ')).not.toMatch(/\[[A-Z]+_\d+\]/);
  });

  it('shows the redacted requests with --preview, and sends nothing', () => {
    add('call.md', 'Called Sam about the rye loaf at 221 Baker Street. Sam keeps the sourdough starter going.', 'Bread call');
    const server = fakeServer(() => '{}');
    const client = createModel(config({ remoteUrl: 'https://models.example.net/v1', remoteModel: 'big-1', apiKeyEnv: 'SKEINWISE_TEST_KEY', remoteHosts: ['models.example.net'], names: ['Sam'] }), 'remote', {
      fetch: server.fetch,
      env: { SKEINWISE_TEST_KEY: 'k' },
    });
    const preview = previewRun(store, new RecordView(store), options('hub', client));
    expect(preview).toMatchObject({ task: 'hub', engine: 'remote', model: 'big-1', entries: 13 });
    expect(preview.requests.length).toBeGreaterThan(1);
    const text = preview.requests.map((r) => r.user).join('\n');
    expect(text).toMatch(/\[NAME_1\]/);
    expect(text).toMatch(/\[ADDRESS_1\]/);
    expect(text).not.toMatch(/Sam|Baker/);
    expect(preview.estimate).toBeGreaterThan(1800);
    expect(server.calls).toHaveLength(0);
    expect(listRuns(store.db)).toHaveLength(0);
  });

  it('keeps an outside model inside the monthly budget', async () => {
    const remote = { remoteUrl: 'https://models.example.net/v1', remoteModel: 'big-1', apiKeyEnv: 'SKEINWISE_TEST_KEY', remoteHosts: ['models.example.net'] };
    const small = fakeServer((u) => hubAnswer(u));
    const client = createModel(config(remote), 'remote', { fetch: small.fetch, env: { SKEINWISE_TEST_KEY: 'k' } });
    // Too small for the estimate: refused before anything is sent.
    await expect(runTask(store, new RecordView(store), options('hub', client, { budget: 500 }))).rejects.toThrow(
      /needs about \d+ tokens, and 500 of the outside model's monthly budget of 500 is left/,
    );
    expect(small.calls).toHaveLength(0);
    expect(listRuns(store.db)).toHaveLength(0);

    // Big enough for the estimate, but the first answer uses more than is left: the run stops and saves nothing.
    const greedy = fakeServer((u) => hubAnswer(u), { usage: { prompt_tokens: 4000, completion_tokens: 1000 } });
    const spender = createModel(config(remote), 'remote', { fetch: greedy.fetch, env: { SKEINWISE_TEST_KEY: 'k' } });
    await expect(runTask(store, new RecordView(store), options('hub', spender, { budget: 4000 }))).rejects.toThrow(/budget of 4000 is spent\. Nothing was saved/);
    expect(greedy.chats()).toHaveLength(1);
    expect(listRuns(store.db)[0]).toMatchObject({ status: 'failed', tokensIn: 4000, tokensOut: 1000 });
    expect(liveHubs(store.db)).toHaveLength(0);

    // The spent tokens count against the month.
    await expect(runTask(store, new RecordView(store), options('hub', spender, { budget: 6000 }))).rejects.toThrow(/1000 of the outside model's monthly budget of 6000 is left/);
  });

  it('refuses a remote engine that is missing settings or its key', () => {
    const deps = { fetch: fakeServer(() => '{}').fetch, env: {} };
    expect(() => createModel(config(), 'remote', deps)).toThrow(/needs more settings:[\s\S]*remoteUrl[\s\S]*remoteModel[\s\S]*apiKeyEnv/);
    const set = config({ remoteUrl: 'https://models.example.net/v1', remoteModel: 'm', apiKeyEnv: 'SKEINWISE_TEST_KEY', remoteHosts: ['models.example.net'] });
    expect(() => createModel(set, 'remote', deps)).toThrow(/SKEINWISE_TEST_KEY is not set/);
    expect(() => createModel({ ...set, remoteUrl: 'http://models.example.net/v1' }, 'remote', { ...deps, env: { SKEINWISE_TEST_KEY: 'k' } })).toThrow(/must use https/);
  });

  it('never shows the key in an error from the server', async () => {
    const fetch = (async () => new Response('bad key secret-key-123', { status: 401, statusText: 'Unauthorized' })) as unknown as typeof globalThis.fetch;
    const client = createModel(config({ remoteUrl: 'https://models.example.net/v1', remoteModel: 'm', apiKeyEnv: 'SKEINWISE_TEST_KEY', remoteHosts: ['models.example.net'] }), 'remote', {
      fetch,
      env: { SKEINWISE_TEST_KEY: 'secret-key-123' },
    });
    const err = (await runTask(store, new RecordView(store), options('hub', client)).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/answered 401 Unauthorized during hub 1 of 2: bad key \*\*\*/);
    expect(err.message).not.toMatch(/secret/);
    expect(listRuns(store.db)[0]!.message).not.toMatch(/secret/);
  });

  it('asks for --yes before sending more than 500 entries', async () => {
    for (let i = 0; i < 490; i++) add(`n${i}.md`, `Entry ${i} about the rye loaf and the sourdough starter, with enough words to go to the model for its layers today.`);
    const server = fakeServer(() => '{}');
    const client = createModel(config(), 'local', { fetch: server.fetch, env: {} });
    await expect(runTask(store, new RecordView(store), options('layer', client))).rejects.toThrow(/about 502 entries to the first model at http:\/\/127\.0\.0\.1:8731\/v1: about \d+ tokens\. Add --yes/);
    expect(server.calls).toHaveLength(0);
  });

  it('writes Expanded, Digest and Ideas from the model, and records which model wrote them', async () => {
    add('plan.md', 'The plan for the rye loaf this spring is to bake twice a week, keep the sourdough starter warmer and write down every bake.', 'Bake plan');
    add('crumb.md', 'Long note on the crumb of the sourdough loaf, how the proof time and the oven heat change it, and what to try next.', 'Crumb');
    const server = fakeServer((u) =>
      JSON.stringify({
        entries: [...u.matchAll(/^E(\d+):$/gm)].map((m) => ({ id: `E${m[1]}`, expanded: `Entry ${m[1]} in full.`, digest: '', ideas: m[1] === '13' ? ['Bake twice a week.'] : [] })),
      }),
    );
    const client = createModel(config(), 'local', { fetch: server.fetch, env: {} });
    const run = await runTask(store, new RecordView(store), options('layer', client));
    expect(run.counts).toMatchObject({ entries: 14, expanded: 2, ideas: 1, byModel: 2 });
    expect(server.chats()).toHaveLength(1);
    expect(entryLayers(store.db, 13).map((l) => [l.layer, l.body, l.engine, l.model])).toEqual([
      ['expanded', 'Entry 13 in full.', 'local', 'models/fake-4b.gguf'],
      ['ideas', '- Bake twice a week.', 'local', 'models/fake-4b.gguf'],
    ]);
  });

  // The security audit's findings on what leaves the computer. Every key and address here is made up, and the only
  // servers are fakes, in the test or on 127.0.0.1.
  describe('what leaves the computer', () => {
    // Key-shaped samples are joined at run time (test/samples.ts).
    const KEY = keyShaped('s', 'k-test-made-up-0123456789abcdef');
    const GITHUB = keyShaped('gh', 'p_fake0123456789abcdefghijklmnopqrstuv');
    const AWS_ID = keyShaped('AK', 'IAFAKE0123456789AB');
    const remote = (over: Partial<Config> = {}) =>
      config({
        remoteUrl: 'https://models.example.net/v1',
        remoteModel: 'big-1',
        apiKeyEnv: 'SKEINWISE_TEST_KEY',
        remoteHosts: ['models.example.net'],
        ...over,
      });
    const env = { SKEINWISE_TEST_KEY: KEY };

    // M10: a remote URL on this computer (a proxy, a tunnel) skipped redaction.
    it('redacts for the remote engine even when its URL is on this computer', async () => {
      add('call.md', `Called Sam about the rye loaf, sam@example.com, and the deploy key ${GITHUB}.`, 'Bread call');
      const server = fakeServer((u) => hubAnswer(u));
      const client = createModel(remote({ remoteUrl: 'http://127.0.0.1:4000/v1', remoteHosts: ['127.0.0.1:4000'], names: ['Sam'] }), 'remote', {
        fetch: server.fetch,
        env,
      });
      expect(client.redacts).toBe(true);
      await runTask(store, new RecordView(store), options('hub', client));
      const sent = server.chats().map((c) => JSON.stringify(c.body)).join('\n');
      expect(sent).not.toMatch(/Sam|sam@example|ghp_/);
    });

    // M9 with redaction off: a person's details go as written, secrets never do.
    it('replaces secrets for the remote engine when redaction is off', async () => {
      add('deploy.md', `Rye loaf deploy notes: password=Hunter2-not-real and ${AWS_ID}, ask Sam.`, 'Bread deploy');
      const server = fakeServer((u) => hubAnswer(u));
      const client = createModel(remote({ redaction: false, names: ['Sam'] }), 'remote', { fetch: server.fetch, env });
      await runTask(store, new RecordView(store), options('hub', client));
      const sent = server.chats().map((c) => JSON.stringify(c.body)).join('\n');
      expect(sent).not.toMatch(/Hunter2/);
      expect(sent).not.toContain(AWS_ID);
      expect(sent).toMatch(/\[SECRET_\d+\]/);
      expect(sent).toMatch(/ask Sam/);
    });

    // M11: the key went to whatever host remoteUrl named, from whatever variable apiKeyEnv named.
    it('sends the key only to a confirmed host, and only from a variable named for a key', async () => {
      const server = fakeServer((u) => hubAnswer(u));
      const unconfirmed = createModel(remote({ remoteUrl: 'https://collector.example.org/v1' }), 'remote', { fetch: server.fetch, env });
      await expect(unconfirmed.probe()).rejects.toThrow(/only goes to hosts you confirmed, and collector\.example\.org isn't one[\s\S]*skeinwise model trust collector\.example\.org/);
      await expect(runTask(store, new RecordView(store), options('hub', unconfirmed))).rejects.toThrow(UsageError);
      expect(server.calls).toHaveLength(0);
      expect(listRuns(store.db)).toHaveLength(0);
      // A port is part of the host: the same name on another port is another server.
      const otherPort = createModel(remote({ remoteUrl: 'https://models.example.net:8443/v1' }), 'remote', { fetch: server.fetch, env });
      await expect(otherPort.probe()).rejects.toThrow(/models\.example\.net:8443 isn't one/);
      // A config built in code is checked too, not only the settings file.
      expect(() => createModel(remote({ apiKeyEnv: 'GITHUB_TOKEN' }), 'remote', { fetch: server.fetch, env: { GITHUB_TOKEN: 'made-up' } })).toThrow(
        /starts with SKEINWISE_ or ends with _API_KEY, not GITHUB_TOKEN/,
      );
      expect(server.calls).toHaveLength(0);
    });

    // M13 and L16: modelOptions was spread last, so it could swap the model, the messages and the length.
    it('lets modelOptions set sampling only, and never raise the length', async () => {
      const server = fakeServer((u) => hubAnswer(u));
      const client = createModel(remote({ modelOptions: { temperature: 0.3, max_tokens: 100 } }), 'remote', { fetch: server.fetch, env });
      await runTask(store, new RecordView(store), options('hub', client));
      const body = server.chats()[0]!.body!;
      expect(body).toMatchObject({ model: 'big-1', temperature: 0.3, max_tokens: 100, response_format: { type: 'json_object' } });
      expect(body.messages[0]!.role).toBe('system');

      const roomy = fakeServer((u) => hubAnswer(u));
      await runTask(store, new RecordView(store), options('hub', createModel(remote({ modelOptions: { max_tokens: 100_000 } }), 'remote', { fetch: roomy.fetch, env })));
      expect(roomy.chats()[0]!.body!.max_tokens).toBeLessThan(100_000);

      const hijack = remote({ modelOptions: { n: 64, model: 'other', stream: true } as unknown as Config['modelOptions'] });
      const sneaky = fakeServer((u) => hubAnswer(u));
      await expect(runTask(store, new RecordView(store), options('hub', createModel(hijack, 'remote', { fetch: sneaky.fetch, env })))).rejects.toThrow(
        /modelOptions may only hold temperature, top_p and max_tokens/,
      );
      expect(sneaky.calls).toHaveLength(0);
    });

    // L11: a redirect was followed with the key still on the request.
    it('never follows a redirect, so the key stays with the confirmed host', async () => {
      const seen: IncomingMessage['headers'][] = [];
      const collector = await listen((req, res) => {
        seen.push(req.headers);
        res.end('{}');
      });
      const redirector = await listen((_req, res) => {
        res.writeHead(307, { location: `http://127.0.0.1:${port(collector)}/v1/chat/completions` }).end();
      });
      try {
        const url = `http://127.0.0.1:${port(redirector)}/v1`;
        const client = createModel(remote({ remoteUrl: url, remoteHosts: [`127.0.0.1:${port(redirector)}`] }), 'remote', { fetch, env });
        const err = (await runTask(store, new RecordView(store), options('hub', client)).catch((e: unknown) => e)) as Error;
        expect(err.message).toMatch(/answered with a redirect, which Skeinwise never follows/);
        expect(seen).toHaveLength(0);
      } finally {
        collector.close();
        redirector.close();
      }
    });

    // L12: the key and secrets came back in errors from a server that echoed the request.
    it('keeps the key and secrets out of every error and the runs table', async () => {
      const echo = (async (_url: string | URL | Request, init?: RequestInit) =>
        Response.json({
          choices: [{ message: { content: `not json; you sent ${String((init?.headers as Record<string, string>).authorization)} and ${GITHUB}` } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        })) as typeof globalThis.fetch;
      const client = createModel(remote(), 'remote', { fetch: echo, env });
      const progress: string[] = [];
      const run = await runTask(store, new RecordView(store), options('hub', client, { progress: (l) => progress.push(l) }));
      expect(progress.join('\n')).toMatch(/is not JSON/);
      for (const text of [...progress, run.message ?? '']) {
        expect(text).not.toContain(KEY);
        expect(text).not.toContain('ghp_');
      }

      const garbled = (async () => new Response(`<html>bad gateway for ${KEY}</html>`)) as unknown as typeof globalThis.fetch;
      const again = (await runTask(store, new RecordView(store), options('hub', createModel(remote(), 'remote', { fetch: garbled, env }))).catch((e: unknown) => e)) as Error;
      expect(again.message).toMatch(/isn't a chat completion/);
      expect(again.message).not.toContain(KEY);
    });

    // LS-15: negative or missing usage, and timeouts, let a run spend without counting it. E2 (Deniz, Nov 25): so did a
    // report of 0. A report of 0 or less counts exactly what a missing one does: our own estimate.
    it('counts usage that is zero, negative, missing or cut off by a timeout', async () => {
      const silent = (async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init!.body)) as { messages: { content: string }[] };
        return Response.json({ choices: [{ message: { content: hubAnswer(body.messages[1]!.content) }, finish_reason: 'stop' }] });
      }) as typeof globalThis.fetch;
      const counted = await runTask(store, new RecordView(store), options('hub', createModel(remote(), 'remote', { fetch: silent, env })));
      expect(counted.tokensIn).toBeGreaterThan(0);
      expect(counted.tokensOut).toBeGreaterThan(0);

      for (const figure of [0, -5000]) {
        const lying = fakeServer((u) => hubAnswer(u), { usage: { prompt_tokens: figure, completion_tokens: figure } });
        const run = await runTask(store, new RecordView(store), options('hub', createModel(remote(), 'remote', { fetch: lying.fetch, env })));
        expect({ figure, tokensIn: run.tokensIn, tokensOut: run.tokensOut }).toEqual({ figure, tokensIn: counted.tokensIn, tokensOut: counted.tokensOut });
      }

      let maxTokens = 0;
      const slow = (async (_url: string | URL | Request, init?: RequestInit) => {
        maxTokens = (JSON.parse(String(init!.body)) as { max_tokens: number }).max_tokens;
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }) as typeof globalThis.fetch;
      const err = await runTask(store, new RecordView(store), options('hub', createModel(remote(), 'remote', { fetch: slow, env }))).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ModelTimeoutError);
      expect((err as Error).message).toMatch(/took longer than 10 minutes[\s\S]*counts in full against the budget/);
      expect(listRuns(store.db)[0]).toMatchObject({ status: 'failed', tokensOut: maxTokens });
      expect(listRuns(store.db)[0]!.tokensIn).toBeGreaterThan(0);
    });

    // LS-09: the local client sends the key `skeinwise model serve` started llama-server with.
    it('sends the local server its key, and says how to start one that takes it', async () => {
      const home = mkdtempSync(join(tmpdir(), 'skeinwise-model-'));
      try {
        mkdirSync(join(home, 'models'));
        writeFileSync(serverKeyPath(home), 'made-up-local-key\n', { mode: 0o600 });
        const server = fakeServer((u) => hubAnswer(u));
        await runTask(store, new RecordView(store), options('hub', createModel(config(), 'local', { fetch: server.fetch, env: { SKEINWISE_HOME: home } })));
        expect(server.calls.map((c) => c.headers.authorization)).toEqual(server.calls.map(() => 'Bearer made-up-local-key'));

        const refuses = (async () => new Response('{"error":"Invalid API Key"}', { status: 401 })) as unknown as typeof globalThis.fetch;
        await expect(createModel(config(), 'local', { fetch: refuses, env: {}, home }).probe()).rejects.toThrow(/wants a key[\s\S]*skeinwise model serve --run/);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  });
});

describe('redaction', () => {
  it('replaces emails, phone numbers, addresses, health words and listed names, and keeps dates', () => {
    const r = new Redactor(['Sam Okafor', 'Sam']);
    const out = r.redact('Mail sam@example.com or call +44 20 7946 0958 on 2026-04-05. Sam Okafor lives at 221B Baker Street. Sam has anxiety.');
    expect(out).toBe('Mail [EMAIL_1] or call [PHONE_1] on 2026-04-05. [NAME_1] lives at [ADDRESS_1]. [NAME_2] has [HEALTH_1].');
    expect(r.restore({ list: ['[NAME_2] and [HEALTH_1]', '[NAME_9]'] })).toEqual({ list: ['Sam and anxiety', '[NAME_9]'] });
    expect(new Redactor([]).redact('Version 1.2.3 at 12:30, order 1234567, 2026-04-05 to 2026-04-06.')).toBe(
      'Version 1.2.3 at 12:30, order 1234567, 2026-04-05 to 2026-04-06.',
    );
  });
});

function listen(handler: Parameters<typeof createServer>[1]): Promise<Server> {
  const server = createServer(handler);
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server)));
}

function port(server: Server): number {
  return (server.address() as { port: number }).port;
}
