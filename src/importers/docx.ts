// A Word document (.docx) read as a note, on this machine, with no new dependency.
//
// The file is a zip, opened through the safe reader (src/fsafe.ts), which refuses links and non-files, reads the
// central directory before inflating anything, and counts the bytes it really inflates against what each entry
// declared. On top of that a .docx has its own, tighter limits, all checked before an entry is inflated:
//
// - at most DOCX_MAX_ENTRIES entries and DOCX_MAX_FILE_BYTES on disk;
// - each XML part at most DOCX_MAX_PART_BYTES unpacked, and a part past DOCX_RATIO_FLOOR may not unpack to more than
//   DOCX_MAX_RATIO times its packed size;
// - the parts read come to at most DOCX_MAX_TOTAL_BYTES, counted as they are inflated;
// - an entry whose name climbs out of the package (`..`, an absolute path, a drive letter) refuses the whole file, and
//   so does a part listed twice;
// - the text it yields is capped like any note (TEXT_MAX_BYTES).
//
// The XML goes through scanXml (src/importers/xml.ts): one linear pass, no DTD and no entities. Only the document's
// text is kept: paragraphs, headings (as `#`), list items (as `-`), tables (as Markdown rows), text boxes once.
// Deleted revisions, field codes and Word's fallback copies of drawings are left out. Footnotes, comments, headers and
// footers aren't read in 1.0.

import { basename, extname } from 'node:path';
import { openZipSafe, UnsafeFileError, type SafeOptions, type SafeZip, type ZipEntry } from '../fsafe.ts';
import { decodeText, TEXT_MAX_BYTES } from './text.ts';
import { toIso } from './util.ts';
import { scanXml, XmlError, type XmlAttrs, type XmlHandler } from './xml.ts';

export const DOCX_MAX_FILE_BYTES = 256 * 1024 ** 2;
export const DOCX_MAX_ENTRIES = 10_000;
export const DOCX_MAX_PART_BYTES = 64 * 1024 ** 2;
export const DOCX_MAX_TOTAL_BYTES = 128 * 1024 ** 2;
export const DOCX_MAX_RATIO = 200;
/** Below this many unpacked bytes a part can't hurt, whatever its ratio. */
export const DOCX_RATIO_FLOOR = 8 * 1024 ** 2;

const W_MAIN = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main']);

export interface DocxDocument {
  path: string;
  sha256: string;
  mtime: Date;
  /** The title in the document's properties, else its first heading; null when it has neither. */
  title: string | null;
  /** When the document's properties say it was created (ISO 8601), or null. */
  createdAt: string | null;
  /** The text as Markdown. */
  body: string;
}

function refuse(label: string, why: string): UnsafeFileError {
  return new UnsafeFileError(label, 'zip', `${label}: refused, ${why}`);
}

function mib(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MiB`;
}

/** A name that leads outside the package once unpacked: `..`, an absolute path, a drive letter, a NUL. */
export function climbsOut(name: string): boolean {
  if (name.includes('\0') || name.startsWith('/') || name.startsWith('\\') || /^[A-Za-z]:/.test(name)) return true;
  return name.split(/[\\/]/).includes('..');
}

/** The parts worth inflating: the package's relationships and XML one folder deep (word/*.xml, docProps/*.xml). */
function wanted(name: string): boolean {
  return name === '_rels/.rels' || /^[^/\\]+\/[^/\\]+\.xml$/i.test(name);
}

/** A relationship target as a part name inside the package, or null when it points outside it. */
function partName(target: string): string | null {
  const parts: string[] = [];
  for (const seg of target.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
}

/** The prefix bound to `uris` on the root element ('' for the default namespace), or null. */
function prefixFor(attrs: XmlAttrs, uris: Set<string>): string | null {
  for (const key of Object.keys(attrs)) {
    if (!uris.has(attrs[key]!)) continue;
    if (key === 'xmlns') return '';
    if (key.startsWith('xmlns:')) return key.slice(6);
  }
  return null;
}

function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon < 0 ? name : name.slice(colon + 1);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function int(value: string | undefined): number | null {
  if (value === undefined || !/^\d{1,3}$/.test(value)) return null;
  return Number(value);
}

// ---------- Package parts ----------

interface Rels {
  main: string | null;
  core: string | null;
}

function readRels(xml: string): Rels {
  const rels: Rels = { main: null, core: null };
  scanXml(xml, {
    open(name, attrs) {
      if (localName(name) !== 'Relationship' || attrs.TargetMode === 'External') return;
      const type = attrs.Type ?? '';
      const target = attrs.Target ?? '';
      if (type.endsWith('/officeDocument') && rels.main === null) rels.main = partName(target) ?? '';
      if (type.endsWith('/core-properties') && rels.core === null) rels.core = partName(target) ?? '';
    },
    close() {},
    text() {},
  });
  return rels;
}

/** The title and created time in docProps/core.xml (Dublin Core), read by local name. */
function readCore(xml: string): { title: string | null; created: string | null } {
  let depth = 0;
  let field: 'title' | 'created' | null = null;
  const found = { title: '', created: '' };
  const seen = new Set<string>();
  scanXml(xml, {
    open(name) {
      depth++;
      const local = localName(name);
      field = depth === 2 && (local === 'title' || local === 'created') && !seen.has(local) ? local : null;
    },
    close(name) {
      if (depth === 2 && field === localName(name)) seen.add(field);
      field = null;
      depth--;
    },
    text(text) {
      if (field && found[field].length < 4096) found[field] += text;
    },
  });
  const title = oneLine(found.title).slice(0, 300);
  return { title: title || null, created: toIso(found.created.trim()) ?? null };
}

/** Paragraph styles to heading levels (0 for none), from word/styles.xml, following `basedOn` a few steps. */
function readStyles(xml: string | null): (styleId: string) => number {
  const builtIn = (id: string) => {
    const m = /^heading([1-9])$/i.exec(id);
    return m ? Number(m[1]) : /^title$/i.test(id) ? 1 : 0;
  };
  if (xml === null) return builtIn;
  interface Style {
    name: string | null;
    outline: number | null;
    basedOn: string | null;
  }
  const styles = new Map<string, Style>();
  let p: string | null = null;
  let current: Style | null = null;
  let currentId = '';
  let skip = 0;
  scanXml(xml, {
    open(name, attrs) {
      if (skip) return void skip++;
      if (p === null) p = prefixFor(attrs, W_MAIN) ?? 'w';
      const local = p && !name.startsWith(`${p}:`) ? null : localName(name);
      const val = attrs[p ? `${p}:val` : 'val'];
      if (local === 'pPrChange' || local === 'rPrChange') return void (skip = 1);
      if (local === 'style') {
        const type = attrs[p ? `${p}:type` : 'type'];
        current = type === undefined || type === 'paragraph' ? { name: null, outline: null, basedOn: null } : null;
        currentId = attrs[p ? `${p}:styleId` : 'styleId'] ?? '';
      } else if (current && local === 'name') current.name = val ?? null;
      else if (current && local === 'basedOn') current.basedOn = val ?? null;
      else if (current && local === 'outlineLvl') current.outline = int(val);
    },
    close(name) {
      if (skip) return void skip--;
      if (localName(name) === 'style' && current) {
        if (currentId && !styles.has(currentId)) styles.set(currentId, current);
        current = null;
      }
    },
    text() {},
  });
  return (id) => {
    let at: string | null = id;
    for (let steps = 0; at !== null && steps < 10; steps++) {
      const s = styles.get(at);
      if (!s) return builtIn(at);
      const named = s.name ? /^heading ([1-9])$/i.exec(s.name) : null;
      if (named) return Math.min(Number(named[1]), 6);
      if (s.name && /^title$/i.test(s.name)) return 1;
      if (s.outline !== null && s.outline <= 8) return Math.min(s.outline + 1, 6);
      at = s.basedOn;
    }
    return 0;
  };
}

// ---------- The document's text ----------

/** Elements whose content isn't the document's current text: deletions, field codes, earlier formatting. */
const SKIP = new Set([
  'del',
  'delText',
  'delInstrText',
  'instrText',
  'moveFrom',
  'pPrChange',
  'rPrChange',
  'sectPrChange',
  'tblPrChange',
  'tblPrExChange',
  'tcPrChange',
  'trPrChange',
  'tblGridChange',
  'numberingChange',
]);

interface Paragraph {
  parts: string[];
  style: string | null;
  outline: number | null;
  list: number | null;
}

interface Table {
  rows: string[][];
  row: string[] | null;
  cell: string[] | null;
}

type Block = { kind: 'p' | 'li' | 'table'; text: string };

class TooLong extends Error {}

function renderTable(rows: string[][]): string | null {
  const kept = rows.filter((r) => r.some((c) => c));
  if (!kept.length) return null;
  let width = 0;
  for (const r of kept) if (r.length > width) width = r.length;
  const line = (r: string[]) => {
    const cells: string[] = [];
    for (let i = 0; i < width; i++) cells.push((r[i] ?? '').replace(/\|/g, '\\|'));
    return `| ${cells.join(' | ')} |`;
  };
  const lines = [line(kept[0]!), `|${' --- |'.repeat(width)}`];
  for (let i = 1; i < kept.length; i++) lines.push(line(kept[i]!));
  return lines.join('\n');
}

/** The body of word/document.xml as Markdown, and its first heading. */
export function documentText(xml: string, headingOf: (styleId: string) => number, maxChars = TEXT_MAX_BYTES): { body: string; heading: string | null } {
  let p: string | null = null;
  let skip = 0;
  let runs = 0;
  let inT = 0;
  let inPPr = 0;
  let chars = 0;
  let num: { level: number; id: string | null } | null = null;
  let heading: string | null = null;
  const paras: Paragraph[] = [];
  const tables: Table[] = [];
  const blocks: Block[] = [];

  const top = () => paras[paras.length - 1];
  const add = (text: string) => {
    const para = top();
    if (!para) return;
    chars += text.length;
    if (chars > maxChars) throw new TooLong();
    para.parts.push(text);
  };
  const val = (attrs: XmlAttrs) => attrs[p ? `${p}:val` : 'val'];
  const local = (name: string): string | null => {
    if (p === '') return name.includes(':') ? null : name;
    return name.startsWith(`${p}:`) ? name.slice(p!.length + 1) : null;
  };

  const endParagraph = (para: Paragraph) => {
    const text = para.parts.join('').trim();
    if (!text) return;
    const table = tables[tables.length - 1];
    if (table?.cell) {
      table.cell.push(oneLine(text));
      return;
    }
    const level = para.outline !== null && para.outline <= 8 ? Math.min(para.outline + 1, 6) : para.style ? headingOf(para.style) : 0;
    if (level > 0) {
      const line = oneLine(text);
      heading ??= line;
      blocks.push({ kind: 'p', text: `${'#'.repeat(level)} ${line}` });
    } else if (para.list !== null) {
      blocks.push({ kind: 'li', text: `${'  '.repeat(Math.min(para.list, 8))}- ${oneLine(text)}` });
    } else {
      blocks.push({ kind: 'p', text });
    }
  };

  const handler: XmlHandler = {
    open(name, attrs) {
      if (skip) return void skip++;
      if (p === null) {
        p = prefixFor(attrs, W_MAIN);
        if (p === null) throw new XmlError('it is not a Word document body (no WordprocessingML namespace)');
      }
      if (localName(name) === 'Fallback' && name !== `${p}:Fallback`) return void (skip = 1);
      const l = local(name);
      if (l === null) return;
      if (SKIP.has(l)) return void (skip = 1);
      const para = top();
      switch (l) {
        case 'p':
          paras.push({ parts: [], style: null, outline: null, list: null });
          break;
        case 'pPr':
          inPPr++;
          break;
        case 'pStyle':
          if (inPPr && para) para.style = val(attrs) ?? null;
          break;
        case 'outlineLvl':
          if (inPPr && para) para.outline = int(val(attrs));
          break;
        case 'numPr':
          if (inPPr && para) num = { level: 0, id: null };
          break;
        case 'ilvl':
          if (num) num.level = int(val(attrs)) ?? 0;
          break;
        case 'numId':
          if (num) num.id = val(attrs) ?? null;
          break;
        case 'r':
          runs++;
          break;
        case 't':
          if (runs) inT++;
          break;
        case 'tab':
          if (runs && !inPPr) add('\t');
          break;
        case 'br':
        case 'cr':
          if (runs && !inPPr) add('\n');
          break;
        case 'noBreakHyphen':
          if (runs && !inPPr) add('-');
          break;
        case 'tbl':
          tables.push({ rows: [], row: null, cell: null });
          break;
        case 'tr': {
          const table = tables[tables.length - 1];
          if (table) table.row = [];
          break;
        }
        case 'tc': {
          const table = tables[tables.length - 1];
          if (table) table.cell = [];
          break;
        }
      }
    },
    close(name) {
      if (skip) return void skip--;
      const l = local(name);
      if (l === null) return;
      switch (l) {
        case 'p': {
          const para = paras.pop();
          if (para) endParagraph(para);
          break;
        }
        case 'pPr':
          if (inPPr) inPPr--;
          break;
        case 'numPr': {
          const para = top();
          if (num && para && num.id !== '0') para.list = num.level;
          num = null;
          break;
        }
        case 'r':
          if (runs) runs--;
          break;
        case 't':
          if (inT) inT--;
          break;
        case 'tc': {
          const table = tables[tables.length - 1];
          if (table) {
            table.row ??= [];
            table.row.push(table.cell?.join(' ') ?? '');
            table.cell = null;
          }
          break;
        }
        case 'tr': {
          const table = tables[tables.length - 1];
          if (table?.row) table.rows.push(table.row);
          if (table) table.row = null;
          break;
        }
        case 'tbl': {
          const table = tables.pop();
          if (!table) break;
          const outer = tables[tables.length - 1];
          if (outer?.cell) {
            // A table inside a cell: its rows, flattened into the outer cell.
            const flat = table.rows
              .map((r) => r.filter(Boolean).join(' '))
              .filter(Boolean)
              .join(' / ');
            if (flat) outer.cell.push(flat);
          } else {
            const text = renderTable(table.rows);
            if (text) blocks.push({ kind: 'table', text });
          }
          break;
        }
      }
    },
    text(text) {
      if (!skip && inT) add(text);
    },
  };

  scanXml(xml, handler);
  const out: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (i) out.push(b.kind === 'li' && blocks[i - 1]!.kind === 'li' ? '\n' : '\n\n');
    out.push(b.text);
  }
  const body = out.join('');
  if (body.length > maxChars) throw new TooLong();
  return { body, heading };
}

// ---------- The file ----------

/**
 * Reads a .docx through the safe reader and its own limits. Throws UnsafeFileError, naming the file and the reason,
 * when the file is refused or damaged, so an importer skips it alone.
 */
export function readDocx(path: string, options: SafeOptions = {}): DocxDocument {
  const unsafe: string[] = [];
  const zip: SafeZip = openZipSafe(path, {
    ...options,
    maxBytes: Math.min(options.maxBytes ?? DOCX_MAX_FILE_BYTES, DOCX_MAX_FILE_BYTES),
    maxEntries: DOCX_MAX_ENTRIES,
    // What the kept parts declare, refused before anything is inflated; the bytes really inflated are counted below.
    maxTotalBytes: DOCX_MAX_TOTAL_BYTES,
    filter: (name) => {
      if (climbsOut(name)) unsafe.push(name);
      return wanted(name);
    },
  });
  const label = zip.path;
  try {
    if (unsafe.length) throw refuse(label, `it holds ${JSON.stringify(unsafe[0])}, a name that leads outside the document`);
    const byName = new Map<string, ZipEntry>();
    for (const e of zip.entries) {
      if (byName.has(e.name)) throw refuse(label, `it holds ${e.name} twice`);
      byName.set(e.name, e);
    }
    let inflated = 0;
    const part = (name: string): string | null => {
      const e = byName.get(name);
      if (!e) return null;
      const where = `${label} (${name})`;
      if (e.size > DOCX_MAX_PART_BYTES) throw refuse(label, `${name} would unpack to ${mib(e.size)}, more than the ${mib(DOCX_MAX_PART_BYTES)} limit`);
      if (e.size > DOCX_RATIO_FLOOR && e.size > DOCX_MAX_RATIO * Math.max(1, e.compressedSize)) {
        const ratio = Math.round(e.size / Math.max(1, e.compressedSize));
        throw refuse(label, `${name} would unpack to ${ratio} times its packed size, past the ${DOCX_MAX_RATIO}:1 limit`);
      }
      if (inflated + e.size > DOCX_MAX_TOTAL_BYTES) throw refuse(label, `its parts would unpack to more than ${mib(DOCX_MAX_TOTAL_BYTES)}`);
      let bytes: Uint8Array;
      try {
        bytes = zip.read(e);
      } catch (error) {
        if (error instanceof UnsafeFileError) throw error;
        throw refuse(label, `${name} is damaged (${error instanceof Error ? error.message : String(error)})`);
      }
      // The bytes the inflater really produced: zip.read refuses an entry that unpacks past what it declared.
      inflated += bytes.length;
      if (inflated > DOCX_MAX_TOTAL_BYTES) throw refuse(label, `its parts unpack to more than ${mib(DOCX_MAX_TOTAL_BYTES)}`);
      return decodeText(bytes, where).text;
    };
    const parse = <T>(name: string, read: () => T): T => {
      try {
        return read();
      } catch (error) {
        if (error instanceof UnsafeFileError) throw error;
        if (error instanceof TooLong) throw refuse(label, `its text runs past ${mib(TEXT_MAX_BYTES)}`);
        if (error instanceof XmlError) throw refuse(label, `${name} is damaged: ${error.message}`);
        throw error;
      }
    };

    const relsXml = part('_rels/.rels');
    const rels = relsXml === null ? { main: null, core: null } : parse('_rels/.rels', () => readRels(relsXml));
    if (rels.main === '') throw refuse(label, 'its main part points outside the document');
    const mainName = rels.main ?? 'word/document.xml';
    const mainXml = part(mainName);
    if (mainXml === null) throw refuse(label, `it has no ${mainName}, so it isn't a Word document`);
    const folder = mainName.includes('/') ? mainName.slice(0, mainName.lastIndexOf('/') + 1) : '';
    const stylesXml = part(`${folder}styles.xml`);
    const headingOf = parse(`${folder}styles.xml`, () => readStyles(stylesXml));
    const coreName = rels.core || 'docProps/core.xml';
    const coreXml = part(coreName);
    const core = coreXml === null ? { title: null, created: null } : parse(coreName, () => readCore(coreXml));
    const { body, heading } = parse(mainName, () => documentText(mainXml, headingOf));
    return { path: zip.path, sha256: zip.sha256, mtime: zip.mtime, title: core.title ?? heading, createdAt: core.created, body };
  } finally {
    zip.close();
  }
}

/**
 * A .docx as the text of a Markdown note: front matter with its title (the document's, its first heading, or the file
 * name) and the time its properties claim, then the body. Every value is one quoted line, so nothing in the
 * document can add a front matter key or end the block early.
 */
export function docxNoteText(doc: DocxDocument): string {
  const fallback = basename(doc.path, extname(doc.path));
  const title = oneLine(doc.title ?? '') || fallback;
  const lines = ['---', `title: ${JSON.stringify(title)}`];
  if (doc.createdAt) lines.push(`created: ${doc.createdAt}`);
  lines.push('---', '');
  return `${lines.join('\n')}\n${doc.body}\n`;
}
