import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openHome } from '../../src/home.ts';
import { ACCESS_FILE, AccessError, checkAccess, readAccess } from '../../src/mcp/access.ts';
import { MCP_COMMANDS, MCP_FLAGS, MCP_HELP, serveMcp } from '../../src/mcp/commands.ts';
import type { Store } from '../../src/store/store.ts';
import { context } from './helpers.ts';

// `skeinwise mcp allow|revoke|agents|lock|unlock`, called with a context built as the CLI builds it.

const NOW = '2026-11-25T09:00:00.000Z';
let home: string;
let store: Store;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'skeinwise-mcp-cmd-'));
  store = openHome(home, () => NOW);
});
afterEach(() => {
  store.db.close();
  rmSync(home, { recursive: true, force: true });
});

async function mcp(args: string[], values: Record<string, unknown> = {}) {
  const { ctx, output } = context(home, store, { args, values, now: () => NOW });
  const code = await MCP_COMMANDS.mcp!(ctx);
  return { code, ...output };
}

describe('skeinwise mcp', () => {
  it('allows, lists and revokes agents in the record folder', async () => {
    expect((await mcp(['agents'])).out).toBe('Unlocked.\nNo agent is allowed yet.\n');
    expect((await mcp(['allow', 'claude-code'])).out).toBe('Allowed claude-code. It can read and write your record through skeinwise mcp now.\n');
    expect((await mcp(['allow', 'Claude-Code'])).out).toBe('claude-code was already allowed.\n');
    expect((await mcp(['allow', 'Claude', 'Desktop'])).out).toMatch(/^Allowed Claude Desktop\./);
    const file = join(home, ACCESS_FILE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ locked: false, allowed: { 'claude-code': NOW, 'Claude Desktop': NOW }, asked: {} });
    expect((await mcp(['agents'])).out).toBe(
      'Unlocked.\nAllowed:\n  claude-code  (since 2026-11-25)\n  Claude Desktop  (since 2026-11-25)\n',
    );
    expect((await mcp(['revoke', 'claude-code'])).out).toBe("claude-code isn't allowed any more; its next tool call is refused.\n");
    expect(Object.keys(readAccess(home).allowed)).toEqual(['Claude Desktop']);
    await expect(mcp(['revoke', 'cursor'])).rejects.toThrow(/cursor/);
    await expect(mcp(['allow'])).rejects.toThrow(/Give the agent's name/);
    await expect(mcp(['allow', 'you'])).rejects.toThrow(/how Skeinwise names its own edits/);
  });

  it('shows agents that asked, with the command to allow them', async () => {
    expect(() => checkAccess(home, 'Cursor Agent', NOW)).toThrow(AccessError);
    expect((await mcp(['agents'])).out).toContain("  Cursor Agent  (last asked 2026-11-25; allow with: skeinwise mcp allow 'Cursor Agent')\n");
  });

  it('locks and unlocks every tool', async () => {
    expect((await mcp(['lock'])).out).toBe('Locked: every agent tool is stopped until you run skeinwise mcp unlock.\n');
    expect((await mcp(['lock'])).out).toBe('Already locked.\n');
    expect(readAccess(home).locked).toBe(true);
    expect((await mcp(['agents'])).out).toMatch(/^Locked: every agent tool is stopped/);
    expect((await mcp(['unlock'])).out).toBe('Unlocked: allowed agents can use their tools again.\n');
    expect((await mcp(['unlock'])).out).toBe('It was not locked.\n');
    await expect(mcp(['lock', 'now'])).rejects.toThrow('mcp lock takes no arguments.');
  });

  it('answers --json for allow, revoke and agents', async () => {
    expect((await mcp(['allow', 'codex'], { json: true })).json).toEqual([{ agent: 'codex', allowed: true }]);
    expect((await mcp(['agents'], { json: true })).json).toEqual([{ locked: false, allowed: { codex: NOW }, asked: {} }]);
    expect((await mcp(['revoke', 'codex'], { json: true })).json).toEqual([{ agent: 'codex', allowed: false }]);
  });

  it('refuses a word it does not know, and a port that is not one', async () => {
    await expect(mcp(['serve'])).rejects.toThrow('Unknown mcp command: serve.');
    const { ctx } = context(home, store, { values: { window: true, port: 'eighty' } });
    await expect(serveMcp(ctx, new PassThrough())).rejects.toThrow('--port must be a port number, not "eighty".');
  });

  it('serves until its input closes, writing only protocol messages to stdout', async () => {
    const { ctx, output } = context(home, store);
    const input = new PassThrough();
    const done = serveMcp(ctx, input);
    input.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } })}\n`);
    expect(await done).toBe(0);
    expect(output.out).toBe('{"jsonrpc":"2.0","id":1,"result":{"resultType":"complete"}}\n');
    expect(output.err).toBe(`skeinwise mcp: serving the memory tools for ${home}.\n`);
  });

  it('exports its flags and help for the CLI to wire', () => {
    expect(MCP_FLAGS).toEqual({ window: { type: 'boolean' }, port: { type: 'string' } });
    const lines = MCP_HELP.trimEnd().split('\n');
    expect(lines).toHaveLength(8);
    for (const line of lines) expect(line).toMatch(/^ {2}mcp[ a-z<>]*\S? +\S|^ {6}--/);
    expect(lines.filter((l) => l.startsWith('  mcp')).map((l) => l.slice(28, 29))).not.toContain(' ');
  });
});
