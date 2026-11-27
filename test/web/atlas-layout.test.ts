import { describe, expect, it } from 'vitest';
import { atlasLines } from '../../web/src/brain/atlasMap.ts';
import { type AtlasInput, atlasLayout, atlasShape, clustersLayout, layoutFor, type LayoutPoint } from '../../web/src/layout.ts';

/** n entries a day apart, then one point per hub (id the hub's negated). */
function points(n: number, hubs: number): LayoutPoint[] {
  const start = Date.UTC(2025, 0, 1);
  const entries = Array.from({ length: n }, (_, i) => ({ id: i + 1, kind: 0 as const, time: start + i * 86_400_000, cluster: i % 3, strand: 0, group: i % 4 }));
  const own = Array.from({ length: hubs }, (_, k) => ({ id: -(k + 1), kind: 1 as const, time: start, cluster: 0, strand: 0, group: 0 }));
  return [...entries, ...own];
}

/**
 * Two hubs side by side, 60 entries each, the first split into two sub-groups; then 10 entries in no hub. Entry i
 * goes to hub 0 for i < 60, hub 1 for i < 120, and none after.
 */
function twoHubs(): { pts: LayoutPoint[]; atlas: AtlasInput } {
  const pts = points(130, 2);
  const hubOf = Int32Array.from(pts, (p, i) => (p.id < 0 ? -p.id - 1 : i < 60 ? 0 : i < 120 ? 1 : -1));
  const partOf = Int32Array.from(pts, (p, i) => (p.id < 0 || i >= 120 ? -1 : i < 60 ? i % 2 : 0));
  const atlas: AtlasInput = {
    hubOf,
    partOf,
    hubs: [
      { name: 'Bread', x: -9, y: 0, r: Math.sqrt(60), parts: [{ name: 'rye', x: -0.45, y: 0 }, { name: 'starter', x: 0.45, y: 0 }] },
      { name: 'River', x: 9, y: 0, r: Math.sqrt(60), parts: [{ name: 'samples', x: 0, y: 0 }] },
    ],
  };
  return { pts, atlas };
}

const at = (pos: Float32Array, i: number) => ({ x: pos[i * 3]!, y: pos[i * 3 + 1]!, z: pos[i * 3 + 2]! });

describe('the map layout', () => {
  it('puts each entry in its hub’s country and its sub-group’s province, flat, and the same every time', () => {
    const { pts, atlas } = twoHubs();
    const pos = atlasLayout(pts, atlas);
    expect(atlasLayout(pts, atlas)).toEqual(pos);
    const shape = atlasShape(pts, atlas);
    for (let i = 0; i < 120; i++) {
      const p = at(pos, i);
      expect(p.z).toBe(0);
      const hub = shape.hubs[atlas.hubOf[i]!]!;
      const province = shape.provinces[atlas.hubOf[i]!]![atlas.partOf[i]!]!;
      expect(Math.hypot(p.x - province.x, p.y - province.y)).toBeLessThanOrEqual(province.r + 1e-6);
      expect(Math.hypot(p.x - hub.x, p.y - hub.y)).toBeLessThanOrEqual(hub.r * 1.5);
    }
    // The first hub's two sub-groups sit apart, left and right, as the organiser placed them.
    const mean = (part: number) => {
      const xs = Array.from({ length: 60 }, (_, i) => i).filter((i) => i % 2 === part).map((i) => at(pos, i).x);
      return xs.reduce((s, x) => s + x, 0) / xs.length;
    };
    expect(mean(0)).toBeLessThan(mean(1));
    // A hub's own point is at its country's middle.
    expect(at(pos, 130)).toEqual({ x: expect.closeTo(shape.hubs[0]!.x, 5), y: expect.closeTo(shape.hubs[0]!.y, 5), z: 0 });
  });

  it('keeps the organiser’s places, scaled to fit, and puts entries in no hub on an island to the south', () => {
    const { pts, atlas } = twoHubs();
    const shape = atlasShape(pts, atlas);
    expect(shape.hubs[0]!.x).toBeLessThan(0);
    expect(shape.hubs[1]!.x).toBeGreaterThan(0);
    expect(shape.hubs[0]!.r).toBeCloseTo(shape.hubs[1]!.r, 6);
    const pos = atlasLayout(pts, atlas);
    let reach = 0;
    for (let i = 0; i < pts.length; i++) reach = Math.max(reach, Math.hypot(at(pos, i).x, at(pos, i).y));
    expect(reach).toBeLessThanOrEqual(1.6 + 1e-6);
    const island = shape.loose!;
    for (let i = 120; i < 130; i++) {
      const p = at(pos, i);
      expect(Math.hypot(p.x - island.x, p.y - island.y)).toBeLessThanOrEqual(island.r + 1e-6);
      expect(p.y).toBeLessThan(Math.min(...shape.hubs.map((h) => h.y - h.r)));
    }
  });

  it('draws Clusters until the organiser has placed the hubs', () => {
    const pts = points(50, 0);
    expect(layoutFor('atlas', pts, null)).toEqual(clustersLayout(pts));
  });
});

describe('the map’s lines', () => {
  const { pts, atlas } = twoHubs();
  const pos = atlasLayout(pts, atlas);
  const country = Int32Array.from(pts, (p, i) => (p.id < 0 ? -2 : atlas.hubOf[i]! < 0 ? 2 : atlas.hubOf[i]!));
  const province = Int32Array.from(pts, (_, i) => (atlas.hubOf[i]! < 0 ? 0 : atlas.partOf[i]!));
  const lines = atlasLines(pos, country, province, atlasShape(pts, atlas));
  const segments = (a: Float32Array) => Array.from({ length: a.length / 6 }, (_, s) => [a[s * 6]!, a[s * 6 + 1]!, a[s * 6 + 3]!, a[s * 6 + 4]!] as const);

  it('rings the land with a coast and splits a country into its provinces', () => {
    const shape = atlasShape(pts, atlas);
    expect(lines.coast.length).toBeGreaterThan(0);
    // Every coast segment lies near a land disc's rim, never deep inside one.
    for (const [x0, y0] of segments(lines.coast)) {
      const inside = [...shape.hubs, shape.loose!].some((d) => Math.hypot(x0 - d.x, y0 - d.y) < d.r * 0.6);
      expect(inside).toBe(false);
    }
    // The border between the first hub's two provinces runs down its middle; the second hub has one province and none.
    const split = segments(lines.provinces);
    expect(split.length).toBeGreaterThan(0);
    for (const [x0, , x1] of split) expect(Math.abs((x0 + x1) / 2 - shape.hubs[0]!.x)).toBeLessThan(shape.hubs[0]!.r);
  });

  it('draws no border between countries that the sea keeps apart, and one where they touch', () => {
    expect(lines.countries.length).toBe(0);
    const touching: AtlasInput = { ...atlas, hubs: atlas.hubs.map((h, k) => ({ ...h, x: k ? Math.sqrt(60) : -Math.sqrt(60) })) };
    const pos2 = atlasLayout(pts, touching);
    const near = atlasLines(pos2, country, province, atlasShape(pts, touching));
    expect(near.countries.length).toBeGreaterThan(0);
    for (const [x0, , x1] of segments(near.countries)) expect(Math.abs((x0 + x1) / 2)).toBeLessThan(0.3);
  });

  it('knows how far apart neighbouring entries stand, about the same in every province', () => {
    const { pts, atlas } = twoHubs();
    const pos = atlasLayout(pts, atlas);
    const { spacing } = atlasShape(pts, atlas);
    expect(spacing).toBeGreaterThan(0);
    // Each entry's nearest neighbour in its own hub stands about one spacing away.
    const nearest: number[] = [];
    for (let i = 0; i < 120; i++) {
      let best = Infinity;
      for (let j = 0; j < 120; j++) {
        if (j === i || atlas.hubOf[j] !== atlas.hubOf[i]) continue;
        best = Math.min(best, Math.hypot(at(pos, i).x - at(pos, j).x, at(pos, i).y - at(pos, j).y));
      }
      nearest.push(best);
    }
    nearest.sort((a, b) => a - b);
    const median = nearest[60]!;
    expect(median).toBeGreaterThan(spacing * 0.5);
    expect(median).toBeLessThan(spacing * 1.5);
  });

  it('draws faint terrain where entries crowd, and nothing for an empty map', () => {
    expect(lines.terrain.length).toBeGreaterThan(0);
    expect(lines.terrain.length % 6).toBe(0);
    const none = atlasLines(new Float32Array(0), new Int32Array(0), new Int32Array(0), { hubs: [], loose: null, provinces: [], spacing: 0 });
    expect(none).toEqual({ countries: new Float32Array(0), provinces: new Float32Array(0), coast: new Float32Array(0), terrain: new Float32Array(0) });
  });
});
