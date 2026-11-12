import { Tag } from '@txresbench/kit'

// Semantic tone + HUMAN label per lifecycle state (dark-aware status tokens; no raw
// hues). The label is title-cased ("Completed", not the raw enum "completed") the
// same way the datasets `ProcessingStatusBadge` humanizes its states — a status is a
// badge a human reads, not the wire enum. The raw `data-testid="job-status-<status>"`
// keeps the enum so existing e2e selectors are unchanged.
const STATUS_PRESENTATION: Record<
  string,
  { tone: 'default' | 'primary' | 'success' | 'warning' | 'error' | 'info'; label: string }
> = {
  queued: { tone: 'info', label: 'Queued' },
  running: { tone: 'primary', label: 'Running' },
  completed: { tone: 'success', label: 'Completed' },
  failed: { tone: 'error', label: 'Failed' },
  stopped: { tone: 'default', label: 'Stopped' },
}

/** The human label for a job lifecycle state ("Completed"), or the raw string for an
 *  unknown state. Shared so any surface rendering a job status reads the same word —
 *  the datasets pipeline's own status Tag reuses this rather than printing the enum. */
export function jobStatusLabel(status: string): string {
  return STATUS_PRESENTATION[status]?.label ?? status
}

/** A status badge for a job's lifecycle state. */
export function JobStatusBadge({ status }: { status: string }) {
  const p = STATUS_PRESENTATION[status] ?? { tone: 'default' as const, label: status }
  return (
    <Tag
      tone={p.tone}
      aria-label={`Job status: ${p.label}`}
      data-testid={`job-status-${status}`}
    >
      {p.label}
    </Tag>
  )
}
