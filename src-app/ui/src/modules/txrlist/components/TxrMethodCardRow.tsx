/**
 * TxrMethodCardRow — ONE row of the redesigned E-screen picker
 * (qa-fixes3 ITEM-1): checkbox; the method's short title with the id in
 * monospace under it; the one-sentence summary (two-line clamp, "More" to
 * expand); the family + language chips; the estimate with its measured/
 * estimate quality dot; the benchmark score with its tooltip; the quiet
 * needs line; and the in-place About disclosure (description, journal and
 * year, DOI link, what it outputs, constraints) — never a dialog, never a
 * navigation away.
 *
 * Interaction rules (the plan's row contract):
 * - the WHOLE row is the checkbox's click target: a click (or Space/Enter
 *   on the focused row) toggles the selection, EXCEPT inside a nested
 *   interactive element (the checkbox itself, the More/About buttons — the
 *   row's handler ignores those targets, so one click never double-fires);
 * - the checkbox's accessible name is the method's short title ("Select
 *   <title>"), `checked` comes from the host's selection set and the row
 *   reports the toggle — the row never holds selection state (DEC-3);
 * - `cannot` rows are never rendered here (the picker keeps those in the
 *   collapsed can't-run section); a stale host selection of a `cannot`
 *   card is masked by the checkbox and ignored by the count (the same rule
 *   as the board rows).
 *
 * Copy notes: "Estimated 12 s" appears with the quality dot; the benchmark
 * fact renders ONLY when the catalogue carries it (D36) — never "Paper 0",
 * never a blank fact column; unknown fields are omitted (never "—").
 */
import { useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react'
import { Button, Checkbox, Skeleton, Tooltip } from '@txresbench/kit'
import type { TxrMethodCard } from '../types'
import { TXRMETHOD_GROUP_EXPLAINER, type TxrMethodGroupId } from '../lib/methodPicker'
import {
  formatBenchmarkScore,
  formatBenchmarkTooltip,
  formatEstimateLabel,
  formatMethodNeedsLine,
} from '../lib/format'
import { METHOD_NOT_FOUND_LINE, useMethodCardDetail } from '../data/useMethodCardDetail'

/** The estimate-quality dot's two tones (measured vs estimate — the plan's
 *  small dot with a tooltip stating which it is). */
const QUALITY_TONES = {
  measured: { background: 'var(--txr-success)' },
  estimate: { background: 'var(--txr-warning)' },
} as const

const QUALITY_LABEL = {
  measured: 'Measured on the benchmark',
  estimate: 'Estimated from the method\'s language',
} as const

/** The row's card look (the board card's rounded box, token-only). */
const CARD: CSSProperties = {
  border: '1px solid var(--txr-border)',
  borderRadius: 10,
  background: 'var(--txr-surface)',
  padding: '10px 14px',
  display: 'flex',
  gap: 10,
  alignItems: 'flex-start',
  cursor: 'pointer',
}

const BODY: CSSProperties = { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }

const TITLE_LINE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'baseline',
  gap: '4px 10px',
  minWidth: 0,
}

const TITLE: CSSProperties = { fontSize: 14.5, fontWeight: 700, color: 'var(--txr-text)' }

const ID_LINE: CSSProperties = {
  fontFamily: "'Source Code Pro', monospace",
  fontSize: 12,
  color: 'var(--txr-muted)',
}

const SUMMARY: CSSProperties = {
  margin: 0,
  fontSize: 13,
  lineHeight: 1.45,
  color: 'var(--txr-text-2)',
  overflowWrap: 'anywhere',
}

/** The clamp summary's max-height (two lines at 13px × 1.45). */
const SUMMARY_TWO_LINES: CSSProperties = {
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
}

const FACTS: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '4px 10px',
  minWidth: 0,
}

const CHIP: CSSProperties = {
  fontSize: 12.5,
  padding: '2px 10px',
  borderRadius: 999,
  background: 'var(--txr-success-soft)',
  color: 'var(--txr-success-ink)',
}

const LANGUAGE_CHIP: CSSProperties = {
  fontSize: 12.5,
  padding: '2px 10px',
  borderRadius: 999,
  border: '1px solid var(--txr-border)',
  color: 'var(--txr-text-2)',
}

const ESTIMATE: CSSProperties = {
  fontSize: 12.5,
  color: 'var(--txr-muted)',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
}

const RANK: CSSProperties = {
  fontSize: 12.5,
  color: 'var(--txr-text-2)',
  borderBottom: '1px dotted var(--txr-border)',
  cursor: 'help',
}

const NEEDS: CSSProperties = { margin: 0, fontSize: 12.5, color: 'var(--txr-muted)' }

const MORE_BUTTON: CSSProperties = {
  padding: 0,
  height: 'auto',
  fontSize: 12.5,
  color: 'var(--txr-brand)',
}

const ABOUT_BUTTON: CSSProperties = {
  padding: 0,
  height: 'auto',
  fontSize: 12.5,
  color: 'var(--txr-brand)',
  alignSelf: 'flex-start',
}

/** The nested-interactive guard: a click/keypress that lands in an input,
 *  button or link is the control's own, never the row's toggle. */
function isInteractive(target: EventTarget | null): boolean {
  return (
    target instanceof Element && target.closest('button, input, a, [data-no-row-toggle]') !== null
  )
}

/** The disclosure's body: the detail's description + the plan's facts. */
function TxrMethodCardAbout({ card }: { card: TxrMethodCard }) {
  return (
    <div data-testid={`txr-method-about-${card.id}`} style={ABOUT_BODY}>
      <TxrMethodAboutContent card={card} />
    </div>
  )
}

const ABOUT_BODY: CSSProperties = {
  borderTop: '1px solid var(--txr-border-subtle)',
  paddingTop: 8,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
}

function needsText(card: TxrMethodCard): string {
  return formatMethodNeedsLine(card.needs, null)
}

/** The disclosure content (fetch-on-open; never blank on failure). */
function TxrMethodAboutContent({ card }: { card: TxrMethodCard }) {
  const { detail, loading, error, retry } = useMethodCardDetail(card.id)
  if (loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Skeleton style={{ height: 12, borderRadius: 6 }} />
        <Skeleton style={{ height: 12, borderRadius: 6 }} />
      </div>
    )
  }
  if (error === 'not-found') {
    return <span style={ABOUT_ERROR}>{METHOD_NOT_FOUND_LINE}</span>
  }
  if (error === 'network') {
    return (
      <span style={ABOUT_ERROR}>
        The method details could not be loaded.{' '}
        <Button data-testid={`txr-method-about-retry-${card.id}`} variant="link" onClick={retry}>
          Retry
        </Button>
      </span>
    )
  }
  const description = detail?.description ?? card.summary
  const journalYear =
    detail?.journal && detail?.year ? `${detail.journal}, ${detail.year}` : null
  const paperDoi = detail?.paper_doi ?? card.paperDoi
  const groupExplainer =
    TXRMETHOD_GROUP_EXPLAINER[card.group as TxrMethodGroupId] ?? null
  return (
    <>
      <p style={ABOUT_DESCRIPTION} data-testid={`txr-method-about-description-${card.id}`}>
        {description}
      </p>
      <div style={ABOUT_FACT_LINES}>
        {journalYear !== null ? <span>{journalYear}</span> : null}
        {paperDoi ? (
          <a
            data-testid={`txr-method-about-doi-${card.id}`}
            href={`https://doi.org/${paperDoi}`}
            target="_blank"
            rel="noreferrer"
            style={{ color: 'var(--txr-brand)' }}
          >
            Paper
          </a>
        ) : null}
        {groupExplainer !== null ? <span>What it outputs: {groupExplainer}</span> : null}
        <span>Needs: {needsText(card)}</span>
      </div>
    </>
  )
}

const ABOUT_DESCRIPTION: CSSProperties = {
  margin: 0,
  fontSize: 13,
  lineHeight: 1.45,
  color: 'var(--txr-text-2)',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
}

const ABOUT_FACT_LINES: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '2px 16px',
  fontSize: 12.5,
  color: 'var(--txr-muted)',
}

const ABOUT_ERROR: CSSProperties = { fontSize: 12.5, color: 'var(--txr-danger)' }

export interface TxrMethodCardRowProps {
  /** The card to render (the picker's row contract). */
  card: TxrMethodCard
  /** Whether the host's selection set holds this card's key. */
  checked: boolean
  /** The checkbox changed (the row's whole-area toggle reports through). */
  onToggle?(card: TxrMethodCard): void
}

export function TxrMethodCardRowView({ card, checked, onToggle }: TxrMethodCardRowProps) {
  const [summaryExpanded, setSummaryExpanded] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const toggle = (): void => onToggle?.(card)

  const onRowClick = (event: MouseEvent): void => {
    if (isInteractive(event.target)) return
    toggle()
  }
  const onRowKeyDown = (event: KeyboardEvent): void => {
    if (isInteractive(event.target)) return
    if (event.key !== ' ' && event.key !== 'Enter') return
    event.preventDefault()
    toggle()
  }

  const needsLine = formatMethodNeedsLine(
    card.needs,
    card.run.status === 'some' ? card.run.coverageLine : null,
  )
  const groupExplainer =
    TXRMETHOD_GROUP_EXPLAINER[card.group as TxrMethodGroupId] ?? null

  return (
    <div
      data-testid={`txr-method-card-${card.id}`}
      data-selected={checked ? 'true' : 'false'}
      role="checkbox"
      aria-checked={checked}
      aria-label={`Select ${card.title}`}
      tabIndex={0}
      className="txr-method-card"
      style={checked ? { ...CARD, borderColor: 'var(--txr-brand)', borderWidth: 2 } : CARD}
      onClick={onRowClick}
      onKeyDown={onRowKeyDown}
    >
      <Checkbox
        data-testid={`txr-method-checkbox-${card.id}`}
        className="txr-list-checkbox"
        aria-label={`Select ${card.title}`}
        checked={checked}
        onCheckedChange={() => toggle()}
      />
      <div style={BODY}>
        <div style={TITLE_LINE}>
          <span data-testid={`txr-method-title-${card.id}`} style={TITLE}>{card.title}</span>
          <span style={ID_LINE}>{card.id}</span>
        </div>
        <p
          data-testid={`txr-method-summary-${card.id}`}
          style={summaryExpanded ? SUMMARY : { ...SUMMARY, ...SUMMARY_TWO_LINES }}
        >
          {card.summary}
        </p>
        {!summaryExpanded && card.summary.length > 120 ? (
          <Button
            data-testid={`txr-method-summary-more-${card.id}`}
            variant="link"
            style={MORE_BUTTON}
            onClick={() => setSummaryExpanded(true)}
          >
            More
          </Button>
        ) : null}
        <div style={FACTS}>
          {groupExplainer !== null ? (
            <span data-testid={`txr-method-chip-${card.id}`} style={CHIP}>
              {card.groupLabel}
            </span>
          ) : null}
          <span style={LANGUAGE_CHIP}>{card.language}</span>
          {card.estimate !== null ? (
            <span style={ESTIMATE} data-testid={`txr-method-estimate-${card.id}`}>
              <Tooltip content={QUALITY_LABEL[card.estimate.quality]}>
                <span
                  aria-hidden="true"
                  title={QUALITY_LABEL[card.estimate.quality]}
                  data-testid={`txr-method-estimate-quality-${card.id}`}
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 999,
                    ...QUALITY_TONES[card.estimate.quality],
                    display: 'inline-block',
                  }}
                />
              </Tooltip>
              {formatEstimateLabel(card.estimate.seconds)}
            </span>
          ) : null}
          {card.rank !== null ? (
            <Tooltip content={formatBenchmarkTooltip(card.rank)}>
              <span
                data-testid={`txr-method-rank-${card.id}`}
                style={RANK}
                title={formatBenchmarkTooltip(card.rank)}
              >
                {formatBenchmarkScore(card.rank)}
              </span>
            </Tooltip>
          ) : null}
        </div>
        <p style={NEEDS} data-testid={`txr-method-needs-${card.id}`}>
          {needsLine}
        </p>
        <Button
          data-testid={`txr-method-about-toggle-${card.id}`}
          variant="link"
          aria-expanded={aboutOpen}
          style={ABOUT_BUTTON}
          onClick={() => setAboutOpen(open => !open)}
        >
          {aboutOpen ? 'Hide About' : 'About'}
        </Button>
        {aboutOpen ? <TxrMethodCardAbout card={card} /> : null}
      </div>
    </div>
  )
}
