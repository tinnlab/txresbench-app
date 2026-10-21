// jobsScope (ITEM-67) — pure paging / status / metric helpers for the project Jobs
// pane. The pane REUSES `modules/jobs` presentational pieces (JobStatusBadge +
// TimeSeriesChart) but scopes the list to ONE project via `GET /api/jobs?project_id=X`
// (the `job_scope` JOIN, ITEM-68) rather than the global owner list the jobs drawer
// shows. These are pure — the pane renders from them; the unit test drives them
// directly (node-env, no React / ApiClient), mirroring `analysis/runHistory.ts`.

import type { JobMetric } from '@/api-client/types'
import type { TimeSeriesPoint } from '@/modules/jobs/components/TimeSeriesChart'

/** The default page size for the project jobs list (mirrors the jobs drawer). */
export const DEFAULT_JOBS_PER_PAGE = 10

/** Max nodes to poll/list per page — the pane pages rather than fetch-all-render-all. */
export const JOBS_LIST_MAX_PER_PAGE = 50

/**
 * The project-scoped jobs list query — the single source of the `?project_id=X`
 * contract (ITEM-67 / TEST-315). Always carries `project_id` so the list JOINs
 * `job_scope` server-side (never the global owner list). `per_page` is clamped so a
 * hydrated/oversized value can't request an unbounded page.
 */
export function buildJobsListQuery(
  projectId: string,
  page: number,
  perPage: number,
): { project_id: string; page: number; per_page: number } {
  const safePage = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1
  const safePer =
    Number.isFinite(perPage) && perPage >= 1
      ? Math.min(Math.floor(perPage), JOBS_LIST_MAX_PER_PAGE)
      : DEFAULT_JOBS_PER_PAGE
  return { project_id: projectId, page: safePage, per_page: safePer }
}

/** Still-controllable states: queued → cancel, running → stop (mirrors JobList). */
export function isActiveJob(status: string): boolean {
  return status === 'queued' || status === 'running'
}

/** Terminal states — the ones a completed operational monitor rests at. */
export function isTerminalJob(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'stopped'
}

/** Page boundaries for the "Showing X–Y of Z" idiom + total page count. */
export function jobsPageBounds(
  page: number,
  perPage: number,
  total: number,
): { from: number; to: number; totalPages: number } {
  const from = total === 0 ? 0 : (page - 1) * perPage + 1
  const to = Math.min(page * perPage, total)
  const totalPages = Math.max(1, Math.ceil(total / Math.max(1, perPage)))
  return { from, to, totalPages }
}

/** The "N of M" jobs count label — the operational monitor's scale-honest header. */
export function jobsCountLabel(page: number, perPage: number, total: number): string {
  const { from, to } = jobsPageBounds(page, perPage, total)
  return `Showing ${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()} job${
    total === 1 ? '' : 's'
  }`
}

/** CPU-% series for the metric chart (reuses the jobs `TimeSeriesChart` shape). */
export function cpuSeries(metrics: JobMetric[]): TimeSeriesPoint[] {
  return metrics.map(m => ({ t: m.sampled_at, v: m.cpu_pct }))
}

/** Memory series in MB for the metric chart. */
export function memSeries(metrics: JobMetric[]): TimeSeriesPoint[] {
  return metrics.map(m => ({ t: m.sampled_at, v: m.mem_bytes / 1_048_576 }))
}
