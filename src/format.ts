// Plain-text formatting shared by the commands.

import { safeBlock, safeLine } from './safe-text.ts';
import type { Entry } from './store/store.ts';

export function day(iso: string): string {
  return iso.slice(0, 10);
}

export function minute(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ');
}

export function speakerLabel(e: Entry): string {
  return safeLine(e.speaker === 'assistant' ? e.sourceLabel : e.speaker);
}

/** "#345  2026-04-05  you · ChatGPT · Plotline". Titles come from imports, so they are made safe to print. */
export function entryHeader(e: Entry): string {
  const where = e.threadTitle ? ` · ${safeLine(e.threadTitle)}` : e.title ? ` · ${safeLine(e.title)}` : '';
  const speaker = speakerLabel(e);
  // An assistant's line is already labelled with its source ("ChatGPT"); don't say it twice.
  const source = speaker === safeLine(e.sourceLabel) ? '' : ` · ${safeLine(e.sourceLabel)}`;
  return `#${e.id}  ${day(e.createdAt)}  ${speaker}${source}${where}`;
}

/** Text indented under a header, made safe to print. */
export function indent(text: string, pad = '    '): string {
  return safeBlock(text)
    .split('\n')
    .map((l) => (l ? pad + l : l))
    .join('\n');
}

/** One line of text, made safe to print and cut to a length. */
export function oneLine(text: string, max = 100): string {
  const flat = safeLine(text).replace(/\s+/g, ' ').trim();
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
  return model ? `${safeLine(engine)} model ${safeLine(model)}` : `${safeLine(engine)} model`;
}
