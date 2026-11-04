import PsdWorker from '@l2s/workers/psd.worker?worker';
import type { PsdWorkerRequest, PsdWorkerResponse } from '@l2s/workers/protocol';

export type ImportDone = Extract<PsdWorkerResponse, { type: 'done' }>;
export type ImportProgress = Extract<PsdWorkerResponse, { type: 'progress' }>;

export interface ImportHandle {
  promise: Promise<ImportDone>;
  cancel(): void;
}

let seq = 0;

/** Parse a PSD off the main thread. Each import gets its own worker so it can be cancelled by termination. */
export function importPsdInWorker(buffer: ArrayBuffer, fileName: string, sourceAssetId: string, onProgress: (p: ImportProgress) => void): ImportHandle {
  const worker = new PsdWorker();
  const requestId = ++seq;
  let settle: { reject: (e: Error) => void } | null = null;
  const promise = new Promise<ImportDone>((resolve, reject) => {
    settle = { reject };
    worker.onmessage = (ev: MessageEvent<PsdWorkerResponse>) => {
      const m = ev.data;
      if (m.requestId !== requestId) return;
      if (m.type === 'progress') onProgress(m);
      else if (m.type === 'done') { resolve(m); worker.terminate(); }
      else { reject(new Error(m.message)); worker.terminate(); }
    };
    worker.onerror = (e) => { reject(new Error(e.message || 'PSD worker failed')); worker.terminate(); };
    const req: PsdWorkerRequest = { type: 'import', requestId, fileName, sourceAssetId, buffer };
    // The buffer is copied (not transferred) because the caller keeps it as the preserved source asset.
    worker.postMessage(req);
  });
  return {
    promise,
    cancel() {
      worker.terminate();
      settle?.reject(new DOMException('Import cancelled', 'AbortError'));
    },
  };
}
