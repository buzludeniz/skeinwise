// `skeinwise model`: the model's chores. `check` asks the server for its models and runs one short test prompt (a
// recorded run, inside the budget, for the outside model). `trust` confirms a host the outside model's key may go to.
// `fetch` downloads the suggested model into the record folder's models/, after showing its size and source and
// asking first, and checks it against the size and sha256 pinned below. `serve` checks that file against the pin again,
// then prints (or with --run, runs) the llama-server command for it, locked with a key and closed to web pages. Weights never go anywhere but that folder,
// and nothing is downloaded without `fetch`.

import { spawn, spawnSync } from 'node:child_process';
import { createHash, type Hash, randomBytes } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  constants,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { once } from 'node:events';
import type { Ctx } from './cli-organiser.ts';
import { loadConfig, parseConfigValue, setConfigValue } from './config.ts';
import { UsageError } from './errors.ts';
import { createModel, isLoopback, serverKeyPath } from './organiser/model.ts';
import { checkBudget } from './organiser/organise.ts';
import { AnswerError, type ModelRequest } from './organiser/plan.ts';
import { currentMark, failRun, finishRun, startRun } from './organiser/runs.ts';

export interface SuggestedModel {
  name: string;
  repo: string;
  file: string;
  /** The repo revision the file is fetched from. */
  revision: string;
  /** The file's size and sha256, pinned here so that neither comes from the place the file does. */
  size: number;
  sha256: string;
}

/** The model Skeinwise suggests: small enough for a laptop, good enough to name hubs and keep to JSON. */
export const SUGGESTED: SuggestedModel = {
  name: 'Qwen3-4B, quantised to Q4_K_M',
  repo: 'Qwen/Qwen3-4B-GGUF',
  file: 'Qwen3-4B-Q4_K_M.gguf',
  // The repo's commit, with the file's size and sha256 as huggingface.co lists them there. A download that differs from
  // them is deleted. The ggml-org build of a file by the same name differs (sha256 ab27b9bf…b328, 2497280640 bytes), so
  // a copy from ggml-org/Qwen3-4B-GGUF doesn't match this pin.
  revision: 'bc640142c66e1fdd12af0bd68f40445458f3869b',
  size: 2_497_280_256,
  sha256: '7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5',
};
const HUB = 'https://huggingface.co';

/** The context the server is started with: enough for the longest organiser request with room to spare. */
const CONTEXT = 32768;

/** The lines for `skeinwise help` under "The local model:". */
export const MODEL_HELP = `  model check               Ask the model server for its model and run one short test prompt
      --engine remote       Check the outside model instead (one short request, recorded as a run)
  model trust [<host>]      Confirm a host the outside model's key may go to (remoteUrl's host by default)
      --yes                 Confirm without asking
  model fetch               Download the suggested model (Qwen3-4B, about 2.5 GB) into the
                            record folder's models/, after showing the size and source
      --yes                 Download without asking
  model serve [<file>]      Print the llama-server command for it (or for a .gguf of yours)
      --run                 Run it here instead, locked with the key in models/.key`;

export function modelsDir(home: string): string {
  return join(home, 'models');
}

export const modelCommand = async (ctx: Ctx): Promise<number> => {
  const [what, ...rest] = ctx.args;
  switch (what) {
    case 'check':
      if (rest.length) throw new UsageError('model check takes no words; it checks the server in your settings.');
      return check(ctx);
    case 'trust':
      if (rest.length > 1) throw new UsageError('model trust confirms one host at a time.');
      return trust(ctx, rest[0]);
    case 'fetch':
      if (rest.length) throw new UsageError(`model fetch downloads the suggested model (${SUGGESTED.file}) and takes no words.`);
      return fetchModel(ctx);
    case 'serve':
      if (rest.length > 1) throw new UsageError('model serve takes at most one model file.');
      return serve(ctx, rest[0]);
    default:
      throw new UsageError('Give one of: skeinwise model check, skeinwise model fetch, skeinwise model serve, skeinwise model trust <host>');
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
  const client = createModel(config, engine, { fetch: ctx.io.fetch ?? fetch, env: ctx.io.env, home: ctx.home });
  await client.probe();
  // A request to the outside model is a run like any other: inside the monthly budget, and in `skeinwise runs`.
  // The runs table has no task for a check, so it is recorded as an ask whose message says what it was.
  let runId: number | null = null;
  if (engine === 'remote') {
    const sent = client.prepare(CHECK_REQUEST);
    checkBudget(ctx.store, config.budget, Math.ceil((sent.system.length + sent.user.length) / 4) + CHECK_REQUEST.maxTokens, 'model check');
    runId = startRun(ctx.store.db, {
      task: 'ask',
      engine: 'remote',
      model: client.model,
      scope: 'all',
      mark: currentMark(ctx.store.db),
      detail: { check: true },
      now: ctx.store.now(),
    });
  }
  const started = performance.now();
  let reply: Awaited<ReturnType<typeof client.send>>;
  try {
    reply = await client.send(CHECK_REQUEST);
  } catch (err) {
    if (runId !== null) {
      const spent = err instanceof AnswerError ? err : { tokensIn: 0, tokensOut: 0 };
      failRun(ctx.store.db, runId, (err as Error).message, spent.tokensIn, spent.tokensOut, ctx.store.now());
    }
    throw err;
  }
  const { answer, tokensIn, tokensOut } = reply;
  const seconds = (performance.now() - started) / 1000;
  const ok = !!answer && typeof answer === 'object' && (answer as { ok?: unknown }).ok === true;
  if (runId !== null) finishRun(ctx.store.db, runId, { counts: { ok: ok ? 1 : 0 }, message: 'model check', tokensIn, tokensOut, now: ctx.store.now() });
  const result = { engine, model: client.model, url: client.url, ok, seconds: Number(seconds.toFixed(2)), tokensIn, tokensOut, ...(runId !== null ? { run: runId } : {}) };
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
  if (runId !== null) ctx.io.out(`Recorded as run ${runId}.\n`);
  return 0;
}

// trust

async function trust(ctx: Ctx, given: string | undefined): Promise<number> {
  const config = loadConfig(ctx.home);
  const from = given ?? config.remoteUrl;
  if (!from) throw new UsageError('Name the host to confirm, or set the outside model first: skeinwise config remoteUrl https://models.example.net/v1');
  const hosts = parseConfigValue('remoteHosts', from).value as string[];
  if (hosts.length !== 1) throw new UsageError('model trust confirms one host at a time.');
  const host = hosts[0]!;
  if (config.remoteHosts.includes(host)) {
    if (ctx.values.json) ctx.json({ host, confirmed: true, remoteHosts: config.remoteHosts });
    else ctx.io.out(`${host} is already confirmed.\n`);
    return 0;
  }
  if (!ctx.values.json) {
    const key = config.apiKeyEnv ? `the key in ${config.apiKeyEnv}` : 'the key in apiKeyEnv';
    const hidden = config.redaction ? 'secrets and personal details' : 'secrets';
    ctx.io.out(`Requests to the outside model at ${host} carry ${key}, and the text of what Skeinwise sends, with ${hidden} replaced.\n`);
  }
  if (!ctx.values.yes) {
    const answer = ctx.io.ask ? await ctx.io.ask(`Confirm ${host}? [y/N] `) : null;
    if (answer === null) throw new UsageError(`Add --yes to confirm ${host}.`);
    if (!/^y(es)?$/i.test(answer.trim())) {
      ctx.io.out('Nothing was confirmed.\n');
      return 0;
    }
  }
  const saved = setConfigValue(ctx.home, 'remoteHosts', [...config.remoteHosts, host].join(','));
  if (ctx.values.json) ctx.json({ host, confirmed: true, remoteHosts: saved.remoteHosts });
  else ctx.io.out(`Confirmed ${host}. The key may go to: ${saved.remoteHosts.join(', ')} (change the list with: skeinwise config remoteHosts).\n`);
  return 0;
}

// fetch

export function gigabytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} kB`;
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Whether a file is the one Skeinwise pins: its size first, which is quick, then its sha256. A file of the right size
 * isn't enough, because a planted or damaged one has to hash to the pin too. `hashing` runs before the slow part.
 */
async function isPinnedFile(file: string, hashing: () => void): Promise<boolean> {
  if (statSync(file).size !== SUGGESTED.size) return false;
  hashing();
  return (await hashFile(file)) === SUGGESTED.sha256;
}

async function fetchModel(ctx: Ctx): Promise<number> {
  const get = ctx.io.fetch ?? fetch;
  const { size, sha256 } = SUGGESTED;
  const dir = modelsDir(ctx.home);
  const target = join(dir, SUGGESTED.file);
  const part = `${target}.part`;
  const source = `${HUB}/${SUGGESTED.repo}/resolve/${SUGGESTED.revision}/${SUGGESTED.file}`;

  let replacing = false;
  if (existsSync(target)) {
    if (await isPinnedFile(target, () => !ctx.values.json && ctx.io.err(`Checking the sha256 of ${target}...\n`))) {
      if (ctx.values.json) ctx.json({ path: target, size, sha256, downloaded: false });
      else ctx.io.out(`${SUGGESTED.file} is already in ${dir} (${gigabytes(size)}, sha256 checked).\nStart it with: skeinwise model serve --run\n`);
      return 0;
    }
    replacing = true;
  }

  const have = existsSync(part) ? statSync(part).size : 0;
  const resume = have > 0 && have < size;
  if (!ctx.values.json) {
    ctx.io.out(`${SUGGESTED.name}: ${gigabytes(size)}\n`);
    ctx.io.out(`  from ${source}\n  to   ${target}\n`);
    if (replacing) ctx.io.out(`  The ${SUGGESTED.file} there isn't the one Skeinwise pins (its size or sha256 differs); the download replaces it.\n`);
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
  if (resume && res.status === 200) return download(ctx, res, part, target, createHash('sha256'), 0);
  if (!res.ok) throw new Error(`${source} answered ${res.status} ${res.statusText}. Nothing was saved as ${SUGGESTED.file}.`);
  return download(ctx, res, part, target, hash, start);
}

async function download(ctx: Ctx, res: Response, part: string, target: string, hash: Hash, start: number): Promise<number> {
  const { size, sha256 } = SUGGESTED;
  if (!res.body) throw new Error('The download came back empty.');
  const out = createWriteStream(part, { flags: start ? 'a' : 'w' });
  let got = start;
  let shown = Math.floor((got / size) * 10);
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      got += chunk.length;
      if (got > size) break;
      if (!out.write(chunk)) await once(out, 'drain');
      const tenth = Math.floor((got / size) * 10);
      if (tenth > shown) {
        shown = tenth;
        ctx.io.err(`  ${gigabytes(got)} of ${gigabytes(size)} (${tenth * 10}%)\n`);
      }
    }
  } catch (err) {
    // The connection broke: what came down is kept, and the next fetch asks only for the rest.
    throw new Error(`The download broke off at ${got} of ${size} bytes (${(err as Error).message}). Run skeinwise model fetch again to fetch the rest.`);
  } finally {
    out.end();
    await once(out, 'close');
  }
  // The server finished sending: anything but the pinned file is the wrong file, not a short one.
  const digest = hash.digest('hex');
  if (got !== size || digest !== sha256) {
    rmSync(part, { force: true });
    const sent = got > size ? `more than ${size} bytes` : `${got} bytes, sha256 ${digest}`;
    throw new Error(`sha256 mismatch: the download (${sent}) isn't the ${SUGGESTED.file} Skeinwise pins (${size} bytes, sha256 ${sha256}). It was deleted; nothing was saved.`);
  }
  renameSync(part, target);
  if (ctx.values.json) ctx.json({ path: target, size, sha256: digest, downloaded: true });
  else ctx.io.out(`Saved ${target} (${gigabytes(size)}, sha256 checked).\nStart it with: skeinwise model serve --run\nThen check it with: skeinwise model check\n`);
  return 0;
}

// serve

/** The flags that keep llama-server closed; `serve --run` checks the installed one lists each in its --help. */
export const LOCKED_FLAGS = ['--api-key-file', '--no-webui', '--no-slots', '--cors-origins', '--no-cors-credentials', '--alias'];

/** The llama-server command line for a model file, on the port of the local server in the settings. */
export function serveCommand(model: string, localUrl: string, keyFile: string, binary = 'llama-server'): string[] {
  const url = new URL(localUrl);
  if (!isLoopback(localUrl)) throw new UsageError(`localUrl ${localUrl} is not on this computer, so Skeinwise won't start a server for it.`);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return [
    binary,
    '-m',
    model,
    // The name the server lists for the model, instead of its path (which names the account it lives in).
    '--alias',
    basename(model).replace(/\.gguf$/i, ''),
    '--host',
    '127.0.0.1',
    '--port',
    port,
    '-c',
    String(CONTEXT),
    '-ngl',
    '99',
    '--jinja',
    // Closed to web pages: every request needs the key; no web UI, no slot listing; and CORS allows only the server's
    // own origin, which serves no page with the web UI off.
    '--api-key-file',
    keyFile,
    '--no-webui',
    '--no-slots',
    '--cors-origins',
    `http://127.0.0.1:${port}`,
    '--no-cors-credentials',
  ];
}

/** Makes the key file `model serve` starts llama-server with, once: random, and readable by the owner only. */
export function ensureServerKey(home: string): string {
  const file = serverKeyPath(home);
  mkdirSync(dirname(file), { recursive: true });
  try {
    writeFileSync(file, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  chmodSync(file, 0o600);
  return file;
}

/** The environment llama-server runs with: enough to run, and none of the keys or tokens in yours. */
export function serverEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ['PATH', 'HOME', 'LANG', 'TMPDIR']) {
    const value = env[name];
    if (value) out[name] = value;
  }
  return out;
}

function runnable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The first executable of that name on PATH, or null. */
export function onPath(name: string, path: string | undefined): string | null {
  for (const dir of (path ?? '').split(delimiter)) {
    if (!dir) continue;
    const file = join(dir, name);
    if (runnable(file)) return file;
  }
  return null;
}

/** Refuses a llama-server whose --help doesn't list every flag that keeps it closed. */
function checkFlags(binary: string, env: Record<string, string>): void {
  const help = spawnSync(binary, ['--help'], { env, encoding: 'utf8', timeout: 30_000 });
  const text = `${help.stdout ?? ''}\n${help.stderr ?? ''}`;
  const missing = LOCKED_FLAGS.filter((flag) => !new RegExp(`(?:^|[\\s,])${flag}(?=[\\s,]|$)`, 'm').test(text));
  if (missing.length) {
    throw new UsageError(
      `${binary} doesn't list ${missing.join(', ')} in its --help, so Skeinwise can't start it closed to web pages. ` +
        'Update llama.cpp (on macOS: brew upgrade llama.cpp), or point Skeinwise at a newer one: skeinwise config llamaServer <path>',
    );
  }
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
  // The pinned name is checked against the pin every time, since anything that can write to models/ could have put
  // another file there after `fetch` checked it. A .gguf you name yourself is yours to vouch for.
  if (!file && !(await isPinnedFile(model, () => !ctx.values.json && ctx.io.err(`Checking the sha256 of ${model}...\n`)))) {
    throw new Error(
      `${model} isn't the ${SUGGESTED.file} Skeinwise pins (its size or sha256 differs), so Skeinwise won't start it. ` +
        'Download it again with: skeinwise model fetch',
    );
  }
  // Resolved once from PATH, then kept: a program put earlier on PATH later doesn't take its place.
  const binary = config.llamaServer || onPath('llama-server', ctx.io.env.PATH);
  const argv = serveCommand(model, config.localUrl, serverKeyPath(ctx.home), binary ?? 'llama-server');
  const keyFile = ensureServerKey(ctx.home);
  if (!ctx.values.run) {
    if (ctx.values.json) ctx.json({ command: argv, model, url: config.localUrl, keyFile });
    else {
      ctx.io.out(`${argv.map(quote).join(' ')}\n\n`);
      ctx.io.out(`It answers only requests that carry the key in ${keyFile}, which Skeinwise sends.\n`);
      ctx.io.out('Run it in its own terminal, or let Skeinwise run it: skeinwise model serve --run\n');
    }
    return 0;
  }
  if (!binary) {
    throw new UsageError(
      'llama-server is not on your PATH. Install llama.cpp (on macOS: brew install llama.cpp), or run Ollama and point Skeinwise at it:\n' +
        '  skeinwise config localUrl http://127.0.0.1:11434/v1',
    );
  }
  if (!runnable(binary)) {
    throw new UsageError(`llamaServer is ${binary}, which isn't a program you can run. Point it at llama-server with: skeinwise config llamaServer <path>`);
  }
  const env = serverEnv(ctx.io.env);
  checkFlags(binary, env);
  if (!config.llamaServer) {
    setConfigValue(ctx.home, 'llamaServer', binary);
    ctx.io.err(`Using ${binary}, found on your PATH and saved as llamaServer. Change it with: skeinwise config llamaServer <path>\n`);
  }
  ctx.io.err(`Starting ${argv.map(quote).join(' ')}\nThe model answers at ${config.localUrl} once it has loaded. Press Ctrl+C to stop it.\n`);
  const child = spawn(binary, argv.slice(1), { stdio: 'inherit', env });
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
