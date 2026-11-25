import { describe, expect, it } from 'vitest';
import { entryHeader } from '../src/format.ts';
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
