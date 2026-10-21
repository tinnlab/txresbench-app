// HOW A SECTION WRITES A PANE VALUE (visualize-pane ITEM-11) — the `scope: pane` state field,
// and the invariant it exists to put in force.
//
// ── What was actually broken ────────────────────────────────────────────────────────────
//
// `$scope.coordinate` was DECLARED and written by nothing, because a section writes through a
// declared action's `set`, which addresses its own store. INV-8's binding half was therefore
// not in force: § Coordinates' picker and the rows the pane was scoped to could disagree. That
// was bounded only because nothing could plot. The emit model removes the bound, so the seam
// and the invariant are asserted together here.
//
// Which way the invariant RUNS changed on 2026-08-13, when the owner deleted the pane's anchor
// control: `$scope.axis` is no longer asked for, it is DERIVED from the chosen coordinate
// (`./coordinateAxis.ts`). See the block comment above the two INV-8 tests below.
//
// Three properties, and the third is the one a wired-looking implementation would miss:
//   1. a `set` on a pane-scoped field reaches the PANE, so other sections see it;
//   2. it is mirrored locally, so the control that wrote it reads its own value back;
//   3. a change made ELSEWHERE reaches the field — which is what makes the null land.

import { beforeEach, describe, expect, it } from 'vitest'

import type { ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import { createViewStore } from './store'
import { currentPaneScope, paneScopeStore } from './paneScope.store'

const PROJECT = 'proj-1'
const COORD_A = 'artifact-a'
const COORD_B = 'artifact-b'
const AXIS_ONE = 'hash-one'
const AXIS_TWO = 'hash-two'

function spec(over: Partial<ViewSpec> = {}): ViewSpec {
  return {
    id: 'demo.section',
    title: 'Demo',
    permission: 'projects::use',
    state: {
      coordinate: { type: 'string', default: null, scope: 'pane' },
      // An ORDINARY field beside it, so every assertion below has its negative control: the
      // seam must reach the pane-scoped field and leave this one alone.
      own: { type: 'string', default: 'mine' },
    },
    widgets: [],
    actions: [],
    ...over,
  } as ViewSpec
}

beforeEach(() => {
  paneScopeStore.getState().reset()
  paneScopeStore.getState().bindProject(PROJECT)
})

describe('a `scope: pane` state field IS the pane’s value', () => {
  it('seeds from the PANE, not from the field’s own default', () => {
    // Seeding from the declared default would clobber the pane's current value the instant a
    // second section mounted — a per-view opinion overwriting a shared fact.
    paneScopeStore.getState().setValue('coordinate', COORD_A)
    const store = createViewStore(spec(), 'v1')
    expect(store.state.coordinate).toBe(COORD_A)
    expect(store.state.own).toBe('mine')
  })

  it('a `set` writes THROUGH to the pane, so another section sees it', () => {
    const writer = createViewStore(spec(), 'writer')
    const reader = createViewStore(spec(), 'reader')
    writer.set('coordinate', COORD_A)
    expect(currentPaneScope().coordinate).toBe(COORD_A)
    // The reader is a DIFFERENT store; it learns the value the way a section does — by
    // re-seeding from the pane, which the host does on every pane-scope change.
    reader.syncPaneScope()
    expect(reader.state.coordinate).toBe(COORD_A)
  })

  it('is mirrored locally, so the control that wrote it reads its own value back', () => {
    const store = createViewStore(spec(), 'v1')
    store.set('coordinate', COORD_A)
    expect(store.state.coordinate).toBe(COORD_A)
  })

  it('leaves an ORDINARY field entirely to the view (the negative control)', () => {
    const store = createViewStore(spec(), 'v1')
    store.set('own', 'changed')
    expect(store.state.own).toBe('changed')
    expect(Object.keys(currentPaneScope())).not.toContain('own')
  })

  // ── the two tests that stood here, and what replaced them ────────────────────────────
  //
  // They asserted INV-8's binding half in the direction it ran until 2026-08-13: *"on an
  // ANCHOR change, `$scope.coordinate` goes to null rather than being re-resolved"*, driven
  // through `paneScopeStore.setAxis`, which cleared the coordinate on every change.
  //
  // The owner deleted the anchor control (there is no such thing as a row space; an axis is
  // never a thing a user picks), so there is no anchor change to clear anything: `axis` is
  // DERIVED from the chosen coordinate (`./coordinateAxis.ts`) and written only through
  // `setDerivedAxis`, which deliberately CARRIES the coordinate. The old assertions are
  // therefore about a facility that no longer exists.
  //
  // The PROPERTY they protected does exist, whole, and runs the other way: a section's picker
  // must never keep pointing at positions the pane's rows are not about. It is now guaranteed
  // by construction rather than by a clearing rule — the coordinate IS the choice and the rows
  // follow it — so the two tests below assert exactly that, plus the one thing a section could
  // still do to break it (writing the axis itself).

  it('INV-8 — the rows FOLLOW the section’s coordinate, so the picker can never be in another frame', () => {
    // The direction the invariant now runs. A section writes the coordinate through the seam;
    // the derivation writes the rows those positions declare. There is no state in which the
    // picker holds positions from one population while the pane is scoped to another, because
    // the pane is scoped to whatever the picker holds.
    const store = createViewStore(spec(), 'v1')
    store.set('coordinate', COORD_A)
    paneScopeStore.getState().setDerivedAxis(PROJECT, [AXIS_ONE])
    expect(currentPaneScope()).toEqual({ axis: [AXIS_ONE], coordinate: COORD_A })

    // A SECOND choice, in a different population. Both halves move together, and the section
    // that wrote the coordinate reads its own value back — the clearing the old rule did is
    // exactly what must NOT happen here.
    store.set('coordinate', COORD_B)
    paneScopeStore.getState().setDerivedAxis(PROJECT, [AXIS_TWO])
    expect(currentPaneScope()).toEqual({ axis: [AXIS_TWO], coordinate: COORD_B })
    store.syncPaneScope()
    expect(store.state.coordinate).toBe(COORD_B)
  })

  it('a section may NOT write the rows — `axis` is derived, and the seam refuses it', () => {
    // The one move that would restore the failure the old clearing rule guarded: a declaration
    // asserting rows of its own, against positions that declare different ones. It is refused
    // at the seam and REPORTED, because a write that silently does nothing is a control that
    // looks wired and is not.
    const store = createViewStore(spec({
      state: {
        // The same declaration a section would ship to try it: a `scope: pane` field named for
        // the pane's derived value. `axis` is in `PANE_SCOPE_KEYS`, so the spec parses — the
        // refusal is at the WRITE, which is where it has to be.
        axis: { type: 'string', default: null, scope: 'pane' },
      },
    }), 'v-axis-writer')
    paneScopeStore.getState().setDerivedAxis(PROJECT, [AXIS_ONE])

    const errors: unknown[] = []
    const original = console.error
    console.error = (...args: unknown[]) => errors.push(args)
    try {
      store.set('axis', AXIS_TWO)
    } finally {
      console.error = original
    }
    expect(currentPaneScope().axis).toEqual([AXIS_ONE])
    expect(errors.length).toBe(1)
  })

  it('`syncPaneScope` is idempotent and a no-op for a view that declares no pane field', () => {
    // It runs from a render effect on every revision, so it must not bump a revision of its own
    // when nothing changed — otherwise the effect re-enters forever.
    const plain = createViewStore(
      spec({ state: { own: { type: 'string', default: 'mine' } } }) as ViewSpec,
      'plain',
    )
    const before = plain.revision
    plain.syncPaneScope()
    plain.syncPaneScope()
    expect(plain.revision).toBe(before)

    const store = createViewStore(spec(), 'v1')
    store.set('coordinate', COORD_A)
    const rev = store.revision
    store.syncPaneScope()
    expect(store.revision).toBe(rev)
  })

  it('a write before the pane knows its project is REFUSED, not stored under a placeholder', () => {
    // A `content_hash` or an artifact id from project A names nothing in project B, so a value
    // that arrived before `bindProject` has no project to belong to. Storing it under a
    // placeholder id would have it cleared from under the control on the next bind.
    paneScopeStore.getState().reset()
    const store = createViewStore(spec(), 'v1')
    store.set('coordinate', COORD_A)
    expect(currentPaneScope().coordinate).toBeNull()
  })

  it('the pane refuses a value it does not hold (INV-13’s runtime backstop)', () => {
    const errors: unknown[] = []
    const original = console.error
    console.error = (...args: unknown[]) => errors.push(args)
    try {
      paneScopeStore.getState().setValue('colorBy', 'x')
    } finally {
      console.error = original
    }
    expect(Object.keys(currentPaneScope())).not.toContain('colorBy')
    expect(errors.length).toBe(1)
  })
})
