// GET /api/ask/stream through the app: the same checks as every API call (token, lock), then the events. The record
// is the demo, with No-AI, so nothing reaches a model server; test/server/ask-stream.test.ts streams a model's answer.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '../../src/cli.ts';
import { loadConfig, saveConfig } from '../../src/config.ts';
import type { AskStreamEvent } from '../../src/server/ask-stream.ts';
import { type Running, startServer } from '../../src/server/serve.ts';

let dir: string;
let app: Running;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'skeinwise-ask-route-'));
  const home = join(dir, 'home');
  expect(await main(['demo'], { out: () => undefined, err: () => undefined, env: { SKEINWISE_HOME: home } })).toBe(0);
  saveConfig(home, { ...loadConfig(home), engine: 'none' });
  app = await startServer({ home, port: 0, webDir: null, scanRoot: join(dir, 'scan') });
});
afterAll(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = (path: string, token: string | null = app.token) =>
  fetch(`http://127.0.0.1:${app.port}/api/${path}`, { headers: token ? { 'X-Skeinwise-Token': token } : {} });

describe('GET /api/ask/stream', () => {
  it('streams the entries, then the answer, as server-sent events', async () => {
    const res = await get('ask/stream?q=what%20did%20I%20decide%20about%20sqlite');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    const events = (await res.text())
      .split('\n\n')
      .filter(Boolean)
      .map((block) => JSON.parse(block.replace(/^data: /, '')) as AskStreamEvent);
    expect(events.map((e) => e.type)).toEqual(['hits', 'done']);
    const done = events[1] as Extract<AskStreamEvent, { type: 'done' }>;
    expect(done.result.hits.length).toBeGreaterThan(0);
    expect(done.result).toMatchObject({ engine: 'none', answer: null });
  });

  it('is refused like any other call: no token, no question, an unknown engine', async () => {
    const cases: [string, string | null, number, RegExp][] = [
      ['ask/stream?q=sqlite', null, 401, /token/],
      ['ask/stream?q=%20', app.token, 400, /Ask a question/],
      [`ask/stream?q=${'x'.repeat(2001)}`, app.token, 413, /too long/],
      ['ask/stream?q=sqlite&engine=bogus', app.token, 400, /Unknown engine "bogus"/],
    ];
    for (const [path, token, status, error] of cases) {
      const res = await get(path, token);
      expect([path, res.status]).toEqual([path, status]);
      expect(((await res.json()) as { error: string }).error).toMatch(error);
    }
  });
});
