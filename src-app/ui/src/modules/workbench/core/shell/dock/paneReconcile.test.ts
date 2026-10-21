import { describe, it, expect } from 'vitest'
import type { Contributions, DatatypeLattice, ViewContribution, WhenContext } from '@/modules/workbench/core'
import { reconcileViews, availableViews } from './paneReconcile'

const LATTICE = { isA: () => false, matches: () => false, get: () => undefined } as unknown as DatatypeLattice
const CTX: WhenContext = { producedTypeIds: [] }

function view(id: string, area: ViewContribution['area']): ViewContribution {
  return { id, extensionId: 'test', apiVersion: '1.0.0', title: id, area, render: { component: `ui/${id}` } }
}
function fakeRegistry(views: ViewContribution[]): Contributions {
  return { views: { all: () => views } } as unknown as Contributions
}

// DEC-15 role→region: analysis control/run surfaces dock RIGHT, output BOTTOM, inspect LEFT.
// `availableViews` reconciles all three areas (broadened from bottom-only), carries each view's
// declared region, and EXCLUDES the shell's own default-pane views (canvas/visualize).
//
// `SHELL_DEFAULT_PANE_VIEW_IDS` has shrunk to ONE id: ITEM-9 took `workbench.selection` with
// the deleted selection inspector, ITEM-33 took `workbench.visualize` with the deleted
// field-provider rail. Each time the fixture drops the view WITH its subject — keeping it
// would assert an exclusion the shipped set no longer makes, i.e. a test tracking the old
// behaviour rather than the new one.
//
// The remaining id (`workbench.canvas`) lives in `center`, which is not a reconcilable area,
// so the fixture below places it in `left` as a SYNTHETIC probe: it proves the filter still
// excludes a default-pane id from a reconcilable area, without pretending any shipped shell
// view occupies one today.
// INV-3 note: a declarative view id is now the BARE spec id — the `::region::<region>`
// suffix went with the region fan. `availableViews` never parsed that suffix (it reads the
// contribution's declared `area`), so the ids below simply follow the new shape. The AREA
// spread is still exercised: `availableViews` must keep reconciling all three reconcilable
// regions, because a non-declarative `ViewContribution` may still claim any of them.
describe('availableViews reconciles left/right/bottom + excludes shell default-pane views (DEC-15)', () => {
  it('returns each analysis view with its declared region and drops the shell default-pane views', () => {
    const reg = fakeRegistry([
      view('workbench.canvas', 'left'), // synthetic: a default-pane id in a reconcilable area — excluded
      view('view.beta', 'right'), // analysis control surface → right
      view('view.alpha', 'right'),
      view('view.gamma', 'bottom'), // analysis output → bottom
      view('inspect', 'left'), // analysis inspect → left
    ])
    const got = availableViews(reg, CTX, LATTICE)
    expect(got).toEqual([
      { id: 'inspect', area: 'left' },
      { id: 'view.beta', area: 'right' },
      { id: 'view.alpha', area: 'right' },
      { id: 'view.gamma', area: 'bottom' },
    ])
    // no shell default-pane view leaks in (would DUPLICATE its dedicated pane).
    expect(got.some(v => v.id.startsWith('workbench.'))).toBe(false)
  })
})

// TEST-211 (ITEM-12) — the pure contributed-view↔pane reconciliation: place each available view,
// self-close a pane whose view is no longer available, and never disturb unrelated panes.
//
// The third argument (the AUTO-MOUNT set) is REQUIRED and is passed explicitly everywhere. In
// this describe and the duplicate-repair one below it repeats the available set, which is the
// "every analysis here applies to this project" case — these tests are about the close / repair
// arms, and saying so out loud beats an implicit default that no production caller uses.
describe('paneReconcile (ITEM-12)', () => {
  it('adds a newly-available view and leaves an already-shown one alone', () => {
    const plan = reconcileViews(['v1', 'v2'], [{ paneId: 'p1', viewId: 'v1' }], ['v1', 'v2'])
    expect(plan.toAdd).toEqual(['v2'])
    expect(plan.toClose).toEqual([])
  })

  it('self-closes a pane whose view lost availability, without touching unrelated view panes', () => {
    const plan = reconcileViews(
      ['v1'],
      [
        { paneId: 'p1', viewId: 'v1' },
        { paneId: 'p3', viewId: 'v3' }, // v3 no longer available → close p3
      ],
      ['v1'],
    )
    expect(plan.toClose).toEqual(['p3'])
    expect(plan.toAdd).toEqual([]) // v1 stays (already shown), not re-added
  })

  it('is a no-op when the shown set already matches availability', () => {
    const plan = reconcileViews(
      ['v1', 'v2'],
      [
        { paneId: 'p1', viewId: 'v1' },
        { paneId: 'p2', viewId: 'v2' },
      ],
      ['v1', 'v2'],
    )
    expect(plan.toAdd).toEqual([])
    expect(plan.toClose).toEqual([])
  })
})

// Self-healing: the diff must also REPAIR an already-duplicated layout, not merely stop making
// new ones. The double-add shipped, so real users have `pane-1..pane-4` (two view ids, four
// panes) persisted in `localStorage`; a forward-only fix leaves them with two identical tabs per
// analysis forever, because nothing else rewrites that state. Verified against a seeded layout:
// it stayed at four panes until this arm existed.
describe('reconcileViews repairs duplicate panes for an available view', () => {
  it('closes the extras and keeps the first', () => {
    const existing = [
      { paneId: 'pane-1', viewId: 'view.alpha' },
      { paneId: 'pane-2', viewId: 'view.beta' },
      { paneId: 'pane-3', viewId: 'view.alpha' },
      { paneId: 'pane-4', viewId: 'view.beta' },
    ]
    const plan = reconcileViews(['view.alpha', 'view.beta'], existing, ['view.alpha', 'view.beta'])
    expect(plan.toAdd).toEqual([])
    expect(plan.toClose.sort()).toEqual(['pane-3', 'pane-4'])
  })

  // The layouts this arm has to repair are PERSISTED, and the persisted ones were written
  // by the region fan — so they carry `::region::`-suffixed refs that no longer match any
  // available view id. Those panes must CLOSE (their view is genuinely gone under that
  // id), and the collapsed view must mount ONCE alongside. Without this the user's first
  // load after the collapse would keep two stale tabs and add a third.
  it('closes the pre-collapse `::region::` panes and adds the collapsed view once', () => {
    const plan = reconcileViews(
      ['view.alpha', 'view.beta'],
      [
        { paneId: 'pane-1', viewId: 'view.alpha::region::right' },
        { paneId: 'pane-2', viewId: 'view.beta::region::right' },
      ],
      ['view.alpha', 'view.beta'],
    )
    expect(plan.toClose.sort()).toEqual(['pane-1', 'pane-2'])
    expect(plan.toAdd).toEqual(['view.alpha', 'view.beta'])
  })

  // The SECOND persisted-id migration, same shape as the `::region::` one above. Panes
  // written while the pane was keyed on the VIEW SPEC carry `ref: <spec id>`; the pane is
  // keyed on the ANALYSIS now (INV-3: one analysis, one pane, however many `ui:` files), so
  // those refs match no available view and must close while the analysis pane mounts once.
  //
  // Worth pinning separately from the generic "view is gone" arm because of the two-file
  // case: a user who opened a two-`ui:` analysis has TWO stale panes for what is now ONE,
  // and a migration that only closed the first would leave a permanent orphan tab.
  it('closes the pre-collapse per-SPEC panes and adds the analysis pane once', () => {
    // Neutral ids: the reconciler is domain-agnostic — it compares view ids as opaque
    // strings — so naming a shipped package here would couple a CORE dock test to that
    // package for no gain. `an.one` stands for the analysis; `an.one.a`/`an.one.b` for its
    // two `ui:` files.
    const plan = reconcileViews(
      ['an.one'],
      [
        { paneId: 'pane-1', viewId: 'an.one.a' }, // its first ui: file
        { paneId: 'pane-2', viewId: 'an.one.b' }, // a second ui: file of the SAME analysis
      ],
      ['an.one'],
    )
    expect(plan.toClose.sort()).toEqual(['pane-1', 'pane-2'])
    expect(plan.toAdd).toEqual(['an.one'])
  })

  it('still closes a pane whose view is GONE, and leaves a single pane alone', () => {
    const plan = reconcileViews(
      ['a'],
      [
        { paneId: 'p1', viewId: 'a' },
        { paneId: 'p2', viewId: 'removed' },
      ],
      ['a'],
    )
    expect(plan.toClose).toEqual(['p2'])
    expect(plan.toAdd).toEqual([])
  })
})

// ── the AUTO-MOUNT GATE's reconcile half ────────────────────────────────────────────────────
//
// `reconcileViews` answers TWO questions that used to be one set: which views may REMAIN open,
// and which are auto-MOUNTED without being asked for. The gate narrows only the second, and the
// separation is the point — a view a user OPENED on purpose (the launcher's ⚙ "open the analysis
// form", which stays enabled for an availability-gated analysis) must not be closed a frame
// later by the same reconcile that refused to mount it.
describe('reconcileViews: the auto-mount set is separable from the retained set', () => {
  it('a view that is available but NOT auto-mountable is not added', () => {
    const plan = reconcileViews(['v1', 'v2'], [], ['v1'])
    expect(plan.toAdd).toEqual(['v1'])
    expect(plan.toClose).toEqual([])
  })

  it('…and a pane the user already has for that view is KEPT, not closed', () => {
    const plan = reconcileViews(['v1', 'v2'], [{ paneId: 'p2', viewId: 'v2' }], ['v1'])
    expect(plan.toClose).toEqual([])
    expect(plan.toAdd).toEqual(['v1'])
  })

  it('the auto-mount set is INTERSECTED with availability — a name not in it is never added', () => {
    // The auto-mount set is a caller-supplied narrowing, not a second source of truth. Without
    // the intersection a caller could add a pane for a view `placeViews` never placed (no
    // declared area, no registered contribution), i.e. a pane whose body has nothing to render.
    const plan = reconcileViews(['v1'], [], ['v1', 'ghost'])
    expect(plan.toAdd).toEqual(['v1'])
  })

  it('the CLOSE arm is untouched by the gate — a view that is gone still closes', () => {
    const plan = reconcileViews(['v1'], [{ paneId: 'p9', viewId: 'gone' }], [])
    expect(plan.toClose).toEqual(['p9'])
    expect(plan.toAdd).toEqual([])
  })

  it('duplicate repair still runs for a gated-out view the user has two panes of', () => {
    const plan = reconcileViews(
      ['v1'],
      [
        { paneId: 'p1', viewId: 'v1' },
        { paneId: 'p2', viewId: 'v1' },
      ],
      [],
    )
    expect(plan.toClose).toEqual(['p2'])
    expect(plan.toAdd).toEqual([])
  })
})
