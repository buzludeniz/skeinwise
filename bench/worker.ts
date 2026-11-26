// One bench measure in a fresh process, so each starts cold and its peak memory is its own. The bench starts it with
// SKEINWISE_HOME and HOME set to folders inside the bench folder, and it prints one JSON line (WorkerReport).
//
// Usage: node bench/worker.ts '<Job as JSON>'

import { request } from 'node:http';
import type { Ctx } from '../src/cli-organiser.ts';
import { main } from '../src/cli.ts';
import { openHome } from '../src/home.ts';
import { allowAgent, TOKEN_ENV } from '../src/mcp/access.ts';
import { unframe } from '../src/mcp/frame.ts';
import { memoryServer } from '../src/mcp/commands.ts';
import { startServer } from '../src/server/serve.ts';

export type Job =
  /** Skeinwise commands, one after another, as the CLI runs them. */
  | { kind: 'cli'; runs: string[][] }
  /** The app's first load of /api/brain, gzip accepted, as the browser asks for it. */
  | { kind: 'brain'; scanRoot: string }
  /** MCP tool calls from an allowed agent; `hubs` adds a read_hub call for each of the first few hubs. */
  | { kind: 'mcp'; calls: { name: string; args: Record<string, unknown> }[]; hubs: number };

export interface WorkerReport {
  /** Milliseconds per command, request or call, in order. */
  times: number[];
  /** Bytes printed (CLI), bytes on the wire (brain) or bytes of each JSON-RPC reply (MCP). */
  sizes: number[];
  /** What each CLI command printed, cut at 64 kB. */
  out: string[];
  /** The process's peak resident memory, in MB. */
  peakMB: number;
  /** The tool of each MCP call, in the order of `times`; empty for the other jobs. */
  tools: string[];
}

const MCP_VERSION = '2025-06-18';

/** Runs a job against the record in `env.SKEINWISE_HOME`, which must be set: the CLI would fall back to ~/.skeinwise. */
export async function work(job: Job, env: NodeJS.ProcessEnv): Promise<WorkerReport> {
  const home = env.SKEINWISE_HOME;
  if (!home) throw new Error('SKEINWISE_HOME is not set; the bench sets it to a folder of its own.');
  const report: WorkerReport = { times: [], sizes: [], out: [], peakMB: 0, tools: [] };
  if (job.kind === 'cli') {
    for (const argv of job.runs) {
      let out = '';
      let err = '';
      const start = performance.now();
      const code = await main(argv, { out: (t) => void (out += t), err: (t) => void (err += t), env });
      report.times.push(performance.now() - start);
      report.sizes.push(Buffer.byteLength(out));
      report.out.push(out.slice(0, 65_536));
      if (code !== 0) throw new Error(`skeinwise ${argv.join(' ')} exited ${code}: ${err.trim()}`);
    }
  } else if (job.kind === 'brain') {
    const app = await startServer({ home, port: 0, webDir: null, scanRoot: job.scanRoot });
    try {
      const start = performance.now();
      report.sizes.push(await download(app.port, '/api/brain', app.token));
      report.times.push(performance.now() - start);
    } finally {
      await app.close();
    }
  } else {
    const store = openHome(home);
    try {
      // The agent's token goes in its environment, as `skeinwise connect` writes it into an agent's MCP config.
      const { token } = allowAgent(home, 'bench', new Date().toISOString());
      const ctx: Ctx = {
        io: { out: () => {}, err: (t) => void process.stderr.write(t), env: { ...env, [TOKEN_ENV]: token } },
        home,
        store,
        values: {} as Ctx['values'],
        args: [],
        json: () => {},
      };
      const server = memoryServer(ctx);
      let id = 0;
      const send = async (method: string, params: Record<string, unknown>) => {
        const start = performance.now();
        const reply = await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }));
        const ms = performance.now() - start;
        if (!reply) throw new Error(`${method} got no reply`);
        const text = JSON.stringify(reply);
        const result = reply.result as { isError?: boolean; content?: { text: string }[] } | undefined;
        if (reply.error || result?.isError) throw new Error(`${method} ${JSON.stringify(params).slice(0, 200)} failed: ${text.slice(0, 300)}`);
        return { ms, bytes: Buffer.byteLength(text), body: result?.content?.[0]?.text ?? '' };
      };
      await send('initialize', { protocolVersion: MCP_VERSION, capabilities: {}, clientInfo: { name: 'bench', version: '1' } });
      const calls = [...job.calls];
      if (job.hubs > 0) {
        const listed = await send('tools/call', { name: 'list_hubs', arguments: {} });
        report.times.push(listed.ms);
        report.sizes.push(listed.bytes);
        report.tools.push('list_hubs');
        // A framed reply (src/mcp/frame.ts): `hubs` is the count, `entries` the hubs on this page.
        const { entries } = unframe(listed.body) as { entries: { id: number }[] };
        for (const h of entries.slice(0, job.hubs)) calls.push({ name: 'read_hub', args: { hub_id: h.id } });
      }
      for (const c of calls) {
        const r = await send('tools/call', { name: c.name, arguments: c.args });
        report.times.push(r.ms);
        report.sizes.push(r.bytes);
        report.tools.push(c.name);
      }
    } finally {
      store.db.close();
    }
  }
  report.peakMB = process.resourceUsage().maxRSS / 1024; // maxRSS is in kB
  return report;
}

/** Bytes of the response body as sent, compressed or not. */
function download(port: number, path: string, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { 'X-Skeinwise-Token': token, 'Accept-Encoding': 'gzip' } }, (res) => {
      let bytes = 0;
      res.on('data', (chunk: Buffer) => (bytes += chunk.length));
      res.on('end', () => (res.statusCode === 200 ? resolve(bytes) : reject(new Error(`${path} answered ${res.statusCode}`))));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

if (import.meta.main) {
  try {
    const report = await work(JSON.parse(process.argv[2] ?? '') as Job, process.env);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  }
}
