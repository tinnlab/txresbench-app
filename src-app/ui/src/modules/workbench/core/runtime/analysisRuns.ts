// analysisRuns — the runs belonging to ONE analysis, ordered the way a person asks about them.
//
// "Did my click work?" is answered by the run that is in flight; "what happened last time?" by
// the most recent finished one. So in-flight runs come first and the rest follow newest-first,
// and the list is BOUNDED — an unbounded list on a long-lived project is the cardinality mistake
// the UI checklist calls out, and it would bury the one row the user came for.
//
// Only-in-flight was the tempting simplification and is wrong: the panel would be empty most of
// the time and would answer "did my click work?" exclusively during the window in which the user
// is least likely to be looking (DEC-5).

import type { Job } from '@/api-client/types'
import type { AnalysisContribution } from '@/modules/workbench/core'
/** Resolve the producing analysis id from a job — BEST-EFFORT, because a `Job` carries no
 *  analysis column: the launch stamps it into `params.analysis_id`, and the job NAME is the
 *  analysis title. No match ⇒ `undefined`, never a guess: attributing a run to the wrong
 *  analysis would put a stranger's run under someone's form.
 *
 *  THE KEY IS `analysis_id`, snake_case. It is not a style choice and it may not drift: the
 *  bag this reads is the wire `AnalysisSpec` the launcher serializes
 *  (`jobsCapability.ts` → `analysisSpec.analysis_id`) and the server parses into
 *  `sandbox::spec::AnalysisSpec::analysis_id`, from which provenance takes the run's
 *  `generator_id`. This function read `params.analysisId` from the day it was written until
 *  it was fixed, so the stamped-id branch NEVER matched a real job and every attribution in
 *  the app silently came from the title fallback below — correct only while no two analyses
 *  share a title and no job is named anything but its analysis'.
 *
 *  Lives in CORE because two surfaces need the same answer — this list and a run's own
 *  next-step guidance — and a second reading would let them disagree about the same row. */
export function resolveJobAnalysisId(job: Job, analyses: AnalysisContribution[]): string | undefined {
  const params = job.params as { analysis_id?: unknown } | null | undefined
  const stamped = params?.analysis_id
  if (typeof stamped === 'string' && analyses.some(a => a.id === stamped)) {
    return stamped
  }
  return analyses.find(a => a.title === job.name)?.id
}

/** How many runs one analysis shows. Small deliberately: this is an at-a-glance answer beside a
 *  form, not a history — the Jobs pane is where a full history belongs. */
export const ANALYSIS_RUNS_LIMIT = 5

/** Still going: the states a run passes through before it has an outcome. Mirrors `isActiveJob`
 *  in `jobsScope`, which the project Jobs pane uses for the same question. */
export function isRunning(status: string | undefined): boolean {
  return status === 'queued' || status === 'running'
}

const startedAt = (j: Job): number => {
  const t = Date.parse(String(j.created_at ?? ''))
  return Number.isFinite(t) ? t : 0
}

/**
 * The runs of `analysisId`, in-flight first, then newest-first, capped at `limit`.
 *
 * The analysis is resolved through the SHARED `resolveJobAnalysisId` — best-effort, because a
 * `Job` carries no analysis column. Reused rather than re-derived: a second reading of "which
 * analysis produced this job" would let this list and the run's own guidance disagree about the
 * same row, and the failure would look like a data bug rather than two readers.
 */
export function runsOfAnalysis(
  jobs: readonly Job[],
  analysisId: string,
  analyses: AnalysisContribution[],
  limit: number = ANALYSIS_RUNS_LIMIT,
): Job[] {
  return jobs
    .filter(j => resolveJobAnalysisId(j, analyses) === analysisId)
    .sort((a, b) => {
      const aRunning = isRunning(a.status)
      const bRunning = isRunning(b.status)
      if (aRunning !== bRunning) return aRunning ? -1 : 1
      return startedAt(b) - startedAt(a)
    })
    .slice(0, Math.max(0, limit))
}
