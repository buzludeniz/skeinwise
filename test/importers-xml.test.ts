// The XML scanner behind the .docx reader (LS-06): what it reports, what it refuses, and that it stays linear.

import { describe, expect, it } from 'vitest';
import { decodeEntities, scanXml, XmlError, type XmlAttrs } from '../src/importers/xml.ts';

type Event = ['open', string, Record<string, string>] | ['close', string] | ['text', string];

function events(xml: string, maxDepth?: number): Event[] {
  const out: Event[] = [];
  scanXml(
    xml,
    {
      open: (name, attrs: XmlAttrs) => out.push(['open', name, { ...attrs }]),
      close: (name) => out.push(['close', name]),
      text: (text) => out.push(['text', text]),
    },
    maxDepth,
  );
  return out;
}

function damage(xml: string, maxDepth?: number): string {
  try {
    events(xml, maxDepth);
  } catch (error) {
    if (error instanceof XmlError) return error.message;
    throw error;
  }
  throw new Error('expected the XML to be refused');
}

describe('scanXml', () => {
  it('reports elements, attributes and text, skipping the declaration, comments and outside text', () => {
    const xml = '﻿<?xml version="1.0"?>\n<!-- c --><a x="1" y=\'two &amp; &#x41;\'>hi <b/><![CDATA[<raw>&amp;]]></a>\n';
    expect(events(xml)).toEqual([
      ['open', 'a', { x: '1', y: 'two & A' }],
      ['text', 'hi '],
      ['open', 'b', {}],
      ['close', 'b'],
      ['text', '<raw>&amp;'],
      ['close', 'a'],
    ]);
  });

  it('refuses a DTD and an entity declaration before reading on', () => {
    expect(damage('<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>')).toBe('it declares a DTD or an entity, which Skeinwise never reads');
    expect(damage('<a><!ENTITY x "y"></a>')).toMatch(/declares a DTD/);
  });

  it('refuses XML cut short anywhere, by where it stops', () => {
    expect(damage('<a><b>text')).toBe('it is cut short inside <b>');
    expect(damage('<a x="1')).toBe('it is cut short inside <a>');
    expect(damage('<a x')).toBe('it is cut short inside <a>');
    expect(damage('<a><!-- never')).toBe('it is cut short inside a comment');
    expect(damage('<a><![CDATA[ never')).toBe('it is cut short inside a CDATA section');
    expect(damage('<?xml version')).toBe('it is cut short inside a processing instruction');
    expect(damage('<a></a')).toBe('it is cut short inside a closing tag');
    expect(damage('<a/')).toBe('it is cut short inside <a>');
    expect(damage('<')).toBe('it is cut short inside a tag');
    expect(damage('')).toBe('it holds no XML element');
  });

  it('refuses tags that do not nest, a second root, and stray markup', () => {
    expect(damage('<a><b></a></b>')).toBe('it closes <a> where <b> is open');
    expect(damage('</a>')).toBe('it closes <a>, which was never opened');
    expect(damage('<a/><b/>')).toBe('it has a second root element, <b>');
    expect(damage('<a>< b</a>')).toMatch(/starts no tag/);
    expect(damage('<a x=1/>')).toBe("<a>'s attribute x isn't quoted");
    expect(damage('<a x/>')).toBe("<a>'s attribute x has no value");
    expect(damage('<a / >')).toBe('<a> has a "/" out of place');
    expect(damage('<a ="1"/>')).toBe('<a> has an attribute without a name');
  });

  it('refuses nesting past the depth limit', () => {
    expect(damage('<a>'.repeat(11) + '</a>'.repeat(11), 10)).toBe('it nests elements more than 10 deep');
    expect(events('<a>'.repeat(10) + '</a>'.repeat(10), 10)).toHaveLength(20);
  });

  it('keeps __proto__ and constructor as plain attribute names', () => {
    let seen: XmlAttrs | undefined;
    scanXml('<a __proto__="p" constructor="c" toString="t"/>', { open: (_, attrs) => (seen = attrs), close() {}, text() {} });
    expect(Object.getPrototypeOf(seen)).toBeNull();
    expect(Object.entries(seen!)).toEqual([
      ['__proto__', 'p'],
      ['constructor', 'c'],
      ['toString', 't'],
    ]);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it('stays linear on input built to make a scanner backtrack', () => {
    const n = 200_000;
    const inputs = [
      '<'.repeat(n),
      `<a>${'&'.repeat(n)}</a>`,
      `<a>${'&#'.repeat(n / 2)}</a>`,
      `<a ${'x="1" '.repeat(n / 6)}/>`.replace(/x="1" /g, (_, i: number) => `x${i}="1" `),
      `<a>${'<!--'.repeat(n / 4)}`,
      `<a>${'<b>'.repeat(n / 3)}`,
      `<a x="${'"'.repeat(1)}${' '.repeat(n)}`,
      `<a>${'<![CDATA['.repeat(n / 9)}`,
      `<a>${'</'.repeat(n / 2)}`,
    ];
    for (const xml of inputs) {
      const started = performance.now();
      try {
        events(xml, Number.MAX_SAFE_INTEGER);
      } catch (error) {
        if (!(error instanceof XmlError)) throw error;
      }
      expect(performance.now() - started, xml.slice(0, 20)).toBeLessThan(1000);
    }
  });
});

describe('decodeEntities', () => {
  it("decodes XML's five entities and numeric references, and leaves anything else as written", () => {
    expect(decodeEntities('&lt;&gt;&amp;&quot;&apos;')).toBe('<>&"\'');
    expect(decodeEntities('&#65;&#x42;&#X43;&#x1F331;')).toBe('ABC\u{1F331}');
    expect(decodeEntities('&nbsp; &copy; & &; &#; &#x; &#xZZ; &amp')).toBe('&nbsp; &copy; & &; &#; &#x; &#xZZ; &amp');
  });

  it('replaces a reference to a character XML does not allow', () => {
    expect(decodeEntities('&#0;&#8;&#xD800;&#xFFFE;&#x110000;')).toBe('�'.repeat(5));
    expect(decodeEntities('&#9;&#10;&#13;')).toBe('\t\n\r');
  });
});
