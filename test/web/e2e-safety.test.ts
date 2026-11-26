// The e2e run serves its own invented record and never reaches the app or the model server already running on this
// computer: no fixed port of theirs, and the record's model address is set to a closed port before anything runs. The
// run folder it empties is one it made, never a folder SKEINWISE_E2E_RUN names by mistake.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { freshRunFolder, RUN_MARK } from '../../e2e/run.ts';

const E2E = join(import.meta.dirname, '..', '..', 'e2e');
const read = (name: string) => readFileSync(join(E2E, name), 'utf8');

describe('the e2e harness', () => {
  it("names neither the app's port nor the model server's", () => {
    for (const name of readdirSync(E2E).filter((n) => n.endsWith('.ts'))) {
      expect(read(name), name).not.toMatch(/\b(7319|8731)\b/);
    }
  });

  it('points the record at a closed model port before it organises or serves', () => {
    const serve = read('serve.ts');
    const at = (text: string) => serve.indexOf(text);
    expect(at("'config', 'localUrl'")).toBeGreaterThan(0);
    expect(at("'config', 'localUrl'")).toBeLessThan(at("'run', 'all'"));
    expect(at("'config', 'localUrl'")).toBeLessThan(at("'serve', '--port'"));
    expect(serve).toContain('await closedPort()');
    expect(serve).toContain("'--engine', 'none'");
  });

  it('keeps its record in the run folder', () => {
    expect(read('serve.ts')).toContain('SKEINWISE_HOME: home');
    expect(read('run.ts')).toContain('process.env.SKEINWISE_E2E_RUN');
  });

  it('empties the run folder only through the guarded helper, before anything runs', () => {
    const serve = read('serve.ts');
    expect(serve).not.toContain('rmSync');
    expect(serve.indexOf('freshRunFolder(run)')).toBeGreaterThan(0);
    expect(serve.indexOf('freshRunFolder(run)')).toBeLessThan(serve.indexOf("'demo'"));
  });
});

describe('the e2e run folder', () => {
  const made: string[] = [];
  const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), 'skeinwise-e2e-run-test-'));
    made.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('makes a new folder and marks it', () => {
    const run = join(scratch(), 'run');
    freshRunFolder(run);
    expect(readdirSync(run)).toEqual([RUN_MARK]);
  });

  it('takes an empty folder', () => {
    const run = scratch();
    freshRunFolder(run);
    expect(readdirSync(run)).toEqual([RUN_MARK]);
  });

  it("empties an earlier run's folder", () => {
    const run = scratch();
    freshRunFolder(run);
    mkdirSync(join(run, 'home'));
    writeFileSync(join(run, 'home', 'record.db'), 'old');
    freshRunFolder(run);
    expect(readdirSync(run)).toEqual([RUN_MARK]);
  });

  it('refuses a folder with files that is not a run folder, and leaves them be', () => {
    const run = scratch();
    writeFileSync(join(run, 'record.db'), 'keep me');
    expect(() => freshRunFolder(run)).toThrow(/not an e2e run folder/);
    expect(readFileSync(join(run, 'record.db'), 'utf8')).toBe('keep me');
    expect(existsSync(join(run, RUN_MARK))).toBe(false);
  });
});
