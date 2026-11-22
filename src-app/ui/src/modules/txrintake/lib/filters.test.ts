// @vitest-environment node
/**
 * The study-answer → method-filter builder (`lib/filters.ts`, step2-filters):
 * ONE function produces the same three facts for both the preview body
 * (top-level `disease_group` / `treatment_classes` / `method_group`) and the
 * inventory body (`filters` block), with the outcome pill → method group
 * mapping pinned.
 *
 * 5a3: the builder now takes the loaded `filter_options` vocabulary as its
 * validity gate — only the ids it knows are sent (a stale persisted id
 * would 422 the server), and while it is not loaded the disease/treatment
 * fields are omitted (the outcome still rides).
 */
import { describe, expect, it } from 'vitest'
import type { FilterOptions } from '@/api-client/types'
import { buildMethodFilters, hasMethodFilters, outcomeToMethodGroup } from './filters'
import type { StudyAnswers } from '../types'

const EMPTY: StudyAnswers = {
  disease: null,
  treatments: null,
  outcome: null,
  markerGroups: null,
  beforeTreatment: null,
  drawsDuringTreatment: null,
  lastDrawDay: null,
}

/** The vocabulary the catalogue's answers were picked from. */
const VOCABULARY: FilterOptions = {
  disease_categories: [
    {
      id: 'Solid tumours',
      diseases: [
        { id: 'colorectal cancer', children: [] },
        { id: 'breast cancer', children: ['breast cancer (triple-negative)'] },
      ],
    },
  ],
  treatment_classes: [
    { id: 'immune checkpoint inhibitor', label: 'Immune checkpoint inhibitor' },
    { id: 'chemotherapy', label: 'Chemotherapy' },
  ],
}

describe('outcomeToMethodGroup', () => {
  it('maps each outcome pill to the method rows group enum', () => {
    expect(outcomeToMethodGroup('binary-response')).toBe('response-call')
    expect(outcomeToMethodGroup('response-probability')).toBe('response-probability')
    expect(outcomeToMethodGroup('progression-by-day')).toBe('static-risk')
    expect(outcomeToMethodGroup('dynamic-risk')).toBe('dynamic-risk')
  })
})

describe('buildMethodFilters', () => {
  it('emits the three facts when answered, in the wire spellings', () => {
    const filters = buildMethodFilters(
      {
        ...EMPTY,
        disease: 'colorectal cancer',
        treatments: ['immune checkpoint inhibitor', 'radiotherapy'],
        outcome: 'progression-by-day',
      },
      VOCABULARY,
    )
    expect(filters).toEqual({
      disease_group: 'colorectal cancer',
      treatment_classes: ['immune checkpoint inhibitor'],
      method_group: 'static-risk',
    })
    expect(hasMethodFilters(filters)).toBe(true)
  })

  it('omits each unanswered field — never null, never an empty list (the "any" rule)', () => {
    expect(buildMethodFilters(EMPTY, VOCABULARY)).toEqual({})
    expect(buildMethodFilters({ ...EMPTY, disease: 'colorectal cancer' }, VOCABULARY)).toEqual({
      disease_group: 'colorectal cancer',
    })
    expect(buildMethodFilters({ ...EMPTY, treatments: [] }, VOCABULARY)).toEqual({})
    expect(buildMethodFilters({ ...EMPTY, treatments: null }, VOCABULARY)).toEqual({})
    expect(
      buildMethodFilters(
        { ...EMPTY, treatments: ['chemotherapy'], outcome: 'dynamic-risk' },
        VOCABULARY,
      ),
    ).toEqual({
      treatment_classes: ['chemotherapy'],
      method_group: 'dynamic-risk',
    })
  })

  it('keeps only the ids the vocabulary knows — a stale persisted id is never sent (5a3, the 422 guard)', () => {
    // The persisted disease was dropped by a newer catalogue; the persisted
    // treatment list mixes a known and an unknown id.
    const filters = buildMethodFilters(
      {
        ...EMPTY,
        disease: 'dead-cancer',
        treatments: ['chemotherapy', 'obsolete-drug'],
        outcome: 'binary-response',
      },
      VOCABULARY,
    )
    expect(filters).toEqual({
      treatment_classes: ['chemotherapy'],
      method_group: 'response-call',
    })
    // A sub-group id of the vocabulary is a valid disease answer.
    expect(
      buildMethodFilters(
        { ...EMPTY, disease: 'breast cancer (triple-negative)' },
        VOCABULARY,
      ),
    ).toEqual({ disease_group: 'breast cancer (triple-negative)' })
  })

  it('while the vocabulary is not loaded (null) the disease/treatment fields are omitted; the outcome still rides', () => {
    const filters = buildMethodFilters(
      {
        ...EMPTY,
        disease: 'colorectal cancer',
        treatments: ['chemotherapy'],
        outcome: 'progression-by-day',
      },
      null,
    )
    expect(filters).toEqual({ method_group: 'static-risk' })
  })

  it('hasMethodFilters is the host omission gate', () => {
    expect(hasMethodFilters({})).toBe(false)
    expect(hasMethodFilters({ disease_group: 'breast cancer' })).toBe(true)
  })
})
