import { describe, it, expect, beforeEach } from 'vitest'
import type { ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import {
  __resetInstanceRegistryForTests,
  getInstanceRecord,
} from '@/core/actions/instanceRegistry'
import { getViewStore, __resetViewStoresForTests } from '@/modules/workbench/core/runtime/viewStores'
import { __resetRegisteredSpecsForTests } from '@/modules/workbench/core/runtime/interpreter'
import { __resetBuiltinWidgetsForTests } from '@/modules/workbench/extensions'
import {
  retain,
  release,
  peekStore,
  __resetDeclarativeMountsForTests,
  destroy,
} from './declarativeMount'

// TEST — the MOUNT coordinator's retain/release/re-retain lifecycle (findings #1/#3):
// React.StrictMode double-invokes a mount effect as retain → release → retain, so the
// coordinator MUST end that cycle with exactly ONE live, registered store — never a
// disposed/unregistered one. This is the framework-free proof of the StrictMode fix
// (a jsdom StrictMode render is exercised indirectly by the other suites; this pins the
// coordinator invariant directly).

function spec(): ViewSpec {
  return {
    id: 'mount/qc',
    title: 'Mount QC',
    permission: 'jobs::use',
    state: { n: { type: 'number', default: 0 } },
    const: {},
    derived: {},
    widgets: [],
    actions: [],
  }
}

const VIEW = 'mount-view-1'

beforeEach(() => {
  __resetDeclarativeMountsForTests()
  __resetViewStoresForTests()
  __resetInstanceRegistryForTests()
  __resetRegisteredSpecsForTests()
  __resetBuiltinWidgetsForTests()
})

describe('declarativeMount — StrictMode-correct lifecycle', () => {
  it('retain → release → retain (StrictMode) leaves exactly one live, registered store', () => {
    const s = spec()

    // First StrictMode retain: creates + registers the store.
    const first = retain(s, VIEW)
    expect(peekStore(VIEW)).toBe(first)
    expect(getViewStore(VIEW)).toBe(first)
    expect(getInstanceRecord(VIEW)).toBeDefined()

    // StrictMode cleanup: refs → 0. The store SURVIVES — see the lifetime case below for why
    // disposing here destroyed a user's state on an ordinary tab switch.
    release(VIEW)
    const kept = peekStore(VIEW)
    expect(kept).toBeDefined()
    expect(getViewStore(VIEW)).toBe(kept)
    expect(getInstanceRecord(VIEW)).toBeDefined()

    // StrictMode re-retain: the SAME live store, still registered and still usable. Under the
    // old lifetime this had to recreate one; recreating is exactly what lost the state.
    const second = retain(s, VIEW)
    expect(second).toBe(kept)
    expect(peekStore(VIEW)).toBe(second)
    expect(getViewStore(VIEW)).toBe(second)
    expect(getInstanceRecord(VIEW)).toBeDefined()

    // The recreated store is fully functional — a `set` mutates + recomputes without throwing.
    expect(() => second.set('n', 5)).not.toThrow()
    expect(second.state.n).toBe(5)
  })

  it('shares ONE store across regions and SURVIVES the last release', () => {
    // This case used to assert the store was disposed once the last region released it, and
    // that produced a real data loss. A region unmounts whenever its pane stops being the
    // ACTIVE tab, so "the last region released it" means "the user switched tabs" — after
    // which they returned to a form reset to defaults and a canvas with no plots, having
    // changed nothing.
    //
    // The lifetime now belongs to the PANE, which survives a tab switch. `release` is
    // bookkeeping; `destroy` is the end of life, and only a pane-close path calls it.
    const s = spec()
    const a = retain(s, VIEW) // region A
    const b = retain(s, VIEW) // region B (same view_id)
    expect(a).toBe(b)
    expect(peekStore(VIEW)).toBe(a)

    release(VIEW) // region A unmounts — store still live for B
    expect(peekStore(VIEW)).toBe(a)
    expect(getViewStore(VIEW)).toBe(a)

    release(VIEW) // the LAST region unmounts (a tab switch) — the user's state must survive
    expect(
      peekStore(VIEW),
      'switching away from a tab must not destroy what the user built in it',
    ).toBe(a)
    expect(getViewStore(VIEW)).toBe(a)

    // Re-mounting (switching BACK) returns the very same store, not a fresh one at defaults.
    expect(retain(s, VIEW)).toBe(a)
    release(VIEW)

    // Closing the pane is what ends it.
    destroy(VIEW)
    expect(peekStore(VIEW)).toBeUndefined()
    expect(getViewStore(VIEW)).toBeUndefined()
    expect(getInstanceRecord(VIEW)).toBeUndefined()
  })

  it('a same-view_id remount does not let the OLD store dispose the LIVE record (finding #3)', () => {
    // The hazard is unchanged — a stale store object disposing late must not delete the record
    // of the store that replaced it — but the way to REACH a replacement moved. `release` no
    // longer disposes (a tab switch must not destroy state), so the sequence that produces a
    // genuinely new store under one id is now close-then-reopen: `destroy` then `retain`.
    const s = spec()
    const first = retain(s, VIEW)
    const firstRecord = getInstanceRecord(VIEW)
    release(VIEW) // the region unmounts — `first` survives, by design
    destroy(VIEW) // the PANE closes — now `first` is disposed and unregistered
    const second = retain(s, VIEW) // reopened: new store + NEW record under the same id
    const secondRecord = getInstanceRecord(VIEW)
    expect(second).not.toBe(first)
    expect(secondRecord).not.toBe(firstRecord)

    // Disposing the OLD store (identity-guarded) must NOT delete the live remounted record.
    first.dispose()
    expect(getInstanceRecord(VIEW)).toBe(secondRecord)
    expect(peekStore(VIEW)).toBe(second)
  })
})
