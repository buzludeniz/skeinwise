import type { EntryInput } from '../store/store.ts';
import { withoutNoteExt } from './note-ext.ts';
import { firstLine, toIso } from './util.ts';

export interface ParsedNote {
  title: string;
  body: string;
  createdAt: string;
  tags: string[];
  links: string[];
  /** Front matter by lower-cased key, for the fields Skeinwise reads itself (title, created, date, tags, agent). */
  meta: Record<string, string | string[]>;
  /** The same front matter under its keys as written: kept with the note as its properties. */
  properties: Record<string, string | string[]>;
}

export interface FrontMatter {
  meta: Record<string, string | string[]>;
  properties: Record<string, string | string[]>;
  body: string;
}

/**
 * The block between a `---` first line and the next `---` (or `...`) line. The lazy middle has nothing after it to
 * retry, so a block that never closes costs one pass, not one per line.
 */
const FRONT_MATTER = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/**
 * A small YAML front matter reader (no dependency): `key: value`, `key: [a, b]`, `key:` followed by `- item` lines,
 * and `key: |` or `key: >` followed by indented lines. Nested maps are skipped. Values stay strings, so nothing is
 * lost or reinterpreted (`007` stays `007`). A byte order mark before the opening `---` is ignored.
 */
export function parseFrontMatter(text: string): FrontMatter {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  // No prototype: a key such as `__proto__` is just a key.
  const meta = Object.create(null) as Record<string, string | string[]>;
  const properties = Object.create(null) as Record<string, string | string[]>;
  const match = FRONT_MATTER.exec(src);
  if (!match) return { meta, properties, body: src };
  const set = (key: string, value: string | string[]) => {
    properties[key] = value;
    meta[key.toLowerCase()] = value;
  };
  const lines = (match[1] ?? '').split(/\r?\n/);
  let listKey: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const item = listKey === undefined ? null : /^\s*-(?:\s+(.*))?$/.exec(raw);
    if (item && listKey !== undefined) {
      const value = unquote((item[1] ?? '').trim());
      const list = properties[listKey];
      // Pushed in place (meta holds the same array): copying it per item made a long list quadratic.
      if (Array.isArray(list)) list.push(value);
      else set(listKey, [value]);
      continue;
    }
    const kv = keyValue(raw);
    if (!kv) continue;
    const [key, value] = kv;
    listKey = undefined;
    if (!value) {
      // A list may follow; until it does the value is empty.
      listKey = key;
      set(key, '');
    } else if (/^[|>][+-]?$/.test(value)) {
      const block: string[] = [];
      let indent = -1;
      while (i + 1 < lines.length && (/^[ \t]/.test(lines[i + 1]!) || !lines[i + 1]!.trim())) {
        const line = lines[++i]!;
        if (indent < 0 && line.trim()) indent = line.length - line.trimStart().length;
        block.push(line.slice(Math.max(0, Math.min(indent, line.length - line.trimStart().length))));
      }
      set(key, value.startsWith('|') ? block.join('\n').trimEnd() : block.map((l) => l.trim()).filter(Boolean).join(' '));
    } else if (value.startsWith('[') && value.endsWith(']')) {
      set(
        key,
        value
          .slice(1, -1)
          .split(',')
          .map((v) => unquote(v.trim()))
          .filter(Boolean),
      );
    } else {
      set(key, unquote(value));
    }
  }
  return { meta, properties, body: src.slice(match[0].length) };
}

/**
 * `key: value` (the key runs to the first colon followed by a space, a tab or the end of the line), or null for an
 * indented line, a comment or a list item. A plain scan: a long line without such a colon is read once.
 */
function keyValue(line: string): [string, string] | null {
  const lead = line.charCodeAt(0);
  if (!line || lead === 0x20 || lead === 0x09 || lead === 0x23 /* # */ || lead === 0x2d /* - */) return null;
  const first = line.indexOf(':');
  let at = first;
  while (at >= 0 && at + 1 < line.length && line[at + 1] !== ' ' && line[at + 1] !== '\t') at = line.indexOf(':', at + 1);
  // `key:value` with no space isn't YAML, but earlier versions read it, so a plain key still counts.
  if (at < 0 && first > 0 && /^[\w-]+$/.test(line.slice(0, first))) at = first;
  if (at <= 0) return null;
  const key = unquote(line.slice(0, at).trim());
  return key ? [key, line.slice(at + 1).trim()] : null;
}

/** A YAML scalar without its quotes: "…" with JSON's escapes, '…' with '' for a quote. */
function unquote(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(v);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // Not JSON's escapes: the text between the quotes, as written.
    }
    return v.slice(1, -1);
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replaceAll("''", "'");
  return v;
}

const DATE_IN_NAME = /(\d{4})-(\d{2})-(\d{2})/;

export function parseNote(fileName: string, text: string, modifiedAt: Date): ParsedNote {
  const { meta, properties, body } = parseFrontMatter(text);
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const baseName = withoutNoteExt(fileName);
  const metaTitle = typeof meta.title === 'string' ? meta.title : undefined;
  const title = metaTitle || heading || baseName || firstLine(body);

  // The front matter's date, else a real date in the name ("Meeting 2023-14-02" has none), else the file's.
  const metaDate = [meta.created, meta.date].map(toIso).find(Boolean);
  const nameDate = DATE_IN_NAME.exec(baseName);
  const createdAt = metaDate ?? (nameDate && toIso(`${nameDate[1]}-${nameDate[2]}-${nameDate[3]}T09:00:00Z`)) ?? modifiedAt.toISOString();

  // Obsidian reads `tags`, and `tag` from older vaults; both merge with the inline #tags.
  const metaTags = meta.tags ?? meta.tag;
  const tags = new Set<string>(
    (Array.isArray(metaTags) ? metaTags : typeof metaTags === 'string' ? metaTags.split(/[,\s]+/) : [])
      .map((t) => t.replace(/^#/, '').toLowerCase())
      .filter(Boolean),
  );
  // Inline #tags: a # at the start or after whitespace, not a heading, not inside a word.
  for (const m of body.matchAll(/(?:^|\s)#([\p{L}][\p{L}\p{N}_/-]*)/gu)) tags.add(m[1]!.toLowerCase());
  const links = [...new Set(wikiLinks(body))];

  return { title, body: body.trim(), createdAt, tags: [...tags], links, meta, properties };
}

const STOP = new Set([']', '|', '#']);

/**
 * The targets of [[wiki links]] ([[target]], [[target|alias]], [[target#heading]]), in order, in one pass. It finds
 * exactly what `/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g` found, trimmed. That regex rescanned to the end from every "[["
 * that never closed: 76 s on 200,000 "[" (PoC 11). From a given "[[" the match is fixed (the target runs to the first
 * "]", "|" or "#", an alias or heading to the first "]"), and both of those "first" positions only move forward as the
 * scan does, so each is found once and reused.
 */
export function wikiLinks(body: string): string[] {
  const links: string[] = [];
  const n = body.length;
  let stop = -1; // the first "]", "|" or "#" at or after the last place asked about
  let close = -1; // the first "]" at or after the last place asked about
  const stopFrom = (from: number) => {
    if (stop < from) for (stop = from; stop < n && !STOP.has(body[stop]!); stop++);
    return stop;
  };
  const closeFrom = (from: number) => {
    if (close < from) {
      close = body.indexOf(']', from);
      if (close < 0) close = n;
    }
    return close;
  };
  let at = body.indexOf('[[');
  while (at >= 0) {
    const target = stopFrom(at + 2);
    let end = -1;
    if (target > at + 2 && target < n) {
      const last = body[target] === ']' ? target : closeFrom(target + 1);
      if (last < n && body[last + 1] === ']') end = last + 2;
    }
    if (end < 0) {
      at = body.indexOf('[[', at + 1);
      continue;
    }
    links.push(body.slice(at + 2, target).trim());
    at = body.indexOf('[[', end);
  }
  return links;
}

export function noteEntry(relativePath: string, note: ParsedNote): EntryInput {
  return {
    externalId: relativePath,
    kind: 'note',
    speaker: 'you',
    title: note.title,
    createdAt: note.createdAt,
    body: note.body,
    // The front matter as written (LS-19); null when the note has none.
    properties: Object.keys(note.properties).length ? note.properties : null,
  };
}
