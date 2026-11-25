/** Small, forgiving readers for loosely typed export JSON. */
import { safeLine } from '../safe-text.ts';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Obj = { [key: string]: unknown };

export function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** The furthest a Date reaches either side of 1970, in milliseconds. */
const MAX_DATE_MS = 8.64e15;

/**
 * Accepts Unix seconds, Unix milliseconds or a date string. Returns ISO 8601 UTC, or undefined for anything that
 * isn't a time, including a number too big for one (nanoseconds): it never throws.
 */
export function toIso(v: unknown): string | undefined {
  let ms: number;
  if (typeof v === 'number') ms = v > 1e12 ? v : v * 1000;
  else if (typeof v === 'string' && v) ms = Date.parse(v);
  else return undefined;
  return Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS ? new Date(ms).toISOString() : undefined;
}

/** A time an export claims: '' when it gives none, undefined when it gives one that isn't a time. */
export function claimedTime(v: unknown): string | undefined {
  return v === undefined || v === null || v === '' ? '' : toIso(v);
}

/** How many problems one file names before it only counts them. */
const NAMED = 20;

/**
 * What a parser skipped in one file, or kept without its time. The first few are named with their position, then they
 * are counted, so an export with thousands of odd values still says something short. Everything it quotes comes from
 * the file, so it goes through safeLine.
 */
export class FileReport {
  /** The path as the person would know it: relative to the folder or zip they named. */
  readonly file: string;
  skipped = 0;
  untimed = 0;
  private named = 0;
  private readonly warn: (message: string) => void;

  constructor(file: string, warn: (message: string) => void = () => {}) {
    this.file = file;
    this.warn = warn;
  }

  /** Parses one entry (or one conversation). If it throws, that one is skipped and named, and the file goes on. */
  each<T>(at: string, parse: () => T, what = 'entry'): T | undefined {
    try {
      return parse();
    } catch (error) {
      this.skip(at, error instanceof Error ? error.message : String(error), what);
      return undefined;
    }
  }

  skip(at: string, reason: string, what = 'entry'): void {
    this.skipped++;
    this.tell(`skipped 1 ${what} in ${this.where(at)}: ${safeLine(reason)}`);
  }

  /** A time that can't be read: the entry is kept, with `fallback` or, failing that, sorted by when it was first seen. */
  time(at: string, value: unknown, fallback: string): void {
    this.untimed++;
    this.tell(`${this.where(at)}: ${quote(value)} is not a time; kept the entry with ${fallback || 'no time'}`);
  }

  /** Once the file is done: how many there were past the ones named. */
  done(): void {
    const more = this.skipped + this.untimed - this.named;
    if (more > 0) {
      this.warn(`${safeLine(this.file)}: ${more} more like that (${this.skipped} skipped, ${this.untimed} kept without their time)`);
    }
  }

  private where(at: string): string {
    return at ? `${safeLine(this.file)}:${at}` : safeLine(this.file);
  }

  private tell(message: string): void {
    if (this.named >= NAMED) return;
    this.named++;
    this.warn(message);
  }
}

function quote(value: unknown): string {
  const text = typeof value === 'string' ? JSON.stringify(value) : String(value);
  return safeLine(text.length > 40 ? `${text.slice(0, 39)}…` : text);
}

export function firstLine(text: string, max = 80): string {
  const line = text.split('\n').find((l) => l.trim())?.trim() ?? '';
  const clean = line.replace(/^#+\s*/, '');
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/**
 * Plain text out of reply HTML: line breaks for <br> and block ends, "- " for list items, other tags dropped, entities
 * decoded. Linear in the length of the HTML: `/<li[^>]*>/` and `/<[^>]+>/` rescan to the end from every "<" that has
 * no ">" after it, which took 69 s on 200,000 of them (PoC 11), so those two steps are scanners. Each step still runs
 * over the previous one's output, as the regexes did, so the text comes out the same.
 */
export function stripHtml(html: string): string {
  const breaks = html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d|pre|tr)>/gi, '\n');
  return dropTags(listItems(breaks))
    .replace(/&(#?\w+);/g, (m, name: string) => entity(name) ?? m)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** `.replace(/<li[^>]*>/gi, '- ')` in one pass. (Not by lower-casing the text: that can change its length.) */
function listItems(text: string): string {
  let out = '';
  let from = 0;
  let at = text.indexOf('<');
  while (at >= 0) {
    if ((text[at + 1] === 'l' || text[at + 1] === 'L') && (text[at + 2] === 'i' || text[at + 2] === 'I')) {
      const end = text.indexOf('>', at + 3);
      // No ">" after this "<li" means none after any later one either.
      if (end < 0) break;
      out += `${text.slice(from, at)}- `;
      from = end + 1;
      at = text.indexOf('<', from);
    } else {
      at = text.indexOf('<', at + 1);
    }
  }
  return out + text.slice(from);
}

/** `.replace(/<[^>]+>/g, '')` in one pass. */
function dropTags(text: string): string {
  let out = '';
  let from = 0;
  let at = text.indexOf('<');
  while (at >= 0) {
    const end = text.indexOf('>', at + 1);
    if (end < 0) break;
    if (end === at + 1) {
      // "<>" is not a tag; the next "<" may start one.
      at = text.indexOf('<', at + 1);
      continue;
    }
    out += text.slice(from, at);
    from = end + 1;
    at = text.indexOf('<', from);
  }
  return out + text.slice(from);
}

/** The character an entity name stands for, or undefined when it stands for none (`&#x;`, `&#99999999;`). */
export function entity(name: string): string | undefined {
  if (ENTITIES[name]) return ENTITIES[name];
  const code = /^#x[0-9a-f]{1,6}$/i.test(name) ? parseInt(name.slice(2), 16) : /^#\d{1,7}$/.test(name) ? parseInt(name.slice(1), 10) : NaN;
  // Not NUL, not past Unicode, not half a surrogate pair.
  return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : undefined;
}

/** Text out of a content field that is a string or a list of { type, text } blocks. */
export function blockText(content: unknown, types: readonly string[] = ['text']): string {
  if (typeof content === 'string') return content;
  return asArray(content)
    .filter((b): b is Obj => isObj(b) && types.includes(String(b.type)))
    .map((b) => str(b.text) ?? '')
    .filter(Boolean)
    .join('\n\n');
}

/** Parses JSON Lines, skipping lines that don't parse. */
export function parseJsonl(text: string): Obj[] {
  return parseJsonlLines(text).map((l) => l.value);
}

/** As parseJsonl, with each object's line number (from 1) for warnings. */
export function parseJsonlLines(text: string): { line: number; value: Obj }[] {
  const out: { line: number; value: Obj }[] = [];
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const v = JSON.parse(line) as unknown;
      if (isObj(v)) out.push({ line: i + 1, value: v });
    } catch {
      // A torn last line in a live history file is normal; skip it.
    }
  });
  return out;
}
