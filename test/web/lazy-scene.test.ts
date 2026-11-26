// three.js and the scene load on first use, in their own chunk, so the app's first load stays small (LS-16).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');

function files(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = join(dir, name);
    return statSync(join(ROOT, path)).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

const sources = files('web/src').map((file) => ({ file, text: readFileSync(join(ROOT, file), 'utf8') }));

describe('the lazy scene', () => {
  it('imports three.js only in the scene', () => {
    const users = sources.filter((s) => /from 'three'|import\('three'\)/.test(s.text)).map((s) => s.file);
    expect(users).toEqual(['web/src/brain/scene.ts']);
  });

  it('reaches the scene only through a dynamic import or a type import', () => {
    const statics = sources.filter((s) => /^import (?!type )[^;]*from '[./]*(brain\/)?scene\.ts';/m.test(s.text)).map((s) => s.file);
    expect(statics).toEqual([]);
    const dynamic = sources.filter((s) => s.text.includes("import('./scene.ts')")).map((s) => s.file);
    expect(dynamic).toEqual(['web/src/brain/useBrain.ts']);
  });

  it('keeps Vite’s chunk warning at its default', () => {
    expect(readFileSync(join(ROOT, 'web/vite.config.ts'), 'utf8')).not.toContain('chunkSizeWarningLimit');
  });
});
