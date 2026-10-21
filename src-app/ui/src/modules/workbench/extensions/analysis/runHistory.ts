// Run history (ITEM-26 / ITEM-39) — pure paging + filtering helpers over
// `Provenance.runs`. The history pane pages the project's runs (the "N of M" RunsList
// idiom, mirroring the provenance trust view + datasets library), and the per-analysis
// artifacts LIST (ITEM-39) is this same list filtered by the producing analysis. Pure —
// the pane renders from these; the unit test drives them directly.

import type { RunNodeDto } from '@/api-client/types'

export const DEFAULT_RUNS_PER_PAGE = 20

/** Page boundaries for the "Showing X–Y of Z" idiom + total page count. */
export function pageBounds(
  page: number,
  perPage: number,
  total: number,
): { from: number; to: number; totalPages: number } {
  const from = total === 0 ? 0 : (page - 1) * perPage + 1
  const to = Math.min(page * perPage, total)
  const totalPages = Math.max(1, Math.ceil(total / perPage))
  return { from, to, totalPages }
}

/** The "N of M" RunsList count label (ITEM-26). */
export function runsCountLabel(page: number, perPage: number, total: number): string {
  const { from, to } = pageBounds(page, perPage, total)
  return `Showing ${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()}`
}

/** A completed run — the ones ITEM-26 surfaces for reviewing artifacts + lineage. */
export function isCompletedRun(run: RunNodeDto): boolean {
  const s = run.status.toLowerCase()
  return s === 'completed' || s === 'succeeded' || s === 'success'
}

/** Filter runs to a single producing analysis (ITEM-39 per-analysis artifacts LIST). An
 *  empty/undefined `generatorId` returns all runs (the generic project history). */
export function filterRunsByAnalysis(runs: RunNodeDto[], generatorId?: string): RunNodeDto[] {
  if (!generatorId) return runs
  return runs.filter(r => r.generator_id === generatorId)
}

/** A short, human run label (analysis id + short run id) for a history row. */
export function runLabel(run: RunNodeDto): string {
  const short = run.run_id.slice(0, 8)
  return `${run.generator_id} · ${short}`
}
