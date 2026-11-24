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
import {
  buildCovariates,
  covariatesAutoOnLine,
  covariatesAutoOnText,
  covariatesUntickLine,
  covariatesUntickText,
  covariatesUseLine,
  requiredTickedCards,
} from './covariates'

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

/** One method card with the facts the covariates lines read. */
function method(
  id: string,
  mode: 'required' | 'optional' | 'none',
  run: { disabled: boolean; reasonCode: string | null } = { disabled: false, reasonCode: null },
  title: string = id,
): TxrMethodCard {
  return {
    key: id,
    id,
    title,
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
    needs: {
      markers: '1 marker',
      covariates: mode === 'none' ? null : `covariates ${mode}`,
      covariatesMode: mode,
      draws: '1+ draws',
    },
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
      method('a', 'optional'),
      method('b', 'none'),
      method('c', 'none'),
      method('d', 'none'),
      method('e', 'none'),
    ]
    expect(covariatesUseLine(cards)).toBe('Used by 1 of the 5 methods that can run.')
  })

  it('says none use them when no runnable method takes them', () => {
    expect(covariatesUseLine([method('a', 'none'), method('b', 'none')])).toBe(
      'None of the methods that can run use them.',
    )
  })

  it('names the one method case plainly', () => {
    expect(covariatesUseLine([method('a', 'required')])).toBe(
      'Used by the one method that can run.',
    )
  })

  it('adds the can\'t-run methods held back by extra inputs (the switch is off, they require them)', () => {
    const cards = [
      method('a', 'none'),
      method('r1', 'required', { disabled: true, reasonCode: 'COVARIATE_REQUIRED_UNMET' }),
      method('r2', 'required', { disabled: true, reasonCode: 'COVARIATE_MISSING' }),
      // Held back by something else first: not counted.
      method('x', 'required', { disabled: true, reasonCode: 'ENV_IMAGE_MISSING' }),
    ]
    expect(covariatesUseLine(cards)).toBe(
      'None of the methods that can run use them. 2 more need them to run.',
    )
  })

  it('is null before there is a method to count (the caller keeps the general help)', () => {
    expect(covariatesUseLine([])).toBeNull()
    expect(
      covariatesUseLine([method('x', 'none', { disabled: true, reasonCode: 'ENV_IMAGE_MISSING' })]),
    ).toBeNull()
  })
})

// ── the switch's two automatic steps (AOC part 2) ────────────────────────────

describe('requiredTickedCards (the auto-on / untick decision set)', () => {
  it('is the ticked RUNNABLE methods whose catalogue mode is required, nothing else', () => {
    const cards = [
      method('req', 'required', { disabled: false, reasonCode: null }, 'Regular rule'),
      method('req2', 'required'),
      method('opt', 'optional'),
      method('none', 'none'),
      method('dis', 'required', { disabled: true, reasonCode: 'COVARIATE_REQUIRED_UNMET' }),
    ]
    const keys = requiredTickedCards(cards, new Set(['req', 'req2', 'opt', 'none', 'dis'])).map(
      card => card.key,
    )
    expect(keys).toEqual(['req', 'req2'])
  })

  it('ignores the unticked required methods', () => {
    const cards = [method('req', 'required'), method('opt', 'optional')]
    expect(requiredTickedCards(cards, new Set(['opt'])).map(card => card.key)).toEqual([])
  })
})

describe('covariatesAutoOnLine (the auto-on decision)', () => {
  const cards = [
    method('req', 'required', undefined, 'Dynamic random forest'),
    method('opt', 'optional'),
  ]

  it('one required method: "Turned on because {method title} needs them."', () => {
    expect(
      covariatesAutoOnLine(cards, new Set(['req']), 'present', false),
    ).toBe('Turned on because Dynamic random forest needs them.')
  })

  it('several: counts the chosen methods that need them', () => {
    expect(
      covariatesAutoOnLine(
        [...cards, method('req2', 'required', undefined, 'Direct rule')],
        new Set(['req', 'req2']),
        'present',
        false,
      ),
    ).toBe('Turned on because 2 of the chosen methods need them.')
  })

  it('is null when no required method is ticked (optional / none never trigger it)', () => {
    expect(covariatesAutoOnLine(cards, new Set(['opt']), 'present', false)).toBeNull()
    expect(covariatesAutoOnLine(cards, new Set(), 'present', false)).toBeNull()
    expect(covariatesAutoOnLine([method('opt', 'optional')], new Set(['opt']), 'present', false)).toBeNull()
    expect(covariatesAutoOnLine([method('none', 'none')], new Set(['none']), 'present', false)).toBeNull()
  })

  it('is null when the switch is already on', () => {
    expect(covariatesAutoOnLine(cards, new Set(['req']), 'present', true)).toBeNull()
  })

  it('is null when the file has no extra-input columns (absent: required methods cannot run, as today)', () => {
    expect(covariatesAutoOnLine(cards, new Set(['req']), 'absent', false)).toBeNull()
  })

  it('is null when the screen cannot say (unknown availability)', () => {
    expect(covariatesAutoOnLine(cards, new Set(['req']), 'unknown', false)).toBeNull()
  })

  it('a required card that cannot run is never the trigger (not runnable)', () => {
    const cannot = [method('req', 'required', { disabled: true, reasonCode: 'COVARIATE_REQUIRED_UNMET' })]
    expect(covariatesAutoOnLine(cannot, new Set(['req']), 'present', false)).toBeNull()
  })
})

describe('covariatesUntickLine (the untick-on-manual-off decision)', () => {
  it('one: "{method title} was unticked: it needs extra inputs."', () => {
    expect(covariatesUntickLine([method('req', 'required', undefined, 'Dynamic random forest')], new Set(['req']))).toBe(
      'Dynamic random forest was unticked: it needs extra inputs.',
    )
  })

  it('several: counts the unticked methods', () => {
    const cards = [
      method('req', 'required', undefined, 'Dynamic random forest'),
      method('req2', 'required', undefined, 'Direct rule'),
    ]
    expect(covariatesUntickLine(cards, new Set(['req', 'req2']))).toBe(
      '2 methods were unticked: they need extra inputs.',
    )
  })

  it('is null when no required method is ticked (optional / none: nothing is unticked)', () => {
    expect(covariatesUntickLine([method('opt', 'optional')], new Set(['opt']))).toBeNull()
    expect(covariatesUntickLine([method('none', 'none')], new Set(['none']))).toBeNull()
    expect(covariatesUntickLine([], new Set())).toBeNull()
  })
})

describe('covariatesAutoOnText / covariatesUntickText (the line builders)', () => {
  it('the auto-on text is the decision line for the given required cards', () => {
    expect(covariatesAutoOnText([])).toBeNull()
    expect(covariatesAutoOnText([method('req', 'required', undefined, 'A rule')])).toBe(
      'Turned on because A rule needs them.',
    )
    expect(
      covariatesAutoOnText([method('r1', 'required', undefined, 'A rule'), method('r2', 'required', undefined, 'B rule')]),
    ).toBe('Turned on because 2 of the chosen methods need them.')
  })

  it('the untick text is the decision line for the given required cards', () => {
    expect(covariatesUntickText([])).toBeNull()
    expect(covariatesUntickText([method('req', 'required', undefined, 'A rule')])).toBe(
      'A rule was unticked: it needs extra inputs.',
    )
  })
})
