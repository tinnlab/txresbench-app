// @ziee/viz — public API barrel for the standalone, SDK-free visualization
// engine. The app (src-app/ui) imports the engine + the two plain-zustand
// coordination stores + the popout window from here (never deep paths). The
// engine's OWN internal wiring uses relative imports within the package.

// ---- Coordination + workspace stores (plain zustand) ------------------------
export { useCoordinationStore, gridScopeId } from './adapter/Coordination.store'
export type { VizViewState } from './adapter/Coordination.store'
export { useGridWorkspaceStore, INITIAL_CELL_ID } from './adapter/GridWorkspace.store'
export { useColorOverrideStore, overridesForColumn } from './adapter/colorOverride.store'
export type {
  ColorOverrideState,
  ColorOverrideActions,
  ColumnColorOverride,
} from './adapter/colorOverride.store'

// ---- Pop-out (portal-move: each cell pops into a real window via useWindowPortal) ----
export { useCellPopout } from './adapter/useCellPopout'

// ---- Grid / workspace surface -----------------------------------------------
export { GridWorkspace } from './viz-core/grid/GridWorkspace'
export type { HostedSurfaceKind, HostedSurfaceClose } from './viz-core/grid/GridWorkspace'
export type { CellKind, GridCell } from './viz-core/grid/gridModel'
export { isDenseKind, cellSpaceKey, cellTestId } from './viz-core/grid/gridModel'
// The PANE-ID VOCABULARY. Public because a COMPOSING HOST is the other half of this contract: it
// mints the pane keys (`<viewId>::<paneId>`) that `makeLayerFilter` / `routeGridHover` then route
// by, and it was minting them against its own private copy of the separator. Two spellings of one
// contract, on either side of a package boundary, is the shape that already cost this package two
// fixes for one defect — so the separator and the ownership predicate are exported and the host
// consumes them. `layerBelongsToCell` in particular is the rule a host can assert its OWN keys
// survive (`…-1` must not claim `…-10`).
export {
  LAYER_ID_SEP,
  cellLayerId,
  cellOfLayer,
  layerBelongsToCell,
  localLayerName,
} from './viz-core/layers/layerIds'

// ---- Chart-type registry + extension surface (EXTENSIBILITY_STUDY STEP 1) ----
export {
  registerChartType,
  getChartType,
  hasChartType,
  chartTypes,
  compatibleChartTypes,
  columnAvailability,
  schemaSatisfiable,
} from './viz-core/registry/registry'
export type { ColumnAvailability } from './viz-core/registry/registry'
export type {
  ChartTypeDescriptor,
  ChartViewProps,
  ChartModel,
  ChartCapabilities,
  CoordSystemId,
  CoordinationHandle,
  BindingChannel,
  BindingSource,
  ResolvedBindings,
  BindingResolution,
  BindingResolutions,
  ModelContext,
} from './viz-core/registry/types'
export { use } from './viz-core/extension'
export type { InstallRegisters, Installer, Extension } from './viz-core/extension'
// `installBuiltins` registers the chart types WITH their deck-backed Views (what a renderer
// needs); `installBuiltinSchemas` registers the same types with the same binding schemas and
// capabilities but placeholder Views (what a PARSER/VALIDATOR needs). See `chartSchemas.ts`.
export { installBuiltinSchemas, BUILTIN_CHART_SCHEMAS } from './viz-core/charts/chartSchemas'
export type { ChartSchema } from './viz-core/charts/chartSchemas'
export { installBuiltins } from './viz-core/charts/installBuiltins'

// ---- Chart-authoring surface (mirrored from @ziee/viz/core so the "write your own
// chart type" flow works from the main barrel too): the model helpers + the
// coordinate-system registry. -------------------------------------------------
export {
  makeChartModel,
  bindingValue,
  bindingList,
  bindingsOf,
  resolveBindingChannel,
  resolveBindings,
  refusalMessage,
  asRefusal,
  REFUSAL_CANDIDATE_PREVIEW,
} from './viz-core/registry/model'
export type { BindingRefusal } from './viz-core/registry/model'
export {
  registerCoordinateSystem,
  getCoordSystem,
  hasCoordSystem,
  coordSystems,
} from './viz-core/registry/coordSystem'
export type {
  CoordSystemDef,
  CoordSystemInstance,
  CoordRegionSpec,
  RenderHost,
  RenderHostId,
  CoordDimension,
  CoordCamera,
} from './viz-core/registry/coordSystem'

// ---- Coordination (Selection) handle + DataZoom components (STEP 3-4) --------
export { defaultCoordinationHandle, createCoordinationHandle } from './adapter/coordinationHandle'
// Per-instance isolation (VIZ_ISOLATION): each <Viz> owns its own store set (a lone <Viz>
// auto-isolates). createVizStores() + VizStoresProvider/useVizStores for advanced multi-instance /
// portal / popup control; scoped hooks resolve the contextual store.
export {
  createVizStores,
  defaultVizStores,
  resolvedPaneBindings,
  VizStoresContext,
  VizStoresProvider,
  useVizStores,
  useCoordination,
  useGridWorkspace,
  useColorOverride,
  usePlotInteraction,
} from './adapter/vizStores'
export type { VizStores } from './adapter/vizStores'
export { ValueDataZoom, DataZoomMatrix } from './viz-core/datazoom/DataZoom'

// ---- Per-chart installers (EXTENSIBILITY_STUDY STEP 7; also on @ziee/viz/charts) ----
export {
  AllCharts,
  ScatterChart,
  ImageChart,
  GridChart,
  ViolinChart,
  BoxChart,
  BarChart,
  DotplotChart,
  HeatmapChart,
  VolcanoChart,
  HistogramChart,
} from './viz-core/charts/installBuiltins'

// ---- Declarative option pipeline: VizOption + setOption + dispatch (STEP 6) ----
export { parseOption, buildLayout } from './viz-core/option/parse'
export type {
  VizOption,
  VizDataset,
  VizGridEntry,
  VizRegion,
  VizDataZoom,
  VizSelection,
  // Selection provenance (M12) — the consumer-facing half of DEC-20: the API reports every point
  // in the region and the CONSUMER partitions, which is impossible without these being exported.
  VizSelectionOp,
  VizSelectionContext,
  VizSelectionCombine,
  VizColorScale,
  VizSeries,
  VizEncode,
  VizColorBy,
  VizWindow,
  VizAxis,
  VizDataZoomType,
  VizSelectionMode,
  ResolvedOption,
  ResolvedSeries,
  ResolvedDataZoom,
} from './viz-core/option/types'
export { VizController } from './adapter/VizController'
export type { VizAction, DatasetResolver, VizControllerOptions } from './adapter/VizController'

// Session state: the legacy `captureVizState`/`restoreVizState`/`VizSessionState` API is DELETED
// (ITEM-6) — save/restore is now the single `VizController.getOption()` / `setOption(o, { replace })`
// pair (strict-JSON `VizOption`).
export { usePlotInteractionStore } from './adapter/PlotInteraction.store'
export type {
  PlotInteractionSlice,
  PlotInteractionState,
  PlotInteractionActions,
  DataZoomWindow,
  FilterRange,
} from './adapter/PlotInteraction.store'
// ITEM-16 (DEC-3): saveVizSession/loadVizSession/clearVizSession DELETED — the app owns persistence via
// `getOption()` → its own store → `setOption(saved, { replace: true })`. The durable primitives
// (AUTOSAVE_KEY / readAutosave / writeAutosave / debounce) remain exported from autosaveCore below.

// ---- Typed plot-event surface (EVENT_API_PLAN Phase 1: select + dataZoom; Phase 2: hover + legend + filter) ----
export { VizEmitter, windowAxis } from './viz-core/events/emitter'
export type {
  VizEvent,
  VizSelectEvent,
  VizDataZoomEvent,
  VizHoverEvent,
  VizLegendEvent,
  VizFilterEvent,
  VizEventType,
  VizEventOf,
  VizEventHandler,
  VizEventBus,
} from './viz-core/events/emitter'

/**
 * The plot-event BUS seam, for a host that mounts a bare `<GridWorkspace>` rather than `<Viz>`.
 *
 * `<Viz>` provides this around its own grid, so a host using that component gets every plot event
 * for free. A host that composes the grid itself gets NO provider — and a plot event raised from
 * deep inside a chart View then reaches nothing at all. That is not a theoretical gap: a cell the
 * host declared `controlled` emits `cell-close` through this bus INSTEAD of removing itself, so
 * without a provider its close X is live, styled, and silently inert.
 *
 * Exported so such a host can provide a bus of its own and close that hole. It is deliberately the
 * narrow `{ emit }` capability rather than the controller.
 */
export { VizEventBusContext, closeEventBus } from './viz-core/events/EventBusContext'

// ---- Declarative React binding: <Viz option={...} /> (STEP 7; also on @ziee/viz/react) ----
export { Viz } from './react/Viz'
export type { VizProps } from './react/Viz'

// ---- Data engine + sources + fixtures ---------------------------------------
export { FixtureSource } from './viz-core/data/fixtures'
export { computeColoring, DEFAULT_COLOR_BY } from './viz-core/data/engine'
export type {
  ColorBy,
  ColorMode,
  SingleChannelColorBy,
  BlendColorBy,
  BlendChannel,
  Coloring,
  BlendColoring,
} from './viz-core/data/engine'
export { BlendLegend } from './viz-core/controls/BlendLegend'
export { Legend } from './viz-core/controls/Legend'
export type { LegendProps } from './viz-core/controls/Legend'
export { computeBlendEncoding, buildBlend2DLegend } from './viz-core/data/blend'
export type { Blend2DLegend, Blend2DLegendRow, BlendEncoding } from './viz-core/data/blend'
// Blend Phase-2 multi-column REDUCE (concat N categorical → composite category; aggregate M
// continuous → one value). The composite-category primitive doubles as a chart group-by key.
export {
  reduceBlendColumns,
  concatCategoricalColumns,
  aggregateContinuousColumns,
  DEFAULT_BLEND_AGGREGATE,
  COMPOSITE_SEPARATOR,
  ALL_CATEGORY_LABEL,
} from './viz-core/data/blendReduce'
export type {
  BlendAggregateOp,
  BlendReduceInput,
  BlendReduceResult,
  BlendCategoricalInput,
  ConcatCategoricalResult,
  AggregateContinuousResult,
} from './viz-core/data/blendReduce'
// Categorical color-override layer (custom palette / by-name colors / display labels).
export {
  resolveEffectivePalette,
  extendPalette,
  displayCategory,
  categoricalColors,
  legendDescriptor,
} from './viz-core/data/color'
export type { PaletteEntry, CategoricalOverrides } from './viz-core/data/color'
export { densify } from './viz-core/data/wire'
export type { DataSource, DatasetCatalog, GraphData } from './viz-core/data/wire'
// The ONE data input: a StreamingSource (catalog + keyed-channel byte streams). `<Viz source>` accepts
// this (or the transitional pull `DataSource`); `fromArray` wraps a resident array as a one-chunk stream,
// `asDataSource` bridges a StreamingSource to the legacy pull interface the Views still read through.
export { fromArray, collectStream } from './viz-core/data/streamingSource'
export type {
  StreamingSource,
  StreamingResolver,
  Channel,
  GatherableChannel,
  MembersRef,
  MemberSegment,
  StreamOptions,
} from './viz-core/data/streamingSource'
export { asDataSource } from './viz-core/data/streamingAdapter'
export { StreamingFixtureSource, STREAMING_FIXTURE_TABLE } from './viz-core/data/streamingFixtures'
// Streaming ingestion (fetch → typed-array reframer) + mergeable sketches (STREAMING_PROGRESSIVE_PLAN).
// `streamBinaryColumn` is a FIXTURE / SHOWCASE API: it takes a REQUIRED `fetchImpl` (ITEM-16 /
// DEC-15 (a)) and has no ambient-`fetch` fallback, so an app consumer must hand it the transport
// that carries auth. In this repo the app never calls it — every byte read goes through
// `core/workstore/binaryClient.ts` → `ApiClient` (INV-7).
export { reframeBytes, streamBinaryColumn, asFloat32, asUint16 } from './viz-core/data/fetchStream'
export type {
  ReframedBatch,
  ReframeOptions,
  StreamTotal,
  StreamBinaryOptions,
} from './viz-core/data/fetchStream'
export { KllSketch, HyperLogLog, hash32 } from './viz-core/data/sketches'

// ---- Coordination helpers ---------------------------------------------------
export { highlightMaskForPoints } from './viz-core/coordination/selectionSync'

// ---- Tooltip model ----------------------------------------------------------
export type { TooltipCatalogLabels, TooltipContext } from './viz-core/tooltip/tooltipModel'

// ---- Overlap tooltips (top-3 + "N more" dialog; point + raster modes) --------
export { OverlapTooltip } from './viz-core/tooltip/OverlapTooltip'
export type { OverlapTooltipProps } from './viz-core/tooltip/OverlapTooltip'
export { OverlapDialog } from './viz-core/tooltip/OverlapDialog'
export type { OverlapDialogProps } from './viz-core/tooltip/OverlapDialog'
export { WindowedList, windowRange } from './viz-core/tooltip/WindowedList'
export type { WindowedListProps, WindowRange } from './viz-core/tooltip/WindowedList'
export { useOverlapTooltip } from './viz-core/tooltip/useOverlapTooltip'
export type {
  UseOverlapTooltipOptions,
  OverlapTooltipHandle,
} from './viz-core/tooltip/useOverlapTooltip'
export { orderByCursor, resolveOverlap, resolveOverlapRow } from './viz-core/tooltip/overlapModel'
export type { OverlapResolution } from './viz-core/tooltip/overlapModel'
export {
  buildBinIndex,
  binOf,
  indicesInBin,
  indicesNear,
  queryRadius,
} from './viz-core/spatial/binIndex'
export type { BinIndex, BinBounds } from './viz-core/spatial/binIndex'

// ---- Export (dialog + spec + crop geometry) ---------------------------------
export { ExportDialog } from './viz-core/export/ExportDialog'
// Legend-as-vector-marks: adopters can bake a legend into their own export scenes (DEC-9).
export { legendToMarks, composeLegendIntoScene, LEGEND_MAX_ROWS, LEGEND_MAX_COLS } from './viz-core/export/legendMarks'
export { gridDividerMarks } from './viz-core/export/gridDividerMarks'
export type { LegendExportSpec, LegendMarksResult, LegendComposePlacement } from './viz-core/export/legendMarks'
// dataZoom slider as vector marks + shared on-screen/export renderer (WYSIWYG): adopters can bake a
// range-zoom slider into their own export scenes, matching the on-screen `AxisDataZoom` rail.
export {
  computeDataZoomLayout,
  drawDataZoomCanvas,
  dataZoomToMarks,
  composeDataZoomIntoScene,
  DATAZOOM_RAIL,
} from './viz-core/controls/dataZoomRender'
export type { Box, DataZoomLayout, DataZoomOrientation, DataZoomExportSpec } from './viz-core/controls/dataZoomRender'
export { sceneToRasterPngDataUrl } from './viz-core/export/vector'
export type { Rect } from './viz-core/export/cropCanvas'
export type { CellSpec, WorkspaceSpec } from './viz-core/export/spec'
export type { LayoutNode as SpecLayoutNode } from './viz-core/export/spec'

// ---- Layout (split tree) ----------------------------------------------------
export type { LayoutNode as SplitLayoutNode } from '@ziee/dock'

// ---- Persistence (autosave core) --------------------------------------------
export { AUTOSAVE_KEY, debounce, readAutosave, writeAutosave } from './viz-core/persist/autosaveCore'

// ---- Per-plot animated transitions (OPT-IN; default off) --------------------
export { deckTransitions, easingFn } from './viz-core/charts/transitions'
export type {
  TransitionConfig,
  TransitionProp,
  TransitionEasing,
  TransitionAccessor,
  DeckTransitions,
} from './viz-core/charts/transitions'

// ---- Chart controls / views (public rendering surface) ----------------------
export { AxisDataZoom } from './viz-core/charts/AxisDataZoom'
export { ViolinView } from './viz-core/charts/ViolinView'
export { BoxView } from './viz-core/charts/BoxView'
export { BarView } from './viz-core/charts/BarView'
export { HistogramView } from './viz-core/charts/HistogramView'
export { DotplotView } from './viz-core/charts/DotplotView'
export { HeatmapView } from './viz-core/charts/HeatmapView'
export { VolcanoView } from './viz-core/charts/VolcanoView'
export { DeckScatterCanvas } from './viz-core/DeckScatterCanvas'

// ---- GPU parity verifiers (used by the app's gpu-parity dev page) -----------
export { verifyGroupReduceParity, deviceSupportsGroupReduce } from './viz-core/gpu/groupReduce'
export { verifyAggregateParity, verifyViolinParity } from './viz-core/charts/aggregateGpu'
export { verifyDensifyParity } from './viz-core/gpu/densifyGpu'
export { verifyBoxStatsParity, verifySignificanceParity } from './viz-core/charts/groupStatsGpu'

// ---- Performance: CPU raster mode (bin-then-shade) + compute backend seam -----
export {
  isSoftwareRenderer,
  matchesSoftwareRenderer,
  readRendererString,
  resolveCpuRasterMode,
  DEFAULT_RASTER_POINT_THRESHOLD,
} from './viz-core/gpu/renderCapability'
export type { CpuRasterModeInput } from './viz-core/gpu/renderCapability'
// Machine-adaptive raster threshold: probe the ACTUAL GPU once, clamp, cache in localStorage.
export {
  resolveMachineThreshold,
  sessionMachineThreshold,
  probePointThroughput,
  capacityToThreshold,
  rendererHash,
  isCapacityRecordValid,
  defaultCapacityStore,
  PROBE_POINT_FLOOR,
  CAPACITY_CEILING,
  FRAME_BUDGET_MS,
  CAPACITY_SCHEMA_VERSION,
  CAPACITY_STORAGE_KEY,
  CAPACITY_TTL_MS,
} from './viz-core/gpu/renderCapacity'
export type {
  CapacityRecord,
  CapacityStore,
  ResolveMachineThresholdDeps,
} from './viz-core/gpu/renderCapacity'
export { binAndShade, binAndShadePacked, normalizeCounts, shadeCounts, shadeValue, shadeCategory, binAndShadeValue, categoryPaletteFor, exactQuantile, DEFAULT_RASTER_NORMALIZE } from './viz-core/density/cpuRaster'
export type { RasterNormalize, BinAndShadeParams, BinAndShadePackedParams, RasterImage, ShadeCountsOptions, ShadeMode, ShadeValueOptions, ShadeCategoryOptions, BinAndShadeValueParams } from './viz-core/density/cpuRaster'
export { packPositions, unpackXY, readX, readY, U16_MAX } from './viz-core/density/quantize'
export type { PackMeta, PackedPositions } from './viz-core/density/quantize'
export { binDensityPacked, binPacked } from './viz-core/density/densityBin'
export { shouldBuildPointLayers, pointColorValue } from './viz-core/spatial/rasterFirst'
export { MAX_SINGLE_LAYER_BYTES } from './viz-core/scale/chunking'
export {
  buildTilePyramid,
  selectTiles,
  levelForZoom,
  reorderByPyramid,
  tileView,
  DEFAULT_MAX_DEPTH,
  DEFAULT_TILE_POINT_CAP,
  DEFAULT_TILE_TARGET_POINTS,
} from './viz-core/scale/tilePyramid'
export type {
  TilePyramid,
  PyramidTile,
  SelectedTile,
  TileSelection,
  BuildTilePyramidOptions,
  SelectTilesOptions,
} from './viz-core/scale/tilePyramid'
export { TiledPointsView } from './viz-core/spatial/TiledPointsView'
export type { TiledPointsViewProps } from './viz-core/spatial/TiledPointsView'
export {
  selectImageTiles,
  levelForImageZoom,
  levelDownsample,
  levelPixelSize,
  levelTileGrid,
  tileWorldBounds,
} from './viz-core/spatial/imageTiles'
export type {
  ImageTilePyramid,
  ImageWorldBounds,
  VisibleTile,
} from './viz-core/spatial/imageTiles'
export { ImageTileLayer, buildImageTileLayers } from './viz-core/spatial/ImageTileLayer'
export type {
  ImageTileLayerProps,
  BuildImageTileLayersParams,
  GetTileUrl,
} from './viz-core/spatial/ImageTileLayer'
// Label-mask review + correction surface (ITEM-11 / ITEM-12). The GPU layer (with the ITEM-11
// hiddenCategories/soloCategory/selectedId props + the ITEM-12 dirtyRect sub-upload path), its
// view, and the pure LUT/encode helpers, plus the review controls + the correction controller.
export { LabelMaskLayer, encodeLabelMaskSubRect, labelMaskModule } from './viz-core/spatial/LabelMaskLayer'
export type {
  LabelMaskLayerExtraProps,
  LabelMaskModuleProps,
  SubImageUpload,
  DirtyRect as LabelMaskDirtyRect,
} from './viz-core/spatial/LabelMaskLayer'
export { LabelMaskView } from './viz-core/spatial/LabelMaskView'
export type { LabelMaskViewProps } from './viz-core/spatial/LabelMaskView'
export {
  buildIdColorLut,
  encodeLabelMaskRGBA,
  decodeIdFromRGB,
  packIdToRGB,
  boundaryMask,
} from './viz-core/spatial/labelMaskColor'
export type {
  IdColorLut,
  BuildIdColorLutOpts,
  LabelMask,
  Palette,
} from './viz-core/spatial/labelMaskColor'
export { MaskReviewControls } from './viz-core/annotate/MaskReviewControls'
export type { MaskReviewControlsProps, MaskCategory, MaskTool } from './viz-core/annotate/MaskReviewControls'
export { createMaskCorrectController } from './viz-core/annotate/maskCorrectController'
export type {
  MaskCorrectController,
  MaskCorrectControllerOpts,
  OnPixelsUpload,
  OnCategoriesChange,
} from './viz-core/annotate/maskCorrectController'
export { CpuRasterView } from './viz-core/density/CpuRasterView'
export type { CpuRasterViewProps, VizProgress } from './viz-core/density/CpuRasterView'
// Streaming/progressive data API (STREAMING_PROGRESSIVE_PLAN Wave 2a/2b): the friendly <Viz data> union
// + multi-channel colorBy (density | label | value). The raster `ColorBy` is aliased `RasterColorBy`
// — the option-encoding `ColorBy` (a different type) is already exported above.
export type { ColorBy as RasterColorBy, ColorByResolver } from './viz-core/density/CpuRasterView'
export { normalizeVizData, normalizeChannelColumn } from './adapter/vizData'
export type {
  VizData,
  PositionsInput,
  NormalizedBatch,
  NormalizeOptions,
  ChannelInput,
  NormalizedChannelBatch,
} from './adapter/vizData'
export { DensityAccumulator, ChannelAccumulator } from './viz-core/density/accumulator'
export type {
  AccumulatorGeometry,
  AccumulatorShadeOptions,
  ChannelConfig,
  ChannelAppend,
  ChannelShadeOptions,
} from './viz-core/density/accumulator'
// Retain-vs-base-grid strategy for data-mode zoom re-bin (STREAMING_PROGRESSIVE_PLAN Wave 2c / item 16).
export {
  chooseRetainStrategy,
  baseGridRollup,
  shouldRebinForView,
  rectContains,
  RETAIN_MAX_POINTS,
  RETAIN_RAW_BYTE_BUDGET,
  RETAIN_BYTES_PER_POINT,
  SERVER_TILE_PYRAMID_THRESHOLD,
  DEFAULT_BASE_GRID_DIM,
} from './viz-core/scale/retainStrategy'
export type {
  RetainStrategy,
  RetainStrategyOptions,
  RebinDecisionInput,
} from './viz-core/scale/retainStrategy'
export { resolveComputeBackend } from './viz-core/gpu/computeDevice'
export type { ComputeBackend } from './viz-core/gpu/computeDevice'

// Selection provenance runtime surface (M12). `partitionSelection` is DEC-20's entire explanatory
// half — "the API reports every point in the region and the consumer partitions" — so without it a
// consumer cannot perform the partition the contract tells them to.
export {
  partitionSelection,
  deriveSelection,
  selectionStaleness,
  classifyChange,
  hashPositions,
} from './viz-core/selection/provenance'
export type {
  SelectionPartition,
  SelectionStaleness,
  ChangeClass,
  ProvenancePane,
  ResolvePane,
} from './viz-core/selection/provenance'

// The production OME-TIFF pyramid reader (#158) — the READER half of the raster stack whose
// renderer this package has always shipped. Storage-agnostic: it takes a `ByteRangeSource`
// and returns the `PixelSource[]` `buildRasterImageLayers` consumes.
export {
  loadOmeTiffPyramid,
  omeTiffModelMatrix,
  ngffForLevels,
  assertHalvingPyramid,
  assertDecodableCodec,
  dtypeOfDirectory,
  DEFAULT_OME_TIFF_LIMITS,
  OmeTiffLoadError,
  UnsupportedImageCodecError,
  // #288: EXPORTED, unlike its sibling `MultiPlaneImageUnsupportedError`, because a consumer
  // has to be able to tell "this application cannot render that many channels" from "the
  // artifact could not be opened". Without the class the app's catalog files both as
  // `hasImage: false` with one `console.warn`, and a user sees an empty pane with no reason.
  SampleCountUnsupportedError,
  MAX_RENDERABLE_CHANNELS,
  NonHalvingPyramidError,
} from './viz-core/spatial/omeTiffPyramid'
export type {
  ByteRangeSource,
  OmeTiffPyramid,
  OmeTiffPyramidLimits,
  LoadOmeTiffOptions,
  LevelSize,
} from './viz-core/spatial/omeTiffPyramid'

// The single-texture reduction of that same pyramid (#159) — the `imageUnderlay()` half of the
// wire's raster contract, beside the reader because every type it needs (`Affine`,
// `invertAffine`, `ImageUnderlay`) is internal to this package.
export {
  omeTiffUnderlay,
  omeTiffUnderlayMeta,
  underlayAffine,
  MAX_UNDERLAY_PIXELS,
  OmeTiffUnderlayError,
  OmeTiffTooLargeForOneTextureError,
  OmeTiffPlacementError,
} from './viz-core/spatial/omeTiffUnderlay'

// The image<->coordinates BINDING (#228) — the frame decision (the camera lives in the declared
// coordinate space), the placement matrices for both raster render paths, and the
// `coordinate_space` predicate that decides whether a layout's points may be drawn over a raster
// at all. Exported because it is pure arithmetic over declared numbers that a host embedding the
// grid needs in order to reason about a pane's frame, and because its refusal reasons are the
// only explanation a picture-with-no-points has.
export {
  resolveOverlayBinding,
  resolvePaneFrame,
  imagePlacementMatrix,
  levelPlacementMatrix,
  imageExtentInSpace,
  frameExtent,
  asPlacementAffine,
  toSpaceFromLevelAffine,
} from './viz-core/spatial/coordinateBinding'
export type {
  OverlayBinding,
  PaneFrame,
  DeclaredPlacement,
  SpaceExtent,
} from './viz-core/spatial/coordinateBinding'

