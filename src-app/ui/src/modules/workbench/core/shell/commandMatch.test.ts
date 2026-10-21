import { describe, it, expect } from 'vitest'
import { actionMatches } from '@/core/actions/search'
import type { ActionMeta } from '@/core/actions/defineAction'

// TEST-3 (richer-actions ITEM-3) — the workbench command palette's filter matches an
// action on ANY of title/alias/keyword/description (not only the title), so a user's
// own word finds the command.

function meta(o: Partial<ActionMeta>): ActionMeta {
  return {
    id: 'dataset.add',
    title: 'Add dataset',
    permission: 'projects::use',
    mutating: true,
    kind: 'instance',
    stateful: false,
    dangerous: false,
    surfaces: { palette: true, ai: true },
    context: 'workbench',
    aliases: [],
    keywords: [],
    ...o,
  }
}

describe('actionMatches (ITEM-3)', () => {
  it('matches on an ALIAS, not only the title', () => {
    const m = meta({ aliases: ['attach data'] })
    expect(actionMatches(m, 'attach data')).toBe(true)
    expect(actionMatches(m, 'attach')).toBe(true)
  })

  it('matches on a keyword and on the description', () => {
    expect(actionMatches(meta({ keywords: ['import'] }), 'import')).toBe(true)
    expect(actionMatches(meta({ description: 'pick a dataset' }), 'pick')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(actionMatches(meta({ aliases: ['Attach Data'] }), 'attach')).toBe(true)
  })

  it('rejects a non-matching query', () => {
    expect(actionMatches(meta({}), 'zzznope')).toBe(false)
  })

  it('an empty query matches everything', () => {
    expect(actionMatches(meta({}), '')).toBe(true)
    expect(actionMatches(meta({}), '   ')).toBe(true)
  })
})
