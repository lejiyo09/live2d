import Dexie, { type Table } from 'dexie';
import type { AssetKind, Project } from '@l2s/editor-core';

export interface ProjectRow {
  id: string;
  name: string;
  updatedAt: string;
  createdAt: string;
  formatVersion: number;
  data: Project;
  thumbnail?: Blob;
}

export interface AssetRow {
  /** `${projectId}:${assetId}` */
  key: string;
  projectId: string;
  assetId: string;
  kind: AssetKind;
  mime: string;
  width?: number;
  height?: number;
  blob: Blob;
}

/** Crash-recovery journal: the latest unsaved document state. */
export interface RecoveryRow {
  projectId: string;
  savedAt: string;
  data: Project;
}

export class StudioDB extends Dexie {
  projects!: Table<ProjectRow, string>;
  assets!: Table<AssetRow, string>;
  recovery!: Table<RecoveryRow, string>;

  constructor(name = 'live2d-studio') {
    super(name);
    this.version(1).stores({
      projects: 'id, updatedAt, name',
      assets: 'key, projectId, [projectId+assetId]',
      recovery: 'projectId, savedAt',
    });
  }
}
