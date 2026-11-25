// $SKEINWISE_HOME/config.json: which engine organises the record and how to reach a model. A key is never stored
// here, only the name of the environment variable that holds it.

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
  /** The NAME of the environment variable holding the outside endpoint's key. */
  apiKeyEnv: string;
  /** Tokens an outside model may use per calendar month (UTC). */
  budget: number;
  /** Replace names, emails, phone numbers, street addresses and health words before text goes to an outside model. */
  redaction: boolean;
  /** Names to redact, besides the patterns. */
  names: string[];
  /** Extra fields merged into every chat request, e.g. {"temperature": 0}. */
  modelOptions: Record<string, unknown>;
  /** Note folders and vaults that `skeinwise live` follows, besides agent histories and Downloads. */
  liveFolders: LiveFolder[];
  /** Whether `skeinwise live` organises what it captures. */
  liveOrganise: boolean;
  /** Whether background organising may use the outside model (it always may use the local one). */
  liveRemote: boolean;
}

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
  budget: 1_000_000,
  redaction: true,
  names: [],
  modelOptions: {},
  liveFolders: [],
  liveOrganise: true,
  liveRemote: false,
};

const KEYS = Object.keys(DEFAULT_CONFIG) as (keyof Config)[];

export function configPath(home: string): string {
  return join(home, 'config.json');
}

export function loadConfig(home: string): Config {
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
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad('a JSON object');
      break;
    case 'apiKeyEnv':
      if (typeof value !== 'string' || (value && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)))
        throw bad('the name of an environment variable, like OPENAI_API_KEY (never the key itself)');
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

/** Parses a value typed on the command line for one key. */
export function parseConfigValue(key: string, text: string): { key: keyof Config; value: Config[keyof Config] } {
  if (!isKey(key)) throw new UsageError(`Unknown setting "${key}". Known: ${KEYS.join(', ')}.`);
  let value: unknown = text;
  if (key === 'budget') value = /^\d+$/.test(text) ? Number(text) : text;
  if (key === 'redaction' || key === 'liveOrganise' || key === 'liveRemote') {
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
    const example = { names: '["Alex", "Sam"]', liveFolders: '[{"path": "/Users/me/Mara", "owner": "Mara"}]' }[key] ?? '{"temperature": 0}';
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
  const config = loadConfig(home);
  const parsed = parseConfigValue(key, text);
  assign(config, parsed.key, parsed.value);
  saveConfig(home, config);
  return config;
}

export function unsetConfigValue(home: string, key: string): Config {
  if (!isKey(key)) throw new UsageError(`Unknown setting "${key}". Known: ${KEYS.join(', ')}.`);
  const config = loadConfig(home);
  assign(config, key, DEFAULT_CONFIG[key]);
  saveConfig(home, config);
  return config;
}
