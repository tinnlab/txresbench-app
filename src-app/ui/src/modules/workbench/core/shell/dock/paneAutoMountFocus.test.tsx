// @vitest-environment jsdom
//
// AN AUTO-MOUNTED PANE MUST NOT TAKE THE REGION AWAY FROM WHAT THE USER IS LOOKING AT.
//
// ── the finding ─────────────────────────────────────────────────────────────────────────────
// `useViewReconciliation` mounts a contributed view the moment the auto-mount gate opens for it
// — i.e. the moment the project produces the datatype that analysis declared. It then placed the
// new pane with `moveToRegion`, and `moveToRegion` FOCUSES what it moves. A user reading the
// analysis launcher in the right region, mid-click, has the launcher replaced by a surface they
// did not ask for; the pane they were interacting with is still open, just no longer on screen.
//
// ── the rule ────────────────────────────────────────────────────────────────────────────────
// An AUTO-MOUNT never changes what is on screen. A USER-INITIATED open always does.
//
// That distinction is already spelled in the store as two verbs — `moveToRegion` (a user move,
// focuses) and `dockToRegion` (the idempotent placement, does not) — and the reconcile's
// RE-ASSERTION loop already uses the second one. Only the ADD path did not, which is why this
// was invisible: the steady state is a no-op either way, and the difference is only observable
// in the one frame where a pane arrives unasked.
//
// The auto-mounted pane is NOT hidden by this: a region with nothing selected falls through to
// its first tab (`RegionShell`'s `activeIn`), so an auto-mount into an empty region is still
// shown. It only stops OVERRIDING a selection the user made.
//
// ── fixture shape ───────────────────────────────────────────────────────────────────────────
// Modelled on `paneReconcileGateDeps.test.tsx`: the REAL `useStore`, a stable fixture whose only
// moving part is `ctx`, and `StrictMode` (which is on in `main.tsx`). The gated view is what
// gives this file an add that happens WHILE the shell is mounted — the situation the defect
// needs and a boot-time mount does not have.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { StrictMode } from 'react'
import { cleanup, renderHook } from '@testing-library/react'
import type { Contributions, DatatypeLattice, ViewContribution, WhenContext } from '@/modules/workbench/core'
import { useViewReconciliation } from './paneReconcile'
import { workbenchDockStore } from './WorkbenchDock.store'
import { workbenchRegionsStore } from '../regions/WorkbenchRegions.store'
import { revealPane } from '../regions/openPane'

const STRICT = {
  isA: (id: string, target: string) => id === target,
  matches: (id: string, sel: { type_id?: string; subtypes_of?: string }) =>
    id === sel.type_id || id === sel.subtypes_of,
  get: () => undefined,
} as unknown as DatatypeLattice

function view(id: string): ViewContribution {
  return { id, extensionId: 'test', apiVersion: '1.0.0', title: id, area: 'right', render: { component: `ui/${id}` } }
}

/** One gated analysis + its view, both declaring the RIGHT region — which is where the analysis
 *  launcher lives, i.e. the pane a user is most likely to be mid-interaction with. */
function fixture() {
  const analyses = new Map([
    [
      'g.gated',
      {
        id: 'g.gated',
        extensionId: 't',
        apiVersion: '1.0.0',
        title: 'g.gated',
        appliesTo: [{ slot: 'x', subtypes_of: 'test/thing' }],
      },
    ],
  ])
  const views = [view('g.gated')]
  const registry = {
    views: { all: () => views },
    analyses: { get: (id: string) => analyses.get(id) },
  } as unknown as Contributions
  const empty: WhenContext = { producedTypeIds: [] }
  const produced: WhenContext = { producedTypeIds: ['test/thing'] }
  return { registry, empty, produced }
}

function gatedPaneId(): string | undefined {
  return workbenchDockStore.getState().panes().find(c => c.kind === 'view' && c.ref === 'g.gated')?.id
}

let seq = 0

beforeEach(() => {
  window.localStorage.clear()
  const project = `p-automount-focus-${++seq}`
  workbenchDockStore.getState().ensureProject(project)
  workbenchRegionsStore.getState().ensureProject(project)
})
// EXPLICIT (see `paneReconcileGateDeps.test.tsx`): this file uses the REAL `useStore`, so a hook
// left mounted stays SUBSCRIBED and the next test's `ensureProject` re-runs its effect.
afterEach(() => cleanup())

describe('an auto-mounted pane does not steal focus', () => {
  it('leaves the region showing the pane the user selected', () => {
    const { registry, empty, produced } = fixture()
    // A pane the user is looking at, in the region the gated view declares.
    const launcher = workbenchDockStore.getState().requestAddPane('launcher')
    expect(launcher, 'the launcher opened').toBeTruthy()
    workbenchRegionsStore.getState().moveToRegion(launcher, 'right')
    expect(workbenchRegionsStore.getState().active.right).toBe(launcher)

    const { rerender } = renderHook(
      ({ ctx }: { ctx: WhenContext }) => useViewReconciliation(registry, ctx, STRICT),
      { initialProps: { ctx: empty }, wrapper: ({ children }) => <StrictMode>{children}</StrictMode> },
    )
    expect(gatedPaneId(), 'gated: withheld until the project produces the type').toBeUndefined()

    // The run finishes and the project now produces the type — the gate opens and the view
    // mounts itself. The user asked for none of that.
    rerender({ ctx: produced })
    const mounted = gatedPaneId()
    expect(mounted, 'the gate opened and the view mounted').toBeTruthy()

    expect(
      workbenchRegionsStore.getState().active.right,
      'an auto-mounted surface took the region away from the pane the user was using',
    ).toBe(launcher)
  })

  it('…but it is still DOCKED — the rule is "do not focus", not "do not place"', () => {
    // The negative control. Satisfying the assertion above by simply not placing the pane would
    // drop it into its kind's default region instead of the area its view declared.
    const { registry, empty, produced } = fixture()
    const launcher = workbenchDockStore.getState().requestAddPane('launcher')
    workbenchRegionsStore.getState().moveToRegion(launcher, 'right')

    const { rerender } = renderHook(
      ({ ctx }: { ctx: WhenContext }) => useViewReconciliation(registry, ctx, STRICT),
      { initialProps: { ctx: empty }, wrapper: ({ children }) => <StrictMode>{children}</StrictMode> },
    )
    rerender({ ctx: produced })

    const mounted = gatedPaneId() as string
    expect(
      workbenchRegionsStore.getState().regionOverride[mounted],
      'the auto-mounted pane still lands in the area its view declared',
    ).toBe('right')
  })

  it('shows itself when the region had NOTHING selected — an empty slot is not a steal', () => {
    // The other half of the rule. `RegionShell.activeIn` falls through to the region's first tab
    // when `active` is null, so an auto-mount into an unselected region is still visible. Without
    // this, "never focus" could be read as "never appear".
    const { registry, empty, produced } = fixture()
    expect(workbenchRegionsStore.getState().active.right, 'nothing selected in the right region').toBeNull()

    const { rerender } = renderHook(
      ({ ctx }: { ctx: WhenContext }) => useViewReconciliation(registry, ctx, STRICT),
      { initialProps: { ctx: empty }, wrapper: ({ children }) => <StrictMode>{children}</StrictMode> },
    )
    rerender({ ctx: produced })

    const mounted = gatedPaneId() as string
    const s = workbenchRegionsStore.getState()
    const inRight = s.regionOverride[mounted] === 'right'
    // `activeIn`'s rule, restated: a region with no selection shows its first pane.
    expect(inRight && (s.active.right === null || s.active.right === mounted)).toBe(true)
  })
})

describe('a USER-INITIATED open still focuses — the other side of the rule', () => {
  it('revealPane brings the pane it opens to the front of its region', () => {
    const launcher = workbenchDockStore.getState().requestAddPane('launcher')
    workbenchRegionsStore.getState().moveToRegion(launcher, 'right')
    expect(workbenchRegionsStore.getState().active.right).toBe(launcher)

    // The route the completion toast, the run list and the status bar all take.
    const jobs = revealPane('jobs', '3f2a1c8e-9d4b-4c1e-8a77-2b6f0d1e5a90')
    expect(jobs, 'the jobs pane opened').toBeTruthy()
    const region = workbenchRegionsStore.getState().regionOverride[jobs] ?? 'right'
    expect(
      workbenchRegionsStore.getState().active[region],
      'a user who asks for a pane by name must be shown it',
    ).toBe(jobs)
  })

  it('the "+" menu’s add focuses what it added', () => {
    // `AddPaneMenu` is `requestAddPane` + `moveToRegion`; the store-level invariant is that the
    // second verb is the FOCUSING one, which is what makes the auto-mount fix a change of verb
    // rather than a change of behaviour for the human paths.
    const first = workbenchDockStore.getState().requestAddPane('launcher')
    workbenchRegionsStore.getState().moveToRegion(first, 'bottom')
    const second = workbenchDockStore.getState().requestAddPane('jobs')
    workbenchRegionsStore.getState().moveToRegion(second, 'bottom')
    expect(workbenchRegionsStore.getState().active.bottom).toBe(second)
  })
})
