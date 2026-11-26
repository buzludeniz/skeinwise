// `skeinwise doctor`: checks what Skeinwise needs and prints one fix for each problem (LS-12). It looks at the Node
// version, node:sqlite with full-text search, the record folder and its files' modes, live capture's status, the model
// server in the settings, and every agent config that starts `skeinwise mcp`. It changes nothing: the only thing it
// sends is one request for the model list to the local model server the settings name, through the fetch it is given.

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { loadConfig } from './config.ts';
import { UsageError } from './errors.ts';
import { AGENT_CLIENTS, type AgentClient, SERVER_NAME, type SetupCtx } from './connect.ts';
import { readStatus } from './live/capture.ts';
import { type Access, agentOfToken, readAccess, TOKEN_ENV } from './mcp/access.ts';
import { onPath } from './model-commands.ts';
import { isLoopback, readServerKey } from './organiser/model.ts';
import { safeLine } from './safe-text.ts';
import { MIGRATIONS } from './store/schema.ts';

export type Status = 'ok' | 'problem' | 'note';

export interface Finding {
  check: 'node' | 'sqlite' | 'record' | 'modes' | 'live' | 'model' | 'mcp';
  status: Status;
  text: string;
  /** What to do about it: a command where there is one. */
  fix?: string;
}

export interface DoctorDeps {
  /** The Node version, as process.versions.node gives it. */
  nodeVersion: string;
  platform: NodeJS.Platform;
  fetch: typeof fetch;
}

export const MIN_NODE = 24;
const PROBE_MS = 3000;

/** Files in the record folder that only their owner should read: the record, settings, tokens, logs and keys. */
export const PRIVATE_FILES = [
  'record.db',
  'record.db-wal',
  'record.db-shm',
  'config.json',
  'agents.json',
  'token',
  'live.json',
  'mcp-log.jsonl',
  'mcp-log.1.jsonl',
  'mcp-requests.json',
  join('models', '.key'),
];

const quote = (path: string) => `'${path.replace(/'/g, "'\\''")}'`;
const mode = (n: number) => `0${(n & 0o777).toString(8)}`;
const message = (err: unknown) => safeLine(err instanceof Error ? err.message : String(err)).slice(0, 300);

function checkNode(version: string): Finding {
  const major = Number(version.split('.')[0]);
  if (major >= MIN_NODE) return { check: 'node', status: 'ok', text: `Node ${version}` };
  return {
    check: 'node',
    status: 'problem',
    text: `Node ${version} is older than Skeinwise needs (Node ${MIN_NODE} or newer).`,
    fix: `Install Node ${MIN_NODE} or newer from https://nodejs.org/ (with nvm: nvm install ${MIN_NODE}).`,
  };
}

async function checkSqlite(): Promise<Finding> {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE VIRTUAL TABLE probe USING fts5(text)');
      const { v } = db.prepare('SELECT sqlite_version() AS v').get() as { v: string };
      return { check: 'sqlite', status: 'ok', text: `node:sqlite (SQLite ${v}) with full-text search` };
    } finally {
      db.close();
    }
  } catch (err) {
    return {
      check: 'sqlite',
      status: 'problem',
      text: `This Node has no node:sqlite with full-text search (${message(err)}).`,
      fix: `Install Node ${MIN_NODE} or newer from https://nodejs.org/.`,
    };
  }
}

/**
 * The record's schema version, from the database file's header (bytes 60 to 63), or null when the file isn't SQLite.
 * Read from the file rather than through SQLite, so doctor leaves no -wal or -shm file behind.
 */
function schemaOf(file: string): number | null {
  const header = Buffer.alloc(100);
  const fd = openSync(file, 'r');
  try {
    if (readSync(fd, header, 0, 100, 0) < 100) return null;
  } finally {
    closeSync(fd);
  }
  return header.toString('latin1', 0, 16) === 'SQLite format 3\0' ? header.readUInt32BE(60) : null;
}

function checkRecord(home: string): Finding {
  const file = join(home, 'record.db');
  if (!existsSync(file)) {
    return { check: 'record', status: 'problem', text: `There is no record at ${home} yet.`, fix: 'Bring in your chats and notes: skeinwise setup' };
  }
  let version: number | null;
  try {
    version = schemaOf(file);
  } catch (err) {
    return { check: 'record', status: 'problem', text: `record.db at ${home} can't be read (${message(err)}).`, fix: `Check that the folder is yours: ls -l ${quote(home)}` };
  }
  if (version === null) {
    return { check: 'record', status: 'problem', text: `record.db at ${home} isn't an SQLite database.`, fix: `Move it away and bring your chats in again: mv ${quote(file)} ${quote(`${file}.broken`)}` };
  }
  if (version > MIGRATIONS.length) {
    return {
      check: 'record',
      status: 'problem',
      text: `The record at ${home} was written by a newer Skeinwise (schema ${version}; this one knows ${MIGRATIONS.length}).`,
      fix: 'Update Skeinwise: npm install -g skeinwise@1',
    };
  }
  return { check: 'record', status: 'ok', text: `Record at ${home}` };
}

function checkModes(home: string, platform: NodeJS.Platform): Finding[] {
  if (platform === 'win32') return [{ check: 'modes', status: 'note', text: "Who may read the record folder isn't checked on Windows yet." }];
  if (!existsSync(home)) return [];
  const out: Finding[] = [];
  const folder = statSync(home).mode;
  if (folder & 0o077) {
    out.push({
      check: 'modes',
      status: 'problem',
      text: `The record folder can be opened by other people on this computer (mode ${mode(folder)}).`,
      fix: `chmod 700 ${quote(home)}`,
    });
  }
  const open = PRIVATE_FILES.map((name) => ({ name, path: join(home, name) }))
    .filter((f) => existsSync(f.path))
    .map((f) => ({ ...f, mode: statSync(f.path).mode }))
    .filter((f) => f.mode & 0o077);
  if (open.length) {
    out.push({
      check: 'modes',
      status: 'problem',
      text: `Other people on this computer can read ${open.map((f) => `${f.name} (mode ${mode(f.mode)})`).join(', ')}.`,
      fix: `chmod 600 ${open.map((f) => quote(f.path)).join(' ')}`,
    });
  }
  if (!out.length) out.push({ check: 'modes', status: 'ok', text: 'The record folder and its files are yours only' });
  return out;
}

function checkLive(home: string): Finding {
  const file = join(home, 'live.json');
  if (!existsSync(file)) return { check: 'live', status: 'note', text: 'Live capture has never run.', fix: 'Record new chats and notes as they appear: skeinwise live' };
  let status;
  try {
    status = readStatus(file);
  } catch (err) {
    return { check: 'live', status: 'problem', text: `live.json in the record folder can't be read (${message(err)}).`, fix: `Remove it; the next live pass writes a new one: rm ${quote(file)}` };
  }
  if (status.errors.length) {
    const first = status.errors[0]!;
    return {
      check: 'live',
      status: 'problem',
      text: `Live capture couldn't bring in ${status.errors.length} file${status.errors.length === 1 ? '' : 's'} on its last pass, ${safeLine(first.path)} first: ${safeLine(first.error).slice(0, 200)}`,
      fix: `See the whole error: skeinwise import ${quote(first.path)}`,
    };
  }
  if (status.organised?.error) {
    return { check: 'live', status: 'problem', text: `Live organising stopped: ${safeLine(status.organised.error).slice(0, 200)}`, fix: 'Check the model server: skeinwise model check' };
  }
  return { check: 'live', status: 'ok', text: `Live capture, last pass ${status.lastPassAt ?? 'not finished yet'}` };
}

function modelIds(body: unknown): string[] | null {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  return data.map((m) => (m as { id?: unknown }).id).filter((id): id is string => typeof id === 'string');
}

async function checkModel(home: string, env: NodeJS.ProcessEnv, deps: DoctorDeps): Promise<Finding> {
  let config;
  try {
    config = loadConfig(home);
  } catch (err) {
    return { check: 'model', status: 'problem', text: `The settings can't be read (${message(err)}).`, fix: `Fix or remove ${quote(join(home, 'config.json'))}` };
  }
  if (config.engine === 'none') return { check: 'model', status: 'ok', text: 'No model: the No-AI engine organises without one' };
  if (config.engine === 'remote') {
    const missing = !config.remoteUrl ? 'skeinwise config remoteUrl <url>' : !config.apiKeyEnv ? 'skeinwise config apiKeyEnv <NAME>' : !env[config.apiKeyEnv] ? `set ${config.apiKeyEnv} in your environment` : null;
    if (missing) return { check: 'model', status: 'problem', text: 'The remote engine is chosen but not set up.', fix: missing };
    return { check: 'model', status: 'ok', text: `Remote model at ${new URL(config.remoteUrl).host} (doctor doesn't call it)` };
  }
  const url = config.localUrl.replace(/\/+$/, '');
  if (!url || !isLoopback(url)) {
    return { check: 'model', status: 'problem', text: `The local model server ${url || '(none)'} isn't on this computer.`, fix: 'skeinwise config localUrl http://127.0.0.1:8731/v1' };
  }
  const key = readServerKey({ fetch: deps.fetch, env, home });
  let res: Response;
  try {
    res = await deps.fetch(`${url}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {}, redirect: 'error', signal: AbortSignal.timeout(PROBE_MS) });
  } catch {
    return { check: 'model', status: 'problem', text: `No model server answers at ${url}.`, fix: 'Start one: skeinwise model serve prints the command (or choose the No-AI engine: skeinwise config engine none)' };
  }
  if (res.status === 401) {
    return { check: 'model', status: 'problem', text: `The model server at ${url} refuses Skeinwise's key.`, fix: 'Start it again with the command skeinwise model serve prints, which passes the key in the record folder' };
  }
  const ids = res.ok ? modelIds(await res.json().catch(() => null)) : null;
  if (!ids) return { check: 'model', status: 'problem', text: `${url}/models answered ${res.status} without a model list.`, fix: 'Check that it is llama-server or another OpenAI-compatible server: skeinwise model check' };
  if (config.localModel && !ids.includes(config.localModel)) {
    return { check: 'model', status: 'problem', text: `The model server at ${url} has no model "${config.localModel}" (it has ${ids.join(', ') || 'none'}).`, fix: 'skeinwise config localModel <name>' };
  }
  if (!ids.length) return { check: 'model', status: 'problem', text: `The model server at ${url} lists no models.`, fix: 'Load one: skeinwise model serve prints the command' };
  return { check: 'model', status: 'ok', text: `Model server at ${url}: ${safeLine(config.localModel || ids[0]!)}` };
}

/** The skeinwise server entry in an agent's config: its command and environment, or why the file can't be read. */
interface Entry {
  command: string | null;
  env: Record<string, string>;
}

function readEntry(client: AgentClient, file: string): Entry | null | { unreadable: string } {
  const text = readFileSync(file, 'utf8');
  if (client.key === 'codex') {
    const lines = text.split('\n');
    const start = lines.findIndex((l) => /^\s*\[\s*mcp_servers\s*\.\s*(?:skeinwise|"skeinwise")\s*\]/.test(l));
    if (start < 0) return null;
    const end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l));
    const block = lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
    const str = (name: string) => {
      const m = new RegExp(`(?:^|[\\s{,])${name}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'm').exec(block);
      if (!m) return undefined;
      try {
        return JSON.parse(`"${m[1]}"`) as string;
      } catch {
        return m[1];
      }
    };
    const env: Record<string, string> = {};
    for (const name of [TOKEN_ENV, 'SKEINWISE_HOME']) {
      const v = str(name);
      if (v !== undefined) env[name] = v;
    }
    return { command: str('command') ?? null, env };
  }
  if (!text.trim()) return null;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { unreadable: `isn't valid JSON (${message(err)})` };
  }
  const entry = (data as { mcpServers?: Record<string, unknown> } | null)?.mcpServers?.[SERVER_NAME] as { command?: unknown; env?: unknown } | undefined;
  if (!entry || typeof entry !== 'object') return null;
  const env = entry.env && typeof entry.env === 'object' ? Object.fromEntries(Object.entries(entry.env).filter(([, v]) => typeof v === 'string')) : {};
  return { command: typeof entry.command === 'string' ? entry.command : null, env: env as Record<string, string> };
}

/**
 * Whether the command an agent's config starts Skeinwise with is there. On Windows a bare name is also found as an .exe
 * (a native install) or a .cmd (npm's shim).
 */
function commandFound(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (isAbsolute(command)) return existsSync(command);
  if (command.includes('/') || command.includes('\\')) return false;
  const names = platform === 'win32' ? [command, `${command}.exe`, `${command}.cmd`] : [command];
  return names.some((name) => onPath(name, env.PATH) !== null);
}

function checkMcp(home: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Finding[] {
  const out: Finding[] = [];
  let access: Access;
  try {
    access = readAccess(home);
  } catch (err) {
    return [{ check: 'mcp', status: 'problem', text: `agents.json can't be read (${message(err)}), so every agent is refused.`, fix: `Remove it and connect your agents again: rm ${quote(join(home, 'agents.json'))}` }];
  }
  if (access.locked) out.push({ check: 'mcp', status: 'note', text: 'Agent tools are locked: every agent call is refused.', fix: 'skeinwise mcp unlock' });
  const here = resolve(home);
  let connected = 0;
  for (const client of AGENT_CLIENTS) {
    const file = client.configFile(env);
    if (!existsSync(file)) continue;
    let entry;
    try {
      entry = readEntry(client, file);
    } catch (err) {
      out.push({ check: 'mcp', status: 'problem', text: `${client.label}'s config ${file} can't be read (${message(err)}).`, fix: `ls -l ${quote(file)}` });
      continue;
    }
    if (!entry) continue;
    if ('unreadable' in entry) {
      out.push({ check: 'mcp', status: 'problem', text: `${client.label}'s config ${file} ${entry.unreadable}, so ${client.label} starts no MCP server.`, fix: 'Fix it, or put back the copy skeinwise connect kept beside it' });
      continue;
    }
    const fix = `skeinwise connect ${client.key}`;
    const serves = entry.env.SKEINWISE_HOME ? resolve(entry.env.SKEINWISE_HOME) : env.SKEINWISE_HOME ? null : here;
    if (serves !== here) {
      out.push({ check: 'mcp', status: 'note', text: `${client.label} serves another record (${serves ?? 'the default one'}), not this one.`, fix });
      continue;
    }
    connected += 1;
    if (!entry.command || !commandFound(entry.command, env, platform)) {
      out.push({ check: 'mcp', status: 'problem', text: `${client.label} starts Skeinwise with ${entry.command ?? 'no command'}, which isn't there.`, fix });
      continue;
    }
    const token = entry.env[TOKEN_ENV];
    if (!token) {
      out.push({ check: 'mcp', status: 'problem', text: `${client.label}'s skeinwise server has no ${TOKEN_ENV}, so every call it makes is refused.`, fix });
      continue;
    }
    const agent = agentOfToken(access, token);
    if (!agent) {
      out.push({ check: 'mcp', status: 'problem', text: `${client.label}'s token isn't one this record knows (taken back, or replaced by a later connect).`, fix });
      continue;
    }
    out.push({ check: 'mcp', status: 'ok', text: `${client.label} is connected as ${agent} (${access.agents[agent]!.scope} scope)` });
  }
  if (!connected) out.push({ check: 'mcp', status: 'note', text: 'No agent is set up to use this record as its memory.', fix: 'skeinwise connect claude-code (or codex, cursor, claude-desktop)' });
  return out;
}

/** Everything doctor checks, in the order it prints them. */
export async function diagnose(home: string, env: NodeJS.ProcessEnv, deps: DoctorDeps): Promise<Finding[]> {
  return [
    checkNode(deps.nodeVersion),
    await checkSqlite(),
    checkRecord(home),
    ...checkModes(home, deps.platform),
    checkLive(home),
    await checkModel(home, env, deps),
    ...checkMcp(home, env, deps.platform),
  ];
}

/** `skeinwise doctor [--json]`: exit code 1 when anything is a problem. */
export async function doctor(ctx: SetupCtx, deps?: Partial<DoctorDeps>): Promise<number> {
  if (ctx.args.length) throw new UsageError('doctor takes no words; it checks the record in SKEINWISE_HOME (or ~/.skeinwise).');
  const findings = await diagnose(ctx.home, ctx.io.env, {
    nodeVersion: deps?.nodeVersion ?? process.versions.node,
    platform: deps?.platform ?? process.platform,
    fetch: deps?.fetch ?? ctx.io.fetch ?? globalThis.fetch,
  });
  const problems = findings.filter((f) => f.status === 'problem').length;
  if (ctx.values.json) {
    ctx.json({ home: ctx.home, problems, findings });
    return problems ? 1 : 0;
  }
  let text = '';
  for (const f of findings) {
    text += `  ${f.status.padEnd(9)}${f.text}\n`;
    if (f.fix && f.status !== 'ok') text += `${' '.repeat(11)}Fix: ${f.fix}\n`;
  }
  text += problems ? `\n${problems} problem${problems === 1 ? '' : 's'}, each with its fix above.\n` : '\nEverything Skeinwise needs is in place.\n';
  ctx.io.out(text);
  return problems ? 1 : 0;
}
