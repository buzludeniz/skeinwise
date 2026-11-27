// The map's names: which tiers show at a zoom, a placer that keeps names from overlapping, and an index of the
// entries' places for finding the ones in view. Pure (no DOM, no WebGL), so the tests can check it; scene.ts measures
// the names and moves their elements.
//
// Three tiers: the countries' names (the hubs) at every zoom, the provinces' names (their sub-groups) once the map is
// zoomed in, and entry titles once the entries stand far enough apart on screen to read one beside each. A name that
// would overlap one already placed waits, so the most important names win: countries, then provinces, then entries.

import RBush from 'rbush';

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** How far in from the widest view, as a multiple of it, the provinces' names start to show. */
export const PROVINCE_ZOOM = 1.8;
/** How far apart on screen neighbouring entries stand, in CSS pixels, before their titles show. */
export const ENTRY_GAP = 22;
/** How small a province can be on screen, as a radius in CSS pixels, and still carry its name. */
export const PROVINCE_MIN_RADIUS = 30;

/**
 * Which tiers show. `zoom` is how far in the view is from the widest one (1 at Fit, 2 at twice as close), `gap` how far
 * apart neighbouring entries stand on screen in CSS pixels. Countries always show, and the tiers come in order: entry
 * titles never before the provinces' names, even on a record small enough to read every entry at the widest view.
 */
export function nameTiers(zoom: number, gap: number): { provinces: boolean; entries: boolean } {
  const provinces = zoom >= PROVINCE_ZOOM;
  return { provinces, entries: provinces && gap >= ENTRY_GAP };
}

/** Places boxes on a screen of the given size so that none overlaps another, first come, first placed. */
export class Placer {
  private tree = new RBush<Box>();
  private width = 0;
  private height = 0;

  /** Starts a new frame on a screen this size. */
  reset(width: number, height: number): void {
    this.tree.clear();
    this.width = width;
    this.height = height;
  }

  /**
   * Places a box at (x, y), its top left corner, `w` by `h` CSS pixels, with `pad` pixels of air around it. False, and
   * nothing placed, when it runs off the screen or overlaps a box already placed. `force` places it regardless (a name
   * with keyboard focus, which always shows) and still keeps the space from later names.
   */
  take(x: number, y: number, w: number, h: number, pad = 3, force = false): boolean {
    const box = { minX: x - pad, minY: y - pad, maxX: x + w + pad, maxY: y + h + pad };
    if (!force) {
      if (x < 0 || y < 0 || x + w > this.width || y + h > this.height) return false;
      if (this.tree.collides(box)) return false;
    }
    this.tree.insert(box);
    return true;
  }

  /** How many boxes are placed. */
  get size(): number {
    return this.tree.all().length;
  }
}

interface Spot extends Box {
  index: number;
}

/** The entries' places on the map, for finding those in a rectangle quickly. */
export class EntryIndex {
  private tree = new RBush<Spot>();

  /** `pos` holds xyz per point; only the points `use` keeps go in. */
  constructor(pos: Float32Array, use: (i: number) => boolean) {
    const spots: Spot[] = [];
    for (let i = 0; i * 3 < pos.length; i++) {
      if (!use(i)) continue;
      const x = pos[i * 3]!;
      const y = pos[i * 3 + 1]!;
      spots.push({ minX: x, minY: y, maxX: x, maxY: y, index: i });
    }
    this.tree.load(spots);
  }

  /** The points inside the rectangle, by index, in no set order. */
  within(minX: number, minY: number, maxX: number, maxY: number): number[] {
    return this.tree.search({ minX, minY, maxX, maxY }).map((s) => s.index);
  }
}

/** A title shortened to fit beside its point. */
export function shortTitle(text: string, max = 30): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/**
 * Lit entries per country: how many of the entries a search lit sit in each country. `lit` is the scene's lit values
 * (2 lit), `country` each point's country (-1 for none), and only entries count, not the hubs' own points.
 */
export function hitsPerCountry(lit: Float32Array, country: Int32Array, isEntry: (i: number) => boolean, countries: number): number[] {
  const hits = new Array<number>(countries).fill(0);
  for (let i = 0; i < lit.length; i++) {
    const c = country[i]!;
    if (c >= 0 && c < countries && lit[i]! > 1.5 && isEntry(i)) hits[c]!++;
  }
  return hits;
}
