import { describe, expect, it } from 'vitest';
import { contrast, HEAT_FILL, mix, PALETTES, palette, pointColors, THEMES, theme, themeVars } from '../../web/src/themes.ts';

describe('themes', () => {
  it('has the six themes and seven palettes the spec names, in order', () => {
    expect(THEMES.map((t) => t.name)).toEqual(['Dusk', 'Ink', 'Slate', 'Moss', 'Linen', 'Paper']);
    expect(THEMES.filter((t) => t.light).map((t) => t.name)).toEqual(['Linen', 'Paper']);
    expect(PALETTES.map((p) => p.name)).toEqual(['Ember', 'Tide', 'Lichen', 'Heather', 'Graphite', 'Saffron', 'Mono']);
  });

  it('keeps Dusk on the spec tokens', () => {
    expect(theme('dusk')).toMatchObject({
      ground: '#0f1219',
      panel: '#181c26',
      line: '#2a3040',
      ink: '#e9e4d8',
      inkSoft: '#959aa8',
      accent: '#e3a857',
    });
    expect(theme('nonsense').key).toBe('dusk');
    expect(palette('nonsense').key).toBe('ember');
  });

  it.each(THEMES.map((t) => [t.name, t] as const))('%s keeps text at WCAG AA', (_, t) => {
    for (const bg of [t.ground, t.panel, t.raised]) {
      expect(contrast(t.ink, bg)).toBeGreaterThanOrEqual(7);
      expect(contrast(t.inkSoft, bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.accent, bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.danger, bg)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(t.onAccent, t.accent)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(THEMES.map((t) => [t.name, t] as const))('%s keeps AA on a selected row and on the fullest heatmap cell', (_, t) => {
    // A selected row (the command bar's, a list's) sits on the accent wash; its secondary line is soft ink.
    const wash = themeVars(t)['--accent-wash']!;
    expect(contrast(t.inkSoft, wash)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t.ink, wash)).toBeGreaterThanOrEqual(4.5);
    // The Workbench heatmap's numbers are ink, on the accent over the page or a panel.
    for (const bg of [t.ground, t.panel]) expect(contrast(t.ink, mix(bg, t.accent, HEAT_FILL[1]))).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps every point colour visible on its ground', () => {
    for (const t of THEMES) for (const p of PALETTES) for (const c of pointColors(p, t)) expect(contrast(c, t.ground)).toBeGreaterThanOrEqual(3);
  });

  it('computes contrast and mixes like WCAG says', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#777777')).toBe(1);
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
  });
});
