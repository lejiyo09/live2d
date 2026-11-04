import { newId, type Expression } from '@l2s/editor-core';

/** exp3.json ⇄ Expression. Spec: Live2D/CubismSpecs FileFormats/exp3.json.md. */
export interface Exp3 {
  Version?: 3;
  Type: 'Live2D Expression';
  FadeInTime?: number;
  FadeOutTime?: number;
  Parameters: Array<{ Id: string; Value: number; Blend?: 'Add' | 'Multiply' | 'Overwrite' }>;
}

export function expressionToExp3(e: Expression): Exp3 {
  return {
    Version: 3,
    Type: 'Live2D Expression',
    ...(e.fadeIn !== undefined ? { FadeInTime: e.fadeIn } : {}),
    ...(e.fadeOut !== undefined ? { FadeOutTime: e.fadeOut } : {}),
    Parameters: e.parameters.map((p) => ({ Id: p.parameterId, Value: Math.round(p.value * 1e6) / 1e6, Blend: p.blend })),
  };
}

export class Exp3Error extends Error {}

/** A missing Blend means "Add" (runtime default). */
export function exp3ToExpression(json: unknown, name: string): Expression {
  const x = json as Exp3;
  if (!x || x.Type !== 'Live2D Expression' || !Array.isArray(x.Parameters)) throw new Exp3Error('Not a Live2D Expression (exp3.json)');
  return {
    id: newId('exp'), name,
    ...(x.FadeInTime !== undefined ? { fadeIn: x.FadeInTime } : {}),
    ...(x.FadeOutTime !== undefined ? { fadeOut: x.FadeOutTime } : {}),
    parameters: x.Parameters.map((p) => ({ parameterId: p.Id, value: p.Value, blend: p.Blend ?? 'Add' })),
  };
}
