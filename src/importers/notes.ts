import type { EntryInput } from '../store/store.ts';
import { firstLine, toIso } from './util.ts';

export interface ParsedNote {
  title: string;
  body: string;
  createdAt: string;
  tags: string[];
  links: string[];
  meta: Record<string, string | string[]>;
}

/** A small YAML front matter reader: `key: value`, `key: [a, b]` and `key:` followed by `- item` lines. */
export function parseFrontMatter(text: string): { meta: Record<string, string | string[]>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { meta: {}, body: text };
  const meta: Record<string, string | string[]> = {};
  let listKey: string | undefined;
  for (const raw of match[1]!.split(/\r?\n/)) {
    const item = /^\s*-\s+(.*)$/.exec(raw);
    if (item && listKey) {
      const list = meta[listKey];
      const value = unquote(item[1]!);
      meta[listKey] = Array.isArray(list) ? [...list, value] : [value];
      continue;
    }
    const kv = /^([\w-]+)\s*:\s*(.*)$/.exec(raw);
    if (!kv) continue;
    const key = kv[1]!.toLowerCase();
    const value = kv[2]!.trim();
    listKey = undefined;
    if (!value) {
      listKey = key;
      meta[key] = [];
    } else if (value.startsWith('[') && value.endsWith(']')) {
      meta[key] = value
        .slice(1, -1)
        .split(',')
        .map((v) => unquote(v.trim()))
        .filter(Boolean);
    } else {
      meta[key] = unquote(value);
    }
  }
  return { meta, body: text.slice(match[0].length) };
}

function unquote(v: string): string {
  return v.replace(/^["']|["']$/g, '');
}

const DATE_IN_NAME = /(\d{4})-(\d{2})-(\d{2})/;

export function parseNote(fileName: string, text: string, modifiedAt: Date): ParsedNote {
  const { meta, body } = parseFrontMatter(text);
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const baseName = fileName.replace(/\.(md|markdown|txt)$/i, '');
  const metaTitle = typeof meta.title === 'string' ? meta.title : undefined;
  const title = metaTitle || heading || baseName || firstLine(body);

  // The front matter's date, else a real date in the name ("Meeting 2023-14-02" has none), else the file's.
  const metaDate = [meta.created, meta.date].map(toIso).find(Boolean);
  const nameDate = DATE_IN_NAME.exec(baseName);
  const createdAt = metaDate ?? (nameDate && toIso(`${nameDate[1]}-${nameDate[2]}-${nameDate[3]}T09:00:00Z`)) ?? modifiedAt.toISOString();

  const metaTags = meta.tags;
  const tags = new Set<string>(
    (Array.isArray(metaTags) ? metaTags : typeof metaTags === 'string' ? metaTags.split(/[,\s]+/) : [])
      .map((t) => t.replace(/^#/, '').toLowerCase())
      .filter(Boolean),
  );
  // Inline #tags: a # at the start or after whitespace, not a heading, not inside a word.
  for (const m of body.matchAll(/(?:^|\s)#([\p{L}][\p{L}\p{N}_/-]*)/gu)) tags.add(m[1]!.toLowerCase());
  const links = [...new Set(wikiLinks(body))];

  return { title, body: body.trim(), createdAt, tags: [...tags], links, meta };
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
  };
}
