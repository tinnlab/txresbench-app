import { describe, it, expect } from 'vitest'
import type { ActionMeta } from '@/core/actions/defineAction'
import { gateAction, gatePaletteActions, type PaletteGatingDeps } from './paletteGating'

// TEST-103 (PLAN.md ITEM-3) — the PURE palette gating predicate. An action is
// offered iff `surfaces.palette !== false` AND (`context === 'global'` OR the
// context is active) AND `hasPermissionNow`; a `kind:'instance'` action is
// additionally offered ONLY against the active focused instance (its `view_id`
// resolved from the injected `activeInstanceId`).

function meta(overrides: Partial<ActionMeta> = {}): ActionMeta {
  return {
    id: 'x.do',
    title: 'Do X',
    permission: 'projects::use',
    mutating: true,
    kind: 'global',
    stateful: false,
    dangerous: false,
    surfaces: { palette: true, ai: true },
    context: 'global',
    aliases: [],
    keywords: [],
    ...overrides,
  }
}

/** Deps builder — everything permits/active by default; override per case. */
function deps(overrides: Partial<PaletteGatingDeps> = {}): PaletteGatingDeps {
  return {
    isContextActive: () => true,
    hasPermission: () => true,
    activeInstanceId: () => 'view-1',
    ...overrides,
  }
}

describe('paletteGating.gateAction (ITEM-3)', () => {
  it('includes a global, permitted, palette-on action', () => {
    const gated = gateAction(meta(), deps())
    expect(gated).not.toBeNull()
    expect(gated?.meta.id).toBe('x.do')
    expect(gated?.viewId).toBeUndefined() // global → no target
  })

  it('EXCLUDES an action that opted out of the palette surface', () => {
    expect(gateAction(meta({ surfaces: { palette: false, ai: true } }), deps())).toBeNull()
  })

  it('EXCLUDES a non-global action whose context is inactive; INCLUDES it once active', () => {
    const scoped = meta({ context: 'workbench' })
    expect(gateAction(scoped, deps({ isContextActive: () => false }))).toBeNull()
    expect(gateAction(scoped, deps({ isContextActive: () => true }))).not.toBeNull()
  })

  it('EXCLUDES an action the user lacks permission for', () => {
    expect(gateAction(meta(), deps({ hasPermission: () => false }))).toBeNull()
  })

  it('offers a kind:"instance" action against the active focused instance via its view_id', () => {
    const instance = meta({ kind: 'instance', context: 'workbench' })
    const gated = gateAction(instance, deps({ activeInstanceId: ctx => (ctx === 'workbench' ? 'wb-view-7' : undefined) }))
    expect(gated).not.toBeNull()
    expect(gated?.viewId).toBe('wb-view-7')
  })

  it('EXCLUDES a kind:"instance" action when no focused instance exists', () => {
    const instance = meta({ kind: 'instance', context: 'workbench' })
    expect(gateAction(instance, deps({ activeInstanceId: () => undefined }))).toBeNull()
  })

  it('gatePaletteActions filters + preserves order', () => {
    const list = [
      meta({ id: 'a', kind: 'global' }),
      meta({ id: 'b', surfaces: { palette: false, ai: true } }), // dropped
      meta({ id: 'c', context: 'workbench' }),
    ]
    const out = gatePaletteActions(list, deps({ isContextActive: () => true }))
    expect(out.map(g => g.meta.id)).toEqual(['a', 'c'])
  })
})
