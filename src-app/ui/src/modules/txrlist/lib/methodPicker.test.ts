/**
 * TEST-UL-15 (qa-fixes3 ITEM-1) — txrlist `lib/methodPicker.ts`: the pure
 * picker rules (recommendation, presets, sort, search/filter, reason
 * groups). The component renders these; the rules' contracts are here.
 */
import { describe, expect, it } from 'vitest'
import type { TxrMethodCard } from '../types'
import {
  activePreset,
  fastSelection,
  filterMethodCards,
  presetOf,
  presetSelection,
  reasonGroups,
  recheckFailedLine,
  recheckLine,
  recommendedSelection,
  runnableCards,
  sortCards,
  TXRMETHOD_GROUP_ORDER,
  TXRMETHOD_RECOMMEND_CAP,
  TXRMETHOD_RECOMMEND_PER_FAMILY,
  TXRMETHOD_REASON_GROUPS,
} from './methodPicker'

/** One synthetic card (the facts the rules read). */
function card(over: Partial<TxrMethodCard> & { id: string }): TxrMethodCard {
  const { id, ...rest } = over
  return {
    key: id,
    id,
    title: id,
    summary: `Summary of ${id}.`,
    paperTitle: null,
    group: 'response-probability',
    groupLabel: 'Response probability',
    language: 'R',
    journal: 'Fixture Journal',
    year: 2020,
    paperDoi: '',
    estimate: { seconds: 120, quality: 'measured' },
    rank: null,
    needs: { markers: '1 marker', covariates: null, draws: '1+ draws' },
    run: {
      status: 'can',
      coverageLine: 'all 151 patients',
      reasonCode: null,
      reasonLine: 'all 151 patients',
      reasonLines: ['all 151 patients'],
      reasonFix: '',
      disabled: false,
    },
    ...rest,
  }
}

const RUNNABLE = [
  card({ id: 'a', group: 'response-call', rank: { median: 0.7, kind: 'c-index', nDatasets: 8 }, estimate: { seconds: 300, quality: 'measured' } }),
  card({ id: 'b', group: 'response-call', rank: { median: 0.8, kind: 'c-index', nDatasets: 12 }, estimate: { seconds: 60, quality: 'measured' } }),
  card({ id: 'c', group: 'response-probability', rank: { median: 0.75, kind: 'c-index', nDatasets: 5 }, estimate: { seconds: 30, quality: 'measured' } }),
  card({ id: 'd', group: 'response-probability', estimate: { seconds: 20, quality: 'estimate' } }),
  card({ id: 'e', group: 'static-risk', rank: { median: 0.55, kind: 'c-index', nDatasets: 4 }, estimate: { seconds: 10, quality: 'measured' } }),
  card({ id: 'f', group: 'static-risk', estimate: { seconds: 3000, quality: 'estimate' } }),
  card({ id: 'g', group: 'dynamic-risk', rank: { median: 0.9, kind: 'c-index', nDatasets: 9 }, estimate: { seconds: 900, quality: 'estimate' } }),
]

describe('runnableCards / recommendedSelection (the plan: up to 8, at most 3 per family, best benchmark first)', () => {
  it('a cannot card is never runnable', () => {
    const cannot = card({ id: 'x', run: { status: 'cannot', coverageLine: '', reasonCode: 'ENV_IMAGE_MISSING', reasonLine: 'no published environment available', reasonLines: ['no published environment available'], reasonFix: 'This method is not available yet.', disabled: true } })
    expect(runnableCards([...RUNNABLE, cannot]).map(c => c.id)).not.toContain('x')
  })

  it('the recommendation caps at 8 / 3 per family, ranks benchmark desc with fastest tie-break', () => {
    const recommended = recommendedSelection(RUNNABLE)
    expect(recommended.length).toBeLessThanOrEqual(TXRMETHOD_RECOMMEND_CAP)
    const byFamily = new Map<string, number>()
    for (const id of recommended) {
      const member = RUNNABLE.find(c => c.id === id)!
      byFamily.set(member.group, (byFamily.get(member.group) ?? 0) + 1)
    }
    for (const count of byFamily.values()) {
      expect(count).toBeLessThanOrEqual(TXRMETHOD_RECOMMEND_PER_FAMILY)
    }
    // b (0.80) before a (0.70); g (0.90) first; c (0.75) before d (no rank);
    // e's rank has nDatasets < 5 so it ranks by time (fastest).
    expect(recommended.slice(0, 3)).toEqual(['g', 'b', 'c'])
  })

  it('deterministic across calls', () => {
    expect(recommendedSelection(RUNNABLE)).toEqual(recommendedSelection(RUNNABLE))
  })

  it('the fastest fallback is used for cards with no usable benchmark', () => {
    const noRank = RUNNABLE.filter(c => c.rank === null || c.rank.nDatasets < 5)
    const chosen = recommendedSelection(noRank)
    expect(chosen[0]).toBe('e') // 10 s — fastest
  })
})

describe('presets (presetSelection / presetOf)', () => {
  it('all selects every runnable key; none clears; fast takes the under-a-minute ones', () => {
    expect(presetSelection('all', RUNNABLE)).toEqual(RUNNABLE.map(c => c.id))
    // The fast preset keeps the catalogue's order (the rule set does not
    // reorder; the picker's sort is a separate control).
    expect(presetSelection('fast', RUNNABLE)).toEqual(['c', 'd', 'e'])
    expect(presetSelection('none', RUNNABLE)).toEqual([])
  })

  it('presetOf recognises the presets and reports custom for a manual tick', () => {
    // A catalogue that exceeds the recommendation caps (9 methods, 4th
    // dynamic-risk): the recommended set is NOT the all set, so 'all' is
    // a preset of its own.
    const overCap = [
      ...RUNNABLE,
      card({ id: 'h', group: 'dynamic-risk', estimate: { seconds: 2000, quality: 'estimate' } }),
      card({ id: 'i', group: 'dynamic-risk', estimate: { seconds: 4000, quality: 'estimate' } }),
    ]
    expect(presetOf(new Set(presetSelection('all', overCap)), overCap)).toBe('all')
    expect(presetOf(new Set(presetSelection('recommended', overCap)), overCap)).toBe('recommended')
    expect(presetOf(new Set(presetSelection('none', RUNNABLE)), RUNNABLE)).toBe('none')
    expect(presetOf(new Set(['a']), RUNNABLE)).toBe('custom')
  })
})

describe('activePreset (the pressed preset button, step-4 fix)', () => {
  // Three runnable methods, one per family, every estimate under a minute:
  // Recommended = All = Fast = the same three (the user's Mac had this
  // shape: 5 runnable methods, Recommended = All).
  const EQUAL = [
    card({ id: 'q1', group: 'response-call', estimate: { seconds: 10, quality: 'measured' } }),
    card({ id: 'q2', group: 'static-risk', estimate: { seconds: 20, quality: 'measured' } }),
    card({ id: 'q3', group: 'dynamic-risk', estimate: { seconds: 30, quality: 'measured' } }),
  ]
  const everything = new Set(['q1', 'q2', 'q3'])

  it('the three presets give the same set here (the case under test)', () => {
    expect(presetSelection('recommended', EQUAL).sort()).toEqual(['q1', 'q2', 'q3'])
    expect(presetSelection('all', EQUAL).sort()).toEqual(['q1', 'q2', 'q3'])
    expect(presetSelection('fast', EQUAL).sort()).toEqual(['q1', 'q2', 'q3'])
  })

  it('the clicked preset wins while the selection equals its set', () => {
    expect(activePreset(everything, EQUAL, 'recommended')).toBe('recommended')
    expect(activePreset(everything, EQUAL, 'all')).toBe('all')
    expect(activePreset(everything, EQUAL, 'fast')).toBe('fast')
  })

  it('after a manual tick the selection decides (custom)', () => {
    const ticked = new Set(['q1', 'q2'])
    expect(activePreset(ticked, EQUAL, 'all')).toBe('custom')
  })

  it('with nothing clicked yet, the order is presetOf\'s (the seeded recommendation shows Recommended)', () => {
    expect(activePreset(everything, EQUAL, null)).toBe('recommended')
    expect(activePreset(everything, EQUAL, null)).toBe(presetOf(everything, EQUAL))
  })

  it('a chosen preset whose set no longer matches falls back to the matching one', () => {
    // The user chose Fast, then the selection became the over-cap All set.
    const overCap = [
      ...RUNNABLE,
      card({ id: 'h', group: 'dynamic-risk', estimate: { seconds: 2000, quality: 'estimate' } }),
      card({ id: 'i', group: 'dynamic-risk', estimate: { seconds: 4000, quality: 'estimate' } }),
    ]
    expect(activePreset(new Set(presetSelection('all', overCap)), overCap, 'fast')).toBe('all')
  })

  it('when no method is fast, None gives none (never "Fast only"), and presetOf of an empty selection is none', () => {
    const slow = EQUAL.map(c => ({ ...c, estimate: { seconds: 600, quality: 'measured' as const } }))
    expect(presetSelection('fast', slow)).toEqual([])
    expect(presetOf(new Set(), slow)).toBe('none')
    expect(activePreset(new Set(), slow, 'none')).toBe('none')
    expect(activePreset(new Set(), slow, null)).toBe('none')
    // Clicking Fast with no fast method selects nothing; the clicked button
    // is the one that shows.
    expect(activePreset(new Set(), slow, 'fast')).toBe('fast')
  })
})

describe('sortCards / filterMethodCards', () => {
  it('filters by id and by the search text and restores without a query', () => {
    const all = RUNNABLE.map(c => c.id)
    expect(filterMethodCards(RUNNABLE, 'b', new Set()).map(c => c.id)).toEqual(['b'])
    expect(filterMethodCards(RUNNABLE, '', new Set()).map(c => c.id)).toEqual(all)
    expect(filterMethodCards(RUNNABLE, '', new Set(['static-risk'])).map(c => c.id)).toEqual(
      RUNNABLE.filter(c => c.group === 'static-risk').map(c => c.id),
    )
  })

  it('sortCards orders by name, year, fastest and recommended', () => {
    const byName = sortCards(RUNNABLE, 'name').map(c => c.id)
    expect(byName).toEqual([...byName].sort())
    const byYear = sortCards(RUNNABLE, 'year')
    expect(byYear[0].year).toBeGreaterThanOrEqual(byYear[byYear.length - 1].year)
    expect(sortCards(RUNNABLE, 'fastest').map(c => c.id)).toEqual(['e', 'd', 'c', 'b', 'a', 'g', 'f'])
  })
})

describe('reasonGroups (the per-reason partition of the cannot cards)', () => {
  it('partitions the cannot cards by their first reason in the fixed order', () => {
    const cannot = [
      card({ id: 'n1', run: { status: 'cannot', coverageLine: '', reasonCode: 'ENV_IMAGE_MISSING', reasonLine: 'no published environment available', reasonLines: ['no published environment available'], reasonFix: '', disabled: true } }),
      card({ id: 'n2', run: { status: 'cannot', coverageLine: '', reasonCode: 'REQUIRED_MARKER_MISSING', reasonLine: 'needs LDH', reasonLines: ['needs LDH'], reasonFix: '', disabled: true } }),
      card({ id: 'n3', run: { status: 'cannot', coverageLine: '', reasonCode: 'MIN_DRAWS_UNMET', reasonLine: 'needs draws', reasonLines: ['needs draws'], reasonFix: '', disabled: true } }),
    ]
    const groups = reasonGroups([...RUNNABLE, ...cannot])
    expect(groups.map(g => g.key)).toEqual(['environment', 'marker', 'draws'])
    expect(groups.map(g => g.count)).toEqual([1, 1, 1])
    // The groups' counts sum to the cannot count — never a double count.
    expect(groups.reduce((sum, g) => sum + g.count, 0)).toBe(cannot.length)
  })

  it('an unknown reason code lands in the catch-all group (never dropped)', () => {
    const foreign = card({ id: 'z', run: { status: 'cannot', coverageLine: '', reasonCode: 'FOREIGN_CODE', reasonLine: 'cannot run with this file', reasonLines: ['cannot run with this file'], reasonFix: '', disabled: true } })
    const groups = reasonGroups([foreign])
    expect(groups[0].key).toBe('other')
    expect(groups[0].cards[0].id).toBe('z')
  })

  it('the reason-group vocabulary is the plan\'s five named reasons plus one catch-all', () => {
    expect(TXRMETHOD_REASON_GROUPS.map(g => g.key)).toEqual([
      'environment',
      'marker',
      'outcome',
      'draws',
      'covariates',
      'other',
    ])
  })
})

describe('the family order is the plan\'s fixed order', () => {
  it('the four families, in order', () => {
    expect([...TXRMETHOD_GROUP_ORDER]).toEqual([
      'response-call',
      'response-probability',
      'static-risk',
      'dynamic-risk',
    ])
  })
})

describe('recheckLine (the line after a re-check, step-4 fix)', () => {
  it('the same set says so, with the count', () => {
    expect(recheckLine(['a', 'b', 'c', 'd', 'e'], ['e', 'd', 'c', 'b', 'a'])).toBe(
      'Checked again: the same 5 methods can run.',
    )
    expect(recheckLine(['a'], ['a'])).toBe('Checked again: the same method can run.')
    expect(recheckLine([], [])).toBe('Checked again: still no method can run.')
  })

  it('more or fewer methods give the new count and the old one', () => {
    expect(recheckLine(['a', 'b', 'c', 'd', 'e'], ['a', 'b', 'c', 'd', 'e', 'f'])).toBe(
      'Checked again: 6 methods can run (was 5).',
    )
    expect(recheckLine(['a', 'b', 'c'], ['a'])).toBe('Checked again: 1 method can run (was 3).')
    expect(recheckLine(['a', 'b'], [])).toBe('Checked again: no method can run now (was 2).')
  })

  it('the same count with other members is "a different set", never "6 (was 6)"', () => {
    const line = recheckLine(['a', 'b', 'c', 'd', 'e', 'f'], ['a', 'b', 'c', 'd', 'e', 'g'])
    expect(line).toBe('Checked again: a different set of 6 methods can run.')
    expect(line).not.toContain('(was 6)')
  })
})

describe('recheckFailedLine (a re-check that failed while a list is shown)', () => {
  it('names the error once, without a doubled full stop, and says what the list shows', () => {
    expect(recheckFailedLine('eligibility down')).toBe(
      'Could not check again: eligibility down. The list shows the last answer.',
    )
    expect(recheckFailedLine('The engine is busy.')).toBe(
      'Could not check again: The engine is busy. The list shows the last answer.',
    )
  })
})
