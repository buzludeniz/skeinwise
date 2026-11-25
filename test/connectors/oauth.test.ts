import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Api } from '../../src/connectors/http.ts';
import { GOOGLE, renewToken, signIn, TODOIST } from '../../src/connectors/oauth.ts';
import { ConnectorError } from '../../src/connectors/types.ts';
import { UsageError } from '../../src/errors.ts';
import { approvingBrowser, fakeFetch, json, NOW, on } from './helpers.ts';

vi.mock('node:child_process', () => ({
  spawn: () => {
    throw new Error('No processes in this test');
  },
}));

const now = () => NOW;

describe('signing in with OAuth', () => {
  it('uses PKCE and a 127.0.0.1 redirect, and swaps the code for a token', async () => {
    let verifier = '';
    const fetch = fakeFetch([
      on('POST', GOOGLE.tokenUrl, (call) => {
        const form = new URLSearchParams(call.body);
        expect(form.get('grant_type')).toBe('authorization_code');
        expect(form.get('code')).toBe('test-auth-code');
        expect(form.get('client_id')).toBe('test-client.apps.example');
        expect(form.has('client_secret')).toBe(false);
        verifier = form.get('code_verifier')!;
        return json({ access_token: 'test-access-token', refresh_token: 'test-refresh-token', expires_in: 3599, scope: 'https://www.googleapis.com/auth/gmail.readonly' });
      }),
    ]);
    const seen: string[] = [];
    const said: string[] = [];
    const signed = await signIn({
      provider: GOOGLE,
      client: { id: 'test-client.apps.example' },
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      fetch,
      now,
      openUrl: approvingBrowser('test-auth-code', seen),
      say: (l) => said.push(l),
    });
    expect(signed.token).toEqual({ access: 'test-access-token', refresh: 'test-refresh-token', expiresAt: '2026-11-25T12:59:59.000Z' });
    expect(signed.granted).toEqual(['https://www.googleapis.com/auth/gmail.readonly']);
    const page = new URL(seen[0]!);
    expect(page.origin + page.pathname).toBe(GOOGLE.authorizeUrl);
    expect(page.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(page.searchParams.get('code_challenge_method')).toBe('S256');
    expect(page.searchParams.get('code_challenge')).toBe(createHash('sha256').update(verifier).digest('base64url'));
    expect(page.searchParams.get('access_type')).toBe('offline');
    expect(page.searchParams.get('response_type')).toBe('code');
    expect(said[0]).toContain("Opening Google's sign-in page");
  });

  it('turns away a request without this run’s state, and keeps waiting for the real one', async () => {
    const fetch = fakeFetch([on('POST', GOOGLE.tokenUrl, () => json({ access_token: 'test-access-token' }))]);
    let stranger = 0;
    const signed = await signIn({
      provider: GOOGLE,
      client: { id: 'test-client' },
      scopes: ['s'],
      fetch,
      now,
      say: () => {},
      openUrl: async (url) => {
        const back = new URL(new URL(url).searchParams.get('redirect_uri')!);
        back.searchParams.set('code', 'forged-code');
        back.searchParams.set('state', 'not-the-state');
        stranger = (await globalThis.fetch(back)).status;
        await approvingBrowser()(url);
      },
    });
    expect(stranger).toBe(400);
    expect(signed.token.access).toBe('test-access-token');
    expect(new URLSearchParams(fetch.calls[0]!.body).get('code')).toBe('test-auth-code');
  });

  it('stops with nothing connected when the person says no on the consent page', async () => {
    const fetch = fakeFetch([]);
    const attempt = signIn({
      provider: GOOGLE,
      client: { id: 'test-client' },
      scopes: ['s'],
      fetch,
      now,
      say: () => {},
      openUrl: async (url) => {
        const u = new URL(url);
        const back = new URL(u.searchParams.get('redirect_uri')!);
        back.searchParams.set('error', 'access_denied');
        back.searchParams.set('state', u.searchParams.get('state')!);
        await globalThis.fetch(back);
      },
    });
    await expect(attempt).rejects.toThrow(UsageError);
    await expect(attempt).rejects.toThrow('access_denied');
    expect(fetch.calls).toHaveLength(0);
  });

  it('gives up after the timeout when the browser never comes back', async () => {
    const attempt = signIn({ provider: GOOGLE, client: { id: 'c' }, scopes: ['s'], fetch: fakeFetch([]), now, say: () => {}, openUrl: async () => {}, timeoutMs: 50 });
    await expect(attempt).rejects.toThrow('No answer from Google');
  });

  it('needs a client secret for Todoist before opening anything', async () => {
    const openUrl = vi.fn(async () => {});
    await expect(signIn({ provider: TODOIST, client: { id: 'c' }, scopes: ['data:read'], fetch: fakeFetch([]), now, say: () => {}, openUrl })).rejects.toThrow(
      'needs your client secret',
    );
    expect(openUrl).not.toHaveBeenCalled();
  });
});

describe('renewing a token', () => {
  it('keeps Google’s refresh token, which Google doesn’t resend', async () => {
    const fetch = fakeFetch([on('POST', GOOGLE.tokenUrl, () => json({ access_token: 'test-access-2', expires_in: 3600 }))]);
    const t = await renewToken(GOOGLE, { id: 'c' }, { access: 'a', refresh: 'test-refresh-token' }, fetch, NOW, 'Gmail');
    expect(t).toEqual({ access: 'test-access-2', refresh: 'test-refresh-token', expiresAt: '2026-11-25T13:00:00.000Z' });
    expect(new URLSearchParams(fetch.calls[0]!.body).get('grant_type')).toBe('refresh_token');
  });

  it('takes Todoist’s new refresh token, since the old one stops working', async () => {
    const fetch = fakeFetch([on('POST', TODOIST.tokenUrl, () => json({ access_token: 'td-access-2', refresh_token: 'td-refresh-2', expires_in: 3600 }))]);
    const t = await renewToken(TODOIST, { id: 'c', secret: 'test-secret' }, { access: 'a', refresh: 'td-refresh-1' }, fetch, NOW, 'Todoist');
    expect(t.refresh).toBe('td-refresh-2');
    expect(new URLSearchParams(fetch.calls[0]!.body).get('client_secret')).toBe('test-secret');
  });

  it('says "connect again" when the refresh token was revoked', async () => {
    const fetch = fakeFetch([on('POST', GOOGLE.tokenUrl, () => json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400))]);
    const renewing = renewToken(GOOGLE, { id: 'c' }, { access: 'a', refresh: 'r' }, fetch, NOW, 'Gmail');
    await expect(renewing).rejects.toBeInstanceOf(ConnectorError);
    await expect(renewing).rejects.toMatchObject({ kind: 'signed-out' });
  });
});

describe('the API client', () => {
  const base = (fetch: typeof globalThis.fetch, extra = {}) =>
    new Api({ dialect: 'google', label: 'Gmail', token: { access: 'old-access', refresh: 'r', expiresAt: '2026-11-25T13:00:00.000Z' }, fetch, now, ...extra });

  it('renews on a 401 once and retries, and hands the new token over to be kept', async () => {
    const kept: string[] = [];
    const fetch = fakeFetch([
      on('GET', 'https://api.example/thing', (call) =>
        call.headers.get('authorization') === 'Bearer new-access' ? json({ ok: 1 }) : json({ error: { code: 401 } }, 401),
      ),
    ]);
    const api = base(fetch, { renew: async () => ({ access: 'new-access', refresh: 'r' }), onToken: async (t: { access: string }) => void kept.push(t.access) });
    expect(await api.get('https://api.example/thing')).toEqual({ ok: 1 });
    expect(kept).toEqual(['new-access']);
    expect(fetch.calls.map((c) => c.headers.get('authorization'))).toEqual(['Bearer old-access', 'Bearer new-access']);
    // The token goes in the header, never in the address.
    for (const c of fetch.calls) expect(c.url.toString()).not.toContain('access');
  });

  it('turns 429 and Retry-After into "slow down until"', async () => {
    const fetch = fakeFetch([on('GET', 'https://api.example/thing', () => json({}, 429, { 'retry-after': '120' }))]);
    await expect(base(fetch).get('https://api.example/thing')).rejects.toMatchObject({ kind: 'rate-limited', retryAt: '2026-11-25T12:02:00.000Z' });
  });

  it('reads Google’s 403 rateLimitExceeded as slow down, not as signed out', async () => {
    const fetch = fakeFetch([on('GET', 'https://api.example/thing', () => json({ error: { code: 403, errors: [{ reason: 'userRateLimitExceeded' }] } }, 403))]);
    await expect(base(fetch).get('https://api.example/thing')).rejects.toMatchObject({ kind: 'rate-limited' });
  });

  it('reads Slack’s ok:false answers', async () => {
    const slackApi = (body: unknown, headers = {}) =>
      new Api({ dialect: 'slack', label: 'Slack', token: { access: 'xoxp-test' }, now, fetch: fakeFetch([on('GET', 'https://slack.com/api/x', () => json(body, 200, headers))]) });
    await expect(slackApi({ ok: false, error: 'token_revoked' }).get('https://slack.com/api/x')).rejects.toMatchObject({ kind: 'signed-out' });
    await expect(slackApi({ ok: false, error: 'ratelimited' }, { 'retry-after': '30' }).get('https://slack.com/api/x')).rejects.toMatchObject({ kind: 'rate-limited' });
    await expect(slackApi({ ok: false, error: 'channel_not_found' }).get('https://slack.com/api/x')).rejects.toThrow('Slack said channel_not_found');
  });

  it('says the service is down rather than crashing when the network fails', async () => {
    const fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof globalThis.fetch;
    await expect(base(fetch).get('https://api.example/thing')).rejects.toMatchObject({ kind: 'unavailable' });
  });
});
