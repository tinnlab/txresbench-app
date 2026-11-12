/**
 * TxrModelCardDialog — the D row's "Model card" dialog (ITEM-6;
 * PROV-UI-MODELS-5, CONS-UM-18, PROV-PC-4).
 *
 * The row's Model-card action opens the catalogue entry's full card, fetched
 * ON DEMAND (`usePretrainedCard`, the ITEM-5 binding — the list is never
 * N+1'd): the source paper as TEXT (`paper.citation` — never a link, the
 * INV-5 network posture; a DOI is data, not an anchor), the card's needs
 * block ("what it needs from your file": the task / endpoint / horizon it
 * predicts, the decision day, the marker facts — count, minimum draws,
 * before-treatment requirement — and the fixed required-marker list when
 * the catalogue declares one), the results on other cohorts (the transfer
 * median + the per-cohort values), the assay warnings, the data sources
 * with their recorded licences and access class (INV-8: shipped models are
 * open-data only — the card renders the record; the build gate is the
 * provider's), the model's own licence, and the research-use notice (INV-3).
 *
 * States (the `useMethodDetail` idiom):
 *
 * - loading — the skeleton;
 * - a 404 (`PRETRAINED_UNKNOWN`) — the not-found line (a catalogue that no
 *   longer serves the id is a finite state, never a crash);
 * - any other failure — the error line + Retry (the hook's own retry);
 * - a card — the facts.
 *
 * Every card field is read through the hook's typed payload; a smaller /
 * not-yet-grown payload degrades by omission (`?? null` on the optional
 * blocks — the model-store DEC-18 drift-guard), never to a fabricated
 * fact. A never-found / unrecorded field renders the module's UNRECORDED
 * constant, never a blank.
 *
 * The dialog is controlled by `cardId` (null = closed); Escape/backdrop
 * close through the kit Dialog's `onOpenChange`. Test-id convention:
 * `txr-models-card-<id>` (opened state).
 */
import type { CSSProperties, ReactNode } from 'react'
import { Button, Descriptions, Dialog, Skeleton, type DescriptionsItem } from '@txresbench/kit'
import type { PretrainedModel, PretrainedNeeds } from '@/api-client/types'
import { usePretrainedCard } from '../data/usePretrained'
import { RESEARCH_NOTICE, UNRECORDED, formatBytes, formatPredicts } from '../lib/format'

/** The one not-found line (a card the catalogue no longer serves). */
const CARD_NOT_FOUND_LINE = 'This model is no longer in the catalogue.'

/** The one network-failure line (the dialog's own, never blank). */
const CARD_ERROR_LINE = 'The model card could not be loaded.'

/** The lead paragraph's look (the board's muted body text). */
const LEAD: CSSProperties = {
  margin: '0 0 10px',
  fontSize: 13.5,
  lineHeight: 1.5,
  color: 'var(--txr-text-2)',
}

/** The multi-line value blocks (the citation, the cohort list). */
const BLOCK: CSSProperties = {
  margin: 0,
  fontSize: 12.5,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  color: 'var(--txr-text-2)',
}

/** The single-line values' look. */
const VALUE: CSSProperties = { fontSize: 12.5, color: 'var(--txr-text-2)' }

/** The error line's look (the dialog's own muted red). */
const ERROR: CSSProperties = { fontSize: 13.5, color: 'var(--txr-danger)' }

/** The research-use notice line (the board's own copy, INV-3). */
const NOTICE_LINE: CSSProperties = { fontSize: 13, color: 'var(--txr-muted)' }

/** The access-class word for the data-sources lines (the record's own
 *  vocabulary — a controlled source is named, never hidden). */
function accessWord(access: 'open' | 'controlled'): string {
  return access === 'open' ? 'open data' : 'controlled access'
}

/** The card's needs summary: what the model predicts + what it needs.
 *  The task class is the catalogue's own (`survival` | `response`); the
 *  endpoint/horizon pair is the board's predicts spelling. */
function predictsText(needs: PretrainedNeeds): string {
  if (needs.task === 'response') {
    return `no response by day ${needs.horizon}`
  }
  return formatPredicts(null, needs.endpoint, needs.horizon)
}

/** The one-line "what it needs" sentence (never blank). */
function needsText(needs: PretrainedNeeds): string {
  const parts: string[] = []
  parts.push(`${needs.marker_facts.count} markers`)
  if (needs.marker_facts.needs_baseline) parts.push('a before-treatment draw')
  if (needs.marker_facts.needs_detection_call) parts.push('a detection call')
  if (needs.marker_facts.min_draws > 1) {
    parts.push(`${needs.marker_facts.min_draws} or more draws`)
  } else {
    parts.push('1 or more draws')
  }
  return parts.join(' · ')
}

/** The paper facts: the citation TEXT (never a link — INV-5), with the
 *  journal/year/doi line below when the citation omits it. */
function paperNode(card: PretrainedModel): ReactNode {
  if (card.paper === undefined || card.paper === null) return UNRECORDED
  const { citation, doi, journal, year } = card.paper
  if (citation.trim().length > 0 && citation.includes(doi)) {
    return <pre style={BLOCK}>{citation}</pre>
  }
  return (
    <>
      <pre style={BLOCK}>{citation}</pre>
      <span style={VALUE}>
        {journal} {year} · {doi}
      </span>
    </>
  )
}

/** The per-cohort results block: one line per cohort (dataset → value). */
function cohortsNode(card: PretrainedModel): ReactNode {
  const transfer = card.transfer
  if (transfer === undefined || transfer === null) return UNRECORDED
  const lines = transfer.cohorts.map(cohort => `${cohort.dataset}: ${cohort.value.toFixed(2)}`)
  return <pre style={BLOCK}>{lines.join('\n')}</pre>
}

/** The required-marker list (a fixed catalogue rule) — one line each. */
function requiredMarkersNode(needs: PretrainedNeeds): ReactNode {
  const required = needs.required_markers
  if (required === undefined || required === null || required.markers.length === 0) {
    return UNRECORDED
  }
  return (
    <span style={VALUE}>
      {required.markers.map(marker => marker.name).join(', ')} ({required.list_source})
    </span>
  )
}

/** The assay warnings (code + detail); a card with none says so. */
function warningNode(card: PretrainedModel): ReactNode {
  const warnings = card.assay_warnings ?? []
  if (warnings.length === 0) return UNRECORDED
  return (
    <span style={VALUE}>
      {warnings.map(warning => warning.detail).join(' · ')}
    </span>
  )
}

/** The data-sources block (dataset · access · licence — INV-8's record). */
function dataSourcesNode(card: PretrainedModel): ReactNode {
  if (card.data_sources.length === 0) return UNRECORDED
  const lines = card.data_sources.map(
    source => `${source.dataset} · ${accessWord(source.access)} · ${source.licence}`,
  )
  return <pre style={BLOCK}>{lines.join('\n')}</pre>
}

/** The card's fact rows in the board's card order. */
function factsOf(card: PretrainedModel): DescriptionsItem[] {
  const needs = card.needs
  const items: DescriptionsItem[] = [
    {
      key: 'source-paper',
      label: 'Source paper',
      children: paperNode(card),
    },
    {
      key: 'predicts',
      label: 'Predicts',
      children: <span style={VALUE}>{predictsText(needs)}</span>,
    },
    {
      key: 'decision-day',
      label: 'Decision day',
      children: <span style={VALUE}>{needs.decision_day}</span>,
    },
    {
      key: 'needs',
      label: 'Needs',
      children: <span style={VALUE}>{needsText(needs)}</span>,
    },
    {
      key: 'required-markers',
      label: 'Fixed markers',
      children: requiredMarkersNode(needs),
    },
    {
      key: 'cohort-results',
      label: 'Other cohorts',
      children:
        card.transfer === undefined || card.transfer === null
          ? UNRECORDED
          : `${card.transfer.metric === 'auc_rule' ? 'AUC' : 'c-index'} ${card.transfer.median.toFixed(2)} · ${card.transfer.n_cohorts} ${card.transfer.n_cohorts === 1 ? 'cohort' : 'cohorts'}`,
    },
    {
      key: 'cohort-values',
      label: 'Per cohort',
      children: cohortsNode(card),
    },
    {
      key: 'assay-warnings',
      label: 'Assay warnings',
      children: warningNode(card),
    },
    {
      key: 'data-sources',
      label: 'Data sources',
      children: dataSourcesNode(card),
    },
    {
      key: 'licence',
      label: 'Licence',
      children: <span style={VALUE}>{card.licence || UNRECORDED}</span>,
    },
    {
      key: 'size',
      label: 'Size',
      children: <span style={VALUE}>{formatBytes(card.asset.size_bytes)}</span>,
    },
  ]
  if (card.embeds_training_data) {
    items.push({
      key: 'training-data',
      label: 'Training data',
      children: <span style={VALUE}>This model keeps parts of its training data inside it.</span>,
    })
  }
  return items
}

/** The loading skin's rows (the card's place, never a blank flash). */
const SKELETON_ROWS = 4

export interface TxrModelCardDialogProps {
  /** The catalogue card whose card opens; `null` is the closed dialog. */
  cardId: string | null
  /** The close request (Escape / backdrop / the corner ×). */
  onClose: () => void
}

export function TxrModelCardDialog({ cardId, onClose }: TxrModelCardDialogProps) {
  const { card, loading, error, retry } = usePretrainedCard(cardId)

  return (
    <Dialog
      data-testid={cardId === null ? 'txr-models-card' : `txr-models-card-${cardId}`}
      title={cardId === null ? 'Model card' : `${cardId} · Model card`}
      open={cardId !== null}
      onOpenChange={open => {
        if (!open) onClose()
      }}
      size="lg"
    >
      {error === 'not-found' ? (
        <p data-testid="txr-models-card-not-found" style={LEAD}>
          {CARD_NOT_FOUND_LINE}
        </p>
      ) : error === 'network' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
          <span data-testid="txr-models-card-error" style={ERROR}>
            {CARD_ERROR_LINE}
          </span>
          <Button data-testid="txr-models-card-retry" variant="outline" onClick={retry}>
            Retry
          </Button>
        </div>
      ) : card !== null ? (
        <div data-testid="txr-models-card-body">
          <p data-testid="txr-models-card-description" style={LEAD}>
            {card.description}
          </p>
          <Descriptions
            data-testid="txr-models-card-facts"
            column={1}
            bordered
            size="sm"
            items={factsOf(card)}
          />
          {card.research_notice ? (
            <p data-testid="txr-models-card-notice" style={NOTICE_LINE}>
              {RESEARCH_NOTICE}
            </p>
          ) : null}
        </div>
      ) : loading ? (
        <div data-testid="txr-models-card-loading" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {Array.from({ length: SKELETON_ROWS }, (_, i) => (
            <Skeleton key={i} style={{ height: 44, borderRadius: 8 }} />
          ))}
        </div>
      ) : null}
    </Dialog>
  )
}
