import { describe, expect, it } from 'vitest';
import { engineLabel, entryBrief, entryHeader, indent, oneLine } from '../src/format.ts';
import type { Entry } from '../src/store/store.ts';

const entry = (over: Partial<Entry>): Entry => ({
  id: 7,
  sourceId: 1,
  sourceKind: 'chatgpt',
  sourceLabel: 'ChatGPT',
  threadId: 1,
  threadTitle: 'Sourdough',
  externalId: 'x',
  kind: 'message',
  speaker: 'you',
  title: null,
  createdAt: '2026-11-20T10:00:00.000Z',
  seq: 0,
  version: 1,
  body: '',
  ...over,
});

describe('an entry header', () => {
  it('names the speaker and the source', () => {
    expect(entryHeader(entry({}))).toBe('#7  2026-11-20  you · ChatGPT · Sourdough');
  });

  it('names an assistant by its source once', () => {
    expect(entryHeader(entry({ speaker: 'assistant' }))).toBe('#7  2026-11-20  ChatGPT · Sourdough');
  });
});

// M5: titles, file names and bodies come from imports, so every shared printer makes them safe to print.
describe('the shared printers with hostile imported text', () => {
  const ESC = '\u001b';
  const BEL = '\u0007';
  const hostile = `${ESC}]0;title-from-filename${BEL}${ESC}[2Jgarden\u202e`;

  it('print a header and a brief with no control, on one line', () => {
    expect(entryHeader(entry({ threadTitle: hostile }))).toBe('#7  2026-11-20  you · ChatGPT · garden');
    expect(entryHeader(entry({ threadTitle: null, title: `Plan\n#999  2020-01-01  you` }))).toBe(
      '#7  2026-11-20  you · ChatGPT · Plan #999  2020-01-01  you',
    );
    expect(entryHeader(entry({ speaker: 'assistant', sourceLabel: `Chat${ESC}[8mGPT` }))).toBe('#7  2026-11-20  ChatGPT · Sourdough');
    expect(entryBrief(entry({ threadTitle: hostile }))).toBe('#7  2026-11-20  you · garden');
  });

  it('indent a body and flatten a line with the escapes gone and the words kept', () => {
    expect(indent(`car.${ESC}[8m hidden${ESC}[0m\n${ESC}]52;c;cHduZWQ=${BEL}next`)).toBe('    car. hidden\n    next');
    expect(oneLine(`a${ESC}]8;;https://attacker.example/${BEL}link${ESC}]8;;${BEL}\n\tb`)).toBe('alink b');
    expect(engineLabel('remote', `qwen${ESC}[2J`)).toBe('remote model qwen');
  });
});
