import { describe, expect, it } from 'vitest';
import { renderMarkdown, snippetHtml, snippetText, wikiLinks } from '../../web/src/markdown.ts';

describe('the Markdown renderer', () => {
  it('renders headings, paragraphs, lists, quotes and code', () => {
    const html = renderMarkdown('# Title\n\nSome **bold** and *soft* words.\n\n- one\n- two\n\n1. first\n\n> said\n\n```\nx < 1\n```');
    expect(html).toContain('<h2>Title</h2>');
    expect(html).toContain('<p>Some <strong>bold</strong> and <em>soft</em> words.</p>');
    expect(html).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(html).toContain('<ol><li>first</li></ol>');
    expect(html).toContain('<blockquote>said</blockquote>');
    expect(html).toContain('<pre><code>x &lt; 1</code></pre>');
  });

  it('escapes HTML and refuses unsafe links', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> [a](javascript:alert(1)) [b](https://example.org/x)');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('<a href="https://example.org/x" target="_blank" rel="noopener noreferrer">b</a>');
  });

  it('turns [[links]] into note buttons, escaped', () => {
    expect(renderMarkdown('See [[Job search]] and [[Plot "A"|the plot]].')).toContain(
      '<button type="button" class="wikilink" data-note="Job search">Job search</button>',
    );
    expect(renderMarkdown('[[Plot "A"|the plot]]')).toContain('data-note="Plot &quot;A&quot;">the plot</button>');
    expect(wikiLinks('a [[One]] b [[Two|2]]')).toEqual(['One', 'Two']);
  });

  it("marks the matches of 1.0's search, which brackets them", () => {
    expect(snippetHtml('…the [rye] <loaf>…')).toBe('…the <mark>rye</mark> &lt;loaf&gt;…');
    expect(snippetHtml('[rye] and [spelt]')).toBe('<mark>rye</mark> and <mark>spelt</mark>');
  });

  it('marks search matches in snippets', () => {
    expect(snippetHtml('…the \u0002rye\u0003 <loaf>…')).toBe('…the <mark>rye</mark> &lt;loaf&gt;…');
    expect(snippetHtml('\u0002rye\u0003 and \u0002spelt\u0003')).toBe('<mark>rye</mark> and <mark>spelt</mark>');
  });

  it('shows brackets as the note has them in a snippet marked with control characters', () => {
    // A [[link]] once came out as a highlighted "[link" and a stray "]".
    expect(snippetHtml('…moved to [[Postgres]] for the \u0002waiting\u0003 list…')).toBe(
      '…moved to [[Postgres]] for the <mark>waiting</mark> list…',
    );
    expect(snippetHtml('[a] \u0002b\u0003')).toBe('[a] <mark>b</mark>');
  });

  it('drops a mark left without its pair', () => {
    expect(snippetHtml('…the \u0002rye loaf…')).toBe('…the rye loaf…');
    expect(snippetHtml('rye\u0003 <loaf>')).toBe('rye &lt;loaf&gt;');
  });

  it('gives a snippet as plain text without its marks', () => {
    expect(snippetText('…the \u0002rye\u0003\n loaf [[Bread]]…')).toBe('…the rye loaf [[Bread]]…');
  });
});
