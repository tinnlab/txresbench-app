import { Button } from '@txresbench/kit'
import type { CSSProperties } from 'react'
import { useAppMode } from '../useAppMode'
import { saveLabel } from '@/core/saveFile'

/**
 * ExampleFileCard — the demo's example-table card (ITEM-5's reusable
 * component; the audit table's `/files` + `/predict-files` rows: the drop
 * zone and picker are replaced by example cards with an "Example" badge).
 *
 * DEMO-ONLY by construction: ITEM-6 mounts it in the demo pages in place of
 * the upload affordances. This card itself is prop-driven (the row count and
 * the marker list come from the caller — the example table ITEM-6 fetches),
 * so it has no network read of its own; the copy (title per kind, the number
 * line, the badge) is the demo module's.
 *
 * The facts lines are real, never a design-example count (the board-bytes
 * rule the intake cards follow): `rows` and `markers` are the caller's
 * measured values.
 */
export type ExampleTableKind = 'patients' | 'measurements' | 'predict'

const TITLES: Record<ExampleTableKind, string> = {
  patients: 'Example patients',
  measurements: 'Example measurements',
  predict: 'Example patients to predict',
}

const DESCRIPTIONS: Record<ExampleTableKind, string> = {
  patients:
    'The example study table: one row per patient, with the outcome, the decision day and the follow-up.',
  measurements:
    'The example measurements table: one row per measurement — a marker value at a date.',
  predict: 'The example measurements of the new patients to predict.',
}

/** The board's card frame (the intake card's own bytes). */
const CARD: CSSProperties = {
  border: '1px solid var(--txr-border)',
  borderRadius: 12,
  background: 'var(--txr-surface)',
  padding: '18px 20px',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  flex: '1 1 340px',
  minWidth: 0,
}

const TITLE: CSSProperties = {
  margin: 0,
  fontFamily: "'Source Serif 4', Georgia, serif",
  fontWeight: 600,
  fontSize: 20,
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flexWrap: 'wrap',
}

const BADGE: CSSProperties = {
  fontSize: 12.5,
  padding: '2px 10px',
  borderRadius: 999,
  background: 'var(--txr-accent-soft)',
  color: 'var(--txr-brand-ink)',
  fontWeight: 600,
  whiteSpace: 'nowrap',
}

const DESCRIPTION: CSSProperties = { margin: 0, color: 'var(--txr-text-2)', fontSize: 14 }

const FACTS: CSSProperties = { margin: 0, fontSize: 14, color: 'var(--txr-text-2)' }

export interface ExampleFileCardProps {
  /** Which example table the card presents (its title + description). */
  kind: ExampleTableKind
  /** The stored table's row count (the card's number line). */
  rows: number
  /** The marker columns (measurements tables; optional). */
  markers?: string[]
  /** Optional download affordance (the example table download stays in demo). */
  onDownloadExample?: () => void
  /** Optional template download (the audit's "template and example downloads
   *  stay" — the demo card replaces the drop zone, not the downloads). */
  onDownloadTemplate?: () => void
}

export function ExampleFileCard({ kind, rows, markers, onDownloadExample, onDownloadTemplate }: ExampleFileCardProps) {
  const { ready, isDemo } = useAppMode()
  if (!ready || !isDemo) return null

  const facts: string[] = [`${rows} rows`]
  if (markers && markers.length > 0) {
    facts.push(`${markers.length} ${markers.length === 1 ? 'marker' : 'markers'}: ${markers.join(', ')}`)
  }

  return (
    <section style={CARD} data-testid={`txr-example-card-${kind}`}>
      <h2 style={TITLE}>
        {TITLES[kind]}
        <span
          data-testid={`txr-example-card-badge-${kind}`}
          style={BADGE}
        >
          Example
        </span>
      </h2>
      <p style={DESCRIPTION}>{DESCRIPTIONS[kind]}</p>
      <p data-testid={`txr-example-card-facts-${kind}`} style={FACTS}>
        {facts.join(' · ')}
      </p>
      {onDownloadTemplate !== undefined || onDownloadExample !== undefined ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', alignItems: 'baseline' }}>
          {onDownloadTemplate !== undefined ? (
            <Button
              variant="link"
              data-testid={`txr-example-card-download-template-${kind}`}
              style={{ padding: 0, color: 'var(--txr-brand)', fontWeight: 600 }}
              onClick={onDownloadTemplate}
            >
              {saveLabel('Save the template (CSV)…', 'Download the template (CSV)')}
            </Button>
          ) : null}
          {onDownloadExample !== undefined ? (
            <Button
              variant="link"
              data-testid={`txr-example-card-download-${kind}`}
              style={{ padding: 0 }}
              onClick={onDownloadExample}
            >
              {saveLabel('Save the full example (CSV)…', 'Download the full example (CSV)')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
