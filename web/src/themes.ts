// App themes and point palettes. Dusk's tokens come from docs/ui.md; the other values are our own. Every theme keeps
// body and secondary text at WCAG AA (4.5:1) on the ground, the panels and raised cards (test/web/themes.test.ts).

export type ThemeKey = 'dusk' | 'ink' | 'slate' | 'moss' | 'linen' | 'paper';
export type PaletteKey = 'ember' | 'tide' | 'lichen' | 'heather' | 'graphite' | 'saffron' | 'mono';

export interface Theme {
  key: ThemeKey;
  name: string;
  light: boolean;
  ground: string;
  panel: string;
  raised: string;
  line: string;
  ink: string;
  inkSoft: string;
  accent: string;
  /** Text on an accent-filled button. */
  onAccent: string;
  danger: string;
  ok: string;
}

export const THEMES: Theme[] = [
  {
    key: 'dusk',
    name: 'Dusk',
    light: false,
    ground: '#0f1219',
    panel: '#181c26',
    raised: '#20252f',
    line: '#2a3040',
    ink: '#e9e4d8',
    inkSoft: '#959aa8',
    accent: '#e3a857',
    onAccent: '#0f1219',
    danger: '#f08a7a',
    ok: '#8fd19e',
  },
  {
    key: 'ink',
    name: 'Ink',
    light: false,
    ground: '#08090b',
    panel: '#121418',
    raised: '#1a1d22',
    line: '#272b32',
    ink: '#eceef1',
    inkSoft: '#9ba2ac',
    accent: '#8bbcec',
    onAccent: '#08090b',
    danger: '#f28b82',
    ok: '#8fd6a8',
  },
  {
    key: 'slate',
    name: 'Slate',
    light: false,
    ground: '#151a21',
    panel: '#1d242d',
    raised: '#252e39',
    line: '#344150',
    ink: '#e6ebf0',
    inkSoft: '#a3afbc',
    accent: '#93cbc3',
    onAccent: '#151a21',
    danger: '#f29a8c',
    ok: '#9ad7a4',
  },
  {
    key: 'moss',
    name: 'Moss',
    light: false,
    ground: '#0f140e',
    panel: '#171f15',
    raised: '#1f291c',
    line: '#2f3b2a',
    ink: '#e8ead9',
    inkSoft: '#a3aa94',
    accent: '#bcd171',
    onAccent: '#0f140e',
    danger: '#f09a84',
    ok: '#a6dc8e',
  },
  {
    key: 'linen',
    name: 'Linen',
    light: true,
    ground: '#f2ede3',
    panel: '#faf7f1',
    raised: '#ffffff',
    line: '#d9cfbe',
    ink: '#2a241c',
    inkSoft: '#655b4c',
    accent: '#9a4f17',
    onAccent: '#ffffff',
    danger: '#a8321f',
    ok: '#2f6b35',
  },
  {
    key: 'paper',
    name: 'Paper',
    light: true,
    ground: '#f5f6f8',
    panel: '#ffffff',
    raised: '#ffffff',
    line: '#dadfe6',
    ink: '#1c2128',
    inkSoft: '#596270',
    accent: '#2b5fb4',
    onAccent: '#ffffff',
    danger: '#b3261e',
    ok: '#22703a',
  },
];

export interface Palette {
  key: PaletteKey;
  name: string;
  colors: string[];
}

export const PALETTES: Palette[] = [
  {
    key: 'ember',
    name: 'Ember',
    colors: ['#f2a65a', '#6fb3e8', '#e86f51', '#9ecf7a', '#d9577d', '#f6d07a', '#b48ef0', '#8fd0c4', '#f08cae', '#e0c2a2'],
  },
  {
    key: 'tide',
    name: 'Tide',
    colors: ['#5fc8e0', '#8fe3cf', '#6f7ff0', '#2fd1c0', '#3a8fd6', '#b7e4f0', '#45b7a0', '#a7b8ff', '#7cc4ff', '#d0f0ff'],
  },
  {
    key: 'lichen',
    name: 'Lichen',
    colors: ['#b5d16e', '#6fcfb0', '#e3d77a', '#7fbf8a', '#d6b86a', '#5fa88f', '#c9e3a5', '#a3c45a', '#8f9e5a', '#e8eec0'],
  },
  {
    key: 'heather',
    name: 'Heather',
    colors: ['#c79be8', '#f09fa8', '#9f8ff0', '#e88fc0', '#a9b4ff', '#f0b6d6', '#7f6fd6', '#d6a6ff', '#b07fc0', '#e7cdf5'],
  },
  {
    key: 'graphite',
    name: 'Graphite',
    colors: ['#e9ecf0', '#a9b1bd', '#cfd4db', '#8590a0', '#c3c9d2', '#9aa3b0', '#d8dce3', '#7c8796', '#b8bfc9', '#6f7a8a'],
  },
  {
    key: 'saffron',
    name: 'Saffron',
    colors: ['#ffb020', '#ff7a1a', '#ffd24d', '#e85d2a', '#ffcf8a', '#f2992e', '#ffe08a', '#d9762b', '#ffc266', '#ffa64d'],
  },
  {
    key: 'mono',
    name: 'Mono',
    colors: ['#f4efe4', '#dcd6ca', '#c4beb2', '#aca69b', '#f4efe4', '#dcd6ca', '#c4beb2', '#aca69b', '#f4efe4', '#dcd6ca'],
  },
];

export function theme(key: string): Theme {
  return THEMES.find((t) => t.key === key) ?? THEMES[0]!;
}

export function palette(key: string): Palette {
  return PALETTES.find((p) => p.key === key) ?? PALETTES[0]!;
}

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`Not a colour: ${hex}`);
  const n = Number.parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
}

/** Mixes two colours: t = 0 gives a, 1 gives b. */
export function mix(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The point colours for a palette on a theme: light themes get darker points, since they can't glow. */
export function pointColors(p: Palette, t: Theme): string[] {
  if (!t.light) return p.colors;
  return p.colors.map((c) => {
    let k = 0.42;
    while (k < 0.9 && contrast(mix(c, '#1a1a1a', k), t.ground) < 3.2) k += 0.04;
    return mix(c, '#1a1a1a', k);
  });
}

/** The CSS variables for a theme. */
export function themeVars(t: Theme): Record<string, string> {
  return {
    '--ground': t.ground,
    '--panel': t.panel,
    '--raised': t.raised,
    '--line': t.line,
    '--ink': t.ink,
    '--ink-soft': t.inkSoft,
    '--accent': t.accent,
    '--on-accent': t.onAccent,
    '--danger': t.danger,
    '--ok': t.ok,
    '--accent-wash': mix(t.panel, t.accent, t.light ? 0.12 : 0.16),
    '--hover': mix(t.panel, t.ink, t.light ? 0.05 : 0.07),
    '--scrim': t.light ? 'rgba(40, 34, 26, 0.28)' : 'rgba(4, 6, 10, 0.6)',
  };
}
