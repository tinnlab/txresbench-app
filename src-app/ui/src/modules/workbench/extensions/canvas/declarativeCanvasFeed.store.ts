// declarativeCanvasFeed.store — the GENERAL bridge between a declarative view's `canvas`
// block and the center CanvasView (declarative-processor-ui Slice 3/4 / ITEM-10/17). It is the
// analysis-AGNOSTIC feed: ANY declarative processor that declares a `canvas:` block drives the
// ONE `@txresbench/viz` canvas grid through this singleton. (Slice 4 RETIRED the cell-filter-specific
// `cellFilterCanvas.store`/`criteriaCanvas` — cell-filter's dynamic before/after now rides THIS
// general feed as declared DATA, and controlled cell-close routes through `onCellClose`.)
//
//   • `DeclarativeRegion` RESOLVES its own view's declared canvas (`resolveDeclarativeCanvas`,
//     `canvasFeed.ts`) into a strict-JSON `VizOption` + a `DatasetResolver` over the resolved
//     `$data` obs slices, and WRITES it here on each data/state change (`setFeed`);
//   • every such contribution is KEPT PER VIEW and folded into one option (`canvasComposition`) —
//     the canvas is the workbench's, so it neither follows nor is evicted by whichever pane is on
//     screen. Read that module's header for why, and for what retires a contribution;
//   • `CanvasView` READS the feed and drives its controller via one `VizController.setOption`
//     (the single canvas grid — never a second `<Viz>`), clean-replacing on option change.
//
// A plain zustand module singleton (mirrors `vizStateStore`) — node-safe (no deck import),
// so the round-trip is directly unit-testable.

import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import type { DatasetResolver, VizOption } from '@txresbench/viz'
import {
  composeCanvas,
  EMPTY_CANVAS,
  type CanvasContribution,
  type ComposedCanvas,
} from './canvasComposition'

/** Routes a controlled cell's `cell-close(coordId)` to the declared close action (Slice 4,
 *  ITEM-17). Built by `DeclarativeRegion` (closure over the resolved `closeActions` map + the
 *  host ctx); `null` for a canvas with no controlled cells. */
export type CellCloseRouter = (coordId: string) => void

export interface DeclarativeCanvasState {
  /** a declarative view with a `canvas` block is mounted + resolved (drives CanvasView). */
  active: boolean
  /** the COMPOSED strict-JSON canvas option across every contributing view (`null` when none). */
  option: VizOption | null
  /** maps the option's logical dataset ids (`obs` / `<ds>.kept` / …) to isolated sources. */
  resolver: DatasetResolver | null
  /** routes a controlled cell's close (`cell-close`) to the declared state mutation (ITEM-17);
   *  `null` when the canvas declares no controlled cells. */
  onCellClose: CellCloseRouter | null
  /** composed pane id → the view that placed it + the id THAT view declared (`canvasComposition`),
   *  so a reader can name a pane the way its own declaration does. */
  paneOwners: ComposedCanvas['paneOwners']
  /** what the fold had to MERGE rather than compose (`canvasComposition`) — two contributions
   *  landing on one pane, or both carrying canvas-level settings. Empty ⇒ the canvas is exactly
   *  what its contributors declared.
   *
   *  Nothing RENDERS from it, deliberately: a merge is a declaration defect, not a user-facing
   *  state, and painting it would put a diagnostic in front of the reader on a canvas that is
   *  otherwise correct. It is here because the store is the only place a runtime reader — a
   *  spec, an e2e seam — can learn the fact at all; the alternative is that the fold knows and
   *  no one can ask. */
  collisions: ComposedCanvas['collisions']
  /** every live contribution, keyed by view, in first-publish order. */
  contributions: ReadonlyMap<string, CanvasContribution>
  /** publish (or re-publish) `viewId`'s contribution. `order` is where its rows belong on the
   *  shared canvas (ascending); omitted ⇒ unpositioned, which stacks after every positioned
   *  contribution — see `CanvasContribution.order`. */
  setFeed: (
    viewId: string,
    option: VizOption,
    resolver: DatasetResolver,
    onCellClose?: CellCloseRouter | null,
    order?: number,
  ) => void
  /** retire `viewId`'s contribution (DEC-4 explicit removal); everything else on the canvas stays.
   *  A view that never contributed is a no-op.
   *
   *  This is a CLOSE, not a repaint: it is driven from the pane-close path, never from a region
   *  unmounting because its tab went inactive. That distinction is the whole point — see
   *  `canvasComposition`. */
  clear: (viewId: string) => void
}

/** Recompose from a mutated contribution set and hand back the full next state. */
function nextState(
  contributions: ReadonlyMap<string, CanvasContribution>,
): Omit<DeclarativeCanvasState, 'setFeed' | 'clear'> {
  const composed = composeCanvas(contributions)
  return {
    active: composed.active,
    option: composed.option,
    resolver: composed.resolver,
    onCellClose: composed.close,
    paneOwners: composed.paneOwners,
    collisions: composed.collisions,
    contributions,
  }
}

export const useDeclarativeCanvasStore = create<DeclarativeCanvasState>()((set, get) => ({
  active: EMPTY_CANVAS.active,
  option: EMPTY_CANVAS.option,
  resolver: EMPTY_CANVAS.resolver,
  onCellClose: EMPTY_CANVAS.close,
  paneOwners: EMPTY_CANVAS.paneOwners,
  collisions: EMPTY_CANVAS.collisions,
  contributions: new Map(),
  setFeed: (viewId, option, resolver, onCellClose = null, order) => {
    const contributions = new Map(get().contributions)
    contributions.set(viewId, { option, resolver, close: onCellClose, ...(order !== undefined ? { order } : {}) })
    set(nextState(contributions))
  },
  clear: viewId => {
    if (!get().contributions.has(viewId)) return
    const contributions = new Map(get().contributions)
    contributions.delete(viewId)
    set(nextState(contributions))
  },
}))

/** The feed CanvasView reads REACTIVELY. Wrapped in `useShallow` so the always-mounted
 *  CanvasView re-renders only when the option/resolver actually change (not on every store
 *  write), since the selector returns a fresh object each call. */
export function useDeclarativeCanvasFeed(): {
  active: boolean
  option: VizOption | null
  resolver: DatasetResolver | null
  onCellClose: CellCloseRouter | null
} {
  return useDeclarativeCanvasStore(
    useShallow(s => ({ active: s.active, option: s.option, resolver: s.resolver, onCellClose: s.onCellClose })),
  )
}

/** Handler-side (non-reactive) snapshot + actions. */
export const declarativeCanvas = {
  get: () => useDeclarativeCanvasStore.getState(),
  setFeed: (
    viewId: string,
    option: VizOption,
    resolver: DatasetResolver,
    onCellClose?: CellCloseRouter | null,
    order?: number,
  ) => useDeclarativeCanvasStore.getState().setFeed(viewId, option, resolver, onCellClose, order),
  clear: (viewId: string) => useDeclarativeCanvasStore.getState().clear(viewId),
}
