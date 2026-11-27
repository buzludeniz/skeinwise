import { describe, expect, it } from 'vitest';
import { ENTRY_GAP, EntryIndex, hitsPerCountry, nameTiers, Placer, PROVINCE_ZOOM, shortTitle } from '../../web/src/brain/mapNames.ts';

describe('the map’s names', () => {
  it('shows countries at the widest zoom, provinces nearer, and entry titles once entries stand apart', () => {
    expect(nameTiers(1, 2)).toEqual({ provinces: false, entries: false });
    expect(nameTiers(PROVINCE_ZOOM, 2)).toEqual({ provinces: true, entries: false });
    expect(nameTiers(PROVINCE_ZOOM * 4, ENTRY_GAP)).toEqual({ provinces: true, entries: true });
    // On a small record, entries stand apart at the widest view, and their titles still wait for the provinces'.
    expect(nameTiers(1, ENTRY_GAP * 3)).toEqual({ provinces: false, entries: false });
    expect(nameTiers(PROVINCE_ZOOM, ENTRY_GAP * 3)).toEqual({ provinces: true, entries: true });
  });

  it('places names first come, first placed, never two on one spot and never off the screen', () => {
    const placer = new Placer();
    placer.reset(400, 300);
    expect(placer.take(10, 10, 100, 20)).toBe(true);
    // Overlapping, or within the air around a placed name.
    expect(placer.take(60, 15, 100, 20)).toBe(false);
    expect(placer.take(112, 10, 50, 20)).toBe(false);
    expect(placer.take(10, 40, 100, 20)).toBe(true);
    // Off the screen.
    expect(placer.take(-5, 100, 50, 20)).toBe(false);
    expect(placer.take(380, 100, 50, 20)).toBe(false);
    expect(placer.take(100, 290, 50, 20)).toBe(false);
    // Forced (a name with keyboard focus): placed where it is, and later names keep clear of it.
    expect(placer.take(60, 15, 100, 20, 3, true)).toBe(true);
    expect(placer.take(150, 20, 40, 10)).toBe(false);
    expect(placer.size).toBe(3);
    placer.reset(400, 300);
    expect(placer.size).toBe(0);
    expect(placer.take(60, 15, 100, 20)).toBe(true);
  });

  it('finds the entries in a rectangle, and only the ones it was given', () => {
    const pos = new Float32Array([0, 0, 0, 1, 1, 0, 2, 2, 0, 5, 5, 0, 1.5, 1.5, 0]);
    const index = new EntryIndex(pos, (i) => i !== 4);
    expect(index.within(-0.5, -0.5, 2.5, 2.5).sort()).toEqual([0, 1, 2]);
    expect(index.within(4, 4, 6, 6)).toEqual([3]);
    expect(index.within(10, 10, 11, 11)).toEqual([]);
  });

  it('counts a search’s hits per country, entries only', () => {
    const lit = new Float32Array([2, 2, 0, 2, 2, 2]);
    const country = Int32Array.from([0, 0, 0, 1, -1, 1]);
    // Point 5 is a hub's own point.
    expect(hitsPerCountry(lit, country, (i) => i !== 5, 3)).toEqual([2, 1, 0]);
  });

  it('shortens a long title at a word’s end or mid-word, and tidies its spaces', () => {
    expect(shortTitle('  Short   title ')).toBe('Short title');
    const long = shortTitle('A title that runs on well past the room beside a point');
    expect(long.length).toBeLessThanOrEqual(30);
    expect(long.endsWith('…')).toBe(true);
    expect(shortTitle('')).toBe('');
  });
});
