import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allowAgent, type Scope, setLocked } from '../../src/mcp/access.ts';
import { MCP_COMMANDS, memoryServer } from '../../src/mcp/commands.ts';
import { LOG_FILE, type LogRecord, logCall, MAX_LOG_BYTES, OLD_LOG_FILE, readLog } from '../../src/mcp/log.ts';
import type { McpServer } from '../../src/mcp/protocol.ts';
import type { Caller } from '../../src/mcp/session.ts';
import type { Store } from '../../src/store/store.ts';
import { keyShaped } from '../samples.ts';
import { call, context, demoRecord, initialize } from './helpers.ts';

// The MCP log (MCP-7): every call an agent makes, served or refused, as one line in mcp-log.jsonl.

const NOW = '2026-11-25T10:00:00.000Z';
let dir: string;
let home: string;
let store: Store;

async function open(agent: string, scope: Scope = 'read', label: string | null = agent): Promise<McpServer<Caller>> {
  const token = allowAgent(home, agent, NOW, scope).token;
  const s = memoryServer(context(home, store, { now: () => NOW, token }).ctx);
  await initialize(s, label);
  return s;
}

const records = (): LogRecord[] =>
  readFileSync(join(home, LOG_FILE), 'utf8')
    .trimEnd()
    .split('\n')
    .map((l) => JSON.parse(l) as LogRecord);

async function mcpLog(values: Record<string, unknown> = {}) {
  const { ctx, output } = context(home, store, { args: ['log'], values, now: () => NOW });
  expect(await MCP_COMMANDS.mcp!(ctx)).toBe(0);
  return output;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skeinwise-mcp-log-'));
  home = join(dir, 'home');
  store = demoRecord(dir, home);
});

afterEach(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the MCP log', () => {
  it('records each call: the agent from its token, its label, the tool, the arguments, the ids sent and the bytes', async () => {
    const s = await open('cursor', 'write', 'claude-code');
    const found = await call(s, 'search', { query: 'starter', limit: 3 });
    const ids = found.json.entries.map((e: { id: number }) => e.id);
    const note = await call(s, 'write_note', { title: 'Plan', body: 'Bake on Sunday.' });
    await call(s, 'list_hubs');
    const [search, write, hubs] = records();
    expect(search).toEqual({
      at: NOW,
      agent: 'cursor',
      label: 'claude-code',
      tool: 'search',
      args: { query: 'starter', limit: 3 },
      entry_ids: ids,
      bytes: Buffer.byteLength(found.text),
      truncated: false,
      outcome: 'ok',
    });
    expect(write).toMatchObject({ agent: 'cursor', tool: 'write_note', entry_ids: [note.json.entry_id], outcome: 'ok' });
    expect(hubs).toMatchObject({ tool: 'list_hubs', outcome: 'ok' });
    expect(hubs!.entry_ids).toBeUndefined();
    expect(statSync(join(home, LOG_FILE)).mode & 0o777).toBe(0o600);
  });

  it('records refusals: no token, the read scope, the lock', async () => {
    const reader = await open('reader');
    await call(reader, 'write_note', { title: 'x', body: 'y' });
    const stranger = memoryServer(context(home, store, { now: () => NOW }).ctx);
    await initialize(stranger, 'claude-code');
    await call(stranger, 'search', { query: 'starter' });
    setLocked(home, true);
    const locked = await call(reader, 'search', { query: 'starter' });
    expect(locked.text).toMatch(/locked/);
    const [scope, noToken, lock] = records();
    expect(scope).toMatchObject({ agent: 'reader', tool: 'write_note', outcome: 'refused', reason: expect.stringMatching(/^not allowed: read scope/), bytes: 0 });
    expect(noToken).toMatchObject({ agent: null, label: 'claude-code', tool: 'search', outcome: 'refused', reason: expect.stringMatching(/has no Skeinwise token/) });
    expect(lock).toMatchObject({ agent: null, tool: 'search', outcome: 'refused', reason: expect.stringMatching(/locked/) });
  });

  it('records a bad call as an error, and keeps arguments short and free of keys', async () => {
    const s = await open('writer', 'write');
    const key = keyShaped('gh', 'p_', 'Zq4mW8rT2xK9bN3vL6pY1sD5fH7jC0aE3gU8');
    await call(s, 'search', { query: 'starter', limit: 99 });
    await call(s, 'write_note', { title: 'Keys', body: `${key} ${'z'.repeat(5000)}` });
    const [bad, long] = records();
    expect(bad).toMatchObject({ outcome: 'error', reason: 'limit must be a whole number from 1 to 20.' });
    const body = (long!.args as { body: string }).body;
    expect(body).toMatch(/^\[SECRET_\d+\] z+… \(\d+ characters\)$/);
    expect(body.length).toBeLessThan(240);
    expect(readFileSync(join(home, LOG_FILE), 'utf8')).not.toContain(key);
  });

  it('refuses the call when the log cannot be written', async () => {
    const s = await open('reader');
    // A folder where the log file should be: appending fails.
    mkdirSync(join(home, LOG_FILE));
    const res = await call(s, 'search', { query: 'starter' });
    expect(res.isError).toBe(true);
    expect(res.text).toBe("Skeinwise couldn't write its MCP log (mcp-log.jsonl: EISDIR), so it sent no result.");
  });

  it('moves a full log aside, keeping the one before it', () => {
    const big: LogRecord = { at: NOW, agent: 'a', label: null, tool: 'search', args: { query: 'x'.repeat(1000) }, bytes: 1, truncated: false, outcome: 'ok' };
    const per = Buffer.byteLength(`${JSON.stringify(big)}\n`);
    const n = Math.ceil(MAX_LOG_BYTES / per) + 5;
    for (let i = 0; i < n; i += 1) logCall(home, { ...big, bytes: i });
    expect(statSync(join(home, LOG_FILE)).size).toBeLessThan(MAX_LOG_BYTES);
    expect(statSync(join(home, OLD_LOG_FILE)).size).toBeGreaterThanOrEqual(MAX_LOG_BYTES);
    expect(readLog(home, 10).map((r) => r.bytes)).toEqual(Array.from({ length: 10 }, (_, i) => n - 10 + i));
    expect(readLog(home, n).map((r) => r.bytes)).toEqual(Array.from({ length: n }, (_, i) => i));
  });
});

describe('skeinwise mcp log', () => {
  it('lists the last calls, newest last, with --limit and --json, and prints what agents sent safely', async () => {
    expect((await mcpLog()).out).toBe('No agent has called a Skeinwise tool yet.\n');
    const s = await open('cursor', 'read', 'evil\u001b]8;;https://x.example\u0007name');
    await call(s, 'search', { query: 'starter', limit: 2 });
    await call(s, 'write_note', { title: 'x', body: 'y' });
    await call(s, 'search', { query: 'rye\u001b[2J' });
    const text = (await mcpLog({ limit: '2' })).out;
    const lines = text.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^2026-11-25 10:00:00 {2}cursor \(calls itself "evil[^"]*name"\) {2}write_note \{.*\} {2}refused: not allowed: read scope/);
    expect(lines[1]).toMatch(/ {2}search \{"query":"rye\\u001b\[2J"\} {2}(entries [\d, ]+|no entries), \d+\.\d KB$/);
    expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
    const json = (await mcpLog({ json: true, limit: '3' })).json[0] as LogRecord[];
    expect(json.map((r) => r.tool)).toEqual(['search', 'write_note', 'search']);
  });
});
