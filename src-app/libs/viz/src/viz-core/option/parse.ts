// option/parse.ts — the PURE `VizOption` → `ResolvedOption` parser (EXTENSIBILITY_STUDY
// Part 4 / Part 6 STEP 6). This is the translation layer's core: it resolves the `dataset`
// (catalog), the `grid` regions (→ a split-tree layout), each `series` (→ a resolved
// `ChartModel` via its descriptor's `model()`, with `encode` bindings overlaid), and the
// decoupled components (`dataZoom`/`selection`/`colorScale`). NOTHING chart-specific lives
// here — every per-kind decision is delegated to the registered descriptor.
//
// PURE: no React, no deck, no store — a `VizOption` + a `DatasetCatalog` in, a `ResolvedOption`
// out — so it is unit-testable in node (the Part 4 linked scatter+heatmap example resolves to a
// known plan). The registry MUST be populated first (`installBuiltins()` / `use([...])`); an
// unregistered `series[].type` throws the ECharts "used but not imported" error, not a silent
// miss. The (impure) `VizController` calls this then drives the existing stores from the plan.

import type { DatasetCatalog } from '../data/wire'
import type { ColorBy } from '../data/engine'
import type { GridCell } from '../grid/gridModel'
import { cellSpaceKey } from '../grid/gridModel'
import type { LayoutNode, SplitDir } from '@ziee/dock'
import { leafIds } from '@ziee/dock'
import { columnAvailability, getChartType, schemaSatisfiable } from '../registry/registry'
import type { BindingChannel, BindingResolution, BindingSource, ChartModel, ResolvedBindings } from '../registry/types'
import { transitionConfigError, type TransitionConfig, type TransitionProp } from '../charts/transitions'
import type {
  ResolvedDataZoom,
  ResolvedOption,
  ResolvedSeries,
  VizColorBy,
  VizColorOverride,
  VizDataset,
  VizEncode,
  VizGridEntry,
  VizOption,
  VizSelectionContext,
  VizSelectionOp,
  VizViewportState,
} from './types'
import { resolveControls } from './types'

/**
 * The layout id a series binds when its `encode.layout` says nothing AND the catalog cannot
 * decide for it. It is a LAST RESORT that names nothing in particular, deliberately: the
 * previous value was `'primary'`, which is what the in-package fixtures and the grid store
 * happen to call their point layout — a guess at another module's vocabulary, exactly as
 * `useGridData` documented when it removed the identical literal from ITS path.
 *
 * It is the EMPTY STRING, and that is the whole point: `''` is viz's existing in-band spelling
 * of "no column / nothing bound" (`validateBindings` skips it, `seriesBoundColumns` skips it,
 * `resolveBindingChannel` returns `unbound` for it), so an unresolvable layout is expressed in
 * a vocabulary the tree already understands instead of a new one.
 *
 * The first attempt here was a SENTINEL — `'\u0000unresolved-layout'` — and a blind review was
 * right to call it what it was: the condemned literal `'primary'` replaced by a different
 * invented literal, handed verbatim to `source.positions(...)`, guarded by nothing anywhere in
 * the tree. Naming a thing "unresolved" does not make a host source treat it as unresolved.
 *
 * `GridCell.layoutId` stays a required field (~71 read sites; making it optional is a wider
 * change than this one), so the empty string is what a cell carries when the catalog declares
 * NO layout at all — `useGridData` already treats a missing layout as "no point cloud", which
 * is the honest render for a dataset with no spatial substrate.
 */
const UNRESOLVED_LAYOUT_ID = ''

/**
 * The `VizOption` schema version (DEC-16 / ITEM-7). Bump on a BREAKING option shape change + add an
 * arm to `migrateOption`. All fields added by this consolidation are OPTIONAL/additive, so `1` is
 * the first versioned shape; an unversioned option is treated as current. This is a SEPARATE axis
 * from the (now-superseded) `VIZ_SESSION_STATE_VERSION` — `migrateOption` absorbs those v1/v2/v3
 * session snapshots forward into a `VizOption`.
 */
export const VIZ_OPTION_VERSION = 1

/** The highest legacy `VizSessionState` snapshot version `migrateOption` will absorb (v1 added the
 *  dataZoom/filter interaction pieces, v2 the docking keys, v3 the multi-dataset id set — all
 *  optional/additive, so one arm reads them all). A newer session blob is refused, not dropped. */
const MAX_LEGACY_SESSION_VERSION = 3

/**
 * Reject a `colorBy` that cannot name anything to colour BY, so it fails at parse instead of
 * painting a default colour and looking fine.
 *
 * `VizColorBy` requires `{ mode, key }` (or the `blend` pair), but a declarative option arrives as
 * untyped JSON, so a view can write `colorBy: "$state.groupBy"` and hand a bare STRING through.
 * That used to resolve to `{ colormap:'viridis', scale:'linear', hidden:Set{} }` — an object with
 * no `mode` and no `key`, which every consumer reads as "colour by nothing". The result was a
 * colour control that appeared to work and silently did nothing; the shipped cell-filter embedding
 * panes were in exactly that state. An authoring mistake in a declaration must say so, like an
 * unregistered `switchTo` type does.
 */
function assertColorByShape(seriesId: string, raw: unknown): void {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(
      `[viz] series "${seriesId}": colorBy must be an object ({ mode, key }), not ${typeof raw} — ` +
        `a bare column name colours by nothing`,
    )
  }
  const cb = raw as { mode?: unknown; key?: unknown }
  if (cb.mode === 'blend') return // validateColorBy checks the blend pair against the catalog
  if (typeof cb.mode !== 'string' || typeof cb.key !== 'string' || cb.key === '') {
    throw new Error(
      `[viz] series "${seriesId}": colorBy needs a mode and a non-empty key ` +
        `(got mode=${JSON.stringify(cb.mode)}, key=${JSON.stringify(cb.key)})`,
    )
  }
}

/** Fill a partial `encode.colorBy` into a full `ColorBy` (defaults mirror `DEFAULT_COLOR_BY`).
 *  `blend` resolves the categorical→hue + continuous→lightness/alpha shape; every single-channel
 *  mode resolves EXACTLY as before. */
function resolveColorBy(partial: VizColorBy): ColorBy {
  if (partial.mode === 'blend') {
    return {
      mode: 'blend',
      // `key` echoes categoryKey so the shared color-scale + existing `colorBy.key` consumers
      // stay valid across the union; the blend branch reads categoryKey/valueKey.
      key: partial.categoryKey,
      categoryKey: partial.categoryKey,
      valueKey: partial.valueKey,
      channel: partial.channel ?? 'lightness',
      alphaFloor: partial.alphaFloor,
      perGroupDomain: partial.perGroupDomain ?? true,
      colormap: partial.colormap ?? 'viridis',
      scale: partial.scale ?? 'linear',
      // STRICT-JSON (DEC-12): the option's `hidden` may be a sorted `number[]` (wire form) OR a
      // `Set` (back-compat input); normalize to the engine's `Set` here. `new Set(iterable)` accepts
      // both; an absent `hidden` yields the empty set (byte-identical to before).
      hidden: partial.hidden ? new Set<number>(partial.hidden) : new Set<number>(),
      ...(partial.palette ? { palette: partial.palette } : {}),
      ...(partial.categoryColors ? { categoryColors: partial.categoryColors } : {}),
      ...(partial.categoryLabels ? { categoryLabels: partial.categoryLabels } : {}),
    }
  }
  return {
    mode: partial.mode,
    key: partial.key,
    colormap: partial.colormap ?? 'viridis',
    scale: partial.scale ?? 'linear',
    // See the blend branch: normalize the strict-JSON `number[]` | `Set` `hidden` to the engine `Set`.
    hidden: partial.hidden ? new Set<number>(partial.hidden) : new Set<number>(),
    // Additive categorical override layer (palette / by-name colors / display labels). Absent ⇒
    // omitted (no field), so a no-override colorBy is byte-identical to before.
    ...(partial.palette ? { palette: partial.palette } : {}),
    ...(partial.categoryColors ? { categoryColors: partial.categoryColors } : {}),
    ...(partial.categoryLabels ? { categoryLabels: partial.categoryLabels } : {}),
  }
}

/**
 * Validate a resolved `blend` colorBy against the dataset catalog (fail LOUD at parse, like
 * `validateBindings`): `categoryKey` MUST be a categorical column, `valueKey` a value/continuous
 * column. Single-channel modes are not validated here (their bindings are validated via `encode`).
 * Phase 1 accepts a single categorical + single continuous only.
 */
function isColorEntry(v: unknown): boolean {
  if (typeof v === 'string') return v.length > 0
  return Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number')
}

function validateColorBy(seriesId: string, colorBy: ColorBy, catalog: DatasetCatalog): void {
  // Minimal shape validation of the additive categorical override layer (all modes): a palette
  // entry / by-name color must be a CSS string or an [r,g,b] triple. A bad value fails LOUD at
  // parse (consistent with the blend/binding validation) rather than silently rendering black.
  if (colorBy.palette) {
    colorBy.palette.forEach((entry, i) => {
      if (!isColorEntry(entry)) {
        throw new Error(
          `[viz] series "${seriesId}": colorBy.palette[${i}] must be a CSS color string or an [r,g,b] triple`,
        )
      }
    })
  }
  if (colorBy.categoryColors) {
    for (const [name, entry] of Object.entries(colorBy.categoryColors)) {
      if (!isColorEntry(entry)) {
        throw new Error(
          `[viz] series "${seriesId}": colorBy.categoryColors["${name}"] must be a CSS color string or an [r,g,b] triple`,
        )
      }
    }
  }
  if (colorBy.mode !== 'blend') return
  const catCols = new Set(catalog.categoricalColumns.map(c => c.id))
  const valCols = new Set([...catalog.continuousColumns.map(c => c.id), ...catalog.valueColumns])
  const categoryKey = colorBy.categoryKey ?? colorBy.key
  if (!catCols.has(categoryKey)) {
    throw new Error(
      `[viz] series "${seriesId}": blend colorBy categoryKey "${categoryKey}" is not a categorical column in the dataset`,
    )
  }
  if (!colorBy.valueKey || !valCols.has(colorBy.valueKey)) {
    throw new Error(
      `[viz] series "${seriesId}": blend colorBy valueKey "${colorBy.valueKey ?? '(missing)'}" is not a value/continuous column in the dataset`,
    )
  }
}

/**
 * Overlay a series' `encode` onto a descriptor-resolved model's bindings. Only channels the
 * chart DECLARES (`bindingSchema`) are overlaid, keyed by each channel's `source` — so the
 * core still never enumerates a chart's binding shape; it reads the chart's own schema to
 * interpret `encode`. Unknown `encode` keys ride through untouched (they don't affect bindings).
 */
function overlayEncode(
  base: ChartModel,
  encode: VizEncode | undefined,
  schema: readonly BindingChannel[] | undefined,
): ChartModel {
  if (!encode || !schema || schema.length === 0) return base
  const bindings: Record<string, string | readonly string[]> = { ...base.bindings }
  // Which channels the encode actually SET, so the resolution map can record them as `bound`
  // (an author's declaration is evidence, and outranks a catalog refusal — see `makeChartModel`).
  // Tracked separately from `bindings` because a channel the catalog refused is ABSENT from
  // `bindings`, so "did this key change?" cannot be read off the object afterwards.
  const overlaid = new Set<string>()
  for (const channel of schema) {
    const before = bindings[channel.id]
    switch (channel.source) {
      case 'categorical':
        if (typeof encode.groupKey === 'string') bindings[channel.id] = encode.groupKey
        break
      case 'value':
        if (typeof encode.valueKey === 'string') bindings[channel.id] = encode.valueKey
        break
      case 'continuous':
        if (typeof encode.continuousKey === 'string') bindings[channel.id] = encode.continuousKey
        else if (typeof encode.valueKey === 'string') bindings[channel.id] = encode.valueKey
        break
      case 'valueList':
        if (Array.isArray(encode.valueKeys)) bindings[channel.id] = [...encode.valueKeys]
        break
      case 'table':
        if (typeof encode.table === 'string') bindings[channel.id] = encode.table
        break
    }
    if (bindings[channel.id] !== before) overlaid.add(channel.id)
  }
  const resolutions: Record<string, BindingResolution> = { ...base.resolutions }
  for (const id of overlaid) {
    const v = bindings[id]
    resolutions[id] = Array.isArray(v)
      ? { status: 'bound-list', columns: v, total: v.length }
      : v === ''
        ? { status: 'unbound' }
        : { status: 'bound', column: v as string }
  }
  return {
    kind: base.kind,
    bindings: bindings as ResolvedBindings,
    resolutions,
    cell: base.cell,
  }
}

/**
 * WHICH layout a series' positions are read from: the DECLARED one, else the catalog's SOLE
 * layout, else unresolved.
 *
 * A declaration is evidence and wins outright (it is not checked against the catalog here —
 * `validateBindings` owns column validation, and a layout is not a column). Absent a
 * declaration, one layout is not a choice at all, so it binds. SEVERAL layouts with no
 * declaration is the first-of-N shape — `layouts[0]` would pick whichever the producer
 * happened to list first — so it resolves to {@link UNRESOLVED_LAYOUT_ID} instead.
 */
function resolveLayoutId(declared: unknown, catalog: DatasetCatalog): string {
  if (typeof declared === 'string' && declared !== '') return declared
  if (catalog.layouts.length === 1) return catalog.layouts[0].id
  // SEVERAL layouts and no declaration is still a guess, and it is REPORTED rather than
  // refused for the same reason `useGridData` reports its twin: refusing paints a blank pane,
  // and a shipped option that never declared a layout would go blank on upgrade. What changed
  // is that the last resort is now a layout the CATALOG declares instead of the literal
  // `'primary'` — a guess narrowed to the data's own vocabulary. Enumerated as F11.
  return catalog.layouts[0]?.id ?? UNRESOLVED_LAYOUT_ID
}

/** True in dev/test builds (Vite sets `import.meta.env.DEV`; production strips it). Mirrors
 *  `core/contextLoss.ts`'s gate — used to keep the encode-key warning out of release builds. */
function isDevEnv(): boolean {
  try {
    const env = (import.meta as unknown as { env?: { DEV?: boolean } }).env
    if (env && typeof env.DEV === 'boolean') return env.DEV
  } catch {
    /* import.meta unavailable (plain node) — fall through */
  }
  try {
    return typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production'
  } catch {
    return false
  }
}

/** Encode keys valid on EVERY series (not chart-specific bindings). */
const ALWAYS_ENCODE_KEYS: readonly string[] = ['layout', 'colorBy']

/** The `encode.*` key(s) each binding-channel `source` reads (mirrors `overlayEncode`). */
function encodeKeysForSource(source: BindingSource): readonly string[] {
  switch (source) {
    case 'categorical':
      return ['groupKey']
    case 'value':
      return ['valueKey']
    case 'continuous':
      return ['continuousKey', 'valueKey'] // continuous falls back to valueKey
    case 'valueList':
      return ['valueKeys']
    case 'table':
      return ['table']
  }
}

/**
 * DEV-mode warn (M5) for a misspelled `encode` key: the `VizEncode` index signature lets any
 * key type-check, so a typo (`grpKey` for `groupKey`) is otherwise SILENTLY dropped. Warn —
 * never throw — so the arbitrary-key escape hatch (heatmap `cluster`, …) still rides through.
 */
function warnUnknownEncodeKeys(
  seriesId: string,
  encode: VizEncode | undefined,
  schema: readonly BindingChannel[] | undefined,
): void {
  if (!encode || !isDevEnv()) return
  const allowed = new Set<string>(ALWAYS_ENCODE_KEYS)
  for (const channel of schema ?? []) for (const k of encodeKeysForSource(channel.source)) allowed.add(k)
  for (const key of Object.keys(encode)) {
    if (!allowed.has(key)) {
      console.warn(
        `[viz] series "${seriesId}": encode key "${key}" is not a recognized binding channel ` +
          `for this chart and was ignored (did you misspell it?)`,
      )
    }
  }
}

/** The catalog column set + human `kind` a binding-channel `source` validates against, or
 *  `null` when the channel binds no dataset column (a `table` name). A `continuous` channel
 *  ALSO accepts a value column (the legitimate `valueKey` fallback in `overlayEncode`). */
function catalogColumnSet(
  catalog: DatasetCatalog,
  source: BindingSource,
): { valid: Set<string>; kind: string } | null {
  switch (source) {
    case 'categorical':
      return { valid: new Set(catalog.categoricalColumns.map(c => c.id)), kind: 'categorical' }
    case 'value':
    case 'valueList':
      return { valid: new Set(catalog.valueColumns), kind: 'value' }
    case 'continuous':
      return {
        valid: new Set([...catalog.continuousColumns.map(c => c.id), ...catalog.valueColumns]),
        kind: 'continuous',
      }
    case 'table':
      return null
  }
}

/**
 * Validate (#4) that every column id a series binds actually exists in the catalog as the right
 * KIND, throwing a clear error so the declarative path fails LOUD at parse instead of
 * half-mounting a View that then hangs on a rejected column fetch (the runtime try/catch is the
 * complement). An empty/absent binding is skipped, and `table` channels bind a fixed name, not a
 * column, so they are skipped too.
 *
 * ── THE CATALOG-DEFAULT EXEMPTION IS GONE, BECAUSE ITS SUBJECT IS ───────────────────────────
 *
 * This used to validate ONLY the channels a series' `encode` set explicitly, and the reason was
 * stated here: a catalog-DEFAULT binding "falls back to a conventional `'group'`/`'qcA'` NAME
 * when the dataset lacks that column kind", and "that fallback name is expected to be absent".
 * The exemption existed to protect an INVENTED column name from the validator that would
 * otherwise have caught it — the guess and the hole it needed were one change apart.
 *
 * `resolveBindingChannel` invents nothing now: a catalog-resolved channel is either a column the
 * catalog carries, or it is not in `bindings` at all. So there is no longer a class of binding
 * this must look away from, and every binding here can be checked.
 *
 * It is deleted rather than kept as a narrower skip because the narrower skip would have been
 * vacuous — a catalog default that reaches this loop is BY CONSTRUCTION a real catalog column,
 * so the condition could never fire. What guards the risk DEC-8 named (a silent guess becoming a
 * hard parse crash on a shipped chart) is not a condition here; it is that the resolver stopped
 * producing the input that would have crashed. `parse.test.ts` pins BOTH halves: every built-in
 * chart type still parses against an empty catalog, and an explicit encode naming a nonexistent
 * column still throws.
 */
function validateBindings(
  seriesId: string,
  bindings: ResolvedBindings,
  schema: readonly BindingChannel[] | undefined,
  catalog: DatasetCatalog,
): void {
  for (const channel of schema ?? []) {
    const spec = catalogColumnSet(catalog, channel.source)
    if (!spec) continue
    const value = bindings[channel.id]
    const ids = typeof value === 'string' ? (value ? [value] : []) : Array.isArray(value) ? value : []
    for (const id of ids) {
      if (!id) continue
      if (!spec.valid.has(id)) {
        throw new Error(
          `[viz] series "${seriesId}": encode binds "${id}" which is not a ${spec.kind} column in the dataset`,
        )
      }
    }
  }
}

/**
 * Validate a series' EXPLICIT `switchTo` alternatives (the author-declared set of chart types the
 * cell's kind switcher may offer) and return the resolved set threaded onto the cell. Each entry
 * MUST be (a) a REGISTERED chart type and (b) DATA-COMPATIBLE — its `bindingSchema` satisfiable by
 * the dataset's columns (`schemaSatisfiable`). An unknown / incompatible declared alternative throws
 * a clear `[viz]` error, consistent with the encode binding-validation (`validateBindings`): a bad
 * declarative option fails LOUD at parse rather than offering a switch target that can't render.
 * `undefined`/absent ⇒ the chrome auto-infers the compatible set (full back-compat).
 */
function resolveSwitchTo(
  seriesId: string,
  switchTo: readonly string[] | undefined,
  catalog: DatasetCatalog,
): readonly string[] | undefined {
  if (!switchTo) return undefined
  const avail = columnAvailability(catalog)
  for (const type of switchTo) {
    const desc = getChartType(type)
    if (!desc) {
      throw new Error(
        `[viz] series "${seriesId}": switchTo references unregistered type "${type}" — ` +
          `installBuiltins() or use([...]) the chart first`,
      )
    }
    if (!schemaSatisfiable(desc.bindingSchema, avail)) {
      throw new Error(
        `[viz] series "${seriesId}": switchTo type "${type}" is not compatible with the dataset ` +
          `(its binding schema needs columns the dataset does not have)`,
      )
    }
  }
  return [...switchTo]
}

/**
 * Validate + resolve a series' OPT-IN `transitions` config (default OFF). `false`/omitted ⇒
 * `undefined` (no transitions threaded — byte-identical render). An enabled config is validated
 * minimally (`transitionConfigError`: duration ≥ 0, known easing) and returned as-is, so a bad
 * declarative option fails LOUD at parse (consistent with `resolveSwitchTo` / `validateBindings`)
 * rather than silently reaching a View with a nonsense duration/easing.
 */
function resolveTransitions(
  seriesId: string,
  transitions: TransitionProp | undefined,
): TransitionConfig | undefined {
  const err = transitionConfigError(transitions)
  if (err) throw new Error(`[viz] series "${seriesId}": ${err}`)
  if (!transitions) return undefined
  return transitions
}

/** Resolve + clone an optional strict-JSON `viewState` (`{ target:[x,y], zoom }`). Absent/malformed
 *  ⇒ `undefined` (no field threaded). */
function resolveViewState(v: VizViewportState | undefined): VizViewportState | undefined {
  if (!v || !Array.isArray(v.target) || v.target.length !== 2 || typeof v.zoom !== 'number') {
    return undefined
  }
  return { target: [v.target[0], v.target[1]], zoom: v.zoom }
}

/** Clone a strict-JSON `Record<string, [number, number]>` (filters / color-scale domains). */
function cloneRangeMap(
  m: Record<string, readonly [number, number]> | undefined,
): Record<string, readonly [number, number]> | undefined {
  if (!m) return undefined
  const out: Record<string, readonly [number, number]> = {}
  for (const [k, v] of Object.entries(m)) out[k] = [v[0], v[1]]
  return out
}

/** Clone the strict-JSON per-space selection map (`Record<string, number[]>`). */
function cloneSpaces(
  m: Record<string, readonly number[]> | undefined,
): Record<string, readonly number[]> | undefined {
  if (!m) return undefined
  const out: Record<string, readonly number[]> = {}
  for (const [k, v] of Object.entries(m)) out[k] = [...v]
  return out
}

/** Clone + VALIDATE the selection provenance op list (ITEM-3).
 *
 *  Ops are a RECIPE: order is load-bearing and the geometry is re-run verbatim on restore, so a
 *  malformed op is rejected at the boundary rather than producing a silently wrong selection later.
 *  `paneIds` is the set of known grid/series ids — an op naming an unknown pane is a stale or
 *  hand-edited option and must not resolve. Errors use the existing `[viz] …` prose. */
function cloneSelectionOps(
  ops: readonly VizSelectionOp[] | undefined,
  paneIds: ReadonlySet<string>,
): VizSelectionOp[] | undefined {
  if (!ops) return undefined
  return ops.map((op, i) => {
    const where = `option.selection.ops[${i}]`
    if (op.tool !== 'rect' && op.tool !== 'polygon' && op.tool !== 'ids') {
      throw new Error(`[viz] ${where} has unknown tool "${(op as { tool: string }).tool}"`)
    }
    if (op.op !== 'add' && op.op !== 'subtract' && op.op !== 'intersect') {
      throw new Error(`[viz] ${where} has unknown combine op "${(op as { op: string }).op}"`)
    }
    // `pane: null` is legal ONLY for a programmatic id op (DEC-12).
    if (op.pane != null && !paneIds.has(op.pane)) {
      throw new Error(`[viz] ${where} names unknown pane "${op.pane}"`)
    }
    if (op.tool === 'rect') {
      if (!Array.isArray(op.region) || op.region.length !== 4 || op.region.some(n => typeof n !== 'number')) {
        throw new Error(`[viz] ${where} is a rect whose region is not 4 numbers`)
      }
      return { ...op, region: [...op.region] as [number, number, number, number] }
    }
    if (op.tool === 'polygon') {
      if (!Array.isArray(op.region) || op.region.length < 3) {
        throw new Error(`[viz] ${where} is a polygon with fewer than 3 vertices`)
      }
      return { ...op, region: op.region.map(v => [v[0], v[1]] as readonly [number, number]) }
    }
    return { ...op, region: [...op.region] }
  })
}

/** Clone the strict-JSON selection context. `hidden` is normalized to a SORTED `number[]` even when
 *  a `Set` is handed in, mirroring the `VizColorBy.hidden` wire discipline (`types.ts:225-228`) —
 *  no `Set` may reach the emitted option. */
function cloneSelectionContext(
  ctx: VizSelectionContext | undefined,
): VizSelectionContext | undefined {
  if (!ctx) return undefined
  const out: {
    filters?: Record<string, readonly [number, number]>
    hidden?: Record<string, readonly number[]>
    panes?: Record<string, string>
  } = {}
  if (ctx.filters) {
    const f: Record<string, readonly [number, number]> = {}
    for (const [k, v] of Object.entries(ctx.filters)) f[k] = [v[0], v[1]]
    out.filters = f
  }
  if (ctx.hidden) {
    const h: Record<string, readonly number[]> = {}
    for (const [k, v] of Object.entries(ctx.hidden)) {
      h[k] = [...(v as Iterable<number>)].sort((a, b) => a - b)
    }
    out.hidden = h
  }
  if (ctx.panes) {
    const p: Record<string, string> = {}
    for (const [k, v] of Object.entries(ctx.panes)) p[k] = v
    out.panes = p
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Clone the strict-JSON per-column display-override map. */
function cloneColorOverrides(
  m: Record<string, VizColorOverride> | undefined,
): Record<string, VizColorOverride> | undefined {
  if (!m) return undefined
  const out: Record<string, VizColorOverride> = {}
  for (const [k, v] of Object.entries(m)) {
    out[k] = {
      ...(v.categoryColors ? { categoryColors: { ...v.categoryColors } } : {}),
      ...(v.categoryLabels ? { categoryLabels: { ...v.categoryLabels } } : {}),
    }
  }
  return out
}

/** Even fractions summing to 1 for `n` children. */
function evenSizes(n: number): number[] {
  return Array.from({ length: n }, () => 1 / n)
}

/**
 * Build the split-tree `LayoutNode` from grid regions (EXTENSIBILITY_STUDY §5.3). Regions are
 * placed row-major: grouped by `region.row ?? 0`, each row sorted by `region.col ?? 0`. One
 * region ⇒ a leaf; one row ⇒ a `col` split; several rows ⇒ a `row` split of (`col`-split or
 * leaf) rows.
 */
export function buildLayout(entries: readonly VizGridEntry[]): LayoutNode {
  if (entries.length === 1) return { kind: 'leaf', id: entries[0].id }
  // Group by row (a missing `region` ⇒ the default cell {row:0,col:0}, DEC-5b pure-parse default).
  const rows = new Map<number, VizGridEntry[]>()
  for (const e of entries) {
    const r = e.region?.row ?? 0
    const arr = rows.get(r) ?? []
    arr.push(e)
    rows.set(r, arr)
  }
  const rowKeys = [...rows.keys()].sort((a, b) => a - b)
  const rowNodes: LayoutNode[] = rowKeys.map(rk => {
    const cols = rows.get(rk)!.slice().sort((a, b) => (a.region?.col ?? 0) - (b.region?.col ?? 0))
    if (cols.length === 1) return { kind: 'leaf', id: cols[0].id }
    return {
      kind: 'split',
      dir: 'col',
      sizes: evenSizes(cols.length),
      children: cols.map(c => ({ kind: 'leaf', id: c.id }) as LayoutNode),
    }
  })
  if (rowNodes.length === 1) return rowNodes[0]
  return { kind: 'split', dir: 'row', sizes: evenSizes(rowNodes.length), children: rowNodes }
}

/** Deep-clone a `LayoutNode` (pure JSON data) so a resolved plan never aliases the caller's tree. */
function cloneLayout(n: LayoutNode): LayoutNode {
  return n.kind === 'leaf'
    ? { kind: 'leaf', id: n.id }
    : { kind: 'split', dir: n.dir, sizes: [...n.sizes], children: n.children.map(cloneLayout) }
}

/** Replace the leaf `targetId` in `node` with `make()` (pure recursive tree map). */
function replaceLeaf(node: LayoutNode, targetId: string, make: () => LayoutNode): LayoutNode {
  if (node.kind === 'leaf') return node.id === targetId ? make() : node
  return { ...node, children: node.children.map(c => replaceLeaf(c, targetId, make)) }
}

/** Split the leaf `from` into a `dir` split of `[from, newId]` at fraction `at` (default 0.5) — the
 *  declarative equivalent of the store's `splitCell(from, dir)` gesture (DEC-5). */
function splitLeafAt(root: LayoutNode, from: string, dir: SplitDir, newId: string, at?: number): LayoutNode {
  const frac = typeof at === 'number' && at > 0 && at < 1 ? at : 0.5
  return replaceLeaf(root, from, () => ({
    kind: 'split',
    dir,
    sizes: [frac, 1 - frac],
    children: [
      { kind: 'leaf', id: from },
      { kind: 'leaf', id: newId },
    ],
  }))
}

/** True when ANY grid entry uses the `split`/`layout` placement form (⇒ the directive assembly path
 *  instead of the row-major `region` grid). */
function hasPlacementDirectives(entries: readonly VizGridEntry[]): boolean {
  return entries.some(e => e.split !== undefined || e.layout !== undefined)
}

/**
 * Assemble a split tree from the `split`/`layout` directive forms (DEC-5), in entry order:
 *  - an entry carrying a full `layout` subtree SEEDS the tree (the "resolved LayoutNode" form);
 *  - an entry with `split { from, dir, at? }` splits an existing pane;
 *  - an entry with neither (region-only / bare) is the anchor leaf (first) or already placed by a
 *    prior split (skipped); a stray unplaced entry is appended as a new column at the root.
 * Fails LOUD on a `split.from` that names no existing pane (mirrors the encode/coordId guards).
 */
function buildLayoutFromDirectives(entries: readonly VizGridEntry[]): LayoutNode {
  let tree: LayoutNode | null = null
  for (const e of entries) {
    if (e.layout !== undefined) {
      // A full resolved subtree — seed the tree (or, if one already exists, it must already contain
      // this entry's leaves; we keep the first-declared tree as authoritative).
      if (!tree) tree = cloneLayout(e.layout)
      continue
    }
    if (e.split !== undefined) {
      if (!tree) {
        throw new Error(
          `[viz] grid entry "${e.id}" uses split.from "${e.split.from}" but no prior pane exists to split`,
        )
      }
      if (!leafIds(tree).includes(e.split.from)) {
        throw new Error(`[viz] grid entry "${e.id}" splits from unknown pane "${e.split.from}"`)
      }
      tree = splitLeafAt(tree, e.split.from, e.split.dir, e.id, e.split.at)
      continue
    }
    // No directive — a bare / region-only anchor.
    if (!tree) {
      tree = { kind: 'leaf', id: e.id }
    } else if (!leafIds(tree).includes(e.id)) {
      tree = {
        kind: 'split',
        dir: 'col',
        sizes: evenSizes(2),
        children: [tree, { kind: 'leaf', id: e.id }],
      }
    }
  }
  if (!tree) throw new Error('[viz] no grid entries to build a layout from')
  return tree
}

/** Validate a resolved layout tree's leaves correspond 1:1 with the `grid` entry ids (DEC-5) so a
 *  `getOption`→`setOption(replace)` round-trip stays byte-for-byte. Rejects a DUPLICATE leaf id (e.g. a
 *  `split.newId` colliding with a leaf already in a seeded `layout` subtree) — a duplicate would
 *  collapse in a Set and silently produce two panes with one id in the grid store. Used on BOTH the
 *  `option.layout` path AND the `split`/`layout` directive-assembly path (they must validate alike). */
function validateLayoutLeaves(layout: LayoutNode, grid: readonly VizGridEntry[]): void {
  const leafList = leafIds(layout)
  const leaves = new Set<string>()
  for (const id of leafList) {
    if (leaves.has(id)) throw new Error(`[viz] layout has a duplicate pane "${id}"`)
    leaves.add(id)
  }
  const ids = new Set(grid.map(g => g.id))
  for (const id of leaves) {
    if (!ids.has(id)) throw new Error(`[viz] option.layout leaf "${id}" has no matching grid entry`)
  }
  for (const id of ids) {
    if (!leaves.has(id)) throw new Error(`[viz] grid entry "${id}" is absent from option.layout`)
  }
}

/**
 * Resolve the workspace layout tree from a `VizOption` — the SINGLE place the three placement forms
 * (`region` | `split` | `layout`) normalize into one `LayoutNode` (DEC-5):
 *  - `option.layout` present ⇒ the AUTHORITATIVE resolved tree (validated + cloned verbatim);
 *  - any grid entry uses `split`/`layout` ⇒ the directive assembly (`buildLayoutFromDirectives`);
 *  - otherwise ⇒ the row-major `region` grid (`buildLayout`, byte-identical to before).
 */
/**
 * The grid entries to lay out (DEC-5b): the explicit `option.grid` when non-empty, otherwise an AUTO
 * one-pane-per-series grid derived from the distinct series `coordId`s (first-appearance order,
 * row-major). So `<Viz option={{ series }}>` with NO `grid` mounts one pane per plot instead of
 * throwing "no grid entries". When `option.grid` IS provided it wins verbatim (byte-identical).
 */
export function effectiveGrid(option: VizOption): readonly VizGridEntry[] {
  if (option.grid.length > 0) return option.grid
  const seen = new Set<string>()
  const derived: VizGridEntry[] = []
  for (const s of option.series ?? []) {
    if (typeof s.coordId === 'string' && s.coordId !== '' && !seen.has(s.coordId)) {
      seen.add(s.coordId)
      derived.push({ id: s.coordId })
    }
  }
  return derived
}

export function resolveLayout(option: VizOption): LayoutNode {
  const grid = effectiveGrid(option)
  if (option.layout !== undefined) {
    validateLayoutLeaves(option.layout, grid)
    return cloneLayout(option.layout)
  }
  if (grid.length > 0 && hasPlacementDirectives(grid)) {
    // The directive path can silently drop/orphan/duplicate panes (a seed `layout` whose leaves
    // aren't grid ids; a grid entry never placed by any directive; a `split.newId` colliding with a
    // seeded leaf). Validate the assembled tree 1:1 against the grid — the SAME guard the
    // `option.layout` path uses — so those slip through LOUD, not into the grid store.
    const tree = buildLayoutFromDirectives(grid)
    validateLayoutLeaves(tree, grid)
    return tree
  }
  return buildLayout(grid)
}

/**
 * Parse a `VizOption` into the pure `ResolvedOption` plan (EXTENSIBILITY_STUDY Part 4). Throws
 * on a malformed option (duplicate ids, an unregistered `series[].type`, an unknown `coordId`,
 * an unbound region, a link referencing an unknown series) so a bad option fails LOUD, not
 * silently half-mounted. The registry must already hold the referenced chart types.
 */
/**
 * Normalize the MULTI-DATASOURCE dataset list: `dataset` (singular sugar) is prepended to
 * `datasets`, de-duped by id (first wins). At least one must be present. Single-dataset callers
 * pass `dataset` and get `[dataset]` — byte-identical downstream.
 */
export function normalizeDatasets(option: VizOption): VizDataset[] {
  const out: VizDataset[] = []
  const seen = new Set<string>()
  const push = (d: VizDataset | undefined) => {
    if (!d || typeof d.id !== 'string') return
    if (seen.has(d.id)) return
    seen.add(d.id)
    out.push(d)
  }
  push(option.dataset)
  for (const d of option.datasets ?? []) push(d)
  return out
}

/** A single `DatasetCatalog` (duck-typed by its `categoricalColumns` array) vs a per-dataset map. */
function isSingleCatalog(c: DatasetCatalog | Record<string, DatasetCatalog>): c is DatasetCatalog {
  return Array.isArray((c as DatasetCatalog).categoricalColumns)
}

/**
 * Parse a `VizOption` into the pure `ResolvedOption` plan (MULTI-DATASOURCE). The 2nd arg is a
 * catalog PER dataset id (each series is validated against ITS dataset's catalog) OR — back-compat —
 * a single `DatasetCatalog` used for every dataset (the single-dataset call).
 */
export function parseOption(
  option: VizOption,
  catalogs: DatasetCatalog | Record<string, DatasetCatalog>,
): ResolvedOption {
  // 0. Top-level shape guard — a structurally-malformed option fails LOUD with a clear `[viz]` message
  //    (parity with the rich per-field errors below) instead of a bare `TypeError` from a downstream
  //    dereference of a missing dataset/`grid`/`series`.
  if (!option || typeof option !== 'object') throw new Error('[viz] option must be an object')
  const datasets = normalizeDatasets(option)
  if (datasets.length === 0) {
    throw new Error('[viz] option.datasets (or option.dataset) with at least one { id } is required')
  }
  const datasetIds = datasets.map(d => d.id)
  const defaultDatasetId = datasetIds[0]
  const isMultiDataset = datasetIds.length > 1
  // Back-compat: a single catalog applies to every dataset (the single-dataset call).
  const catalogMap: Record<string, DatasetCatalog> = isSingleCatalog(catalogs)
    ? Object.fromEntries(datasetIds.map(id => [id, catalogs]))
    : catalogs
  if (!Array.isArray(option.grid)) throw new Error('[viz] option.grid must be an array')
  if (!Array.isArray(option.series)) throw new Error('[viz] option.series must be an array')

  // 1. Index grid regions (unique ids). DEC-5b: an empty `grid` + series auto-derives one pane per
  //    distinct series `coordId` (via `effectiveGrid`), so a grid-less option mounts rather than throws.
  const grid = effectiveGrid(option)
  const regionById = new Map<string, VizGridEntry>()
  for (const g of grid) {
    if (regionById.has(g.id)) throw new Error(`[viz] duplicate grid id "${g.id}"`)
    regionById.set(g.id, g)
  }

  // 2. Resolve each series → a cell (keyed by its region id) + a resolved model.
  const cells: Record<string, GridCell> = {}
  const series: ResolvedSeries[] = []
  const seriesIds = new Set<string>()
  for (const s of option.series) {
    if (seriesIds.has(s.id)) throw new Error(`[viz] duplicate series id "${s.id}"`)
    seriesIds.add(s.id)
    const desc = getChartType(s.type)
    if (!desc) {
      throw new Error(
        `[viz] series "${s.id}" uses unregistered type "${s.type}" — ` +
          `installBuiltins() or use([...]) the chart first`,
      )
    }
    // ENFORCED coordination capabilities (Area B, ITEM-4/6): the descriptor's declared defaults,
    // overlaid below with the per-series `emphasis`/`select` override + gated against the shared
    // color-scale link.
    const caps = desc.capabilities ?? {}
    if (!regionById.has(s.coordId)) {
      throw new Error(`[viz] series "${s.id}" references unknown coordId "${s.coordId}"`)
    }
    if (cells[s.coordId]) {
      throw new Error(
        `[viz] region "${s.coordId}" is bound by more than one series ` +
          `(v1 mounts one series per region)`,
      )
    }
    // MULTI-DATASOURCE (ITEM-2/5): resolve the series' dataset + validate its encode against THAT
    // dataset's catalog. Unset ⇒ the default (first) dataset. `catalog` (per-series) shadows into the
    // rest of the loop so every downstream validation uses the correct dataset's columns.
    const datasetId = s.datasetId ?? defaultDatasetId
    if (!datasetIds.includes(datasetId)) {
      throw new Error(`[viz] series "${s.id}" references unknown datasetId "${datasetId}"`)
    }
    const catalog = catalogMap[datasetId]
    if (!catalog) throw new Error(`[viz] no catalog provided for dataset "${datasetId}"`)
    const layoutId = resolveLayoutId(s.encode?.layout, catalog)
    // DEC-16: the color-by intent may live on `encode.colorBy` (original) OR the series-level
    // `colorBy` alias; `encode.colorBy` WINS when both are set (back-compat).
    const colorByInput = s.encode?.colorBy ?? s.colorBy
    if (colorByInput) assertColorByShape(s.id, colorByInput)
    const colorBy = colorByInput ? resolveColorBy(colorByInput) : undefined
    // DEC-14/16 additive per-series fields (carried onto the cell/series where a home exists).
    const graphOverlay = s.graphOverlay === true
    // ITEM-3 annotation opt-in (carried onto the cell → mints the per-cell AnnotateStore + overlay).
    const annotate = s.annotate === true
    // segmentation-scale ITEM-3 opt-in (carried onto the cell → in-grid label-mask surface + controls).
    const segment = s.segment === true
    // Plot-editing (ITEM-5, DEC-7): carry `radius` and/or `opacity` (0..1) when either is a number.
    const styleR = s.style && typeof s.style.radius === 'number' ? { radius: s.style.radius } : undefined
    const styleO = s.style && typeof s.style.opacity === 'number' ? { opacity: s.style.opacity } : undefined
    const style = styleR || styleO ? { ...styleR, ...styleO } : undefined
    // Plot-editing (ITEM-4): a plot title + optional x/y axis titles (present only when a string).
    const title = typeof s.title === 'string' ? s.title : undefined
    const axX = s.axisTitles && typeof s.axisTitles.x === 'string' ? { x: s.axisTitles.x } : undefined
    const axY = s.axisTitles && typeof s.axisTitles.y === 'string' ? { y: s.axisTitles.y } : undefined
    const axisTitles = axX || axY ? { ...axX, ...axY } : undefined
    const viewState = resolveViewState(s.viewState)
    // Fail LOUD on a blend colorBy naming a column of the wrong kind (mirrors validateBindings).
    if (colorBy) validateColorBy(s.id, colorBy, catalog)
    // ENFORCED (ITEM-6): a chart declaring `linkableColorScale:false` opts OUT of the shared color
    // domain — we refuse to link it even when `colorScale.link` names it. Unset/true ⇒ eligible
    // (byte-identical: no built-in declares `false`).
    const linkColorScale =
      (option.colorScale?.link.includes(s.id) ?? false) && caps.linkableColorScale !== false
    // Validate + resolve the explicit kind-switch set (throws on an unknown/incompatible entry).
    const switchTo = resolveSwitchTo(s.id, s.switchTo, catalog)
    // Validate + resolve the OPT-IN per-plot transition config (default off; throws on a bad one).
    const transitions = resolveTransitions(s.id, s.transitions)
    // ENFORCED coordination flags (ITEM-4): the EFFECTIVE value = per-series override ?? descriptor
    // default (undefined when NEITHER set — a chart with no declared/overridden capability, so the
    // cell omits the field and `ChartBody` falls back to the descriptor default = today-behavior).
    const consumesSelectionEff = s.emphasis?.consumesSelection ?? caps.consumesSelection
    const producesSelectionEff = s.select?.produces ?? caps.producesSelection
    const cell: GridCell = {
      id: s.coordId,
      kind: s.type,
      layoutId,
      // MULTI-DATASOURCE (ITEM-4): stamp datasetId when there are ≥2 datasets OR when THIS series
      // NAMED one. A cell without a datasetId reads the WORKSPACE source at render (`GridPaneLayer`:
      // `cellEntry?.source ?? source`) while its bindings were resolved + validated HERE against the
      // DECLARED dataset's catalog — the same source under ≥2 datasets, a different one the moment
      // the host's workspace source is not the option's dataset (the declarative-canvas mount, whose
      // workspace source is the whole project's data plane while the option's dataset resolves
      // through a `DatasetResolver`). Gating on the COUNT conflated "how many datasets exist" with
      // "did the author name one", so a canvas declaring ONE dataset read every binding from the
      // wrong source while a canvas declaring TWO worked.
      // A single-dataset option whose series names nothing is UNSTAMPED exactly as before, so
      // `cellSpaceKey` + the render path stay byte-identical for every such mount.
      ...(isMultiDataset || s.datasetId != null ? { datasetId } : {}),
      ...(colorBy ? { colorBy } : {}),
      ...(linkColorScale ? { linkColorScale: true } : {}),
      // Stamp the resolved capability flags (Area B, ITEM-4), mirroring how `colorBy`/`linkColorScale`
      // are stamped: only when meaningful (a declared/overridden value), so an un-capable chart stays
      // field-free and byte-identical.
      ...(consumesSelectionEff !== undefined ? { consumesSelection: consumesSelectionEff } : {}),
      ...(producesSelectionEff !== undefined ? { producesSelection: producesSelectionEff } : {}),
      ...(caps.dataZoomAxes ? { dataZoomAxes: [...caps.dataZoomAxes] } : {}),
      ...(caps.linkableColorScale !== undefined ? { linkableColorScale: caps.linkableColorScale } : {}),
      ...(switchTo ? { switchTo } : {}),
      ...(transitions ? { transitions } : {}),
      // DEC-16: the per-cell node-link graph overlay toggle (a real `GridCell` field). Only stamped
      // when the series opted in, so an un-overlaid cell stays field-free / byte-identical.
      ...(graphOverlay ? { graphOverlay: true } : {}),
      // ITEM-3: the per-cell annotation overlay toggle (a real `GridCell` field). Only stamped when
      // the series opted in, so a non-annotated cell stays field-free / byte-identical.
      ...(annotate ? { annotate: true } : {}),
      // segmentation-scale ITEM-3: the per-cell segmentation toggle (a real `GridCell` field). Only
      // stamped when the series opted in, so a non-segment cell stays field-free / byte-identical.
      ...(segment ? { segment: true } : {}),
      // Plot-editing (ITEM-4/5): the editable mark style + plot title + optional axis titles, stamped
      // onto the cell so the render + in-cell editors + getOption read them. Absent ⇒ field-free /
      // byte-identical.
      ...(style ? { style } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(axisTitles ? { axisTitles } : {}),
      // MATRIX value colormap (heatmap/dotplot) — stamped when the series set it.
      ...(s.valueColormap ? { valueColormap: s.valueColormap } : {}),
      // Phase 3: CONTROLLED close — stamp only when the series opted in, so a normal cell stays
      // field-free and its close X removes it directly (byte-identical).
      ...(s.controlled ? { controlled: true } : {}),
      // The user-facing reason this cell's close is unavailable. Stamped only when the series
      // declared one, so an ordinary cell stays field-free and removable (byte-identical).
      ...(typeof s.removeBlockedReason === 'string' && s.removeBlockedReason.trim().length > 0
        ? { removeBlockedReason: s.removeBlockedReason }
        : {}),
      // The per-cell provenance marker. Stamped only when the series declared one, so an
      // unmarked cell stays field-free — which is also what keeps markers RARE by construction.
      ...(typeof s.provenanceNote === 'string' && s.provenanceNote.trim().length > 0
        ? { provenanceNote: s.provenanceNote.trim() }
        : {}),
      // COMPOSED CANVAS: the authored id + the contribution that placed this cell. Stamped only
      // when the host supplied them, so an un-composed option's cells stay field-free and their DOM
      // identity remains `coordId` exactly as before.
      ...(typeof s.localId === 'string' && s.localId.length > 0 ? { localId: s.localId } : {}),
      ...(typeof s.ownerId === 'string' && s.ownerId.length > 0 ? { ownerId: s.ownerId } : {}),
    }
    cells[s.coordId] = cell
    const base = desc.model(cell, { catalog })
    const model = overlayEncode(base, s.encode, desc.bindingSchema)
    // Dev-warn a misspelled encode key (silently dropped otherwise), then fail LOUD on a
    // resolved binding that names a column absent from the dataset (complements the Views'
    // runtime try/catch — a bad declarative binding never reaches a half-mounted View).
    warnUnknownEncodeKeys(s.id, s.encode, desc.bindingSchema)
    validateBindings(s.id, model.bindings, desc.bindingSchema, catalog)
    series.push({
      id: s.id,
      type: s.type,
      coordId: s.coordId,
      datasetId,
      coordinateSystem: desc.coordinateSystem,
      model,
      consumesSelection: s.emphasis?.consumesSelection ?? caps.consumesSelection ?? false,
      producesSelection: s.select?.produces ?? caps.producesSelection ?? false,
      ...(colorBy ? { colorBy } : {}),
      linkColorScale,
      ...(transitions ? { transitions } : {}),
      // DEC-14/16 additive per-series carried fields (present only when the series set them).
      ...(graphOverlay ? { graphOverlay: true } : {}),
      ...(style ? { style } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(axisTitles ? { axisTitles } : {}),
      ...(viewState ? { viewState } : {}),
    })
  }

  // 3. Every region MUST be bound by a series (so layout leaves ↔ store cells stay in lockstep).
  //    Iterate the EFFECTIVE grid (DEC-5b auto-derive), not raw `option.grid` — a grid-less option
  //    has `option.grid === []`, which would make this check a silent no-op.
  for (const g of grid) {
    if (!cells[g.id]) throw new Error(`[viz] grid region "${g.id}" has no series bound to it`)
  }

  // 4. Validate component link memberships reference known series.
  const assertKnown = (id: string, where: string): void => {
    if (!seriesIds.has(id)) throw new Error(`[viz] ${where} references unknown series "${id}"`)
  }
  if (option.selection) for (const id of option.selection.link) assertKnown(id, 'selection.link')
  if (option.colorScale) for (const id of option.colorScale.link) assertKnown(id, 'colorScale.link')

  // 5. Resolve dataZoom targets → their region's coordinate-space key.
  const dataZoom: ResolvedDataZoom[] = (option.dataZoom ?? []).map(z => {
    const cell = cells[z.coordId]
    if (!cell) throw new Error(`[viz] dataZoom "${z.id}" references unknown coordId "${z.coordId}"`)
    return {
      id: z.id,
      type: z.type,
      coordId: z.coordId,
      spaceKey: cellSpaceKey(cell),
      axes: [...z.axes],
      // DEC-16: carry the resolved live zoom window through (present only when the option had one).
      ...(z.window ? { window: [z.window[0], z.window[1]] as const } : {}),
    }
  })

  // 6. Resolve the split-tree layout from the placement forms (region | split | layout → one tree).
  const layout = resolveLayout(option)

  // 7. Derive gridLinked: ≥2 world2d series sharing one coordinate space → link cameras.
  //    An explicit `option.gridLinked` WINS over the auto-derivation (so a caller can keep same-space
  //    cells zooming independently by default, or force linking) — absent ⇒ the auto-derived default.
  const spaceCounts = new Map<string, number>()
  for (const r of series) {
    if (r.coordinateSystem !== 'world2d') continue
    const key = cellSpaceKey(cells[r.coordId])
    spaceCounts.set(key, (spaceCounts.get(key) ?? 0) + 1)
  }
  const gridLinked = option.gridLinked ?? [...spaceCounts.values()].some(n => n >= 2)

  // 8. Carry the strict-JSON live-state fields (DEC-16) onto the plan (present only when supplied).
  const filters = cloneRangeMap(option.filters)
  const colorOverrides = cloneColorOverrides(option.colorOverrides)

  return {
    version: typeof option.version === 'number' ? option.version : VIZ_OPTION_VERSION,
    datasetIds,
    datasetId: defaultDatasetId,
    layout,
    cells,
    seq: Object.keys(cells).length,
    // EFFECTIVE grid (DEC-5b): raw `option.grid` is [] on the auto-derived path, which would leave
    // `order` empty while `cells`/`seq` are populated — a self-inconsistent ResolvedOption.
    order: grid.map(g => g.id),
    series,
    dataZoom,
    selection: option.selection
      ? {
          mode: option.selection.mode,
          link: [...option.selection.link],
          ...(option.selection.ids ? { ids: [...option.selection.ids] } : {}),
          ...(cloneSpaces(option.selection.spaces) ? { spaces: cloneSpaces(option.selection.spaces)! } : {}),
          // PROVENANCE (ITEM-3) — optional + additive: a pre-provenance option carries none of
          // these keys and resolves EXACTLY as before (INV-5).
          ...(cloneSelectionOps(option.selection.ops, new Set(Object.keys(cells)))
            ? { ops: cloneSelectionOps(option.selection.ops, new Set(Object.keys(cells)))! }
            : {}),
          ...(cloneSelectionContext(option.selection.context)
            ? { context: cloneSelectionContext(option.selection.context)! }
            : {}),
          ...(option.selection.provenance ? { provenance: option.selection.provenance } : {}),
        }
      : null,
    colorScale: option.colorScale
      ? {
          link: [...option.colorScale.link],
          ...(cloneRangeMap(option.colorScale.domains)
            ? { domains: cloneRangeMap(option.colorScale.domains)! }
            : {}),
        }
      : null,
    ...(filters ? { filters } : {}),
    ...(option.colorBySelection !== undefined ? { colorBySelection: option.colorBySelection } : {}),
    ...(colorOverrides ? { colorOverrides } : {}),
    // Plot-editing: resolve the (optional) per-control edit capabilities with defaults filled in.
    controls: resolveControls(option.controls),
    gridLinked,
  }
}

// ── migrateOption — forward-migrate any persisted blob into a current `VizOption` (ITEM-7) ────────
//
// Absorbs the (now-superseded) `sessionState.ts` migration knowledge so the app can persist
// `getOption()` and load it back through ONE entry point. Handles three shapes:
//   1. a current `VizOption` (has a `series` array) — version-guarded + normalized forward;
//   2. a legacy `VizSessionState` snapshot (`grid` + `interaction`, v1/v2/v3) — converted (below);
//   3. a legacy `WorkspaceSpec` (top-level `layout` + `cells[]` array) — wrapped forward.
// A newer-than-this-build blob THROWS (never silently drop state a newer writer produced).
//
// LEGACY VizSessionState migration boundary (HONEST scope — do not overclaim). `sessionStateToOption`
// carries forward the structure + the losslessly-mappable interaction: grid ids, layout tree, series
// (from `grid.cells`), the multi-dataset id set, selection ids, colorScale domains, filters,
// colorBySelection, and colorOverrides. It DOES NOT reconstruct three pieces of live view-ephemera
// that the pre-cutover VizSessionState serialized in shapes with NO 1:1 map into the current
// `VizOption`: (a) live `dataZoomWindows` (a bare window map, missing the dataZoom id/type/coordId/axes
// a `VizDataZoom` requires — a guessed coordId would make `parseOption` THROW, a guessed axis would
// restore the wrong axis); (b) per-space camera `viewStates` (keyed by space, not resolvable to a
// series without the resolved cell); (c) multi-container docking (stored as separate
// `grid.containerLayouts`/`grid.paneContainer` keys, not a `DockingSnapshot`). A pre-cutover session
// therefore restores its DATA + panel layout + colors/selection/filters, but not its live zoom/camera
// or pop-out docking — an accepted, documented boundary for this transitional read-only-absorb path
// (NOT a silent drop: it is enumerated here and the forward getOption/setOption path round-trips all
// three for current-format options). A fuller legacy reconstruction is deferred pending a real
// pre-cutover blob to test against.

/** Coerce any legacy/loose `hidden` (a `Set`, an array, or absent) to a strict-JSON SORTED array. */
function sortedHidden(h: unknown): number[] | undefined {
  if (h == null) return undefined
  const arr = Array.isArray(h)
    ? (h as number[])
    : typeof (h as Iterable<number>)[Symbol.iterator] === 'function'
      ? [...(h as Iterable<number>)]
      : []
  if (arr.length === 0) return undefined
  return [...arr].sort((a, b) => a - b)
}

/** Coerce a stored (engine) `ColorBy`-like object into a strict-JSON `VizColorBy` (sorts `hidden`). */
function colorByToViz(cb: Record<string, unknown> | undefined): VizColorBy | undefined {
  if (!cb || typeof cb !== 'object' || typeof cb.mode !== 'string') return undefined
  const hidden = sortedHidden(cb.hidden)
  const out: Record<string, unknown> = { ...cb }
  if (hidden) out.hidden = hidden
  else delete out.hidden
  return out as unknown as VizColorBy
}

/** Reconstruct a minimal `VizSeries[]` + id-only `VizGridEntry[]` from a serialized grid `cells`
 *  record (a `VizSessionState.grid.cells`). One series per cell (id = cell id, type = kind). */
function seriesFromCells(cells: Record<string, Record<string, unknown>>): {
  grid: VizGridEntry[]
  series: VizOption['series']
} {
  const grid: VizGridEntry[] = []
  const series: Array<Record<string, unknown>> = []
  for (const [id, cell] of Object.entries(cells)) {
    grid.push({ id })
    const colorBy = colorByToViz(cell.colorBy as Record<string, unknown> | undefined)
    series.push({
      id,
      type: typeof cell.kind === 'string' ? cell.kind : 'scatter',
      coordId: id,
      ...(typeof cell.datasetId === 'string' ? { datasetId: cell.datasetId } : {}),
      ...(typeof cell.layoutId === 'string' ? { encode: { layout: cell.layoutId } } : {}),
      ...(colorBy ? { colorBy } : {}),
      ...(cell.graphOverlay === true ? { graphOverlay: true } : {}),
      ...(cell.annotate === true ? { annotate: true } : {}),
      ...(cell.segment === true ? { segment: true } : {}),
    })
  }
  return { grid, series: series as unknown as VizOption['series'] }
}

/** Build the strict-JSON color-scale `domains` map from a serialized `colorScales` record. */
function domainsFromColorScales(
  scales: Record<string, { key?: string; domain?: [number, number] }> | undefined,
): Record<string, readonly [number, number]> | undefined {
  if (!scales) return undefined
  const out: Record<string, readonly [number, number]> = {}
  for (const [scopeId, sc] of Object.entries(scales)) {
    if (sc && Array.isArray(sc.domain) && sc.domain.length === 2) {
      out[typeof sc.key === 'string' && sc.key ? sc.key : scopeId] = [sc.domain[0], sc.domain[1]]
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Convert a legacy `VizSessionState` (grid + interaction) into a `VizOption`. */
function sessionStateToOption(obj: Record<string, unknown>): VizOption {
  const version = typeof obj.version === 'number' ? obj.version : 0
  if (version > MAX_LEGACY_SESSION_VERSION) {
    throw new Error(
      `[viz] migrateOption: session-state version ${version} is newer than this build ` +
        `(absorbs ≤ ${MAX_LEGACY_SESSION_VERSION}); refusing to load rather than drop state`,
    )
  }
  const grid = (obj.grid ?? {}) as {
    layout?: LayoutNode
    cells?: Record<string, Record<string, unknown>>
  }
  const interaction = (obj.interaction ?? {}) as Record<string, unknown>
  const dataset = (obj.dataset ?? {}) as { id?: string; ids?: string[] }
  const cells = grid.cells ?? {}
  const { grid: gridEntries, series } = seriesFromCells(cells)

  const datasetIds =
    Array.isArray(dataset.ids) && dataset.ids.length > 0
      ? dataset.ids
      : typeof dataset.id === 'string' && dataset.id
        ? [dataset.id]
        : []

  const selectionSlice = interaction.selection as { ids?: number[] } | undefined
  const selectionIds = Array.isArray(selectionSlice?.ids) ? sortedHidden(selectionSlice!.ids) : undefined
  const domains = domainsFromColorScales(
    interaction.colorScales as Record<string, { key?: string; domain?: [number, number] }> | undefined,
  )
  const filters = cloneRangeMap(interaction.filters as Record<string, readonly [number, number]> | undefined)
  const colorOverrides = cloneColorOverrides(
    interaction.colorOverrides as Record<string, VizColorOverride> | undefined,
  )
  const colorBySelection =
    typeof interaction.colorBySelection === 'string' || interaction.colorBySelection === null
      ? (interaction.colorBySelection as string | null)
      : undefined

  return {
    version: VIZ_OPTION_VERSION,
    ...(datasetIds.length > 0 ? { datasets: datasetIds.map(id => ({ id })) } : {}),
    grid: gridEntries,
    ...(grid.layout ? { layout: cloneLayout(grid.layout) } : {}),
    series,
    ...(selectionIds ? { selection: { mode: 'lasso', link: [], ids: selectionIds } } : {}),
    ...(domains ? { colorScale: { link: [], domains } } : {}),
    ...(filters ? { filters } : {}),
    ...(colorBySelection !== undefined ? { colorBySelection } : {}),
    ...(colorOverrides ? { colorOverrides } : {}),
  }
}

/** Convert a legacy `export/spec.ts` `WorkspaceSpec` (top-level `layout` + `cells[]`) forward. The
 *  thin `cells[]` is `{ id, kind }` (its legacy `colorBy` was a plain string descriptor, dropped —
 *  mirrors `sessionState.migrateVizState`). */
function workspaceSpecToOption(obj: Record<string, unknown>): VizOption {
  const layout = obj.layout as LayoutNode | undefined
  const rawCells = (obj.cells as Array<Record<string, unknown>>) ?? []
  const grid: VizGridEntry[] = []
  const series: Array<Record<string, unknown>> = []
  for (const c of rawCells) {
    const id = typeof c.id === 'string' ? c.id : ''
    if (!id) continue
    grid.push({ id })
    series.push({ id, type: typeof c.kind === 'string' ? c.kind : 'scatter', coordId: id })
  }
  return {
    version: VIZ_OPTION_VERSION,
    grid,
    ...(layout ? { layout: cloneLayout(layout) } : {}),
    series: series as unknown as VizOption['series'],
  }
}

/** Normalize an already-`VizOption` blob forward: version-fill + coerce every `hidden` (series-level
 *  and `encode.colorBy`) to the strict-JSON sorted array. Additive — no other field is rewritten. */
function normalizeOption(option: VizOption): VizOption {
  const normSeries = option.series.map(s => {
    const next = { ...s } as Record<string, unknown>
    const encColor = colorByToViz(
      (s.encode as { colorBy?: Record<string, unknown> } | undefined)?.colorBy,
    )
    if (encColor) next.encode = { ...(s.encode ?? {}), colorBy: encColor }
    const sColor = colorByToViz(s.colorBy as Record<string, unknown> | undefined)
    if (sColor) next.colorBy = sColor
    return next
  })
  return {
    ...option,
    version: VIZ_OPTION_VERSION,
    series: normSeries as unknown as VizOption['series'],
  }
}

/**
 * Forward-migrate a raw persisted object into a current `VizOption` (ITEM-7). See the section
 * banner above for the three shapes handled + the refuse-newer contract.
 */
export function migrateOption(raw: unknown): VizOption {
  if (raw == null || typeof raw !== 'object') {
    throw new Error('[viz] migrateOption: not an option object')
  }
  const obj = raw as Record<string, unknown>

  // (1) already a `VizOption` (has a `series` array).
  if (Array.isArray(obj.series)) {
    const version = typeof obj.version === 'number' ? obj.version : VIZ_OPTION_VERSION
    if (version > VIZ_OPTION_VERSION) {
      throw new Error(
        `[viz] migrateOption: option version ${version} is newer than this build ` +
          `(supports ≤ ${VIZ_OPTION_VERSION}); refusing to load rather than drop state`,
      )
    }
    return normalizeOption(obj as unknown as VizOption)
  }

  // (2) a legacy `VizSessionState` snapshot (grid + interaction), v1/v2/v3.
  if ('grid' in obj && 'interaction' in obj) {
    return sessionStateToOption(obj)
  }

  // (3) a legacy `WorkspaceSpec` (top-level `layout` + a `cells` ARRAY, no `grid`).
  if ('layout' in obj && Array.isArray(obj.cells) && !('grid' in obj)) {
    return workspaceSpecToOption(obj)
  }

  throw new Error(
    '[viz] migrateOption: unrecognized shape (neither a VizOption, a VizSessionState, nor a legacy WorkspaceSpec)',
  )
}
