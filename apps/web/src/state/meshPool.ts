import MeshWorker from '@l2s/workers/mesh.worker?worker';
import type { ArtMesh, AutoMeshSettings, Rect } from '@l2s/editor-core';
import type { MeshJob, MeshJobResult } from '@l2s/workers/mesh.worker';

/** Small pool of auto-mesh workers (spec §13.1: heavy processing off the main thread). */
let pool: Worker[] | null = null;
let seq = 0;

function workers(): Worker[] {
  if (!pool) {
    const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
    pool = Array.from({ length: n }, () => new MeshWorker());
  }
  return pool;
}

export interface MeshTask { layerId: string; alpha: Uint8Array; bounds: Rect; partCategory?: string }

export async function generateMeshesInWorkers(tasks: MeshTask[], settings: AutoMeshSettings, onProgress: (done: number) => void): Promise<Array<{ layerId: string; mesh: ArtMesh | null; constrained: boolean }>> {
  const ws = workers();
  const results: Array<{ layerId: string; mesh: ArtMesh | null; constrained: boolean }> = [];
  let next = 0, done = 0;
  await Promise.all(ws.map((w) => new Promise<void>((resolve) => {
    const run = () => {
      if (next >= tasks.length) { resolve(); return; }
      const t = tasks[next++]!;
      const jobId = ++seq;
      const onMsg = (ev: MessageEvent<MeshJobResult>) => {
        if (ev.data.jobId !== jobId) return;
        w.removeEventListener('message', onMsg);
        results.push({ layerId: ev.data.layerId, mesh: ev.data.mesh, constrained: ev.data.constrained });
        onProgress(++done);
        run();
      };
      w.addEventListener('message', onMsg);
      // Copy the alpha map: the texture cache keeps its own for picking.
      const alpha = new Uint8Array(t.alpha);
      const job: MeshJob = { jobId, layerId: t.layerId, alpha, bounds: t.bounds, settings, partCategory: t.partCategory };
      w.postMessage(job, [alpha.buffer]);
    };
    run();
  })));
  const order = new Map(tasks.map((t, i) => [t.layerId, i]));
  return results.sort((a, b) => order.get(a.layerId)! - order.get(b.layerId)!);
}
