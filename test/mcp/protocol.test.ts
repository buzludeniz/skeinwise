import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { UsageError } from '../../src/errors.ts';
import { AccessError } from '../../src/mcp/access.ts';
import { McpServer, serveStdio, SUPPORTED_VERSIONS, type Tool } from '../../src/mcp/protocol.ts';
import { LEGACY_VERSION, MODERN_VERSION } from './helpers.ts';

// The JSON-RPC layer on its own, with two toy tools: one echoes, one fails the ways a real tool can.

const TOOLS: Tool<{ agent: string | null }>[] = [
  {
    name: 'echo',
    title: 'Echo',
    description: 'Says who asked and what.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    readOnly: true,
    run: (ctx, a) => ({ agent: ctx.agent, text: a.text ?? null }),
  },
  {
    name: 'fail',
    title: 'Fail',
    description: 'Throws.',
    inputSchema: { type: 'object' },
    readOnly: false,
    run: (_ctx, a) => {
      if (a.how === 'usage') throw new UsageError('You asked for it.');
      if (a.how === 'text') return 'plain words';
      throw new Error('boom');
    },
  },
];

function server(opts: { refuse?: string } = {}) {
  const logged: string[] = [];
  const s = new McpServer({
    name: 'test',
    version: '9.9.9',
    instructions: 'Be kind.',
    tools: TOOLS,
    context: (agent) => {
      if (opts.refuse && agent === opts.refuse) throw new AccessError(`${agent} may not.`);
      return { agent };
    },
    log: (t) => logged.push(t),
  });
  return { s, logged };
}

const send = async <C>(s: McpServer<C>, message: unknown) => s.handleLine(JSON.stringify(message));
const meta = (version: string, name?: string) => ({
  _meta: { 'io.modelcontextprotocol/protocolVersion': version, ...(name ? { 'io.modelcontextprotocol/clientInfo': { name, version: '1' } } : {}) },
});

describe('the legacy handshake', () => {
  it('answers initialize with the version asked for, or its newest legacy one', async () => {
    const { s } = server();
    const reply = await send(s, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LEGACY_VERSION, clientInfo: { name: 'claude-code' } } });
    expect(reply).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: LEGACY_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'test', version: '9.9.9' }, instructions: 'Be kind.' },
    });
    expect(s.agent).toBe('claude-code');
    const other = await send(server().s, { jsonrpc: '2.0', id: 'a', method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    expect(other?.result?.protocolVersion).toBe('2025-11-25');
  });

  it('wants initialize before tools, and names the agent from it', async () => {
    const { s } = server();
    expect((await send(s, { jsonrpc: '2.0', id: 1, method: 'tools/list' }))?.error).toMatchObject({ code: -32600, message: /Send initialize first/ });
    await send(s, { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: LEGACY_VERSION, clientInfo: { name: 'cursor' } } });
    expect(await send(s, { jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    const list = await send(s, { jsonrpc: '2.0', id: 3, method: 'tools/list' });
    expect(list?.result).toEqual({
      tools: [
        expect.objectContaining({ name: 'echo', annotations: { title: 'Echo', readOnlyHint: true, destructiveHint: false, openWorldHint: false } }),
        expect.objectContaining({ name: 'fail', annotations: expect.objectContaining({ readOnlyHint: false }) }),
      ],
    });
    const echo = await send(s, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } });
    expect(echo?.result).toEqual({ content: [{ type: 'text', text: '{"agent":"cursor","text":"hi"}' }] });
  });
});

describe('the newer protocol, version and name in every request', () => {
  it('serves tools with no handshake and marks results complete', async () => {
    const { s } = server();
    const list = await send(s, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: meta(MODERN_VERSION) });
    expect(list?.result).toMatchObject({ resultType: 'complete', ttlMs: 0, cacheScope: 'public', tools: expect.any(Array) });
    const echo = await send(s, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', ...meta(MODERN_VERSION, 'codex') } });
    expect(echo?.result).toEqual({ resultType: 'complete', content: [{ type: 'text', text: '{"agent":"codex","text":null}' }] });
    expect(await send(s, { jsonrpc: '2.0', id: 3, method: 'ping', params: meta(MODERN_VERSION) })).toMatchObject({ result: { resultType: 'complete' } });
  });

  it('describes itself on server/discover', async () => {
    const reply = await send(server().s, { jsonrpc: '2.0', id: 1, method: 'server/discover', params: meta(MODERN_VERSION) });
    expect(reply?.result).toMatchObject({
      resultType: 'complete',
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      instructions: 'Be kind.',
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'test', version: '9.9.9' } },
    });
  });

  it('refuses a version it does not know, naming the ones it does', async () => {
    const reply = await send(server().s, { jsonrpc: '2.0', id: 7, method: 'tools/list', params: meta('2099-01-01') });
    expect(reply).toEqual({
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32022, message: 'Unsupported protocol version', data: { supported: SUPPORTED_VERSIONS, requested: '2099-01-01' } },
    });
  });
});

describe('errors', () => {
  it('answers malformed input with JSON-RPC errors', async () => {
    const { s } = server();
    expect(await s.handleLine('{nope')).toMatchObject({ id: null, error: { code: -32700 } });
    expect(await s.handleLine('[]')).toMatchObject({ id: null, error: { code: -32600 } });
    expect(await s.handleLine('42')).toMatchObject({ id: null, error: { code: -32600 } });
    expect(await send(s, { jsonrpc: '1.0', id: 1, method: 'ping' })).toMatchObject({ id: 1, error: { code: -32600 } });
    expect(await send(s, { jsonrpc: '2.0', id: 1, result: {} })).toBeNull(); // a stray response
    expect(await send(s, { jsonrpc: '2.0', id: 2, method: 'resources/list', params: meta(MODERN_VERSION) })).toMatchObject({
      id: 2,
      error: { code: -32601, message: 'Method not found: resources/list' },
    });
    expect(await send(s, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nope', ...meta(MODERN_VERSION) } })).toMatchObject({
      error: { code: -32602, message: 'Unknown tool: nope' },
    });
    expect(await send(s, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: [1], ...meta(MODERN_VERSION) } })).toMatchObject({
      error: { code: -32602 },
    });
  });

  it("returns a tool's failures as its result; only unexpected ones are logged", async () => {
    const { s, logged } = server({ refuse: 'mallory' });
    const callAs = (name: string | undefined, args: Record<string, unknown>) =>
      send(s, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fail', arguments: args, ...meta(MODERN_VERSION, name) } });
    expect((await callAs('a', { how: 'usage' }))?.result).toEqual({ resultType: 'complete', content: [{ type: 'text', text: 'You asked for it.' }], isError: true });
    expect((await callAs('mallory', {}))?.result).toMatchObject({ content: [{ text: 'mallory may not.' }], isError: true });
    expect((await callAs('a', { how: 'text' }))?.result).toEqual({ resultType: 'complete', content: [{ type: 'text', text: 'plain words' }] });
    expect(logged).toEqual([]);
    expect((await callAs('a', {}))?.result).toMatchObject({ content: [{ text: 'boom' }], isError: true });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/^skeinwise mcp: fail: Error: boom/);
  });
});

describe('serveStdio', () => {
  it('reads one message per line, however the bytes arrive, and answers in order', async () => {
    const { s } = server();
    const input = new PassThrough();
    let out = '';
    const done = serveStdio(s, input, (t) => (out += t));
    const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LEGACY_VERSION, clientInfo: { name: 'x' } } });
    input.write(init.slice(0, 10));
    input.write(`${init.slice(10)}\r\n\n${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { text: 'é' } } })}\n`);
    input.end(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' })); // the last line has no newline
    await done;
    const lines = out.split('\n');
    expect(lines.pop()).toBe('');
    expect(lines.map((l) => (JSON.parse(l) as { id: number }).id)).toEqual([1, 2, 3]);
    expect(JSON.parse(lines[1]!).result.content[0].text).toBe('{"agent":"x","text":"é"}');
  });
});
