/// <reference lib="webworker" />
import { encodePng, parsePsd, convertPsd } from '@l2s/psd-importer';
import type { DisplayAsset, EncodedAsset, PsdWorkerRequest, PsdWorkerResponse } from './protocol.ts';

declare const self: DedicatedWorkerGlobalScope;

const post = (msg: PsdWorkerResponse, transfer: Transferable[] = []) => self.postMessage(msg, transfer);

self.onmessage = async (ev: MessageEvent<PsdWorkerRequest>) => {
  const req = ev.data;
  if (req.type !== 'import') return;
  const { requestId } = req;
  try {
    post({ type: 'progress', requestId, phase: 'parse', done: 0, total: 1 });
    const psd = parsePsd(req.buffer);
    const result = convertPsd(psd, {
      fileName: req.fileName,
      sourceAssetId: req.sourceAssetId,
      onProgress: (done, total) => {
        if (done % 8 === 0 || done === total) post({ type: 'progress', requestId, phase: 'layers', done, total });
      },
    });

    const displayIds = new Set<string>();
    for (const n of Object.values(result.project.nodes)) if (n.kind === 'layer') displayIds.add(n.assets.display);

    const assets: EncodedAsset[] = [];
    const displays: DisplayAsset[] = [];
    const transfer: Transferable[] = [];
    let i = 0;
    for (const a of result.assets) {
      const { width, height, data } = a.pixels;
      // Level 3: ~1.5× faster than 6 on large PSDs for ~25 % larger (still lossless) files.
      const png = encodePng(width, height, data, 3);
      assets.push({ id: a.id, kind: a.kind, mime: 'image/png', width, height, png });
      transfer.push(png.buffer);
      if (displayIds.has(a.id)) {
        const bitmap = await createImageBitmap(new ImageData(new Uint8ClampedArray(data), width, height), {
          premultiplyAlpha: 'none',
          colorSpaceConversion: 'none',
        });
        const alpha = new Uint8Array(width * height);
        for (let p = 0, j = 3; p < alpha.length; p++, j += 4) alpha[p] = data[j]!;
        displays.push({ id: a.id, bitmap, alpha });
        transfer.push(bitmap, alpha.buffer);
      }
      i++;
      if (i % 8 === 0 || i === result.assets.length) post({ type: 'progress', requestId, phase: 'encode', done: i, total: result.assets.length });
    }
    // Thumbnail: composite visible layers at ≤256 px on an OffscreenCanvas (no GPU readback on the main thread).
    let thumbnail: Blob | undefined;
    try {
      const { width: W, height: H } = result.project.canvas;
      const k = Math.min(1, 256 / Math.max(W, H));
      const c = new OffscreenCanvas(Math.max(1, Math.round(W * k)), Math.max(1, Math.round(H * k)));
      const g = c.getContext('2d')!;
      const byId = new Map(displays.map((x) => [x.id, x.bitmap]));
      const walk = (ids: string[], alpha: number, visible: boolean) => {
        for (const id of ids) {
          const n = result.project.nodes[id]!;
          const v = visible && n.visible, a = alpha * n.opacity;
          if (n.kind === 'group') { walk(n.childIds, a, v); continue; }
          const bmp = byId.get(n.assets.display);
          if (!v || !bmp) continue;
          g.globalAlpha = a;
          g.drawImage(bmp, n.bounds.x * k, n.bounds.y * k, n.bounds.width * k, n.bounds.height * k);
        }
      };
      walk(result.project.rootIds, 1, true);
      thumbnail = await c.convertToBlob({ type: 'image/png' });
    } catch { /* thumbnail is optional */ }
    post({ type: 'done', requestId, thumbnail, project: result.project, warnings: result.warnings, stats: result.stats, assets, displays }, transfer);
  } catch (err) {
    post({ type: 'error', requestId, message: err instanceof Error ? err.message : String(err) });
  }
};
