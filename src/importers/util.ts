/** Small, forgiving readers for loosely typed export JSON. */

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

/** Accepts Unix seconds, Unix milliseconds or a date string. Returns ISO 8601 UTC, or undefined. */
export function toIso(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const ms = v > 1e12 ? v : v * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof v === 'string' && v) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  return undefined;
}

export function firstLine(text: string, max = 80): string {
  const line = text.split('\n').find((l) => l.trim())?.trim() ?? '';
  const clean = line.replace(/^#+\s*/, '');
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d|pre|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#?\w+);/g, (m, name: string) => {
      if (ENTITIES[name]) return ENTITIES[name];
      if (name.startsWith('#x')) return String.fromCodePoint(parseInt(name.slice(2), 16));
      if (name.startsWith('#')) return String.fromCodePoint(parseInt(name.slice(1), 10));
      return m;
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
  const out: Obj[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as unknown;
      if (isObj(v)) out.push(v);
    } catch {
      // A torn last line in a live history file is normal; skip it.
    }
  }
  return out;
}
