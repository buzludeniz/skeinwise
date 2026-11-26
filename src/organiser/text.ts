// The No-AI engine's text tools: a tokenizer with stop words and light stemming, TF-IDF term vectors, cosine
// similarity, seeded k-means, keywords and extractive summaries. Everything is deterministic: the same record and
// seed give the same result.

import { mulberry32 } from '../random.ts';

const STOP_WORDS = new Set(
  `a about above after again against ago all almost also although always am among an and another any anyone anything
  anyway are around as ask asked at away back be became because been before being below best better between both but
  by can cannot cant could couldnt day days did didnt do does doesnt doing done dont down during each either else enough
  etc even ever every everything few first for from further get gets getting give given go goes going gone good got
  great had hadnt has hasnt have havent having he her here hers herself him himself his how however id ill im into is
  isnt it its itself ive just keep kind know last least less let lets like likely little lot lots made make makes
  making many may maybe me might mine more most much must my myself need needs never new next no nor not now of off
  often oh ok okay on once one only onto or other others otherwise our ours ourselves out over own perhaps please
  pretty put quite rather re really right said same say says see seem seems several shall she should shouldnt since so
  some something sometimes soon still such sure take than thank thanks that thats the their theirs them themselves then
  there theres these they theyre thing things think this those though through thus to today too took toward try trying
  two under until up upon us use used using very via want wants was wasnt way we well were werent what whats when
  where whether which while who whole whom whose why will with within without wont would wouldnt yeah yes yet you youd
  youll your youre yours yourself yourselves youve`.split(/\s+/),
);

/** Light suffix stripping, so "plots", "plotted" and "plotting" meet. Not a full stemmer, and not meant to be. */
export function stem(word: string): string {
  let w = word;
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith('ied') && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.endsWith('s') && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  if (w.endsWith('ing') && w.length >= 6) w = undouble(w.slice(0, -3));
  else if (w.endsWith('ed') && w.length >= 5) w = undouble(w.slice(0, -2));
  if (w.endsWith('ly') && w.length >= 6) w = w.slice(0, -2);
  if (w.endsWith('e') && w.length > 4) w = w.slice(0, -1);
  return w;
}

function undouble(w: string): string {
  const a = w.at(-1);
  if (a && a === w.at(-2) && !'lsz'.includes(a) && !'aeiou'.includes(a)) return w.slice(0, -1);
  return w;
}

/** Words as they appear (case kept), apostrophes dropped, numbers and one-letter words left out. */
function words(text: string): string[] {
  return (text.replace(/['’]/g, '').match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1 && !/^\d+$/.test(w));
}

/** Content tokens: lowercased, stop words removed, stemmed. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const w of words(text)) {
    const lower = w.toLowerCase();
    if (!STOP_WORDS.has(lower)) out.push(stem(lower));
  }
  return out;
}

/**
 * A text's most frequent words after stop words, as written (lowercase), one per stem: its commonest spelling. Ties
 * go to the longer word, then the first in the alphabet. For a full-text query that should read like the text.
 */
export function keyWords(text: string, n: number): string[] {
  const byStem = new Map<string, { count: number; forms: Map<string, number> }>();
  for (const w of words(text)) {
    const lower = w.toLowerCase();
    if (STOP_WORDS.has(lower)) continue;
    const t = stem(lower);
    const s = byStem.get(t) ?? { count: 0, forms: new Map<string, number>() };
    s.count++;
    s.forms.set(lower, (s.forms.get(lower) ?? 0) + 1);
    byStem.set(t, s);
  }
  const first = (forms: Map<string, number>) => [...forms].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || (a[0] < b[0] ? -1 : 1))[0]![0];
  return [...byStem.values()]
    .map((s) => ({ count: s.count, word: first(s.forms) }))
    .sort((a, b) => b.count - a.count || b.word.length - a.word.length || (a.word < b.word ? -1 : 1))
    .slice(0, n)
    .map((s) => s.word);
}

/** Splits text into sentences: at . ! or ? before a space, and at line breaks. List markers are dropped. */
export function sentences(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n+/)) {
    const clean = line.replace(/^\s*(?:[-*+>]|\d+[.)]|#+)\s+/, '').trim();
    if (!clean) continue;
    for (const part of clean.split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}"'(\[])/u)) {
      const s = part.trim();
      if (s) out.push(s);
    }
  }
  return out;
}

/** A sparse term vector: term index to weight. Vectors from an index are L2-normalised. */
export type Vec = Map<number, number>;

export interface TermIndex {
  /** Stemmed terms. */
  terms: string[];
  /** For each term, the word to show for it. */
  shown: string[];
  idf: Float64Array;
  termId: Map<string, number>;
  /** The document vectors, in the order given. */
  vectors: Vec[];
  /** The mean weight of each term over all documents. */
  mean: Float64Array;
}

export interface IndexOptions {
  /** Terms in fewer documents than this are dropped. Default: 2 when there are 20 or more documents, else 1. */
  minDf?: number;
  /** Terms in more than this share of the documents are dropped (only with 10 or more documents). Default 0.5. */
  maxDfRatio?: number;
}

/** Which document frequencies keep a term, out of n documents (IndexOptions). */
export function dfWindow(n: number, options: IndexOptions = {}): { minDf: number; maxDf: number } {
  const minDf = options.minDf ?? (n >= 20 ? 2 : 1);
  const maxDf = n >= 10 ? Math.max(minDf, Math.floor(n * (options.maxDfRatio ?? 0.5))) : n;
  return { minDf, maxDf };
}

/** Smoothed inverse document frequency: a term in df of n documents. */
export function idfOf(n: number, df: number): number {
  return Math.log((1 + n) / (1 + df)) + 1;
}

/** A term's weight before normalising: sublinear in how often it occurs. */
export function termWeight(count: number, idf: number): number {
  return (1 + Math.log(count)) * idf;
}

/** Builds TF-IDF vectors (sublinear tf, smoothed idf, L2-normalised) for a list of texts. */
export function buildIndex(texts: string[], options: IndexOptions = {}): TermIndex {
  const n = texts.length;
  const { minDf, maxDf } = dfWindow(n, options);
  const counts: Map<string, number>[] = [];
  const df = new Map<string, number>();
  const forms = new Map<string, Map<string, number>>();
  for (const text of texts) {
    const c = new Map<string, number>();
    for (const w of words(text)) {
      const lower = w.toLowerCase();
      if (STOP_WORDS.has(lower)) continue;
      const t = stem(lower);
      c.set(t, (c.get(t) ?? 0) + 1);
      const f = forms.get(t) ?? new Map<string, number>();
      f.set(w, (f.get(w) ?? 0) + 1);
      forms.set(t, f);
    }
    counts.push(c);
    for (const t of c.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const terms = [...df.keys()].filter((t) => df.get(t)! >= minDf && df.get(t)! <= maxDf).sort();
  const termId = new Map(terms.map((t, i) => [t, i]));
  const idf = new Float64Array(terms.length);
  terms.forEach((t, i) => (idf[i] = idfOf(n, df.get(t)!)));
  const vectors = counts.map((c) => weigh(c, termId, idf));
  const mean = new Float64Array(terms.length);
  for (const v of vectors) for (const [i, w] of v) mean[i]! += w / Math.max(1, n);
  return { terms, shown: terms.map((t) => shownForm(forms.get(t)!)), idf, termId, vectors, mean };
}

function weigh(counts: Map<string, number>, termId: Map<string, number>, idf: Float64Array): Vec {
  const v: Vec = new Map();
  for (const [t, c] of counts) {
    const i = termId.get(t);
    if (i !== undefined) v.set(i, termWeight(c, idf[i]!));
  }
  return normalise(v);
}

/** A lowercase form when it is common enough (ordinary words), else the most frequent spelling (names, "SQLite"). */
function shownForm(forms: Map<string, number>): string {
  let total = 0;
  const lower = new Map<string, number>();
  for (const [w, c] of forms) {
    total += c;
    if (w === w.toLowerCase()) lower.set(w, c);
  }
  const pick = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0];
  const lowerTotal = [...lower.values()].reduce((a, b) => a + b, 0);
  return lowerTotal * 4 >= total && lower.size ? pick(lower) : pick(forms);
}

/** Vectorises a new text against an existing index (terms the index doesn't know are ignored). */
export function vectorize(index: TermIndex, text: string): Vec {
  const c = new Map<string, number>();
  for (const t of tokenize(text)) c.set(t, (c.get(t) ?? 0) + 1);
  return weigh(c, index.termId, index.idf);
}

export function normalise(v: Vec): Vec {
  let sum = 0;
  for (const w of v.values()) sum += w * w;
  if (sum === 0) return v;
  const norm = Math.sqrt(sum);
  const out: Vec = new Map();
  for (const [i, w] of v) out.set(i, w / norm);
  return out;
}

/** Cosine similarity of two normalised vectors. */
export function cosine(a: Vec, b: Vec): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [i, w] of small) {
    const x = large.get(i);
    if (x !== undefined) dot += w * x;
  }
  return dot;
}

/** The normalised mean of some vectors: the centre of a group. */
export function centroid(vectors: Vec[]): Vec {
  const sum: Vec = new Map();
  for (const v of vectors) for (const [i, w] of v) sum.set(i, (sum.get(i) ?? 0) + w);
  return normalise(sum);
}

/**
 * The vectors close to a query vector, from an inverted index, so an all-pairs comparison needn't compare every pair:
 * only vectors sharing a term are touched. The dot products are summed term by term, not as {@link cosine} sums them,
 * so they can differ from cosine in the last bits (far below 1e-9).
 */
export class Postings {
  private readonly start: Int32Array;
  private readonly ids: Int32Array;
  private readonly weights: Float64Array;
  private readonly dot: Float64Array;
  private readonly touched: Int32Array;

  constructor(vectors: Vec[]) {
    let dims = 0;
    let total = 0;
    for (const v of vectors) {
      total += v.size;
      for (const t of v.keys()) if (t >= dims) dims = t + 1;
    }
    const count = new Int32Array(dims + 1);
    for (const v of vectors) for (const t of v.keys()) count[t + 1]!++;
    for (let t = 0; t < dims; t++) count[t + 1]! += count[t]!;
    this.start = count.slice();
    this.ids = new Int32Array(total);
    this.weights = new Float64Array(total);
    const fill = count;
    vectors.forEach((v, i) => {
      for (const [t, w] of v) {
        const p = fill[t]!++;
        this.ids[p] = i;
        this.weights[p] = w;
      }
    });
    this.dot = new Float64Array(vectors.length);
    this.touched = new Int32Array(vectors.length);
  }

  /** The vectors whose dot product with v is at least min: their indexes, in index order, and the dot products. */
  near(v: Vec, min: number): { i: number; dot: number }[] {
    let n = 0;
    for (const [t, w] of v) {
      if (t + 1 >= this.start.length) continue;
      for (let p = this.start[t]!; p < this.start[t + 1]!; p++) {
        const i = this.ids[p]!;
        if (this.dot[i] === 0) this.touched[n++] = i;
        this.dot[i]! += w * this.weights[p]!;
      }
    }
    const out: { i: number; dot: number }[] = [];
    for (let k = 0; k < n; k++) {
      const i = this.touched[k]!;
      if (this.dot[i]! >= min) out.push({ i, dot: this.dot[i]! });
      this.dot[i] = 0;
    }
    return out.sort((a, b) => a.i - b.i);
  }
}

/** The number of groups for n items: about the square root of n/2, at least 1 and at most 40. */
export function chooseK(n: number): number {
  return Math.max(1, Math.min(40, Math.round(Math.sqrt(n / 2))));
}

export interface Clustering {
  /** For each vector, its group (0..k-1), or -1 for an empty vector. */
  assign: number[];
  centroids: Vec[];
}

/** Up to this many vectors, k-means runs every restart over every vector until nothing moves. */
export const KMEANS_EXACT = 3000;
/** Above it, the centres are fitted on a seeded sample of this many vectors, and every vector is then placed once. */
export const KMEANS_SAMPLE = 5000;

/**
 * Spherical k-means (cosine) with k-means++ seeding. Several seeded restarts; the tightest result wins. Empty vectors
 * are left out (group -1).
 *
 * Up to {@link KMEANS_EXACT} vectors, every restart runs over all of them until nothing moves. Above it, which a record
 * of tens of thousands of entries reaches, that took most of an hour: the centres are fitted on a seeded sample of
 * {@link KMEANS_SAMPLE}, with fewer restarts (16 at 3,000 gives 2 at 50,000), each stopping once fewer than 0.1% of the
 * sample move; then every vector goes to its nearest centre in one pass. The same vectors always give the same groups.
 */
export function kmeans(vectors: Vec[], k: number, seed = 1, restarts = 4): Clustering {
  const usable = vectors.map((v, i) => (v.size ? i : -1)).filter((i) => i >= 0);
  const kk = Math.min(k, usable.length);
  if (kk === 0) return { assign: vectors.map(() => -1), centroids: [] };
  const large = usable.length > KMEANS_EXACT;
  const fit = large ? sampleOf(usable, KMEANS_SAMPLE, mulberry32(seed * 7919 - 1)) : usable;
  const runs = large ? Math.max(2, Math.round((restarts * KMEANS_EXACT) / usable.length)) : restarts;
  const settled = large ? fit.length * 0.001 : 1;
  const space = new Centres(vectors, kk);
  let best: { score: number; assign: number[]; centroids: Vec[] } | undefined;
  for (let r = 0; r < runs; r++) {
    const assign = space.fit(fit, mulberry32(seed * 7919 + r), settled);
    const score = fit.reduce((sum, i) => sum + space.similarity(i, assign[i]!), 0);
    if (!best || score > best.score + 1e-12) best = { score, assign, centroids: space.toVecs() };
  }
  if (!large) return { assign: best!.assign, centroids: best!.centroids };
  space.load(best!.centroids);
  const assign = vectors.map(() => -1);
  space.place(usable, assign);
  space.update(usable, assign);
  return { assign, centroids: space.toVecs() };
}

/** n of these indexes, picked at random (seeded), in their first order. */
function sampleOf(indexes: number[], n: number, rand: () => number): number[] {
  if (indexes.length <= n) return indexes;
  const pool = [...indexes];
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rand() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, n).sort((a, b) => a - b);
}

/**
 * k-means's centres, held dense, and the vectors as flat arrays. Each similarity and each centre is summed exactly as
 * {@link cosine} and {@link centroid} sum them on maps, in the same order, so a result is the same to the last bit; only
 * the lookups are faster.
 */
class Centres {
  private readonly vectors: Vec[];
  private readonly k: number;
  private readonly dims: number;
  private readonly start: Int32Array;
  private readonly ids: Int32Array;
  private readonly weights: Float64Array;
  private readonly rows: Float64Array;
  /** Each centre's terms, in the order its map would hold them. */
  private readonly terms: number[][];
  private readonly seen: Int32Array;
  private stamp = 0;

  constructor(vectors: Vec[], k: number) {
    this.vectors = vectors;
    this.k = k;
    let total = 0;
    let dims = 0;
    for (const v of vectors) {
      total += v.size;
      for (const t of v.keys()) if (t >= dims) dims = t + 1;
    }
    this.dims = dims;
    this.start = new Int32Array(vectors.length + 1);
    this.ids = new Int32Array(total);
    this.weights = new Float64Array(total);
    let p = 0;
    vectors.forEach((v, i) => {
      this.start[i] = p;
      for (const [t, w] of v) {
        this.ids[p] = t;
        this.weights[p++] = w;
      }
    });
    this.start[vectors.length] = p;
    this.rows = new Float64Array(k * dims);
    this.terms = Array.from({ length: k }, () => []);
    this.seen = new Int32Array(dims);
  }

  /** cosine(vectors[i], centre j). */
  similarity(i: number, j: number): number {
    const from = this.start[i]!;
    const to = this.start[i + 1]!;
    const terms = this.terms[j]!;
    const base = j * this.dims;
    let dot = 0;
    if (to - from <= terms.length) {
      // A term the centre lacks adds w * 0, which leaves the sum as it was.
      for (let p = from; p < to; p++) dot += this.weights[p]! * this.rows[base + this.ids[p]!]!;
    } else {
      const v = this.vectors[i]!;
      for (const t of terms) {
        const x = v.get(t);
        if (x !== undefined) dot += this.rows[base + t]! * x;
      }
    }
    return dot;
  }

  /** One restart over these vectors: seeds the centres, then alternates placing and updating until it settles. */
  fit(members: number[], rand: () => number, settled: number): number[] {
    this.seed(members, rand);
    const assign = this.vectors.map(() => -1);
    for (let iter = 0; iter < 50; iter++) {
      const moved = this.place(members, assign);
      this.update(members, assign);
      if (moved < settled) break;
    }
    return assign;
  }

  /** k-means++: each new centre is picked with probability growing with its distance from the centres so far. */
  private seed(members: number[], rand: () => number): void {
    this.setVector(0, members[Math.floor(rand() * members.length)]!);
    const nearest = members.map((i) => 1 - this.similarity(i, 0));
    for (let j = 1; j < this.k; j++) {
      const weights = nearest.map((d) => d * d);
      const total = weights.reduce((a, b) => a + b, 0);
      let pick = 0;
      if (total > 0) {
        let r = rand() * total;
        while (pick < weights.length - 1 && r >= weights[pick]!) r -= weights[pick++]!;
      } else {
        pick = Math.floor(rand() * members.length);
      }
      this.setVector(j, members[pick]!);
      members.forEach((i, n) => (nearest[n] = Math.min(nearest[n]!, 1 - this.similarity(i, j))));
    }
  }

  /** Puts each vector with its nearest centre (the first, on a tie); returns how many changed group. */
  place(members: number[], assign: number[]): number {
    let moved = 0;
    for (const i of members) {
      let bestJ = 0;
      let bestSim = -Infinity;
      for (let j = 0; j < this.k; j++) {
        const s = this.similarity(i, j);
        if (s > bestSim + 1e-12) {
          bestSim = s;
          bestJ = j;
        }
      }
      if (assign[i] !== bestJ) {
        assign[i] = bestJ;
        moved++;
      }
    }
    return moved;
  }

  /** Moves each centre to the centroid of its vectors; a centre with none stays where it was. */
  update(members: number[], assign: number[]): void {
    const groups: number[][] = Array.from({ length: this.k }, () => []);
    for (const i of members) groups[assign[i]!]!.push(i);
    groups.forEach((group, j) => {
      if (!group.length) return;
      const base = this.clear(j);
      const terms = this.terms[j]!;
      this.stamp++;
      for (const i of group) {
        for (let p = this.start[i]!; p < this.start[i + 1]!; p++) {
          const t = this.ids[p]!;
          if (this.seen[t] !== this.stamp) {
            this.seen[t] = this.stamp;
            terms.push(t);
          }
          this.rows[base + t]! += this.weights[p]!;
        }
      }
      let sum = 0;
      for (const t of terms) sum += this.rows[base + t]! * this.rows[base + t]!;
      if (sum === 0) return;
      const norm = Math.sqrt(sum);
      for (const t of terms) this.rows[base + t] = this.rows[base + t]! / norm;
    });
  }

  /** The centres as maps, as centroid() makes them. */
  toVecs(): Vec[] {
    return this.terms.map((terms, j) => new Map(terms.map((t) => [t, this.rows[j * this.dims + t]!])));
  }

  /** Sets the centres from maps. */
  load(centres: Vec[]): void {
    centres.forEach((c, j) => {
      const base = this.clear(j);
      for (const [t, w] of c) {
        this.terms[j]!.push(t);
        this.rows[base + t] = w;
      }
    });
  }

  private setVector(j: number, i: number): void {
    const base = this.clear(j);
    for (let p = this.start[i]!; p < this.start[i + 1]!; p++) {
      this.terms[j]!.push(this.ids[p]!);
      this.rows[base + this.ids[p]!] = this.weights[p]!;
    }
  }

  /** Empties centre j; returns where its row starts. */
  private clear(j: number): number {
    const base = j * this.dims;
    for (const t of this.terms[j]!) this.rows[base + t] = 0;
    this.terms[j] = [];
    return base;
  }
}

/**
 * The terms that set a group apart: its mean weight minus the record's mean weight, highest first. Returns term
 * indexes.
 */
export function distinctiveTerms(index: TermIndex, members: Vec[], n: number): number[] {
  const sum = new Map<number, number>();
  for (const v of members) for (const [i, w] of v) sum.set(i, (sum.get(i) ?? 0) + w);
  const size = Math.max(1, members.length);
  return [...sum]
    .map(([i, w]) => [i, w / size - index.mean[i]!] as const)
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, n)
    .map(([i]) => i);
}

/** The highest-weighted terms of one vector (keywords of one text). Returns term indexes. */
export function topTerms(v: Vec, n: number): number[] {
  return [...v]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, n)
    .map(([i]) => i);
}

export interface Candidate {
  vector: Vec;
}

/**
 * Picks up to n candidates close to a target and unlike each other (maximal marginal relevance). Returns their
 * positions in the order picked.
 */
export function pickDiverse(candidates: Candidate[], target: Vec, n: number, lambda = 0.7): number[] {
  const chosen: number[] = [];
  const relevance = candidates.map((c) => cosine(c.vector, target));
  while (chosen.length < Math.min(n, candidates.length)) {
    let best = -1;
    let bestScore = -Infinity;
    candidates.forEach((c, i) => {
      if (chosen.includes(i) || !c.vector.size) return;
      const overlap = chosen.reduce((m, j) => Math.max(m, cosine(c.vector, candidates[j]!.vector)), 0);
      const score = lambda * relevance[i]! - (1 - lambda) * overlap;
      if (score > bestScore + 1e-12) {
        bestScore = score;
        best = i;
      }
    });
    if (best < 0) break;
    chosen.push(best);
  }
  return chosen;
}

/** An extractive summary: the n sentences of a text closest to its own centre, in their original order. */
export function summarize(index: TermIndex, text: string, n: number): string[] {
  const list = sentences(text);
  if (list.length <= n) return list;
  const candidates = list.map((s) => ({ vector: vectorize(index, s) }));
  const target = centroid(candidates.map((c) => c.vector));
  return pickDiverse(candidates, target, n)
    .sort((a, b) => a - b)
    .map((i) => list[i]!);
}
