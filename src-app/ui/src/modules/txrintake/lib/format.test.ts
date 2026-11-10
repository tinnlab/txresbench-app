// @vitest-environment node
/**
 * TEST-INT-13's ITEM-5 rows (`lib/format.ts`): the option labels are the
 * board's option text verbatim (Criteria.dc.html: Disease, Treatment,
 * outcome pills, Before treatment, Draws during treatment, Last draw); the
 * "N of M methods fit" / "N methods are left out" copy is parameter-free
 * (no hardcoded counts — FLOW.md's design-example rule); the B-panel
 * fallback reason line is the module's own constant. The remaining
 * row-label rows of TEST-INT-13 (pluralize/rowLabel + the board's
 * fixed-locale grouping) ship with ITEM-8; the download rows' file is
 * `lib/download.test.ts` (created at ITEM-6).
 */
import { describe, expect, it } from 'vitest'
import {
  BEFORE_TREATMENT_OPTIONS,
  DISEASE_OPTIONS,
  DRAWS_OPTIONS,
  LAST_DRAW_OPTIONS,
  OUTCOME_OPTIONS,
  PREVIEW_REASON_FALLBACK,
  TREATMENT_OPTIONS,
  fitHeading,
  groupNumber,
  leftOutHeading,
  pluralize,
  rowLabel,
  someFitLine,
} from './format'

describe('option labels (TEST-INT-13)', () => {
  it('disease options are the board text verbatim', () => {
    expect(DISEASE_OPTIONS.map(o => o.label)).toEqual([
      'Colorectal cancer',
      'Lung cancer',
      'Breast cancer',
      'Prostate cancer',
      'Other or not listed',
    ])
    expect(DISEASE_OPTIONS.map(o => o.value)).toEqual([
      'colorectal',
      'lung',
      'breast',
      'prostate',
      'other',
    ])
  })

  it('treatment options are the board text verbatim', () => {
    expect(TREATMENT_OPTIONS.map(o => o.label)).toEqual([
      'Immunotherapy',
      'Chemotherapy',
      'Targeted therapy',
      'Radiotherapy',
      'Other or mixed',
    ])
  })

  it('outcome pills are the board text verbatim', () => {
    expect(OUTCOME_OPTIONS.map(o => o.label)).toEqual([
      'Will the treatment work? (yes or no)',
      'Chance of response',
      'Risk of progression or death by a day',
      'Risk over time as new draws arrive',
    ])
    expect(OUTCOME_OPTIONS.map(o => o.value)).toEqual([
      'binary-response',
      'response-probability',
      'progression-by-day',
      'dynamic-risk',
    ])
  })

  it('schedule options are the board text verbatim', () => {
    expect(BEFORE_TREATMENT_OPTIONS.map(o => o.label)).toEqual(['Always', 'Sometimes'])
    expect(DRAWS_OPTIONS.map(o => ({ label: o.label, value: o.value }))).toEqual([
      { label: '1', value: 1 },
      { label: '2 to 3', value: 2 },
      { label: '4 or more', value: 4 },
    ])
    expect(LAST_DRAW_OPTIONS.map(o => ({ label: o.label, value: o.value }))).toEqual([
      { label: 'Day 28', value: 28 },
      { label: 'Day 42', value: 42 },
      { label: 'Day 56', value: 56 },
      { label: 'Day 84', value: 84 },
    ])
  })
})

describe('panel copy (TEST-INT-13)', () => {
  it('the count copy is a live-data template, never a hardcoded number', () => {
    // R2-1: the heading's count is the answer-caused left-out (the
    // environment fact has its own line — see preview.test.ts).
    expect(fitHeading({ total: 39, fit: 26 })).toBe('26 of 39 methods fit')
    expect(leftOutHeading({ leftOut: 13 })).toBe('13 methods are left out')
    expect(someFitLine({ some: 4 })).toBe('4 can run for some patients')
  })

  it('the fallback reason line is the module constant', () => {
    expect(PREVIEW_REASON_FALLBACK).toBe("doesn't fit with these answers")
  })
})

describe('row labels (TEST-INT-13, ITEM-8)', () => {
  it('pluralize renders the count with its word and the board grouping', () => {
    expect(pluralize(151, 'patient')).toBe('151 patients')
    expect(pluralize(1, 'patient')).toBe('1 patient')
    expect(pluralize(1102, 'patient')).toBe('1,102 patients')
  })

  it('rowLabel renders the row-count phrase (the board "Found 1,102 rows")', () => {
    expect(rowLabel(1102)).toBe('1,102 rows')
    expect(rowLabel(151)).toBe('151 rows')
    expect(rowLabel(1)).toBe('1 row')
  })

  it('the grouping is the board fixed-locale bytes, never the host locale', () => {
    expect(groupNumber(1102)).toBe('1,102')
    expect(groupNumber(999)).toBe('999')
    expect(groupNumber(1234567)).toBe('1,234,567')
  })
})
