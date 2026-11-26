// A small XML scanner for the parts of a .docx, built to stay linear on any input (LS-06):
//
// - One pass from left to right. Every search starts where the last one ended, and a search that fails ends the scan
//   (the file is cut short), so nothing is read twice.
// - No DTD, so no entities beyond XML's five and numeric references: a document that declares one is refused, which
//   rules out entity expansion ("billion laughs") and external entities alike. Word never writes a DTD.
// - An unknown entity is kept as written; a numeric reference to a character XML doesn't allow becomes U+FFFD.
// - Tags must nest and close: a part that ends inside an element, or closes the wrong one, is refused as damaged.

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlError';
  }
}

/** Attribute values by their qualified name. No prototype, so a name like `__proto__` is just a name. */
export type XmlAttrs = Record<string, string>;

export interface XmlHandler {
  /** An element opens. A self-closing element gets open() then close(). */
  open(name: string, attrs: XmlAttrs): void;
  close(name: string): void;
  /** Character data inside the root element, entities decoded. One run of text may arrive in several calls. */
  text(text: string): void;
}

/** Deeper than any real document; past it the part is refused rather than walked. */
export const XML_MAX_DEPTH = 4096;

/** The longest reference worth decoding: `&#x10FFFF;` is 10 characters. */
const MAX_REF = 12;

function isSpace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

/** Characters that end a tag or attribute name. */
function endsName(c: number): boolean {
  return isSpace(c) || c === 0x3e /* > */ || c === 0x2f /* / */ || c === 0x3d /* = */ || c === 0x22 || c === 0x27 || c === 0x3c;
}

function xmlChar(cp: number): boolean {
  return (
    cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** XML's five entities and numeric references, in one pass; the search for each `;` looks only a few characters ahead. */
export function decodeEntities(t: string): string {
  let amp = t.indexOf('&');
  if (amp < 0) return t;
  const parts: string[] = [];
  let last = 0;
  while (amp >= 0) {
    let semi = -1;
    const stop = Math.min(t.length, amp + MAX_REF);
    for (let k = amp + 1; k < stop; k++) {
      if (t.charCodeAt(k) === 0x3b /* ; */) {
        semi = k;
        break;
      }
    }
    if (semi > 0) {
      const ref = t.slice(amp + 1, semi);
      let out: string | undefined = NAMED[ref];
      if (out === undefined && ref.charCodeAt(0) === 0x23 /* # */) {
        const hex = ref[1] === 'x' || ref[1] === 'X';
        const digits = ref.slice(hex ? 2 : 1);
        const cp = (hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits) ? Number.parseInt(digits, hex ? 16 : 10) : NaN;
        out = Number.isFinite(cp) ? (xmlChar(cp) ? String.fromCodePoint(cp) : '\ufffd') : undefined;
      }
      if (out !== undefined) {
        parts.push(t.slice(last, amp), out);
        last = semi + 1;
      }
    }
    amp = t.indexOf('&', amp + 1);
  }
  parts.push(t.slice(last));
  return parts.join('');
}

/** Scans `xml`, calling the handler for each element and run of text. Throws XmlError when the part is damaged. */
export function scanXml(xml: string, handler: XmlHandler, maxDepth = XML_MAX_DEPTH): void {
  const n = xml.length;
  const stack: string[] = [];
  let sawRoot = false;
  let i = xml.charCodeAt(0) === 0xfeff ? 1 : 0;
  const cut = (what: string) => new XmlError(`it is cut short inside ${what}`);

  while (i < n) {
    const lt = xml.indexOf('<', i);
    const end = lt < 0 ? n : lt;
    if (end > i && stack.length) handler.text(decodeEntities(xml.slice(i, end)));
    if (lt < 0) break;
    const c = xml.charCodeAt(lt + 1);

    if (c === 0x3f /* ? */) {
      const close = xml.indexOf('?>', lt + 2);
      if (close < 0) throw cut('a processing instruction');
      i = close + 2;
      continue;
    }
    if (c === 0x21 /* ! */) {
      if (xml.startsWith('!--', lt + 1)) {
        const close = xml.indexOf('-->', lt + 4);
        if (close < 0) throw cut('a comment');
        i = close + 3;
        continue;
      }
      if (xml.startsWith('![CDATA[', lt + 1)) {
        const close = xml.indexOf(']]>', lt + 9);
        if (close < 0) throw cut('a CDATA section');
        if (stack.length && close > lt + 9) handler.text(xml.slice(lt + 9, close));
        i = close + 3;
        continue;
      }
      throw new XmlError('it declares a DTD or an entity, which Skeinwise never reads');
    }
    if (c === 0x2f /* / */) {
      const close = xml.indexOf('>', lt + 2);
      if (close < 0) throw cut('a closing tag');
      const name = xml.slice(lt + 2, close).trim();
      const open = stack.pop();
      if (open === undefined) throw new XmlError(`it closes <${name}>, which was never opened`);
      if (open !== name) throw new XmlError(`it closes <${name}> where <${open}> is open`);
      handler.close(name);
      i = close + 1;
      continue;
    }

    // A start tag: its name, then attributes up to `>` or `/>`.
    let k = lt + 1;
    while (k < n && !endsName(xml.charCodeAt(k))) k++;
    const name = xml.slice(lt + 1, k);
    if (!name) {
      if (k >= n) throw cut('a tag');
      throw new XmlError(`it has a "<" that starts no tag, at character ${lt}`);
    }
    if (sawRoot && !stack.length) throw new XmlError(`it has a second root element, <${name}>`);
    const attrs: XmlAttrs = Object.create(null) as XmlAttrs;
    let empty = false;
    for (;;) {
      while (k < n && isSpace(xml.charCodeAt(k))) k++;
      if (k >= n) throw cut(`<${name}>`);
      const ch = xml.charCodeAt(k);
      if (ch === 0x3e /* > */) {
        k++;
        break;
      }
      if (ch === 0x2f /* / */) {
        if (k + 1 >= n) throw cut(`<${name}>`);
        if (xml.charCodeAt(k + 1) !== 0x3e) throw new XmlError(`<${name}> has a "/" out of place`);
        k += 2;
        empty = true;
        break;
      }
      const start = k;
      while (k < n && !endsName(xml.charCodeAt(k))) k++;
      const attr = xml.slice(start, k);
      if (!attr) throw new XmlError(`<${name}> has an attribute without a name`);
      while (k < n && isSpace(xml.charCodeAt(k))) k++;
      if (k >= n) throw cut(`<${name}>`);
      if (xml.charCodeAt(k) !== 0x3d /* = */) throw new XmlError(`<${name}>'s attribute ${attr} has no value`);
      k++;
      while (k < n && isSpace(xml.charCodeAt(k))) k++;
      if (k >= n) throw cut(`<${name}>`);
      const quote = xml[k];
      if (quote !== '"' && quote !== "'") throw new XmlError(`<${name}>'s attribute ${attr} isn't quoted`);
      const close = xml.indexOf(quote, k + 1);
      if (close < 0) throw cut(`<${name}>`);
      attrs[attr] = decodeEntities(xml.slice(k + 1, close));
      k = close + 1;
    }
    sawRoot = true;
    handler.open(name, attrs);
    if (empty) handler.close(name);
    else {
      stack.push(name);
      if (stack.length > maxDepth) throw new XmlError(`it nests elements more than ${maxDepth} deep`);
    }
    i = k;
  }
  if (stack.length) throw cut(`<${stack[stack.length - 1]}>`);
  if (!sawRoot) throw new XmlError('it holds no XML element');
}
