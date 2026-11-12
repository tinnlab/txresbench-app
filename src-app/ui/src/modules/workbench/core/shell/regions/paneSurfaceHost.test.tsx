// @vitest-environment jsdom
//
// The centre canvas grid's per-plot editing surfaces must render as SEPARATE RIGHT-SIDE
// WORKBENCH PANES, not inside the canvas.
//
// ── What is REAL here and what stands in ────────────────────────────────────────────────
// Real: `paneSurfaceHost` (the containers + the projection), the pane registry, the region
// model, the dock store, and the mounted `RegionShell` — i.e. every line this change added.
// Standing in: `@txresbench/viz`'s `GridDockLayer`, because it is a deck.gl/WebGL component jsdom
// cannot mount. `GridStandIn` below is NOT a convenience mock: it reproduces that layer's
// partition VERBATIM (`const host = container?.(id) ?? null; if (host) portal else internal`,
// `GridDockLayer.tsx:713-752`), because that partition IS the contract under test — the whole
// defect is that the host answered nothing and every surface took the `internal` branch.
// The same flow against the real grid is `tests/e2e/14-workbench/plot-surface-panes.spec.ts`.
//
// ── The invariant most likely to be silently lost ───────────────────────────────────────
// viz INV-8: the container resolver is called ONCE PER OPEN PANE, and N surfaces may be open
// at once, each independently operable. A host that returns one shared node satisfies every
// "it is not in the grid" assertion and still renders two plots' editors on top of each other.
// So the two-plot case is not a variation on the one-plot case here — it is the point, and it
// is asserted on identity (two DIFFERENT containers), on ancestry (each inside ITS OWN pane
// body) and on behaviour (editing one never reaches the other, across a tab switch).

import { Fragment, useEffect, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RegionShell } from './RegionShell'
import { workbenchRegionsStore } from './WorkbenchRegions.store'
import { regionOfKind } from './regionModel'
import {
  installHostedSurfaceCloser,
  peekPaneSurfaceHost,
  resetPaneSurfaceHosts,
  surfacePaneId,
  workbenchPlotSurfaceContainers,
} from './paneSurfaceHost'
import { workbenchDockStore } from '@/modules/workbench/core/shell/dock/WorkbenchDock.store'
import { isPaneFullBleed, isPaneHostedSurface, PANE_KINDS } from '@/modules/workbench/core/shell/dock/paneModel'
import { DEFAULT_PANE_IDS } from '@/modules/workbench/core/shell/dock/defaultLayout'
import { createWorkbenchApi } from '@/modules/workbench/core'
import { makeFakeHost } from '@/modules/workbench/core/host/createHost'
import { WorkbenchProvider } from '@/modules/workbench/core/shell/WorkbenchContext'
// The production registration (the same side-effect import the shell performs at boot). Without
// it these kinds resolve the registry's seeded fallback and the file would measure the fallback.
import '@/modules/workbench/core/shell/dock/panes'

const PROJECT = 'wb-plot-surface-panes'
/** Two plot panes in the canvas grid — the ids the grid resolves its containers with. */
const PLOT_A = 'plot-alpha'
const PLOT_B = 'plot-beta'

/** A stand-in for ONE open surface: a titled frame with an editable field + its own close,
 *  which is the shape both real surfaces have (`PaneEditForm`, `PlotDataTable`). The field is
 *  stateful so "independently operable" can be asserted as behaviour rather than as presence. */
function SurfaceStandIn({ plotId, onClose }: { plotId: string; onClose: () => void }) {
  const [title, setTitle] = useState('')
  return (
    <div data-testid={`surface-${plotId}`}>
      <h2>Edit plot</h2>
      <input
        data-testid={`surface-title-${plotId}`}
        value={title}
        onChange={e => setTitle(e.currentTarget.value)}
      />
      {/* native-control-ok: a stand-in for the surface's OWN close control, which lives in
          libs/viz and is not a kit control. The test is about the host adopting and
          releasing the container, not about what the surface renders inside it. */}
      <button type="button" data-testid={`surface-close-${plotId}`} onClick={onClose}>
        Close
      </button>
    </div>
  )
}

type Resolver = (paneId: string) => HTMLElement | null | undefined

/** The pre-change host: no container for anybody. Models both spellings the grid collapses to
 *  one (`container?.(id) ?? null`) — the prop being absent, and a host that declines. */
const NO_HOST: Resolver = () => null

/** The DOM inside a surface's container, whether or not that container is currently attached.
 *  A region shows one tab's body at a time, so a surface whose pane is not the active tab is
 *  mounted in a DETACHED container — present and operable, but not reachable through `screen`. */
function inHost(plotId: string, selector: string): HTMLElement | null {
  return peekPaneSurfaceHost('edit-plot', plotId)?.querySelector(selector) ?? null
}

/**
 * The grid's dock partition, verbatim: resolve the host per OPEN pane; portal where one comes
 * back, stack the rest in the grid's own internal right panel (`viz-edit-panel`). `resolver`
 * is optional precisely so the pre-change behaviour is reachable as a control.
 */
function GridStandIn({
  open,
  resolver,
  onClose,
}: {
  open: readonly string[]
  resolver: Resolver
  onClose: (plotId: string) => void
}) {
  // The CLOSE half of the same seam, also verbatim (`GridWorkspace.tsx`'s
  // `registerHostedSurfaceClose` effect): the grid hands the host a closer bound to its own open
  // set, and withdraws it on unmount. Without this the host's close has nothing to delegate to —
  // which is exactly the state the pane was in before, and why it had no close at all.
  useEffect(() => {
    installHostedSurfaceCloser((_kind, plotId) => onClose(plotId))
    return () => installHostedSurfaceCloser(null)
  }, [onClose])
  const portaled: Array<{ id: string; host: HTMLElement; el: ReactElement }> = []
  const internal: ReactElement[] = []
  for (const id of open) {
    const el = <SurfaceStandIn key={`edit-${id}`} plotId={id} onClose={() => onClose(id)} />
    const host = resolver?.(id) ?? null
    if (host) portaled.push({ id, host, el })
    else internal.push(el)
  }
  return (
    <div data-testid="grid-root">
      {portaled.map(({ id, host, el }) => (
        <Fragment key={`portal-${id}`}>{createPortal(el, host)}</Fragment>
      ))}
      {internal.length > 0 ? <div data-testid="viz-edit-panel">{internal}</div> : null}
    </div>
  )
}

/** The shell's own default panes (`visualize`/`canvas`) render contributed areas, so the real
 *  `RegionShell` needs the workbench context a real mount gives it. Backend-free fake host. */
function Shell({ children }: { children: ReactElement }) {
  const api = createWorkbenchApi(makeFakeHost({ projectId: PROJECT }), 'txr.workbench.pane-surface-test')
  return (
    <WorkbenchProvider api={api} projectId={PROJECT} viewId={`test-${PROJECT}`} canEdit>
      {children}
    </WorkbenchProvider>
  )
}

/** Mount the canvas + the shell together, as the workbench does. Returns a re-render hook so a
 *  test can CLOSE a surface the way the grid does — by no longer portaling it. */
async function mountWith(open: string[], resolver: Resolver = workbenchPlotSurfaceContainers.editForm) {
  const closed: string[] = []
  // The open set is STATE inside the harness, not a render argument, because a close driven
  // through the shell has to be able to change it — that is the whole outcome under test ("the
  // plot's toggle goes unlit"), and a set the test re-supplies by hand would prove only that the
  // test can remove a surface.
  let setOpen: ((next: readonly string[]) => void) | null = null
  function Harness() {
    const [cur, set] = useState<readonly string[]>(open)
    setOpen = next => set(next)
    return (
      <>
        <GridStandIn
          open={cur}
          resolver={resolver}
          onClose={id => {
            closed.push(id)
            set(prev => prev.filter(x => x !== id))
          }}
        />
        <RegionShell />
      </>
    )
  }
  const view = render(
    <Shell>
      <Harness />
    </Shell>,
  )
  const rerenderWith = async (next: readonly string[]) => {
    // The projection is driven by a MutationObserver, whose callback is a microtask.
    await act(async () => {
      setOpen?.(next)
      await Promise.resolve()
    })
  }
  await act(async () => {
    await Promise.resolve()
  })
  return { ...view, rerenderWith, closed }
}

/** The workbench pane hosting `plotId`'s edit surface, or null. */
const paneIdFor = (plotId: string): string | null => surfacePaneId('edit-plot', plotId)

/** Every OPEN edit-plot pane, by the tab's accessible name — the user-visible handle, and the one
 *  thing present whether or not a pane is the region's active tab. */
const editTabs = () => screen.queryAllByRole('tab', { name: /^Edit plot . / })

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
describe('the two surface pane kinds are declared, homed and framed', () => {
  it('are in the pane vocabulary and home to the RIGHT region', () => {
    expect(PANE_KINDS).toContain('edit-plot')
    expect(PANE_KINDS).toContain('data-table')
    expect(regionOfKind('edit-plot')).toBe('right')
    expect(regionOfKind('data-table')).toBe('right')
  })

  it('declare their inset AT THE REGISTRATION (full-bleed) rather than inside the renderer', () => {
    // The surface arrives with its own padding; a shell inset would frame it twice. Declared
    // per KIND so it cannot drift back into a renderer cancelling the inset from the inside.
    expect(isPaneFullBleed('edit-plot')).toBe(true)
    expect(isPaneFullBleed('data-table')).toBe(true)
    // …and they are hosted surfaces, which is what withholds the shell's header + close.
    expect(isPaneHostedSurface('edit-plot')).toBe(true)
    expect(isPaneHostedSurface('data-table')).toBe(true)
    // A pane the shell DOES own is unaffected — this is the negative control for both flags.
    expect(isPaneFullBleed('launcher')).toBe(false)
    expect(isPaneHostedSurface('launcher')).toBe(false)
  })
})

// ── the reported defect, and the fix ────────────────────────────────────────────────────────
describe('an open plot surface renders in a workbench pane, not inside the grid', () => {
  it('CONTROL: with no host resolver the surface renders INSIDE the grid (the shipped defect)', async () => {
    // The pre-change behaviour, reachable because `GridStandIn` reproduces the real partition.
    // Without this the assertions below could pass against a test that cannot tell the two apart.
    await mountWith([PLOT_A], NO_HOST)
    const grid = screen.getByTestId('grid-root')
    const surface = screen.getByTestId(`surface-${PLOT_A}`)
    expect(grid.contains(surface), 'the control must reproduce the defect').toBe(true)
    expect(screen.getByTestId('viz-edit-panel').contains(surface)).toBe(true)
    expect(paneIdFor(PLOT_A), 'no workbench pane is created on the fallback path').toBeNull()
  })

  it('renders inside its own pane BODY and outside the grid subtree entirely', async () => {
    await mountWith([PLOT_A])

    const paneId = paneIdFor(PLOT_A)
    expect(paneId, 'a workbench pane was opened for the surface').not.toBeNull()

    const grid = screen.getByTestId('grid-root')
    const surface = screen.getByTestId(`surface-${PLOT_A}`)
    const paneBody = screen.getByTestId(`region-pane-body-${paneId as string}`)

    // ANCESTRY, not a class name: the surface hangs off the pane body and off nothing in the grid.
    expect(paneBody.contains(surface)).toBe(true)
    expect(grid.contains(surface)).toBe(false)
    expect(surface.closest('[data-testid="grid-root"]')).toBeNull()
    expect(surface.closest('[data-testid^="region-pane-body-"]')).toBe(paneBody)

    // The grid's internal right panel — the column that used to eat canvas width — is not rendered
    // at all, because nothing was left to stack in it.
    expect(screen.queryByTestId('viz-edit-panel')).toBeNull()

    // The pane sits in the RIGHT region, as a tab.
    expect(screen.getByTestId(`region-tab-${paneId as string}`)).toBeTruthy()
    expect(screen.getByTestId('region-right').contains(paneBody)).toBe(true)
  })

  // ── THE SHELL CLOSE, AND WHAT IT MUST ACTUALLY DO ─────────────────────────────────────────
  //
  // This pane used to carry NO close at all — not on the tab, not in a header — because a close
  // that merely removed the projection would leave the surface open in a detached container:
  // invisible, with its plot's toggle still lit, reachable only by toggling that plot twice. The
  // affordance was withheld rather than shipped broken.
  //
  // It is now shipped WORKING: viz hands the shell a closer (`registerHostedSurfaceClose`), the
  // shell's close delegates to it, the surface closes, its container empties, and the projection
  // is retired by the observer that already watched it. So the assertion is the OUTCOME — the
  // SURFACE is gone — never "the tab disappeared", which the stranding bug also satisfies.
  it('the pane close closes the SURFACE, not just the projection', async () => {
    const view = await mountWith([PLOT_A])
    const paneId = paneIdFor(PLOT_A) as string

    // Both title surfaces carry it: the tab (where the user looked) and the pane header.
    //
    // The tab's X is a POINTER affordance now, `aria-hidden` and unnamed — a `role="tab"` may
    // not own a second interactive node (axe `nested-interactive`; see `RegionTab`), and the
    // keyboard route to the same action is `Delete` on the tab. So what names the pane here is
    // the TAB, and the header's close is the focusable button.
    const tabClose = screen.getByTestId(`region-tab-close-${paneId}`)
    expect(screen.getByTestId(`region-tab-${paneId}`).getAttribute('aria-label')).toBe('Edit plot · plot-alpha')
    expect(screen.getByTestId(`pane-header-close-${paneId}`).getAttribute('aria-label')).toBe(
      'Close Edit plot · plot-alpha',
    )

    await act(async () => {
      fireEvent.click(tabClose)
      await Promise.resolve()
    })

    // THE OUTCOME: the surface itself closed — the grid's open set no longer holds this plot
    // (its toggle is unlit) and the surface's DOM is gone from the document AND from the
    // container, which is what "not stranded" means.
    expect(view.closed, 'the close did not reach the surface').toEqual([PLOT_A])
    await waitFor(() => expect(screen.queryByTestId(`surface-${PLOT_A}`)).toBeNull())
    expect(peekPaneSurfaceHost('edit-plot', PLOT_A)).toBeUndefined()
    // …and the projection followed it: no pane, no tab.
    expect(paneIdFor(PLOT_A)).toBeNull()
    expect(screen.queryByTestId(`region-pane-body-${paneId}`)).toBeNull()
    expect(screen.queryByTestId(`region-tab-${paneId}`)).toBeNull()
  })

  it('re-opening the surface after a shell close gives a FRESH pane', async () => {
    // The other half of "genuinely closed": a close that left the container behind would hand the
    // next open a stale node, and the state the user just dismissed would come back with it.
    const view = await mountWith([PLOT_A])
    const firstPaneId = paneIdFor(PLOT_A) as string
    await act(async () => {
      fireEvent.click(screen.getByTestId(`region-tab-close-${firstPaneId}`))
      await Promise.resolve()
    })
    expect(paneIdFor(PLOT_A)).toBeNull()

    await view.rerenderWith([PLOT_A])
    const secondPaneId = paneIdFor(PLOT_A)
    expect(secondPaneId, 're-opening the surface did not produce a pane').not.toBeNull()
    expect(screen.getByTestId(`surface-${PLOT_A}`)).toBeTruthy()
  })

  it('still offers no pop-out — that one IS withheld, for a different reason', async () => {
    await mountWith([PLOT_A])
    const paneId = paneIdFor(PLOT_A) as string
    // A popped-out pane renders its body into ANOTHER document; this body is a node the grid has
    // already portaled a React tree into, in THIS one. Unchanged by the close work.
    expect(screen.queryByTestId(`region-popout-${paneId}`)).toBeNull()
    // Positive control: a pane the shell fully owns still pops out.
    await act(async () => {
      workbenchRegionsStore.getState().setActive('right', DEFAULT_PANE_IDS.launcher)
      await Promise.resolve()
    })
    expect(screen.getByTestId(`region-popout-${DEFAULT_PANE_IDS.launcher}`)).toBeTruthy()
  })
})

// ── INV-8: N surfaces, N panes, each independently operable ─────────────────────────────────
describe('TWO plots edited at once', () => {
  it('resolves a DISTINCT container per open plot pane (never one shared node)', async () => {
    await mountWith([PLOT_A, PLOT_B])
    const hostA = peekPaneSurfaceHost('edit-plot', PLOT_A)
    const hostB = peekPaneSurfaceHost('edit-plot', PLOT_B)
    expect(hostA).toBeTruthy()
    expect(hostB).toBeTruthy()
    expect(hostA, 'one shared container renders both editors on top of each other').not.toBe(hostB)
    // Each container holds ITS OWN surface, and only that one.
    expect(inHost(PLOT_A, `[data-testid="surface-${PLOT_A}"]`)).toBeTruthy()
    expect(inHost(PLOT_A, `[data-testid="surface-${PLOT_B}"]`)).toBeNull()
    expect(inHost(PLOT_B, `[data-testid="surface-${PLOT_B}"]`)).toBeTruthy()
    expect(inHost(PLOT_B, `[data-testid="surface-${PLOT_A}"]`)).toBeNull()
  })

  it('opens TWO panes — one per plot — and neither is inside the grid', async () => {
    await mountWith([PLOT_A, PLOT_B])
    const paneA = paneIdFor(PLOT_A)
    const paneB = paneIdFor(PLOT_B)
    expect(paneA).not.toBeNull()
    expect(paneB).not.toBeNull()
    expect(paneA).not.toBe(paneB)

    // Exactly two edit-plot panes, no more: a third would mean a leak, one would mean a retarget.
    expect(editTabs()).toHaveLength(2)
    expect(editTabs().map(t => t.getAttribute('aria-label')).sort()).toEqual(
      [`Edit plot \u00b7 ${PLOT_A}`, `Edit plot \u00b7 ${PLOT_B}`].sort(),
    )

    // Both tabs are in the right region; the grid's internal panel is unused; and NEITHER
    // surface hangs anywhere under the grid — asserted on the containers, so it holds for the
    // one whose tab is not currently active as well.
    expect(screen.getByTestId(`region-tab-${paneA as string}`)).toBeTruthy()
    expect(screen.getByTestId(`region-tab-${paneB as string}`)).toBeTruthy()
    const grid = screen.getByTestId('grid-root')
    expect(grid.contains(peekPaneSurfaceHost('edit-plot', PLOT_A) as Node)).toBe(false)
    expect(grid.contains(peekPaneSurfaceHost('edit-plot', PLOT_B) as Node)).toBe(false)
    expect(screen.queryByTestId('viz-edit-panel')).toBeNull()
  })

  it('each is independently operable, and neither loses its state to the other', async () => {
    // HOW THE SHELL SHOWS N PANES IN ONE REGION, stated because it is the property a reader
    // will want: a region is TABBED, so N surfaces are simultaneously OPEN — N panes, N
    // containers, N mounted React trees — and the region shows one of them at a time. The
    // container of a non-active tab is DETACHED, never unmounted, which is what makes the
    // switch below non-destructive. (This is the workbench's model for every side-region pane;
    // the grid's internal panel used to stack them instead, at the cost of canvas width.)
    const view = await mountWith([PLOT_A, PLOT_B])
    const paneA = paneIdFor(PLOT_A) as string
    const paneB = paneIdFor(PLOT_B) as string

    // Operate on B (the tab the second open focused).
    const fieldB = screen.getByTestId(`surface-title-${PLOT_B}`) as HTMLInputElement
    expect(screen.getByTestId(`region-pane-body-${paneB}`).contains(fieldB)).toBe(true)
    fireEvent.change(fieldB, { target: { value: 'beta title' } })
    expect(fieldB.value).toBe('beta title')
    // A is untouched — the two surfaces do not share a container, so they cannot share a value.
    expect((inHost(PLOT_A, 'input') as HTMLInputElement).value).toBe('')

    // Select A's tab and operate on IT.
    await act(async () => {
      workbenchRegionsStore.getState().setActive('right', paneA)
      await Promise.resolve()
    })
    const fieldA = screen.getByTestId(`surface-title-${PLOT_A}`) as HTMLInputElement
    expect(screen.getByTestId(`region-pane-body-${paneA}`).contains(fieldA)).toBe(true)
    fireEvent.change(fieldA, { target: { value: 'alpha title' } })
    expect(fieldA.value).toBe('alpha title')
    // B kept its edit while its pane was not the active tab.
    expect((inHost(PLOT_B, 'input') as HTMLInputElement).value).toBe('beta title')

    // Switch back: B's surface returns intact, and A's is still live in its own container.
    await act(async () => {
      workbenchRegionsStore.getState().setActive('right', paneB)
      await Promise.resolve()
    })
    expect((screen.getByTestId(`surface-title-${PLOT_B}`) as HTMLInputElement).value).toBe('beta title')
    expect(screen.getByTestId(`region-pane-body-${paneB}`).contains(screen.getByTestId(`surface-${PLOT_B}`))).toBe(true)
    expect((inHost(PLOT_A, 'input') as HTMLInputElement).value).toBe('alpha title')
    view.unmount()
  })

  it('a tab switch DETACHES the other surface, it never unmounts it (state would be lost)', async () => {
    // The failure this pins: adopting the container by CREATING one per mount (instead of
    // moving the one that exists) would remount the surface on every tab switch, and a
    // half-typed plot title would vanish every time the user looked at the other plot.
    await mountWith([PLOT_A, PLOT_B])
    const hostA = peekPaneSurfaceHost('edit-plot', PLOT_A) as HTMLElement
    fireEvent.change(inHost(PLOT_A, 'input') as HTMLInputElement, { target: { value: 'kept' } })

    await act(async () => {
      workbenchRegionsStore.getState().setActive('right', paneIdFor(PLOT_B) as string)
      await Promise.resolve()
    })
    // Same node object, still holding the same mounted tree with the same value.
    expect(peekPaneSurfaceHost('edit-plot', PLOT_A)).toBe(hostA)
    expect((inHost(PLOT_A, 'input') as HTMLInputElement).value).toBe('kept')
  })

  it('closing ONE surface removes exactly that pane and leaves the other open', async () => {
    const view = await mountWith([PLOT_A, PLOT_B])
    const paneA = paneIdFor(PLOT_A) as string
    const paneB = paneIdFor(PLOT_B) as string

    // The grid closes a surface by no longer portaling it — the only close signal a host gets.
    await view.rerenderWith([PLOT_A])
    await waitFor(() => expect(paneIdFor(PLOT_B)).toBeNull())

    expect(paneIdFor(PLOT_A), 'the surviving pane is unchanged').toBe(paneA)
    expect(editTabs()).toHaveLength(1)
    expect(screen.queryByTestId(`region-tab-${paneB}`)).toBeNull()
    expect(screen.getByTestId(`region-tab-${paneA}`)).toBeTruthy()
    expect(screen.getByTestId(`surface-${PLOT_A}`)).toBeTruthy()
    expect(peekPaneSurfaceHost('edit-plot', PLOT_B), 'the retired container is released').toBeUndefined()
    expect(peekPaneSurfaceHost('edit-plot', PLOT_A)).toBeTruthy()
  })

  it('closing the LAST surface leaves no orphan tab behind', async () => {
    const view = await mountWith([PLOT_A])
    expect(paneIdFor(PLOT_A)).not.toBeNull()
    // The empty-set transition: the grid renders and asks about NOTHING. A host that inferred
    // its panes from the resolver CALL would never learn this happened.
    await view.rerenderWith([])
    await waitFor(() => expect(paneIdFor(PLOT_A)).toBeNull())
    expect(editTabs(), 'no orphan tab survives the last surface').toHaveLength(0)
  })
})

// ── the two kinds do not collide ────────────────────────────────────────────────────────────
describe('the edit form and the plotting-data table are separate panes', () => {
  it('the same plot can have both open, in two panes with two containers', async () => {
    render(
      <Shell>
        <>
          <GridStandIn open={[PLOT_A]} resolver={workbenchPlotSurfaceContainers.editForm} onClose={() => {}} />
          <GridStandIn open={[PLOT_A]} resolver={workbenchPlotSurfaceContainers.dataTable} onClose={() => {}} />
          <RegionShell />
        </>
      </Shell>,
    )
    await act(async () => {
      await Promise.resolve()
    })
    const editPane = surfacePaneId('edit-plot', PLOT_A)
    const tablePane = surfacePaneId('data-table', PLOT_A)
    expect(editPane, 'the edit surface has its own pane').toBeTruthy()
    expect(tablePane, 'the table surface has its own pane').toBeTruthy()
    expect(editPane).not.toBe(tablePane)
    expect(screen.getByRole('tab', { name: `Edit plot \u00b7 ${PLOT_A}` })).toBeTruthy()
    expect(screen.getByRole('tab', { name: `Plot data \u00b7 ${PLOT_A}` })).toBeTruthy()
    expect(peekPaneSurfaceHost('edit-plot', PLOT_A)).not.toBe(peekPaneSurfaceHost('data-table', PLOT_A))
  })
})
