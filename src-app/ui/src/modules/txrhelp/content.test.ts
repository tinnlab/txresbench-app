/**
 * TEST-HELP-1/2 — the Help content data: the section list, the
 * quick-start cards, the status vocabulary and the closed problem-code
 * entries (qa-fixes2 ITEM-3, R2-H8).
 *
 * The trouble-free closed set below is the file validator's `ProblemCode::ALL`
 * — the 28 codes of `src-app/server/src/modules/file_validator/types.rs`
 * (R01–R21 + A01–A07) — and the SEVERITY groups + the "reported" verdicts
 * come from the committed catalogue (`validator-catalog.json`, generated
 * from the validator's own declaration tables by the server's
 * `file_validator::catalog` and pinned TWO-sided by the server test
 * `catalog_roundtrip_and_committed_copy`): this test reads the SAME byte
 * file the page imports, never a second table. A code the server adds
 * without a catalogue entry fails the server test first; a code the
 * catalogue carries without Help prose fails HERE (the "every validator
 * code has an entry" property is a pin, not a hope).
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ELIGIBILITY_STATUSES,
  HELP_SECTIONS,
  PROBLEM_GROUPS,
  PROBLEM_HELP,
  PROBLEM_HELP_BY_CODE,
  QUICK_START,
  RUN_STATE_MEANINGS,
  VALIDATOR_CATALOG,
  catalogEntryOf,
  problemAnchorOf,
  problemGroupOf,
} from './content'
import type { HelpProblemEntry, HelpSection } from './types'

const HERE = dirname(fileURLToPath(import.meta.url))

/** The file validator's closed code vocabulary (ProblemCode::ALL). */
const CLOSED_CODES = [
  'R01',
  'R02',
  'R03',
  'R04',
  'R05',
  'R06',
  'R07',
  'R08',
  'R09',
  'R10',
  'R11',
  'R12',
  'R13',
  'R14',
  'R15',
  'R16',
  'R17',
  'R18',
  'R19',
  'R20',
  'R21',
  'A01',
  'A02',
  'A03',
  'A04',
  'A05',
  'A06',
  'A07',
] as const

describe('help content — sections (TEST-HELP-1)', () => {
  it('carries the planned sections in page order, each with a unique anchor id', () => {
    expect(HELP_SECTIONS.map(section => section.id)).toEqual([
      'overview',
      'steps',
      'files',
      'choosing-methods',
      'statuses',
      'results',
      'models',
      'history',
      'privacy',
      'data-location',
      'troubleshooting',
    ])
    const ids = new Set(HELP_SECTIONS.map(section => section.id))
    expect(ids.size).toBe(HELP_SECTIONS.length)
    for (const section of HELP_SECTIONS) {
      expect(section.id).toMatch(/^[a-z][a-z0-9-]*$/)
      expect(section.title.length).toBeGreaterThan(3)
      expect(section.blocks.length).toBeGreaterThan(0)
    }
  })

  it('every block is a valid HelpBlock shape with non-empty text content', () => {
    const walk = (blocks: HelpSection['blocks']): void => {
      for (const block of blocks) {
        switch (block.kind) {
          case 'paragraph':
          case 'caption':
            expect(block.text.length).toBeGreaterThan(0)
            return
          case 'bullets':
            expect(block.items.length).toBeGreaterThan(0)
            for (const item of block.items) {
              expect(item.length).toBeGreaterThan(0)
            }
            return
          case 'table':
            expect(block.head.length).toBeGreaterThan(0)
            for (const row of block.rows) {
              expect(row.length).toBe(block.head.length)
              for (const value of row) {
                expect(value.length).toBeGreaterThan(0)
              }
            }
            return
          case 'callout':
            expect(['tip', 'note', 'watch']).toContain(block.tone)
            expect(block.text.length).toBeGreaterThan(0)
            return
          case 'stepper':
            expect(block.steps).toHaveLength(4)
            for (const step of block.steps) {
              expect(step.number).toBeGreaterThanOrEqual(1)
              expect(step.number).toBeLessThanOrEqual(4)
              expect(step.lines).toHaveLength(2)
              expect(step.name.length).toBeGreaterThan(0)
              expect(step.screen.length).toBeGreaterThan(0)
              expect(step.details.length).toBeGreaterThan(0)
            }
            return
          case 'fileCard':
            expect(['patients', 'measurements']).toContain(block.card.file)
            expect(block.card.columns.length).toBeGreaterThan(3)
            for (const column of block.card.columns) {
              expect(column.name.length).toBeGreaterThan(0)
              expect(column.meaning.length).toBeGreaterThan(0)
              expect(column.example.length).toBeGreaterThan(0)
            }
            expect(block.card.exampleRows.split('\n').length).toBeGreaterThanOrEqual(2)
            return
          case 'statuses':
            return
        }
      }
    }
    for (const section of HELP_SECTIONS) {
      walk(section.blocks)
    }
  })

  it('the authored sections cover the plan\'s content (a section per subject)', () => {
    const titles = HELP_SECTIONS.map(section => section.title)
    for (const subject of [
      'What TxResBench does',
      'The four steps',
      'Preparing your files',
      'Choosing methods',
      'Status words on the screens',
      'Reading results',
      'Saved models and pretrained models',
      'Run history',
      'Privacy',
      'What the app keeps',
      'Troubleshooting',
    ]) {
      expect(titles).toContain(subject)
    }
  })

  it('the quick-start row mirrors the Start screen: three cards, their screens and buttons', () => {
    expect(QUICK_START.map(card => card.id)).toEqual(['pretrained', 'learn', 'saved'])
    expect(QUICK_START[0].cta).toBe('Add the patients to predict')
    expect(QUICK_START[1].cta).toBe('Add my data')
    expect(QUICK_START[2].cta).toBe('Predict with a model I saved')
    expect(QUICK_START[0].route).toBe('/predict-files')
    expect(QUICK_START[1].route).toBe('/study')
    expect(QUICK_START[2].route).toBe('/predict-files')
  })

  it('the status vocabulary covers both the eligibility verdicts and the run states, with a one-line meaning each', () => {
    expect(ELIGIBILITY_STATUSES.map(item => item.status)).toEqual(['can', 'some', 'cannot'])
    expect(RUN_STATE_MEANINGS.map(item => item.state)).toEqual([
      'waiting',
      'downloading',
      'running',
      'finished',
      'failed',
      'stopped',
      'skipped',
      'cannot_run',
    ])
    for (const item of [...ELIGIBILITY_STATUSES, ...RUN_STATE_MEANINGS]) {
      expect(item.meaning.length).toBeGreaterThan(20)
    }
  })

  it('the example rows equal the app\'s committed example material (first three rows)', () => {
    const patients = HELP_SECTIONS.find(s => s.id === 'files')!.blocks.find(
      b => b.kind === 'fileCard' && b.card.file === 'patients',
    )!
    const measurements = HELP_SECTIONS.find(s => s.id === 'files')!.blocks.find(
      b => b.kind === 'fileCard' && b.card.file === 'measurements',
    )!
    const expected = (file: string): string => {
      const text = readFileSync(
        resolve(HERE, '../../../../../data/file-validator/examples/', file),
        'utf8',
      )
      return text.split('\n').slice(0, 4).join('\n').trimEnd()
    }
    expect(patients.kind === 'fileCard' && patients.card.exampleRows).toBe(expected('patients.csv'))
    expect(measurements.kind === 'fileCard' && measurements.card.exampleRows).toBe(
      expected('measurements.csv'),
    )
  })
})

describe('help content — the closed problem-code entries (TEST-HELP-2)', () => {
  it('the catalogue covers the closed vocabulary in order — the server\'s own declaration order', () => {
    expect(VALIDATOR_CATALOG.map(entry => entry.code)).toEqual([...CLOSED_CODES])
    expect(VALIDATOR_CATALOG.length).toBe(28)
  })

  it('has exactly one prose entry per catalogue code, in the catalogue\'s order', () => {
    expect(PROBLEM_HELP.map(entry => entry.code)).toEqual([...CLOSED_CODES])
    expect(PROBLEM_HELP.length).toBe(28)
  })

  it('every entry carries its code as an anchor, a plain title, a meaning and an action', () => {
    const codes = new Set<string>()
    for (const entry of PROBLEM_HELP) {
      expect(codes.has(entry.code)).toBe(false)
      codes.add(entry.code)
      expect(entry.anchor).toBe(`problem-${entry.code.toLowerCase()}`)
      // The title is PLAIN (the code renders as the chip) — the old
      // "R03 — column types" heading moved to the chip + title split.
      expect(entry.title).not.toMatch(/^[RAD]\d\d\s*—/)
      expect(entry.meaning.length).toBeGreaterThan(20)
      expect(entry.action.length).toBeGreaterThan(20)
    }
  })

  it('maps each closed code to its entry and computes its anchor (the intake link target)', () => {
    for (const code of CLOSED_CODES) {
      expect(PROBLEM_HELP_BY_CODE[code]).toBeDefined()
      expect(PROBLEM_HELP_BY_CODE[code].code).toBe(code)
      expect(problemAnchorOf(code)).toBe(`problem-${code.toLowerCase()}`)
    }
    // An unknown code falls back to the same spelling convention (never a
    // blank href); the closed set above guarantees that case is unreachable
    // for the validator's own codes.
    expect(problemAnchorOf('X99')).toBe('problem-x99')
  })

  it('the severity groups come from the catalogue, not the prose — R2-H8\'s facts pinned', () => {
    expect(catalogEntryOf('A04')?.severity).toBe('error_or_warning')
    expect(catalogEntryOf('R10')?.applicability).toBe('holds_by_construction')
    expect(catalogEntryOf('A07')?.applicability).toBe('reported')
    expect(problemGroupOf('A04')).toBe('error_or_warning')
    // The "not reported by the app" set: R01/R21 declared not applicable,
    // R09/R10/R11/R16/R17 hold by construction (R10: the feature list is
    // folded from the measurement rows themselves — the R2-H8 finding).
    expect(
      PROBLEM_HELP.filter(entry => problemGroupOf(entry.code) === 'never').map(entry => entry.code),
    ).toEqual(['R01', 'R09', 'R10', 'R11', 'R16', 'R17', 'R21'])
    expect(
      PROBLEM_HELP.filter(entry => problemGroupOf(entry.code) === 'error').map(entry => entry.code),
    ).toEqual(['R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08', 'R12', 'R13', 'R15', 'R18', 'A01', 'A02'])
    expect(
      PROBLEM_HELP.filter(entry => problemGroupOf(entry.code) === 'warning').map(entry => entry.code),
    ).toEqual(['R14', 'R19', 'R20', 'A03', 'A05', 'A06', 'A07'])
    expect(problemGroupOf('R99')).toBe('error')
  })

  it('the R2-H8 findings are fixed in the prose: R12 names the patients table, R05 names R03, A07 is honest, R08/R15 pair up', () => {
    const entry = (code: string): HelpProblemEntry => PROBLEM_HELP_BY_CODE[code]
    expect(entry('R12').meaning).toMatch(/PATIENTS table/i)
    expect(entry('R05').action).toMatch(/R03/)
    expect(entry('A07').action).toMatch(/offer/i)
    expect(entry('A07').meaning).toMatch(/identity/i)
    expect(entry('R08').action).toMatch(/R15/)
    expect(entry('R10').meaning).toMatch(/by construction/i)
    expect(entry('A04').meaning).toMatch(/Error:/)
    expect(entry('A04').meaning).toMatch(/Warning:/)
  })

  it('the groups render in severity order with their displayed labels', () => {
    expect(PROBLEM_GROUPS.map(group => group.group)).toEqual([
      'error',
      'warning',
      'error_or_warning',
      'never',
    ])
    expect(PROBLEM_GROUPS[0].label).toMatch(/block/)
  })
})
