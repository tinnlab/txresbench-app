/**
 * TxrCompareCard — the H screen's "How the two methods compare" card
 * (`Results.dc.html`): the two board sentences — "Both methods put <ids>
 * among their five highest chances." and "They differ most for <id> (77%
 * and 52%) and <id> (35% and 57%)." — plus the board's
 * "Show only the patients where they differ" toggle.
 *
 * The numbers come from ITEM-4's `compareReport` (DEC-7: the report is
 * defined over the view's first two columns; a view with fewer than two
 * columns carries no card — the page decides). The sentences are the
 * module's copy constants (`lib/format.ts` builders — the flat-string
 * source pinned by TEST-UR-3, with the same punctuation: comma-joined,
 * "and" before the last, no Oxford comma); this component renders the same
 * bytes with the named patient ids bolded as the board does, so a
 * `textContent` read is byte-identical to the formatter twin.
 *
 * The toggle reports the board's divergent-only filter (|a − b| ≥
 * DIVERGENCE_PP, the view model's `divergentPatients`); the page applies
 * it to the table rows. The toggle never holds the filter as local state —
 * `divergentOnly` is the store's and `aria-pressed` carries it.
 */
import type { CSSProperties, ReactNode } from 'react'
import { Button } from '@ziee/kit'
import type { TxrCompareReport } from '../types'
import {
  DIFFER_LEAD,
  DIFFER_NONE,
  DIVERGENT_TOGGLE,
  SHARED_TOP_LEAD,
  SHARED_TOP_NONE,
  SHARED_TOP_TAIL,
  compareCardTitle,
} from '../lib/format'

const CARD: CSSProperties = {
  border: '1px solid #cfcdc7',
  borderRadius: 10,
  padding: '16px 18px',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}

const TITLE: CSSProperties = { fontWeight: 600, margin: 0 }

const SENTENCES: CSSProperties = {
  fontSize: 14,
  color: '#3a3a3a',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}

const TOGGLE: CSSProperties = {
  alignSelf: 'flex-start',
  fontSize: 14,
  padding: 0,
  color: '#1d4e89',
}

/** The board's named-id list: comma-joined, "and" before the last, ids bold. */
function BoldPatientList({ ids }: { ids: string[] }) {
  if (ids.length === 0) return null
  if (ids.length === 1) return <b>{ids[0]}</b>
  return (
    <>
      {ids.map((id, i) => (
        <span key={id}>
          {i === 0 ? '' : i === ids.length - 1 ? ' and ' : ', '}
          <b>{id}</b>
        </span>
      ))}
    </>
  )
}

/** Sentence one: the intersection of the two methods' top-5 sets (or the none-case constant). */
function SharedTopSentence({ shared }: { shared: ReadonlyArray<{ patientId: string }> }) {
  const ids = shared.map(r => r.patientId)
  if (ids.length === 0) return <div>{SHARED_TOP_NONE}.</div>
  return (
    <div>
      {SHARED_TOP_LEAD} <BoldPatientList ids={ids} /> {SHARED_TOP_TAIL}.
    </div>
  )
}

/** A chance as "77%" or the board's em dash for an abstain slot (formatDifferSentence's rule). */
function formatPctOrDash(value: number | null): string {
  if (value === null) return '\u2014'
  return `${value}%`
}

/** Sentence two: the top divergences with both chances (or the none-case constant). */
function DifferSentence({
  differing,
}: {
  differing: ReadonlyArray<{ patientId: string; a: number | null; b: number | null }>
}) {
  if (differing.length === 0) return <div>{DIFFER_NONE}.</div>
  const parts = differing.map(d => (
    <span key={d.patientId}>
      <b>{d.patientId}</b> ({formatPctOrDash(d.a)} and {formatPctOrDash(d.b)})
    </span>
  ))
  return (
    <div>
      {DIFFER_LEAD}{' '}
      {parts.map((part, i) => (
        <span key={i}>
          {i === 0 ? '' : i === parts.length - 1 ? ' and ' : ', '}
          {part}
        </span>
      ))}
      .
    </div>
  )
}

export interface TxrCompareCardProps {
  /** ITEM-4's report over the view's first two columns (never empty in compare mode). */
  report: TxrCompareReport
  /** The first compared method's display label (the card's title, RES-10). */
  aLabel: string
  /** The second compared method's display label (the card's title, RES-10). */
  bLabel: string
  /** The divergent-only filter state (the store's `divergentOnly`). */
  divergentOnly: boolean
  onToggleDivergent: (on: boolean) => void
}

export function TxrCompareCard({
  report,
  aLabel,
  bLabel,
  divergentOnly,
  onToggleDivergent,
}: TxrCompareCardProps) {
  return (
    <div data-testid="txr-compare-card" style={CARD}>
      <div style={TITLE} data-testid="txr-compare-card-title">
        {compareCardTitle(aLabel, bLabel)}
      </div>
      <div style={SENTENCES}>
        <SharedTopSentence shared={report.sharedTop} />
        <DifferSentence differing={report.mostDiffering} />
        <Button
          data-testid="txr-compare-divergent-toggle"
          variant="link"
          className="p-0"
          aria-pressed={divergentOnly}
          disabled={report.divergentCount === 0}
          style={TOGGLE}
          onClick={() => onToggleDivergent(!divergentOnly)}
        >
          {DIVERGENT_TOGGLE}
        </Button>
      </div>
    </div>
  )
}
