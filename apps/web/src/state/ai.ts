import { create } from 'zustand';
import type { Command, LayerNode, PartTag } from '@l2s/editor-core';
import { AUTO_MESH_PRESETS, generateAutoMesh } from '@l2s/mesh-engine';
import {
  analyzeRig, applyRigProposal, buildRigProposal, interpret, recognizeParts,
  type AssistantPlan, type Finding, type PartSuggestion, type RigProposal, type RigStepId,
} from '@l2s/ai-engine';
import { editor, log, useEditor } from './editor.ts';
import { useMesh } from './mesh.ts';

export interface AiState {
  recognize: { suggestions: PartSuggestion[]; accepted: Record<string, boolean> } | null;
  rig: { proposal: RigProposal; source: 'auto' | 'assistant'; plan?: AssistantPlan } | null;
  assistantOpen: boolean;
  assistantText: string;
  /** A previewed AI change waiting for Keep / Discard. */
  preview: { label: string } | null;
  demo: boolean;
  findings: Finding[] | null;
  analyzedAt: string | null;
}

export const useAi = create<AiState>(() => ({
  recognize: null, rig: null, assistantOpen: false, assistantText: '', preview: null, demo: false, findings: null, analyzedAt: null,
}));
const set = useAi.setState;
const get = useAi.getState;

function alphaOf(l: LayerNode) {
  return editor.renderer?.textures.getAlpha(l.assets.display)?.alpha;
}

function meshesFor(layers: LayerNode[]) {
  const settings = useMesh.getState().settings ?? AUTO_MESH_PRESETS.standard;
  return layers.flatMap((l) => {
    const a = alphaOf(l);
    const m = a ? generateAutoMesh({ layerId: l.id, alpha: a, bounds: l.bounds, settings, partCategory: l.partTag?.category }).mesh : null;
    return m ? [m] : [];
  });
}

const RIG_LABEL = 'AI Auto Rig';

let demoRaf = 0;

export const aiActions = {
  // -------------------------------------------------------------- recognition (§10.1)
  openRecognize() {
    const suggestions = recognizeParts(editor.project);
    set({ recognize: { suggestions, accepted: Object.fromEntries(suggestions.map((s) => [s.layerId, s.suggested.confidence >= 0.5 || !s.current])) } });
    if (!suggestions.length) log('info', 'Recognize Parts: nothing new to suggest.');
  },
  toggleSuggestion(id: string, v: boolean) {
    const r = get().recognize;
    if (r) set({ recognize: { ...r, accepted: { ...r.accepted, [id]: v } } });
  },
  applyRecognize() {
    const r = get().recognize;
    if (!r) return;
    const chosen = r.suggestions.filter((s) => r.accepted[s.layerId]);
    const cmd: Command = {
      label: `Recognize Parts (${chosen.length})`,
      apply(d) {
        for (const s of chosen) {
          const n = d.nodes[s.layerId];
          if (n) n.partTag = { ...s.suggested } as PartTag;
        }
      },
    };
    if (chosen.length) editor.run(cmd);
    set({ recognize: null });
    log('info', `Recognize Parts: tagged ${chosen.length} layer(s).`);
  },
  closeRecognize() { set({ recognize: null }); },

  // -------------------------------------------------------------- auto rig (§10.4)
  openAutoRig() {
    const proposal = buildRigProposal(editor.project, meshesFor);
    set({ rig: { proposal, source: 'auto' } });
  },
  toggleStep(id: RigStepId, v: boolean) {
    const r = get().rig;
    if (!r) return;
    set({ rig: { ...r, proposal: { ...r.proposal, steps: r.proposal.steps.map((s) => (s.id === id ? { ...s, enabled: v } : s)) } } });
  },
  closeRig() { set({ rig: null }); },
  /** Apply the proposal; with `preview` the user then keeps or discards it. */
  applyRig(preview: boolean) {
    const r = get().rig;
    if (!r) return;
    if (get().preview) aiActions.keep();
    if (!editor.run(applyRigProposal(r.proposal))) { log('error', 'Auto rig made no changes.'); return; }
    editor.resetParams();
    editor.setLeftTab('deformers');
    const n = r.proposal.steps.filter((s) => s.enabled).length;
    log('info', `AI Auto Rig: applied ${n} step(s)${r.proposal.physicsCandidates.length ? `; physics candidates for Phase 5: ${r.proposal.physicsCandidates.length} part(s)` : ''}.`);
    set({ rig: null, preview: preview ? { label: RIG_LABEL } : null });
    if (preview) aiActions.setDemo(true);
    aiActions.analyze();
  },
  keep() {
    aiActions.setDemo(false);
    set({ preview: null });
  },
  discard() {
    aiActions.setDemo(false);
    const labels = useEditor.getState().undoLabels;
    if (labels.at(-1) === RIG_LABEL) editor.undo();
    else log('warn', 'The preview was already modified; use Undo / History to revert it.');
    set({ preview: null });
  },

  // -------------------------------------------------------------- assistant (§10.5)
  openAssistant(v: boolean) { set({ assistantOpen: v }); },
  setAssistantText(t: string) { set({ assistantText: t }); },
  ask() {
    const text = get().assistantText.trim();
    if (!text) return;
    const proposal = buildRigProposal(editor.project, meshesFor);
    const plan = interpret(text, proposal, editor.project);
    if (!plan.understood) { set({ rig: null }); log('warn', `Assistant: could not map "${text}" to a rigging task.`); }
    const steps = proposal.steps.map((s) => ({
      ...s,
      // Only steps the request asked for, and only when the proposal found something to do.
      enabled: plan.steps.includes(s.id) && (s.id === 'parameters' ? s.enabled : s.targets.length > 0),
    }));
    set({ rig: plan.understood ? { proposal: { ...proposal, steps }, source: 'assistant', plan } : null, assistantOpen: !plan.understood });
  },

  // -------------------------------------------------------------- analyzer (§10.6)
  analyze() {
    const findings = analyzeRig(editor.project, { alpha: alphaOf });
    set({ findings, analyzedAt: new Date().toLocaleTimeString() });
    editor.setBottomTab('analyzer');
  },
  focusFinding(f: Finding) {
    if (f.target && (editor.project.nodes[f.target] || editor.project.deformers[f.target])) editor.selectIds([f.target]);
    if (f.at) { editor.resetParams(); editor.setParams(f.at); }
  },

  // -------------------------------------------------------------- demo motion
  setDemo(on: boolean) {
    cancelAnimationFrame(demoRaf);
    set({ demo: on });
    if (!on) { editor.resetParams(); return; }
    const t0 = performance.now();
    const has = (id: string) => editor.project.parameters.some((p) => p.id === id);
    const tick = (now: number) => {
      if (!get().demo) return;
      const t = (now - t0) / 1000;
      const blink = (t % 3.2) < 0.18 ? Math.abs(Math.cos(((t % 3.2) / 0.18) * Math.PI)) : 1;
      const v: Record<string, number> = {};
      if (has('ParamAngleX')) v.ParamAngleX = 30 * Math.sin(t * 1.1);
      if (has('ParamAngleY')) v.ParamAngleY = 18 * Math.sin(t * 0.7 + 1);
      if (has('ParamAngleZ')) v.ParamAngleZ = 20 * Math.sin(t * 0.5);
      if (has('ParamEyeLOpen')) v.ParamEyeLOpen = blink;
      if (has('ParamEyeROpen')) v.ParamEyeROpen = blink;
      if (has('ParamEyeBallX')) v.ParamEyeBallX = Math.sin(t * 0.9 + 2);
      if (has('ParamEyeBallY')) v.ParamEyeBallY = 0.5 * Math.sin(t * 0.6);
      if (has('ParamMouthOpenY')) v.ParamMouthOpenY = Math.max(0, Math.sin(t * 4)) * (Math.sin(t * 0.8) > 0 ? 1 : 0);
      if (has('ParamMouthForm')) v.ParamMouthForm = Math.sin(t * 0.4);
      editor.setParams(v);
      demoRaf = requestAnimationFrame(tick);
    };
    demoRaf = requestAnimationFrame(tick);
  },
};

if (import.meta.env.DEV) {
  const g = globalThis as Record<string, unknown> & { __l2s?: Record<string, unknown> };
  if (g.__l2s) Object.assign(g.__l2s, { useAi, aiActions });
}
