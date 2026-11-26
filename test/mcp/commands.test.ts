import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openHome } from '../../src/home.ts';
import { ACCESS_FILE, AccessError, checkAccess, hashToken, readAccess } from '../../src/mcp/access.ts';
import { UsageError } from '../../src/errors.ts';
import { MCP_COMMANDS, MCP_FLAGS, MCP_HELP, serveMcp, windowServer } from '../../src/mcp/commands.ts';
import { fileRequest, pendingRequests, REQUESTS_FILE } from '../../src/mcp/requests.ts';
import type { Store } from '../../src/store/store.ts';
import { context, demoRecord } from './helpers.ts';

// `skeinwise mcp allow|deny|agents|lock|unlock`, called with a context built as the CLI builds it.

const NOW = '2026-11-25T09:00:00.000Z';
let home: string;
let store: Store;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'skeinwise-mcp-cmd-'));
  store = openHome(home, () => NOW);
});
afterEach(() => {
  if (store.db.isOpen) store.db.close();
  rmSync(home, { recursive: true, force: true });
});

async function mcp(args: string[], values: Record<string, unknown> = {}) {
  const { ctx, output } = context(home, store, { args, values, now: () => NOW });
  const code = await MCP_COMMANDS.mcp!(ctx);
  return { code, ...output };
}

describe('skeinwise mcp', () => {
  it('allows an agent with a token shown once, keeping only its hash', async () => {
    expect((await mcp(['agents'])).out).toBe('Unlocked.\nNo agent is allowed yet. Connect one with: skeinwise connect claude-code\n');
    const out = (await mcp(['allow', 'claude-code'])).out;
    expect(out).toMatch(/^Allowed claude-code to read your record\. Its token, shown only this once:\n\n {2}swa_[A-Za-z0-9_-]{43}\n\nGive it to the agent's MCP config as SKEINWISE_AGENT_TOKEN/);
    const token = /swa_[A-Za-z0-9_-]{43}/.exec(out)![0];
    const file = join(home, ACCESS_FILE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const saved = readFileSync(file, 'utf8');
    expect(saved).not.toContain(token);
    expect(JSON.parse(saved)).toEqual({ locked: false, agents: { 'claude-code': { scope: 'read', since: NOW, tokenHash: hashToken(token) } } });
    expect(checkAccess(home, token, 'anything')).toEqual({ agent: 'claude-code', scope: 'read' });
  });

  it('gives write scope with --write, and a new token on each allow', async () => {
    const first = (await mcp(['allow', 'claude-code'], { json: true })).json[0] as { token: string };
    const again = (await mcp(['allow', 'Claude-Code'], { write: true })).out;
    expect(again).toMatch(/^Allowed claude-code to read and write your record\. Its earlier token stops working now\./);
    expect(() => checkAccess(home, first.token)).toThrow(AccessError);
    expect(readAccess(home).agents['claude-code']!.scope).toBe('write');
    expect((await mcp(['allow', 'Claude', 'Desktop'])).out).toMatch(/^Allowed Claude Desktop to read/);
    expect((await mcp(['agents'])).out).toBe('Unlocked.\nAllowed:\n  claude-code  write  (since 2026-11-25)\n  Claude Desktop  read  (since 2026-11-25)\n');
  });

  it('denies (or revokes) an agent', async () => {
    const token = ((await mcp(['allow', 'claude-code'], { json: true })).json[0] as { token: string }).token;
    expect((await mcp(['deny', 'claude-code'])).out).toBe("claude-code isn't allowed any more; its next tool call is refused.\n");
    expect(() => checkAccess(home, token)).toThrow(AccessError);
    await mcp(['allow', 'codex']);
    expect((await mcp(['revoke', 'codex'])).out).toBe("codex isn't allowed any more; its next tool call is refused.\n");
    expect(readAccess(home).agents).toEqual({});
    await expect(mcp(['deny', 'cursor'])).rejects.toThrow(/cursor/);
    await expect(mcp(['allow'])).rejects.toThrow(/Give the agent's name/);
    await expect(mcp(['allow', 'you'])).rejects.toThrow(/how Skeinwise names its own edits/);
  });

  it('lists an agent allowed before tokens, with the command that gives it one', async () => {
    writeFileSync(join(home, ACCESS_FILE), JSON.stringify({ locked: false, allowed: { 'Cursor Agent': NOW }, asked: {} }));
    expect((await mcp(['agents'])).out).toContain("  Cursor Agent  (allowed before tokens: give it one with skeinwise mcp allow 'Cursor Agent')\n");
    expect(() => checkAccess(home, 'anything')).toThrow(AccessError);
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

  it('answers --json for allow, deny and agents', async () => {
    expect((await mcp(['allow', 'codex'], { json: true })).json).toEqual([{ agent: 'codex', scope: 'read', token: expect.stringMatching(/^swa_/), replaced: false }]);
    expect((await mcp(['agents'], { json: true })).json).toEqual([{ locked: false, allowed: { codex: { scope: 'read', since: NOW, token: true } } }]);
    expect((await mcp(['deny', 'codex'], { json: true })).json).toEqual([{ agent: 'codex', allowed: false }]);
  });

  it('refuses a word it does not know, and a window port that is not one', async () => {
    await expect(mcp(['serve'])).rejects.toThrow('Unknown mcp command: serve.');
    expect(() => windowServer(context(home, store, { values: { port: 'eighty' } }).ctx)).toThrow('--port must be a port number, not "eighty".');
  });

  it('refuses --window with a usage error and serves nothing: agents use the stdio server in 1.0', async () => {
    const { ctx, output } = context(home, store, { values: { window: true } });
    const input = new PassThrough();
    const served = serveMcp(ctx, input);
    await expect(served).rejects.toThrow(UsageError);
    await expect(served).rejects.toThrow("skeinwise mcp --window isn't available in 1.0. Agents use skeinwise mcp over stdio; skeinwise connect sets one up.");
    expect(output.out).toBe('');
    expect(output.err).toBe('');
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

  it('exports its flags and help for the CLI to wire, the window server left out of the help', () => {
    expect(MCP_FLAGS).toEqual({ window: { type: 'boolean' }, port: { type: 'string' }, write: { type: 'boolean' } });
    expect(MCP_HELP).not.toMatch(/window|--port/);
    const lines = MCP_HELP.trimEnd().split('\n');
    expect(lines).toHaveLength(11);
    for (const line of lines) expect(line).toMatch(/^ {2}mcp[ a-z<>]*\S? +\S|^ {6}--/);
    expect(lines.filter((l) => l.startsWith('  mcp')).map((l) => l.slice(28, 29))).not.toContain(' ');
  });
});

describe('agent requests: mcp pending, confirm and refuse', () => {
  // These need threads, so they run on the demo record in a folder of its own.
  let demo: string;
  beforeEach(() => {
    store.db.close();
    rmSync(home, { recursive: true, force: true });
    demo = mkdtempSync(join(tmpdir(), 'skeinwise-mcp-req-'));
    home = join(demo, 'home');
    store = demoRecord(demo, home);
  });
  afterEach(() => {
    // Closed first: Windows can't remove a folder while the record in it is open.
    store.db.close();
    rmSync(demo, { recursive: true, force: true });
  });

  it('lists what agents asked for, makes the change on confirm, and drops it on refuse', async () => {
    expect((await mcp(['pending'])).out).toBe('No agent request is waiting.\n');
    const threads = store.allEntries().filter((e) => e.threadId !== null).map((e) => e.threadId!);
    const [first, second] = [...new Set(threads)];
    const a = fileRequest(home, { agent: 'claude-code', tool: 'not_mine', target: first!, what: `Leave out thread ${first}, "\u001b[31mred\u001b[0m"` }, NOW);
    const b = fileRequest(home, { agent: 'cursor', tool: 'not_mine', target: second!, what: `Leave out thread ${second}` }, NOW);
    const listed = (await mcp(['pending'])).out;
    expect(listed).toContain(`  ${a.id}  2026-11-25 09:00  claude-code asks: Leave out thread ${first}, "red"`);
    expect(listed).toContain(`  ${b.id}  2026-11-25 09:00  cursor asks: Leave out thread ${second}`);
    expect(listed).not.toContain('\u001b');
    expect(statSync(join(home, REQUESTS_FILE)).mode & 0o777).toBe(0o600);

    expect((await mcp(['confirm', String(a.id)])).out).toBe(`Done: thread ${first} is left out now. Bring it back with: skeinwise not-mine ${first} --undo\n`);
    expect(store.visibleThread(first!)).toBeUndefined();
    expect((await mcp(['refuse', String(b.id)])).out).toBe(`Refused request ${b.id}; nothing changed.\n`);
    expect(store.visibleThread(second!)).toBeDefined();
    expect(pendingRequests(home, NOW)).toEqual([]);
    await expect(mcp(['confirm', String(b.id)])).rejects.toThrow(`No agent request ${b.id} is waiting.`);
    await expect(mcp(['confirm'])).rejects.toThrow(/Give the request number/);
  });

  it('lets a request wait seven days at most', () => {
    fileRequest(home, { agent: 'claude-code', tool: 'undo_run', target: 3, what: 'Undo run 3' }, '2026-11-01T09:00:00.000Z');
    expect(pendingRequests(home, '2026-11-08T08:59:00.000Z')).toHaveLength(1);
    expect(pendingRequests(home, '2026-11-08T09:01:00.000Z')).toEqual([]);
    // Numbers aren't reused once a request is gone.
    expect(fileRequest(home, { agent: 'claude-code', tool: 'undo_run', target: 3, what: 'Undo run 3' }, '2026-11-09T09:00:00.000Z').id).toBe(2);
  });
});
