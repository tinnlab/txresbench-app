# Performance Build Plan — 4 phases (execution)

Execution plan for the techniques ranked in [`PERF_SCALING_PLAN.md`](./PERF_SCALING_PLAN.md).
That doc is the research (why/what); this is the build (how), phased with deliverables, files,
tests, and a measured gate per phase. Domain-neutral, WebGL2 stack, NO SVG, additive/opt-in
(every phase byte-identical to today when its new path is off).

Measured baseline to beat (`benchmark` story, real view):
CPU/SwiftShader — 100k 0.57 fps · 1M 0.10 fps · 10M won't-load. GPU/H200 — 100k 47 · 1M 56 · 10M
single-layer cliff (chunked renders).

## Phase 0 — Reproducible fps gate (foundation for every phase)

- **Deliver:** commit `scripts/viz-perf.mjs` (referenced by `perf.spec.ts` but missing) — drives the
  `benchmark` story headless at `?points=` under BOTH `--use-angle=swiftshader` (CPU) and
  `--use-angle=gl-egl` (GPU), records `{meanFps, p95Ms}` at 100k/1M/10M, writes a JSON baseline.
- **Files:** `scripts/viz-perf.mjs`, a `just`/npm task.
- **Gate:** produces the baseline table above; used by all later phases as before/after.

## Phase 1 — CPU raster mode (P0: closes the measured gap)  [A4 → A1 → A2 → A3]

The bin-then-shade path: when software rendering is detected, render dense scatter as ONE
`BitmapLayer` quad of a CPU-binned + shaded raster instead of N points.

- **A4 capability probe** — `gpu/renderCapability.ts`: `isSoftwareRenderer(device|gl)` via
  `UNMASKED_RENDERER_WEBGL` (matches `/swiftshader|llvmpipe|software/i`) OR `!deviceSupportsDensify`.
  A `CpuRasterMode` context/flag (auto from probe; manual override for tests + a story toggle).
- **A1 bin-then-shade** — reuse the existing CPU `densify` oracle (`data/wire.ts::densify`) to build a
  `W×H` count grid from the interleaved xy for the current viewport bounds; shade counts→RGBA
  (log / hist-eq normalize) through the existing colormap into a `Uint8ClampedArray`; hand it to a
  `@deck.gl/layers` `BitmapLayer` (`bounds` = view world-rect). New `density/cpuRaster.ts` +
  `density/CpuRasterView` (or a branch in `CategoricalPointsView`).
- **A2 amortize** — pan = the `BitmapLayer.bounds` follow the OrthographicView (0 CPU re-bin); zoom =
  debounced re-bin (~120 ms) with the stale raster shown until the new one lands. (Progressive fill
  is a stretch within this phase.)
- **A3 off-thread bin** — move the O(N) bin+shade into a Web Worker (transferable `ArrayBuffer`;
  `SharedArrayBuffer` if COOP/COEP present); worker returns the shaded bytes. Main thread only
  uploads + draws. (May land as A1/A2 first on main-thread, A3 as the follow commit in-phase.)
- **Routing** — in CPU mode the raster is the WHOLE-range dense path (the >3M density threshold is
  dropped); on a real GPU nothing changes (byte-identical).
- **Files:** `gpu/renderCapability.ts`, `density/cpuRaster.ts`, worker under `density/`, a branch in
  `spatial/CategoricalPointsView.tsx` / `DeckScatterCanvas.tsx`, `scale/lod.ts` (software-aware
  thresholds), a `cpu-raster.story.tsx`, unit + swiftshader e2e.
- **Tests:** unit (bin correctness vs `densify` oracle, shade ramp, probe matching); e2e — force CPU
  mode, assert a single non-blank BitmapLayer renders + pan stays interactive; **fps gate** via
  Phase 0 at 100k/1M/10M under swiftshader.
- **Target:** **≥30 fps pan at 10M on CPU** (today 0.10–won't-load); GPU path unchanged.

## Phase 2 — Load-enabling for 10M under software  [B2 packing + chunk-under-cap]

Make 10M *load* + shrink the worker transfer.

- **Deliver:** optional 16-bit position packing (`Uint16` + per-tile origin+scale → 4 B xy, restored
  in-shader / pre-bin) behind a flag; confirm chunked layers stay under Chrome's ~1 GB single-alloc
  cap (`scale/chunking.ts`) and that CPU mode goes density-first from frame 1 (never builds 10M point
  layers under software — the thing that stalled load).
- **Files:** `data/wire.ts` (pack/unpack), `scale/chunking.ts`, the CPU-raster load path.
- **Tests:** unit (pack↔unpack round-trip, precision bound); e2e — 10M **loads** under swiftshader
  within budget + renders via the raster.
- **Target:** 10M loads on CPU (today: times out); position VRAM/transfer ÷2.

## Phase 3 — GPU unbounded scale  [B1 client quadtree tiling + viewport LOD] (+ B4/B5/B6)

Break the chunked ceiling: draw only on-screen tiles at the current zoom.

- **Deliver:** a CLIENT-side quadtree over the resident typed array (offline/server tiler out of
  scope), a `TileLayer`-style viewport-LOD selector that draws only visible tiles at a zoom-matched
  stride/aggregate, per-frame cost decoupled from total N. Fold in the cheap GPU wins: **B5** picking
  discipline (`pickable:false` while dense), **B6** `updateTriggers`/`dataComparator` hygiene,
  **B4** additive-blend density accumulation (order-independent) generalized from the screen-grid.
- **Files:** `scale/tilePyramid.ts` (+ tests), a tiling branch in the grid render, `spatial/*`.
- **Tests:** unit (tile selection by viewport+zoom, cull correctness); e2e — 10M via tiling renders
  non-blank + interactive on GPU; picking off while dense.
- **Target:** 10M+ full-fidelity **≥30 fps** on GPU via tiling (beyond the single/chunked cliff).

## Phase 4 — WebGPU-ready compute seam  [C2 now; C1 reference, unwired]

WebGPU is hardware-GPU-only and deck.gl's WebGPU render path isn't production-ready (picking ❌), so
this phase is the **seam**, not a runtime dependency.

- **Deliver:** add a `ComputeBackend = 'cpu' | 'webgl2' | 'webgpu'` enum to the compute-helper
  interface (`gpu/computeDevice.ts`, `gpu/groupReduce.ts`, `gpu/densifyGpu.ts`); default accumulator
  is **integer counts**, with a documented fixed-point path for weighted density (WGSL has no
  `atomic<f32>`). Hold a luma `Device` (not a raw GL context) so a WebGPU device drops in via
  `luma.createDevice({ adapters })` later. Ship a **reference WGSL compute-histogram** as a string
  constant + a gated `runDensifyWebGPU` that is **NOT wired into runtime and adds NO `@luma.gl/webgpu`
  dep** (a documented, test-only reference so the kernel exists when the ecosystem is ready).
- **Files:** `gpu/computeDevice.ts`, `gpu/groupReduce.ts`, `gpu/densifyGpu.ts`, a new
  `gpu/webgpuHistogram.wgsl.ts` (string), unit tests.
- **Tests:** unit — backend-enum dispatch selects cpu/webgl2 correctly; **byte-identical** to today
  for cpu + webgl2 (the WebGPU arm is compiled-in but never selected without a registered adapter).
- **Target:** zero runtime change today; a one-adapter-registration away from a WebGPU compute path
  for hardware-GPU users at 5–50M. (Full WebGPU kernel wiring + `@luma.gl/webgpu` dep = a later,
  separately-gated effort once deck.gl WebGPU rendering + picking land.)

## Sequencing

Phase 0 first (the gate). Phases 1→2→3 share the render path (`CategoricalPointsView`/
`DeckScatterCanvas`/`scale/*`) → build sequentially. **Phase 4 edits only `gpu/*` → parallel-safe with
Phase 1.** Each phase: implement → tsc + unit → swiftshader/GPU e2e + fps gate → blind-audit → commit
(local only). Build in-tree (NOT `isolation:worktree`).
</content>
