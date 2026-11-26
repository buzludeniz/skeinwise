// The fuzz targets for views, both fed arbitrary JSON: the spec checker (src/viewspec/spec.ts), and the views routes
// (src/server/viewspec.ts) with the saved-views folder and the local model's answer behind them. The checker never
// throws, and a spec it passes keeps every promise a spec makes. A route answers, or refuses the way app.ts turns into
// a 400 (a 404 for a saved view that isn't there), and writes nothing outside <home>/views. test/viewspec/spec.test.ts
// has a seeded fuzz of checkSpec's values of its own; this one starts from JSON text, and goes on through the routes.
// A finding here goes to the lead with its seed, unfixed.

import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { strToU8 } from 'fflate';
import { loadConfig, saveConfig } from '../../src/config.ts';
import { UsageError } from '../../src/errors.ts';
import { assertNoRunning } from '../../src/organiser/runs.ts';
import { isBidiControl } from '../../src/safe-text.ts';
import { HttpError } from '../../src/server/app.ts';
import { TABLE_FORMS, TABLE_PROPS } from '../../src/server/config.ts';
import { type ViewRoute, viewRoutes } from '../../src/server/viewspec.ts';
import { openDb } from '../../src/store/db.ts';
import { Store } from '../../src/store/store.ts';
import { BUILTINS } from '../../src/viewspec/builtins.ts';
import { VIEW_ID, viewsDir } from '../../src/viewspec/saved.ts';
import { type Checked, checkSpec, checkSpecValue, KINDS, parseSpecText, type Salvage, SHOWS, SORTS, SPEC_FIELDS, SPEC_LIMITS, WHERE_PROPS } from '../../src/viewspec/spec.ts';
import { int, MAX_INPUT, pick, type Rng, type Target } from './engine.ts';

// ---- what a checked spec promises ----

/** As test/viewspec/spec.test.ts holds a reason to: a sentence or two the page shows. */
const REASON_MAX = 600;
const DAY = /^\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function hasControl(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || isBidiControl(c)) return true;
  }
  return false;
}

const among = (list: readonly string[], value: unknown) => typeof value === 'string' && list.includes(value);

/** Text a spec carries (a title, a filter's value): plain, trimmed, at most `max` characters, no < or >. */
function checkText(what: string, value: unknown, max: number): void {
  if (typeof value !== 'string') throw new Error(`${what} is ${typeof value}, not text`);
  const length = [...value].length;
  if (length === 0 || length > max) throw new Error(`${what} has ${length} characters, not 1 to ${max}`);
  if (value !== value.trim()) throw new Error(`${what} has spaces at an end: ${JSON.stringify(value)}`);
  if (hasControl(value)) throw new Error(`${what} carries a control character: ${JSON.stringify(value)}`);
  if (/[<>]/.test(value)) throw new Error(`${what} carries < or >: ${JSON.stringify(value)}`);
}

function checkWhere(what: string, where: unknown): void {
  if (!Array.isArray(where) || where.length < 1 || where.length > SPEC_LIMITS.where) throw new Error(`${what} is not a list of 1 to ${SPEC_LIMITS.where} filters`);
  const props = new Set<unknown>();
  where.forEach((w: Record<string, unknown>, i) => {
    const at = `${what}[${i}]`;
    if (typeof w !== 'object' || w === null || Object.getPrototypeOf(w) !== Object.prototype || !isDeepStrictEqual(Object.keys(w).sort(), ['is', 'prop'])) throw new Error(`${at} is not a plain {prop, is}`);
    if (!among(WHERE_PROPS, w.prop)) throw new Error(`${at} filters on ${String(w.prop)}`);
    if (props.has(w.prop)) throw new Error(`${at} filters ${String(w.prop)} a second time`);
    props.add(w.prop);
    checkText(`${at}.is`, w.is, SPEC_LIMITS.value);
    if (w.prop === 'kind' && !among(KINDS, w.is)) throw new Error(`${at} is a kind of ${String(w.is)}`);
    if (w.prop === 'time' && !MONTH.test(w.is as string)) throw new Error(`${at} is a time of ${String(w.is)}`);
  });
}

/** Everything a passed spec must be, whatever went in. */
export function checkPassed(spec: unknown, what = 'the spec'): void {
  if (typeof spec !== 'object' || spec === null || Object.getPrototypeOf(spec) !== Object.prototype) throw new Error(`${what} is not a plain object`);
  const s = spec as Record<string, unknown>;
  const stray = Object.keys(s).filter((k) => !(SPEC_FIELDS as readonly string[]).includes(k));
  if (stray.length) throw new Error(`${what} kept the fields ${stray.join(', ')}`);
  if (s.v !== 1) throw new Error(`${what} has v ${String(s.v)}`);
  checkText(`${what}.title`, s.title, SPEC_LIMITS.title);
  if (!among(SHOWS, s.show)) throw new Error(`${what} shows ${String(s.show)}`);
  if (s.show === 'chart') {
    if (!among(TABLE_FORMS, s.form) || !among(TABLE_PROPS, s.x)) throw new Error(`${what} is a chart with form ${String(s.form)} and x ${String(s.x)}`);
    if ('y' in s && (!among(TABLE_PROPS, s.y) || s.y === s.x)) throw new Error(`${what} is a chart with y ${String(s.y)} for x ${String(s.x)}`);
    if ('sort' in s || 'limit' in s) throw new Error(`${what} is a chart with a sort or a limit`);
  } else {
    if (!among(SORTS, s.sort)) throw new Error(`${what} is a list sorted ${String(s.sort)}`);
    if (!Number.isInteger(s.limit) || (s.limit as number) < 1 || (s.limit as number) > SPEC_LIMITS.list) throw new Error(`${what} is a list with limit ${String(s.limit)}`);
    if ('form' in s || 'x' in s || 'y' in s) throw new Error(`${what} is a list with a form, an x or a y`);
  }
  if ('where' in s) checkWhere(`${what}.where`, s.where);
  for (const key of ['from', 'to'] as const) {
    if (key in s && (typeof s[key] !== 'string' || !DAY.test(s[key]))) throw new Error(`${what}.${key} is ${JSON.stringify(s[key])}`);
  }
  const from = s.from as string | undefined;
  const to = s.to as string | undefined;
  if (from && to && (from.length === 7 ? `${from}-01` : from) > (to.length === 7 ? `${to}-31` : to)) throw new Error(`${what} runs from ${from} to ${to}`);
  // Checking it again changes nothing, and it fits in a saved file, which a read caps at SPEC_LIMITS.text bytes.
  if (!isDeepStrictEqual(checkSpec(structuredClone(s)), { ok: true, spec: s })) throw new Error(`${what} checks differently a second time`);
  const file = Buffer.byteLength(`${JSON.stringify(s, null, 2)}\n`);
  if (file > SPEC_LIMITS.text) throw new Error(`${what} takes ${file} bytes as a saved file, past the ${SPEC_LIMITS.text} a read takes`);
}

function checkSalvage(salvage: Salvage): void {
  const stray = Object.keys(salvage).filter((k) => !(SPEC_FIELDS as readonly string[]).includes(k));
  if (stray.length) throw new Error(`the salvage kept the fields ${stray.join(', ')}`);
  if (salvage.title !== undefined) checkText('the salvage title', salvage.title, SPEC_LIMITS.title);
  if (salvage.show !== undefined && !among(SHOWS, salvage.show)) throw new Error(`the salvage shows ${String(salvage.show)}`);
  if (salvage.form !== undefined && !among(TABLE_FORMS, salvage.form)) throw new Error(`the salvage form is ${String(salvage.form)}`);
  for (const axis of ['x', 'y'] as const) if (salvage[axis] !== undefined && !among(TABLE_PROPS, salvage[axis])) throw new Error(`the salvage ${axis} is ${String(salvage[axis])}`);
  if (salvage.sort !== undefined && !among(SORTS, salvage.sort)) throw new Error(`the salvage sort is ${String(salvage.sort)}`);
  if (salvage.where !== undefined) checkWhere('the salvage where', salvage.where);
}

/** A line the page shows: text, no control characters, short. */
function checkMessage(what: string, text: unknown): void {
  if (typeof text !== 'string' || !text) throw new Error(`${what} is not text`);
  if (hasControl(text)) throw new Error(`${what} carries a control character: ${JSON.stringify(text.slice(0, 200))}`);
}

function checkChecked(r: Checked, what: string): void {
  if (r.ok) return checkPassed(r.spec, `${what}'s spec`);
  if (!Array.isArray(r.reasons) || r.reasons.length === 0) throw new Error(`${what} refused with no reason`);
  for (const reason of r.reasons) {
    checkMessage(`a reason ${what} gave`, reason);
    if (reason.length > REASON_MAX) throw new Error(`a reason ${what} gave runs to ${reason.length} characters: ${reason.slice(0, 200)}`);
  }
  checkSalvage(r.salvage);
}

// ---- inputs: JSON text, mostly near a valid spec ----

const WORDS = [
  ...SPEC_FIELDS, ...TABLE_PROPS, ...TABLE_FORMS, ...KINDS, ...SORTS, ...SHOWS, 'prop', 'is', 'spec', 'cell', 'request', 'answer', 'id', 'file',
  '__proto__', 'constructor', 'prototype', 'toString', 'garden notes', 'Garden notes', 'kept', '2025-03', '2025-03-14', '2025-02-31', '2025-13', '0000-01', '9999-12-31',
];
const CHARS = [
  'a', 'Z', '0', ' ', '-', '"', '\\', '/', '<', '>', '&', '.', 'é', 'İ', '日', '🧶', '́', '\u0000', '\u001b', '\n', '\t', '\r', '\u007f', '\u0085', '\u009b',
  '‏', '‮', '⁦', ' ', '﻿', '\ud800', '\udc00',
];
const NUMBERS = [0, 1, -1, 2, 50, 199, 200, 201, 1.5, -0, 1e-7, 1e308, 2 ** 53, 2 ** 31];

function text(rng: Rng): string {
  const r = rng();
  if (r < 0.4) return pick(rng, WORDS);
  // Now and then past a cap: a title's 80, a value's 120, the 8192 of a whole spec.
  const length = r < 0.43 ? SPEC_LIMITS.text + int(rng, 64) : r < 0.55 ? 75 + int(rng, 60) : int(rng, 24);
  let out = '';
  for (let i = 0; i < length; i++) out += pick(rng, CHARS);
  return out;
}

const put = (o: object, key: string, value: unknown) => Object.defineProperty(o, key, { value, enumerable: true, configurable: true, writable: true });

function value(rng: Rng, depth: number): unknown {
  const k = int(rng, depth > 3 ? 5 : 8);
  if (k === 0) return null;
  if (k === 1) return rng() < 0.5;
  if (k === 2) return rng() < 0.7 ? pick(rng, NUMBERS) : int(rng, 400);
  if (k <= 4) return text(rng);
  if (k === 5) return Array.from({ length: int(rng, 6) }, () => value(rng, depth + 1));
  const o = {};
  for (let i = int(rng, 6); i > 0; i--) put(o, rng() < 0.8 ? pick(rng, WORDS) : text(rng), value(rng, depth + 1));
  return o;
}

const DATES = ['2024-01', '2025-03', '2025-03-14', '2025-04-30', '2026-12', '2025-02-31', '2025-3', '2025-13'];

/** A value a field of a spec could well have, so that a changed spec passes as often as it fails. */
function plausible(rng: Rng, key: string): unknown {
  switch (key) {
    case 'v':
      return rng() < 0.8 ? 1 : pick(rng, [2, '1', 1.0, true]);
    case 'title':
      return text(rng);
    case 'show':
      return pick(rng, [...SHOWS, 'table']);
    case 'form':
      return pick(rng, TABLE_FORMS);
    case 'x':
    case 'y':
      return pick(rng, TABLE_PROPS);
    case 'sort':
      return pick(rng, SORTS);
    case 'limit':
      return int(rng, 203);
    case 'from':
    case 'to':
      return pick(rng, DATES);
    case 'where':
      return Array.from({ length: int(rng, 6) }, () => ({ prop: pick(rng, WHERE_PROPS), is: rng() < 0.5 ? pick(rng, [...KINDS, ...DATES, 'garden notes', 'Seed swap İstanbul']) : text(rng) }));
    default:
      return value(rng, 1);
  }
}

/** The objects and lists in a tree, to change one in place. */
function containers(root: unknown, out: (object | unknown[])[] = [], depth = 0): (object | unknown[])[] {
  if (typeof root !== 'object' || root === null || depth > 8 || out.length > 64) return out;
  out.push(root);
  for (const child of Object.values(root)) containers(child, out, depth + 1);
  return out;
}

/** One change to a parsed tree: a field set, dropped or added, or a list's item replaced, added or dropped. */
function change(rng: Rng, root: unknown): unknown {
  const all = containers(root);
  if (!all.length || rng() < 0.05) return value(rng, 0);
  const node = pick(rng, all);
  if (Array.isArray(node)) {
    const r = rng();
    if (r < 0.4 && node.length) node[int(rng, node.length)] = value(rng, 2);
    else if (r < 0.7 && node.length) node.splice(int(rng, node.length), 1);
    else node.push(rng() < 0.5 && node.length ? structuredClone(pick(rng, node)) : value(rng, 2));
    return root;
  }
  const keys = Object.keys(node);
  const r = rng();
  if (r < 0.1) put(node, pick(rng, SPEC_FIELDS), plausible(rng, pick(rng, SPEC_FIELDS)));
  else if (r < 0.55) {
    const key = pick(rng, SPEC_FIELDS);
    put(node, key, plausible(rng, key));
  } else if (r < 0.65 && keys.length) delete (node as Record<string, unknown>)[pick(rng, keys)];
  else if (r < 0.85 && keys.length) put(node, pick(rng, keys), rng() < 0.3 ? pick(rng, WORDS) : value(rng, 1));
  else put(node, rng() < 0.85 ? pick(rng, WORDS) : text(rng), value(rng, 1));
  return root;
}

/** A tree's JSON text, sometimes with room in it, so text and value sizes part. */
function textOf(rng: Rng, tree: unknown): Uint8Array {
  const json = (rng() < 0.15 ? JSON.stringify(tree, null, 1 + int(rng, 8)) : JSON.stringify(tree)) ?? 'null';
  return strToU8(json);
}

/** A value inside thousands of lists: checkSpecValue writes a value out to size it before it reads a single field. */
function deep(rng: Rng, inner: string, wrap: (nested: string) => string): Uint8Array {
  const depth = Math.min(2 ** (10 + int(rng, 6)), Math.floor((MAX_INPUT - inner.length - 32) / 2));
  return strToU8(wrap(`${'['.repeat(depth)}${inner}${']'.repeat(depth)}`));
}

function mutateJson(rng: Rng, seed: Uint8Array, generic: (bytes: Uint8Array) => Uint8Array, wrap: (nested: string) => string): Uint8Array {
  const r = rng();
  if (r < 0.25) return generic(seed);
  const tree = JSON.parse(new TextDecoder().decode(seed)) as unknown;
  if (r < 0.26) return deep(rng, JSON.stringify(tree), wrap);
  let out = tree;
  for (let n = 1 + int(rng, 3); n > 0; n--) out = change(rng, out);
  return textOf(rng, out);
}

const JSON_TOKENS = [
  '"__proto__"', '"constructor"', '1e999', '-0', '1.0', '1e0', '200', '201', 'null', 'true', '[]', '{}', '[', '{', ',', ':', '"', '\\',
  '\\u0000', '\\u001b', '\\u202e', '\\ud800', '\\udc00', '\\u2028', '"<b>"', '"2025-02-30"', '"2025-13"', '"v"', '"title"', '"show"', '"where"', '"prop"', '"is"', '"kind"', '"time"',
];

const chart = { v: 1, title: 'Garden by month', show: 'chart', form: 'bars', x: 'time' };
const split = { v: 1, title: 'Garden by source', show: 'chart', form: 'stacked', x: 'time', y: 'source', from: '2025-03', to: '2025-04-30' };
const list = { v: 1, title: 'Garden notes', show: 'list', sort: 'oldest', limit: 10, where: [{ prop: 'source', is: 'garden notes' }, { prop: 'kind', is: 'note' }] };
const month = { v: 1, title: 'March', show: 'list', where: [{ prop: 'time', is: '2025-03' }] };

// ---- the spec checker ----

/** checkSpecValue (or parseSpecText) said no, as it promises to: the input is counted as refused. */
class SpecRefused extends Error {}

const viewSpec: Target = {
  name: 'view-spec',
  owner: 'src/viewspec/spec.ts',
  // At about 13k inputs a second the process itself sits some 250 MiB above where the run started, and its peak was
  // seen to jump to 433 MiB on one run while no input held more than 18 MiB and none replays past 256 alone (seed
  // 1684760261). So the budget is the process's own room plus an input's caps.
  memoryMiB: 512,
  seeds: () => [chart, split, list, month, ...BUILTINS.map((b) => b.spec)].map((s) => strToU8(JSON.stringify(s))),
  tokens: JSON_TOKENS,
  mutate: (rng, seed, generic) => mutateJson(rng, seed, generic, (nested) => nested),
  run: (input) => {
    const text = new TextDecoder().decode(input);
    const byText = parseSpecText(text);
    checkChecked(byText, 'parseSpecText');
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      if (byText.ok) throw new Error('parseSpecText passed text that JSON.parse refuses');
      throw new SpecRefused();
    }
    const byValue = checkSpecValue(value);
    checkChecked(byValue, 'checkSpecValue');
    // The same JSON gets the same answer as text and as a value, when it is under the cap both ways.
    let size = Infinity;
    try {
      size = JSON.stringify(value)?.length ?? 0;
    } catch {
      // Not writable as JSON: checkSpecValue has refused it, and the two answers may differ.
    }
    if (text.length <= SPEC_LIMITS.text && size <= SPEC_LIMITS.text && !isDeepStrictEqual(byText, byValue)) {
      throw new Error(`parseSpecText and checkSpecValue answer the same JSON differently: ${JSON.stringify(byText).slice(0, 300)} / ${JSON.stringify(byValue).slice(0, 300)}`);
    }
    if (!byText.ok && !byValue.ok) throw new SpecRefused();
  },
  refused: (error) => error instanceof SpecRefused,
};

// ---- the routes ----

/**
 * The routes as app.ts runs them, on a body as its readJson gives one: a JSON object. Besides the fields the routes
 * read (spec, cell, request), a body may carry three of the fuzz's own: `answer`, what the fake local model answers
 * (the spec's JSON when it is left out); `id`, the saved view to delete (the one just saved, or "kept"); and `file`,
 * a saved view's file put in the folder first as "kept" (text as the file's bytes, anything else as a folder).
 */
const LOCAL = 'http://127.0.0.1:47395/v1';
const NOW = '2026-05-10T12:00:00.000Z';
const BASE = 'http://127.0.0.1';
/** Inputs one store serves before a fresh one, so the runs every draw records don't pile up over a long run. */
const STORE_USES = 1000;

interface World {
  home: string;
  store: Store;
  routes: ViewRoute[];
  uses: number;
  answer: string;
}
let world: World | undefined;

/** The local model, faked in this thread: it answers the probe with a model and every chat with `world.answer`. */
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (!url.startsWith(LOCAL)) throw new Error(`the fake model was asked for ${url}`);
  if (url.endsWith('/models')) return Response.json({ object: 'list', data: [{ id: 'fake-view-model' }] });
  if (!init?.body) throw new Error('the fake model got a chat with no body');
  return Response.json({ choices: [{ message: { role: 'assistant', content: world!.answer }, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 30 } });
}) as typeof globalThis.fetch;

/**
 * src/organiser/model.ts gives every request a signal from AbortSignal.timeout(REQUEST_MS), and that timer and its signal
 * live their full ten minutes after the request is answered. A long run makes hundreds of requests a second, and those
 * timers outgrow the memory budget within five minutes (reported to the lead, Nov 26). So in this target's worker the
 * timeouts an input makes are cleared once it is done, and the memory check measures what the input itself holds.
 */
const requestTimers: NodeJS.Timeout[] = [];
function clearTimeoutsWhenDone(): void {
  AbortSignal.timeout = (ms: number): AbortSignal => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), ms);
    timer.unref();
    requestTimers.push(timer);
    return controller.signal;
  };
}

function newWorld(home: string): World {
  const store = new Store(openDb(':memory:'), () => NOW);
  store.ingest({
    source: { kind: 'notes', label: 'Garden notes', location: '/invented/garden' },
    threads: [],
    entries: [
      { externalId: 'beds.md', kind: 'note', speaker: 'you', title: 'Tomato beds', createdAt: '2025-03-02T08:00:00.000Z', body: 'Raised beds.' },
      { externalId: 'peas.md', kind: 'note', speaker: 'you', title: 'Pea trellis', createdAt: '2025-03-20T08:00:00.000Z', body: 'Netting.' },
      { externalId: 'rye.md', kind: 'note', speaker: 'you', title: 'Rye ratios', createdAt: '2025-04-11T08:00:00.000Z', body: 'Water.' },
    ],
  });
  store.ingest({
    source: { kind: 'notes', label: 'Seed swap İstanbul', location: '/invented/swap' },
    threads: [],
    entries: [{ externalId: 'swap.md', kind: 'note', speaker: 'you', title: 'Swap list', createdAt: '2025-04-20T08:00:00.000Z', body: 'Beans.' }],
  });
  return { home, store, routes: viewRoutes({ home, store, deps: () => ({ fetch: fakeFetch, env: {}, home }) }), uses: 0, answer: '' };
}

interface Answer {
  status: number;
  body?: Record<string, any>;
  error?: unknown;
}

/** One request, answered with app.ts's status: HttpError's own, 400 for a UsageError, 500 for anything else. */
async function call(method: string, path: string, body: Record<string, unknown>): Promise<Answer> {
  const pathname = new URL(path, BASE).pathname;
  for (const [m, re, handler] of world!.routes) {
    const match = re.exec(pathname);
    if (!match || m !== method) continue;
    try {
      return { status: 200, body: (await handler({ params: match.slice(1), json: async () => body })) as Record<string, any> };
    } catch (error) {
      if (error instanceof HttpError) return { status: error.status, error };
      if (error instanceof UsageError) return { status: 400, error };
      return { status: 500, error };
    }
  }
  return { status: 404 };
}

/** A status the route promises, or the finding: the error itself for a 500, so its stack points at the fault. */
function expectStatus(what: string, answer: Answer, allowed: number[]): void {
  if (allowed.includes(answer.status)) {
    if (answer.status !== 200 && answer.error) checkMessage(`${what}'s ${answer.status} message`, (answer.error as Error).message);
    return;
  }
  if (answer.status === 500) throw answer.error;
  throw new Error(`${what} answered ${answer.status}: ${answer.error instanceof Error ? answer.error.message : 'no such route'}`);
}

const errno = (error: unknown) => (error as NodeJS.ErrnoException).code;

/** A file's or folder's mode keeps others out, where the system has modes. */
function checkPrivate(path: string): void {
  if (process.platform === 'win32') return;
  const mode = lstatSync(path).mode & 0o777;
  if (mode & 0o077) throw new Error(`${path} has mode ${mode.toString(8)}, open to others`);
}

/**
 * The fake model's answer when the body names none: the spec's JSON. Node 24's JSON.stringify recurses, so a spec
 * nested thousands of lists deep overflows the stack (input 161 of seed 20261125); checkSpecValue refuses that spec
 * the same way, and the model answers "null".
 */
function specAnswer(spec: unknown): string {
  try {
    return JSON.stringify(spec) ?? 'null';
  } catch {
    return 'null';
  }
}

/** The body was not a JSON object (app.ts's own 400), or no route took it: counted as refused. */
class RouteRefused extends Error {}

async function runRoutes(input: Uint8Array): Promise<void> {
  try {
    await routesOnce(input);
  } finally {
    for (const timer of requestTimers.splice(0)) clearTimeout(timer);
  }
}

async function routesOnce(input: Uint8Array): Promise<void> {
  const w = world!;
  if (++w.uses > STORE_USES) {
    w.store.db.close();
    world = newWorld(w.home);
  }
  const { home, store } = world!;
  const views = viewsDir(home);
  // Each input starts with no saved views, so it replays the same alone as in a run.
  rmSync(views, { recursive: true, force: true });

  // app.ts's readJson: the body is a JSON object, or the request is a 400.
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(input) || '{}') as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    throw new RouteRefused();
  }
  const own = (key: string): unknown => (Object.hasOwn(body, key) ? body[key] : undefined);
  world!.answer = typeof own('answer') === 'string' ? (own('answer') as string) : specAnswer(own('spec'));

  const kept = own('file');
  if (kept !== undefined) {
    mkdirSync(views, { mode: 0o700 });
    if (typeof kept === 'string') writeFileSync(join(views, 'kept.json'), kept);
    else mkdirSync(join(views, 'kept.json'));
  }
  let answered = false;

  const data = await call('POST', '/api/views/data', body);
  expectStatus('POST /api/views/data', data, [200, 400]);
  if (data.status === 200) {
    answered = true;
    if (!Array.isArray(data.body!.notes)) throw new Error('the data has no notes');
    for (const note of data.body!.notes) checkMessage('a data note', note);
    if (own('cell') === undefined) checkPassed(data.body!.spec, 'the data spec');
    else if (!Number.isInteger(data.body!.total) || data.body!.total < data.body!.entries.length) throw new Error(`the cell has ${data.body!.entries.length} entries of ${data.body!.total}`);
  }

  const saved = await call('POST', '/api/views', body);
  expectStatus('POST /api/views', saved, [200, 400]);
  let id: string | undefined;
  if (saved.status === 200) {
    answered = true;
    const s = saved.body!;
    id = s.id as string;
    if (typeof id !== 'string' || !VIEW_ID.test(id)) throw new Error(`a view was saved as ${JSON.stringify(id)}`);
    const checked = checkSpecValue(own('spec'));
    if (!checked.ok || !isDeepStrictEqual(s.spec, checked.spec)) throw new Error('the saved spec is not the checked one');
    const file = join(views, `${id}.json`);
    const back = parseSpecText(readFileSync(file, 'utf8'));
    if (!back.ok || !isDeepStrictEqual(back.spec, s.spec)) throw new Error(`${id}.json doesn't read back as the spec it saved`);
    checkPrivate(views);
    checkPrivate(file);
  }

  const listed = await call('GET', '/api/views', {});
  expectStatus('GET /api/views', listed, [200]);
  const l = listed.body!;
  if (l.problem !== null) throw new Error(`the list has a problem: ${String(l.problem)}`);
  for (const v of l.saved) checkPassed(v.spec, `saved view ${v.id}`);
  for (const b of l.broken) for (const reason of b.reasons) checkMessage(`broken view ${b.id}'s reason`, reason);
  if (id !== undefined) {
    const found = l.saved.filter((v: { id: string }) => v.id === id);
    if (found.length !== 1 || !isDeepStrictEqual(found[0].spec, saved.body!.spec)) throw new Error(`${id} is listed ${found.length} times, or with another spec`);
  }
  if (kept !== undefined) {
    const times = [...l.saved, ...l.broken].filter((v: { id: string }) => v.id === 'kept').length;
    if (times !== 1) throw new Error(`the kept file is listed ${times} times`);
  }

  const target = id ?? (typeof own('id') === 'string' ? (own('id') as string) : 'kept');
  const deleted = await call('POST', `/api/views/${target}/delete`, {});
  expectStatus('POST /api/views/<id>/delete', deleted, [200, 400, 404]);
  if (deleted.status === 200) {
    const gone = deleted.body!.deleted as string;
    try {
      lstatSync(join(views, `${gone}.json`));
      throw new Error(`${gone} is still there after it was deleted`);
    } catch (error) {
      if (errno(error) !== 'ENOENT') throw error;
    }
  }

  const drawn = await call('POST', '/api/views/draw', body);
  expectStatus('POST /api/views/draw', drawn, [200, 400]);
  if (drawn.status === 200) {
    answered = true;
    const d = drawn.body!;
    checkPassed(d.spec, 'the drawn spec');
    if (d.drawn === true) {
      if (d.builtin !== null || d.why.length) throw new Error('a drawn view also names a built-in or a reason');
    } else if (d.drawn !== false || !BUILTINS.some((b) => b.id === d.builtin) || !d.why.length) {
      throw new Error(`a view that wasn't drawn stands in with ${String(d.builtin)}`);
    }
    for (const why of d.why) checkMessage('a reason the draw gave', why);
  }
  // Every draw that started a run ended it.
  try {
    assertNoRunning(store.db);
  } catch (error) {
    throw new Error(`a draw left a run going: ${(error as Error).message}`);
  }
  if (!answered) throw new RouteRefused();
}

const viewRoutesTarget: Target = {
  name: 'view-routes',
  owner: 'src/server/viewspec.ts',
  // As view-spec's: 20k inputs replayed in a fresh process sit 208 MiB above where they started, and a 900 s run
  // (seed 45503953) peaked at 260 on 16 inputs that peak at 21 replayed together.
  memoryMiB: 512,
  seeds: () =>
    [
      { spec: chart },
      { spec: list, cell: { x: '2025-03', y: null } },
      { spec: split, cell: { x: '2025-03', y: 'Garden notes' } },
      { spec: month, id: 'march' },
      { request: 'garden notes, month by month' },
      { request: 'notes by source', answer: JSON.stringify({ ...list, where: [{ prop: 'source', is: 'SEED SWAP İSTANBUL' }] }) },
      { request: 'a list', answer: 'Here is your view: {"v": 1}' },
      { spec: chart, file: JSON.stringify(list) },
      { spec: list, file: '{"v": 1, "title": "half' },
      { spec: month, file: {} },
    ].map((b) => strToU8(JSON.stringify(b))),
  tokens: JSON_TOKENS,
  mutate: (rng, seed, generic) => mutateJson(rng, seed, generic, (nested) => `{"spec": ${nested}, "request": "x"}`),
  setUp: (folder) => {
    const home = join(folder, 'home');
    mkdirSync(home, { recursive: true, mode: 0o700 });
    saveConfig(home, { ...loadConfig(home), engine: 'local', localUrl: LOCAL });
    world?.store.db.close();
    world = newWorld(home);
    clearTimeoutsWhenDone();
  },
  writesIn: (folder) => viewsDir(join(folder, 'home')),
  run: runRoutes,
  refused: (error) => error instanceof RouteRefused,
};

export const VIEW_TARGETS: Target[] = [viewSpec, viewRoutesTarget];
