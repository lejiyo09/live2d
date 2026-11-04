import { Application, Container, Graphics, Mesh, MeshGeometry, Rectangle, RenderTexture, Sprite, Texture } from 'pixi.js';
import 'pixi.js/advanced-blend-modes';
import { boundsOf, resolveDrawOrder, type ArtMesh, type LayerNode, type NodeId, type Project, type Rect } from '@l2s/editor-core';
import { TEXTURE_PAD, TextureCache, brushTexture } from './assets.ts';
import { buildRibbon } from '@l2s/mesh-engine';
import { toPixiBlend } from './blend.ts';
import { fit, screenToWorld, zoomAt, type CameraState } from './camera.ts';
import { pick, type MeshSampler } from './hittest.ts';
import type { Resolved } from '@l2s/deformer-engine';

/** Evaluated pose from the deformer/parameter engines. */
export interface Pose {
  meshes: Map<NodeId, { positions: Float32Array; opacity: number; drawOrder?: number }>;
  deformers: Map<string, Resolved>;
}

export interface PickEvent {
  /** Picked node (null = empty space). */
  id: NodeId | null;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  world: { x: number; y: number };
}

export interface RendererEvents {
  pick?: (e: PickEvent) => void;
  hover?: (id: NodeId | null, world: { x: number; y: number } | null) => void;
  camera?: (cam: CameraState) => void;
}

export interface OverlayOptions {
  showCanvasBorder: boolean;
  showBounds: boolean;
  /** Draw wireframes of the selected layers' meshes. */
  showMeshes: boolean;
  /** Grid spacing in canvas px (0 = off). */
  grid: number;
  /** Centre line and thirds guides. */
  guides: boolean;
}

/** Pointer input routed to an active canvas tool (mesh editing, later deformers). */
export interface ToolPointerEvent {
  world: { x: number; y: number };
  screen: { x: number; y: number };
  button: number;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  /** Camera zoom, to convert screen-pixel tolerances into world units. */
  zoom: number;
  detail: number;
}

export interface CanvasTool {
  /** Return true to capture the pointer (subsequent moves/up go to the tool). */
  onPointerDown(e: ToolPointerEvent): boolean;
  onPointerMove(e: ToolPointerEvent, captured: boolean): void;
  onPointerUp(e: ToolPointerEvent): void;
  cursor?: string;
}

/** Point-editing overlay (mesh topology edit, keyform deform edit). */
export interface EditOverlay {
  kind: 'mesh' | 'warp' | 'rotation';
  targetId: string;
  /** Canvas-space points being edited (mesh vertices / warp grid points / [origin, handle]). */
  points: ArrayLike<number>;
  triangles?: number[];
  boundary?: number[][];
  cols?: number;
  rows?: number;
  selected: ReadonlySet<number>;
  hover: number;
  /** Rubber-band selection in world space. */
  box: Rect | null;
  /** Points flagged by the quality check. */
  flagged: ReadonlySet<number>;
  /** Rest pose drawn as a ghost for comparison (spec §7.2 keyform difference). */
  ghost?: ArrayLike<number>;
  /** Deformed grid shown under a Bézier control net. */
  underlay?: { points: ArrayLike<number>; cols: number; rows: number };
  /** False when the parameters are between keys: shown dimmed, not editable. */
  editable: boolean;
}

const SELECT_COLOR = 0x3b9cff;
const HOVER_COLOR = 0xffb020;
const MESH_COLOR = 0x5ad1ff;
const OUTLINE_COLOR = 0xff6ac1;
const FLAG_COLOR = 0xff4d4d;
const DEFORMER_COLOR = 0x7dff9b;
const ROTATION_COLOR = 0xffd34d;

type Display =
  | { kind: 'sprite'; obj: Sprite }
  | { kind: 'mesh'; obj: Mesh<MeshGeometry>; mesh: ArtMesh; texture: Texture; positions: Float32Array | null };

/**
 * Canvas renderer for the editor workspace. Owns the PixiJS application,
 * camera and picking. It never mutates the project: interactions are
 * reported through events / tools and turned into commands by the editor.
 */
export class StudioRenderer {
  readonly textures = new TextureCache();
  private app = new Application();
  private world = new Container({ label: 'world' });
  private art = new Container({ label: 'art', sortableChildren: false });
  private overlay = new Graphics({ label: 'overlay' });
  private displays = new Map<NodeId, Display>();
  private project: Project | null = null;
  private selection: NodeId[] = [];
  private hoverId: NodeId | null = null;
  private cam: CameraState = { zoom: 1, x: 0, y: 0 };
  private events: RendererEvents = {};
  private opts: OverlayOptions = { showCanvasBorder: true, showBounds: false, showMeshes: true, grid: 0, guides: false };
  private edit: EditOverlay | null = null;
  /** Onion skin ghosts: mesh positions at other times (spec §3.1). */
  private onion: Array<{ meshes: Map<NodeId, Float32Array>; color: number; alpha: number }> = [];
  private pose: Pose | null = null;
  private tool: CanvasTool | null = null;
  private toolCapture: number | null = null;
  private panning: { id: number; sx: number; sy: number; cx: number; cy: number } | null = null;
  private spaceDown = false;
  private disposers: Array<() => void> = [];
  private initialized = false;
  private destroyed = false;
  private overlayQueued = false;
  /** Runtime ArtMesh masks: one render texture per distinct mask set. */
  private masks = new Map<string, { scene: Container; rt: RenderTexture; parts: Map<NodeId, Display> }>();
  private maskSprites = new Map<NodeId, Sprite>();

  async init(host: HTMLElement, events: RendererEvents = {}) {
    this.events = events;
    await this.app.init({
      preference: 'webgl',
      backgroundAlpha: 0,
      antialias: true,
      useBackBuffer: true, // required for advanced (PSD) blend modes on WebGL
      resizeTo: host,
      autoDensity: true,
      resolution: Math.min(globalThis.devicePixelRatio || 1, 2),
      powerPreference: 'high-performance',
    });
    if (this.destroyed) {
      this.app.destroy(true);
      return;
    }
    this.initialized = true;
    const canvas = this.app.canvas;
    canvas.style.display = 'block';
    canvas.dataset.testid = 'workspace-canvas';
    host.appendChild(canvas);
    this.world.addChild(this.art);
    this.app.stage.addChild(this.world, this.overlay);
    this.bindInput(canvas);
    let lastSize = { w: this.app.screen.width, h: this.app.screen.height };
    this.app.renderer.on('resize', () => {
      // Keep the view centre fixed when the panel resizes (e.g. split view, splitters).
      const w = this.app.screen.width, h = this.app.screen.height;
      if (lastSize.w && lastSize.h) this.setCamera({ ...this.cam, x: this.cam.x + (w - lastSize.w) / 2, y: this.cam.y + (h - lastSize.h) / 2 });
      lastSize = { w, h };
      this.redrawOverlay();
    });
    // PixiJS' resizeTo only reacts to window resizes; panel splitters resize the host too.
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => this.app.queueResize?.() ?? this.app.resize());
      ro.observe(host);
      this.disposers.push(() => ro.disconnect());
    }
    if (this.project) this.sync(this.project);
  }

  get camera(): CameraState {
    return { ...this.cam };
  }

  get canvas(): HTMLCanvasElement | null {
    return this.initialized ? this.app.canvas : null;
  }

  /**
   * Pause/resume rendering. Secondary views are kept alive and paused rather
   * than destroyed: destroying one PixiJS Application while another is
   * running breaks the other (shared batcher pools in PixiJS v8).
   */
  setActive(active: boolean) {
    if (!this.initialized) return;
    if (active) this.app.start(); else this.app.stop();
  }

  /** Upload textures to the GPU now (spread large imports over several frames instead of one long first render). */
  preloadTextures(ids: Iterable<string>) {
    if (!this.initialized) return;
    const sys = (this.app.renderer as unknown as { texture: { initSource(s: unknown): void } }).texture;
    for (const id of ids) {
      const t = this.textures.get(id);
      if (t) sys.initSource(t.source);
    }
  }

  setOverlayOptions(o: Partial<OverlayOptions>) {
    this.opts = { ...this.opts, ...o };
    this.redrawOverlay();
  }

  setOnionSkin(ghosts: Array<{ meshes: Map<NodeId, Float32Array>; color: number; alpha: number }>) {
    this.onion = ghosts;
    this.redrawOverlay();
  }

  setEditOverlay(state: EditOverlay | null) {
    this.edit = state;
    this.redrawOverlay();
  }

  setTool(tool: CanvasTool | null) {
    this.tool = tool;
    this.toolCapture = null;
    if (this.initialized) this.app.canvas.style.cursor = tool?.cursor ?? '';
    if (tool) this.setHover(null);
  }

  /** Reconcile display objects with the project. Cheap to call on every change. */
  sync(project: Project, pose: Pose | null = this.pose) {
    const prevCanvas = this.project?.canvas;
    const prevId = this.project?.id;
    this.project = project;
    this.pose = pose;
    if (!this.initialized) return;
    const layers = resolveDrawOrder(project, this.drawOrderOf);
    const seen = new Set<NodeId>();
    const ordered: Container[] = [];
    for (const r of layers) {
      const n = r.node;
      seen.add(n.id);
      const posed = pose?.meshes.get(n.id);
      const d = this.updateDisplay(n, project.meshes[n.id], posed?.positions ?? null);
      d.obj.visible = r.effectiveVisible;
      d.obj.alpha = r.effectiveOpacity * (posed?.opacity ?? 1);
      d.obj.blendMode = toPixiBlend(n.blendMode);
      ordered.push(d.obj);
    }
    for (const [id, d] of this.displays) {
      if (!seen.has(id)) {
        this.destroyDisplay(d);
        this.displays.delete(id);
      }
    }
    // Re-establish draw order without destroying display objects.
    this.art.removeChildren();
    if (ordered.length) this.art.addChild(...ordered);
    this.syncMasks(project, layers.map((r) => r.node), pose);

    if (prevId !== project.id || !prevCanvas || prevCanvas.width !== project.canvas.width || prevCanvas.height !== project.canvas.height) {
      this.fitToView();
    }
    this.redrawOverlay();
  }

  private updateDisplay(n: LayerNode, mesh: ArtMesh | undefined, positions: Float32Array | null): Display {
    const tex = this.textures.get(n.assets.display) ?? Texture.EMPTY;
    let d = this.displays.get(n.id);
    if (mesh?.path) return this.updatePath(n, mesh, positions, d);
    if (!mesh) {
      if (d?.kind !== 'sprite') {
        if (d) this.destroyDisplay(d);
        d = { kind: 'sprite', obj: new Sprite({ label: n.id }) };
        this.displays.set(n.id, d);
      }
      if (d.obj.texture !== tex) d.obj.texture = tex;
      const pad = tex === Texture.EMPTY ? 0 : TEXTURE_PAD;
      d.obj.position.set(n.bounds.x - pad, n.bounds.y - pad);
      return d;
    }
    if (d?.kind === 'mesh' && d.mesh === mesh && d.texture === tex) {
      // Same topology: only the pose changed (parameter slider) — update positions in place.
      if (d.positions !== positions) {
        d.obj.geometry.positions = positions ?? Float32Array.from(mesh.vertices);
        d.positions = positions;
      }
      return d;
    }
    const geometry = buildGeometry(mesh, n.bounds, tex, positions);
    if (d?.kind === 'mesh') {
      const old = d.obj.geometry;
      d.obj.geometry = geometry;
      if (d.obj.texture !== tex) d.obj.texture = tex;
      old.destroy();
      d.mesh = mesh;
      d.texture = tex;
      d.positions = positions;
      return d;
    }
    if (d) this.destroyDisplay(d);
    const nd: Display = { kind: 'mesh', obj: new Mesh({ geometry, texture: tex, label: n.id }), mesh, texture: tex, positions };
    this.displays.set(n.id, nd);
    return nd;
  }

  /**
   * Clipping masks (spec §5.1 mask references): the mask layers are drawn
   * into a canvas-sized render texture, which is used as an alpha mask for
   * every layer referencing that mask set. Re-rendered on every sync, so
   * masks follow deformation.
   */
  private syncMasks(project: Project, layers: LayerNode[], pose: Pose | null) {
    const { width, height } = project.canvas;
    const res = Math.min(1, 2048 / Math.max(width, height));
    const used = new Set<string>();
    for (const n of layers) {
      const d = this.displays.get(n.id);
      const cm = n.clipMask;
      if (!d) continue;
      if (!cm || !cm.ids.some((id) => project.nodes[id]?.kind === 'layer')) {
        if (this.maskSprites.has(n.id)) { d.obj.setMask({ mask: null }); this.maskSprites.get(n.id)!.destroy(); this.maskSprites.delete(n.id); }
        continue;
      }
      const ids = cm.ids.filter((id) => project.nodes[id]?.kind === 'layer').sort();
      const key = ids.join(',');
      used.add(key);
      let m = this.masks.get(key);
      if (!m) {
        m = { scene: new Container({ label: `mask:${key}` }), rt: RenderTexture.create({ width: Math.ceil(width * res), height: Math.ceil(height * res) }), parts: new Map() };
        m.scene.scale.set(res);
        this.masks.set(key, m);
      }
      let sprite = this.maskSprites.get(n.id);
      if (!sprite || sprite.texture !== m.rt) {
        sprite?.destroy();
        sprite = new Sprite({ texture: m.rt, label: `maskSprite:${n.id}` });
        sprite.scale.set(1 / res);
        this.maskSprites.set(n.id, sprite);
      }
      this.art.addChild(sprite);
      d.obj.setMask({ mask: sprite, channel: 'alpha', inverse: cm.inverted });
    }
    // Render each used mask set from the current pose.
    for (const [key, m] of this.masks) {
      if (!used.has(key)) {
        m.scene.destroy({ children: true });
        m.rt.destroy(true);
        this.masks.delete(key);
        continue;
      }
      const ids = key.split(',');
      for (const id of ids) {
        const n = project.nodes[id];
        if (n?.kind !== 'layer') continue;
        const mesh = project.meshes[id];
        const tex = this.textures.get(n.assets.display) ?? Texture.EMPTY;
        let part = m.parts.get(id);
        const positions = pose?.meshes.get(id)?.positions ?? null;
        if (mesh) {
          if (part?.kind !== 'mesh' || part.mesh !== mesh || part.texture !== tex) {
            part?.obj.destroy();
            part = { kind: 'mesh', obj: new Mesh({ geometry: buildGeometry(mesh, n.bounds, tex, positions), texture: tex }), mesh, texture: tex, positions };
            m.parts.set(id, part);
            m.scene.addChild(part.obj);
          } else if (part.positions !== positions) {
            part.obj.geometry.positions = positions ?? Float32Array.from(mesh.vertices);
            part.positions = positions;
          }
        } else {
          if (part?.kind !== 'sprite') {
            part?.obj.destroy();
            part = { kind: 'sprite', obj: new Sprite(tex) };
            m.parts.set(id, part);
            m.scene.addChild(part.obj);
          }
          if (part.obj.texture !== tex) part.obj.texture = tex;
          const pad = tex === Texture.EMPTY ? 0 : TEXTURE_PAD;
          part.obj.position.set(n.bounds.x - pad, n.bounds.y - pad);
        }
      }
      this.app.renderer.render({ container: m.scene, target: m.rt, clear: true });
    }
  }

  /** ArtPath: rebuild the stroke ribbon from the (posed) control points. */
  private updatePath(n: LayerNode, mesh: ArtMesh, positions: Float32Array | null, d: Display | undefined): Display {
    const style = mesh.path!;
    const r = buildRibbon(positions ?? mesh.vertices, style);
    if (d?.kind === 'mesh' && d.mesh === mesh && d.positions === positions && d.obj.geometry.indices.length === r.indices.length) return d;
    const geometry = new MeshGeometry({ positions: r.positions, uvs: r.uvs, indices: r.indices });
    const tex = brushTexture();
    if (d?.kind === 'mesh') {
      const old = d.obj.geometry;
      d.obj.geometry = geometry;
      old.destroy();
    } else {
      if (d) this.destroyDisplay(d);
      d = { kind: 'mesh', obj: new Mesh({ geometry, texture: tex, label: n.id }), mesh, texture: tex, positions };
      this.displays.set(n.id, d);
    }
    d.obj.tint = style.color;
    d.mesh = mesh;
    d.positions = positions;
    return d;
  }

  private destroyDisplay(d: Display) {
    if (d.kind === 'mesh') d.obj.destroy({ children: true });
    else d.obj.destroy();
  }

  setSelection(ids: NodeId[]) {
    this.selection = ids;
    this.redrawOverlay();
  }

  setHover(id: NodeId | null) {
    if (this.hoverId === id) return;
    this.hoverId = id;
    this.redrawOverlay();
  }

  fitToView() {
    if (!this.project || !this.initialized) return;
    const { width, height } = this.app.screen;
    this.setCamera(fit(width, height, this.project.canvas.width, this.project.canvas.height));
  }

  setZoom(zoom: number) {
    if (!this.initialized) return;
    const { width, height } = this.app.screen;
    this.setCamera(zoomAt(this.cam, width / 2, height / 2, zoom / this.cam.zoom));
  }

  zoomBy(factor: number) {
    this.setZoom(this.cam.zoom * factor);
  }

  setCamera(cam: CameraState) {
    this.cam = cam;
    this.world.scale.set(cam.zoom);
    this.world.position.set(cam.x, cam.y);
    this.redrawOverlay();
    this.events.camera?.(this.camera);
  }

  /** Artwork only (no overlay, no camera) at `scale`× canvas size, for export. */
  extractArtwork(scale: number): HTMLCanvasElement | null {
    if (!this.project || !this.initialized) return null;
    const { width, height } = this.project.canvas;
    return this.app.renderer.extract.canvas({ target: this.art, frame: new Rectangle(0, 0, width, height), resolution: scale }) as HTMLCanvasElement;
  }

  /** Render the artwork (no overlay) to a PNG, scaled so the long edge is `maxSize`. */
  async snapshot(maxSize = 512): Promise<Blob | null> {
    if (!this.project || !this.initialized) return null;
    const { width, height } = this.project.canvas;
    const resolution = Math.min(1, maxSize / Math.max(width, height));
    const canvas = this.app.renderer.extract.canvas({
      target: this.art,
      frame: new Rectangle(0, 0, width, height),
      resolution,
    }) as HTMLCanvasElement;
    if ('convertToBlob' in canvas) return (canvas as unknown as OffscreenCanvas).convertToBlob({ type: 'image/png' });
    return new Promise((res) => canvas.toBlob((b) => res(b), 'image/png'));
  }

  destroy() {
    this.destroyed = true;
    for (const d of this.disposers) d();
    this.disposers = [];
    this.textures.clear();
    for (const m of this.masks.values()) { m.scene.destroy({ children: true }); m.rt.destroy(true); }
    this.masks.clear();
    this.maskSprites.clear();
    if (this.initialized) this.app.destroy(true, { children: true });
    this.initialized = false;
    this.displays.clear();
  }

  // ---------------------------------------------------------------- overlay

  /** Coalesce overlay redraws to one per frame (vertex drags emit many updates). */
  private redrawOverlay() {
    if (!this.initialized || this.overlayQueued) return;
    this.overlayQueued = true;
    requestAnimationFrame(() => {
      this.overlayQueued = false;
      if (this.initialized) this.drawOverlay();
    });
  }

  private drawOverlay() {
    const g = this.overlay;
    g.clear();
    const p = this.project;
    if (!p) return;
    const z = this.cam.zoom;
    const sx = (x: number) => x * z + this.cam.x;
    const sy = (y: number) => y * z + this.cam.y;
    const toScreen = (x: number, y: number, w: number, h: number) =>
      [Math.round(sx(x)) + 0.5, Math.round(sy(y)) + 0.5, Math.round(w * z), Math.round(h * z)] as const;

    if (this.opts.grid > 0) {
      // Skip lines that would be denser than 6 px on screen.
      let step = this.opts.grid;
      while (step * z < 6) step *= 2;
      for (let x = step; x < p.canvas.width; x += step) g.moveTo(Math.round(sx(x)) + 0.5, sy(0)).lineTo(Math.round(sx(x)) + 0.5, sy(p.canvas.height));
      for (let y = step; y < p.canvas.height; y += step) g.moveTo(sx(0), Math.round(sy(y)) + 0.5).lineTo(sx(p.canvas.width), Math.round(sy(y)) + 0.5);
      g.stroke({ width: 1, color: 0xffffff, alpha: 0.07 });
    }
    if (this.opts.guides) {
      const W = p.canvas.width, H = p.canvas.height;
      g.moveTo(Math.round(sx(W / 2)) + 0.5, sy(0)).lineTo(Math.round(sx(W / 2)) + 0.5, sy(H)).stroke({ width: 1, color: 0x3bd1ff, alpha: 0.6 });
      for (const f of [1 / 3, 2 / 3]) g.moveTo(sx(0), Math.round(sy(H * f)) + 0.5).lineTo(sx(W), Math.round(sy(H * f)) + 0.5);
      g.stroke({ width: 1, color: 0x3bd1ff, alpha: 0.35 });
    }
    if (this.opts.showCanvasBorder) {
      g.rect(...toScreen(0, 0, p.canvas.width, p.canvas.height)).stroke({ width: 1, color: 0x7a7f8a, alpha: 0.9 });
    }
    if (this.opts.showBounds) {
      for (const r of resolveDrawOrder(p)) {
        if (!r.effectiveVisible) continue;
        const b = r.node.bounds;
        g.rect(...toScreen(b.x, b.y, b.width, b.height)).stroke({ width: 1, color: 0x8892a0, alpha: 0.35 });
      }
    }

    // Onion skin: outlines of every visible mesh at the ghost poses.
    for (const ghost of this.onion) {
      for (const r of resolveDrawOrder(p)) {
        if (!r.effectiveVisible) continue;
        const m = p.meshes[r.node.id];
        const pos = ghost.meshes.get(r.node.id);
        if (!m || !pos) continue;
        for (const loop of m.boundary) {
          loop.forEach((idx, j) => { const x = sx(pos[idx * 2]!), y = sy(pos[idx * 2 + 1]!); if (j === 0) g.moveTo(x, y); else g.lineTo(x, y); });
          g.closePath();
        }
      }
      g.stroke({ width: 1.2, color: ghost.color, alpha: ghost.alpha });
    }

    const sel = this.selection;
    const e = this.edit;
    // Wireframes of selected meshes / handles of selected deformers.
    if (this.opts.showMeshes) {
      for (const id of sel) {
        if (e?.targetId === id) continue;
        const m = p.meshes[id];
        if (m) this.drawWire(g, this.pose?.meshes.get(id)?.positions ?? m.vertices, m.triangles, m.boundary, sx, sy, 0.45);
        const r = this.pose?.deformers.get(id);
        if (r?.kind === 'warp') this.drawGrid(g, r.points, r.cols, r.rows, sx, sy, 0.7, true);
        if (r?.kind === 'rotation') this.drawRotation(g, r, sx, sy, 0.8);
      }
    }

    if (e) {
      const alpha = e.editable ? 0.95 : 0.4;
      if (e.ghost && e.kind === 'mesh' && e.triangles) this.drawWire(g, e.ghost, e.triangles, [], sx, sy, 0.18);
      if (e.ghost && e.kind === 'warp') this.drawGrid(g, e.ghost, e.cols!, e.rows!, sx, sy, 0.18, false);
      if (e.underlay) this.drawGrid(g, e.underlay.points, e.underlay.cols, e.underlay.rows, sx, sy, 0.55, true);
      if (e.kind === 'mesh') this.drawWire(g, e.points, e.triangles ?? [], e.boundary ?? [], sx, sy, alpha);
      if (e.kind === 'mesh' && !e.triangles?.length && e.points.length >= 4) {
        // ArtPath: control polygon
        for (let i = 0; i < e.points.length; i += 2) { const x = sx(e.points[i]!), y = sy(e.points[i + 1]!); if (i === 0) g.moveTo(x, y); else g.lineTo(x, y); }
        g.stroke({ width: 1, color: 0xff6ac1, alpha, });
      }
      if (e.kind === 'warp') this.drawGrid(g, e.points, e.cols!, e.rows!, sx, sy, alpha, false);
      if (e.kind === 'rotation') {
        const ox = sx(e.points[0]!), oy = sy(e.points[1]!), hx = sx(e.points[2]!), hy = sy(e.points[3]!);
        g.moveTo(ox, oy).lineTo(hx, hy).stroke({ width: 2, color: ROTATION_COLOR, alpha });
        g.circle(ox, oy, 9).stroke({ width: 2, color: ROTATION_COLOR, alpha });
      }
      const size = 3;
      for (let i = 0; i < e.points.length / 2; i++) {
        const x = sx(e.points[i * 2]!), y = sy(e.points[i * 2 + 1]!);
        const selected = e.selected.has(i);
        const hover = e.hover === i;
        const s = hover || selected ? size + 1 : size;
        if (e.kind === 'rotation') g.circle(x, y, s + 1);
        else g.rect(x - s, y - s, s * 2, s * 2);
        if (!e.editable) g.fill({ color: 0x9aa0aa, alpha: 0.6 });
        else if (selected) g.fill({ color: SELECT_COLOR }).stroke({ width: 1, color: 0xffffff });
        else g.fill({ color: e.flagged.has(i) ? FLAG_COLOR : 0xffffff }).stroke({ width: 1, color: hover ? HOVER_COLOR : 0x202020 });
      }
      const box = e.box;
      if (box) g.rect(...toScreen(box.x, box.y, box.width, box.height)).fill({ color: SELECT_COLOR, alpha: 0.08 }).stroke({ width: 1, color: SELECT_COLOR });
      return; // layer boxes would clutter point editing
    }

    if (this.hoverId && p.nodes[this.hoverId] && !this.selection.includes(this.hoverId)) {
      const b = boundsOf(p, [this.hoverId]);
      if (b) g.rect(...toScreen(b.x, b.y, b.width, b.height)).stroke({ width: 1, color: HOVER_COLOR, alpha: 0.9 });
    }
    for (const id of sel) {
      const b = boundsOf(p, [id]);
      if (!b) continue;
      g.rect(...toScreen(b.x, b.y, b.width, b.height)).stroke({ width: 1.5, color: SELECT_COLOR, alpha: 1 });
    }
    if (sel.length > 1) {
      const b = boundsOf(p, sel);
      if (b) {
        const [x, y, w, h] = toScreen(b.x, b.y, b.width, b.height);
        g.rect(x - 3, y - 3, w + 6, h + 6).stroke({ width: 1, color: SELECT_COLOR, alpha: 0.6 });
      }
    }
  }

  private drawGrid(g: Graphics, pts: ArrayLike<number>, cols: number, rows: number, sx: (x: number) => number, sy: (y: number) => number, alpha: number, dots: boolean) {
    const at = (c: number, r: number) => [sx(pts[(r * (cols + 1) + c) * 2]!), sy(pts[(r * (cols + 1) + c) * 2 + 1]!)] as const;
    for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
      const [x, y] = at(c, r);
      if (c < cols) { const [x2, y2] = at(c + 1, r); g.moveTo(x, y).lineTo(x2, y2); }
      if (r < rows) { const [x2, y2] = at(c, r + 1); g.moveTo(x, y).lineTo(x2, y2); }
    }
    g.stroke({ width: 1, color: DEFORMER_COLOR, alpha });
    if (dots) for (let i = 0; i < pts.length / 2; i++) g.rect(sx(pts[i * 2]!) - 1.5, sy(pts[i * 2 + 1]!) - 1.5, 3, 3).fill({ color: DEFORMER_COLOR, alpha });
  }

  private drawRotation(g: Graphics, r: { x: number; y: number; angle: number; handleLength: number }, sx: (x: number) => number, sy: (y: number) => number, alpha: number) {
    const [hx, hy] = rotationHandle(r);
    g.moveTo(sx(r.x), sy(r.y)).lineTo(sx(hx), sy(hy)).stroke({ width: 2, color: ROTATION_COLOR, alpha });
    g.circle(sx(r.x), sy(r.y), 8).stroke({ width: 2, color: ROTATION_COLOR, alpha });
  }

  private drawWire(g: Graphics, v: ArrayLike<number>, t: number[], boundary: number[][], sx: (x: number) => number, sy: (y: number) => number, alpha: number) {
    const n = v.length / 2;
    const seen = new Set<number>();
    for (let i = 0; i < t.length; i += 3) {
      for (const [a, b] of [[t[i]!, t[i + 1]!], [t[i + 1]!, t[i + 2]!], [t[i + 2]!, t[i]!]] as const) {
        const k = a < b ? a * n + b : b * n + a;
        if (seen.has(k)) continue;
        seen.add(k);
        g.moveTo(sx(v[a * 2]!), sy(v[a * 2 + 1]!)).lineTo(sx(v[b * 2]!), sy(v[b * 2 + 1]!));
      }
    }
    g.stroke({ width: 1, color: MESH_COLOR, alpha });
    for (const loop of boundary) {
      loop.forEach((idx, j) => {
        const x = sx(v[idx * 2]!), y = sy(v[idx * 2 + 1]!);
        if (j === 0) g.moveTo(x, y); else g.lineTo(x, y);
      });
      g.closePath();
    }
    g.stroke({ width: 1.5, color: OUTLINE_COLOR, alpha });
  }

  /** Keyed draw order of a layer at the current pose (spec: ArtMesh draw order keyforms). */
  private drawOrderOf = (id: NodeId) => this.pose?.meshes.get(id)?.drawOrder;

  /** Alpha under a canvas point through the posed mesh triangles (barycentric → UV → alpha map). */
  private meshSampler: MeshSampler = (layerId, x, y) => {
    const p = this.project;
    const m = p?.meshes[layerId];
    const n = p?.nodes[layerId];
    if (!m || n?.kind !== 'layer') return null;
    if (m.path) {
      const r = buildRibbon(this.pose?.meshes.get(layerId)?.positions ?? m.vertices, m.path, 4);
      const c = r.positions;
      // Inside any ribbon quad (two triangles) counts as opaque.
      for (let i = 0; i < r.indices.length; i += 3) {
        const a = r.indices[i]!, b = r.indices[i + 1]!, q = r.indices[i + 2]!;
        const ax = c[a * 2]!, ay = c[a * 2 + 1]!, bx = c[b * 2]!, by = c[b * 2 + 1]!, cx = c[q * 2]!, cy = c[q * 2 + 1]!;
        const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
        if (Math.abs(den) < 1e-9) continue;
        const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / den, l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / den;
        if (l1 >= 0 && l2 >= 0 && l1 + l2 <= 1) return 255;
      }
      return 0;
    }
    const v = this.pose?.meshes.get(layerId)?.positions ?? m.vertices;
    const t = m.triangles;
    for (let i = 0; i < t.length; i += 3) {
      const a = t[i]!, b = t[i + 1]!, c = t[i + 2]!;
      const ax = v[a * 2]!, ay = v[a * 2 + 1]!, bx = v[b * 2]!, by = v[b * 2 + 1]!, cx = v[c * 2]!, cy = v[c * 2 + 1]!;
      if (x < Math.min(ax, bx, cx) || x > Math.max(ax, bx, cx) || y < Math.min(ay, by, cy) || y > Math.max(ay, by, cy)) continue;
      const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(den) < 1e-9) continue;
      const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / den;
      const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / den;
      const l3 = 1 - l1 - l2;
      if (l1 < 0 || l2 < 0 || l3 < 0) continue;
      const u = l1 * m.uvs[a * 2]! + l2 * m.uvs[b * 2]! + l3 * m.uvs[c * 2]!;
      const w = l1 * m.uvs[a * 2 + 1]! + l2 * m.uvs[b * 2 + 1]! + l3 * m.uvs[c * 2 + 1]!;
      return this.textures.sampleAlpha(n.assets.display, Math.floor(u * n.bounds.width), Math.floor(w * n.bounds.height)) ?? 255;
    }
    return 0;
  };

  // ------------------------------------------------------------------ input

  private localPoint(e: PointerEvent | WheelEvent) {
    const r = this.app.canvas.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top };
  }

  private toolEvent(e: PointerEvent): ToolPointerEvent {
    const { sx, sy } = this.localPoint(e);
    return {
      world: screenToWorld(this.cam, sx, sy), screen: { x: sx, y: sy }, button: e.button,
      shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey, zoom: this.cam.zoom, detail: e.detail,
    };
  }

  private bindInput(canvas: HTMLCanvasElement) {
    const on = <K extends keyof HTMLElementEventMap>(t: EventTarget, type: K | string, fn: (e: never) => void, opts?: AddEventListenerOptions) => {
      t.addEventListener(type, fn as EventListener, opts);
      this.disposers.push(() => t.removeEventListener(type, fn as EventListener, opts));
    };
    canvas.style.touchAction = 'none';

    on(canvas, 'wheel', (e: WheelEvent) => {
      e.preventDefault();
      const { sx, sy } = this.localPoint(e);
      if (e.ctrlKey || e.metaKey || !e.shiftKey) {
        // Wheel / pinch zoom (trackpad pinch arrives as ctrl+wheel).
        const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        this.setCamera(zoomAt(this.cam, sx, sy, Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0015))));
      } else {
        this.setCamera({ ...this.cam, x: this.cam.x - e.deltaY, y: this.cam.y - e.deltaX });
      }
    }, { passive: false });

    on(canvas, 'pointerdown', (e: PointerEvent) => {
      const { sx, sy } = this.localPoint(e);
      if (e.button === 1 || (e.button === 0 && this.spaceDown) || e.button === 2) {
        e.preventDefault();
        canvas.setPointerCapture(e.pointerId);
        this.panning = { id: e.pointerId, sx, sy, cx: this.cam.x, cy: this.cam.y };
        canvas.style.cursor = 'grabbing';
        return;
      }
      if (e.button !== 0 || !this.project) return;
      if (this.tool) {
        if (this.tool.onPointerDown(this.toolEvent(e))) {
          canvas.setPointerCapture(e.pointerId);
          this.toolCapture = e.pointerId;
        }
        return;
      }
      const w = screenToWorld(this.cam, sx, sy);
      const id = pick(this.project, this.textures.sampleAlpha, w.x, w.y, {
        cycleFrom: e.altKey ? this.selection.at(-1) : undefined,
        meshSampler: this.meshSampler,
        drawOrderOf: this.drawOrderOf,
      });
      this.events.pick?.({ id, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey, world: w });
    });

    on(canvas, 'pointermove', (e: PointerEvent) => {
      const { sx, sy } = this.localPoint(e);
      if (this.panning && this.panning.id === e.pointerId) {
        this.setCamera({ ...this.cam, x: this.panning.cx + (sx - this.panning.sx), y: this.panning.cy + (sy - this.panning.sy) });
        return;
      }
      if (!this.project) return;
      const w = screenToWorld(this.cam, sx, sy);
      if (this.tool) {
        this.tool.onPointerMove(this.toolEvent(e), this.toolCapture === e.pointerId);
        this.events.hover?.(null, w);
        return;
      }
      const id = pick(this.project, this.textures.sampleAlpha, w.x, w.y, { meshSampler: this.meshSampler, drawOrderOf: this.drawOrderOf });
      this.setHover(id);
      this.events.hover?.(id, w);
    });

    const endPointer = (e: PointerEvent) => {
      if (this.toolCapture === e.pointerId) {
        this.toolCapture = null;
        this.tool?.onPointerUp(this.toolEvent(e));
      }
      if (this.panning?.id !== e.pointerId) return;
      this.panning = null;
      canvas.style.cursor = this.spaceDown ? 'grab' : (this.tool?.cursor ?? '');
    };
    on(canvas, 'pointerup', endPointer);
    on(canvas, 'pointercancel', endPointer);
    on(canvas, 'pointerleave', () => {
      this.setHover(null);
      this.events.hover?.(null, null);
    });
    on(canvas, 'contextmenu', (e: Event) => e.preventDefault());

    const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    on(window, 'keydown', (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isTyping(e.target)) {
        if (!this.spaceDown) canvas.style.cursor = 'grab';
        this.spaceDown = true;
        if (e.target === document.body || e.target === canvas) e.preventDefault();
      }
    });
    on(window, 'keyup', (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        this.spaceDown = false;
        if (!this.panning) canvas.style.cursor = this.tool?.cursor ?? '';
      }
    });
  }
}

/** Canvas position of a rotation deformer's angle handle. */
export function rotationHandle(r: { x: number; y: number; angle: number; handleLength: number }): [number, number] {
  // Handle points "up" at 0°, like Cubism's rotation deformer handle.
  const a = ((r.angle - 90) * Math.PI) / 180;
  return [r.x + Math.cos(a) * r.handleLength, r.y + Math.sin(a) * r.handleLength];
}

/** Mesh UVs are stored relative to the unpadded layer image; map them into the padded texture. */
function buildGeometry(mesh: ArtMesh, bounds: Rect, tex: Texture, positions: Float32Array | null): MeshGeometry {
  const pad = tex === Texture.EMPTY ? 0 : TEXTURE_PAD;
  const tw = bounds.width + pad * 2, th = bounds.height + pad * 2;
  const uvs = new Float32Array(mesh.uvs.length);
  for (let i = 0; i < uvs.length; i += 2) {
    uvs[i] = (mesh.uvs[i]! * bounds.width + pad) / tw;
    uvs[i + 1] = (mesh.uvs[i + 1]! * bounds.height + pad) / th;
  }
  return new MeshGeometry({
    positions: positions ?? Float32Array.from(mesh.vertices),
    uvs,
    indices: Uint32Array.from(mesh.triangles),
  });
}
