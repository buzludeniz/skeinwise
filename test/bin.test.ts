// The `skeinwise` command's Node check (src/bin.ts, src/node-check.ts): an old Node gets a clear message before
// node:sqlite loads, which only holds while the two files import nothing that leads to it.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NODE_MAJOR, oldNodeMessage } from '../src/node-check.ts';

const root = join(import.meta.dirname, '..');
const read = (file: string) => readFileSync(join(root, file), 'utf8');
const staticImports = (source: string) => [...source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);

describe('the Node check', () => {
  it('turns away every Node before 24 with a message that names both versions and where to get Node', () => {
    for (const version of ['22.12.0', '22.4.1', '20.18.0', '18.20.4', 'v23.11.0']) {
      const message = oldNodeMessage(version);
      expect(message, version).toContain(`Skeinwise needs Node ${NODE_MAJOR} or newer, and this is Node ${version}.`);
      expect(message, version).toContain('https://nodejs.org');
    }
  });

  it('lets Node 24 and later through', () => {
    for (const version of ['24.0.0', '24.11.1', '26.13.1', '30.0.0']) expect(oldNodeMessage(version), version).toBeUndefined();
  });

  it('turns away a version it cannot read rather than guess', () => {
    expect(oldNodeMessage('unknown')).toContain('Skeinwise needs Node');
  });

  it('runs before anything that loads node:sqlite: bin.ts imports only node-check.ts, which imports nothing', () => {
    expect(staticImports(read('src/bin.ts'))).toEqual(['./node-check.ts']);
    expect(read('src/bin.ts')).toContain("await import('./cli.ts')");
    expect(staticImports(read('src/node-check.ts'))).toEqual([]);
    expect(read('src/node-check.ts')).not.toMatch(/\bimport\s*\(/);
  });

  it('is the package bin, and runs the CLI on this Node', () => {
    const pkg = JSON.parse(read('package.json')) as { bin: Record<string, string>; version: string };
    expect(pkg.bin).toEqual({ skeinwise: 'dist/src/bin.js' });
    const out = execFileSync(process.execPath, [join(root, 'src/bin.ts'), '--version'], { encoding: 'utf8' });
    expect(out).toBe(`${pkg.version}\n`);
  });
});
