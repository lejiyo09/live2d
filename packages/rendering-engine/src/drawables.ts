import { Application, Container, Mesh, MeshGeometry, RenderTexture, Sprite, Texture } from 'pixi.js';
import 'pixi.js/advanced-blend-modes';
import { fit, zoomAt, type CameraState } from './camera.ts';

/** A drawable in canvas pixels (e.g. read from the official Cubism Core). */
export interface DrawableInput {
  index: number;
  visible: boolean;
  opacity: number;
  renderOrder: number;
  texture: number;
  blend: 'normal' | 'add' | 'multiply';
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint16Array;
  masks: number[];
  invertedMask: boolean;
}

/**
 * Read-only renderer for externally evaluated drawables (MOC3 preview,
 * spec §11.3). Masks are rendered to a texture and applied as alpha masks,
 * the same technique as the editor's ArtMesh masks.
 */
export class DrawableRenderer {
  private app = new Application();
  private world = new Container();
  private art = new Container();
  private meshes = new Map<number, Mesh<MeshGeometry>>();
  private maskSets = new Map<string, { scene: Container; rt: RenderTexture; parts: Map<number, Mesh<MeshGeometry>> }>();
  private maskSprites = new Map<number, Sprite>();
  private textures: Texture[] = [];
  private canvasSize = { width: 1, height: 1 };
  private cam: CameraState = { zoom: 1, x: 0, y: 0 };
  private ready = false;
  private disposers: Array<() => void> = [];

  async init(host: HTMLElement) {
    await this.app.init({ preference: 'webgl', backgroundAlpha: 0, antialias: true, useBackBuffer: true, resizeTo: host, autoDensity: true, resolution: Math.min(globalThis.devicePixelRatio || 1, 2) });
    host.appendChild(this.app.canvas);
    this.app.canvas.dataset.testid = 'moc3-canvas';
    this.world.addChild(this.art);
    this.app.stage.addChild(this.world);
    this.ready = true;
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => this.app.resize());
      ro.observe(host);
      this.disposers.push(() => ro.disconnect());
    }
    const c = this.app.canvas;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      this.setCamera(zoomAt(this.cam, e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015)));
    };
    c.addEventListener('wheel', wheel, { passive: false });
    this.disposers.push(() => c.removeEventListener('wheel', wheel));
  }

  /** Pause/resume (see StudioRenderer.setActive: never destroy a second Application while another runs). */
  setActive(active: boolean) {
    if (!this.ready) return;
    if (active) this.app.start(); else this.app.stop();
  }

  get initialized() { return this.ready; }

  /** Textures are created from straight-alpha images; premultiplied on upload. */
  setTextures(images: Array<HTMLCanvasElement | OffscreenCanvas | ImageBitmap | HTMLImageElement>, canvas: { width: number; height: number }) {
    for (const t of this.textures) t.destroy(true);
    this.textures = images.map((img) => Texture.from(img as HTMLCanvasElement));
    this.canvasSize = canvas;
    this.fit();
  }

  fit() {
    if (!this.ready) return;
    this.setCamera(fit(this.app.screen.width, this.app.screen.height, this.canvasSize.width, this.canvasSize.height));
  }

  private setCamera(c: CameraState) {
    this.cam = c;
    this.world.scale.set(c.zoom);
    this.world.position.set(c.x, c.y);
  }

  private meshFor(map: Map<number, Mesh<MeshGeometry>>, d: DrawableInput, parent: Container): Mesh<MeshGeometry> {
    let m = map.get(d.index);
    const tex = this.textures[d.texture] ?? Texture.EMPTY;
    if (!m || m.geometry.indices.length !== d.indices.length) {
      m?.destroy();
      m = new Mesh({ geometry: new MeshGeometry({ positions: d.positions, uvs: d.uvs, indices: new Uint32Array(d.indices) }), texture: tex });
      map.set(d.index, m);
      parent.addChild(m);
    } else {
      m.geometry.positions = d.positions;
    }
    if (m.texture !== tex) m.texture = tex;
    return m;
  }

  render(frame: DrawableInput[]) {
    if (!this.ready) return;
    const sorted = [...frame].sort((a, b) => a.renderOrder - b.renderOrder);
    this.art.removeChildren();
    for (const d of sorted) {
      const m = this.meshFor(this.meshes, d, this.art);
      this.art.addChild(m);
      m.visible = d.visible && d.opacity > 0;
      m.alpha = d.opacity;
      m.blendMode = d.blend === 'add' ? 'add' : d.blend === 'multiply' ? 'multiply' : 'normal';
    }
    // Masks
    const byIndex = new Map(frame.map((d) => [d.index, d]));
    const used = new Set<string>();
    const { width, height } = this.canvasSize;
    const res = Math.min(1, 2048 / Math.max(width, height));
    for (const d of sorted) {
      const m = this.meshes.get(d.index)!;
      if (!d.masks.length) {
        if (this.maskSprites.has(d.index)) { m.setMask({ mask: null }); this.maskSprites.get(d.index)!.destroy(); this.maskSprites.delete(d.index); }
        continue;
      }
      const key = [...d.masks].sort((a, b) => a - b).join(',');
      used.add(key);
      let set = this.maskSets.get(key);
      if (!set) {
        set = { scene: new Container(), rt: RenderTexture.create({ width: Math.ceil(width * res), height: Math.ceil(height * res) }), parts: new Map() };
        set.scene.scale.set(res);
        this.maskSets.set(key, set);
      }
      let sp = this.maskSprites.get(d.index);
      if (!sp || sp.texture !== set.rt) { sp?.destroy(); sp = new Sprite(set.rt); sp.scale.set(1 / res); this.maskSprites.set(d.index, sp); }
      this.art.addChild(sp);
      m.setMask({ mask: sp, channel: 'alpha', inverse: d.invertedMask });
    }
    for (const [key, set] of this.maskSets) {
      if (!used.has(key)) { set.scene.destroy({ children: true }); set.rt.destroy(true); this.maskSets.delete(key); continue; }
      for (const idx of key.split(',').map(Number)) {
        const md = byIndex.get(idx);
        if (md) this.meshFor(set.parts, md, set.scene);
      }
      this.app.renderer.render({ container: set.scene, target: set.rt, clear: true });
    }
  }

  destroy() {
    for (const d of this.disposers) d();
    for (const t of this.textures) t.destroy(true);
    for (const s of this.maskSets.values()) { s.scene.destroy({ children: true }); s.rt.destroy(true); }
    if (this.ready) this.app.destroy(true, { children: true });
    this.ready = false;
  }
}
