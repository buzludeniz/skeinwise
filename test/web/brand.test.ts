// The page's tab icon and its mark come from docs/brand, the one home of the logo, and from nowhere else.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

describe('the logo', () => {
  it('gives the tab the favicon from docs/brand', () => {
    const icons = [...read('web/index.html').matchAll(/<link rel="icon" href="([^"]+)"/g)].map((m) => m[1]);
    expect(icons).toEqual(['../docs/brand/favicon.ico']);
    expect(existsSync(join(ROOT, 'docs/brand/favicon.ico'))).toBe(true);
  });

  it('draws the mark from the light and dark files in docs/brand', () => {
    const common = read('web/src/ui/common.tsx');
    const marks = [...common.matchAll(/from '\.\.\/\.\.\/\.\.\/(docs\/brand\/[^']+)'/g)].map((m) => m[1]);
    expect(marks.sort()).toEqual(['docs/brand/logo-mark-dark.svg', 'docs/brand/logo-mark.svg']);
    for (const mark of marks) expect(existsSync(join(ROOT, mark!))).toBe(true);
    const logo = common.slice(common.indexOf('export function Logo'), common.indexOf('type ButtonProps'));
    expect(logo).not.toContain('<svg');
  });

  it('keeps no other icon file in the page', () => {
    const pub = join(ROOT, 'web/public');
    const files = existsSync(pub) ? readdirSync(pub) : [];
    expect(files.filter((f) => /^(favicon|logo|icon)/i.test(f))).toEqual([]);
  });
});
