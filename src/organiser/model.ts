// Talking to a model: any server with the OpenAI chat completions API. The local engine talks to one on this computer
// (llama-server, Ollama, LM Studio and others), with the key `skeinwise model serve` gave llama-server; the remote
// engine to one elsewhere, with a key from an environment variable, sent only to hosts you confirmed. Text for the
// remote engine is always redacted (secrets always, a person's details when redaction is on), even when its URL is on
// this computer: a proxy there passes it on. Requests never follow redirects, settings can't change a request's model,
// messages or length, and errors never carry the key. Every answer must be one JSON object that the task's own check
// accepts. An answer that isn't (not JSON, cut off, or the wrong shape) is asked for once more, with what was wrong;
// a second bad answer throws a BadAnswerError, which carries the tokens of both.
//
// The local engine can also stream: `stream` hands over the answer's text as the model writes it, and its signal
// stops the request (llama-server stops writing when the connection closes).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { API_KEY_ENV, type Config, hostOf, MODEL_OPTIONS, type ModelOptions } from '../config.ts';
import { UsageError } from '../errors.ts';
import { AnswerError, type ModelClient, type ModelRequest, type Sent } from './plan.ts';
import { Redactor, scrubSecrets } from './redact.ts';

/** How long one request may take. A small model on a laptop can need minutes for a long answer. */
/** The longest one request to the model may take once sent. */
export const REQUEST_MS = 10 * 60 * 1000;
const PROBE_MS = 5000;

/**
 * A signal that aborts after `ms` as AbortSignal.timeout's does, with a TimeoutError, and a way to drop its timer once
 * the request is done. AbortSignal.timeout's timer and signal live their full time after the answer comes, ten minutes
 * for a request. Unref'd as that timer is, so a request in flight doesn't hold the process open by its deadline alone.
 */
function deadline(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), ms);
  timer.unref();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}
const REDACTED_NOTE = 'Some words are replaced by placeholders like [NAME_1]. Keep any placeholder you use exactly as written.';

export interface ModelDeps {
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  /** The record folder, which holds the local server's key; from SKEINWISE_HOME (or HOME) in env when not given. */
  home?: string;
}

/** A request that timed out once the server had it. A provider bills such a request all the same, so it counts in full. */
export class ModelTimeoutError extends AnswerError {}

/**
 * An answer still unusable after one repair: not JSON, cut off, or not the shape the task asked for. The runner can
 * do that request's part without the model.
 */
export class BadAnswerError extends AnswerError {}

/** A request its caller stopped. What the model wrote before it stopped counts. */
export class ModelCancelledError extends AnswerError {}

/** What a streamed request reports while it runs, and how its caller stops it. */
export interface Live {
  /** Each piece of the answer's text as the model writes it: the raw JSON, uncleaned. Only the local engine streams. */
  onText?: (piece: string) => void;
  /** The answer was bad and is asked for again: the text so far is void. */
  onRestart?: (why: string) => void;
  /** Stops the request. */
  signal?: AbortSignal;
}

export type Reply = { answer: unknown; tokensIn: number; tokensOut: number };

/** A model client that can also stream an answer and be stopped. */
export interface StreamingClient extends ModelClient {
  stream: (request: ModelRequest, live: Live) => Promise<Reply>;
}

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

export function createModel(config: Config, engine: 'local' | 'remote', deps: ModelDeps): StreamingClient {
  return engine === 'local' ? localModel(config, deps) : remoteModel(config, deps);
}

function localModel(config: Config, deps: ModelDeps): StreamingClient {
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
  const target = (): Target => {
    if (!resolved) throw new Error('The local model was not checked before sending; call probe first.');
    // Thinking models (Qwen3 and others) answer faster and in plain JSON with their thinking switched off. The server
    // keeps the prompt it last read, so a request that starts the same way (the same system prompt) reads only the
    // rest; llama-server does that by default, and cache_prompt asks for it in case.
    return { engine: 'local', url, key: readServerKey(deps), model: resolved, extra: { chat_template_kwargs: { enable_thinking: false }, cache_prompt: true } };
  };
  const model: StreamingClient = {
    engine: 'local',
    model: resolved,
    url,
    redacts: false,
    prepare: (request) => ({ system: request.system, user: request.user }),
    probe: async () => {
      if (probed) return;
      // The deadline covers reading the list too, and goes once the probe has its answer or fails.
      const timeout = deadline(PROBE_MS);
      let listed: unknown;
      try {
        let res: Response;
        try {
          res = await deps.fetch(`${url}/models`, { headers: keyHeader(readServerKey(deps)), redirect: 'error', signal: timeout.signal });
        } catch {
          throw new UsageError(startHelp(url));
        }
        if (res.status === 401) throw new UsageError(keyRefused(url));
        if (!res.ok) throw new UsageError(`${url}/models answered ${res.status}: is this an OpenAI-compatible server?\n\n${startHelp(url)}`);
        listed = await res.json().catch(() => null);
      } finally {
        timeout.clear();
      }
      const ids = modelIds(listed);
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
    send: async (request) => send(deps, target(), request, model.prepare(request), null, config.modelOptions),
    stream: async (request, live) => send(deps, target(), request, model.prepare(request), null, config.modelOptions, live),
  };
  return model;
}

function remoteModel(config: Config, deps: ModelDeps): StreamingClient {
  const missing: string[] = [];
  if (!config.remoteUrl) missing.push('skeinwise config remoteUrl https://api.example.com/v1');
  if (!config.remoteModel) missing.push('skeinwise config remoteModel <model name>');
  if (!config.apiKeyEnv) missing.push('skeinwise config apiKeyEnv <NAME_OF_THE_VARIABLE_HOLDING_THE_KEY>');
  if (missing.length) throw new UsageError(`The remote engine needs more settings:\n  ${missing.join('\n  ')}`);
  if (!API_KEY_ENV.test(config.apiKeyEnv)) {
    throw new UsageError(
      `Skeinwise reads a key only from a variable whose name starts with SKEINWISE_ or ends with _API_KEY, not ${config.apiKeyEnv}. ` +
        'Set one with: skeinwise config apiKeyEnv SKEINWISE_REMOTE_API_KEY',
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
    // Not streamed: its text has placeholders until the whole answer is back and restored. It can still be stopped.
    stream: async (request, live) => {
      confirmed();
      const { r, sent } = redactorFor(request);
      const quiet: Live = { ...(live.signal ? { signal: live.signal } : {}), ...(live.onRestart ? { onRestart: live.onRestart } : {}) };
      return send(deps, { engine: 'remote', url, key, model: config.remoteModel, extra: {} }, request, sent, r, config.modelOptions, quiet);
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

/**
 * A usage number the server reported, or null when it is missing, not a number, or not above zero. A request always
 * sends something and an answer always says something, so a server reporting 0 or less is wrong (or hiding what it
 * spent), and the caller counts its own estimate instead (E2, Deniz, Nov 25).
 */
function reported(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.ceil(value) : null;
}

interface Target {
  engine: 'local' | 'remote';
  url: string;
  key: string | null;
  model: string;
  /** Fixed fields the engine adds to every request. */
  extra: Record<string, unknown>;
}

type Message = { role: 'system' | 'user' | 'assistant'; content: string };

/** One answer as it came back: usable, or bad with what to tell the model about it. */
type Attempt = Reply & { content: string; bad: null | { message: string; repair: string } };

async function send(
  deps: ModelDeps,
  target: Target,
  request: ModelRequest,
  sent: Sent,
  redactor: Redactor | null,
  options: ModelOptions,
  live: Live = {},
): Promise<Reply> {
  const first = await attempt(deps, target, request, sent, redactor, options, [], live);
  if (!first.bad) return { answer: first.answer, tokensIn: first.tokensIn, tokensOut: first.tokensOut };
  // Once more, with the bad answer and what was wrong with it. The conversation so far is the server's cached prompt,
  // so only the new turn is read again. The remote engine's note is redacted like the rest: a check's reason can
  // quote the restored answer.
  live.onRestart?.(first.bad.message);
  const note = `That answer can't be used: ${first.bad.repair}. Answer again with only the JSON object asked for, in the shape asked for.`;
  const repair: Message[] = [
    { role: 'assistant', content: first.content },
    { role: 'user', content: redactor ? redactor.redact(note) : note },
  ];
  let second: Attempt;
  try {
    second = await attempt(deps, target, request, sent, redactor, options, repair, live);
  } catch (err) {
    if (err instanceof AnswerError) {
      err.tokensIn += first.tokensIn;
      err.tokensOut += first.tokensOut;
      throw err;
    }
    if (target.engine === 'remote') {
      // The first answer was spent at a provider that bills it, so its tokens go with the error.
      const spent = new AnswerError((err as Error).message);
      spent.tokensIn = first.tokensIn;
      spent.tokensOut = first.tokensOut;
      throw spent;
    }
    throw err;
  }
  const tokensIn = first.tokensIn + second.tokensIn;
  const tokensOut = first.tokensOut + second.tokensOut;
  if (!second.bad) return { answer: second.answer, tokensIn, tokensOut };
  const err = new BadAnswerError(second.bad.message);
  err.tokensIn = tokensIn;
  err.tokensOut = tokensOut;
  throw err;
}

async function attempt(
  deps: ModelDeps,
  target: Target,
  request: ModelRequest,
  sent: Sent,
  redactor: Redactor | null,
  options: ModelOptions,
  more: Message[],
  live: Live,
): Promise<Attempt> {
  const { url, key } = target;
  const { max_tokens: lower, ...sampling } = samplers(options);
  const maxTokens = Math.min(request.maxTokens, lower ?? request.maxTokens);
  // Only the local engine streams: a remote answer has placeholders in it until it is whole and restored.
  const streamed = !!live.onText && target.engine === 'local';
  const messages: Message[] = [{ role: 'system', content: sent.system }, { role: 'user', content: sent.user }, ...more];
  // Settings go first, so nothing in them can change the model, the messages, the length or the format.
  const body = {
    temperature: 0,
    ...sampling,
    model: target.model,
    messages,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
    ...(streamed ? { stream: true, stream_options: { include_usage: true } } : {}),
    ...target.extra,
  };
  const estimateIn = Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4);
  /** Server text made safe for a message or the runs table: no key, no secrets, one short line. */
  const clean = (text: string) => scrubSecrets(text, [key]).replace(/\s+/g, ' ').slice(0, 300);
  let content = '';
  const failed = (err: unknown): never => {
    if (live.signal?.aborted) {
      const stopped = new ModelCancelledError(`Stopped during ${request.purpose}.`);
      stopped.tokensIn = estimateIn;
      stopped.tokensOut = Math.ceil(content.length / 4);
      throw stopped;
    }
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
  const timeout = deadline(REQUEST_MS);
  let res: Response;
  let raw = '';
  let events: StreamEnd | null = null;
  try {
    res = await deps.fetch(`${url}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      redirect: 'error',
      signal: live.signal ? AbortSignal.any([live.signal, timeout.signal]) : timeout.signal,
    });
    if (streamed && res.ok && /^text\/event-stream\b/.test(res.headers.get('content-type') ?? '')) {
      events = await readEvents(res, (piece) => {
        content += piece;
        live.onText!(piece);
      });
    } else {
      raw = await res.text();
    }
  } catch (err) {
    return failed(err);
  } finally {
    // The answer is read whole, or the request failed or was stopped: its deadline goes now, not ten minutes on.
    timeout.clear();
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
  let finish: unknown;
  let usage: { prompt_tokens?: unknown; completion_tokens?: unknown } | undefined;
  if (events) {
    if (events.error !== null) fail(`${url} stopped with an error during ${request.purpose}: ${clean(events.error)}`, estimateIn, Math.ceil(content.length / 4));
    finish = events.finish;
    usage = events.usage;
  } else {
    let reply: { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[]; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
    try {
      reply = JSON.parse(raw);
    } catch {
      return fail(`${url} sent something that isn't a chat completion during ${request.purpose}: ${clean(raw)}`, estimateIn, most);
    }
    const choice = reply?.choices?.[0];
    const text = choice?.message?.content;
    if (typeof text !== 'string') return fail(`${url} sent no answer text during ${request.purpose}: ${clean(raw)}`, estimateIn, most);
    content = text;
    finish = choice?.finish_reason;
    usage = reply.usage;
    // A server that answered whole when asked to stream: its text arrives in one piece.
    if (streamed) live.onText!(content);
  }
  const tokensIn = reported(usage?.prompt_tokens) ?? estimateIn;
  const tokensOut = reported(usage?.completion_tokens) ?? (target.engine === 'remote' ? maxTokens : Math.ceil(content.length / 4));
  const bad = (message: string, repair: string): Attempt => ({ answer: null, tokensIn, tokensOut, content, bad: { message: scrubSecrets(message, [key]), repair } });
  if (finish === 'length') {
    return bad(`The model's answer for ${request.purpose} was cut off at ${maxTokens} tokens. Try a narrower --scope, or a model that writes less.`, `it was cut off at ${maxTokens} tokens, so write less`);
  }
  let answer: unknown;
  try {
    answer = parseAnswer(request.purpose, content);
  } catch (err) {
    return bad((err as Error).message, 'it is not one JSON object');
  }
  if (redactor) answer = redactor.restore(answer);
  try {
    request.check(answer);
  } catch (err) {
    const message = (err as Error).message;
    return bad(message, message.replace(/^The model's answer for .*? doesn't fit: /, ''));
  }
  return { answer, tokensIn, tokensOut, content, bad: null };
}

interface StreamEnd {
  finish: unknown;
  usage: { prompt_tokens?: unknown; completion_tokens?: unknown } | undefined;
  /** An error the server sent in the stream, or null. */
  error: string | null;
}

/** Reads a chat completion stream (server-sent events), handing each piece of answer text over as it arrives. */
async function readEvents(res: Response, onText: (piece: string) => void): Promise<StreamEnd> {
  const end: StreamEnd = { finish: undefined, usage: undefined, error: null };
  if (!res.body) return end;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  const line = (text: string): boolean => {
    if (!text.startsWith('data:')) return true;
    const data = text.slice(text.startsWith('data: ') ? 6 : 5);
    if (data === '[DONE]') return false;
    let event: { choices?: { delta?: { content?: unknown }; finish_reason?: unknown }[]; usage?: StreamEnd['usage']; error?: unknown };
    try {
      event = JSON.parse(data);
    } catch {
      end.error = `an event that isn't JSON: ${data}`;
      return false;
    }
    if (event.error !== undefined) {
      end.error = typeof event.error === 'object' && event.error && 'message' in event.error ? String(event.error.message) : JSON.stringify(event.error);
      return false;
    }
    const choice = event.choices?.[0];
    const piece = choice?.delta?.content;
    if (typeof piece === 'string' && piece) onText(piece);
    if (choice?.finish_reason) end.finish = choice.finish_reason;
    if (event.usage) end.usage = event.usage;
    return true;
  };
  for (;;) {
    const { done, value } = await reader.read();
    pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
    const lines = pending.split(/\r\n|\r|\n/);
    pending = done ? '' : lines.pop()!;
    for (const l of lines) {
      if (!line(l)) {
        await reader.cancel().catch(() => {});
        return end;
      }
    }
    if (done) return end;
  }
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
