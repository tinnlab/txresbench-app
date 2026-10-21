// Pure helpers for the dataset supporting-files surface (ITEM-15 / ITEM-16).
//
// A supporting file is an axis-aligned annotation table folded onto a primary
// dataset; its integrate job carries a per-file `integration_status` + a coverage
// `integration_summary`. These helpers derive the small view-model the panel needs
// without any store coupling (unit-testable, reused by the gallery seeds).

import type { AxisSpec, Datatype, DatasetFile, DatasetWithFiles } from '@/api-client/types'
import type { TagTone } from '@ziee/kit'

/** The supporting (non-primary) files linked into a dataset (ITEM-15). */
export function supportingFiles(dataset: DatasetWithFiles | null): DatasetFile[] {
  if (!dataset) return []
  return dataset.files.filter(f => f.role === 'supporting')
}

/**
 * The AXES a dataset's primary datatype declares (DEC-15) — looked up in the
 * `/datatypes` catalog by the dataset's `datatype` id. An untyped dataset, or a
 * datatype with no aligned axes, yields `[]`.
 */
export function declaredAxes(
  dataset: DatasetWithFiles | null,
  datatypes: Datatype[],
): AxisSpec[] {
  if (!dataset?.datatype) return []
  return datatypes.find(d => d.id === dataset.datatype)?.axes ?? []
}

/**
 * Whether a dataset is CONVERTED — its primary import has completed, so the
 * per-axis entity-index the integrate converter needs exists. The import writes
 * the dataset's `metadata` bag (obs/var names + shape), so a non-empty metadata
 * object on a typed dataset is the frontend signal that the import ran (ITEM-15:
 * the Add control appears only when converted).
 */
export function isConverted(dataset: DatasetWithFiles | null): boolean {
  if (!dataset?.datatype) return false
  const md = dataset.metadata
  return !!md && typeof md === 'object' && Object.keys(md as object).length > 0
}

/** A normalized supporting integration status (defaults to `pending`). */
export type IntegrationStatus = 'pending' | 'running' | 'integrated' | 'failed'

export function integrationStatus(file: DatasetFile): IntegrationStatus {
  switch (file.integration_status) {
    case 'running':
    case 'integrated':
    case 'failed':
      return file.integration_status
    default:
      return 'pending'
  }
}

/** The Tag tone + human label for an integration status (mirrors LineageView). */
export function statusPresentation(status: IntegrationStatus): { tone: TagTone; label: string } {
  switch (status) {
    case 'running':
      return { tone: 'info', label: 'Integrating…' }
    case 'integrated':
      return { tone: 'success', label: 'Integrated' }
    case 'failed':
      return { tone: 'error', label: 'Failed' }
    default:
      return { tone: 'warning', label: 'Queued' }
  }
}

/** Narrow the untyped `integration_summary` JSON into the fields the UI reads. */
function coverage(summary: unknown): {
  matched?: number
  missing?: number
  extra?: number
  error?: string
} {
  if (!summary || typeof summary !== 'object') return {}
  const s = summary as Record<string, unknown>
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)
  return {
    // Prefer the post-normalization matched count (DEC-18) when both are present.
    matched: num(s.matched_after) ?? num(s.matched),
    missing: num(s.missing),
    extra: num(s.extra),
    error: str(s.error) ?? str(s.reason) ?? str(s.message),
  }
}

/**
 * A one-line coverage summary read from `integration_summary`, e.g.
 * "3,410 matched · 12 missing · 5 extra". Null when no counts are present.
 */
export function formatCoverage(summary: unknown): string | null {
  const { matched, missing, extra } = coverage(summary)
  const parts: string[] = []
  if (matched != null) parts.push(`${matched.toLocaleString()} matched`)
  if (missing != null) parts.push(`${missing.toLocaleString()} missing`)
  if (extra != null) parts.push(`${extra.toLocaleString()} extra`)
  return parts.length > 0 ? parts.join(' · ') : null
}

/** The failure reason from a failed integrate job's summary, if any. */
export function coverageError(summary: unknown): string | null {
  return coverage(summary).error ?? null
}
