// Shared by the memory server's tests: a record with the demo in it, a command context, and JSON-RPC calls.

import { join } from 'node:path';
import type { Ctx } from '../../src/cli-organiser.ts';
import { DEMO_NOW, writeDemo } from '../../src/demo/demo.ts';
import { openHome } from '../../src/home.ts';
import { readImports } from '../../src/importers/detect.ts';
import { FRAME_OPEN, unframe } from '../../src/mcp/frame.ts';
import type { McpServer, Reply } from '../../src/mcp/protocol.ts';
import type { Store } from '../../src/store/store.ts';

export const LEGACY_VERSION = '2025-06-18';
export const MODERN_VERSION = '2026-07-28';

/** A record folder at `home` holding the demo's chats and notes. */
export function demoRecord(dir: string, home: string, now: () => string = () => DEMO_NOW): Store {
  const store = openHome(home, now);
  const exports = join(dir, 'exports');
  writeDemo(exports);
  for (const p of ['chatgpt', 'claude', 'claude-code', 'notes']) for (const b of readImports(join(exports, p))) store.ingest(b);
  return store;
}

export interface Output {
  out: string;
  err: string;
  json: unknown[];
}

/** A command context like the CLI's, with its output kept. `token` is the agent token its environment carries. */
export function context(
  home: string,
  store: Store,
  extra: { args?: string[]; values?: Record<string, unknown>; fetch?: typeof fetch; now?: () => string; token?: string } = {},
): {
  ctx: Ctx;
  output: Output;
} {
  const output: Output = { out: '', err: '', json: [] };
  const ctx: Ctx = {
    io: {
      out: (t) => (output.out += t),
      err: (t) => (output.err += t),
      env: { SKEINWISE_HOME: home, ...(extra.token ? { SKEINWISE_AGENT_TOKEN: extra.token } : {}) },
      ...(extra.fetch ? { fetch: extra.fetch } : {}),
      ...(extra.now ? { now: extra.now } : {}),
    },
    home,
    store,
    values: (extra.values ?? {}) as Ctx['values'],
    args: extra.args ?? [],
    json: (v) => output.json.push(v),
  };
  return { ctx, output };
}

let nextId = 1;

export async function rpc<C>(server: McpServer<C>, method: string, params: Record<string, unknown> = {}): Promise<Reply> {
  const reply = await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }));
  if (!reply) throw new Error(`${method} got no reply`);
  return reply;
}

/** Opens a legacy session as `agent`. */
export async function initialize<C>(server: McpServer<C>, agent: string | null = 'claude-code'): Promise<Reply> {
  return rpc(server, 'initialize', {
    protocolVersion: LEGACY_VERSION,
    capabilities: {},
    clientInfo: agent === null ? { version: '1' } : { name: agent, version: '1' },
  });
}

export interface ToolResult {
  isError: boolean;
  text: string;
  /** The parsed text, or the data inside a Skeinwise frame: tests read whatever shape the tool returned. */
  json: any;
}

/** Calls a tool and returns its text, parsed when it is JSON. */
export async function call<C>(server: McpServer<C>, name: string, args: Record<string, unknown> = {}, meta?: Record<string, unknown>): Promise<ToolResult> {
  const reply = await rpc(server, 'tools/call', { name, arguments: args, ...(meta ? { _meta: meta } : {}) });
  if (reply.error) throw new Error(`tools/call ${name}: ${reply.error.message}`);
  const result = reply.result as { content: { type: string; text: string }[]; isError?: boolean };
  const text = result.content[0]!.text;
  let json: unknown;
  try {
    json = text.startsWith(FRAME_OPEN) ? unframe(text) : JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { isError: result.isError === true, text, json };
}
