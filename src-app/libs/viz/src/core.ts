// @txresbench/viz/core — the tree-shakeable CORE subpath (EXTENSIBILITY_STUDY Part 6 STEP 7): the
// pipeline + registry, the coordinate-system registry, the Coordination / DataZoom components +
// handle, the plain-zustand stores, the declarative option pipeline (parser + controller), and
// the pure data/coordination helpers. It renders NOTHING on its own — it imports NO chart Views
// and NO `installBuiltins` (charts arrive via `@txresbench/viz/charts`), so an app that only needs the
// engine + a subset of charts never pulls all ten in (ECharts `echarts/core` shape).
//
// The main `@txresbench/viz` barrel re-exports everything (back-compat); this subpath is the opt-in
// minimal surface.

// ── registry + extension surface ─────────────────────────────────────────────────────
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
// The RENDER-FREE chart registration: the same 10 built-in types with the same binding
// schemas + capabilities `parseOption` validates against, but placeholder Views and no
// deck.gl. It belongs on this subpath precisely because it pulls no chart View — a
// consumer that only PARSES a `VizOption` calls this instead of `/charts`'
// `installBuiltins()`. (Importing it is still inert; only calling it registers.)
export { installBuiltinSchemas, BUILTIN_CHART_SCHEMAS } from './viz-core/charts/chartSchemas'
export type { ChartSchema } from './viz-core/charts/chartSchemas'
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

// ── coordination + workspace stores (plain zustand) ────────────────────────────────────
export { useCoordinationStore, gridScopeId } from './adapter/Coordination.store'
export type { VizViewState } from './adapter/Coordination.store'
export { useGridWorkspaceStore, INITIAL_CELL_ID } from './adapter/GridWorkspace.store'
export { useColorOverrideStore, overridesForColumn } from './adapter/colorOverride.store'
export type {
  ColorOverrideState,
  ColorOverrideActions,
  ColumnColorOverride,
} from './adapter/colorOverride.store'

// ── Coordination (Selection) handle + DataZoom components ───────────────────────────────
export { defaultCoordinationHandle, createCoordinationHandle } from './adapter/coordinationHandle'
// Per-instance isolation (VIZ_ISOLATION): each <Viz> owns its own store set (a lone <Viz>
// auto-isolates). createVizStores() + VizStoresProvider/useVizStores for advanced multi-instance /
// portal / popup control; scoped hooks resolve the contextual store.
export {
  createVizStores,
  defaultVizStores,
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

// ── grid model (pure helpers) ───────────────────────────────────────────────────────────
export type { CellKind, GridCell } from './viz-core/grid/gridModel'
export { isDenseKind, cellSpaceKey, cellTestId } from './viz-core/grid/gridModel'
// The PANE-ID VOCABULARY (see the same block in `index.ts`). Deck-FREE by construction —
// `layerIds.ts` was split out of `multiView.ts` precisely so taking a value from it cannot drag
// `@deck.gl/core` onto a consumer's critical path — so it belongs on the minimal subpath too.
export {
  LAYER_ID_SEP,
  cellLayerId,
  cellOfLayer,
  layerBelongsToCell,
  localLayerName,
} from './viz-core/layers/layerIds'

// ── data engine + sources + fixtures ────────────────────────────────────────────────────
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
export { densify } from './viz-core/data/wire'
export type { DataSource, DatasetCatalog, GraphData } from './viz-core/data/wire'
// The ONE data input: a StreamingSource (catalog + keyed-channel byte streams). `<Viz source>` accepts
// this (or the transitional pull `DataSource`); `fromArray` wraps a resident array as a one-chunk stream,
// `asDataSource` bridges a StreamingSource to the legacy pull interface the Views still read through.
export { fromArray, collectStream } from './viz-core/data/streamingSource'
export type { StreamingSource, StreamingResolver, Channel, StreamOptions } from './viz-core/data/streamingSource'
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

// ── coordination helpers ─────────────────────────────────────────────────────────────────
export { highlightMaskForPoints } from './viz-core/coordination/selectionSync'

// ── declarative option pipeline (STEP 6) ────────────────────────────────────────────────
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
// ITEM-16 (DEC-3): saveVizSession/loadVizSession/clearVizSession DELETED — app owns persistence via
// getOption()→store→setOption(saved,{replace}). Durable primitives stay exported from autosaveCore.

// ── typed plot-event surface (EVENT_API_PLAN Phase 1: select + dataZoom; Phase 2: hover/legend/filter) ─
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

// ── per-plot animated transitions (OPT-IN; default off) ─────────────────────────────────
export { deckTransitions, easingFn } from './viz-core/charts/transitions'
export type {
  TransitionConfig,
  TransitionProp,
  TransitionEasing,
  TransitionAccessor,
  DeckTransitions,
} from './viz-core/charts/transitions'

// ── Performance: CPU raster mode (bin-then-shade) + compute backend seam ─────────────────
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

