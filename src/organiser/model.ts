// Talking to a model: any server with the OpenAI chat completions API. The local engine talks to one on this computer
// (llama-server, Ollama, LM Studio and others); the remote engine to one elsewhere, with a key from an environment
// variable. Text for a server that is not on this computer is redacted first, when redaction is on. Every answer must
// be one JSON object; the task's own check then decides whether it fits.

import type { Config } from '../config.ts';
import { UsageError } from '../errors.ts';
import { AnswerError, type ModelClient, type ModelRequest, type Sent } from './plan.ts';
import { Redactor } from './redact.ts';

/** How long one request may take. A small model on a laptop can need minutes for a long answer. */
const REQUEST_MS = 10 * 60 * 1000;
const PROBE_MS = 5000;
const REDACTED_NOTE = 'Some words are replaced by placeholders like [NAME_1]. Keep any placeholder you use exactly as written.';

export interface ModelDeps {
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
}

export function isLoopback(url: string): boolean {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** What to do when no local server answers. */
export function startHelp(url: string): string {
  const port = new URL(url).port || '80';
  return [
    `No model server answers at ${url}.`,
    'Start one on this computer, for example:',
    `  llama-server -m <model>.gguf --port ${port} --jinja`,
    'or run Ollama and point Skeinwise at it:',
    '  skeinwise config localUrl http://127.0.0.1:11434/v1',
    '  skeinwise config localModel <model name>',
    'To organise without a model, add --engine none (or: skeinwise config engine none).',
  ].join('\n');
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
        res = await deps.fetch(`${url}/models`, { signal: AbortSignal.timeout(PROBE_MS) });
      } catch {
        throw new UsageError(startHelp(url));
      }
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
    send: (request) => {
      if (!resolved) throw new Error('The local model was not checked before sending; call probe first.');
      // Thinking models (Qwen3 and others) answer faster and in plain JSON with their thinking switched off.
      return send(deps, url, null, resolved, request, model.prepare(request), new Redactor([]), { chat_template_kwargs: { enable_thinking: false } }, config);
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
  const url = config.remoteUrl.replace(/\/+$/, '');
  const local = isLoopback(url);
  if (!local && !url.startsWith('https://')) throw new UsageError(`remoteUrl ${url} must use https: requests carry your key.`);
  const key = deps.env[config.apiKeyEnv];
  if (!key) throw new UsageError(`The environment variable ${config.apiKeyEnv} is not set; the remote engine reads its key from there.`);
  const redacts = config.redaction && !local;
  const redactorFor = (request: ModelRequest) => {
    const r = new Redactor(redacts ? config.names : []);
    const system = redacts ? r.redact(request.system) : request.system;
    const user = redacts ? r.redact(request.user) : request.user;
    return { r, sent: { system: r.size ? `${system}\n${REDACTED_NOTE}` : system, user } };
  };
  return {
    engine: 'remote',
    model: config.remoteModel,
    url,
    redacts,
    prepare: (request) => redactorFor(request).sent,
    // A remote server is only reached by real requests: not every compatible service lists its models.
    probe: async () => {},
    send: (request) => {
      const { r, sent } = redactorFor(request);
      return send(deps, url, key, config.remoteModel, request, sent, r, {}, config);
    },
  };
}

function modelIds(body: unknown): string[] | null {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { data?: unknown }).data)) return null;
  const ids = (body as { data: unknown[] }).data.map((m) => (m && typeof m === 'object' ? (m as { id?: unknown }).id : undefined));
  return ids.every((id): id is string => typeof id === 'string') ? ids : null;
}

async function send(
  deps: ModelDeps,
  url: string,
  key: string | null,
  model: string,
  request: ModelRequest,
  sent: Sent,
  redactor: Redactor,
  extra: Record<string, unknown>,
  config: Config,
): Promise<{ answer: unknown; tokensIn: number; tokensOut: number }> {
  const body = {
    model,
    messages: [
      { role: 'system', content: sent.system },
      { role: 'user', content: sent.user },
    ],
    max_tokens: request.maxTokens,
    temperature: 0,
    response_format: { type: 'json_object' },
    ...extra,
    ...config.modelOptions,
  };
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  let res: Response;
  try {
    res = await deps.fetch(`${url}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(REQUEST_MS) });
  } catch (err) {
    const why = (err as Error).name === 'TimeoutError' ? `took longer than ${REQUEST_MS / 60000} minutes` : 'could not be reached';
    if (!key) throw new UsageError(`The model server ${why} during ${request.purpose}.\n\n${startHelp(url)}`);
    throw new Error(`${url} ${why} during ${request.purpose}: ${(err as Error).message}`);
  }
  const raw = await res.text();
  const scrub = (s: string) => (key ? s.split(key).join('***') : s).replace(/\s+/g, ' ').slice(0, 300);
  if (!res.ok) throw new Error(`${url} answered ${res.status} ${res.statusText} during ${request.purpose}: ${scrub(raw)}`);
  let reply: { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[]; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
  try {
    reply = JSON.parse(raw);
  } catch {
    throw new Error(`${url} sent something that isn't a chat completion during ${request.purpose}: ${scrub(raw)}`);
  }
  const choice = reply.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== 'string') throw new Error(`${url} sent no answer text during ${request.purpose}: ${scrub(raw)}`);
  const tokensIn = typeof reply.usage?.prompt_tokens === 'number' ? reply.usage.prompt_tokens : Math.ceil((sent.system.length + sent.user.length) / 4);
  const tokensOut = typeof reply.usage?.completion_tokens === 'number' ? reply.usage.completion_tokens : Math.ceil(content.length / 4);
  const fail = (message: string): never => {
    const err = new AnswerError(message);
    err.tokensIn = tokensIn;
    err.tokensOut = tokensOut;
    throw err;
  };
  if (choice?.finish_reason === 'length') {
    fail(`The model's answer for ${request.purpose} was cut off at ${request.maxTokens} tokens. Try a narrower --scope, or a model that writes less.`);
  }
  let answer: unknown;
  try {
    answer = parseAnswer(request.purpose, content);
  } catch (err) {
    fail((err as Error).message);
  }
  return { answer: redactor.restore(answer), tokensIn, tokensOut };
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
