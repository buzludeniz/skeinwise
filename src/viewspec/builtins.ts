// The built-in views: the ones that exist with no model at all, and what a view falls back to when the model's spec
// doesn't pass. closestBuiltin picks the one nearest to what was asked, from the spec's fields that did pass and the
// words of the request.

import type { Salvage, ViewSpec } from './spec.ts';

export interface Builtin {
  id: string;
  spec: ViewSpec;
  /** Words in a request that point at this view, singular and lower case. */
  words: readonly string[];
}

export const BUILTINS: readonly Builtin[] = [
  { id: 'by-month', spec: { v: 1, title: 'Entries by month', show: 'chart', form: 'bars', x: 'time' }, words: ['month', 'time', 'entry', 'activity', 'busy', 'when', 'how', 'many', 'count'] },
  { id: 'sources-by-month', spec: { v: 1, title: 'Each source by month', show: 'chart', form: 'lines', x: 'time', y: 'source' }, words: ['source', 'app', 'chat', 'import', 'where', 'from'] },
  { id: 'speakers-by-month', spec: { v: 1, title: 'You and the assistants by month', show: 'chart', form: 'stacked', x: 'time', y: 'speaker' }, words: ['speaker', 'you', 'assistant', 'ai', 'who', 'said', 'asked', 'talked'] },
  { id: 'projects-over-time', spec: { v: 1, title: 'Projects over time', show: 'chart', form: 'heatmap', x: 'time', y: 'project' }, words: ['project', 'work'] },
  { id: 'tags-by-month', spec: { v: 1, title: 'Tags by month', show: 'chart', form: 'heatmap', x: 'time', y: 'tag' }, words: ['tag', 'topic', 'mood', 'theme', 'subject'] },
  { id: 'folders-by-source', spec: { v: 1, title: 'Folders by source', show: 'chart', form: 'table', x: 'folder', y: 'source' }, words: ['folder', 'filed', 'inbox', 'table'] },
  { id: 'newest', spec: { v: 1, title: 'Newest entries', show: 'list', sort: 'newest', limit: 50 }, words: ['newest', 'latest', 'recent', 'recently', 'last', 'new', 'list', 'today', 'week'] },
  { id: 'notes', spec: { v: 1, title: 'Your notes', show: 'list', where: [{ prop: 'kind', is: 'note' }], sort: 'newest', limit: 100 }, words: ['note', 'journal', 'wrote', 'down', 'idea'] },
];

export function builtin(id: string): Builtin | undefined {
  return BUILTINS.find((b) => b.id === id);
}

function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!t) continue;
    out.add(t);
    if (t.length > 3 && t.endsWith('s')) out.add(t.slice(0, -1));
  }
  return out;
}

/**
 * The built-in view nearest to a request: by the fields of the spec that passed (what to show, the axes, the form,
 * the filters), then by the words of the request and the spec's title. A tie goes to the earlier view, so a request
 * with nothing to go by gets entries by month.
 */
export function closestBuiltin(salvage: Salvage, request = ''): Builtin {
  const words = tokens(`${request} ${salvage.title ?? ''}`);
  for (const p of [salvage.x, salvage.y, ...(salvage.where ?? []).map((w) => (w.prop === 'kind' ? w.is : w.prop))]) if (p) words.add(p);
  let best = BUILTINS[0]!;
  let bestScore = -1;
  for (const b of BUILTINS) {
    const s = b.spec;
    let score = 0;
    if (salvage.show === s.show) score += 3;
    if (s.show === 'chart') {
      if (salvage.x === s.x) score += 2;
      if (salvage.y !== undefined && salvage.y === s.y) score += 2;
      if (salvage.form === s.form) score += 1;
    } else if (salvage.sort === s.sort) score += 1;
    for (const w of b.words) if (words.has(w)) score += 2;
    if (score > bestScore) {
      best = b;
      bestScore = score;
    }
  }
  return best;
}
