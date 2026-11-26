// L9, the page's side: the token lives in the page's memory only, never in storage, and leaves the address bar.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keyShaped } from '../samples.ts';

const TOKEN = keyShaped('0123456789abcdef', '0123456789abcdef', '0123456789abcdef', '0123456789abcdef');
let stored: Map<string, string>;
let replaced: string[];

function page(hash: string) {
  stored = new Map([['skeinwise.token', keyShaped('fedcba9876543210'.repeat(4))]]);
  replaced = [];
  vi.stubGlobal('location', { hash, pathname: '/', search: '' });
  vi.stubGlobal('history', { replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url) });
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, v),
    removeItem: (k: string) => void stored.delete(k),
  });
}

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe('the page token (L9)', () => {
  it('takes the token from the address, clears it there, and stores it nowhere', async () => {
    page(`#token=${TOKEN}`);
    const { api, initToken } = await import('../../web/src/api.ts');
    expect(initToken()).toBe(TOKEN);
    expect(replaced).toEqual(['/']);
    expect(stored.size).toBe(0);
    const sent: Record<string, string>[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: { headers: Record<string, string> }) => {
      sent.push(init.headers);
      return new Response('{}', { status: 200 });
    });
    await api.get('status');
    expect(sent[0]!['X-Skeinwise-Token']).toBe(TOKEN);
  });

  it('has no token after a reload, and drops one an older build stored', async () => {
    page('');
    const { initToken } = await import('../../web/src/api.ts');
    expect(initToken()).toBeNull();
    expect(stored.has('skeinwise.token')).toBe(false);
    expect(replaced).toEqual([]);
  });
});
