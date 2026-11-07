/**
 * TEST-MOD-03 — the txrmodels board copy formatters (PROV-UI-MODELS-4,
 * ITEM-2; the INV-4/6 postures the TEST-MOD-02 hygiene scan records).
 *
 * Every expected string below is board copy, byte-for-byte, from
 * `Models.dc.html` (the J table's Predicts / Trained on / Made column entries + the
 * Model subline), `Pretrained.dc.html` / `Saved.dc.html` (the bottom-bar
 * research notice) and `SaveModels.dc.html` / `SaveOne.dc.html` (the save
 * dialogs' ruled copy + the training-data warning sentence). The boards'
 * numbers are design examples — these tests pin the FORMAT of facts the
 * host passes, never a board value.
 *
 * The "never blank" rule: every formatter yields a constant - the
 * `UNRECORDED` word ("not recorded", the board's own fallback) - for a
 * null datum, with exactly the two deliberate blanks the boards pin: the
 * empty model subline (the column shows the name alone) and the empty
 * warning line (the dialog renders no warning). No formatter ever returns
 * a numerical null spelled into an entry.
 *
 * The pinned dates are TZ-proof by construction: the fixture instants are
 * built from local-noon `new Date(y, m, d, 12)` values, so the en-GB
 * day-month-year rendering is the same calendar day in every zone.
 */
import { describe, expect, it } from 'vitest'
import {
  NOT_SAVED_LABEL,
  NOT_SAVED_TEXT,
  RESEARCH_NOTICE,
  SAVE_ONE_WHAT_IS_SAVED_TEXT,
  SAVE_SET_WHAT_IS_SAVED_TEXT,
  TRAINING_WARNING_KEEP,
  TRAINING_WARNING_STAYS,
  UNRECORDED,
  WHAT_IS_SAVED_LABEL,
  formatBytes,
  formatMade,
  formatModelSublines,
  formatPredicts,
  formatTrainingDataWarning,
  formatTrainedOn,
} from './format'

/** A local-noon instant, so the en-GB date rendering is zone-independent. */
function localNoonIso(year: number, month: number, day: number): string {
  return new Date(year, month - 1, day, 12, 0, 0).toISOString()
}

describe('formatPredicts — the J Predicts column (TEST-MOD-03)', () => {
  it('spells the three board lines from the task vocabulary', () => {
    expect(formatPredicts('pfs', 'pfs', 238)).toBe('progression, death by day 238')
    expect(formatPredicts('os', 'os', 238)).toBe('death by day 238')
    expect(formatPredicts('response', 'os', 182)).toBe('no response by day 182')
  })

  it('falls to the endpoint flavor when the task is unclassified', () => {
    // The summary row's `task` is nullable until the run classifies the
    // method (ModelSummary.task); the endpoint carries the analysis flavor.
    expect(formatPredicts(null, 'pfs', 224)).toBe('progression, death by day 224')
    expect(formatPredicts(null, 'os', 56)).toBe('death by day 56')
  })

  it('renders the constant, never a blank or a half-spelled entry, for null inputs', () => {
    expect(formatPredicts(null, null, null)).toBe(UNRECORDED)
    expect(formatPredicts('pfs', 'pfs', null)).toBe(UNRECORDED)
    expect(formatPredicts(null, null, 56)).toBe(UNRECORDED)
    expect(formatPredicts('pfs', 'pfs', Number.NaN)).toBe(UNRECORDED)
  })
})

describe('formatMade — the J Made column (TEST-MOD-03)', () => {
  it('renders the run date and the opened verb for imported provenance', () => {
    expect(formatMade(localNoonIso(2026, 10, 21), 'run')).toBe('21 Oct 2026')
    expect(formatMade(localNoonIso(2026, 10, 14), 'imported')).toBe('opened 14 Oct 2026')
  })

  it('reads the opened verb for a pretrained row too (it was installed, not trained on this machine)', () => {
    expect(formatMade(localNoonIso(2026, 10, 21), 'pretrained')).toBe('opened 21 Oct 2026')
  })

  it('renders the constant for a missing or unparseable instant', () => {
    expect(formatMade(null, 'run')).toBe(UNRECORDED)
    expect(formatMade('', 'run')).toBe(UNRECORDED)
    expect(formatMade('not-a-date', 'imported')).toBe(UNRECORDED)
  })
})

describe('formatTrainedOn — the J Trained-on column (TEST-MOD-03)', () => {
  it('spells the count with the board plural', () => {
    expect(formatTrainedOn(151)).toBe('151 patients')
    expect(formatTrainedOn(1)).toBe('1 patient')
    expect(formatTrainedOn(0)).toBe('0 patients')
  })

  it('renders the constant, never a blank, for an unknown cohort size', () => {
    expect(formatTrainedOn(null)).toBe(UNRECORDED)
    expect(formatTrainedOn(Number.NaN)).toBe(UNRECORDED)
  })
})

describe('formatModelSublines — the J Model subline (TEST-MOD-03)', () => {
  it('joins the board facts in the board order with the board separator', () => {
    expect(formatModelSublines(6, true, null)).toBe('6 markers \u00b7 uses age')
    expect(formatModelSublines(4, false, null)).toBe('4 markers')
    expect(formatModelSublines(5, false, 'breast-panel.txr')).toBe(
      'opened from breast-panel.txr \u00b7 5 markers',
    )
    expect(formatModelSublines(2, true, 'x.txr')).toBe('opened from x.txr \u00b7 2 markers \u00b7 uses age')
  })

  it('spells the singular at one marker', () => {
    expect(formatModelSublines(1, false, null)).toBe('1 marker')
  })

  it('renders the name alone when no fact applies (the board null-facts row)', () => {
    expect(formatModelSublines(null, false, null)).toBe('')
    expect(formatModelSublines(null, false, '')).toBe('')
  })

  it('stills spells a fact when only one is present', () => {
    expect(formatModelSublines(null, true, null)).toBe('uses age')
    expect(formatModelSublines(null, false, 'breast-panel.txr')).toBe('opened from breast-panel.txr')
  })
})

describe('formatBytes — the sizes (TEST-MOD-03)', () => {
  it("formats the board's checklist sizes", () => {
    expect(formatBytes(1_258_291)).toBe('1.2 MB')
    expect(formatBytes(6_603_981)).toBe('6.3 MB')
    expect(formatBytes(104_858)).toBe('0.1 MB')
  })

  it('spells whole megabytes for the larger sizes', () => {
    expect(formatBytes(42_991_616)).toBe('41 MB')
    expect(formatBytes(Math.round(41.4 * 1024 * 1024))).toBe('41 MB')
  })

  it('drops to kilobytes and bytes below the board granularity', () => {
    expect(formatBytes(100 * 1024)).toBe('100 KB')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(0)).toBe('0 B')
  })

  it('renders the constant for null / negative / non-finite inputs', () => {
    expect(formatBytes(null)).toBe(UNRECORDED)
    expect(formatBytes(-1)).toBe(UNRECORDED)
    expect(formatBytes(Number.NaN)).toBe(UNRECORDED)
  })
})

describe('the training-data warning sentence (SaveModels.dc.html)', () => {
  it('composes the board line with the count and the run\'s method order', () => {
    expect(formatTrainingDataWarning(['dynforest', 'flirti'])).toBe(
      '2 models (dynforest, flirti) keep parts of the training data inside them. They stay on this computer; check before you copy or share their files.',
    )
  })

  it('agrees the singular reading for a single training-data-keeping model', () => {
    expect(formatTrainingDataWarning(['dynforest'])).toBe(
      '1 model (dynforest) keeps parts of the training data inside it. It stays on this computer; check before you copy or share its files.',
    )
  })

  it('renders no line for an empty list (the dialog omits the warning)', () => {
    expect(formatTrainingDataWarning([])).toBe('')
    expect(formatTrainingDataWarning(['  '])).toBe('')
  })
})

describe('the board copy constants (ITEM-2)', () => {
  it('carries the D/I bottom-bar notice verbatim (INV-3)', () => {
    expect(RESEARCH_NOTICE).toBe("For research. Not for deciding a patient's treatment.")
  })

  it('carries the save dialogs ruled copy verbatim', () => {
    expect(WHAT_IS_SAVED_LABEL).toBe('What is saved:')
    expect(NOT_SAVED_LABEL).toBe('Not saved:')
    expect(SAVE_SET_WHAT_IS_SAVED_TEXT).toBe(
      'each trained model, its settings, the markers and units it needs, and how it did on your data.',
    )
    expect(SAVE_ONE_WHAT_IS_SAVED_TEXT).toBe(
      'the trained model, its settings, the markers and units it needs, and how it did on your data.',
    )
    expect(NOT_SAVED_TEXT).toBe("your patients' tables.")
    expect(TRAINING_WARNING_KEEP).toBe('keep parts of the training data inside them.')
    expect(TRAINING_WARNING_STAYS).toBe(
      'They stay on this computer; check before you copy or share their files.',
    )
  })
})
