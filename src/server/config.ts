// config.json in the home folder: the app's settings. Reading fills in defaults; writing applies a checked patch
// and keeps any keys this module doesn't know, so other parts of Skeinwise can keep their own settings there.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
    remote: { address: string; model: string; keyEnv: string };
  };
  usageCap: { monthlyTokens: number };
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
  brain: { pointSize: 1, lineDensity: 0.6, labels: true, turning: true, grouping: 'source', layout: 'brain' },
  agents: { chosen: [] },
  ai: {
    engine: 'local',
    local: { address: 'http://127.0.0.1:8731/v1', model: 'qwen3-4b-q4_k_m.gguf' },
    remote: { address: '', model: '', keyEnv: 'SKEINWISE_API_KEY' },
  },
  usageCap: { monthlyTokens: 2_000_000 },
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

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

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

function readRaw(home: string): Obj {
  const file = join(home, 'config.json');
  if (!existsSync(file)) return {};
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return isObj(data) ? data : {};
  } catch {
    throw new ConfigError(`config.json in ${home} is not valid JSON; fix or remove it`);
  }
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
  config.bringIn = isObj(raw.bringIn)
    ? (Object.fromEntries(
        Object.entries(raw.bringIn).filter(([, d]) => (DECISIONS as readonly string[]).includes(d as string)),
      ) as Config['bringIn'])
    : {};
  return config;
}

/** Applies a checked patch and writes config.json atomically. Returns the new settings. */
export function writeConfig(home: string, patch: unknown): Config {
  const clean = checkPatch(patch);
  const next = merge(readRaw(home), clean);
  const file = join(home, 'config.json');
  writeFileSync(`${file}.tmp`, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  return readConfig(home);
}
