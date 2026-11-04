# Architecture

## Data flow

```
File (.psd) ──► psd.worker ──► { Project JSON, PNG assets, ImageBitmaps + alpha maps }
                 │ ag-psd parse (useImageData, no canvas)
                 │ mask / clipping / fill-opacity baked into *display* pixels
                 │ originals kept untouched (lossless PNG, plus the source PSD bytes)
                 ▼
          editor store (apps/web/src/state/editor.ts)
                 │ CommandHistory (editor-core) ── Immer patches ── undo / redo
                 ├──► StudioRenderer.sync(project)   (rendering-engine, PixiJS 8 / WebGL2)
                 └──► ProjectStore (IndexedDB)        (project-format, autosave 1.5 s)
```

Rules (spec §17): React never deforms or renders pixels itself; the renderer never mutates the
project. Canvas interaction is reported as events (`pick`, `hover`, `camera`) and converted
into commands by the editor layer.

## Scene graph

`Project.nodes` is a flat map; hierarchy is `parentId` + `GroupNode.childIds`. Children are
stored **bottom → top** (PSD order). The tree view shows them reversed. Inherited state
(visibility, lock, opacity, PSD clipping-base visibility) is resolved by `resolveDrawOrder`.

## Commands and history

A `Command` mutates an Immer draft. `CommandHistory.execute` records forward/inverse patches,
so every command is reversible without writing undo code by hand. Commands with the same
`mergeKey` inside 800 ms collapse into one step (slider drags). No-op commands are not recorded.

## Rendering

* Layers with an ArtMesh render as a PixiJS `Mesh`; layers without one as a `Sprite`.
* Textures are copied into a canvas with a 2 px transparent border (`TEXTURE_PAD`) so mesh
  margins outside the art sample transparency instead of clamped edge pixels. Mesh UVs are
  stored relative to the unpadded layer image and remapped at upload.

## ArtMesh generation (mesh-engine)

1. Alpha → conservative grid (≤ 512 cells per side) → exact Euclidean distance transforms.
2. Outer region = within *outer margin* of the art; inner ring = deeper than *inner margin*.
3. Region boundaries traced as loops, Douglas–Peucker simplified, resampled at *outline spacing*.
4. Interior points: Poisson-style sampling, spacing shrinks with local thickness (hair tips) and
   by *detail factor* for Eye/Eyebrow/Mouth part tags.
5. Delaunator + Constrainautor (outline loops as constraints), triangles outside the outline
   dropped, zero-area triangles from collinear outline points repaired by splitting the
   neighbour (no T-junctions).

In mesh-edit mode moving a vertex moves its UV too (the texture stays put). Deformation
keyforms (Phase 3) will move positions only.
* PSD blend modes map to PixiJS advanced blend modes (`useBackBuffer: true`). `hue`,
  `darker-color`, `lighter-color`, `dissolve` have no GPU equivalent and are approximated
  (flagged in the Inspector).
* The canvas is transparent; the checkerboard is CSS, so blend modes composite against
  transparency like Photoshop.
* Picking uses a 1-byte-per-pixel alpha map per display texture (threshold 16/255).

## Known Phase 1 approximations

| Item | Behaviour |
|---|---|
| Group opacity / blend | Applied per child, not as an isolated group composite |
| Clipping onto a group | Not baked (warning) |
| Layer effects, vector masks, adjustment layers | Not imported (warning in Import Report) |
| 16/32-bit PSD | Converted to 8-bit sRGB |

## Parameters, keyforms and deformers (Phase 3)

Follows Cubism's model:

* Every keyed object (ArtMesh, warp, rotation) owns a `KeyformGrid`: bindings
  `(parameterId, keys[])` and one keyform per key combination (first binding varies
  fastest). Values between keys are interpolated multilinearly; outside the keys they clamp.
* Keyform data is stored in the **parent's local space**:
  * root → canvas px
  * warp parent → normalized 0..1 over the warp grid (bilinear, extrapolated outside)
  * rotation parent → px offsets from the origin, rotated/scaled
* Evaluation (`deformer-engine/evaluate.ts`) resolves deformers parents-first into canvas
  space (warp → canvas grid points; rotation → canvas origin + effective angle/scale), then
  maps each ArtMesh's interpolated local positions through its immediate parent. A rotation
  deformer under a warp follows the warp's local rotation/stretch relative to its default pose.
* Editing in canvas space uses inverse transforms (warp inverse by Newton iteration).
* Reparenting, deformer creation/deletion and pivot moves re-express every keyform so its pose
  at its own key context is unchanged.
* Parameter values are view state (not undoable, not saved); everything else is a Command.
* Mesh topology editing works in the rest pose; moved/added/deleted vertices update every
  keyform (added vertices interpolate barycentrically).

Known gaps: Bezier warp handles, blend shapes, draw-order keyforms, per-deformer visibility.

## AI Assistance (Phase 4)

`packages/ai-engine` is deterministic: no trained model ships with the project (spec §10.7 requires
licence review of any model). Every result is a proposal the user reviews; applying it is one Command.

* `recognizeParts` — name rules (layer + ancestor folders) combined with geometry relative to the
  face (position, size, draw order, left/right). Sources are recorded as `name-rule` / `shape-rule`;
  user tags are never touched. `PartClassifier` is the slot for an ONNX image classifier.
* `buildRigProposal` / `applyRigProposal` — rule engine producing the standard face rig
  (Head Z → Face XY → Eye L/R, Mouth, Hair Front; Hair Back). Keyforms are written as canvas-space
  displacements converted into each deformer's parent space, so the default pose is unchanged.
* `analyzeRig` — static checks plus evaluation at every bound parameter's min/max (folds, stretch).
* `interpret` — keyword intent parser for the assistant; `LanguageModelProvider` is the opt-in,
  consent-gated slot for server-side LLM planning.

## Physics and animation (Phase 5)

* `physics-engine` reproduces the behaviour of Cubism's physics3 runtime (normalisation around the
  centre of the parameter range, `AirResistance = 5`, `MovementThreshold = 0.001`, delay × 30,
  fixed-step simulation at `physics.fps` with interpolated inputs and outputs, chained groups).
  It was written from the algorithm in the open-source Cubism Web Framework, not copied, and
  reproduces the runtime's in-place rotation so motion matches the official viewer.
* `animation-engine`: clips hold per-parameter tracks; segment interpolation is defined by the left
  key (`linear` / `bezier` / `step`) with Bezier handles stored as (segment fraction, value offset),
  which maps directly onto motion3.json segments for the Phase 6 exporter.
* Runtime (`apps/web/src/state/anim.ts`): slider values → animation sample (when playing) → physics
  (when enabled) → `evaluateModel`. These "driven" values never enter the undo history.
* Baking (`bakePhysics`) simulates the clip deterministically from rest at the clip fps and stores
  the outputs as reduced linear keys; export uses the same deterministic simulation.
* Export renders each frame off-screen (`StudioRenderer.extractArtwork`) and writes a PNG zip or a
  WebM via WebCodecs + mediabunny (MPL-2.0, pinned 1.62.0).

## Masks (Phase 2b, shared with the MOC3 preview)

Mask layers are drawn into a canvas-sized render texture (≤ 2048 px) that is applied as a PixiJS
alpha mask (`setMask({ mask: sprite, channel: 'alpha', inverse })`). Mask textures are re-rendered
on every pose change, so clipping follows deformation. Hit testing honours masks.

## Third-party licences

PixiJS (MIT), ag-psd (MIT), React (MIT), Zustand (MIT), Immer (MIT), Dexie (Apache-2.0),
fflate (MIT), delaunator (ISC), @kninnug/constrainautor (ISC), mediabunny (MPL-2.0, unmodified),
vite-plugin-pwa (MIT). The Live2D Cubism Core is **not** included (user-supplied, proprietary).

## Multiple PixiJS applications

Secondary views (split view, MOC3 preview) are created once and then paused (`setActive(false)`)
and moved out of the DOM instead of being destroyed: destroying one PixiJS v8 Application while
another is running corrupts shared batcher pools. Renderers observe their host with a
ResizeObserver (PixiJS' `resizeTo` only listens to window resizes) and keep the view centre fixed.
