// Keeps the one brain scene in step with the app: the record, the grouping, theme, palette, settings, layout and
// whatever is lit. The Brain view and the Timeline's strip both use it. The scene and three.js load on first use, in
// their own chunk, so the rest of the app opens without waiting for them.

import { useEffect, useState } from 'preact/hooks';
import type { RefObject } from 'preact';
import { openEntry, openPanel } from '../actions.ts';
import { useApp } from '../store.ts';
import { mix, palette, theme } from '../themes.ts';
import { type BrainModel, buildModel, litValues } from './input.ts';
import type { BrainScene, Hover, SceneMode } from './scene.ts';

let shownData: unknown = null;
let growNext = false;

/** The next time the record loads into the scene, its points appear one by one, oldest first. */
export function growOnNextLoad(): void {
  growNext = true;
  shownData = null;
}

let loaded: BrainScene | null = null;
let loading: Promise<BrainScene> | null = null;

/** The one scene, loading it (and three.js) the first time it is asked for. */
export function loadScene(): Promise<BrainScene> {
  loading ??= import('./scene.ts').then(
    (m) => (loaded = m.brainScene()),
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading;
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
  const [scene, setScene] = useState<BrainScene | null>(loaded);
  const model = useBrainModel();
  const brain = useApp((s) => s.brain);
  const layout = useApp((s) => s.layout);
  const lit = useApp((s) => s.lit);
  const isolate = useApp((s) => s.isolate);
  const themeKey = useApp((s) => s.config?.appearance.theme ?? 'dusk');
  const opts = useApp((s) => s.config?.brain);
  const [ok, setOk] = useState(true);
  // The scene's own file didn't load, which is not a WebGL problem: most often Skeinwise was rebuilt since this page
  // opened, so the file name the page asks for is gone. ok goes false too, so a view that reads only ok still hides
  // its canvas.
  const [loadFailed, setLoadFailed] = useState(false);
  const [hover, setHover] = useState<Hover | null>(null);

  useEffect(() => {
    if (scene) return;
    let live = true;
    loadScene().then(
      (s) => live && setScene(s),
      () => {
        if (!live) return;
        setLoadFailed(true);
        setOk(false);
      },
    );
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!scene || !host.current) return;
    setOk(scene.attach(host.current, mode));
    return () => scene.detach();
  }, [scene, mode]);

  useEffect(() => {
    if (!scene) return;
    const t = theme(themeKey);
    scene.setTheme({ light: t.light, ground: t.ground, shell: mix(t.inkSoft, t.accent, 0.25), ink: t.ink });
  }, [scene, themeKey]);

  useEffect(() => {
    if (!scene || !model || !brain) return;
    if (shownData !== brain) {
      shownData = brain;
      scene.setData(model.input, growNext);
      growNext = false;
    } else scene.setColors(model.input.colors, model.input.points);
  }, [scene, model]);

  useEffect(() => {
    if (scene && opts) scene.setOptions({ pointSize: opts.pointSize, lineDensity: opts.lineDensity, labels: opts.labels, turning: opts.turning });
  }, [scene, opts]);

  useEffect(() => {
    if (!scene) return;
    if (mode === 'full') scene.setLayout(layout);
    else scene.setLayout('brain');
  }, [scene, layout, mode]);

  useEffect(() => {
    if (!scene || !model) return;
    const ids = spanLit ?? lit?.ids ?? null;
    const group = isolate === null ? null : model.legend.findIndex((g) => g.label === isolate);
    scene.setLit(litValues(model, ids, group === null || group < 0 ? null : group));
  }, [scene, model, lit, isolate, spanLit]);

  useEffect(() => {
    if (!scene) return;
    scene.onHover = setHover;
    scene.onOpen = (i) => {
      const id = model?.input.points[i]?.id;
      // A hub's point carries its hub id negated.
      if (id !== undefined) id < 0 ? openPanel({ kind: 'hub', id: -id }) : openEntry(id);
    };
  }, [scene, model]);

  return { scene, model, ok, loadFailed, hover };
}
