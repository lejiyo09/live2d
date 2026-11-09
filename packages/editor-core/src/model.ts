/**
 * Internal project data model (Scene Graph).
 *
 * Children are stored in **draw order (bottom → top)**, the same order PSD
 * files use. UI tree views display them reversed (top first), like Photoshop
 * and Cubism Editor.
 */

export const PROJECT_FORMAT_VERSION = 6;

export type NodeId = string;
export type AssetId = string;

/** PSD blend modes, preserved verbatim (kebab-case). Rendering maps them to what the GPU backend supports. */
export type BlendMode =
  | 'pass-through'
  | 'normal'
  | 'dissolve'
  | 'darken'
  | 'multiply'
  | 'color-burn'
  | 'linear-burn'
  | 'darker-color'
  | 'lighten'
  | 'screen'
  | 'color-dodge'
  | 'linear-dodge'
  | 'lighter-color'
  | 'overlay'
  | 'soft-light'
  | 'hard-light'
  | 'vivid-light'
  | 'linear-light'
  | 'pin-light'
  | 'hard-mix'
  | 'difference'
  | 'exclusion'
  | 'subtract'
  | 'divide'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Part classification (filled by the AI Layer Classifier in Phase 4, editable by the user). */
export interface PartTag {
  /** Dotted category, e.g. `Hair.Front.Left`. */
  category: string;
  /** 0..1, `1` when set manually. */
  confidence: number;
  source: 'user' | 'name-rule' | 'shape-rule' | 'ai';
}

interface NodeBase {
  id: NodeId;
  name: string;
  parentId: NodeId | null;
  visible: boolean;
  locked: boolean;
  /** 0..1 */
  opacity: number;
  blendMode: BlendMode;
  partTag?: PartTag;
}

export interface GroupNode extends NodeBase {
  kind: 'group';
  /** PSD allows clipping flags on groups; kept for fidelity. */
  clipping?: boolean;
  /** Draw order, bottom → top. */
  childIds: NodeId[];
  collapsed: boolean;
}

export interface LayerMaskInfo {
  /** Mask bounds in canvas space. */
  bounds: Rect;
  /** Value (0..255) outside the mask bounds. */
  defaultColor: number;
  disabled: boolean;
  /** Mask bounds are relative to the layer (follow layer moves). */
  positionedRelativeToLayer: boolean;
}

export interface LayerNode extends NodeBase {
  kind: 'layer';
  /** Pixel bounds in canvas space. */
  bounds: Rect;
  assets: {
    /** Untouched layer pixels as stored in the PSD. */
    original: AssetId;
    /** Pixels used for display: original with layer mask / clipping baked in. */
    display: AssetId;
    /** Layer mask (grayscale) if present. */
    mask?: AssetId;
  };
  /** PSD clipping mask: clipped to the nearest non-clipping layer below. */
  clipping: boolean;
  /**
   * ArtMesh mask references (spec §5.1): the layer is drawn only where the
   * mask layers have alpha (or only outside, when inverted). Evaluated at
   * render time, so masks follow deformation.
   */
  clipMask?: { ids: NodeId[]; inverted: boolean };
  mask?: LayerMaskInfo;
  /** Position of the layer inside the source PSD tree, for re-import diffing. */
  sourcePath: number[];
}

export type SceneNode = GroupNode | LayerNode;

export interface ProjectSource {
  kind: 'psd';
  fileName: string;
  /** Asset holding the original PSD bytes (never modified). */
  assetId: AssetId;
  importedAt: string;
}

export interface ArtPathStyle {
  /** Stroke width in canvas px. */
  width: number;
  /** 0xRRGGBB */
  color: number;
  closed: boolean;
  /** Thin the stroke towards both ends. */
  taper: boolean;
}

/** Built-in procedural textures (not stored as assets). */
export const BUILTIN_BRUSH_ASSET = 'builtin:brush';

/** Settings used by the automatic mesh generator (names follow Cubism Editor's auto-mesh dialog). */
export interface AutoMeshSettings {
  /** Alpha (0..255) at or above which a pixel counts as part of the drawing ("boundary opacity"). */
  alphaThreshold: number;
  /** Distance of the outer contour outside the drawing, px. */
  outerMargin: number;
  /** Distance of the inner contour inside the drawing, px (0 = no inner ring). */
  innerMargin: number;
  /** Point spacing along the contours, px. */
  outerSpacing: number;
  /** Point spacing of interior points, px. */
  innerSpacing: number;
  /** Multiplier (<1 = denser) for parts that deform a lot (eyes, mouth, hair tips). */
  detailFactor: number;
}

/**
 * ArtMesh geometry for a layer (spec §5.1). Texture, draw order, opacity and
 * mask references live on the owning LayerNode.
 */
export interface ArtMesh {
  layerId: NodeId;
  /** Flat [x0, y0, x1, y1, …] in canvas space (rest pose). */
  vertices: number[];
  /** Flat [u0, v0, …] normalized to the layer's pixel bounds (may be < 0 or > 1 in the margin). */
  uvs: number[];
  /** Flat triangle vertex indices. */
  triangles: number[];
  /** Constrained outline loops (vertex indices). The first is not necessarily the outer one. */
  boundary: number[][];
  /**
   * ArtPath (vector stroke): when set, `vertices` are the path's control
   * points (no triangles); the renderer builds a stroke ribbon from the
   * evaluated control points every frame, so keyforms and deformers apply.
   */
  path?: ArtPathStyle;
  /** User edges (spec §5.2 edge editing): kept as constraints whenever the mesh is re-triangulated. */
  edges?: Array<[number, number]>;
  /** Triangles the user deleted (sorted vertex triples); excluded from re-triangulation. */
  excluded?: Array<[number, number, number]>;
  generatedBy: 'auto' | 'manual' | 'ai';
  settings?: AutoMeshSettings;
  /** Parent deformer. Requires `form` (positions are then in the parent's local space). */
  parentId?: DeformerId | null;
  /**
   * Keyforms over bound parameters. Without it the mesh is static and drawn at
   * `vertices` (canvas space, root parent only).
   */
  form?: KeyformGrid<MeshKeyform>;
  blendShapes?: BlendShape<MeshKeyform>[];
}

// ------------------------------------------------------------------ parameters & keyforms (spec §7)

export type ParameterId = string;
export type DeformerId = string;

export interface Parameter {
  /** Cubism-style ID, e.g. `ParamAngleX` (letters, digits, `_`). */
  id: ParameterId;
  name: string;
  min: number;
  max: number;
  default: number;
  /** Values wrap around min..max instead of clamping (spec §7.3 parameter repeat). */
  repeat?: boolean;
  groupId?: string;
  /** Free text, e.g. "+로 눈을 뜨기" (kept for parameter-list CSV round trips). */
  description?: string;
  /** GUID from an imported parameter-list CSV, kept for round trips. */
  guid?: string;
}

export interface ParameterGroup {
  id: string;
  name: string;
  /** Label colour as in Cubism parameter lists, e.g. "RED:#903D34". */
  color?: string;
  guid?: string;
}

/** A scene arranges clips on tracks over time (spec §9.1 장면 관리). Later tracks override earlier ones. */
export interface Scene {
  id: string;
  name: string;
  duration: number;
  fps: number;
  loop: boolean;
  entries: Array<{ id: string; clipId: string; start: number; track: number }>;
}

/** Expression / parameter preset (spec §7.3, Cubism exp3.json semantics). */
export interface Expression {
  id: string;
  name: string;
  fadeIn?: number;
  fadeOut?: number;
  parameters: Array<{
    parameterId: ParameterId;
    /** Add: offset from the current value · Multiply: factor · Overwrite: absolute value. */
    value: number;
    blend: 'Add' | 'Multiply' | 'Overwrite';
  }>;
}

/** An object is keyed on `parameterId` at `keys` (ascending). */
export interface KeyformBinding {
  parameterId: ParameterId;
  keys: number[];
}

/**
 * Keyforms on the grid spanned by `bindings`. Index of key combination
 * (k0, k1, …) is k0 + k1·n0 + k2·n0·n1 … (first binding varies fastest).
 * With no bindings there is exactly one keyform.
 */
export interface KeyformGrid<T> {
  bindings: KeyformBinding[];
  keyforms: T[];
}

/**
 * Blend shape (spec §7.3, Cubism 5 style): an additive displacement tied to
 * one parameter, applied on top of the keyform result. `deltas[i]` is the
 * displacement at `keys[i]` (same structure as a keyform, in the same local
 * space); the delta at the parameter's default value is zero.
 */
export interface BlendShape<T> {
  parameterId: ParameterId;
  keys: number[];
  deltas: T[];
}

export interface MeshKeyform {
  /** Flat vertex positions in the parent's local space (canvas px when root). */
  positions: number[];
  /** Multiplier on the layer opacity. */
  opacity: number;
  /**
   * Cubism-style draw order (0–1000, default 500), interpolated and rounded.
   * Reorders the layer among its siblings only. When present it is present
   * on every keyform of the mesh.
   */
  drawOrder?: number;
}

export interface WarpKeyform {
  /** (cols+1)·(rows+1) grid points, row-major, flat, in the parent's local space. */
  points: number[];
  opacity: number;
}

export interface RotationKeyform {
  /** Origin in the parent's local space. */
  x: number;
  y: number;
  /** Degrees, clockwise on screen. */
  angle: number;
  scale: number;
  opacity: number;
}

interface DeformerBase {
  id: DeformerId;
  name: string;
  parentId: DeformerId | null;
}

/**
 * Warp deformer: children's local coordinates are normalized (0..1) over the
 * grid and follow it by bilinear interpolation.
 */
export interface WarpDeformer extends DeformerBase {
  kind: 'warp';
  cols: number;
  rows: number;
  form: KeyformGrid<WarpKeyform>;
  blendShapes?: BlendShape<WarpKeyform>[];
}

/** Rotation deformer: children's local coordinates are pixel offsets from the origin. */
export interface RotationDeformer extends DeformerBase {
  kind: 'rotation';
  form: KeyformGrid<RotationKeyform>;
  blendShapes?: BlendShape<RotationKeyform>[];
  /** Length of the angle handle in the editor, px. */
  handleLength: number;
}

export type Deformer = WarpDeformer | RotationDeformer;

// ------------------------------------------------------------------ physics (spec §8, Cubism physics3 model)

export type PhysicsSourceType = 'x' | 'y' | 'angle';

export interface PhysicsInput {
  parameterId: ParameterId;
  type: PhysicsSourceType;
  /** 0..100 */
  weight: number;
  reflect: boolean;
}

export interface PhysicsOutput {
  parameterId: ParameterId;
  type: PhysicsSourceType;
  /** Particle whose segment (index−1 → index) drives the output; ≥ 1. */
  vertexIndex: number;
  scale: number;
  /** 0..100 */
  weight: number;
  reflect: boolean;
}

/** Pendulum strand particle. `y` is the rest offset along the strand (Cubism "Position"). */
export interface PhysicsParticle {
  x: number;
  y: number;
  mobility: number;
  delay: number;
  acceleration: number;
  radius: number;
}

export interface PhysicsRange { min: number; default: number; max: number }

export interface PhysicsSetting {
  id: string;
  name: string;
  inputs: PhysicsInput[];
  outputs: PhysicsOutput[];
  particles: PhysicsParticle[];
  normalization: { position: PhysicsRange; angle: PhysicsRange };
}

export interface PhysicsRig {
  /** Simulation rate; 0 = run once per frame. */
  fps: number;
  gravity: { x: number; y: number };
  wind: { x: number; y: number };
  settings: PhysicsSetting[];
}

// ------------------------------------------------------------------ animation (spec §9, motion3-compatible segments)

export type Interpolation = 'linear' | 'bezier' | 'step';

export interface Keyframe {
  /** Seconds. */
  t: number;
  v: number;
  /** Interpolation of the segment that starts at this key. */
  interp: Interpolation;
  /** Bezier handles: [fraction of segment duration, value offset]. `out` leaves this key, `in` arrives at it. */
  out?: [number, number];
  in?: [number, number];
}

export interface AnimationTrack {
  parameterId: ParameterId;
  keyframes: Keyframe[];
}

export interface AnimationClip {
  id: string;
  name: string;
  /** Seconds. */
  duration: number;
  fps: number;
  loop: boolean;
  tracks: AnimationTrack[];
  /** Optional work range for playback / export, seconds. */
  range?: { start: number; end: number };
  /** Parameters whose keys were produced by physics baking. */
  bakedFromPhysics?: ParameterId[];
}

export interface Project {
  formatVersion: number;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  canvas: { width: number; height: number };
  /** Draw order, bottom → top. */
  rootIds: NodeId[];
  nodes: Record<NodeId, SceneNode>;
  /** ArtMeshes keyed by layer id. Layers without an entry render as a plain quad. */
  meshes: Record<NodeId, ArtMesh>;
  /** Parameter definitions in display order. */
  parameters: Parameter[];
  parameterGroups: ParameterGroup[];
  deformers: Record<DeformerId, Deformer>;
  physics: PhysicsRig;
  animations: AnimationClip[];
  scenes: Scene[];
  expressions: Expression[];
  source?: ProjectSource;
}

export type AssetKind = 'source-psd' | 'layer-original' | 'layer-display' | 'layer-mask' | 'thumbnail';

export interface AssetMeta {
  id: AssetId;
  kind: AssetKind;
  mime: string;
  width?: number;
  height?: number;
  byteLength: number;
}

export function createEmptyProject(name: string, width = 2048, height = 2048): Project {
  const now = new Date().toISOString();
  return {
    formatVersion: PROJECT_FORMAT_VERSION,
    id: newId('prj'),
    name,
    createdAt: now,
    updatedAt: now,
    canvas: { width, height },
    rootIds: [],
    nodes: {},
    meshes: {},
    parameters: [],
    parameterGroups: [],
    deformers: {},
    physics: defaultPhysicsRig(),
    animations: [],
    scenes: [],
    expressions: [],
  };
}

let counter = 0;
export function newId(prefix: string): string {
  counter = (counter + 1) % 0xffff;
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(16).slice(2, 14);
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${rand}`;
}

export function defaultPhysicsRig(): PhysicsRig {
  return { fps: 30, gravity: { x: 0, y: -1 }, wind: { x: 0, y: 0 }, settings: [] };
}

export const DEFAULT_DRAW_ORDER = 500;
