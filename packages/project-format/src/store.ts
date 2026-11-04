import { referencedAssetIds, type AssetKind, type Project } from '@l2s/editor-core';
import { StudioDB, type AssetRow, type ProjectRow } from './db.ts';
import { migrateProject } from './migrate.ts';

export interface StoredAsset {
  id: string;
  kind: AssetKind;
  mime: string;
  width?: number;
  height?: number;
  blob: Blob;
}

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: string;
  thumbnail?: Blob;
}

/** IndexedDB-backed local project storage. Image binaries live apart from the JSON document. */
export class ProjectStore {
  constructor(readonly db = new StudioDB()) {}

  async list(): Promise<ProjectSummary[]> {
    const rows = await this.db.projects.orderBy('updatedAt').reverse().toArray();
    return rows.map(({ id, name, updatedAt, thumbnail }) => ({ id, name, updatedAt, thumbnail }));
  }

  async putAssets(projectId: string, assets: StoredAsset[]) {
    const rows: AssetRow[] = assets.map((a) => ({
      key: `${projectId}:${a.id}`, projectId, assetId: a.id, kind: a.kind, mime: a.mime, width: a.width, height: a.height, blob: a.blob,
    }));
    await this.db.assets.bulkPut(rows);
  }

  /** Save the document; unreferenced assets of this project are removed. */
  /** Save the document; without `thumbnail` the previously stored one is kept. */
  async saveProject(project: Project, thumbnail?: Blob) {
    const keepThumb = thumbnail ?? (await this.db.projects.get(project.id))?.thumbnail;
    const row: ProjectRow = {
      id: project.id, name: project.name, updatedAt: project.updatedAt, createdAt: project.createdAt,
      formatVersion: project.formatVersion, data: project, thumbnail: keepThumb,
    };
    const keep = referencedAssetIds(project);
    await this.db.transaction('rw', this.db.projects, this.db.assets, this.db.recovery, async () => {
      await this.db.projects.put(row);
      const stale = await this.db.assets.where('projectId').equals(project.id).filter((a) => !keep.has(a.assetId)).primaryKeys();
      if (stale.length) await this.db.assets.bulkDelete(stale);
      await this.db.recovery.delete(project.id);
    });
  }

  async loadProject(id: string): Promise<{ project: Project; recovered: boolean } | null> {
    const row = await this.db.projects.get(id);
    const rec = await this.db.recovery.get(id);
    if (!row && !rec) return null;
    const useRecovery = !!rec && (!row || rec.savedAt > row.updatedAt);
    const data = useRecovery ? rec!.data : row!.data;
    return { project: migrateProject(data), recovered: useRecovery };
  }

  async getAssets(projectId: string, ids?: Iterable<string>): Promise<StoredAsset[]> {
    const rows = ids
      ? (await this.db.assets.bulkGet([...ids].map((i) => `${projectId}:${i}`))).filter((r): r is AssetRow => !!r)
      : await this.db.assets.where('projectId').equals(projectId).toArray();
    return rows.map((r) => ({ id: r.assetId, kind: r.kind, mime: r.mime, width: r.width, height: r.height, blob: r.blob }));
  }

  async writeRecovery(project: Project) {
    await this.db.recovery.put({ projectId: project.id, savedAt: new Date().toISOString(), data: project });
  }

  async pendingRecoveries(): Promise<ProjectSummary[]> {
    const recs = await this.db.recovery.toArray();
    return recs.map((r) => ({ id: r.projectId, name: r.data.name, updatedAt: r.savedAt }));
  }

  async deleteProject(id: string) {
    await this.db.transaction('rw', this.db.projects, this.db.assets, this.db.recovery, async () => {
      await this.db.projects.delete(id);
      await this.db.assets.where('projectId').equals(id).delete();
      await this.db.recovery.delete(id);
    });
  }
}
