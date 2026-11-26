import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../../src/config.ts';
import { CLI_ONLY, CliOnly, ConfigError, DEFAULT_CONFIG, readConfig, writeConfig } from '../../src/server/config.ts';
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

  it("keeps the models and cap in the organiser's config.json", () => {
    const next = writeConfig(home, { ai: { local: { model: 'small.gguf' } }, usageCap: { monthlyTokens: 5000 }, brain: { labels: false } });
    expect(next.ai.local.model).toBe('small.gguf');
    expect(next.usageCap.monthlyTokens).toBe(5000);
    expect(next.brain.labels).toBe(false);
    expect(loadConfig(home)).toMatchObject({ localModel: 'small.gguf', budget: 5000 });
    const app = JSON.parse(readFileSync(join(home, 'app.json'), 'utf8')) as Record<string, unknown>;
    expect(app).toEqual({ brain: { labels: false } });
    // A setting the CLI wrote shows in the app.
    writeFileSync(join(home, 'config.json'), JSON.stringify({ engine: 'remote', remoteUrl: 'https://example.test/v1', remoteHosts: ['example.test'] }));
    expect(readConfig(home).ai).toMatchObject({ engine: 'remote', remote: { address: 'https://example.test/v1', hosts: ['example.test'] } });
    // The organiser's own checks apply.
    expect(() => writeConfig(home, { ai: { local: { address: 'not an address' } } })).toThrow(ConfigError);
  });

  it("keeps Record live's switch in config.json, and shows the folders the CLI chose", () => {
    const next = writeConfig(home, { live: { organise: false } });
    expect(next.live).toEqual({ folders: [], organise: false, remote: false, downloads: false });
    expect(loadConfig(home)).toMatchObject({ liveOrganise: false });
    expect(existsSync(join(home, 'app.json'))).toBe(false);
    // The organiser resolves the folders, so on Windows /notes comes back as D:\notes: the test writes them resolved.
    const folders = [{ path: resolve('/notes') }, { path: resolve('/mara'), owner: 'Mara' }];
    writeFileSync(join(home, 'config.json'), JSON.stringify({ liveFolders: folders, liveDownloads: true }));
    expect(readConfig(home).live).toEqual({ folders, organise: true, remote: false, downloads: true });
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


describe('SETTINGS-1: where your words go is set in the terminal only', () => {
  const changes: Record<string, unknown> = {
    'ai.engine': 'remote',
    'ai.remote.address': 'https://collector.attacker.invalid/v1',
    'ai.remote.hosts': ['collector.attacker.invalid'],
    'ai.remote.keyEnv': 'SKEINWISE_STOLEN_API_KEY',
    'exclusions.redact': false,
    'live.folders': [{ path: '/Users/someone/.ssh' }],
    'live.remote': true,
    'live.downloads': true,
  };
  const patch = (path: string, value: unknown): Record<string, unknown> =>
    path.split('.').reduceRight<unknown>((inner, key) => ({ [key]: inner }), value) as Record<string, unknown>;

  it('refuses a change to each, writes nothing, and names the command without the value sent', () => {
    expect(Object.keys(changes).sort()).toEqual(Object.keys(CLI_ONLY).sort());
    for (const [path, value] of Object.entries(changes)) {
      let error: unknown;
      try {
        writeConfig(home, { appearance: { theme: 'paper' }, ...patch(path, value) });
      } catch (e) {
        error = e;
      }
      expect(error, path).toBeInstanceOf(CliOnly);
      expect((error as CliOnly).command).toBe(CLI_ONLY[path]);
      expect((error as CliOnly).message).not.toContain('attacker');
      expect((error as CliOnly).message).not.toContain('STOLEN');
      expect((error as CliOnly).message).not.toContain('.ssh');
    }
    expect(existsSync(join(home, 'config.json'))).toBe(false);
    expect(existsSync(join(home, 'app.json'))).toBe(false);
  });

  it('lets the page send back the values it was shown', () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ engine: 'none', redaction: false, liveFolders: [{ path: '/notes', owner: 'Mara' }], remoteHosts: ['models.example.net'] }));
    const shown = readConfig(home);
    const next = writeConfig(home, { ai: shown.ai, live: shown.live, exclusions: shown.exclusions, appearance: { theme: 'paper' } });
    expect(next.ai.engine).toBe('none');
    expect(next.exclusions.redact).toBe(false);
    expect(next.appearance.theme).toBe('paper');
    expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))).toMatchObject({ engine: 'none', redaction: false, remoteHosts: ['models.example.net'] });
    expect(() => writeConfig(home, { ai: { ...shown.ai, engine: 'local' } })).toThrow(CliOnly);
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
