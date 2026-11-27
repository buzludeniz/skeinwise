// The brain: one WebGL view of every entry as a point of light. It opens on the clusters layout, one disc per colour
// group; in the brain layout, notes sit in the two lobes and originals wind up the stem below them in time order. The
// same scene moves between the Brain view and the Timeline's strip, where the points lie in one lane per source in
// time order, so the colours carry over.

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  LineSegments,
  Mesh,
  NormalBlending,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  Scene,
  ShaderMaterial,
  Vector3,
  WebGLRenderer,
} from 'three';
import { type AtlasShape, atlasShape, brainOutline, hash01, layoutFor, ringGuides, stripLayout, type Layout, type LayoutPoint } from '../layout.ts';
import { type AtlasLines, atlasLines } from './atlasMap.ts';
import { EntryIndex, hitsPerCountry, nameTiers, Placer, PROVINCE_MIN_RADIUS, shortTitle } from './mapNames.ts';
import { hexToRgb } from '../themes.ts';
import type { SceneInput } from './input.ts';
import { nearestPoint } from './pick.ts';

export type { SceneInput };

export type SceneMode = 'full' | 'strip';

export interface SceneOptions {
  pointSize: number;
  lineDensity: number;
  labels: boolean;
  turning: boolean;
}

export interface SceneTheme {
  light: boolean;
  ground: string;
  /** The faint outline's tone. */
  shell: string;
  ink: string;
}

export interface Hover {
  index: number;
  x: number;
  y: number;
}

const POINT_VERT = /* glsl */ `
attribute vec3 target;
attribute vec3 color;
attribute float size;
attribute float lit;
attribute float born;
uniform float uMix;
uniform float uScale;
uniform float uSize;
uniform float uGrow;
uniform float uAnyLit;
uniform float uRatio;
uniform float uRef;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec3 p = mix(position, target, uMix);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float shown = smoothstep(born - 0.02, born, uGrow);
  float boost = lit > 1.5 ? 1.7 : (lit < 0.5 ? 0.8 : 1.0);
  // On the map (uRef > 0, the fitted distance), a point grows only as the square root of the zoom, so close up the
  // points stay apart and their titles have room.
  float z = max(0.05, -mv.z);
  float d = uRef > 0.0 ? sqrt(z * uRef) : z;
  gl_PointSize = clamp(size * uSize * uScale / d * boost * shown, 0.0, 96.0) * uRatio;
  vColor = color;
  vAlpha = (lit < 0.5 ? (uAnyLit > 0.5 ? 0.1 : 0.16) : 1.0) * shown;
}`;

const POINT_FRAG = /* glsl */ `
uniform float uLight;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  if (d > 1.0) discard;
  if (uLight > 0.5) {
    // On a light ground a point is an ink dot about as wide as the glowing core on a dark one, with a faint rim.
    float a = smoothstep(0.6, 0.42, d) + smoothstep(1.0, 0.6, d) * 0.12;
    gl_FragColor = vec4(vColor, a * vAlpha * 0.9);
  } else {
    float core = smoothstep(0.42, 0.0, d);
    float halo = exp(-d * d * 5.0);
    float a = clamp(core * 0.95 + halo * 0.5, 0.0, 1.0);
    gl_FragColor = vec4(mix(vColor, vec3(1.0), core * 0.45), a * vAlpha);
  }
}`;

const LINE_VERT = /* glsl */ `
attribute vec3 target;
attribute vec3 color;
attribute float lit;
uniform float uMix;
uniform float uAnyLit;
uniform float uLitGain;
varying vec3 vColor;
varying float vLit;
void main() {
  vec3 p = mix(position, target, uMix);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  vColor = color;
  vLit = uAnyLit > 0.5 ? (lit > 1.5 ? uLitGain : 0.18) : (lit < 0.5 ? 0.2 : 1.0);
}`;

const LINE_FRAG = /* glsl */ `
uniform float uAlpha;
varying vec3 vColor;
varying float vLit;
void main() {
  gl_FragColor = vec4(vColor, clamp(uAlpha * vLit, 0.0, 1.0));
}`;

const SHELL_VERT = /* glsl */ `
attribute float shade;
uniform float uScale;
uniform float uRatio;
uniform float uShow;
varying float vShade;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(0.022 * uScale / max(0.05, -mv.z), 0.0, 8.0) * uRatio * uShow;
  vShade = shade;
}`;

const SHELL_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
uniform float uShow;
varying float vShade;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  if (d > 1.0) discard;
  gl_FragColor = vec4(uColor, (1.0 - d) * uAlpha * vShade * uShow);
}`;

// The selected point's marker: a ring around it, drawn over everything, so a selection never relies on colour alone.
const MARK_VERT = /* glsl */ `
attribute vec3 target;
uniform float uMix;
uniform float uScale;
uniform float uSize;
uniform float uBase;
uniform float uRatio;
void main() {
  vec4 mv = modelViewMatrix * vec4(mix(position, target, uMix), 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(uBase * uSize * uScale / max(0.05, -mv.z) * 1.9 + 14.0, 20.0, 120.0) * uRatio;
}`;

const MARK_FRAG = /* glsl */ `
uniform vec3 uColor;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = smoothstep(0.6, 0.72, d) * (1.0 - smoothstep(0.86, 0.98, d));
  if (a <= 0.0) discard;
  gl_FragColor = vec4(uColor, a);
}`;

const BACK_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy;
  gl_Position = vec4(position.xy, 0.9999, 1.0);
}`;

const BACK_FRAG = /* glsl */ `
uniform vec3 uGround;
uniform vec3 uLift;
uniform float uAspect;
varying vec2 vUv;
void main() {
  vec2 p = vec2(vUv.x * uAspect, vUv.y + 0.18);
  float d = length(p) / max(1.0, uAspect);
  gl_FragColor = vec4(mix(uLift, uGround, smoothstep(0.0, 1.1, d)), 1.0);
}`;

const rgb = (hex: string): [number, number, number] => hexToRgb(hex).map((v) => v / 255) as [number, number, number];

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

const LINK_STEPS = 8;
const FOV = 38;

interface Orbit {
  yaw: number;
  pitch: number;
  dist: number;
  target: Vector3;
}

export class BrainScene {
  readonly root: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly labelLayer: HTMLDivElement;
  private renderer: WebGLRenderer | null = null;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(FOV, 1, 0.01, 100);
  private readonly back: Mesh;
  private readonly backMat: ShaderMaterial;
  private readonly pointMat: ShaderMaterial;
  private readonly threadMat: ShaderMaterial;
  private readonly linkMat: ShaderMaterial;
  private readonly crossMat: ShaderMaterial;
  private readonly spokeMat: ShaderMaterial;
  private readonly shellMat: ShaderMaterial;
  private readonly ringMat: ShaderMaterial;
  private points: Points | null = null;
  private threadLines: LineSegments | null = null;
  private linkLines: LineSegments | null = null;
  private crossLines: LineSegments | null = null;
  private spokeLines: LineSegments | null = null;
  private shell: Points | null = null;
  private rings: LineSegments | null = null;
  /** The map's borders, coast and terrain, drawn only in the map layout of the full view. */
  private readonly borderMat: ShaderMaterial;
  private readonly provinceMat: ShaderMaterial;
  private readonly terrainMat: ShaderMaterial;
  private mapLines: LineSegments[] = [];
  /** The map's lines and names for the current points, worked out once per record. */
  private mapCache: { input: SceneInput; lines: AtlasLines; names: MapNames } | null = null;
  /** Whether the map's names were placed in the last frame drawn (so leaving the map hides them once). */
  private namesOn = false;
  /** For measuring entry titles without laying out the page; widths kept by text. */
  private measure: CanvasRenderingContext2D | null = null;
  private readonly widths = new Map<string, number>();
  private readonly markMat: ShaderMaterial;
  private readonly selectMat: ShaderMaterial;
  private mark: Points | null = null;
  private selectLines: LineSegments | null = null;
  /** The selected point's index, or -1. Its marker and its own lines follow it through moves. */
  private selected = -1;
  private selectDirty = false;

  private input: SceneInput | null = null;
  private layouts = new Map<Layout | 'strip', Float32Array>();
  /** The default, as the store's and the config's: the scene starts where the view will ask it to be. */
  private layout: Layout = 'atlas';
  /** Where every point is drawn now, once the current move ends. */
  private current = new Float32Array(0);
  private from = new Float32Array(0);
  private lit = new Float32Array(0);
  private anyLit = false;
  private mix = 1;
  private moveStart = 0;
  private moveMs = 900;
  private grow = 1;
  private growStart = 0;
  private growMs = 0;
  private shellShow = 1;

  private mode: SceneMode = 'full';
  private orbit: Orbit = { yaw: 0.55, pitch: 0.1, dist: 7, target: new Vector3(0, -0.6, 0) };
  private goal: Orbit | null = null;
  private turning = true;
  private touched = false;
  /** The system asks for less motion: no turning, and moves, growth and camera glides land at once. Follows the setting live. */
  private reducedMotion: boolean;
  private readonly motionQuery: MediaQueryList | null;
  private options: SceneOptions = { pointSize: 1, lineDensity: 0.6, labels: true, turning: true };
  private theme: SceneTheme = { light: false, ground: '#0f1219', shell: '#8d9ab8', ink: '#e9e4d8' };

  private width = 1;
  private height = 1;
  private ratio = 1;
  private frame = 0;
  private last = 0;
  private dirty = true;
  private resizer: ResizeObserver | null = null;
  private labelEls: LabelEl[] = [];
  /** The label that has keyboard focus: always shown, wherever its point is. -1 when none. */
  private focusedLabel = -1;

  private pointers = new Map<number, { x: number; y: number }>();
  private dragMoved = 0;
  private pinch = 0;
  private hoverAt: { x: number; y: number } | null = null;
  private hovered = -1;

  onHover: (hover: Hover | null) => void = () => undefined;
  onOpen: (index: number) => void = () => undefined;
  /** A click on a point or its label selects it; a click on empty space passes -1. `keyboard` when a key pressed the label. */
  onSelect: (index: number, keyboard: boolean) => void = () => undefined;
  onTouch: () => void = () => undefined;

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'brain-root';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'brain-canvas';
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', canvasLabel(this.layout));
    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'brain-labels';
    this.labelLayer.setAttribute('role', 'group');
    this.labelLayer.setAttribute('aria-label', 'Labelled hubs and notes');
    this.root.append(this.canvas, this.labelLayer);
    this.motionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    this.reducedMotion = this.motionQuery?.matches ?? false;
    this.motionQuery?.addEventListener('change', this.onMotionChange);

    this.backMat = new ShaderMaterial({
      vertexShader: BACK_VERT,
      fragmentShader: BACK_FRAG,
      uniforms: { uGround: { value: new Vector3() }, uLift: { value: new Vector3() }, uAspect: { value: 1 } },
      depthTest: false,
      depthWrite: false,
    });
    this.back = new Mesh(new PlaneGeometry(2, 2), this.backMat);
    this.back.frustumCulled = false;
    this.back.renderOrder = -10;
    this.scene.add(this.back);

    const pointUniforms = {
      uMix: { value: 1 },
      uScale: { value: 1 },
      uSize: { value: 1 },
      uGrow: { value: 1 },
      uAnyLit: { value: 0 },
      uRatio: { value: 1 },
      uLight: { value: 0 },
      uRef: { value: 0 },
    };
    this.pointMat = new ShaderMaterial({
      vertexShader: POINT_VERT,
      fragmentShader: POINT_FRAG,
      uniforms: pointUniforms,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    // A faint line kind gains more when lit, so a lit hub's spokes or a lit entry's cross links stand out.
    const lineMat = (alpha: number, litGain = 2.2) =>
      new ShaderMaterial({
        vertexShader: LINE_VERT,
        fragmentShader: LINE_FRAG,
        uniforms: { uMix: { value: 1 }, uAnyLit: { value: 0 }, uAlpha: { value: alpha }, uLitGain: { value: litGain } },
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      });
    this.threadMat = lineMat(0.12);
    this.linkMat = lineMat(0.34);
    this.crossMat = lineMat(0.08, 4);
    this.spokeMat = lineMat(0.05, 7);
    this.ringMat = lineMat(0.16);
    this.borderMat = lineMat(0.42);
    this.provinceMat = lineMat(0.16);
    this.terrainMat = lineMat(0.07);
    this.shellMat = new ShaderMaterial({
      vertexShader: SHELL_VERT,
      fragmentShader: SHELL_FRAG,
      uniforms: {
        uScale: { value: 1 },
        uRatio: { value: 1 },
        uShow: { value: 1 },
        uColor: { value: new Vector3(0.55, 0.6, 0.72) },
        uAlpha: { value: 0.32 },
      },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });

    this.markMat = new ShaderMaterial({
      vertexShader: MARK_VERT,
      fragmentShader: MARK_FRAG,
      uniforms: {
        uMix: { value: 1 },
        uScale: { value: 1 },
        uSize: { value: 1 },
        uBase: { value: 0.1 },
        uRatio: { value: 1 },
        uColor: { value: new Vector3(0.91, 0.89, 0.85) },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: NormalBlending,
    });
    this.selectMat = lineMat(0.55);
    this.selectMat.blending = NormalBlending;

    const { positions, shade } = brainOutline();
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(positions, 3));
    g.setAttribute('shade', new BufferAttribute(shade, 1));
    this.shell = new Points(g, this.shellMat);
    this.shell.frustumCulled = false;
    this.shell.renderOrder = 0;
    this.scene.add(this.shell);

    this.bindInput();
  }

  /** Puts the canvas into a host element. Returns false when WebGL is not available. */
  attach(host: HTMLElement, mode: SceneMode): boolean {
    if (!this.renderer) {
      try {
        this.renderer = new WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
      } catch {
        return false;
      }
      this.renderer.autoClear = true;
    }
    host.append(this.root);
    const moved = mode !== this.mode;
    this.mode = mode;
    this.root.dataset.mode = mode;
    if (mode !== 'full') this.select(-1);
    // Into or out of the strip: the points change places at once, and the outline and guides follow the mode.
    if (moved && this.input) {
      this.moveTo(this.layout, false);
      this.buildRings();
    }
    this.resizer?.disconnect();
    this.resizer = new ResizeObserver(() => this.resize());
    this.resizer.observe(host);
    this.resize();
    this.fit(false);
    if (!this.frame) this.frame = requestAnimationFrame(this.tick);
    return true;
  }

  detach(): void {
    this.resizer?.disconnect();
    this.resizer = null;
    this.root.remove();
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.setHover(-1);
  }

  get attached(): boolean {
    return this.root.isConnected;
  }

  focus(): void {
    this.canvas.focus();
  }

  setTheme(theme: SceneTheme): void {
    this.theme = theme;
    const ground = rgb(theme.ground);
    const lift = theme.light ? ground.map((v) => Math.min(1, v * 1.03 + 0.02)) : ground.map((v, i) => v * 1.5 + [0.02, 0.025, 0.045][i]!);
    this.backMat.uniforms.uGround!.value.set(...ground);
    this.backMat.uniforms.uLift!.value.set(...lift);
    const blend = theme.light ? NormalBlending : AdditiveBlending;
    for (const m of [this.pointMat, this.threadMat, this.linkMat, this.crossMat, this.spokeMat, this.shellMat, this.ringMat, this.borderMat, this.provinceMat, this.terrainMat]) {
      m.blending = blend;
      m.needsUpdate = true;
    }
    this.pointMat.uniforms.uLight!.value = theme.light ? 1 : 0;
    this.shellMat.uniforms.uColor!.value.set(...rgb(theme.shell));
    this.shellMat.uniforms.uAlpha!.value = theme.light ? 0.2 : 0.3;
    this.threadMat.uniforms.uAlpha!.value = theme.light ? 0.16 : 0.12;
    this.linkMat.uniforms.uAlpha!.value = theme.light ? 0.4 : 0.34;
    this.crossMat.uniforms.uAlpha!.value = theme.light ? 0.12 : 0.08;
    this.spokeMat.uniforms.uAlpha!.value = theme.light ? 0.08 : 0.05;
    this.ringMat.uniforms.uAlpha!.value = theme.light ? 0.25 : 0.16;
    this.borderMat.uniforms.uAlpha!.value = theme.light ? 0.5 : 0.38;
    this.provinceMat.uniforms.uAlpha!.value = theme.light ? 0.2 : 0.15;
    this.terrainMat.uniforms.uAlpha!.value = theme.light ? 0.09 : 0.07;
    this.markMat.uniforms.uColor!.value.set(...rgb(theme.ink));
    if (this.input) this.buildRings();
    this.selectDirty = true;
    this.dirty = true;
  }

  setOptions(options: SceneOptions): void {
    const densityChanged = options.lineDensity !== this.options.lineDensity;
    this.options = options;
    this.turning = options.turning && !this.touched && !this.reducedMotion;
    this.pointMat.uniforms.uSize!.value = options.pointSize;
    this.markMat.uniforms.uSize!.value = options.pointSize;
    if (densityChanged) this.applyDensity();
    this.syncLabels();
    this.dirty = true;
  }

  /** New points. With grow, they appear one by one in time order. */
  setData(input: SceneInput, grow = false): void {
    this.input = input;
    this.layouts.clear();
    this.atlasRef = 0;
    this.canvas.setAttribute('aria-label', canvasLabel(this.flat ? 'atlas' : this.layout === 'atlas' ? 'clusters' : this.layout));
    const n = input.points.length;
    const pos = this.layoutOf(this.layout);
    this.current = pos.slice();
    this.from = pos.slice();
    this.lit = new Float32Array(n).fill(1);
    this.anyLit = false;
    this.mix = 1;
    // The outline shows from the first frame only in the layout that has it, whichever layout the scene opens on.
    this.applyMix();
    this.selected = -1;
    this.selectDirty = true;

    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(this.from, 3));
    g.setAttribute('target', new BufferAttribute(this.current.slice(), 3));
    g.setAttribute('color', new BufferAttribute(input.colors, 3));
    g.setAttribute('size', new BufferAttribute(input.sizes, 1));
    g.setAttribute('lit', new BufferAttribute(this.lit, 1));
    const born = new Float32Array(n);
    const order = [...input.points.keys()].sort((a, b) => input.points[a]!.time - input.points[b]!.time || a - b);
    order.forEach((i, rank) => (born[i] = n <= 1 ? 0 : rank / (n - 1)));
    g.setAttribute('born', new BufferAttribute(born, 1));
    if (this.points) {
      this.scene.remove(this.points);
      this.points.geometry.dispose();
    }
    this.points = new Points(g, this.pointMat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    this.scene.add(this.points);

    this.buildLines();
    this.buildRings();
    this.buildLabels();
    if (grow && !this.reducedMotion) {
      this.grow = 0;
      this.growStart = performance.now();
      this.growMs = Math.min(6000, 1600 + n * 6);
    } else this.grow = 1;
    this.pointMat.uniforms.uGrow!.value = this.grow;
    if (!this.touched) this.fit(false);
    this.dirty = true;
  }

  /** New colours (and, for the clusters layout, new places) after the grouping or palette changes. */
  setColors(colors: Float32Array, points: LayoutPoint[]): void {
    if (!this.input || !this.points) return;
    this.input = { ...this.input, colors, points };
    this.points.geometry.setAttribute('color', new BufferAttribute(colors, 3));
    this.layouts.delete('clusters');
    if (!this.input.atlas) this.layouts.delete('atlas');
    if (this.layout === 'clusters' || (this.layout === 'atlas' && !this.input.atlas)) this.moveTo(this.layout, true);
    this.buildLines();
    this.selectDirty = true;
    this.dirty = true;
  }

  setLayout(layout: Layout): void {
    if (layout === this.layout) return;
    this.moveTo(layout, true);
    this.goal = this.fitOrbit(layout);
    if (this.reducedMotion) {
      this.orbit = this.goal;
      this.goal = null;
    }
  }

  get currentLayout(): Layout {
    return this.layout;
  }

  /** Lights some points and dims the rest: 2 = lit, 1 = as usual, 0 = dimmed. Null puts everything back. */
  setLit(values: Float32Array<ArrayBuffer> | null): void {
    if (!this.points || !this.input) return;
    const n = this.input.points.length;
    this.lit = values && values.length === n ? values : new Float32Array(n).fill(1);
    this.anyLit = !!values && this.lit.some((v) => v > 1.5);
    const attr = new BufferAttribute(this.lit, 1);
    this.points.geometry.setAttribute('lit', attr);
    this.pointMat.uniforms.uAnyLit!.value = this.anyLit ? 1 : 0;
    for (const m of [this.threadMat, this.linkMat, this.crossMat, this.spokeMat]) m.uniforms.uAnyLit!.value = this.anyLit ? 1 : 0;
    this.buildLineLit();
    this.syncLabels();
    this.dirty = true;
  }

  /** Frames the whole cloud. */
  fit(animate = true): void {
    const goal = this.fitOrbit(this.layout);
    if (animate && !this.reducedMotion) this.goal = goal;
    else {
      this.orbit = goal;
      this.goal = null;
    }
    this.dirty = true;
  }

  /** Less motion: stops the turning and finishes any move, growth or camera glide now. Turning comes back when it is lifted. */
  setReducedMotion(reduce: boolean): void {
    this.reducedMotion = reduce;
    this.turning = this.options.turning && !this.touched && !reduce;
    if (reduce) {
      if (this.goal) {
        this.orbit = this.goal;
        this.goal = null;
      }
      if (this.mix < 1) {
        this.mix = 1;
        this.applyMix();
        this.buildRings();
      }
      if (this.grow < 1) {
        this.grow = 1;
        this.pointMat.uniforms.uGrow!.value = 1;
      }
    }
    this.dirty = true;
  }

  private onMotionChange = (e: MediaQueryListEvent): void => this.setReducedMotion(e.matches);

  dispose(): void {
    this.motionQuery?.removeEventListener('change', this.onMotionChange);
    this.detach();
    this.renderer?.dispose();
    this.renderer = null;
  }

  /** Where a point is on screen, in CSS pixels from the canvas's top left; null when behind the camera. */
  screenOf(index: number): { x: number; y: number } | null {
    const p = this.pointAt(index);
    const v = new Vector3(p[0], p[1], p[2]).project(this.camera);
    if (v.z > 1) return null;
    return { x: ((v.x + 1) / 2) * this.width, y: ((1 - v.y) / 2) * this.height };
  }

  /** Marks one point as selected, with a ring and its own lines drawn brighter; -1 clears it. Only the Brain view selects. */
  select(index: number): void {
    const n = this.input?.points.length ?? 0;
    const next = index >= 0 && index < n && this.mode === 'full' ? index : -1;
    if (next === this.selected) return;
    this.selected = next;
    this.selectDirty = true;
    this.dirty = true;
  }

  get selectedIndex(): number {
    return this.selected;
  }

  /** Puts keyboard focus on the label of this point, if it has one; otherwise on the canvas. */
  focusLabel(index: number): void {
    const label = this.labelEls.find((l) => l.index === index);
    if (label && !this.labelLayer.classList.contains('hidden')) label.el.focus({ preventScroll: true });
    else this.canvas.focus({ preventScroll: true });
  }

  // Layout and moves.

  /** Where the points sit in a layout; the strip, whatever the layout, lays them in lanes. */
  private layoutOf(layout: Layout): Float32Array {
    const key = this.mode === 'strip' ? 'strip' : layout;
    let pos = this.layouts.get(key);
    if (!pos) {
      const points = this.input?.points ?? [];
      const sources = this.input?.sources ?? [];
      pos = key === 'strip' ? stripLayout(points, sources) : layoutFor(layout, points, this.input?.atlas ?? null);
      this.layouts.set(key, pos);
    }
    return pos;
  }

  /** The map is drawn: its layout, in the full view, with every hub placed. Then the camera looks straight down and pans. */
  private get flat(): boolean {
    return this.layout === 'atlas' && this.mode === 'full' && !!this.input?.atlas;
  }

  /** The camera distance that frames the whole map, which sets how points grow as the map zooms in. 0 until needed. */
  private atlasRef = 0;

  /** The brain's outline belongs to the brain layout in the full view, not to the strip. */
  private get shellShown(): boolean {
    return this.layout === 'brain' && this.mode === 'full';
  }

  /** Where point i is drawn right now: mid-move, on the same eased path the shaders draw. */
  private pointAt(i: number): [number, number, number] {
    const k = i * 3;
    if (this.mix >= 1) return [this.current[k]!, this.current[k + 1]!, this.current[k + 2]!];
    const t = easeInOut(this.mix);
    return [
      this.from[k]! + (this.current[k]! - this.from[k]!) * t,
      this.from[k + 1]! + (this.current[k + 1]! - this.from[k + 1]!) * t,
      this.from[k + 2]! + (this.current[k + 2]! - this.from[k + 2]!) * t,
    ];
  }

  private moveTo(layout: Layout, animate: boolean): void {
    this.layout = layout;
    this.canvas.setAttribute('aria-label', canvasLabel(this.flat ? 'atlas' : layout === 'atlas' ? 'clusters' : layout));
    if (!this.points || !this.input) return;
    const n = this.input.points.length;
    const now = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) now.set(this.pointAt(i), i * 3);
    this.from = now;
    this.current = this.layoutOf(layout).slice();
    const g = this.points.geometry;
    g.setAttribute('position', new BufferAttribute(this.from, 3));
    g.setAttribute('target', new BufferAttribute(this.current, 3));
    const fromLines = {
      threads: this.threadLines?.geometry.getAttribute('position'),
      links: this.linkLines?.geometry.getAttribute('position'),
      cross: this.crossLines?.geometry.getAttribute('position'),
      spokes: this.spokeLines?.geometry.getAttribute('position'),
    };
    this.buildLines(fromLines);
    if (animate && !this.reducedMotion) {
      this.mix = 0;
      this.moveStart = performance.now();
    } else this.mix = 1;
    this.applyMix();
    // The map's lines show once the points are in place, and go at once when the points leave.
    if (this.mix >= 1) this.buildRings();
    else this.dropMap();
    this.buildLabels();
    this.selectDirty = true;
    this.dirty = true;
  }

  private applyMix(): void {
    const t = easeInOut(this.mix);
    for (const m of [this.pointMat, this.threadMat, this.linkMat, this.crossMat, this.spokeMat, this.markMat, this.selectMat]) m.uniforms.uMix!.value = t;
    this.shellShow = this.shellShown ? Math.max(this.shellShow, t) : Math.min(this.shellShow, 1 - t);
    this.shellMat.uniforms.uShow!.value = this.shellShow;
    if (this.rings) this.ringMat.uniforms.uMix!.value = 1;
  }

  // Lines.

  /** Line vertices: one segment per pair, or with a bow, a curve of LINK_STEPS segments arcing outward by bow × length. */
  private lineVertices(pos: Float32Array, pairs: Uint32Array, curved: boolean, bow = 0.35): Float32Array {
    if (!curved) {
      const out = new Float32Array(pairs.length * 3);
      for (let k = 0; k < pairs.length; k++) out.set(pos.subarray(pairs[k]! * 3, pairs[k]! * 3 + 3), k * 3);
      return out;
    }
    const segs = pairs.length / 2;
    const out = new Float32Array(segs * LINK_STEPS * 2 * 3);
    let o = 0;
    for (let s = 0; s < segs; s++) {
      const a = pos.subarray(pairs[s * 2]! * 3, pairs[s * 2]! * 3 + 3);
      const b = pos.subarray(pairs[s * 2 + 1]! * 3, pairs[s * 2 + 1]! * 3 + 3);
      // Bow the link outward from the middle of the cloud, so it arcs over the surface.
      const m = [(a[0]! + b[0]!) / 2, (a[1]! + b[1]!) / 2, (a[2]! + b[2]!) / 2];
      const len = Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
      const out0 = [m[0]!, m[1]! - 0.5, m[2]!];
      const ol = Math.hypot(out0[0]!, out0[1]!, out0[2]!) || 1;
      const c = [m[0]! + (out0[0]! / ol) * len * bow, m[1]! + (out0[1]! / ol) * len * bow, m[2]! + (out0[2]! / ol) * len * bow];
      let prev = [a[0]!, a[1]!, a[2]!];
      for (let k = 1; k <= LINK_STEPS; k++) {
        const t = k / LINK_STEPS;
        const u = 1 - t;
        const p = [0, 1, 2].map((d) => u * u * a[d]! + 2 * u * t * c[d]! + t * t * b[d]!);
        out.set(prev, o);
        out.set(p, o + 3);
        o += 6;
        prev = p;
      }
    }
    return out;
  }

  private lineColors(pairs: Uint32Array, curved: boolean): Float32Array {
    const colors = this.input!.colors;
    const per = curved ? LINK_STEPS * 2 : 1;
    const out = new Float32Array((curved ? pairs.length / 2 : pairs.length) * per * 3);
    if (!curved) {
      for (let k = 0; k < pairs.length; k++) out.set(colors.subarray(pairs[k]! * 3, pairs[k]! * 3 + 3), k * 3);
      return out;
    }
    for (let s = 0; s < pairs.length / 2; s++) {
      const a = colors.subarray(pairs[s * 2]! * 3, pairs[s * 2]! * 3 + 3);
      const b = colors.subarray(pairs[s * 2 + 1]! * 3, pairs[s * 2 + 1]! * 3 + 3);
      for (let v = 0; v < per; v++) {
        const t = (Math.floor(v / 2) + (v % 2)) / LINK_STEPS;
        for (let d = 0; d < 3; d++) out[(s * per + v) * 3 + d] = a[d]! + (b[d]! - a[d]!) * t;
      }
    }
    return out;
  }

  /** Thread pairs in a fixed shuffled order, so drawing the first part of them shows an even sample. */
  private threadOrder: Uint32Array = new Uint32Array(0);

  private buildLines(from?: { threads?: unknown; links?: unknown; cross?: unknown; spokes?: unknown }): void {
    if (!this.input) return;
    const pos = this.layoutOf(this.layout);
    const { threads, links, cross, spokes } = this.input;
    if (!from) {
      const segs = threads.length / 2;
      const idx = [...Array(segs).keys()].sort((a, b) => hash01(a, 11) - hash01(b, 11));
      this.threadOrder = new Uint32Array(threads.length);
      idx.forEach((s, k) => {
        this.threadOrder[k * 2] = threads[s * 2]!;
        this.threadOrder[k * 2 + 1] = threads[s * 2 + 1]!;
      });
    }
    const make = (pairs: Uint32Array, curved: boolean, mat: ShaderMaterial, old: LineSegments | null, oldPos: unknown, bow?: number) => {
      const target = this.lineVertices(pos, pairs, curved, bow);
      const start = oldPos instanceof BufferAttribute && oldPos.array.length === target.length ? this.mixedLine(old!) : target.slice();
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(start, 3));
      g.setAttribute('target', new BufferAttribute(target, 3));
      g.setAttribute('color', new BufferAttribute(this.lineColors(pairs, curved), 3));
      g.setAttribute('lit', new BufferAttribute(new Float32Array(target.length / 3).fill(1), 1));
      if (old) {
        this.scene.remove(old);
        old.geometry.dispose();
      }
      const lines = new LineSegments(g, mat);
      lines.frustumCulled = false;
      lines.renderOrder = 1;
      this.scene.add(lines);
      return lines;
    };
    this.threadLines = make(this.threadOrder, false, this.threadMat, this.threadLines, from?.threads);
    this.linkLines = make(links, true, this.linkMat, this.linkLines, from?.links);
    // Cross links bow only a little: most join points in the stem, and a full arc would loop far outside the brain.
    this.crossLines = make(cross, true, this.crossMat, this.crossLines, from?.cross, 0.08);
    this.spokeLines = make(spokes, false, this.spokeMat, this.spokeLines, from?.spokes);
    this.applyDensity();
    this.buildLineLit();
  }

  /** The line positions as drawn right now, mid-move included. */
  private mixedLine(lines: LineSegments): Float32Array {
    const a = lines.geometry.getAttribute('position').array as Float32Array;
    const b = lines.geometry.getAttribute('target').array as Float32Array;
    const t = easeInOut(this.mix);
    const out = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = a[i]! + (b[i]! - a[i]!) * t;
    return out;
  }

  private applyDensity(): void {
    const d = this.options.lineDensity;
    if (this.threadLines) {
      const verts = this.threadOrder.length;
      this.threadLines.geometry.setDrawRange(0, Math.floor((verts / 2) * d * d) * 2);
      this.threadLines.visible = d > 0;
    }
    if (this.linkLines) this.linkLines.visible = d > 0;
    if (this.crossLines) this.crossLines.visible = d > 0;
    // On the map a hub's spokes would be a starburst over its own country, which the borders already show.
    if (this.spokeLines) this.spokeLines.visible = d > 0 && !this.flat;
    this.selectDirty = true;
    this.dirty = true;
  }

  private buildLineLit(): void {
    const set = (lines: LineSegments | null, pairs: Uint32Array, per: number) => {
      if (!lines) return;
      const attr = lines.geometry.getAttribute('lit') as BufferAttribute;
      const arr = attr.array as Float32Array;
      for (let s = 0; s < pairs.length / 2; s++) {
        const v = Math.min(this.lit[pairs[s * 2]!] ?? 1, this.lit[pairs[s * 2 + 1]!] ?? 1);
        arr.fill(v, s * per, s * per + per);
      }
      attr.needsUpdate = true;
    };
    set(this.threadLines, this.threadOrder, 2);
    if (this.input) set(this.linkLines, this.input.links, LINK_STEPS * 2);
    if (this.input) set(this.crossLines, this.input.cross, LINK_STEPS * 2);
    if (this.input) set(this.spokeLines, this.input.spokes, 2);
  }

  // The selection.

  /**
   * The selected point's ring and its own lines (its links, cross links, spokes and thread steps), in ink, over the
   * rest. Rebuilt when the selection, the layout, the line density, the theme or the data change, never once a frame;
   * the shaders carry them through a move, as they do the points and lines.
   */
  private buildSelection(): void {
    this.selectDirty = false;
    const i = this.selected;
    if (this.mark) {
      this.scene.remove(this.mark);
      this.mark.geometry.dispose();
      this.mark = null;
    }
    if (this.selectLines) {
      this.scene.remove(this.selectLines);
      this.selectLines.geometry.dispose();
      this.selectLines = null;
    }
    if (i < 0 || !this.input) return;
    // Built once per selection, layout move or new data, not once a frame: like the points and lines, it starts where
    // it was drawn (from) and the shaders carry it to where it goes (current) as uMix runs.
    const mg = new BufferGeometry();
    mg.setAttribute('position', new BufferAttribute(this.from.slice(i * 3, i * 3 + 3), 3));
    mg.setAttribute('target', new BufferAttribute(this.current.slice(i * 3, i * 3 + 3), 3));
    this.markMat.uniforms.uBase!.value = this.input.sizes[i] ?? 0.1;
    this.mark = new Points(mg, this.markMat);
    this.mark.frustumCulled = false;
    this.mark.renderOrder = 4;
    this.scene.add(this.mark);

    // The pairs touching i, curved like the lines they lie over.
    const touching = (pairs: Uint32Array) => {
      const out: number[] = [];
      for (let k = 0; k + 1 < pairs.length; k += 2) if (pairs[k] === i || pairs[k + 1] === i) out.push(pairs[k]!, pairs[k + 1]!);
      return Uint32Array.from(out);
    };
    const starts: Float32Array[] = [];
    const parts: Float32Array[] = [];
    const add = (pairs: Uint32Array, curved: boolean, bow?: number) => {
      starts.push(this.lineVertices(this.from, pairs, curved, bow));
      parts.push(this.lineVertices(this.current, pairs, curved, bow));
    };
    if (this.options.lineDensity > 0) {
      add(touching(this.input.links), true);
      add(touching(this.input.cross), true, 0.08);
      add(touching(this.input.spokes), false);
      add(touching(this.threadOrder), false);
    }
    const length = parts.reduce((sum, p) => sum + p.length, 0);
    if (!length) return;
    const join = (list: Float32Array[]) => {
      const out = new Float32Array(length);
      let o = 0;
      for (const p of list) {
        out.set(p, o);
        o += p.length;
      }
      return out;
    };
    const pos = join(parts);
    const colors = new Float32Array(pos.length);
    const ink = rgb(this.theme.ink);
    for (let k = 0; k < colors.length; k += 3) colors.set(ink, k);
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(join(starts), 3));
    g.setAttribute('target', new BufferAttribute(pos, 3));
    g.setAttribute('color', new BufferAttribute(colors, 3));
    g.setAttribute('lit', new BufferAttribute(new Float32Array(pos.length / 3).fill(1), 1));
    this.selectLines = new LineSegments(g, this.selectMat);
    this.selectLines.frustumCulled = false;
    this.selectLines.renderOrder = 3;
    this.scene.add(this.selectLines);
  }

  private dropMap(): void {
    for (const lines of this.mapLines) {
      this.scene.remove(lines);
      lines.geometry.dispose();
    }
    this.mapLines = [];
  }

  /**
   * The map's names, made once per record and shown by placeMapLabels: a name per country (used where its hub has no
   * label button), one per province, and a pool of entry titles filled as the view needs them. They are not in the
   * reading order: the canvas and the label buttons carry everything they say.
   */
  private buildNames(input: SceneInput, shape: AtlasShape): MapNames {
    const atlas = input.atlas!;
    const { points } = input;
    const name = (kind: string, text: string) => {
      const el = document.createElement('div');
      el.className = `map-name ${kind}`;
      el.textContent = text;
      el.setAttribute('aria-hidden', 'true');
      this.labelLayer.append(el);
      return el;
    };
    const capital = new Int32Array(atlas.hubs.length).fill(-1);
    points.forEach((p, i) => {
      if (p.id < 0 && atlas.hubOf[i]! >= 0) capital[atlas.hubOf[i]!] = i;
    });
    const countries = atlas.hubs
      .map((h, k) => ({ hub: k, el: name('country', shortTitle(h.name, 34)), w: 0, h: 0 }))
      .sort((a, b) => shape.hubs[b.hub]!.r - shape.hubs[a.hub]!.r || a.hub - b.hub);
    const provinces = atlas.hubs
      .flatMap((h, k) => h.parts.map((part, j) => ({ hub: k, part: j, text: shortTitle(part.name, 28), r: shape.provinces[k]![j]!.r })))
      .filter((p) => p.text && p.r > 0)
      .sort((a, b) => b.r - a.r || a.hub - b.hub || a.part - b.part)
      .map(({ hub, part, text }) => ({ hub, part, el: name('province', text), w: 0, h: 0 }));
    return {
      shape,
      country: Int32Array.from(points, (p, i) => (p.id < 0 ? -1 : atlas.hubOf[i]!)),
      capital,
      countries,
      provinces,
      pool: [],
      index: new EntryIndex(this.layoutOf('atlas'), (i) => points[i]!.id >= 0),
      placer: new Placer(),
      hitsOf: null,
    };
  }

  private dropNames(names: MapNames): void {
    for (const n of [...names.countries, ...names.provinces, ...names.pool]) n.el.remove();
  }

  /** The map's borders, coast and faint terrain, in ink, under the points; only while the map is drawn. */
  private buildMap(): void {
    this.dropMap();
    const input = this.input;
    if (!input?.atlas || !this.flat) return;
    if (this.mapCache?.input !== input) {
      const { atlas, points } = input;
      const loose = atlas.hubs.length;
      // Entries in no hub are land of their own; a hub's own point is no land at all.
      const country = Int32Array.from(points, (p, i) => (p.id < 0 ? -2 : atlas.hubOf[i]! < 0 ? loose : atlas.hubOf[i]!));
      const province = Int32Array.from(points, (p, i) => (atlas.hubOf[i]! < 0 ? 0 : atlas.partOf[i]!));
      const shape = atlasShape(points, atlas);
      if (this.mapCache) this.dropNames(this.mapCache.names);
      this.mapCache = { input, lines: atlasLines(this.layoutOf('atlas'), country, province, shape), names: this.buildNames(input, shape) };
    }
    const { countries, provinces, coast, terrain } = this.mapCache.lines;
    const ink = rgb(this.theme.ink);
    for (const [pos, mat] of [
      [terrain, this.terrainMat],
      [provinces, this.provinceMat],
      [countries, this.borderMat],
      [coast, this.borderMat],
    ] as const) {
      if (!pos.length) continue;
      const colors = new Float32Array(pos.length);
      for (let i = 0; i < colors.length; i += 3) colors.set(ink, i);
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(pos, 3));
      g.setAttribute('target', new BufferAttribute(pos, 3));
      g.setAttribute('color', new BufferAttribute(colors, 3));
      g.setAttribute('lit', new BufferAttribute(new Float32Array(pos.length / 3).fill(1), 1));
      const lines = new LineSegments(g, mat);
      lines.frustumCulled = false;
      lines.renderOrder = 0;
      this.scene.add(lines);
      this.mapLines.push(lines);
    }
  }

  /** The activity layout's guides: a faint circle per year, with month spokes, only in that layout and the full view. */
  private buildRings(): void {
    this.buildMap();
    if (this.rings) {
      this.scene.remove(this.rings);
      this.rings.geometry.dispose();
      this.rings = null;
    }
    for (const el of this.labelLayer.querySelectorAll('.ring-label')) el.remove();
    if (!this.input || this.layout !== 'rings' || this.mode !== 'full') return;
    const guides = ringGuides(this.input.points);
    const v: number[] = [];
    const steps = 96;
    for (const [, inner, outer] of guides) {
      for (const r of [inner, outer]) {
        for (let k = 0; k < steps; k++) {
          const a0 = (k / steps) * Math.PI * 2;
          const a1 = ((k + 1) / steps) * Math.PI * 2;
          v.push(Math.cos(a0) * r, -0.02, Math.sin(a0) * r, Math.cos(a1) * r, -0.02, Math.sin(a1) * r);
        }
      }
    }
    const outerMost = guides.length ? guides[guides.length - 1]![2] : 1;
    for (let m = 0; m < 12; m++) {
      const a = (m / 12) * Math.PI * 2 - Math.PI / 2;
      v.push(Math.cos(a) * 0.3, -0.02, Math.sin(a) * 0.3, Math.cos(a) * outerMost, -0.02, Math.sin(a) * outerMost);
    }
    const pos = new Float32Array(v);
    const ink = rgb(this.theme.ink);
    const colors = new Float32Array(pos.length);
    for (let i = 0; i < colors.length; i += 3) colors.set(ink, i);
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('target', new BufferAttribute(pos, 3));
    g.setAttribute('color', new BufferAttribute(colors, 3));
    g.setAttribute('lit', new BufferAttribute(new Float32Array(pos.length / 3).fill(1), 1));
    this.rings = new LineSegments(g, this.ringMat);
    this.rings.frustumCulled = false;
    this.scene.add(this.rings);
    this.ringLabels = guides.map(([year, inner, outer]) => {
      const el = document.createElement('div');
      el.className = 'ring-label';
      el.textContent = String(year);
      this.labelLayer.append(el);
      return { el, at: new Vector3(0, 0, -(inner + outer) / 2) };
    });
  }

  private ringLabels: { el: HTMLDivElement; at: Vector3 }[] = [];

  // Labels.

  /**
   * The labels are buttons: a click or Enter selects the point, and Tab steps through them in order, hubs first and
   * biggest first. A rebuild keeps keyboard focus on the same label.
   */
  private buildLabels(): void {
    const had = this.labelEls.find((l) => l.el === document.activeElement)?.el.getAttribute('aria-label') ?? null;
    for (const { el } of this.labelEls) el.remove();
    this.labelEls = [];
    this.focusedLabel = -1;
    // New buttons carry no hit counts yet.
    if (this.mapCache) this.mapCache.names.hitsOf = null;
    if (!this.input) return;
    const max = this.width < 700 ? 6 : 12;
    for (const { index, text, name } of this.input.labels.slice(0, max)) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'brain-label';
      el.textContent = text.length > 34 ? `${text.slice(0, 32)}…` : text;
      el.setAttribute('aria-label', name);
      el.addEventListener('click', (e) => this.onSelect(index, e.detail === 0));
      el.addEventListener('dblclick', () => this.onOpen(index));
      el.addEventListener('focus', () => {
        this.focusedLabel = index;
        this.dirty = true;
      });
      el.addEventListener('blur', () => {
        if (this.focusedLabel === index) this.focusedLabel = -1;
        this.dirty = true;
      });
      this.labelLayer.append(el);
      this.labelEls.push({ index, el, w: 0, h: 0 });
      if (had !== null && name === had) el.focus({ preventScroll: true });
    }
    this.syncLabels();
  }

  /** Shown in every layout of the full view, so Tab reaches the hubs wherever the brain opens (the canvas says so). */
  private syncLabels(): void {
    const show = this.options.labels && this.mode === 'full';
    this.labelLayer.classList.toggle('hidden', !show);
  }

  private placeLabels(): void {
    if (this.labelLayer.classList.contains('hidden')) return;
    // The map, once its lines are drawn, names by tiers; while points move into it or in any other layout, as below.
    if (this.flat && this.mapLines.length && this.mapCache?.input === this.input) {
      this.placeMapLabels(this.mapCache.names);
      return;
    }
    this.hideMapNames();
    const centre = this.orbit.target.clone().project(this.camera).z;
    const placed: { x: number; y: number; w: number }[] = [];
    for (const label of this.labelEls) {
      const { index, el } = label;
      const s = this.screenOf(index);
      const p = this.pointAt(index);
      const depth = new Vector3(p[0], p[1], p[2]).project(this.camera).z;
      const dimmed = this.anyLit ? this.lit[index]! < 1.5 : this.lit[index]! < 0.5;
      // To the right of its point, or to the left when that would run off the canvas. Measured once.
      label.w ||= el.offsetWidth;
      const box = s ? { x: s.x + 9 + label.w > this.width - 8 ? Math.max(8, s.x - 9 - label.w) : s.x + 9, y: s.y - 22, w: label.w } : null;
      // A label with keyboard focus always shows, so focus is never on something unseen; behind the camera, it waits
      // in the top left corner.
      if (index === this.focusedLabel) {
        const at = box ?? { x: 8, y: 8, w: label.w };
        el.classList.add('on');
        placed.push(at);
        el.style.transform = `translate(${Math.round(at.x)}px, ${Math.round(Math.max(4, at.y))}px)`;
        continue;
      }
      // Hide labels on the far side of the cloud, under a dim point, or overlapping a label already placed.
      const visible =
        !!box &&
        depth < centre + 0.002 &&
        !dimmed &&
        this.grow >= 1 &&
        !placed.some((q) => Math.abs(q.y - box.y) < 24 && box.x < q.x + q.w + 6 && q.x < box.x + box.w + 6);
      el.classList.toggle('on', visible);
      if (box && visible) {
        placed.push(box);
        el.style.transform = `translate(${Math.round(box.x)}px, ${Math.round(box.y)}px)`;
      }
    }
    for (const { el, at } of this.ringLabels) {
      const v = at.clone().project(this.camera);
      el.style.transform = `translate(${Math.round(((v.x + 1) / 2) * this.width - 14)}px, ${Math.round(((1 - v.y) / 2) * this.height - 8)}px)`;
    }
  }

  /**
   * The map's names (mapNames.ts has the tiers): the name with keyboard focus, then each country's, biggest first, under
   * its capital (the hub's point, which stays clear for the pointer); nearer, the provinces'; up close, entry titles,
   * the lit ones only while a search lights some. A name that would overlap one already placed waits.
   */
  private placeMapLabels(names: MapNames): void {
    const input = this.input!;
    const pos = this.layoutOf('atlas');
    const wpp = this.worldPerPixel;
    const t = this.orbit.target;
    const W = this.width;
    const H = this.height;
    const sx = (i: number) => W / 2 + (pos[i * 3]! - t.x) / wpp;
    const sy = (i: number) => H / 2 - (pos[i * 3 + 1]! - t.y) / wpp;
    const fitWpp = (2 * this.atlasRef * Math.tan(((FOV / 2) * Math.PI) / 180)) / H;
    const tier = nameTiers(fitWpp / wpp, names.shape.spacing / wpp);
    this.namesOn = true;

    // Hit counts change the names' widths, so they are written before anything is measured.
    this.countHits(names);
    const hubButtons = new Map<number, LabelEl>();
    const noteButtons = new Map<number, LabelEl>();
    for (const l of this.labelEls) {
      if (input.points[l.index]!.id < 0) hubButtons.set(input.atlas!.hubOf[l.index]!, l);
      else noteButtons.set(l.index, l);
    }
    // Measured together, before anything moves, so the page lays out once.
    for (const l of this.labelEls) {
      l.w ||= l.el.offsetWidth;
      l.h ||= l.el.offsetHeight || LABEL_H;
    }
    for (const c of names.countries) {
      if (!c.w && !hubButtons.has(c.hub)) [c.w, c.h] = [c.el.offsetWidth, c.el.offsetHeight];
    }
    if (tier.provinces) for (const p of names.provinces) if (!p.w) [p.w, p.h] = [p.el.offsetWidth, p.el.offsetHeight];

    const placer = names.placer;
    placer.reset(W, H);
    const shown = new Set<HTMLElement>();
    const put = (el: HTMLElement, x: number, y: number) => {
      shown.add(el);
      el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    };
    // Under a capital, or to the right of an entry's point.
    const spot = (l: LabelEl) => (input.points[l.index]!.id < 0 ? { x: sx(l.index) - l.w / 2, y: sy(l.index) + CAPITAL_GAP } : { x: sx(l.index) + 9, y: sy(l.index) - l.h / 2 });

    const focused = this.labelEls.find((l) => l.index === this.focusedLabel);
    if (focused) {
      // Always shown, and kept on screen, so focus is never on something unseen.
      const at = spot(focused);
      const x = Math.max(8, Math.min(W - focused.w - 8, at.x));
      const y = Math.max(4, Math.min(H - focused.h - 4, at.y));
      placer.take(x, y, focused.w, focused.h, 3, true);
      put(focused.el, x, y);
    }
    if (this.grow >= 1) {
      for (const i of names.capital) if (i >= 0) placer.take(sx(i) - CAPITAL_GAP + 4, sy(i) - CAPITAL_GAP + 4, 2 * CAPITAL_GAP - 8, 2 * CAPITAL_GAP - 8, 0, true);
      for (const c of names.countries) {
        const i = names.capital[c.hub]!;
        const button = hubButtons.get(c.hub);
        if (i < 0 || (button && button === focused)) continue;
        const [el, w, h] = button ? [button.el, button.w, button.h] : [c.el, c.w, c.h];
        const x = sx(i) - w / 2;
        const y = sy(i) + CAPITAL_GAP;
        if (placer.take(x, y, w, h)) put(el, x, y);
      }
      if (tier.provinces) {
        for (const p of names.provinces) {
          const d = names.shape.provinces[p.hub]![p.part]!;
          if (d.r / wpp < PROVINCE_MIN_RADIUS) continue;
          const x = W / 2 + (d.x - t.x) / wpp - p.w / 2;
          const y = H / 2 - (d.y - t.y) / wpp - p.h / 2;
          if (placer.take(x, y, p.w, p.h)) put(p.el, x, y);
        }
      }
      if (tier.entries) this.placeTitles(names, noteButtons, focused, sx, sy, placer, put);
    }
    for (const l of this.labelEls) l.el.classList.toggle('on', shown.has(l.el));
    for (const n of [...names.countries, ...names.provinces, ...names.pool]) n.el.classList.toggle('on', shown.has(n.el));
  }

  /**
   * Entry titles in view, in a fixed order so the same ones win as the map moves: notes with a label button first, then
   * the biggest points, then the oldest. Beside its point, on the right or else the left.
   */
  private placeTitles(
    names: MapNames,
    noteButtons: Map<number, LabelEl>,
    focused: LabelEl | undefined,
    sx: (i: number) => number,
    sy: (i: number) => number,
    placer: Placer,
    put: (el: HTMLElement, x: number, y: number) => void,
  ): void {
    const input = this.input!;
    const wpp = this.worldPerPixel;
    const t = this.orbit.target;
    const halfW = (this.width / 2) * wpp;
    const halfH = (this.height / 2) * wpp;
    const lit = this.lit;
    const anyLit = this.anyLit;
    const { sizes } = input;
    const inView = names.index.within(t.x - halfW, t.y - halfH, t.x + halfW, t.y + halfH).filter((i) => !anyLit || lit[i]! > 1.5);
    inView.sort((a, b) => +noteButtons.has(b) - +noteButtons.has(a) || sizes[b]! - sizes[a]! || a - b);
    let used = 0;
    for (let n = 0; n < inView.length && n < TITLES_TRIED && used < TITLES_SHOWN; n++) {
      const i = inView[n]!;
      const button = noteButtons.get(i);
      if (button === focused && button) continue;
      const x = sx(i);
      const y = sy(i);
      if (button) {
        const by = y - button.h / 2;
        if (placer.take(x + 9, by, button.w, button.h)) put(button.el, x + 9, by);
        else if (placer.take(x - 9 - button.w, by, button.w, button.h)) put(button.el, x - 9 - button.w, by);
        continue;
      }
      const text = shortTitle(input.titles[i] ?? '');
      if (!text) continue;
      const w = this.textWidth(text);
      const by = y - TITLE_HEIGHT / 2;
      let bx = x + 6;
      if (!placer.take(bx, by, w, TITLE_HEIGHT, 2)) {
        bx = x - 6 - w;
        if (!placer.take(bx, by, w, TITLE_HEIGHT, 2)) continue;
      }
      let slot = names.pool[used];
      if (!slot) {
        const el = document.createElement('div');
        el.className = 'map-name entry';
        el.setAttribute('aria-hidden', 'true');
        this.labelLayer.append(el);
        slot = { el, text: '' };
        names.pool.push(slot);
      }
      if (slot.text !== text) {
        slot.el.textContent = text;
        slot.text = text;
      }
      put(slot.el, bx, by);
      used++;
    }
  }

  /**
   * Writes each country's hit count (the lit entries in it) on its name and its label button, and quiets the countries
   * with none; clears them when nothing is lit. Only when what is lit has changed.
   */
  private countHits(names: MapNames): void {
    const lit = this.anyLit ? this.lit : null;
    if (lit === names.hitsOf) return;
    names.hitsOf = lit;
    const input = this.input!;
    const hits = lit ? hitsPerCountry(lit, names.country, (i) => input.points[i]!.id >= 0, names.capital.length) : null;
    const buttons = new Map<number, LabelEl>();
    for (const l of this.labelEls) if (input.points[l.index]!.id < 0) buttons.set(input.atlas!.hubOf[l.index]!, l);
    for (const c of names.countries) {
      const n = hits?.[c.hub] ?? 0;
      const button = buttons.get(c.hub);
      for (const el of button ? [c.el, button.el] : [c.el]) {
        if (n) el.dataset.hits = n.toLocaleString('en');
        else delete el.dataset.hits;
        el.classList.toggle('quiet', !!hits && !n);
      }
      c.w = 0;
      if (button) button.w = 0;
    }
  }

  /** Off the map: its names go, and the label buttons lose their hit counts (the map counts them, and may again). */
  private hideMapNames(): void {
    const names = this.mapCache?.names;
    if (!this.namesOn || !names) return;
    this.namesOn = false;
    for (const n of [...names.countries, ...names.provinces, ...names.pool]) n.el.classList.remove('on');
    for (const l of this.labelEls) {
      if (l.el.dataset.hits === undefined && !l.el.classList.contains('quiet')) continue;
      delete l.el.dataset.hits;
      l.el.classList.remove('quiet');
      l.w = 0;
    }
    names.hitsOf = null;
  }

  /** An entry title's width in CSS pixels, measured on a canvas in the titles' font rather than by laying out the page. */
  private textWidth(text: string): number {
    let w = this.widths.get(text);
    if (w !== undefined) return w;
    if (!this.measure) {
      this.measure = document.createElement('canvas').getContext('2d');
      if (this.measure) this.measure.font = `${TITLE_FONT}px ${getComputedStyle(this.labelLayer).fontFamily}`;
    }
    w = Math.ceil(this.measure ? this.measure.measureText(text).width : text.length * TITLE_FONT * 0.6) + 2;
    if (this.widths.size > 4000) this.widths.clear();
    this.widths.set(text, w);
    return w;
  }

  // Camera.

  /** Frames the lit points (a search's hits), in whichever layout is shown. Nothing happens when nothing is lit. */
  fitHits(): void {
    if (!this.input || !this.anyLit) return;
    const { points } = this.input;
    const lit = this.lit;
    const goal = this.fitOrbit(this.layout, (i) => lit[i]! > 1.5 && points[i]!.id >= 0);
    // A single hit still shows its neighbours.
    goal.dist = Math.max(goal.dist, this.fitOrbit(this.layout).dist * 0.06);
    this.touch();
    if (this.reducedMotion) {
      this.orbit = goal;
      this.goal = null;
    } else this.goal = goal;
    this.dirty = true;
  }

  /** The camera that frames the layout's points, or only those `only` keeps. */
  private fitOrbit(layout: Layout, only?: (i: number) => boolean): Orbit {
    const pos = this.input ? this.layoutOf(layout) : new Float32Array(0);
    const sets = layout === 'brain' && this.mode === 'full' && !only ? [pos, this.shell!.geometry.getAttribute('position').array as Float32Array] : [pos];
    const skip = (s: Float32Array, i: number) => !!only && s === pos && !only(i / 3);
    let minY = Infinity;
    let maxY = -Infinity;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let flat = 0;
    for (const s of sets) {
      for (let i = 0; i < s.length; i += 3) {
        if (skip(s, i)) continue;
        minX = Math.min(minX, s[i]!);
        maxX = Math.max(maxX, s[i]!);
        minY = Math.min(minY, s[i + 1]!);
        maxY = Math.max(maxY, s[i + 1]!);
        minZ = Math.min(minZ, s[i + 2]!);
        maxZ = Math.max(maxZ, s[i + 2]!);
      }
    }
    if (minY === Infinity) return { yaw: 0.55, pitch: 0.1, dist: 6, target: new Vector3() };
    const target = new Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
    for (const s of sets) {
      for (let i = 0; i < s.length; i += 3) if (!skip(s, i)) flat = Math.max(flat, Math.hypot(s[i]! - target.x, s[i + 2]! - target.z));
    }
    const aspect = this.width / this.height;
    const tv = Math.tan(((FOV / 2) * Math.PI) / 180);
    const th = tv * aspect;
    if (this.mode === 'strip') {
      // From the side: the stem runs left to right, oldest on the left.
      const halfLen = (maxY - minY) / 2;
      const halfH = (maxZ - minZ) / 2;
      return { yaw: 0, pitch: 0, dist: Math.max(halfLen / th, halfH / tv) * 1.04 + (maxX - minX) / 2, target };
    }
    if (layout === 'rings') {
      const pitch = 1.2;
      const half = flat;
      return { yaw: 0, pitch, dist: Math.max(half / tv, half / th) * 1.05 + 0.2, target };
    }
    if (layout === 'clusters' || layout === 'atlas') {
      const halfW = (maxX - minX) / 2;
      const halfH = (maxY - minY) / 2;
      return { yaw: 0, pitch: 0, dist: Math.max(halfW / th, halfH / tv) * 1.12 + 0.1, target };
    }
    const halfH = (maxY - minY) / 2;
    return { yaw: this.orbit.yaw, pitch: 0.08, dist: Math.max(halfH / tv, flat / th) * 1.04 + flat * 0.55, target };
  }

  private placeCamera(): void {
    if (this.flat && !this.atlasRef) this.atlasRef = this.fitOrbit('atlas').dist;
    this.pointMat.uniforms.uRef!.value = this.flat ? this.atlasRef : 0;
    const o = this.orbit;
    if (this.mode === 'strip') {
      this.camera.up.set(0, 0, 1);
      this.camera.position.set(o.target.x + o.dist, o.target.y, o.target.z);
    } else {
      this.camera.up.set(0, 1, 0);
      const cp = Math.cos(o.pitch);
      this.camera.position.set(o.target.x + o.dist * cp * Math.sin(o.yaw), o.target.y + o.dist * Math.sin(o.pitch), o.target.z + o.dist * cp * Math.cos(o.yaw));
    }
    this.camera.lookAt(o.target);
    this.camera.updateMatrixWorld();
  }

  private resize(): void {
    const host = this.root.parentElement;
    if (!host || !this.renderer) return;
    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);
    this.ratio = Math.min(2, window.devicePixelRatio || 1);
    if (w === this.width && h === this.height && this.renderer.getPixelRatio() === this.ratio) return;
    const refit = Math.abs(w / h - this.width / this.height) > 0.01;
    this.width = w;
    this.height = h;
    this.renderer.setPixelRatio(this.ratio);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const scale = h / (2 * Math.tan(((FOV / 2) * Math.PI) / 180));
    this.pointMat.uniforms.uScale!.value = scale;
    this.shellMat.uniforms.uScale!.value = scale;
    this.pointMat.uniforms.uRatio!.value = this.ratio;
    this.shellMat.uniforms.uRatio!.value = this.ratio;
    this.markMat.uniforms.uScale!.value = scale;
    this.markMat.uniforms.uRatio!.value = this.ratio;
    this.backMat.uniforms.uAspect!.value = w / h;
    this.atlasRef = 0;
    if (refit && !this.touched) this.fit(false);
    if (this.labelEls.length && (w < 700) !== (this.labelEls.length <= 6)) this.buildLabels();
    this.dirty = true;
  }

  private tick = (now: number): void => {
    this.frame = requestAnimationFrame(this.tick);
    const dt = Math.min(0.1, (now - (this.last || now)) / 1000);
    this.last = now;
    if (this.mix < 1) {
      this.mix = Math.min(1, (now - this.moveStart) / this.moveMs);
      this.applyMix();
      if (this.mix >= 1) this.buildRings();
      this.dirty = true;
    }
    if (this.grow < 1) {
      this.grow = Math.min(1, (now - this.growStart) / this.growMs);
      this.pointMat.uniforms.uGrow!.value = this.grow;
      this.dirty = true;
    }
    if (this.goal) {
      const k = 1 - Math.exp(-dt * 6);
      const o = this.orbit;
      const g = this.goal;
      o.yaw += (g.yaw - o.yaw) * k;
      o.pitch += (g.pitch - o.pitch) * k;
      o.dist += (g.dist - o.dist) * k;
      o.target.lerp(g.target, k);
      if (Math.abs(g.dist - o.dist) < 0.002 && Math.abs(g.pitch - o.pitch) < 0.001 && o.target.distanceTo(g.target) < 0.001) {
        // Lands exactly, so a Fit after a pan draws the very picture the first fit drew.
        this.orbit = { ...g, target: g.target.clone() };
        this.goal = null;
      }
      this.dirty = true;
    }
    if (this.turning && this.mode === 'full' && this.layout !== 'clusters' && this.layout !== 'atlas' && this.grow >= 0) {
      this.orbit.yaw += dt * 0.08;
      if (this.goal) this.goal.yaw = this.orbit.yaw;
      this.dirty = true;
    }
    if (!this.dirty || !this.renderer) return;
    this.dirty = false;
    if (this.selectDirty) this.buildSelection();
    this.placeCamera();
    this.renderer.render(this.scene, this.camera);
    this.placeLabels();
    if (this.hoverAt) this.pick();
  };

  // Input.

  private touch(): void {
    if (!this.touched) {
      this.touched = true;
      this.turning = false;
      this.onTouch();
    }
    this.goal = null;
  }

  private bindInput(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      if (this.mode !== 'full') return;
      c.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.dragMoved = 0;
      if (this.pointers.size === 2) this.pinch = this.pinchSpan();
    });
    c.addEventListener('pointermove', (e) => {
      const rect = c.getBoundingClientRect();
      const prev = this.pointers.get(e.pointerId);
      if (prev && this.mode === 'full') {
        const dx = e.clientX - prev.x;
        const dy = e.clientY - prev.y;
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        this.dragMoved += Math.abs(dx) + Math.abs(dy);
        if (this.dragMoved > 3) this.touch();
        if (this.pointers.size === 1 && this.dragMoved > 3) {
          // On the map a drag moves the map under the pointer; elsewhere it turns the brain.
          if (this.flat) this.pan(-dx, dy);
          else {
            this.orbit.yaw -= dx * 0.006;
            this.orbit.pitch = Math.max(-1.45, Math.min(1.45, this.orbit.pitch + dy * 0.005));
          }
          this.setHover(-1);
        } else if (this.pointers.size === 2) {
          const span = this.pinchSpan();
          if (this.pinch > 0) this.zoom(this.pinch / span);
          this.pinch = span;
        }
        this.dirty = true;
        return;
      }
      if (e.pointerType === 'mouse') {
        this.hoverAt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        this.dirty = true;
      }
    });
    const end = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = 0;
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => {
      this.hoverAt = null;
      this.setHover(-1);
    });
    const wheel = (e: WheelEvent) => {
      if (this.mode !== 'full') return;
      e.preventDefault();
      this.touch();
      const rect = c.getBoundingClientRect();
      this.zoom(Math.exp(e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)), { x: e.clientX - rect.left, y: e.clientY - rect.top });
    };
    // The labels too: up close on the map they stand everywhere, and the wheel must still zoom over them.
    c.addEventListener('wheel', wheel, { passive: false });
    this.labelLayer.addEventListener('wheel', wheel, { passive: false });
    // One click selects (a drag that turned the brain doesn't); a click on empty space clears the selection.
    c.addEventListener('click', (e) => {
      if (this.mode !== 'full' || this.dragMoved > 3) return;
      const rect = c.getBoundingClientRect();
      this.onSelect(this.nearest(e.clientX - rect.left, e.clientY - rect.top, 16), false);
    });
    c.addEventListener('dblclick', (e) => {
      const rect = c.getBoundingClientRect();
      const i = this.nearest(e.clientX - rect.left, e.clientY - rect.top, 16);
      if (i >= 0) this.onOpen(i);
    });
    c.addEventListener('keydown', (e) => {
      if (this.mode !== 'full') return;
      const step = e.shiftKey ? 0.3 : 0.1;
      // On the map the arrows move it a tenth of the view (Shift, three tenths); elsewhere they turn the brain.
      const across = step * Math.min(this.width, this.height);
      const keys: Record<string, () => void> = this.flat
        ? {
            ArrowLeft: () => this.pan(-across, 0),
            ArrowRight: () => this.pan(across, 0),
            ArrowUp: () => this.pan(0, across),
            ArrowDown: () => this.pan(0, -across),
          }
        : {
            ArrowLeft: () => (this.orbit.yaw += step),
            ArrowRight: () => (this.orbit.yaw -= step),
            ArrowUp: () => (this.orbit.pitch = Math.min(1.45, this.orbit.pitch + step)),
            ArrowDown: () => (this.orbit.pitch = Math.max(-1.45, this.orbit.pitch - step)),
          };
      Object.assign(keys, {
        '+': () => this.zoom(0.85),
        '=': () => this.zoom(0.85),
        '-': () => this.zoom(1.18),
        f: () => this.fit(),
        F: () => this.fit(),
      });
      const run = keys[e.key];
      if (!run || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      if (e.key !== 'f' && e.key !== 'F') this.touch();
      run();
      this.dirty = true;
    });
  }

  private pinchSpan(): number {
    const [a, b] = [...this.pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  /** World units per CSS pixel on the map's plane, at the current distance. */
  private get worldPerPixel(): number {
    return (2 * this.orbit.dist * Math.tan(((FOV / 2) * Math.PI) / 180)) / this.height;
  }

  /**
   * Zooms by a factor. On the map it zooms about a spot on screen (the pointer's), so what is under it stays there,
   * and it goes much closer, near enough to read single entries.
   */
  private zoom(factor: number, at?: { x: number; y: number }): void {
    const o = this.orbit;
    const before = this.worldPerPixel;
    o.dist = Math.max(this.flat ? 0.05 : 0.6, Math.min(30, o.dist * factor));
    if (this.flat && at) {
      const shift = before - this.worldPerPixel;
      o.target.x += (at.x - this.width / 2) * shift;
      o.target.y -= (at.y - this.height / 2) * shift;
      this.keepOnMap();
    }
    this.dirty = true;
  }

  /** Moves the map's view by CSS pixels: right and up are positive. */
  private pan(dx: number, dy: number): void {
    const k = this.worldPerPixel;
    this.orbit.target.x += dx * k;
    this.orbit.target.y += dy * k;
    this.keepOnMap();
    this.dirty = true;
  }

  /** Keeps the middle of the view over the map, so a pan can't lose it. */
  private keepOnMap(): void {
    const pos = this.layoutOf('atlas');
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < pos.length; i += 3) {
      minX = Math.min(minX, pos[i]!);
      maxX = Math.max(maxX, pos[i]!);
      minY = Math.min(minY, pos[i + 1]!);
      maxY = Math.max(maxY, pos[i + 1]!);
    }
    if (minX === Infinity) return;
    const t = this.orbit.target;
    t.x = Math.max(minX, Math.min(maxX, t.x));
    t.y = Math.max(minY, Math.min(maxY, t.y));
  }

  private setHover(i: number): void {
    if (i === this.hovered) return;
    this.hovered = i;
    this.canvas.style.cursor = i >= 0 ? 'pointer' : '';
    if (i < 0) this.onHover(null);
  }

  private pick(): void {
    if (!this.hoverAt || this.pointers.size) return;
    const i = this.nearest(this.hoverAt.x, this.hoverAt.y, 12);
    this.setHover(i);
    if (i >= 0) {
      const s = this.screenOf(i);
      if (s) this.onHover({ index: i, x: s.x, y: s.y });
    }
  }

  /** The point nearest a spot on screen, within a radius in CSS pixels; -1 when none. Dimmed points don't count. */
  private nearest(x: number, y: number, radius: number): number {
    if (!this.input || this.grow < 1) return -1;
    const matrix = this.camera.projectionMatrix.clone().multiply(this.camera.matrixWorldInverse).elements;
    const lit = this.lit;
    const floor = this.anyLit ? 1.5 : 0.5;
    const view = { matrix, width: this.width, height: this.height };
    const at = { from: this.from, to: this.current, t: easeInOut(this.mix) };
    const { points } = this.input;
    // On the map a hub's point is its country's capital, packed in among its entries: within its own reach it wins,
    // so the pointer can find it.
    if (this.flat) {
      const hub = nearestPoint(view, at, points.length, x, y, Math.min(radius, HUB_REACH), (i) => points[i]!.id >= 0 || lit[i]! < floor);
      if (hub >= 0) return hub;
    }
    return nearestPoint(view, at, points.length, x, y, radius, (i) => lit[i]! < floor);
  }
}

/** How near, in CSS pixels, the pointer must come to a hub's point on the map for the hub to win over its entries. */
const HUB_REACH = 10;
/** On the map, how far below its capital a country's name sits, in CSS pixels; the capital keeps the spot above clear. */
const CAPITAL_GAP = 11;
/** A label button's height before it is measured, and an entry title's, in CSS pixels, and the titles' font size (styles.css, .map-name.entry). */
const LABEL_H = 22;
const TITLE_HEIGHT = 15;
const TITLE_FONT = 11;
/** At most this many entry titles at once, from at most this many tried. */
const TITLES_SHOWN = 48;
const TITLES_TRIED = 400;

/** A label button and its measured size (0 until measured). */
interface LabelEl {
  index: number;
  el: HTMLButtonElement;
  w: number;
  h: number;
}

/** The map's names for one record: the elements for each tier and what places them. */
interface MapNames {
  shape: AtlasShape;
  /** Each point's country, for counting hits: its hub, or -1 (in no hub, or a hub's own point). */
  country: Int32Array;
  /** Each hub's own point, by hub; -1 when it isn't drawn. */
  capital: Int32Array;
  /** A name per country, biggest first, shown where its hub has no label button. */
  countries: { hub: number; el: HTMLDivElement; w: number; h: number }[];
  /** A name per province, biggest first. */
  provinces: { hub: number; part: number; el: HTMLDivElement; w: number; h: number }[];
  /** Elements for entry titles, reused from frame to frame. */
  pool: { el: HTMLDivElement; text: string }[];
  index: EntryIndex;
  placer: Placer;
  /** The lit values the hit counts were last written for; null when nothing was lit. */
  hitsOf: Float32Array | null;
}

/** What the canvas says it is, by layout: the map pans, the others turn. */
function canvasLabel(layout: Layout): string {
  return layout === 'atlas'
    ? 'The map: every entry as a point, each concept hub a country and its sub-groups provinces. Click a point for its card. Drag or use the arrow keys to move the map, plus and minus or the wheel to zoom, F to fit. Tab steps through the labelled hubs.'
    : 'The brain: every entry as a point. Click a point for its card. Drag or use the arrow keys to turn it, plus and minus to zoom, F to fit. Tab steps through the labelled hubs.';
}

let shared: BrainScene | null = null;

/** The one scene for the page. */
export function brainScene(): BrainScene {
  shared ??= new BrainScene();
  return shared;
}
