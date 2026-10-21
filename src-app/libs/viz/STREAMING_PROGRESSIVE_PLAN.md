# Streaming + Progressive Rendering Plan (Phase 2.5)

Research synthesis + build spec for keeping the CPU raster interactive while 10M+ cells arrive
progressively (~1M/sec) across heterogeneous channels. Companion to `PERF_SCALING_PLAN.md` /
`PERFORMANCE_PLAN.md`. Maps onto what we already shipped: the columnar lazy `DataSource`, the
off-thread **additive count-grid worker** with epoch-drop, the single `BitmapLayer` quad, 16-bit
packed positions, and canonical point-id selection.

## The spine (why this is cheap for us)

Our additive count-grid **is an incrementally-maintainable materialized view** — a histogram is
`COUNT … GROUP BY (binX,binY)`, the textbook self-maintainable additive aggregate. A new 1M chunk is
a `+=` into the accumulator; we never recompute. **Progressive rendering, for us, = emit the current
accumulator as a frame after each delta.** (IVM/ViewDF, StreamingCube.)

## Ranked techniques (leverage-for-our-stack; effort S/M/L)

1. **Partial-histogram emit (S) — do first.** Don't wait for "all bins done"; the worker shades the
   accumulator-so-far every ~50–100ms and posts a frame. First meaningful frame at ~1M (~1s) instead
   of the full-load wait. Epoch counter = cancellation token (stale partial dropped like a stale full).
2. **Anti-flicker: normalize + EMA (S).** Shade off *relative* density (`count/currentTotal` or
   `/currentMax`), and EMA-blend this frame's RGBA toward the last, so the image doesn't re-level /
   flash on every chunk. One line in the shade pass.
3. **Additive channel accumulation (S–M).** Labels → per-top-K-category count grids; continuous
   (one gene) → `sum[bin]+=v`, `cnt[bin]+=1`, `sumSq` → mean/variance at shade time. All additive →
   a chunk just updates. Enables live gene/label coloring *during* the stream.
4. **Transferables / SharedArrayBuffer handoff (S–M).** `postMessage(buf,[buf])` (~29ms) not
   structured-clone (~268ms) for arriving column buffers; retained 16-bit positions live in a growing
   **SAB** so zoom re-bin reads shared memory with zero re-transfer. (SAB needs COOP/COEP.)
5. **Per-column streams aligned by global offset (M).** Each bound channel = its own chunked stream over
   HTTP; chunk *k* of every column covers the same `[offset,offset+len)` rows. `id = offset + localRow`
   keeps selection valid mid-stream. Bandwidth ∝ bound channels; switching gene fetches ONE column, not a
   reload. **This was written as Arrow IPC and shipped as shuffle+gzip zarr** — see the phase-2.6 gate
   below for why the survey's Arrow assumption does not apply to our wire (DEC-4). The general-industry
   note is retained: were one to use Arrow, it is the **streaming format**, NOT Flight (unsupported
   in-browser).
6. **Online-aggregation semantics (M).** Server streams chunks in **randomized/interleaved** order so a
   partial accumulator is an *unbiased* scaled-down copy (never spatially-sorted → early frames biased).
   Optional CLT √n coverage badge ("~12% sampled, ±X%") so a partial reads as a converging estimate.
7. **Streaming sketches for NON-additive stats (M).** Color-scale percentiles (p1/p99) → **KLL / t-digest**
   (mergeable); distinct labels → **HyperLogLog**; heavy hitters → **Count-Min**. Merge per chunk →
   O(sketch), never a second pass over 10M.
8. **Backpressure (M).** Pull-gate `reader.read()` on a worker `ready` flag (Atomics on a control SAB);
   under burst the worker **coalesces** (keeps `+=`, skips an emit) instead of queueing frames. Raw
   browser WebSocket has NO backpressure — use WebSocketStream / WebTransport (per-column streams, no
   cross-column head-of-line) / pull-gated chunked fetch.
9. **deck.gl async-iterable `data` (S) — overlays only.** Right mechanism for a small vector overlay
   (selection, centroids, <100k exact-zoom points); NOT for the raster (a 10M-vertex layer is the cost
   we engineered away).
10. **Retain-raw vs base-grid/data-cube (M/L) — the zoom-during-stream decision.** See below.

## Heterogeneous channels — what streams, what doesn't

- **positions** → stream (16-bit packed), retained in SAB. **labels** → stream, per-category count grids.
  **continuous scalar (one gene)** → stream, `sum`+`cnt`(+`sumSq`). All ADDITIVE.
- **20k×10M matrix** → **NEVER stream/accumulate.** Random-access resource: fetch only the *bound* gene
  column on demand (RAG-style), re-accumulate (additive). Switching gene = one new column stream.
- **images (thumbnails / masks / big spatial tissue)** → **NEVER accumulate.** Lazy resource channel;
  big spatial images = a `TileLayer`/`BitmapLayer` tile pyramid (OME-Zarr/Deep-Zoom) composited *under*
  the raster; thumbnails per-selection.

## The retain-vs-cube decision line

- **≤10M — retain raw** (SAB positions ≈40MB, +labels +1 scalar ≈120MB): exact re-bin at any zoom.
  **This is our current design; keep it.**
- **10M–100M — hybrid:** retain raw for the CURRENT viewport; keep a coarse global **base-grid
  data-cube** (2048²–4096²) that rolls up additively for zoom-out/overview; re-stream raw for deep
  zoom-in / large pan.
- **>100M — base-grid / tile-pyramid only:** push binning server-side (Datashader-style), stream
  pre-binned rasters/tiles (quadtree pyramid), not points. Constant client memory; zoom detail bounded
  by tile resolution.

## Streaming DataSource contract (additive to today's columnar source)

```ts
interface StreamedChannel {
  batches(signal: AbortSignal): AsyncIterable<{ offset: number; length: number; data: ArrayBuffer }>
}
DataSource.streamPositions?(layout): StreamedChannel    // 16-bit packed
DataSource.streamCategorical?(key): StreamedChannel     // label codes
DataSource.streamContinuous?(key): StreamedChannel      // one scalar/gene
// matrix = streamContinuous(gene) on bind; images = separate resource/tile layer (NOT streamed)
```
Invariant: every bound channel emits batch *k* over the SAME `[offset,offset+len)` (alignment + id base).
`<Viz onProgress={{rowsSeen,rowsTotal?,coveragePct}}>`; one epoch bump cancels network reader + in-flight
batch + pending emit (pan/zoom/encoding-change all just bump the epoch).

## Worker / accumulator state (the materialized view)

```
count: Uint32[nbins]                          // always
sum, sumSq, cnt: Float32/Uint32[nbins]        // per bound continuous channel → mean/var
catCount: Uint32[nbins] × topK                // per top-K label
retainedPos: SharedArrayBuffer (grow)         // 16-bit packed, exact re-bin on zoom
qSketch: KLL/t-digest per continuous channel  // p1/p99 color scale, no 2nd pass
```
Per chunk: parse (transferable) → per row `count[bin]++; sum[bin]+=v; sumSq[bin]+=v*v; cnt[bin]++;
catCount[label][bin]++;` update `qSketch`; append positions to SAB. **Pure `+=`, O(chunk).** Throttled
`emitPartial()` shades (relative-normalize + EMA) → transfer RGBA → BitmapLayer. **Additive:**
count/sum/mean/var/min/max/per-category. **Non-additive → sketch:** median/quantile (KLL/t-digest),
distinct (HLL), top-K (Count-Min).

## What we should NOT do

1. Don't recompute any aggregate per chunk — additive stats are `+=`.
2. Don't compute exact median/percentile/distinct by re-scanning — use mergeable sketches.
3. Don't stream chunks spatially-sorted for the progressive raster — randomize (else biased early frames).
4. Don't push 10M rows through deck.gl async-iterable `data` as a scatter layer — raster stays one quad.
5. Don't stream/accumulate the matrix or big images — on-demand column + tile pyramid.
6. Don't structured-clone chunk buffers to the worker — transfer / SAB.
7. Don't use a raw WebSocket for 1M/sec without backpressure — WebSocketStream/WebTransport/pull-gated fetch.
8. Don't re-level the color map absolutely each frame — normalize + EMA.
9. Don't assume retain-raw scales to 100M (~1.2GB) — cross into hybrid base-grid/tile-pyramid.
10. Don't count on Arrow Flight in the browser — use Arrow IPC streaming format.

## Execution plan — phases + item list

16 build items in dependency order. **Dep** = `lib` (viz-package only, buildable now) / `server`
(needs a streaming backend) / `deploy` (host config). Effort S/M/L. Each phase: implement → tsc +
unit → swiftshader/GPU e2e + the fps/first-frame gate → blind-audit → commit (local only). Build
in-tree (NOT `isolation:worktree`). Reuses today's `density/cpuRaster.worker.ts` +
`cpuRasterClient.ts` + `CpuRasterView.tsx` + the additive grid + `BitmapLayer`.

### Phase 2.5 — Progressive (client-only) — MVP, biggest perceived win
| # | item | what | files | effort | dep |
|---|---|---|---|---|---|
| 1 | **`emitPartial()`** | worker shades + posts the accumulator-so-far on a ~50–100ms throttle, not only at completion | `cpuRaster.worker.ts`, `cpuRasterClient.ts` | S | lib |
| 2 | **anti-flicker shade** | normalize by *current* total/max + EMA-blend toward the last frame | `cpuRaster.ts` (shade tail) | S | lib |
| 3 | **chunked feed** | feed the worker positions in slices (even from a whole in-memory array) so the raster fills blurry→sharp for ANY source | `CpuRasterView.tsx`, `cpuRasterClient.ts` | S | lib |
| 4 | **`<Viz onProgress>` + coverage badge** | `{rowsSeen, coveragePct}` surfaced to the app | `react/Viz.tsx`, `CpuRasterView.tsx` | S | lib |
> **Gate:** first meaningful frame at ~1M (~1s) instead of the full-load wait; no server work; default (non-progressive) byte-identical.

### Phase 2.5b — Additive channels (client-only)
| # | item | what | files | effort | dep |
|---|---|---|---|---|---|
| 5 | **accumulator struct** | per-top-K-category count grids + `sum`/`cnt`/`sumSq` per bound continuous channel | `cpuRaster.worker.ts`, new `density/accumulator.ts` | M | lib |
| 6 | **channel-select shade** | density vs mean(`sum/cnt`) vs category-hue from the accumulator (live gene/label coloring during load) | `cpuRaster.ts` | S–M | lib |
> **Gate:** color-by-gene / color-by-label is as progressive as density; additive-only stats.

### Phase 2.6 — Streaming ingestion (needs a streaming source)
| # | item | what | files | effort | dep |
|---|---|---|---|---|---|
| 7 | **`StreamingSource` contract** | `stream(channel, opts) → AsyncIterable<{offset,length,data}>`, aligned by global offset. SHIPPED as `viz-core/data/streamingSource.ts`, consumed through `asDataSource` (`streamingAdapter.ts`) with an optional trailing `DataReadOptions` on the `data/wire.ts` bulk-byte methods | `data/streamingSource.ts`, `data/streamingAdapter.ts`, `data/wire.ts` | M | lib |
| 8 | **per-column shuffle+gzip zarr reader** | chunked byte range → `DecompressionStream('gzip')` → un-shuffle transpose → transferable typed-array view. SHIPPED **app-side** as `WorkbenchStreamingSource` (`ui/src/modules/workbench/extensions/data/workbenchStreamingSource.ts`) over the existing `ZarrArray`/`zarrReader`; the library gains no reader and no format dependency | `workbenchStreamingSource.ts` (app), `core/workstore/zarrReader.ts` | M | app |
| 9 | **transferable / SAB handoff** | transfer arriving column buffers; retained positions in a growing SharedArrayBuffer | `cpuRasterClient.ts`, `cpuRaster.worker.ts` | S–M | lib + **deploy** (COOP/COEP) |
| 10 | **backpressure** | pull-gate `reader.read()` on a worker `ready` flag (Atomics on control SAB); coalesce emits under burst | `cpuRasterClient.ts` | M | lib |
| 11 | **epoch cancellation (extend)** | one epoch bump cancels reader + in-flight batch + pending emit | `cpuRasterClient.ts` (existing epoch) | S | lib |
> **Gate (RESTATED — no Arrow dependency; items 7/8 shipped 2026-08-16):** a positions read arrives in
> chunks and the pane paints each stage, over the wire format the producer ALREADY writes. It used to
> make this phase wait on a backend that could serve Arrow columns — stricter than the format needs,
> and it left the phase looking blocked on something nobody is going to build. (The superseded
> sentence is deliberately NOT quoted: TEST-18 asserts its ABSENCE from this document, and a
> quotation inside the note explaining its removal is indistinguishable from the live gate to any
> guard that reads text.)
>
> **Why there is no backend Arrow dependency.** DEC-4 chose **byte-shuffle + gzip, not blosc and not
> Arrow IPC**, precisely so the browser decodes natively: it measures at **97.4% of blosc's ratio**
> while staying readable with `DecompressionStream('gzip')` plus a ~10-line transpose
> (`src-app/packages/_lib/cyto_zarr.py:26-32`). The producer contract is explicit that *"There is no
> Parquet, no TileDB, no SOMA and no Arrow IPC on the wire … zero dependencies on either side"*
> (`cyto_zarr.py:5-8`). An Arrow endpoint would add a SECOND wire format the design refuses, and a
> WASM codec on the client. **Nobody should wait on that phantom blocker again.** Item 9's COOP/COEP
> dependency is unaffected and stands.

### Phase 2.7 — Non-additive stats + honest early frames
| # | item | what | files | effort | dep |
|---|---|---|---|---|---|
| 12 | **streaming sketches** | KLL/t-digest per continuous channel → color-scale p1/p99; HLL → distinct labels (merge per chunk) | new `data/sketches.ts`, worker | M | lib |
| 13 | **randomized chunk order** | server streams chunks interleaved/random so partial frames are unbiased (never spatial-sorted) | source impl | M | **server** |
> **Gate:** correct/stable color scales + legends DURING the stream; early frames unbiased (+ optional √n coverage indicator).

### Phase 2.8 — Heterogeneous channels + >10M scale
| # | item | what | files | effort | dep |
|---|---|---|---|---|---|
| 14 | **high-dim matrix = bind-a-column** | fetch ONE gene column on demand (RAG-style), re-accumulate — NEVER stream the matrix | `data/wire.ts`, encoding bind | S | lib |
| 15 | **images = lazy resource + tile pyramid** | `TileLayer` for big spatial images composited UNDER the raster; thumbnails per-selection — NEVER accumulated | new `spatial/ImageTileLayer.tsx` | M–L | lib (+ server tiles) |
| 16 | **retain-vs-cube** | hybrid (retain viewport + coarse base-grid roll-up) for 10M–100M; server tile pyramid for >100M | worker accumulator, `scale/*` | M/L | lib (+ **server** >100M) |
> **Gate:** 100M via base-grid/tiles at bounded client memory; matrix + images never enter the accumulator budget.

### Cross-cutting infra (not the viz lib)
- **COOP/COEP headers** on the app server → unlocks SharedArrayBuffer (item 9).
- **Randomized/interleaved chunk ordering** (item 13) — the only remaining SERVER dependency on this
  arc. There is **no** "backend Arrow-IPC streaming endpoints" dependency: items 7/8 ship over the
  existing sharded-zarr byte-range route (DEC-4's shuffle+gzip), not over a second wire format.

### Recommended sequencing
Ship **2.5 (1–4)** first — client-only, reuses the worker/accumulator, turns 8.7s-to-first-frame into
~1s blurry→sharp. Then **2.5b (5–6)** + **14** (all lib-only). **2.6 items 7/8 needed no backend work at
all and shipped 2026-08-16** over the existing shuffle+gzip zarr route; items 9/10 still wait on
COOP/COEP (item 9), not on a column format. **2.7/2.8** are the correctness + >10M/spatial-image tier.

## Key references
IVM/materialized-view: ViewDF (cs.uwaterloo.ca/~tozsu/publications/stream), StreamingCube (dl.acm.org/doi/10.1145/3132847.3133165) ·
Online aggregation: Hellerstein (comp.nus.edu.sg/~tankl/cs5208/readings/online.pdf), STULL (arxiv 2008.13028), Progressive Data Analysis (aviz.fr/Progressive) ·
Arrow streaming: arrow.apache.org/docs/python/ipc.html, duckdb.org/2025/05/23/arrow-ipc-support-in-duckdb ·
Sketches: KLL (arxiv 2102.09299), DataSketches ·
Transport/backpressure: MDN Transferable objects + SharedArrayBuffer, blog.haroldadmin.com/posts/backpressure-with-websockets-and-web-streams, WebTransport (developer.chrome.com/docs/capabilities/web-apis/webtransport) ·
deck.gl: loading-data + performance guides · Datashader: datashader.org/getting_started/Introduction.html
</content>
