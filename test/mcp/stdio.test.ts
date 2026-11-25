import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openHome } from '../../src/home.ts';
import { allowAgent } from '../../src/mcp/access.ts';
import { demoRecord, LEGACY_VERSION } from './helpers.ts';

// A real session: `skeinwise mcp` in its own process, spoken to over stdin and stdout as an MCP client would.

const SERVE = fileURLToPath(new URL('./fixtures/serve.ts', import.meta.url));

let dir: string;
let home: string;
let token: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skeinwise-stdio-'));
  home = join(dir, 'home');
  demoRecord(dir, home).db.close();
  token = allowAgent(home, 'stdio-test', '2026-11-21T09:00:00.000Z', 'write').token;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function session(messages: unknown[], env: Record<string, string> = { SKEINWISE_AGENT_TOKEN: token }): Promise<{ code: number | null; replies: Record<string, any>[]; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVE], { env: { ...process.env, SKEINWISE_AGENT_TOKEN: '', SKEINWISE_HOME: home, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        resolve({ code, stdout, stderr, replies: stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>) });
      } catch (err) {
        reject(new Error(`stdout held something that isn't a protocol message: ${(err as Error).message}\n${stdout}\n${stderr}`));
      }
    });
    for (const m of messages) child.stdin.write(`${JSON.stringify(m)}\n`);
    child.stdin.end();
  });
}

it('serves a whole session over stdio: initialize, list tools, search, write a note', async () => {
  const { code, replies, stderr } = await session([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LEGACY_VERSION, capabilities: {}, clientInfo: { name: 'stdio-test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search', arguments: { query: 'starter', limit: 2 } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'write_note', arguments: { title: 'From the session', body: 'Written over stdio.' } } },
  ]);
  expect(code).toBe(0);
  expect(stderr).toContain(`skeinwise mcp: serving the memory tools for ${home}.`);
  expect(replies.map((r) => r.id)).toEqual([1, 2, 3, 4]);
  expect(replies[0]!.result).toMatchObject({ protocolVersion: LEGACY_VERSION, serverInfo: { name: 'skeinwise', version: expect.stringMatching(/^\d+\.\d+\.\d+/) } });
  expect(replies[1]!.result.tools).toHaveLength(12);

  const search = replies[2]!.result;
  expect(search.isError).toBeUndefined();
  const hits = JSON.parse(search.content[0].text).hits as { id: number; snippet: string }[];
  expect(hits.length).toBeGreaterThan(0);
  expect(hits.length).toBeLessThanOrEqual(2);

  const written = replies[3]!.result;
  expect(written.isError).toBeUndefined();
  const note = JSON.parse(written.content[0].text) as { entry_id: number; created: boolean };
  expect(note.created).toBe(true);

  const store = openHome(home);
  try {
    expect(store.getEntry(note.entry_id)).toMatchObject({ speaker: 'stdio-test', title: 'From the session' });
    expect(store.history(note.entry_id).map((v) => v.editor)).toEqual(['stdio-test']);
  } finally {
    store.db.close();
  }
}, 30_000);

it('refuses every tool to a session whose token is unknown, whatever its client is called', async () => {
  const { code, replies } = await session(
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LEGACY_VERSION, clientInfo: { name: 'stdio-test', version: '1' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search', arguments: { query: 'starter' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'write_note', arguments: { title: 'x', body: 'y' } } },
    ],
    { SKEINWISE_AGENT_TOKEN: `swa_${'B'.repeat(43)}` },
  );
  expect(code).toBe(0);
  for (const r of replies.slice(1)) expect(r.result).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/token .*isn't allowed/) }] });
}, 30_000);
