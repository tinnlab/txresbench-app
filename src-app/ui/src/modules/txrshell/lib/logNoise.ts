/**
 * `isTechnicalLogNoise` — the ONE start-up-noise predicate of qa-fixes4
 * ITEM-6 (results-r3 R2-10 rest): the setlocale / R-startup lines that
 * opened a run log with one warning per method (the "Show technical
 * output" switch reveals them). The engine's own log content for the
 * locale warnings a sandboxed method's shell and R runtime print on
 * start.
 *
 * Why it lives in `txrshell` and not in the run screen module: the
 * running screen's log panel (txrrun, R2-5) and the results run-log
 * dialog (txrresults, R2-10 rest) must hide the SAME lines, and
 * txrresults cannot import txrrun (txrrun depends on txrresults — the
 * module cycle). The shell module has no txr dependencies, so the
 * predicate is its resident (the `safeText` / `runStatus` precedent).
 *
 * The truth rule: these lines are TRUE output — the switch reveals them —
 * but they are not progress, and a log that opens with 7 warning lines
 * per method hides the run's own lines behind them. Matched on the line
 * content (the engine authors no per-line kind field): `setlocale` (the
 * bash warning), `Setting LC_*` (R's per-locale messages) and the R
 * start-up warning banner. Plain-voice rule: the screens' own copy
 * layer, the lines stay in the store and in the copy text when the
 * switch is on.
 */
export interface LogLineLike {
  content: string
}

const TECHNICAL_NOISE: RegExp = /setlocale|Setting LC_|During startup - Warning/i

export function isTechnicalLogNoise(line: LogLineLike): boolean {
  return TECHNICAL_NOISE.test(line.content)
}
