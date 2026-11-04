# Performance (spec §13)

Measured with `scripts/make-stress-psd.mjs` (4096×4096, 240 layers in 24 folders, 20 MB PSD) in
headless Chromium with **software** WebGL (SwiftShader) on 4 cores — a pessimistic setup; a real GPU
is faster for uploads and renders. Reproduce: `pnpm dev`, then import `samples/stress.psd`.

| Stage | Before | After | Change |
|---|---|---|---|
| PSD import, total | 14.0 s | 7.6 s | PNG level 3 in the worker; worker-side thumbnail |
| Longest UI freeze during import | 2967 ms | 117 ms | batched GPU upload with frame yields; no GPU readback for the first thumbnail |
| Save (autosave) | 2.6 s first / 0.4 s each | 35 ms | thumbnail refreshed at most once a minute (or on Ctrl+S / export) |
| Auto mesh, 240 layers (52k vertices) | 11.2 s on the main thread | 6.4 s in a worker pool | `workers/mesh.worker.ts`, up to 4 workers |
| Longest UI freeze during auto mesh | ≈ 11 s | 267 ms | (applying the result + mesh check) |
| Evaluate one pose (52k vertices, warp + keyforms) | 3.4 ms | 2.7 ms | — |
| Slider → rendered pose | 3.6 ms | ≈ 4–6 ms | — |
| Undo + redo of a warp creation | 8–23 ms | — | patch based |
| JS heap after import | 144 MB | 147 MB | display textures only on the GPU; originals stay compressed in IndexedDB |

Design rules kept:

* PSD parsing / PNG encoding (`psd.worker.ts`) and auto mesh (`mesh.worker.ts`) run off the main thread.
* Only display textures are uploaded (with a 2 px transparent border); originals and masks stay as PNG blobs.
* Parameter evaluation is independent of rendering; mesh geometry buffers are updated in place on pose changes.
* Secondary PixiJS applications are paused, never destroyed (see architecture.md).

Not done yet: staged/lazy texture loading for PSDs larger than GPU memory, texture atlasing, and
off-screen culling.
