/// <reference lib="webworker" />
import { generateAutoMesh } from '@l2s/mesh-engine';
import type { ArtMesh, AutoMeshSettings, Rect } from '@l2s/editor-core';

declare const self: DedicatedWorkerGlobalScope;

export interface MeshJob { jobId: number; layerId: string; alpha: Uint8Array; bounds: Rect; settings: AutoMeshSettings; partCategory?: string }
export interface MeshJobResult { jobId: number; layerId: string; mesh: ArtMesh | null; constrained: boolean; error?: string }

/** Auto-mesh generation off the main thread (spec §13.1). */
self.onmessage = (ev: MessageEvent<MeshJob>) => {
  const j = ev.data;
  try {
    const r = generateAutoMesh({ layerId: j.layerId, alpha: j.alpha, bounds: j.bounds, settings: j.settings, partCategory: j.partCategory });
    self.postMessage({ jobId: j.jobId, layerId: j.layerId, mesh: r.mesh, constrained: r.stats.constrained } satisfies MeshJobResult);
  } catch (e) {
    self.postMessage({ jobId: j.jobId, layerId: j.layerId, mesh: null, constrained: true, error: (e as Error).message } satisfies MeshJobResult);
  }
};
