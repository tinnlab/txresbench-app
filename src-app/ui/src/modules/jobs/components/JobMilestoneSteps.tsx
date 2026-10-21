import { Check, Loader, X } from 'lucide-react'
import type { JobMilestone } from '@/api-client/types'

/**
 * Human-readable one-liner for a milestone's harvested `detail`, whatever the
 * processor put there: a `{count, names}` finding renders as `"3 (alpha, beta)"`,
 * a bare `{note}` renders as its note, and anything else renders as "".
 *
 * (Lifted verbatim from the datasets pipeline's private helper so the job-monitor
 * surfaces and the dataset pipeline share ONE renderer — see DEC-5.)
 */
export function milestoneDetailText(detail: unknown): string {
  if (detail == null || typeof detail !== 'object') return ''
  const d = detail as Record<string, unknown>
  const parts: string[] = []
  if (typeof d.count === 'number') parts.push(String(d.count))
  if (Array.isArray(d.names) && d.names.length > 0) parts.push(`(${d.names.join(', ')})`)
  if (parts.length === 0 && typeof d.note === 'string') parts.push(d.note)
  return parts.join(' ')
}

/**
 * The user-facing STEP TICKER (ITEM-24): the manifest-declared steps a running job
 * has reported, each with a live status glyph + its harvested finding. This is the
 * "what step is it at / what did it find" surface — NOT a bare spinner.
 *
 * Shared, prop-driven: the datasets pipeline and both job-monitor detail surfaces
 * (the global drawer + the workbench pane) render the SAME component from a
 * `JobMilestone[]`. Renders nothing when there are no milestones (a job whose
 * processor declared no steps, or one that has not reported yet).
 */
export function JobMilestoneSteps({
  milestones,
  testidPrefix = 'job-milestone',
}: {
  milestones: readonly JobMilestone[]
  /** testid stem: container is `<prefix>s`, each step is `<prefix>-<milestone_id>`.
   *  Datasets passes `pipeline-milestone` to preserve its existing specs. */
  testidPrefix?: string
}) {
  if (milestones.length === 0) return null
  return (
    // aria-live so a screen reader announces each step as it streams in / transitions.
    <ol
      className="flex flex-col gap-1"
      data-testid={`${testidPrefix}s`}
      aria-label="Processing steps"
      aria-live="polite"
    >
      {milestones.map(m => {
        const done = m.status === 'done'
        const failed = m.status === 'failed'
        const Icon = failed ? X : done ? Check : Loader
        const glyph = failed
          ? 'text-destructive'
          : done
            ? 'text-success'
            : 'animate-spin text-info'
        const statusWord = failed ? 'failed' : done ? 'done' : 'in progress'
        const stepName = m.milestone_id.replace(/_/g, ' ')
        const text = milestoneDetailText(m.detail)
        return (
          <li
            key={m.milestone_id}
            // flex-wrap + a min-w-0 finding span: a long harvested finding (count + a
            // long `names` list) wraps to the next line instead of forcing page-body
            // horizontal scroll at a narrow (390px) width. (INV-5.)
            className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs"
            data-testid={`${testidPrefix}-${m.milestone_id}`}
          >
            {/* status conveyed to AT via the li's sr-only text (not the color/icon alone) */}
            <Icon className={'size-3.5 shrink-0 ' + glyph} aria-hidden />
            <span className="font-medium text-foreground">{stepName}</span>
            {text ? <span className="min-w-0 break-words text-muted-foreground">— {text}</span> : null}
            <span className="sr-only">
              {stepName}: {statusWord}
              {text ? `, ${text}` : ''}
            </span>
          </li>
        )
      })}
    </ol>
  )
}
