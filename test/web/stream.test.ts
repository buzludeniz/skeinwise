// The page's reader for GET /api/ask/stream (web/src/api.ts): events cut anywhere between chunks arrive whole and in
// order, the token goes with the request, stopping it closes the connection, and a refusal reads like any other call's.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keyShaped } from '../samples.ts';

const TOKEN = keyShaped('0123456789abcdef', '0123456789abcdef', '0123456789abcdef', '0123456789abcdef');

/** A body that sends these chunks, as bytes, one read at a time. */
function body(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      c.close();
    },
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('location', { hash: `#token=${TOKEN}`, pathname: '/', search: '' });
  vi.stubGlobal('history', { replaceState: () => {} });
  vi.stubGlobal('localStorage', { removeItem: () => {} });
});
afterEach(() => vi.unstubAllGlobals());

describe('readEvents', () => {
  it('gives each event whole, however the body is cut', async () => {
    const { readEvents } = await import('../../web/src/api.ts');
    const bytes = new TextEncoder().encode('data: {"type":"text","text":"café ☕"}\n\n');
    const split = bytes.indexOf(0xe2) + 1; // inside the cup's three bytes
    const events: unknown[] = [];
    await readEvents(
      body(['data: {"type":"hits"', ',"n":1}\n', '\n: a comment line\n\ndata: {"type":"status","line":"Writing"}\n\n', bytes.slice(0, split), bytes.slice(split)]),
      (e) => events.push(e),
    );
    expect(events).toEqual([
      { type: 'hits', n: 1 },
      { type: 'status', line: 'Writing' },
      { type: 'text', text: 'café ☕' },
    ]);
  });
});

describe('api.stream', () => {
  it('sends the token, hands over each event, and stops when asked', async () => {
    const { api, initToken } = await import('../../web/src/api.ts');
    initToken();
    const sent: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return new Response(body(['data: {"type":"hits"}\n\ndata: {"type":"done"}\n\n']), { headers: { 'content-type': 'text/event-stream' } });
    });
    const stop = new AbortController();
    const events: unknown[] = [];
    await api.stream('ask/stream?q=rye', (e) => events.push(e), stop.signal);
    expect(events).toEqual([{ type: 'hits' }, { type: 'done' }]);
    expect(sent[0]!.url).toBe('/api/ask/stream?q=rye');
    expect((sent[0]!.init.headers as Record<string, string>)['X-Skeinwise-Token']).toBe(TOKEN);
    expect(sent[0]!.init.signal).toBe(stop.signal);
  });

  it('rejects with the AbortError when stopped mid-stream', async () => {
    const { api } = await import('../../web/src/api.ts');
    const stop = new AbortController();
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(encoder.encode('data: {"type":"text","text":"Rye"}\n\n'));
            init.signal!.addEventListener('abort', () => c.error(init.signal!.reason));
          },
        }),
      );
    });
    const events: unknown[] = [];
    const done = api.stream('ask/stream?q=rye', (e) => {
      events.push(e);
      stop.abort();
    }, stop.signal);
    await expect(done).rejects.toMatchObject({ name: 'AbortError' });
    expect(events).toEqual([{ type: 'text', text: 'Rye' }]);
  });

  it('refuses like any other call: the server’s message, and the lock listeners told', async () => {
    const { api, ApiError, onLocked } = await import('../../web/src/api.ts');
    let locked = 0;
    onLocked(() => (locked += 1));
    vi.stubGlobal('fetch', async () => Response.json({ error: 'Ask a question.' }, { status: 400 }));
    await expect(api.stream('ask/stream?q=', () => {})).rejects.toEqual(new ApiError(400, 'Ask a question.'));
    vi.stubGlobal('fetch', async () => new Response('locked', { status: 423 }));
    const refused = await api.stream('ask/stream?q=rye', () => {}).catch((e: unknown) => e);
    expect(refused).toMatchObject({ status: 423, message: 'The server answered 423' });
    expect(locked).toBe(1);
  });
});
