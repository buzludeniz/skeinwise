// `skeinwise mcp`: the memory server (or with --window, the window server) on stdio for an AI agent, and the commands
// that allow agents and lock them all out. An MCP client starts the server itself, from a config like the ones in
// docs/mcp.md; stdout then carries only protocol messages, so everything else goes to stderr.

import { existsSync, readFileSync } from 'node:fs';
import type { Readable } from 'node:stream';
import type { Ctx } from '../cli-organiser.ts';
import { UsageError } from '../errors.ts';
import { allowAgent, checkAccess, quoteArg, readAccess, revokeAgent, setLocked } from './access.ts';
import { McpServer, serveStdio } from './protocol.ts';
import { INSTRUCTIONS, type MemoryCtx, MEMORY_TOOLS } from './tools.ts';
import { WINDOW_PORT, WINDOW_TOOLS, type WindowCtx } from './window.ts';

type Command = (ctx: Ctx) => number | Promise<number>;

/** The flags `skeinwise mcp` reads, beyond the ones every command has. */
export interface McpValues {
  window?: boolean;
  port?: string;
}

export const MCP_FLAGS = {
  window: { type: 'boolean' },
  port: { type: 'string' },
} as const;

const line = (command: string, text: string) => `  ${command.padEnd(26)}${text}\n`;
const flag = (name: string, text: string) => `      ${name.padEnd(22)}${text}\n`;

export const MCP_HELP =
  line('mcp', 'Serve your record to an AI agent over stdio (setup: docs/mcp.md)') +
  flag('--window', 'Serve the window tools instead: they move the app\'s view') +
  flag('--port <n>', `The app's port for --window (default ${WINDOW_PORT})`) +
  line('mcp allow <agent>', 'Let an agent use the record, by the name its client gives') +
  line('mcp revoke <agent>', "Take an agent's allowance back") +
  line('mcp agents', 'List allowed agents, the ones that asked, and the lock') +
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

/**
 * The memory server. Every tool call checks the access file first, so a lock, an allowance or a revoke takes effect on
 * the next call, without restarting the server.
 */
export function memoryServer(ctx: Ctx): McpServer<MemoryCtx> {
  const now = clock(ctx);
  return new McpServer<MemoryCtx>({
    name: 'skeinwise',
    version: version(),
    instructions: INSTRUCTIONS,
    tools: MEMORY_TOOLS,
    context: (agent) => ({ store: ctx.store, home: ctx.home, agent: checkAccess(ctx.home, agent, now()), now }),
    log: (text) => ctx.io.err(text),
  });
}

/** The window server, behind the same access check; it talks to the app on --port. */
export function windowServer(ctx: Ctx): McpServer<WindowCtx> {
  const now = clock(ctx);
  const target = { home: ctx.home, port: port(ctx.values as McpValues), fetch: ctx.io.fetch ?? fetch };
  return new McpServer<WindowCtx>({
    name: 'skeinwise-window',
    version: version(),
    instructions:
      "Moves the Skeinwise app's view while the user watches: show entries in the brain, open an entry or a hub, change the layout, highlight. Use ids from Skeinwise's memory server.",
    tools: WINDOW_TOOLS,
    context: (agent) => ({ ...target, store: ctx.store, agent: checkAccess(ctx.home, agent, now()) }),
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
      const allowed = allowAgent(ctx.home, name, clock(ctx)());
      if (ctx.values.json) ctx.json({ agent: allowed.name, allowed: true });
      else say(ctx, allowed.already ? `${allowed.name} was already allowed.` : `Allowed ${allowed.name}. It can read and write your record through skeinwise mcp now.`);
      return 0;
    }
    case 'revoke': {
      const revoked = revokeAgent(ctx.home, name);
      if (ctx.values.json) ctx.json({ agent: revoked, allowed: false });
      else say(ctx, `${revoked} isn't allowed any more; its next tool call is refused.`);
      return 0;
    }
    case 'agents': {
      const access = readAccess(ctx.home);
      if (ctx.values.json) {
        ctx.json(access);
        return 0;
      }
      const allowed = Object.entries(access.allowed);
      const asked = Object.entries(access.asked);
      say(ctx, access.locked ? 'Locked: every agent tool is stopped. Unlock with: skeinwise mcp unlock' : 'Unlocked.');
      say(ctx, allowed.length ? `Allowed:\n${allowed.map(([n, at]) => `  ${n}  (since ${at.slice(0, 10)})`).join('\n')}` : 'No agent is allowed yet.');
      if (asked.length) say(ctx, `Asked, not allowed:\n${asked.map(([n, at]) => `  ${n}  (last asked ${at.slice(0, 10)}; allow with: skeinwise mcp allow ${quoteArg(n)})`).join('\n')}`);
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
      throw new UsageError(`Unknown mcp command: ${sub}. Use allow, revoke, agents, lock or unlock, or no word to serve.`);
  }
};

export const MCP_COMMANDS: Record<string, Command> = { mcp };
