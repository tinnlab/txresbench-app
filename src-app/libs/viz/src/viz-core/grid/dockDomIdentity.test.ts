// @vitest-environment jsdom
//
// dockDomIdentity — the per-pane DOCK SURFACES are addressed by the id their author wrote, the same
// rule `cellDomIdentity.test.ts` already holds over the pane's own chrome.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────────────────────────
// The pane-chrome round swept 37 ids in the PANE SUBTREE onto `cellTestId`/`paneTestId` and recorded,
// in `cellDomIdentity.test.ts`'s header, that the edit form and the dock headers were LEFT stamping
// the composing host's fold key — "rendered by other layers into other containers, still stamp the
// grid key, and are recorded as such rather than silently included in a green". That record is what
// this file closes. It is a second file rather than a second `describe` because the subjects are
// rendered by a different layer (`GridDockLayer`) into a different container, and the pane-subtree
// scan there is structurally blind to them: `paneChromeIds` starts at `[data-cell-id]`, which no
// dock surface is inside.
//
// ── WHY THE SWEEP WAS SURGERY RATHER THAN A RENAME ───────────────────────────────────────────────
// In the pane chrome, the cell id reached the DOM and nothing else. On the dock surfaces the SAME
// identifier also feeds STORE CALLS — `closeEditCell(id)`, `annotateStoreFor(id)`,
// `patchMaskReview(cellId, …)`, `shareMaskAcrossGroup(groupId)` — so resolving it at the top would
// have re-pointed the writes at an id no store is keyed by. The two identities are therefore
// THREADED separately: the grid key keeps every store call and every `id=` that must be
// document-unique; `cellTestId`/`paneTestId` supplies every `data-testid` and every announced name.
//
// ── THE THIRD IDENTITY: `id=` / `htmlFor=` ARE NOT TESTIDS ───────────────────────────────────────
// `PaneEditForm` wires six labels to their controls with `htmlFor`/`id`. An `id` attribute must be
// unique IN THE DOCUMENT and the authored id deliberately is not — namespacing exists precisely
// because two declarations may name a pane the same thing — so those pairs KEEP the grid key. This
// is the same reasoning `cellDomIdentity.test.ts` records for `blockedAction`'s `whyId`, and it is
// load-bearing here for a stronger reason: INV-8 says several panes' edit forms are open AT ONCE,
// so a duplicate `id` is not hypothetical. Clicking pane B's "Plot title" label would focus pane A's
// input — a silent, symptomless mis-wire. The fixture at the bottom holds exactly that window.

import * as React from 'react'
import { render, cleanup, act } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { PaneEditForm, type PaneEditFormProps } from '../controls/PaneEditForm'
import { GridDockLayer, type GridDockLayerProps } from './GridDockLayer'
import { GridWorkspaceSeamProvider, type GridWorkspaceSeam } from './GridWorkspaceContext'
import { type GridCell, type GridDockApi, type LabelMaskData } from './gridModel'
import { createVizStores } from '../../adapter/vizStores'
import { createCellDisplayStore } from '../../adapter/CellDisplay.store'
import { createPaneDocksStore } from '../../adapter/PaneDocks.store'
import { createAnnotateStore } from '../annotate/Annotate.store'
import { createMaskCorrectController } from '../annotate/maskCorrectController'
import { installBuiltins } from '../charts/installBuiltins'
import type { PaneRect } from '../layers/multiView'

// `react-resizable-panels` and the kit's overlay primitives construct observers jsdom does not
// ship. Nothing here asserts on SIZE — only on ids written during render.
class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= NoopObserver

afterEach(() => cleanup())

/** The composed pane: the grid's key namespaces the declaring view, the AUTHORED id is `emb`. */
const COMPOSED_KEY = 'view.filter::emb'
const AUTHORED = 'emb'

/** `segment: true` is load-bearing, not decoration. The mask dock's SHARE affordances — "Share mask
 *  across group", "Apply contrast + palette to group" and the share NOTICE, three of the ids swept
 *  here — render only when the pane's link group holds ≥2 members that are BOTH `segment` AND carry
 *  a resolved mask (`groupSegmentCount >= 2`). Mutation testing found this: with plain cells the
 *  block never rendered, and mutating all three ids back to the grid key killed nothing. */
const composedCell = (key = COMPOSED_KEY, localId = AUTHORED): GridCell =>
  ({ id: key, localId, ownerId: 'view.filter', kind: 'scatter', layoutId: 'primary', segment: true }) as GridCell

// ── the edit form ────────────────────────────────────────────────────────────────────────────────

/** Every optional section turned ON, because a section that never renders cannot be caught leaking —
 *  and the categorical + channel rows are where the id gains a SUFFIX, which is the shape a naive
 *  "ends with the pane id" rule gets wrong. */
function editFormProps(paneId: string, domIdScope: string): PaneEditFormProps {
  const noop = () => {}
  return {
    paneId,
    domIdScope,
    plotTitle: 'A',
    axisX: 'x',
    axisY: 'y',
    legendTitle: '',
    hasLegend: true,
    showLegend: true,
    legendCorner: 'tr',
    legendBeside: false,
    hasGrid: true,
    showGrid: true,
    categoryEntries: [
      { code: 0, label: 'one', hex: '#112233' },
      { code: 1, label: 'two', hex: '#445566' },
    ],
    categoryNames: ['one', 'two'],
    hidden: new Set<number>(),
    legendHidden: new Set<number>(),
    colormap: 'viridis',
    domain: [0, 1],
    range: [0, 1],
    showMarks: true,
    radius: 3,
    opacity: 1,
    typography: {},
    linkColorScale: false,
    legendUseRange: false,
    hasChannels: true,
    channels: [{ name: 'DAPI', visible: true, color: [255, 0, 0], contrastLimits: [0, 255] }],
    contrastMax: 255,
    onClose: noop,
    onSetPlotTitle: noop,
    onSetAxisTitle: noop,
    onSetLegendTitle: noop,
    onSetShowLegend: noop,
    onSetLegendCorner: noop,
    onSetLegendBeside: noop,
    onSetShowGrid: noop,
    onSetTypography: noop,
    onSetColormap: noop,
    onSetRadius: noop,
    onSetOpacity: noop,
    onSetCategoryColor: noop,
    onSetCategoryLabel: noop,
    onSetPalette: noop,
    onToggleCategory: noop,
    onToggleLegendHidden: noop,
    onSetRange: noop,
    onSetLegendUseRange: noop,
    onToggleLinkColorScale: noop,
  } as unknown as PaneEditFormProps
}

const renderEditForm = (paneId: string, domIdScope: string) =>
  render(React.createElement(PaneEditForm, editFormProps(paneId, domIdScope)))

/** Every `data-testid` in a rendered container, root included. */
function testIds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-testid]'))
    .map(el => el.getAttribute('data-testid'))
    .filter((v): v is string => v !== null)
}

/** An id ADDRESSES pane `p` when `p` is its last path segment or the segment before a suffix —
 *  `viz-edit-title-emb` and `viz-edit-cat-emb-1` both do; `viz-edit-title-view.filter::emb` does not. */
const addresses = (id: string, pane: string): boolean => id === pane || id.endsWith(`-${pane}`) || id.includes(`-${pane}-`)

describe('the per-pane EDIT FORM is addressed by the authored id', () => {
  it('NO id it renders carries the composition separator', () => {
    const { container } = renderEditForm(AUTHORED, COMPOSED_KEY)
    const ids = testIds(container)
    // A vacuous pass is the real risk: with every section gated off, the loop has nothing to reject.
    expect(ids.length, 'the form must actually render its sections for this to mean anything').toBeGreaterThan(25)
    expect(
      ids.filter(id => id.includes('::')),
      'a spec, a screenshot diff or a screen reader addressing any of these would have to know the ' +
        "host's composition separator AND which declaration contributed the pane",
    ).toEqual([])
  })

  it('…and every one of them ADDRESSES the same pane', () => {
    const { container } = renderEditForm(AUTHORED, COMPOSED_KEY)
    expect(testIds(container).filter(id => !addresses(id, AUTHORED))).toEqual([])
  })

  it('an UN-COMPOSED pane renders the SAME id set keyed by its own id — the negative control', () => {
    const { container } = renderEditForm('cell-1', 'cell-1')
    const ids = testIds(container)
    expect(ids.length).toBeGreaterThan(25)
    expect(ids.filter(id => !addresses(id, 'cell-1'))).toEqual([])
  })

  it('the LABEL WIRING stays on the grid key — two panes named alike must not steal each other\'s focus', () => {
    // The window mutation testing said no fixture could hold, built: two panes that BOTH call
    // themselves `emb`, BOTH open (INV-8 allows N at once), in ONE document. A duplicate `id` fails
    // silently — the browser resolves `htmlFor` to whichever node came first, so clicking pane B's
    // label focuses pane A's input, with no visible symptom.
    const a = renderEditForm(AUTHORED, 'view.alpha::emb')
    const b = renderEditForm(AUTHORED, 'view.beta::emb')
    const idsOf = (v: typeof a) =>
      Array.from(v.container.querySelectorAll('[id]')).map(el => el.getAttribute('id')!)

    // Both are ADDRESSED identically — which is exactly the hazard the `id=` channel must dodge.
    expect(testIds(a.container)).toEqual(testIds(b.container))
    expect(idsOf(a).length, 'the form must wire labels for this to mean anything').toBeGreaterThan(4)
    expect(idsOf(a).filter(id => idsOf(b).includes(id)), 'no `id` may be shared across the two').toEqual([])

    // …and each label still resolves to a control INSIDE ITS OWN form.
    for (const v of [a, b]) {
      const labels = Array.from(v.container.querySelectorAll<HTMLLabelElement>('label[for]'))
      expect(labels.length).toBeGreaterThan(3)
      for (const label of labels) {
        const target = Array.from(v.container.querySelectorAll('[id]')).find(
          el => el.getAttribute('id') === label.getAttribute('for'),
        )
        expect(target, `label "${label.textContent}" must resolve inside its own form`).toBeTruthy()
      }
    }
  })
})

// ── the dock panels (annotate + segment), rendered by the real layer ─────────────────────────────

/** The seam members `GridDockLayer` actually reads. The rest of `GridWorkspaceSeam` is never touched
 *  by this layer, so supplying it would be fixture that proves nothing. */
function seamValue(): GridWorkspaceSeam {
  const stores = createVizStores()
  return {
    stores,
    storesRef: { current: stores },
    cellDisplay: createCellDisplayStore(),
    paneDocks: createPaneDocksStore(),
    viewStateRef: { current: {} },
    cellDataRef: { current: () => ({}) },
    cellSelectionSpaceRef: { current: () => 'space' },
    activeCellRef: { current: null },
  } as unknown as GridWorkspaceSeam
}

const RECT = (id: string): PaneRect => ({ id, x: 0, y: 0, width: 400, height: 300 })

/** A 2×2 label mask with two classes, so the review panel renders real category rows. */
function labelMask(): LabelMaskData {
  const raster = new Uint32Array([0, 1, 2, 1])
  const categoryForId = new Uint16Array([0, 1, 2])
  return { raster, width: 2, height: 2, categoryForId }
}

/** Mount the dock layer with the annotate AND segment docks open on TWO panes of one link group —
 *  the group is what makes the share/apply affordances render, and they carry three of the ids.
 *
 *  The EXPORT dialog is opened too, through the layer's own `apiRef` handle rather than a prop,
 *  because `exportTarget` is this layer's private state (SPLIT C) and the handle is how the pane
 *  toolbar's Export button reaches it in production. Without this the scan below would run over four
 *  of the five dock surfaces and report an empty leak set for the fifth, vacuously — which is
 *  precisely how the export dialog's own `cellId` survived the first pass of this sweep. */
function renderDocks(cells: readonly GridCell[]) {
  const seam = seamValue()
  const ids = cells.map(c => c.id)
  seam.paneDocks.getState().openAnnotate(ids[0])
  seam.paneDocks.setState({ editCellIds: new Set([ids[0]]), segmentOpenIds: new Set(ids) })

  const apiRef: React.RefObject<GridDockApi | null> = { current: null }
  const cellMap = Object.fromEntries(cells.map(c => [c.id, c])) as Record<string, GridCell>
  const mask = labelMask()
  const controller = createMaskCorrectController({
    mask: mask.raster,
    width: mask.width,
    height: mask.height,
    categoryForId: mask.categoryForId,
  })
  const noop = () => {}
  const props = {
    isPrimaryContainer: true,
    apiRef,
    containerRef: { current: null },
    cells,
    cellMap,
    denseCells: cells,
    denseIds: new Set(ids),
    rects: ids.map(RECT),
    insetPane: (r: PaneRect) => r,
    legendGutterFor: () => null,
    cellToolbarsOn: true,
    radius: 3,
    cellData: () => ({ positions: new Float32Array(0), colors: new Uint8Array(0), nPoints: 0 }),
    chartContribs: new Map(),
    closeEditCell: noop,
    legendForCell: () => undefined,
    perCellLegend: {},
    valueLegends: {},
    perCellHiddenCodes: {},
    perCellRange: {},
    perCellColors: {},
    setCellRange: noop,
    imagePyramids: {},
    setImageChannel: noop,
    setImageColormap: noop,
    autoContrastChannel: noop,
    closeDataTable: noop,
    publishChartHover: noop,
    perCellColorData: {},
    perCellPlotRows: {},
    colorOverrides: {},
    cameraEpoch: 0,
    annotateMode: true,
    annotateCellIds: ids,
    annotateStoreFor: () => createAnnotateStore(),
    boundAnnotateCellId: ids[0],
    closeAnnotateCell: noop,
    annotateEditor: { polyDraftLength: 0, finishPolygon: noop, cancelDraft: noop },
    onAnnotateExportSeeds: noop,
    segmentMode: true,
    segmentCellIds: ids,
    patchMaskReview: noop,
    closeSegmentCell: noop,
    ensureMaskSession: () => ({ controller, data: mask }),
    resolvedLabelMask: () => mask,
    sharedSessionForCell: () => null,
    cellLinkGroup: Object.fromEntries(ids.map(id => [id, 'group-1'])),
    linkGroups: { 'group-1': [...ids] },
    maskShareNotice: 'a notice',
    shareMaskAcrossGroup: noop,
    detachSharedMask: noop,
    applyDisplayToGroup: noop,
    bumpMask: noop,
  } as unknown as GridDockLayerProps

  const view = render(
    React.createElement(
      GridWorkspaceSeamProvider,
      { value: seam },
      React.createElement(GridDockLayer, props),
    ),
  )
  // The layer fills `apiRef` during render; opening through it is what the pane toolbar's Export
  // button does. `act` so the state write flushes before the scan reads the DOM.
  act(() => apiRef.current?.openExportCell(ids[0]))
  return view
}

describe('the DOCK PANELS are addressed by the authored id', () => {
  beforeAll(() => installBuiltins())

  const cells = [composedCell(), composedCell('view.filter::seg', 'seg')]

  it('NO id any dock renders carries the composition separator', () => {
    const { container } = renderDocks(cells)
    const ids = testIds(container)
    // Non-vacuity: the annotate dock alone contributes ~15 ids, the mask dock ~8, the edit form ~30.
    expect(ids.length, 'the docks must actually render for this to mean anything').toBeGreaterThan(40)
    expect(
      ids.filter(id => id.includes('::')),
      'the dock panels are the surfaces `cellDomIdentity.test.ts` recorded as still leaking the ' +
        "host's fold key; that record is closed here",
    ).toEqual([])
  })

  // ── PANE-AMBIGUOUS IDS: a RECORDED residue, not a hand-list of covered sites ───────────────────
  // The assertion below is over the CLASS — every id a dock renders must name the pane it belongs to
  // — with an ENUMERATED exception set. The difference matters: a hand-list of covered sites drops
  // the twenty-first site silently, whereas an exception set is closed, so a NEW bare id fails this
  // test the moment it is written. What is in the set today, and why it is not swept here:
  //
  //   `viz-edit-panel`         the grid's own internal right panel — the CONTAINER the docks stack
  //                            in, one per workspace. It belongs to no pane, correctly.
  //   `viz-mask-*` (10 ids)    `MaskReviewControls`' own chrome. These never carried the composition
  //                            key — they are a DIFFERENT defect (pane-ambiguity in a shared child,
  //                            the one `AnnotateControls` already closed with its `data-testid`
  //                            prefix prop) — and they have live external consumers in
  //                            `libs/viz/tests/e2e/*.mjs` that address them bare. Fixing them is
  //                            a prefix prop plus those specs; it is recorded here rather than
  //                            folded into a composition-key sweep. Note the duplication the run
  //                            below exposes: with TWO segment docks open, every one of these ten
  //                            appears TWICE in one document, so a spec addressing them silently
  //                            asserts the first pane.
  const PANE_AMBIGUOUS_RESIDUE = [
    'viz-edit-panel',
    'viz-mask-review-controls',
    'viz-mask-cell-readout',
    'viz-mask-undo',
    'viz-mask-redo',
    'viz-mask-class-visible-1',
    'viz-mask-class-visible-2',
    'viz-mask-class-solo-1',
    'viz-mask-class-solo-2',
    'viz-mask-tool-relabel',
    'viz-mask-tool-split',
    'viz-mask-tool-merge',
    'viz-mask-tool-brush',
  ]

  it('every dock id ADDRESSES one of the open panes, bar the recorded residue', () => {
    // INV-12 puts N panels on screen at once, so an id that names no pane silently addresses the
    // FIRST one — the single-pane blind spot per-pane docking exists to remove.
    const { container } = renderDocks(cells)
    const panes = ['emb', 'seg']
    const orphans = testIds(container).filter(id => !panes.some(p => addresses(id, p)))
    expect(
      [...new Set(orphans)].sort(),
      'every dock id must name the pane it belongs to, or be a RECORDED exception above',
    ).toEqual([...PANE_AMBIGUOUS_RESIDUE].sort())
  })

  it('an UN-COMPOSED grid renders the SAME id set keyed by its own ids — the negative control', () => {
    const plain = [
      { id: 'cell-1', kind: 'scatter', layoutId: 'primary', segment: true } as GridCell,
      { id: 'cell-2', kind: 'scatter', layoutId: 'primary', segment: true } as GridCell,
    ]
    const composedIds = testIds(renderDocks(cells).container)
    cleanup()
    const plainIds = testIds(renderDocks(plain).container)
    expect(plainIds.length).toBe(composedIds.length)
    expect(
      plainIds.map(id => id.replace(/cell-1/g, 'emb').replace(/cell-2/g, 'seg')).sort(),
      'byte-identical to the composed grid once the pane ids are substituted',
    ).toEqual(composedIds.slice().sort())
  })
})
