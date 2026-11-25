// A small, safe Markdown renderer for notes and messages: every character of the source is escaped first, and only
// the few constructs below turn into tags. Links go out only to http(s) and mailto; [[Note]] links become buttons the
// page wires to open that note.

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function inline(src: string): string {
  const codes: string[] = [];
  let s = escapeHtml(src).replace(/`([^`]+)`/g, (_, code: string) => {
    codes.push(`<code>${code}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s
    .replace(/\[\[([^\]|]{1,200})(?:\|([^\]]{1,200}))?\]\]/g, (_, target: string, label?: string) => {
      const t = target.trim();
      return `<button type="button" class="wikilink" data-note="${t}">${(label ?? t).trim()}</button>`;
    })
    .replace(/\[([^\]]{1,300})\]\(((?:https?:\/\/|mailto:)[^\s)]{1,2000})\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?=[^*\w]|$)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\s][^_]*)_(?=[^_\w]|$)/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)]!);
}

/** Renders Markdown to HTML. */
export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let para: string[] = [];
  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null;
  let quote: string[] = [];
  const line = inline;
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(line).join('<br>')}</p>`);
    para = [];
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${line(i)}</li>`).join('')}</${list.tag}>`);
    list = null;
    if (quote.length) out.push(`<blockquote>${quote.map(line).join('<br>')}</blockquote>`);
    quote = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const fence = /^```\s*([\w-]*)\s*$/.exec(l);
    if (fence) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^```\s*$/.test(lines[i]!); i++) code.push(lines[i]!);
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) {
      flush();
      const level = Math.min(6, h[1]!.length + 1);
      out.push(`<h${level}>${line(h[2]!)}</h${level}>`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) {
      flush();
      out.push('<hr>');
      continue;
    }
    const li = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(l);
    if (li) {
      const tag = li[1] ? 'ul' : 'ol';
      if (para.length || quote.length || (list && list.tag !== tag)) flush();
      list ??= { tag, items: [] };
      list.items.push(li[3]!);
      continue;
    }
    const q = /^\s*>\s?(.*)$/.exec(l);
    if (q) {
      if (para.length || list) flush();
      quote.push(q[1]!);
      continue;
    }
    if (!l.trim()) {
      flush();
      continue;
    }
    if (list || quote.length) flush();
    para.push(l);
  }
  flush();
  return out.join('\n');
}

/** Turns a search snippet ("…the [rye] loaf…") into safe HTML with the matches marked. */
export function snippetHtml(snippet: string): string {
  return escapeHtml(snippet.replace(/\s+/g, ' ')).replace(/\[([^\]]{1,200})\]/g, '<mark>$1</mark>');
}

/** The [[link]] targets in a note. */
export function wikiLinks(src: string): string[] {
  return [...src.matchAll(/\[\[([^\]|]{1,200})(?:\|[^\]]*)?\]\]/g)].map((m) => m[1]!.trim());
}

/** The [[ being typed just before the caret, if any: where it starts and what has been typed after it. */
export function openLink(text: string, caret: number): { start: number; typed: string } | null {
  const m = /\[\[([^\]\n[]{0,80})$/.exec(text.slice(0, caret));
  return m ? { start: caret - m[1]!.length, typed: m[1]! } : null;
}
