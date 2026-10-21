# Processor Port — the annotation editor's external-processor seam (ITEM-10)

`viz-core/annotate/processorPort.ts` is the **stable, public, types-only** contract
between the annotation editor and an external **processor** (a segmentation/AI model, a
WASM kernel, a remote service…). The editor exposes a `ProcessorPort`; a processor
depends on nothing of the editor beyond these types. Treat the barrel as the contract —
it is a semver-stable surface, like the workbench `apiVersion`.

## The editor runs NO model (INV-3)

The editor performs **no inference and bundles no AI/segmentation model**. It only
**captures gestures + view state** and **displays/commits** the geometry & masks a
processor produces. `setPending` is **display-only** ("working…") — it never triggers
inference. A processor is always external; a future one can live in a Web Worker or
another process without changing these types.

## What a processor can READ (fresh snapshot each call)

- `getImageRef(): ImageRef` — a serializable reference (`sourceId`, full-res
  `width`/`height`, `levelCount`, `channelCount`, optional `pixelSize`). **Never a live
  loader** — the processor resolves its own pixels from `sourceId` (INV-2).
- `getViewState(): ProcessorViewState` — camera snapshot (`center`, `zoom`, visible
  `bounds`) so work can be scoped to the visible region.
- `getActiveGesture(): Gesture | null` — the latest user prompt: `click` | `box` |
  `lasso` (the lasso ring is byte-equal to `selectRegion`'s input). Reading it does not
  consume, clear, or infer.

## What a processor can WRITE

- `commitPolygons(features, opts?)` / `commitPoints(features, opts?)` — commit vector
  `GeoFeature[]` as stored annotations, **indistinguishable from hand-drawn**
  (undo / reshape / export / link all apply). Re-running with the same `origin`/`groupId`
  **replaces that group** (napari's re-run contract). Returns the assigned annotation ids.
- `commitLabelMask(result, opts?)` — commit a dense id raster the editor renders via
  `LabelMaskLayer` and can correct in place. `result.bounds` may place it within the image
  (a dirty-rect commit).
- `setPending(state | null)` — set/clear the display-only progress hint (INV-3).

## Coordinates are full-res (INV-4)

Every coordinate crossing the seam is in **full-resolution image pixels**
(level-independent) unless a `CommitOpts.space` overrides it. The processor reads full-res
coords and writes full-res coords; the editor's `coords.ts` facade owns all
level ↔ physical ↔ world math. An overlay therefore registers on the same image feature at
every zoom.

## Stateless per call

Every method is **stateless-per-call**: reads return a fresh copy (mutating it never
touches the editor); writes are self-contained (no handshake/session to hold). The last
`setPending` value is what shows.

## Structured-clone-safe (why the seam is future-proof)

Every type is composed of **typed arrays + plain objects — no class instances, no
Map/Set/Date**. So `structuredClone(x)` succeeds on every input and result, and a
`postMessage` to a Worker/other process serializes the same values with **zero shape
change**. A cross-process processor is a pure addition, not a rewrite. `processorPort.test.ts`
(TEST-9) proves both halves: the mock type-checks against `ProcessorPort` with no `as any`,
and `structuredClone` of each result type (`LabelMaskResult` with a `Uint32Array`, a
`GeoFeature[]`, a `CommitResult`) round-trips.
