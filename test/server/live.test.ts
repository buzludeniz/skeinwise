import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../src/cli.ts';
import { loadConfig, saveConfig } from '../../src/config.ts';
import { type Running, startServer } from '../../src/server/serve.ts';

// Record live from the app menu: the switch runs the same update stream as `skeinwise live` inside the server, over a
// pretend home directory, and the status carries the stream's own two lines.

let dir: string;
let home: string;
let scan: string;
let app: Running;

const line = (type: 'user' | 'assistant', i: number, text: string) =>
  JSON.stringify({
    type,
    sessionId: 's1',
    uuid: `u${i}`,
    timestamp: `2026-11-20T10:0${i}:00.000Z`,
    message: type === 'user' ? { role: 'user', content: text } : { role: 'assistant', content: [{ type: 'text', text }] },
  }) + '\n';

async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${app.port}/api/${path}`, {
    method: init.method ?? 'GET',
    headers: { 'X-Skeinwise-Token': app.token, 'Content-Type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

interface LiveState {
  on: boolean;
  lines: [string, string] | null;
  error: string | null;
}

async function liveState(until: (s: LiveState) => boolean): Promise<LiveState> {
  for (let i = 0; i < 100; i++) {
    const { live } = await api<{ live: LiveState }>('status');
    if (until(live)) return live;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('Record live never got there');
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'skeinwise-live-app-'));
  home = join(dir, 'home');
  expect(await main(['demo'], { out: () => undefined, err: () => undefined, env: { SKEINWISE_HOME: home } })).toBe(0);
  // No model and no background organising: this file is about capture and the status lines.
  saveConfig(home, { ...loadConfig(home), engine: 'none', liveOrganise: false });
  scan = join(dir, 'scan');
  mkdirSync(join(scan, '.claude', 'projects', '-home-me-code'), { recursive: true });
  writeFileSync(
    join(scan, '.claude', 'projects', '-home-me-code', 's1.jsonl'),
    line('user', 1, 'Plan the allotment map') + line('assistant', 2, 'Start with the plots'),
  );
  app = await startServer({ home, port: 0, webDir: null, scanRoot: scan });
});

afterAll(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Record live', () => {
  it('is off, with no lines, until it has run', async () => {
    expect(await liveState(() => true)).toEqual({ on: false, lines: null, error: null });
  });

  it('catches up from the pretend home when switched on, and says so in two lines', async () => {
    const before = (await api<{ entries: number }>('status')).entries;
    await api('settings', { method: 'PUT', body: { recordLive: true } });
    const live = await liveState((s) => s.on);
    expect(live.lines).toEqual(['saved just now', 'caught up 1 chat from Claude Code']);
    expect((await api<{ entries: number }>('status')).entries).toBe(before + 2);
  });

  it('stops when switched off, and keeps the last lines', async () => {
    await api('settings', { method: 'PUT', body: { recordLive: false } });
    const live = await liveState((s) => !s.on);
    expect(live.lines?.[0]).toBe('saved just now');
  });
});
