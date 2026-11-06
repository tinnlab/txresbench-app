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
import { buildCovariates } from './covariates'

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
