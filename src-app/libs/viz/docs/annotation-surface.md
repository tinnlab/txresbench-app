# Design — Tissue-Image View + Annotation Editor (`@ziee/viz`)

Status: design source for the `annotation-surface` feature lifecycle.
Scope: **a frontend EDITOR — the functions + API for image-view manipulation and
annotation authoring/editing** inside `@ziee/viz`. Like an image/annotation editor
(think the canvas + selection tools + layers API), NOT the AI that produces masks.

**The editor runs no model and bundles no AI.** Segmentation / promptable models
(SAM, Cellpose, …) are **external AI processors**; they are a SEPARATE concern that
*consumes* this editor's API — handing it a produced mask/geometry to display + edit,
and reading the editor's view state + selection gesture. Inference, embeddings,
model hosting and ONNX are explicitly out of scope (§7).

Storage engine, tile serving and persistence are likewise backend concerns. The
editor is a self-contained view+annotation library with a documented API.

Derived from the capability research; the evidence base with findings + sources is
`annotation-surface-research.md` in this directory (REQUIRED READING). Every
invariant below traces to a numbered finding there (its §6 findings→design map),
and the Phase-6 design-conformance audit checks shipped behavior against BOTH the
invariants here AND those findings.

---

## 1. What this is

For tissue images the **viewer** is largely solved in our stack (Viv multiscale
renderer, GPU label-mask layer, affine cell↔image alignment, lasso→region→cell
selection all exist in `@ziee/viz`). What's missing is the **editor**: the functions
and API to manipulate the view (pan/zoom, channels, contrast, LOD) and to author and
edit **annotations** — draw/reshape/brush geometry, label it, review and correct a
mask, import/export — plus a clean **API seam** through which an external AI processor
can inject a produced result and read the current gesture/view.

The field context (why an editor and not a viewer): the human role is
**draw → prompt → correct → adjudicate**, and the AI is weakest exactly on dense
touching cells — so the human's *editing and correction* is the real work, and the
editor is the tool that must make it fast. The editor owns the editing; the AI owns
the producing.

## 2. Boundaries (the two seams the editor renders against)

The editor is a library; its external boundaries are exactly two, and everything
behind them is invisible to it:

1. **`PixelSource`** — Viv's tile loader (`{level, x, y, channel} → tile`).
   `RasterImageView` already consumes a `PixelSource[]`. The bytes may come from a
   Zarr file, a TileDB-SOMA tile endpoint, or a fixture — the editor does not know.
2. **Annotation model API** — geometry (polygons/points) and label-masks flow in and
   out through a documented API: GeoJSON import/export, and programmatic
   inject/read/edit. This is also the seam an **external AI processor** uses — it
   commits a produced mask/geometry through this API and reads the editor's current
   view state + selection gesture. The editor neither knows nor runs whatever
   produced the result.

## 3. Surfaces / capabilities (Phases 0–4)

- **P0 · Render + view API** — an `image` grid cell renders a multichannel pyramid
  from its `PixelSource`; camera (pan/zoom/fit) and channel/contrast/colormap are
  exposed as view-manipulation functions.
- **P1 · Annotation authoring** — an editable vector overlay: draw / reshape / brush
  polygons and points, per-object class + label, undo/redo, GeoJSON import/export.
- **P2 · Processor API seam** — a documented API to (a) COMMIT an externally-produced
  result — a polygon set, point set, or label-mask — as editable annotations/mask,
  and (b) READ the current view state + active selection/gesture — so any
  segmentation processor plugs in WITHOUT the editor knowing the model. No inference
  in the editor.
- **P3 · Mask review & correction** — on top of the existing GPU label-mask layer:
  hide/solo classes, hover→cell-id, and correction as editing operations (relabel,
  split, merge, brush-fix a cell).
- **P4 · Link** — a lasso/gate on a scatter/embedding highlights those cells on the
  tissue and vice-versa, through the shared identity-space coordination model.

## 4. Jobs-to-be-done (per surface)

A user opens a slide and reads it at any zoom (P0); outlines a tumor region or paints
a niche, labels it, and exports GeoJSON that opens in QuPath (P1); has a processor's
segmentation dropped in and then *reviews and corrects* the residual bad cells rather
than re-drawing (P2+P3); and selects a population on a UMAP to see those cells on the
tissue and refine the gate (P4). Every one of these is an editing/manipulation job —
the producing (AI) happens elsewhere.

## 5. Multi-instance & state

The same editor can exist in more than one grid cell at once (two slides side by side,
or a slide + its mask). Annotation edit state, the active tool, and the undo stack are
**per-image-cell instance** (a per-instance store), never a single shared global —
state must not leak between cells.

## 6. Non-negotiables (invariants)

The design's promises. The plan lifts them VERBATIM as `INV-N`; each is verified for
fidelity (Phase 2) and pinned to an executable acceptance test (Phase 3).

- **INV-1**: The editor renders tissue images through the storage-agnostic `PixelSource` interface and never imports or depends on any backend/server/storage module — it does not choose or know the storage engine.
- **INV-2**: The editor is a self-contained view + annotation library whose only external boundaries are the `PixelSource` (pixels in) and the annotation-model API (geometry/label-masks in/out via GeoJSON + programmatic inject/read/edit); it has zero backend dependency and every capability builds and runs against fixtures.
- **INV-3**: The editor performs NO model inference and bundles NO AI/segmentation model — it captures selection/prompt gestures and displays + edits externally-produced masks and geometry through the documented API seam; all segmentation/AI is an external processor.
- **INV-4**: Annotations are stored in full-resolution / physical image coordinates, independent of pyramid level, so an overlay registers on the same image feature at every zoom.
- **INV-5**: The editor reuses the existing GPU label-mask layer (render + per-pixel label-id pick) and the identity-space selection/coordination model; it does not reimplement mask rendering or cross-view selection.
- **INV-6**: Editing & correction are first-class — the editor provides split / merge / brush-fix / relabel on masks and reshape/edit on vector annotations, not only initial creation.
- **INV-7**: Exported annotations are GeoJSON that round-trips losslessly for geometry and class/label (import → edit → export → re-import preserves them).

## 7. Explicitly out of scope

- **All AI / segmentation** — inference, promptable/SAM decoders, embeddings, ONNX,
  model hosting, batch segmenters. These are external **AI processors** that consume
  the editor's API (§2 seam 2); the editor only displays + edits their results.
- Backend image datatype, pyramidal-tile byte serving, vendor→OME-Zarr conversion,
  the compute backend, and annotation persistence — behind the two seams, wired later.
