import type { AssetKind, Project } from '@l2s/editor-core';
import type { ImportWarning, ImportResult } from '@l2s/psd-importer';

export type PsdWorkerRequest = {
  type: 'import';
  requestId: number;
  fileName: string;
  sourceAssetId: string;
  buffer: ArrayBuffer;
};

export interface EncodedAsset {
  id: string;
  kind: AssetKind;
  mime: 'image/png';
  width: number;
  height: number;
  png: Uint8Array;
}

/** GPU-ready display asset: premultiplied ImageBitmap + 1-byte alpha map for picking. */
export interface DisplayAsset {
  id: string;
  bitmap: ImageBitmap;
  alpha: Uint8Array;
}

export type PsdWorkerResponse =
  | { type: 'progress'; requestId: number; phase: 'parse' | 'layers' | 'encode'; done: number; total: number }
  | {
      type: 'done';
      requestId: number;
      project: Project;
      warnings: ImportWarning[];
      stats: ImportResult['stats'];
      assets: EncodedAsset[];
      displays: DisplayAsset[];
      /** Small preview composited in the worker (normal blending), for the project list. */
      thumbnail?: Blob;
    }
  | { type: 'error'; requestId: number; message: string };
