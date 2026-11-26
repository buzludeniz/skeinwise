import { spawn } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_CLIENTS, type ConnectDeps, connect, launchCommand, type SetupCtx, shellWord, withoutCodexEntry } from '../src/connect.ts';
import { writeDemo } from '../src/demo/demo.ts';
import { UsageError } from '../src/errors.ts';
import { openHome } from '../src/home.ts';
import { agentOfToken, readAccess } from '../src/mcp/access.ts';
import { FRAME_OPEN, unframe } from '../src/mcp/frame.ts';
import { SETUP_COMMANDS, SETUP_HELP, setup } from '../src/setup.ts';
import { demoRecord, LEGACY_VERSION } from './mcp/helpers.ts';
import { expectMode } from './modes.ts';

// `skeinwise connect` and `skeinwise setup` (LS-12), each in a throwaway HOME made here: the agents' config files,
// histories and record all sit under it, and `claude` is a fake script that writes down how it was called.

const NOW = '2026-11-25T10:00:00.000Z';
const DEPS: ConnectDeps = { script: resolve('src/cli.ts'), node: process.execPath };

let dir: string;
let user: string;
let home: string;
let bin: string;
let calls: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skeinwise-connect-'));
  user = join(dir, 'user');
  home = join(dir, 'record');
  bin = join(dir, 'bin');
  calls = join(dir, 'claude-calls.txt');
  mkdirSync(user);
  mkdirSync(bin);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A fake `claude` on PATH: it notes its arguments, fails `mcp remove` (nothing there yet) and does what `script` says. */
function fakeClaude(script = 'exit 0'): void {
  const file = join(bin, 'claude');
  writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$CLAUDE_CALLS"\n[ "$2" = remove ] && exit 1\n${script}\n`);
  chmodSync(file, 0o755);
}

function setupCtx(args: string[], values: SetupCtx['values'] = {}, ask?: (q: string) => Promise<string | null>) {
  const output = { out: '', err: '', json: [] as unknown[], asked: [] as string[] };
  const ctx: SetupCtx = {
    io: {
      out: (t) => (output.out += t),
      err: (t) => (output.err += t),
      env: { HOME: user, SKEINWISE_HOME: home, PATH: `${bin}:/usr/bin:/bin`, CLAUDE_CALLS: calls },
      now: () => NOW,
      ...(ask
        ? {
            ask: (q: string) => {
              output.asked.push(q);
              return ask(q);
            },
          }
        : {}),
    },
    home,
    values,
    args,
    json: (v) => output.json.push(v),
  };
  return { ctx, output };
}

/** Splits a POSIX shell line as `sh` would, for plain words, single quotes and backslashes. */
function shellSplit(line: string): string[] {
  const words: string[] = [];
  let word: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      word = (word ?? '') + line.slice(i + 1, end);
      i = end;
    } else if (c === '\\') word = (word ?? '') + line[++i];
    else if (/\s/.test(c)) {
      if (word !== null) words.push(word);
      word = null;
    } else word = (word ?? '') + c;
  }
  if (word !== null) words.push(word);
  return words;
}

/** Runs a server command with its environment and sends one search: what an agent would do with the printed config. */
function search(command: string, args: string[], env: Record<string, string>): Promise<Record<string, any>[]> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { env: { PATH: '/usr/bin:/bin', HOME: user, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.on('error', fail);
    child.on('close', () => done(stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>)));
    for (const m of [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LEGACY_VERSION, capabilities: {}, clientInfo: { name: 'claude-code', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search', arguments: { query: 'starter', limit: 2 } } },
    ]) {
      child.stdin.write(`${JSON.stringify(m)}\n`);
    }
    child.stdin.end();
  });
}

describe('skeinwise connect', () => {
  beforeEach(() => demoRecord(dir, home).db.close());

  it('connect claude-code writes nothing without --yes and prints a command that works', async () => {
    fakeClaude();
    const { ctx, output } = setupCtx(['claude-code']);
    expect(await connect(ctx, DEPS)).toBe(0);

    expect(readdirSync(user)).toEqual([]);
    expect(existsSync(calls)).toBe(false);
    expect(output.out).toContain('Or let Skeinwise run it for you: skeinwise connect claude-code --yes');
    expect(readAccess(home).agents['claude-code']).toMatchObject({ scope: 'read', since: NOW });

    const line = output.out.split('\n').find((l) => l.startsWith('  claude mcp add'))!;
    const words = shellSplit(line.trim());
    expect(words.slice(0, 6)).toEqual(['claude', 'mcp', 'add', '--scope', 'user', 'skeinwise']);
    const dash = words.indexOf('--');
    const env: Record<string, string> = {};
    for (let i = 6; i < dash; i += 2) {
      expect(words[i]).toBe('-e');
      const [k, ...v] = words[i + 1]!.split('=');
      env[k!] = v.join('=');
    }
    expect(env).toEqual({ SKEINWISE_AGENT_TOKEN: expect.stringMatching(/^swa_[A-Za-z0-9_-]{43}$/), SKEINWISE_HOME: home });
    expect(words.slice(dash + 1)).toEqual([process.execPath, resolve('src/cli.ts'), 'mcp']);

    const replies = await search(words[dash + 1]!, words.slice(dash + 2), env);
    expect(replies.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(replies[1]!.result.tools).toHaveLength(7);
    const text = replies[2]!.result.content[0].text as string;
    expect(replies[2]!.result.isError).toBeFalsy();
    expect(text.startsWith(FRAME_OPEN)).toBe(true);
    expect((unframe(text) as { entries: unknown[] }).entries.length).toBeGreaterThan(0);
  }, 60_000);

  it('runs claude mcp add with --yes, after keeping a copy of .claude.json', async () => {
    fakeClaude();
    writeFileSync(join(user, '.claude.json'), '{"numStartups": 3}\n');
    const { ctx, output } = setupCtx(['claude-code'], { yes: true, write: true });
    expect(await connect(ctx, DEPS)).toBe(0);

    const token = readAccess(home).agents['claude-code']!;
    expect(token.scope).toBe('write');
    const ran = readFileSync(calls, 'utf8').trim().split('\n');
    expect(ran[0]).toBe('mcp remove --scope user skeinwise');
    expect(ran[1]).toMatch(new RegExp(`^mcp add --scope user skeinwise -e SKEINWISE_AGENT_TOKEN=swa_\\S+ -e SKEINWISE_HOME=${home} -- ${process.execPath} \\S+cli\\.ts mcp$`));
    const sent = /SKEINWISE_AGENT_TOKEN=(\S+)/.exec(ran[1]!)![1]!;
    expect(agentOfToken(readAccess(home), sent)).toBe('claude-code');

    const copy = join(user, '.claude.json.skeinwise-backup-20261125T100000Z');
    expect(readFileSync(copy, 'utf8')).toBe('{"numStartups": 3}\n');
    expectMode(copy, 0o600);
    expect(output.out).toContain('Added to Claude Code.');
    expect(output.out).toContain(`kept at ${copy}`);
  });

  it('says what went wrong when claude mcp add fails', async () => {
    fakeClaude('echo "boom: config locked" >&2; exit 1');
    await expect(connect(setupCtx(['claude-code'], { yes: true }).ctx, DEPS)).rejects.toThrow(/claude mcp add failed: boom: config locked/);
  });

  it('refuses --yes without claude on PATH, before the token changes', async () => {
    const { ctx } = setupCtx(['claude-code'], { yes: true });
    await expect(connect(ctx, DEPS)).rejects.toThrow(UsageError);
    await expect(connect(ctx, DEPS)).rejects.toThrow(/claude command isn't on your PATH/);
    expect(readAccess(home).agents['claude-code']).toBeUndefined();
  });

  it('adds itself to Cursor next to the servers already there, owner-only', async () => {
    const file = join(user, '.cursor', 'mcp.json');
    mkdirSync(join(user, '.cursor'));
    const before = `${JSON.stringify({ mcpServers: { other: { command: 'other-mcp' } }, theme: 'dark' })}\n`;
    writeFileSync(file, before);
    const { ctx, output } = setupCtx(['cursor'], { yes: true });
    expect(await connect(ctx, DEPS)).toBe(0);

    const after = JSON.parse(readFileSync(file, 'utf8'));
    expect(after.theme).toBe('dark');
    expect(after.mcpServers.other).toEqual({ command: 'other-mcp' });
    expect(after.mcpServers.skeinwise).toEqual({
      command: process.execPath,
      args: [resolve('src/cli.ts'), 'mcp'],
      env: { SKEINWISE_AGENT_TOKEN: expect.stringMatching(/^swa_/), SKEINWISE_HOME: home },
    });
    expect(agentOfToken(readAccess(home), after.mcpServers.skeinwise.env.SKEINWISE_AGENT_TOKEN)).toBe('cursor');
    expectMode(file, 0o600);
    expect(readFileSync(`${file}.skeinwise-backup-20261125T100000Z`, 'utf8')).toBe(before);
    expect(output.out).toContain(`Wrote ${file}.`);
  });

  it("refuses a config that isn't valid JSON, and leaves the file and the token as they were", async () => {
    const file = join(user, '.cursor', 'mcp.json');
    mkdirSync(join(user, '.cursor'));
    writeFileSync(file, '{"mcpServers": {,}');
    await expect(connect(setupCtx(['cursor'], { yes: true }).ctx, DEPS)).rejects.toThrow(/won't edit .*mcp\.json: it isn't valid JSON/);
    expect(readFileSync(file, 'utf8')).toBe('{"mcpServers": {,}');
    expect(readAccess(home).agents.cursor).toBeUndefined();
    expect(readdirSync(join(user, '.cursor'))).toEqual(['mcp.json']);

    writeFileSync(file, '{"mcpServers": []}');
    await expect(connect(setupCtx(['cursor'], { yes: true }).ctx, DEPS)).rejects.toThrow(/isn't shaped like an MCP config/);
  });

  it('prints the Cursor config but writes it only on a yes', async () => {
    const file = join(user, '.cursor', 'mcp.json');
    const no = setupCtx(['cursor'], {}, async () => 'n');
    expect(await connect(no.ctx, DEPS)).toBe(0);
    expect(no.output.asked[0]).toMatch(/^Write it to .*mcp\.json\? A copy of the file as it is now is kept beside it\. \(y\/N\) $/);
    expect(no.output.out).toContain('"SKEINWISE_AGENT_TOKEN": "swa_');
    expect(existsSync(file)).toBe(false);

    const nobody = setupCtx(['cursor'], {}, async () => null);
    expect(await connect(nobody.ctx, DEPS)).toBe(0);
    expect(existsSync(file)).toBe(false);

    const yes = setupCtx(['cursor'], {}, async () => 'yes');
    expect(await connect(yes.ctx, DEPS)).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf8')).mcpServers.skeinwise.command).toBe(process.execPath);
  });

  it("writes Claude desktop's config where Claude desktop reads it", async () => {
    const client = AGENT_CLIENTS.find((c) => c.key === 'claude-desktop')!;
    const file = client.configFile({ HOME: user });
    expect(file.startsWith(user)).toBe(true);
    const { ctx, output } = setupCtx(['claude-desktop'], { yes: true });
    expect(await connect(ctx, DEPS)).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf8')).mcpServers.skeinwise.args).toEqual([resolve('src/cli.ts'), 'mcp']);
    expect(output.out).toContain('restart Claude');
  });

  it("replaces the skeinwise tables in Codex's config.toml and keeps the rest", async () => {
    const file = join(user, '.codex', 'config.toml');
    mkdirSync(join(user, '.codex'));
    writeFileSync(
      file,
      [
        'model = "local"',
        '',
        '[mcp_servers.other]',
        'command = "other-mcp"',
        '',
        '[mcp_servers.skeinwise]',
        'command = "old"',
        'args = ["mcp"]',
        '[mcp_servers.skeinwise.env]',
        'SKEINWISE_AGENT_TOKEN = "old"',
        '',
        '[profiles.quiet]',
        'model = "small"',
        '',
      ].join('\n'),
    );
    expect(await connect(setupCtx(['codex'], { yes: true }).ctx, DEPS)).toBe(0);
    const text = readFileSync(file, 'utf8');
    expect(text.match(/\[mcp_servers\.skeinwise/g)).toHaveLength(1);
    expect(text).not.toContain('"old"');
    expect(text).toContain('[mcp_servers.other]\ncommand = "other-mcp"');
    expect(text).toContain('[profiles.quiet]\nmodel = "small"');
    expect(text).toContain(`command = ${JSON.stringify(process.execPath)}`);
    const token = /SKEINWISE_AGENT_TOKEN = "(swa_[^"]+)"/.exec(text)![1]!;
    expect(agentOfToken(readAccess(home), token)).toBe('codex');
    expect(text).toContain(`SKEINWISE_HOME = ${JSON.stringify(home)}`);
    expectMode(file, 0o600);
  });

  it('refuses a Codex config that sets skeinwise up in a form it does not edit', () => {
    expect(withoutCodexEntry('mcp_servers = { skeinwise = { command = "x" } }\n')).toHaveProperty('refused');
    expect(withoutCodexEntry('[mcp_servers]\nskeinwise = { command = "x" }\n')).toHaveProperty('refused');
    expect(withoutCodexEntry('mcp_servers.skeinwise.command = "x"\n')).toHaveProperty('refused');
    expect(withoutCodexEntry('[other]\nname = "skeinwise notes"\n')).toEqual({ text: '[other]\nname = "skeinwise notes"\n' });
  });

  it('answers --json with the token and what it would run', async () => {
    fakeClaude();
    const { ctx, output } = setupCtx(['claude-code'], { json: true });
    expect(await connect(ctx, DEPS)).toBe(0);
    expect(output.out).toBe('');
    const [result] = output.json as { token: string; setup: string; written: boolean; scope: string }[];
    expect(result).toMatchObject({ agent: 'claude-code', scope: 'read', written: false, backup: null, replaced: false });
    expect(result!.setup).toContain(`SKEINWISE_AGENT_TOKEN=${result!.token}`);
  });

  it('gives a second connect a new token and stops the old one', async () => {
    fakeClaude();
    const first = setupCtx(['claude-code'], { json: true });
    await connect(first.ctx, DEPS);
    const second = setupCtx(['claude-code']);
    await connect(second.ctx, DEPS);
    expect(second.output.out).toContain('the token it had before stops working now');
    expect(agentOfToken(readAccess(home), (first.output.json[0] as { token: string }).token)).toBeUndefined();
  });

  it('names the agents it knows when given another', async () => {
    await expect(connect(setupCtx(['vim']).ctx, DEPS)).rejects.toThrow(/skeinwise connect claude-code, skeinwise connect codex, skeinwise connect cursor, skeinwise connect claude-desktop/);
    await expect(connect(setupCtx([]).ctx, DEPS)).rejects.toThrow(UsageError);
  });
});

describe('the command an agent starts', () => {
  it('uses npx when this CLI came from npx, the skeinwise on PATH, or else this node and file', () => {
    const env = { PATH: `${bin}:/usr/bin:/bin` };
    expect(launchCommand(env, { script: '/home/x/.npm/_npx/abc/node_modules/skeinwise/dist/src/cli.js', node: '/n' }).args).toEqual(['-y', 'skeinwise@1', 'mcp']);
    expect(launchCommand(env, DEPS)).toEqual({ command: process.execPath, args: [resolve('src/cli.ts'), 'mcp'] });
    writeFileSync(join(bin, 'skeinwise'), '#!/bin/sh\n');
    chmodSync(join(bin, 'skeinwise'), 0o755);
    expect(launchCommand(env, DEPS)).toEqual({ command: join(bin, 'skeinwise'), args: ['mcp'] });
  });

  it('quotes a word only when the shell needs it', () => {
    expect(shellWord('SKEINWISE_HOME=/a/b')).toBe('SKEINWISE_HOME=/a/b');
    expect(shellWord("/Users/x/Application Support/it's")).toBe("'/Users/x/Application Support/it'\\''s'");
    expect(shellSplit(`a 'b c' 'it'\\''s'`)).toEqual(['a', 'b c', "it's"]);
  });
});

describe('skeinwise setup', () => {
  beforeEach(() => {
    // Invented histories: the demo's Claude Code sessions where Claude Code keeps them, and a Notes folder.
    const exports = join(dir, 'exports');
    writeDemo(exports);
    cpSync(join(exports, 'claude-code', 'projects'), join(user, '.claude', 'projects'), { recursive: true });
    mkdirSync(join(user, 'Documents', 'Notes'), { recursive: true });
    writeFileSync(join(user, 'Documents', 'Notes', 'garden.md'), '# Garden\n\nPlant the garlic before the frost.\n');
  });

  it('lists what it finds and brings nothing in without a yes', async () => {
    const { ctx, output } = setupCtx([]);
    expect(await setup(ctx)).toBe(0);
    expect(output.out).toContain('Claude Code history: ');
    expect(output.out).toContain('Notes: Notes: 1 note');
    expect(output.out).toContain(`skeinwise import ${join(user, 'Documents', 'Notes')}`);
    expect(output.out).toContain('or all at once: skeinwise setup --yes');
    expect(output.out).toContain('skeinwise connect claude-code');
    const store = openHome(home);
    expect(store.sources()).toHaveLength(0);
    store.db.close();
    expectMode(join(home, 'record.db'), 0o600);
  });

  it('brings everything in with --yes, sums it up, and finds it already in the next time', async () => {
    const first = setupCtx([], { yes: true });
    expect(await setup(first.ctx)).toBe(0);
    expect(first.output.out).toMatch(/Claude Code: \d+ new entries in \d+ conversations/);
    expect(first.output.out).toMatch(/Notes: 1 new entry\n/);
    expect(first.output.out).toContain('Notes came in as your own words');

    const again = setupCtx([], { yes: true });
    expect(await setup(again.ctx)).toBe(0);
    expect(again.output.out.match(/\(already in your record\)/g)).toHaveLength(2);
    expect(again.output.out).not.toMatch(/new entr/);
  });

  it('asks once, and Enter means yes', async () => {
    const no = setupCtx([], {}, async () => 'n');
    await setup(no.ctx);
    expect(no.output.asked).toEqual(['\nBring in these 2? Nothing leaves this computer. (Y/n) ']);
    expect(no.output.out).not.toMatch(/new entr/);

    const enter = setupCtx([], {}, async () => '');
    await setup(enter.ctx);
    expect(enter.output.out).toMatch(/new entries/);
  });

  it('says where else to look when it finds nothing', async () => {
    rmSync(join(user, '.claude'), { recursive: true });
    rmSync(join(user, 'Documents'), { recursive: true });
    const { ctx, output } = setupCtx([]);
    expect(await setup(ctx)).toBe(0);
    expect(output.out).toContain('Found no AI histories, exports or note folders');
    expect(output.out).toContain('skeinwise connect <agent>');
  });

  it('answers --json', async () => {
    const { ctx, output } = setupCtx([], { yes: true, json: true });
    expect(await setup(ctx)).toBe(0);
    expect(output.out).toBe('');
    const [result] = output.json as { found: unknown[]; brought: { results: unknown[] }[]; agents: string[] }[];
    expect(result!.found).toHaveLength(2);
    expect(result!.brought.every((b) => b.results.length > 0)).toBe(true);
    expect(result!.agents).toEqual(['claude-code']);
  });

  it('is wired as setup, connect and doctor, with help lines', () => {
    expect(Object.keys(SETUP_COMMANDS)).toEqual(['setup', 'connect', 'doctor']);
    expect(SETUP_HELP).toContain('connect <agent>');
    expect(SETUP_HELP.split('\n').filter(Boolean)).toHaveLength(6);
  });
});
