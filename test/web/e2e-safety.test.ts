// The e2e run serves its own invented record and never reaches the app or the model server already running on this
// computer: no fixed port of theirs, and the record's model address is set to a closed port before anything runs.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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
});
