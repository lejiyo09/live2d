import type { PartTag } from '@l2s/editor-core';

/**
 * Rule-based part suggestion from layer names (Korean / Japanese / English).
 * This is the deterministic fallback for the AI Layer Classifier (spec §4.3);
 * image-based classification is added in Phase 4.
 */
const SIDE_RULES: Array<[RegExp, string]> = [
  [/(^|[_\-\s.(（])(l|left)([_\-\s.)）]|$)|좌|왼|左/i, 'Left'],
  [/(^|[_\-\s.(（])(r|right)([_\-\s.)）]|$)|우|오른|右/i, 'Right'],
];

const PART_RULES: Array<[RegExp, string]> = [
  [/앞머리|前髪|bang|fringe|front\s*hair|hair[_\s-]*front|더듬이|아호게|アホ毛|ahoge/i, 'Hair.Front'],
  [/옆머리|横髪|side\s*hair|hair[_\s-]*side/i, 'Hair.Side'],
  [/뒷머리|後ろ髪|後髪|back\s*hair|hair[_\s-]*back/i, 'Hair.Back'],
  [/머리카락|머리|髪|hair/i, 'Hair'],
  [/흰자|白目|eye[_\s-]*white|sclera/i, 'Eye.White'],
  [/홍채|눈동자|동공|瞳|黒目|iris|pupil|eyeball/i, 'Eye.Iris'],
  [/속눈썹|睫毛|まつ毛|lash/i, 'Eye.Lash'],
  [/눈꺼풀|쌍커풀|쌍꺼풀|まぶた|瞼|二重|eyelid/i, 'Eye.Lid'],
  [/눈썹|眉|brow/i, 'Eyebrow'],
  [/하이라이트|ハイライト|highlight/i, 'Eye.Highlight'],
  [/눈|目|eye/i, 'Eye'],
  [/입|口|mouth|lip/i, 'Mouth'],
  [/이빨|치아|歯|teeth|tooth/i, 'Mouth.Teeth'],
  [/혀|舌|tongue/i, 'Mouth.Tongue'],
  [/볼|홍조|頬|cheek|blush/i, 'Face.Cheek'],
  [/코|鼻|nose/i, 'Face.Nose'],
  [/귀|耳|ear/i, 'Face.Ear'],
  [/얼굴|顔|face|head/i, 'Face.Base'],
  [/목|首|neck/i, 'Neck'],
  [/팔|腕|arm/i, 'Body.Arm'],
  [/손|手|hand/i, 'Body.Hand'],
  [/다리|脚|足|leg/i, 'Body.Leg'],
  [/옷|의상|카라|칼라|服|襟|cloth|shirt|dress|skirt|jacket|collar/i, 'Clothing'],
  [/리본|ribbon|bow/i, 'Accessory.Ribbon'],
  [/모자|帽子|hat|cap/i, 'Accessory.Hat'],
  [/악세|액세서리|アクセ|accessor/i, 'Accessory'],
  [/몸|몸통|体|胴|body|torso/i, 'Body'],
];

const OPEN_CLOSE: Array<[RegExp, string]> = [
  [/열림|開き|open/i, 'Open'],
  [/닫힘|閉じ|close/i, 'Closed'],
];

export function suggestPartTag(name: string): PartTag | undefined {
  const rule = PART_RULES.find(([re]) => re.test(name));
  if (!rule) return undefined;
  let category = rule[1];
  const side = SIDE_RULES.find(([re]) => re.test(name));
  const state = OPEN_CLOSE.find(([re]) => re.test(name));
  if (state && /^(Mouth|Eye)/.test(category)) category += `.${state[1]}`;
  if (side) category += `.${side[1]}`;
  // Short generic hits (e.g. a single "눈") are less certain than specific ones.
  const confidence = rule[1].includes('.') ? 0.8 : 0.6;
  return { category, confidence, source: 'name-rule' };
}

// ------------------------------------------------------------------ pairs and guides

type SideNode = { id: string; kind: string; name: string; parentId: string | null; bounds?: { x: number; y: number; width: number; height: number }; childIds?: string[]; partTag?: PartTag };
type SideProject = { nodes: Record<string, SideNode> };

/** Folders such as "입 가이드" / "ガイド" / "guide" hold reference drawings that are not model parts. */
const GUIDE_RE = /가이드|ガイド|guide/i;
/** Mirrored pairs marked with `<` / `>` (e.g. "눈흰자<" / "눈흰자>", folders "눈<" / "눈>"). */
const MIRROR_RE = /[<>＜＞]/;

export function isGuideNode(project: SideProject, id: string): boolean {
  for (let cur: string | null = id; cur; cur = project.nodes[cur]?.parentId ?? null) {
    const n = project.nodes[cur];
    if (!n) break;
    if (n.kind === 'group' && GUIDE_RE.test(n.name)) return true;
  }
  return false;
}

function nodeBounds(project: SideProject, id: string): { x0: number; x1: number } | null {
  const n = project.nodes[id];
  if (!n) return null;
  if (n.kind === 'layer' && n.bounds) return { x0: n.bounds.x, x1: n.bounds.x + n.bounds.width };
  let out: { x0: number; x1: number } | null = null;
  for (const c of n.childIds ?? []) {
    const b = nodeBounds(project, c);
    if (b) out = out ? { x0: Math.min(out.x0, b.x0), x1: Math.max(out.x1, b.x1) } : b;
  }
  return out;
}

/**
 * Sides for `<` / `>` pairs. Which symbol means which side is an artist's convention,
 * so the side comes from position instead: of two otherwise identically named nodes,
 * the one further left on the canvas is `Left` (the same convention as the geometric
 * recogniser and the ParamEyeL/R bindings). Descendants inherit their folder's side.
 */
export function mirroredSides(project: SideProject): Map<string, 'Left' | 'Right'> {
  const byKey = new Map<string, string[]>();
  for (const n of Object.values(project.nodes)) {
    if (!MIRROR_RE.test(n.name)) continue;
    const key = `${n.kind}:${n.name.replace(/[<>＜＞]/g, '').trim()}`;
    byKey.set(key, [...(byKey.get(key) ?? []), n.id]);
  }
  const own = new Map<string, 'Left' | 'Right'>();
  for (const ids of byKey.values()) {
    if (ids.length !== 2) continue;
    const c = ids.map((id) => { const b = nodeBounds(project, id); return b ? (b.x0 + b.x1) / 2 : NaN; });
    if (!Number.isFinite(c[0]) || !Number.isFinite(c[1]) || c[0] === c[1]) continue;
    const [l, r] = c[0]! < c[1]! ? [ids[0]!, ids[1]!] : [ids[1]!, ids[0]!];
    own.set(l, 'Left'); own.set(r, 'Right');
  }
  const out = new Map<string, 'Left' | 'Right'>();
  for (const n of Object.values(project.nodes)) {
    for (let cur: string | null = n.id; cur; cur = project.nodes[cur]?.parentId ?? null) {
      const s = own.get(cur);
      if (s) { out.set(n.id, s); break; }
    }
  }
  return out;
}

/** Applies {@link mirroredSides} to automatic tags without a side, and drops tags inside guide folders. */
export function refineImportedTags(project: SideProject) {
  const sides = mirroredSides(project);
  for (const n of Object.values(project.nodes)) {
    if (!n.partTag || n.partTag.source === 'user') continue;
    if (n.kind === 'layer' && isGuideNode(project, n.id)) { delete n.partTag; continue; }
    const s = sides.get(n.id);
    if (s && !/\.(Left|Right)$/.test(n.partTag.category)) n.partTag = { ...n.partTag, category: `${n.partTag.category}.${s}` };
  }
}
