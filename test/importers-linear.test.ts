// LS-06 (M6): the wiki-link and HTML parsers run in one pass. Built from PoC 11 (11_redos.mjs): 200,000 "[" took
// 75.9 s to parse as a note and 200,000 "<" 68.6 s to strip. The property tests hold the scanners to the regexes they
// replace, on ordinary notes and on fuzz.
import { describe, expect, it } from 'vitest';
import { parseNote, wikiLinks } from '../src/importers/notes.ts';
import { entity, stripHtml } from '../src/importers/util.ts';

// The replaced code, kept here as the reference. (Entities go through the new guard, so `&#x;` doesn't throw here.)
const oldLinks = (body: string) => [...body.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)].map((m) => m[1]!.trim());
const oldStripHtml = (html: string) =>
  html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d|pre|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#?\w+);/g, (m, name: string) => entity(name) ?? m)
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** A seeded generator, so a failure names an input that can be run again. */
function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]!;
  return { next, pick };
}

const WORDS = ['seed', 'tomato', 'bread', 'crumb', 'ledger', 'Postgres', 'plan', 'idea', 'a', 'the', 'Mara', 'Ünïcode', 'İstanbul'];
const NOTE_BITS = [
  () => '[[Garden Plan]]',
  () => '[[Garden Plan|the plan]]',
  () => '[[Recipes#Bread]]',
  () => '[[ spaced target ]]',
  () => '[[unclosed',
  () => '[single]',
  () => ']]',
  () => '[[]]',
  () => '[[a|b|c]]',
  () => '[[outer [[inner]]]]',
  () => '#tag',
  () => '\n# Heading\n',
  () => '\n- item\n',
  () => '`code ]]`',
];
const HTML_BITS = [
  '<p>',
  '</p>',
  '<br>',
  '<br/>',
  '<BR />',
  '<ul>',
  '<li>',
  '<LI class="x">',
  '</li>',
  '<div class="answer">',
  '</div>',
  '<h2>',
  '</h2>',
  '<pre>',
  '</pre>',
  '&amp;',
  '&#39;',
  '&#x1F600;',
  'a < b',
  '<>',
  '<link rel="x">',
  '\n\n\n',
];

describe('PoC 11: 200,000 hostile characters parse in one pass', () => {
  // The PoC's bar is 50 ms each. The bound here is looser, so a loaded machine doesn't fail it, and still 100 times
  // under what a rescan from every character costs.
  const fast = (fn: () => unknown) => {
    const started = performance.now();
    fn();
    return performance.now() - started;
  };
  const n = 200_000;
  it.each([
    ['a note of "["', () => parseNote('x.md', '['.repeat(n), new Date())],
    ['a note of "[[a#"', () => parseNote('x.md', '[[a#'.repeat(n / 4), new Date())],
    ['a note of "[[a"', () => parseNote('x.md', '[[a'.repeat(n / 3), new Date())],
    ['HTML of "<"', () => stripHtml('<'.repeat(n))],
    ['HTML of "<li"', () => stripHtml('<li'.repeat(n / 2))],
    ['HTML of "<<>"', () => stripHtml('<<>'.repeat(n / 3))],
  ])('%s', (_label, fn) => {
    expect(fast(fn)).toBeLessThan(500);
  });

  it('finds the same links in those as the regex would, where the regex finishes', () => {
    for (const body of ['['.repeat(2000), '[[a#'.repeat(500), '[[a'.repeat(700), '[[a]]'.repeat(300), '[[a|'.repeat(400) + ']]']) {
      expect(wikiLinks(body)).toEqual(oldLinks(body));
    }
    expect(stripHtml('<'.repeat(2000))).toBe(oldStripHtml('<'.repeat(2000)));
    expect(stripHtml('<li'.repeat(700))).toBe(oldStripHtml('<li'.repeat(700)));
  });
});

describe('the scanners give exactly what the regexes gave', () => {
  it('on 10,000 ordinary notes', () => {
    const { next, pick } = random(11);
    for (let i = 0; i < 10_000; i++) {
      let body = '';
      const parts = 5 + Math.floor(next() * 40);
      for (let p = 0; p < parts; p++) body += next() < 0.3 ? pick(NOTE_BITS)() : `${pick(WORDS)} `;
      expect(wikiLinks(body), `note ${i}: ${JSON.stringify(body)}`).toEqual(oldLinks(body));
      const note = parseNote('n.md', body, new Date(0));
      expect(note.links).toEqual([...new Set(oldLinks(note.body))]);
    }
  });

  it('on 10,000 ordinary replies', () => {
    const { next, pick } = random(12);
    for (let i = 0; i < 10_000; i++) {
      let html = '';
      const parts = 5 + Math.floor(next() * 40);
      for (let p = 0; p < parts; p++) html += next() < 0.5 ? pick(HTML_BITS) : `${pick(WORDS)} `;
      expect(stripHtml(html), `reply ${i}: ${JSON.stringify(html)}`).toBe(oldStripHtml(html));
    }
  });

  it('on 10,000 strings of the characters that matter, in any order', () => {
    const { next, pick } = random(13);
    const alphabet = ['[', ']', '|', '#', 'a', ' ', '\n', '<', '>', 'l', 'i', 'L', 'I', '/', 'b', 'r', '&', ';', 'x', '1'];
    for (let i = 0; i < 10_000; i++) {
      let text = '';
      const length = Math.floor(next() * 80);
      for (let c = 0; c < length; c++) text += pick(alphabet);
      expect(wikiLinks(text), JSON.stringify(text)).toEqual(oldLinks(text));
      expect(stripHtml(text), JSON.stringify(text)).toBe(oldStripHtml(text));
    }
  });
});
