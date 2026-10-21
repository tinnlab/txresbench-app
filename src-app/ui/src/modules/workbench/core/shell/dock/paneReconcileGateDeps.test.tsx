// @vitest-environment jsdom
//
// The auto-mount gate's INPUT as an effect DEPENDENCY — in a file with the REAL `useStore`.
//
// This file was built for the flag: it flipped `gateAutoMount` between two renders to hold a
// mutation that dropped that flag from the effect's dep list. The flag is gone with the adoption,
// so that subject is gone with it — but the FIXTURE is not vacuous, and this is the check rather
// than the assumption. What the gate reads now is `ctx.producedTypeIds`, and `ctx` is a dep for
// exactly the same reason the flag was: it is the ONLY thing in the list that moves when a
// project produces the artifact a withheld analysis was waiting for. `panes` does not move on its
// own when a run finishes; `registry`/`lattice` are stable module refs; `regionsProject` changes
// only on a project switch. Omit `ctx` and the withheld pane never appears — the user runs the
// analysis that produces the type and the surface that was waiting for it stays absent.
//
// This test cannot live in `paneReconcileEffect.test.tsx`. That file mocks `useStore` to return
// a fresh `{}` on every call (deliberately — it holds the render closure STALE to reproduce the
// StrictMode double-add), which makes the `panes` dependency differ on every render and the
// effect re-run unconditionally. Under that mock a dep-list omission is invisible: dropping a dep
// is a mutation the whole dock suite SURVIVES. The fixture this needs is a file where the
// dependency array is the only thing deciding whether the effect re-runs — which is what the real
// store gives, since its pane map keeps its identity across a render that changed nothing.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { StrictMode } from 'react'
import { cleanup, renderHook } from '@testing-library/react'
import type { Contributions, DatatypeLattice, ViewContribution, WhenContext } from '@/modules/workbench/core'
import { useViewReconciliation } from './paneReconcile'
import { workbenchDockStore } from './WorkbenchDock.store'

const STRICT = {
  isA: (id: string, target: string) => id === target,
  matches: (id: string, sel: { type_id?: string; subtypes_of?: string }) =>
    id === sel.type_id || id === sel.subtypes_of,
  get: () => undefined,
} as unknown as DatatypeLattice

function view(id: string): ViewContribution {
  return { id, extensionId: 'test', apiVersion: '1.0.0', title: id, area: 'right', render: { component: `ui/${id}` } }
}

/** Stable identities for EVERY other dependency, so `ctx` is provably the only thing that moved
 *  between the two renders. Built ONCE per test and reused across both renders — a `registry`
 *  rebuilt per render would re-run the effect by itself and the file would prove nothing. */
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

/** Through the store's own `panes()` accessor rather than its state field: a file with no
 *  `domain-baseline.json` entry has a budget of ZERO tokens, and the field's name is one. The
 *  accessor is the better read anyway — it is the published shape. */
function viewPanes() {
  return workbenchDockStore.getState().panes().filter(c => c.kind === 'view')
}

describe('the gate’s input participates in the effect’s dependencies', () => {
  beforeEach(() => {
    workbenchDockStore.getState().ensureProject(`p-${Math.random().toString(36).slice(2)}`)
  })
  // EXPLICIT, because there is no vitest setup file registering RTL's auto-cleanup. Without it
  // the previous test's hook stays mounted AND — since this file uses the REAL `useStore` — stays
  // SUBSCRIBED to the dock store, so the next test's `ensureProject` re-renders it and its effect
  // mounts a pane into the new project. Measured: the control below saw one pane it never asked
  // for, produced by the test above it.
  afterEach(() => cleanup())

  it('producing the type the analysis needs mounts the view that had been withheld', () => {
    const { registry, empty, produced } = fixture()
    const { rerender } = renderHook(
      ({ ctx }: { ctx: WhenContext }) => useViewReconciliation(registry, ctx, STRICT),
      { initialProps: { ctx: empty }, wrapper: ({ children }) => <StrictMode>{children}</StrictMode> },
    )
    expect(viewPanes(), 'gated: the analysis needs a type the project has not produced').toHaveLength(0)

    rerender({ ctx: produced })
    expect(viewPanes().map(c => c.ref)).toEqual(['g.gated'])
  })

  it('a re-render that changes NOTHING does not re-run the effect (the control for the above)', () => {
    // Without this, the test above would also pass in a world where the effect re-runs on every
    // render for some unrelated reason — i.e. it would not be evidence about the dep list at all.
    const { registry, empty } = fixture()
    const { rerender } = renderHook(
      ({ ctx }: { ctx: WhenContext }) => useViewReconciliation(registry, ctx, STRICT),
      { initialProps: { ctx: empty }, wrapper: ({ children }) => <StrictMode>{children}</StrictMode> },
    )
    rerender({ ctx: empty })
    rerender({ ctx: empty })
    expect(viewPanes()).toHaveLength(0)
  })
})
