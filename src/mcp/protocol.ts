// A small MCP server over stdio: JSON-RPC 2.0, one message per line. It speaks both eras of the protocol. Older clients
// open with `initialize`, whose clientInfo names the agent for the whole session. Clients on 2026-07-28 or later send
// no handshake and carry the version and their name in each request's _meta. Only tools are offered.

import type { Readable } from 'node:stream';
import { UsageError } from '../errors.ts';
import { AccessError } from './access.ts';

/** Versions that carry everything in each request's _meta. */
const MODERN = ['2026-07-28'];
/** Versions that open with an initialize handshake, newest first. */
const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const SUPPORTED_VERSIONS = [...MODERN, ...LEGACY];

const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CLIENT = 'io.modelcontextprotocol/clientInfo';

export type JsonSchema = Record<string, unknown>;

export interface Tool<C> {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  /** Changes nothing in the record. */
  readOnly: boolean;
  run: (ctx: C, args: Record<string, unknown>) => unknown;
}

export interface ServerOptions<C> {
  name: string;
  version: string;
  instructions: string;
  tools: Tool<C>[];
  /** Builds a tool's context for the agent calling it; it may refuse (AccessError) before the tool runs. */
  context: (agent: string | null) => C | Promise<C>;
  /** Where unexpected errors are logged; stdout belongs to the protocol. */
  log: (text: string) => void;
}

type Id = string | number;

interface Message {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export interface Reply {
  jsonrpc: '2.0';
  id: Id | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export class McpServer<C> {
  readonly options: ServerOptions<C>;
  /** The agent named by initialize, for legacy sessions. */
  agent: string | null = null;
  private initialized = false;

  constructor(options: ServerOptions<C>) {
    this.options = options;
  }

  /** Handles one line of input; returns the reply to write, or null for a notification. */
  async handleLine(line: string): Promise<Reply | null> {
    let msg: Message;
    try {
      msg = JSON.parse(line) as Message;
    } catch {
      return failure(null, new RpcError(-32700, 'Parse error: each line must be one JSON-RPC message.'));
    }
    if (Array.isArray(msg) || typeof msg !== 'object' || msg === null) {
      return failure(null, new RpcError(-32600, 'Invalid request: send one JSON-RPC message per line, not a batch.'));
    }
    // This server sends no requests, so a response is stray: answering it could look like a reply to the client's own id.
    if (!('method' in msg) && ('result' in msg || 'error' in msg)) return null;
    const isRequest = 'id' in msg && (typeof msg.id === 'string' || typeof msg.id === 'number');
    if (!isRequest) return null; // notifications (initialized, cancelled, …) need no reply
    const id = msg.id as Id;
    try {
      if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') throw new RpcError(-32600, 'Invalid request: needs jsonrpc "2.0" and a method.');
      const params = isObject(msg.params) ? msg.params : {};
      return { jsonrpc: '2.0', id, result: await this.dispatch(msg.method, params) };
    } catch (err) {
      if (err instanceof RpcError) return failure(id, err);
      this.options.log(`skeinwise mcp: ${(err as Error).stack ?? String(err)}\n`);
      return failure(id, new RpcError(-32603, `Internal error: ${(err as Error).message}`));
    }
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (method === 'initialize') return this.initialize(params);
    const meta = isObject(params._meta) ? params._meta : {};
    const requested = meta[META_VERSION];
    const modern = typeof requested === 'string' && !LEGACY.includes(requested);
    if (modern && !MODERN.includes(requested)) {
      throw new RpcError(-32022, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS, requested });
    }
    if (method === 'server/discover') return this.discover();
    if (method === 'ping') return complete({}, modern);
    if (!modern && !this.initialized) throw new RpcError(-32600, 'Send initialize first, or give a protocol version in _meta.');
    const client = meta[META_CLIENT];
    const agent = modern ? (isObject(client) && typeof client.name === 'string' ? client.name : null) : this.agent;
    if (method === 'tools/list') {
      const tools = this.options.tools.map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: { title: t.title, readOnlyHint: t.readOnly, destructiveHint: false, openWorldHint: false },
      }));
      return complete(modern ? { tools, ttlMs: 0, cacheScope: 'public' } : { tools }, modern);
    }
    if (method === 'tools/call') return complete(await this.call(params, agent), modern);
    throw new RpcError(-32601, `Method not found: ${method}`);
  }

  private initialize(params: Record<string, unknown>): Record<string, unknown> {
    const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const client = isObject(params.clientInfo) ? params.clientInfo : {};
    this.agent = typeof client.name === 'string' ? client.name : null;
    this.initialized = true;
    return {
      protocolVersion: LEGACY.includes(asked) ? asked : LEGACY[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: this.options.name, version: this.options.version },
      instructions: this.options.instructions,
    };
  }

  private discover(): Record<string, unknown> {
    return {
      resultType: 'complete',
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      instructions: this.options.instructions,
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: this.options.name, version: this.options.version } },
      ttlMs: 0,
      cacheScope: 'public',
    };
  }

  private async call(params: Record<string, unknown>, agent: string | null): Promise<Record<string, unknown>> {
    const tool = this.options.tools.find((t) => t.name === params.name);
    if (!tool) throw new RpcError(-32602, `Unknown tool: ${String(params.name)}`);
    const args = params.arguments === undefined ? {} : params.arguments;
    if (!isObject(args)) throw new RpcError(-32602, `The arguments for ${tool.name} must be an object.`);
    try {
      const ctx = await this.options.context(agent);
      const value = await tool.run(ctx, args);
      return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] };
    } catch (err) {
      // Refusals and mistakes go back to the agent as the tool's own result, so it can tell you or try again.
      if (!(err instanceof UsageError || err instanceof AccessError)) this.options.log(`skeinwise mcp: ${tool.name}: ${(err as Error).stack ?? String(err)}\n`);
      return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
    }
  }
}

function complete(result: Record<string, unknown>, modern: boolean): Record<string, unknown> {
  return modern ? { resultType: 'complete', ...result } : result;
}

function failure(id: Id | null, err: RpcError): Reply {
  return { jsonrpc: '2.0', id, error: { code: err.code, message: err.message, ...(err.data === undefined ? {} : { data: err.data }) } };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Serves until the input closes. Messages are handled one at a time, in order, so two writes never interleave; each
 * reply is written as one line.
 */
export function serveStdio<C>(server: McpServer<C>, input: Readable, write: (text: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let queue = Promise.resolve();
    const take = (line: string) => {
      if (!line.trim()) return;
      queue = queue.then(async () => {
        const reply = await server.handleLine(line);
        if (reply) write(`${JSON.stringify(reply)}\n`);
      });
    };
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => {
      buffer += chunk;
      let at: number;
      while ((at = buffer.indexOf('\n')) >= 0) {
        take(buffer.slice(0, at).replace(/\r$/, ''));
        buffer = buffer.slice(at + 1);
      }
    });
    input.on('end', () => {
      take(buffer);
      queue.then(resolve, reject);
    });
    input.on('error', reject);
  });
}
