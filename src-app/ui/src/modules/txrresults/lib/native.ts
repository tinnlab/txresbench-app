/**
 * txrresults — the methods' own results (the score and the yes/no call each
 * method returned, shown under the chances). PURE helpers: the native values
 * travel on each view column in the RESPONSE's patient order, while the
 * tables render SORTED rows; these helpers look a patient's own result up by
 * id, and choose which columns the own-results table shows.
 */
import type { TxrHeatmapColumn } from '../types'

/** One patient's own result from one method; null fields = none returned. */
export interface TxrOwnResult {
  score: number | null
  call: 0 | 1 | null
}

/** The response's patient order as an id → index map (built once per render). */
export function patientIndexOf(patients: ReadonlyArray<string>): Map<string, number> {
  const index = new Map<string, number>()
  patients.forEach((id, i) => {
    if (!index.has(id)) index.set(id, i)
  })
  return index
}

/**
 * One patient's own result from one method column: null when the column has
 * no own results recorded (an older run, a demo replay) — the caller says
 * "not recorded" once, never per patient. A patient outside the column's
 * arrays reads as no score and no call.
 */
export function ownResultOf(
  column: Pick<TxrHeatmapColumn, 'native'>,
  index: ReadonlyMap<string, number>,
  patientId: string,
): TxrOwnResult | null {
  const native = column.native ?? null
  if (native === null) return null
  const i = index.get(patientId)
  if (i === undefined) return { score: null, call: null }
  return {
    score: native.scores[i] ?? null,
    call: native.calls === null ? null : (native.calls[i] ?? null),
  }
}

/** Whether a column has its own results recorded. */
export function hasOwnResults(column: Pick<TxrHeatmapColumn, 'native'>): boolean {
  return column.native !== undefined && column.native !== null
}

/**
 * The columns the own-results table shows, in the run's method order: the
 * view's shown columns AND the ones it dropped for having no chance at all
 * (a saved model with no score-to-chance conversion still has its own
 * score). `all` is the run's column list; membership is by method id.
 */
export function ownResultColumnsOf(
  all: ReadonlyArray<TxrHeatmapColumn>,
  shown: ReadonlyArray<TxrHeatmapColumn>,
  dropped: ReadonlyArray<TxrHeatmapColumn>,
): TxrHeatmapColumn[] {
  const ids = new Set<string>([...shown, ...dropped].map(c => c.methodId))
  return all.filter(c => ids.has(c.methodId))
}
