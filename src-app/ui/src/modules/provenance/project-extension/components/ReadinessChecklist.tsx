import { Badge, Empty } from '@ziee/kit'
import { Check, X } from 'lucide-react'
import type { ReadinessDto } from '@/api-client/types'

/** The six independent readiness flags, in checklist order (ITEM-21, +ITEM-4). */
const CHECKS: { key: keyof Omit<ReadinessDto, 'ready'>; label: string }[] = [
  { key: 'code_captured', label: 'Analysis code captured' },
  { key: 'env_pinned', label: 'Environment pinned' },
  { key: 'inputs_checksummed', label: 'Inputs checksummed' },
  // ITEM-4: without a run's real params an export replays the processor on its
  // DEFAULTS — a silently different answer. Surfaced as its own row so the
  // failure is visible, not just folded into the overall `ready` badge.
  { key: 'params_captured', label: 'Analysis parameters captured' },
  { key: 'seeds_set', label: 'Random seeds set' },
  { key: 'roots_have_provenance', label: 'Source data has provenance' },
]

/**
 * The reproducibility readiness checklist — the 6 independent `ReadinessDto`
 * flags plus the overall `ready` badge (true only when all six pass). The
 * "at-a-glance can this be reproduced" summary above the run table.
 */
export function ReadinessChecklist({ readiness }: { readiness: ReadinessDto | null }) {
  if (!readiness) {
    return (
      <Empty
        description="Readiness is computed once a project has recorded runs."
        data-testid="provenance-readiness-empty"
      />
    )
  }

  return (
    <div className="flex flex-col gap-3" data-testid="provenance-readiness">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Reproducibility readiness</span>
        <Badge
          tone={readiness.ready ? 'success' : 'warning'}
          data-testid="provenance-readiness-overall"
        >
          {readiness.ready ? 'Ready' : 'Not ready'}
        </Badge>
      </div>
      <ul className="flex flex-col gap-2">
        {CHECKS.map(c => {
          const pass = readiness[c.key]
          return (
            <li
              key={c.key}
              className="flex items-center gap-2 text-sm"
              data-testid={`provenance-readiness-${c.key}`}
            >
              {pass ? (
                <Check className="size-4 text-success" aria-label="Pass" />
              ) : (
                <X className="size-4 text-destructive" aria-label="Fail" />
              )}
              <span className={pass ? '' : 'text-muted-foreground'}>{c.label}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
