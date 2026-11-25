// Talking to a model: any server with the OpenAI chat completions API. The local engine talks to one on this computer
// (llama-server, Ollama, LM Studio and others), with the key `skeinwise model serve` gave llama-server; the remote
// engine to one elsewhere, with a key from an environment variable, sent only to hosts you confirmed. Text for the
// remote engine is always redacted (secrets always, a person's details when redaction is on), even when its URL is on
// this computer: a proxy there passes it on. Requests never follow redirects, settings can't change a request's model,
// messages or length, and errors never carry the key. Every answer must be one JSON object; the task's own check then
// decides whether it fits.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { API_KEY_ENV, type Config, hostOf, MODEL_OPTIONS, type ModelOptions } from '../config.ts';
import { UsageError } from '../errors.ts';
import { AnswerError, type ModelClient, type ModelRequest, type Sent } from './plan.ts';
import { Redactor, scrubSecrets } from './redact.ts';

/** How long one request may take. A small model on a laptop can need minutes for a long answer. */
const REQUEST_MS = 10 * 60 * 1000;
const PROBE_MS = 5000;
const REDACTED_NOTE = 'Some words are replaced by placeholders like [NAME_1]. Keep any placeholder you use exactly as written.';

export interface ModelDeps {
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  /** The record folder, which holds the local server's key; from SKEINWISE_HOME (or HOME) in env when not given. */
  home?: string;
}

/** A request that timed out once the server had it. A provider bills such a request all the same, so it counts in full. */
export class ModelTimeoutError extends AnswerError {}

export function isLoopback(url: string): boolean {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** Where `skeinwise model serve` keeps the key it starts llama-server with (one line, owner-only). */
export function serverKeyPath(home: string): string {
  return join(home, 'models', '.key');
}

/** The local server's key, or null when `model serve` never made one. */
export function readServerKey(deps: ModelDeps): string | null {
  const home = deps.home ?? (deps.env.SKEINWISE_HOME || (deps.env.HOME ? join(deps.env.HOME, '.skeinwise') : ''));
  if (!home) return null;
  try {
    return readFileSync(serverKeyPath(home), 'utf8').split('\n')[0]!.trim() || null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** What to do when no local server answers. */
export function startHelp(url: string): string {
  const port = new URL(url).port || '80';
  return [
    `No model server answers at ${url}.`,
    'Start one on this computer with: skeinwise model serve --run',
    'or by hand, for example:',
    `  llama-server -m <model>.gguf --port ${port} --jinja`,
    'or run Ollama and point Skeinwise at it:',
    '  skeinwise config localUrl http://127.0.0.1:11434/v1',
    '  skeinwise config localModel <model name>',
    'To organise without a model, add --engine none (or: skeinwise config engine none).',
  ].join('\n');
}

/** What to do when the remote engine's host was never confirmed. */
export function untrustedHost(host: string, apiKeyEnv: string): string {
  return (
    `The key in ${apiKeyEnv} only goes to hosts you confirmed, and ${host} isn't one. ` +
    `If ${host} is the service you mean to use, confirm it once with: skeinwise model trust ${host}`
  );
}

export function createModel(config: Config, engine: 'local' | 'remote', deps: ModelDeps): ModelClient {
  return engine === 'local' ? localModel(config, deps) : remoteModel(config, deps);
}

function localModel(config: Config, deps: ModelDeps): ModelClient {
  const url = config.localUrl.replace(/\/+$/, '');
  if (!url) throw new UsageError('No local model server is set. Set one with: skeinwise config localUrl http://127.0.0.1:8731/v1');
  if (!isLoopback(url)) {
    throw new UsageError(
      `localUrl ${url} is not on this computer. The local engine only talks to 127.0.0.1, localhost or ::1; ` +
        'for a server elsewhere use the remote engine, which redacts text and keeps to a budget.',
    );
  }
  let resolved = config.localModel;
  let probed = false;
  const model: ModelClient = {
    engine: 'local',
    model: resolved,
    url,
    redacts: false,
    prepare: (request) => ({ system: request.system, user: request.user }),
    probe: async () => {
      if (probed) return;
      let res: Response;
      try {
        res = await deps.fetch(`${url}/models`, { headers: keyHeader(readServerKey(deps)), redirect: 'error', signal: AbortSignal.timeout(PROBE_MS) });
      } catch {
        throw new UsageError(startHelp(url));
      }
      if (res.status === 401) throw new UsageError(keyRefused(url));
      if (!res.ok) throw new UsageError(`${url}/models answered ${res.status}: is this an OpenAI-compatible server?\n\n${startHelp(url)}`);
      const ids = modelIds(await res.json().catch(() => null));
      if (!ids) throw new UsageError(`${url}/models didn't list models the OpenAI way ({"data": [{"id": ...}]}).`);
      if (resolved && !ids.includes(resolved)) {
        throw new UsageError(`The server at ${url} has no model "${resolved}". It has: ${ids.join(', ') || 'none'}. Change it with: skeinwise config localModel <name>`);
      }
      if (!resolved) {
        if (!ids.length) throw new UsageError(`The server at ${url} lists no models. Load one, or set: skeinwise config localModel <name>`);
        resolved = ids[0]!;
        model.model = resolved;
      }
      probed = true;
    },
    send: async (request) => {
      if (!resolved) throw new Error('The local model was not checked before sending; call probe first.');
      // Thinking models (Qwen3 and others) answer faster and in plain JSON with their thinking switched off.
      const target: Target = { engine: 'local', url, key: readServerKey(deps), model: resolved, extra: { chat_template_kwargs: { enable_thinking: false } } };
      return send(deps, target, request, model.prepare(request), null, config.modelOptions);
    },
  };
  return model;
}

function remoteModel(config: Config, deps: ModelDeps): ModelClient {
  const missing: string[] = [];
  if (!config.remoteUrl) missing.push('skeinwise config remoteUrl https://api.example.com/v1');
  if (!config.remoteModel) missing.push('skeinwise config remoteModel <model name>');
  if (!config.apiKeyEnv) missing.push('skeinwise config apiKeyEnv <NAME_OF_THE_VARIABLE_HOLDING_THE_KEY>');
  if (missing.length) throw new UsageError(`The remote engine needs more settings:\n  ${missing.join('\n  ')}`);
  if (!API_KEY_ENV.test(config.apiKeyEnv)) {
    throw new UsageError(
      `Skeinwise reads a key only from a variable whose name starts with SKEINWISE_ or ends with _API_KEY, not ${config.apiKeyEnv}. ` +
        'Set one with: skeinwise config apiKeyEnv OPENAI_API_KEY',
    );
  }
  const url = config.remoteUrl.replace(/\/+$/, '');
  if (!isLoopback(url) && !url.startsWith('https://')) throw new UsageError(`remoteUrl ${url} must use https: requests carry your key.`);
  const key = deps.env[config.apiKeyEnv];
  if (!key) throw new UsageError(`The environment variable ${config.apiKeyEnv} is not set; the remote engine reads its key from there.`);
  const host = hostOf(url);
  const confirmed = () => {
    if (!config.remoteHosts.includes(host)) throw new UsageError(untrustedHost(host, config.apiKeyEnv));
  };
  // The engine decides, not the host: a remote URL on this computer is a proxy or a tunnel to somewhere else.
  const redactorFor = (request: ModelRequest) => {
    const r = new Redactor(config.names, { personal: config.redaction });
    const system = r.redact(request.system);
    const user = r.redact(request.user);
    return { r, sent: { system: r.size ? `${system}\n${REDACTED_NOTE}` : system, user } };
  };
  return {
    engine: 'remote',
    model: config.remoteModel,
    url,
    redacts: true,
    prepare: (request) => redactorFor(request).sent,
    // A remote server is only reached by real requests: not every compatible service lists its models.
    probe: async () => confirmed(),
    send: async (request) => {
      confirmed();
      const { r, sent } = redactorFor(request);
      return send(deps, { engine: 'remote', url, key, model: config.remoteModel, extra: {} }, request, sent, r, config.modelOptions);
    },
  };
}

function modelIds(body: unknown): string[] | null {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { data?: unknown }).data)) return null;
  const ids = (body as { data: unknown[] }).data.map((m) => (m && typeof m === 'object' ? (m as { id?: unknown }).id : undefined));
  return ids.every((id): id is string => typeof id === 'string') ? ids : null;
}

function keyHeader(key: string | null): Record<string, string> {
  return key ? { authorization: `Bearer ${key}` } : {};
}

function keyRefused(url: string): string {
  return (
    `The model server at ${url} wants a key that Skeinwise doesn't have. ` +
    'Start the server with skeinwise model serve --run, which gives it the key Skeinwise sends.'
  );
}

/** The sampling settings a request may take from modelOptions. Anything else fails, rather than being dropped quietly. */
function samplers(options: ModelOptions): ModelOptions {
  const out: ModelOptions = {};
  for (const [k, v] of Object.entries(options)) {
    if (!(MODEL_OPTIONS as string[]).includes(k) || typeof v !== 'number' || !Number.isFinite(v)) {
      throw new UsageError(`modelOptions may only hold temperature, top_p and max_tokens, as numbers; "${k}" can't be set.`);
    }
    out[k as keyof ModelOptions] = v;
  }
  return out;
}

/** A usage number the server reported: never below zero, and null when it is missing or not a number. */
function reported(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.ceil(value)) : null;
}

interface Target {
  engine: 'local' | 'remote';
  url: string;
  key: string | null;
  model: string;
  /** Fixed fields the engine adds to every request. */
  extra: Record<string, unknown>;
}

async function send(
  deps: ModelDeps,
  target: Target,
  request: ModelRequest,
  sent: Sent,
  redactor: Redactor | null,
  options: ModelOptions,
): Promise<{ answer: unknown; tokensIn: number; tokensOut: number }> {
  const { url, key } = target;
  const { max_tokens: lower, ...sampling } = samplers(options);
  const maxTokens = Math.min(request.maxTokens, lower ?? request.maxTokens);
  // Settings go first, so nothing in them can change the model, the messages, the length or the format.
  const body = {
    temperature: 0,
    ...sampling,
    model: target.model,
    messages: [
      { role: 'system', content: sent.system },
      { role: 'user', content: sent.user },
    ],
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
    ...target.extra,
  };
  const estimateIn = Math.ceil((sent.system.length + sent.user.length) / 4);
  /** Server text made safe for a message or the runs table: no key, no secrets, one short line. */
  const clean = (text: string) => scrubSecrets(text, [key]).replace(/\s+/g, ' ').slice(0, 300);
  const failed = (err: unknown): never => {
    const e = err as Error & { cause?: { message?: unknown } };
    const timedOut = e.name === 'TimeoutError';
    const redirected = /redirect/i.test(`${e.message} ${String(e.cause?.message ?? '')}`);
    const why = timedOut ? `took longer than ${REQUEST_MS / 60000} minutes` : redirected ? 'answered with a redirect, which Skeinwise never follows,' : 'could not be reached';
    if (target.engine === 'local') throw new UsageError(`The model server ${why} during ${request.purpose}.${redirected ? '' : `\n\n${startHelp(url)}`}`);
    const message = `${url} ${why} during ${request.purpose}: ${clean(e.message)}`;
    if (!timedOut) throw new Error(message);
    const timeout = new ModelTimeoutError(`${message}. It counts in full against the budget: the server may have done the work.`);
    timeout.tokensIn = estimateIn;
    timeout.tokensOut = maxTokens;
    throw timeout;
  };
  const headers: Record<string, string> = { 'content-type': 'application/json', ...keyHeader(key) };
  let res: Response;
  let raw: string;
  try {
    res = await deps.fetch(`${url}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_MS),
    });
    raw = await res.text();
  } catch (err) {
    return failed(err);
  }
  if (target.engine === 'local' && res.status === 401) throw new UsageError(keyRefused(url));
  if (!res.ok) throw new Error(`${url} answered ${res.status} ${res.statusText} during ${request.purpose}: ${clean(raw)}`);
  // From here the server did the work, so a reply without usage counts the most the request allowed.
  const fail = (message: string, tokensIn: number, tokensOut: number): never => {
    const err = new AnswerError(message);
    err.tokensIn = tokensIn;
    err.tokensOut = tokensOut;
    throw err;
  };
  const most = target.engine === 'remote' ? maxTokens : 0;
  let reply: { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[]; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
  try {
    reply = JSON.parse(raw);
  } catch {
    return fail(`${url} sent something that isn't a chat completion during ${request.purpose}: ${clean(raw)}`, estimateIn, most);
  }
  const choice = reply?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== 'string') return fail(`${url} sent no answer text during ${request.purpose}: ${clean(raw)}`, estimateIn, most);
  const tokensIn = reported(reply.usage?.prompt_tokens) ?? estimateIn;
  const tokensOut = reported(reply.usage?.completion_tokens) ?? (target.engine === 'remote' ? maxTokens : Math.ceil(content.length / 4));
  if (choice?.finish_reason === 'length') {
    fail(`The model's answer for ${request.purpose} was cut off at ${maxTokens} tokens. Try a narrower --scope, or a model that writes less.`, tokensIn, tokensOut);
  }
  let answer: unknown;
  try {
    answer = parseAnswer(request.purpose, content);
  } catch (err) {
    fail(scrubSecrets((err as Error).message, [key]), tokensIn, tokensOut);
  }
  return { answer: redactor ? redactor.restore(answer) : answer, tokensIn, tokensOut };
}

/** The JSON object in an answer, after any thinking block and code fence around it. Anything else fails. */
export function parseAnswer(purpose: string, content: string): unknown {
  const text = content
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .trim()
    .replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/, '$1')
    .trim();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`The model's answer for ${purpose} is not JSON: ${text.replace(/\s+/g, ' ').slice(0, 200) || '(empty)'}`);
  }
}
