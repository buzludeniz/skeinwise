// The fuzz targets for the import parsers: decodeText, the line endings of a note, scanXml, readDocx (through the zip
// reader) and parseFrontMatter/parseNote. Each takes a mutated input and returns, or refuses it the way it says it will
// (UnsafeFileError, XmlError); what it returns must also keep the rules written in its `run`. The seeds are built here
// at run time, so nothing hostile is committed.

import { strToU8, unzipSync, zipSync } from 'fflate';
import { UnsafeFileError } from '../../src/fsafe.ts';
import { docxNoteText, readDocx } from '../../src/importers/docx.ts';
import { parseFrontMatter, parseNote } from '../../src/importers/notes.ts';
import { decodeText, type TextEncoding } from '../../src/importers/text.ts';
import { scanXml, XmlError } from '../../src/importers/xml.ts';
import { concat, int, MAX_INPUT, mutateZipField, pick, type Rng, type Target } from './engine.ts';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function wellFormed(text: string, what: string): void {
  if (LONE_SURROGATE.test(text)) throw new Error(`${what} holds a lone surrogate`);
}

export const utf8 = (bytes: Uint8Array): string => new TextDecoder('utf-8').decode(bytes);

// ---- seeds ----

export const NOTE = '---\ntitle: "Seed swap: spring"\ncreated: 2025-03-01\ntags: [garden, seeds]\npeople:\n  - Ana\n  - "Bo, Jr"\nsummary: |\n  two\n  lines\n---\n# Swap\n\nBring #seeds and [[Seed list]].\n';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Seed swap</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Bring &amp; share &#x2615; </w:t></w:r><w:r><w:tab/><w:t>#seeds</w:t><w:br/></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Beans</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>a|b</w:t></w:r></w:p></w:tc><w:tc><w:tbl><w:tr><w:tc><w:p><w:r><w:t>c</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:tc></w:tr></w:tbl>
<w:p><w:del><w:r><w:delText>gone</w:delText></w:r></w:del><w:r><w:instrText>PAGE</w:instrText></w:r><w:r><w:t><![CDATA[x<y]]></w:t></w:r></w:p>
</w:body></w:document>`;
const STYLES = `<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Sub"><w:basedOn w:val="Heading1"/></w:style></w:styles>`;
const CORE = `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"><dc:title>Seed swap</dc:title><dcterms:created>2025-03-01T10:00:00Z</dcterms:created></cp:coreProperties>`;
const RELS = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;

function docxParts(): Record<string, Uint8Array> {
  return { '_rels/.rels': strToU8(RELS), 'word/document.xml': strToU8(DOCUMENT), 'word/styles.xml': strToU8(STYLES), 'docProps/core.xml': strToU8(CORE) };
}

// ---- structure-aware XML mutation ----

const ELEMENTS = ['w:p', 'w:r', 'w:t', 'w:tbl', 'w:tr', 'w:tc', 'w:del', 'w:pPr', 'w:body', 'w:style', 'dc:title', 'Relationship'];
const TEXT_TOKENS = ['&amp;', '&lt;', '&#x1F331;', '&#xD800;', '&#0;', '&#x110000;', '&unknown;', '&', '﻿', '‮', '\r\n', '\t', '# ', '---', '[[x]]', '|', '`', '<!-- c -->', '<![CDATA[<]]>', ']]>'];
const ATTR_TOKENS = [' w:val="Heading1"', ' w:val="Heading9"', ' w:val=""', ' w:val="&quot;"', ' w:val="a" w:val="b"', ' xmlns:w="urn:other"', ' xml:space="preserve"', ' Target="../../x.xml"', ' Target="/word/document.xml"', ' Type="x"', ' __proto__="p"', ' w:styleId="Sub"', ' w:ilvl="99999"'];
const NEST = ['<w:tbl><w:tr><w:tc>', '</w:tc></w:tr></w:tbl>'] as const;

/** Where the element opened at `at` ends, past its closing tag, by counting tags of its own name; -1 when it doesn't. */
function elementEnd(xml: string, at: number, name: string): number {
  const self = xml.indexOf('>', at);
  if (self < 0) return -1;
  if (xml[self - 1] === '/') return self + 1;
  const tags = new RegExp(`<(/?)${name.replace(':', '\\:')}(?=[\\s/>])[^>]*?(/?)>`, 'g');
  tags.lastIndex = at;
  let depth = 0;
  for (let m = tags.exec(xml); m; m = tags.exec(xml)) {
    if (m[2]) continue;
    depth += m[1] ? -1 : 1;
    if (depth === 0) return m.index + m[0].length;
  }
  return -1;
}

/** One element of the given name, picked at random: [start, end), or null. */
function someElement(rng: Rng, xml: string, name: string): [number, number] | null {
  const starts: number[] = [];
  const open = new RegExp(`<${name.replace(':', '\\:')}(?=[\\s/>])`, 'g');
  for (let m = open.exec(xml); m && starts.length < 512; m = open.exec(xml)) starts.push(m.index);
  if (!starts.length) return null;
  const start = pick(rng, starts);
  const end = elementEnd(xml, start, name);
  return end < 0 ? null : [start, end];
}

/** A place between two tags, where an element can go. */
function someGap(rng: Rng, xml: string): number {
  const gaps: number[] = [];
  for (let i = xml.indexOf('><'); i >= 0 && gaps.length < 4096; i = xml.indexOf('><', i + 1)) gaps.push(i + 1);
  return gaps.length ? pick(rng, gaps) : xml.length;
}

/**
 * Changes an XML part the way a strange but well-formed document would: elements duplicated, dropped, repeated or
 * nested deep, odd text and attributes, with a generic byte mutation now and then for the parser's error paths.
 */
export function mutateXml(rng: Rng, xml: string, generic: (bytes: Uint8Array) => Uint8Array): string {
  if (rng() < 0.2) return utf8(generic(strToU8(xml)));
  let out = xml;
  for (let n = 1 + int(rng, 3); n > 0; n--) {
    const op = int(rng, 6);
    const el = someElement(rng, out, pick(rng, ELEMENTS));
    if (op === 0 && el) {
      out = out.slice(0, el[1]) + out.slice(el[0], el[1]) + out.slice(el[1]);
    } else if (op === 1 && el) {
      out = out.slice(0, el[0]) + out.slice(el[1]);
    } else if (op === 2 && el) {
      // Many copies, to reach the size caps and anything slow in the number of elements.
      const one = out.slice(el[0], el[1]);
      const times = Math.min(1 + int(rng, 4000), Math.floor((MAX_INPUT - out.length) / Math.max(1, one.length)));
      if (times > 0) out = out.slice(0, el[1]) + one.repeat(times) + out.slice(el[1]);
    } else if (op === 3 && el) {
      // Tables in tables, around and past the parser's depth limit.
      const depth = pick(rng, [2, 50, 1000, 1364, 1365, 1366, 2000]);
      out = out.slice(0, el[0]) + NEST[0].repeat(depth) + out.slice(el[0], el[1]) + NEST[1].repeat(depth) + out.slice(el[1]);
    } else if (op === 4) {
      const texts: number[] = [];
      for (let m = /<(?:w:t|w:delText|dc:title)(?:\s[^>]*)?>/g, r = m.exec(out); r && texts.length < 512; r = m.exec(out)) texts.push(r.index + r[0].length);
      const at = texts.length ? pick(rng, texts) : someGap(rng, out);
      out = out.slice(0, at) + pick(rng, TEXT_TOKENS) + out.slice(at);
    } else {
      const tags: number[] = [];
      for (let m = /<[A-Za-z][\w:.-]*/g, r = m.exec(out); r && tags.length < 512; r = m.exec(out)) tags.push(r.index + r[0].length);
      if (tags.length) {
        const at = pick(rng, tags);
        out = out.slice(0, at) + pick(rng, ATTR_TOKENS) + out.slice(at);
      }
    }
  }
  return out.length > MAX_INPUT ? out.slice(0, MAX_INPUT) : out;
}

const XML_TOKENS = ['<', '>', '</', '/>', '<!--', '-->', '<![CDATA[', ']]>', '<?', '?>', '<!DOCTYPE a [<!ENTITY x "y">]>', '&', '&amp;', '&#', '&#x', '&#x1F331;', '&#0;', ';', '"', "'", '=', ' xmlns:w="x"', '<w:p>', '</w:p>', '<w:t>', '</w:t>', '<w:tbl><w:tr><w:tc>', '<w:del>', '﻿', '\u0000'];

// ---- text decoding ----

const BOMS: Record<TextEncoding, number[]> = {
  'utf-8': [0xef, 0xbb, 0xbf],
  'utf-16le': [0xff, 0xfe],
  'utf-16be': [0xfe, 0xff],
  'utf-32le': [0xff, 0xfe, 0, 0],
  'utf-32be': [0, 0, 0xfe, 0xff],
};

function encode(text: string, encoding: TextEncoding): Uint8Array {
  if (encoding === 'utf-8') return Buffer.from(text, 'utf8');
  if (encoding === 'utf-16le') return Buffer.from(text, 'utf16le');
  if (encoding === 'utf-16be') return Buffer.from(text, 'utf16le').swap16();
  const points = [...text].map((c) => c.codePointAt(0)!);
  const out = Buffer.alloc(points.length * 4);
  points.forEach((p, i) => (encoding === 'utf-32le' ? out.writeUInt32LE(p, i * 4) : out.writeUInt32BE(p, i * 4)));
  return out;
}

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean => Buffer.compare(a, b) === 0;

/** decodeText's promises: well-formed text without a NUL, a mark it names, and nothing replaced that it doesn't say. */
function checkDecoded(input: Uint8Array): string {
  const decoded = decodeText(input, 'fuzz.txt');
  const { text, encoding, bom, replaced } = decoded;
  wellFormed(text, 'the decoded text');
  if (text.includes('\0')) throw new Error('a NUL came through');
  const mark = BOMS[encoding];
  if (bom && !mark.every((b, i) => input[i] === b)) throw new Error(`says it dropped a ${encoding} mark the input doesn't start with`);
  if (replaced && !text.includes('�')) throw new Error('says it replaced bytes, and holds no U+FFFD');
  // Nothing replaced: the text is exactly the input's bytes after the mark, in its encoding.
  if (!replaced && !equalBytes(encode(text, encoding), input.subarray(bom ? mark.length : 0))) throw new Error(`replaced bytes without saying so (${encoding})`);
  return text;
}

// ---- line endings ----

/** Every line break as CR LF; a lone CR stays. Undone by `lf` below, as `lf(crlf(t)) === lf(t)`. */
const crlf = (t: string): string => t.replace(/\r?\n/g, '\r\n');
const lf = (t: string): string => t.replace(/\r\n/g, '\n');

/** A parsed note with every string's CR LF made LF, as JSON: the same note whatever its line breaks were. */
function noteRead(text: string): string {
  // A name with no stem, so the title falls back to the note's first line when it has no heading or title.
  const note = parseNote('.md', text, new Date(0));
  return JSON.stringify(note, (_key, value: unknown) => (typeof value === 'string' ? lf(value) : value));
}

// ---- targets ----

const notFile = (error: unknown) => error instanceof UnsafeFileError && error.reason === 'not-a-file';

export const IMPORTER_TARGETS: Target[] = [
  {
    name: 'text',
    owner: 'src/importers/text.ts (tab 9)',
    memoryMiB: 256,
    seeds: () => {
      const wide = Buffer.from(NOTE, 'utf16le');
      return [
        strToU8(NOTE),
        concat(new Uint8Array(BOMS['utf-8']), strToU8(NOTE)),
        concat(new Uint8Array(BOMS['utf-16le']), wide),
        concat(new Uint8Array(BOMS['utf-16be']), Buffer.from(wide).swap16()),
        wide,
        concat(new Uint8Array(BOMS['utf-32le']), encode(NOTE, 'utf-32le')),
        concat(new Uint8Array(BOMS['utf-32be']), encode('Bring 🌱 seeds\r\n', 'utf-32be')),
        strToU8('mixed\r\nline\nends\rhere\n\r'),
      ];
    },
    tokens: ['﻿', '\u0000', '�', '\u{1F331}', '\r\n', '\r', '\n', '\n\r', '\uD800', '\xff', '\xfe\xff', '\xef\xbb\xbf', '\xff\xfe\x00\x00', '\x00\x00\xfe\xff', '\x00\x00', '\xed\xa0\x80', '\xf4\x90\x80\x80', '\xc0\x80', '\x00\xd8', '\x00\xdc'],
    run: (input) => void checkDecoded(input),
    refused: notFile,
  },
  {
    name: 'lines',
    owner: 'src/importers/notes.ts (tab 9)',
    memoryMiB: 256,
    seeds: () => [strToU8(NOTE), strToU8(crlf(NOTE)), strToU8(NOTE.replace(/\n/g, (_, at: number) => (at % 3 ? '\n' : '\r\n'))), strToU8('first line\r\nsecond #tag\r[[Link\r\n]]\n'), strToU8('---\r\n---\n# T\r\n')],
    tokens: ['\r\n', '\n', '\r', '\n\r', '\r\r\n', '---\r\n', '---\n', '...\r\n', '\r\n---\r\n', 'key: |\r\n', 'key: >\n', '  more\r\n', '  - item\r\n', 'tags: [a,\r\n b]\r\n', '# heading\r\n', '#\r\n', '[[link\r\n]]', ' #tag\r\n', 'title:\r\n'],
    run: (input) => {
      const text = checkDecoded(input);
      if (noteRead(text) !== noteRead(crlf(text))) throw new Error('the note reads differently with CR LF line breaks');
    },
    refused: notFile,
  },
  {
    name: 'xml',
    owner: 'src/importers/xml.ts (tab 9)',
    memoryMiB: 256,
    seeds: () => [strToU8(DOCUMENT), strToU8(STYLES), strToU8(CORE), strToU8(RELS)],
    tokens: XML_TOKENS,
    mutate: (rng, seed, generic) => strToU8(mutateXml(rng, utf8(seed), generic)),
    run: (input) => {
      let depth = 0;
      scanXml(utf8(input), {
        open: (_name, attrs) => {
          if (Object.getPrototypeOf(attrs) !== null) throw new Error('attributes have a prototype');
          depth++;
        },
        close: () => {
          depth--;
          if (depth < 0) throw new Error('closed more elements than it opened');
        },
        text: (text) => wellFormed(text, 'the text'),
      });
      if (depth !== 0) throw new Error(`returned with ${depth} elements open`);
    },
    refused: (error) => error instanceof XmlError,
  },
  {
    name: 'docx',
    owner: 'src/importers/docx.ts (tab 9)',
    fileName: 'input.docx',
    // Its caps: 128 MiB of parts in all, read as text, with the XML and the Markdown made from it.
    memoryMiB: 1024,
    seeds: () => [zipSync(docxParts()), zipSync(docxParts(), { level: 0 }), zipSync({ 'word/document.xml': strToU8(DOCUMENT) })],
    tokens: [...XML_TOKENS, 'PK\x03\x04', 'PK\x01\x02', 'PK\x05\x06', '../', 'word/../../'],
    mutate: (rng, seed, generic) => {
      const r = rng();
      if (r < 0.15) return generic(seed);
      if (r < 0.3) return mutateZipField(rng, seed);
      // Mutate one part's XML and zip it again, so the change reaches the parser and the walker behind the zip reader.
      const parts: Record<string, Uint8Array> = unzipSync(seed);
      const name = pick(rng, Object.keys(parts));
      parts[name] = strToU8(mutateXml(rng, utf8(parts[name]!), generic));
      if (rng() < 0.1) parts[pick(rng, ['../evil.xml', 'word/../../x.xml', '/abs.xml', 'word/extra.xml'])] = strToU8(DOCUMENT);
      return zipSync(parts, { level: rng() < 0.5 ? 0 : 6 });
    },
    run: (_input, file) => {
      const doc = readDocx(file);
      wellFormed(doc.body, 'the body');
      const note = parseNote('input.docx', docxNoteText(doc), new Date(0));
      wellFormed(note.body, "the note's body");
      // The front matter is the reader's own: nothing in the document adds a key to it.
      const keys = Object.keys(note.properties).sort().join();
      if (keys !== 'title' && keys !== 'created,title') throw new Error(`the document added front matter: ${keys}`);
    },
    refused: (error) => error instanceof UnsafeFileError,
  },
  {
    name: 'frontmatter',
    owner: 'src/importers/notes.ts (tab 9)',
    memoryMiB: 256,
    seeds: () => [strToU8(NOTE), strToU8(`﻿${NOTE}`), strToU8(crlf(NOTE)), strToU8('---\n---\n'), strToU8('no front matter #tag')],
    tokens: ['---\n', '...\n', '\n', ':', ': ', '- ', '  - ', '[', ']', ',', '"', "'", "''", '\\"', '|', '>', '#', '[[', ']]', '__proto__: x\n', 'constructor: y\n', 'tags: ', 'created: ', '﻿', '\r'],
    run: (input) => {
      const text = utf8(input);
      const front = parseFrontMatter(text);
      if (Object.getPrototypeOf(front.properties) !== null || Object.getPrototypeOf(front.meta) !== null) throw new Error('front matter has a prototype');
      if (!text.endsWith(front.body)) throw new Error('the body is not the end of the note');
      const note = parseNote('fuzz.md', text, new Date(0));
      if (note.createdAt && Number.isNaN(Date.parse(note.createdAt))) throw new Error(`createdAt ${note.createdAt} is not a date`);
      JSON.stringify(note.properties);
    },
    refused: () => false,
  },
];
