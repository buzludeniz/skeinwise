import { describe, expect, it } from 'vitest';
import {
  buildIndex,
  centroid,
  chooseK,
  cosine,
  distinctiveTerms,
  kmeans,
  pickDiverse,
  sentences,
  stem,
  summarize,
  tokenize,
  topTerms,
  vectorize,
} from '../src/organiser/text.ts';

const GARDEN = [
  'The allotment plots need a waiting list. Plot holders pay rent each spring.',
  'Allotment rent goes up next year; the plots by the river flood in winter.',
  'Waiting list rules for the allotment: one plot per household.',
];
const BREAD = [
  'My sourdough starter doubled overnight. The bread had a great crumb.',
  'Sourdough loaf came out flat; the starter was sluggish after the fridge.',
  'Feeding the starter twice a day before baking sourdough bread.',
];

describe('tokenize and stem', () => {
  it('drops stop words and numbers and meets word forms', () => {
    expect(tokenize("I've been planting 3 plots, and it's raining")).toEqual(['plant', 'plot', 'rain']);
    expect(stem('plotted')).toBe(stem('plots'));
    expect(stem('decided')).toBe(stem('decide'));
    expect(stem('deciding')).toBe(stem('decides'));
    expect(stem('studies')).toBe('study');
    expect(stem('running')).toBe('run');
  });

  it('splits sentences at end marks and line breaks', () => {
    expect(sentences('First one. Second one? Third!\n- a list item\n\n# Heading')).toEqual([
      'First one.',
      'Second one?',
      'Third!',
      'a list item',
      'Heading',
    ]);
    expect(sentences('Version 2.5 is out. Good')).toEqual(['Version 2.5 is out.', 'Good']);
  });
});

describe('TF-IDF and cosine', () => {
  const index = buildIndex([...GARDEN, ...BREAD]);

  it('gives normalised vectors, and similar texts score higher', () => {
    for (const v of index.vectors) {
      let sum = 0;
      for (const w of v.values()) sum += w * w;
      expect(sum).toBeCloseTo(1, 9);
    }
    const [g0, g1] = [index.vectors[0]!, index.vectors[1]!];
    const b0 = index.vectors[3]!;
    expect(cosine(g0, g1)).toBeGreaterThan(cosine(g0, b0));
    expect(cosine(g0, g0)).toBeCloseTo(1, 9);
  });

  it('vectorises new text against the index', () => {
    const q = vectorize(index, 'sourdough starter');
    const scores = index.vectors.map((v) => cosine(q, v));
    expect(scores.indexOf(Math.max(...scores))).toBeGreaterThanOrEqual(3);
    expect(vectorize(index, 'nothing known here zebra').size).toBe(0);
  });

  it('shows names in their usual spelling and ordinary words in lower case', () => {
    const idx = buildIndex(['Plotline uses SQLite.', 'Plotline on SQLite again.', 'Sourdough is bread. sourdough rises.']);
    const shown = (t: string) => idx.shown[idx.termId.get(t)!];
    expect(shown('plotlin')).toBe('Plotline');
    expect(shown('sqlit')).toBe('SQLite');
    expect(shown('sourdough')).toBe('sourdough');
  });
});

describe('k-means', () => {
  const index = buildIndex([...GARDEN, ...BREAD]);

  it('separates two clear groups, the same way every time', () => {
    const a = kmeans(index.vectors, 2, 7);
    const b = kmeans(index.vectors, 2, 7);
    expect(a.assign).toEqual(b.assign);
    expect(new Set(a.assign.slice(0, 3)).size).toBe(1);
    expect(new Set(a.assign.slice(3)).size).toBe(1);
    expect(a.assign[0]).not.toBe(a.assign[3]);
  });

  it('leaves empty vectors out and never makes more groups than items', () => {
    const vectors = [...index.vectors.slice(0, 2), new Map()];
    const result = kmeans(vectors, 5, 1);
    expect(result.assign[2]).toBe(-1);
    expect(result.centroids.length).toBeLessThanOrEqual(2);
  });

  it('picks k near the square root of n/2', () => {
    expect(chooseK(1)).toBe(1);
    expect(chooseK(136)).toBe(8);
    expect(chooseK(100000)).toBe(40);
  });
});

describe('keywords and summaries', () => {
  const index = buildIndex([...GARDEN, ...BREAD]);

  it('finds the words that set a group apart', () => {
    const terms = distinctiveTerms(index, index.vectors.slice(3), 3).map((i) => index.terms[i]);
    expect(terms).toContain('sourdough');
    expect(terms).toContain('starter');
    const top = topTerms(index.vectors[0]!, 2).map((i) => index.terms[i]);
    expect(top.length).toBe(2);
  });

  it('picks central, different sentences', () => {
    const candidates = index.vectors.map((vector) => ({ vector }));
    const target = centroid(index.vectors.slice(0, 3));
    const picked = pickDiverse(candidates, target, 2);
    expect(picked).toHaveLength(2);
    expect(picked.every((i) => i < 3)).toBe(true);
  });

  it('summarises a text with its own sentences, in order', () => {
    const text = GARDEN.join(' ');
    const summary = summarize(index, text, 2);
    expect(summary).toHaveLength(2);
    const all = sentences(text);
    expect(all.indexOf(summary[0]!)).toBeLessThan(all.indexOf(summary[1]!));
  });
});
