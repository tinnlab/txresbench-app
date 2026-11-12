# Research — Tissue-Image Annotation & Segmentation (grounding for `annotation-surface`)

The evidence base the design and plan are DERIVED from. This is **required reading**
for anyone implementing or auditing `viz-core/annotate/**` or the image/mask spatial
surfaces — the one-line invariants only summarize it; the findings and their sources
carry the WHY and the gotchas. Synthesized from six parallel research streams
(JTBD ×5 communities, web-tool prior-art, segmentation-model ecosystem + licensing,
image formats + web-GPU rendering, and a grounding pass over `@txresbench/viz`).

Companion long-form: the published research artifact (frontend re-scope). This doc
is the durable, citable version.

---

## 1. What users want (JTBD, 5 communities)

Everywhere the unit of work is the same — **turn a huge image into objects (cells,
regions, domains) and labels (types, scores, masks)**. Two shifts dominate:

- **F-JTBD-1 · Draw → prompt → correct → adjudicate.** Model-in-the-loop
  segmentation (SAM/SAM2, Cellpose, Baysor) has moved the human off the pixels; the
  work is now prompting, reviewing and *fixing*.
- **F-JTBD-2 · Batch for cells, interactive for regions.** Cell/nucleus
  segmentation is a batch step you QC; region annotation, niche painting, ROI
  selection and gating stay interactive — where tooling is weakest.

Per community:
- **Pathology** — outline tumor/stroma/necrosis/TILs; grade; biomarker scores;
  build GT. Regions interactive; nuclei batch→QC.
- **Spatial biology** — segment cells; assign transcripts; paint tissue
  domains/niches; lasso ROIs for pseudobulk. Segmentation batch→QC; niches interactive.
- **Multiplex** — segment 20–100 markers; phenotype (cluster-then-label OR gate);
  click-cell→marker profile. Segmentation batch→QC; gating interactive.
- **Microscopy** — segment nuclei/cells/organelles; count; measure; auto→brush-correct.
- **ML-labeling** — click/box→mask (SAM) default; pre-label→correct; consensus.

**F-JTBD-3 · Top pain points (ranked):** (1) gigapixel scale — never load the
whole slide; (2) dense-tissue correction is slow — the #1 time sink; (3) mask
cost (~6× a bbox); (4) desktop/no-web lock-in; (5) weak image↔data linking
("gate a scatter → see cells on tissue → refine"); (6) annotation lock-in (users
want GeoJSON round-trip to QuPath/scverse).

Sources: [SAM-for-pathology weak on dense nuclei (arXiv 2304.04155)](https://arxiv.org/abs/2304.04155) ·
[ESDIP annotation-variability survey](https://www.laboratoryinvestigation.org/article/S0023-6837(24)01881-6/fulltext) ·
[OME-NGFF (Nat. Methods 2021)](https://www.nature.com/articles/s41592-021-01326-w).

## 2. Prior-art & the whitespace

- **F-GAP-1 · The whitespace:** NO open, zero-install WEB tool unifies gigapixel-WSI
  viewing + promptable (bio-tuned) AI segmentation + the single-cell loop. QuPath
  does all three — DESKTOP. Vitessce VIEWS but can't author/segment. Cytomine/DSA
  annotate on the web but predate promptable AI. CVAT/Roboflow have SAM but aren't
  bio/gigapixel. The lane is **web-first + agentic**.
- **F-GAP-2 · Web-rendering approach:** the winning path is client-side WebGL/deck.gl
  multiscale (Viv/Avivator/vizarr/Vitessce) — GPU multichannel blend, lazy tiles,
  no server tiler required. We already run deck.gl → adoption is composition.
- **F-GAP-3 · Annotation storage seen in the wild:** GeoJSON is the interoperability
  lingua franca (QuPath import/export); a single giant GeoJSON blob hits a memory
  wall at millions of features, so at scale it's GeoParquet + viewport-tiled serving,
  with a label-mask raster fallback at low zoom.

Sources: [QuPath GeoJSON export](https://qupath.readthedocs.io/en/stable/docs/advanced/exporting_annotations.html) ·
[Viv (deck.gl OME renderer)](https://github.com/hms-dbmi/viv) ·
[Vitessce (Nat. Methods 2024)](https://www.nature.com/articles/s41592-024-02436-x) ·
[Cytomine](https://cytomine.com/).

## 3. Segmentation models — EXTERNAL processors (context for the API seam, NOT built here)

> The editor builds and runs NONE of this. This section defines the SHAPE of what
> plugs into the editor's processor-API seam (§ INV-3) — so the seam is designed to
> receive their outputs (a mask, a set of polygons, a prompt→result) and to expose
> what they need to read (view state, a selection gesture). The AI is a separate
> processor concern; the facts below tell the editor's API what to accommodate.


- **F-SEG-1 · The encode-once / decode-per-click split (the interactive pattern to
  own):** SAM splits into a HEAVY image encoder (ViT, run once per image → a cached
  embedding) and a TINY prompt+mask decoder (~4M params, ~50ms/click on CPU,
  ONNX-exportable, WebGPU ~3.8× faster). The proven web deployment: encoder
  server-side (once), decoder in-browser per click via `onnxruntime-web`.
- **F-SEG-2 · SAM is weakest on dense touching cells / thin structures** — precisely
  the biomedical value zone — so lead with the CORRECTION UX (split/merge/brush),
  not raw auto-mask.
- **F-SEG-3 · Licensing (for the browser-side model we bundle):** prefer
  **SAM/SAM2 (Apache-2.0)** or a distilled MobileSAM/SlimSAM for full-client mode.
  Batch segmenters a backend would run — Cellpose (BSD), StarDist (BSD),
  InstanSeg (Apache) — are permissive but out of the frontend. **AVOID baking**
  Mesmer/DeepCell (non-commercial + token gate) or pathology foundation models
  (UNI/CONCH/Virchow/Prov-GigaPath — gated, research-only, and EMBEDDERS not
  segmenters) into a client bundle.

Sources: [SAM (50ms in-browser decoder)](https://ar5iv.labs.arxiv.org/html/2304.02643) ·
[SAM 2](https://github.com/facebookresearch/sam2) ·
[ONNX Runtime Web / WebGPU](https://opensource.microsoft.com/blog/2024/02/29/onnx-runtime-web-unleashes-generative-ai-in-the-browser-using-webgpu/) ·
[webgpu-sam2](https://github.com/lucasgelfond/webgpu-sam2) ·
[micro-sam (Nat. Methods 2024)](https://www.nature.com/articles/s41592-024-02580-4) ·
[DeepCell API-key gate](https://deepcell.readthedocs.io/en/master/API-key.html).

## 4. Formats, coordinates & web-GPU rendering

- **F-FMT-1 · The frontend is storage-agnostic via `PixelSource`.** Viv renders
  through a `PixelSource` ("give me the tile at `{level,x,y,channel}`"). The store
  behind it — Zarr file, TileDB-SOMA tile endpoint, or a fixture — is invisible to
  the UI. Zarr-vs-TileDB is a BACKEND decision; since we already run TileDB-SOMA,
  the natural path is a thin custom `PixelSource` against a tile endpoint.
- **F-FMT-2 · Coordinate convention (non-negotiable):** store annotations in
  FULL-RESOLUTION / physical (micron) coordinates, NEVER a pyramid level's pixels,
  then transform per level at render. OME-NGFF encodes the level→physical map; the
  transform layer (NGFF RFC-5) is the least-settled part of the stack → isolate it
  behind one abstraction.
- **F-FMT-3 · Viv reuse quantified:** adopting Viv (already a dep) collapses the
  hardest part — the gigapixel multichannel renderer, tile loading, LOD, GPU
  compositing — into a dependency composed into our existing deck. Overlays render
  as deck.gl `PolygonLayer`/`PathLayer`/`ScatterplotLayer` in the SAME world space.

Sources: [Viv README (PixelSource, 4096² single-texture cap)](https://github.com/hms-dbmi/viv/blob/main/README.md) ·
[OME-NGFF labels spec](https://ngff.openmicroscopy.org/0.5/) ·
[SpatialData (annotation model)](https://spatialdata.scverse.org/) ·
[NGFF RFC-5 (transforms, in review)](https://ngff.openmicroscopy.org/rfc/5/).

## 5. Codebase inventory — what `@txresbench/viz` already has (the reuse basis)

- **F-CODE-1 · Gigapixel multichannel viewer** — `spatial/RasterImageView.tsx`
  (Viv `MultiscaleImageLayer` + XRLayer channel model, driven by a `PixelSource[]`
  loader), `imageTiles.ts` (tile cull), `imageMeta.ts` (OME-NGFF parse).
- **F-CODE-2 · GPU label-mask renderer + picking** — `spatial/LabelMaskLayer.ts`:
  pixel value = label id, id→color LUT, in-shader boundary stroke; hover resolves
  the exact cell id. The segmentation-RESULT renderer already exists.
- **F-CODE-3 · Region→cell + identity-space selection** — `spatial/regionSelect.ts`
  (ROI → cells via KD-tree + point-in-polygon), `adapter/Coordination.store.ts`
  (Vitessce-style scopes; selection = canonical ids sharded by identity space).
- **F-CODE-4 · Affine cell↔image** — `data/image.ts` (`Affine`, `scaleAffine` for
  Visium hires-scalef, `composeAffine`, `imageBounds`); Xenium/MERFISH micron↔pixel.
- **F-CODE-5 · `ImageAdapter` is a STUB** returning `<Unsupported>` in
  `charts/installBuiltins.tsx` — the P0 wire target.
- **F-CODE-6 · Fixture harness** — `spatial/{imageFixture,labelMaskFixture}.ts` +
  a story-driven `PixelSource` → the whole surface builds with NO backend.
- **F-CODE-7 · Gap: no annotation AUTHORING layer** — nothing draws/edits/persists
  annotations today; only display exists. This is the net-new work.

## 6. Findings → design mapping (the grounding bridge)

Every invariant and the load-bearing items trace to a finding above. The Phase-6
`design-conformance` audit checks the shipped behavior against BOTH the invariants
AND these findings — an item that satisfies its invariant but contradicts the
finding it came from is a conformance defect.

| Design element | Grounded in |
|---|---|
| INV-1 (storage-agnostic `PixelSource`) | F-FMT-1, F-CODE-1 |
| INV-2 (three seams, fixtures-first) | F-GAP-1, F-CODE-6, F-FMT-1 |
| INV-3 (editor runs NO model; AI is an external processor via the API seam) | F-SEG-1, F-SEG-3 |
| INV-4 (full-res/physical coords) | F-FMT-2 |
| INV-5 (reuse label-mask + coordination) | F-CODE-2, F-CODE-3, F-GAP-2 |
| INV-6 (correction is first-class) | **F-SEG-2**, F-JTBD-1, F-JTBD-3(#2) |
| INV-7 (GeoJSON round-trip) | F-GAP-3, F-JTBD-3(#6) |
| ITEM-8/9/10 processor API seam (inject result / read gesture; editor runs nothing) | F-SEG-1, F-SEG-3 |
| ITEM-11/12 mask review/correct (editor operations) | F-SEG-2, F-JTBD-2 |
| ITEM-13 image↔data linking | F-JTBD-3(#5), F-CODE-3 |
| ITEM-14 coordinate abstraction (isolated) | F-FMT-2 |
| Scale rule (no fetch-all vertices; mask fallback) | F-GAP-3, F-FMT-3 |
| No AI/model bundled in the editor (no ONNX dep) | F-SEG-1, F-SEG-3, INV-3 |
