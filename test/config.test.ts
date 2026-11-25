import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configPath, DEFAULT_CONFIG, loadConfig, setConfigValue, unsetConfigValue } from '../src/config.ts';
import { keyShaped } from './samples.ts';

describe('config', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'skeinwise-config-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('uses the local engine on port 8731 until told otherwise', () => {
    expect(loadConfig(home)).toEqual(DEFAULT_CONFIG);
    expect(DEFAULT_CONFIG).toMatchObject({ engine: 'local', localUrl: 'http://127.0.0.1:8731/v1', redaction: true });
  });

  it('saves only what differs from the defaults, readable by the owner only', () => {
    setConfigValue(home, 'engine', 'none');
    setConfigValue(home, 'budget', '25000');
    setConfigValue(home, 'names', 'Sam, Alex Okafor');
    setConfigValue(home, 'redaction', 'off');
    expect(JSON.parse(readFileSync(configPath(home), 'utf8'))).toEqual({ engine: 'none', budget: 25000, redaction: false, names: ['Sam', 'Alex Okafor'] });
    expect(statSync(configPath(home)).mode & 0o777).toBe(0o600);
    unsetConfigValue(home, 'budget');
    expect(loadConfig(home).budget).toBe(DEFAULT_CONFIG.budget);
  });

  it('refuses values that would half-work', () => {
    expect(() => setConfigValue(home, 'engine', 'cloud')).toThrow(/local, remote, none/);
    expect(() => setConfigValue(home, 'budget', 'lots')).toThrow(/whole number/);
    expect(() => setConfigValue(home, 'apiKeyEnv', keyShaped('s', 'k-abc123-not-a-name'))).toThrow(/never the key itself/);
    expect(() => setConfigValue(home, 'modelOptions', '{temperature: 0}')).toThrow(/must be JSON/);
    expect(() => setConfigValue(home, 'colour', 'blue')).toThrow(/Unknown setting "colour"/);
    writeFileSync(configPath(home), '{"engine": "local", "port": 1}');
    expect(() => loadConfig(home)).toThrow(/unknown setting "port"/);
  });
});
