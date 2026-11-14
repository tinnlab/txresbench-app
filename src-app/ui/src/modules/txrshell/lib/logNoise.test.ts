/**
 * qa-fixes4 ITEM-6 (results-r3 R2-10 rest) — the ONE start-up-noise
 * predicate of the log surfaces (`txrshell/lib/logNoise`): the setlocale /
 * R-startup lines a run log opens with (one warning per method). The
 * specimens are the report's own lines (results-r3 R2-10: "setlocale:
 * LC_ALL: cannot change locale", "Setting LC_CTYPE failed", R "not all
 * columns named in 'colClasses' exist" is NOT noise — it is the run's own
 * line); the predicate moved here from txrrun (its R2-5 pins) so the
 * running panel and the results dialog hide the same lines without a
 * module cycle.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTechnicalLogNoise } from './logNoise'

const line = (content: string) => ({ content })

test('names the setlocale / R start-up lines as technical output — never the run\'s own lines', () => {
  assert.equal(
    isTechnicalLogNoise(line('/bin/bash: warning: setlocale: LC_ALL: cannot change locale (C.UTF-8)')),
    true,
  )
  assert.equal(isTechnicalLogNoise(line('During startup - Warning messages:')), true)
  assert.equal(isTechnicalLogNoise(line('1: Setting LC_CTYPE failed, using "C"')), true)
  assert.equal(isTechnicalLogNoise(line('7: Setting LC_MEASUREMENT failed')), true)
  assert.equal(isTechnicalLogNoise(line('cox-baseline-delta done in 12s')), false)
  assert.equal(isTechnicalLogNoise(line('fitting the model')), false)
  // The R colClasses warning is the run's own line — technical toggle
  // content, never hidden as start-up noise (the running panel collapses
  // its repeated block instead, qa-fixes4 ITEM-3).
  assert.equal(
    isTechnicalLogNoise(line('not all columns named in "colClasses" exist')),
    false,
  )
})
