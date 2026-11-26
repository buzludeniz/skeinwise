// Undoing a run in the page says, as `skeinwise undo` does, when a note it put back is a Word document: Skeinwise
// doesn't write Word files, so the record has the earlier text and the file is left as it was.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('location', { hash: '', pathname: '/', search: '' });
  vi.stubGlobal('history', { replaceState: () => {} });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function server(word: string[] | undefined): string[] {
  const asked: string[] = [];
  vi.stubGlobal('fetch', async (url: string, init: { method: string }) => {
    asked.push(`${init.method} ${url}`);
    return new Response(JSON.stringify({ restored: [3], purged: [], ...(word ? { word } : {}) }), { status: 200 });
  });
  return asked;
}

describe('undoing a run in the page', () => {
  it('names each Word document it left as it was', async () => {
    const asked = server(['notes/Garden plan.docx']);
    const { postRunUndo } = await import('../../web/src/actions.ts');
    const { getState } = await import('../../web/src/store.ts');
    await postRunUndo(7);
    expect(asked).toEqual(['POST /api/runs/7/undo']);
    expect(getState().toasts.map((t) => t.text)).toEqual([
      'notes/Garden plan.docx is a Word document, which Skeinwise doesn’t write, so it was left as it is.',
    ]);
  });

  it('says nothing more when no note is a Word document', async () => {
    server([]);
    const { postRunUndo } = await import('../../web/src/actions.ts');
    const { getState } = await import('../../web/src/store.ts');
    await postRunUndo(7);
    expect(getState().toasts).toEqual([]);
  });
});
