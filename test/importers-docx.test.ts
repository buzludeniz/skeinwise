// .docx as notes: a plain document, then the hostile ones (bomb, huge, odd encoding, truncated, names that climb out).
// Every hostile file is built here at run time; none is committed.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, strToU8, zipSync, type Zippable } from 'fflate';
import { buildZip } from './fsafe-zip.ts';
import { UnsafeFileError } from '../src/fsafe.ts';
import { DOCX_MAX_ENTRIES, docxNoteText, documentText, readDocx } from '../src/importers/docx.ts';
import { readImportFile } from '../src/importers/files.ts';
import { parseNote } from '../src/importers/notes.ts';
import { mulberry32 } from '../src/random.ts';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const RELS =
  '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
  '</Relationships>';
const STYLES =
  `<?xml version="1.0"?><w:styles xmlns:w="${W}">` +
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Kop2"><w:name w:val="heading 2"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Chapter"><w:name w:val="Chapter"/><w:basedOn w:val="Heading1"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Loop1"><w:name w:val="Loop one"/><w:basedOn w:val="Loop2"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Loop2"><w:name w:val="Loop two"/><w:basedOn w:val="Loop1"/></w:style>' +
  '</w:styles>';

function documentXml(body: string, namespaces = `xmlns:w="${W}" xmlns:mc="${MC}"`): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${namespaces}><w:body>${body}<w:sectPr/></w:body></w:document>`;
}

function core(title: string, created: string): string {
  return (
    '<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${title}</dc:title><dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created></cp:coreProperties>`
  );
}

const para = (text: string, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const style = (id: string) => `<w:pStyle w:val="${id}"/>`;
const listItem = (level: number, numId = 1) => `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr>`;
const cell = (text: string) => `<w:tc>${para(text)}</w:tc>`;

function withDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'skeinwise-docx-'));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeDocx(dir: string, name: string, parts: Record<string, string | Uint8Array>): string {
  const files: Zippable = { '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types/>') };
  for (const [part, value] of Object.entries(parts)) files[part] = typeof value === 'string' ? strToU8(value) : value;
  const path = join(dir, name);
  writeFileSync(path, zipSync(files));
  return path;
}

function refusal(run: () => unknown): UnsafeFileError {
  try {
    run();
  } catch (error) {
    if (error instanceof UnsafeFileError) return error;
    throw error;
  }
  throw new Error('expected the file to be refused');
}

/** Bytes that don't compress, for packed data whose size has to look honest. */
function noise(length: number, seed = 7): Uint8Array {
  const random = mulberry32(seed);
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = Math.floor(random() * 256);
  return out;
}

describe('a plain .docx', () => {
  const body = [
    para('Garden plan', style('Heading1')),
    para('Beds &amp; paths: &lt;b&gt;, &#x2014; &#169;'),
    para('Sow peas', listItem(0)),
    para('Early', listItem(1)),
    para('Water', listItem(0)),
    para('Not a list', listItem(0, 0)),
    `<w:tbl><w:tr>${cell('Bed')}${cell('Crop')}</w:tr><w:tr>${cell('A')}${cell('Peas | beans')}</w:tr></w:tbl>`,
    '<w:p><w:r><w:t>one</w:t><w:tab/><w:t>two</w:t><w:br/><w:t>three</w:t></w:r></w:p>',
    '<w:p><w:r><w:t xml:space="preserve">kept </w:t></w:r><w:del w:id="1"><w:r><w:delText>gone</w:delText></w:r></w:del><w:ins w:id="2"><w:r><w:t>added</w:t></w:r></w:ins></w:p>',
    '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> HYPERLINK "https://example.invalid" </w:instrText></w:r>' +
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>link text</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>',
    `<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wps:txbx xmlns:wps="urn:test:wps"><w:txbxContent>${para('In the box')}</w:txbxContent></wps:txbx></w:drawing></mc:Choice>` +
      `<mc:Fallback><w:pict><v:textbox xmlns:v="urn:schemas-microsoft-com:vml"><w:txbxContent>${para('In the box')}</w:txbxContent></v:textbox></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>`,
    para('Chapter two', style('Chapter')),
    para('Sub', style('Kop2')),
    para('Outline', '<w:outlineLvl w:val="2"/>'),
    para('Round in circles', style('Loop1')),
    '<w:p><w:pPr><w:rPr><w:t>not text</w:t></w:rPr></w:pPr></w:p>',
  ].join('');

  const expected = [
    '# Garden plan',
    'Beds & paths: <b>, \u2014 \u00a9',
    '- Sow peas\n  - Early\n- Water',
    'Not a list',
    '| Bed | Crop |\n| --- | --- |\n| A | Peas \\| beans |',
    'one\ttwo\nthree',
    'kept added',
    'link text',
    'In the box',
    '# Chapter two',
    '## Sub',
    '### Outline',
    'Round in circles',
  ].join('\n\n');

  it('reads its text as Markdown, with its title and date', () => {
    withDir((dir) => {
      const path = writeDocx(dir, 'plan.docx', {
        '_rels/.rels': RELS,
        'word/document.xml': documentXml(body),
        'word/styles.xml': STYLES,
        'docProps/core.xml': core('Garden &quot;notes&quot;', '2024-03-05T10:00:00Z'),
        'word/media/image1.png': new Uint8Array([137, 80, 78, 71]),
      });
      const doc = readDocx(path);
      expect(doc.body).toBe(expected);
      expect(doc.title).toBe('Garden "notes"');
      expect(doc.createdAt).toBe('2024-03-05T10:00:00.000Z');
      expect(doc.sha256).toMatch(/^[0-9a-f]{64}$/);

      const note = parseNote('plan.docx', docxNoteText(doc), new Date('2026-01-01T00:00:00Z'));
      expect(note.title).toBe('Garden "notes"');
      expect(note.createdAt).toBe('2024-03-05T10:00:00.000Z');
      expect(note.body).toBe(expected);
      expect({ ...note.properties }).toEqual({ title: 'Garden "notes"', created: '2024-03-05T10:00:00.000Z' });
      expect(readImportFile(path).text).toBe(docxNoteText(doc));
    });
  });

  it('takes the title from the first heading, then the file name, and finds its parts without the relationships', () => {
    withDir((dir) => {
      // No _rels/.rels and no styles.xml: the standard part names and Word's own heading style ids still work.
      const headed = readDocx(writeDocx(dir, 'a.docx', { 'word/document.xml': documentXml(para('Intro', style('Heading2')) + para('text')) }));
      expect(headed).toMatchObject({ title: 'Intro', createdAt: null, body: '## Intro\n\ntext' });
      const plain = readDocx(writeDocx(dir, '2025-07-14 minutes.docx', { 'word/document.xml': documentXml(para('just text')) }));
      expect(plain.title).toBeNull();
      const note = parseNote('2025-07-14 minutes.docx', docxNoteText(plain), new Date());
      expect(note.title).toBe('2025-07-14 minutes');
      expect(note.createdAt).toBe('2025-07-14T09:00:00.000Z');
    });
  });

  it('reads the strict namespace, a default namespace and a main part named by the relationships', () => {
    withDir((dir) => {
      const strict = documentXml(para('Strict'), 'xmlns:w="http://purl.oclc.org/ooxml/wordprocessingml/main"');
      expect(readDocx(writeDocx(dir, 's.docx', { 'word/document.xml': strict })).body).toBe('Strict');
      const bare = `<document xmlns="${W}"><body><p><r><t>Default</t></r></p></body></document>`;
      expect(readDocx(writeDocx(dir, 'd.docx', { 'word/document.xml': bare })).body).toBe('Default');
      const rels = RELS.replace('Target="word/document.xml"', 'Target="/content/main.xml"');
      expect(readDocx(writeDocx(dir, 'r.docx', { '_rels/.rels': rels, 'content/main.xml': documentXml(para('Moved')) })).body).toBe('Moved');
    });
  });

  it('keeps a nested table inside its cell', () => {
    const inner = `<w:tbl><w:tr>${cell('x')}${cell('y')}</w:tr><w:tr>${cell('z')}</w:tr></w:tbl>`;
    const xml = documentXml(`<w:tbl><w:tr><w:tc>${para('outer')}${inner}</w:tc>${cell('b')}</w:tr></w:tbl>`);
    expect(documentText(xml, () => 0).body).toBe('| outer x y / z | b |\n| --- | --- |');
  });

  it('refuses a zip without a document part, and a document part that is not Word', () => {
    withDir((dir) => {
      expect(refusal(() => readDocx(writeDocx(dir, 'x.docx', { 'notes.xml': '<a/>' }))).message).toMatch(/x\.docx: refused, it has no word\/document\.xml/);
      expect(refusal(() => readDocx(writeDocx(dir, 'y.docx', { 'word/document.xml': '<doc><p>hi</p></doc>' }))).message).toMatch(
        /y\.docx: refused, word\/document\.xml is damaged: it is not a Word document body/,
      );
    });
  });
});

describe('a hostile .docx', () => {
  const kernel = deflateSync(new Uint8Array(4096).fill(32));

  it('bomb: refuses a part past the ratio before inflating it', () => {
    withDir((dir) => {
      const path = join(dir, 'ratio.docx');
      writeFileSync(path, buildZip([{ name: 'word/document.xml', data: kernel, size: 9 * 1024 ** 2 }]));
      const started = performance.now();
      const error = refusal(() => readDocx(path));
      expect(performance.now() - started).toBeLessThan(500);
      expect(error.reason).toBe('zip');
      expect(error.message).toMatch(/ratio\.docx: refused, word\/document\.xml would unpack to \d+ times its packed size, past the 200:1 limit/);
    });
  });

  it('bomb: counts the bytes really inflated, refusing a part that unpacks past what it declared', () => {
    withDir((dir) => {
      const path = join(dir, 'liar.docx');
      writeFileSync(path, buildZip([{ name: 'word/document.xml', data: deflateSync(new Uint8Array(1024 ** 2).fill(60)), size: 1000 }]));
      expect(refusal(() => readDocx(path)).message).toMatch(/liar\.docx \(word\/document\.xml\): refused, it unpacks past the 1000 bytes it declared/);
    });
  });

  it('bomb: refuses too many entries, and parts that add up past the total', () => {
    withDir((dir) => {
      const many = join(dir, 'many.docx');
      const specs = Array.from({ length: DOCX_MAX_ENTRIES + 1 }, (_, i) => ({ name: `word/media/${i}.png`, data: new Uint8Array(0), method: 0 as const, size: 0 }));
      writeFileSync(many, buildZip(specs));
      expect(refusal(() => readDocx(many)).message).toMatch(/many\.docx: refused, it holds 10001 files, more than the 10000 limit/);

      const total = join(dir, 'total.docx');
      const part = (name: string) => ({ name, data: kernel, size: 50 * 1024 ** 2 });
      writeFileSync(total, buildZip([part('word/document.xml'), part('word/styles.xml'), part('docProps/core.xml')]));
      expect(refusal(() => readDocx(total)).message).toMatch(/total\.docx: refused, it would unpack to 150 MiB, more than the 128 MiB limit/);
    });
  });

  it('huge: refuses a file over the size limit unread, a part over its limit uninflated, and text past the note limit', () => {
    withDir((dir) => {
      const sparse = join(dir, 'huge.docx');
      writeFileSync(sparse, '');
      truncateSync(sparse, 257 * 1024 ** 2);
      const big = refusal(() => readDocx(sparse));
      expect(big.reason).toBe('too-big');
      expect(big.message).toMatch(/huge\.docx: skipped, it holds 257 MiB, more than the 256 MiB limit/);

      const part = join(dir, 'part.docx');
      writeFileSync(part, buildZip([{ name: 'word/document.xml', data: noise(1024 ** 2), size: 65 * 1024 ** 2 }]));
      expect(refusal(() => readDocx(part)).message).toMatch(/part\.docx: refused, word\/document\.xml would unpack to 65 MiB, more than the 64 MiB limit/);

      // Stored, not deflated, so the ratio is 1:1 and only the text limit stands in the way.
      const long = join(dir, 'long.docx');
      const xml = strToU8(documentXml(`<w:p><w:r><w:t>${'a'.repeat(17 * 1024 ** 2)}</w:t></w:r></w:p>`));
      writeFileSync(long, zipSync({ 'word/document.xml': [xml, { level: 0 }] }));
      expect(refusal(() => readDocx(long)).message).toMatch(/long\.docx: refused, its text runs past 16 MiB/);
    });
  });

  it('odd encoding: reads UTF-16 and bad bytes, refuses a DTD (billion laughs), and replaces bad references', () => {
    withDir((dir) => {
      const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(documentXml(para('Sixteen \u00e9')).replace('UTF-8', 'UTF-16'), 'utf16le')]);
      expect(readDocx(writeDocx(dir, 'utf16.docx', { 'word/document.xml': utf16 })).body).toBe('Sixteen \u00e9');

      // A UTF-8 lead byte without its continuation, just before the text.
      const xml = strToU8(documentXml(para('QQok')));
      const at = Buffer.from(xml).indexOf('QQok');
      const bytes = new Uint8Array([...xml.subarray(0, at), 0xc3, 0x28, ...xml.subarray(at + 2)]);
      expect(readDocx(writeDocx(dir, 'bytes.docx', { 'word/document.xml': bytes })).body).toBe('\ufffd(ok');

      const lol = '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]>';
      const laughs = `<?xml version="1.0"?>${lol}<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>&lol2;</w:t></w:r></w:p></w:body></w:document>`;
      expect(refusal(() => readDocx(writeDocx(dir, 'lol.docx', { 'word/document.xml': laughs }))).message).toMatch(
        /lol\.docx: refused, word\/document\.xml is damaged: it declares a DTD or an entity/,
      );

      const refs = documentXml(para('[&#0;][&#xD800;][&#x110000;][&#99999999999999999999;][&nbsp;][&amp][& ][&#65;]'));
      // A reference longer than any real one is past the bounded lookahead, so it stays as written.
      expect(readDocx(writeDocx(dir, 'refs.docx', { 'word/document.xml': refs })).body).toBe(
        '[\ufffd][\ufffd][\ufffd][&#99999999999999999999;][&nbsp;][&amp][& ][A]',
      );
    });
  });

  it('truncated: refuses a cut file, a cut deflate stream and XML cut mid-tag, each by name', () => {
    withDir((dir) => {
      const whole = zipSync({ 'word/document.xml': strToU8(documentXml(para('whole'))) });
      const cut = join(dir, 'cut.docx');
      writeFileSync(cut, whole.subarray(0, Math.floor(whole.length / 2)));
      expect(refusal(() => readDocx(cut)).message).toMatch(/cut\.docx: refused, it is not a zip file/);

      const xml = strToU8(documentXml(para('stream '.repeat(2000))));
      const packed = deflateSync(xml);
      const stream = join(dir, 'stream.docx');
      writeFileSync(stream, buildZip([{ name: 'word/document.xml', data: packed.subarray(0, Math.floor(packed.length / 2)), size: xml.length }]));
      expect(refusal(() => readDocx(stream)).message).toMatch(/stream\.docx.*refused/);

      const text = documentXml(para('half'));
      const mid = writeDocx(dir, 'mid.docx', { 'word/document.xml': text.slice(0, text.indexOf('half') - 3) });
      expect(refusal(() => readDocx(mid)).message).toMatch(/mid\.docx: refused, word\/document\.xml is damaged: it is cut short inside/);

      const garbage = join(dir, 'garbage.docx');
      writeFileSync(garbage, noise(4096));
      expect(refusal(() => readDocx(garbage)).reason).toBe('zip');
    });
  });

  it('refuses names that climb out, a part listed twice and a main part outside the package', () => {
    withDir((dir) => {
      const stored = (name: string, text = '<a/>') => ({ name, data: strToU8(text), method: 0 as const, size: strToU8(text).length });
      const ok = stored('word/document.xml', documentXml(para('x')));
      for (const name of ['../evil.xml', 'word/../../evil.xml', '/etc/evil.xml', 'C:\\evil.xml', '..\\evil.xml']) {
        const path = join(dir, 'climb.docx');
        writeFileSync(path, buildZip([ok, stored(name)]));
        expect(refusal(() => readDocx(path)).message).toMatch(/climb\.docx: refused, it holds .* a name that leads outside the document/);
      }
      const twice = join(dir, 'twice.docx');
      writeFileSync(twice, buildZip([ok, stored('word/document.xml', documentXml(para('other')))]));
      expect(refusal(() => readDocx(twice)).message).toMatch(/twice\.docx: refused, it holds word\/document\.xml twice/);

      const rels = RELS.replace('Target="word/document.xml"', 'Target="../../../outside.xml"');
      expect(refusal(() => readDocx(writeDocx(dir, 'out.docx', { '_rels/.rels': rels, 'word/document.xml': documentXml(para('x')) }))).message).toMatch(
        /out\.docx: refused, its main part points outside the document/,
      );
      // An external target is a link, not a part: the standard part is read instead.
      const external = RELS.replace('Target="word/document.xml"', 'Target="https://example.invalid/x.xml" TargetMode="External"');
      expect(readDocx(writeDocx(dir, 'ext.docx', { '_rels/.rels': external, 'word/document.xml': documentXml(para('local')) })).body).toBe('local');
    });
  });

  it('gives attribute names no prototype', () => {
    const xml = documentXml(`<w:p><w:pPr><w:pStyle __proto__="x" constructor="y" w:val="Heading1"/></w:pPr><w:r><w:t>Safe</w:t></w:r></w:p>`);
    expect(documentText(xml, (id) => (id === 'Heading1' ? 1 : 0)).body).toBe('# Safe');
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});
