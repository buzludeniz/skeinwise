// `skeinwise connect <agent>`: gives an AI agent your record as its memory in one step (LS-12). It allows the agent
// with a new token (read scope unless --write), then prints the exact command or config that starts `skeinwise mcp`
// for that agent. With --yes, or a yes to its question, it writes that config itself: Claude Code's through Claude
// Code's own `claude mcp add`, the others by editing their config file, each time keeping a copy of the file as it was.
// A config file it can't edit safely (JSON that doesn't parse, a Codex entry in a shape it doesn't know) is refused
// before the agent's token changes.
//
// Every path comes from the environment the command was given (HOME, APPDATA, CODEX_HOME, CLAUDE_CONFIG_DIR), never
// from the process's own, so a test's throwaway HOME is all it ever reads or writes.

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import type { Io } from './cli.ts';
import { UsageError } from './errors.ts';
import { allowAgent, type Scope, TOKEN_ENV } from './mcp/access.ts';
import { onPath } from './model-commands.ts';
import { safeLine } from './safe-text.ts';

/** What the setup commands get: the CLI's context without an open record, which `setup` opens itself. */
export interface SetupCtx {
  io: Io;
  /** The record folder. */
  home: string;
  values: { json?: boolean; yes?: boolean; write?: boolean };
  /** The words after the command. */
  args: string[];
  json: (value: unknown) => void;
}

export type ClientKey = 'claude-code' | 'codex' | 'cursor' | 'claude-desktop';

export interface AgentClient {
  key: ClientKey;
  label: string;
  /** The file that holds its MCP servers. */
  configFile: (env: NodeJS.ProcessEnv, platform?: NodeJS.Platform) => string;
}

function userHome(env: NodeJS.ProcessEnv): string {
  return env.HOME || env.USERPROFILE || homedir();
}

export const AGENT_CLIENTS: readonly AgentClient[] = [
  {
    key: 'claude-code',
    label: 'Claude Code',
    configFile: (env) => (env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : join(userHome(env), '.claude.json')),
  },
  { key: 'codex', label: 'Codex', configFile: (env) => join(env.CODEX_HOME || join(userHome(env), '.codex'), 'config.toml') },
  { key: 'cursor', label: 'Cursor', configFile: (env) => join(userHome(env), '.cursor', 'mcp.json') },
  {
    key: 'claude-desktop',
    label: 'Claude desktop',
    configFile: (env, platform = process.platform) => {
      if (platform === 'darwin') return join(userHome(env), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
      if (platform === 'win32') return join(env.APPDATA || join(userHome(env), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
      return join(env.XDG_CONFIG_HOME || join(userHome(env), '.config'), 'Claude', 'claude_desktop_config.json');
    },
  },
];

export const SERVER_NAME = 'skeinwise';

export function findClient(key: string | undefined): AgentClient {
  const client = AGENT_CLIENTS.find((c) => c.key === key?.toLowerCase());
  if (!client) {
    throw new UsageError(`Name the agent to connect: ${AGENT_CLIENTS.map((c) => `skeinwise connect ${c.key}`).join(', ')}.`);
  }
  return client;
}

/** How this computer starts `skeinwise mcp`. */
export interface Launch {
  command: string;
  args: string[];
}

/** Where the running CLI came from, which decides how an agent should start it. Tests give their own. */
export interface ConnectDeps {
  /** The CLI file this process runs. */
  script: string;
  /** The node that runs it. */
  node: string;
  /** The platform the config paths and commands are for (tests set it). */
  platform?: NodeJS.Platform;
}

const defaultDeps = (): ConnectDeps => ({ script: process.argv[1] ?? '', node: process.execPath });

/**
 * The command an agent runs to start the memory server: `npx -y skeinwise@1 mcp` when this CLI came from npx (its
 * cache may be cleared), the `skeinwise` on PATH by its full path (apps started from the Dock don't see the shell's
 * PATH), or else this very node and CLI file.
 */
export function launchCommand(env: NodeJS.ProcessEnv, deps: ConnectDeps): Launch {
  const script = deps.script ? resolve(deps.script) : '';
  const platform = deps.platform ?? process.platform;
  if (script.includes(`${sep}_npx${sep}`)) {
    return { command: onPath(platform === 'win32' ? 'npx.cmd' : 'npx', env.PATH) ?? 'npx', args: ['-y', 'skeinwise@1', 'mcp'] };
  }
  const onPathFile = onPath(platform === 'win32' ? 'skeinwise.cmd' : 'skeinwise', env.PATH);
  if (onPathFile) return { command: onPathFile, args: ['mcp'] };
  if (!script) throw new UsageError("Skeinwise can't tell how it was started, so it can't write a command that starts it. See docs/mcp.md.");
  return { command: deps.node, args: [script, 'mcp'] };
}

/** One word for a POSIX shell, quoted only when it has to be. */
export function shellWord(word: string): string {
  return /^[A-Za-z0-9._@%+=:,/-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;
}

/**
 * One word for PowerShell, Windows' own shell, quoted only when it has to be. Double quotes when nothing inside is
 * special to PowerShell or to cmd.exe, so a path with spaces reads the same in both; otherwise PowerShell's single
 * quotes, which take everything as it is, with each quote mark doubled (PowerShell counts the curly ones as quotes
 * too). `--` is quoted as well: bare, PowerShell takes it as the end of its own parameters and drops it before a
 * script such as npm's claude.ps1 sees it. A quoted first word would need `&` before it in PowerShell; the commands
 * printed with this start with `claude` or `skeinwise`, which are never quoted.
 */
export function windowsWord(word: string): string {
  if (word === '--') return '"--"';
  if (/^[A-Za-z0-9._+=:\\/-]+$/.test(word)) return word;
  if (!/["$`%\u201c\u201d\u201e]/.test(word)) return `"${word}"`;
  return `'${word.replace(/['\u2018\u2019\u201a\u201b]/g, '$&$&')}'`;
}

/** One word of a command printed for the person to paste: PowerShell's form on Windows, a POSIX shell's elsewhere. */
export function commandWord(word: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? windowsWord(word) : shellWord(word);
}

/**
 * The variables the server needs: the token, and the record folder when it isn't the default. On Windows, SystemRoot
 * too: an agent may start the server with only the variables its config names, and Windows child processes and
 * networking fail without it.
 */
function serverEnv(env: NodeJS.ProcessEnv, token: string, platform: NodeJS.Platform): Record<string, string> {
  const out: Record<string, string> = { [TOKEN_ENV]: token };
  if (env.SKEINWISE_HOME) out.SKEINWISE_HOME = resolve(env.SKEINWISE_HOME);
  const root = env.SystemRoot ?? env.SYSTEMROOT;
  if (platform === 'win32' && root) out.SystemRoot = root;
  return out;
}

/** The arguments to `claude` that add the server for this user, in every project. */
export function claudeAddArgs(launch: Launch, env: Record<string, string>): string[] {
  return ['mcp', 'add', '--scope', 'user', SERVER_NAME, ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), '--', launch.command, ...launch.args];
}

function tomlString(s: string): string {
  return JSON.stringify(s).replace(/\x7f/g, '\\u007F');
}

export function codexBlock(launch: Launch, env: Record<string, string>): string {
  const vars = Object.entries(env).map(([k, v]) => `${k} = ${tomlString(v)}`);
  return [
    `[mcp_servers.${SERVER_NAME}]`,
    '# Added by skeinwise connect: your record as this agent\'s memory. The token works like a password.',
    `command = ${tomlString(launch.command)}`,
    `args = [${launch.args.map(tomlString).join(', ')}]`,
    `env = { ${vars.join(', ')} }`,
    '',
  ].join('\n');
}

export function jsonEntry(launch: Launch, env: Record<string, string>): Record<string, unknown> {
  return { command: launch.command, args: launch.args, env };
}

// Editing the config files

const OUR_TABLE = /^\s*\[\s*mcp_servers\s*\.\s*(?:skeinwise|"skeinwise")\s*(?:\.[^\]]*)?\]\s*(?:#.*)?$/;
const ANY_TABLE = /^\s*\[/;

/** The Codex config with any skeinwise table taken out, or a reason it can't be edited safely. */
export function withoutCodexEntry(text: string): { text: string } | { refused: string } {
  const lines = text.split('\n');
  const kept: string[] = [];
  let inOurs = false;
  for (const line of lines) {
    if (OUR_TABLE.test(line)) inOurs = true;
    else if (ANY_TABLE.test(line)) inOurs = false;
    if (!inOurs) kept.push(line);
  }
  const rest = kept.join('\n');
  if (/^\s*mcp_servers\s*=/m.test(rest) || /^\s*(?:mcp_servers\s*\.\s*)?"?skeinwise"?\s*[.=]/m.test(rest)) {
    return { refused: 'it sets up a skeinwise server in a form Skeinwise doesn\'t edit. Take that part out by hand, then run this again' };
  }
  return { text: rest };
}

type Plan = { kind: 'claude'; file: string; claude: string } | { kind: 'json'; file: string; data: Record<string, unknown> } | { kind: 'toml'; file: string; text: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Reads the agent's config file and checks Skeinwise can edit it; throws a UsageError naming the file if not. */
function planWrite(client: AgentClient, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Plan {
  const file = client.configFile(env, platform);
  if (client.key === 'claude-code') {
    // claude is a .cmd on Windows, and Node won't start one without a shell, whose quoting rules differ: print it there.
    if (platform === 'win32') {
      throw new UsageError("On Windows, Skeinwise doesn't run claude mcp add for you. Run the command skeinwise connect claude-code prints, in a terminal where claude works.");
    }
    const claude = onPath('claude', env.PATH);
    if (!claude) throw new UsageError(
        "Claude Code's claude command isn't on your PATH here, so Skeinwise can't run claude mcp add for you. Run it where claude works: skeinwise connect claude-code prints it.",
      );
    return { kind: 'claude', file, claude };
  }
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const refuse = (why: string) => new UsageError(`Skeinwise won't edit ${file}: ${why}. Nothing was changed.`);
  if (client.key === 'codex') {
    const edited = withoutCodexEntry(text);
    if ('refused' in edited) throw refuse(edited.refused);
    return { kind: 'toml', file, text: edited.text };
  }
  if (!text.trim()) return { kind: 'json', file, data: {} };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw refuse(`it isn't valid JSON (${(err as Error).message}). Fix it or move it away, then run this again`);
  }
  if (!isObject(data) || (data.mcpServers !== undefined && !isObject(data.mcpServers))) {
    throw refuse('it isn\'t shaped like an MCP config ({"mcpServers": {...}})');
  }
  return { kind: 'json', file, data };
}

function stamp(now: string): string {
  return now.replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '');
}

/** Copies the file as it is now beside itself (owner-only: it may hold other tokens) and returns the copy's path. */
function backup(file: string, now: string): string | null {
  if (!existsSync(file)) return null;
  const copy = `${file}.skeinwise-backup-${stamp(now)}`;
  // Written owner-only from the start, never copied at the original's mode first.
  writeFileSync(copy, readFileSync(file), { mode: 0o600 });
  chmodSync(copy, 0o600);
  return copy;
}

function writeOwnerOnly(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
}

// Reached only through a 'claude' plan, which planWrite never makes on Windows: claude is a .cmd there.
function runClaude(io: Io, claude: string, args: string[]): void {
  // An entry left from an earlier connect holds a token that stops working now, so it goes first.
  spawnSync(claude, ['mcp', 'remove', '--scope', 'user', SERVER_NAME], { env: io.env, encoding: 'utf8', timeout: 60_000 });
  const added = spawnSync(claude, args, { env: io.env, encoding: 'utf8', timeout: 60_000 });
  if (added.status !== 0) {
    const said = safeLine(`${added.stderr ?? ''} ${added.stdout ?? ''}`.trim()).slice(0, 500);
    throw new Error(`claude mcp add failed${added.error ? ` (${added.error.message})` : ''}${said ? `: ${said}` : ''}`);
  }
}

function write(io: Io, plan: Plan, launch: Launch, env: Record<string, string>, now: string): string | null {
  const saved = backup(plan.file, now);
  if (plan.kind === 'claude') runClaude(io, plan.claude, claudeAddArgs(launch, env));
  else if (plan.kind === 'toml') {
    const base = plan.text.replace(/\s*$/, '');
    writeOwnerOnly(plan.file, `${base ? `${base}\n\n` : ''}${codexBlock(launch, env)}`);
  } else {
    const servers = isObject(plan.data.mcpServers) ? plan.data.mcpServers : {};
    writeOwnerOnly(plan.file, `${JSON.stringify({ ...plan.data, mcpServers: { ...servers, [SERVER_NAME]: jsonEntry(launch, env) } }, null, 2)}\n`);
  }
  return saved;
}

export interface Connected {
  agent: string;
  scope: Scope;
  token: string;
  replaced: boolean;
  /** The agent's config file. */
  config: string;
  /** What to run (Claude Code) or put in the file (the others). */
  setup: string;
  written: boolean;
  backup: string | null;
}

/** `skeinwise connect <agent> [--write] [--yes] [--json]`. */
export async function connect(ctx: SetupCtx, deps: ConnectDeps = defaultDeps()): Promise<number> {
  const client = findClient(ctx.args.length === 1 ? ctx.args[0] : undefined);
  const { io } = ctx;
  const now = (io.now ?? (() => new Date().toISOString()))();
  const launch = launchCommand(io.env, deps);

  // With --yes the file must be editable before the token changes; asked, an uneditable file only means no question.
  let plan: Plan | null = null;
  let unwritable: string | null = null;
  try {
    plan = planWrite(client, io.env, deps.platform ?? process.platform);
  } catch (err) {
    if (ctx.values.yes || !(err instanceof UsageError)) throw err;
    unwritable = err.message;
  }

  mkdirSync(ctx.home, { recursive: true, mode: 0o700 });
  const allowed = allowAgent(ctx.home, client.key, now, ctx.values.write ? 'write' : 'read');
  const env = serverEnv(io.env, allowed.token, deps.platform ?? process.platform);
  const file = client.configFile(io.env, deps.platform ?? process.platform);
  const setup =
    client.key === 'claude-code'
      ? `claude ${claudeAddArgs(launch, env).map((w) => commandWord(w, deps.platform ?? process.platform)).join(' ')}`
      : client.key === 'codex'
        ? codexBlock(launch, env)
        : `${JSON.stringify({ mcpServers: { [SERVER_NAME]: jsonEntry(launch, env) } }, null, 2)}\n`;

  const result: Connected = { agent: allowed.name, scope: allowed.scope, token: allowed.token, replaced: allowed.replaced, config: file, setup, written: false, backup: null };
  const say = (t: string) => {
    if (!ctx.values.json) io.out(t);
  };

  const can = allowed.scope === 'write' ? 'read and write' : 'read';
  say(`Allowed ${allowed.name} to ${can} your record${allowed.replaced ? '; the token it had before stops working now' : ''}.\n\n`);
  if (client.key === 'claude-code') say(`Add Skeinwise to Claude Code with:\n\n  ${setup}\n\n`);
  else say(`Add this to ${file}${client.key === 'claude-desktop' ? ', then restart Claude' : ''}:\n\n${setup}\n`);
  say(`The token in it (${TOKEN_ENV}) works like a password: don't commit it or paste it anywhere else.\n`);

  let go = Boolean(ctx.values.yes);
  if (!go && plan && !ctx.values.json && io.ask) {
    const question = client.key === 'claude-code' ? 'Run it now?' : `Write it to ${file}? A copy of the file as it is now is kept beside it.`;
    const answer = await io.ask(`${question} (y/N) `);
    go = answer !== null && /^y(es)?$/i.test(answer.trim());
  }
  if (go && plan) {
    result.backup = write(io, plan, launch, env, now);
    result.written = true;
    say(client.key === 'claude-code' ? '\nAdded to Claude Code.' : `\nWrote ${file}.`);
    say(result.backup ? ` The file as it was is kept at ${result.backup}.\n` : '\n');
    say(`Start a new ${client.label} session${client.key === 'claude-desktop' ? ' (restart Claude)' : ''} and ask it something about your notes.\n`);
  } else if (unwritable) {
    say(`\n${unwritable}\n`);
  } else {
    say(`\nOr let Skeinwise ${client.key === 'claude-code' ? 'run it' : 'write it'} for you: skeinwise connect ${client.key} --yes${ctx.values.write ? ' --write' : ''}\n`);
  }
  say(`What ${allowed.name} asks for and gets: skeinwise mcp log. Take its token back: skeinwise mcp deny ${allowed.name}\n`);
  if (ctx.values.json) ctx.json(result);
  return 0;
}
