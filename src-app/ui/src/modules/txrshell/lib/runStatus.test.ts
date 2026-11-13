/**
 * qa-fixes4 ITEM-2 — the shared truthful run-status vocabulary
 * (`txrshell/lib/runStatus`): the one word set the K status chip and the
 * G/H results header render, over the engine's own per-state counts.
 * Every specimen below is a report fact (results-r3 R3-results-3,
 * methods-r3 R3-methods-10): 97b25262 (6 of 209 finished, 203 cannot run),
 * e89047e9 (2 of 5 finished, 3 failed), 8eb11087 (4 finished + 1 stopped +
 * 1 skipped), dd62a064 (Stop-all: 4 stopped + 2 skipped, run status
 * stopped).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runStatusWord, truthBucketOf } from './runStatus'

const zero = { finished: 0, failed: 0, stopped: 0, skipped: 0, cannot_run: 0 }

test('"Done" only when every method finished', () => {
  assert.equal(
    runStatusWord('finished', { ...zero, finished: 6 }, 6),
    'Done',
  )
})

test('a finished run with 3 of 5 failed reads "Done, 3 of 5 methods failed"', () => {
  assert.equal(
    runStatusWord('finished', { ...zero, finished: 2, failed: 3 }, 5),
    'Done, 3 of 5 methods failed',
  )
})

test('the 203-of-209 cannot-run run names the cannot-run count', () => {
  assert.equal(
    runStatusWord('finished', { ...zero, finished: 6, cannot_run: 203 }, 209),
    'Done, 203 of 209 methods could not run',
  )
})

test('a finished run with stopped/skipped rows names the unfinished count', () => {
  assert.equal(
    runStatusWord('finished', { ...zero, finished: 4, stopped: 1, skipped: 1 }, 6),
    'Done, 2 of 6 methods were stopped or skipped',
  )
  assert.equal(
    runStatusWord('finished', { ...zero, finished: 5, stopped: 1 }, 6),
    'Done, 1 of 6 methods was stopped or skipped',
  )
})

test('a stopped run reads "Stopped by you" with the skipped count', () => {
  assert.equal(
    runStatusWord('stopped', { ...zero, stopped: 4, skipped: 2 }, 6),
    'Stopped by you (2 skipped)',
  )
  assert.equal(runStatusWord('stopped', { ...zero, stopped: 1 }, 1), 'Stopped by you')
})

test('failed and running keep the board words', () => {
  assert.equal(runStatusWord('failed', { ...zero, failed: 1 }, 1), 'Failed')
  assert.equal(runStatusWord('running', zero, 6), 'Running')
})

test('the one-method singular reads "1 of 1 method failed"', () => {
  assert.equal(
    runStatusWord('finished', { ...zero, failed: 1 }, 1),
    'Done, 1 of 1 method failed',
  )
})

test('truthBucketOf: a finished run with no finished method is the failure truth', () => {
  assert.equal(truthBucketOf('finished', { ...zero, finished: 0 }), 'failed')
  assert.equal(truthBucketOf('finished', { ...zero, finished: 2 }), 'finished')
  assert.equal(truthBucketOf('stopped', { ...zero, finished: 0 }), 'stopped')
  assert.equal(truthBucketOf('failed', { ...zero, failed: 2 }), 'failed')
  // The live statuses have NO status word — the counts segment stays.
  assert.equal(truthBucketOf('running', zero), null)
  assert.equal(truthBucketOf('preparing', zero), null)
  assert.equal(truthBucketOf('finishing', zero), null)
  assert.equal(truthBucketOf('creating', zero), null)
})
