// $SKEINWISE_HOME/config.json: which engine organises the record and how to reach a model. A key is never stored
// here, only the name of the environment variable that holds it, and the hosts you confirmed may receive it.

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { UsageError } from './errors.ts';

export type EngineName = 'local' | 'remote' | 'none';
export const ENGINES: readonly EngineName[] = ['local', 'remote', 'none'];

export interface Config {
  engine: EngineName;
  /** An OpenAI-compatible server on this computer. */
  localUrl: string;
  /** The model to ask for; when empty, the first model the local server lists. */
  localModel: string;
  remoteUrl: string;
  remoteModel: string;
  /** The NAME of the environment variable holding the outside endpoint's key: SKEINWISE_* or *_API_KEY. */
  apiKeyEnv: string;
  /** Hosts (host or host:port) you confirmed on the command line to receive the key; it goes nowhere else. */
  remoteHosts: string[];
  /** Tokens an outside model may use per calendar month (UTC). */
  budget: number;
  /**
   * Replace names, emails, phone numbers, street addresses and health words before text goes to an outside model.
   * Keys, passwords, card numbers and other secrets are replaced either way.
   */
  redaction: boolean;
  /** Names to redact, besides the patterns. */
  names: string[];
  /** Sampling settings for every chat request: temperature, top_p, and a lower max_tokens. */
  modelOptions: ModelOptions;
  /** The llama-server program `skeinwise model serve` runs: an absolute path, found on PATH once and kept. */
  llamaServer: string;
  /** Note folders and vaults that `skeinwise live` follows, besides agent histories and Downloads. */
  liveFolders: LiveFolder[];
  /** Whether `skeinwise live` organises what it captures. */
  liveOrganise: boolean;
  /** Whether background organising may use the outside model (it always may use the local one). */
  liveRemote: boolean;
  /** Whether `skeinwise live` watches Downloads for chat exports. What it finds waits in `live pending` until you accept it. */
  liveDownloads: boolean;
}

/** The request fields a setting may change. Everything else in a request (model, messages, format) is fixed. */
export interface ModelOptions {
  temperature?: number;
  top_p?: number;
  /** Lowers the answer length a request allows; it never raises it past what the task asks for. */
  max_tokens?: number;
}

export const MODEL_OPTIONS: readonly (keyof ModelOptions)[] = ['temperature', 'top_p', 'max_tokens'];

/** Names an API key's variable may have, so a setting can't point the key at GITHUB_TOKEN or AWS_SECRET_ACCESS_KEY. */
export const API_KEY_ENV = /^(?:SKEINWISE_[A-Z0-9_]+|[A-Z][A-Z0-9_]*_API_KEY)$/;

export interface LiveFolder {
  path: string;
  /** Whose words the folder holds; you when not given. */
  owner?: string;
}

export const DEFAULT_CONFIG: Config = {
  engine: 'local',
  localUrl: 'http://127.0.0.1:8731/v1',
  localModel: '',
  remoteUrl: '',
  remoteModel: '',
  apiKeyEnv: '',
  remoteHosts: [],
  budget: 1_000_000,
  redaction: true,
  names: [],
  modelOptions: {},
  llamaServer: '',
  liveFolders: [],
  liveOrganise: true,
  liveRemote: false,
  liveDownloads: false,
};

const KEYS = Object.keys(DEFAULT_CONFIG) as (keyof Config)[];

export function configPath(home: string): string {
  return join(home, 'config.json');
}

export function loadConfig(home: string): Config {
  return readConfig(home, null);
}

/** Reads the settings; `replacing` is not checked, so a setting that no longer passes can still be set or unset. */
function readConfig(home: string, replacing: keyof Config | null): Config {
  const file = configPath(home);
  if (!existsSync(file)) return { ...DEFAULT_CONFIG };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new UsageError(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new UsageError(`${file} must hold a JSON object.`);
  const config = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(raw)) {
    if (!isKey(key)) throw new UsageError(`${file}: unknown setting "${key}". Known: ${KEYS.join(', ')}.`);
    if (key === replacing) continue;
    assign(config, key, checkValue(key, value, file));
  }
  return config;
}

function isKey(key: string): key is keyof Config {
  return (KEYS as string[]).includes(key);
}

function assign<K extends keyof Config>(config: Config, key: K, value: Config[K]): void {
  config[key] = value;
}

/** Checks a value read from JSON, so a hand-edited file fails loudly instead of half-working. */
function checkValue<K extends keyof Config>(key: K, value: unknown, where: string): Config[K] {
  const bad = (want: string) => new UsageError(`${where}: "${key}" must be ${want}.`);
  switch (key) {
    case 'engine':
      if (typeof value !== 'string' || !(ENGINES as string[]).includes(value)) throw bad(ENGINES.join(', '));
      break;
    case 'budget':
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw bad('a whole number of tokens');
      break;
    case 'redaction':
    case 'liveOrganise':
    case 'liveRemote':
    case 'liveDownloads':
      if (typeof value !== 'boolean') throw bad('true or false');
      break;
    case 'liveFolders':
      if (
        !Array.isArray(value) ||
        !value.every(
          (f) =>
            f &&
            typeof f === 'object' &&
            typeof (f as LiveFolder).path === 'string' &&
            (f as LiveFolder).path.trim() &&
            ((f as LiveFolder).owner === undefined || typeof (f as LiveFolder).owner === 'string'),
        )
      )
        throw bad('a list of folders, like [{"path": "/Users/me/Notes"}, {"path": "/Users/me/Mara", "owner": "Mara"}]');
      break;
    case 'names':
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v.trim())) throw bad('a list of names');
      break;
    case 'modelOptions':
      if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.entries(value).every(([k, v]) => modelOptionOk(k, v)))
        throw bad('a JSON object with only temperature (0 to 2), top_p (0 to 1) and max_tokens (a whole number above 0), like {"temperature": 0.2}');
      break;
    case 'apiKeyEnv':
      if (typeof value !== 'string' || (value && !API_KEY_ENV.test(value)))
        throw bad('the name of an environment variable that starts with SKEINWISE_ or ends with _API_KEY, like OPENAI_API_KEY (never the key itself)');
      break;
    case 'remoteHosts':
      if (!Array.isArray(value) || !value.every((h) => typeof h === 'string' && HOST.test(h))) throw bad('a list of hosts, like ["api.openai.com"]');
      break;
    case 'llamaServer':
      if (typeof value !== 'string' || (value && !isAbsolute(value))) throw bad('the absolute path of the llama-server program');
      break;
    case 'localUrl':
    case 'remoteUrl':
      if (typeof value !== 'string' || (value && !/^https?:\/\/\S+$/.test(value))) throw bad('an http(s) URL');
      break;
    default:
      if (typeof value !== 'string') throw bad('text');
  }
  return value as Config[K];
}

/** A host name or address, with a port when it isn't the scheme's own: what URL.host gives, in lower case. */
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/;

/** The host a URL's requests go to, as remoteHosts holds it. */
export function hostOf(url: string): string {
  return new URL(url).host.toLowerCase();
}

function modelOptionOk(key: string, value: unknown): boolean {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (key === 'temperature') return value >= 0 && value <= 2;
  if (key === 'top_p') return value >= 0 && value <= 1;
  if (key === 'max_tokens') return Number.isInteger(value) && value > 0;
  return false;
}

/** Parses a value typed on the command line for one key. */
export function parseConfigValue(key: string, text: string): { key: keyof Config; value: Config[keyof Config] } {
  if (!isKey(key)) throw new UsageError(`Unknown setting "${key}". Known: ${KEYS.join(', ')}.`);
  let value: unknown = text;
  if (key === 'budget') value = /^\d+$/.test(text) ? Number(text) : text;
  if (key === 'redaction' || key === 'liveOrganise' || key === 'liveRemote' || key === 'liveDownloads') {
    if (/^(on|true|yes)$/i.test(text)) value = true;
    else if (/^(off|false|no)$/i.test(text)) value = false;
  }
  if (key === 'names') {
    value = text.trim().startsWith('[')
      ? parseJson(key, text)
      : text
          .split(',')
          .map((n) => n.trim())
          .filter(Boolean);
  }
  if (key === 'modelOptions') value = parseJson(key, text);
  // Hosts or URLs separated by commas; a URL counts for its host.
  if (key === 'remoteHosts') {
    value = text
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean)
      .map((h) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(h) ? hostOf(h) : h.toLowerCase()));
  }
  if (key === 'llamaServer' && text) value = resolve(text);
  // Folder paths separated by commas, or JSON for folders that hold someone else's words.
  if (key === 'liveFolders') {
    value = text.trim().startsWith('[')
      ? parseJson(key, text)
      : text
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean)
          .map((path) => ({ path: resolve(path) }));
  }
  const checked = checkValue(key, value, 'config');
  if (key === 'liveFolders') return { key, value: (checked as LiveFolder[]).map((f) => ({ ...f, path: resolve(f.path) })) };
  return { key, value: checked };
}

function parseJson(key: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const example = { names: '["Alex", "Sam"]', liveFolders: '[{"path": "/Users/me/Mara", "owner": "Mara"}]' }[key] ?? '{"temperature": 0.2}';
    throw new UsageError(`"${key}" must be JSON, for example: ${example}`);
  }
}

/** Writes the settings that differ from the defaults, readable by the owner only. */
export function saveConfig(home: string, config: Config): void {
  const out: Record<string, unknown> = {};
  for (const key of KEYS) {
    if (JSON.stringify(config[key]) !== JSON.stringify(DEFAULT_CONFIG[key])) out[key] = config[key];
  }
  const file = configPath(home);
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function setConfigValue(home: string, key: string, text: string): Config {
  const parsed = parseConfigValue(key, text);
  const config = readConfig(home, parsed.key);
  assign(config, parsed.key, parsed.value);
  saveConfig(home, config);
  return config;
}

export function unsetConfigValue(home: string, key: string): Config {
  if (!isKey(key)) throw new UsageError(`Unknown setting "${key}". Known: ${KEYS.join(', ')}.`);
  const config = readConfig(home, key);
  assign(config, key, DEFAULT_CONFIG[key]);
  saveConfig(home, config);
  return config;
}
