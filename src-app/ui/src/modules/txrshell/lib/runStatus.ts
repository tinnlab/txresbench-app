/**
 * `runStatusWord` — the ONE truthful run-status vocabulary of qa-fixes4
 * ITEM-2 (results-r3 R3-results-1/-3, methods-r3 R3-methods-4/-7/-10/-11,
 * DEC-3): "Done" only when every method finished; partial failures and
 * user stops are named ("Done, 3 of 5 methods failed", "Stopped by you
 * (2 skipped)"); "Failed" when no method finished.
 *
 * Why it lives in `txrshell` and not in either screen module: the K status
 * chip (txrhistory) and the G results-page header (txrresults) must speak
 * the SAME vocabulary (the plan's own words), and txrresults already
 * consumes txrhistory's builders — a txrhistory import back would close a
 * module cycle. The shell module has no txr dependencies, so the one pure
 * word builder is its resident (the `safeText` precedent, ITEM-1).
 *
 * The truth rule (DEC-3, the engine's own accounting):
 * - `finished` bucket + every method finished → "Done";
 * - `finished` bucket + failures → "Done, N of M methods failed" (the
 *   failed count first — the dominant truth); no failures but
 *   cannot-run rows → "Done, N of M methods could not run"; otherwise
 *   stopped/skipped rows → "Done, N of M methods were stopped or skipped";
 * - `stopped` bucket → "Stopped by you" + the skipped count (the waiting
 *   methods a Stop-all never started — the round-3 report's "2 skipped");
 * - `failed` bucket → "Failed";
 * - `running` bucket → "Running" (untouched).
 *
 * Pure and framework-free: the modules render the WORD with their own
 * tones (K's status palette, G's subtitle segment); nothing here renders.
 */
/** The count facts the vocabulary reads (the engine's `TxrRunCounts` pick). */
export interface RunCountsLike {
  finished: number
  failed: number
  stopped: number
  skipped: number
  cannot_run: number
}

/** The four-bucket run vocabulary (the K filter's own words). */
export type RunStatusBucket = 'running' | 'finished' | 'stopped' | 'failed'

/**
 * The TRUTH bucket of a run (qa-fixes2 R2-02's rule, read from the counts
 * — the engine's `predictions_ready` is `finished > 0`, TEST-EE-9): a
 * `finished` run whose counts report NO finished method is the failure
 * truth ("Failed"), never a done truth. The live statuses
 * (`creating|preparing|running|finishing`) have no status word — the
 * counts segment is the live header's own.
 */
export function truthBucketOf(status: string, counts: RunCountsLike): RunStatusBucket | null {
  if (status === 'finished') return counts.finished > 0 ? 'finished' : 'failed'
  if (status === 'stopped' || status === 'failed') return status
  return null
}

/**
 * The truthful status word of one run. `methodCount` is the run's
 * selected-method count (the "of M" figure); the counts are the engine's
 * own per-state accounting — this function never computes a count from
 * anything but them.
 */
export function runStatusWord(
  bucket: RunStatusBucket,
  counts: RunCountsLike,
  methodCount: number,
): string {
  switch (bucket) {
    case 'running':
      return 'Running'
    case 'failed':
      return 'Failed'
    case 'stopped':
      return counts.skipped > 0
        ? `Stopped by you (${counts.skipped} skipped)`
        : 'Stopped by you'
    case 'finished': {
      if (methodCount > 0 && counts.finished >= methodCount) return 'Done'
      const noun = methodCount === 1 ? 'method' : 'methods'
      if (counts.failed > 0) return `Done, ${counts.failed} of ${methodCount} ${noun} failed`
      if (counts.cannot_run > 0) {
        return `Done, ${counts.cannot_run} of ${methodCount} ${noun} could not run`
      }
      const stoppedOrSkipped = counts.stopped + counts.skipped
      if (stoppedOrSkipped > 0) {
        return `Done, ${stoppedOrSkipped} of ${methodCount} ${noun} ${stoppedOrSkipped === 1 ? 'was' : 'were'} stopped or skipped`
      }
      return 'Done'
    }
  }
  // Exhaustive over the bucket union; a grown bucket fails here at compile
  // time until its word is spelled.
  const _exhaustive: never = bucket
  return _exhaustive
}
