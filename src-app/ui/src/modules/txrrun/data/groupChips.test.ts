/**
 * TEST-RUN-09 — txrrun `buildGroupChips` (PROV-UI-RUN-2's chip builder,
 * DEC-8; ITEM-4). The E board's four group chips are the host's data: the
 * shared list renders host-controlled `TxrFilterChip`s, and this builder
 * derives the STATIC facts (id, label, count) from one catalogue list
 * payload — the host wires `active` / `onToggle` (ITEM-8).
 *
 * Pinned behaviors:
 *
 * - one chip per DISTINCT group present, in the board's order (Response
 *   call → Response probability → Static risk → Dynamic risk — which is the
 *   generated `MethodGroup` enum order) with the group's label;
 * - the count is the group's methods INSIDE the set the host passes (the
 *   status-filtered set — it matches what the list shows);
 * - a group with ZERO methods in the set renders NO chip (an empty filter
 *   is never offered — TEST-RUN-09's zero-count rule);
 * - the chip id is the group id (the filter's identity), and the stateful
 *   fields are the inert host-replaced defaults.
 *
 * Fixtures are the generated `MethodSummary` wire type (the txrlist test
 * idiom), synthetic ids only (INV-6).
 */
import { describe, expect, it } from 'vitest'
import type { MethodGroup, MethodSummary } from '@/api-client/types'
import { buildGroupChips } from './groupChips'

/** One catalogue summary with the group facts the builder reads. */
function summary(group: MethodSummary['group'], group_label: string): MethodSummary {
  return {
    container: true,
    covariates: 'none',
    embeds_training_data: false,
    frozen_model: false,
    group,
    group_label,
    id: group,
    journal: 'J. Methods',
    language: 'R',
    marker_groups_required: [],
    markers: { kind: 'panel', count: 3 },
    min_draws: 3,
    needs_baseline: true,
    needs_detection_call: false,
    paper_doi: '10.1000/example',
    runnable: true,
    spec_status: 'shipped',
    tasks: [group],
    timing: { base_seconds_per_fold: 60, benchmarked_units: 2, quality: 'measured' },
    uses_history: 'landmark',
    year: 2021,
  }
}

/** The four groups in the board's order, with the board's labels. */
const BOARD_GROUPS: { group: MethodGroup; label: string }[] = [
  { group: 'response-call', label: 'Response call' },
  { group: 'response-probability', label: 'Response probability' },
  { group: 'static-risk', label: 'Static risk' },
  { group: 'dynamic-risk', label: 'Dynamic risk' },
]

describe('buildGroupChips (TEST-RUN-09)', () => {
  it('yields one chip per distinct group present, in the board order, with the group label', () => {
    const chips = buildGroupChips([
      summary('response-probability', 'Response probability'),
      summary('response-call', 'Response call'),
      summary('dynamic-risk', 'Dynamic risk'),
      summary('static-risk', 'Static risk'),
    ])
    expect(chips.map(chip => chip.id)).toEqual([
      'response-call',
      'response-probability',
      'static-risk',
      'dynamic-risk',
    ])
    for (const [index, expected] of BOARD_GROUPS.entries()) {
      expect(chips[index].id).toBe(expected.group)
      expect(chips[index].label).toBe(expected.label)
    }
  })

  it('counts the group members inside the host-passed (status-filtered) set', () => {
    const chips = buildGroupChips([
      summary('response-call', 'Response call'),
      summary('response-call', 'Response call'),
      summary('dynamic-risk', 'Dynamic risk'),
    ])
    const byId = new Map(chips.map(chip => [chip.id, chip]))
    expect(byId.get('response-call')?.count).toBe(2)
    expect(byId.get('dynamic-risk')?.count).toBe(1)
  })

  it('renders no chip for a group with zero methods in the current set', () => {
    const chips = buildGroupChips([
      summary('response-call', 'Response call'),
      summary('dynamic-risk', 'Dynamic risk'),
    ])
    expect(chips.map(chip => chip.id)).toEqual(['response-call', 'dynamic-risk'])
  })

  it('an empty set yields no chips', () => {
    expect(buildGroupChips([])).toEqual([])
  })

  it('carries the host-replaced stateful fields as the inert defaults', () => {
    const [chip] = buildGroupChips([summary('response-call', 'Response call')])
    expect(chip.active).toBe(false)
    // The host replaces onToggle with its own filter predicate (ITEM-8);
    // the inert default never selects anything by itself.
    expect(() => chip.onToggle()).not.toThrow()
  })
})
