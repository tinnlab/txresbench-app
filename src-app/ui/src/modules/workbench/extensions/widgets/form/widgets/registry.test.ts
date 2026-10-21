// TEST-514 (ITEM-53) — the OPEN Tier-3 widget seam. Written in VITEST style
// (`describe/it/expect`) since the app's `npx vitest` pass is the gate (a `node:test`
// file reports "no tests" under vitest). Node env, no DOM: we assert on the seam +
// resolver contract (register → resolvable; unknown → `makeStubWidget` fallback, no
// throw), not a rendered tree — the real widget RENDER is the e2e (TEST-515).

import { describe, it, expect, beforeEach } from 'vitest'
import {
  registerWidget,
  getWidget,
  resolveWidget,
  registeredWidgetKinds,
  __resetWidgetRegistry,
  type HostWidget,
} from './registry'
import { makeStubWidget } from './StubWidget'

const Fake: HostWidget = () => null
Fake.displayName = 'FakeWidget'

beforeEach(() => __resetWidgetRegistry())

describe('widget registry seam', () => {
  it('registerWidget adds a kind to the seam and a known kind resolves to it', () => {
    expect(getWidget('fake')).toBeUndefined()
    registerWidget('fake', Fake)
    expect(getWidget('fake')).toBe(Fake)
    expect(resolveWidget('fake')).toBe(Fake)
    expect(registeredWidgetKinds()).toEqual(['fake'])
  })

  it('is last-wins on re-register (HMR-safe)', () => {
    const A: HostWidget = () => null
    const B: HostWidget = () => null
    registerWidget('w', A)
    registerWidget('w', B)
    expect(resolveWidget('w')).toBe(B)
  })

  it('resolves an unknown kind to a makeStubWidget fallback — never undefined, never a throw', () => {
    const resolved = resolveWidget('does-not-exist')
    expect(typeof resolved).toBe('function')
    // The fallback is a stub (matches `makeStubWidget`'s displayName contract).
    expect(String((resolved as HostWidget).displayName)).toMatch(/^StubWidget\(/)
    // Rendering it (calling the component fn) must not throw and yields a real element.
    const el = (resolved as (p: { value: unknown; onChange: () => void }) => unknown)({
      value: undefined,
      onChange: () => {},
    })
    expect(el).toBeTruthy()
  })

  it('makeStubWidget builds an inert, labeled placeholder component (the generic fallback)', () => {
    const Stub = makeStubWidget('Colormap picker')
    expect(typeof Stub).toBe('function')
    expect(Stub.displayName).toBe('StubWidget(Colormap picker)')
    expect((Stub as (p: { value: unknown; onChange: () => void }) => unknown)({ value: 1, onChange: () => {} })).toBeTruthy()
  })

  it('registeredWidgetKinds is id-sorted (deterministic introspection / window seam)', () => {
    registerWidget('zebra', Fake)
    registerWidget('alpha', Fake)
    expect(registeredWidgetKinds()).toEqual(['alpha', 'zebra'])
  })
})
