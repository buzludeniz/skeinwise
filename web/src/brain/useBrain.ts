// Keeps the one brain scene in step with the app: the record, the grouping, theme, palette, settings, layout and
// whatever is lit. The Brain view and the Timeline's strip both use it.

import { useEffect, useState } from 'preact/hooks';
import type { RefObject } from 'preact';
import { openEntry } from '../actions.ts';
import { useApp } from '../store.ts';
import { mix, palette, theme } from '../themes.ts';
import { type BrainModel, buildModel, litValues } from './input.ts';
import { brainScene, type Hover, type SceneMode } from './scene.ts';

let shownData: unknown = null;
let growNext = false;

/** The next time the record loads into the scene, its points appear one by one, oldest first. */
export function growOnNextLoad(): void {
  growNext = true;
  shownData = null;
}

let cached: { key: unknown[]; model: BrainModel } | null = null;

/** The model for the current record and look; built once and shared by every component that asks. */
export function useBrainModel(): BrainModel | null {
  const brain = useApp((s) => s.brain);
  const grouping = useApp((s) => s.grouping);
  const layout = useApp((s) => s.layout);
  const themeKey = useApp((s) => s.config?.appearance.theme ?? 'dusk');
  const paletteKey = useApp((s) => s.config?.appearance.palette ?? 'ember');
  if (!brain) return null;
  const by = layout === 'rings' ? 'month' : grouping;
  const key = [brain, by, themeKey, paletteKey];
  if (!cached || cached.key.some((k, i) => k !== key[i])) cached = { key, model: buildModel(brain, by, palette(paletteKey), theme(themeKey)) };
  return cached.model;
}

export function useBrainScene(host: RefObject<HTMLDivElement | null>, mode: SceneMode, spanLit: Set<number> | null = null) {
  const scene = brainScene();
  const model = useBrainModel();
  const brain = useApp((s) => s.brain);
  const layout = useApp((s) => s.layout);
  const lit = useApp((s) => s.lit);
  const isolate = useApp((s) => s.isolate);
  const themeKey = useApp((s) => s.config?.appearance.theme ?? 'dusk');
  const opts = useApp((s) => s.config?.brain);
  const [ok, setOk] = useState(true);
  const [hover, setHover] = useState<Hover | null>(null);

  useEffect(() => {
    if (!host.current) return;
    setOk(scene.attach(host.current, mode));
    return () => scene.detach();
  }, [mode]);

  useEffect(() => {
    const t = theme(themeKey);
    scene.setTheme({ light: t.light, ground: t.ground, shell: mix(t.inkSoft, t.accent, 0.25), ink: t.ink });
  }, [themeKey]);

  useEffect(() => {
    if (!model || !brain) return;
    if (shownData !== brain) {
      shownData = brain;
      scene.setData(model.input, growNext);
      growNext = false;
    } else scene.setColors(model.input.colors, model.input.points);
  }, [model]);

  useEffect(() => {
    if (opts) scene.setOptions({ pointSize: opts.pointSize, lineDensity: opts.lineDensity, labels: opts.labels, turning: opts.turning });
  }, [opts]);

  useEffect(() => {
    if (mode === 'full') scene.setLayout(layout);
    else scene.setLayout('brain');
  }, [layout, mode]);

  useEffect(() => {
    if (!model) return;
    const ids = spanLit ?? lit?.ids ?? null;
    const group = isolate === null ? null : model.legend.findIndex((g) => g.label === isolate);
    scene.setLit(litValues(model, ids, group === null || group < 0 ? null : group));
  }, [model, lit, isolate, spanLit]);

  useEffect(() => {
    scene.onHover = setHover;
    scene.onOpen = (i) => {
      const id = model?.input.points[i]?.id;
      if (id !== undefined) openEntry(id);
    };
  }, [model]);

  return { scene, model, ok, hover };
}
