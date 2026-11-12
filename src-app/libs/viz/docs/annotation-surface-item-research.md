# Per-Item Research — annotation-surface (grounding for every ITEM)

Deep per-item research (seven parallel streams, each reading the code + external
prior art) for the view+annotation EDITOR. **Required reading** for the implementer
and the Phase-6 audit: each ITEM below carries its chosen APPROACH, the PERFORMANCE
technique that makes it viable at gigapixel / millions-of-cells scale, the MODULARITY
boundary, the GROUNDING (invariants + research findings + sources + the exact code to
reuse), and the acceptance-test shape. The editor runs NO AI (INV-3).

Companion docs: `annotation-surface.md` (design + invariants), `annotation-surface-research.md`
(the F-* evidence base).

---

## Cross-cutting decisions (settled by the research)

- **DEC-A · Editable geometry = HAND-ROLL on the existing gesture core; do NOT adopt
  `@deck.gl-community/editable-layers`.** Its published ceiling is ~100K features, it
  re-tessellates the whole `FeatureCollection` per drag, has no WebGPU path, and is
  self-described "semi-maintained." `selection/{areaGestures,SelectionController,useAreaSelection}`
  is already ~80% of the draft→commit→reshape lifecycle. **No new editable-layers dep.**
- **DEC-B · Two-tier rendering.** A static, viewport-culled (flatbush over per-feature
  bboxes) binary `SolidPolygonLayer`/`PathLayer`/`ScatterplotLayer` for the *many*
  committed annotations + a tiny isolated edit layer for the *few* features in flight;
  a **label-mask raster fallback** (`LabelMaskLayer`) below the zoom where polygons go
  sub-pixel. This is what keeps per-frame cost ∝ visible features, not total.
- **DEC-C · State = `defineLocalStore` per image cell** (fresh `createStore()` +
  per-instance EventBus group), wrapped in a per-cell context mirroring `vizStores.ts`.
  **Undo = Immer `produceWithPatches` patch/inverse stack** (O(diff), bounded FIFO) —
  NOT snapshots (O(collection) memory). Drag-coalescing falls out of commit-on-`pointerup`.
- **DEC-D · Mask correction = pure `maskEdit.ts` + a dirty-rect sub-upload** (luma.gl
  `copyImageData`) replacing `LabelMaskLayer.updateState`'s full-texture rebuild.
  Widen the editable label raster to **`Uint32Array`** (Uint16 caps at 65535 ids).
- **DEC-E · Processor seam = a typed `ProcessorPort` PORT, not a coupling.** The editor
  exposes it; it depends on nothing of any processor. Committed results are
  indistinguishable from hand-drawn (undo/reshape/export/link all apply).
- **DEC-F · Linking routes through `Coordination.store`** (Vitessce readable-scope) — no
  new bus. region→scatter is half-built; add the scatter→tissue consume leg + a
  label-mask highlight LUT + expose `*InSpace` on the coordination handle.
- **DEC-G · Coordinates = one `coords.ts` facade** built on `data/image.ts` affines, with
  a new **`invertAffine`** primitive; isolates the NGFF RFC-5-volatile transform layer.
- **DEC-H · Sequencing:** the P1 authoring store (ITEM-3/5) must land BEFORE the processor
  commit-side (ITEM-8 write) — the "indistinguishable-from-hand-drawn" guarantee needs the
  shared write target. ITEM-8's read side + pending can land independently.
- **Shared new cell seam:** `GridCell` gains a resolved `loader: PixelSource[]` +
  `channels: RasterChannelState[]` (+ optional `colormap`), fed by `DataSource.imagePixelSource()`.

---

## P0 — Render + view API

### ITEM-1 — Wire `ImageAdapter` → Viv multiscale, composed into the shared deck
- **Approach**: extract `RasterImageView`'s layer memo into a pure `buildRasterImageLayers({loader,channels,modelMatrix,cellId})` → `MultiscaleImageLayer` (loader.length>1) else `ImageLayer`; the `image`-cell branch calls it and **replaces the flat single-tile `BitmapLayer`** (`GridWorkspace.tsx:1966-1984`), direct-emitting into the ONE shared `<DeckGL>` (`:3490-3509`) via the `cellScatterLayerId`+`buildScatterProps` pattern (`:2056-2078`) — **not** `chartLayerSink` (dense cells don't use it). Add a storage-agnostic `DataSource.imagePixelSource(): Promise<PixelSource[]>` seam. Reject: a 2nd `<DeckGL>` per cell (second WebGL context, breaks link-zoom); the mega-texture (4096² cap).
- **Performance**: 100k×100k slide ≫ the GPU single-texture cap → `MultiscaleImageLayer` (deck `TileLayer`): LOD level ≈ 1 screen-px, viewport tile culling, LRU evict, `AbortSignal` cancels stale tiles, GPU additive composite. Per render O(visible tiles), size-independent.
- **Modularity**: consumes ONLY Viv `PixelSource`; no backend/storage import (INV-1); builds on `InMemoryPixelSource` fixture (INV-2); does not couple to the annotation model or read coordination directly (the grid threads it in, as for scatter).
- **Grounding**: INV-1, INV-2, INV-4; F-CODE-1/5/6, F-FMT-1/3, F-GAP-2. Reuse: `GridWorkspace.tsx:1966-1984` (replace site) / `:2056-2078` / `:2735-2738` / `:3490-3509`, `layers/multiView.ts:73-93`, `spatial/RasterImageView.tsx:123-157` (extract) + `:106-117` (camera-fit to reconcile with the grid's CONTROLLED viewState), `spatial/imageMeta.ts:parseMultiscales/imageModelMatrix`, `spatial/imageFixture.ts:InMemoryPixelSource`, `data/wire.ts:DataSource`. Viv `getDefaultInitialViewState` is a `@hms-dbmi/viv` export (net-new import), NOT in-repo. Sources: [Viv README (4096² cap, MultiscaleImageLayer)](https://github.com/hms-dbmi/viv), [PixelSource type](https://github.com/hms-dbmi/viv/blob/main/packages/types/src/index.d.ts), [deck.gl TileLayer](https://deck.gl/docs/api-reference/geo-layers/tile-layer).
- **Acceptance**: unit — builder returns `MultiscaleImageLayer` iff loader.length>1, props 1:1 to channels, id=`cellLayerId(cellId,'image')`; gallery-runtime — image cell renders on the SINGLE shared `<DeckGL>` (no 2nd canvas) and pans/zooms with shared viewState; two image cells side-by-side render independently.

### ITEM-2 — Channel / contrast / colormap controls in the pane edit form
- **Approach**: reuse Viv's `RasterChannelState {name,color,contrastLimits,visible}` (+ optional single `colormap` via `AdditiveColormapExtension`, mutually exclusive with per-channel colors). LIFT channel editing out of `RasterImageView`'s inline panel INTO `PaneEditForm` as a new `Channels` `Section` (PaneEditForm contract = edits in the form, WYSIWYG-for-export), wired to the per-cell channel store (§5). Controls: `Switch` (visible), color input (mirror `Categories` swatch), `Slider`×2 (contrast, max=`contrastMax`), `Select` (colormap), `Auto`→Viv `getChannelStats`. Reject: keep inline (breaks WYSIWYG); reuse `data/color.ts:CONTINUOUS_COLORMAPS` directly (those are scatter/heatmap value scales, a parallel vocabulary).
- **Performance**: contrast/color/visibility are **XRLayer shader uniforms** — `updateTriggers` re-composite on the GPU, **no tile refetch** → a slider drag is O(visible tiles), commits LIVE. `Auto`/`getChannelStats` runs on a LOW-RES level (few hundred KB), never full-res.
- **Modularity**: presentational — every edit a callback the grid wires (CODING §12); consumes only the Viv channel model; no PixelSource/backend/coordination/annotation import; per-cell state (two cells' sliders independent).
- **Grounding**: INV-1, INV-2, INV-3 (pure view-manip, no inference). F-CODE-1, F-FMT-1. Reuse: `controls/PaneEditForm.tsx` (`Section`/`Switch`/`Slider`/`Select` + swatch `:441-491`), `spatial/RasterImageView.tsx:32-39` (`RasterChannelState`) + `:159-247` (inline panel lifted). Sources: [Viv types (contrastLimits/colors, ColorPalette vs AdditiveColormap)](https://github.com/hms-dbmi/viv/blob/main/packages/types/src/index.d.ts), [Avivator autocontrast/getChannelStats](https://github.com/hms-dbmi/viv).
- **Acceptance**: unit — toggling visible/color/contrast calls back with the patched channel + re-aligns layer props; `Auto` sets contrastLimits from `getChannelStats`; gallery/e2e — Channels section shows, a contrast drag updates render with NO refetch, per-cell isolation, every control has a WCAG name.

## P1 — Annotation authoring

### ITEM-3 — Editable vector overlay (draw/select/reshape polygons + points)
- **Approach**: HAND-ROLL (DEC-A). Two-tier (DEC-B): static display tier (binary `SolidPolygonLayer`+`PathLayer`+`ScatterplotLayer`, `_normalize:false`/`_validate:false`, built once) + a tiny edit tier (edges + draggable vertex/midpoint handles + draft polygon) for only the feature under edit. New pure `AnnotationController` (mirrors `SelectionController`, adds `insertVertex`/`moveVertex`/`deleteVertex` + redo) + `useAnnotationEditor` (mirrors `useAreaSelection`) + `buildAnnotationLayers()` (host composes into the shared deck).
- **Performance**: failure = one polygon layer over millions = multi-second main-thread earcut + giant buffer per change. Fix: build static tier once (binary); viewport-cull via a **flatbush** over per-feature bboxes (immutable analog of `pointIndex.ts`); isolate re-tessellation to the ONE edited feature; mask-raster fallback below sub-pixel zoom (`LabelMaskLayer`). Cull O(log F + v); edit O(verts of one feature)/frame.
- **Modularity**: `viz-core/annotate/` exposes pure `annotationGestures.ts` + `AnnotationController` (node-testable) + `useAnnotationEditor` + `buildAnnotationLayers()` + `geojson.ts`. MUST NOT couple to PixelSource/backend (INV-1/2), AI (INV-3), or another module's store (cross-view via the `Coordination` seam). Full-res/physical world coords (INV-4). Composes into the shared deck (no parallel deck).
- **Grounding**: INV-2/4/5/6/7; F-CODE-1/2/3/7, F-GAP-3, F-FMT-2/3. Reuse: `selection/areaGestures.ts:hitTestTopmostArea/translateArea`, `selection/SelectionController.ts:applyArea/updateArea/undo`, `selection/useAreaSelection.tsx:finishPolygon/buildSelectionOutlineLayer/RECOMPUTE_DEBOUNCE_MS`, `spatial/pointIndex.ts` (KD-tree cache), `spatial/imageTiles.ts:selectImageTiles` (cull pattern), `spatial/LabelMaskLayer.ts` (fallback). Sources: [editable-layers (semi-maintained, 100K ceiling, no WebGPU)](https://visgl.github.io/deck.gl-community/docs/modules/editable-layers), [SolidPolygonLayer `_normalize`/`_validate`](https://deck.gl/docs/api-reference/layers/solid-polygon-layer), [PolygonLayer perf #4245](https://github.com/visgl/deck.gl/issues/4245).
- **Acceptance**: pure node-vitest (mirror `regionSelect.test.ts`) for insert/move/delete rings, topmost hit, snap; GeoJSON round-trip (INV-7); e2e draws→reshapes + asserts only-visible-features in the layer at scale + mask-fallback swap at low zoom.

### ITEM-4 — Brush / freehand region tool
- **Approach**: HAND-ROLL, same tool vocabulary/controller as ITEM-3. Freehand lasso: capture path → unproject → **RDP-simplify** → close ring. Circular brush: stamp disks along the path into a scratch label bitmap → **marching-squares** boundary → RDP → ring (reuses `LabelMaskLayer`/`labelMaskColor`; IS the mask brush-fix path, INV-6). Reject: turf `buffer`+`union`/martinez clipping (bundle, overkill); nebula freehand (drags in the whole dep).
- **Performance**: failure = capture every pointer-move → thousand-vertex ring + per-frame preview re-tessellation. Fix: throttle to a min world-distance delta; preview raw path as a fill-less `PathLayer` (no tessellation) during drag; tessellate only the simplified ring at pointer-up; reuse the outline-realtime/mask-debounced split (`RECOMPUTE_DEBOUNCE_MS`). brush→mask cost ∝ brushed bbox, N-cell-independent.
- **Modularity**: pure `annotate/freehand.ts` + `annotate/brushRaster.ts` (dependency-free, node-testable like `regionSelect.ts`); no deck/react/backend coupling; one controller with ITEM-3.
- **Grounding**: INV-6/5/7/4; F-SEG-2, F-JTBD-1/-3#2, F-CODE-2. Reuse: `data/selection.ts:selectInPolygon/polygonBoundingBox`, `spatial/regionSelect.ts`, `selection/areaGestures.ts:combineMask`, `spatial/labelMaskColor.ts`. Sources: [nebula DrawPolygonByDragging (freehand prior art)](https://github.com/uber/nebula.gl/blob/master/modules/edit-modes/src/lib/draw-polygon-by-dragging-mode.ts), RDP/`simplify-js`.
- **Acceptance**: node-vitest — RDP reduces + is idempotent within tol; marching-squares of a known disk → expected ring; freehand ring → `selectRegion` selects the enclosed cells; brush-into-mask relabels expected texels; GeoJSON round-trip.

### ITEM-5 — Per-instance annotation store
- **Approach**: `defineLocalStore` (store-kit) `.use()` mints a fresh `createStore()` per mount + a `local:N` EventBus group; wrap each image cell in an `AnnotationStoreContext` provider mirroring `vizStores.ts:VizStoresProvider`. Store (`immer:true`): normalized `byId`+`ids`, `activeTool`, `activeClassId`, `selection`, undo/redo stacks; geometry as raw `Float64Array` kept OUTSIDE the Immer draft (swap ref on commit). Reject: flat array (O(N) scans), fully-mutable structs (forfeit cheap undo), global keyed-by-cellId map (couples lifecycle).
- **Performance**: failure = a store field a big subtree subscribes to written per `pointermove` → per-frame re-render. Fix (mirror `useAreaSelection.tsx`): draft geometry in a `useRef` (imperative), cheap preview layer reads the ref per frame, commit ONCE on `pointerup`; heavy recomputes on the 80ms debounce. Store writes O(1)/edit.
- **Modularity**: the per-instance boundary IS the `.use()`-minted store (fresh id space + undo stack + bus group). Exposes reactive reads + actions resolved from the instance's OWN `getState()` (`createLocalProxy`). Named pitfall: a reactive-read bridge that resolves actions from a singleton mutates the wrong instance — `defineLocalStore` binds both to the same per-mount api.
- **Grounding**: INV-2/3/4, §5; F-CODE-7/1/6. Reuse: `sdk/packages/framework/src/store-kit.ts:defineLocalStore/createLocalProxy`, `src-app/ui/src/modules/workbench/panes/jobsPaneStore.ts`, `adapter/vizStores.ts:VizStoresContext/Provider`, `Coordination.store.ts:createCoordinationStore` (factory idiom), `useAreaSelection.tsx` (imperative draft).
- **Acceptance**: draw→collection grows; relabel updates only that object; `$` snapshot round-trips to the seam; **two-instance no-leak** (mirror `vizStores.test.ts`): add in A → B `ids.length===0`; distinct api refs.

### ITEM-6 — Undo / redo
- **Approach**: Immer `produceWithPatches` → push `{patches,inverse}`; undo applies inverse, redo re-applies patches; bounded FIFO (~100–200), clear redo on new edit. Reject: full-snapshot Memento (O(collection)/entry memory), hand-written command closures (boilerplate; patches already serializable for session-save like `Coordination.store` serialize/hydrate).
- **Performance**: because the store writes once per gesture (ITEM-5), **drag-coalescing into ONE undo entry is automatic**; mergeable bursts (successive relabels) collapse via an upsert window. push/undo/redo O(patch size); memory O(Σ diffs, capped).
- **Modularity**: stacks live INSIDE the per-cell store (independent history per cell); exposes only `undo()/redo()/canUndo/canRedo`; patch stacks internal (optionally in the serialize slice).
- **Grounding**: INV-6, §5; F-SEG-2, F-JTBD-1/-3#2. Sources: [Immer patches/produceWithPatches](https://immerjs.github.io/immer/patches/), [Immer performance](https://immerjs.github.io/immer/performance/).
- **Acceptance**: create/reshape/delete/relabel each undo+redo correctly (deep-equal geometry; delete restores object+class+selection); **drag = single undo entry** (N moves then up → depth +1, store not written during move); bounded-history drops oldest + keeps pointer; processor-inject→undo restores pre-inject in one step; two-instance no-leak.

### ITEM-7 — GeoJSON import/export (lossless, QuPath-portable)
- **Approach**: RFC 7946 `FeatureCollection`; per Feature `id` (stable UUID), `geometry`, `properties` mirroring QuPath exactly — `objectType`, `name`, `classification:{name,color:[r,g,b]}`, `isLocked`, `measurements`, namespaced `txresbench:{}`. **Foreign-property passthrough** is the round-trip rule (retain any unmodeled key verbatim). Coords in full-res-pixel default (opt-in physical/micron), space in a top-level `txresbench:crs`. Normalize winding on export (RFC right-hand rule), permissive on import (geojson-rewind). Reject: WKT/TopoJSON, per-object files, level-pixel coords (violates INV-4), default precision-trimming.
- **Performance**: failure = one giant in-memory GeoJSON blob (~10⁵–10⁶ feature wall); mitigate: parse off-thread, keep the editable model as flat typed arrays (columnar-friendly → future GeoParquet is a serialization swap), default full-precision (lossless) with opt-in rounding. Scale-out past 10⁶ = GeoParquet + viewport-tiled + mask fallback (out of scope; not precluded).
- **Modularity**: touches coords through exactly ONE call surface (the ITEM-14 `fullRes↔physical` facade); never inline level math. Serializer knows only the canonical stored space.
- **Grounding**: INV-4, INV-7; F-FMT-2, F-GAP-3, F-JTBD-3#6. Reuse: new `annotate/geojson.ts` over `data/image.ts:Affine` + the ITEM-14 facade. Sources: [QuPath export (FeatureCollection, full-res px)](https://qupath.readthedocs.io/en/stable/docs/advanced/exporting_annotations.html), [classification{name,color:[r,g,b]}](https://andrewjanowczyk.com/exporting-and-re-importing-annotations-from-qupath-for-usage-in-machine-learning/), [RFC 7946 (winding §3.1.6, precision §11.2)](https://datatracker.ietf.org/doc/html/rfc7946), [SpatialData Shapes=GeoParquet](https://www.nature.com/articles/s41592-024-02212-x).
- **Acceptance**: a QuPath-authored fixture (polygon-with-hole, multipolygon, point, classified, foreign `measurements`) → import→export→re-import yields vertex-exact geometry + identical class/name/color/id/isLocked/foreign props (deep-equal); export normalizes winding while geometrically equivalent.

## P2 — Processor API seam (NO inference in the editor)

### ITEM-8 — Processor-facing API (commit result / read view+gesture)
- **Approach**: one typed `ProcessorPort` minted per instance by `createProcessorPort(stores)` (mirrors `createCoordinationHandle`/`VizController`). READ (snapshots, full-res coords): `getImageRef()`, `getViewState()` (target/zoom/bounds — Vitessce readable scope), `getActiveGesture(): {click|box|lasso}` (reuses the lasso→`selectRegion` path). WRITE: `commitPolygons`/`commitPoints`/`commitLabelMask` (→ `LabelMaskLayer` directly) + `setPending()` (DISPLAY state only, no inference — INV-3). Stateless-per-call. Reject: callback-push (inverts control), handing over stores/layers (leaks internals), one giant `applyResult` union, a global singleton.
- **Performance**: `commitLabelMask` = one texture upload (O(pixels) once, then in-shader). 100k polygons: packed typed arrays (flat coords + ring offsets) → deck layer + one KD-tree index (hit-test O(log N+k)); accept typed arrays by reference (zero-copy from a Worker/WASM). Above a size threshold, chunk-commit across `requestIdleCallback` + build-then-swap (like `VizController.applyOption`'s `optionSeq` guard).
- **Modularity**: a PORT not a coupling — exposes the interface + factory from the barrel; MUST NOT import AI/onnxruntime (INV-3) or backend (INV-1/2). Dependency arrow one-way. A committed result is indistinguishable from hand-drawn (undo/reshape/export/link apply) — napari's contract; `origin`/`groupId` update-by-id so a re-run replaces its prior output.
- **Grounding**: INV-2/3/4/5/6/7; F-SEG-1/3, F-CODE-2/3. Reuse: `adapter/coordinationHandle.ts:createCoordinationHandle`, `adapter/VizController.ts` (per-instance handle + staleness guard), `spatial/LabelMaskLayer.ts`, `spatial/regionSelect.ts:selectRegion`, `Coordination.store.ts:VizViewState`. Sources: [napari LayerDataTuple/plugin returns](https://napari.org/dev/plugins/building_a_plugin/guides.html), [Vitessce coordination](http://vitessce.io/docs/coordination/), [QuPath GeoJSON](https://qupath.readthedocs.io/en/stable/docs/advanced/exporting_annotations.html).
- **Acceptance**: `commitLabelMask(fixture)` → present in the store AND renders via `LabelMaskLayer`; `getViewState()`/`getActiveGesture()` return camera + a seeded lasso (byte-equal to `selectRegion`'s input); **no-AI guard** — the built editor bundle has no `onnxruntime`/model import.

### ITEM-9 — Gallery mock-processor fixture
- **Approach**: a ~40-line `MockProcessor` story consuming ONLY the public `ProcessorPort`; on a gesture, `getActiveGesture()`→`setPending`→ synthesize a canned result from `makeLabelMaskFixture`→`commit*`. Deterministic (seeded). Doubles as the perf harness (a "large result" knob: 4096² / 50k labels / 100k polygons).
- **Modularity**: lives in `showcase/stories/` (tree-shaken from the lib build); importing only the barrel is itself proof the seam is clean.
- **Grounding**: INV-2/3; F-CODE-6/2. Reuse: `showcase/stories/spatial-image.story.tsx`, `regionSelectFixture.ts`, `labelMaskFixture.ts:makeLabelMaskFixture`, `showcase/registry.ts`. Sources: [napari plugin templates](https://napari.org/dev/plugins/building_a_plugin/guides.html).
- **Acceptance**: drive a synthetic lasso → `setPending` fired, committed mask present, pending cleared — full round-trip, no AI/network.

### ITEM-10 — Typed contract for the seam
- **Approach**: `viz-core/annotate/processorPort.ts` — pure types (no deck/react/store): `ImageRef`, `ProcessorViewState`, `Gesture`, `LabelMaskResult` (Uint16|Uint32 + categoryForId + bounds/affine), `GeoFeature`, `CommitOpts`, `CommitResult`, `PendingState`, `ProcessorPort`. Factory `createProcessorPort(stores)` in `adapter/`. All **structured-clone-safe** (typed arrays + plain objects) so a future cross-window/worker processor is a pure addition (serialize the same types). Doc `docs/processor-port.md`. Treat as a semver-stable public surface (barrel = contract), like the workbench `apiVersion`.
- **Modularity**: types in `viz-core` (framework-agnostic, mechanically enforceable purity rule `regionSelect`/`imageMeta` follow); factory store-bound in `adapter`; zero AI/backend/processor dependency.
- **Grounding**: INV-2/3/4/7; F-SEG-1/3. Reuse: `workbench-api/src/contributions/types.ts` (typed contribution + apiVersion), `Coordination.store.ts:CoordinationSlice` (clone-safe serialize), viz-core purity rule.
- **Acceptance**: `processorPort.test.ts` — the mock type-checks against `ProcessorPort` with no `as any`; `structuredClone` of each result type succeeds.

## P3 — Mask review & correction

### ITEM-11 — Mask review controls (hide/solo classes · hover→cell-id)
- **Approach**: a thin controls layer over `LabelMaskLayer`, ZERO new rendering. hover/click→id is already free (`getPickingInfo` `LabelMaskLayer.ts:313`, `LabelMaskView.tsx:77`) — promote to a readout (id + class) + `onClick→selectedId`. hide/solo = a **LUT edit**: extend `buildIdColorLut` (`labelMaskColor.ts:63`) with `hiddenCategories`/`soloCategory` writing alpha 0; rebuild the O(numLabels) LUT + re-bind `idColorLut` — the id→pixel raster is never touched. Reject: a per-pixel visibility raster (O(pixels) re-upload per toggle).
- **Performance**: failure = treating a class toggle as a mask edit → re-encode full `w·h`. Avoided: hide/solo is O(numLabels) LUT rebuild + a ≤256×N upload, pixel-count-independent; hover O(1) (GPU pick).
- **Modularity**: reuses render + picking + `buildIdColorLut` verbatim; the only new code is a pure LUT-visibility option + a `MaskReviewControls` UI. Exposes `visibleCategories`/`soloCategory` props + `selectedId`/`onSelectCell`.
- **Grounding**: INV-5, INV-6; F-SEG-2, F-JTBD-2. Reuse: `LabelMaskLayer.ts:313/158-166`, `labelMaskColor.ts:63`, `LabelMaskView.tsx:77`. Sources: [napari Labels](https://napari.org/dev/howtos/layers/labels.html), [QuPath classification](https://qupath.readthedocs.io/en/stable/docs/tutorials/pixel_classification.html).
- **Acceptance**: `buildIdColorLut(catForId,{hiddenCategories:{2}})` → every id of category 2 has LUT alpha 0, others unchanged (pure oracle test like `labelMaskColor.test.ts`); a view test drives `onHover` → readout equals `categoryForId[id]`.

### ITEM-12 — Mask correction (relabel · split · merge · brush-fix)
- **Approach**: pure `maskEdit.ts` on the CPU label raster (widen to **`Uint32Array`**, DEC-D) + a dirty-rect sub-upload path on `LabelMaskLayer` (reuse, not rewrite). Each op → `{dirtyRect, undoAtom}`: relabel = change `categoryForId[id]` + LUT rebuild (NO pixels); merge = rewrite B→A over `bbox(B)`; split = new id + repartition within `bbox(cell)` (default manual cut line; assisted marker-watershed); brush-fix = paint id in a disk, rAF-coalesced upload. Replace `LabelMaskLayer.updateState`'s full re-encode (`:238-258`) with dirty-rect sub-encode + luma `copyImageData` (→ `writeTexture`/`texSubImage2D`).
- **Performance**: failure = any edit re-encodes+re-uploads the whole raster. Fix: cost tracks the EDIT not the image — brush O(r²), merge O(cell area), split O(bbox), relabel O(numLabels). Past the 4096² cap → chunked/tiled textures, re-upload only intersected tiles.
- **Modularity**: `LabelMaskLayer` stays the sole renderer (adds a sub-region upload path, not a 2nd layer); all logic in pure `maskEdit.ts` (oracle-testable, mirrors `labelMaskColor.ts`); reuses the ITEM-11 LUT path for relabel/merge recolor. Exposes `applyBrush/applyRelabel/applyMerge/applySplit → {dirtyRect,undoAtom}` + an `UndoStack` (per-cell).
- **Grounding**: INV-5, INV-6; F-SEG-2, F-JTBD-1. Reuse: `LabelMaskLayer.ts:238-258/313`, `labelMaskColor.ts:44/89/109`, `labelMaskFixture.ts`. Sources: [napari paint/fill + undo atoms](https://napari.org/0.4.15/_modules/napari/layers/labels/labels.html), [ilastik seeded watershed](https://www.ilastik.org/documentation/carving/carving), [luma copyImageData](https://luma.gl/docs/api-reference/core/resources/texture), [texSubImage2D](https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/texSubImage2D).
- **Acceptance**: `applyBrush` → disk pixels == id, everything outside `dirtyRect` byte-identical; `applyMerge(A,B)` → picking over `bbox(B)` returns only A; `applySplit` → two distinct ids + a new boundary seam; `undoAtom` restores byte-for-byte; **GPU test**: spy `copyImageData`, assert bounds == `dirtyRect` (proves NO full re-upload — the gigapixel-safety invariant).

## P4 — Link

### ITEM-13 — image↔data linking (bidirectional)
- **Approach**: route through the shared `Coordination.store` selection channel (Vitessce coordination) — no new bus. tissue-region→scatter already runs (`spatial-roi.story`: `selectRegion`→`mapRowsToIds`→`setSelection`→scatter reads `pointSelection`). Net-new (small): make `RasterUnderlayScatterView` a CONSUMER of `pointSelection` (publish-only today) via `highlightMaskForIds`; add a label-mask **id→selected highlight LUT** (clone `buildIdColorLut`); expose `*InSpace` on `CoordinationHandle`. Identity-space: same-dataset = DEFAULT space (index==id); cross-dataset via `setSelectionInSpace`/`pointSelectionInSpace`. Reject: an index-carrying linked-brush event (cross-contaminates, F-CODE-3); view-to-view refs.
- **Performance**: failure = per-frame O(N) membership scan on millions. Reused dodge: resolve O(log N+k) (KD-tree + WeakMap `makePointIndexCache`); highlight built once per selection change (`buildIdToRow` dense `Int32Array`, `highlightMaskForIds`); GPU attribute-driven (`selectionAttribute`/`DIM_OPACITY`, DataFilterExtension) — O(1)/element/frame. Label-mask analog = an id→selected LUT texture sampled per pixel.
- **Modularity**: maximal INV-5 reuse — coordination model, region model, `selectionSync` mappers all unchanged; net-new is additive (consume leg + highlight LUT + `*InSpace` on the handle). No new coordination/region logic.
- **Grounding**: INV-5; F-JTBD-3#5, F-CODE-2/3, F-GAP-2. Reuse: `Coordination.store.ts:setSelectionInSpace/pointSelectionInSpace/DEFAULT_SELECTION_SPACE`, `spatial/regionSelect.ts:selectRegion`, `spatial/pointIndex.ts:makePointIndexCache`, `viz-core/coordination/selectionSync.ts:mapRowsToIds/buildIdToRow/highlightMaskForIds`, `spatial/RasterUnderlayScatterView.tsx` (make it consume), `LabelMaskLayer.ts:buildIdColorLut` (clone for highlight LUT), `DeckScatterCanvas.tsx:highlightMask`, `registry/types.ts:CoordinationHandle` (add `*InSpace`). Sources: [Vitessce coordination](http://vitessce.io/docs/coordination/), [deck.gl DataFilterExtension](https://deck.gl/docs/api-reference/extensions/data-filter-extension).
- **Acceptance** (both directions ACTIVE, no idle control): region→scatter lights exactly the ids inside the polygon; scatter→tissue lights the SAME ids on both the underlay overlay and the mask LUT (through the store, not a local shortcut); identity-space isolation (a selection in dataset-A's space → no highlight on a dataset-B view); additive refine unions on both, Clear wipes both; **perf invariant**: KD-tree built once per buffer (WeakMap cache hit) + one `updateTrigger` per selection epoch (no per-frame O(N)).

## Cross-cutting

### ITEM-14 — Coordinate-transform abstraction
- **Approach**: one `ImageCoordinateSystem` facade (`annotate/coords.ts`) over `data/image.ts` affines: `physical↔fullRes` (`pixelSizeAffine` + inverse), `fullRes↔level(n)` (`scaleAffine(1/downsample)` + inverse), `fullRes→world` (`imageModelMatrix`), `world→screen` (deck viewport, kept at the render boundary). Public API `map(pt, from, to)` over `CoordSpace = 'physical'|'fullRes'|{level:n}|'world'`. **One new primitive: `invertAffine(a)`** (RFC-5 rotation/shear ⇒ inversion isn't a reciprocal). Annotations stored canonically in full-res pixels (INV-4). Reject: scattering `×downsample` inline (drift, the F-FMT-2 anti-pattern); level-pixel storage; a scene-graph lib.
- **Performance**: pure affine composition — fold the chain into ONE 2×3/4×4 once per level; deck multiplies it on the GPU (`affineToModelMatrix`, DEC-26); no per-vertex CPU transform on the hot path (CPU `transformPositions` stays as the test oracle). Level-independent canonical store ⇒ no whole-set re-transform on zoom.
- **Modularity**: all NGFF-transform interpretation confined to `imageMeta.ts` + this facade; the isolation contract is a TYPE boundary — downstream consumes an `Affine`; RFC-5 changes only HOW an `Affine` is computed, not its type. When RFC-5 lands: extend `NgffTransform`, fold the general affine in `parseMultiscales`/`pixelSizeAffine`, rely on `invertAffine` — no annotation/codec/render change.
- **Grounding**: INV-4; F-FMT-2. Reuse/extend: `data/image.ts:Affine/applyAffine/composeAffine/transformPositions` (**add `invertAffine`**), `spatial/imageMeta.ts:pixelSizeAffine/imageModelMatrix/NgffTransform/parseMultiscales`, `data/affineMatrix.ts:affineToModelMatrix`. Sources: [OME-NGFF RFC-5 (in review)](https://ngff.openmicroscopy.org/rfc/5/), [NGFF 0.5](https://ngff.openmicroscopy.org/0.5/).
- **Acceptance**: inverse identity for a rotation+shear affine (`invertAffine(a)∘a ≈ I`); zoom-stable registration (a full-res point maps to the same physical point via every level); a vertex authored at level 2 read at level 0 lands on the same feature; facade fold matches the CPU `transformPositions` oracle + GPU `affineToModelMatrix`.

### ITEM-15 — Gallery stories + fixtures (visual/gate:ui exit condition)
- **Approach**: the umbrella covering every surface/state each item above enumerates, at **desktop + 390px**. Fixture inventory (from the item briefs): `InMemoryPixelSource` 3-level pyramid + a 16-bit multiplex variant + a single-level RGB variant (ITEM-1/2); a seeded annotation collection (K polygons/points, full-res coords) with empty/loaded/mid-draw/selection states (ITEM-3/5/6); brush states (ITEM-4); a QuPath-authored GeoJSON sample (ITEM-7); `makeLabelMaskFixture` (adjacent blobs for merge/split) with review/correct states (ITEM-11/12); the `MockProcessor` story + large-result knob (ITEM-8/9); the `regionSelectFixture` two-space source + a two-dataset variant + the scatter→tissue return-leg state (ITEM-13); an RFC-5 rotation+shear meta variant (ITEM-14).
- **Modularity**: stories in `showcase/stories/` (tree-shaken); fixtures deterministic/seeded.
- **Grounding**: the Phase-8 `gate:ui`/gallery-coverage exit condition; F-CODE-6 (fixtures-first). Reuse: `showcase/registry.ts`, `spatial/{imageFixture,labelMaskFixture}.ts`, `showcase/stories/spatial-image.story.tsx`.
- **Acceptance**: every new surface has a loaded-with-data gallery state at desktop + 390px; `gate:ui` (runtime-health + Layer A/axe) green; visual baselines blessed.
