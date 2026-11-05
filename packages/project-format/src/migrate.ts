import { PROJECT_FORMAT_VERSION, type Project } from '@l2s/editor-core';

type Migration = (p: Record<string, unknown>) => Record<string, unknown>;

/** `MIGRATIONS[n]` upgrades a document from version n to n + 1. */
const MIGRATIONS: Record<number, Migration> = {
  // v1 → v2: ArtMesh support (Phase 2).
  1: (p) => ({ ...p, meshes: p.meshes ?? {} }),
  // v2 → v3: parameters and deformers (Phase 3).
  2: (p) => ({ ...p, parameters: p.parameters ?? [], parameterGroups: p.parameterGroups ?? [], deformers: p.deformers ?? {} }),
  // v3 → v4: physics and animation (Phase 5).
  // v4 → v5: expressions (parameter presets).
  4: (p) => ({ ...p, expressions: p.expressions ?? [] }),
  // v5 → v6: scenes (multi-clip timeline).
  5: (p) => ({ ...p, scenes: p.scenes ?? [] }),
  3: (p) => ({ ...p, physics: p.physics ?? { fps: 30, gravity: { x: 0, y: -1 }, wind: { x: 0, y: 0 }, settings: [] }, animations: p.animations ?? [] }),
};

export class ProjectVersionError extends Error {}

export function migrateProject(input: unknown): Project {
  if (!input || typeof input !== 'object') throw new ProjectVersionError('Project data is not an object');
  let doc = structuredClone(input) as Record<string, unknown>;
  let v = typeof doc.formatVersion === 'number' ? doc.formatVersion : 0;
  if (v > PROJECT_FORMAT_VERSION) {
    throw new ProjectVersionError(`Project was saved by a newer version (format ${v}); this build supports up to ${PROJECT_FORMAT_VERSION}.`);
  }
  while (v < PROJECT_FORMAT_VERSION) {
    const m = MIGRATIONS[v];
    if (!m) throw new ProjectVersionError(`No migration from format ${v}`);
    doc = m(doc);
    v++;
    doc.formatVersion = v;
  }
  return doc as unknown as Project;
}
