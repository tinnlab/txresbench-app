// @vitest-environment jsdom
//
// cellDomIdentity — a pane's DOM identity is the id its AUTHOR wrote; the grid's own identity is a
// separate channel.
//
// ── THE DEFECT ──────────────────────────────────────────────────────────────────────────────────
// A host that composes several independently-authored declarations onto ONE grid must namespace
// their pane ids, or two unrelated plots that happen to share a name silently merge into one square.
// The cell id therefore stopped being anything an author wrote — and the cell id is what this
// component stamped into `data-testid="viz-cell-view-…"`. So every reader of the DOM inherited the
// host's internal key: a testid carrying a separator plus whichever contribution happened to place
// the pane.
//
// Two ids, two channels: `data-testid` carries the AUTHORED id (`localId`, when the host supplies
// one), `data-cell-id` carries the grid's own. The second is not decoration — the cross-window drag
// hit-test recovers cell ids from the DOM and feeds them straight back into `swapCells`/`movePane`,
// so the mapping has to stay invertible. It used to invert through the testid, which is exactly why
// the internal key was in the testid in the first place.
//
// ── WHERE THE REST OF THE CHAIN IS ──────────────────────────────────────────────────────────────
// This file owns the rendered DOM. The composing host's half — which pane gets which `localId`, and
// that the internal namespacing survives — is `src-app/ui/src/modules/workbench/extensions/canvas/
// composedPaneDomId.test.ts`.
//
// ── THE SECOND ROUND: `viz-cell-view-*` WAS ONE OF TWENTY ───────────────────────────────────────
// Fixing the pane ROOT's testid left every other id this chrome stamps still carrying the fold key —
// the toolbar and its ten actions, the grip, the overflow trigger and its panel, the colour-by and
// plot-kind selects, the pop-out/return buttons, the drop indicator, the tear-off prompt. A test
// that names them one by one is a hand-list, and a hand-list drops the twenty-first: the class of
// defect is "some id in this pane's chrome carries the host's key", so the assertion below is over
// the CLASS — every `data-testid` the pane renders — rather than over a list somebody maintains.
//
// `paneChromeIds` is deliberately scoped to what this chrome OWNS: the pane subtree — it starts at
// `[data-cell-id]`, so it is structurally blind to anything rendered into another container.
//
// THE RECORDED EXCLUSION IS NOW CLOSED. This header used to say the per-pane EDIT FORM and the dock
// headers "still stamp the grid key, and are recorded as such rather than silently included in a
// green". They no longer do: `dockDomIdentity.test.ts` holds the same CLASS assertion over
// `PaneEditForm` and over the annotate + segment docks as `GridDockLayer` really renders them, plus
// the label-wiring fixture for the `id=`/`htmlFor=` channel those surfaces additionally carry.
// Extending THIS file was not an option — the dock surfaces are not inside any pane's subtree, so
// the scan above would have gone on reporting an empty leak set over them, vacuously.

import * as React from 'react'
import { render, cleanup } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { CellView } from './CellView'
import { cellTestId, paneTestId, type GridCell } from './gridModel'
import { VizEventBusContext } from '../events/EventBusContext'
import type { VizEvent } from '../events/emitter'
import { createVizStores, VizStoresProvider } from '../../adapter/vizStores'
import { VizController } from '../../adapter/VizController'
import { FixtureSource } from '../data/fixtures'
import { installBuiltins } from '../charts/installBuiltins'
import { parseOption } from '../option/parse'
import type { VizOption } from '../option/types'
import type { DatasetCatalog, DataSource } from '../data/wire'
import type { PaneRect } from '../layers/multiView'

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
/** Never read — a DENSE (scatter) cell draws on the shared deck, so `CellView` renders chrome only. */
const SOURCE = {} as unknown as DataSource

afterEach(() => cleanup())

function renderPane(cell: GridCell, extra: Record<string, unknown> = {}) {
  const bus = { emit(_e: VizEvent) {} }
  return render(
    React.createElement(
      VizStoresProvider,
      { value: createVizStores() },
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
          ...extra,
        }),
      ),
    ),
  )
}

describe('cellTestId — the id a reader addresses', () => {
  it('is the authored id when the host namespaced the cell', () => {
    expect(cellTestId({ id: 'cell-filter::emb', localId: 'emb' } as GridCell)).toBe('emb')
  })

  it('falls back to the cell id when nothing was namespaced (every un-composed caller)', () => {
    expect(cellTestId({ id: 'cell-1' } as GridCell)).toBe('cell-1')
  })
})

/** `paneTestId` — the same rule for the loops that hold a KEY instead of a cell (the measured pane
 *  rects, a link group's member list, the split tree's leaves). Those were the routes by which the
 *  fold key reached the legend, the plot title, the visual-map and the leaf body. */
describe('paneTestId — the same identity, reached from a grid key', () => {
  const CELLS = {
    'cell-filter::emb': { id: 'cell-filter::emb', localId: 'emb' },
    plain: { id: 'plain' },
  }

  it('resolves a composed key to the authored id', () => {
    expect(paneTestId(CELLS, 'cell-filter::emb')).toBe('emb')
  })

  it('is the key itself for an un-composed pane — byte-identical to before it existed', () => {
    expect(paneTestId(CELLS, 'plain')).toBe('plain')
  })

  it('falls back to the key for a pane the map no longer holds (mid-teardown)', () => {
    // The legend / title loops iterate MEASURED rects, which outlive a removed cell by one commit.
    // Throwing or emitting `undefined` there would turn a routine teardown into a broken testid.
    expect(paneTestId(CELLS, 'gone')).toBe('gone')
  })
})

describe('the wire carries both ids', () => {
  beforeAll(() => installBuiltins())

  it('parseOption stamps them; a series declaring neither stays field-free', () => {
    const option: VizOption = {
      dataset: { id: 'demo' },
      grid: [{ id: 'cell-filter::emb', region: { col: 0 } }, { id: 'plain', region: { col: 1 } }],
      series: [
        {
          id: 's-emb',
          type: 'scatter',
          coordId: 'cell-filter::emb',
          localId: 'emb',
          ownerId: 'cell-filter',
          encode: { layout: 'primary' },
        },
        { id: 's-plain', type: 'scatter', coordId: 'plain', encode: { layout: 'primary' } },
      ],
    }
    const plan = parseOption(option, CATALOG)
    expect(plan.cells['cell-filter::emb'].localId).toBe('emb')
    expect(plan.cells['cell-filter::emb'].ownerId).toBe('cell-filter')
    expect(plan.cells.plain.localId).toBeUndefined()
    expect(plan.cells.plain.ownerId).toBeUndefined()
  })

  it('and survives a save/restore round-trip (getOption → strict JSON → setOption)', async () => {
    // A restore that dropped them would hand back a grid addressed by the host's internal
    // composition key again — the exact leak they exist to close, reintroduced by a reload.
    const stores = createVizStores()
    const source = new FixtureSource({ seed: 3, pointCount: 100 })
    const controller = new VizController({ resolveDataset: () => source, stores })
    await controller.setOption({
      dataset: { id: 'demo' },
      grid: [{ id: 'cell-filter::emb', region: { col: 0 } }],
      series: [
        {
          id: 's-emb',
          type: 'scatter',
          coordId: 'cell-filter::emb',
          localId: 'emb',
          ownerId: 'cell-filter',
          encode: { layout: 'primary' },
        },
      ],
    })
    const saved = JSON.parse(JSON.stringify(controller.getOption())) as VizOption
    expect(saved.series?.[0].localId).toBe('emb')
    expect(saved.series?.[0].ownerId).toBe('cell-filter')

    await controller.setOption(saved)
    const restored = stores.gridWorkspace.getState().cells
    const cell = Object.values(restored)[0] as GridCell
    expect(cellTestId(cell)).toBe('emb')
  })
})

describe('the rendered pane', () => {
  beforeAll(() => installBuiltins())

  const composed = {
    id: 'cell-filter::emb',
    localId: 'emb',
    ownerId: 'cell-filter',
    kind: 'scatter',
    layoutId: 'primary',
  } as GridCell

  it('is addressed by the AUTHORED id — no separator, no view id', () => {
    const { container } = renderPane(composed)
    const el = container.querySelector('[data-testid^="viz-cell-view-"]')
    expect(el, 'the pane root renders').not.toBeNull()
    const testid = el!.getAttribute('data-testid')!
    expect(
      testid,
      'a spec addressing this pane would have to know the composition separator AND which view ' +
        'happened to contribute the pane — neither is any of its business',
    ).toBe('viz-cell-view-emb')
    expect(testid).not.toContain('::')
  })

  it('still exposes the grid-internal id, because the drag hit-test inverts through it', () => {
    const { container } = renderPane(composed)
    const el = container.querySelector('[data-testid^="viz-cell-view-"]')!
    expect(
      el.getAttribute('data-cell-id'),
      'the cross-window drag recovers cell ids off these elements and feeds them to swapCells / ' +
        'movePane — losing the invertible id would silently break the drag on a composed grid',
    ).toBe('cell-filter::emb')
    // …and which contribution placed it, so two views that both named a pane `emb` stay tellable apart.
    expect(el.getAttribute('data-cell-owner')).toBe('cell-filter')
  })

  it('an un-composed cell is byte-identical to before: testid = cell id, no owner attribute', () => {
    const { container } = renderPane({ id: 'cell-1', kind: 'scatter', layoutId: 'primary' } as GridCell)
    const el = container.querySelector('[data-testid^="viz-cell-view-"]')!
    expect(el.getAttribute('data-testid')).toBe('viz-cell-view-cell-1')
    expect(el.getAttribute('data-cell-id')).toBe('cell-1')
    expect(el.getAttribute('data-cell-owner')).toBeNull()
  })
})

/** Every `data-testid` the pane's own chrome renders, with the pane ROOT included. */
function paneChromeIds(container: HTMLElement): string[] {
  const root = container.querySelector('[data-cell-id]')
  if (!root) return []
  return [root, ...Array.from(root.querySelectorAll('[data-testid]'))]
    .map(el => el.getAttribute('data-testid'))
    .filter((v): v is string => v !== null)
}

describe('the WHOLE pane chrome is addressed by the authored id, not just the root', () => {
  beforeAll(() => installBuiltins())

  const composed = {
    id: 'cell-filter::emb',
    localId: 'emb',
    ownerId: 'cell-filter',
    kind: 'scatter',
    layoutId: 'primary',
  } as GridCell

  /** Enough handlers that the toolbar offers its optional actions too — a capability-gated button
   *  that never renders cannot be caught leaking, and those were half the sites. */
  const wired = {
    onExportCell: () => {},
    onEditCell: () => {},
    onShowData: () => {},
    onAnnotateCell: () => {},
    onSegmentCell: () => {},
    onToggleLink: () => {},
  }

  it('NO id in the pane subtree carries the composition separator', () => {
    const { container } = renderPane(composed, wired)
    const ids = paneChromeIds(container)
    // A vacuous pass is the real risk here: if the chrome failed to render, the loop below has
    // nothing to reject. The toolbar alone contributes a dozen ids.
    expect(ids.length, 'the pane must actually render its chrome for this to mean anything').toBeGreaterThan(8)
    expect(
      ids.filter(id => id.includes('::')),
      'a spec, a screenshot diff or a screen reader addressing any of these would have to know the ' +
        "host's composition separator and which declaration contributed the pane",
    ).toEqual([])
  })

  it('…and every one of them ENDS with the authored id, so they address the same pane', () => {
    const { container } = renderPane(composed, wired)
    // `viz-drop-tile-<id>-<zone>` is the one shape with a suffix after the id; it renders only
    // while this pane is a drop target, so it is absent here and the rule is a clean equality.
    const ids = paneChromeIds(container)
    expect(ids.filter(id => !id.endsWith('-emb'))).toEqual([])
  })

  // ── THE DRAG GHOST IS NOT ASSERTED HERE, and that is a finding rather than an omission ─────────
  // `useGripDrag` appends the ghost to `document.body`, OUTSIDE the render container, so the two
  // subtree scans above are structurally blind to it — exactly the kind of site a hand-list drops.
  // It cannot be reached from this harness either: `beginGripDrag` refuses to start unless
  // `opts.snapshot` finds a `viz-grid-workspace` in the source window and returns pane rects, and a
  // bare `<CellView>` has neither. Mounting a whole workspace here would not help — jsdom's
  // `getBoundingClientRect` is all zeros, so every pane rect would be degenerate and the hit-test
  // meaningless. It is asserted in a REAL browser instead, by the composed-grid drag spec
  // (`ui/tests/viz-e2e/composed-grid-drag.spec.ts`), which drives a real pointer over a real layout.

  it('the blocked-Close DESCRIPTION id stays on the grid key — two panes named alike must not collide', () => {
    // The one id on this strip that is NOT swept, and the only one with a reason to be different:
    // it is an `id=` attribute wired by `aria-describedby`, so it has to be unique IN THE DOCUMENT.
    // The authored id is deliberately not — namespacing exists precisely because two declarations may
    // name a pane the same thing — and a duplicate `id` fails silently: the browser resolves the
    // reference to whichever node came first, so one pane's blocked Close would announce the OTHER
    // pane's reason to a screen reader, with no visible symptom at all.
    //
    // This is the window that mutation testing said no fixture could hold, so the fixture is built
    // here: two panes that BOTH call themselves `emb` and are BOTH close-blocked, in one document.
    const blocked = (ownerId: string, reason: string) =>
      ({
        id: `${ownerId}::emb`,
        localId: 'emb',
        ownerId,
        kind: 'scatter',
        layoutId: 'primary',
        removeBlockedReason: reason,
      }) as GridCell

    const a = renderPane(blocked('view.alpha', 'the alpha reason'), wired)
    const b = renderPane(blocked('view.beta', 'the beta reason'), wired)
    const describedBy = (v: typeof a) =>
      v.container.querySelector('[data-testid^="viz-cell-remove-"]')!.getAttribute('aria-describedby')
    const idsOf = (v: typeof a) =>
      Array.from(v.container.querySelectorAll('[id]')).map(el => el.getAttribute('id'))

    // Both panes are addressed identically — which is exactly the hazard.
    expect(a.container.querySelector('[data-testid^="viz-cell-remove-"]')!.getAttribute('data-testid'))
      .toBe(b.container.querySelector('[data-testid^="viz-cell-remove-"]')!.getAttribute('data-testid'))
    // …and their description targets are NOT, so each Close describes its own pane.
    expect(describedBy(a), 'the blocked-Close description must resolve per pane').not.toBe(describedBy(b))
    expect(idsOf(a).filter(id => idsOf(b).includes(id)), 'no `id` may be shared across the two').toEqual([])
    // Each still points at a node that exists and carries ITS OWN reason.
    // `querySelector('#…')` needs CSS escaping the id deliberately does not avoid, and jsdom ships
    // no `CSS` object — read the id attribute directly instead.
    const byId = (v: typeof a, id: string) =>
      Array.from(v.container.querySelectorAll('[id]')).find(el => el.getAttribute('id') === id)
    expect(byId(a, describedBy(a)!)?.textContent).toBe('the alpha reason')
    expect(byId(b, describedBy(b)!)?.textContent).toBe('the beta reason')
  })

  it('an un-composed pane renders the SAME id set, keyed by its own id — the negative control', () => {
    const { container } = renderPane(
      { id: 'cell-1', kind: 'scatter', layoutId: 'primary' } as GridCell,
      wired,
    )
    const ids = paneChromeIds(container)
    expect(ids.length).toBeGreaterThan(8)
    expect(ids.filter(id => !id.endsWith('-cell-1'))).toEqual([])
  })
})
