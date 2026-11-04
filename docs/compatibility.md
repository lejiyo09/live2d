# MOC3 / Cubism compatibility

Spec §11, §14 Phase 6, §16. Status as of Phase 6.

## What exists

| Item | Status | How it is verified |
|---|---|---|
| **physics3.json** export / import | ✅ | Unit tests; round trip simulates identically; imports Live2D's official *Haru* sample physics (optional test, `CUBISM_SAMPLES=<folder>`) |
| **motion3.json** export / import | ✅ linear, bézier (restricted and free handles), stepped, inverse stepped | Unit tests; official Haru motions (63 curves, 296 segments) import and re-export with identical curves |
| **cdi3.json** export | ✅ parameters, parameter groups, parts (folders) | Unit test against the spec structure |
| Interop bundle (File → Export → Cubism JSON) | ✅ physics3 + cdi3 + motions + README | E2E: export from an auto-rigged project, re-import into a fresh one |
| **MOC3 preview** (File → Preview MOC3 Model) | ⚠️ implemented, **not yet verified with the real Core** | Tested end-to-end against a *test double* of the Core interface (`tests/fixtures/mock-cubism-core.js`): bundle reading, moc version / consistency checks, model→canvas coordinates, render order, alpha masks, parameters, motions and physics |
| `.moc3` / model3.json **export** | ❌ by design | Needs an authorized export path (§11.4) |

### Why the MOC3 preview is not verified yet

The Cubism Core (`live2dcubismcore.min.js`) is proprietary and distributed only through Live2D's
download page / CDN. Neither is reachable from the build environment used so far (network policy),
and the Core is intentionally not committed. The adapter was written against the Core API as the
open-source Cubism Web Framework uses it (`Moc.fromArrayBuffer`, `Moc.prototype.hasMocConsistency`,
`Version.csmGetMocVersion/csmGetLatestMocVersion`, `Model.fromMoc`, `model.parameters/parts/drawables/canvasinfo`,
`getRenderOrders`, `Utils.has*Bit`).

To verify (spec §11.6): open *File → Preview MOC3 Model*, choose `live2dcubismcore.min.js` from the
official Cubism SDK for Web, then a sample model folder (e.g. Haru from CubismWebSamples).
Points to check against the official viewer:

1. Coordinate mapping `x·PPU + CanvasOriginX`, `−y·PPU + CanvasOriginY` and the UV v-flip.
2. Mask results (incl. inverted masks) and draw order.
3. Multiply / screen colours and back-face culling are **not** implemented yet; Cubism 5.3 colour
   blend types and offscreen rendering are not supported.

## Rules kept

* Nothing is labelled "compatible" until validated with the official Core / SDK (§11.6).
* No `.moc3` reverse engineering or forging (§16). The Core is loaded only from a file the user
  supplies, used only in that browser tab, never uploaded or bundled.
* The official runtime simulates physics with its own options (gravity (0,−1), no wind), not with
  physics3 `Meta.EffectiveForces`; Live2D Studio does the same.

## Open questions for Live2D

1. Is there a licensed path for third-party tools to generate `.moc3`?
2. Which SDK release-license category applies to a web model editor that uses the Core only to
   preview user-supplied models (the user supplies the Core file)?
3. Conditions for offering a one-click download of the Core from the official CDN inside the PWA.

## References

* https://docs.live2d.com/ko/cubism-editor-manual/file-type-and-extension/
* https://docs.live2d.com/ko/cubism-editor-manual/export-moc3-motion3-files/
* https://docs.live2d.com/en/cubism-sdk-manual/cubism-core-api-reference/
* https://www.live2d.com/ko/sdk/license/
* Live2D/CubismSpecs — FileFormats/motion3.json.md, physics3.json.md, cdi3.json.md, model3.json.md
