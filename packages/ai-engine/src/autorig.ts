import { snapshot, type ArtMesh, type Command, type LayerNode, type NodeId, type Project } from '@l2s/editor-core';
import { STANDARD_PARAMETERS, STANDARD_PARAMETER_GROUPS, defaultValues, gridIndex, type ParameterValues } from '@l2s/parameter-engine';
import {
  addStandardParameters, bindParameter, contextValues, createRotationDeformer, createWarpDeformer, evaluateModel, parentResolved,
  setRotationPivot, toLocal,
} from '@l2s/deformer-engine';
import { setMeshes } from '@l2s/mesh-engine';
import { newPhysicsSetting } from '@l2s/physics-engine';
import { addParameter } from '@l2s/deformer-engine';
import { newId } from '@l2s/editor-core';
import { isGuideNode } from '@l2s/psd-importer';

/**
 * Auto Rig (spec §10.4): a rule engine that turns part tags into a draft rig.
 * The result is a *proposal* — a list of steps the user can review, toggle,
 * preview and apply as one undoable command.
 */

export type RigStepId = 'meshes' | 'parameters' | 'headZ' | 'faceXY' | 'eyes' | 'eyeballs' | 'mouth' | 'hairFront' | 'hairBack' | 'hairPhysics';

export interface RigStep {
  id: RigStepId;
  title: string;
  detail: string;
  /** Layers this step will act on (for display). */
  targets: NodeId[];
  enabled: boolean;
  /** Steps that only make sense when another step is applied too. */
  needs?: RigStepId[];
}

export interface RigProposal {
  steps: RigStep[];
  notes: string[];
  /** Parts suggested for physics (spec §10.4, used by Phase 5). */
  physicsCandidates: NodeId[];
  /** Symmetric left/right part pairs found. */
  pairs: Array<[NodeId, NodeId]>;
  /** Pre-generated meshes for layers that have none (needs pixel data, computed by the caller). */
  meshes: ArtMesh[];
}

export interface RigOptions {
  /** Head tilt at ParamAngleZ = ±30, degrees. */
  headTilt?: number;
  /** Horizontal turn amplitude at ParamAngleX = ±30, fraction of face width. */
  turn?: number;
  /** Vertical nod amplitude at ParamAngleY = ±30, fraction of face height. */
  nod?: number;
}

const DEFAULTS: Required<RigOptions> = { headTilt: 10, turn: 0.07, nod: 0.05 };

type Group = 'face' | 'eyeL' | 'eyeR' | 'iris' | 'mouth' | 'mouthOpen' | 'mouthClosed' | 'hairFront' | 'hairBack' | 'head' | 'physics';

/** Classify tagged layers into rig groups. */
export function rigGroups(project: Project): Record<Group, LayerNode[]> {
  const g: Record<Group, LayerNode[]> = { face: [], eyeL: [], eyeR: [], iris: [], mouth: [], mouthOpen: [], mouthClosed: [], hairFront: [], hairBack: [], head: [], physics: [] };
  // Accessories count as head parts only when they sit above the bottom of the face (a hair ribbon, not a chest bow).
  const faces = Object.values(project.nodes).filter((n): n is LayerNode => n.kind === 'layer' && n.partTag?.category === 'Face.Base');
  const faceBottom = faces.length ? Math.max(...faces.map((f) => f.bounds.y + f.bounds.height)) : Infinity;
  for (const n of Object.values(project.nodes)) {
    if (n.kind !== 'layer' || !n.partTag || isGuideNode(project, n.id)) continue;
    const c = n.partTag.category;
    const top = c.split('.')[0]!;
    const headAccessory = /^Accessory\.(Hat|Ribbon)/.test(c) && n.bounds.y + n.bounds.height / 2 < faceBottom;
    const isHead = ['Face', 'Eye', 'Eyebrow', 'Mouth', 'Hair'].includes(top) || headAccessory;
    if (isHead) g.head.push(n);
    if (isHead && !c.startsWith('Hair.Back')) g.face.push(n);
    if (top === 'Eye' && c.endsWith('.Left')) g.eyeL.push(n);
    if (top === 'Eye' && c.endsWith('.Right')) g.eyeR.push(n);
    if (/^Eye\.(Iris|Highlight)/.test(c)) g.iris.push(n);
    if (top === 'Mouth') g.mouth.push(n);
    if (c.startsWith('Mouth.Open')) g.mouthOpen.push(n);
    if (c.startsWith('Mouth.Closed')) g.mouthClosed.push(n);
    if (c.startsWith('Hair.Front') || c.startsWith('Hair.Side')) g.hairFront.push(n);
    if (c.startsWith('Hair.Back')) g.hairBack.push(n);
    if (top === 'Hair' || (c.startsWith('Accessory.Ribbon') && headAccessory)) g.physics.push(n);
  }
  return g;
}

function union(layers: LayerNode[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of layers) {
    x0 = Math.min(x0, l.bounds.x); y0 = Math.min(y0, l.bounds.y);
    x1 = Math.max(x1, l.bounds.x + l.bounds.width); y1 = Math.max(y1, l.bounds.y + l.bounds.height);
  }
  return x0 === Infinity ? null : { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

const ids = (ls: LayerNode[]) => ls.map((l) => l.id);

export function buildRigProposal(project: Project, meshesFor: (layers: LayerNode[]) => ArtMesh[]): RigProposal {
  const g = rigGroups(project);
  const notes: string[] = [];
  const faceBase = g.face.find((l) => l.partTag?.category === 'Face.Base');
  if (!g.head.length) notes.push('No head parts are tagged. Run AI Tools → Recognize Parts first (or tag layers in the Inspector).');
  if (!faceBase) notes.push('No Face.Base layer found; the head pivot falls back to the bottom of all head parts.');
  const rigLayers = [...new Set([...g.head])];
  const missing = rigLayers.filter((l) => !project.meshes[l.id]);
  const meshes = missing.length ? meshesFor(missing) : [];
  const hasStd = ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamEyeLOpen', 'ParamEyeROpen', 'ParamEyeBallX', 'ParamEyeBallY', 'ParamMouthOpenY', 'ParamMouthForm']
    .every((id) => project.parameters.some((p) => p.id === id));
  if (Object.keys(project.deformers).length) notes.push('The project already has deformers. The proposal adds new ones on top; review the Deformers tree afterwards.');

  const steps: RigStep[] = [
    { id: 'meshes', title: 'Generate ArtMeshes', detail: missing.length ? `${missing.length} head layer(s) have no mesh yet (auto mesh, denser for eyes and mouth).` : 'All head layers already have meshes.', targets: ids(missing), enabled: missing.length > 0 },
    { id: 'parameters', title: 'Add standard parameters', detail: hasStd ? 'Already present.' : `The default parameter list: ${STANDARD_PARAMETERS.length} parameters in ${STANDARD_PARAMETER_GROUPS.length} groups (angles, eyes, brows, mouth, body, breath).`, targets: [], enabled: !hasStd },
    { id: 'headZ', title: 'Head tilt — rotation deformer "Head Z"', detail: `Pivot at the chin; ParamAngleZ ±30 → ±${DEFAULTS.headTilt}°. Contains all head parts.`, targets: ids(g.head), enabled: g.head.length > 0 },
    { id: 'faceXY', title: 'Face turn — warp "Face XY" (5×5)', detail: 'ParamAngleX × ParamAngleY (3×3 keys). Features bulge toward the turn direction for a rounded look.', targets: ids(g.face), enabled: g.face.length > 0 },
    { id: 'eyes', title: 'Blink — warps "Eye L" / "Eye R"', detail: `ParamEyeLOpen / ParamEyeROpen: eyes close onto the lower lid line. ${g.eyeL.length}+${g.eyeR.length} eye parts.`, targets: ids([...g.eyeL, ...g.eyeR]), enabled: g.eyeL.length + g.eyeR.length > 0, needs: ['faceXY'] },
    { id: 'eyeballs', title: 'Gaze — iris / highlight keyforms', detail: 'ParamEyeBallX × ParamEyeBallY: irises shift within the eye white (clipped by the runtime mask).', targets: ids(g.iris), enabled: g.iris.length > 0 },
    { id: 'mouth', title: 'Mouth — warp "Mouth"', detail: g.mouthOpen.length && g.mouthClosed.length ? 'MouthOpenY swaps the closed/open layers (opacity keyforms) and opens the mouth; MouthForm curves the corners.' : 'MouthOpenY stretches the mouth open; MouthForm curves the corners.', targets: ids(g.mouth), enabled: g.mouth.length > 0, needs: ['faceXY'] },
    { id: 'hairFront', title: 'Front hair parallax — warp "Hair Front"', detail: 'Extra ParamAngleX shift so front hair moves more than the face (depth).', targets: ids(g.hairFront), enabled: g.hairFront.length > 0, needs: ['faceXY'] },
    { id: 'hairBack', title: 'Back hair parallax — warp "Hair Back"', detail: 'Opposite ParamAngleX shift so back hair moves less / behind the face.', targets: ids(g.hairBack), enabled: g.hairBack.length > 0 },
    { id: 'hairPhysics', title: 'Hair physics — sway warps + pendulum groups', detail: 'Adds ParamHairFront / ParamHairBack, "… Sway" warps whose tips swing, and physics groups driven by head turn (AngleX) and tilt (AngleZ).', targets: ids([...g.hairFront, ...g.hairBack]), enabled: g.hairFront.length + g.hairBack.length > 0 },
  ];
  const pairs: Array<[NodeId, NodeId]> = [];
  const byCat = new Map(Object.values(project.nodes).filter((n): n is LayerNode => n.kind === 'layer' && !!n.partTag).map((n) => [n.partTag!.category, n.id]));
  for (const [cat, id] of byCat) if (cat.endsWith('.Left') && byCat.has(cat.replace(/Left$/, 'Right'))) pairs.push([id, byCat.get(cat.replace(/Left$/, 'Right'))!]);
  return { steps, notes, physicsCandidates: ids(g.physics), pairs, meshes };
}

// ------------------------------------------------------------------ apply

/** Write canvas-space displacements into a warp keyform at the given key values. */
function deformWarp(d: Project, warpId: string, keys: ParameterValues, delta: (u: number, v: number, rect: { x: number; y: number; width: number; height: number }) => [number, number]) {
  const w = d.deformers[warpId];
  if (w?.kind !== 'warp') return;
  const snap = snapshot(d);
  const coords = w.form.bindings.map((b) => b.keys.findIndex((k) => k === keys[b.parameterId]));
  if (coords.some((c) => c < 0)) return;
  const index = gridIndex(w.form.bindings, coords);
  const rest = evaluateModel(snap, defaultValues(snap)).deformers.get(warpId);
  if (rest?.kind !== 'warp') return;
  const pts = rest.points;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) { x0 = Math.min(x0, pts[i]!); x1 = Math.max(x1, pts[i]!); y0 = Math.min(y0, pts[i + 1]!); y1 = Math.max(y1, pts[i + 1]!); }
  const rect = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  const out: number[] = [];
  for (let r = 0; r <= w.rows; r++) for (let c = 0; c <= w.cols; c++) {
    const i = (r * (w.cols + 1) + c) * 2;
    const [dx, dy] = delta(c / w.cols, r / w.rows, rect);
    out.push(pts[i]! + dx, pts[i + 1]! + dy);
  }
  const ctx = contextValues(snap, snap.deformers[warpId]!.form, index);
  const parent = parentResolved(evaluateModel(snap, ctx), w.parentId);
  w.form.keyforms[index]!.points = toLocal(parent, out);
}

/** Shift whole meshes in canvas space at the given key values (iris gaze). */
function shiftMesh(d: Project, layerId: string, keys: ParameterValues, dx: number, dy: number) {
  const m = d.meshes[layerId];
  if (!m?.form) return;
  const snap = snapshot(d);
  const coords = m.form.bindings.map((b) => b.keys.findIndex((k) => k === keys[b.parameterId]));
  if (coords.some((c) => c < 0)) return;
  const index = gridIndex(m.form.bindings, coords);
  const ctx = contextValues(snap, snap.meshes[layerId]!.form!, index);
  const model = evaluateModel(snap, defaultValues(snap));
  const rest = model.meshes.get(layerId)!.positions;
  const moved = Array.from(rest, (v, i) => v + (i % 2 ? dy : dx));
  m.form.keyforms[index]!.positions = toLocal(parentResolved(evaluateModel(snap, ctx), m.parentId), moved);
}

function setMeshOpacity(d: Project, layerId: string, keys: ParameterValues, opacity: number) {
  const m = d.meshes[layerId];
  if (!m?.form) return;
  const coords = m.form.bindings.map((b) => b.keys.findIndex((k) => k === keys[b.parameterId]));
  if (coords.some((c) => c < 0)) return;
  m.form.keyforms[gridIndex(m.form.bindings, coords)]!.opacity = opacity;
}

const bulge = (t: number) => Math.sin(Math.PI * Math.min(1, Math.max(0, t)));

export function applyRigProposal(proposal: RigProposal, opts: RigOptions = {}): Command {
  const o = { ...DEFAULTS, ...opts };
  const on = new Set(proposal.steps.filter((s) => s.enabled).map((s) => s.id));
  return {
    label: 'AI Auto Rig',
    apply(d) {
      if (on.has('meshes') && proposal.meshes.length) setMeshes(proposal.meshes).apply(d);
      if (on.has('parameters')) addStandardParameters().apply(d);
      const g = rigGroups(snapshot(d));
      const meshed = (ls: LayerNode[]) => ls.filter((l) => d.meshes[l.id]).map((l) => l.id);
      const faceBase = g.face.find((l) => l.partTag?.category === 'Face.Base');
      const faceRect = union(faceBase ? [faceBase] : g.head);

      if (on.has('headZ') && meshed(g.head).length && faceRect) {
        const head = createRotationDeformer(meshed(g.head), { name: 'Head Z' });
        head.command.apply(d);
        setRotationPivot(head.id, faceRect.x + faceRect.width / 2, faceRect.y + faceRect.height * 0.95).apply(d);
        bindParameter([head.id], 'ParamAngleZ', [-30, 0, 30]).apply(d);
        const rot = d.deformers[head.id];
        if (rot?.kind === 'rotation') {
          rot.form.keyforms[0]!.angle -= o.headTilt;
          rot.form.keyforms[2]!.angle += o.headTilt;
        }
      }

      // Reuse an existing "Face XY" (e.g. when the assistant adds only front-hair parallax later).
      let faceId: string | null = Object.values(d.deformers).find((x) => x.name === 'Face XY')?.id ?? null;
      if (on.has('faceXY') && meshed(g.face).length) {
        const w = createWarpDeformer(meshed(g.face), { name: 'Face XY', cols: 5, rows: 5 });
        w.command.apply(d);
        faceId = w.id;
        bindParameter([w.id], 'ParamAngleX', [-30, 0, 30]).apply(d);
        bindParameter([w.id], 'ParamAngleY', [-30, 0, 30]).apply(d);
        for (const ax of [-30, 0, 30]) for (const ay of [-30, 0, 30]) {
          if (!ax && !ay) continue;
          const sx = Math.sign(ax), sy = Math.sign(ay);
          deformWarp(d, w.id, { ParamAngleX: ax, ParamAngleY: ay }, (u, v, r) => [
            // Turn: the centre of the face moves most (rounded surface), plus a small overall shift.
            sx * r.width * o.turn * (0.35 + 0.65 * bulge(u)) * (0.6 + 0.4 * bulge(v)),
            // Nod: up for positive AngleY.
            -sy * r.height * o.nod * (0.35 + 0.65 * bulge(v)) * (0.6 + 0.4 * bulge(u)),
          ]);
        }
      }

      if (on.has('eyes')) {
        for (const [parts, param, name] of [[g.eyeL, 'ParamEyeLOpen', 'Eye L'], [g.eyeR, 'ParamEyeROpen', 'Eye R']] as const) {
          const ids2 = meshed(parts as LayerNode[]);
          if (!ids2.length) continue;
          const w = createWarpDeformer(ids2, { name, cols: 3, rows: 3, margin: 0.15 });
          w.command.apply(d);
          bindParameter([w.id], param, [0, 1]).apply(d);
          deformWarp(d, w.id, { [param]: 0 }, (_u, v, r) => {
            // Close onto the lower lid line (65 % down the eye box).
            const lid = 0.65;
            return [0, (lid - v) * r.height * 0.92];
          });
        }
      }

      if (on.has('eyeballs')) {
        const iris = meshed(g.iris);
        if (iris.length) {
          bindParameter(iris, 'ParamEyeBallX', [-1, 0, 1]).apply(d);
          bindParameter(iris, 'ParamEyeBallY', [-1, 0, 1]).apply(d);
          for (const id of iris) {
            const layer = d.nodes[id] as LayerNode;
            const white = [...g.eyeL, ...g.eyeR].find((e) => /^Eye\.White/.test(e.partTag!.category) && e.partTag!.category.split('.').at(-1) === layer.partTag?.category.split('.').at(-1));
            const span = white ? white.bounds : layer.bounds;
            for (const bx of [-1, 0, 1]) for (const by of [-1, 0, 1]) {
              if (!bx && !by) continue;
              shiftMesh(d, id, { ParamEyeBallX: bx, ParamEyeBallY: by }, bx * span.width * 0.25, -by * span.height * 0.2);
            }
          }
        }
      }

      if (on.has('mouth')) {
        const mouth = meshed(g.mouth);
        if (mouth.length) {
          const open = meshed(g.mouthOpen), closed = meshed(g.mouthClosed);
          if (open.length && closed.length) {
            for (const id of open) (d.nodes[id] as LayerNode).visible = true;
            bindParameter([...open, ...closed], 'ParamMouthOpenY', [0, 1]).apply(d);
            for (const id of open) setMeshOpacity(d, id, { ParamMouthOpenY: 0 }, 0);
            for (const id of closed) setMeshOpacity(d, id, { ParamMouthOpenY: 1 }, 0);
          }
          const w = createWarpDeformer(mouth, { name: 'Mouth', cols: 3, rows: 3, margin: 0.3 });
          w.command.apply(d);
          bindParameter([w.id], 'ParamMouthOpenY', [0, 1]).apply(d);
          bindParameter([w.id], 'ParamMouthForm', [-1, 0, 1]).apply(d);
          const swap = open.length > 0 && closed.length > 0;
          for (const oy of [0, 1]) for (const f of [-1, 0, 1]) {
            if (!oy && !f) continue;
            deformWarp(d, w.id, { ParamMouthOpenY: oy, ParamMouthForm: f }, (u, v, r) => {
              const edge = Math.abs(2 * u - 1);
              // Smile: corners up (and slightly out), centre still.
              const formDy = -f * r.height * 0.18 * edge * edge;
              // Open: lower half moves down (less when an open-mouth layer takes over the shape).
              const openDy = oy * r.height * (swap ? 0.15 : 0.45) * Math.max(0, v - 0.4) / 0.6 * (1 - 0.5 * edge);
              return [f * r.width * 0.03 * (2 * u - 1), formDy + openDy];
            });
          }
        }
      }

      if (on.has('hairFront') && faceId) {
        const hair = meshed(g.hairFront).filter((id) => d.meshes[id]!.parentId === faceId);
        if (hair.length) {
          const w = createWarpDeformer(hair, { name: 'Hair Front', cols: 3, rows: 3 });
          w.command.apply(d);
          bindParameter([w.id], 'ParamAngleX', [-30, 0, 30]).apply(d);
          for (const ax of [-30, 30]) deformWarp(d, w.id, { ParamAngleX: ax }, (_u, v, r) => [Math.sign(ax) * r.width * o.turn * 0.35 * (0.5 + 0.5 * v), 0]);
        }
      }

      if (on.has('hairBack')) {
        const hair = meshed(g.hairBack);
        if (hair.length) {
          const w = createWarpDeformer(hair, { name: 'Hair Back', cols: 3, rows: 3 });
          w.command.apply(d);
          bindParameter([w.id], 'ParamAngleX', [-30, 0, 30]).apply(d);
          for (const ax of [-30, 30]) deformWarp(d, w.id, { ParamAngleX: ax }, (_u, _v, r) => [-Math.sign(ax) * r.width * o.turn * 0.4, 0]);
        }
      }
      if (on.has('hairPhysics')) {
        for (const [parts, pid, name, sway] of [[g.hairFront, 'ParamHairFront', 'Hair Front', 0.06], [g.hairBack, 'ParamHairBack', 'Hair Back', 0.05]] as const) {
          const hair = meshed(parts as LayerNode[]);
          if (!hair.length) continue;
          if (!d.parameters.some((p) => p.id === pid)) {
            // Cubism standard IDs; grouped under the physics group when the parameter list has one.
            const physicsGroup = d.parameterGroups.find((x) => /물리|物理|physics/i.test(x.name));
            const label = pid === 'ParamHairFront' ? '머리 흔들림 앞' : '머리 흔들림 뒤';
            addParameter({ id: pid, name: label, min: -1, max: 1, default: 0, ...(physicsGroup ? { groupId: physicsGroup.id } : {}) }).apply(d);
          }
          const w = createWarpDeformer(hair, { name: `${name} Sway`, cols: 3, rows: 3 });
          w.command.apply(d);
          bindParameter([w.id], pid, [-1, 0, 1]).apply(d);
          // Roots stay, tips swing (displacement grows down the strand).
          for (const k of [-1, 1]) deformWarp(d, w.id, { [pid]: k }, (_u, v, r) => [k * r.width * sway * Math.pow(v, 1.5), -Math.abs(k) * r.height * 0.01 * v]);
          if (!d.physics.settings.some((x) => x.outputs.some((o) => o.parameterId === pid))) {
            const inputs = (['ParamAngleX', 'ParamAngleZ'] as const).filter((id) => d.parameters.some((p) => p.id === id)).map((id) => [id, id === 'ParamAngleZ' ? 'angle' : 'x', 60] as [string, 'x' | 'angle', number]);
            d.physics.settings.push(newPhysicsSetting(newId('phy'), name, pid, { inputs, length: name === 'Hair Back' ? 14 : 10 }));
          }
        }
      }
      d.updatedAt = new Date().toISOString();
    },
  };
}

export type { ArtMesh };
