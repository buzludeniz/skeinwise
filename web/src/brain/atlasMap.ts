// The map's lines: borders between countries (hubs), fainter ones between provinces (a hub's sub-groups), the coast,
// and faint terrain lines where entries crowd. Pure geometry (no DOM, no WebGL), so the tests can check it.
//
// The borders are Voronoi edges. Every entry is a site labelled with its country and province, and a jittered grid of
// sea sites fills the water around the land discs. An edge between two sites with different labels is a border, of
// the kind the two labels make: two countries, two provinces of one country, or land and sea.

import { contourDensity } from 'd3-contour';
import { Delaunay } from 'd3-delaunay';
import { type AtlasShape, type Disc, hash01 } from '../layout.ts';

export interface AtlasLines {
  /** Line segments as x, y, z triples, two vertices per segment, all at z = 0. */
  countries: Float32Array;
  provinces: Float32Array;
  coast: Float32Array;
  terrain: Float32Array;
}

/** How fine the sea grid is: this many cells across the map's widest side. */
const SEA_CELLS = 110;
/** How far the coast stands off the land discs, in sea cells. */
const SHORE = 0.6;

/**
 * The map's lines for points at `pos` (xyz per point). `country` and `province` label each point (-1 for a point that
 * isn't land, such as a hub's own point); a point with country -2 is skipped. The shape's discs say where the land is.
 */
export function atlasLines(pos: Float32Array, country: Int32Array, province: Int32Array, shape: AtlasShape): AtlasLines {
  const land: Disc[] = [...shape.hubs, ...shape.provinces.flat(), ...(shape.loose ? [shape.loose] : [])];
  const xs: number[] = [];
  const ys: number[] = [];
  const cty: number[] = [];
  const prv: number[] = [];
  for (let i = 0; i < country.length; i++) {
    if (country[i]! < -1) continue;
    xs.push(pos[i * 3]!);
    ys.push(pos[i * 3 + 1]!);
    cty.push(country[i]!);
    prv.push(province[i]!);
  }
  const empty = { countries: new Float32Array(0), provinces: new Float32Array(0), coast: new Float32Array(0), terrain: new Float32Array(0) };
  if (!xs.length || !land.length) return empty;
  const dots = xs.length;

  // The sea: a grid over the land's box and a margin, jittered so no four sites sit on one circle, kept only off the land.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const d of land) {
    minX = Math.min(minX, d.x - d.r);
    maxX = Math.max(maxX, d.x + d.r);
    minY = Math.min(minY, d.y - d.r);
    maxY = Math.max(maxY, d.y + d.r);
  }
  const cell = Math.max(maxX - minX, maxY - minY, 1e-6) / SEA_CELLS;
  const margin = cell * 4;
  const shore = cell * SHORE;
  const cols = Math.ceil((maxX - minX + 2 * margin) / cell) + 1;
  const rows = Math.ceil((maxY - minY + 2 * margin) / cell) + 1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = minX - margin + c * cell + (hash01(r * cols + c, 5) - 0.5) * cell * 0.3;
      const y = minY - margin + r * cell + (hash01(r * cols + c, 9) - 0.5) * cell * 0.3;
      if (land.some((d) => Math.hypot(x - d.x, y - d.y) < d.r + shore)) continue;
      xs.push(x);
      ys.push(y);
      cty.push(-1);
      prv.push(-1);
    }
  }

  const coords = new Float64Array(xs.length * 2);
  for (let i = 0; i < xs.length; i++) {
    coords[i * 2] = xs[i]!;
    coords[i * 2 + 1] = ys[i]!;
  }
  const delaunay = new Delaunay(coords);
  const { triangles, halfedges } = delaunay;
  const centre = (t: number): [number, number] => circumcentre(coords, triangles[t * 3]!, triangles[t * 3 + 1]!, triangles[t * 3 + 2]!);
  const out = { countries: [] as number[], provinces: [] as number[], coast: [] as number[] };
  for (let e = 0; e < halfedges.length; e++) {
    const o = halfedges[e]!;
    // Each inner edge once; the hull's edges face nothing.
    if (o < e) continue;
    const a = triangles[e]!;
    const b = triangles[e % 3 === 2 ? e - 2 : e + 1]!;
    const ca = cty[a]!;
    const cb = cty[b]!;
    let kind: number[] | null = null;
    if (ca === -1 && cb === -1) continue;
    if (ca === -1 || cb === -1) kind = out.coast;
    else if (ca !== cb) kind = out.countries;
    else if (prv[a] !== prv[b]) kind = out.provinces;
    if (!kind) continue;
    const [x0, y0] = centre(Math.floor(e / 3));
    const [x1, y1] = centre(Math.floor(o / 3));
    kind.push(x0, y0, 0, x1, y1, 0);
  }

  return {
    countries: Float32Array.from(out.countries),
    provinces: Float32Array.from(out.provinces),
    coast: Float32Array.from(out.coast),
    terrain: terrain(xs.slice(0, dots), ys.slice(0, dots), minX - margin, minY - margin, cols * cell, rows * cell),
  };
}

/** The centre of the circle through a triangle's corners; its middle when the corners lie on a line. */
function circumcentre(c: Float64Array, i: number, j: number, k: number): [number, number] {
  const ax = c[i * 2]!;
  const ay = c[i * 2 + 1]!;
  const bx = c[j * 2]! - ax;
  const by = c[j * 2 + 1]! - ay;
  const cx = c[k * 2]! - ax;
  const cy = c[k * 2 + 1]! - ay;
  const d = 2 * (bx * cy - by * cx);
  if (Math.abs(d) < 1e-12) return [ax + (bx + cx) / 3, ay + (by + cy) / 3];
  const b2 = bx * bx + by * by;
  const c2 = cx * cx + cy * cy;
  return [ax + (cy * b2 - by * c2) / d, ay + (bx * c2 - cx * b2) / d];
}

/** How many terrain lines: each a step up in how closely entries crowd. */
const TERRAIN_LEVELS = 7;

/** Faint contour lines of where entries crowd, as line segments in the map's units. */
function terrain(xs: number[], ys: number[], x0: number, y0: number, width: number, height: number): Float32Array {
  // d3-contour works on a pixel grid: the map is laid on one 400 cells across.
  const scale = 400 / Math.max(width, height, 1e-6);
  const w = Math.ceil(width * scale);
  const h = Math.ceil(height * scale);
  const index = xs.map((_, i) => i);
  const levels = contourDensity<number>()
    .x((i) => (xs[i]! - x0) * scale)
    .y((i) => (ys[i]! - y0) * scale)
    .size([w, h])
    .cellSize(4)
    .bandwidth(9)
    .thresholds(TERRAIN_LEVELS)(index);
  const out: number[] = [];
  // The lowest level rings all the land, close to the coast already drawn, so it is left out.
  for (const level of levels.slice(1)) {
    for (const polygon of level.coordinates) {
      for (const ring of polygon) {
        for (let p = 1; p < ring.length; p++) {
          const [ax, ay] = ring[p - 1]!;
          const [bx, by] = ring[p]!;
          out.push(x0 + ax! / scale, y0 + ay! / scale, 0, x0 + bx! / scale, y0 + by! / scale, 0);
        }
      }
    }
  }
  return Float32Array.from(out);
}
