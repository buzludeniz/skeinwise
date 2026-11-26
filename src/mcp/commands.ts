// `skeinwise mcp`: the memory server on stdio for an AI agent, and the commands that allow agents, take them back and
// lock them all out. An MCP client starts the server itself, from a config `skeinwise connect` writes or docs/mcp.md
// shows; stdout then carries only protocol messages, so everything else goes to stderr. The window server
// (windowServer) isn't served in 1.0: --window refuses with a usage error, and it is left out of the help and the docs.

import { existsSync, readFileSync } from 'node:fs';
import type { Readable } from 'node:stream';
import type { Ctx } from '../cli-organiser.ts';
import { needId, UsageError } from '../errors.ts';
import { safeLine } from '../safe-text.ts';
import { allowAgent, checkAccess, denyAgent, quoteArg, readAccess, setLocked, TOKEN_ENV } from './access.ts';
import { type LogRecord, readLog } from './log.ts';
import { McpServer, serveStdio } from './protocol.ts';
import { confirmRequest, pendingRequests, refuseRequest } from './requests.ts';
import { type Caller, MemorySession } from './session.ts';
import { INSTRUCTIONS } from './tools.ts';
import { WINDOW_PORT, WINDOW_TOOLS, type WindowCtx } from './window.ts';

type Command = (ctx: Ctx) => number | Promise<number>;

/** The flags `skeinwise mcp` reads, beyond the ones every command has. */
export interface McpValues {
  window?: boolean;
  port?: string;
  write?: boolean;
}

export const MCP_FLAGS = {
  window: { type: 'boolean' },
  port: { type: 'string' },
  write: { type: 'boolean' },
} as const;

const line = (command: string, text: string) => `  ${command.padEnd(26)}${text}\n`;
const flag = (name: string, text: string) => `      ${name.padEnd(22)}${text}\n`;

export const MCP_HELP =
  line('mcp', 'Serve your record to an AI agent over stdio (setup: skeinwise connect)') +
  line('mcp allow <agent>', 'Give an agent a token to read the record; it is shown once') +
  flag('--write', 'Let it write notes and tags too') +
  line('mcp deny <agent>', "Take an agent's token back (also: mcp revoke)") +
  line('mcp agents', 'List the allowed agents, their scope, and the lock') +
  line('mcp lock', 'Stop every agent tool until you unlock') +
  line('mcp unlock', 'Let allowed agents use their tools again') +
  line('mcp log', 'What agents asked for and were sent, newest last (--limit <n>)') +
  line('mcp pending', 'Changes agents asked for that wait for your yes') +
  line('mcp confirm <n>', 'Make the change request n asked for') +
  line('mcp refuse <n>', 'Drop request n; nothing changes');

function version(): string {
  // package.json sits two levels up from src/mcp/ and three from dist/src/mcp/.
  for (const rel of ['../../package.json', '../../../package.json']) {
    const url = new URL(rel, import.meta.url);
    if (existsSync(url)) return (JSON.parse(readFileSync(url, 'utf8')) as { version: string }).version;
  }
  return '0.0.0';
}

function clock(ctx: Ctx): () => string {
  return ctx.io.now ?? (() => new Date().toISOString());
}

function port(values: McpValues): number {
  if (values.port === undefined) return WINDOW_PORT;
  const n = Number(values.port);
  if (!/^\d+$/.test(values.port) || n < 1 || n > 65535) throw new UsageError(`--port must be a port number, not "${values.port}".`);
  return n;
}

function token(ctx: Ctx): string | undefined {
  return ctx.io.env[TOKEN_ENV];
}

/**
 * The memory server. Every tool call checks the access file first, so a lock, an allowance or a deny takes effect on
 * the next call, without restarting the server. The agent is the one whose token the client's environment carries.
 */
export function memoryServer(ctx: Ctx): McpServer<Caller> {
  const session = new MemorySession({ store: ctx.store, home: ctx.home, token: token(ctx), now: clock(ctx) });
  return new McpServer<Caller>({
    name: 'skeinwise',
    version: version(),
    instructions: INSTRUCTIONS,
    tools: session.tools,
    listed: () => session.listed(),
    context: (label) => ({ label }),
    log: (text) => ctx.io.err(text),
  });
}

/** The window server, behind the same access check; it talks to the app on --port. */
export function windowServer(ctx: Ctx): McpServer<WindowCtx> {
  const target = { home: ctx.home, port: port(ctx.values as McpValues), fetch: ctx.io.fetch ?? fetch };
  return new McpServer<WindowCtx>({
    name: 'skeinwise-window',
    version: version(),
    instructions:
      "Moves the Skeinwise app's view while the user watches: show entries in the brain, open an entry or a hub, change the layout, highlight. Use ids from Skeinwise's memory server.",
    tools: WINDOW_TOOLS,
    context: (label) => ({ ...target, store: ctx.store, agent: checkAccess(ctx.home, token(ctx), label).agent }),
    log: (text) => ctx.io.err(text),
  });
}

/** Serves the memory tools on the input until it closes. 1.0 serves no window tools: --window is refused. */
export async function serveMcp(ctx: Ctx, input: Readable): Promise<number> {
  if ((ctx.values as McpValues).window) {
    throw new UsageError("skeinwise mcp --window isn't available in 1.0. Agents use skeinwise mcp over stdio; skeinwise connect sets one up.");
  }
  const server = memoryServer(ctx);
  ctx.io.err(`skeinwise mcp: serving the memory tools for ${ctx.home}.\n`);
  await serveStdio(server, input, ctx.io.out);
  return 0;
}

/** One log record as a line of text; what the agent sent is made safe to print. */
function logRow(r: LogRecord): string {
  const who = r.agent ?? 'unknown agent';
  const called = r.label && r.label !== r.agent ? ` (calls itself "${safeLine(r.label).slice(0, 64)}")` : '';
  const ids = r.entry_ids ? `entries ${r.entry_ids.join(', ')}` : r.hub_ids ? `hubs ${r.hub_ids.join(', ')}` : 'no entries';
  const what =
    r.outcome === 'ok'
      ? `${ids}, ${(r.bytes / 1024).toFixed(1)} KB${r.truncated ? ', cut to fit' : ''}`
      : `${r.outcome}: ${safeLine(r.reason ?? '').slice(0, 160)}`;
  return `${r.at.slice(0, 19).replace('T', ' ')}  ${who}${called}  ${r.tool} ${safeLine(JSON.stringify(r.args)).slice(0, 120)}  ${what}`;
}

function say(ctx: Ctx, text: string): void {
  ctx.io.out(text.endsWith('\n') ? text : `${text}\n`);
}

const mcp: Command = async (ctx) => {
  const [sub, ...rest] = ctx.args;
  const name = rest.join(' ');
  switch (sub) {
    case undefined:
      if (process.stdin.isTTY) {
        ctx.io.err('skeinwise mcp: waiting for an MCP client on stdin. An agent starts this itself; docs/mcp.md has the config.\n');
      }
      return serveMcp(ctx, process.stdin);
    case 'allow': {
      const allowed = allowAgent(ctx.home, name, clock(ctx)(), (ctx.values as McpValues).write ? 'write' : 'read');
      if (ctx.values.json) {
        ctx.json({ agent: allowed.name, scope: allowed.scope, token: allowed.token, replaced: allowed.replaced });
        return 0;
      }
      const can = allowed.scope === 'write' ? 'read and write' : 'read';
      say(
        ctx,
        `Allowed ${allowed.name} to ${can} your record.${allowed.replaced ? ' Its earlier token stops working now.' : ''} Its token, shown only this once:\n\n` +
          `  ${allowed.token}\n\n` +
          `Give it to the agent's MCP config as ${TOKEN_ENV}, or let "skeinwise connect" write the config for you.`,
      );
      return 0;
    }
    case 'deny':
    case 'revoke': {
      const denied = denyAgent(ctx.home, name);
      if (ctx.values.json) ctx.json({ agent: denied, allowed: false });
      else say(ctx, `${denied} isn't allowed any more; its next tool call is refused.`);
      return 0;
    }
    case 'agents': {
      const access = readAccess(ctx.home);
      const agents = Object.entries(access.agents);
      if (ctx.values.json) {
        ctx.json({ locked: access.locked, allowed: Object.fromEntries(agents.map(([n, g]) => [n, { scope: g.scope, since: g.since, token: g.tokenHash !== null }])) });
        return 0;
      }
      say(ctx, access.locked ? 'Locked: every agent tool is stopped. Unlock with: skeinwise mcp unlock' : 'Unlocked.');
      const row = ([n, g]: (typeof agents)[number]) =>
        g.tokenHash === null
          ? `  ${n}  (allowed before tokens: give it one with skeinwise mcp allow ${quoteArg(n)}${g.scope === 'write' ? ' --write' : ''})`
          : `  ${n}  ${g.scope}  (since ${g.since.slice(0, 10)})`;
      say(ctx, agents.length ? `Allowed:\n${agents.map(row).join('\n')}` : 'No agent is allowed yet. Connect one with: skeinwise connect claude-code');
      return 0;
    }
    case 'lock':
      if (rest.length) throw new UsageError('mcp lock takes no arguments.');
      say(ctx, setLocked(ctx.home, true) ? 'Already locked.' : 'Locked: every agent tool is stopped until you run skeinwise mcp unlock.');
      return 0;
    case 'unlock':
      if (rest.length) throw new UsageError('mcp unlock takes no arguments.');
      say(ctx, setLocked(ctx.home, false) ? 'Unlocked: allowed agents can use their tools again.' : 'It was not locked.');
      return 0;
    case 'log': {
      if (rest.length) throw new UsageError('mcp log takes no arguments; use --limit <n> for more or fewer calls.');
      const records = readLog(ctx.home, ctx.values.limit ? needId(ctx.values.limit, 'limit') : 20);
      if (ctx.values.json) {
        ctx.json(records);
        return 0;
      }
      if (!records.length) {
        say(ctx, 'No agent has called a Skeinwise tool yet.');
        return 0;
      }
      say(ctx, records.map(logRow).join('\n'));
      return 0;
    }
    case 'pending': {
      if (rest.length) throw new UsageError('mcp pending takes no arguments.');
      const waiting = pendingRequests(ctx.home, clock(ctx)());
      if (ctx.values.json) {
        ctx.json(waiting);
        return 0;
      }
      if (!waiting.length) {
        say(ctx, 'No agent request is waiting.');
        return 0;
      }
      const rows = waiting.map((r) => `  ${r.id}  ${r.at.slice(0, 16).replace('T', ' ')}  ${r.agent} asks: ${safeLine(r.what)}`);
      say(ctx, `Waiting for your yes:\n${rows.join('\n')}\nConfirm with: skeinwise mcp confirm <n>. Refuse with: skeinwise mcp refuse <n>.`);
      return 0;
    }
    case 'confirm': {
      if (rest.length !== 1) throw new UsageError('Give the request number: skeinwise mcp confirm <n>. "skeinwise mcp pending" lists them.');
      const done = confirmRequest(ctx.home, ctx.store, needId(rest[0], 'request'), clock(ctx)());
      if (ctx.values.json) ctx.json(done);
      else if (done.request.tool === 'not_mine') say(ctx, `Done: thread ${done.request.target} is left out now. Bring it back with: skeinwise not-mine ${done.request.target} --undo`);
      else say(ctx, `Done: run ${done.request.target} is undone.`);
      return 0;
    }
    case 'refuse': {
      if (rest.length !== 1) throw new UsageError('Give the request number: skeinwise mcp refuse <n>. "skeinwise mcp pending" lists them.');
      const dropped = refuseRequest(ctx.home, needId(rest[0], 'request'), clock(ctx)());
      if (ctx.values.json) ctx.json({ refused: dropped });
      else say(ctx, `Refused request ${dropped.id}; nothing changed.`);
      return 0;
    }
    default:
      throw new UsageError(`Unknown mcp command: ${sub}. Use allow, deny, agents, lock, unlock, log, pending, confirm or refuse, or no word to serve.`);
  }
};

export const MCP_COMMANDS: Record<string, Command> = { mcp };
