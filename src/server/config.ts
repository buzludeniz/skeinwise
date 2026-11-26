// The app's settings. The engine, the model addresses, the token cap, redaction and Record live's settings belong to
// the organiser and live in config.json (src/config.ts), so the CLI and the app agree on them; everything else lives
// in app.json beside it.
// Reading fills in defaults; writing applies a checked patch and keeps any keys this module doesn't know.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type LiveFolder, loadConfig, parseConfigValue, saveConfig, type Config as EngineConfig } from '../config.ts';

export const THEMES = ['dusk', 'ink', 'slate', 'moss', 'linen', 'paper'] as const;
export const PALETTES = ['ember', 'tide', 'lichen', 'heather', 'graphite', 'saffron', 'mono'] as const;
export const GROUPINGS = ['project', 'folder', 'source', 'speaker'] as const;
export const LAYOUTS = ['brain', 'rings', 'clusters'] as const;
export const ENGINES = ['local', 'remote', 'none'] as const;
export const DECISIONS = ['in', 'out', 'later'] as const;
export const TABLE_PROPS = ['time', 'folder', 'project', 'hub', 'source', 'speaker', 'tag'] as const;
export const TABLE_FORMS = ['table', 'heatmap', 'bars', 'stacked', 'lines', 'dots'] as const;

export interface LabView {
  name: string;
  x: string;
  y: string;
  filter: string;
  form: string;
}

export interface Config {
  firstRunDone: boolean;
  recordLive: boolean;
  appearance: { theme: (typeof THEMES)[number]; palette: (typeof PALETTES)[number] };
  brain: {
    pointSize: number;
    lineDensity: number;
    labels: boolean;
    turning: boolean;
    grouping: (typeof GROUPINGS)[number];
    layout: (typeof LAYOUTS)[number];
  };
  agents: { chosen: string[] };
  ai: {
    engine: (typeof ENGINES)[number];
    local: { address: string; model: string };
    /** `hosts` are the hosts confirmed in the terminal to receive the key; the page shows them and can't change them. */
    remote: { address: string; model: string; keyEnv: string; hosts: string[] };
  };
  usageCap: { monthlyTokens: number };
  /** Record live's settings, kept in config.json: the folders it follows, and whether and how it organises. */
  live: { folders: LiveFolder[]; organise: boolean; remote: boolean; downloads: boolean };
  proofOfDate: boolean;
  backup: { daily: boolean };
  exclusions: { rules: string[]; redact: boolean };
  sync: { folder: string };
  /** First-run choices for sources found on this computer, by path. */
  bringIn: Record<string, (typeof DECISIONS)[number]>;
  lab: { views: LabView[] };
}

export const DEFAULT_CONFIG: Config = {
  firstRunDone: false,
  recordLive: false,
  appearance: { theme: 'dusk', palette: 'ember' },
  brain: { pointSize: 1, lineDensity: 0.6, labels: true, turning: true, grouping: 'source', layout: 'clusters' },
  agents: { chosen: [] },
  ai: {
    engine: 'local',
    local: { address: 'http://127.0.0.1:8731/v1', model: '' },
    remote: { address: '', model: '', keyEnv: '', hosts: [] },
  },
  usageCap: { monthlyTokens: 1_000_000 },
  live: { folders: [], organise: true, remote: false, downloads: false },
  proofOfDate: false,
  backup: { daily: false },
  exclusions: { rules: [], redact: true },
  sync: { folder: '' },
  bringIn: {},
  lab: { views: [] },
};

/** Fields whose value must be one of a list. */
const ENUMS: Record<string, readonly string[]> = {
  'appearance.theme': THEMES,
  'appearance.palette': PALETTES,
  'brain.grouping': GROUPINGS,
  'brain.layout': LAYOUTS,
  'ai.engine': ENGINES,
};

/** Number fields and their allowed range. */
const RANGES: Record<string, [number, number]> = {
  'brain.pointSize': [0.3, 3],
  'brain.lineDensity': [0, 1],
  'usageCap.monthlyTokens': [0, 1e12],
};

export class ConfigError extends Error {}

/**
 * Settings that decide where the record's words go: which model reads them, which host gets the key, what is
 * redacted first, and which folders and downloads come in. Only the terminal changes them (SETTINGS-1, M11), so a
 * page, a stolen token or a script in the page can't. Each maps to the command that does, with a placeholder for the
 * value: never the value a request sent, so a copied command can't carry someone else's host.
 */
export const CLI_ONLY: Record<string, string> = {
  'ai.engine': 'skeinwise config engine local|remote|none',
  'ai.remote.address': 'skeinwise config remoteUrl <address>',
  'ai.remote.hosts': 'skeinwise config remoteHosts <host>',
  'ai.remote.keyEnv': 'skeinwise config apiKeyEnv <VARIABLE_NAME>',
  'exclusions.redact': 'skeinwise config redaction on|off',
  'live.folders': 'skeinwise config liveFolders <folder>,<folder>',
  'live.remote': 'skeinwise config liveRemote on|off',
  'live.downloads': 'skeinwise config liveDownloads on|off',
};

/** A change only the terminal may make; the server answers 403 with the command. */
export class CliOnly extends Error {
  readonly command: string;
  constructor(message: string, command: string) {
    super(message);
    this.command = command;
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function checkLiveFolder(v: unknown, path: string): LiveFolder {
  if (!isObj(v) || typeof v.path !== 'string' || !v.path.trim()) throw new ConfigError(`${path} needs a folder path`);
  if (v.owner !== undefined && typeof v.owner !== 'string') throw new ConfigError(`${path}.owner must be text`);
  const owner = typeof v.owner === 'string' ? v.owner.trim().slice(0, 200) : '';
  return owner ? { path: v.path.slice(0, 2000), owner } : { path: v.path.slice(0, 2000) };
}

function checkLabView(v: unknown, path: string): LabView {
  if (!isObj(v)) throw new ConfigError(`${path} must be an object`);
  const view = {} as Record<keyof LabView, string>;
  for (const key of ['name', 'x', 'y', 'filter', 'form'] as const) {
    if (typeof v[key] !== 'string') throw new ConfigError(`${path}.${key} must be text`);
    view[key] = (v[key] as string).slice(0, 200);
  }
  if (!view.name.trim()) throw new ConfigError(`${path}.name is empty`);
  if (!(TABLE_PROPS as readonly string[]).includes(view.x) || !(TABLE_PROPS as readonly string[]).includes(view.y)) {
    throw new ConfigError(`${path} has an unknown axis`);
  }
  if (!(TABLE_FORMS as readonly string[]).includes(view.form)) throw new ConfigError(`${path}.form is unknown`);
  return view;
}

/** Checks a patch against the defaults' shape and returns a clean copy. Throws ConfigError on anything unknown. */
export function checkPatch(patch: unknown, shape: unknown = DEFAULT_CONFIG, path = ''): Obj {
  if (!isObj(patch)) throw new ConfigError(`${path || 'settings'} must be an object`);
  if (!isObj(shape)) throw new ConfigError(`${path} cannot hold an object`);
  const out: Obj = {};
  for (const [key, value] of Object.entries(patch)) {
    const at = path ? `${path}.${key}` : key;
    if (at === 'bringIn') {
      if (!isObj(value)) throw new ConfigError('bringIn must be an object');
      const clean: Obj = {};
      for (const [p, d] of Object.entries(value)) {
        if (!(DECISIONS as readonly string[]).includes(d as string)) throw new ConfigError(`bringIn choice for ${p} is unknown`);
        clean[p] = d;
      }
      out[key] = clean;
      continue;
    }
    if (!(key in shape)) throw new ConfigError(`Unknown setting: ${at}`);
    const def = shape[key];
    if (isObj(def)) {
      out[key] = checkPatch(value, def, at);
    } else if (Array.isArray(def)) {
      if (!Array.isArray(value)) throw new ConfigError(`${at} must be a list`);
      if (value.length > 200) throw new ConfigError(`${at} is too long`);
      out[key] =
        at === 'lab.views'
          ? value.map((v, i) => checkLabView(v, `${at}[${i}]`))
          : at === 'live.folders'
            ? value.map((v, i) => checkLiveFolder(v, `${at}[${i}]`))
            : value.map((v, i) => {
              if (typeof v !== 'string') throw new ConfigError(`${at}[${i}] must be text`);
              return v.slice(0, 500);
            });
    } else {
      if (typeof value !== typeof def) throw new ConfigError(`${at} must be a ${typeof def}`);
      const allowed = ENUMS[at];
      if (allowed && !allowed.includes(value as string)) throw new ConfigError(`${at} must be one of: ${allowed.join(', ')}`);
      const range = RANGES[at];
      if (range && (!Number.isFinite(value) || (value as number) < range[0] || (value as number) > range[1])) {
        throw new ConfigError(`${at} must be between ${range[0]} and ${range[1]}`);
      }
      out[key] = typeof value === 'string' ? value.slice(0, 2000) : value;
    }
  }
  return out;
}

function merge(base: Obj, patch: Obj): Obj {
  const out: Obj = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isObj(value) && isObj(base[key]) && key !== 'bringIn' ? merge(base[key] as Obj, value) : value;
  }
  // bringIn merges by path, so one choice doesn't wipe the others.
  if (isObj(patch.bringIn) && isObj(base.bringIn)) out.bringIn = { ...base.bringIn, ...patch.bringIn };
  return out;
}

export const APP_FILE = 'app.json';

function readRaw(home: string): Obj {
  const file = join(home, APP_FILE);
  if (!existsSync(file)) return {};
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return isObj(data) ? data : {};
  } catch {
    throw new ConfigError(`${APP_FILE} in ${home} is not valid JSON; fix or remove it`);
  }
}

/** The organiser's settings that the app shows, read from config.json. A bad file there fails loudly. */
function engineSettings(home: string): Pick<Config, 'ai' | 'usageCap' | 'live'> & { redact: boolean } {
  const c = loadConfig(home);
  return {
    ai: {
      engine: c.engine,
      local: { address: c.localUrl, model: c.localModel },
      remote: { address: c.remoteUrl, model: c.remoteModel, keyEnv: c.apiKeyEnv, hosts: c.remoteHosts },
    },
    usageCap: { monthlyTokens: c.budget },
    live: { folders: c.liveFolders, organise: c.liveOrganise, remote: c.liveRemote, downloads: c.liveDownloads },
    redact: c.redaction,
  };
}

/** Where each app setting kept in config.json lives there. */
const ENGINE_KEYS: [path: string, key: keyof EngineConfig][] = [
  ['ai.engine', 'engine'],
  ['ai.local.address', 'localUrl'],
  ['ai.local.model', 'localModel'],
  ['ai.remote.address', 'remoteUrl'],
  ['ai.remote.model', 'remoteModel'],
  ['ai.remote.keyEnv', 'apiKeyEnv'],
  ['ai.remote.hosts', 'remoteHosts'],
  ['usageCap.monthlyTokens', 'budget'],
  ['exclusions.redact', 'redaction'],
  ['live.folders', 'liveFolders'],
  ['live.organise', 'liveOrganise'],
  ['live.remote', 'liveRemote'],
  ['live.downloads', 'liveDownloads'],
];

function take(obj: Obj, path: string): { found: boolean; value: unknown } {
  const keys = path.split('.');
  let at: unknown = obj;
  for (const k of keys.slice(0, -1)) {
    if (!isObj(at)) return { found: false, value: undefined };
    at = at[k];
  }
  const last = keys.at(-1)!;
  if (!isObj(at) || !(last in at)) return { found: false, value: undefined };
  const value = at[last];
  delete at[last];
  return { found: true, value };
}

/** Moves the organiser's settings out of a checked patch into config.json, with the organiser's own checks. */
function writeEngineSettings(home: string, patch: Obj): void {
  const changes: { key: keyof EngineConfig; value: unknown }[] = [];
  let shown: Obj | undefined;
  for (const [path, key] of ENGINE_KEYS) {
    const { found, value } = take(patch, path);
    if (!found) continue;
    const command = CLI_ONLY[path];
    if (command) {
      // The page sends whole groups back, so the value it was shown passes; any change is refused, and the whole
      // patch with it, before anything is written.
      if (!shown) {
        const { redact, ...rest } = engineSettings(home);
        shown = { ...rest, exclusions: { redact } };
      }
      if (JSON.stringify(value) !== JSON.stringify(valueAt(shown, path))) {
        throw new CliOnly(`${path} decides where your words go, so only the terminal changes it: ${command}`, command);
      }
      continue;
    }
    changes.push({ key, value });
  }
  if (!changes.length) return;
  const config = loadConfig(home);
  for (const { key, value } of changes) {
    let parsed;
    try {
      // The organiser's parser reads the text form a CLI user types; a list of folders goes over as JSON.
      parsed = parseConfigValue(key, Array.isArray(value) ? JSON.stringify(value) : String(value));
    } catch (error) {
      throw new ConfigError(error instanceof Error ? error.message : String(error));
    }
    (config as unknown as Obj)[parsed.key] = parsed.value;
  }
  saveConfig(home, config);
}

function valueAt(obj: Obj, path: string): unknown {
  let at: unknown = obj;
  for (const k of path.split('.')) at = isObj(at) ? at[k] : undefined;
  return at;
}

/** Drops objects a patch left empty once the organiser's settings were taken out. */
function prune(obj: Obj): Obj {
  for (const [k, v] of Object.entries(obj)) {
    if (isObj(v) && k !== 'bringIn') {
      prune(v);
      if (!Object.keys(v).length) delete obj[k];
    }
  }
  return obj;
}

/** The settings, defaults filled in. Values of the wrong type in the file fall back to the default. */
export function readConfig(home: string): Config {
  const raw = readRaw(home);
  const filled = (def: unknown, value: unknown, path: string): unknown => {
    if (isObj(def)) {
      const out: Obj = {};
      const src = isObj(value) ? value : {};
      for (const key of Object.keys(def)) out[key] = filled(def[key], src[key], path ? `${path}.${key}` : key);
      return out;
    }
    if (value === undefined) return def;
    try {
      return checkPatch({ v: value }, { v: def }).v;
    } catch {
      return def;
    }
  };
  const config = filled(DEFAULT_CONFIG, raw, '') as Config;
  // An enum value the file holds but this build doesn't know falls back too.
  for (const [path, allowed] of Object.entries(ENUMS)) {
    const [a, b] = path.split('.') as [keyof Config, string];
    const group = config[a] as unknown as Obj;
    if (!allowed.includes(group[b] as string)) group[b] = (DEFAULT_CONFIG[a] as unknown as Obj)[b];
  }
  const engine = engineSettings(home);
  config.ai = engine.ai;
  config.usageCap = engine.usageCap;
  config.live = engine.live;
  config.exclusions.redact = engine.redact;
  config.bringIn = isObj(raw.bringIn)
    ? (Object.fromEntries(
        Object.entries(raw.bringIn).filter(([, d]) => (DECISIONS as readonly string[]).includes(d as string)),
      ) as Config['bringIn'])
    : {};
  return config;
}

/** Applies a checked patch, the organiser's part to config.json and the rest to app.json. Returns the new settings. */
export function writeConfig(home: string, patch: unknown): Config {
  const clean = checkPatch(patch);
  writeEngineSettings(home, clean);
  const rest = prune(clean);
  if (!Object.keys(rest).length) return readConfig(home);
  const next = merge(readRaw(home), rest);
  const file = join(home, APP_FILE);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  return readConfig(home);
}
