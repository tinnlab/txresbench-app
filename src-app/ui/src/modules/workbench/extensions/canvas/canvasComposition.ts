// canvasComposition — fold every contributing view's resolved canvas into the ONE option the
// workbench's single `@ziee/viz` grid is driven with.
//
// WHY THERE IS MORE THAN ONE CONTRIBUTOR. The canvas belongs to the WORKBENCH, not to whichever
// pane happens to be the active tab. The feed store used to hold ONE resolved option plus the id
// of the view that owned it, so a publish REPLACED what was there and the owner's teardown blanked
// it. Both halves were wrong the moment anything else could plot:
//
//   · a region unmounts whenever its pane stops being the ACTIVE tab, so "the owner stopped
//     rendering" says what is on screen, never what the user still wants. The user switched tabs
//     and their plots were gone, having changed nothing — the same loss the per-view store was
//     fixed for one layer down, and fixing only the store leaves the plots built from it behind;
//   · a second view with a canvas silently evicted the first, so two open panes could never be
//     seen together on the one surface they both plot onto.
//
// So contributions are kept PER VIEW and composed here. Retiring one is a separate act from
// ceasing to render it (the pane-close path), which is what keeps the set bounded by the number of
// OPEN panes instead of growing for the life of the page.
//
// NAMESPACING is not defensive tidiness. Two independently-authored declarations may legitimately
// name a pane or a slice the same thing, and a collision on a shared grid is a silent, undebuggable
// merge of two unrelated plots into one square. Every id a contribution wrote is therefore prefixed
// with its view, and the maps returned alongside are the INVERSE — so the resolver, the close
// router and the e2e seam keep speaking each declaration's own vocabulary, and nothing downstream
// ever parses a composed id back apart.
//
// Pure / framework-free (no React, no store) so the fold is directly unit-testable.

import { LAYER_ID_SEP } from '@ziee/viz'
import type { DatasetResolver, VizDataset, VizGridEntry, VizOption, VizSeries } from '@ziee/viz'

/** Routes a controlled pane's close gesture to the declared action that removes it. */
export type CloseRouter = (paneId: string) => void

/** ONE view's contribution to the shared canvas, exactly as its own declaration resolved. */
export interface CanvasContribution {
  option: VizOption
  resolver: DatasetResolver
  /** the declared close routing for this view's controlled panes; `null` when it declares none. */
  close: CloseRouter | null
  /**
   * Where this contribution's rows belong on the shared canvas, ASCENDING — the contributor's
   * own statement of its position, not an accident of when it first published.
   *
   * The fold used to stack contributions in whatever order the map iterated, which is
   * FIRST-PUBLISH order. That is a fact about mounting, not about arrangement: a contributor
   * that publishes late (its host was collapsed, or its availability resolved a tick later)
   * landed at the bottom however it was arranged, and rearranging the hosts afterwards moved
   * nothing — the canvas and the surface that drives it disagreed, with no way for the reader
   * to tell which was lying.
   *
   * ABSENT means unpositioned, and an unpositioned contribution sorts AFTER every positioned
   * one, keeping its publish order among its peers. That is the tree's own sparse-rank rule
   * (`regions/RegionShell.tsx`, `resolveSectionOrder`), and it is what makes this additive: with
   * nothing declared the fold is byte-identical to what it was.
   */
  order?: number
}

/** One composed pane carrying more than one series — see `CanvasCollisions`. */
export interface SharedPane {
  /** the composed pane id (`<viewId><NS><local>`). */
  paneId: string
  viewId: string
  /** the id the DECLARATION wrote. */
  local: string
  /** every series that landed on it, in declaration order. */
  seriesIds: readonly string[]
}

/**
 * What the fold had to MERGE rather than compose, reported instead of absorbed.
 *
 * Composition is deliberately total — it never throws — because `setOption` is per-GRID: a
 * refusal is not confined to the offending pane, it takes down every open contributor's plots
 * with it. So a merge is performed and stated, never performed silently. Both fields empty is
 * the honest "everything composed as declared".
 */
export interface CanvasCollisions {
  /** panes carrying more than one series. Legitimate as an OVERLAY, and a defect when it is a
   *  list of emitted plots whose ids were not derived per item — composition cannot tell those
   *  apart, so it reports the fact and the emitter owes uniqueness by construction. */
  sharedPanes: readonly SharedPane[]
  /** canvas-LEVEL (non-pane) keys — `controls`, `selection`, `filters`, `mask`, … — that more
   *  than one contribution carried. They cannot be merged meaningfully, so the later publish
   *  wins; these are the keys that lost. At most ONE contributor may carry them. */
  optionKeys: readonly string[]
}

const NO_COLLISIONS: CanvasCollisions = { sharedPanes: [], optionKeys: [] }

/** Which view a composed id belongs to, and what that view calls it. */
export interface Owned {
  viewId: string
  /** the id the DECLARATION wrote — a logical dataset id, or a pane's own coord id. */
  local: string
}

/** The single canvas the contributions fold into. */
export interface ComposedCanvas {
  /** at least one view is contributing something plottable. */
  active: boolean
  option: VizOption | null
  resolver: DatasetResolver | null
  close: CloseRouter | null
  /** composed pane id → the view that placed it + the id THAT view declared. */
  paneOwners: ReadonlyMap<string, Owned>
  /** what the fold merged rather than composed. Empty ⇒ the canvas is what it looks like. */
  collisions: CanvasCollisions
}

/** Separates a view id from a declaration's own id. Never parsed back apart — the owner maps are
 *  the inverse — so a declaration containing this sequence costs readability, never correctness.
 *
 *  VIZ'S separator, not a local `'::'` literal, which is what stood here. The composed id is the
 *  key viz's `makeLayerFilter` / `routeGridHover` route a layer and a hover BY, so this module and
 *  that one are two halves of one grammar; spelling it twice means a change to either half is a
 *  silent, total routing failure (every pane draws in no view) with nothing to fail on. Taking the
 *  constant is deck-free — `layerIds.ts` exists as its own module for exactly that reason. */
const NS = LAYER_ID_SEP

/** Nothing is contributing. */
export const EMPTY_CANVAS: ComposedCanvas = {
  active: false,
  option: null,
  resolver: null,
  close: null,
  paneOwners: new Map(),
  collisions: NO_COLLISIONS,
}

/** The slices a contribution declares, in the two shapes a resolved option can carry. */
function contributedDatasets(option: VizOption): VizDataset[] {
  if (Array.isArray(option.datasets) && option.datasets.length > 0) return [...option.datasets]
  const single = (option as { dataset?: VizDataset }).dataset
  return single?.id ? [single] : []
}

/** Say ONCE that two declarations both carried canvas-level (non-pane) settings — composition
 *  cannot merge them meaningfully, so the later one wins and the reader should know why. NAMES
 *  the keys that lost: "they cannot be merged" is only actionable if the reader learns WHICH. */
let warnedComposite = false
/** Test-only: re-arm the say-it-once latch, so one spec's collision cannot silence the next one's.
 *  (`canvasHostProvider`'s `__resetCanvasHostForTests` is the same shape, for the same reason.) */
export function __resetCompositionWarningForTests(): void {
  warnedComposite = false
}
function warnCompositeOption(keys: readonly string[]): void {
  if (warnedComposite) return
  warnedComposite = true
  console.warn(
    `[canvas] two views contribute canvas-level settings (${keys.join(', ')}) to the one grid; ` +
      'they cannot be merged, so the later publish wins.',
  )
}

/**
 * The contributions in the order their rows are stacked (see `CanvasContribution.order`).
 *
 * A stable sort over the map's own iteration order, so an unpositioned set is returned exactly
 * as it arrived. `Array.prototype.sort` is specified stable, so the tiebreak needs no index
 * carried alongside.
 */
function stacked(
  contributions: ReadonlyMap<string, CanvasContribution>,
): [string, CanvasContribution][] {
  const entries = [...contributions]
  return entries.sort(
    ([, a], [, b]) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER),
  )
}

/**
 * Fold every live contribution into one option.
 *
 * Each contribution keeps its own internal placement, and its rows are OFFSET below whatever the
 * contributions before it occupy — so views stack down the canvas instead of overwriting each
 * other's rows. A contribution that placed nothing is laid out as a single row, which is exactly
 * what viz's own auto-derivation would have given it alone.
 *
 * "Before it" is the contributors' DECLARED order (`CanvasContribution.order`), not the order they
 * happened to publish in; and whatever the fold has to merge rather than compose is reported on
 * `collisions` rather than absorbed.
 */
export function composeCanvas(contributions: ReadonlyMap<string, CanvasContribution>): ComposedCanvas {
  if (contributions.size === 0) return EMPTY_CANVAS

  const datasets: VizDataset[] = []
  const series: VizSeries[] = []
  const grid: VizGridEntry[] = []
  const datasetOwners = new Map<string, Owned>()
  const paneOwners = new Map<string, Owned>()
  let rest: Record<string, unknown> = {}
  let rowOffset = 0
  /** composed pane id → every series that landed on it, so a shared pane is a COUNT and not a
   *  guess reconstructed afterwards. */
  const paneSeries = new Map<string, string[]>()
  const collidedKeys: string[] = []

  for (const [viewId, contribution] of stacked(contributions)) {
    const { option } = contribution
    const ns = (local: string): string => `${viewId}${NS}${local}`

    const own = contributedDatasets(option)
    for (const d of own) {
      const id = ns(d.id)
      datasetOwners.set(id, { viewId, local: d.id })
      datasets.push({ ...d, id })
    }
    // A plot with no explicit slice defaults to the option's FIRST — which, once composed, may
    // belong to a different view. Resolve that default HERE so every plot names its own.
    const fallback = own[0]?.id

    const declaredRegion = new Map((option.grid ?? []).map(g => [g.id, g.region]))
    const nextCol = new Map<number, number>()
    let rowsUsed = 0
    for (const s of option.series ?? []) {
      const local = s.datasetId ?? fallback
      const paneId = ns(s.coordId)
      series.push({
        ...s,
        // The SERIES id is namespaced for the same reason its `coordId` is, and it was not: two
        // declarations that name a plot the same thing are as ordinary as two that name a pane the
        // same thing, and `parseOption` rejects a duplicate series id OUTRIGHT — so the whole
        // composed canvas threw and every open pane's plots went with it, for a collision on an id
        // viz only ever uses for uniqueness and error text.
        id: ns(s.id),
        coordId: paneId,
        // The composed id is the GRID's key and stays internal. What a reader addresses — a spec, a
        // screenshot, a person — is the pane this declaration named, so it travels alongside and
        // viz stamps THAT into the DOM as the pane's test id. Without it the only id in the DOM was
        // `<viewId>::<local>`: a testid carrying this module's separator plus the identity of
        // whichever view happened to contribute the pane, neither of which a reader can know.
        localId: s.coordId,
        ownerId: viewId,
        ...(local !== undefined ? { datasetId: ns(local) } : {}),
      })
      // Several plots may share ONE pane (an overlay); it is placed once, by the first.
      //
      // Composition cannot tell a DELIBERATE overlay from a list of emitted plots whose ids were
      // not derived per item — both are "two series, one coordId". So the merge is performed (a
      // refusal here would blank every open contributor, not just this one) and the fact is
      // REPORTED: an emitter keying each plot by index or content reports none, and one that
      // silently folded two of them into one square can be seen doing it.
      paneSeries.set(paneId, [...(paneSeries.get(paneId) ?? []), ns(s.id)])
      if (paneOwners.has(paneId)) continue
      paneOwners.set(paneId, { viewId, local: s.coordId })
      const declared = declaredRegion.get(s.coordId)
      const row = typeof declared?.row === 'number' ? declared.row : 0
      const auto = nextCol.get(row) ?? 0
      const col = typeof declared?.col === 'number' ? declared.col : auto
      nextCol.set(row, Math.max(auto, col) + 1)
      rowsUsed = Math.max(rowsUsed, row + 1)
      grid.push({ id: paneId, region: { row: row + rowOffset, col } })
    }
    rowOffset += rowsUsed

    // Everything the declaration carried that is NOT per-pane (controls, selection, filters…).
    // Composing those across independent views has no defined meaning, so a later contribution
    // wins and says so; with a single contributor this is exactly its own option.
    const { series: _s, datasets: _d, dataset: _one, grid: _g, ...others } = option as VizOption & {
      dataset?: VizDataset
    }
    if (Object.keys(others).length > 0) {
      // The keys that LOSE are the ones both carried. A later contribution introducing a key the
      // earlier one never had is not a collision — it composes, because nothing was overwritten.
      const lost = Object.keys(others).filter(k => k in rest)
      if (lost.length > 0) {
        collidedKeys.push(...lost.filter(k => !collidedKeys.includes(k)))
        warnCompositeOption(collidedKeys)
      }
      rest = { ...rest, ...others }
    }
  }

  // `datasets` is omitted rather than emitted empty: a declaration that names none relies on viz's
  // own defaulting, and an empty list is a different statement from an absent one.
  const option: VizOption = {
    ...(rest as Partial<VizOption>),
    ...(datasets.length > 0 ? { datasets } : {}),
    grid,
    series,
  } as VizOption

  const resolver: DatasetResolver = (id: string) => {
    const owner = datasetOwners.get(id)
    if (!owner) throw new Error(`[canvas] no contributing view owns dataset "${id}"`)
    const contribution = contributions.get(owner.viewId)
    if (!contribution) throw new Error(`[canvas] the view contributing dataset "${id}" is gone`)
    return contribution.resolver(owner.local)
  }

  const routes = [...contributions.values()].some(c => c.close)
  const close: CloseRouter | null = routes
    ? (paneId: string): void => {
        const owner = paneOwners.get(paneId)
        if (!owner) return
        contributions.get(owner.viewId)?.close?.(owner.local)
      }
    : null

  const sharedPanes: SharedPane[] = []
  for (const [paneId, seriesIds] of paneSeries) {
    if (seriesIds.length < 2) continue
    const owner = paneOwners.get(paneId) as Owned
    sharedPanes.push({ paneId, viewId: owner.viewId, local: owner.local, seriesIds })
  }

  return {
    active: true,
    option,
    resolver,
    close,
    paneOwners,
    collisions:
      sharedPanes.length === 0 && collidedKeys.length === 0
        ? NO_COLLISIONS
        : { sharedPanes, optionKeys: collidedKeys },
  }
}
