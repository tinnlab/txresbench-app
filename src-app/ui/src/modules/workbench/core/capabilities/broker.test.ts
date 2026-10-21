// ITEM-6 — the capability broker. Routing is BY ID ONLY; absence is a VALUE, not a
// throw; a version outside the requested range is absent; a re-publish is
// idempotent-with-warning. Plus the INV-6 guard: nothing under `core/capabilities`
// may NAME or TYPE a specific capability.

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createCapabilityBroker, resolveOrThrow } from './broker.ts'
import {
  registerCapabilityProvider,
  installRegisteredCapabilities,
  registeredCapabilityIds,
  __resetCapabilityProvidersForTests,
} from './providers.ts'

interface Greeter {
  greet(): string
}

describe('capability broker', () => {
  it('round-trips publish → resolve for an id', () => {
    const broker = createCapabilityBroker()
    const impl: Greeter = { greet: () => 'hi' }
    broker.publish('acme.greeter', '1.2.0', impl)

    const found = broker.resolve<Greeter>('acme.greeter')
    expect(found.present).toBe(true)
    if (!found.present) throw new Error('unreachable')
    expect(found.version).toBe('1.2.0')
    expect(found.value.greet()).toBe('hi')
    expect(broker.has('acme.greeter')).toBe(true)
    expect(broker.ids()).toEqual(['acme.greeter'])
  })

  it('returns a typed ABSENT result — never throws — for an unpublished id', () => {
    const broker = createCapabilityBroker()
    let found: ReturnType<typeof broker.resolve<Greeter>> | undefined
    expect(() => {
      found = broker.resolve<Greeter>('acme.missing')
    }).not.toThrow()
    expect(found).toEqual({ present: false, reason: 'not-published' })
    expect(broker.has('acme.missing')).toBe(false)
  })

  it('resolves ABSENT when the published version falls outside the requested range', () => {
    const broker = createCapabilityBroker()
    broker.publish('acme.greeter', '2.0.0', { greet: () => 'hi' })

    expect(broker.resolve<Greeter>('acme.greeter', '^1')).toEqual({
      present: false,
      reason: 'out-of-range',
      publishedVersion: '2.0.0',
    })
    // …and PRESENT when it is inside.
    expect(broker.resolve<Greeter>('acme.greeter', '^2').present).toBe(true)
    // No range → version-agnostic.
    expect(broker.resolve<Greeter>('acme.greeter').present).toBe(true)
  })

  it('is idempotent on an identical re-publish and warns-but-keeps-the-first otherwise', () => {
    const broker = createCapabilityBroker()
    const first: Greeter = { greet: () => 'first' }
    const second: Greeter = { greet: () => 'second' }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    broker.publish('acme.greeter', '1.0.0', first)
    broker.publish('acme.greeter', '1.0.0', first) // identical → silent no-op
    expect(warn).not.toHaveBeenCalled()

    broker.publish('acme.greeter', '1.1.0', second) // different → warn, first wins
    expect(warn).toHaveBeenCalledTimes(1)
    const found = broker.resolve<Greeter>('acme.greeter')
    expect(found.present && found.value.greet()).toBe('first')
    expect(found.present && found.version).toBe('1.0.0')
    expect(broker.ids()).toEqual(['acme.greeter'])
    warn.mockRestore()
  })

  it('resolveOrThrow surfaces a clear error for both absent reasons', () => {
    const broker = createCapabilityBroker()
    expect(() => resolveOrThrow<Greeter>(broker, 'acme.greeter')).toThrow(/nothing is published/)
    broker.publish('acme.greeter', '1.0.0', { greet: () => 'hi' })
    expect(() => resolveOrThrow<Greeter>(broker, 'acme.greeter', '^3')).toThrow(/outside "\^3"/)
    expect(resolveOrThrow<Greeter>(broker, 'acme.greeter', '^1').greet()).toBe('hi')
  })
})

describe('capability providers', () => {
  it('instantiates registered providers into a broker, isolating a failing one', () => {
    __resetCapabilityProvidersForTests()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    registerCapabilityProvider<{ tag: string }>('acme.a', '1.0.0', ctx => ({ tag: ctx.tag }))
    registerCapabilityProvider('acme.boom', '1.0.0', () => {
      throw new Error('nope')
    })
    registerCapabilityProvider<{ tag: string }>('acme.b', '1.0.0', () => ({ ok: true }))
    // re-registering the same id is ignored (first declaration wins)
    registerCapabilityProvider('acme.a', '9.9.9', () => ({ tag: 'hijacked' }))
    expect(registeredCapabilityIds()).toEqual(['acme.a', 'acme.boom', 'acme.b'])

    const broker = createCapabilityBroker()
    installRegisteredCapabilities(broker, { tag: 'ctx' })
    expect(broker.ids()).toEqual(['acme.a', 'acme.b'])
    expect(broker.resolve<{ tag: string }>('acme.a')).toMatchObject({ present: true, value: { tag: 'ctx' } })
    expect(broker.resolve('acme.boom')).toEqual({ present: false, reason: 'not-published' })
    expect(error).toHaveBeenCalledTimes(1)
    error.mockRestore()
    __resetCapabilityProvidersForTests()
  })
})

describe('INV-6 — core/capabilities names no specific capability', () => {
  // A capability's CONTRACT belongs to the extension that publishes it. If core ever
  // declares (or type-imports) a name like `DataApi` / `JobHandle` / `SelectionApi` /
  // `ComputeHost` / `CommandRegistry`, routing has stopped being id-only.
  const FORBIDDEN = /data|selection|job|compute|command/i
  const DIR = fileURLToPath(new URL('.', import.meta.url))

  /** Every name this file DECLARES as a type, plus every name it TYPE-IMPORTS. */
  function declaredTypeNames(src: string): string[] {
    const names: string[] = []
    for (const m of src.matchAll(/\b(?:interface|type|class|enum)\s+([A-Za-z_$][\w$]*)/g)) names.push(m[1])
    for (const m of src.matchAll(/import\s+type\s*\{([^}]*)\}/g)) {
      for (const raw of m[1].split(',')) {
        const name = raw.trim().split(/\s+as\s+/).pop()?.trim()
        if (name) names.push(name)
      }
    }
    return names
  }

  it('declares/imports no capability-specific type name', () => {
    const files = readdirSync(DIR).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    expect(files.length).toBeGreaterThan(0)
    const offenders: string[] = []
    for (const f of files) {
      for (const name of declaredTypeNames(readFileSync(DIR + f, 'utf8'))) {
        if (FORBIDDEN.test(name)) offenders.push(`${f}: ${name}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
