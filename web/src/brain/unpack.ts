// /api/brain's packed reply back into the BrainData the page draws from: the inverse of packBrain in
// src/server/queries.ts, whose BrainWire says how each part is packed. test/server/brain.test.ts checks that the two
// give back exactly what the server built.

import type { BrainData, BrainPoint, BrainWire } from '../types.ts';

export function unpackBrain(wire: BrainWire): BrainData {
  const { packed, points: cols, links: packedLinks, hubs, ...rest } = wire;
  if (packed !== 1) throw new Error(`The brain came packed in a way this page can't read (packed: ${String(packed)}). Reload the page.`);
  const [ids, kinds, speakers, sources, threads, folders, projects, times, labels] = cols;
  const points: BrainPoint[] = new Array(ids.length);
  let id = 0;
  let time = 0;
  for (let i = 0; i < ids.length; i++) {
    id += ids[i]!;
    const step = times[i]!;
    // A point without a time stays null, as JSON has always sent its NaN.
    const t = step === null ? null : (time += step);
    points[i] = [id, kinds[i]!, speakers[i]!, sources[i]!, threads[i]!, folders[i]!, projects[i]!, t as number, labels[i]!];
  }
  const [froms, tos, linkKinds] = packedLinks;
  const links: BrainData['links'] = new Array(froms.length);
  let from = 0;
  for (let k = 0; k < froms.length; k++) {
    from += froms[k]!;
    links[k] = [points[from]![0], points[from + tos[k]!]![0], linkKinds[k]!];
  }
  return {
    ...rest,
    points,
    links,
    hubs: hubs.map((h) => {
      let e = 0;
      return { ...h, entries: h.entries.map((step) => (e += step)) };
    }),
  };
}
