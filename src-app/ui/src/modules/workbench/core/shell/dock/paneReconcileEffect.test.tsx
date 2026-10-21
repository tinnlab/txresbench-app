// @vitest-environment jsdom
//
// The EFFECT, not just the pure plan.
//
// `paneReconcile.test.ts` covers `reconcileViews`/`availableViews` in isolation and both were
// CORRECT while the shipped dock showed FOUR panes for TWO views: the persisted layout carried
// `pane-1..pane-4` with only two distinct `ref`s (`view.alpha::region::right`,
// `view.beta::region::right`), and only the second pair carried a `regionOverride` — so the
// first pair fell into the bottom region and read as a duplicate "view" tab: same title, no way
// to tell them apart. Neither side's test could see it. The bug lives in the effect that JOINS
// them, and nothing drove that.
//
// The mechanism is a read-modify-write against a stale snapshot. `toAdd` was diffed against the
// `cells` captured in the render closure, and `React.StrictMode` (on in `main.tsx`) double-invokes
// an effect with the SAME closure — so both invocations saw zero existing view panes and both
// called `addPane`.
//
// (Those `::region::` ids are HISTORY — INV-3 collapsed a view to one contribution under
// its bare spec id. The defect is not: the read-modify-write below is orthogonal to how
// many contributions a spec produces, and StrictMode still double-invokes the effect. What
// changed is only that a double-add now yields two tabs instead of four.)
//
// Pinning `useStore` to a frozen snapshot is what makes that deterministic here. A plain
// `renderHook` + StrictMode does NOT reproduce it: the store subscription re-renders between the
// two invocations and hands the second one a FRESH `cells` — the very thing the real app does not do.
// A test that cannot fail is the failure mode this file exists to prevent, so the snapshot is
// held stale on purpose.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StrictMode } from 'react'
import { renderHook } from '@testing-library/react'
import type { Contributions, DatatypeLattice, ViewContribution, WhenContext } from '@/modules/workbench/core'

// The stale snapshot: whatever the store does, the render closure keeps seeing this.
// Only `useStore` is replaced — the rest of zustand (`createStore`, …) stays real, or every
// other store in the import graph breaks and the suite fails to collect instead of running.
vi.mock('zustand', async importOriginal => ({
  ...(await importOriginal<typeof import('zustand')>()),
  useStore: () => ({}),
}))

const { useViewReconciliation } = await import('./paneReconcile')
const { workbenchDockStore } = await import('./WorkbenchDock.store')

const CTX: WhenContext = { producedTypeIds: [] }
const LATTICE = { isA: () => true, matches: () => true, get: () => undefined } as unknown as DatatypeLattice

function view(id: string): ViewContribution {
  return { id, extensionId: 'test', apiVersion: '1.0.0', title: id, area: 'right', render: { component: `ui/${id}` } }
}
function fakeRegistry(views: ViewContribution[]): Contributions {
  return { views: { all: () => views } } as unknown as Contributions
}
function viewPanes() {
  return Object.values(workbenchDockStore.getState().cells).filter(c => c.kind === 'view')
}

describe('useViewReconciliation mounts each available view EXACTLY once', () => {
  beforeEach(() => {
    workbenchDockStore.getState().ensureProject(`p-${Math.random().toString(36).slice(2)}`)
  })

  it('does not double-add when the effect re-runs against a stale `cells` snapshot', () => {
    const registry = fakeRegistry([view('a.view'), view('b.view')])

    const { rerender } = renderHook(() => useViewReconciliation(registry, CTX, LATTICE), {
      wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
    })
    rerender()
    rerender()

    const byRef = new Map<string, number>()
    for (const c of viewPanes()) byRef.set(c.ref!, (byRef.get(c.ref!) ?? 0) + 1)
    const duplicated = [...byRef.entries()].filter(([, n]) => n > 1)
    expect(duplicated, `each view id owns exactly ONE pane; duplicated: ${JSON.stringify(duplicated)}`).toEqual([])
    expect(viewPanes()).toHaveLength(2)
  })

  it('mounts a single available view once (positive control — the diff still ADDS)', () => {
    const registry = fakeRegistry([view('c.view')])
    renderHook(() => useViewReconciliation(registry, CTX, LATTICE), {
      wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
    })
    expect(viewPanes()).toHaveLength(1)
    expect(viewPanes()[0].ref).toBe('c.view')
  })
})

// The SECOND half of the same defect. Removing the duplicate exposed it: the surviving pair
// sat in the BOTTOM strip while both views declare `right`. Child effects run before parent
// effects, so this hook docks its panes and then `WorkbenchShell`'s `ensureProject` resets the
// regions slice out from under them. (It was masked before: the double-add meant a SECOND
// moveToRegion ran after the reset, so one pair happened to land correctly and the other did
// not — which is exactly why the two panes appeared in different regions.)
describe('a mounted view pane ends up in the region its view DECLARED', () => {
  it('re-asserts the declared region after the regions slice is reset underneath it', async () => {
    const { workbenchRegionsStore } = await import('@/modules/workbench/core/shell/regions/WorkbenchRegions.store')
    const registry = fakeRegistry([view('d.view')])

    const { rerender } = renderHook(() => useViewReconciliation(registry, CTX, LATTICE), {
      wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
    })
    const paneId = viewPanes().find(c => c.ref === 'd.view')!.id
    expect(workbenchRegionsStore.getState().regionOverride[paneId]).toBe('right')

    // The shell binds a DIFFERENT project — `ensureProject` resets, dropping the overrides.
    workbenchRegionsStore.getState().ensureProject('some-other-project')
    expect(workbenchRegionsStore.getState().regionOverride[paneId]).toBeUndefined()

    // The next pass must put it back rather than leaving it wherever the default lands.
    rerender()
    expect(workbenchRegionsStore.getState().regionOverride[paneId]).toBe('right')
  })
})

// ── the AUTO-MOUNT GATE, at the EFFECT (where a user would see it) ───────────────────────────
//
// The gate is UNCONDITIONAL now — there is no flag to pass, and these are assertions about what
// the shipped product does. Every other describe in this file runs with an all-matching lattice,
// so none of them can tell a gate that works from one that is vacuous; this one uses a
// DISCRIMINATING lattice and an analysis whose declared input type the project has not produced,
// which is the only shape that can.
describe('the auto-mount gate — an analysis whose input type is ABSENT', () => {
  // Discriminating lattice + a registry that also answers `analyses` (the gate's lookup).
  const STRICT = {
    isA: (id: string, target: string) => id === target,
    matches: (id: string, sel: { type_id?: string; subtypes_of?: string }) =>
      id === sel.type_id || id === sel.subtypes_of,
    get: () => undefined,
  } as unknown as DatatypeLattice

  function gatedRegistry(): Contributions {
    const analyses = new Map([
      ['e.gated', { id: 'e.gated', extensionId: 't', apiVersion: '1.0.0', title: 'e.gated', appliesTo: [{ slot: 'x', subtypes_of: 'test/thing' }] }],
    ])
    return {
      views: { all: () => [view('e.gated')] },
      analyses: { get: (id: string) => analyses.get(id) },
    } as unknown as Contributions
  }

  beforeEach(() => {
    workbenchDockStore.getState().ensureProject(`p-${Math.random().toString(36).slice(2)}`)
  })

  it('does NOT auto-mount on an empty project', () => {
    renderHook(() => useViewReconciliation(gatedRegistry(), { producedTypeIds: [] }, STRICT), {
      wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
    })
    expect(viewPanes()).toHaveLength(0)
  })

  it('DOES auto-mount once the project has produced the type (positive control)', () => {
    renderHook(
      () => useViewReconciliation(gatedRegistry(), { producedTypeIds: ['test/thing'] }, STRICT),
      { wrapper: ({ children }) => <StrictMode>{children}</StrictMode> },
    )
    expect(viewPanes().map(c => c.ref)).toEqual(['e.gated'])
  })

  it('a pane the USER opened for a gated view survives the reconcile', () => {
    // The launcher's ⚙ "open the analysis form" stays enabled for an availability-gated
    // analysis and adds this pane. A gate that also CLOSED it would take the affordance away
    // rather than only the unasked-for mount.
    const paneId = workbenchDockStore.getState().addPane('view', 'e.gated')
    expect(paneId).toBeTruthy()
    renderHook(() => useViewReconciliation(gatedRegistry(), { producedTypeIds: [] }, STRICT), {
      wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
    })
    expect(viewPanes().map(c => c.ref)).toEqual(['e.gated'])
  })

  it('a view no analysis owns still mounts (fail-open — nothing to gate on)', () => {
    const registry = fakeRegistry([view('shell.orphan')])
    renderHook(() => useViewReconciliation(registry, { producedTypeIds: [] }, STRICT), {
      wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
    })
    expect(viewPanes().map(c => c.ref)).toEqual(['shell.orphan'])
  })

})

// ── THE AFFORDANCE THE GATE PROMISED TO LEAVE INTACT ─────────────────────────────────────────
//
// The launcher's ⚙ / the run pane's signpost stay enabled for a gated analysis, and clicking one
// must put that analysis IN FRONT OF THE USER. "The pane is kept" (asserted above) is only half:
// a pane that exists as an UNSELECTED tab in a region nobody is looking at is not a revealed
// surface.
//
// Why this only became reachable with the gate. `analysis.launch` (`WorkbenchSection.tsx`) focuses
// the pane's EFFECTIVE region, `regionOverride[id] ?? regionOfKind('view')`, and a brand-new view
// pane has no override yet — so that resolves to the `view` kind's FALLBACK, `bottom`. Before the
// gate every declarative pane was already mounted WITH its declared-region override, so a launch
// never took that branch. Now a gated analysis' pane is added BY the launch, and the reconcile's
// re-assertion relocated it to its declared region without the focus the launch had just given it.
// Measured end-to-end before the fix: `run-config.spec.ts` polled the revealed tab 43 times over
// 20 s and read `aria-selected="false"` every time.
//
// ── ITS OWN DESCRIBE, WITH BOTH STORES RESET, AND THAT IS NOT TIDINESS ───────────────────────
//
// Written first inside the describe above, this test PASSED against the unfixed code. Both stores
// are module singletons, this file registers no RTL cleanup, and `ensureProject` restarts the dock's
// pane-id counter — so `pane-1` recurs in every test, and an earlier test's `moveToRegion('right',
// 'pane-1')` had already left `active.right === 'pane-1'`. The assertion matched a value the
// subject never produced. Resetting the REGIONS store too is what makes the reading the test's own.
describe('a launched view pane keeps the focus its affordance gave it', () => {
  const STRICT = {
    isA: (id: string, target: string) => id === target,
    matches: (id: string, sel: { type_id?: string; subtypes_of?: string }) =>
      id === sel.type_id || id === sel.subtypes_of,
    get: () => undefined,
  } as unknown as DatatypeLattice

  function gatedRegistry(): Contributions {
    const analyses = new Map([
      ['e.gated', { id: 'e.gated', extensionId: 't', apiVersion: '1.0.0', title: 'e.gated', appliesTo: [{ slot: 'x', subtypes_of: 'test/thing' }] }],
    ])
    return {
      views: { all: () => [view('e.gated')] },
      analyses: { get: (id: string) => analyses.get(id) },
    } as unknown as Contributions
  }

  let regions: typeof import('@/modules/workbench/core/shell/regions/WorkbenchRegions.store').workbenchRegionsStore
  beforeEach(async () => {
    const key = `p-${Math.random().toString(36).slice(2)}`
    workbenchDockStore.getState().ensureProject(key)
    regions = (await import('@/modules/workbench/core/shell/regions/WorkbenchRegions.store')).workbenchRegionsStore
    regions.getState().ensureProject(key) // resets active / regionOverride — see the note above
  })

  it('a pane another affordance ADDED and focused keeps that focus when the reconcile relocates it', () => {
    // Exactly what `analysis.launch` does for a not-yet-mounted view: add it, then focus its
    // effective region — which, with no override yet, is the `view` kind's fallback `bottom`.
    const paneId = workbenchDockStore.getState().addPane('view', 'e.gated')
    regions.getState().setActive('bottom', paneId)
    expect(regions.getState().active.right, 'precondition: the declared region is NOT already showing it').not.toBe(paneId)

    renderHook(() => useViewReconciliation(gatedRegistry(), { producedTypeIds: [] }, STRICT), {
      wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
    })

    expect(regions.getState().regionOverride[paneId], 'relocated to its declared region').toBe('right')
    expect(
      regions.getState().active.right,
      'and it is the ACTIVE tab THERE — the reveal must survive the relocation, not be undone by it',
    ).toBe(paneId)
  })

  // The control, and the reason the re-assertion must NOT focus unconditionally: opening any
  // unrelated pane re-runs this effect over every view pane, and a walk that focused them all
  // would leave the LAST one holding the region's active slot — taking it from whatever the user
  // had selected. Focus is carried only when the pane is genuinely BEING RELOCATED.
  it('…but the steady-state re-assertion still does NOT steal focus', () => {
    const { rerender } = renderHook(
      () => useViewReconciliation(gatedRegistry(), { producedTypeIds: ['test/thing'] }, STRICT),
      { wrapper: ({ children }) => <StrictMode>{children}</StrictMode> },
    )
    const paneId = viewPanes().find(c => c.ref === 'e.gated')!.id
    expect(regions.getState().regionOverride[paneId]).toBe('right')
    // The user selects something else in that region; then anything at all re-runs the effect.
    regions.getState().setActive('right', 'p-launcher')
    rerender()
    expect(regions.getState().active.right, 'the user’s selection survives an unrelated re-run').toBe('p-launcher')
    expect(regions.getState().regionOverride[paneId]).toBe('right')
  })

  // …and INERT, not merely focus-preserving. This is the window that holds the `current !== declared`
  // half of the carry-focus guard, which nothing above can see: with the pane ALREADY in its declared
  // region and ALREADY active there, `moveToRegion` writes the same two values back — the STATE is
  // identical, so no state assertion can tell the two branches apart. What differs is that
  // `moveToRegion` always calls `set` with fresh objects (an emission, i.e. a re-render of every
  // regions subscriber — `RegionShell` among them) while `dockToRegion` returns the same state and
  // zustand suppresses the notify. This effect re-runs whenever ANY pane opens, so the difference is
  // a re-render of the whole region chrome on every pane open, forever.
  it('…and is INERT: an idempotent re-run does not write to the regions store at all', () => {
    const { rerender } = renderHook(
      () => useViewReconciliation(gatedRegistry(), { producedTypeIds: ['test/thing'] }, STRICT),
      { wrapper: ({ children }) => <StrictMode>{children}</StrictMode> },
    )
    const paneId = viewPanes().find(c => c.ref === 'e.gated')!.id
    // The steady state the guard is about: in its declared region AND holding that region's slot.
    //
    // The SELECTION is now made explicitly, and that is not scaffolding — it is the behaviour.
    // An AUTO-MOUNT (which is what put this pane here) deliberately does not focus what it
    // mounts: the user did not ask for it, and taking the region would interrupt whatever they
    // were doing (`paneAutoMountFocus.test.tsx`). So the only thing that puts an auto-mounted
    // pane in a region's active slot is a user selecting its tab — which is what this line is.
    regions.getState().setActive('right', paneId)
    expect(regions.getState().regionOverride[paneId]).toBe('right')
    expect(regions.getState().active.right).toBe(paneId)

    let writes = 0
    const unsubscribe = regions.subscribe(() => {
      writes += 1
    })
    rerender()
    unsubscribe()
    expect(writes, 'a settled reconcile pass must not emit — every regions subscriber re-renders on one').toBe(0)
  })
})

