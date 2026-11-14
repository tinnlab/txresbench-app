/**
 * qa-fixes4 ITEM-2 (results-r3 R3-results-3, methods-r3 R3-methods-10/-11)
 * — the truth rules over a run's methods that did not finish: grouping by
 * (state, reason code) so that 203 same-reason failures become ONE card,
 * not 203 cards, with the per-method reasons in the expandable list, and
 * the true "other N methods are shown" count.
 *
 * The grouping key is the sibling reason CODE (not the detail text): the
 * reason codes are the one closed vocabulary, and a text classifier would
 * misfire (the same stored detail sentence can carry per-method words —
 * old runs stored "no published environment for method <id>"). The group's
 * sentence is code-informed (the ITEM-1 addendum's own mapping): the
 * env-family codes read the plan's sentence "their environments are not
 * available yet"; any other code reads the group's first detail verbatim
 * (the per-method reasons stay in the expandable list).
 *
 * The tail's "other N" is the FINISHED count (the run's `counts.finished`)
 * — the true number of methods the table shows, never the board's
 * "total minus one" the round-3 report found false ("The other 208 methods
 * are shown" next to 6 finished).
 */
import type { TxrRunMethod, TxrRunReason } from '@/api-client/types'
import { formatReasonText } from './format'

/** One trouble row: a run method that did not reach `finished`. */
export interface TxrTroubleRow {
  methodId: string
  /** The catalogue id (the board's monospace name); a reuse row's uuid
   *  method id is never rendered raw — the label is the truth (f). */
  label: string
  state: 'failed' | 'cannot_run' | 'stopped' | 'skipped'
  reason?: TxrRunReason
}

/** The terminal non-finished states the trouble surface owns. */
export type TxrTroubleState = TxrTroubleRow['state']

/**
 * The run's trouble rows: the methods that did not reach `finished`
 * (failed / cannot_run / stopped / skipped), mapped to the display rows
 * with the label first — a reuse run's `method_id` is a model uuid and is
 * never the rendered name (PLAN ITEM-2 (f): no raw UUIDs on screen).
 */
export function troubleRowsOf(methods: ReadonlyArray<TxrRunMethod>): TxrTroubleRow[] {
  const rows: TxrTroubleRow[] = []
  for (const method of methods) {
    if (
      method.state !== 'failed' &&
      method.state !== 'cannot_run' &&
      method.state !== 'stopped' &&
      method.state !== 'skipped'
    ) {
      continue
    }
    rows.push({
      methodId: method.method_id,
      label: method.label.length > 0 ? method.label : method.method_id,
      state: method.state,
      ...(method.reason !== undefined ? { reason: method.reason } : {}),
    })
  }
  return rows
}

/** The env-family reason codes (the ITEM-1 sanitiser's own family — ONE
 *  vocabulary for the two lines of defence). */
export const ENV_FAMILY_CODES: ReadonlySet<string> = new Set([
  'ENV_UNKNOWN',
  'ENV_IMAGE_TOOL_MISSING',
  'ENV_TOOL_MISSING',
  'SANDBOX_UNAVAILABLE',
  'METHOD_ENTRYPOINT_MISSING',
])

/** Whether a reason code belongs to the env family (its sentence is the
 *  plan's environment sentence, never a per-method stored detail). */
export function isEnvFamilyCode(code: string | null | undefined): boolean {
  return code !== undefined && code !== null && ENV_FAMILY_CODES.has(code)
}

/** One trouble group (same state + same reason code — one card). */
export interface TxrTroubleGroup {
  state: TxrTroubleRow['state']
  /** The group's reason code (null = no code recorded — a row set cannot
   *  meet a code it never received). */
  code: string | null
  rows: TxrTroubleRow[]
  /** The env-family flag the sentence builder reads. */
  envFamily: boolean
}

/**
 * Group trouble rows by (state, reason code), first-appearance order (the
 * run's own method order — the engine's row order, never a re-sort).
 * State + code is the honest key: the SAME code across states is two
 * different facts (a stopped ENV_* row is not a cannot-run ENV_* row).
 */
export function groupTroubleRows(rows: ReadonlyArray<TxrTroubleRow>): TxrTroubleGroup[] {
  const groups: TxrTroubleGroup[] = []
  const byKey = new Map<string, TxrTroubleGroup>()
  for (const row of rows) {
    const code = row.reason?.code ?? null
    const key = `${row.state}|${code ?? ''}`
    let group = byKey.get(key)
    if (group === undefined) {
      group = { state: row.state, code, rows: [], envFamily: isEnvFamilyCode(code) }
      byKey.set(key, group)
      groups.push(group)
    }
    group.rows.push(row)
  }
  return groups
}

/**
 * The one-sentence heading of a group ("203 methods could not run: their
 * environments are not available yet."). The count + noun is this
 * function's; the reason sentence is code-informed (the env family) or the
 * group's first stored detail verbatim (the per-method reasons live in the
 * expandable list — the heading never re-authors a per-method fact).
 */
export function troubleHeading(group: TxrTroubleGroup): string {
  const n = group.rows.length
  const noun = n === 1 ? 'method' : 'methods'
  const detail = group.rows[0]?.reason
  const text = formatReasonText(detail?.code, detail?.detail)
  switch (group.state) {
    case 'cannot_run':
      return group.envFamily
        ? `${n} ${noun} could not run: their environments are not available yet.`
        : `${n} ${noun} could not run: ${text}`
    case 'failed':
      return `${n} ${noun} failed: ${text}`
    case 'stopped': {
      const tail = detail !== undefined && detail.detail.trim().length > 0 ? `: ${text}` : ''
      return `${n} ${noun} ${n === 1 ? 'was' : 'were'} stopped${tail}.`
    }
    case 'skipped':
      return `${n} ${noun} ${n === 1 ? 'was' : 'were'} skipped.`
  }
  const _exhaustive: never = group.state
  return _exhaustive
}

/**
 * The true "other N" tail (qa-fixes4 ITEM-2): N is the run's finished
 * count — the methods the table actually shows. Null when nothing
 * finished (the terminal failure state owns its own copy).
 */
export function othersShownTail(finishedCount: number): string | null {
  if (finishedCount <= 0) return null
  return `The other ${finishedCount} ${finishedCount === 1 ? 'method' : 'methods'} are shown.`
}

/** The row's state word (the F screen's chip words, DEC-2's vocabulary). */
export function troubleStateWord(state: TxrTroubleRow['state']): string {
  switch (state) {
    case 'failed':
      return 'failed'
    case 'cannot_run':
      return 'cannot run'
    case 'stopped':
      return 'stopped'
    case 'skipped':
      return 'skipped'
  }
  const _exhaustive: never = state
  return _exhaustive
}
