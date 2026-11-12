import { Tag } from '@txresbench/kit'

const PRESENTATION: Record<string, { tone: 'default' | 'info' | 'error' | 'success'; label: string }> = {
  pending: { tone: 'default', label: 'Queued' },
  running: { tone: 'info', label: 'Processing' },
  failed: { tone: 'error', label: 'Failed' },
  completed: { tone: 'success', label: 'Ready' },
}

/**
 * A status tag for a dataset's PRIMARY processing job — the on-ingest converter run
 * the upload pipeline queues for the dataset's input, whatever datatype that is —
 * DERIVED server-side from that job (`processing_status`). By default it
 * renders NOTHING for the quiet states (no job, or `completed`) so a list only
 * badges what needs attention: queued / processing / FAILED (with the reason as
 * a hover title). Pass `showCompleted` on a detail surface to also confirm a
 * finished run with a "Ready" tag.
 */
export function ProcessingStatusBadge({
  status,
  error,
  showCompleted = false,
}: {
  status?: string | null
  error?: string | null
  showCompleted?: boolean
}) {
  if (!status) return null
  if (status === 'completed' && !showCompleted) return null
  const p = PRESENTATION[status] ?? { tone: 'default' as const, label: status }
  return (
    <Tag
      tone={p.tone}
      variant="soft"
      // Screen-reader label: without it the row reads "…name… Failed" (failed WHAT?).
      // For a failure, fold the reason in so it's reachable without the hover-only title.
      aria-label={
        status === 'failed' && error
          ? `Processing status: Failed — ${error}`
          : `Processing status: ${p.label}`
      }
      title={status === 'failed' && error ? error : undefined}
      data-testid="dataset-processing-status"
    >
      {p.label}
    </Tag>
  )
}
