import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../src/random.ts';
import { isBidiControl } from '../../src/safe-text.ts';
import { checkPassed } from '../fuzz/views.ts';
import { TABLE_FORMS, TABLE_PROPS } from '../../src/server/config.ts';
import {
  type Checked,
  checkSpec,
  checkSpecValue,
  KINDS,
  parseSpecText,
  SHOWS,
  SORTS,
  SPEC_FIELDS,
  SPEC_LIMITS,
  type ViewSpec,
  WHERE_PROPS,
} from '../../src/viewspec/spec.ts';

const chart = { v: 1, title: 'Projects over time', show: 'chart', form: 'heatmap', x: 'time', y: 'project' };
const list = { v: 1, title: 'Your notes', show: 'list', where: [{ prop: 'kind', is: 'note' }] };

function ok(input: unknown): ViewSpec {
  const r = checkSpec(input);
  if (!r.ok) throw new Error(`expected a pass, got: ${r.reasons.join(' | ')}`);
  return r.spec;
}

function reasons(input: unknown): string {
  const r = checkSpec(input);
  if (r.ok) throw new Error(`expected a refusal, got ${JSON.stringify(r.spec)}`);
  return r.reasons.join(' | ');
}

describe('checkSpec', () => {
  it('passes a chart and a list, fills in the list defaults, and checking again changes nothing', () => {
    expect(ok(chart)).toEqual(chart);
    const l = ok(list);
    expect(l).toEqual({ ...list, sort: 'newest', limit: 50 });
    expect(ok(l)).toEqual(l);
    expect(ok({ v: 1, title: 'By month', show: 'chart', form: 'bars', x: 'time' })).not.toHaveProperty('y');
  });

  it('returns a new object holding the checked fields only', () => {
    const input = { ...chart, where: [{ prop: 'source', is: 'Notes' }] };
    const spec = ok(input);
    expect(spec).not.toBe(input);
    expect((spec as { where?: unknown[] }).where).not.toBe(input.where);
    expect(Object.getPrototypeOf(spec)).toBe(Object.prototype);
  });

  it('refuses fields it does not know, __proto__ and constructor included, without touching any prototype', () => {
    expect(reasons({ ...chart, script: 'alert(1)' })).toMatch(/no field "script"/);
    const parsed = JSON.parse('{"v":1,"title":"t","show":"list","__proto__":{"polluted":true}}');
    expect(reasons(parsed)).toMatch(/no field "__proto__"/);
    expect(reasons({ ...chart, constructor: 'x' })).toMatch(/no field "constructor"/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(reasons(Object.assign(Object.create({ v: 1, title: 't', show: 'list' }), {}))).toMatch(/must be a JSON object/);
  });

  it('refuses what is not an object, and values outside the lists', () => {
    for (const bad of [null, 1, 'a view', [], true]) expect(reasons(bad)).toMatch(/must be a JSON object/);
    expect(reasons({ ...chart, v: 2 })).toMatch(/"v" must be 1/);
    expect(reasons({ ...chart, show: 'html' })).toMatch(/"show" must be "chart" or "list"/);
    expect(reasons({ ...chart, form: 'pie' })).toMatch(/"form" must be one of table, heatmap/);
    expect(reasons({ ...chart, x: 'mood' })).toMatch(/"x" must be one of time/);
    expect(reasons({ ...chart, y: 'time' })).toMatch(/both "time"/);
    expect(reasons({ ...list, sort: 'random' })).toMatch(/"sort" must be/);
    for (const limit of [0, 201, 2.5, '10', Number.NaN]) expect(reasons({ ...list, limit })).toMatch(/"limit" must be a whole number/);
  });

  it("keeps chart fields off lists and list fields off charts", () => {
    expect(reasons({ ...chart, sort: 'newest' })).toMatch(/A chart has no sort/);
    expect(reasons({ ...list, x: 'time', form: 'bars' })).toMatch(/A list has no form, x/);
  });

  it('cleans the title: controls out, at most 80 characters, and no markup', () => {
    expect(ok({ ...chart, title: '  \u001b]0;x\u0007By‮ month\n ' }).title).toBe('By month');
    expect([...ok({ ...chart, title: '日'.repeat(90) }).title]).toHaveLength(SPEC_LIMITS.title);
    expect(reasons({ ...chart, title: '<script>alert(1)</script>' })).toMatch(/can't contain < or >/);
    expect(reasons({ ...chart, title: ' \n ' })).toMatch(/"title" is empty/);
    expect(reasons({ ...chart, title: 7 })).toMatch(/"title" must be text, not 7/);
  });

  it('checks filters: at most four, one per property, months for time, kinds by name, no markup', () => {
    const where = (w: unknown) => ({ ...list, where: w });
    expect(ok(where([{ prop: 'project', is: ' Garden ' }, { prop: 'time', is: '2025-03' }])).where).toEqual([
      { prop: 'project', is: 'Garden' },
      { prop: 'time', is: '2025-03' },
    ]);
    expect(reasons(where('kind:note'))).toMatch(/must be a list of filters/);
    expect(reasons(where(['folder', 'project', 'hub', 'tag', 'source'].map((prop) => ({ prop, is: 'a' }))))).toMatch(/at most 4/);
    expect(reasons(where([{ prop: 'tag', is: 'a' }, { prop: 'tag', is: 'b' }]))).toMatch(/one filter per property/);
    expect(reasons(where([{ prop: 'time', is: '2025' }]))).toMatch(/a month, like "2025-03"/);
    expect(reasons(where([{ prop: 'kind', is: 'email' }]))).toMatch(/kind must be one of message, note, file/);
    expect(reasons(where([{ prop: 'project', is: '<img src=x onerror=alert(1)>' }]))).toMatch(/can't contain < or >/);
    expect(reasons(where([{ prop: 'project', is: 'x'.repeat(121) }]))).toMatch(/longer than 120/);
    expect(reasons(where([{ prop: 'project', is: 'a', sql: "' OR 1=1" }]))).toMatch(/no field "sql"/);
    expect(reasons(where([{ prop: 'mood', is: 'a' }]))).toMatch(/"prop" must be one of/);
    expect(reasons(where([{ prop: 'project', is: '' }]))).toMatch(/"is" is empty/);
  });

  it('checks dates: a month or a day, and from no later than to', () => {
    expect(ok({ ...list, from: '2025-03-15', to: '2025-03' })).toMatchObject({ from: '2025-03-15', to: '2025-03' });
    expect(reasons({ ...list, from: '2025-13' })).toMatch(/"from" must be a date/);
    expect(reasons({ ...list, to: 'last week' })).toMatch(/"to" must be a date/);
    expect(reasons({ ...list, from: '2025-04', to: '2025-03-31' })).toMatch(/comes after/);
  });

  it('gives back the fields that passed on their own when the whole fails', () => {
    const r = checkSpec({ v: 1, title: 'Notes by tag', show: 'chart', form: 'pie', x: 'tag', where: [{ prop: 'kind', is: 'note' }, { prop: 'x', is: 'y' }] });
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.salvage).toEqual({ title: 'Notes by tag', show: 'chart', x: 'tag', where: [{ prop: 'kind', is: 'note' }] });
  });

  it('reads spec text and spec values with a size cap', () => {
    expect(parseSpecText(JSON.stringify(chart))).toEqual({ ok: true, spec: chart });
    expect(parseSpecText('{"v":1,')).toMatchObject({ ok: false, reasons: ["The view isn't JSON."] });
    expect(parseSpecText(' '.repeat(SPEC_LIMITS.text + 1))).toMatchObject({ ok: false, reasons: [expect.stringMatching(/longer than 8192/)] });
    expect(checkSpecValue({ ...chart, title: 'x'.repeat(SPEC_LIMITS.text) })).toMatchObject({ ok: false, reasons: [expect.stringMatching(/longer than/)] });
    const loop: Record<string, unknown> = { ...chart };
    loop.self = loop;
    expect(checkSpecValue(loop)).toMatchObject({ ok: false, reasons: ["The view isn't JSON."] });
    expect(checkSpecValue({ ...chart, n: 10n })).toMatchObject({ ok: false, reasons: ["The view isn't JSON."] });
  });
});

// --- Fuzz -----------------------------------------------------------------------------------------------------------
// Seeded, so a failure reproduces: the message carries the input. SKEINWISE_FUZZ_RUNS raises the count for a long run.

const RUNS = Number(process.env.SKEINWISE_FUZZ_RUNS ?? '') || 3000;
/** A millisecond a run is ample; vitest's 5 s default covers the usual count. */
const LONG = Math.max(5000, RUNS);

function hasControl(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || isBidiControl(c)) return true;
  }
  return false;
}

/** A refusal gives clean reasons and fields it may keep; a passed spec keeps every rule the views fuzz holds it to. */
function assertSound(r: Checked, input: string): void {
  if (!r.ok) {
    expect(r.reasons.length, input).toBeGreaterThan(0);
    for (const reason of r.reasons) {
      expect(typeof reason, input).toBe('string');
      expect(hasControl(reason), `${input} → ${reason}`).toBe(false);
      expect(reason.length, input).toBeLessThan(600);
    }
    for (const key of Object.keys(r.salvage)) expect(SPEC_FIELDS as readonly string[], input).toContain(key);
    return;
  }
  expect(() => checkPassed(r.spec, `the spec from ${input}`)).not.toThrow();
}

function generators(seed: number) {
  const rand = mulberry32(seed);
  const int = (n: number) => Math.floor(rand() * n);
  const pick = <T>(list: readonly T[]): T => list[int(list.length)]!;
  const chars = [
    'a', 'Z', '0', ' ', '-', '"', "'", '\\', '/', '<', '>', '&', ':', '{', '}', 'é', '日', '🧶',
    '\u0000', '\u0007', '\u001b', '\n', '\t', '\r', '\u007f', '\u0085', '\u009b', '‏', '‪', '‮', '⁦', '⁩', ' ', '﻿', '\ud800',
  ];
  const words = [
    ...SPEC_FIELDS, ...TABLE_PROPS, ...TABLE_FORMS, ...KINDS, ...SORTS, ...SHOWS, 'prop', 'is',
    '__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'script', 'javascript:alert(1)', '2025-03', '2025-03-14', '2025-02-31', '1999-00',
  ];
  const text = (): string => (rand() < 0.4 ? pick(words) : Array.from({ length: int(rand() < 0.1 ? 140 : 24) }, () => pick(chars)).join(''));
  const num = (): number => pick([0, 1, -1, 2, 50, 200, 201, 2.5, -0, 1e300, 2 ** 53, Number.NaN, Number.POSITIVE_INFINITY, int(400)]);
  const value = (depth: number): unknown => {
    const k = int(depth > 2 ? 5 : 8);
    if (k === 0) return null;
    if (k === 1) return rand() < 0.5;
    if (k === 2) return num();
    if (k === 3 || k === 4) return text();
    if (k === 5) return Array.from({ length: int(6) }, () => value(depth + 1));
    return object(depth + 1);
  };
  const object = (depth: number): Record<string, unknown> => {
    const o: Record<string, unknown> = {};
    for (let i = int(7); i > 0; i--) Object.defineProperty(o, rand() < 0.8 ? pick(words) : text(), { value: value(depth), enumerable: true, configurable: true, writable: true });
    return o;
  };
  const where = (): unknown => ({ prop: pick(WHERE_PROPS), is: pick([text(), 'note', 'file', '2025-03', 'Garden', ' Garden ']) });
  const valid = (): Record<string, unknown> => {
    const base: Record<string, unknown> =
      rand() < 0.5
        ? { v: 1, title: text() || 'A view', show: 'chart', form: pick(TABLE_FORMS), x: pick(TABLE_PROPS), ...(rand() < 0.6 ? { y: pick(TABLE_PROPS) } : {}) }
        : { v: 1, title: text() || 'A view', show: 'list', ...(rand() < 0.5 ? { sort: pick(SORTS) } : {}), ...(rand() < 0.5 ? { limit: 1 + int(200) } : {}) };
    if (rand() < 0.5) base.where = Array.from({ length: int(5) }, where);
    if (rand() < 0.3) base.from = pick(['2024-01', '2025-06-30', '2026-12']);
    if (rand() < 0.3) base.to = pick(['2024-01', '2025-06-30', '2026-12']);
    return base;
  };
  /** A near-valid spec with one to three changes: the inputs most likely to slip through a gap. */
  const mutant = (): unknown => {
    const o = valid();
    for (let n = 1 + int(3); n > 0; n--) {
      const key = rand() < 0.85 ? pick(SPEC_FIELDS) : pick(words);
      const r = rand();
      if (r < 0.3) delete o[key];
      else if (r < 0.75) Object.defineProperty(o, key, { value: value(1), enumerable: true, configurable: true, writable: true });
      else if (Array.isArray(o.where) && o.where.length) (o.where as Record<string, unknown>[])[int(o.where.length)] = rand() < 0.5 ? object(2) : { ...(where() as object), [pick(words)]: value(2) };
      else o[key] = pick(words);
    }
    return o;
  };
  /** JSON text with a few characters changed: what a model or a hand-edited file might send. */
  const garbled = (): string => {
    let s = JSON.stringify(rand() < 0.5 ? valid() : value(0)) ?? 'null';
    for (let n = int(4); n > 0; n--) {
      const at = int(s.length + 1);
      const r = rand();
      if (r < 0.4) s = s.slice(0, at) + s.slice(at + 1);
      else if (r < 0.8) s = s.slice(0, at) + pick(['"', ',', '{', '}', '[', ']', ':', '\\', 'null', '"__proto__":{}', '1e999']) + s.slice(at);
      else s = s.slice(0, at) + pick(chars) + s.slice(at);
    }
    return s;
  };
  return { valid, mutant, value, garbled };
}

describe('checkSpec (seeded fuzz)', () => {
  it('passes or refuses every near-valid spec soundly, and both happen', () => {
    const g = generators(20261125);
    let passed = 0;
    for (let n = 0; n < RUNS; n++) {
      const input = g.mutant();
      const label = JSON.stringify(input) ?? String(input);
      const r = checkSpec(input);
      assertSound(r, label);
      if (r.ok) passed++;
    }
    expect(passed).toBeGreaterThan(RUNS * 0.05);
    expect(passed).toBeLessThan(RUNS * 0.95);
  }, LONG);

  it('checks specs built from valid parts soundly', () => {
    const g = generators(7319);
    for (let n = 0; n < RUNS; n++) {
      const input = g.valid();
      assertSound(checkSpec(input), JSON.stringify(input));
    }
  }, LONG);

  it('never throws on any value, and refuses whatever is not an object', () => {
    const g = generators(8731);
    for (let n = 0; n < RUNS; n++) {
      const input = g.value(0);
      const r = checkSpec(input);
      assertSound(r, JSON.stringify(input) ?? String(input));
      if (typeof input !== 'object' || input === null || Array.isArray(input)) expect(r.ok).toBe(false);
    }
  }, LONG);

  it('reads garbled JSON text soundly, and leaves Object.prototype alone', () => {
    const g = generators(42);
    const before = Object.getOwnPropertyNames(Object.prototype).sort();
    for (let n = 0; n < RUNS; n++) {
      const text = g.garbled();
      assertSound(parseSpecText(text), text);
    }
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  }, LONG);
});
