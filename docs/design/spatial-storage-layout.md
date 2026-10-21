# Spatial storage layout + import processor

**Status:** RESTORED TO `main` BY [#315](https://github.com/phibya/cytoanalyst/issues/315).
**Issue:** [#315](https://github.com/phibya/cytoanalyst/issues/315) — this file is cited by name,
and by section number, throughout the shipped spatial arm, and it was not in `main`.

> **HOW TO READ THIS DOCUMENT**
>
> **§0–§15 below are a byte-for-byte restoration of the design as approved**, taken from
> `docs/spatial-design-revisions` @ `e55b16ef` ("docs(spatial): apply the 17-platform
> stress-test revisions + owner renames"), the newest of that branch's four revisions and the
> one every `§`-number in the tree resolves against. Nothing in them was edited, reworded or
> renumbered. That is deliberate and it is the whole point of the restoration: shipped code
> **quotes these sections verbatim** and asserts on the quotes —
> `spatial-import-xenium/compute/registration_qc.py` reproduces §7.5 as a block quote,
> `spatial-import-xenium/compute/boundaries.py` reproduces §6.4's invariant sentence, and the
> `_helpers/tests/test_visium_chain_*` suites quote §9's four constraints one by one. Editing
> the prose in place would silently falsify those quotations; renumbering would break every
> citation the restoration exists to repair.
>
> **§0–§15 are therefore a DESIGN SPIKE AS WRITTEN IN ITS MOMENT, not a description of the
> shipped system.** They were written before any of the epic was built, and the tree has since
> built most of it and learned things the spike could not know. Where a section and the tree
> disagree, **the tree wins**, and §16 — added by this restoration — is the list of every
> disagreement that was found, each one checked against the code at `4b63a482` rather than
> against memory. Read §16 alongside any section you are about to rely on.
>
> **§15 wins over §0–§14** where those disagree with each other. That was the owner's ruling
> when §15 was applied and `spatial-types/manifest.yaml:3-6` restates it.
>
> **Citing this document.** §12's five weaknesses are a numbered list, and the tree cites them
> as `§12.1`…`§12.5` — this document's own §2.3 does so ("addressed head-on in §12.1"). So
> `§12.<n>` means the <n>th weakness in §12. §16.1 records the one citation in the tree where
> that reading and the citing sentence disagree.

> **Scope.** How spatial transcriptomics data is **REPRESENTED AS CYTOANALYST ARTIFACTS**, and
> the **import processor** that converts vendor output into them. This is the *foundation*
> layer: a storage layout + an importer. Deconvolution, spatial QC, SVG detection, domain
> detection and cell–cell communication are **downstream analyses** that consume these
> artifacts like every other analysis consumes artifacts; **none of them is designed here.**
>
> **Read first:** `docs/research/data-processing/06-spatial-processing.md` (esp. §11 "the
> analysis-ready spatial object"), `01-file-formats.md` §14/§15/§21/§22 (vendor bundle
> internals), `02-platforms.md`.
>
> **Status.** DESIGN + RESEARCH SPIKE. Read-only: no product code was changed. Every platform
> claim below cites a file path that was read; inferences are labelled **(inferred)**.

---

## 0. TL;DR

**The headline is not what it looks like.** The obvious framing — "spatial needs images and
polygons and point clouds, none of which fit the three implemented structures, therefore we
must extend the structure vocabulary" — is **wrong for two of the three**, and the third has
an escape that does not cost a Rust change.

1. **Points and geometry already fit `table`.** The vendors hand them over in *long format*:
   Xenium's `cell_boundaries.parquet` is **one row per polygon vertex** (`cell_id, vertex_x,
   vertex_y`), and `transcripts.parquet` is **one row per transcript**
   (`01-file-formats.md:640,650`). A vertex table over a `vertex` axis and a transcript table
   over a `transcript` axis are ordinary `structure.kind: "table"` artifacts. **No new
   structure. No core change.**
2. **Images do NOT fit, and `opaque` is the only home — but it is a *usable* home here, unlike
   the h5ad-layers trap.** The reason is a fact about the *consumer*: the tree ships a complete
   **Viv-based raster stack** (`src-app/libs/viz/src/viz-core/spatial/`, 33 files, 6,749 lines)
   built around a `PixelSource` pyramid seam, and `GET /artifacts/{id}/data/{*member}` already
   serves HTTP ranges (200 + `?range=`, 206 + `Range:`). An image is not "bytes no analysis can
   read" — it is bytes a *shipped renderer* is shaped to read. That is exactly what
   `import.h5ad`'s opaque layers were not.
   **Caveat, verified and load-bearing:** only Viv's **layers** are imported
   (`MultiscaleImageLayer`, `ImageLayer`, `getChannelStats` — `spatial/rasterImageLayers.ts:32`,
   `grid/useGridRaster.ts:43`). **Viv's loaders are not**: there is no `loadOmeTiff`,
   `loadOmeZarr` or `ZarrPixelSource` anywhere in the tree, and `imageMeta.parseMultiscales`
   has exactly two callers — a fixture and its own test. **A production `PixelSource` loader is
   net-new work** (§10). The renderer is built; the reader is not.
3. **But the format must be OME-TIFF, not OME-Zarr — and that is forced by the gate.**
   `conformance._bytes_are_not_a_store` **refuses any `opaque` artifact containing a
   `zarr.json`** (`_lib/conformance.py:1705-1712`). An OME-NGFF/Zarr pyramid is a Zarr store,
   so it cannot be declared `opaque`. **OME-TIFF is a single non-Zarr file, Viv reads it via
   geotiff.js range requests, and it passes the anti-bypass check.** This is the single
   sharpest constraint in the design and it decides the image format for us.
4. **Coordinates are an `embedding`-shaped artifact, not a metadata-column pair.**
   `cyto_columns.write_embedding` already writes a dense `(n × 2)` float32 member with
   `aligned_to` + `membership` (`_lib/cyto_columns.py:372-416`), and the shipped
   `sc.viz.coordinates` section binds on the **`plottable-xy` capability alone**
   (`single-cell-viz/manifest.yaml:58`). A tissue map *is* a 2-D layout. Declaring
   `spatial/coordinates` with `plottable-xy` lights up the existing Coordinates section and the
   existing `sc.viz.colour-by` colouring **with zero UI work**.
5. **Siblings, not a container.** The tree's own answer to "several things from one run" is
   *separate artifacts* — established by the velocity spike and by `anndata-import`, which
   emits dozens. Spatial follows it: expression + coords + image + geometry + points are
   **sibling artifacts of one run**, bound by `aligned_to` (obs-axis row identity) and by a
   declared `coordinate_space` id (image ↔ world).
6. **Adopt SpatialData's *conceptual* schema, not its container.** Its five primitives
   (Images / Labels / Points / Shapes / Tables) and its axiom — *"Images, Labels, Points and
   Shapes MUST have one or more coordinate systems and coordinate transformations, while
   Tables CAN NOT"* — map onto our kinds almost one-to-one and give us the vocabulary for free.
   Its **Zarr container** we cannot use (see 3).
7. **First platform: Visium.** It is the only complete case that needs *nothing* new: spot
   matrix + coords + one image + scalefactors, and it exercises every seam once. Xenium is
   second and is where the scale problems live.
8. **Cost.** The recommended design needs **zero Rust** and **zero `src-app/packages/_lib`
   changes** for Visium. The honest caveats are in §12: they are about *scale limits* and
   *the un-checkable affine*, not about the type system.

**The one thing that is genuinely blocked and must be said plainly:** the *front end* is
already built and *unfed*. `workbenchDataSource.ts:800` hardcodes `hasImage: false` and
`:1095-1097` throws `NotReachableError('image underlay')`; `cell-filter/ui/cell-filter.yaml`
already ships spatial before/after image panes gated `when: "has:spatial"`, and **no datatype
in the registry declares a `spatial` capability**, so that gate can never fire. This design's
main deliverable is the data plane that turns those sockets on.

---

## 1. The design problem, stated

An analysis-ready spatial object (`06-spatial-processing.md` §11) must hold:

| element | shape | example |
|---|---|---|
| normalized expression | entities × genes, sparse | Visium spot × gene |
| **spatial coordinates** | entities × 2 (or 3), dense | `obsm['spatial']` |
| **image(s) + correct scalefactors** | H × W × C raster, pyramidal, multi-GB | `tissue_hires_image.png`, `morphology.ome.tif` |
| **segmentation geometry** | polygons (ragged) and/or label mask (raster) | `cell_boundaries.parquet`, `cells.zarr.zip` |
| **transcript points** | 10^8 rows × (gene, x, y, z, qv) | `transcripts.parquet` |
| (spot) deconvolution / mapped labels | entities × celltypes | *downstream — out of scope* |

CytoAnalyst implements **exactly three structures** — `opaque`, `table`, `sparse_csc`
(`_lib/conformance.py:1515-1543`) — and shipped consumers refuse anything else **by name**:

```python
# src-app/packages/embedding/compute/_shared.py:320-323
if structure.get("kind") != "sparse_csc":
    fail(f"input on slot {slot!r} ... declares kind {structure.get('kind')!r}; "
         "embedding.reduce reads a `sparse_csc` count matrix")
```
(the same refusal in `cell-filter.py:747`, `differential-expression/_shared.py:237`,
`clustering/_shared.py:335`, `qc-10x.py:684`).

So the question is: **which of the six rows above can be expressed inside
`opaque | table | sparse_csc`, and what does the remainder cost?**

### 1.1 The writer's real ceiling

This is where a generic answer goes wrong. The constraint is not "three structures", it is
what `cyto_zarr` can actually *write*:

```python
# src-app/packages/_lib/cyto_zarr.py:494-495
if arr.ndim not in (1, 2):
    raise ValueError(f"{name!r}: write_array takes 1-D or 2-D arrays, got {arr.ndim}-D")
```

and, for the 2-D case (`cyto_zarr.py:239-242`):

```python
shard_rows  = inner_chunk * chunks_per_shard
shape       = [n] if width is None else [n, width]
chunk_shape = [shard_rows] if width is None else [shard_rows, width]
```

Three consequences, all fatal for a raster and all harmless for a table:

* **Rank ≤ 2.** There is no way to write an `(H, W, C)` image, let alone OME-NGFF's `czyx`.
* **The second dimension is never chunked.** A 2-D chunk is `[shard_rows, width]` — *full
  width per chunk*. There is no 2-D tiling, so there is no tile a viewer could range-fetch.
* **Numeric dtypes only** (`cyto_zarr.py:322`, `_NUMERIC_DTYPES`), and members are `numeric |
  categorical | string` (`conformance.py:416`).

`write_array`'s own docstring is explicit that the 2-D case exists for embeddings: *"A 2-D
array is chunked along the ROWS only — each chunk carries the full width — so the shard index
is the same flat sequence a 1-D array produces and a consumer that wants one row fetches
exactly one chunk"* (`cyto_zarr.py:480-483`). It is a *columnar* writer wearing a 2-D hat. It
is not, and was never meant to be, a raster writer.

### 1.2 The `aux` channel — the mechanism that *looks* like the answer, and why we do not need it

`Table.aux()` (`cyto_zarr.py:1477-1566`) exists precisely for "a member whose length is
deliberately NOT the axis's `n`": it takes an N-D numeric array, and its length rule is a
**named extent** resolved through `structure.extents`, so two members claiming `output_rows`
are checked against one number. `conformance._conform_aux` (`conformance.py:2776-2942`)
enforces it.

It is tempting — polygon offsets and vertex arrays are exactly "several lengths in one
artifact". **But it carries a hard toll:**

```python
# src-app/packages/_lib/conformance.py:2861-2869
role = member.get("role")
if role not in _AUX_ROLES:
    out.append(f'aux member "{path}" declares role {role!r}, which this gate has no opinion '
               "about. ... Add it to `_AUX_ROLES` with what it means, or do not write it.")
```

`_AUX_ROLES` (`conformance.py:701-765`) is a **hardcoded table in the framework-owned gate**,
today containing only the seven `alignment_*` roles. **Using the aux channel for spatial means
editing `_lib/conformance.py`** — the one file in the tree whose whole design thesis is that a
producer may not influence it. That is not forbidden, but it is a real cost, and §4 shows it is
**avoidable**: everything the aux channel would carry can be carried by a **sibling
`metadata-column`** instead, at zero cost.

There is also a naming trap worth recording. `_AUX_ROLES`' own docstring explains why
`alignment_feature_index` was renamed: *"`feature` is on `lint-no-domain-in-builtin`'s noun
list and the role string rides into every emitted artifact's `structure`, so it landed in the
reference fixture that core's `zarrReader` parity tests consume — where core's domain-freedom
rule applies"* (`conformance.py:733-740`). `_lib/*.py` is **not** itself scanned by the lint
(`SCANNED_PACKAGES = ['dock']`, and `NON_PACKAGE_DIRS` includes `_lib` —
`lint-no-domain-in-builtin.mjs:317,1020`), but role strings *leak into scanned fixtures*. Note
for anyone who ignores this section's advice: `cell`/`cells`, `gene`, `feature`, `barcode`,
`transcriptome` are all on the noun list (`lint-no-domain-in-builtin.mjs:554-563`); `spatial`,
`tissue`, `vertex`, `molecule`, `transcript` are **not** — and the lint's own comments already
anticipate `spatial` as a future contributed package id (`:1112`, `:1411`).

---

## 2. What the tree actually has today (verified)

Six facts that change the design, each read rather than assumed.

### 2.1 A new *kind* costs zero core Rust — this is proven, not hoped

`open-kinds/manifest.yaml:1-23` is a whole package of three datatypes contributed as **pure
data**, with the un-gameable proof named in the file: `scripts/check-kinds-zero-core.sh` plus
the Rust grep-guard `kinds_zero_core_scope`. Registration is a folder scan
(`extensions/loader.rs`, seeded by `include_dir!` over `packages/`). So the question "does
spatial need core changes?" reduces to "does it need a new **structure**", not "does it need a
new **kind**".

### 2.2 The importer drops `obsm['spatial']` today, and says so

`anndata-import` classifies it (`h5ad_import.py:690-694`), and then:

```python
# src-app/packages/anndata-import/compute/h5ad_import.py:1442-1443
if role != "embedding":
    continue
```

The coordinate **values are never written**. What *is* emitted is a small JSON *alignment
plan* — `{library, coords_key, image_key, width, height, affine, scale_factor,
spot_diameter_fullres}` — as a `data/opaque` artifact (`h5ad_import.py:1155-1169`, built by
`multimodal.extract_spatial` at `multimodal.py:432-459`, whose `visium_affine(s)` returns
`[s,0,0,0,s,0]`). **The image raster is never materialized either** — only its width/height are
recorded, and `extract_spatial`'s docstring claim that "the ingest writer materializes the
image output" is false today.

The tree states the gap itself:

> *"KNOWN GAP, stated rather than hidden: `obsm['spatial']`'s coordinate VALUES ... are not
> emitted as an artifact of their own, so `plan['coords_key']` currently names a key with no
> shipped bytes behind it. Emitting them needs a new output id + datatype + a frontend consumer
> — a decision of its own rather than a consequence of deleting the transpose buffer."*
> — `anndata-import/tests/test_convert.py:559-563`

**This design is that decision.**

`import-h5ad` has zero spatial handling (`obsm` appears only as a list of key names,
`import-h5ad.py:244`). `cellranger` is `cellranger count`, not Space Ranger — zero hits for
`spatial|scalefactor|images`.

### 2.3 The front end is built and unfed

* **The viz library ships a complete spatial stack**: `libs/viz/src/viz-core/spatial/` — 33
  files, 6,749 lines: `RasterImageView.tsx`, `RasterUnderlayScatterView.tsx`,
  `TiledPointsView.tsx`, `LabelMaskLayer.ts` + `LabelMaskView.tsx`, `ImageTileLayer.tsx`,
  `imageTiles.ts`, `imageMeta.ts` (OME-Zarr multiscale + affine composition), `pointIndex.ts`,
  `binIndex.ts`, `regionSelect.ts`. Dependency `@hms-dbmi/viv ^0.22.0`
  (`libs/viz/package.json:33`). There are e2e tests
  (`ui/tests/viz-e2e/spatial-segmentation-interaction.spec.ts`,
  `spatial-transcripts-filter.spec.ts`) — **against stories, not artifacts.**
* **The data-plane contract already names the methods** (`libs/viz/src/viz-core/data/wire.ts`):
  `imageUnderlay()`, the optional Viv pyramid `imagePixelSource?(): Promise<PixelSource<['c']>[]>`
  (*"index 0 = full resolution, each subsequent entry half-scale ... a production source
  resolves it from an OME-Zarr/OME-TIFF loader"*), and the optional
  `imageLabelMask?(): Promise<LabelMaskData>` (*"a production source resolves it from an
  OME-Zarr `labels/` group / a segmentation processor's output"*).
* **And the production implementation refuses**: `workbenchDataSource.ts:800` `hasImage: false`;
  `:1095-1097` `async imageUnderlay() { throw new NotReachableError('image underlay') }`; same
  in `workbenchStreamingSource.ts:645` and `core/spec/schema.ts:946`. The file header says *"no
  project data path today"*.
* **A shipped package's UI already asks for it**: `cell-filter/ui/cell-filter.yaml` declares
  `showSpatial` (`:80`), `showSpatialBtn`/`hideSpatialBtn` gated `when: "has:spatial && …"`
  (`:488-497`), and `kind: image` series `s-spatial-before` / `s-spatial-after` (`:925-958`).
  `has:spatial` is derived from produced-datatype capabilities (`caps.ts:24-45`) and **no
  datatype declares a `spatial` capability**, so it is永 false.
* `libs/viz/src/adapter/DatasetStore.ts:387` says the quiet part: *"That component has NO
  production consumer."* **Zero files under `src-app/ui/src` import anything from
  `viz-core/spatial/**`.**

**And the deferral was deliberate and is written down.** `libs/viz/docs/segmentation-scale.md:3-4`
scopes that whole effort as *"frontend only"*, and its predecessor
`libs/viz/docs/annotation-surface.md:107-109` names the missing half exactly:

> *"Explicitly out of scope: … Backend image datatype, pyramidal-tile byte serving,
> vendor→OME-Zarr conversion, the compute backend, and annotation persistence — behind the two
> seams, **wired later**."*

**This design is "later".** Two consequences worth carrying forward: (a) the seams to fill are
already named and typed (`imagePixelSource`, `imageLabelMask`, and `annotate/processorPort.ts`'s
types-only `commitLabelMask` at `:266`, whose only implementor is a test mock); (b) that doc
assumed **OME-Zarr**, and §3 concludes we must use **OME-TIFF** — a real disagreement with a
prior design, addressed head-on in §12.1 rather than quietly overridden.

### 2.4 The range-read path exists and the browser already uses it

`workstore/routes.rs:89-96` registers `/artifacts/{id}/data` and `/artifacts/{id}/data/{*member}`.
`data_api.rs:1058-1065` defines two dialects: `?range=` → **200** (cacheable, URL is the cache
key), `Range:` → **206** + `Content-Range`; both at once → 400 `AMBIGUOUS_RANGE`; out of bounds
→ 416. `octet_response` streams via `store.get_stream(key, offset, length)` with
`Accept-Ranges: bytes` and `Cache-Control: private, max-age=31536000, immutable`
(`data_api.rs:1010-1037`). The browser Zarr reader already range-reads through it
(`ui/src/core/workstore/binaryClient.ts:118,123,242`).

**So a browser can read a slice of a multi-GB artifact without materializing it.** This is the
half of question 5 that has a good answer.

### 2.5 The sandbox cannot. Materialization is a whole-file copy.

`sandbox/inputs.rs::Stager::stage` (`:435-474`) tries `store.link_blob(key, dest)` — a real
`fs::hard_link` on local FS (`object_store/local_fs.rs:470-489`) — and otherwise **streams a
full copy**. Remote backends do **not** override `link_blob`; the trait default is
`BlobLink::Unsupported` (`object_store/mod.rs:238-240`, `s3.rs:72-75`), so **on S3/GCS every
input is copied in full**. Multi-file (Zarr) artifacts stage **every member**
(`stage_prefix_members`, `:868-899`). Staged files are then bind-mounted read-only file-by-file
at `/inputs/<name>` (`:160-179`). There is **no lazy/range read path into a sandbox at all.**

### 2.6 The scientific libraries are already installed — and used by nobody

`env-rootfs/single-cell/Dockerfile:49-55` installs `squidpy spatialdata`, and `:85` smoke-imports
them; the header calls it *"DEC-A full spatial"*. **Zero packages import them** (grep over
`src-app/packages/`). They are shipped for nobody today — the same state the Dockerfile itself
records for the removed TileDB-SOMA wheel (`:40-43`).

**Gap to note:** `spatialdata-io` — the package that actually contains the `visium`, `visium_hd`,
`xenium`, `merscope` readers — is **not** installed. `squidpy.read.visium()` is, and that is
sufficient for the Visium-first recommendation. Adding `spatialdata-io` is `[shared] #80`
territory (§13).

---

## 3. Option analysis — the structure vocabulary

### Option A — extend the structure vocabulary (`raster` / `geometry` / `points`)

Add new `structure.kind` values (and for a raster, a new *encoding*, because the geometry is
not a Zarr `table`).

**What it would cost, concretely.** It is not one edit:

1. `_lib/conformance.py` — a `_conform_raster` branch beside `_conform_table` /
   `_conform_sparse_csc` at `:1537-1543`, plus its own required-key / stamped-key / chunk-grid
   tables. That file is 4,498 lines of *"absence must not select a shallower check"*; a new
   branch must satisfy the same discipline, including `_conform_node_coverage` in both
   directions, `_chunk_grid` derivation, and `_chunk_key_place`. This is the largest single
   piece of work in the whole option.
2. `_lib/cyto_zarr.py` — a real N-D, **tiled** writer (`_array_meta` currently emits
   `chunk_shape = [shard_rows, width]`; a raster needs `[1, tile_h, tile_w]`-style grids), with
   byte-stability preserved because `zarr.json` is part of the artifact's merkle identity
   (`cyto_zarr.py:235-237`).
3. `_lib/cyto_zarr_read.py` + the TS `zarrReader.ts` — both are held to parity by fixtures
   (`conformance.py:1018-1020` cites `zarrReader.ts`'s `#assertRowChunked` as the reference the
   gate must not diverge from).
4. Every shipped consumer's refusal-by-name is unaffected (they check for `sparse_csc`), but
   the **catalog/serve** path and `datatype/types.rs`'s `layout` vocabulary would need the new
   kind (`storage.layout` is a closed enum — `chunked_sparse`, `chunked_dense`,
   `columnar_table`, `chunked_1d`, `opaque_as_is`).

**Honest verdict: this is a multi-week core epic, and it buys us a *worse* image path than
option B.** A hand-rolled tiled Zarr raster would not be OME-NGFF (which Viv reads natively);
it would be a bespoke format for which we would then have to write a `PixelSource`. We would be
building a private re-implementation of OME-NGFF and getting less.

### Option B — express everything within `opaque | table | sparse_csc`

* points → `table` over a `transcript` axis
* polygons → `table` over a `vertex` axis (+ per-entity offsets as sibling `metadata-column`s)
* label masks and images → `opaque`, as **OME-TIFF**

**The objection, and the answer.** The objection is the h5ad-layers trap: `opaque` bytes are
unreadable to any analysis (`06`-adjacent; velocity spike §1 Block 3, branch
`spike/research-velocity`). That objection is *correct for a matrix* and *wrong for a raster*,
for a reason specific to this case:

| | h5ad `layers` as opaque | OME-TIFF image as opaque |
|---|---|---|
| Is there a consumer that reads it? | **No**, and none can exist — every matrix consumer refuses non-`sparse_csc` **by name**, so the bytes are unreachable *by construction*. | **Yes in principle, and the renderer is written.** `@hms-dbmi/viv` reads pyramidal OME-TIFF via geotiff.js **HTTP range requests**; `libs/viz/.../spatial/` already drives Viv's *layers*. The *loader* is the missing piece — net-new, but ordinary FE work against a documented seam, not a type-system impossibility. |
| Does the artifact have rows to align? | Yes — and opacity destroys exactly the alignment the gate exists to check. | **No.** A raster has no axis, no `n`, no key sequence. There is no row-order fault for the gate to have caught. |
| Is opacity hiding checkable structure? | Yes — the bytes *are* a matrix. | Partly — see the honest cost in §12.2 (the affine). |

So `opaque` here is not "the gate is switched off for something it could have checked"; for the
pixel grid there is genuinely nothing in the gate's vocabulary to check. That is the same
argument `single-cell-types/manifest.yaml:21-49` makes when it re-parents `anndata` to
`data/opaque`.

**The constraint that decides the format.** `opaque` may not be a Zarr store:

```python
# src-app/packages/_lib/conformance.py:1705-1712
if entry.name == _NODE_META and entry.is_file():
    return found([f"declared `encoding: opaque`, but the bytes are a Zarr store ({rel} is a "
                  "Zarr node) — `opaque` is the one encoding whose contents this suite does "
                  "not verify, so declaring it over a store the suite CAN verify disables "
                  "the gate for this artifact (DEC-8: no declaration may weaken it)"])
```

plus `_OPAQUE_WALK_LIMIT = 20000` entries (`:404`) — *"too many to establish that it is not a
structured store, so the claim is unverified rather than accepted"*.

**⇒ OME-NGFF / OME-Zarr is unavailable as an `opaque` artifact. OME-TIFF is available, is a
single file, is what Xenium already emits (`morphology.ome.tif`), and is what Viv reads.**

### Option C — hybrid (recommended)

Option B **plus** a scoped, later, well-justified core item *only if* a measured need appears:
a `raster` structure would be re-opened when (and only when) we need **server-side pixel
reads** — i.e. a *sandboxed analysis* that must read image tiles (segmentation running
in-platform). Visium and "bring your own segmentation" do not need it. Xenium-with-in-platform-
segmentation does. Filing it now as a leaf blocked on evidence is honest; building it now is not.

### RECOMMENDATION

> **Option B/C. Do NOT extend the structure vocabulary for the foundation layer.** Points and
> geometry are `table`. Coordinates are a dense 2-D `table` member (the existing embedding
> writer). Images and label masks are `opaque` **OME-TIFF** with a declared metadata sidecar.
> Revisit a `raster` structure only when an in-sandbox pixel consumer exists, and file it as a
> separately-evidenced item.

Rationale in one line: **the expensive change buys a worse image path than the free one**,
because the free one inherits OME-TIFF + Viv + HTTP ranges, all three of which already ship.

---

## 4. Sibling artifacts vs one container

**Siblings. Decisively.**

The precedent is explicit and was established for exactly this question. From the velocity
spike (`docs/research/rna-velocity.md` on `spike/research-velocity`, §2a):

> *"A run may emit many artifacts. `anndata.import` emits dozens (one store + N obs columns + N
> var columns + a report). So spliced and unspliced can be two sibling artifacts from one run.
> **No multi-layer matrix kind is needed.** This is the single most important design consequence
> of this spike: the tempting 'add a layers axis' change is not required and should not be
> attempted."*

The same reasoning holds a fortiori for spatial, and there is an additional structural reason:
`open-kinds/manifest.yaml:57-61` records that **"the platform routes each store on ONE
`structure.kind`, so a single artifact cannot co-locate a CSC membership store and a columnar
metadata table"**. A spatial container would need `sparse_csc` (expression) + `table` (coords,
vertices, transcripts) + `opaque` (image) in one artifact. **That is not expressible.** A
container is not a design choice here; it is unavailable.

### What binds the siblings

Three distinct bindings, and it matters that they are distinct:

1. **Row identity (obs axis)** — `aligned_to`, the `key_sequence_digest` of the row space, which
   `write_metadata_column` and `write_embedding` already carry (`cyto_columns.py:388-393`:
   *"an embedding is the case that makes the declaration load-bearing rather than tidy: its
   whole job is to be painted, so 'may these values be painted on these points' is asked of it
   every time"*). This binds **expression ↔ coordinates ↔ per-entity metadata ↔ per-entity
   geometry offsets**. It exists; we use it unchanged.
2. **World coordinate space (image ↔ everything geometric)** — a declared `coordinate_space`
   id + affine. This is the **new** binding and it is what SpatialData exists to solve (§5).
   It rides in each spatial artifact's `meta` (see §6.6 for the byte budget).
3. **Run provenance** — artifacts of one import share a run id; `produces:` in the manifest
   declares the set. This is the weakest binding and must not be relied on for correctness —
   two Visium sections imported in two runs must still be distinguishable, which (2) does and
   (3) does not.

**Anti-pattern to refuse explicitly:** binding image to coords by *artifact adjacency in the
same run*. A user who later registers an H&E image to a Xenium run creates a second image
artifact in a different run that shares the *coordinate space*. Only binding (2) survives that.

---

## 5. Do we adopt SpatialData's model as the conceptual schema?

**Yes for the model. No for the container. And the split is principled, not pragmatic.**

SpatialData's five primitives and its central axiom
([design doc](https://github.com/scverse/spatialdata/blob/main/docs/design_doc.md),
[Nat. Methods 2024](https://www.nature.com/articles/s41592-024-02212-x)):

> *"Images, Labels, Points and Shapes MUST have one or more coordinate systems and coordinate
> transformations, while Tables CAN NOT have a coordinate system or coordinate transforms."*

That axiom maps onto our model with almost no loss:

| SpatialData | our carrier | structure | coordinate system? |
|---|---|---|---|
| **Tables** (AnnData) | `single-cell/expression` + `metadata-column`s | `sparse_csc`, `chunked_1d` | **no** — bound by `aligned_to` |
| **Shapes** (polygons, spot circles) | `spatial/boundaries` (vertex table) + per-entity offsets | `table` | **yes** |
| **Points** (transcripts) | `spatial/transcripts` (transcript table) | `table` | **yes** |
| **Images** (multiscale raster) | `spatial/image` (OME-TIFF) | `opaque` | **yes** |
| **Labels** (segmentation mask raster) | `spatial/labels` (OME-TIFF) | `opaque` | **yes** |
| coordinate systems + transforms | declared `coordinate_space` + affine in `meta` | — | — |

**Why adopt it.** Three reasons, in order of weight:

1. **It is the vendor-neutral vocabulary the whole ecosystem converged on**, and every reader we
   would ever write (`visium`, `visium_hd`, `xenium`, `merscope`, `cosmx`, `curio`, `stereoseq`)
   already targets it (`06-spatial-processing.md` §3a). Adopting a different vocabulary means
   translating twice.
2. **The Tables-have-no-coordinate-system rule is exactly our `aligned_to` vs `coordinate_space`
   split**, and it is a rule we would otherwise have discovered the hard way. It tells us
   *which* artifacts must carry a coordinate declaration and which must not — a real design
   constraint, not a naming convention.
3. **Its element/table annotation model matches ours.** A SpatialData table annotates a shapes
   or labels element via `region`/`region_key`/`instance_key`; ours annotates a row space via
   `aligned_to` + `membership`. Same idea, our spelling.

**Why not the container.** Four reasons:

1. **The gate forbids it** (§3, `conformance.py:1705-1712`) — a SpatialData `.zarr` cannot be an
   `opaque` artifact.
2. **One artifact = one `structure.kind`** (`open-kinds/manifest.yaml:57-61`) — a SpatialData
   store is by construction many kinds.
3. **It would re-opacify everything.** The expression matrix inside a SpatialData store would be
   unreachable to `qc.10x` / `embedding.reduce` / `de.compare`, all of which refuse anything
   that is not a `sparse_csc` store *by name*. That is the h5ad trap, re-entered voluntarily.
4. **`spatialdata` is a Python object model, not a wire format we can serve.** The browser reads
   our artifacts through `zarrReader.ts` and Viv; neither speaks SpatialData.

**Net:** we adopt the *schema* — element names, the coordinate-system axiom, the transform
concept — and serialize it as **sibling CytoAnalyst artifacts**. A future
`spatial.export-spatialdata` analysis can reassemble a real `.zarr` for users who want to leave;
that is an export concern, not a storage one.

---

## 6. The proposed declarations

All of the following is **pure data** in a new `packages/spatial-types/manifest.yaml` (modelled
on `open-kinds`), plus a `packages/spatial-import/` processor package. No `src-app` file changes.

### 6.1 Axes

Reuse `cells` for the measured entity — **this is the backwards-compatibility decision** (§11).
A Visium spot barcode *is* a barcode; a Xenium segmented cell *is* a cell. Inventing a `spots`
axis would fork every existing analysis.

Two genuinely new axes:

```yaml
- { name: vertex,   key_label: vertex_index }    # one row per polygon vertex
- { name: transcript, key_label: transcript_id }     # one row per decoded transcript
```

Both are domain-lint-safe (§1.2). Both are *long-format* axes — this is the point: the vendor
already delivers the data in that shape.

### 6.2 `spatial/coordinates` — the tissue map

```yaml
- id: spatial/coordinates
  extends: embedding
  title: Spatial coordinates
  description: >-
    Per-entity positions in a tissue coordinate space (x, y[, z]) — the physical layout a
    spatial measurement was taken in, as opposed to a computed embedding.
  is_abstract: false
  axes:
    - { name: cells, key_label: barcode }
    - { name: dims,  key_label: dim_index }
  entity_axis: cells
  storage: { layout: { kind: chunked_dense }, format: zarr, file_layout: single }
  capabilities: [obs-aligned, plottable-xy, spatial-coordinates]
```

* **Structure**: `{"encoding":"zarr_v3","kind":"table","axis":"cells","n":N,...}` with one 2-D
  numeric member — i.e. **exactly what `cyto_columns.write_embedding` emits today**
  (`cyto_columns.py:372-416`), carrying `aligned_to` and `membership`. Zero new code.
* **`extends: embedding`** is safe: **no shipped manifest selects `subtypes_of: embedding`**
  (verified — every `subtypes_of` in the tree targets `single-cell/expression`,
  `metadata-column` or `geneset/collection`). So this cannot cause an analysis to offer to
  re-embed a tissue map.
* **`plottable-xy` is declared explicitly**, not inherited: `axes_for` is a flat lookup that
  does not walk `extends` (`single-cell-types/manifest.yaml:151-153`), and the same is assumed
  for capabilities **(inferred — I read the axes comment, not the capability resolver)**. It is
  the capability `sc.viz.coordinates` binds on, *and nothing else*:

  ```yaml
  # src-app/packages/single-cell-viz/manifest.yaml:44-58
  # A CAPABILITY-only selector (ITEM-61) — the section applies to anything DECLARED
  # plottable as x/y, whoever contributed it.
  applies_to: [{ capabilities: [plottable-xy] }]
  ```

  **This is the single highest-leverage line in the design.** It makes the tissue map appear in
  the Coordinates section, selectable beside UMAP/PCA, with no UI work at all — and
  `sc.viz.colour-by` (`applies_to: [{ type_id: metadata-column }]`) then colours it by any
  existing metric for free.
* **`spatial-coordinates`** is a dispatch marker, and it is what finally makes `has:spatial`
  satisfiable for `cell-filter`'s already-shipped panes (§2.3). *(Name it
  `spatial-coordinates`, not `spatial`, so the capability says what carries it.)*

**Deliberate divergence from the velocity spike.** There, `velocity/embedding-vectors` must
**not** declare `plottable-xy`, because plotting a velocity *direction* as a *position* is
scientifically wrong. Here the opposite holds: these **are** positions. Recording the contrast
because the two decisions look identical and are not.

### 6.3 `spatial/image` and `spatial/labels` — the rasters

```yaml
- id: spatial/image
  extends: data/opaque
  title: Tissue image
  description: >-
    A registered tissue image (H&E / DAPI / morphology / IF) as a pyramidal OME-TIFF, placed
    into a declared coordinate space by an affine. Opaque: the pixel grid has no axis, no row
    order and no key sequence, so there is no member structure to declare.
  is_abstract: false
  storage: { layout: { kind: opaque_as_is }, format: ome-tiff, file_layout: single }
  capabilities: [spatial-image]
  ingest: { extensions: [ome.tif, ome.tiff, tif, tiff] }

- id: spatial/labels
  extends: data/opaque
  title: Segmentation label mask
  description: >-
    An integer label raster (0 = background, n = entity n) as OME-TIFF, in the same coordinate
    space as its image. Consumed by the label-mask surface; paired with a per-entity id LUT.
  is_abstract: false
  storage: { layout: { kind: opaque_as_is }, format: ome-tiff, file_layout: single }
  capabilities: [spatial-labels]
```

* **`structure` = `cyto_columns.opaque("image/tiff; application=ome")`** — the existing helper
  (`cyto_columns.py:83-93`), and the media type is a real RFC 6838 `type/subtype` with a
  parameter, which `_MEDIA_TYPE_RE` accepts (`conformance.py:379-382`).
* **Why OME-TIFF and not PNG.** Viv reads pyramidal OME-TIFF via geotiff.js over HTTP range
  requests ([Viv](https://github.com/hms-dbmi/viv)), which is the *only* way a multi-GB image is
  viewable at all; a PNG must be fetched whole. For Visium's small `tissue_hires_image.png`
  (~2000 px) either works, and we still write OME-TIFF so that one code path serves both scales.
* **Why not OME-NGFF/Zarr.** The gate refuses it (§3). This is a real loss — OME-NGFF is the
  better cloud format and is what SpatialData uses — and it is the strongest argument that will
  eventually be made for Option A. Recorded as such rather than glossed.
* **No `axes`.** An opaque container may declare axis *identity*
  (`single-cell-types/manifest.yaml:417-429` argues for it at the upload boundary), but an image's
  dimensions are `y/x/c`, which are not axes anything in this system joins on. Declaring them
  would be a structure claim INV-7 forbids.

### 6.4 `spatial/boundaries` — segmentation polygons, as a vertex table

The vendor already hands this over in the right shape:

> *"Boundaries are **one row per polygon vertex**, not one row per cell — group by `cell_id`."*
> — `01-file-formats.md:650`

```yaml
- id: spatial/boundaries
  extends: tabular
  title: Segmentation geometry
  description: >-
    Polygon boundaries in long format — one row per vertex, ordered within each entity — over a
    `vertex` axis. Per-entity slices are addressed through sibling offset columns on the entity
    axis, so no ragged-array structure is required.
  is_abstract: false
  axes: [{ name: vertex, key_label: vertex_index }]
  entity_axis: vertex
  storage: { layout: { kind: columnar_table }, format: zarr, file_layout: single }
  capabilities: [spatial-geometry]
  arrays:
    - name: table
      kind: annotation-table
      dims: [{ axis: vertex }]
      attrs:
        - { name: entity_index, dtype: i64 }   # row index into the entity axis
        - { name: x,            dtype: f32 }
        - { name: y,            dtype: f32 }
      layout: { kind: columnar_table }
```

**The ragged-array problem, solved for free.** A polygon set is ragged (cell *i* has *k_i*
vertices). The two candidate encodings:

| encoding | cost |
|---|---|
| offsets as an `aux` member with `extent: [cells]` | **edits `_lib/conformance.py`** to add two `_AUX_ROLES` entries |
| offsets as **sibling `metadata-column`s** on the `cells` axis | **zero** |

Take the second. Emit `boundary_vertex_start` and `boundary_vertex_count` as ordinary
`metadata-column` artifacts (`write_metadata_column`, `cyto_columns.py:125`), which are 1-D over
`cells`, carry `aligned_to`, and are conformance-checked like every other column. A consumer
reads `[start, start+count)` out of the vertex table. **The ragged structure becomes two dense
per-entity vectors plus a sorted long table** — which is what CSR does, and it is exactly the
shape `sparse_csc`'s `indptr` already is, so the idea is native to the tree rather than
imported.

*(This is the finding that removes the `_AUX_ROLES` edit from the critical path. It is worth
stating as an invariant: **any ragged per-entity structure can be encoded as a long table plus
per-entity offset metadata-columns, with zero framework change.**)*

### 6.5 `spatial/transcripts` — transcript detections

```yaml
- id: spatial/transcripts
  extends: tabular
  title: Molecule points
  description: >-
    Decoded transcript detections in long format — one row per transcript — over a `transcript` axis:
    position, the gene called, the quality value, and the entity it was assigned to (or absent).
  is_abstract: false
  axes: [{ name: transcript, key_label: transcript_id }]
  entity_axis: transcript
  storage: { layout: { kind: columnar_table }, format: zarr, file_layout: single }
  capabilities: [spatial-points]
  arrays:
    - name: table
      kind: annotation-table
      dims: [{ axis: transcript }]
      attrs:
        - { name: x,            dtype: f32 }
        - { name: y,            dtype: f32 }
        - { name: z,            dtype: f32 }        # omitted when the platform is 2-D (INV-3)
        - { name: gene_label,   dtype: categorical } # the panel is small ⇒ a good categorical
        - { name: qv,           dtype: f32 }
        - { name: entity_index, dtype: i64 }        # -1 is NOT used; see below
      layout: { kind: columnar_table }
```

Three details that are not cosmetic:

* **`gene_label` is `categorical`, and that is a large win.** A Xenium panel is 100–5,000 genes
  over 10^8 transcripts; as a categorical it is a `uint16` code array plus a level set, i.e. 2
  bytes/row instead of ~10. `Table.categorical` requires `levels_digest` + `n_levels` +
  `ordered` on the row (`conformance.py:445-450`) and stamps `levels` into the member's
  `attributes.cyto` — a level set of 5,000 short strings is fine there (the *row* carries only
  the digest, which is precisely why `levels` was replaced by `levels_digest`:
  `conformance.py:438-444`, *"Restating the list here made one member's row entry 450 KB for a
  9 KB array and blew MAX_MANIFEST_BYTES"*).
* **Unassigned transcripts.** Xenium writes `cell_id = 'UNASSIGNED'` / `-1`. **Do not store -1.**
  The tree refuses out-of-range sentinel codes explicitly (`conformance.py:747-755`: *"`-1` is
  pandas' in-memory missing code, and storing it is exactly what `cyto_columns` refuses ... the
  read side rejects a negative code with a 400 for the whole column"*). Encode assignment as a
  **separate `assigned` categorical column** with a declared level for the unassigned state, or
  as a boolean-coded column, and keep `entity_index` valid-only. This is the "absence is
  absence" (INV-3) rule.
* **Negative controls are dropped from the expression matrix and kept in the points table
  flagged**, per `06-spatial-processing.md:445-447`. That is a QC input, not expression.

### 6.6 The coordinate-space declaration

Every artifact in the table in §5 marked "coordinate system: yes" carries, in its **output entry
`meta`**:

```jsonc
{
  "coordinate_space": "<stable id, e.g. the run's slide/library id>",
  "unit": "micrometre" | "pixel",
  "to_space": [a, b, tx, c, d, ty],   // 2x3 row-major affine: THIS artifact -> coordinate_space
  "extent": { "width": W, "height": H }   // rasters only
}
```

**Budget check.** `MAX_MANIFEST_BYTES = 1 MiB` and `MAX_OUTPUTS = 512`
(`sandbox/outputs.rs:198,201`) ⇒ **~2,048 bytes per manifest entry**, asserted cross-language by
`_lib/test_conformance.py:4375-4436`. The block above is ~200 bytes. Comfortable.

**Precedent:** this generalizes the existing `spatial.json` plan
(`multimodal.py:432-459`), whose `visium_affine(s) = [s,0,0,0,s,0]` is the same 2×3 row-major
shape, and which the canvas already reads (`canvasFeed.ts:99-119` requires an `affine` key).
**We are populating a socket that is already shaped for this.**

### 6.7 Vendor bundle upload containers

```yaml
- id: spatial/visium-bundle
  extends: data/opaque
  title: Visium (Space Ranger outs)
  is_abstract: false
  axes:
    - { name: cells, key_label: barcode }
    - { name: genes, key_label: gene_id }
  entity_axis: cells
  storage: { layout: { kind: opaque_as_is }, format: spaceranger, file_layout: manifest }
  input_requirements:
    requires: manifest
    members:
      - "filtered_feature_bc_matrix.h5"
      - "tissue_positions.csv|tissue_positions_list.csv"
      - "scalefactors_json.json"
      - "tissue_hires_image.png"
    allow_archive: true
  capabilities: [spatial-bundle-target]
```

Modelled exactly on `single-cell/matrix-mtx` (`single-cell-types/manifest.yaml:642-702`),
including the `|`-alternation, which is *"the core's ONE matching sugar"* and exists for
precisely this kind of vendor rename — Space Ranger ≤1.x wrote headerless
`tissue_positions_list.csv`, ≥2.0 wrote `tissue_positions.csv` with a header
(`01-file-formats.md:590-592`).

**A real limitation, verified and worth designing around.** Member matching is by **basename**:

```rust
// src-app/server/src/modules/dataset/repository.rs:185-190
fn normalize_member_name(filename: &str) -> String {
    let base = filename.rsplit(['/', '\\']).next().unwrap_or(filename).to_ascii_lowercase();
```

and `detect_manifest_group` returns `None` unless **exactly one** file matches each member
(`repository.rs:207-212`). Consequences:

* The four members above have **unique basenames** across a Space Ranger `outs/` — this works.
* `filtered_feature_bc_matrix/matrix.mtx.gz` and `raw_feature_bc_matrix/matrix.mtx.gz` collide
  on basename, which is **why the `.h5` is the declared member and the MEX directory is not.**
* **Visium HD cannot use this path**: `binned_outputs/square_002um|008um|016um/` each contain
  identically-named files, so every member has three candidates and grouping returns `None`.
  Visium HD therefore needs either a per-bin upload or a directory-aware member matcher — filed
  as a `[shared]` platform item (§13), **not** worked around in the importer.

---

## 7. The import processor

### 7.1 Which family and platform first — **Visium**

| | Visium | Xenium / MERFISH |
|---|---|---|
| coordinates | `tissue_positions.csv`, one row per barcode | `cells.parquet` centroids |
| image | one small PNG + explicit scalefactors | multi-GB pyramidal OME-TIFF |
| geometry | none (spots are circles of known diameter) | `cell_boundaries.parquet`, ~10^6 polygons |
| points | none | `transcripts.parquet`, **10^8 rows** |
| expression | `filtered_feature_bc_matrix.h5` — **already an importable 10x h5** | `cell_feature_matrix.h5` — also fine |
| reader available in rootfs | **`squidpy.read.visium()` — installed** | needs `spatialdata-io` — **not installed** |
| new seams exercised | coords, image, coordinate space, bundle upload | all of the above **plus** two new axes and every scale limit |

**Recommend Visium first**, for four reasons in order:

1. **It is the only complete case that is also small.** It exercises *every new seam exactly
   once* — a coordinates artifact, an image artifact, a coordinate-space declaration, a bundle
   upload container — with no artifact exceeding a few hundred MB. The seams get proven before
   the scale problems are added.
2. **Its expression matrix needs no new work at all.** `filtered_feature_bc_matrix.h5` is a 10x
   HDF5 matrix; the existing conversion path already produces a `sparse_csc` store from one.
   So on day one, a Visium dataset is fully usable by `qc.10x`, `cell.filter`,
   `embedding.reduce`, `clustering.*` and `de.compare` — see §11.
3. **The scalefactor is the whole risk, and Visium is where it is *explicit*.** `01-file-formats.md:594-605`
   documents the exact fields, and the rule is one multiplication:
   `pxl_*_in_fullres * tissue_hires_scalef`. Getting registration wrong silently misregisters
   everything downstream; proving the affine on the case where the ground truth is a documented
   JSON file is the right place to build the QC overlay that proves it (§7.5).
4. **`squidpy` is already installed** (`env-rootfs/.../Dockerfile:55`), so Visium needs **no
   rootfs republish** — which matters because `[shared] #80` records that the env-image publish
   workflow is currently disabled.

**Xenium is second**, and its first increment should be **coordinates + expression + image
only** — deferring `transcripts.parquet` and `cell_boundaries.parquet` to their own items, for
the scale reasons in §8.

### 7.2 What the Visium importer maps

Analysis id `spatial.import-visium`, `category: data-io`, modelled on `import.h5ad`
(`import-h5ad/manifest.yaml`) — but **launchable**, not `trigger: on-ingest`, because the user
must be able to see and confirm the registration.

| vendor input | → artifact | datatype | structure |
|---|---|---|---|
| `filtered_feature_bc_matrix.h5` | expression store | `single-cell/counts` | `sparse_csc` |
| `tissue_positions.csv` → `(pxl_col_in_fullres, pxl_row_in_fullres)` | tissue map | `spatial/coordinates` | `table`, one 2-D member |
| `tissue_positions.csv` → `in_tissue` | per-spot flag | `metadata-column` (categorical) | `chunked_1d` |
| `tissue_positions.csv` → `array_row`, `array_col` | grid indices | `metadata-column` ×2 | `chunked_1d` |
| `tissue_hires_image.png` (+ full-res if supplied) | tissue image | `spatial/image` | `opaque` OME-TIFF |
| `scalefactors_json.json` | → the `to_space` affine + `spot_diameter_fullres` in `meta` | — | — |
| barcodes / features | axis index artifacts | (existing importer behaviour) | — |
| run summary + **registration overlay** | report | `report/qc` | `opaque` |

**Dropped, deliberately, and each with a reason** (INV-3: absence is absence, never a fabricated
value):

* `raw_feature_bc_matrix` — the unfiltered barcode set. Out-of-tissue spots capture ambient
  signal (`06-spatial-processing.md:401-403`); the filtered matrix is what analysis wants, and
  the raw one doubles storage. *Re-add as an opt-in slot if empty-droplet-style analysis lands.*
* `analysis/` (Space Ranger's own clustering/DR/DE) — a vendor's analysis, not our provenance.
  Re-computing it under our own recorded parameters is the whole point of the workbench.
* `possorted_genome_bam.bam` (+ `.bai`), `molecule_info.h5` — no `sequence/bam` datatype exists
  (velocity spike §1), and these are 10s of GB.
* `aligned_fiducials.jpg`, `detected_tissue_image.jpg` — QC overlays. **Embed them in the
  `report/qc` HTML instead of emitting artifacts**; they are diagnostics, not data.
* `web_summary.html`, `metrics_summary.csv` — the vendor's own report; its *contents* are
  summarized into our report and its **version fields are lifted into provenance** (§7.4).
* `cytassist_image.tiff` — emit as a **second** `spatial/image` in the same `coordinate_space`
  when present. Not dropped, but not required.

### 7.3 Preserving scalefactors and the coordinate system — the part that silently breaks

**The failure mode is silent.** Getting the affine wrong does not error; it draws spots in the
wrong place, and every downstream spatial analysis then measures the wrong neighbourhoods. So
the design rule is: **declare the space, never the scale factor alone.**

Concretely:

1. **Coordinates are stored in FULL-RESOLUTION PIXELS, always.** `tissue_positions.csv`'s
   `pxl_row_in_fullres` / `pxl_col_in_fullres` are already in that space. Storing hires-scaled
   coordinates would bake in a choice of image, and a second image (CytAssist, a post-hoc H&E)
   would then be unplaceable.
2. **`coordinate_space` = the full-res pixel frame of the capture area**, identified by the
   library id. The coordinates artifact declares `to_space = identity`.
3. **Each image declares its OWN affine INTO that space**, i.e. the *inverse* of its
   scalefactor: `tissue_hires_image.png` declares `to_space = [1/s, 0, 0, 0, 1/s, 0]` where
   `s = tissue_hires_scalef`. This is the direction that composes: N images, one coordinate
   space, every pair placeable.
4. **`spot_diameter_fullres` rides in the coordinates artifact's `meta`** — a spot is a *disc*,
   not a point, and the renderer needs its radius to draw it at the right size at every zoom.
5. **Axis order is a named trap.** `tissue_positions.csv` gives `pxl_row_*` (y) *before*
   `pxl_col_*` (x); `obsm['spatial']` convention is `(x, y)`. The importer must transpose, and
   the test for it must assert on a **non-square** fixture — a square image passes a transposed
   affine silently. *(This is the single most likely bug in the whole importer.)*

Note the existing `visium_affine` helper (`multimodal.py:423-429`) returns `[s,0,0,0,s,0]` —
the *forward* (fullres→hires) direction. The design above needs the inverse. That is a
one-line difference and exactly the kind of thing that is wrong for a year if nobody writes it
down.

### 7.4 Provenance — recording the vendor pipeline and version

The vendor pipeline is a **processing step we did not run**, and the honest position is that its
version is as load-bearing as any of our own parameters — Xenium's segmentation changed its
default nucleus expansion from 15 µm to 5 µm between versions
(`06-spatial-processing.md:145-147`), which changes every cell in the dataset.

Sources, in order of reliability:

| platform | where the version is | file |
|---|---|---|
| Visium | `metrics_summary.csv` / `web_summary.html` header | Space Ranger version + reference transcriptome + probe set |
| Visium | `scalefactors_json.json` | `microns_per_pixel`, `bin_size_um` (HD) |
| Xenium | `experiment.xenium` (JSON manifest) | XOA version, panel, segmentation method + parameters |

Record all of it, and record **which segmentation produced the entities**, because for imaging
platforms that is the dominant determinant of every downstream result
(`06-spatial-processing.md:317-319`).

**`[shared]` blocker.** `#77` records that *methods.md cannot narrate a model / reference-asset
version — closed param-role vocabulary, package-only Key Resources Table*. A vendor pipeline
version is exactly that shape. So the honest plan is: record it in the artifact `meta` and the
report **now**, and let the methods narrator pick it up when `#77` lands. Do not invent a second
provenance channel.

### 7.5 The registration QC overlay — the only defence against a silent affine bug

Nothing in the conformance gate can check an affine (§12.2). The compensating control is a
**rendered overlay in the `report/qc`**: the spot centres drawn on the tissue image at the
declared transform, exactly as Space Ranger's own `detected_tissue_image.jpg` does. A human
sees a misregistration instantly and sees nothing else about it. **This is a required output of
the importer, not a nice-to-have** — it is the entire verification story for step 7.3.

---

## 8. Scale — and whether an analysis can read a slice

### 8.1 The measured limits

| limit | value | source |
|---|---|---|
| multipart threshold / part size | 16 MiB / 8 MiB (min 5 MiB) | `workstore/config.rs:120-123` |
| max output **file** | **8 GiB** (admin-tunable 1 MiB – 64 GiB) | `workstore/settings.rs:47,90-96` |
| max multi-file **artifact total** | **32 GiB** (admin-tunable to 256 GiB) | `workstore/settings.rs:48` |
| max outputs per run | **512** | `sandbox/outputs.rs:198` |
| outputs manifest | 1 MiB ⇒ **~2 KiB/entry** | `sandbox/outputs.rs:201` |
| **`RLIMIT_FSIZE` inside the sandbox** | **2 GiB per file** | `sandbox/settings.rs` (`fsize_bytes`) |
| sandbox memory / address space | 8 GiB / 64 GiB | `sandbox/settings.rs` |
| sandbox CPU / wall | 600 CPU-s / 600 s (batch: 4 cpu, 8 GiB) | `sandbox/settings.rs:98-106` |
| input staging timeout | 900 s | `sandbox/settings.rs:98` |
| upload body limit | 64 GiB | `dataset/routes.rs:55` |
| k8s job resources | **none set**; `emptyDir` with no `sizeLimit` | `sandbox/backend/kubernetes.rs:151-161,207-224` |

### 8.2 The verdict on reading a slice

**Split answer, and the split is the finding.**

* **Browser: the transport is there, the readers are not.** `?range=` / `Range:` on
  `/artifacts/{id}/data/{*member}` with `Accept-Ranges: bytes` and immutable caching
  (`data_api.rs:1010-1065`) is live and is already used by the Zarr column reader
  (`binaryClient.ts:242`). So *column* slices of a sharded store are range-read today.
  **Two things are NOT range-read today and must not be claimed to be:**
  * **Images** — no `PixelSource` loader exists (§0.2), so nothing currently issues a tile
    request. `imageUnderlay()` (the only *required* image method) takes the **whole raster in
    one `Uint8Array`** (`wire.ts:217-224`); the pyramid seam `imagePixelSource?()` is optional
    and implemented **only by five showcase story literals**.
  * **Points** — `TiledPointsView` tiles **client-side**: it *"builds a CLIENT quadtree over the
    resident xy ONCE"* (`TiledPointsView.tsx:1-11`), and `binIndex.ts` is a counting sort over
    already-resident interleaved positions. **There is no server-tile protocol for points.** A
    10^8-row transcript table is therefore not renderable by the shipped stack at all — it would
    have to be fully resident.
  `LabelMaskData.raster` is likewise a whole `Uint32Array` (`grid/gridModel.ts:47-62`).
* **Sandbox: no, and there is no path to yes without core work.** `sandbox/inputs.rs:435-474`
  hardlinks (local FS) or **streams a full copy** (remote — `link_blob` is `Unsupported` for
  S3/GCS, `object_store/mod.rs:238-240`), then bind-mounts read-only. Multi-file Zarr artifacts
  stage **every member** (`:868-899`). There is no range/lazy read into `/inputs`.

**What that means in practice:**

| artifact | size | sandbox verdict |
|---|---|---|
| Visium coords (5k × 2 f32) | ~40 KB | fine |
| Visium hires image | ~10 MB | fine |
| Visium HD 8 µm expression (~10^6 bins) | ~1–5 GB | fine on local FS (hardlink); **a 900 s staging risk on S3** |
| Xenium cell boundaries (~10^6 cells × ~20 vertices) | ~1 GB | fine |
| Xenium morphology OME-TIFF | **5–50 GB** | **exceeds the 8 GiB per-file ingest cap** and is unstageable; must never be an analysis *input* |
| Xenium `transcripts.parquet` (10^8 rows) | **~2–4 GB as our categorical table** | at/over the **2 GiB `RLIMIT_FSIZE`** if written as one member file |

Three concrete design consequences:

1. **A large image must be a viz-only artifact.** It is produced once by the importer and
   thereafter consumed **only by the browser through range reads**. No analysis takes it as an
   input slot. This is a *stated contract*, and it is why "image as `opaque`" is not the h5ad
   trap: the consumer was never going to be a sandbox.
2. **`RLIMIT_FSIZE = 2 GiB` is a per-FILE cap, not a per-artifact cap — and sharding saves us.**
   `cyto_zarr` writes shards sized by `shard_chunks` (`cyto_zarr.py:125`), capped at
   `SHARD_CAP_CHUNKS` ≈ 16.8M elements per shard. So a 10^8-row transcript table lands as many
   shard files, each far under 2 GiB. **The transcript table is writable.** *(A raster written as
   one OME-TIFF is not — which is the second, independent reason the importer must not
   *re-encode* a Xenium morphology image, only reference or subset it.)*
3. **`MAX_OUTPUTS = 512` bounds the artifact fan-out.** A Visium import emits on the order of
   10–20 artifacts plus one `metadata-column` per obs column — comfortable. But any design that
   emits per-tile or per-gene artifacts is dead on arrival. Recorded so nobody proposes
   "one artifact per pyramid level".

### 8.3 What Xenium actually requires, honestly

Full Xenium support needs **at least one** of:

* an **out-of-band image path** — the multi-GB OME-TIFF referenced rather than ingested (a host
  resource, or an artifact whose bytes live outside the 8 GiB cap), **or**
* the ingest caps raised (they are admin-tunable to 64 GiB/file, 256 GiB/artifact —
  `workstore/settings.rs:90-96`), **and** a downsampled pyramid emitted by the importer so the
  browser is not asked to range-read 50 GB, **and**
* acceptance that on an S3/GCS deployment nothing large can be a sandbox input until
  `link_blob` or a lazy-read path exists, **and**
* a **point-rendering budget**, because the transcript table is *writable* (sharding keeps every
  file under `RLIMIT_FSIZE`) but **not renderable** by the shipped stack: `TiledPointsView`
  quadtrees a client-resident array and there is no server-tile protocol for points. 10^8
  transcripts will not fit in a browser. The realistic first answer is a **declared
  subsample/aggregate for display** with the full table kept for analysis — stated as a product
  decision, not silently applied.

**None of this blocks Visium.** All of it blocks Xenium. That asymmetry is the strongest single
argument for the platform ordering in §7.1, and it should be filed as an explicit
evidence-gathering item (#161) rather than assumed away.

**The uncomfortable summary:** for Xenium, *storage* is the easy part. Every genuinely hard
problem — a 50 GB image, 10^8 renderable points, a sandbox that copies its inputs — is a
**transport and rendering** problem, and none of them is solved by choosing a different
structure. That is further evidence for Option B: extending the structure vocabulary would not
have moved any of these.

---

## 9. Backwards compatibility

**The requirement:** a spatial dataset's expression matrix must remain usable by existing
analyses (QC, clustering, DE), with spatial as *additional* artifacts.

**Verdict: achievable, and essentially free — because of one decision.**

The mechanism is §6.1: **the expression matrix is emitted as an ordinary
`single-cell/counts` `sparse_csc` store over the `cells × genes` axes.** Every shipped consumer
selects on `subtypes_of: single-cell/expression` (`qc/manifest.yaml:78`,
`embedding/manifest.yaml:70`, `cell-filter/manifest.yaml:67`,
`differential-expression/manifest.yaml:52,138`) and refuses by `structure.kind != "sparse_csc"`.
A Visium spot matrix satisfies both. **Nothing needs to know it is spatial.**

**What it constrains — four things, and they are real:**

1. **No `spots` axis.** The entity axis must remain `cells` with `key_label: barcode`. Inventing
   a spatial-specific axis would make every `subtypes_of: single-cell/expression` selector miss,
   and would fork `metadata-column` (whose axis is `cells`). *A Visium spot is not a cell — but
   it is the row of the matrix, and the axis name is a join key, not a biological claim.* This
   trade should be stated in the UI copy rather than fixed in the type system.
2. **`spatial/coordinates` must not extend `single-cell/expression`.** It extends `embedding`
   (§6.2) — the same argument the velocity spike makes for `velocity/field`
   (*"Every raw-count gate in the tree would otherwise offer to run on it"*).
3. **The analyses will be *scientifically* wrong in known ways, and the platform will not say
   so.** `qc.10x` will compute %mito on a Visium spot — legitimate, but
   `06-spatial-processing.md:405-407` warns that high %mito can mark a *real anatomical region*
   and must not be blindly filtered. For an imaging panel there are usually **no MT genes at
   all**, so %mito is meaningless rather than merely risky. **This is a disclosure problem, not
   a storage problem**, and it belongs to the analysis epics — but the importer should stamp a
   `platform` / `measurement_unit` metadata-column so a future disclosure has something to
   dispatch on. Filing it as a child item.
4. **Filtering must carry the spatial siblings.** `cell.filter` emits a filtered matrix and a
   keep-mask; the coordinates artifact is `obs-aligned` with `aligned_to` + `membership`
   (`cyto_columns.py:395-398` — *"a coordinate set computed over a selected population is
   exactly the artifact whose `aligned_to` matches the parent's while its rows are a subset"*).
   So the mechanism exists and is the one already used for embeddings. **Verify, don't assume:**
   whether `cell.filter` re-emits or merely invalidates obs-aligned siblings is a behaviour I
   did not read. Filed as a child item with a test as its acceptance.

---

## 10. What it costs in `src-app`

**For the Visium foundation: zero `src-app` changes.** Everything is:

* `packages/spatial-types/manifest.yaml` — a new pure-data package (precedent: `open-kinds`,
  proven zero-core by `scripts/check-kinds-zero-core.sh` + `kinds_zero_core_scope`).
* `packages/spatial-import/` — manifest + `compute/*.py` + `ui/*.yaml` + tests.
* `packages/pytest.ini` — the one sanctioned non-package edit (`testpaths` is a hand
  enumeration; the exemption is codified in `clustering/tests/test_zero_src_app_diff.py`).

**What is NOT free, stated plainly:**

| item | cost | when |
|---|---|---|
| `spatialdata-io` (or a hand-rolled Xenium reader) in the rootfs | one Dockerfile line + smoke import + **an image republish**, and the publish workflow is **currently disabled** (`[shared] #80`) | Xenium only — Visium needs nothing |
| Visium HD bundle upload | `normalize_member_name` is basename-only (`repository.rs:185-190`) ⇒ **core change or a per-bin upload UX** | HD only |
| **a client `PixelSource` loader** for OME-TIFF (and/or OME-Zarr) | **net-new.** Viv's *layers* are imported, its *loaders* are not; no `loadOmeTiff` / `ZarrPixelSource` exists and `parseMultiscales` feeds only a fixture. This is the single largest FE item. | required to see a **pyramidal** image |
| `imageUnderlay()` / `imagePixelSource()` / `imageLabelMask()` in the production data source | `workbenchDataSource.ts:1095-1097` throws; the pyramid/mask methods are **absent** and implemented only by 5 showcase stories. **`ui/src` work, i.e. `src-app`.** | required to *see* anything |
| **point rendering at Xenium scale** | `TiledPointsView` tiles a **client-resident** array; there is no server-tile protocol for points | required before a transcript table is viewable |
| large-image ingest (>8 GiB) | admin settings raise, or an out-of-band path | Xenium only |
| lazy/range reads into a sandbox | **core Rust** (`sandbox/inputs.rs` + `ObjectStore`) | only if an in-sandbox pixel/point consumer appears |
| a `raster` structure | **large core epic** (§3 Option A) | only if the above appears |

**The honest headline: the storage layout is free; making it visible is not.** The FE rows in
that table are the real cost of "supporting spatial", and they are app-core work that a
pure-data package cannot do. This design does not pretend otherwise.

What it *does* buy: the **rendering** half is already written and tested (6,749 lines, real Viv
layers, a GPU label-mask shader, e2e coverage), and the seams to fill are already declared and
typed. The remaining FE work is a **loader + three data-source methods**, not a viewer. And
`spatial/coordinates` — the single most valuable artifact for a user — needs **none of it**: it
renders through the existing `sc.viz.coordinates` scatter path on day one. That is why the DAG
puts coordinates before images.

---

## 11. Answers to the six questions, in one place

1. **Extend the structure vocabulary?** **No.** Points and geometry are `table` (the vendors ship
   long format); coordinates are the existing dense 2-D member; images are `opaque` OME-TIFF.
   Extending it would cost a multi-week core epic and buy a *worse* image path than OME-TIFF+Viv.
   Revisit only for an in-sandbox pixel consumer.
2. **Siblings or container?** **Siblings** — and a container is not merely undesirable but
   **unavailable**, because one artifact routes on one `structure.kind`. Bound by `aligned_to`
   (rows), a declared `coordinate_space` + affine (world), and run provenance (weakest).
3. **SpatialData as the conceptual schema?** **Yes for the model** (five primitives; the
   Tables-have-no-coordinate-system axiom maps exactly onto `aligned_to` vs `coordinate_space`).
   **No for the container** (the gate refuses Zarr-in-`opaque`; one kind per artifact; and it
   would re-opacify the expression matrix).
4. **Coordinates?** **An `embedding`-shaped artifact** (`spatial/coordinates extends embedding`,
   `plottable-xy`) — not a `metadata-column` pair, which would lose the 2-vector and the free
   Coordinates section. Per-spot scalars (`in_tissue`, `array_row/col`) *are* metadata-columns,
   and get free colouring.
5. **Scale / materialization?** **Browser yes, sandbox no.** Range reads ship and are already
   used; sandbox staging is a whole-file hardlink-or-copy with no lazy path. Therefore a large
   image is a **viz-only artifact** by contract. Hard numbers: 8 GiB/file and 32 GiB/artifact
   ingest caps, 2 GiB `RLIMIT_FSIZE` per file written in-sandbox (sharding saves the transcript
   table), 512 outputs/run, 900 s staging timeout.
6. **Backwards compatibility?** **Achieved by keeping the `cells × genes` axes and emitting an
   ordinary `sparse_csc` store.** Constrains us to no `spots` axis, to not extending
   `single-cell/expression`, and it leaves a *scientific disclosure* debt (%mito on a spot;
   no MT genes on a panel) that belongs to the analysis epics but needs a `platform` column
   from the importer to dispatch on.

---

## 12. Known weaknesses of this design

Stated because a design doc that lists none has not been read hard enough.

1. **OME-NGFF is the better format, we cannot use it, and this CONTRADICTS a prior design doc.**
   `libs/viz/docs/annotation-surface.md:107-109` scopes the deferred backend as
   *"vendor→**OME-Zarr** conversion"*. This doc concludes OME-**TIFF**, and the reason is not
   preference: `conformance._bytes_are_not_a_store` refuses any `opaque` artifact containing a
   `zarr.json` (`conformance.py:1705-1712`). That rule is *right* — it closes a real bypass —
   but it costs us the cloud-native pyramid format the ecosystem standardized on, and it is the
   argument that will eventually justify Option A.

   **Three ways out, and the honest ranking:**
   * **(a) OME-TIFF** — free today, Viv reads it, single file (so no `_OPAQUE_WALK_LIMIT` risk).
     **Recommended.** Cost: it is the less cloud-native format, and a huge one is a single file
     that trips both the 8 GiB ingest cap and the 2 GiB `RLIMIT_FSIZE`.
   * **(b) a real `raster` structure** (Option A) — the principled end-state, a large core epic,
     and only justified once an **in-sandbox** pixel consumer exists (§3 Option C; filed as #166).
   * **(c) an `opaque` sub-declaration naming an externally-specified store format**, checked
     against that spec. **Explicitly NOT proposed.** It is precisely the shape of knob
     `conformance.py`'s header spends 200 lines retiring — a producer-written declaration that
     selects how hard the gate looks. Recorded so that it is rejected on the record rather than
     re-invented.

   Whoever picks this up should treat the disagreement with `annotation-surface.md` as a
   decision to be *made*, not a discrepancy to be smoothed over.
2. **The affine is producer-declared and unverifiable.** No gate can check a registration. The
   compensating control is the rendered overlay (§7.5) — a human check, not a mechanical one.
   This is a genuine weakening relative to every other artifact in the system, and it should be
   named in the item that implements it rather than discovered later.
3. **`coordinate_space` is a string, and two artifacts agreeing on it is a convention.** Unlike
   `aligned_to` (a digest of actual bytes), nothing recomputes it. The mitigation is to derive it
   from the vendor's own library/slide id rather than minting one, so two imports of the same
   slide collide correctly — but that is a producer discipline, not an invariant.
4. **`entity_index` in the geometry/points tables is a positional row index into the `cells`
   axis, and positional addressing is what `key_sequence_digest` exists to guard.** The tables
   must carry the entity axis's `aligned_to` digest so a consumer can refuse a mismatched pair.
   *(Whether a `table` over a `vertex` axis can declare `aligned_to` for a **different** axis is
   something I did not verify — flagged as an open question on the leaf item.)*
5. **I did not verify capability inheritance through `extends`.** §6.2 declares `plottable-xy`
   explicitly, which is correct either way, but the claim "capabilities are a flat lookup" is
   **inferred** from the axes comment (`single-cell-types/manifest.yaml:151-153`), not read.

---

## 13. `[shared]` — overlaps with in-flight work

| # | item | overlap |
|---|---|---|
| **#80** | analysis packages cannot pin python deps; env-rootfs publish workflow disabled | **Direct.** `spatialdata-io` is needed for Xenium and is not installed. Visium is deliberately scoped to need nothing. |
| **#77** | methods.md cannot narrate a model/reference-asset version | **Direct.** A vendor pipeline version (Space Ranger / XOA) is exactly that shape (§7.4). |
| methods-narrator fix (**#131**) | ships two known-wrong outputs today | The importer's methods block will inherit whatever lands; do not write around it. |
| **#127** | `[shared]` app-core vector-field / graph-overlay viz seam | Adjacent, **not** the same seam. Spatial needs the *raster/points* data-source methods wired, not a new chart kind — the chart kinds (`image`, `scatter`, both `world2d`) already exist. |
| **#115** | node-link / network chart kind | Not needed by the foundation layer; cell–cell communication (an analysis) may want it. |
| **#94** | no scientific reference-parity test tier | The registration overlay (§7.5) is a *visual* control; a real parity test against `squidpy.read.visium` output would want this tier. |
| **#86** | no shared per-sample / batch-key convention | A multi-section spatial experiment is a multi-sample experiment; `coordinate_space` is adjacent to but **not** a substitute for a sample key. |
| #75 #76 #81 #85 #101 #125 | the six existing analysis epics | **No overlap by construction** — this is the foundation beneath a future spatial-analysis epic, and none of these six consumes spatial artifacts. |
| **NEW `[shared]`** | Visium HD bundle upload is blocked by basename-only member matching (`repository.rs:185-190`) | filed as a child (§14) |
| **NEW `[shared]`** | production `DataSource.imageUnderlay/imagePixelSource/imageLabelMask` throw or are absent; `hasImage: false` hardcoded | filed as #159 — **this is the item that makes spatial visible** |
| **NEW `[shared]`** | **no client `PixelSource` loader exists** — Viv's layers are imported, its loaders are not | filed as #158; the largest FE item, and a prerequisite for any pyramidal image |
| **NEW `[shared]`** | **no server-tile protocol for points** — `TiledPointsView` tiles a client-resident array | filed as #165; blocks Xenium-scale transcript rendering |
| **NEW `[decision]`** | OME-TIFF (this doc) vs OME-Zarr (`annotation-surface.md:107`) | filed as #153; must be settled before any image is encoded |

---

## 14. Proposed issue DAG

The **leaf is the type declaration**, not the structure-vocabulary decision — because §3
concludes the structure vocabulary is *not* extended. That is the design's main result and the
DAG shape reflects it.

```
EPIC #151: Spatial storage layout + import processor
│
├─► #152  spatial-types package (kinds/axes/capabilities)     ← THE LEAF, blocks all
│    │
│    ├─► #154  spatial.import-visium: coords + expression + in_tissue
│    │    │      (the tissue map lights up sc.viz.coordinates via plottable-xy,
│    │    │       so THIS item alone makes a Visium dataset useful)
│    │    │
│    │    ├─► #155  spatial/image + the coordinate-space affine
│    │    │    │      (OME-TIFF encode, to_space = INVERSE scalefactor,
│    │    │    │       spot_diameter; also blocked_by #153)
│    │    │    │
│    │    │    └─► #156  [acceptance] the registration QC overlay
│    │    │              — the affine's ONLY check; nothing mechanical can verify it
│    │    │
│    │    └─► #157  [acceptance] backwards-compat proof: qc.10x → cell.filter →
│    │              embedding.reduce → clustering → de.compare, unmodified,
│    │              + obs-aligned siblings survive cell.filter
│    │
│    ├─► #153  [decision] OME-TIFF vs OME-Zarr — this doc says TIFF (the gate
│    │    │      refuses Zarr-in-opaque); annotation-surface.md:107 assumed Zarr.
│    │    │      Settle it BEFORE #155 encodes anything.
│    │    │
│    │    └─► #158  [shared] a client PixelSource LOADER for OME-TIFF
│    │         │      (net-new: Viv's LAYERS are imported, its LOADERS are not)
│    │         │
│    │         └─► #159  [shared] wire the production DataSource: imageUnderlay /
│    │                   imagePixelSource / imageLabelMask, hasImage, has:spatial
│    │                   (also blocked_by #155; turns on cell-filter's shipped panes)
│    │
│    └─► #160  [shared] Visium HD bundle upload — basename-only member matching
│               blocks binned_outputs/ (repository.rs:185-190)
│
└─► #161  [decision] Xenium scale envelope — evidence, not code
     │      (image >8 GiB ingest cap; S3 has no link_blob; 900 s staging;
     │       and points are unrenderable — see #165)
     │
     └─► #162  spatial.import-xenium phase 1: coords + expression + image only
          │      blocked_by #155, #161, and [shared] #80 (spatialdata-io)
          │
          ├─► #163  spatial/boundaries from cell_boundaries.parquet
          │          + boundary_vertex_start/count metadata-columns
          │          (proves: ragged → long-table + offsets needs ZERO framework change)
          │
          └─► #164  spatial/transcripts from transcripts.parquet (10^8 rows)
               │      categorical gene_label; NO -1 sentinel; shard-size proof
               │
               └─► #165  [shared] point rendering at scale — TiledPointsView tiles a
                    │      CLIENT-RESIDENT array; no server-tile protocol for points
                    │
                    └─► #166  [decision] revisit a `raster` structure — OPEN,
                               gated on evidence from #161/#164 that an
                               IN-SANDBOX pixel consumer is actually needed
```

**Invariant / test per item** (what would prove it):

* **#152** — `check-kinds-zero-core.sh` passes and `git diff --stat src-app/` outside `packages/`
  is empty; every declared kind resolves in the registry after a version-keyed re-extract.
* **#154** — a Visium fixture imports; the coordinates artifact conforms under the real
  `conform_outputs` entry at `full=True`; the emitted `structure` is byte-identical to
  `write_embedding`'s; the tissue map appears under `sc.viz.coordinates` (capability-only
  selector, no code path naming the datatype).
* **#155** — round-trip: `pxl_* × tissue_hires_scalef` computed from the declared `to_space`
  equals the vendor's own value; **on a non-square fixture**, so a transposed affine fails.
* **#156** — the report contains a rendered overlay; a deliberately transposed affine produces a
  visibly wrong overlay *and* the test asserts the overlay exists at all.
* **#157** — the five-analysis chain runs on the Visium fixture with **no manifest or selector
  change**; `aligned_to` on the post-filter coordinates matches the post-filter matrix.
* **#158** — a `PixelSource[]` resolved from a real emitted `spatial/image` artifact drives
  `MultiscaleImageLayer`; level 0 is full resolution and each subsequent entry is half-scale;
  tiles are fetched by HTTP range, asserted by counting requests rather than by eye.
* **#159** — `has:spatial` is true for a project holding a `spatial/coordinates` artifact;
  `imageUnderlay()` returns rather than throws; cell-filter's `showSpatialBtn` renders.
* **#153** — a written decision naming the format, the gate rule that forces it, and what is
  given up; `annotation-surface.md` updated or explicitly superseded.
* **#165** — a stated budget: how many points the resident path renders acceptably, measured;
  and either a server-tile protocol or a declared subsample/aggregate strategy for above it.
* **#160** — a Visium HD `binned_outputs/` archive groups into one dataset (currently returns
  `None` from `detect_manifest_group`).
* **#161** — a written envelope: measured artifact sizes per platform against the caps table in
  §8.1, and a stated decision per over-cap item.
* **#163** — for every entity, `[start, start+count)` over the vertex table reproduces the
  vendor's polygon exactly; a mismatched `aligned_to` is refused.
* **#164** — 10^8 rows written with no shard file exceeding `RLIMIT_FSIZE`; `gene_label`
  round-trips through `levels_digest`; **no negative code anywhere** (the read side 400s on one).

---

## Sources

**Platform (read in-tree):**
`src-app/packages/_lib/conformance.py` (:404, :416, :427-459, :701-765, :1515-1543, :1547-1584,
:1705-1712, :2776-2942) · `_lib/cyto_zarr.py` (:125, :231-267, :475-511, :1477-1566, :1581-1596) ·
`_lib/cyto_columns.py` (:83-93, :125, :372-416) · `_lib/verify_conformance.py` ·
`packages/open-kinds/manifest.yaml` · `packages/single-cell-types/manifest.yaml` ·
`packages/single-cell-viz/manifest.yaml:44-58` · `packages/import-h5ad/manifest.yaml` ·
`packages/anndata-import/compute/h5ad_import.py` (:690-708, :1155-1169, :1436-1457) ·
`anndata-import/compute/multimodal.py:416-469` · `anndata-import/tests/test_convert.py:559-563` ·
`packages/embedding/compute/_shared.py:320-323` · `packages/cell-filter/ui/cell-filter.yaml` ·
`env-rootfs/single-cell/Dockerfile:1-85` ·
`server/src/modules/workstore/config.rs:120-123` · `workstore/settings.rs:47-105` ·
`workstore/data_api.rs:1010-1065` · `workstore/routes.rs:89-96` ·
`workstore/object_store/mod.rs:43,166-240` · `object_store/local_fs.rs:430-489` ·
`object_store/s3.rs:64-102,276-440` · `server/src/modules/sandbox/inputs.rs:160-179,435-474,868-899` ·
`sandbox/outputs.rs:198-305` · `sandbox/settings.rs:66-139` ·
`sandbox/backend/kubernetes.rs:105-224` · `server/src/modules/dataset/repository.rs:182-225` ·
`server/src/modules/datatype/types.rs:172-189` ·
`libs/viz/src/viz-core/data/wire.ts:165-290` · `libs/viz/src/viz-core/spatial/**`
(`rasterImageLayers.ts:32`, `TiledPointsView.tsx:1-11`, `binIndex.ts`, `imageMeta.ts`) ·
`libs/viz/src/viz-core/grid/gridModel.ts:47-62` · `libs/viz/src/viz-core/grid/useGridRaster.ts:43` ·
`libs/viz/src/viz-core/annotate/processorPort.ts:266` ·
`libs/viz/docs/segmentation-scale.md:3-4` · `libs/viz/docs/annotation-surface.md:107-109` ·
`libs/viz/src/viz-core/charts/chartSchemas.ts:87-100` ·
`libs/viz/src/viz-core/charts/installBuiltins.tsx:81-93` · `libs/viz/package.json:33` ·
`ui/src/modules/workbench/extensions/data/workbenchDataSource.ts:800,1095-1097` ·
`ui/src/core/workstore/binaryClient.ts:118-242` ·
`ui/scripts/lint-no-domain-in-builtin.mjs:317,554-563,1020,1112,1411`

**In-tree research:** `docs/research/data-processing/06-spatial-processing.md` (§3, §4, §5, §8,
§9, §11) · `docs/research/data-processing/01-file-formats.md` (§14, §15, §21, §22) ·
`docs/research/rna-velocity.md` (branch `spike/research-velocity`, §2a — the sibling-artifacts
precedent)

**External:**
- <https://github.com/scverse/spatialdata/blob/main/docs/design_doc.md> — SpatialData design: the five primitives; Images/Labels/Points/Shapes MUST have coordinate systems, Tables CANNOT.
- <https://www.nature.com/articles/s41592-024-02212-x> — SpatialData (Nat. Methods 2024): unified multiplatform format, lazy larger-than-memory representation, alignment to common coordinate systems.
- <https://spatialdata.scverse.org/en/latest/tutorials/notebooks/notebooks/examples/transformations.html> — transformations and coordinate systems.
- <https://github.com/hms-dbmi/viv> — Viv: multiscale visualization of high-resolution bioimaging on the web; **directly renders Zarr and OME-TIFF**; `PixelSource` abstraction (`ZarrPixelSource` / `TiffPixelSource`); geotiff.js for remote TIFF over HTTP.
- <https://www.10xgenomics.com/support/software/space-ranger/latest/analysis/outputs/output-overview> — Space Ranger outputs: `spatial/`, `tissue_positions`, `scalefactors_json.json`, filtered/raw matrices.
- <https://www.10xgenomics.com/support/software/xenium-onboard-analysis/latest/analysis/xoa-output-at-a-glance> — Xenium bundle: `transcripts.parquet`, `cell_boundaries.parquet` (one row per vertex), `morphology.ome.tif`, `experiment.xenium`.
- <https://www.10xgenomics.com/analysis-guides/segmentation-visium-hd> — Visium HD 2/8/16 µm binning.
- <https://squidpy.readthedocs.io/> — `squidpy.read.visium()` (installed in the rootfs today).
- <https://spatialdata.scverse.org/projects/io/en/latest/> — `spatialdata-io` readers (**not** installed).
- <https://bioconductor.org/books/release/OSTA/> — OSTA, the analysis-side landscape these artifacts feed.

---

## 15. Revisions after the 17-platform stress test (owner-approved)

The platform survey (`docs/research/spatial-platforms/`, branch `docs/research-spatial-platforms`)
stress-tested this design against 17 platforms. **The six kinds, two new axes and three
structures all survived unchanged.** Every finding was a *field inside* a kind, not a change to
the type model. Four additive fixes are applied here, plus two renames.

### 15.0 Renames (owner decision)

* **`spatial/points` → `spatial/transcripts`**, and **`spatial/geometry` → `spatial/boundaries`**.
  Both `coordinates` and `points` are literally points — the old names encoded *shape*
  (identical) rather than *contents* (completely different), and two separate readers hit the
  confusion in one review. The new names say what the artifact holds. Note this diverges from
  SpatialData's `Points`/`Shapes` vocabulary, which is generic because its model spans domains;
  ours only ever holds transcript detections and cell boundaries.
* **The axis `molecule` → `transcript`** (and `molecule_id` → `transcript_id`). "Molecule" is
  inherited from upstream tools (SpatialData's "single molecule data", Seurat's `Molecules`) but
  reads as *metabolomics* to a domain reader — which this platform does not do. Verified
  domain-lint-safe: `transcript` is not on the noun list in
  `ui/scripts/lint-no-domain-in-builtin.mjs:554-563` (`transcriptome` is; `transcript` alone is not).
* **`spatial/coordinates` is deliberately NOT renamed.** A candidate name like
  `spatial/cell-positions` would be *actively false* on Visium, where one row is a spot holding
  ~1-10 cells, and on Visium HD, where one row is a bin holding a fraction of a cell. The kind is
  entity-agnostic on purpose — it holds one position per *matrix row*, whatever that row is. That
  is exactly why §15.1 is necessary.

### 15.1 `measured_entity` — the highest-value fix ⟨probe B: BREAKS⟩

**"One run, one row space" is false for 8 of 17 platforms.** Visium HD emits `square_002um`
(11,222,500 rows), `square_008um` (702,244), `square_016um` (175,561), H&E-segmented cells *and*
nucleus segmentations from one run, with 10x's own `barcode_mappings.parquet` relating them;
Stereo-seq holds bins 1/5/10/20/50/100/150/200 simultaneously in one `.gef`; Open-ST's default
run emits beads + a hex mesh at three UMI cutoffs + cellpose cells.

They **coexist correctly already** — each is a distinct `key_sequence_digest`, so `aligned_to`
prevents cross-resolution contamination. This is an undesigned-for strength. **What breaks is
identity**: all three declared bindings are identical across those bins (same `coordinate_space`,
same run, and `aligned_to` is a digest nobody can read), so a user distinguishes 8 µm from 16 µm
**by row count**, and cannot distinguish a 5 µm-expansion Xenium cell set from a 15 µm one at all
— the exact change 10x made between XOA versions, which alters every cell in the dataset.

This was filed under §9.3 as *scientific disclosure*. It is **entity identity**, and it is
**unrecoverable from the bytes once artifacts exist**. Stamp it in `meta` at write time:

```yaml
measured_entity:
  kind: spot | bin | bead | cell | nucleus     # what one row IS
  resolution_um: 55                            # optional; spot/bin diameter or pitch
  segmentation:                                # present only for a segmented entity
    method: xenium-expansion | cellpose | baysor | ...
    params: { expansion_um: 5 }
    software_version: "xenium-4.0.0.19"
  platform: visium-hd | xenium | stereo-seq | ...
```

The UI label derives from this, not from the row count. Artifacts sharing a run and differing
only in `measured_entity` form a **resolution group**.

### 15.2 The always-2-D writer rule ⟨probe A: BENDS at writer, BREAKS at consumer⟩

`spatial/coordinates` is specified as a 2-D member, but Xenium, MERSCOPE, CosMx and STARmap all
carry a z. The break is **in dispatch, not decode**: the shipped selector is
`source: { capabilities: [plottable-xy], dims: 2 }`
(`single-cell-viz/ui/coordinates.yaml:114`) and the matcher is exact equality that fails closed —
`if (filter.dims != null && declaredComponentCount(row) !== filter.dims) return false`
(`ui/src/modules/workbench/core/runtime/axisSource.ts:1334`). An honest `(n × 3)` artifact would
be **silently invisible** in the Coordinates section, while the reader is already 3-D-tolerant
(`workbenchDataSource.ts:955-990` de-interleaves the first two dims).

**Rule: a producer ALWAYS emits `(n × 2)`.** z goes out as a sibling `metadata-column` with a
declared kind — `physical` (µm), `index` (z-plane number) or absent. Absence stays absence; never
write `z = 0` for a 2-D platform. Relaxing the UI `dims` filter is a later, separate change.

### 15.3 `positioning.partial` ⟨probe C: HOLDS⟩

Slide-tags positions only a subset of nuclei, and no platform guarantees every entity is placed.
Declare it rather than leaving a reader to infer it from nulls:

```yaml
positioning:
  partial: true                 # not every entity has a position
  confidence_column: pos_conf   # optional sibling metadata-column
```

A consumer that cannot handle absent positions must refuse, not default. (INV-3: absence is
absence.)

### 15.4 `section` ⟨probe F: BREAKS⟩

`coordinate_space` names one frame; it cannot express *several sections of one sample intended to
align into a volume*. Record the section now — it is free at write time and unrecoverable later:

```yaml
section:
  sample_id: "donor-04-blockA"
  index: 3                      # ordinal within the series
  z_offset_um: 30               # optional, if known
```

**Deliberately NOT designed now:** the section→section transform. Serial-section registration is
frequently **non-linear** (PASTE2, STalign), so an affine is *insufficient* — recording one would
be worse than recording none. That is a `[SCHEMA-LATER]` item; `section` alone is the
`[FIELD-NOW]` half.

### 15.5 Two corrections to earlier claims in this document

* **The `opaque`-refuses-Zarr gate has a blind spot.** §0.3 presents it as authoritative. It
  tests `_NODE_META = "zarr.json"` (`_lib/conformance.py:946`) — **Zarr v3 only** — and there are
  **zero** references to `.zattrs`/`.zgroup` in the suite, so an **OME-NGFF 0.4** pyramid (Zarr v2
  layout) is not caught by that check; only `_OPAQUE_WALK_LIMIT = 20000` does the real work.
  **OME-TIFF still stands, but justify it by platform reality: zero of the 17 platforms ship NGFF
  natively.** Also note Xenium's `morphology_focus/` is a *multi-file* OME-TIFF.
* **Xenium protein arrived in XOA 4.0, not 5.3.1** (verified from a bundle's `experiment.xenium`:
  `"analysis_sw_version": "xenium-4.0.0.19"`). Protein rides in the *same* matrix with a root
  attribute `protein_scaling_factor = 10` that must be divided out.

### 15.6 What remains genuinely un-modellable

**Volumetric segmentation geometry** (STARmap's 150 µm sections). A `vertex` table encodes a 2-D
polygon; a 3-D mesh is not expressible. SpatialData cannot express it either — `force_2d` is
public API, *"3D polygons/meshes are not implemented"*, and its 3-D roadmap issue has been open
since Jan 2023. Recorded as a known limit, not a gap to close now.

---

## 16. Reconciliation with what shipped (added by #315, at `4b63a482`)

§0–§15 are the spike as approved. This section is what the tree looks like now. **Everything
below was read out of the code at `4b63a482`, and every measured number was re-derived from the
committed bytes rather than copied from a comment** — the tree has been bitten repeatedly by
restated magnitudes (#277, #294, #321), and a restored design document is exactly the kind of
file that would carry one forward for a year.

**Where §0–§15 and this section disagree, this section is closer to the tree; where this section
and the code disagree, the code wins.** Nothing here amends the earlier sections' text, because
shipped modules quote them verbatim.

### 16.1 The citation index — every reference in the tree, and where it lands

Cited **by path** (`docs/design/spatial-storage-layout.md`), 17 sites:

| citing file | cites | what the citation expects | resolves? |
|---|---|---|---|
| `spatial-types/manifest.yaml:3` | §6 + §15 | the declarations, with §15 winning on disagreement | yes |
| `spatial-types/compute/spatial_declarations.py:8` and its two byte-identical vendored copies in `spatial-import-visium/compute/` and `spatial-import-xenium/compute/` | §15 (and §6.6, §7.3, §8.2, §15.1–§15.4 inline) | the four `[FIELD-NOW]` fields and the coordinate-space block | yes |
| `spatial-import-xenium/compute/boundaries.py:4` | §6.4, naming the blob `e55b16ef` | the long-table-plus-offsets invariant, quoted verbatim | yes — quote is exact |
| `spatial-import-xenium/compute/registration_qc.py:7` | §7.5, "verbatim" | the whole §7.5 paragraph as a block quote | yes — quote is exact, word for word |
| `_helpers/tests/test_visium_chain_compat.py:5` | §9 | the epic's central bet, and §9's four constraints one at a time | yes |
| `_helpers/tests/test_visium_chain_selectors.py:5` | §9 (and §6.1, §6.2) | the `subtypes_of` mechanism; the `vertex` axis blessing; the `extends` clause | yes — and §6.2 is the one clause the tree deliberately did not implement (§16.2) |
| `_helpers/tests/test_visium_chain_zero_src_app.py:5` | §10 | "§10 opens with the sentence this file exists to make" | yes — §10 opens *"For the Visium foundation: zero `src-app` changes."* |
| `_helpers/tests/visium_chain_fixtures.py:9` | §9 | that nothing in the chain special-cases spatial | yes |
| `server/tests/workstore/spatial_filter_vd_test.rs:3` | §9, fourth constraint | the one clause §9 refuses to assert, paraphrased rather than quoted on purpose (`lint-no-domain-in-builtin.mjs` scans `server/tests/**`) | yes |
| `ui/src/modules/workbench/extensions/data/productionRasterSeams.test.ts:6` | §10 | the §10 cost-table row for the three data-source methods | yes — the quote elides the `:1095-1097` line reference, which had already moved |
| `ui/tests/e2e/14-declarative-qc/spatial-capability-gate.spec.ts:5` | §14 | §14's per-item invariant for #159 | yes — the quote substitutes "the filter package's gated button" for §14's `cell-filter`'s `showSpatialBtn`, and marks the elision |
| `ui/tests/e2e/workstore/ome-tiff-range-read.spec.ts:11` | §2.4 | *"So a browser can read a slice of a multi-GB artifact without materializing it."* | yes — exact |
| `libs/viz/src/viz-core/spatial/omeTiffUnderlay.ts:18,55` | §2.4 | the same sentence, as the invariant forbidding a level-0 read | yes — exact |
| `libs/viz/src/viz-core/data/streamingSource.ts:152` | §2.4 | the whole-object read §2.4 exists to prevent | yes |

Cited **by section number alone**, in files whose only design-doc reference is this one: §2, §2.4,
§3, §5, §6.1, §6.2, §6.3, §6.4, §6.5, §6.6, §6.7, §7.2, §7.3 (including "rule 3" and "rule 5"),
§7.4, §7.5, §8.1, §8.2, §8.3, §9, §10, §11, §12.2, §12.3, §14, §15, §15.0, §15.1, §15.2, §15.3,
§15.4, §15.5. **Every one of them resolves in the restored text**, with two exceptions and one
caveat:

1. **`spatial-import-visium/tests/test_spatial_image.py:90` cites "§12.2 item 1"** for the rule
   that forces OME-TIFF over OME-Zarr. Under the `§12.<n>` convention the rest of the tree uses
   (and this document's own §2.3 uses), `§12.2` is the *affine* weakness; the OME-TIFF rule is
   `§12.1`, i.e. item **1**. The citation's two halves point at different weaknesses. The
   surrounding prose is unambiguously about the OME-TIFF rule, so the intended target is §12.1.
   **Recorded, not repaired (#356)** — repairing it is a code edit, and this branch is
   documentation only. `test_sandbox_reachability.py:252`'s "§12.2 item 2" is self-consistent
   and correct.
2. **`spatial-import-xenium/compute/boundaries.py:5-6` cites `spatial-types/manifest.yaml:386-422`**
   as where §6.4's declaration half landed. `spatial/boundaries` is now at
   `manifest.yaml:446-482`. A drifted line range, not a missing section (#356).
3. **The caveat: `file:line` citations inside §0–§15 are as of the spike and most have moved.**
   Spot-checked at `4b63a482`: `cyto_zarr.py:495`'s rank rule still lands; `conformance.py:946`'s
   `_NODE_META = "zarr.json"` (§15.5) still lands exactly; `sandbox/outputs.rs:198,201`'s
   `MAX_OUTPUTS = 512` / `MAX_MANIFEST_BYTES = 1 MiB` (§6.6) still land. `conformance.py:1705-1712`
   (§0.3, §3, §12.1) is now `_bytes_are_not_a_store` at `conformance.py:1623`;
   `embedding/compute/_shared.py:320-323` (§1) is now `:392`;
   `workbenchDataSource.ts:800` (§0, §2.3) no longer exists in that form (§16.6). **Treat every
   line number in §0–§15 as a pointer to a symbol, not to a line.**

### 16.2 §6 — the declarations that shipped

The type model survived: no fourth `structure.kind`, zero core Rust, one pure-data package
(`packages/spatial-types/`, `version: 0.8.5`) whose `contributes.datatypes` is merged into the
registry at boot by `extensions/loader.rs` → `datatype/mod.rs::init`. Seven kinds are declared,
not six, and four details differ from §6.

| §6 proposed | shipped | note |
|---|---|---|
| `spatial/coordinates extends embedding` (§6.2) | **`extends: matrix`** | Not a change of mind: `lint_processor_package` builds its known-id set from the six universal roots plus the package's own ids, so a cross-package supertype is a **dangling `extends`** and the whole package is skipped. `matrix` is `embedding`'s own parent. The divergence is pinned by `_helpers/tests/test_visium_chain_selectors.py::test_the_shipped_coordinates_datatype_diverges_from_the_designs_extends_clause`, which names §6.2 in its own failure message. §6.2's *requirement* — that it must not extend `single-cell/expression` — holds either way, and the render path binds on the `plottable-xy` **capability**, which is what §6.2 identified as the load-bearing line. |
| `capabilities: [obs-aligned, plottable-xy, spatial-coordinates]` (§6.2) | `[obs-aligned, plottable-xy, spatial-coordinates, spatial]` | `has:spatial` is an exact-token test (`runtime/expr.ts::hasCapability` over `runtime/caps.ts::deriveCaps`), so the marker name alone would not satisfy `cell-filter`'s already-shipped panes. Both are declared. |
| `spatial/image` / `spatial/labels` carry `capabilities: [spatial-image] / [spatial-labels]` (§6.3) | **no `capabilities` key at all** | The omission is load-bearing (INV-7): `has:spatial/image` already resolves through the id-and-ancestry half of `deriveCaps`. |
| `spatial/image ingest.extensions: [ome.tif, ome.tiff, tif, tiff]` (§6.3) | `[tif, tiff]` | `datatype/sniff.rs`'s `extension_of` uses `rsplit_once('.')`, so a two-segment entry can never match. |
| `spatial/boundaries capabilities: [spatial-geometry]` (§6.4) | `[spatial-boundaries, spatial]` | §15.0's rename carried into the capability name. The `arrays` block shipped as designed: `vertex` axis, `entity_index` i64, `x`/`y` f32. |
| `spatial/transcripts` + the `transcript` axis (§6.5) | **not declared** | Deferred by owner decision (#164, open). `manifest.yaml:22-33` records the four reasons and that §6.5 "stands as recorded intent". The raw `transcripts.parquet` stays in the retained vendor bundle. |
| one bundle container, `spatial/visium-bundle` (§6.7) | three: `spatial/visium-bundle`, `spatial/xenium-bundle`, `spatial/visium-hd-bundle` | all `extends: data/opaque`, `capabilities: [mtx-trio-target, spatial-bundle-target]` |

**§6.7's Visium HD conclusion is now false, and that is a fix rather than a drift.** §6.7 and
§13 both record that member matching is basename-only (`normalize_member_name`), so
`binned_outputs/` could never group. #160 replaced it with `member_path_segments` +
suffix-anchored matching: a member declaring *K* separators matches the candidate's last *K+1*
normalized segments. `spatial/visium-hd-bundle` accordingly declares twelve members at two
depths (`square_002um/filtered_feature_bc_matrix.h5`,
`square_002um/spatial/tissue_positions.parquet`, …). **HD is uploadable and declared; it has no
import processor** — that residue is #313.

**§6.6 understated the mechanism.** §6.6 puts the coordinate-space block in the output entry's
`meta`. It ships in **two** channels, because `meta` is invisible inside a sandbox:

* **Zarr kinds** (`spatial/coordinates`, `spatial/boundaries`) — `mirror_declarations_into_store`
  stamps the block into `<store>/zarr.json` → `attributes.cyto.cyto_spatial`, tagged
  `declares: "cyto-spatial/1"`. `conformance._conform_group_attributes` then re-reads it off the
  store and condemns the artifact unless it equals the manifest row's `structure`, so the two
  copies cannot drift.
* **`opaque` kinds** (`spatial/image`) — `encode_placement` writes
  `"cyto-spatial/1 " + <compact JSON>` into the OME `Image/Description`; `decode_placement`
  returns a typed unknown-version marker rather than guessing at a foreign token.

The block's key set is also wider than §6.6's four keys. It is closed, and it is:
`coordinate_space`, `unit`, `to_space`, `extent`, `microns_per_pixel`,
`microns_per_pixel_source`, `coordinate_space_source`, plus the four `[FIELD-NOW]` blocks
`measured_entity`, `measured_entity_label`, `positioning`, `section`, and the optional
`z_column`. `microns_per_pixel` is the addition §6.6 could not have known it needed: a `pixel`
space carries no scale, so a neighbour-graph radius "in microns" would be a radius in an
arbitrary unit. It is **refused** on a `micrometre` space rather than defaulted.

`§15`'s four fields shipped intact and are enforced as refusals, never defaults —
`measured_entity.kind` is closed to `spot|bin|bead|cell|nucleus`, `resolution_um` is required for
`spot|bin|bead` and a `segmentation` block for `cell|nucleus`; `positioning.partial` must be an
explicit bool; `section` refuses `affine`/`transform`/`to_section`/`to_volume`/`registration`/`warp`
**by name**, which is §15.4's "deliberately NOT designed now" made executable. §15.2's always-2-D
rule is enforced in the writer: `write_spatial_coordinates` refuses `ndim != 2` and
`shape[1] != 2` before calling `cyto_columns.write_embedding`.

**Coordinate-space identity is literal, never hashed** — §12.3 predicted this and it is what
shipped. Visium: `f"visium:{library_id}"`, falling back to the bundle directory name. Xenium: a
three-rung ladder — `roi_uuid`, then `slide_id`+`region_name`, then a value derived from the run's
own cell ids and centroids — with the rung that produced it travelling beside it as
`coordinate_space_source`. §12.3's "producer discipline, not an invariant" is exactly the posture,
and #327/#328 are the open residues of it.

### 16.3 §7 — the importers that shipped, and the real on-disk layout

Two analyses ship: `spatial.import-visium` (`spatial-import-visium` v0.12.1) and
`spatial.import-xenium` (`spatial-import-xenium` v0.9.8). Both take exactly one bundle slot, both
are launchable rather than `trigger: on-ingest` (§7.2's reasoning, preserved as DEC-1), and
neither uses `spatialdata-io` or `squidpy` — see §16.6.

Neither importer touches AnnData at all, so §2.2's `obsm['spatial']` framing does not apply to
this path: the readers are `h5py` over `/matrix/*`, `csv`, and `pyarrow.parquet`.

**The layout, as emitted** (relative to the job's `/outputs`; two asymmetries a diagram must not
smooth over — only the two Zarr kinds live under `spatial/`, and the images and overlay sit at
the root):

```
Visium                                     Xenium
manifest.json                              manifest.json
expression.zarr/            counts         expression.zarr/            counts
axis/{barcode,gene_id,gene_symbol}.zarr/   axis/{cell_id,gene_id,gene_symbol,feature_type}.zarr/
spatial/coordinates.zarr/   coordinates    spatial/coordinates.zarr/   coordinates
  zarr.json  (cyto_spatial)                  zarr.json  (cyto_spatial)
  coordinates/  f32 (n,2) px                  coordinates/  f32 (n,2) µm
                                           spatial/boundaries.zarr/    boundaries (axis: vertex)
                                             entity_index/ i64, x/ f32, y/ f32
metadata/*.zarr/            columns        metadata/*.zarr/            columns
                                           metadata/boundary_vertex_{start,count}.zarr/  i64, axis cells
spatial-image-hires.ome.tif   image        spatial-image-morphology.ome.tif   image
spatial-image-lowres.ome.tif  image        spatial-image-morphology-registration-overlay.png
visium-import-report.json     report/qc    xenium-import-report.json   report/qc
visium-import-summary.html    report/html  xenium-import-summary.html  report/html
run-environment.json          report/qc    run-environment.json        report/qc
```

The container is `spatial/coordinates.zarr` — a Zarr v3 group directory — and its array member is
named **`coordinates`**. That name is load-bearing and is the subject of a live defect: the
gathered-artifact path hardcodes `column_selector: "values"` (`virtual_dataset.rs`), so a
post-filter read of the shipped coordinates artifact names a member the store does not have
(#203/#211). §9's fourth constraint is what sent someone to look; see §16.6.

**§7.3's five rules all shipped, including the trap it named.** Coordinates are stored in the
full-resolution frame with `to_space = identity`; each image declares the **inverse** scalefactor
(`ome_writer.inverse_scalefactor_affine(s) → [1/s, 0, 0, 0, 1/s, 0]`, whose docstring quotes
§7.3's "a one-line difference that is wrong for a year if nobody writes it down" against the
in-tree forward-direction `visium_affine`); the row/column transpose is explicit; and the
non-square fixture §7.3 rule 5 demands is committed (7000 × 9000). Two things §7.3 did not
anticipate: the affine has **no translation term** (corner anchoring, argued in
`emitted_affine`), and `microns_per_pixel` on an image block is the **space's** scale, not the
image's own pixel pitch, so three artifacts in one space cannot disagree by a factor of five.
`spot_diameter_fullres` rides in `meta` **only when the vendor states it** — absence stays absence,
which is stricter than §7.3 rule 4's unconditional phrasing.

**§7.5's overlay shipped twice, and the two are not the same shape.** §7.5 says "a rendered
overlay in the `report/qc`".

* **Visium (#156)** renders it into `visium-import-summary.html` as a `data:` URI and puts the
  verdict lines in artifact `meta`. It is **not** an artifact, deliberately: `produces` and the
  output count are unchanged, and — the importer's own words — this application does not render
  `report/html`, so an overlay that lived only there would be "an image nobody opens". Two
  referents: the slide's manufactured 100 µm spot pitch, and the spots read back through the
  emitted artifact's own OME-XML scored against the vendor's `in_tissue` by Youden's J.
* **Xenium (#301)** emits it as its own `report/qc` artifact,
  `spatial-image-morphology-registration-overlay.png`, because of that same observation.
  It cannot use either Visium referent (no capture array, no `in_tissue` flag), so it scores a
  `signal_lift` of cell centres against a pixel-derived signal mask, where 0 is chance. Measured
  on the package's two real vendor bundles: 0.608 / 0.536 for the declared placement, 0.000 for a
  transpose. Both refuse to raise into the import; `not-evaluated` is a third verdict distinct
  from `pass` and `fail`.

§7.4's provenance shipped as designed, and its `[shared]` blocker (#77) is still the reason it
lives in `meta` and the report rather than in the methods narration.

### 16.4 The OME-TIFF layout — what §6.3 left unspecified

§6.3 decided the *format*. The bytes were decided later (#227, #176, #158, #259, #322) and are
recorded in full in `docs/design/ome-tiff-tile-layout.md`, `ome-tiff-dtype-refusal.md`,
`ome-tiff-sample-classification.md` and `ome-tiff-reader-sample-counts.md`. The short form, read
out of `spatial-types/compute/ome_writer.py` and confirmed against the committed fixtures:

* **Tiled 512 × 512 at every pyramid level** (`TILE = (512, 512)`, passed at every
  `writer.write` call site). Never `rowsperstrip`: a strip is full image width by construction,
  so a viewport tile would cost the whole width of the image every time. A file tiled at level 0
  and not below it would report a different layout per level, so a consumer would have to branch
  per level to read one image.
* **deflate** (`CODEC = "deflate"`; stdlib `zlib`, so `imagecodecs` is not a Visium dependency),
  dtype passed through unchanged and refused outright if it is not OME-expressible, photometric
  `rgb` for 3 or 4 samples and `minisblack` otherwise.
* **Levels are subIFDs, not top-level IFDs** — `subifds=len(levels) or None` on the base write,
  `subfiletype=1` on each level. Halving by box mean (not decimation, and `np.rint`-rounded for
  integer dtypes) while the next level's shorter side stays ≥ 256; a source already under 256
  yields a legal single-level file with no `SubIFDs` tag.
* **BigTIFF above 2 GiB** of total pixel payload — 2 rather than 4 as headroom, because classic
  TIFF overflow writes corrupt offsets rather than erroring.
* **OME-XML** carries only what tifffile derives plus two things the writer sets:
  `Image/Description` = the `cyto-spatial/1` placement payload, and `PhysicalSizeX/Y` in µm,
  which must equal the display derivative's `applied_resolution_um`. `DimensionOrder` is
  tifffile's `XYCZT`; `SizeZ` and `SizeT` are 1; there is no `PhysicalSizeZ`.
* **The image is a display derivative** (#176): downsampled by an integer box mean to a 0.5 µm/px
  cap, lossless, with an `is_display_derivative` provenance block naming the original resolution,
  extent, source and writer version. The original is referenced, never re-encoded.

**The reader** (`libs/viz/src/viz-core/spatial/omeTiffPyramid.ts`) walks IFD 0 plus each
`SubIFDs` offset, refuses more than one top-level IFD, and validates every level against level 0
for codec, sample layout and dtype before `assertHalvingPyramid`. It bypasses Viv's own
`loadOmeTiff` and implements the byte source itself so that **one tile is one ranged read** in the
cacheable `?range=` dialect. `byteLength` is supplied rather than discovered, because that dialect
answers an over-long span with a 416 and the pyramid's level directories live in the file's tail.
The single-texture fallback (`omeTiffUnderlay.ts`) takes the **coarsest** level and, because
"coarsest" is relative to a writer's choice of depth, backs it with an absolute
`MAX_UNDERLAY_PIXELS = 4,194,304` over which it **refuses** rather than degrading — with a
distinct error class, because folding it into "cannot be opened" once withdrew the raster view
from the one case tiling exists for.

**Measured, not restated.** Re-derived here with `tifffile` from the committed fixtures under
`libs/viz/src/viz-core/spatial/fixtures/`:

| fixture | bytes | W×H | levels | intra-level layout |
|---|---|---|---|---|
| `spatial-image-hires.ome.tif` | 166,838 | 1400×1800 uint8 ×3 | 3 (→700×900→350×450) | tiles 512², 12 / 4 / 1 |
| `spatial-image-hires-stripped.ome.tif` | 167,778 | 1400×1800 uint8 ×3 | 3 | stripped, `RowsPerStrip` 62 / 124 / 249, 30 / 8 / 2 |
| `spatial-image-greyscale.ome.tif` | 18,031 | 768×1024 uint16 ×1 | 2 | tiles 512² |
| `spatial-image-lowres.ome.tif` | 13,517 | 420×540 uint8 ×3 | 1 (no `SubIFDs`) | tiles 512² |

Only those four are shipped-writer output; the rest of the corpus is deliberate negative
fixtures, including `third-party-stripped.ome.tif`, which Pillow's bundled libtiff wrote and the
reader decodes successfully. `tiled-deflate.ome.tif` uses 256² tiles and is **not** writer output —
do not read "the tile size in the corpus" off it.

**#158's wire measurement, and why the number in this document is nine.** A single 512×512
level-0 tile cost **14 ranged GETs, 41,891 of 167,778 bytes** against the pre-#227 stripped
artifact. Five of those GETs are the open (5,508 B); the remainder is the 512-row band, which
spans **nine** full-width strips totalling 36,383 B. Nine is forced geometrically — eight strips
of 62 rows cover only 496 of the 512 rows needed — and `spatial-types/tests/test_wire_measurement_strip_count.py`
derives it every run from the fixture's own `RowsPerStrip` / `StripByteCounts` tags and the
producer's own `TILE` constant, rather than comparing against a literal. I re-ran that derivation
here: bands at y=0, 512 and 1024 each span 9 strips (36,383 / 36,390 / 36,444 B). The count is
**9**. An earlier generation of this claim said ten across six files; #259 corrected it and #321
closed the last of them. Note the qualifier the guard itself carries: bands are **tile-grid
aligned**, and a 512-row band at an arbitrary offset can span ten — nine is the span of the reads
a grid-aligned viewer actually issues. `docs/design/ome-tiff-tile-layout.md` §2 is the document
that owns this correction; do not restate the retired wording anywhere, including here.

Post-#227, the same transaction costs **16,568 bytes over 6 GETs** — 5,508 to open, then 11,060
in **one** GET for the tile, 9.9 % of the 166,838-byte object.

**One live inconsistency, recorded rather than fixed (#357):** `ome_writer.py`'s comment corpus pins its
`tifffile.py:NNNN` citations and its dtype-table mirror to tifffile **2025.5.10** (also the
`Creator` of every committed fixture), while `env-rootfs/single-cell/requirements.txt` pins
**2026.3.3** in the runtime rootfs. The `except tifffile.OmeXmlError` backstop exists for exactly
this drift, but the prose documents a version the rootfs does not run.

### 16.5 §8 — the measured limits, re-measured

§8.1's table is mostly intact at `4b63a482`. **One row is materially wrong and its consequence
propagates:**

| §8.1 row | §8.1 said | at `4b63a482` |
|---|---|---|
| `RLIMIT_FSIZE` inside the sandbox | **2 GiB per file** | **64 GiB** — raised in `bf3db41c` ("promote the upload ceilings to admin settings; raise fsize default"); validated range unchanged at 1 MiB … 256 GiB |
| sandbox memory | 8 GiB | 8 GiB for the **batch** class only; interactive and normal are **4 GiB**. Address space is 64 GiB, as stated |
| upload body limit | 64 GiB, `dataset/routes.rs:55` | 64 GiB, but promoted to the admin setting `max_output_file_bytes`'s neighbour `max_upload_body_bytes` in `workstore/settings.rs`; the old `const` is retired |
| max output file / multi-file total / outputs per run / manifest bytes / staging timeout / multipart | 8 GiB / 32 GiB / 512 / 1 MiB / 900 s / 16 MiB threshold, 8 MiB parts | all unchanged, and §6.6's derived ~2 KiB per manifest entry still follows |

**What the `RLIMIT_FSIZE` change does to §8.2.** §8.2's second design consequence is written as
"`RLIMIT_FSIZE = 2 GiB` is a per-FILE cap … and sharding saves us". The cap is no longer 2 GiB, so
the *argument* is obsolete even though the *conclusion* (a transcript table is writable) still
holds, more easily. §8.2's first and third consequences are unaffected. §8.3's Xenium envelope is
correspondingly less tight than it reads — and #161, the item §8.3 asked for, is closed.

§8.2's split verdict — browser yes, sandbox no — is still the shape of the system, but the browser
half has moved from "the transport is there, the readers are not" to "both are there": see §16.6.

### 16.6 §2, §10, §13, §14 — the front end, the shared items, and the DAG

**§0's headline is retired.** §0 and §2.3 say the front end is "built and unfed": `hasImage` a
hardcoded `false`, `imageUnderlay()` throwing. Neither is true. `hasImage` is now
`hasImage: openedRaster` and `imageUnderlay()` returns for a project with a raster and refuses
only for one without; `imagePixelSource()` ships beside it, forwarded through
`asDataSource(WorkbenchStreamingSource)` — which is the object production actually hands the grid,
and the trap `productionRasterSeams.test.ts` was written about. #158 (the loader §10 called "the
single largest FE item") and #159 both closed. `has:spatial` is satisfiable and
`cell-filter`'s panes light, asserted end to end in a real browser by
`spatial-capability-gate.spec.ts`.

**§0.2's magnitude has moved.** `libs/viz/src/viz-core/spatial/` was 33 files / 6,749 lines when
the spike was written. At `4b63a482` it is **72 files / 16,797 lines**.

**§13's shared table, re-checked:**

* **#80 / `spatialdata-io`** — no longer on the critical path. The Xenium importer is hand-rolled
  over `h5py` / `csv` / `pyarrow.parquet` / `tifffile`; `spatialdata_io` is imported nowhere.
* **§2.6 still holds**: `squidpy` and `spatialdata` are installed in the `single-cell` rootfs and
  **zero packages import them**. `tifffile` and `imagecodecs`, by contrast, are now genuinely
  consumed — #264 tracks the requirements file still calling them unconsumed.
* **Visium HD member matching** — closed by #160; see §16.2. The row is stale.
* **The raster/mask data-source seam** — closed by #159, except the third method: §10 names three
  and #159 shipped two. `imageLabelMask()` is unbuilt, because no producer emits a
  `spatial/labels` artifact yet.
* **Point rendering at scale (#165)** and the **`raster` structure (#166)** are still open, exactly
  as §13 and §14 predicted, and #164 (transcripts) is open with them.

**§14's DAG, resolved:** #152, #153, #154, #155, #156, #157, #158, #159, #160, #161, #162, #163
are **closed**; #164, #165, #166 and the epic #151 are **open**, as is #175 (the non-goals
register §15's refusals were folded into). §14's per-item invariants were largely kept as written
— #163's "for every entity, `[start, start+count)` reproduces the vendor's polygon" is what
`boundaries.py` implements, with `(start, count)` chosen over a cumulative `indptr` so that a
filtered subset of the cells axis still names the right vertices.

**§9's fourth constraint, answered.** §9 refuses to assert whether `cell.filter` re-emits or
merely invalidates obs-aligned siblings, and files it. The answer, measured by
`server/tests/workstore/spatial_filter_vd_test.rs`: **neither, and not in the compute at all.**
The filter's compute emits a keep-mask and a report and nothing else; the carrying happens
server-side in `create_filter_vd_for_run`, which mints one gathered row per usable artifact. And
because `gathered_structure` hardcodes `column_selector: "values"` while the importer's member is
named `coordinates`, the shipped Visium artifact fails **loudly** rather than serving wrong
numbers — which is a materially better outcome than #203's headline describes. #203 and #211 are
the open items.

**§9's central bet held.** The five-analysis chain (`qc.10x` → `cell.filter` →
`embedding.reduce` → `clustering.cluster` → `de.markers` / `de.compare`) runs on a real Visium
import at the shipped paths with no manifest or selector change, driven by
`_helpers/tests/visium_chain_fixtures.py`. The mechanism is the one §9 named: every consumer
selects `subtypes_of: single-cell/expression` and refuses on `structure.kind != "sparse_csc"`, and
a spatially-imported matrix satisfies both. **And no shipped downstream analysis consumes
`spatial/coordinates`, `spatial/image` or `spatial/boundaries`** — the tissue map reaches a user
through the viz path, not through an analysis slot.

### 16.7 Still open, and found while restoring this document

* **#164 / #165 / #166** — transcripts, point rendering at scale, and the `raster` structure.
  §6.5 and §8.3 remain the design of record for all three.
* **#313** — Visium HD is uploadable and declared and has no import processor.
* **#203 / #211** — the gathered-artifact `column_selector` hardcodes `values`; the coordinates
  member is `coordinates`.
* **#327 / #328** — the residues of §12.3's "`coordinate_space` is a convention": a placeholder
  library id becomes the frame, and `f"xenium:{slide}_{region}"` is not injective.
* **#318** — §15.4's `section()` can express neither an absent `sample_id` nor a
  `sample_id_source`.
* **Found while restoring this document, and filed rather than fixed here** — this branch is
  documentation only, and `spatial-types`, `spatial-import-visium` and `spatial-import-xenium`
  are owned by sibling branches:
  * **#355** — no gate checks that a `docs/design/*` path cited in the tree actually exists.
    This is the check #315 itself asked for, and the reason #315 was found by hand months after
    the first dangling citation shipped.
  * **#356** — the two mis-pointed citations §16.1 records: `test_spatial_image.py:90`'s
    `§12.2 item 1`, and `boundaries.py`'s `manifest.yaml:386-422`, now `:446-482`.
  * **#357** — `ome_writer.py`'s comment corpus, and its mirror of tifffile's OME-expressible
    dtype table, are pinned to **2025.5.10** while the rootfs runs **2026.3.3**.
