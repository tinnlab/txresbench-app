/**
 * TEST RUN-15's data side — the Extra-inputs fact builder
 * (`lib/covariates.ts`, ITEM-7; PROV-UI-RUN-4's `covariates` prop): the
 * patients file's inspection `covariate_columns` names → the row's names
 * line, with the three availability states (present / absent / unknown)
 * and the never-a-guess rule (no inspection → pending, never a name).
 *
 * The names here are the FIXTURE's own synthetic columns (the board's
 * "age, sex, stage" is a design example — INV-6; only the TEST file pins
 * a real-word example, as the module's copy scan excludes test files).
 */
import { describe, expect, it } from 'vitest'
import type { FileInspection } from '@/api-client/types'
import type { TxrMethodCard } from '@/modules/txrlist/types'
import { buildCovariates, covariatesUseLine } from './covariates'

/** One inspection with the given covariate facts (the fixture shape). */
function inspection(covariates: { name: string; is_numeric: boolean }[]): FileInspection {
  return {
    kind: 'patients',
    source_name: 'patients.csv',
    columns: {
      resolved: {},
      unresolved: ['unknown_col'],
      covariate_columns: covariates,
    },
    problems: [],
    summary: { rows: 18, draw_days: [0, 14], markers: [] },
  }
}

describe('buildCovariates (the Extra-inputs line facts, TEST-RUN-15)', () => {
  it('carries the inspection covariate-column names in file order (present)', () => {
    const fact = buildCovariates(
      inspection([
        { name: 'age', is_numeric: true },
        { name: 'sex', is_numeric: false },
        { name: 'stage', is_numeric: true },
      ]),
    )
    expect(fact.availability).toBe('present')
    expect(fact.names).toEqual(['age', 'sex', 'stage'])
  })

  it('reports absent for an inspected file with no covariate column', () => {
    const fact = buildCovariates(inspection([]))
    expect(fact.availability).toBe('absent')
    expect(fact.names).toEqual([])
  })

  it('reports unknown when the file has no resolved inspection — never a name', () => {
    const fact = buildCovariates(null)
    expect(fact.availability).toBe('unknown')
    expect(fact.names).toEqual([])
  })
})

/** One method card with the facts `covariatesUseLine` reads. */
function method(
  id: string,
  covariates: string | null,
  run: { disabled: boolean; reasonCode: string | null } = { disabled: false, reasonCode: null },
): TxrMethodCard {
  return {
    key: id,
    id,
    title: id,
    summary: `Summary of ${id}.`,
    paperTitle: null,
    group: 'static-risk',
    groupLabel: 'Static risk',
    language: 'R',
    journal: 'Fixture Journal',
    year: 2020,
    paperDoi: '',
    estimate: { seconds: 30, quality: 'measured' },
    rank: null,
    needs: { markers: '1 marker', covariates, draws: '1+ draws' },
    run: {
      status: run.disabled ? 'cannot' : 'can',
      coverageLine: '',
      reasonCode: run.reasonCode,
      reasonLine: '',
      reasonLines: [],
      reasonFix: '',
      disabled: run.disabled,
    },
  }
}

describe('covariatesUseLine (the Extra-inputs help once the list is known, step-4 fix)', () => {
  it('says how many of the methods that can run take extra inputs', () => {
    const cards = [
      method('a', 'covariates optional'),
      method('b', null),
      method('c', null),
      method('d', null),
      method('e', null),
    ]
    expect(covariatesUseLine(cards)).toBe('Used by 1 of the 5 methods that can run.')
  })

  it('says none use them when no runnable method takes them', () => {
    expect(covariatesUseLine([method('a', null), method('b', null)])).toBe(
      'None of the methods that can run use them.',
    )
  })

  it('names the one method case plainly', () => {
    expect(covariatesUseLine([method('a', 'covariates required')])).toBe(
      'Used by the one method that can run.',
    )
  })

  it('adds the can\'t-run methods held back by extra inputs (the switch is off, they require them)', () => {
    const cards = [
      method('a', null),
      method('r1', 'covariates required', { disabled: true, reasonCode: 'COVARIATE_REQUIRED_UNMET' }),
      method('r2', 'covariates required', { disabled: true, reasonCode: 'COVARIATE_MISSING' }),
      // Held back by something else first: not counted.
      method('x', 'covariates required', { disabled: true, reasonCode: 'ENV_IMAGE_MISSING' }),
    ]
    expect(covariatesUseLine(cards)).toBe(
      'None of the methods that can run use them. 2 more need them to run.',
    )
  })

  it('is null before there is a method to count (the caller keeps the general help)', () => {
    expect(covariatesUseLine([])).toBeNull()
    expect(
      covariatesUseLine([method('x', null, { disabled: true, reasonCode: 'ENV_IMAGE_MISSING' })]),
    ).toBeNull()
  })
})
