# Large-Scale Rendering — Performance Scaling Plan (100k → 10M → 100M+)

Synthesis of a 3-track web research sweep (CPU/aggregation, GPU-scatter SOTA, WebGPU+tiling),
de-duplicated and mapped to THIS stack (deck.gl v9 / luma.gl **WebGL2 only**, single `<DeckGL>` +
N OrthographicViews, 12 B/point interleaved xy·f32 + rgba·u8, GPU colormap LUT + per-point category
code, chunked layers >budget, GPU screen-grid density image + CPU `densify`/`cpuGroupReduce` oracles).

## Measured baseline (this box, `benchmark` story, real LOD/density view)

| points | GPU (H200, WebGL2) | CPU (SwiftShader, WebGL2) |
|---|---|---|
| 100k | ~47 fps | pan redraws **seconds** (meanFps 0.57) |
| 1M | ~56 fps | meanFps 0.10, 5.5 s load |
| 10M | single-layer cliff ~1 fps → **chunked** = 40×250k, 120 MB, renders | **won't load in 10 min** |

Root cause of the CPU gap: LOD/density thresholds are **GPU-tuned** (LOD >1.5M, density >3M), so
below that we draw every point; and on SwiftShader a per-point draw is `O(N × huge-emulation-constant)`
(every vertex+fragment interpreted). WebGL2-over-SwiftShader is the ONLY CPU render path we have.

## The two insights that frame everything

1. **CPU / software realtime = bin-then-shade (Datashader model).** Stop drawing N marks. Aggregate
   N points → a fixed W×H count grid → shade to RGBA → draw as **ONE `BitmapLayer` quad**. On
   SwiftShader a quad is `O(pixels)`, **N-independent**; N points is `O(N × constant)`. We ALREADY
   compute this exact aggregate (GPU screen-grid COUNT image + the CPU `densify` oracle) — the work
   is making the raster the PRIMARY path in CPU mode, amortized + off-thread.
2. **GPU unbounded scale = tiling pyramid.** Beyond chunking, the only path to tens-of-millions /
   billions at full fidelity is a quadtile pyramid + viewport LOD (`TileLayer`, deepscatter model):
   load/draw only tiles in view at the current zoom. Per-frame cost decouples from total N.
3. **WebGPU is a hardware-GPU-only win — it does NOT help the software case** (Chrome is even removing
   the SwiftShader auto-fallback). So WebGPU is NOT the answer to the CPU gap; it's a future compute
   accelerator for hardware-GPU users. Keep the portable seam; don't take the dep yet.

## What we already have (don't rebuild)

- ✅ Binary interleaved typed-array attributes (xy·f32 + rgba·u8) — deck.gl's #1 documented optimization.
- ✅ Category code (per-point) + GPU colormap LUT — recolor = LUT swap, no re-upload (`CategoricalPointsView`).
- ✅ GPU screen-grid COUNT density image (`densifyGpu`) + CPU `densify` / `cpuGroupReduce` oracles.
- ✅ LOD-while-interacting subset + chunked N-layer split under a VRAM budget (`scale/lod.ts`, `scale/chunking.ts`).

## Technique catalog (ranked by impact ÷ effort, deduped across all 3 tracks)

### Track A — CPU-realtime (closes the MEASURED gap)
| # | Technique | Impact (CPU) | Effort | Fit to our code |
|---|---|---|---|---|
| A1 | **Bin-then-shade → one `BitmapLayer` quad** (Datashader) | ★★★★★ | M | reuse `densify` oracle as the aggregate; render its RGBA as a BitmapLayer per view |
| A2 | **Amortize**: pan = slide quad bounds (free); zoom = debounced re-bin; progressive fill for 10M | ★★★★★ | S–M | BitmapLayer `bounds` follow the OrthographicView; debounce where `densify` recomputes |
| A3 | **Off-thread bin**: Worker + transferable / SharedArrayBuffer (COOP/COEP) + OffscreenCanvas | ★★★★ | M | worker owns the xy typed array; returns shaded `Uint8ClampedArray` |
| A4 | **CPU-mode detection** → run the raster path across the WHOLE range (thresholds moot in CPU mode) | ★★★★ | S | probe `UNMASKED_RENDERER_WEBGL` = SwiftShader / `!deviceSupportsDensify` |
| A5 | **Reservoir / stratified sample** for the moving subset (~10–50k), density/outlier-aware (not head-N) | ★★★ | S | replace the current head-N LOD slice; drawn only during gestures |

### Track B — GPU scale (push single/chunked higher; unbounded N)
| # | Technique | Impact | Effort | Fit |
|---|---|---|---|---|
| B1 | **Quadtile pyramid + `TileLayer` viewport LOD** (deepscatter) — the unbounded-N unlock | ★★★★★ | L | needs an offline/server tiler; draws only on-screen tiles |
| B2 | **16-bit / half-float positions + per-tile origin shift** (avoid fp64, ~10× shader cost) | ★★★ | M | halve position VRAM + upload; keep f32 precision via CPU origin subtract |
| B3 | **GeoArrow / Arrow zero-copy ingestion** (`@geoarrow/deck.gl-layers`, RecordBatch→GPU) | ★★★★ | M | only if source is columnar; kills JS-object churn + GC at load |
| B4 | **GPU density accumulation** (additive blend, order-independent) / HeatmapLayer, iOS 8-bit fallback | ★★★ | M | we have the screen-grid; generalize to additive-blend + tonemap |
| B5 | **Picking discipline** (`pickable:false` while dense; 16M items/layer, 256 layers caps) | ★★★ | S | picking is a whole extra pass — top hidden cost at scale |
| B6 | **`updateTriggers` / `dataComparator` / constant accessors** hygiene | ★★ | S | avoid buffer rebuilds on recolor/resize |

### Track C — WebGPU (future, hardware-GPU users only)
| # | Technique | Impact | Effort | Fit |
|---|---|---|---|---|
| C1 | **WebGPU compute histogram** (storage buffers + `atomicAdd`, workgroup-shared bins) for `densify`/`groupReduce` | ★★★★ (HW GPU, 5–50M) | M | drop-in behind the existing portable helper interface + CPU oracle; **integer-count accumulator** (no `atomic<f32>` in WGSL — fixed-point for weighted) |
| C2 | Keep the seam: luma `Device` abstraction + backend enum (`cpu`\|`webgl2`\|`webgpu`); **do not add `@luma.gl/webgpu` dep yet** (deck.gl WebGPU rendering not ready — picking ❌) | — | S | matches the "eventual WebGPU" comments already in `gpu/*.ts` |
| C3 | **Precomputed multiscale aggregates** (imMens/Falcon/Nanocubes → Mosaic/DuckDB) for 100M+ fixed dashboards | ★★★★ (100M+) | L | data-architecture layer ABOVE deck.gl; O(1)/view, N-independent |

## Recommended build order

1. **CPU-realtime raster mode** (A4 → A1 → A2 → A3), gated on the software probe. Target: **≥30 fps pan
   at 10M on CPU** via the density-first path; regression-gate with the measured CPU fps numbers.
   Reuses the existing `densify` oracle + screen-grid aggregate; ~M total. **This closes the gap the
   user hit.** In CPU mode the >3M density threshold is dropped — raster is the whole-range path.
2. **Load-enabling for 10M under software** (B2 quantize + confirm chunked layers stay < ~1 GB alloc)
   so 10M *loads* at all; pairs with A3 (transfer a smaller buffer to the worker).
3. **GPU unbounded scale** (B1 tiling pyramid) — separate, larger initiative; the only path past the
   chunked ceiling to 10M+ full-fidelity interactive. B4/B5/B6 are cheap GPU-side wins to fold in.
4. **WebGPU compute** (C1) — when a hardware-GPU segment feels pain at 5–50M; decoupled from deck.gl
   layer readiness. Keep C2 seam now (near-zero cost, mostly discipline).

## Targets + gate

- CPU: interactive (**≥30 fps**) pan at 100k / 1M / 10M via raster mode (today: 0.57 / 0.10 / won't-load).
- GPU: keep 1M single-layer ~50 fps; 10M via chunk/tile at ≥30 fps.
- Gate: extend the `benchmark`/`perf` harness to record CPU (`--use-angle=swiftshader`) + GPU
  (`--use-angle=gl-egl`) fps at each N; fail on regression.

## Key references
Datashader (bin-then-shade): https://datashader.org/getting_started/Introduction.html ·
deck.gl performance: https://deck.gl/docs/developer-guide/performance ·
deepscatter (quadtile pyramid, >1B): https://github.com/nomic-ai/deepscatter ·
regl-scatterplot (texture-state, 20M): https://github.com/flekschas/regl-scatterplot ·
GeoArrow layers (zero-copy): https://github.com/geoarrow/deck.gl-layers ·
WebGPU compute histogram: https://webgpufundamentals.org/webgpu/lessons/webgpu-compute-shaders-histogram.html ·
WGSL atomics (no f32): https://google.github.io/tour-of-wgsl/types/atomics/atomic-types/ ·
luma.gl/deck.gl WebGPU status: https://deck.gl/docs/developer-guide/webgpu · https://luma.gl/docs/whats-new ·
Chrome removing SwiftShader fallback: https://groups.google.com/a/chromium.org/g/blink-dev/c/yhFguWS_3pM ·
imMens/Falcon (precomputed aggregates): http://vis.stanford.edu/files/2013-imMens-EuroVis.pdf · https://idl.cs.washington.edu/files/2019-Falcon-CHI.pdf
</content>
</invoke>
