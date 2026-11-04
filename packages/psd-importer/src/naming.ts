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
  [/앞머리|前髪|bang|fringe|front\s*hair|hair[_\s-]*front/i, 'Hair.Front'],
  [/옆머리|横髪|side\s*hair|hair[_\s-]*side/i, 'Hair.Side'],
  [/뒷머리|後ろ髪|後髪|back\s*hair|hair[_\s-]*back/i, 'Hair.Back'],
  [/머리카락|머리|髪|hair/i, 'Hair'],
  [/흰자|白目|eye[_\s-]*white|sclera/i, 'Eye.White'],
  [/홍채|눈동자|동공|瞳|黒目|iris|pupil|eyeball/i, 'Eye.Iris'],
  [/속눈썹|睫毛|まつ毛|lash/i, 'Eye.Lash'],
  [/눈꺼풀|まぶた|瞼|eyelid/i, 'Eye.Lid'],
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
  [/옷|의상|服|cloth|shirt|dress|skirt|jacket/i, 'Clothing'],
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
