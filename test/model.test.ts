import { beforeEach, describe, expect, it } from 'vitest';
import { type Config, DEFAULT_CONFIG } from '../src/config.ts';
import { UsageError } from '../src/errors.ts';
import { createModel, parseAnswer } from '../src/organiser/model.ts';
import { previewRun, type RunOptions, runTask } from '../src/organiser/organise.ts';
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
function hubAnswer(user: string, extra: { inShort?: string } = {}): string {
  const name = /rye|sourdough|loaf/.test(user) ? 'Rye baking' : 'River samples';
  return JSON.stringify({
    name,
    in_short: [{ text: extra.inShort ?? `Notes on ${name.toLowerCase()}.`, cites: ['S1', 'S2'] }],
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
    expect(body).toMatchObject({ model: 'models/fake-4b.gguf', temperature: 0, response_format: { type: 'json_object' }, chat_template_kwargs: { enable_thinking: false } });
    expect(server.chats()[0]!.headers.authorization).toBeUndefined();
  });

  it('fails the run and saves nothing when an answer is not JSON, or does not fit', async () => {
    const prose = fakeServer(() => 'Sure! The subject is rye baking.');
    const client = createModel(config(), 'local', { fetch: prose.fetch, env: {} });
    await expect(runTask(store, new RecordView(store), options('hub', client))).rejects.toThrow(/answer for hub 1 of 2 is not JSON: Sure!/);
    let run = listRuns(store.db)[0]!;
    expect(run).toMatchObject({ status: 'failed', tokensIn: 100, tokensOut: 20 });
    expect(run.message).toMatch(/not JSON/);
    expect(liveHubs(store.db)).toHaveLength(0);

    const unshown = fakeServer((u) => hubAnswer(u).replace('"S2"]', '"S99"]'));
    await expect(runTask(store, new RecordView(store), options('hub', createModel(config(), 'local', { fetch: unshown.fetch, env: {} })))).rejects.toThrow(
      /cites "S99", which it wasn't shown/,
    );
    run = listRuns(store.db)[0]!;
    expect(run.status).toBe('failed');
    expect(liveHubs(store.db)).toHaveLength(0);
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
      return hubAnswer(u, { inShort: /rye/.test(u) ? `Baking with ${name}.` : 'River notes.' });
    });
    const client = createModel(config({ remoteUrl: 'https://models.example.net/v1', remoteModel: 'big-1', apiKeyEnv: 'SW_KEY', names: ['Sam'] }), 'remote', {
      fetch: server.fetch,
      env: { SW_KEY: 'secret-key-123' },
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
    const client = createModel(config({ remoteUrl: 'https://models.example.net/v1', remoteModel: 'big-1', apiKeyEnv: 'SW_KEY', names: ['Sam'] }), 'remote', {
      fetch: server.fetch,
      env: { SW_KEY: 'k' },
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
    const remote = { remoteUrl: 'https://models.example.net/v1', remoteModel: 'big-1', apiKeyEnv: 'SW_KEY' };
    const small = fakeServer((u) => hubAnswer(u));
    const client = createModel(config(remote), 'remote', { fetch: small.fetch, env: { SW_KEY: 'k' } });
    // Too small for the estimate: refused before anything is sent.
    await expect(runTask(store, new RecordView(store), options('hub', client, { budget: 500 }))).rejects.toThrow(
      /needs about \d+ tokens, and 500 of the outside model's monthly budget of 500 is left/,
    );
    expect(small.calls).toHaveLength(0);
    expect(listRuns(store.db)).toHaveLength(0);

    // Big enough for the estimate, but the first answer uses more than is left: the run stops and saves nothing.
    const greedy = fakeServer((u) => hubAnswer(u), { usage: { prompt_tokens: 4000, completion_tokens: 1000 } });
    const spender = createModel(config(remote), 'remote', { fetch: greedy.fetch, env: { SW_KEY: 'k' } });
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
    const set = config({ remoteUrl: 'https://models.example.net/v1', remoteModel: 'm', apiKeyEnv: 'SW_KEY' });
    expect(() => createModel(set, 'remote', deps)).toThrow(/SW_KEY is not set/);
    expect(() => createModel({ ...set, remoteUrl: 'http://models.example.net/v1' }, 'remote', { ...deps, env: { SW_KEY: 'k' } })).toThrow(/must use https/);
  });

  it('never shows the key in an error from the server', async () => {
    const fetch = (async () => new Response('bad key secret-key-123', { status: 401, statusText: 'Unauthorized' })) as unknown as typeof globalThis.fetch;
    const client = createModel(config({ remoteUrl: 'https://models.example.net/v1', remoteModel: 'm', apiKeyEnv: 'SW_KEY' }), 'remote', {
      fetch,
      env: { SW_KEY: 'secret-key-123' },
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
