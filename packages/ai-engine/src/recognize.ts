import { resolveDrawOrder, type LayerNode, type NodeId, type PartTag, type Project, type Rect } from '@l2s/editor-core';
import { suggestPartTag } from '@l2s/psd-importer';

/**
 * Part recognition (spec §10.1). Two deterministic sources are combined:
 *  1. layer / folder names (Korean, Japanese, English) — `name-rule`
 *  2. geometry relative to the face: position, size, draw order and
 *     left/right pairing — `shape-rule`
 * An image classifier (ONNX) can be plugged in through {@link PartClassifier}.
 */
export interface PartSuggestion {
  layerId: NodeId;
  layerName: string;
  current?: PartTag;
  suggested: PartTag;
  reason: string;
}

/** Optional learned classifier (e.g. an ONNX model running in a worker). */
export interface PartClassifier {
  id: string;
  classify(layer: LayerNode, pixels: { alpha: Uint8Array; width: number; height: number } | undefined): Promise<PartTag | null>;
}

const center = (b: Rect) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

/** Category with the folder names of the ancestors (e.g. layer "L" in folder "目_左"). */
function nameTag(project: Project, layer: LayerNode): { tag: PartTag; via: string } | null {
  const own = suggestPartTag(layer.name);
  let cur = layer.parentId;
  const folders: string[] = [];
  while (cur) {
    const n = project.nodes[cur];
    if (!n) break;
    folders.push(n.name);
    cur = n.parentId;
  }
  if (own) {
    // Refine side from folders when the layer name has none ("홍채" inside "눈_좌").
    if (!/\.(Left|Right)$/.test(own.category)) {
      for (const f of folders) {
        const ft = suggestPartTag(f);
        const side = ft?.category.match(/\.(Left|Right)$/)?.[1];
        if (side) return { tag: { ...own, category: `${own.category}.${side}` }, via: `name "${layer.name}" + folder "${f}"` };
      }
    }
    return { tag: own, via: `name "${layer.name}"` };
  }
  for (const f of folders) {
    const ft = suggestPartTag(f);
    if (ft) return { tag: { ...ft, confidence: ft.confidence * 0.75 }, via: `folder "${f}"` };
  }
  return null;
}

/** The face base layer: tagged Face.Base, else the largest layer near the canvas centre in the upper half. */
function findFace(project: Project, layers: LayerNode[]): LayerNode | null {
  const tagged = layers.filter((l) => l.partTag?.category === 'Face.Base' || suggestPartTag(l.name)?.category === 'Face.Base');
  if (tagged.length) return tagged.sort((a, b) => b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height)[0]!;
  const W = project.canvas.width, H = project.canvas.height;
  const cands = layers.filter((l) => {
    const c = center(l.bounds);
    return Math.abs(c.x - W / 2) < W * 0.2 && c.y < H * 0.6 && l.bounds.width > W * 0.15;
  });
  return cands.sort((a, b) => b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height)[0] ?? null;
}

/** Geometric guess relative to the face box. */
function shapeTag(layer: LayerNode, face: LayerNode, faceOrder: number, order: number): { tag: PartTag; why: string } | null {
  const f = face.bounds, b = layer.bounds, c = center(b), fc = center(f);
  const rx = (c.x - f.x) / f.width, ry = (c.y - f.y) / f.height;
  const relW = b.width / f.width, relH = b.height / f.height;
  const side = c.x < fc.x - f.width * 0.05 ? 'Left' : c.x > fc.x + f.width * 0.05 ? 'Right' : '';
  // Note: "Left" means screen-left here; Cubism's L/R naming convention is decided by the user.
  const inside = rx > 0 && rx < 1 && ry > 0 && ry < 1;
  const mk = (category: string, confidence: number, why: string) => ({ tag: { category, confidence, source: 'shape-rule' as const }, why });
  if (inside && relW < 0.35 && relH < 0.25 && ry > 0.3 && ry < 0.62 && side) return mk(`Eye.${side}`, 0.45, 'small, paired, in the upper-middle of the face');
  if (inside && relW < 0.35 && relH < 0.1 && ry <= 0.35 && side) return mk(`Eyebrow.${side}`, 0.4, 'thin, above eye height');
  if (inside && relW < 0.4 && relH < 0.15 && ry >= 0.65 && !side) return mk('Mouth', 0.45, 'small, centred, lower third of the face');
  if (inside && relW < 0.25 && relH < 0.15 && ry >= 0.55 && side) return mk(`Face.Cheek.${side}`, 0.3, 'paired, lower half of the face');
  if (relW > 0.8 && b.y < f.y + f.height * 0.2 && order > faceOrder) return mk('Hair.Front', 0.4, 'large, covers the top of the face, drawn in front');
  if (relW > 0.8 && order < faceOrder && b.height > f.height * 0.8) return mk('Hair.Back', 0.4, 'large, drawn behind the face');
  if (b.y > f.y + f.height * 0.85 && relW < 0.5 && c.y < f.y + f.height * 1.35 && !side) return mk('Neck', 0.35, 'narrow, directly below the face');
  if (b.y > f.y + f.height * 0.9) return mk(relW > 0.7 ? 'Clothing' : 'Body', 0.3, 'below the face');
  return null;
}

export function recognizeParts(project: Project): PartSuggestion[] {
  const order = resolveDrawOrder(project);
  const layers = order.map((r) => r.node);
  const idx = new Map(layers.map((l, i) => [l.id, i]));
  const face = findFace(project, layers);
  const out: PartSuggestion[] = [];
  for (const l of layers) {
    if (l.partTag?.source === 'user') continue; // never override the user
    const byName = nameTag(project, l);
    let suggested: PartTag | null = null, reason = '';
    if (byName) { suggested = byName.tag; reason = byName.via; }
    if (face && l !== face) {
      const shape = shapeTag(l, face, idx.get(face.id)!, idx.get(l.id)!);
      if (shape) {
        if (!suggested) { suggested = shape.tag; reason = shape.why; }
        else if (shape.tag.category.split('.')[0] === suggested.category.split('.')[0]) {
          // Name and geometry agree: more confident.
          suggested = { ...suggested, confidence: Math.min(0.95, suggested.confidence + 0.15) };
          reason += ` · geometry agrees (${shape.why})`;
        }
      }
    }
    if (face && l === face && !suggested) { suggested = { category: 'Face.Base', confidence: 0.5, source: 'shape-rule' }; reason = 'largest central layer'; }
    if (!suggested) continue;
    if (l.partTag && l.partTag.category === suggested.category && l.partTag.confidence >= suggested.confidence) continue;
    out.push({ layerId: l.id, layerName: l.name, current: l.partTag, suggested, reason });
  }
  return out;
}

/** Left/right pairs by tag (`X.Left` ↔ `X.Right`) for symmetry checks and mirroring. */
export function symmetricPairs(project: Project): Array<[NodeId, NodeId]> {
  const byCat = new Map<string, NodeId>();
  for (const n of Object.values(project.nodes)) if (n.kind === 'layer' && n.partTag) byCat.set(n.partTag.category, n.id);
  const pairs: Array<[NodeId, NodeId]> = [];
  for (const [cat, id] of byCat) {
    if (!cat.endsWith('.Left')) continue;
    const other = byCat.get(cat.replace(/\.Left$/, '.Right'));
    if (other) pairs.push([id, other]);
  }
  return pairs;
}
