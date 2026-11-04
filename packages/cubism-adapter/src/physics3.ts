import type { PhysicsRig, PhysicsSetting, PhysicsSourceType } from '@l2s/editor-core';
import { newId } from '@l2s/editor-core';

/**
 * physics3.json (Version 3) ⇄ PhysicsRig.
 * Spec: Live2D/CubismSpecs FileFormats/physics3.json.md.
 *
 * Note: the official runtime simulates with its own gravity/wind options
 * (default gravity (0,-1), no wind), not with Meta.EffectiveForces. We
 * write our values for reference and keep runtime defaults on import.
 */
export interface Physics3 {
  Version: 3;
  Meta: {
    PhysicsSettingCount: number;
    TotalInputCount: number;
    TotalOutputCount: number;
    VertexCount: number;
    Fps?: number;
    EffectiveForces: { Gravity: { X: number; Y: number }; Wind: { X: number; Y: number } };
    PhysicsDictionary: Array<{ Id: string; Name: string }>;
  };
  PhysicsSettings: Array<{
    Id: string;
    Input: Array<{ Source: { Target: 'Parameter'; Id: string }; Weight: number; Type: 'X' | 'Y' | 'Angle'; Reflect: boolean }>;
    Output: Array<{ Destination: { Target: 'Parameter'; Id: string }; VertexIndex: number; Scale: number; Weight: number; Type: 'X' | 'Y' | 'Angle'; Reflect: boolean }>;
    Vertices: Array<{ Position: { X: number; Y: number }; Mobility: number; Delay: number; Acceleration: number; Radius: number }>;
    Normalization: {
      Position: { Minimum: number; Default: number; Maximum: number };
      Angle: { Minimum: number; Default: number; Maximum: number };
    };
  }>;
}

const T_OUT: Record<PhysicsSourceType, 'X' | 'Y' | 'Angle'> = { x: 'X', y: 'Y', angle: 'Angle' };
const T_IN: Record<string, PhysicsSourceType> = { X: 'x', Y: 'y', Angle: 'angle' };

export function rigToPhysics3(rig: PhysicsRig): Physics3 {
  const settings = rig.settings.map((s, i) => ({ s, id: `PhysicsSetting${i + 1}` }));
  return {
    Version: 3,
    Meta: {
      PhysicsSettingCount: settings.length,
      TotalInputCount: rig.settings.reduce((n, s) => n + s.inputs.length, 0),
      TotalOutputCount: rig.settings.reduce((n, s) => n + s.outputs.length, 0),
      VertexCount: rig.settings.reduce((n, s) => n + s.particles.length, 0),
      Fps: rig.fps,
      EffectiveForces: { Gravity: { X: rig.gravity.x, Y: rig.gravity.y }, Wind: { X: rig.wind.x, Y: rig.wind.y } },
      PhysicsDictionary: settings.map(({ s, id }) => ({ Id: id, Name: s.name })),
    },
    PhysicsSettings: settings.map(({ s, id }) => ({
      Id: id,
      Input: s.inputs.map((i) => ({ Source: { Target: 'Parameter' as const, Id: i.parameterId }, Weight: i.weight, Type: T_OUT[i.type], Reflect: i.reflect })),
      Output: s.outputs.map((o) => ({ Destination: { Target: 'Parameter' as const, Id: o.parameterId }, VertexIndex: o.vertexIndex, Scale: o.scale, Weight: o.weight, Type: T_OUT[o.type], Reflect: o.reflect })),
      Vertices: s.particles.map((p) => ({ Position: { X: p.x, Y: p.y }, Mobility: p.mobility, Delay: p.delay, Acceleration: p.acceleration, Radius: p.radius })),
      Normalization: {
        Position: { Minimum: s.normalization.position.min, Default: s.normalization.position.default, Maximum: s.normalization.position.max },
        Angle: { Minimum: s.normalization.angle.min, Default: s.normalization.angle.default, Maximum: s.normalization.angle.max },
      },
    })),
  };
}

export class Physics3Error extends Error {}

export function physics3ToRig(json: unknown): { rig: PhysicsRig; notes: string[] } {
  const p = json as Physics3;
  if (!p || p.Version !== 3 || !Array.isArray(p.PhysicsSettings)) throw new Physics3Error('Not a Version 3 physics3.json');
  const names = new Map((p.Meta?.PhysicsDictionary ?? []).map((d) => [d.Id, d.Name]));
  const notes: string[] = [];
  const g = p.Meta?.EffectiveForces?.Gravity, w = p.Meta?.EffectiveForces?.Wind;
  if (g && (g.X !== 0 || g.Y !== -1)) notes.push(`File gravity (${g.X}, ${g.Y}) is informational; simulation uses the runtime default (0, -1).`);
  if (w && (w.X !== 0 || w.Y !== 0)) notes.push(`File wind (${w.X}, ${w.Y}) is informational; simulation uses no wind (runtime default).`);
  const settings: PhysicsSetting[] = p.PhysicsSettings.map((s) => ({
    id: newId('phy'),
    name: names.get(s.Id) ?? s.Id,
    inputs: s.Input.map((i) => ({ parameterId: i.Source.Id, type: T_IN[i.Type] ?? 'x', weight: i.Weight, reflect: !!i.Reflect })),
    outputs: s.Output.map((o) => ({ parameterId: o.Destination.Id, type: T_IN[o.Type] ?? 'angle', vertexIndex: o.VertexIndex, scale: o.Scale, weight: o.Weight, reflect: !!o.Reflect })),
    particles: s.Vertices.map((v) => ({ x: v.Position.X, y: v.Position.Y, mobility: v.Mobility, delay: v.Delay, acceleration: v.Acceleration, radius: v.Radius })),
    normalization: {
      position: { min: s.Normalization.Position.Minimum, default: s.Normalization.Position.Default, max: s.Normalization.Position.Maximum },
      angle: { min: s.Normalization.Angle.Minimum, default: s.Normalization.Angle.Default, max: s.Normalization.Angle.Maximum },
    },
  }));
  return { rig: { fps: p.Meta?.Fps ?? 0, gravity: { x: 0, y: -1 }, wind: { x: 0, y: 0 }, settings }, notes };
}
