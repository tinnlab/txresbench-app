# Streaming the visualization's data reads

**Status: design, derived from a verified codebase audit (2026-08-15).** It is the app-side
companion to `src-app/libs/viz/STREAMING_PROGRESSIVE_PLAN.md` (the library's own plan, phase
2.6 items 7-11 + 14) and to `src-app/libs/viz/src/viz-core/data/streamingSource.ts`'s DEC-2/8/9/10.
This doc adds only what that plan does not carry: the **app-side** constraints (auth, wire
buffering, chunk granularity, per-coordinate sharing) that any streaming implementation here
must respect.

**It deliberately does NOT settle the open architectural choices.** Those are listed in §7 and
belong to the owner. A design doc that quietly picks them would be laundering a decision through
the plan.

---

## 1. What is materialized today, and where

The visualization pane does **not** read its data through one path. It reads through two, and only
one of them is typed.

**Arc A — positions (typed, artifact-keyed, already deduped).**

`canvasHostProvider.publish` resolves each canvas base's declared `coords: { artifact }`
(`canvasHostProvider.ts:70-72`), fires `buildCanvasDataSource(api, projectId).positions(artifact)`
(`:82`), and caches the resolved `{positions: Float32Array, length}` in a module-level map keyed
`<projectId>|<catalogEpoch>|<artifactId>` (`:45`), with an in-flight set so N views naming one
artifact issue ONE read (`:47`). The resolved map is handed into the feed as `positionsByArtifact`
(`:160`), and `CanvasObsSource` receives the finished array as `injectedPositions`
(`canvasBinding.ts:189`, `:514`).

Underneath, `WorkbenchDataSource.positions()` (`workbenchDataSource.ts:921-925`) already calls
`deps.readPositions(layoutId, structure, deps.onChunk)` → `artifactReader.readPositions`
(`artifactReader.ts:1041`), which fills a pre-allocated buffer chunk by chunk off
`ZarrArray.chunks()` (`zarrReader.ts:651`) and invokes `onChunk` per inner chunk.
**`deps.onChunk` has no production consumer** — `canvasDataSource.buildCanvasDataSource`
(`canvasDataSource.ts:16-49`) passes none, so the hook is wired end-to-end and unused. The only
consumer is the dev-only e2e seam `__cyto_read.positionsProgressive`
(`core/workstore/index.ts:195-213`).

**Arc B — colour / value columns (boxed, via the declarative data runtime).**

The emit sections' plotted columns do **not** come through `WorkbenchDataSource` at all. They come
through the declarative `$data` runtime: `column_values` (`runtime/columnValues.ts:40`) →
`readColumnValues` (`:132`) → `ReadArtifactFrame`, whose result type is
`ColumnarFrame = Record<string, unknown[]>` (`runtime/axisSource.ts:934`) and whose entry arm
returns `Promise<readonly number[]>` (`columnValues.ts:37`). Those **boxed JS arrays** become the
canvas base's `obs` columns (`canvasBinding.ts:504`, `:514`).

So the pane's colour data is materialized twice over — once out of typed zarr chunks into a
`Float32Array`, and again out of that into a boxed `unknown[]` — before viz sees a byte.

## 2. The library's two ingresses (only one is progressive)

`@ziee/viz` accepts data two ways, and they are **parallel, not layered**:

- `<Viz source>` — a `StreamingSource` or a legacy pull `DataSource` (`react/Viz.tsx:180`,
  discriminated at `:71-77`). A streaming source is registered on the `DatasetStore`
  (`DatasetStore.ts:198-217`) **and** simultaneously wrapped `asDataSource(source)` for the grid
  (`Viz.tsx:377`).
- `<Viz data>` — the `VizData` union (`adapter/vizData.ts:56`), which accepts a bare
  `AsyncIterable<Uint8Array>` for positions (`PositionsInput`, `vizData.ts:35-41`). **When `data`
  is present `Viz` renders `CpuRasterView` and never renders the grid at all**
  (`Viz.tsx:753-778`).

`asDataSource` collects and decodes each channel whole (`streamingAdapter.ts:36-108`; every
decoder in `data/streamDecode.ts` is `collectStream`-then-decode). **Exactly one consumer in the
library iterates a stream chunk by chunk**: `progressiveDomain.streamColumnDomain`
(`progressiveDomain.ts:47-69`), called from `useGridColoring.ts:251` for a `continuous` colour-by
on a cell whose dataset has a raw `StreamingSource`. It feeds a `KllSketch` and repaints per chunk
with a converging p1/p99 domain.

The progressive raster (worker accumulator, EMA anti-flicker, base-grid roll-up, `onProgress`,
epoch cancellation — all shipped and well tested) hangs off the **`data`** ingress, not off
`source`. `CpuRasterView` already accepts `data` with `positions` **optional**
(`CpuRasterView.tsx:184-196`); the grid's raster call site passes whole `positions`
(`spatial/CategoricalPointsView.tsx:668-678`).

**Consequence.** An app-supplied `StreamingSource`, on its own, buys progressive rendering for the
`continuous` colour channel and for nothing else. Positions are collected whole by
`DatasetStore.ensureBuffers` (`DatasetStore.ts:317`) before the first paint. This is the single
most important fact for scoping this work, and it contradicts the natural reading of
`VisualizationPage.tsx:9-11` ("a streaming source drops in behind the same seam later").

## 3. Constraint — auth must ride the generated client

The byte-range route is `RequirePermissions<(ProjectsUse,)>` (`data_api.rs:1061`, `:1077`) plus
per-artifact scope resolution (`load_readable_artifact` → `require_artifact_read`,
`authz.rs:138-148`, dispatching to `require_project_read` / `require_dataset_read`,
`authz.rs:80-109`).

viz's `streamBinaryColumn` (`fetchStream.ts:144-193`) calls `doFetch(url, { signal })` with
`doFetch = fetchImpl ?? fetch` (`:149`, `:153`) — **no headers, no credentials, no auth hook**. It
is publicly exported (`src/index.ts:271`, `src/core.ts:139`).

**Rule.** The **app** owns the `StreamingSource`. Every byte read goes through
`core/workstore/binaryClient.ts`, which delegates to `ApiClient.Workstore.getArtifactData(Member)`
(`binaryClient.ts:95-107`) — the generic transport behind `ApiClient` carries the bearer, the base
URL, the silent 401-refresh and the retry-once. viz contributes `reframeBytes` and the raster
worker. **`streamBinaryColumn` must never be pointed at this endpoint**; its only legitimate use
is a fixture with an injected `fetchImpl`.

## 4. Constraint — there is no response-body streaming today

The generated client buffers the whole octet-stream body: `toBytes` does
`new Uint8Array(await blob.arrayBuffer())` (`api-client/index.ts:103-115`), applied to both byte
routes (`:124-133`). The **server** does stream (`data_api.rs:924` `Body::from_stream`); the
buffering is purely client-side. The whole-shard read path additionally fetches the entire shard
before decoding chunk 0 (`zarrReader.ts:782-785`, `:912-915`).

**Therefore "progressive" here means progressive DECODE, not progressive WIRE.** Whether to add a
`ReadableStream` variant to the `api-client` splice point (app/core work — not backend, not
generated code) is an open choice (§7 Q4).

## 5. Constraint — the streaming unit is ONE INNER CHUNK

`byte_shuffle` transposes the WHOLE chunk (`cyto_zarr.py:167-179`) and each inner chunk is its own
gzip member (`:201-203`, emitted per chunk at `:403-417`). Nothing is readable until a whole chunk
decompresses. Inner chunk = **8192 rows for embeddings** (`cyto_columns.py:75`, applied `:358`),
**4096** for other numeric columns (`cyto_zarr.py:90`), 65536 bytes for string payloads (`:131`).

**So there is no incremental paint below ~8k cells.** A 3460-row UMAP is exactly one chunk and
will render in one step no matter what this feature does. The win begins in the tens of thousands
of rows and is large in the millions. Any test asserting progressiveness must use a
verified-multi-chunk fixture (`seedPlottableProject` already returns `embedding_chunks`, and
`progressive-render.spec.ts:56-59` already refuses to run vacuously).

Reader facts that constrain a chunk iterator: an embedding chunk must span all dims
(`zarrReader.ts:618-631`); `ZarrArray.chunks()` trims the fill padding to the real length
(`:692`) — consume **its** slices, never raw chunk bytes; an EMPTY shard index slot
(`0xffff…ffff`, `:227`) must synthesize `fill_value` (`:806`, `:868-876`) and never be fetched; a
whole-shard read parses the index out of the same bytes, costing zero index requests
(`:782-785`, `:912-915`). `?range=` supports `a-b`, `a-` and a clamping suffix `-n`
(`range.rs:75-140`), answers **200**, and is cached `immutable` (`data_api.rs:920`, `:1057`).

## 6. Invariant — one decode per coordinate, whatever the pane count

**This is settled and must not be regressed.** `450efed6` ("row 34 — panes on one coordinate share
one dataset base", an ancestor of `origin/main`) established that panes drawn in one coordinate
artifact fold onto ONE dataset base, keyed by the **artifact**:
`sharedCoordinateBase(artifact) => "@coords:" + artifact` (`canvasFeed.ts:271-272`), with the fold
at `:457-470`, dedup at `:582-589`, series re-pointing at `:566-571`, a union column frame at
`:497-506`, and disjoint dense canonical id ranges per artifact at `:292-332`. Pinned by
`canvasFeed.test.ts:940-983` and by the e2e `link-space.spec.ts:132-139`.

Two prose sources say the opposite and are **stale**:
`packages/single-cell-viz/ui/coordinates.yaml:203-209` and `colour-by.yaml:219-223` ("One dataset
base … per emitted cell … two cells sharing one base would brush each other") were written
2026-08-13, one day before the fold landed. They describe the DECLARATION layer, which does still
mint one id per emitted cell — those ids are what `canvasFeed` folds. The same stale rationale is
repeated at `runtime/columnValues.ts:20-21`. (`canvasBinding.ts:888` — "a `coordId` several series
share is ONE pane" — is about GRID PLACEMENT, a third and unrelated level; it is correct.)

Two honest limits on "shared by every pane": panes in **different contributing sections** get two
`DatasetStore` entries (composition namespaces dataset ids per view,
`canvasFeed.test.ts:1036-1047`) — they share the canonical id space but not the buffer, though the
app-side `declaredPositions` cache still means ONE decode. And a base that declares no `coords`
artifact is deliberately still isolated (`canvasFeed.ts:474-478`).

## 7. Choices — settled and open

**SETTLED by the owner, 2026-08-15.**

1. **The raster gets a real progressive paint.** This feature MAY modify `libs/viz` core, in an
   enumerated set of four source files (three under Q1: `CategoricalPointsView.tsx`,
   `DatasetStore.ts`, `useGridColoring.ts`; one under Q7: `fetchStream.ts`). A fifth needs a fresh
   question. The constraint on ledger row 34 (*"should not modify viz core"*) was scoped to that
   row, which its fix honoured; row 34 is closed at `03125467` recording the scoping. The reason the
   lift was granted is §2: an app-side source alone leaves the pane behaving identically.
2. **`streamBinaryColumn` keeps its export but loses the implicit ambient-`fetch` fallback.** The
   mechanism is open — see `.lifecycle/viz-streaming-reads/DECISIONS.md` DEC-15, since the
   post-ruling caller sweep found a production caller (`adapter/vizData.ts:169`, `:230`) the ruling
   did not have in front of it.

**STILL OPEN — not this doc's to settle.**

3. Does the boxed declarative `column_values` arc (§1 Arc B) get typed and streamed, or is it a
   named follow-up this round?
4. Do `STREAMING_PROGRESSIVE_PLAN.md` items 7/8 (Arrow IPC) get formally replaced by the existing
   shuffle+gzip zarr reader, or kept as a future second wire format?
5. Does this feature add a `ReadableStream` variant to the api-client byte splice (§4), or defer?
6. Does the canvas surface a coverage indicator from the already-emitted `onProgress`?
7. Are the streaming tunables a fixed `StreamingLimits` struct or an admin-configurable row?

## 8. Two known defects this work sits on top of

- **The colour column is read 2-3× per colour change.** For a `continuous` cell,
  `useGridColoring.ts:251` streams it via `streamColumnDomain`, and the legend effect independently
  calls `computeColoring(src, cb)` (`:392`) **and** `src.continuous(cb.key)` (`:401`) — two more
  full `collectStream` reads. `asDataSource` memoizes only the catalog
  (`streamingAdapter.ts:37-41`), so the comment at `useGridColoring.ts:405-408` ("the source caches
  this fetch … it's ~free") is false for the streaming path.
- **`streamColumnDomain` is called with no `AbortSignal`** (`useGridColoring.ts:251`), so a rapid
  colour-by switch leaves N concurrent full column reads running; cancellation is an `alive`
  boolean that only discards results. `asDataSource` never forwards a signal either
  (`streamingAdapter.ts:49-108`).
