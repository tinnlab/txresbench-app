import { describe, it, expect, beforeEach } from 'vitest'
import {
  registerActiveContext,
  unregisterActiveContext,
  isContextActive,
  getActiveEntity,
  subscribeActiveContext,
  getActiveContextSnapshot,
  useActiveContext,
} from './activeContext'

// TEST-102 (PLAN.md ITEM-2) — the active-context module singleton. The hook
// (`useActiveContext`) is a thin mount/unmount wrapper over
// `registerActiveContext`/`unregisterActiveContext` (identical shape to
// `useAction` over the instance registry), so — with no React renderer in the
// node unit environment — these exercise the REGISTER/UNREGISTER primitives the
// hook drives (mount register → unmount unregister), plus snapshot stability.

function clearAll(): void {
  // Reset any residual registrations between tests (tests share the singleton).
  for (const name of Object.keys(getActiveContextSnapshot().byName)) {
    unregisterActiveContext(name)
  }
}

describe('activeContext — registry primitives (ITEM-2)', () => {
  beforeEach(clearAll)

  it('register makes a context active and readable; unregister clears it (the mount/unmount path)', () => {
    expect(isContextActive('workbench')).toBe(false)
    // mount:
    registerActiveContext('workbench')
    expect(isContextActive('workbench')).toBe(true)
    // unmount:
    unregisterActiveContext('workbench')
    expect(isContextActive('workbench')).toBe(false)
  })

  it('carries the optional entityId, read back via getActiveEntity', () => {
    registerActiveContext('dataset', { entityId: 'ds-42' })
    expect(isContextActive('dataset')).toBe(true)
    expect(getActiveEntity('dataset')).toBe('ds-42')
    // A context with no entity reads back undefined but is still active.
    registerActiveContext('workbench')
    expect(getActiveEntity('workbench')).toBeUndefined()
    expect(isContextActive('workbench')).toBe(true)
    // Cleared on unregister.
    unregisterActiveContext('dataset')
    expect(getActiveEntity('dataset')).toBeUndefined()
  })

  it('getActiveEntity / isContextActive are false/undefined for an inactive or "global" context', () => {
    expect(isContextActive('global')).toBe(false)
    expect(getActiveEntity('global')).toBeUndefined()
    expect(isContextActive('never')).toBe(false)
  })

  it('the useSyncExternalStore snapshot is a STABLE reference while unchanged, and bumps on change', () => {
    const before = getActiveContextSnapshot()
    // Two reads with no mutation between → same reference (Object.is stable).
    expect(getActiveContextSnapshot()).toBe(before)

    let notified = 0
    const unsub = subscribeActiveContext(() => {
      notified++
    })

    registerActiveContext('dataset', { entityId: 'ds-1' })
    const afterRegister = getActiveContextSnapshot()
    expect(afterRegister).not.toBe(before)
    expect(afterRegister.version).toBeGreaterThan(before.version)
    expect(afterRegister.byName.dataset).toEqual({ entityId: 'ds-1' })
    expect(notified).toBe(1)

    // A no-op re-register (identical entity) must NOT bump/notify.
    registerActiveContext('dataset', { entityId: 'ds-1' })
    expect(getActiveContextSnapshot()).toBe(afterRegister)
    expect(notified).toBe(1)

    // A changed entity bumps + notifies.
    registerActiveContext('dataset', { entityId: 'ds-2' })
    expect(getActiveContextSnapshot()).not.toBe(afterRegister)
    expect(notified).toBe(2)

    unsub()
    // After unsubscribe, further mutations don't notify this listener.
    unregisterActiveContext('dataset')
    expect(notified).toBe(2)
  })

  it('exports useActiveContext as the hook a surface calls on mount', () => {
    // Can't render a hook without a React renderer here (node env); assert it
    // exists + is a function — its register/unregister behavior is covered by
    // the primitive tests above (the hook is a mount/unmount wrapper).
    expect(typeof useActiveContext).toBe('function')
  })
})
