import { describe, expect, it } from 'vitest';
import { renderMarkdown, snippetHtml, wikiLinks } from '../../web/src/markdown.ts';

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

  it('marks search matches in snippets', () => {
    expect(snippetHtml('…the [rye] <loaf>…')).toBe('…the <mark>rye</mark> &lt;loaf&gt;…');
  });
});
