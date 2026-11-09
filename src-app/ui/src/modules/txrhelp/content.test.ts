/**
 * TEST-HELP-1 — the Help content data: the section list and
 * the closed problem-code entries (ITEM-4).
 *
 * The closed set below is the file validator's `ProblemCode::ALL` — the 28
 * codes of `src-app/server/src/modules/file_validator/types.rs`
 * (R01–R21 + A01–A07). The test pins them as literals so a code added to
 * the server's closed enum fails THIS test until its Help entry (and its
 * intake link anchor) exists — the "every validator code has an entry"
 * property (TEST-QA-4) is a pin here, not a hope.
 */
import { describe, expect, it } from 'vitest'
import {
  HELP_SECTIONS,
  PROBLEM_HELP,
  PROBLEM_HELP_BY_CODE,
  problemAnchorOf,
} from './content'
import type { HelpProblemEntry, HelpSection } from './types'

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
          case 'note':
            expect(block.text.length).toBeGreaterThan(0)
            return
          case 'bullets':
          case 'steps':
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
})

describe('help content — the closed problem-code entries (TEST-HELP-2)', () => {
  it('has exactly one entry per closed validator code, in the validator\'s order', () => {
    expect(PROBLEM_HELP.map(entry => entry.code)).toEqual([...CLOSED_CODES])
    expect(PROBLEM_HELP.length).toBe(28)
  })

  it('every entry carries its code as an anchor, a title, a meaning and an action', () => {
    const codes = new Set<string>()
    for (const entry of PROBLEM_HELP) {
      expect(codes.has(entry.code)).toBe(false)
      codes.add(entry.code)
      expect(entry.anchor).toBe(`problem-${entry.code.toLowerCase()}`)
      expect(entry.title).toMatch(new RegExp(`^${entry.code} — `))
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

  it('severity coverage: errors, warnings and the never-reported tidy ids', () => {
    const byLevel = (level: HelpProblemEntry['level']) =>
      PROBLEM_HELP.filter(entry => entry.level === level).map(entry => entry.code)
    // R01/R21 are declared NotApplicable; R09/R11/R16/R17 hold by
    // construction (the app derives each draw from the value rows — the
    // validator's own declarations, `rules.rs RULES`).
    expect(byLevel('never')).toEqual(['R01', 'R09', 'R11', 'R16', 'R17', 'R21'])
    expect(byLevel('warning')).toEqual([
      'R14',
      'R19',
      'R20',
      'A03',
      'A04',
      'A05',
      'A06',
      'A07',
    ])
    expect(byLevel('error').length).toBe(14)
  })
})
