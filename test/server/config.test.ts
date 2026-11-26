import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.ts';
import { ConfigError, DEFAULT_CONFIG, readConfig, writeConfig } from '../../src/server/config.ts';
import { loadToken, sameToken } from '../../src/server/token.ts';
import { expectMode } from '../modes.ts';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'skeinwise-config-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('settings', () => {
  it('starts from the defaults', () => {
    expect(readConfig(home)).toEqual(DEFAULT_CONFIG);
  });

  it('merges a patch, keeps keys it does not know, and writes owner-only', () => {
    writeFileSync(join(home, 'app.json'), JSON.stringify({ later: { schedule: 'nightly' } }));
    const next = writeConfig(home, { appearance: { theme: 'paper' }, brain: { pointSize: 1.5 } });
    expect(next.appearance).toEqual({ theme: 'paper', palette: 'ember' });
    expect(next.brain.pointSize).toBe(1.5);
    const raw = JSON.parse(readFileSync(join(home, 'app.json'), 'utf8')) as Record<string, unknown>;
    expect(raw.later).toEqual({ schedule: 'nightly' });
    expectMode(join(home, 'app.json'), 0o600);
    expect(existsSync(join(home, 'config.json'))).toBe(false);
  });

  it("keeps the engine, models, cap and redaction in the organiser's config.json", () => {
    const next = writeConfig(home, { ai: { engine: 'none', local: { model: 'small.gguf' } }, usageCap: { monthlyTokens: 5000 }, exclusions: { redact: false }, brain: { labels: false } });
    expect(next.ai.engine).toBe('none');
    expect(next.ai.local.model).toBe('small.gguf');
    expect(next.usageCap.monthlyTokens).toBe(5000);
    expect(next.exclusions.redact).toBe(false);
    expect(next.brain.labels).toBe(false);
    expect(loadConfig(home)).toMatchObject({ engine: 'none', localModel: 'small.gguf', budget: 5000, redaction: false });
    const app = JSON.parse(readFileSync(join(home, 'app.json'), 'utf8')) as Record<string, unknown>;
    expect(app).toEqual({ brain: { labels: false } });
    // A setting the CLI wrote shows in the app.
    writeFileSync(join(home, 'config.json'), JSON.stringify({ engine: 'remote', remoteUrl: 'https://example.test/v1' }));
    expect(readConfig(home).ai).toMatchObject({ engine: 'remote', remote: { address: 'https://example.test/v1' } });
    // The organiser's own checks apply.
    expect(() => writeConfig(home, { ai: { remote: { keyEnv: 'sk-not a name' } } })).toThrow(ConfigError);
  });

  it("keeps Record live's folders and switches in config.json, under the organiser's keys", () => {
    const next = writeConfig(home, { live: { folders: [{ path: '/notes' }, { path: '/mara', owner: ' Mara ' }], organise: false, remote: true } });
    expect(next.live).toEqual({ folders: [{ path: '/notes' }, { path: '/mara', owner: 'Mara' }], organise: false, remote: true });
    expect(loadConfig(home)).toMatchObject({ liveFolders: [{ path: '/notes' }, { path: '/mara', owner: 'Mara' }], liveOrganise: false, liveRemote: true });
    expect(existsSync(join(home, 'app.json'))).toBe(false);
    expect(() => writeConfig(home, { live: { folders: [{ path: ' ' }] } })).toThrow(ConfigError);
    expect(() => writeConfig(home, { live: { folders: ['/notes'] } })).toThrow(ConfigError);
  });

  it('refuses values of the wrong type or outside the lists', () => {
    expect(() => writeConfig(home, { appearance: { theme: 'neon' } })).toThrow(ConfigError);
    expect(() => writeConfig(home, { brain: { pointSize: 'big' } })).toThrow(ConfigError);
    expect(() => writeConfig(home, { brain: { pointSize: 99 } })).toThrow(ConfigError);
    expect(() => writeConfig(home, { nonsense: true })).toThrow(ConfigError);
    expect(() => writeConfig(home, [])).toThrow(ConfigError);
  });

  it('falls back to the default for a bad value already in the file', () => {
    writeFileSync(join(home, 'app.json'), JSON.stringify({ appearance: { theme: 'neon', palette: 'tide' }, brain: { pointSize: 'x' } }));
    const c = readConfig(home);
    expect(c.appearance).toEqual({ theme: 'dusk', palette: 'tide' });
    expect(c.brain.pointSize).toBe(1);
  });

  it('keeps bring-in choices per path', () => {
    writeConfig(home, { bringIn: { '/a': 'in' } });
    expect(writeConfig(home, { bringIn: { '/b': 'later' } }).bringIn).toEqual({ '/a': 'in', '/b': 'later' });
    expect(() => writeConfig(home, { bringIn: { '/c': 'maybe' } })).toThrow(ConfigError);
  });
});

describe('the access token', () => {
  it('is made once, kept owner-only and compared safely', () => {
    const token = loadToken(home);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(loadToken(home)).toBe(token);
    expectMode(join(home, 'token'), 0o600);
    expect(sameToken(token, token)).toBe(true);
    expect(sameToken(undefined, token)).toBe(false);
    expect(sameToken('', token)).toBe(false);
    expect(sameToken(`${token.slice(0, -1)}0`.replace(/.$/, token.endsWith('0') ? '1' : '0'), token)).toBe(false);
    expect(sameToken(token.slice(0, 10), token)).toBe(false);
  });
});
