import type { Project } from '@l2s/editor-core';
import type { RigProposal, RigStepId } from './autorig.ts';

/**
 * Rigging assistant (spec §10.5). Natural-language requests are mapped to
 * auto-rig steps by a local intent parser (Korean / English / Japanese
 * keywords). The resulting plan is shown for approval and applied as one
 * undoable command — the same path an LLM provider will use once one is
 * configured (opt-in, server-side, see {@link LanguageModelProvider}).
 */
export interface AssistantPlan {
  understood: boolean;
  steps: RigStepId[];
  /** Human-readable explanation of what will happen, in order. */
  explanation: string[];
  unmatched?: string;
}

/** Optional LLM backend. Images or project data are only sent after explicit user consent (spec §10.7, §16). */
export interface LanguageModelProvider {
  id: string;
  requiresConsent: true;
  plan(request: string, context: { parts: string[]; parameters: string[] }): Promise<AssistantPlan>;
}

const INTENTS: Array<{ re: RegExp; steps: RigStepId[]; say: string }> = [
  { re: /(앞머리|前髪|bang|fringe|front\s*hair).*(회전|돌|움직|따라|turn|rotat|follow|move)|(머리\s*회전|head\s*turn).*(앞머리|bang)/i, steps: ['faceXY', 'hairFront'], say: 'Front hair follows the head turn with extra parallax (warp "Hair Front" under "Face XY", ParamAngleX).' },
  { re: /(뒷머리|後ろ髪|back\s*hair)/i, steps: ['hairBack'], say: 'Back hair moves opposite to the turn for depth (warp "Hair Back", ParamAngleX).' },
  { re: /(깜빡|눈\s*감|눈\s*뜨|눈\s*개폐|まばたき|blink|eye\s*(open|close))/i, steps: ['eyes'], say: 'Blink: eye warps close onto the lower lid (ParamEyeLOpen / ParamEyeROpen).' },
  { re: /(눈동자|시선|홍채|目線|gaze|eyeball|iris|look)/i, steps: ['eyeballs'], say: 'Gaze: irises follow ParamEyeBallX / ParamEyeBallY.' },
  { re: /(입|립싱크|말하|口|mouth|lip\s*sync|talk|smile|웃)/i, steps: ['mouth'], say: 'Mouth opens with ParamMouthOpenY and curves with ParamMouthForm.' },
  { re: /(고개|기울|갸웃|tilt|angle\s*z|머리\s*기울)/i, steps: ['headZ'], say: 'Head tilt: rotation deformer at the chin (ParamAngleZ).' },
  { re: /(얼굴|좌우|상하|돌아|顔|face|turn|look\s*(left|right|up|down)|angle\s*[xy])/i, steps: ['faceXY'], say: 'Face turn and nod: warp "Face XY" over ParamAngleX × ParamAngleY.' },
  { re: /(전부|전체|자동\s*리깅|모두|全部|auto\s*rig|everything|full\s*rig)/i, steps: ['meshes', 'parameters', 'headZ', 'faceXY', 'eyes', 'eyeballs', 'mouth', 'hairFront', 'hairBack'], say: 'Full draft rig.' },
];

export function interpret(request: string, proposal: RigProposal, project: Project): AssistantPlan {
  const steps = new Set<RigStepId>();
  const explanation: string[] = [];
  for (const it of INTENTS) {
    if (!it.re.test(request)) continue;
    it.steps.forEach((s) => steps.add(s));
    explanation.push(it.say);
  }
  if (!steps.size) return { understood: false, steps: [], explanation: [], unmatched: request };
  return completePlan({ understood: true, steps: [...steps], explanation }, proposal, project);
}

/** Adds prerequisites and warnings to a plan (used for both the local parser and an LLM provider). */
export function completePlan(plan: AssistantPlan, proposal: RigProposal, project: Project): AssistantPlan {
  if (!plan.understood) return plan;
  const steps = new Set<RigStepId>(plan.steps);
  const explanation = [...plan.explanation];
  // Prerequisites: meshes and parameters always; nested warps need their parents.
  const avail = new Map(proposal.steps.map((s) => [s.id, s]));
  for (const s of [...steps]) for (const n of avail.get(s)?.needs ?? []) {
    if (!steps.has(n) && !Object.values(project.deformers).some((d) => d.name === (n === 'faceXY' ? 'Face XY' : ''))) { steps.add(n); explanation.push(`(needs: ${avail.get(n)?.title})`); }
  }
  if (avail.get('meshes')?.targets.length) steps.add('meshes');
  if (avail.get('parameters')?.enabled) steps.add('parameters');
  const empty = [...steps].filter((s) => avail.get(s) && !avail.get(s)!.targets.length && !['parameters', 'meshes'].includes(s));
  for (const s of empty) explanation.push(`⚠ ${avail.get(s)!.title}: no matching tagged parts — run Recognize Parts or tag layers.`);
  return { understood: true, steps: [...steps], explanation };
}
