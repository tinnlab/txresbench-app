// @vitest-environment jsdom
//
// paneRemoveBlocked.test.ts — a pane whose close CANNOT do anything must SAY SO, and must say WHY.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────────────────────────
// `controlled: true` means "do not remove yourself — tell the app, and let it mutate the state you
// are derived from" (the reopen-loop guard). It is a promise about who acts, and nothing anywhere
// checked that anyone WOULD. A host that had no route for a particular pane's close still got a
// close X that was fully live, fully styled, hoverable, focusable and tooltipped — and that did
// NOTHING when clicked. The user clicks; the plot stays; no message, no state change, no log.
//
// A dead control is worse than an absent one, because the user cannot tell it apart from a bug in
// their own understanding. So the cell now carries `removeBlockedReason`, the toolbar renders the
// close as UNAVAILABLE, and the reason reaches the user through channels that do not require them
// to already suspect something is wrong.
//
// ── WHAT IS ASSERTED, AND AT WHICH LAYER ─────────────────────────────────────────────────────────
// Behaviour on the rendered DOM and on real model values — never a regex over this feature's own
// source, which is a technique this package has already paid for twice (see
// `paneToolbarItems.test.ts`'s own header, and DEC-45). The three cases the round exists for:
//
//   1. controlled, WITH a route  — the close is live and still fires the controlled path
//                                  (`cell-close` on the bus). The regression guard: today's working
//                                  path must not become collateral damage.
//   2. controlled, WITHOUT one   — the close is unavailable, the reason is reachable by hover, by
//                                  focus AND programmatically, and clicking it does nothing.
//   3. uncontrolled              — unchanged: the cell removes itself through the store.
//
// Plus the two model-level properties that decide whether case 2 can even arrive at the toolbar:
// the wire field survives `parseOption` and `getOption`, and it travels with a cell's CONTENT on a
// drag-swap (otherwise a swap launders a blocked pane into a closable one).

import * as React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { PaneToolbar } from './PaneToolbar'
import { CellView } from './CellView'
import { type GridCell, paneRemoveBlockedReason, swapCellContent } from './gridModel'
import { VizEventBusContext } from '../events/EventBusContext'
import type { VizEvent } from '../events/emitter'
import { createVizStores, VizStoresProvider } from '../../adapter/vizStores'
import { VizController } from '../../adapter/VizController'
import { installBuiltins } from '../charts/installBuiltins'
import { FixtureSource } from '../data/fixtures'
import { parseOption } from '../option/parse'
import type { VizOption } from '../option/types'
import type { DatasetCatalog, DataSource } from '../data/wire'
import type { PaneRect } from '../layers/multiView'

const REASON = 'The analysis declares this plot, so it cannot be closed here.'

const CATALOG: DatasetCatalog = {
  datasetId: 'demo',
  pointCount: 3,
  layouts: [{ id: 'primary', kind: 'layout', label: 'Primary' }],
  valueColumns: [],
  categoricalColumns: [],
  continuousColumns: [],
  hasImage: false,
}

const RECT: PaneRect = { id: 'p1', x: 0, y: 0, width: 400, height: 300 }

/** A `DataSource` that is never read — a DENSE (scatter) cell draws on the shared deck, so
 *  `CellView` renders its toolbar and no chart body at all. */
const SOURCE = {} as unknown as DataSource

afterEach(() => cleanup())

// ── layer 1: the predicate ───────────────────────────────────────────────────────────────────────
describe('paneRemoveBlockedReason — blocked and "here is why" are ONE fact', () => {
  it('absent ⇒ removable', () => {
    expect(paneRemoveBlockedReason({})).toBeUndefined()
    expect(paneRemoveBlockedReason({ removeBlockedReason: undefined })).toBeUndefined()
  })

  it('a non-empty reason blocks, trimmed', () => {
    expect(paneRemoveBlockedReason({ removeBlockedReason: `  ${REASON} ` })).toBe(REASON)
  })

  it('BLANK reads as REMOVABLE — "blocked with nothing to say" must be unrepresentable', () => {
    // This is the whole argument for one field instead of `removable:false` + a separate reason.
    // A blank string is the only way a host could express the mute dead-end through this API, and
    // it is answered by making it mean "not blocked" rather than "blocked, silently".
    expect(paneRemoveBlockedReason({ removeBlockedReason: '' })).toBeUndefined()
    expect(paneRemoveBlockedReason({ removeBlockedReason: '   \n\t ' })).toBeUndefined()
  })
})

// ── layer 2: the wire ────────────────────────────────────────────────────────────────────────────
describe('the reason survives the option pipeline', () => {
  beforeAll(() => installBuiltins())

  const option: VizOption = {
    dataset: { id: 'demo' },
    grid: [{ id: 'g-blocked', region: { col: 0 } }, { id: 'g-open', region: { col: 1 } }],
    series: [
      {
        id: 's-blocked',
        type: 'scatter',
        coordId: 'g-blocked',
        encode: { layout: 'primary' },
        controlled: true,
        removeBlockedReason: REASON,
      },
      { id: 's-open', type: 'scatter', coordId: 'g-open', encode: { layout: 'primary' }, controlled: true },
    ],
  }

  it('parseOption stamps it onto the cell; a series without one stays field-free', () => {
    const plan = parseOption(option, { demo: CATALOG })
    expect(plan.cells['g-blocked'].removeBlockedReason).toBe(REASON)
    expect(plan.cells['g-open'].removeBlockedReason).toBeUndefined()
  })

  it('a BLANK declared reason is not stamped (the same normalization, one layer earlier)', () => {
    const blank: VizOption = {
      ...option,
      series: [{ ...option.series![0], removeBlockedReason: '   ' }, option.series![1]],
    }
    expect(parseOption(blank, { demo: CATALOG }).cells['g-blocked'].removeBlockedReason).toBeUndefined()
  })

  it('a save/restore round-trip keeps the block (getOption → strict JSON → setOption)', async () => {
    // A restore that dropped it would hand the user back the live-but-dead close this whole feature
    // exists to remove — the same argument that put `controlled` in this projection.
    const stores = createVizStores()
    const source = new FixtureSource({ seed: 3, pointCount: 100 })
    const controller = new VizController({ resolveDataset: () => source, stores })
    await controller.setOption({
      dataset: { id: 'demo' },
      grid: [{ id: 'g1', region: { col: 0 } }],
      series: [
        {
          id: 'g1',
          type: 'scatter',
          coordId: 'g1',
          encode: { layout: 'primary' },
          controlled: true,
          removeBlockedReason: REASON,
        },
      ],
    })
    const saved = controller.getOption()
    expect(saved.series?.find(s => s.id === 'g1')?.removeBlockedReason).toBe(REASON)
    await controller.setOption(JSON.parse(JSON.stringify(saved)) as VizOption, { replace: true })
    expect(stores.gridWorkspace.getState().cells['g1'].removeBlockedReason).toBe(REASON)
  })

  it('travels with the CONTENT on a swap — a drag must not launder a blocked pane into a closable one', () => {
    const a: GridCell = { id: 'a', kind: 'scatter', layoutId: 'primary', controlled: true, removeBlockedReason: REASON }
    const b: GridCell = { id: 'b', kind: 'violin', layoutId: 'primary' }
    const [aNext, bNext] = swapCellContent(a, b)
    expect(aNext.removeBlockedReason).toBeUndefined()
    expect(bNext.removeBlockedReason).toBe(REASON)
  })
})

// ── layer 3: what the user sees + can do ─────────────────────────────────────────────────────────
function renderToolbar(cell: GridCell, onRemove: () => void) {
  return render(
    React.createElement(PaneToolbar, {
      cell,
      catalog: CATALOG,
      onSetKind: () => {},
      onSplit: () => {},
      onRemove,
      onEdit: () => {},
    }),
  )
}

describe('PaneToolbar close affordance', () => {
  it('a removable pane: the close is LIVE and runs the handler (regression guard)', () => {
    const onRemove = vi.fn()
    const { getByTestId } = renderToolbar({ id: 'p1', kind: 'scatter', layoutId: 'primary' }, onRemove)
    const btn = getByTestId('viz-cell-remove-p1')
    expect(btn.getAttribute('aria-disabled')).toBeNull()
    fireEvent.click(btn)
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it('a blocked pane: the close is announced UNAVAILABLE and does nothing when clicked', () => {
    const onRemove = vi.fn()
    const { getByTestId } = renderToolbar(
      { id: 'p1', kind: 'scatter', layoutId: 'primary', controlled: true, removeBlockedReason: REASON },
      onRemove,
    )
    const btn = getByTestId('viz-cell-remove-p1')
    expect(btn.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(btn)
    expect(onRemove).not.toHaveBeenCalled()
  })

  it('a blocked pane keeps its own NAME — the reason must not swallow what the control is', () => {
    // If the reason became the accessible name, a screen-reader user would hear the explanation and
    // never learn which control they are on.
    const { getByTestId } = renderToolbar(
      { id: 'p1', kind: 'scatter', layoutId: 'primary', removeBlockedReason: REASON },
      () => {},
    )
    expect(getByTestId('viz-cell-remove-p1').getAttribute('aria-label')).toBe('Remove cell')
  })

  it('the reason is programmatically ASSOCIATED, not only revealed on hover', () => {
    // A tooltip exists in the accessibility tree only while it is open, and opening it takes a
    // pointer or a focus the user has no reason to spend on a greyed-out control. `aria-describedby`
    // is what makes the explanation available to assistive tech unconditionally.
    const { getByTestId, container } = renderToolbar(
      { id: 'p1', kind: 'scatter', layoutId: 'primary', removeBlockedReason: REASON },
      () => {},
    )
    const describedBy = getByTestId('viz-cell-remove-p1').getAttribute('aria-describedby')
    expect(describedBy, 'the blocked close must reference a description node').toBeTruthy()
    const description = container.ownerDocument.getElementById(describedBy!)
    expect(description, `no element with id "${describedBy}" — the reference dangles`).not.toBeNull()
    expect(description!.textContent).toBe(REASON)
  })

  it('the blocked close stays FOCUSABLE + hoverable, so its tooltip can ever open', () => {
    // The reason this is `aria-disabled` and not a native `disabled`: a natively-disabled button
    // fires no pointer events and leaves the tab order, so the tooltip carrying the reason could
    // never appear and the control would be greyed out AND mute — the original defect, restyled.
    const { getByTestId } = renderToolbar(
      { id: 'p1', kind: 'scatter', layoutId: 'primary', removeBlockedReason: REASON },
      () => {},
    )
    const btn = getByTestId('viz-cell-remove-p1') as HTMLButtonElement
    expect(btn.disabled, 'a native `disabled` would make the reason unreachable by hover').toBe(false)
    btn.focus()
    expect(btn.ownerDocument.activeElement).toBe(btn)
  })
})

// ── layer 3b: the SAME close, folded into the overflow menu ──────────────────────────────────────
// `remove` is in `RANK_ORDER`, so on a narrow pane the close is a MENU ROW rather than an icon —
// a second rendering of the same affordance, and the one a hover tooltip cannot help (the user has
// already opened a popup). It is asserted separately because "the icon form is right" says nothing
// about it: a fix applied to one form and not the other is exactly how a folded control ends up
// announcing nothing (the `aria-pressed`-dropped-by-MenuRowButton finding, this file's neighbour).
class StubResizeObserver {
  constructor(private readonly cb: (entries: unknown[], obs: unknown) => void) {}
  observe(el: Element) {
    this.cb([{ target: el, contentRect: el.getBoundingClientRect() }], this)
  }
  unobserve() {}
  disconnect() {}
}

/** Force the fold: jsdom reports every width as 0, so the toolbar's measure pass folds everything —
 *  but only once a `ResizeObserver` exists at all (without one the effect returns before measuring). */
function renderFoldedMenu(cell: GridCell, onRemove: () => void) {
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = StubResizeObserver
  const view = renderToolbar(cell, onRemove)
  const trigger = view.container.querySelector(`[data-testid="viz-cell-overflow-${cell.id}"]`)
  expect(trigger, 'nothing folded — the fixture is not exercising the menu form at all').not.toBeNull()
  fireEvent.click(trigger!)
  const row = view.container.ownerDocument.querySelector(
    `[data-testid="viz-cell-remove-${cell.id}"]`,
  ) as HTMLButtonElement | null
  expect(row, 'the folded close row never mounted').not.toBeNull()
  return row!
}

describe('PaneToolbar close affordance, folded into the overflow menu', () => {
  // The stub is a GLOBAL, and jsdom reports every width as 0 — so leaving it installed would make
  // every later toolbar in this file fold too, and the icon-form assertions would silently start
  // querying a control that is no longer inline. Scoped to this block, deliberately.
  afterEach(() => {
    delete (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver
  })

  it('a blocked pane: the row is inert and SHOWS the reason (no hover required)', () => {
    const onRemove = vi.fn()
    const row = renderFoldedMenu(
      { id: 'p1', kind: 'scatter', layoutId: 'primary', removeBlockedReason: REASON },
      onRemove,
    )
    expect(row.disabled).toBe(true)
    // In a menu there is ROOM, so the explanation is text rather than a tooltip — the strongest
    // form, reachable without a pointer, a focus, or an accessibility tree.
    expect(row.textContent).toContain(REASON)
    expect(row.getAttribute('aria-label')).toContain(REASON)
    expect(row.getAttribute('aria-label')).toContain('Remove cell')
    fireEvent.click(row)
    expect(onRemove).not.toHaveBeenCalled()
  })

  it('POSITIVE CONTROL: a removable pane folds into a LIVE row that still removes', () => {
    const onRemove = vi.fn()
    const row = renderFoldedMenu({ id: 'p1', kind: 'scatter', layoutId: 'primary' }, onRemove)
    expect(row.disabled, 'the fold must not disable an ordinary close').toBe(false)
    fireEvent.click(row)
    expect(onRemove).toHaveBeenCalledTimes(1)
  })
})

// ── layer 4: the routing branch the button drives ────────────────────────────────────────────────
function renderPane(cell: GridCell, stores: ReturnType<typeof createVizStores>, bus: { emit(e: VizEvent): void }) {
  return render(
    React.createElement(
      VizStoresProvider,
      { value: stores },
      React.createElement(
        VizEventBusContext.Provider,
        { value: bus },
        React.createElement(CellView, {
          cell,
          rect: RECT,
          source: SOURCE,
          catalog: CATALOG,
          positions: new Float32Array(0),
          colors: new Uint8Array(0),
          showToolbar: true,
        }),
      ),
    ),
  )
}

describe('CellView close routing', () => {
  /** A store whose `removeCell` is a spy — the observable effect of the built-in remove. */
  function storesWithRemoveSpy() {
    const stores = createVizStores()
    const removeCell = vi.fn()
    stores.gridWorkspace.setState({ removeCell } as never)
    return { stores, removeCell }
  }

  it('UNCONTROLLED: the pane removes itself through the store', () => {
    const { stores, removeCell } = storesWithRemoveSpy()
    const emit = vi.fn()
    const { getByTestId } = renderPane({ id: 'p1', kind: 'scatter', layoutId: 'primary' }, stores, { emit })
    fireEvent.click(getByTestId('viz-cell-remove-p1'))
    expect(removeCell).toHaveBeenCalledWith('p1')
    expect(emit).not.toHaveBeenCalled()
  })

  it('CONTROLLED with a route: emits `cell-close` and does NOT self-remove (unchanged)', () => {
    const { stores, removeCell } = storesWithRemoveSpy()
    const emit = vi.fn()
    const { getByTestId } = renderPane(
      { id: 'p1', kind: 'scatter', layoutId: 'primary', controlled: true },
      stores,
      { emit },
    )
    fireEvent.click(getByTestId('viz-cell-remove-p1'))
    expect(emit).toHaveBeenCalledWith({ type: 'cell-close', cellId: 'p1' })
    expect(removeCell).not.toHaveBeenCalled()
  })

  it('CONTROLLED with NO route: neither branch fires, and the close says why', () => {
    const { stores, removeCell } = storesWithRemoveSpy()
    const emit = vi.fn()
    const { getByTestId } = renderPane(
      { id: 'p1', kind: 'scatter', layoutId: 'primary', controlled: true, removeBlockedReason: REASON },
      stores,
      { emit },
    )
    const btn = getByTestId('viz-cell-remove-p1')
    expect(btn.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(btn)
    expect(emit, 'a blocked close must not emit an event nobody handles').not.toHaveBeenCalled()
    expect(removeCell, 'and must not fall through to the built-in remove either').not.toHaveBeenCalled()
  })
})
