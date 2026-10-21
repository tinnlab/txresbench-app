// The `@/modules/workbench/core/manifest` subpath barrel (ITEM-14/15).
export type {
  ExtensionManifest,
  ManifestContributes,
  ManifestAnalysis,
  ManifestView,
} from './types.ts'
export { validateManifest } from './validate.ts'
export type { ValidationResult, ValidationError } from './validate.ts'
// The declarative `view_spec` contract types (ITEM-1, DEC-10). NOTE: `ViewSpec`
// (the declarative top type) is intentionally NOT re-exported here — a
// render-descriptor `ViewSpec` already occupies the main-barrel namespace
// (`contributions/types.ts`, consumed by `shell/renderStrategies.ts`), and a
// duplicate `export *` name would be silently dropped from the main barrel and
// break that consumer. Import the declarative top type directly from the
// `@/modules/workbench/core/manifest/viewSpec` subpath.
export type {
  WidgetSpec,
  WidgetBase,
  SelectWidget,
  RangeSliderWidget,
  ListEditorWidget,
  TableWidget,
  TableColumnSpec,
  ButtonWidget,
  AlertWidget,
  StatWidget,
  GroupWidget,
  DatasetPickerWidget,
  ScatterWidget,
  ViolinWidget,
  BarWidget,
  HistogramWidget,
  ImageWidget,
  VizEncode,
  ActionSpec,
  EffectSpec,
  StateFieldSpec,
  DataSourceSpec,
  DerivedSpec,
  // INV-3 — `LayoutSpec`/`LayoutRegion`/`RegionSplit`/`RegionContent` are GONE with
  // `layout.regions`: a spec is one pane and its `widgets` order is the layout.
  ArtifactRefWidget,
  ArtifactRefSource,
  CatalogArtifactSource,
  AxisScopedArtifactSource,
  ExprString,
} from './viewSpec.ts'
// The `packages/<name>/` DATA-package contract (ITEM-3/ITEM-23, DEC-22).
export type {
  ProcessorAnalysisData,
  ProcessorManifestData,
  ProcessorPackage,
} from './processorPackage.ts'
import schema from './schema.json' with { type: 'json' }
/** The published manifest JSON-schema contract (external-loader + BE serde SoT). */
export const MANIFEST_SCHEMA = schema
