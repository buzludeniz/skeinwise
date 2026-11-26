// A view spec: the JSON that describes one view of the record, written by the local model, carried by a built-in view
// or read back from a saved file. It is data only: a few names from fixed lists, short strings and one small number.
// checkSpec below is the only way in. It takes what JSON.parse returns, rejects any field or value it doesn't know, and
// gives back a fresh object built from the checked values alone. Nothing in a spec is ever run, evaluated or put into
// HTML: titles and filter values reach the page as text, and filters are compared with the record's values in memory.

import { safeLine } from '../safe-text.ts';
import { TABLE_FORMS, TABLE_PROPS } from '../server/config.ts';

export type ViewProp = (typeof TABLE_PROPS)[number];
export type ViewForm = (typeof TABLE_FORMS)[number];
export const KINDS = ['message', 'note', 'file'] as const;
export type Kind = (typeof KINDS)[number];
export const WHERE_PROPS = [...TABLE_PROPS, 'kind'] as const;
export type WhereProp = (typeof WHERE_PROPS)[number];
export const SORTS = ['newest', 'oldest'] as const;
export type Sort = (typeof SORTS)[number];
export const SHOWS = ['chart', 'list'] as const;

/** The limits a spec must keep to. `text` caps the JSON text of one spec, from a model, a request or a file. */
export const SPEC_LIMITS = { title: 80, value: 120, where: 4, list: 200, text: 8192 } as const;
export const DEFAULT_LIST_LIMIT = 50;

/** One filter: entries whose `prop` is exactly `is`. Several filters all have to hold. */
export interface Where {
  prop: WhereProp;
  is: string;
}

interface Common {
  v: 1;
  title: string;
  where?: Where[];
  /** 'YYYY-MM' or 'YYYY-MM-DD', inclusive. */
  from?: string;
  to?: string;
}

/** Entries counted by x (and by y, one colour each, when there is one), drawn in one of the Workbench's six forms. */
export interface ChartSpec extends Common {
  show: 'chart';
  form: ViewForm;
  x: ViewProp;
  y?: ViewProp;
}

/** Entries in a list, newest or oldest first. */
export interface ListSpec extends Common {
  show: 'list';
  sort: Sort;
  limit: number;
}

export type ViewSpec = ChartSpec | ListSpec;

/** The fields of a spec that passed on their own, from a spec that failed as a whole: what the fallback goes by. */
export interface Salvage {
  title?: string;
  show?: ViewSpec['show'];
  form?: ViewForm;
  x?: ViewProp;
  y?: ViewProp;
  where?: Where[];
  sort?: Sort;
}

export type Checked = { ok: true; spec: ViewSpec } | { ok: false; reasons: string[]; salvage: Salvage };

/** Every field a spec may have. Anything else is refused, `__proto__` and `constructor` included. */
export const SPEC_FIELDS = ['v', 'title', 'show', 'form', 'x', 'y', 'where', 'from', 'to', 'sort', 'limit'] as const;
const CHART_ONLY = ['form', 'x', 'y'];
const LIST_ONLY = ['sort', 'limit'];
const DAY = /^\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function has(list: readonly string[], value: unknown): boolean {
  return typeof value === 'string' && list.includes(value);
}

/** A value as a reason quotes it: text cleaned and clipped, anything else by its kind. */
function shown(value: unknown): string {
  if (typeof value === 'string') {
    const line = [...safeLine(value)];
    return JSON.stringify(line.length > 40 ? `${line.slice(0, 40).join('')}…` : line.join(''));
  }
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'a number that is not finite';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

function listOf(names: readonly string[]): string {
  return names.join(', ');
}

/** Spec text as a person reads it: line breaks and controls out, outer spaces trimmed. */
function cleanText(value: string): string {
  return safeLine(value).trim();
}

const MARKUP = /[<>]/;

/**
 * Checks one parsed spec. On success the spec returned is a new object with the checked fields only, defaults
 * filled in, so checking it again gives the same spec. On failure it gives every reason found, plain enough to show,
 * and the fields that passed on their own.
 */
export function checkSpec(input: unknown): Checked {
  const reasons: string[] = [];
  const salvage: Salvage = {};
  if (!isPlainObject(input)) return { ok: false, reasons: [`A view must be a JSON object, not ${shown(input)}.`], salvage };

  const unknown = Object.keys(input).filter((k) => !(SPEC_FIELDS as readonly string[]).includes(k));
  if (unknown.length) {
    reasons.push(`A view has no field ${unknown.slice(0, 3).map(shown).join(', ')}${unknown.length > 3 ? ' (and more)' : ''}. Its fields are ${listOf(SPEC_FIELDS)}.`);
  }
  const get = (key: (typeof SPEC_FIELDS)[number]): unknown => (Object.hasOwn(input, key) ? input[key] : undefined);

  if (get('v') !== 1) reasons.push(`"v" must be 1, not ${shown(get('v'))}.`);

  const title = get('title');
  let cleanTitle: string | undefined;
  if (typeof title !== 'string') reasons.push(`"title" must be text, not ${shown(title)}.`);
  else {
    const chars = [...cleanText(title)];
    const clipped = (chars.length > SPEC_LIMITS.title ? chars.slice(0, SPEC_LIMITS.title).join('') : chars.join('')).trim();
    if (!clipped) reasons.push('"title" is empty.');
    else if (MARKUP.test(clipped)) reasons.push('"title" can\'t contain < or >.');
    else salvage.title = cleanTitle = clipped;
  }

  const show = get('show');
  if (!has(SHOWS, show)) reasons.push(`"show" must be "chart" or "list", not ${shown(show)}.`);
  else salvage.show = show as ViewSpec['show'];

  const present = (key: string) => Object.hasOwn(input, key) && input[key] !== undefined;
  if (show === 'chart') {
    const stray = LIST_ONLY.filter(present);
    if (stray.length) reasons.push(`A chart has no ${listOf(stray)}: those are for lists.`);
  } else if (show === 'list') {
    const stray = CHART_ONLY.filter(present);
    if (stray.length) reasons.push(`A list has no ${listOf(stray)}: those are for charts.`);
  }

  // Chart fields.
  let form: ViewForm | undefined;
  let x: ViewProp | undefined;
  let y: ViewProp | undefined;
  if (show === 'chart') {
    const f = get('form');
    if (!has(TABLE_FORMS, f)) reasons.push(`"form" must be one of ${listOf(TABLE_FORMS)}, not ${shown(f)}.`);
    else salvage.form = form = f as ViewForm;
    const gx = get('x');
    if (!has(TABLE_PROPS, gx)) reasons.push(`"x" must be one of ${listOf(TABLE_PROPS)}, not ${shown(gx)}.`);
    else salvage.x = x = gx as ViewProp;
    const gy = get('y');
    if (gy !== undefined) {
      if (!has(TABLE_PROPS, gy)) reasons.push(`"y" must be one of ${listOf(TABLE_PROPS)}, or left out, not ${shown(gy)}.`);
      else if (gy === gx) reasons.push(`"x" and "y" are both ${shown(gy)}; leave "y" out for one series.`);
      else salvage.y = y = gy as ViewProp;
    }
  }

  // List fields.
  let sort: Sort | undefined;
  let limit: number | undefined;
  if (show === 'list') {
    const s = get('sort');
    if (s === undefined) sort = 'newest';
    else if (!has(SORTS, s)) reasons.push(`"sort" must be "newest" or "oldest", not ${shown(s)}.`);
    else sort = s as Sort;
    if (sort) salvage.sort = sort;
    const l = get('limit');
    if (l === undefined) limit = DEFAULT_LIST_LIMIT;
    else if (typeof l !== 'number' || !Number.isInteger(l) || l < 1 || l > SPEC_LIMITS.list) {
      reasons.push(`"limit" must be a whole number from 1 to ${SPEC_LIMITS.list}, not ${shown(l)}.`);
    } else limit = l;
  }

  // Filters.
  let where: Where[] | undefined;
  const w = get('where');
  if (w !== undefined) {
    if (!Array.isArray(w)) reasons.push(`"where" must be a list of filters, not ${shown(w)}.`);
    else if (w.length > SPEC_LIMITS.where) reasons.push(`"where" has ${w.length} filters; a view takes at most ${SPEC_LIMITS.where}.`);
    else {
      const kept: Where[] = [];
      const seen = new Set<string>();
      w.forEach((item, i) => {
        const at = `Filter ${i + 1}`;
        if (!isPlainObject(item)) return reasons.push(`${at} must be an object like {"prop": "project", "is": "…"}, not ${shown(item)}.`);
        const extra = Object.keys(item).filter((k) => k !== 'prop' && k !== 'is');
        if (extra.length) return reasons.push(`${at} has no field ${extra.slice(0, 3).map(shown).join(', ')}; a filter has "prop" and "is" only.`);
        const prop = Object.hasOwn(item, 'prop') ? item.prop : undefined;
        const is = Object.hasOwn(item, 'is') ? item.is : undefined;
        if (!has(WHERE_PROPS, prop)) return reasons.push(`${at}: "prop" must be one of ${listOf(WHERE_PROPS)}, not ${shown(prop)}.`);
        if (seen.has(prop as string)) return reasons.push(`${at} filters ${shown(prop)} again; use one filter per property.`);
        seen.add(prop as string);
        if (typeof is !== 'string') return reasons.push(`${at}: "is" must be text, not ${shown(is)}.`);
        const value = cleanText(is);
        if (!value) return reasons.push(`${at}: "is" is empty.`);
        if ([...value].length > SPEC_LIMITS.value) return reasons.push(`${at}: "is" is longer than ${SPEC_LIMITS.value} characters.`);
        if (MARKUP.test(value)) return reasons.push(`${at}: "is" can't contain < or >.`);
        if (prop === 'time' && !MONTH.test(value)) return reasons.push(`${at}: a time filter is a month, like "2025-03", not ${shown(value)}.`);
        if (prop === 'kind' && !has(KINDS, value)) return reasons.push(`${at}: kind must be one of ${listOf(KINDS)}, not ${shown(value)}.`);
        kept.push({ prop: prop as WhereProp, is: value });
        return undefined;
      });
      if (kept.length) salvage.where = kept;
      if (kept.length === w.length && kept.length) where = kept;
    }
  }

  // Dates.
  const dates: { from?: string; to?: string } = {};
  for (const key of ['from', 'to'] as const) {
    const d = get(key);
    if (d === undefined) continue;
    if (typeof d !== 'string' || !DAY.test(d)) reasons.push(`"${key}" must be a date like "2025-03" or "2025-03-14", not ${shown(d)}.`);
    else dates[key] = d;
  }
  if (dates.from && dates.to && (dates.from.length === 7 ? `${dates.from}-01` : dates.from) > (dates.to.length === 7 ? `${dates.to}-31` : dates.to)) {
    reasons.push(`"from" (${dates.from}) comes after "to" (${dates.to}).`);
  }

  if (reasons.length || cleanTitle === undefined) return { ok: false, reasons, salvage };
  const common = { v: 1 as const, title: cleanTitle, ...(where ? { where } : {}), ...dates };
  if (show === 'chart') return { ok: true, spec: { ...common, show: 'chart', form: form!, x: x!, ...(y ? { y } : {}) } };
  return { ok: true, spec: { ...common, show: 'list', sort: sort!, limit: limit! } };
}

/** Checks spec text: at most SPEC_LIMITS.text characters of JSON. */
export function parseSpecText(text: string): Checked {
  if (text.length > SPEC_LIMITS.text) return { ok: false, reasons: [`The view is longer than ${SPEC_LIMITS.text} characters.`], salvage: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reasons: ["The view isn't JSON."], salvage: {} };
  }
  return checkSpec(parsed);
}

/** Checks a spec that came as parsed JSON (a request body, a model answer), with the same size cap as text. */
export function checkSpecValue(value: unknown): Checked {
  let size: number;
  try {
    size = JSON.stringify(value)?.length ?? 0;
  } catch {
    return { ok: false, reasons: ["The view isn't JSON."], salvage: {} };
  }
  if (size > SPEC_LIMITS.text) return { ok: false, reasons: [`The view is longer than ${SPEC_LIMITS.text} characters.`], salvage: {} };
  return checkSpec(value);
}
