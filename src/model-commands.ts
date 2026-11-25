// `skeinwise model`: the local model's three chores. `check` asks the server for its models and runs one short test
// prompt. `fetch` downloads the suggested model into the record folder's models/, after showing its size and source
// and asking first, and checks it against the sha256 the source publishes. `serve` prints (or with --run, runs) the
// llama-server command for it. Weights never go anywhere but that folder, and nothing is downloaded without `fetch`.

import { spawn } from 'node:child_process';
import { createHash, type Hash } from 'node:crypto';
import { accessSync, constants, createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { once } from 'node:events';
import type { Ctx } from './cli-organiser.ts';
import { loadConfig } from './config.ts';
import { UsageError } from './errors.ts';
import { createModel, isLoopback } from './organiser/model.ts';
import type { ModelRequest } from './organiser/plan.ts';

/** The model Skeinwise suggests: small enough for a laptop, good enough to name hubs and keep to JSON. */
export const SUGGESTED = {
  name: 'Qwen3-4B, quantised to Q4_K_M',
  repo: 'Qwen/Qwen3-4B-GGUF',
  file: 'Qwen3-4B-Q4_K_M.gguf',
};
const HUB = 'https://huggingface.co';

/** The context the server is started with: enough for the longest organiser request with room to spare. */
const CONTEXT = 32768;

export function modelsDir(home: string): string {
  return join(home, 'models');
}

export const modelCommand = async (ctx: Ctx): Promise<number> => {
  const [what, ...rest] = ctx.args;
  switch (what) {
    case 'check':
      if (rest.length) throw new UsageError('model check takes no words; it checks the server in your settings.');
      return check(ctx);
    case 'fetch':
      if (rest.length) throw new UsageError(`model fetch downloads the suggested model (${SUGGESTED.file}) and takes no words.`);
      return fetchModel(ctx);
    case 'serve':
      if (rest.length > 1) throw new UsageError('model serve takes at most one model file.');
      return serve(ctx, rest[0]);
    default:
      throw new UsageError('Give one of: skeinwise model check, skeinwise model fetch, skeinwise model serve');
  }
};

// check

const CHECK_REQUEST: ModelRequest = {
  purpose: 'the model check',
  system: 'You answer with one JSON object and nothing else.',
  user: 'Reply with exactly this JSON object: {"ok": true}',
  maxTokens: 64,
  check: (answer) => answer,
};

async function check(ctx: Ctx): Promise<number> {
  const config = loadConfig(ctx.home);
  const engine = ctx.values.engine ?? 'local';
  if (engine === 'none') throw new UsageError('The No-AI engine has no model to check. Check the local model with: skeinwise model check');
  if (engine !== 'local' && engine !== 'remote') throw new UsageError(`Unknown engine "${engine}". Use local or remote.`);
  const client = createModel(config, engine, { fetch: ctx.io.fetch ?? fetch, env: ctx.io.env });
  await client.probe();
  const started = performance.now();
  const { answer, tokensIn, tokensOut } = await client.send(CHECK_REQUEST);
  const seconds = (performance.now() - started) / 1000;
  const ok = !!answer && typeof answer === 'object' && (answer as { ok?: unknown }).ok === true;
  const result = { engine, model: client.model, url: client.url, ok, seconds: Number(seconds.toFixed(2)), tokensIn, tokensOut };
  if (ctx.values.json) {
    ctx.json(result);
    return ok ? 0 : 1;
  }
  const who = engine === 'local' ? 'The local model' : 'The outside model';
  ctx.io.out(`${who} answers: ${client.model} at ${client.url}\n`);
  if (!ok) {
    ctx.io.out(`The test prompt came back as JSON, but not the object it asked for: ${JSON.stringify(answer).slice(0, 200)}\n`);
    ctx.io.out('Organiser answers may fail their checks with this model; a larger or instruction-tuned one may do better.\n');
    return 1;
  }
  ctx.io.out(`A test prompt came back as the JSON it asked for in ${seconds.toFixed(1)} s (${tokensIn} tokens in, ${tokensOut} out).\n`);
  return 0;
}

// fetch

interface Listed {
  size: number;
  sha256: string;
}

/** The file's size and sha256 as the source lists them. */
async function listed(get: typeof fetch): Promise<Listed> {
  const url = `${HUB}/api/models/${SUGGESTED.repo}/tree/main`;
  let res: Response;
  try {
    res = await get(url, { signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new Error(`Could not reach ${HUB} to look up ${SUGGESTED.file}: ${(err as Error).message}`);
  }
  if (!res.ok) throw new Error(`${url} answered ${res.status} ${res.statusText}.`);
  const files = (await res.json().catch(() => null)) as { path?: unknown; size?: unknown; lfs?: { oid?: unknown; size?: unknown } }[] | null;
  const file = Array.isArray(files) ? files.find((f) => f?.path === SUGGESTED.file) : undefined;
  const size = file?.lfs?.size ?? file?.size;
  const sha256 = file?.lfs?.oid;
  if (typeof size !== 'number' || typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(`${HUB}/${SUGGESTED.repo} no longer lists ${SUGGESTED.file} with a size and sha256, so it can't be checked. Nothing was downloaded.`);
  }
  return { size, sha256 };
}

export function gigabytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} kB`;
}

async function fetchModel(ctx: Ctx): Promise<number> {
  const get = ctx.io.fetch ?? fetch;
  const dir = modelsDir(ctx.home);
  const target = join(dir, SUGGESTED.file);
  const part = `${target}.part`;
  const source = `${HUB}/${SUGGESTED.repo}/resolve/main/${SUGGESTED.file}`;
  const { size, sha256 } = await listed(get);

  if (existsSync(target) && statSync(target).size === size) {
    if (ctx.values.json) ctx.json({ path: target, size, sha256, downloaded: false });
    else ctx.io.out(`${SUGGESTED.file} is already in ${dir} (${gigabytes(size)}).\nStart it with: skeinwise model serve --run\n`);
    return 0;
  }

  const have = existsSync(part) ? statSync(part).size : 0;
  const resume = have > 0 && have < size;
  if (!ctx.values.json) {
    ctx.io.out(`${SUGGESTED.name}: ${gigabytes(size)}\n`);
    ctx.io.out(`  from ${source}\n  to   ${target}\n`);
    if (resume) ctx.io.out(`  ${gigabytes(have)} came down before; the rest follows.\n`);
  }
  if (!ctx.values.yes) {
    const answer = ctx.io.ask ? await ctx.io.ask(`Download ${gigabytes(size - (resume ? have : 0))} now? [y/N] `) : null;
    if (answer === null) throw new UsageError('Add --yes to download it.');
    if (!/^y(es)?$/i.test(answer.trim())) {
      ctx.io.out('Nothing was downloaded.\n');
      return 0;
    }
  }

  mkdirSync(dir, { recursive: true });
  const hash = createHash('sha256');
  let start = 0;
  if (resume) {
    for await (const chunk of createReadStream(part)) hash.update(chunk as Buffer);
    start = have;
  }
  let res: Response;
  try {
    res = await get(source, resume ? { headers: { range: `bytes=${start}-` } } : {});
  } catch (err) {
    throw new Error(`Could not download ${source}: ${(err as Error).message}`);
  }
  // A server that ignores the range sends the whole file again: start over.
  if (resume && res.status === 200) return download(ctx, res, part, target, createHash('sha256'), 0, size, sha256);
  if (!res.ok) throw new Error(`${source} answered ${res.status} ${res.statusText}. Nothing was saved as ${SUGGESTED.file}.`);
  return download(ctx, res, part, target, hash, start, size, sha256);
}

async function download(ctx: Ctx, res: Response, part: string, target: string, hash: Hash, start: number, size: number, sha256: string): Promise<number> {
  if (!res.body) throw new Error('The download came back empty.');
  const out = createWriteStream(part, { flags: start ? 'a' : 'w' });
  let got = start;
  let shown = Math.floor((got / size) * 10);
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      got += chunk.length;
      if (got > size) throw new Error(`The download is larger than the ${size} bytes listed for ${SUGGESTED.file}.`);
      if (!out.write(chunk)) await once(out, 'drain');
      const tenth = Math.floor((got / size) * 10);
      if (tenth > shown) {
        shown = tenth;
        ctx.io.err(`  ${gigabytes(got)} of ${gigabytes(size)} (${tenth * 10}%)\n`);
      }
    }
  } finally {
    out.end();
    await once(out, 'close');
  }
  if (got !== size) {
    throw new Error(`The download stopped at ${got} of ${size} bytes. Run skeinwise model fetch again to fetch the rest.`);
  }
  const digest = hash.digest('hex');
  if (digest !== sha256) {
    rmSync(part, { force: true });
    throw new Error(`The download's sha256 is ${digest}, but the source lists ${sha256}. It was deleted; nothing was saved.`);
  }
  renameSync(part, target);
  if (ctx.values.json) ctx.json({ path: target, size, sha256, downloaded: true });
  else ctx.io.out(`Saved ${target} (${gigabytes(size)}, sha256 checked).\nStart it with: skeinwise model serve --run\nThen check it with: skeinwise model check\n`);
  return 0;
}

// serve

/** The llama-server command line for a model file, on the port of the local server in the settings. */
export function serveCommand(model: string, localUrl: string): string[] {
  const url = new URL(localUrl);
  if (!isLoopback(localUrl)) throw new UsageError(`localUrl ${localUrl} is not on this computer, so Skeinwise won't start a server for it.`);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return ['llama-server', '-m', model, '--host', '127.0.0.1', '--port', port, '-c', String(CONTEXT), '-ngl', '99', '--jinja'];
}

/** The first executable of that name on PATH, or null. */
export function onPath(name: string, path: string | undefined): string | null {
  for (const dir of (path ?? '').split(delimiter)) {
    if (!dir) continue;
    const file = join(dir, name);
    try {
      accessSync(file, constants.X_OK);
      if (statSync(file).isFile()) return file;
    } catch {
      // not here
    }
  }
  return null;
}

function quote(arg: string): string {
  return /^[\w./:=@-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

async function serve(ctx: Ctx, file: string | undefined): Promise<number> {
  const config = loadConfig(ctx.home);
  const model = file ? resolve(file) : join(modelsDir(ctx.home), SUGGESTED.file);
  if (!existsSync(model)) {
    throw new UsageError(
      file ? `There is no model file at ${model}.` : `The suggested model isn't in ${modelsDir(ctx.home)} yet. Fetch it with: skeinwise model fetch`,
    );
  }
  const argv = serveCommand(model, config.localUrl);
  if (!ctx.values.run) {
    if (ctx.values.json) ctx.json({ command: argv, model, url: config.localUrl });
    else ctx.io.out(`${argv.map(quote).join(' ')}\n\nRun it in its own terminal, or let Skeinwise run it: skeinwise model serve --run\n`);
    return 0;
  }
  const binary = onPath('llama-server', ctx.io.env.PATH);
  if (!binary) {
    throw new UsageError(
      'llama-server is not on your PATH. Install llama.cpp (on macOS: brew install llama.cpp), or run Ollama and point Skeinwise at it:\n' +
        '  skeinwise config localUrl http://127.0.0.1:11434/v1',
    );
  }
  ctx.io.err(`Starting ${argv.map(quote).join(' ')}\nThe model answers at ${config.localUrl} once it has loaded. Press Ctrl+C to stop it.\n`);
  const child = spawn(binary, argv.slice(1), { stdio: 'inherit', env: ctx.io.env });
  // Ctrl+C reaches the server too; wait for it to finish rather than leave it behind.
  const ignore = () => {};
  process.on('SIGINT', ignore);
  try {
    const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
    return code ?? (signal === 'SIGINT' ? 0 : 1);
  } finally {
    process.off('SIGINT', ignore);
  }
}
