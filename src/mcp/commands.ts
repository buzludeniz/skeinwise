// `skeinwise mcp`: the memory server on stdio for an AI agent, and the commands that allow agents, take them back and
// lock them all out. An MCP client starts the server itself, from a config `skeinwise connect` writes or docs/mcp.md
// shows; stdout then carries only protocol messages, so everything else goes to stderr. The window server (--window)
// is kept for the app's own use and left out of the help and the docs for v1.0.

import { existsSync, readFileSync } from 'node:fs';
import type { Readable } from 'node:stream';
import type { Ctx } from '../cli-organiser.ts';
import { UsageError } from '../errors.ts';
import { allowAgent, checkAccess, denyAgent, quoteArg, readAccess, setLocked, TOKEN_ENV } from './access.ts';
import { McpServer, serveStdio } from './protocol.ts';
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
  line('mcp unlock', 'Let allowed agents use their tools again');

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

/** Serves the memory or window tools on the input until it closes. */
export async function serveMcp(ctx: Ctx, input: Readable): Promise<number> {
  if ((ctx.values as McpValues).window) {
    const server = windowServer(ctx);
    ctx.io.err(`skeinwise mcp: serving the window tools for ${ctx.home} (app on port ${port(ctx.values as McpValues)}).\n`);
    await serveStdio(server, input, ctx.io.out);
  } else {
    const server = memoryServer(ctx);
    ctx.io.err(`skeinwise mcp: serving the memory tools for ${ctx.home}.\n`);
    await serveStdio(server, input, ctx.io.out);
  }
  return 0;
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
    default:
      throw new UsageError(`Unknown mcp command: ${sub}. Use allow, deny, agents, lock or unlock, or no word to serve.`);
  }
};

export const MCP_COMMANDS: Record<string, Command> = { mcp };
