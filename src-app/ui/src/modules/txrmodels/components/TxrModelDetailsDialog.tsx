/**
 * TxrModelDetailsDialog — the I row's "Details" dialog (ITEM-7;
 * PROV-UI-MODELS-5, CONS-UM-4, PROV-MS-2).
 *
 * The row's Details action opens the saved model's FULL record, fetched
 * ON DEMAND (`useModelDetail` — the list is never N+1'd): what the model
 * predicts (task / endpoint / horizon), the decision day it was trained
 * for, the cohort it was trained on, when and from where it entered the
 * inventory (the board's "Made" verb), the method + version that produced
 * it, the marker/inputs subline (the board's "N markers · uses age"
 * facts), the catalogue's fixed-required-marker rule when the record
 * declares one, the licence (unrecorded for a user's own rows), the size,
 * the record's warnings — `MODEL_VERSION_MISMATCH` / `DIGEST_MISMATCH` /
 * `REQUIREMENTS_UNRECORDED`, each with the provider's fact line — and the
 * training-data note when the model embeds training data.
 *
 * States (the `TxrModelCardDialog` idiom):
 *
 * - loading — the skeleton;
 * - a 404 (`MODEL_NOT_FOUND` — a row whose tree vanished, or one the
 *   store no longer serves) — the not-found line, never a crash;
 * - any other failure — the error line + Retry (the hook's retry);
 * - the record — the facts.
 *
 * Every fact is read through the hook's typed payload; a never-recorded /
 * not-yet-grown fact renders the module's UNRECORDED constant or omits
 * the segment (the composition rule of the module's formatters), never a
 * blank or a fabricated value. The `required_markers` block is the
 * record's own (the store's, not re-derived); the raw key list the run
 * carried is deliberately not shown — the board draws marker facts, not
 * engine param keys, and this module's copy hygiene (DEC-18) keeps the
 * derived-vocabulary words out of its identifiers.
 *
 * Controlled by `modelId` (null = closed); Escape/backdrop close through
 * the kit Dialog's `onOpenChange`. Test-id convention:
 * `txr-models-details-<id>` (opened state).
 */
import type { CSSProperties, ReactNode } from 'react'
import { Button, Descriptions, Dialog, Skeleton, type DescriptionsItem } from '@txresbench/kit'
import type { ModelDetail, RequiredMarkers } from '@/api-client/types'
import { useModelDetail } from '../data/useModelDetail'
import {
  UNRECORDED,
  formatBytes,
  formatMade,
  formatModelSublines,
  formatPredicts,
  formatTrainedOn,
} from '../lib/format'

/** The one not-found line (a record no longer served). */
const DETAIL_NOT_FOUND_LINE = 'This model is no longer available.'

/** The one network-failure line (the dialog's own, never blank). */
const DETAIL_ERROR_LINE = 'The model details could not be loaded.'

/** The lead paragraph's look (the card dialog's muted body text). */
const LEAD: CSSProperties = {
  margin: '0 0 10px',
  fontSize: 13.5,
  lineHeight: 1.5,
  color: 'var(--txr-text-2)',
}

/** The single-line values' look. */
const VALUE: CSSProperties = { fontSize: 12.5, color: 'var(--txr-text-2)' }

/** The multi-line value blocks (the warning list). */
const BLOCK: CSSProperties = {
  margin: 0,
  fontSize: 12.5,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  color: 'var(--txr-text-2)',
}

/** The error line's look (the dialog's own muted red). */
const ERROR: CSSProperties = { fontSize: 13.5, color: 'var(--txr-danger)' }

/** The board's mono look for the method id. */
const MONO: CSSProperties = {
  fontFamily: "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace",
  fontSize: 12.5,
  color: 'var(--txr-text-2)',
}

/** The board's "Made" verb for a run row (the J column's own words). */
function madeNode(detail: ModelDetail): ReactNode {
  return <span style={VALUE}>{formatMade(detail.created_at, detail.provenance)}</span>
}

/** The fixed-required-marker rule (the catalogue's list, if declared). */
function requiredMarkersNode(required: RequiredMarkers | undefined): ReactNode {
  if (required === undefined || required === null || required.markers.length === 0) {
    return UNRECORDED
  }
  const names = required.markers
    .map(marker => marker.name.trim())
    .filter(name => name.length > 0)
  if (names.length === 0) return UNRECORDED
  return (
    <span style={VALUE}>
      {names.join(', ')} ({required.list_source})
    </span>
  )
}

/** The record's warnings: the provider's fact line, code as the fallback
 *  (a warning always carries a detail per the shape; the fallback keeps
 *  the row honest — never blank). */
function warningNode(detail: ModelDetail): ReactNode {
  const warnings = detail.warnings ?? []
  if (warnings.length === 0) return UNRECORDED
  const lines = warnings.map(warning => {
    const text = warning.detail?.trim() ?? ''
    return text.length > 0 ? text : warning.code
  })
  return <pre style={BLOCK}>{lines.join('\n')}</pre>
}

/** The dialog's fact rows in a stable order. */
function factsOf(detail: ModelDetail): DescriptionsItem[] {
  const items: DescriptionsItem[] = [
    {
      key: 'predicts',
      label: 'Predicts',
      children: (
        <span style={VALUE}>{formatPredicts(detail.task, detail.endpoint, detail.horizon)}</span>
      ),
    },
    {
      key: 'decision-day',
      label: 'Decision day',
      children: <span style={VALUE}>{detail.decision_day}</span>,
    },
    {
      key: 'trained-on',
      label: 'Trained on',
      children: <span style={VALUE}>{formatTrainedOn(detail.trained_on_patients)}</span>,
    },
    {
      key: 'made',
      label: 'Made',
      children: madeNode(detail),
    },
    {
      key: 'method',
      label: 'Method',
      children: (
        <span style={MONO}>
          {detail.method_id} · {detail.method_version}
        </span>
      ),
    },
    {
      key: 'group',
      label: 'Group',
      children: <span style={VALUE}>{detail.group_label || UNRECORDED}</span>,
    },
    {
      key: 'markers',
      label: 'Markers',
      children: (
        <span style={VALUE}>
          {formatModelSublines(
            detail.marker_count ?? null,
            detail.uses_covariates === true,
            detail.imported_from ?? null,
            null,
            // The detail carries the block's kind directly; the summary's
            // flattened `marker_kind` is the same fact (ITEM-5, RES-19).
            detail.marker_facts?.kind ?? detail.marker_kind ?? null,
          ) || UNRECORDED}
        </span>
      ),
    },
    {
      key: 'required-markers',
      label: 'Fixed markers',
      children: requiredMarkersNode(detail.required_markers),
    },
    {
      key: 'licence',
      label: 'Licence',
      children: <span style={VALUE}>{detail.licence || UNRECORDED}</span>,
    },
    {
      key: 'size',
      label: 'Size',
      children: <span style={VALUE}>{formatBytes(detail.size_bytes)}</span>,
    },
    {
      key: 'warnings',
      label: 'Warnings',
      children: warningNode(detail),
    },
  ]
  if (detail.embeds_training_data) {
    items.push({
      key: 'training-data',
      label: 'Training data',
      children: (
        <span style={VALUE}>This model keeps parts of its training data inside it.</span>
      ),
    })
  }
  return items
}

/** The loading skin's rows (the facts' place, never a blank flash). */
const SKELETON_ROWS = 4

export interface TxrModelDetailsDialogProps {
  /** The saved model whose details open; `null` is the closed dialog. */
  modelId: string | null
  /** The close request (Escape / backdrop / the corner ×). */
  onClose: () => void
}

export function TxrModelDetailsDialog({ modelId, onClose }: TxrModelDetailsDialogProps) {
  const { detail, loading, error, retry } = useModelDetail(modelId)

  return (
    <Dialog
      data-testid={modelId === null ? 'txr-models-details' : `txr-models-details-${modelId}`}
      title={modelId === null ? 'Model details' : `${detail?.name ?? modelId} · Model details`}
      open={modelId !== null}
      onOpenChange={open => {
        if (!open) onClose()
      }}
      size="lg"
    >
      {error === 'not-found' ? (
        <p data-testid="txr-models-details-not-found" style={LEAD}>
          {DETAIL_NOT_FOUND_LINE}
        </p>
      ) : error === 'network' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
          <span data-testid="txr-models-details-error" style={ERROR}>
            {DETAIL_ERROR_LINE}
          </span>
          <Button data-testid="txr-models-details-retry" variant="outline" onClick={retry}>
            Retry
          </Button>
        </div>
      ) : detail !== null ? (
        <div data-testid="txr-models-details-body">
          <Descriptions
            data-testid="txr-models-details-facts"
            column={1}
            bordered
            size="sm"
            items={factsOf(detail)}
          />
        </div>
      ) : loading ? (
        <div data-testid="txr-models-details-loading" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {Array.from({ length: SKELETON_ROWS }, (_, i) => (
            <Skeleton key={i} style={{ height: 44, borderRadius: 8 }} />
          ))}
        </div>
      ) : null}
    </Dialog>
  )
}
