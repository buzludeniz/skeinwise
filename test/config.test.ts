import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configPath, DEFAULT_CONFIG, loadConfig, setConfigValue, unsetConfigValue } from '../src/config.ts';
import { keyShaped } from './samples.ts';
import { expectMode } from './modes.ts';

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
    expectMode(configPath(home), 0o600);
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

  // Security audit M11 (supply/07, the wire proof of concept part 3): any variable could be named as the key.
  it('reads a key only from a variable named for one', () => {
    for (const name of ['GITHUB_TOKEN', 'CLOUD_DEPLOY_SECRET', 'AWS_SECRET_ACCESS_KEY', 'SW_TEST_KEY', 'openai_api_key', 'HOME']) {
      expect(() => setConfigValue(home, 'apiKeyEnv', name), name).toThrow(/starts with SKEINWISE_ or ends with _API_KEY/);
    }
    for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'SKEINWISE_KEY', 'SKEINWISE_TEST_KEY']) {
      expect(setConfigValue(home, 'apiKeyEnv', name).apiKeyEnv).toBe(name);
    }
    writeFileSync(configPath(home), '{"apiKeyEnv": "GITHUB_TOKEN"}');
    expect(() => loadConfig(home)).toThrow(/"apiKeyEnv" must be/);
  });

  it('keeps confirmed hosts as their URL host, in lower case', () => {
    expect(setConfigValue(home, 'remoteHosts', 'API.OpenAI.com, https://models.example.net:8443/v1, [::1]:4000').remoteHosts).toEqual([
      'api.openai.com',
      'models.example.net:8443',
      '[::1]:4000',
    ]);
    expect(() => setConfigValue(home, 'remoteHosts', 'evil.example/path')).toThrow(/a list of hosts/);
    writeFileSync(configPath(home), '{"remoteHosts": "api.openai.com"}');
    expect(() => loadConfig(home)).toThrow(/a list of hosts/);
  });

  // Security audit M13 and L16 (supply/07 part C, the wire proof of concept part 4): modelOptions could replace the
  // model, the messages or the length of every request.
  it('takes only temperature, top_p and max_tokens as model options', () => {
    expect(setConfigValue(home, 'modelOptions', '{"temperature": 0.2, "top_p": 0.9, "max_tokens": 800}').modelOptions).toEqual({
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 800,
    });
    for (const bad of [
      '{"model": "other", "messages": [], "stream": true}',
      '{"n": 64}',
      '{"max_tokens": 0}',
      '{"max_tokens": 1.5}',
      '{"temperature": 5}',
      '{"top_p": "high"}',
      '[]',
    ]) {
      expect(() => setConfigValue(home, 'modelOptions', bad), bad).toThrow(/only temperature/);
    }
  });

  it('keeps llama-server as an absolute path, and the Downloads watch off until turned on', () => {
    expect(setConfigValue(home, 'llamaServer', '/opt/homebrew/bin/llama-server').llamaServer).toBe('/opt/homebrew/bin/llama-server');
    writeFileSync(configPath(home), '{"llamaServer": "llama-server"}');
    expect(() => loadConfig(home)).toThrow(/absolute path/);
    rmSync(configPath(home));
    expect(loadConfig(home).liveDownloads).toBe(false);
    expect(setConfigValue(home, 'liveDownloads', 'on').liveDownloads).toBe(true);
    expect(() => setConfigValue(home, 'liveDownloads', 'maybe')).toThrow(/true or false/);
  });

  it('can replace or unset a setting the file holds that no longer passes', () => {
    writeFileSync(configPath(home), '{"budget": 9, "apiKeyEnv": "GITHUB_TOKEN"}');
    expect(() => loadConfig(home)).toThrow(/"apiKeyEnv" must be/);
    setConfigValue(home, 'apiKeyEnv', 'OPENAI_API_KEY');
    expect(loadConfig(home)).toMatchObject({ budget: 9, apiKeyEnv: 'OPENAI_API_KEY' });
    writeFileSync(configPath(home), '{"budget": 9, "modelOptions": {"model": "x"}}');
    expect(() => setConfigValue(home, 'budget', '10')).toThrow(/"modelOptions" must be/);
    unsetConfigValue(home, 'modelOptions');
    expect(loadConfig(home)).toMatchObject({ budget: 9, modelOptions: {} });
  });
});
