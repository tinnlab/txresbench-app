// ONE attach-picker option: the `SelectOption` the kit `<Select>` renders for a
// candidate dataset. Split out of the panel so the exact node the picker shows is
// directly renderable in a test — the panel calls this and does nothing else to it.

import type { SelectOption } from '@ziee/kit'
import { Tag } from '@ziee/kit'
import { ProcessingStatusBadge } from '@/modules/datasets/components/ProcessingStatusBadge'
import { candidateSearchText, isReady, type AttachCandidate } from './attachOptions'

export interface AttachOptionDeps {
  /** The datatype's display title — a CONTRIBUTED string, resolved by the caller. */
  typeLabel: string
  /**
   * What the dataset holds: the one-line `text` plus the fuller `detail` for hover.
   * `null` means "we do not know" (the summary has not loaded, or this dataset was
   * outside the read's cap) and renders NOTHING — never a claim of emptiness.
   */
  holdings: { text: string; detail: string } | null
}

/**
 * Two lines: identity + readiness on top, holdings underneath.
 *
 * A not-ready candidate is MARKED, not removed — the badge carries the status and,
 * for a failure the server surfaced a reason for, that reason as its hover + its
 * accessible name. Both lines truncate, so a long name in a narrow panel shortens
 * instead of wrapping the row.
 */
export function buildAttachOption(c: AttachCandidate, deps: AttachOptionDeps): SelectOption {
  return {
    value: c.id,
    label: (
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{c.name}</span>
          {!isReady(c) ? (
            <span className="shrink-0" data-testid={`project-attach-opt-status-${c.id}`}>
              <ProcessingStatusBadge status={c.processingStatus} error={c.processingError} />
            </span>
          ) : null}
          <Tag
            variant="outline"
            className="shrink-0"
            data-testid={`project-attach-opt-type-${c.id}`}
          >
            {deps.typeLabel}
          </Tag>
        </span>
        {deps.holdings ? (
          <span
            className="truncate text-xs text-muted-foreground"
            title={deps.holdings.detail}
            data-testid={`project-attach-opt-holdings-${c.id}`}
          >
            {deps.holdings.text}
          </span>
        ) : null}
      </span>
    ),
    // The label is a NODE, so the kit's search would otherwise fall back to the option
    // VALUE — the dataset's uuid. Name the haystack explicitly.
    searchText: candidateSearchText(c, deps.typeLabel),
    // The trigger shows only the name (keeps the collapsed control compact).
    selectedLabel: c.name,
  }
}
