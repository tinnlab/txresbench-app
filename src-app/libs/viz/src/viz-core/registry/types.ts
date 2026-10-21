// registry/types.ts — the PUBLIC chart-type extension contract (EXTENSIBILITY_STUDY
// §3.2). This is the uniform descriptor that replaces the closed `CellKind` union +
// the exhaustive `switch (cell.kind)` in `CellView`: a chart type registers ONE
// `ChartTypeDescriptor` and the core dispatches to it generically, knowing nothing
// about what the chart is.
//
// STEP 2 scope: each descriptor now OWNS its chart's binding schema (`bindingSchema`) and
// a proper `model()` that resolves it against the dataset catalog. The bespoke-per-chart
// View props (violin's `{valueKey,groupKey}`, heatmap's `{valueKeys,groupKey}`, volcano's
// `{tableName}`, …) are fields of the resolved `model.bindings`; the adapter in
// `installBuiltins` shrinks to spreading `model.bindings` onto its wrapped View's props,
// and the core (`CellView`) calls `desc.model(...)` generically — it no longer knows any
// chart's binding shape. The chrome reads `bindingSchema` from the registry.
//
// Pure types only (no React runtime, no deck): every cross-module reference here is
// `import type`, so this module never participates in a runtime import cycle even
// though `gridModel` imports the registry's value API.

import type { ComponentType } from 'react'
import type { DataSource, DatasetCatalog } from '../data/wire'
import type { GridCell } from '../grid/gridModel'
import type { GroupEmphasis, IdToRow } from '../coordination/selectionSync'

/**
 * Which render host + coordinate flavor a chart lives in (EXTENSIBILITY_STUDY §3.2).
 * This is the registry-backed replacement for the hard-coded `isDenseKind` predicate:
 * a chart is "dense" (shared single-`<DeckGL>` deck) IFF its coordinate system is
 * `world2d`.
 *
 *  - `world2d`  — shared single-`<DeckGL>` / N-views deck, free ortho camera
 *                 (scatter, image). `isDenseKind` is true for exactly these.
 *  - `chart2d`  — own `ChartCanvas`, independent-axis auto-fit
 *                 (violin, box, bar, histogram, volcano; also the nested `grid`).
 *  - `matrix2d` — own `ChartCanvas`, `controller:false` texel-window framing
 *                 (heatmap, dotplot).
 */
export type CoordSystemId = 'world2d' | 'chart2d' | 'matrix2d'

/**
 * How a chart PARTICIPATES in the shared coordination components (opt-in). These flags are
 * now ENFORCED (viz-followups Area B, ITEM-4/5/6): `option/parse.ts` folds each descriptor
 * default + per-series override into the resolved plan AND stamps the effective value onto
 * the `GridCell`; `CellView.ChartBody` threads it through the uniform `ChartViewProps` to the
 * View, which then reads / publishes selection CONDITIONALLY. The DEFAULT (a flag left unset
 * on the descriptor AND the series) resolves to the descriptor's declared capability =
 * TODAY'S behavior, so a plain chart is byte-identical; only an EXPLICIT opt-out changes it.
 *
 *  - `consumesSelection: false` ⇒ the View does NOT read the shared selection (no dim, no
 *    highlight); `producesSelection: false` ⇒ the View hides its brush / lasso / band gesture.
 *    An override rides on `series.emphasis.consumesSelection` / `series.select.produces`.
 *  - `dataZoomAxes` gates each View's SELF-HOSTED DataZoom to only the declared axes (a value
 *    chart without `'y'` disables its value zoom; `[]` disables all zoom).
 *  - `linkableColorScale: false` opts a chart OUT of the shared-domain color join — `parse.ts`
 *    refuses to stamp `linkColorScale: true` on it even when `colorScale.link` names it.
 */
export interface ChartCapabilities {
  /** ENFORCED (ITEM-5). Whether the View READS the shared selection (dim/emphasis). Unset ⇒
   *  the View's today-behavior (the built-in consuming Views dim); an explicit `false` makes
   *  the View skip consuming (no dim, no highlight). Overridable per series via
   *  `series.emphasis.consumesSelection`. */
  readonly consumesSelection?: boolean
  /** ENFORCED (ITEM-5). Whether the View exposes its PRODUCE gesture (brush / lasso / band).
   *  Unset ⇒ today-behavior (the gesture shows when a producer sink is wired); an explicit
   *  `false` hides it. Overridable per series via `series.select.produces`. */
  readonly producesSelection?: boolean
  /** ENFORCED (ITEM-6). Which axes the View's self-hosted DataZoom honors
   *  (`[]` / `['y']` / `['x','y']`). A value chart lacking `'y'` disables its value zoom; `[]`
   *  disables all zoom. Unset ⇒ the View's default (unrestricted). */
  readonly dataZoomAxes?: readonly ('x' | 'y')[]
  /** ENFORCED (ITEM-6). Whether the chart may join the shared (linked) color domain. An
   *  explicit `false` makes `parse.ts` refuse to link this series even when `colorScale.link`
   *  names it. Unset ⇒ eligible (today-behavior). */
  readonly linkableColorScale?: boolean
}

/**
 * Which catalog "vocabulary" a binding channel draws its options + default from
 * (EXTENSIBILITY_STUDY Part 6 STEP 2). This is how a chart declares WHAT KIND of column
 * a channel binds to, without the core enumerating per-kind binding shapes.
 *
 *  - `categorical` — one categorical column id (the `groupKey` channel).
 *  - `value`       — one value-column key (the primary `valueKey` channel).
 *  - `valueList`   — several value-column keys (the matrix `valueKeys` channel).
 *  - `continuous`  — one continuous column id (histogram's value channel).
 *  - `table`       — a FIXED bulk-table name (volcano's `tableName`); no catalog options.
 */
export type BindingSource = 'categorical' | 'value' | 'valueList' | 'continuous' | 'table'

/**
 * One data-binding channel a chart type declares it needs (EXTENSIBILITY_STUDY §3.2 /
 * Part 6 STEP 2). A chart's `bindingSchema` is the ordered list of these; it is the
 * per-kind binding knowledge that USED to be hard-coded in `CellView`'s switch and the
 * shared `defaultBindings` — now OWNED by the descriptor. `model()` resolves each channel
 * against the dataset catalog; the chrome renders / describes controls generically from
 * this schema (never a hard-coded per-kind list).
 */
export interface BindingChannel {
  /** Stable id — the key under which the resolved value lands in `ChartModel.bindings`,
   *  and the key the chrome uses for its control. Unique within a schema. */
  readonly id: string
  /** Which catalog vocabulary supplies this channel's options + default. */
  readonly source: BindingSource
  /** Human label for the chrome's binding control. */
  readonly label: string
  /** For `source: 'table'` — the fixed table name to bind (e.g. `'de'`). */
  readonly constant?: string
  /** For `source: 'value' | 'valueList'` — cap on how many value columns to consider
   *  (default 6, matching the legacy `defaultBindings` slice). */
  readonly limit?: number
  /** This channel is NICE TO HAVE, not required: the chart is meaningful without it, and a
   *  dataset that cannot supply it must still be able to render the chart.
   *
   *  It exists because satisfiability decides what the per-cell KIND SWITCHER offers. A
   *  distribution needs a value column; a grouping merely splits it. Treating the grouping as
   *  required meant a frame with no categorical column could not offer a violin at all — so
   *  switching a cell away from violin was a ONE-WAY DOOR, with no way back and no explanation. */
  readonly optional?: boolean
}

/**
 * The resolved bindings of a `ChartModel`, keyed by each schema channel's `id`. A single
 * column channel resolves to a `string`; a multi-column (`valueList`) channel to a
 * `readonly string[]`. Generic (not a fixed shape) so each chart owns its own channels —
 * the core never enumerates them. Read via `bindingValue` / `bindingList` (`model.ts`).
 */
export type ResolvedBindings = Readonly<Record<string, string | readonly string[]>>

/**
 * WHAT a binding channel resolved to — a discriminated result, not a bare column name.
 *
 * A resolver whose return type is `string` can only ever say a column, so when it has no
 * evidence it must invent one. That is the whole first-of-N family: `resolveBinding` used to
 * answer an unresolvable `categorical` channel with `catalog.categoricalColumns[ordinal]?.id
 * ?? 'group'` — catalog ORDER (real, stable, meaningless) and then a literal from the
 * in-package fixtures' vocabulary. Both are plausible; neither is evidence.
 *
 * So refusal is made EXPRESSIBLE, and the five statuses are five genuinely different things a
 * caller must do (`docs/design/binding-resolution-refusal.md`, INV-1/INV-4):
 *
 *   `bound`      — an exact id-match, or the SOLE candidate of this channel's kind. A sole
 *                  candidate is not a choice at all, which is why it binds (DEC-2) and why
 *                  every single-column dataset behaves exactly as it did before.
 *   `bound-list` — a multi-column (`valueList`) channel. `total` is how many candidates there
 *                  WERE, so a truncated list can say "6 of 40" instead of implying 6 is all
 *                  there is.
 *   `unbound`    — DELIBERATELY no column. This is viz's in-band `''`, and it is a DIFFERENT
 *                  answer from `absent`: an explicitly-empty channel says "nothing, on
 *                  purpose", an absent one says "never mentioned". Collapsing the two is the
 *                  bug behind *"the violin shows many groups before I choose anything"*
 *                  (INV-4) — so they are two statuses, not one.
 *   `absent`     — the catalog offers NO candidate of this kind. Silence, not contradiction.
 *   `ambiguous`  — SEVERAL candidates and nothing distinguishes them, so the channel
 *                  identifies NONE of them. This is the one a fallback must not absorb: every
 *                  candidate is a real column, so any substitute stays plausible all the way
 *                  down to the pixels.
 *
 * Modelled directly on `AxisResolution` in the app's `extensions/data/contract.ts`, which
 * made this same call for axis labels and recorded why: `undefined` "conflates two situations
 * that license OPPOSITE caller behaviour, and every consumer that collapsed them wrote the
 * same bug: `axisByLabel(…) ?? <some other axis>`."
 */
export type BindingResolution =
  | { readonly status: 'bound'; readonly column: string }
  | {
      readonly status: 'bound-list'
      readonly columns: readonly string[]
      /** How many candidates existed before `limit` truncated the list (≥ `columns.length`). */
      readonly total: number
    }
  | { readonly status: 'unbound' }
  | { readonly status: 'absent'; readonly source: BindingSource }
  | {
      readonly status: 'ambiguous'
      readonly source: BindingSource
      readonly candidates: readonly string[]
    }

/** Every channel's `BindingResolution`, keyed by channel id — the companion of
 *  `ResolvedBindings`, which carries only the BOUND ones. */
export type BindingResolutions = Readonly<Record<string, BindingResolution>>

/** Context handed to a descriptor's `model()` — the dataset catalog it fills defaults
 *  from (EXTENSIBILITY_STUDY §3.2, `catalog` lets a series fill defaults). */
export interface ModelContext {
  readonly catalog: DatasetCatalog
}

/**
 * The resolved model handed to a chart View through the uniform `ChartViewProps`. It
 * carries the cell's chosen `kind`, the resolved data `bindings` (produced by the
 * descriptor's own `model()` from its `bindingSchema`), and the `cell` config. The View
 * reads the fields it needs; the adapter spreads `model.bindings` onto its wrapped View's
 * props (EXTENSIBILITY_STUDY Part 6 STEP 2).
 */
export interface ChartModel {
  /** The registry key this model was resolved for (the cell's `kind`). */
  readonly kind: string
  /**
   * The resolved data bindings, keyed by this chart's own `bindingSchema` channel ids.
   *
   * Carries ONLY the channels that actually resolved to a column (`bound`/`bound-list`) plus
   * the explicitly-`unbound` ones (as `''`, which is what unbound MEANS on this wire). A
   * channel that could not be decided — `absent` or `ambiguous` — is **not a key here at
   * all**: it is neither a column nor a deliberate blank, and writing it as `''` would spell
   * a refusal with the token that already means "on purpose" (INV-4).
   */
  readonly bindings: ResolvedBindings
  /**
   * What EVERY declared channel resolved to, including the ones that refused. This is the
   * fact a caller gates on — `resolutions[id].status === 'ambiguous'`, not
   * `bindings[id] === undefined`, which is true for a legitimately-unbound channel too and
   * so cannot tell a refusal from a choice (INV-5).
   */
  readonly resolutions: BindingResolutions
  /** The grid cell config this model was resolved from. */
  readonly cell: GridCell
}

/**
 * The injected handle a chart View uses to READ the shared cross-plot selection (+ shared
 * color domain) and PUBLISH a selection, instead of importing the concrete `Coordination`
 * store directly (EXTENSIBILITY_STUDY §3.2 / §5.2, Part 6 STEP 3). The handle wraps the
 * `Coordination` store — now an implementation DETAIL of the Selection component — so every
 * View is decoupled from the store (testable + the coordination mechanism is swappable). A
 * View CONSUMES the shared selection iff its descriptor's `capabilities.consumesSelection`
 * (it reads through the handle); it PRODUCES iff `capabilities.producesSelection` (its
 * brush/lasso/band gesture calls `setSelection` through the handle).
 *
 * The `use*` members are React hooks (reactive reads) — call them at the top of a View's
 * render, exactly like the store selector they replace. The emphasis computation
 * (`useGroupEmphasis`) is the component's visual-stage handler: ONE place computes each
 * consuming chart's emphasis artifacts from the shared selection via the pure `selectionSync`
 * helpers (`groupEmphasis`/`groupEmphasisByIds`), which are unchanged (they're the moat).
 */
export interface CoordinationHandle {
  /** Reactive read of the shared canonical-id point selection (`null`/empty ⇒ no selection). */
  readonly usePointSelection: () => Uint32Array | null
  /** Reactive exclusive-selection reconciliation signal `{ epoch, origin }` — a producer surface drops
   *  its committed outline when `origin !== its own id` (single-mode replace elsewhere / Clear). */
  readonly useExclusiveSelection: () => { epoch: number; origin: string | null }
  /** Available seam — no built-in View consumes it yet. Reactive read of the origin id
   *  that produced the current selection (intended for self-echo suppression). */
  readonly useSelectionOrigin: () => string | null
  /**
   * Reactive group-mark emphasis for a CONSUMING group chart (box / bar / dotplot / violin),
   * computed from the CURRENT shared selection over this chart's per-point `codes` via the pure
   * `selectionSync` helpers. `idToRow` is the multi-source seam (absent ⇒ index identity).
   */
  readonly useGroupEmphasis: (
    codes: Uint16Array | Uint32Array,
    idToRow?: IdToRow | null,
  ) => GroupEmphasis
  /** Available seam — no built-in View consumes it yet. Reactive shared (union) color
   *  domain across scopes coloring by `key`, or `null`. */
  readonly useSharedColorDomain: (key: string) => [number, number] | null
  /** Publish a selection ORIGINATING from `originId` (canonical point ids; `null` clears). */
  readonly setSelection: (
    originId: string | null,
    ids: Uint32Array | null,
    accumulate?: boolean,
  ) => void
  /** Publish a selection with NO origin attribution. */
  readonly setPointSelection: (ids: Uint32Array | null) => void
  /** Clear the shared selection + its origin. */
  readonly clearSelection: () => void
  /**
   * Reactive read of ONE IDENTITY SPACE's shared canonical-id point selection (`null`/empty ⇒ no
   * selection in that space). This is the multi-datasource / image↔data linking seam (ITEM-13): a
   * selection made against one datasource's id space never surfaces on a read of another space
   * (identity-space isolation). The `DEFAULT_SELECTION_SPACE` id is byte-identical to
   * `usePointSelection` (the default space mirrors the legacy top-level selection). Call at the top
   * of a View's render exactly like `usePointSelection`.
   */
  readonly usePointSelectionInSpace: (spaceId: string) => Uint32Array | null
  /** Reactive read of ONE identity space's origin view id (for self-echo suppression on the consume
   *  leg), or `null` when unknown / empty. The `DEFAULT_SELECTION_SPACE` id mirrors `useSelectionOrigin`. */
  readonly useSelectionOriginInSpace: (spaceId: string) => string | null
  /** Publish a selection into ONE identity space (canonical point ids; `null`/empty clears that
   *  space, leaving other spaces untouched). Writing `DEFAULT_SELECTION_SPACE` keeps the top-level
   *  selection in lockstep (equivalent to `setSelection`). */
  readonly setSelectionInSpace: (
    spaceId: string,
    originId: string | null,
    ids: Uint32Array | null,
  ) => void
  /** Clear ONE identity space's selection + its origin (other spaces untouched). */
  readonly clearSelectionInSpace: (spaceId: string) => void
}

/**
 * The UNIFORM View props every chart View honors (EXTENSIBILITY_STUDY §3.2). This is
 * what lets the core dispatch generically instead of `switch`ing on bespoke props.
 * STEP 3 adds `coordination` (the injected Selection handle). There is intentionally NO
 * `window` prop: the core does NOT thread a dataZoom window through here — each chart View
 * HOSTS its OWN DataZoom component today (the `ValueDataZoom` / `DataZoomMatrix` widgets
 * live in core and are instantiated by the View, which owns its own window `useState`).
 */
export interface ChartViewProps {
  /** The resolved model (post-`defaultBindings`), incl. the bindings the cell declared. */
  readonly model: ChartModel
  /** The viz data plane (unchanged `DataSource`). */
  readonly source: DataSource
  /** The dataset catalog (column ids / labels the View / adapter may read). */
  readonly catalog: DatasetCatalog
  /**
   * The coordination handle (STEP 3): READ the shared selection/color, PUBLISH a selection.
   * Optional — a View that omits it falls back to the default store-backed handle, so a
   * plain `<View model source catalog />` still works (byte-identical). `CellView`/
   * `GridWorkspace` construct + thread the handle so every dispatched chart gets it.
   */
  readonly coordination?: CoordinationHandle
  /**
   * ENFORCED capability flags (viz-followups Area B, ITEM-4). `CellView.ChartBody` resolves
   * each as `cell.<flag> ?? descriptor.capabilities.<flag>` and threads it here; the View
   * reads it to gate its consume / produce / dataZoom behavior. `undefined` ⇒ the View's
   * today-behavior (byte-identical); an explicit value enforces the opt-out. See
   * `ChartCapabilities` for the per-flag contract.
   */
  readonly consumesSelection?: boolean
  readonly producesSelection?: boolean
  readonly dataZoomAxes?: readonly ('x' | 'y')[]
  // NOTE: `linkableColorScale` is intentionally NOT a View prop — it is enforced entirely in
  // `parse.ts` (the shared-domain join is AND-gated there), never read by a View. It lives only on
  // `ChartCapabilities` (the descriptor) + `GridCell` (the parsed value). Threading it here would be
  // dead wiring.
}

/**
 * Everything the core needs to run one chart type WITHOUT knowing what it is
 * (EXTENSIBILITY_STUDY §3.2). A chart type registers exactly one of these via
 * `registerChartType`; a third-party chart is byte-identical in shape (no privileged
 * access).
 */
export interface ChartTypeDescriptor {
  /** The `kind` string a cell matches (e.g. `'violin'`). Unique across the registry. */
  readonly type: string
  /** Which coordinate system / render host this chart composes into. */
  readonly coordinateSystem: CoordSystemId
  /**
   * VIEW: the React component that renders this chart from the uniform `ChartViewProps`.
   * STEP 1 this is a THIN ADAPTER around the existing `*View.tsx`. This replaces the
   * `switch (cell.kind)`.
   */
  readonly view: ComponentType<ChartViewProps>
  /** How this chart participates in the shared components (declarative metadata). */
  readonly capabilities?: ChartCapabilities
  /**
   * This chart's OWN binding schema — the ordered channels it needs (EXTENSIBILITY_STUDY
   * Part 6 STEP 2). This is the per-kind binding knowledge lifted out of `CellView`'s
   * switch and the shared `defaultBindings`. The chrome reads it to render / describe
   * binding controls generically; `model()` resolves it against the catalog. A chart with
   * no bindings (scatter / image / grid) declares `[]` (or omits it).
   */
  readonly bindingSchema?: readonly BindingChannel[]
  /**
   * MODEL: resolve a cell + the dataset catalog into the `ChartModel` the View renders
   * (EXTENSIBILITY_STUDY §3.2 — mirrors ECharts `SeriesModel.getInitialData`). Pure; no
   * React, no deck — unit-testable in node. The core (`CellView`) calls this GENERICALLY
   * to produce `ChartViewProps.model`, so it never needs to know this chart's binding
   * shape. Built-ins derive it from `bindingSchema` via `makeChartModel` (`model.ts`).
   */
  readonly model: (cell: GridCell, ctx: ModelContext) => ChartModel
}
