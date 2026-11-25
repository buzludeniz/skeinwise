import type { EntryInput } from '../store/store.ts';
import { firstLine } from './util.ts';

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

  const metaDate = [meta.created, meta.date].find((v): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v)));
  const nameDate = DATE_IN_NAME.exec(baseName);
  const createdAt = metaDate
    ? new Date(metaDate).toISOString()
    : nameDate
      ? new Date(`${nameDate[1]}-${nameDate[2]}-${nameDate[3]}T09:00:00Z`).toISOString()
      : modifiedAt.toISOString();

  const metaTags = meta.tags;
  const tags = new Set<string>(
    (Array.isArray(metaTags) ? metaTags : typeof metaTags === 'string' ? metaTags.split(/[,\s]+/) : [])
      .map((t) => t.replace(/^#/, '').toLowerCase())
      .filter(Boolean),
  );
  // Inline #tags: a # at the start or after whitespace, not a heading, not inside a word.
  for (const m of body.matchAll(/(?:^|\s)#([\p{L}][\p{L}\p{N}_/-]*)/gu)) tags.add(m[1]!.toLowerCase());
  const links = [...new Set([...body.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)].map((m) => m[1]!.trim()))];

  return { title, body: body.trim(), createdAt, tags: [...tags], links, meta };
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
