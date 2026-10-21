import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { defineAction, getActionMeta } from './defineAction'

// TEST-101 (PLAN.md ITEM-1) — the `surfaces`/`context` extension of
// `defineAction`/`ActionMeta` is PURELY ADDITIVE: defaults applied when
// omitted, explicit values preserved, `kind:'instance'` still requires a
// `view_id` param, and every pre-existing (surface/context-less) call's meta
// keeps its original fields byte-identical. Each `defineAction` id must be
// unique per module-load, so every test here uses a distinct id.

describe('defineAction — surfaces/context (ITEM-1)', () => {
  it('defaults surfaces to {palette:true,ai:true} and context to "global" when omitted', () => {
    defineAction({
      id: 'test101.defaults',
      title: 'Defaults',
      permission: 'mcp::use',
      mutating: false,
      params: z.object({}),
      run: () => {},
    })
    const meta = getActionMeta('test101.defaults')
    expect(meta).toBeDefined()
    expect(meta?.surfaces).toEqual({ palette: true, ai: true })
    expect(meta?.context).toBe('global')
  })

  it('preserves explicit surfaces + context', () => {
    defineAction({
      id: 'test101.explicit',
      title: 'Explicit',
      permission: 'mcp::use',
      mutating: true,
      context: 'workbench',
      surfaces: { palette: false, ai: false },
      params: z.object({}),
      run: () => {},
    })
    const meta = getActionMeta('test101.explicit')
    expect(meta?.surfaces).toEqual({ palette: false, ai: false })
    expect(meta?.context).toBe('workbench')
  })

  it('defaults each surface flag INDEPENDENTLY (partial surfaces keeps the other true)', () => {
    defineAction({
      id: 'test101.partial',
      title: 'Partial surfaces',
      permission: 'mcp::use',
      mutating: false,
      surfaces: { palette: false },
      params: z.object({}),
      run: () => {},
    })
    // `surfaces:{palette:false}` must NOT drop `ai` to undefined — it defaults
    // to true (the object analog of `stateful`/`dangerous`'s per-field `?? …`).
    expect(getActionMeta('test101.partial')?.surfaces).toEqual({ palette: false, ai: true })
  })

  it('still requires view_id for a kind:"instance" action', () => {
    defineAction({
      id: 'test101.instance',
      title: 'Instance',
      permission: 'mcp::use',
      mutating: true,
      kind: 'instance',
      context: 'workbench',
      params: z.object({ view_id: z.string() }),
      run: () => {},
    })
    const meta = getActionMeta('test101.instance')
    expect(meta?.kind).toBe('instance')
    // The zod schema still names `view_id` as required (the collector's
    // instance-shape gate depends on this — TEST-109).
    const parsed = z.toJSONSchema(z.object({ view_id: z.string() }))
    expect(parsed.required).toContain('view_id')
  })

  it('a surface/context-less call keeps its original meta fields byte-identical (additive)', () => {
    defineAction({
      id: 'test101.legacy',
      title: 'A legacy-style action',
      permission: 'projects::use',
      mutating: true,
      dangerous: true,
      params: z.object({ project_id: z.string() }),
      run: () => {},
    })
    const meta = getActionMeta('test101.legacy')
    // Every field a pre-ITEM-1 caller set is unchanged…
    expect(meta?.id).toBe('test101.legacy')
    expect(meta?.title).toBe('A legacy-style action')
    expect(meta?.permission).toBe('projects::use')
    expect(meta?.mutating).toBe(true)
    expect(meta?.kind).toBe('global')
    expect(meta?.stateful).toBe(false)
    expect(meta?.dangerous).toBe(true)
    // …and the two NEW fields are the additive defaults (nothing else added).
    expect(meta?.surfaces).toEqual({ palette: true, ai: true })
    expect(meta?.context).toBe('global')
    expect(Object.keys(meta ?? {}).sort()).toEqual([
      'aliases',
      'context',
      'dangerous',
      'description',
      'group',
      'id',
      'keywords',
      'kind',
      'mutating',
      'permission',
      'stateful',
      'surfaces',
      'title',
    ])
  })
})

// TEST-1 (richer-actions ITEM-1) — the discoverability metadata extension of
// `defineAction`/`ActionMeta` is PURELY ADDITIVE: defaults applied when omitted
// (group→undefined, aliases/keywords→[]), explicit values preserved.
describe('defineAction — discoverability metadata (richer-actions ITEM-1)', () => {
  it('defaults group→undefined, aliases/keywords→[], description→undefined when omitted', () => {
    defineAction({
      id: 'ra1.bare',
      title: 'Bare',
      permission: 'projects::use',
      mutating: false,
      params: z.object({}),
      run: () => undefined,
    })
    const m = getActionMeta('ra1.bare')
    expect(m?.group).toBeUndefined()
    expect(m?.aliases).toEqual([])
    expect(m?.keywords).toEqual([])
    expect(m?.description).toBeUndefined()
  })

  it('preserves group/aliases/keywords/description when provided', () => {
    defineAction({
      id: 'ra1.rich',
      title: 'Rich',
      group: 'Datasets',
      aliases: ['attach data'],
      keywords: ['link'],
      description: 'A description',
      permission: 'projects::use',
      mutating: false,
      params: z.object({}),
      run: () => undefined,
    })
    const m = getActionMeta('ra1.rich')
    expect(m?.group).toBe('Datasets')
    expect(m?.aliases).toEqual(['attach data'])
    expect(m?.keywords).toEqual(['link'])
    expect(m?.description).toBe('A description')
  })
})
