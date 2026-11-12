/**
 * The MID-RUN watchdog — a Playwright reporter that notices when the origin dies
 * UNDER a run and stops the run instead of letting it narrate the corpse.
 *
 * ## Why the pre-flight is not enough
 *
 * The pre-flight proves the origin at t=0. `viz-full-2.log` died at t≈20s: three
 * specs passed, then the run that actually OWNED the server exited and Playwright
 * killed it (it kills only servers it started, and this run had merely adopted it).
 * The remaining 132 specs each re-discovered `net::ERR_CONNECTION_REFUSED` and each
 * reported it as its own failure, for 10.6 minutes.
 *
 * Reproduced deterministically on this branch before the fix: boot this worktree's
 * showcase, start the tier (it adopts), kill the server at t≈45s → `3 passed`,
 * `18 × net::ERR_CONNECTION_REFUSED`, 2.3 minutes. Identical shape.
 *
 * ## What it does
 *
 * On any failure whose error text carries a CONNECTION-level signature, it re-asks
 * the origin the pre-flight question. Two outcomes, and the asymmetry is the point:
 *
 *   - the origin still proves itself → do nothing. The spec failed for its own
 *     reasons and the suite is doing its job. A watchdog that fired on the error
 *     TEXT alone would abort real runs and would be guarding a string, not a state.
 *   - the origin cannot prove itself → print the banner and stop the run.
 *
 * It therefore keys on RUNTIME STATE (does a server answer /__worktree as us, right
 * now) and uses the error text only as a cheap trigger for asking. This repo has
 * already paid for the other arrangement: a guard that read source text instead of
 * runtime state let a real regression through.
 *
 * Stopping is SIGINT to self, which is Playwright's own graceful-abort path — it
 * tears down workers and the webServers it started, and exits non-zero. A
 * `process.exit()` here would orphan both.
 */
import { resolveWorktreeRoot } from '@txresbench/gallery/scripts/lib/run-key.mjs'

import { DEAD_ORIGIN_SIGNATURE, classifyOrigin, originBanner, originIsOurs } from './harness-origin.mjs'
import { readOrigins } from './harness-preflight.mjs'
import { narrowedOut, narrowingBanner } from './tag-narrowing.mjs'

/** Pull every string a failure can hide its cause in. `error.message` alone misses
 *  the timed-out case, where the navigation error is only in the stack/value. */
export function failureText(result) {
  const parts = []
  for (const e of result?.errors ?? []) parts.push(e?.message ?? '', e?.stack ?? '', String(e?.value ?? ''))
  if (result?.error) parts.push(result.error.message ?? '', result.error.stack ?? '')
  return parts.join('\n')
}

/** Should this result make us re-ask the origin? */
export function looksLikeDeadOrigin(result) {
  if (result?.status !== 'failed' && result?.status !== 'timedOut') return false
  return DEAD_ORIGIN_SIGNATURE.test(failureText(result))
}

export default class HarnessWatchdogReporter {
  constructor(options = {}) {
    this.ownRoot = options.ownRoot || resolveWorktreeRoot()
    this.fetchImpl = options.fetchImpl || fetch
    this.onAbort = options.onAbort || (() => process.kill(process.pid, 'SIGINT'))
    this.probing = false
    this.tripped = false
    this.origins = null
    this.originsError = null
    /** Narrowings the RUNNING config declared — filled in `onBegin`, announced in `onEnd`. */
    this.narrowings = options.narrowings || []
    try {
      this.origins = readOrigins(options.env || process.env)
    } catch (e) {
      // Not fatal here — globalSetup owns "the config forgot to publish origins".
      // Recording it keeps this reporter from silently pretending to watch.
      this.originsError = e
    }
  }

  printsToStdio() {
    return true
  }

  /**
   * Read the narrowing off the config that is ACTUALLY running. Playwright resolves
   * `grepInvert` onto `FullConfig`, so a config that narrows announces itself and one
   * that does not stays quiet — no per-config wiring, and a fifth config that starts
   * excluding a tag is disclosed the day it does.
   */
  onBegin(config, suite) {
    if (this.narrowings.length) return // injected by a test
    const inverts = [config?.grepInvert ?? []].flat().filter(Boolean)
    if (!inverts.length) return
    // The testDir the scan should walk: the project's, falling back to the suite root.
    const testDir = config?.projects?.[0]?.testDir || suite?.location?.file || config?.rootDir
    for (const re of inverts) {
      // The tag as WRITTEN in the pattern (`/@acceptance/` → `@acceptance`). A narrowing
      // whose pattern is not a plain tag is still announced, by its source text — better
      // an unlovely banner than a narrowing that opts itself out of disclosure for being
      // hard to pretty-print.
      const tag = String(re.source ?? re).replace(/^\^|\$$/g, '')
      this.narrowings.push({ tag, testDir })
    }
  }

  /** Exposed for the tests: the whole decision, minus the process signal. */
  async check(result) {
    if (this.tripped || this.probing || !this.origins) return null
    if (!looksLikeDeadOrigin(result)) return null
    this.probing = true
    try {
      for (const o of this.origins) {
        // eslint-disable-next-line no-await-in-loop
        const c = await classifyOrigin(o.port, { ownRoot: this.ownRoot, fetchImpl: this.fetchImpl })
        if (originIsOurs(c)) continue
        this.tripped = true
        // eslint-disable-next-line no-console
        console.error(originBanner(c, { label: `${o.label} (died DURING the run)`, url: o.url }))
        // eslint-disable-next-line no-console
        console.error(
          ' Stopping the run now. The remaining specs would each have re-reported this\n' +
            ' same one fact as their own failure — which is what made a dead server look\n' +
            ' like a catastrophic code regression (viz-full-2.log: 132 failed, 10.6 min).\n',
        )
        return c
      }
      return null
    } finally {
      this.probing = false
    }
  }

  onTestEnd(_test, result) {
    // Playwright does not await this hook, so the probe runs alongside the next
    // spec and the abort lands a second or two later — seconds, not ten minutes.
    void this.check(result).then(c => {
      if (c) this.onAbort()
    })
  }

  onEnd() {
    if (this.originsError) {
      // eslint-disable-next-line no-console
      console.error(`[watchdog] NOT watching any origin: ${this.originsError.message}`)
    }
    // WHAT THIS RUN LEFT OUT, printed AFTER the totals. The config prints the same
    // narrowing at load, but that scrolls off the top of a twenty-minute run and the
    // thing a reader acts on is the last screen — `N passed`, which is the number that
    // gets pasted into a report as if it were the suite. This puts the exclusion beside
    // it, so the totals cannot be read as full coverage without also reading what is
    // missing from them.
    //
    // It reads the RUNNING CONFIG'S OWN `grepInvert` rather than an env var, because
    // this reporter is shared by all four configs and only one of them narrows. Keying
    // on `TXR_E2E_REAL_COMPUTE` would have made the viz/gallery/visual runs — which
    // exclude nothing — print an exclusion notice, and a disclaimer that appears on runs
    // it does not describe is one readers learn to skip. Whatever a config declares is
    // what gets announced; a config that declares no narrowing says nothing.
    for (const { tag, testDir } of this.narrowings) {
      // eslint-disable-next-line no-console
      console.warn(narrowingBanner(narrowedOut({ testDir, tag })))
    }
  }
}
