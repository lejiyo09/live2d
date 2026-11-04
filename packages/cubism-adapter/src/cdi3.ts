import type { Project } from '@l2s/editor-core';

/** cdi3.json (display info, Version 3). Spec: Live2D/CubismSpecs FileFormats/cdi3.json.md. */
export interface Cdi3 {
  Version: 3;
  Parameters: Array<{ Id: string; GroupId: string; Name: string }>;
  ParameterGroups: Array<{ Id: string; GroupId: string; Name: string }>;
  Parts: Array<{ Id: string; Name: string }>;
  CombinedParameters?: Array<[string, string]>;
}

/** Cubism-style ID from a display name (ASCII letters, digits, `_`). */
export function partId(index: number) {
  return `Part${String(index + 1).padStart(2, '0')}`;
}

export function projectToCdi3(p: Project): Cdi3 {
  const groups = p.nodes ? Object.values(p.nodes).filter((n) => n.kind === 'group') : [];
  return {
    Version: 3,
    Parameters: p.parameters.map((x) => ({ Id: x.id, GroupId: x.groupId ?? '', Name: x.name || x.id })),
    ParameterGroups: p.parameterGroups.map((g) => ({ Id: g.id, GroupId: '', Name: g.name })),
    Parts: groups.map((g, i) => ({ Id: partId(i), Name: g.name })),
  };
}

export function cdi3Names(json: unknown): Map<string, string> {
  const c = json as Partial<Cdi3>;
  return new Map((c.Parameters ?? []).map((x) => [x.Id, x.Name]));
}
