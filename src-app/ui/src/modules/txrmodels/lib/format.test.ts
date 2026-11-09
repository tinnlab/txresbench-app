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
  formatCheckedAgainstLine,
  formatMade,
  formatModelSublines,
  formatPredicts,
  formatSavedTotals,
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
    expect(formatModelSublines(6, true, null, null, 'single')).toBe(
      '6 markers \u00b7 uses age',
    )
    expect(formatModelSublines(4, false, null, null, 'single')).toBe('4 markers')
    expect(formatModelSublines(5, false, 'breast-panel.txr', null, 'single')).toBe(
      'opened from breast-panel.txr \u00b7 5 markers',
    )
    expect(formatModelSublines(2, true, 'x.txr', null, 'single')).toBe(
      'opened from x.txr \u00b7 2 markers \u00b7 uses age',
    )
  })

  it('spells the singular at one marker', () => {
    expect(formatModelSublines(1, false, null, null, 'single')).toBe('1 marker')
  })

  it('renders the name alone when no fact applies (the board null-facts row)', () => {
    expect(formatModelSublines(null, false, null, null, 'single')).toBe('')
    expect(formatModelSublines(null, false, '', null, 'single')).toBe('')
  })

  it('stills spells a fact when only one is present', () => {
    expect(formatModelSublines(null, true, null, null, 'single')).toBe('uses age')
    expect(formatModelSublines(null, false, 'breast-panel.txr', null, 'single')).toBe(
      'opened from breast-panel.txr',
    )
  })

  it('reads the marker KIND, never a bare count, for the catalogue any-mode rows (RES-19)', () => {
    // 77 shipped methods record kind `any` with count 0 — "0 markers" would
    // say a method that runs on ANY marker uses none.
    expect(formatModelSublines(0, false, null, null, 'any')).toBe('any marker')
    // The defensive no-kind read keeps the count wording (a grown response).
    expect(formatModelSublines(0, false, null, null, undefined)).toBe('0 markers')
  })

  it('names the set the model was saved in when it differs from the display name (RES-17)', () => {
    expect(formatModelSublines(6, true, null, 'Second run, day 60', 'single')).toBe(
      '6 markers \u00b7 uses age \u00b7 from the set \'Second run, day 60\'',
    )
    // The caller already suppressed a set name equal to the model's own.
    expect(formatModelSublines(6, true, null, null, 'single')).toBe(
      '6 markers \u00b7 uses age',
    )
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

describe('formatSavedTotals — screen I\'s totals line (ITEM-5, RES-22)', () => {
  it('counts can-run as what can start — fit AND some — so the sentence agrees with the chip', () => {
    // The old line read "6 can run, 0 cannot, 6 partly" next to the chip
    // "Can run 12" — two accountings of one set. One definition: the 12
    // non-disabled rows (6 for all patients, 6 for some) all START.
    expect(formatSavedTotals(12, 6, 6, 0)).toBe(
      '12 saved models shown \u00b7 12 can run, 0 cannot (6 of them for some patients)',
    )
  })

  it('omits the some-split when no model is partial (never a zero sentence)', () => {
    expect(formatSavedTotals(10, 8, 0, 2)).toBe('10 saved models shown \u00b7 8 can run, 2 cannot')
    expect(formatSavedTotals(10, 0, 0, 10)).toBe('10 saved models shown \u00b7 0 can run, 10 cannot')
  })

  it('keeps the closed accounting: fit + some + cannot == shown', () => {
    expect(formatSavedTotals(13, 6, 2, 5)).toBe(
      '13 saved models shown \u00b7 8 can run, 5 cannot (2 of them for some patients)',
    )
  })
})

describe('formatCheckedAgainstLine — the D/I checked-against line (ITEM-5, RES-22)', () => {
  const raw = (days: ReadonlyArray<number>) => ({
    inventory: { patients: 94, markers: [{ id: 'ctdna_1' }, { id: 'ctdna_2' }] },
    measurements: { distinct_draw_days: days },
  })

  it('keeps the board spelling for four or fewer draw days', () => {
    expect(formatCheckedAgainstLine(raw([0, 14, 28, 56]), 'Pick as many as you like.')).toBe(
      'Checked against your file: 94 patients, 2 markers, draws at day 0, 14, 28 and 56. Pick as many as you like.',
    )
    expect(formatCheckedAgainstLine(raw([35]), 'Pick as many as you like.')).toBe(
      'Checked against your file: 94 patients, 2 markers, draws at day 35. Pick as many as you like.',
    )
  })

  it('reads a count, never a 14-item list, for a file with many draw days', () => {
    const days = [0, 35, 39, 40, 49, 63, 70, 84, 91, 105, 120, 180, 240, 799]
    expect(formatCheckedAgainstLine(raw(days), 'Models from one training run are grouped; pick any of them.')).toBe(
      'Checked against your file: 94 patients, 2 markers, draws on 14 days. Models from one training run are grouped; pick any of them.',
    )
  })

  it('omits the draw segment when the file records no draw days', () => {
    expect(formatCheckedAgainstLine(raw([]), 'Pick as many as you like.')).toBe(
      'Checked against your file: 94 patients, 2 markers. Pick as many as you like.',
    )
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
