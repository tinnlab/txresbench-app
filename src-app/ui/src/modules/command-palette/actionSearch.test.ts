import { describe, it, expect } from 'vitest'
import { actionSearchTerms } from '@/core/actions/search'
import type { ActionMeta } from '@/core/actions/defineAction'

// TEST-2 (richer-actions ITEM-2) — `actionSearchTerms` (feeds cmdk `keywords` in the
// global ⌘K) collects title + group + aliases + keywords + description, so an action
// is findable by intent, not only its literal title.

function meta(o: Partial<ActionMeta>): ActionMeta {
  return {
    id: 'dataset.add',
    title: 'Add dataset',
    permission: 'projects::use',
    mutating: true,
    kind: 'global',
    stateful: false,
    dangerous: false,
    surfaces: { palette: true, ai: true },
    context: 'global',
    aliases: [],
    keywords: [],
    ...o,
  }
}

describe('actionSearchTerms (ITEM-2)', () => {
  it('includes title, group, every alias, every keyword, and the description', () => {
    const terms = actionSearchTerms(
      meta({
        group: 'Datasets',
        aliases: ['attach data', 'link dataset'],
        keywords: ['import'],
        description: 'Pick a dataset to link',
      }),
    )
    expect(terms).toContain('Add dataset')
    expect(terms).toContain('Datasets')
    expect(terms).toContain('attach data')
    expect(terms).toContain('link dataset')
    expect(terms).toContain('import')
    expect(terms).toContain('Pick a dataset to link')
  })

  it('includes only an EXPLICIT group (no derived fallback → no display/search divergence)', () => {
    const terms = actionSearchTerms(meta({ id: 'dataset.add', group: undefined }))
    expect(terms).not.toContain('Dataset')
    expect(terms).toContain('Add dataset') // still findable by title
  })

  it('drops empty/undefined terms', () => {
    const terms = actionSearchTerms(meta({ group: 'Datasets', description: undefined }))
    expect(terms.every(t => t.length > 0)).toBe(true)
  })
})
