# Package APIs (Phase 1)

## @l2s/editor-core
* Model: `Project`, `GroupNode`, `LayerNode`, `PartTag`, `BlendMode`, `createEmptyProject`, `newId`
* Tree: `resolveDrawOrder`, `flattenForTree`, `boundsOf`, `subtreeIds`, `isInSubtree`, `siblingsOf`, `referencedAssetIds`
* History: `CommandHistory` (`execute`, `undo`, `redo`, `reset`, `sealLastStep`, `subscribe`, `state`, `labels`)
* Commands: `setNodeProps`, `renameNode`, `moveNode`, `reorderNode`, `groupNodes`, `ungroup`, `deleteNodes`, `translateNodes`, `renameProject`
* Selection: `applySelection(project, sel, id, 'replace'|'add'|'toggle'|'range')`, `pruneSelection`

## @l2s/psd-importer
* `importPsd(bytes, { fileName, sourceAssetId, suggestTags?, onProgress? }) → { project, assets, warnings, stats }`
* `parsePsd`, `convertPsd`, `mapBlendMode`, `suggestPartTag`, `encodePng`, `toRgba8`

## @l2s/rendering-engine
* `StudioRenderer` (`init(host, { pick, hover, camera })`, `sync`, `setSelection`, `setHover`, `fitToView`, `setZoom`, `zoomBy`, `setCamera`, `snapshot`, `destroy`, `textures`)
* `TextureCache`, `hitTestAll`, `pick`, `toPixiBlend`, camera helpers

## @l2s/project-format
* `ProjectStore` (IndexedDB): `list`, `saveProject`, `loadProject`, `putAssets`, `getAssets`, `writeRecovery`, `deleteProject`
* `writePackage`, `readPackage`, `checkIntegrity`, `migrateProject`
