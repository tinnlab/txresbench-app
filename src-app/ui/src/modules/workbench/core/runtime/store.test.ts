import { describe, it, expect, beforeEach } from 'vitest'
import type { ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import {
  __resetInstanceRegistryForTests,
  getInstanceRecord,
} from '@/core/actions/instanceRegistry'
import { createViewStore, __setRecomputeSchedulerForTests } from './store'
import { paneScopeStore } from './paneScope.store'

// TEST-3 (PLAN.md ITEM-3) — the per-instance reactive store: `set(field)`
// triggers dependent `derived` recompute; the store joins `instanceRegistry`
// under its `view_id` on create and leaves on `dispose`.

function filterSpec(): ViewSpec {
  return {
    id: 'qc/filter',
    title: 'Filter cells',
    permission: 'studies::use',
    state: { ranges: { type: 'map', default: {} } },
    const: {},
    derived: {
      hidden: {
        filter_mask: {
          values: '$data.obs.nCount',
          group_of: '$data.obs.ident',
          ranges: '$state.ranges',
        },
      },
      nCells: { count_by: { group: '$data.obs.ident', hidden: '$derived.hidden' } },
    },
    widgets: [],
    actions: [],
  }
}

const data = { obs: { nCount: [1, 10, 100], ident: ['A', 'A', 'A'] } }

beforeEach(() => __resetInstanceRegistryForTests())

describe('createViewStore — reactive derived (ITEM-3)', () => {
  it('recomputes dependent derived when a state field is set', () => {
    const store = createViewStore(filterSpec(), 'view-1', data)

    // No range → nothing hidden.
    expect(store.derived.hidden).toEqual([false, false, false])
    expect((store.derived.nCells as Record<string, unknown>).A).toEqual({ before: 3, after: 3 })

    const tokenBefore = store.token
    store.set('ranges', { A: [5, 50] })

    // 1 < 5 hidden, 10 kept, 100 > 50 hidden.
    expect(store.derived.hidden).toEqual([true, false, true])
    expect((store.derived.nCells as Record<string, unknown>).A).toEqual({ before: 3, after: 1 })
    expect(store.get().derived.hidden).toEqual([true, false, true])
    // the state token bumped on mutation.
    expect(store.token).not.toBe(tokenBefore)
  })

  it('joins the instance directory under its view_id and leaves on dispose', () => {
    const store = createViewStore(filterSpec(), 'view-42', data)

    const rec = getInstanceRecord('view-42')
    expect(rec?.type).toBe('qc/filter')
    const snap = rec?.getSnapshot()
    expect(typeof snap?._state_token).toBe('string')

    store.dispose()
    expect(getInstanceRecord('view-42')).toBeUndefined()
  })

  it('dispose only unregisters OUR record — a same-view_id remount survives the old dispose (finding #3)', () => {
    const first = createViewStore(filterSpec(), 'view-dup', data)
    expect(getInstanceRecord('view-dup')?.type).toBe('qc/filter')

    // A fast remount registers a NEW store (new record) under the SAME id + type.
    const second = createViewStore(filterSpec(), 'view-dup', data)
    const liveRecord = getInstanceRecord('view-dup')

    // Disposing the OLD store must be identity-guarded: the live (second) record stays.
    first.dispose()
    expect(getInstanceRecord('view-dup')).toBe(liveRecord)
    expect(getInstanceRecord('view-dup')).toBeDefined()

    // The live store still works, and its own dispose does remove it.
    second.set('ranges', { A: [1, 2] })
    expect((second.snapshot() as Record<string, unknown>).ranges).toEqual({ A: [1, 2] })
    second.dispose()
    expect(getInstanceRecord('view-dup')).toBeUndefined()
  })

  it('exposes a token-stamped snapshot that reflects live state', () => {
    const store = createViewStore(filterSpec(), 'view-7', data)
    store.set('ranges', { A: [5, 50] })
    const snap = store.snapshot()
    expect(snap._state_token).toBe(store.token)
    expect((snap as Record<string, unknown>).ranges).toEqual({ A: [5, 50] })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// declarative-rendering-hardening Slice 2 (F3/F7) — the data-lifecycle fields.
//
// `dataStatus` is what lets a region tell a FAILED fetch from a genuinely-empty project;
// `dataRevision` is the error-boundary's reset key (DEC-2) and must bump ONLY on a data
// arrival, never on a state `set` — otherwise the boundary re-throws on every slider tick,
// which is the exact symptom F7 names.
// ─────────────────────────────────────────────────────────────────────────────

function dataDeclaringSpec(): ViewSpec {
  return {
    id: 'x/y',
    title: 'X',
    permission: 'jobs::use',
    state: { n: { type: 'number', default: 1 } },
    const: {},
    derived: {},
    widgets: [],
    actions: [],
    data: { obs: { source: 'job.result', args: { path: '/obs', datatype: 'report/qc' } } },
  } as unknown as ViewSpec
}

function sliceLessSpec(): ViewSpec {
  const s = dataDeclaringSpec() as ViewSpec & { data?: unknown }
  delete s.data
  return s
}

describe('ViewStore data lifecycle (declarative-rendering-hardening ITEM-3)', () => {
  it('a spec that declares a resolvable slice starts `loading`', () => {
    const store = createViewStore(dataDeclaringSpec(), 'v-a')
    expect(store.dataStatus).toBe('loading')
    expect(store.dataError).toBeUndefined()
    expect(store.dataRevision).toBe(0)
    store.dispose()
  })

  it('a store created WITH explicit data starts `ready` (nothing to wait for)', () => {
    const store = createViewStore(dataDeclaringSpec(), 'v-b', { obs: { c: [1] } })
    expect(store.dataStatus).toBe('ready')
    store.dispose()
  })

  it('a spec declaring NO resolvable slice starts `ready` — never a skeleton pinned forever', () => {
    const store = createViewStore(sliceLessSpec(), 'v-c')
    expect(store.dataStatus).toBe('ready')
    store.dispose()
  })

  it('a slice declaring no DATATYPE is not resolvable → `ready`', () => {
    const spec = dataDeclaringSpec() as ViewSpec & { data: Record<string, { args?: unknown }> }
    spec.data.obs.args = { path: '/obs' }
    const store = createViewStore(spec, 'v-d')
    expect(store.dataStatus).toBe('ready')
    store.dispose()
  })

  it('setData bumps BOTH revision and dataRevision, and records the status', () => {
    const store = createViewStore(dataDeclaringSpec(), 'v-e')
    const rev = store.revision
    store.setData({ obs: { c: [1, 2] } })
    expect(store.dataStatus).toBe('ready')
    expect(store.revision).toBe(rev + 1)
    expect(store.dataRevision).toBe(1)
    expect(store.data).toEqual({ obs: { c: [1, 2] } })
    store.dispose()
  })

  it('a plain `set` bumps revision but NOT dataRevision (DEC-2 — the latch survives slider ticks)', () => {
    const store = createViewStore(dataDeclaringSpec(), 'v-f')
    store.setData({ obs: { c: [1] } })
    const dataRev = store.dataRevision
    const rev = store.revision
    store.set('n', 2)
    store.set('n', 3)
    expect(store.revision).toBe(rev + 2)
    expect(store.dataRevision).toBe(dataRev)
    store.dispose()
  })

  it('setDataStatus records an error, notifies, and does NOT bump dataRevision (no data arrived)', () => {
    const store = createViewStore(dataDeclaringSpec(), 'v-g')
    store.setData({ obs: { c: [1] } })
    let notified = 0
    const off = store.subscribe(() => {
      notified += 1
    })
    store.setDataStatus('error', 'backend down')
    expect(store.dataStatus).toBe('error')
    expect(store.dataError).toBe('backend down')
    expect(store.data).toEqual({ obs: { c: [1] } })
    expect(notified).toBe(1)
    // A bare status flip carries NO data, so the widget error-boundary's reset key must not
    // move — otherwise every Try-again clears (and re-throws) every latched widget error.
    expect(store.dataRevision).toBe(1)
    off()
    store.dispose()
  })

  it('setData(…, "error", msg) records a PARTIAL failure (some data landed, one slice did not)', () => {
    const store = createViewStore(dataDeclaringSpec(), 'v-h')
    store.setData({ obs: { c: [1] } }, 'error', 'slice b failed')
    expect(store.dataStatus).toBe('error')
    expect(store.dataError).toBe('slice b failed')
    expect(store.data).toEqual({ obs: { c: [1] } })
    store.dispose()
  })
})

// ── r3canvas: the frame kernels' operand key ────────────────────────────────────────────────
//
// `keep_mask` / `columns_of` / `categories_by_column` all take ONE columnar `{ column: values[] }`
// operand. It used to be spelled `obs:`, so a processor author had to write a biology noun for a
// generic column map — core privileging a domain word in the LANGUAGE, not just in a default. It
// is `frame:` now, with `obs:` DUAL-ACCEPTED so the two shipping YAMLs need no migration and no
// `WORKBENCH_API_VERSION` bump. `evalDerivedEntry`'s `frameOperand()` is the single read site;
// these pin it. (The end-to-end parity proof is `core/spec/obsLanguage.test.ts`.)

function frameKernelSpec(operand: Record<string, unknown>): ViewSpec {
  return {
    id: 'frame/kernels',
    title: 'Frame kernels',
    permission: 'studies::use',
    state: { criteria: { type: 'list', default: [] } },
    const: {},
    derived: {
      keptMask: { keep_mask: { criteria: '$state.criteria', ...operand } },
      columns: { columns_of: { ...operand } },
      categories: { categories_by_column: { ...operand } },
    },
    widgets: [],
    actions: [],
  } as unknown as ViewSpec
}

const FRAME_DATA = { anySliceName: { score: [1, 2, 3], label: ['a', 'b', 'a'] } }

describe('evalDerivedEntry — the frame kernels take `frame:` (dual-accepting legacy `obs:`)', () => {
  it('`frame:` resolves the columnar operand', () => {
    const store = createViewStore(frameKernelSpec({ frame: '$data.anySliceName' }), 'v-frame', FRAME_DATA)
    expect(store.derived.keptMask).toEqual([true, true, true])
    expect(JSON.stringify(store.derived.columns)).toMatch(/score/)
    expect(store.derived.categories).toEqual({ label: ['a', 'b'] })
    store.dispose()
  })

  it('the legacy `obs:` spelling resolves IDENTICALLY (no spec migration needed)', () => {
    const viaFrame = createViewStore(frameKernelSpec({ frame: '$data.anySliceName' }), 'v-f2', FRAME_DATA)
    const viaObs = createViewStore(frameKernelSpec({ obs: '$data.anySliceName' }), 'v-o2', FRAME_DATA)
    expect(viaObs.derived).toEqual(viaFrame.derived)
    viaFrame.dispose()
    viaObs.dispose()
  })

  it('neither key ⇒ an EMPTY frame, not a guess at a slice called `obs`', () => {
    // `obs` is present in the data and would satisfy every kernel — a core that still defaulted
    // to it would return columns here. It must not: the spec bound nothing.
    const store = createViewStore(frameKernelSpec({}), 'v-none', { obs: { score: [1, 2, 3] } })
    expect(store.derived.columns).toEqual([])
    expect(store.derived.categories).toEqual({})
    expect(store.derived.keptMask).toEqual([])
    store.dispose()
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════
// binding-origin — the origin SIDECAR.
//
// (The `TEST-3` cited at the top of this file belongs to the visualize-pane namespace; test
// IDs restart per lifecycle. Everything below is the `binding-origin` namespace.)
//
// What is under test is the DISTINCTION, never the write. A test that asserted "set stores a
// value" would pass on main. Every case below puts an auto-bound value and a user-chosen
// value with the SAME value side by side, and asserts they are told apart.
// ══════════════════════════════════════════════════════════════════════════════════════════

function bindableSpec(): ViewSpec {
  return {
    id: 'origin/spec',
    title: 'Origin',
    permission: 'studies::use',
    state: { picked: { type: 'string', default: null } },
    const: {},
    derived: {},
    widgets: [],
  } as unknown as ViewSpec
}

describe('TEST-3 (binding-origin / ITEM-3) — [acceptance] [invariant: INV-1] byte-identical values are distinguishable', () => {
  beforeEach(() => __resetInstanceRegistryForTests())

  it('two stores holding the SAME value report DIFFERENT origins', () => {
    // The literal defect, stated as a test: before the sidecar these two stores were
    // indistinguishable in every observable way, which is why nothing downstream could act
    // on the difference.
    const chosen = createViewStore(bindableSpec(), 'v-user')
    const guessed = createViewStore(bindableSpec(), 'v-auto')

    chosen.set('picked', 'artifact-1')
    guessed.set('picked', 'artifact-1', 'auto')

    expect(guessed.state.picked).toEqual(chosen.state.picked)
    expect(chosen.originOf('picked')).toBe('user')
    expect(guessed.originOf('picked')).toBe('auto')

    chosen.dispose()
    guessed.dispose()
  })

  it("a plain set defaults to 'user' — the only way to record auto is to ask for it", () => {
    // The direction of the default is load-bearing. A site that forgets to pass an origin
    // under-reports NOTHING; a site that auto-binds must say so explicitly.
    const s = createViewStore(bindableSpec(), 'v-default')
    s.set('picked', 'artifact-1')
    expect(s.originOf('picked')).toBe('user')
    s.dispose()
  })
})

describe('TEST-4 (binding-origin / ITEM-3) — [acceptance] [invariant: INV-5] re-picking IS the review', () => {
  beforeEach(() => __resetInstanceRegistryForTests())

  it('a user write over an auto-bound path resolves the origin to user', () => {
    const s = createViewStore(bindableSpec(), 'v-review')
    s.set('picked', 'artifact-1', 'auto')
    expect(s.originOf('picked')).toBe('auto')

    // The SAME value, chosen deliberately this time. If the origin only ever accumulated
    // instead of overwriting, a reviewed input would read `auto` forever and every run after
    // the review would carry a false accusation.
    s.set('picked', 'artifact-1')
    expect(s.originOf('picked')).toBe('user')
    s.dispose()
  })

  it('the resolution does not depend on the value changing', () => {
    const s = createViewStore(bindableSpec(), 'v-review-2')
    s.set('picked', 'artifact-1', 'auto')
    s.set('picked', 'artifact-2')
    expect(s.originOf('picked')).toBe('user')
    // …and back the other way: a later auto-bind over a reviewed path is recorded honestly
    // rather than being suppressed by the earlier review.
    s.set('picked', 'artifact-3', 'auto')
    expect(s.originOf('picked')).toBe('auto')
    s.dispose()
  })
})

describe('TEST-5 (binding-origin / ITEM-3) — an unwritten path, and the dotted path', () => {
  beforeEach(() => __resetInstanceRegistryForTests())

  it('a field never written reports undefined, NOT user', () => {
    // It still holds the spec's DECLARED default, which is not in this vocabulary (DEC-3):
    // a declared default is the package author's consent, and calling it `user` would claim
    // a human looked at it.
    const s = createViewStore(bindableSpec(), 'v-untouched')
    expect(s.originOf('picked')).toBeUndefined()
    expect(s.originOf('nothing.at.all')).toBeUndefined()
    s.dispose()
  })

  it('a PARENT path reports the strongest origin written beneath it', () => {
    // This assertion used to say the opposite, and it was CERTIFYING A BUG. A declaration and
    // the write that satisfies it are routinely different paths: a shipped view declares its
    // input as a bare `$state.<field>` while the control filling it writes an INDEXED child,
    // one entry per repeated row. With an exact-key lookup the slot the run consumes reported
    // `undefined` — so a DECLARED auto-bind could never report its own origin, and the run
    // went out claiming nothing was guessed.
    const s = createViewStore(bindableSpec(), 'v-dotted')
    s.set('picked.inner', 'artifact-1', 'auto')
    expect(s.originOf('picked.inner')).toBe('auto')
    expect(s.originOf('picked')).toBe('auto')
    s.dispose()
  })

  it('a `user` parent does NOT launder an `auto` child (the multi-field write)', () => {
    // A shipped action sets TWO fields in one body — the value the user picked and a RESET
    // of the dependent list beside it — so the reset carries the gesture's `user`. Each
    // repeated control then auto-binds its sole candidate beneath it. Reporting `user` for that slot would be a
    // fabricated review, and it is the UNDER-report — the direction the design names as the
    // defect rather than the tolerable false alarm.
    const s = createViewStore(bindableSpec(), 'v-launder')
    s.set('picked', [], 'user')
    s.set('picked.0', 'artifact-1', 'auto')
    expect(s.originOf('picked')).toBe('auto')
    s.dispose()
  })

  it('a WHOLESALE parent write clears the origins beneath it (INV-5, unclearably otherwise)', () => {
    // Found by the round-2 audit as a defect the round-1 fix CREATED: widening the READ to a
    // subtree fold without pruning on write leaves an `auto` at `f.0` surviving a wholesale
    // `set('f', …, 'user')`, and the parent read folds it straight back in. The slot the user
    // has just answered is then permanently unreviewable — INV-5 failing in the one direction
    // no gesture can clear.
    const s = createViewStore(bindableSpec(), 'v-prune')
    s.set('picked.0', 'artifact-1', 'auto')
    expect(s.originOf('picked')).toBe('auto')
    s.set('picked', 'artifact-2')
    expect(s.originOf('picked')).toBe('user')
    s.dispose()
  })

  it('a SIBLING whose name merely starts the same is not folded in', () => {
    // A separator check, not a bare `startsWith`: `pickedExtra` is a different field, and
    // reading it as part of `picked` would over-report on an unrelated control.
    const s = createViewStore(bindableSpec(), 'v-sibling')
    s.set('picked', 'artifact-1', 'user')
    s.set('pickedExtra', 'artifact-2', 'auto')
    expect(s.originOf('picked')).toBe('user')
    s.dispose()
  })
})

describe('TEST-5 (binding-origin / ITEM-3) — [acceptance] [invariant: INV-4] an absence stays an absence', () => {
  beforeEach(() => __resetInstanceRegistryForTests())

  it('originOf answers undefined, and a write never manufactures an origin for a sibling', () => {
    // The store half of INV-4. (The gate half — that no verdict turns on origin at all —
    // lives with the gate, in `extensions/analysis/inputEconomy.test.ts` as TEST-6: `core`
    // may not import an extension, and asserting it from here would be the layer-boundary
    // violation the lint refuses.)
    const s = createViewStore(bindableSpec(), 'v-inv4')
    expect(s.originOf('picked')).toBeUndefined()
    s.set('picked', 'artifact-1', 'auto')
    expect(s.originOf('other')).toBeUndefined()
    s.dispose()
  })
})

// The three tests below drove the mirror through a `scope: pane` field named `axis`, moved by
// `paneScopeStore.setAxis`. Neither survives (owner, 2026-08-13): the pane's anchor control is
// deleted, `axis` is DERIVED from the chosen coordinate and a view that writes it is REFUSED at
// the seam — so a spec declaring `axis` as its pane field would be testing the mirror through a
// write the store rejects, and the "value changed" step could never happen.
//
// The pane field is therefore `coordinate` — the pane's ONE user-writable value, and the one an
// author actually ships. Nothing about what these assert moves: the subject is `syncPaneScope`
// dropping the origin it invalidated, and the mirror does not care which key it mirrors.
describe('TEST-5 (binding-origin / ITEM-3) — syncPaneScope drops the origin it invalidated', () => {
  beforeEach(() => {
    __resetInstanceRegistryForTests()
    paneScopeStore.getState().reset()
  })

  it('a pane re-seed that CHANGES the value drops that field\'s recorded origin', () => {
    // Carrying it would be the stale-pair defect in miniature: another section moves the pane's
    // coordinate, and an origin left behind would go on describing how a value nobody holds any
    // more was chosen. Absence is the honest answer, and the authority for a pane-scoped
    // field's origin is the pane store, not this mirror.
    const spec = {
      id: 'origin/pane',
      title: 'Pane',
      permission: 'studies::use',
      state: { coordinate: { type: 'string', default: null, scope: 'pane' } },
      const: {},
      derived: {},
      widgets: [],
    } as unknown as ViewSpec

    paneScopeStore.getState().bindProject('p1')
    const s = createViewStore(spec, 'v-pane')
    s.set('coordinate', 'artifact-a', 'auto')
    expect(s.originOf('coordinate')).toBe('auto')

    // Another section moves the pane. This view's mirror follows on the next sync.
    paneScopeStore.getState().setValue('coordinate', 'artifact-b')
    s.syncPaneScope()
    expect(s.state.coordinate).toBe('artifact-b')
    expect(s.originOf('coordinate')).toBeUndefined()
    s.dispose()
  })

  it('a pane re-seed drops the origins BENEATH the field too, not just its exact key', () => {
    // The write-side twin of the fold, and the second half of the same asymmetry. `set`
    // explicitly anticipates a dotted write under a pane-scoped root (its `root === field`
    // guard exists for exactly that case), so a descendant origin can outlive the value it
    // described and then be folded back in by the parent read — which is precisely what the
    // comment above the delete promises against.
    const spec = {
      id: 'origin/pane3',
      title: 'Pane',
      permission: 'studies::use',
      state: { coordinate: { type: 'string', default: null, scope: 'pane' } },
      const: {},
      derived: {},
      widgets: [],
    } as unknown as ViewSpec

    paneScopeStore.getState().bindProject('p3')
    const s = createViewStore(spec, 'v-pane-3')
    s.set('coordinate.detail', 'sub', 'auto')
    expect(s.originOf('coordinate')).toBe('auto')

    paneScopeStore.getState().setValue('coordinate', 'artifact-z')
    s.syncPaneScope()
    // The orphan is gone with the value it described — absence, which is the honest answer.
    expect(s.originOf('coordinate')).toBeUndefined()
    s.dispose()
  })

  it('a re-seed that changes NOTHING leaves the recorded origin alone', () => {
    const spec = {
      id: 'origin/pane2',
      title: 'Pane',
      permission: 'studies::use',
      state: { coordinate: { type: 'string', default: null, scope: 'pane' } },
      const: {},
      derived: {},
      widgets: [],
    } as unknown as ViewSpec

    paneScopeStore.getState().bindProject('p2')
    const s = createViewStore(spec, 'v-pane-2')
    s.set('coordinate', 'artifact-a', 'auto')
    s.syncPaneScope()
    expect(s.originOf('coordinate')).toBe('auto')
    s.dispose()
  })
})

// ══════════════════════════════════════════════════════════════════════════════════
// T2 — the coercer fork is pinned AT THIS CALL SITE, behaviourally.
//
// `columnCoerce` exports two number coercions that differ ONLY on a missing entry:
// `asNumsNaNMissing` (→ NaN, dropped downstream) and `asNumsZeroMissing` (→ 0, counted).
// `store.ts` aliases `asNums = asNumsNaNMissing`. Its own unit tests both stay green when
// that alias is swapped, and so did the entire 246-file UI suite — the fork was documented
// but not measured anywhere the derived pipeline actually runs.
//
// So assert the SEMANTICS through the real `createViewStore` → `evalDerivedEntry` → `extent`
// path, not the identity of the imported symbol (which a re-export or a re-alias would hide).
//
// WHEN THE DEFECT IS PRESENT (store.ts:135 aliased to `asNumsZeroMissing`) the missing entry
// coerces to a real 0, `extent` counts it, and the observed lower bound is 0 instead of 5 —
// i.e. a blank entry silently drags a domain / a threshold / a filter boundary to zero.
// ══════════════════════════════════════════════════════════════════════════════════

describe('T2 — a MISSING entry is NaN (dropped), never 0, on the derived path', () => {
  function extentSpec(): ViewSpec {
    return {
      id: 'qc/extent',
      title: 'Extent',
      permission: 'studies::use',
      state: {},
      const: {},
      derived: { span: { extent: '$data.frame.depth' } },
      widgets: [],
      actions: [],
    } as unknown as ViewSpec
  }

  it('a null in the column does NOT drag the extent down to 0', () => {
    const store = createViewStore(extentSpec(), 'view-coerce-1', {
      frame: { depth: [5, null, 9] },
    })
    // NaN-for-missing: `extent` skips the non-finite, so the domain is the REAL data range.
    // Zero-for-missing would report [0, 9].
    expect(store.derived.span).toEqual([5, 9])
    store.dispose()
  })

  it('an empty string and a boolean are missing too — all three drop, none become 0', () => {
    const store = createViewStore(extentSpec(), 'view-coerce-2', {
      frame: { depth: [5, '', false, undefined, 9] },
    })
    expect(store.derived.span).toEqual([5, 9])
    store.dispose()
  })

  it('a column that is ENTIRELY missing yields an empty extent, not [0, 0]', () => {
    const store = createViewStore(extentSpec(), 'view-coerce-3', {
      frame: { depth: [null, '', undefined] },
    })
    // Zero-for-missing would report [0, 0] — a fabricated domain that renders as a
    // legitimate-looking axis instead of "no data".
    expect(store.derived.span).toEqual([undefined, undefined])
    store.dispose()
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════
// TEST-43 (ITEM-35, DEC-D) — the FUSED-MEMBER-SET sidecar (`artifactsOf`).
//
// The twin of the origin sidecar, and under test for the same reason: a fused pick's stored
// VALUE is byte-identical to an ordinary one (the primary id, INV-4), so the only place the
// member set can be told from a single artifact is this companion fact. Every case pairs a
// fused write against an unfused one and asserts they are distinguishable.
// ══════════════════════════════════════════════════════════════════════════════════════════
describe('TEST-43 (member-set sidecar / ITEM-35) — [invariant: INV-4] a fused pick carries its whole set', () => {
  beforeEach(() => __resetInstanceRegistryForTests())

  it('records EVERY member, primary first, while the stored value stays the one primary id', () => {
    const s = createViewStore(bindableSpec(), 'v-fused')
    s.set('picked', 'a1', 'user', ['a1', 'b1'])
    // The value is the ONE primary — a composed/delimited id is exactly what INV-4 forbids.
    expect(s.state.picked).toBe('a1')
    // …and the member set travels beside it, order preserved.
    expect(s.artifactsOf('picked')).toEqual(['a1', 'b1'])
    s.dispose()
  })

  it('an UNFUSED write records no set — absence, never [] (negative control)', () => {
    const s = createViewStore(bindableSpec(), 'v-unfused')
    s.set('picked', 'a1')
    expect(s.artifactsOf('picked')).toBeUndefined()
    // An explicit empty array is treated as absence too — a real fusion always spans ≥2.
    s.set('picked', 'a1', 'user', [])
    expect(s.artifactsOf('picked')).toBeUndefined()
    s.dispose()
  })

  it('re-picking a plain artifact over a fused one CLEARS the set — the write-side twin of re-review', () => {
    const s = createViewStore(bindableSpec(), 'v-refuse')
    s.set('picked', 'a1', 'user', ['a1', 'b1'])
    expect(s.artifactsOf('picked')).toEqual(['a1', 'b1'])
    // A later ordinary pick of a single artifact must not leave the stale member set behind, or
    // the run would record members the user just deselected.
    s.set('picked', 'c1')
    expect(s.artifactsOf('picked')).toBeUndefined()
    s.dispose()
  })

  it('folds indexed children under a bare declared field, deduped and in path order', () => {
    const s = createViewStore(bindableSpec(), 'v-fold')
    // A repeated control writes children; a run declares the bare parent. `b1` is shared and
    // must appear once, in first-seen path order.
    s.set('picked.1', 'x1', 'user', ['x1', 'b1'])
    s.set('picked.0', 'a1', 'user', ['a1', 'b1'])
    expect(s.artifactsOf('picked')).toEqual(['a1', 'b1', 'x1'])
    s.dispose()
  })
})

// draftable-entity ITEM-10 — the `$state`↔draft binding. A `draftable` view seeds
// each declared state field from the persisted `draft.data` (falling back to the
// field `default`), and every `set()` persists the new `$state` back. The binding is
// INERT when absent — proven by the unchanged behaviour above.
describe('createViewStore — draftable binding (ITEM-10)', () => {
  function draftableSpec(): ViewSpec {
    return {
      id: 'test/widget-editor',
      title: 'Widget editor',
      permission: 'drafts::use',
      state: {
        items: { type: 'list', default: [] },
        title: { type: 'text', default: 'untitled' },
      },
      const: {},
      derived: {},
      widgets: [],
      actions: [],
    }
  }

  it('seeds $state from draft.data, falling back to the field default', () => {
    // draft.data supplies `items` but not `title` → `items` from the draft, `title`
    // from the declared default.
    const persisted: unknown[] = []
    const store = createViewStore(draftableSpec(), 'draftable-seed', undefined, {
      data: { items: ['a', 'b'] },
      persist: s => persisted.push(s),
    })
    expect(store.state.items).toEqual(['a', 'b'])
    expect(store.state.title).toBe('untitled')
    expect(persisted).toHaveLength(0)
  })

  it('persists the new $state on every set()', () => {
    const persisted: Array<Record<string, unknown>> = []
    const store = createViewStore(draftableSpec(), 'draftable-persist', undefined, {
      data: { items: [] },
      persist: s => persisted.push({ ...s }),
    })
    store.set('title', 'my widget')
    store.set('items', [1, 2, 3])
    expect(persisted).toHaveLength(2)
    expect(persisted[0].title).toBe('my widget')
    expect(persisted[1].items).toEqual([1, 2, 3])
    // The persisted blob is the whole reactive state (opaque to core).
    expect(persisted[1].title).toBe('my widget')
  })

  it('is inert without a draftable binding (existing views unaffected)', () => {
    const store = createViewStore(draftableSpec(), 'draftable-absent')
    expect(store.state.items).toEqual([])
    expect(store.state.title).toBe('untitled')
    // A set() with no binding simply mutates — nothing to persist, no throw.
    expect(() => store.set('title', 'x')).not.toThrow()
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════════
// incremental-landing (#29) — chunk accumulation + coalesced derived recompute (ITEM-2/3)
// ════════════════════════════════════════════════════════════════════════════════════════════

// A neutral (domain-free) spec whose derived read the landed slice `s`, columns `a` (values) and
// `g` (group) — the fixtures below avoid domain vocabulary by construction.
function landSpec(): ViewSpec {
  return {
    id: 'x/land',
    title: 'Land',
    permission: 'jobs::use',
    state: { ranges: { type: 'map', default: {} } },
    const: {},
    derived: {
      hidden: { filter_mask: { values: '$data.s.a', group_of: '$data.s.g', ranges: '$state.ranges' } },
      counts: { count_by: { group: '$data.s.g', hidden: '$derived.hidden' } },
    },
    widgets: [],
    actions: [],
  } as unknown as ViewSpec
}

describe('TEST-4 — incremental derived recompute (ITEM-3)', () => {
  it('N chunks trigger FEWER than N full recomputes, and the final derived VALUES equal the wholesale result', () => {
    const spec = landSpec()
    const store = createViewStore(spec, 'v-inc')
    // A manual scheduler so the coalescing is deterministic + countable (DEC-8): partial chunks
    // schedule ONE flush here; the `done` chunk recomputes synchronously.
    const pending: Array<() => void> = []
    const restore = __setRecomputeSchedulerForTests(fn => pending.push(fn))
    try {
      const before = store.__derivedRecomputeCount
      const N = 4
      const epoch = 1
      store.beginLanding(epoch)
      // Chunks are CUMULATIVE (the producer accumulates the stream), so chunk i carries rows 0..i.
      const a = [10, 20, 30, 40]
      const g = ['A', 'A', 'A', 'A']
      for (let i = 0; i < N; i++) {
        store.landChunk(
          { s: { a: a.slice(0, i + 1), g: g.slice(0, i + 1) } },
          { done: i === N - 1, epoch },
        )
      }
      // Drain any still-pending coalesced flush.
      pending.forEach(fn => fn())
      const recomputes = store.__derivedRecomputeCount - before

      // COUNT leg: fewer than N full recomputes (the whole point — O(chunks×frame) is what this
      // avoids). A wholesale-per-chunk implementation would record N.
      expect(recomputes).toBeLessThan(N)
      expect(recomputes).toBeGreaterThan(0)

      // ACCUMULATION: every chunk's rows survive (ITEM-2) — chunk 1's `10` is still present, and NOT
      // duplicated (a delta-append store fed cumulative prefixes would produce [10,10,20,...]).
      expect(store.data).toEqual({ s: { a: [10, 20, 30, 40], g: ['A', 'A', 'A', 'A'] } })

      // VALUES leg: final derived byte-equals a WHOLESALE store over the same accumulated data.
      // (The count leg alone could pass with wrong values; the value leg alone passes with the
      // O(chunks×frame) wholesale recompute intact. Both, or neither means anything.)
      const wholesale = createViewStore(spec, 'v-whole', {
        s: { a: [10, 20, 30, 40], g: ['A', 'A', 'A', 'A'] },
      })
      expect(store.derived).toEqual(wholesale.derived)
      // The terminal chunk lands `ready`.
      expect(store.dataStatus).toBe('ready')
    } finally {
      restore()
    }
  })

  it('a landing REPLACES the slice object every chunk (never mutates) so the canvas memo re-reads it (ITEM-5)', () => {
    const store = createViewStore(landSpec(), 'v-rev')
    const epoch = 7
    store.beginLanding(epoch)
    store.landChunk({ s: { a: [1], g: ['A'] } }, { done: false, epoch })
    const first = store.data
    // CUMULATIVE: chunk 2 carries rows 0..1.
    store.landChunk({ s: { a: [1, 2], g: ['A', 'A'] } }, { done: true, epoch })
    const second = store.data
    // A NEW top-level object AND a new nested slice frame — identity changed, not a mutation.
    expect(second).not.toBe(first)
    expect((second as { s: unknown }).s).not.toBe((first as { s: unknown }).s)
    expect(store.data).toEqual({ s: { a: [1, 2], g: ['A', 'A'] } })
  })

  it('a chunk from a SUPERSEDED epoch is discarded; the live epoch keeps accumulating', () => {
    const store = createViewStore(landSpec(), 'v-sup')
    store.beginLanding(1)
    store.landChunk({ s: { a: [1], g: ['A'] } }, { done: false, epoch: 1 })
    // A new landing supersedes epoch 1.
    store.beginLanding(2)
    store.landChunk({ s: { a: [2], g: ['A'] } }, { done: false, epoch: 2 })
    // A LATE straggler from epoch 1 must NOT corrupt the live epoch-2 frame.
    store.landChunk({ s: { a: [999], g: ['Z'] } }, { done: false, epoch: 1 })
    // CUMULATIVE: epoch-2's next chunk carries rows 0..1 of its OWN sequence.
    store.landChunk({ s: { a: [2, 3], g: ['A', 'A'] } }, { done: true, epoch: 2 })
    expect(store.data).toEqual({ s: { a: [2, 3], g: ['A', 'A'] } })
  })
})
