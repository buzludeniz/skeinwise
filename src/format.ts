// Plain-text formatting shared by the commands.

import type { Entry } from './store/store.ts';

export function day(iso: string): string {
  return iso.slice(0, 10);
}

export function minute(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ');
}

export function speakerLabel(e: Entry): string {
  return e.speaker === 'assistant' ? `${e.sourceLabel}` : e.speaker;
}

export function entryHeader(e: Entry): string {
  const where = e.threadTitle ? ` · ${e.threadTitle}` : e.title ? ` · ${e.title}` : '';
  const speaker = speakerLabel(e);
  // An assistant's line is already labelled with its source ("ChatGPT"); don't say it twice.
  const source = speaker === e.sourceLabel ? '' : ` · ${e.sourceLabel}`;
  return `#${e.id}  ${day(e.createdAt)}  ${speaker}${source}${where}`;
}

export function indent(text: string, pad = '    '): string {
  return text
    .split('\n')
    .map((l) => (l ? pad + l : l))
    .join('\n');
}

/** One line of text, cut to a length. */
export function oneLine(text: string, max = 100): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** "topics 12, tagged 400" */
export function countsText(counts: Record<string, number>): string {
  return Object.entries(counts)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
}

/** "#345  2026-04-05  you · Plotline" */
export function entryBrief(e: Entry): string {
  const where = e.threadTitle ?? e.title;
  return `#${e.id}  ${day(e.createdAt)}  ${speakerLabel(e)}${where ? ` · ${oneLine(where, 60)}` : ''}`;
}

/** How an engine is named to you: No-AI, a local or remote model, or you (a correction). */
export function engineLabel(engine: string, model: string | null): string {
  if (engine === 'none') return 'No-AI';
  if (engine === 'you') return 'by you';
  return model ? `${engine} model ${model}` : `${engine} model`;
}
