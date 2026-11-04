# `.l2studio` project format (formatVersion 4)

ZIP package (spec §12.1):

```
manifest.json                 format, formatVersion, generator, asset index (path, kind, mime, size)
project.json                  Project (scene graph) — see packages/editor-core/src/model.ts
assets/original/<id>.psd      untouched source PSD
assets/original/<id>.png      untouched layer pixels (lossless RGBA8 PNG, straight alpha)
assets/extracted/<id>.png     display pixels (mask / clipping / fill opacity baked) and layer masks
meshes/meshes.json            { version: 1, meshes: ArtMesh[] } — vertices (canvas px), uvs (layer-normalized), triangles, boundary loops
deformers/deformers.json      { version: 1, deformers: (WarpDeformer | RotationDeformer)[] }
parameters/parameters.json    { version: 1, parameters: Parameter[], groups: ParameterGroup[] }
physics/physics.json          { version: 1, fps, gravity, wind, settings: PhysicsSetting[] }
animations/animations.json    { version: 1, clips: AnimationClip[] }
ai/suggestions.json           reserved (Phase 4)
preview/thumbnail.png         512 px preview
```

* A layer whose display pixels equal its original pixels references the same asset id twice.
* Readers verify every manifest entry exists and matches `byteLength`, then run
  `checkIntegrity` (dangling nodes, wrong parents, cycles, duplicate references, missing assets).
* v3 → v4 adds `physics` and `animations`. Layers may carry `clipMask: { ids, inverted }` (runtime ArtMesh masks; optional, no migration needed). PSD clipping imported before this change stays baked into the display pixels.
* v2 → v3 adds `parameters`, `parameterGroups`, `deformers`; meshes gain optional `parentId` and `form` (keyforms).
* v1 → v2 adds `meshes: {}`. In packages, meshes are stripped from `project.json` and stored in `meshes/meshes.json`.
* `migrateProject` upgrades older `formatVersion`s step by step and refuses newer ones.

## Local storage (IndexedDB `live2d-studio`)

| Table | Key | Content |
|---|---|---|
| `projects` | `id` | Project JSON + thumbnail |
| `assets` | `projectId:assetId` | Blob + kind/mime/size (binaries separate from JSON) |
| `recovery` | `projectId` | crash-recovery journal (newer than `projects` row → restored) |

Saving deletes assets of the project that are no longer referenced.
