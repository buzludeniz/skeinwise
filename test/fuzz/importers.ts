// The fuzz harness for the import parsers: decodeText, scanXml, readDocx and parseFrontMatter/parseNote. Each target
// takes a mutated input and must either return or refuse it the way it says it will (UnsafeFileError, XmlError) within
// a time budget; any other error, a result that breaks a target's own rule, or a slow input is a finding. Every input is
// built at run time from the seeds written here, so nothing hostile is ever committed.
//
// test/importers-fuzz.test.ts runs a few hundred seeded inputs per target with the suite. A long run, from the repo:
//
//   node test/fuzz/importers.ts --seconds 600 --dir <a new folder> [--seed 1] [--target docx]
//   node test/fuzz/importers.ts --replay <dir>/<finding>.bin --target docx
//
// A long run loads the Mac for minutes: take the heavy-job turn first and release it when it ends. Each finding names
// its target, seed and iteration, which replay it exactly, and its input is written to --dir.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { UnsafeFileError } from '../../src/fsafe.ts';
import { mulberry32 } from '../../src/random.ts';
import { docxNoteText, readDocx } from '../../src/importers/docx.ts';
import { parseFrontMatter, parseNote } from '../../src/importers/notes.ts';
import { decodeText } from '../../src/importers/text.ts';
import { scanXml, XmlError } from '../../src/importers/xml.ts';

type Rng = () => number;

export interface Target {
  name: string;
  /** Valid inputs to start from. */
  seeds: () => Uint8Array[];
  /** Words worth inserting: the syntax this parser cares about. */
  tokens: string[];
  /** Runs one input. Throws a refusal the target promises, or anything else when it found a bug. */
  run: (input: Uint8Array, scratch: string) => void;
  /** The errors that are the parser saying no, as it should. */
  refused: (error: unknown) => boolean;
  /** Mutates in a way that knows the format, some of the time (a .docx: a part's XML, zipped again). */
  mutate?: (rng: Rng, seed: Uint8Array, generic: (bytes: Uint8Array) => Uint8Array) => Uint8Array;
}

export interface Finding {
  target: string;
  seed: number;
  iteration: number;
  ms: number;
  error: string;
  input: Uint8Array;
}

/** The largest input a mutation may build: big enough for a repeated token to show a parser going quadratic. */
const MAX_INPUT = 1024 * 1024;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function wellFormed(text: string, what: string): void {
  if (LONE_SURROGATE.test(text)) throw new Error(`${what} holds a lone surrogate`);
}

const utf8 = (bytes: Uint8Array) => new TextDecoder('utf-8').decode(bytes);
const pick = <T>(rng: Rng, list: readonly T[]): T => list[Math.floor(rng() * list.length)]!;
const int = (rng: Rng, below: number) => Math.floor(rng() * below);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const INTERESTING = [0x00, 0x0a, 0x0d, 0x20, 0x22, 0x23, 0x26, 0x2d, 0x2f, 0x3a, 0x3b, 0x3c, 0x3e, 0x5b, 0x5d, 0x7f, 0x80, 0xbf, 0xc0, 0xef, 0xfe, 0xff];

/** One to four generic mutations: bit flips, odd bytes, cuts, deletions, splices from the seeds, repeats, tokens. */
function mutateBytes(rng: Rng, input: Uint8Array, seeds: Uint8Array[], tokens: Uint8Array[]): Uint8Array {
  let bytes = input;
  for (let n = 1 + int(rng, 4); n > 0; n--) {
    const at = int(rng, bytes.length + 1);
    switch (int(rng, 8)) {
      case 0: {
        bytes = bytes.slice();
        for (let k = 1 + int(rng, 8); k > 0 && bytes.length; k--) bytes[int(rng, bytes.length)]! ^= 1 << int(rng, 8);
        break;
      }
      case 1: {
        bytes = bytes.slice();
        for (let k = 1 + int(rng, 4); k > 0 && bytes.length; k--) bytes[int(rng, bytes.length)] = pick(rng, INTERESTING);
        break;
      }
      case 2:
        bytes = bytes.subarray(0, at);
        break;
      case 3:
        bytes = concat(bytes.subarray(0, at), bytes.subarray(Math.min(bytes.length, at + 1 + int(rng, 64))));
        break;
      case 4: {
        const other = pick(rng, seeds);
        const from = int(rng, other.length);
        bytes = concat(bytes.subarray(0, at), other.subarray(from, from + 1 + int(rng, 256)), bytes.subarray(at));
        break;
      }
      case 5: {
        // A chunk repeated many times: the shape that makes a backtracking parser slow.
        const chunk = bytes.subarray(at, at + 1 + int(rng, 16));
        const times = Math.min(1 << int(rng, 17), Math.floor(MAX_INPUT / Math.max(1, chunk.length)));
        const repeated = new Uint8Array(chunk.length * times);
        for (let i = 0; i < times; i++) repeated.set(chunk, i * chunk.length);
        bytes = concat(bytes.subarray(0, at), repeated, bytes.subarray(at));
        break;
      }
      case 6:
      case 7: {
        const token = pick(rng, tokens);
        const times = rng() < 0.2 ? Math.min(1 << int(rng, 14), Math.floor(MAX_INPUT / Math.max(1, token.length))) : 1;
        const repeated = new Uint8Array(token.length * times);
        for (let i = 0; i < times; i++) repeated.set(token, i * token.length);
        bytes = concat(bytes.subarray(0, at), repeated, bytes.subarray(at));
        break;
      }
    }
    if (bytes.length > MAX_INPUT) bytes = bytes.subarray(0, MAX_INPUT);
  }
  return bytes;
}

// ---- seeds ----

const NOTE = '---\ntitle: "Seed swap: spring"\ncreated: 2025-03-01\ntags: [garden, seeds]\npeople:\n  - Ana\n  - "Bo, Jr"\nsummary: |\n  two\n  lines\n---\n# Swap\n\nBring #seeds and [[Seed list]].\n';
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

const XML_TOKENS = ['<', '>', '</', '/>', '<!--', '-->', '<![CDATA[', ']]>', '<?', '?>', '<!DOCTYPE a [<!ENTITY x "y">]>', '&', '&amp;', '&#', '&#x', '&#x1F331;', '&#0;', ';', '"', "'", '=', ' xmlns:w="x"', '<w:p>', '</w:p>', '<w:t>', '</w:t>', '<w:tbl><w:tr><w:tc>', '<w:del>', '﻿', '\u0000'];

// ---- targets ----

export const TARGETS: Target[] = [
  {
    name: 'text',
    seeds: () => {
      const wide = Buffer.from(NOTE, 'utf16le');
      return [
        strToU8(NOTE),
        concat(new Uint8Array([0xef, 0xbb, 0xbf]), strToU8(NOTE)),
        concat(new Uint8Array([0xff, 0xfe]), wide),
        concat(new Uint8Array([0xfe, 0xff]), Buffer.from(wide).swap16()),
        wide,
        concat(new Uint8Array([0xff, 0xfe, 0, 0]), new Uint8Array(new Uint32Array([...NOTE].map((c) => c.codePointAt(0)!)).buffer)),
      ];
    },
    tokens: ['﻿', '\u0000', '�', '\u{1F331}', '\r\n', '\uD800', '\xff', '\xfe\xff', '\xef\xbb\xbf'],
    run: (input) => {
      // Only the first U+FEFF is a byte order mark: one after it is text (a zero-width no-break space) and is kept.
      wellFormed(decodeText(input, 'fuzz.txt').text, 'the decoded text');
    },
    refused: (error) => error instanceof UnsafeFileError && error.reason === 'not-a-file',
  },
  {
    name: 'xml',
    seeds: () => [strToU8(DOCUMENT), strToU8(STYLES), strToU8(CORE), strToU8(RELS)],
    tokens: XML_TOKENS,
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
    seeds: () => [zipSync(docxParts()), zipSync(docxParts(), { level: 0 }), zipSync({ 'word/document.xml': strToU8(DOCUMENT) })],
    tokens: [...XML_TOKENS, 'PK\u0003\u0004', 'PK\u0001\u0002', 'PK\u0005\u0006', '../', 'word/../../'],
    mutate: (rng, seed, generic) => {
      if (rng() < 0.5) return generic(seed);
      // Mutate one part's XML and zip it again, so the damage reaches the parser behind the zip reader.
      const parts: Record<string, Uint8Array> = unzipSync(seed);
      const names = Object.keys(parts);
      const name = pick(rng, names);
      parts[name] = generic(parts[name]!);
      if (rng() < 0.1) parts[pick(rng, ['../evil.xml', 'word/../../x.xml', '/abs.xml', 'word/extra.xml'])] = strToU8(DOCUMENT);
      return zipSync(parts, { level: rng() < 0.5 ? 0 : 6 });
    },
    run: (input, scratch) => {
      const path = join(scratch, 'fuzz.docx');
      writeFileSync(path, input);
      const doc = readDocx(path);
      wellFormed(doc.body, 'the body');
      const note = parseNote('fuzz.docx', docxNoteText(doc), new Date(0));
      wellFormed(note.body, "the note's body");
    },
    refused: (error) => error instanceof UnsafeFileError,
  },
  {
    name: 'frontmatter',
    seeds: () => [strToU8(NOTE), strToU8(`﻿${NOTE}`), strToU8(NOTE.replace(/\n/g, '\r\n')), strToU8('---\n---\n'), strToU8('no front matter #tag')],
    tokens: ['---\n', '...\n', '\n', ':', ': ', '- ', '  - ', '[', ']', ',', '"', "'", "''", '\\"', '|', '>', '#', '[[', ']]', '__proto__: x\n', 'constructor: y\n', 'tags: ', 'created: ', '﻿', '\r'],
    run: (input) => {
      const text = utf8(input);
      const front = parseFrontMatter(text);
      if (Object.getPrototypeOf(front.properties) !== null || Object.getPrototypeOf(front.meta) !== null) throw new Error('front matter has a prototype');
      if (!text.endsWith(front.body) && !text.replace(/^﻿/, '').endsWith(front.body)) throw new Error('the body is not the end of the note');
      const note = parseNote('fuzz.md', text, new Date(0));
      if (note.createdAt && Number.isNaN(Date.parse(note.createdAt))) throw new Error(`createdAt ${note.createdAt} is not a date`);
      JSON.stringify(note.properties);
    },
    refused: () => false,
  },
];

/** A generator for one iteration, so any finding replays from its seed and iteration alone. */
function rngFor(seed: number, target: string, iteration: number): Rng {
  let h = seed >>> 0;
  for (const c of target) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return mulberry32((h ^ Math.imul(iteration + 1, 0x9e3779b1)) >>> 0);
}

/** Builds the input for one iteration of a target. */
export function inputFor(target: Target, seed: number, iteration: number): Uint8Array {
  const rng = rngFor(seed, target.name, iteration);
  const seeds = target.seeds();
  const tokens = target.tokens.map((t) => (/^[\x00-\xff]*$/.test(t) && /[\x80-\xff]/.test(t) ? Uint8Array.from(t, (c) => c.charCodeAt(0)) : strToU8(t)));
  const start = pick(rng, seeds);
  const generic = (bytes: Uint8Array) => mutateBytes(rng, bytes, seeds, tokens);
  return target.mutate ? target.mutate(rng, start, generic) : generic(start);
}

/** Runs one input; a finding when it fails in a way the target doesn't promise, or takes longer than budgetMs. */
export function runOne(target: Target, input: Uint8Array, scratch: string, budgetMs: number): { error?: string; ms: number } {
  const started = performance.now();
  let error: string | undefined;
  try {
    target.run(input, scratch);
  } catch (e) {
    if (!target.refused(e)) error = e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ''}` : String(e);
  }
  const ms = performance.now() - started;
  if (!error && ms > budgetMs) error = `took ${Math.round(ms)} ms on ${input.length} bytes, past the ${budgetMs} ms budget`;
  return error ? { error, ms } : { ms };
}

export interface FuzzOptions {
  seed: number;
  /** Stop after this many inputs per target... */
  iterations?: number;
  /** ...or after this many seconds in all, shared between the targets. */
  seconds?: number;
  targets?: Target[];
  /** Where the .docx inputs are written while they run. */
  scratch: string;
  budgetMs?: number;
  onFinding?: (finding: Finding) => void;
}

export function fuzz(options: FuzzOptions): { runs: Record<string, number>; findings: Finding[] } {
  const targets = options.targets ?? TARGETS;
  const budgetMs = options.budgetMs ?? 2000;
  const findings: Finding[] = [];
  const runs: Record<string, number> = {};
  const until = options.seconds ? performance.now() + options.seconds * 1000 : Infinity;
  const limit = options.iterations ?? (options.seconds ? Infinity : 200);
  for (let iteration = 0; iteration < limit && performance.now() < until; iteration++) {
    for (const target of targets) {
      const input = inputFor(target, options.seed, iteration);
      const { error, ms } = runOne(target, input, options.scratch, budgetMs);
      runs[target.name] = (runs[target.name] ?? 0) + 1;
      if (error) {
        const finding = { target: target.name, seed: options.seed, iteration, ms, error, input };
        findings.push(finding);
        options.onFinding?.(finding);
      }
    }
  }
  return { runs, findings };
}

function main(): void {
  const { values } = parseArgs({
    options: {
      seconds: { type: 'string', default: '60' },
      seed: { type: 'string', default: String(Date.now() % 2 ** 31) },
      target: { type: 'string' },
      dir: { type: 'string' },
      replay: { type: 'string' },
      budget: { type: 'string', default: '2000' },
    },
  });
  const targets = values.target ? TARGETS.filter((t) => t.name === values.target) : TARGETS;
  if (!targets.length) throw new Error(`No target named ${values.target}: ${TARGETS.map((t) => t.name).join(', ')}`);
  const dir = values.dir ? resolve(values.dir) : mkdtempSync(join(tmpdir(), 'skeinwise-fuzz-'));
  mkdirSync(dir, { recursive: true });
  const budgetMs = Number(values.budget);
  if (values.replay) {
    const input = new Uint8Array(readFileSync(values.replay));
    for (const target of targets) console.log(`${target.name}: ${runOne(target, input, dir, budgetMs).error ?? 'returned or refused, as it should'}`);
    return;
  }
  const seed = Number(values.seed);
  console.log(`fuzzing ${targets.map((t) => t.name).join(', ')} for ${values.seconds} s, seed ${seed}, inputs in ${dir}`);
  const { runs, findings } = fuzz({
    seed,
    seconds: Number(values.seconds),
    targets,
    scratch: dir,
    budgetMs,
    onFinding: (f) => {
      const file = join(dir, `${f.target}-seed${f.seed}-i${f.iteration}.bin`);
      writeFileSync(file, f.input);
      console.log(`FINDING ${f.target} seed ${f.seed} iteration ${f.iteration} (${f.input.length} bytes, ${Math.round(f.ms)} ms): ${f.error.split('\n')[0]}\n  input: ${file}`);
    },
  });
  writeFileSync(join(dir, 'findings.json'), JSON.stringify(findings.map(({ input: _input, ...f }) => f), null, 2));
  console.log(`${Object.entries(runs).map(([t, n]) => `${t} ${n}`).join(', ')} inputs; ${findings.length} findings`);
  process.exitCode = findings.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
