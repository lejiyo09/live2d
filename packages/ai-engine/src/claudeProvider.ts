import Anthropic from '@anthropic-ai/sdk';
import type { RigStepId } from './autorig.ts';
import type { AssistantPlan, LanguageModelProvider } from './assistant.ts';

/**
 * Opt-in Claude backend for the Rigging Assistant (spec §10.5 / §10.7).
 *
 * Privacy contract — enforced here, not by the caller:
 *  - only TEXT is sent: the user's request, part names / tags and parameter ids;
 *  - never images, textures, meshes or the project file;
 *  - the key is supplied by the user and passed straight to the Anthropic API
 *    (bring-your-own-key, the SDK's `dangerouslyAllowBrowser` mode).
 * The model only chooses among the fixed auto-rig steps; the result is still
 * shown for approval and applied as one undoable command.
 */
export const CLAUDE_MODEL = 'claude-opus-5-5';

const STEP_IDS: RigStepId[] = ['meshes', 'parameters', 'headZ', 'faceXY', 'eyes', 'eyeballs', 'mouth', 'hairFront', 'hairBack', 'hairPhysics'];

const STEP_HELP: Record<RigStepId, string> = {
  meshes: 'auto-generate ArtMeshes for parts without one',
  parameters: 'add the Cubism standard parameters (ParamAngleX …)',
  headZ: 'head tilt: rotation deformer at the chin (ParamAngleZ)',
  faceXY: 'face turn / nod: warp "Face XY" over ParamAngleX × ParamAngleY',
  eyes: 'blink: eye warps close onto the lower lid (ParamEyeLOpen / ParamEyeROpen)',
  eyeballs: 'gaze: irises follow ParamEyeBallX / ParamEyeBallY',
  mouth: 'mouth open / form (ParamMouthOpenY, ParamMouthForm)',
  hairFront: 'front hair follows the head turn with parallax (warp under Face XY)',
  hairBack: 'back hair moves opposite to the turn for depth',
  hairPhysics: 'hair sway physics driven by angle / body parameters',
};

const SYSTEM = [
  'You plan rigging steps for a 2D character rigging editor (Live2D-style deformers and parameters).',
  'Choose only from these step ids:',
  ...STEP_IDS.map((id) => `- ${id}: ${STEP_HELP[id]}`),
  'Pick the smallest set of steps that fulfils the request. Reply in the language of the request.',
  'Set "understood" to false and leave "steps" empty when the request is not about rigging these parts.',
  'Each explanation entry is one short sentence describing one chosen step.',
].join('\n');

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    understood: { type: 'boolean' },
    steps: { type: 'array', items: { type: 'string', enum: STEP_IDS } },
    explanation: { type: 'array', items: { type: 'string' } },
  },
  required: ['understood', 'steps', 'explanation'],
  additionalProperties: false,
} as const;

export interface ClaudeProviderOptions {
  apiKey: string;
  model?: string;
  /** Injected for tests (mocked network). */
  fetch?: typeof fetch;
  baseURL?: string;
}

export class ClaudeAssistantError extends Error {}

/** What actually leaves the machine — exported so the UI can show it before consent. */
export function buildAssistantPayload(request: string, context: { parts: string[]; parameters: string[] }): string {
  const clip = (xs: string[]) => [...new Set(xs.map((s) => s.slice(0, 80)))].slice(0, 200);
  return JSON.stringify({ request: request.slice(0, 2000), parts: clip(context.parts), parameters: clip(context.parameters) }, null, 1);
}

export function createClaudeProvider(opts: ClaudeProviderOptions): LanguageModelProvider {
  const client = new Anthropic({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL,
    fetch: opts.fetch,
    // The user pastes their own key into their own browser; nothing is proxied through us.
    dangerouslyAllowBrowser: true,
    maxRetries: 1,
  });
  return {
    id: 'claude',
    requiresConsent: true,
    async plan(request, context) {
      let msg: Anthropic.Beta.BetaMessage;
      try {
        msg = await client.beta.messages.create({
          model: opts.model ?? CLAUDE_MODEL,
          max_tokens: 16000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          system: SYSTEM,
          output_config: { effort: 'low', format: { type: 'json_schema', schema: PLAN_SCHEMA } },
          messages: [{ role: 'user', content: buildAssistantPayload(request, context) }],
        });
      } catch (e) {
        if (e instanceof Anthropic.AuthenticationError) throw new ClaudeAssistantError('Invalid API key.');
        if (e instanceof Anthropic.RateLimitError) throw new ClaudeAssistantError('Rate limited — try again shortly.');
        if (e instanceof Anthropic.APIError) throw new ClaudeAssistantError(`Claude API error ${e.status ?? ''}: ${e.message}`);
        throw new ClaudeAssistantError(`Network error: ${(e as Error).message}`);
      }
      if (msg.stop_reason === 'refusal') throw new ClaudeAssistantError('The request was declined.');
      if (msg.stop_reason === 'max_tokens') throw new ClaudeAssistantError('The response was cut off.');
      const text = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      return parsePlan(text, request);
    },
  };
}

/** Validates model output against the step whitelist (never trust it blindly). */
export function parsePlan(text: string, request: string): AssistantPlan {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new ClaudeAssistantError('Malformed response.'); }
  const o = raw as { understood?: unknown; steps?: unknown; explanation?: unknown };
  const steps = Array.isArray(o.steps) ? [...new Set(o.steps.filter((s): s is RigStepId => STEP_IDS.includes(s as RigStepId)))] : [];
  const explanation = Array.isArray(o.explanation) ? o.explanation.filter((s): s is string => typeof s === 'string').map((s) => s.slice(0, 300)).slice(0, 12) : [];
  const understood = o.understood === true && steps.length > 0;
  return understood ? { understood, steps, explanation } : { understood: false, steps: [], explanation: [], unmatched: request };
}
