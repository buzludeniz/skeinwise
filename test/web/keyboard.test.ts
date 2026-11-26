// The screens from the keyboard: the keys of a row of tabs, and every row of tabs built on TabList so the arrow keys
// work on all of them. The browser side (focus into a side panel and back, the tabs moving) is in e2e/smoke.e2e.ts.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { panelId, radioStep, tabId, tabPanel, tabStep } from '../../web/src/ui/tabs.ts';

describe('tabStep', () => {
  it('moves right and wraps from the last tab to the first', () => {
    expect(tabStep('ArrowRight', 0, 3)).toBe(1);
    expect(tabStep('ArrowRight', 2, 3)).toBe(0);
  });

  it('moves left and wraps from the first tab to the last', () => {
    expect(tabStep('ArrowLeft', 2, 3)).toBe(1);
    expect(tabStep('ArrowLeft', 0, 3)).toBe(2);
  });

  it('goes to the ends with Home and End', () => {
    expect(tabStep('Home', 2, 5)).toBe(0);
    expect(tabStep('End', 1, 5)).toBe(4);
  });

  it('stays on a single tab', () => {
    for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) expect(tabStep(key, 0, 1)).toBe(0);
  });

  it('leaves every other key alone, the up and down arrows included', () => {
    for (const key of ['ArrowUp', 'ArrowDown', 'Enter', ' ', 'Tab', 'a']) expect(tabStep(key, 1, 3)).toBeNull();
    expect(tabStep('ArrowRight', 0, 0)).toBeNull();
  });
});

describe('radioStep', () => {
  it('moves to the next radio on right and down, and wraps', () => {
    expect(radioStep('ArrowRight', 0, 3)).toBe(1);
    expect(radioStep('ArrowDown', 2, 3)).toBe(0);
  });

  it('moves to the one before on left and up, and wraps', () => {
    expect(radioStep('ArrowLeft', 1, 3)).toBe(0);
    expect(radioStep('ArrowUp', 0, 3)).toBe(2);
  });

  it('leaves every other key alone', () => {
    for (const key of ['Home', 'End', 'Enter', ' ', 'Tab', 'a']) expect(radioStep(key, 1, 3)).toBeNull();
    expect(radioStep('ArrowDown', 0, 0)).toBeNull();
  });
});

describe('tabPanel', () => {
  it('names the panel by the selected tab, and the tabs point at the panel', () => {
    expect(tabPanel('row', 'activity')).toEqual({ id: panelId('row'), role: 'tabpanel', 'aria-labelledby': tabId('row', 'activity') });
    expect(tabId('row', 'activity')).not.toBe(tabId('row', 'table'));
  });
});

const web = join(import.meta.dirname, '..', '..', 'web', 'src');

/** The screens' source files. The brain's own files are t-brain's and are left out. */
function screens(dir = web): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const path = join(dir, d.name);
    if (d.isDirectory()) return d.name === 'brain' ? [] : screens(path);
    return /\.tsx?$/.test(d.name) && d.name !== 'BrainView.tsx' ? [path] : [];
  });
}

/** A tab or a row of tabs written out by hand, without the keys. A tab panel is fine. */
const RAW_TAB = /role=["'{]+tab(list)?["'}]/;

describe('rows of tabs', () => {
  it('are all built on TabList, which carries the keys', () => {
    const raw = screens()
      .filter((f) => relative(web, f) !== join('ui', 'common.tsx'))
      .filter((f) => RAW_TAB.test(readFileSync(f, 'utf8')))
      .map((f) => relative(web, f));
    expect(raw).toEqual([]);
  });

  it('written by hand are caught by the check above', () => {
    expect(RAW_TAB.test('<div class="tabs" role="tablist" aria-label="Layers">')).toBe(true);
    expect(RAW_TAB.test('<button type="button" role="tab" aria-selected={on}>')).toBe(true);
    expect(RAW_TAB.test("<button role={'tab'}>")).toBe(true);
    expect(RAW_TAB.test('<div role="tabpanel" class="layer">')).toBe(false);
  });
});
