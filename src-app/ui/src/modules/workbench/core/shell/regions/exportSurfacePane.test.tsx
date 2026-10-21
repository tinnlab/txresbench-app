// @vitest-environment jsdom
//
// The centre canvas grid's EXPORT surface must render as a RIGHT-SIDE WORKBENCH PANE, not
// inside the canvas — for the WHOLE-GRID export (the reported defect) and for a single plot's
// export alike.
//
// ── What is REAL here and what stands in ────────────────────────────────────────────────
// Real: `paneSurfaceHost` (the containers + the projection), the pane registry, the region
// model, the dock store, and the mounted `RegionShell`. Standing in: `@ziee/viz`'s
// `GridDockLayer`, because it is a deck.gl/WebGL component jsdom cannot mount. `GridStandIn`
// below is NOT a convenience mock — it reproduces that layer's EXPORT partition step for step
// (`GridDockLayer.tsx:725-727, 997`): build the dialog for the open target; ask the host for a
// container, resolved with that target's grid pane id (or the reserved whole-grid sentinel);
// PORTAL into it when one comes back, and otherwise push the dialog into the grid's own
// internal right panel and render it there.
//
// That partition IS the contract under test: the whole defect is that the host answered
// nothing for the export dialog, so it took the `internal` branch and opened INSIDE the
// canvas. The same flow against the real grid is
// `tests/e2e/14-workbench/export-surface-pane.spec.ts`.
//
// ── What GRID SCOPE means for container identity (the decision this file pins) ──────────
// Unlike `edit-plot`/`data-table`, the export surface is not always plot-scoped: viz owns ONE
// export target, which is either a grid pane or the WHOLE GRID, and only ONE export can be
// open at a time.
//
// The identity rule is therefore unchanged and applied verbatim: ONE CONTAINER PER SUBJECT,
// where the whole grid's subject id is viz's reserved `'__grid__'` sentinel — an id no plot
// pane can carry. Because viz permits a single open export, that yields AT MOST ONE export
// pane at any moment; retargeting retires the old subject's container (and its pane) and
// mints the new one, so the pane always describes the thing actually being exported. The
// alternative — one shared container for every target — was rejected here: it makes the pane
// ref ambiguous, and re-opening export while its tab is backgrounded would never re-reveal
// the pane (the container never empties, so no transition is observed).

import { useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RegionShell } from './RegionShell'
import { workbenchRegionsStore } from './WorkbenchRegions.store'
import { regionOfKind } from './regionModel'
import {
  GRID_EXPORT_SURFACE_ID,
  peekPaneSurfaceHost,
  resetPaneSurfaceHosts,
  surfacePaneId,
  workbenchPlotSurfaceContainers,
} from './paneSurfaceHost'
import { workbenchDockStore } from '@/modules/workbench/core/shell/dock/WorkbenchDock.store'
import { DEFAULT_PANE_IDS } from '@/modules/workbench/core/shell/dock/defaultLayout'
import { isPaneFullBleed, isPaneHostedSurface, PANE_KINDS, paneTitle } from '@/modules/workbench/core/shell/dock/paneModel'
import { createWorkbenchApi } from '@/modules/workbench/core'
import { makeFakeHost } from '@/modules/workbench/core/host/createHost'
import { WorkbenchProvider } from '@/modules/workbench/core/shell/WorkbenchContext'
// The production registration (the same side-effect import the shell performs at boot). Without
// it these kinds resolve the registry's seeded fallback and the file would measure the fallback.
import '@/modules/workbench/core/shell/dock/panes'

const PROJECT = 'wb-export-surface-pane'
/** A plot pane in the canvas grid — the id viz resolves a per-plot export container with. */
const PLOT_A = 'plot-alpha'

/** viz's export target: a grid pane id, or `null` for the WHOLE GRID. */
type ExportTarget = { plotId: string | null } | null

/** A stand-in for the open export dialog: a titled frame with an editable filename field and
 *  its own close — the shape `ExportDialog` has. The field is stateful so "the surface keeps
 *  its state across a tab switch" can be asserted as behaviour rather than as presence. */
function ExportStandIn({ plotId, onClose }: { plotId: string | null; onClose: () => void }) {
  const [filename, setFilename] = useState('')
  const id = plotId ?? 'grid'
  return (
    <div data-testid={`viz-export-dialog-${id}`}>
      <h2>Export</h2>
      <p data-testid={`export-target-title-${id}`}>{plotId ?? 'Whole grid'}</p>
      <input
        data-testid={`export-filename-${id}`}
        value={filename}
        onChange={e => setFilename(e.currentTarget.value)}
      />
      {/* native-control-ok: a stand-in for the surface's OWN close control, which lives in
          libs/viz and is not a kit control. The test is about the host adopting and
          releasing the container, not about what the surface renders inside it. */}
      <button type="button" data-testid={`viz-export-close-${id}`} onClick={onClose}>
        Close
      </button>
    </div>
  )
}

type Resolver = (paneId: string) => HTMLElement | null | undefined

/** The pre-change host: no container for anybody. Models both spellings the grid collapses to
 *  one (`container?.(id) ?? null`) — the prop being absent, and a host that declines. */
const NO_HOST: Resolver = () => null

/**
 * viz's export dock partition, verbatim (see the header). `resolver` is optional precisely so
 * the pre-change behaviour is reachable as a live control.
 */
function GridStandIn({
  target,
  resolver,
  onClose,
}: {
  target: ExportTarget
  resolver: Resolver
  onClose: () => void
}) {
  const el = target ? <ExportStandIn plotId={target.plotId} onClose={onClose} /> : null
  const host = target ? (resolver?.(target.plotId ?? GRID_EXPORT_SURFACE_ID) ?? null) : null
  const internal: ReactElement[] = []
  if (el && !host) internal.push(el)
  return (
    <div data-testid="grid-root">
      {el && host ? createPortal(el, host) : null}
      {internal.length > 0 ? <div data-testid="viz-edit-panel">{internal}</div> : null}
    </div>
  )
}

/** The shell's own default panes render contributed areas, so the real `RegionShell` needs the
 *  workbench context a real mount gives it. Backend-free fake host. */
function Shell({ children }: { children: ReactElement }) {
  const api = createWorkbenchApi(makeFakeHost({ projectId: PROJECT }), 'cyto.workbench.export-pane-test')
  return (
    <WorkbenchProvider api={api} projectId={PROJECT} viewId={`test-${PROJECT}`} canEdit>
      {children}
    </WorkbenchProvider>
  )
}

/** Mount the canvas + the shell together, as the workbench does. Returns a re-render hook so a
 *  test can RETARGET or CLOSE the export the way the grid does — by changing `exportTarget`. */
async function mountWith(target: ExportTarget, resolver: Resolver = workbenchPlotSurfaceContainers.exportDialog) {
  const tree = (next: ExportTarget) => (
    <Shell>
      <>
        <GridStandIn target={next} resolver={resolver} onClose={() => {}} />
        <RegionShell />
      </>
    </Shell>
  )
  const view = render(tree(target))
  const rerenderWith = async (next: ExportTarget) => {
    view.rerender(tree(next))
    // The projection is driven by a MutationObserver, whose callback is a microtask.
    await act(async () => {
      await Promise.resolve()
    })
  }
  await act(async () => {
    await Promise.resolve()
  })
  return { ...view, rerenderWith }
}

/** The workbench pane hosting the export of `subject`, or null. */
const paneIdFor = (subject: string): string | null => surfacePaneId('export', subject)

/** Every OPEN export pane, by the tab's accessible name. */
const exportTabs = () => screen.queryAllByRole('tab', { name: /^Export\b/ })

beforeEach(() => {
  cleanup()
  window.localStorage.clear()
  window.sessionStorage.clear()
  resetPaneSurfaceHosts()
  workbenchRegionsStore.getState().reset()
  workbenchDockStore.getState().reset()
  workbenchDockStore.getState().ensureProject(PROJECT)
})

afterEach(() => {
  cleanup()
  resetPaneSurfaceHosts()
})

// ── the vocabulary + its declarations ───────────────────────────────────────────────────────
describe('the export surface pane kind is declared, homed and framed', () => {
  it('is in the pane vocabulary and homes to the RIGHT region', () => {
    expect(PANE_KINDS).toContain('export')
    expect(regionOfKind('export')).toBe('right')
  })

  it('declares the SAME chrome policy as the two shipped hosted-surface kinds', () => {
    // Asserted as SAMENESS rather than as literal `true`: the export surface is one more
    // canvas-hosted surface, so whatever inset + chrome policy those kinds carry, it carries
    // too. A divergence here is the drift this states — not a particular value.
    expect(isPaneFullBleed('export')).toBe(isPaneFullBleed('edit-plot'))
    expect(isPaneHostedSurface('export')).toBe(isPaneHostedSurface('edit-plot'))
    // Negative control: a pane the shell fully owns is unaffected by either flag.
    expect(isPaneFullBleed('launcher')).toBe(false)
    expect(isPaneHostedSurface('launcher')).toBe(false)
  })

  it('titles the WHOLE-GRID export by its subject, never by the raw sentinel', () => {
    // The sentinel is an IDENTITY (it must be the pane ref — see the header), so the tab label
    // is the one place it must not leak: "Export · __grid__" is an internal token on a tab.
    expect(paneTitle({ id: 'p', kind: 'export', ref: GRID_EXPORT_SURFACE_ID })).toBe('Export · Whole grid')
    // A per-plot export still reads as every other ref-bearing pane does.
    expect(paneTitle({ id: 'p', kind: 'export', ref: PLOT_A })).toBe(`Export · ${PLOT_A}`)
  })

  it('is never PERSISTED: the pane is a projection, and nothing re-opens the surface on reload', async () => {
    // A persisted export pane would come back after a reload as a permanently empty tab that the
    // shell offers no way to close — the surface behind it is gone and only the surface can close
    // it. Asserted on the STORED BYTES rather than on a kind list, so it holds however the
    // persistence layer chooses to prune.
    await mountWith({ plotId: null })
    const paneId = paneIdFor(GRID_EXPORT_SURFACE_ID) as string
    expect(paneId).toBeTruthy()
    const stored = Object.keys(window.localStorage)
      .map(k => window.localStorage.getItem(k) ?? '')
      .join('\n')
    expect(stored, 'a durable pane IS written — the positive control for this scan').toContain(
      DEFAULT_PANE_IDS.launcher,
    )
    expect(stored, 'the export pane must not survive a reload').not.toContain(paneId)
  })
})

// ── the reported defect, and the fix ────────────────────────────────────────────────────────
describe('the WHOLE-GRID export renders in a workbench pane, not inside the grid', () => {
  it('CONTROL: with no host resolver it renders INSIDE the grid (the shipped defect)', async () => {
    // The pre-change behaviour, reachable because `GridStandIn` reproduces the real partition.
    // Without this the assertions below could pass against a test that cannot tell the two apart.
    await mountWith({ plotId: null }, NO_HOST)
    const grid = screen.getByTestId('grid-root')
    const dialog = screen.getByTestId('viz-export-dialog-grid')
    expect(grid.contains(dialog), 'the control must reproduce the defect').toBe(true)
    expect(screen.getByTestId('viz-edit-panel').contains(dialog)).toBe(true)
    expect(paneIdFor(GRID_EXPORT_SURFACE_ID), 'no workbench pane is created on the fallback path').toBeNull()
  })

  it('renders inside its own pane BODY and outside the grid subtree entirely', async () => {
    await mountWith({ plotId: null })

    const paneId = paneIdFor(GRID_EXPORT_SURFACE_ID)
    expect(paneId, 'a workbench pane was opened for the whole-grid export').not.toBeNull()

    const grid = screen.getByTestId('grid-root')
    const dialog = screen.getByTestId('viz-export-dialog-grid')
    const paneBody = screen.getByTestId(`region-pane-body-${paneId as string}`)

    // ANCESTRY, not a class name: the dialog hangs off the pane body and off nothing in the grid.
    expect(paneBody.contains(dialog)).toBe(true)
    expect(grid.contains(dialog)).toBe(false)
    expect(dialog.closest('[data-testid="grid-root"]')).toBeNull()
    expect(dialog.closest('[data-testid^="region-pane-body-"]')).toBe(paneBody)

    // The grid's internal right panel — the column that used to eat canvas width — is not
    // rendered at all, because nothing was left to stack in it.
    expect(screen.queryByTestId('viz-edit-panel')).toBeNull()

    // The pane sits in the RIGHT region, as a tab named for its subject.
    expect(screen.getByTestId(`region-tab-${paneId as string}`)).toBeTruthy()
    expect(screen.getByTestId('region-right').contains(paneBody)).toBe(true)
    expect(screen.getByRole('tab', { name: 'Export · Whole grid' })).toBeTruthy()
  })
})

// ── grid scope vs plot scope: the per-plot path must not be collateral damage ────────────────
describe('a SINGLE PLOT export is the same mechanism with a different subject', () => {
  it('renders in its own pane, keyed by the plot it exports', async () => {
    await mountWith({ plotId: PLOT_A })
    const paneId = paneIdFor(PLOT_A)
    expect(paneId, 'the per-plot export opened its own pane').not.toBeNull()
    expect(paneIdFor(GRID_EXPORT_SURFACE_ID), 'and it is NOT the whole-grid subject').toBeNull()

    const dialog = screen.getByTestId(`viz-export-dialog-${PLOT_A}`)
    expect(screen.getByTestId(`region-pane-body-${paneId as string}`).contains(dialog)).toBe(true)
    expect(screen.getByTestId('grid-root').contains(dialog)).toBe(false)
    expect(screen.queryByTestId('viz-edit-panel')).toBeNull()
    expect(screen.getByRole('tab', { name: `Export · ${PLOT_A}` })).toBeTruthy()
  })

  it('resolves a DISTINCT container per subject, and per KIND for the same subject', async () => {
    // The grid subject and a plot subject can never share a container — that is what makes the
    // pane describe the thing actually being exported.
    const view = await mountWith({ plotId: PLOT_A })
    const hostPlot = peekPaneSurfaceHost('export', PLOT_A)
    expect(hostPlot).toBeTruthy()
    await view.rerenderWith({ plotId: null })
    const hostGrid = peekPaneSurfaceHost('export', GRID_EXPORT_SURFACE_ID)
    expect(hostGrid).toBeTruthy()
    expect(hostGrid).not.toBe(hostPlot)

    // …and the export of a plot is not the edit form of that plot (kind is part of the key).
    render(
      <Shell>
        <>
          <GridStandIn target={{ plotId: PLOT_A }} resolver={workbenchPlotSurfaceContainers.exportDialog} onClose={() => {}} />
          <RegionShell />
        </>
      </Shell>,
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(workbenchPlotSurfaceContainers.editForm(PLOT_A)).not.toBe(
      workbenchPlotSurfaceContainers.exportDialog(PLOT_A),
    )
  })
})

// ── ONE export at a time: retarget, and close ───────────────────────────────────────────────
describe('the export pane follows viz’s single open target', () => {
  it('retargeting from a plot to the whole grid moves the pane rather than accumulating panes', async () => {
    const view = await mountWith({ plotId: PLOT_A })
    const plotPane = paneIdFor(PLOT_A) as string
    expect(exportTabs()).toHaveLength(1)

    await view.rerenderWith({ plotId: null })
    await waitFor(() => expect(paneIdFor(GRID_EXPORT_SURFACE_ID)).not.toBeNull())

    expect(paneIdFor(PLOT_A), 'the previous subject’s pane is retired with its container').toBeNull()
    expect(peekPaneSurfaceHost('export', PLOT_A)).toBeUndefined()
    expect(screen.queryByTestId(`region-tab-${plotPane}`)).toBeNull()
    // Exactly one export tab, and it names the new subject.
    expect(exportTabs()).toHaveLength(1)
    expect(screen.getByRole('tab', { name: 'Export · Whole grid' })).toBeTruthy()
    expect(screen.queryByTestId('viz-edit-panel')).toBeNull()
  })

  it('closing the export leaves no orphan tab behind', async () => {
    const view = await mountWith({ plotId: null })
    expect(paneIdFor(GRID_EXPORT_SURFACE_ID)).not.toBeNull()
    // The grid closes the export by no longer portaling it — the only close signal a host gets,
    // and an empty-set transition that produces no resolver call at all.
    await view.rerenderWith(null)
    await waitFor(() => expect(paneIdFor(GRID_EXPORT_SURFACE_ID)).toBeNull())
    expect(exportTabs(), 'no orphan tab survives the closed export').toHaveLength(0)
    expect(peekPaneSurfaceHost('export', GRID_EXPORT_SURFACE_ID)).toBeUndefined()
  })

  it('a tab switch DETACHES the surface, it never unmounts it (a typed filename would be lost)', async () => {
    await mountWith({ plotId: null })
    const host = peekPaneSurfaceHost('export', GRID_EXPORT_SURFACE_ID) as HTMLElement
    const field = screen.getByTestId('export-filename-grid') as HTMLInputElement
    fireEvent.change(field, { target: { value: 'figure-1' } })

    // Select ANOTHER right-region pane, then come back.
    await act(async () => {
      workbenchRegionsStore.getState().setActive('right', DEFAULT_PANE_IDS.launcher)
      await Promise.resolve()
    })
    // Same node object, still holding the same mounted tree with the same value.
    expect(peekPaneSurfaceHost('export', GRID_EXPORT_SURFACE_ID)).toBe(host)
    expect((host.querySelector('input') as HTMLInputElement).value).toBe('figure-1')

    await act(async () => {
      workbenchRegionsStore.getState().setActive('right', paneIdFor(GRID_EXPORT_SURFACE_ID) as string)
      await Promise.resolve()
    })
    expect((screen.getByTestId('export-filename-grid') as HTMLInputElement).value).toBe('figure-1')
  })
})
