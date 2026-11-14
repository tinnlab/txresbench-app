/**
 * TxrMethodAside — the H screen's explanatory column (`Results.dc.html`'s
 * aside): the "Read these with care" card (the board's sentence, with the
 * cohort size from the run — never a board number), the
 * "How the chance is calculated" link that opens `TxrChanceDialog`, and —
 * for the one-method tab — the method's own facts card (qa-fixes RES-11):
 * the coverage ("Scored for 68 of 94 patients"), the prob-source sentence
 * (a `none` column explains that no chances are shown — RES-05) and the
 * "Show the log" link.
 *
 * qa-fixes4 ITEM-1 (results-r3 R3-results-2): the board's "Saved in
 * <dir>" line + its "Open the folder" action are GONE from the aside. The
 * run directory is an internal host fact (the report's screenshots show
 * the live machine's absolute path) and must never be user-visible, in
 * web mode and desktop mode alike; the reveal command stays for the
 * History details' desktop-only action (`txrhistory/TxrHistoryActions`),
 * which never shows a path.
 *
 * The component is presentational: `trainedOn` is the run's fact, the
 * callbacks are the page's wiring (store actions today, the reveal seam
 * at ITEM-10 — the open-folder line's removal leaves
 * `lib/reveal.ts` consumed by ui-history only).
 */
import type { CSSProperties } from 'react'
import { Button } from '@txresbench/kit'
import type { TxrHeatmapColumn } from '../types'
import { formatCoverage, formatProbSourceLine } from '../lib/format'

const CARD: CSSProperties = {
  border: '1px solid var(--txr-border)',
  borderRadius: 10,
  padding: '16px 18px',
  fontSize: 14,
  color: 'var(--txr-text-2)',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}

const CARD_TITLE: CSSProperties = { fontWeight: 600, color: 'var(--txr-text)' }

const FACT_LINE: CSSProperties = { fontSize: 13.5, color: 'var(--txr-text-2)' }

const LINK: CSSProperties = { fontSize: 13.5, color: 'var(--txr-brand)', padding: 0 }

/** The care-card sentence (the board's words; the cohort size is the run's fact). */
export function formatCareSentence(trainedOn: number | null): string {
  const cohort =
    trainedOn === null || !Number.isFinite(trainedOn)
      ? 'your patients'
      : `your ${trainedOn} ${trainedOn === 1 ? 'patient' : 'patients'}`
  return `The chances come from methods learned on ${cohort}. They estimate risk for patients like yours; they are not a diagnosis or a treatment decision.`
}

export interface TxrMethodAsideProps {
  /** `run.input_summary.patients` — the care card's cohort size (omitted when null). */
  trainedOn: number | null
  /** Opens `TxrChanceDialog` (the aside's "How the chance is calculated" link). */
  onOpenChance: () => void
  /**
   * The one-method tab's column (qa-fixes RES-11): the aside then renders
   * the method facts card (coverage, prob source, log link) above the care
   * card. Null on the compare tab (the facts belong to one method).
   */
  method?: TxrHeatmapColumn | null
  /** "Show the log" — opens the log dialog for the method (RES-11's log link). */
  onShowLog?: (methodId: string) => void
}

export function TxrMethodAside({
  trainedOn,
  onOpenChance,
  method,
  onShowLog,
}: TxrMethodAsideProps) {
  const coverage = method?.coverage ?? null
  const coverageLine = coverage ? formatCoverage(coverage.scored, coverage.eligible) : null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {method ? (
        <div data-testid="txr-results-method-facts" style={CARD}>
          <div style={CARD_TITLE}>{method.label}</div>
          <div style={FACT_LINE}>{method.groupLabel}</div>
          {coverageLine !== null ? (
            <div data-testid="txr-results-coverage" style={FACT_LINE}>
              {coverageLine}
            </div>
          ) : null}
          <div data-testid="txr-results-prob-source" style={FACT_LINE}>
            {formatProbSourceLine(method.probSource, method.flatConversion)}
          </div>
          {onShowLog ? (
            <Button
              data-testid="txr-results-method-log"
              variant="link"
              className="p-0 self-start"
              style={LINK}
              onClick={() => onShowLog(method.methodId)}
            >
              Show the log
            </Button>
          ) : null}
        </div>
      ) : null}
      <div data-testid="txr-results-care" style={CARD}>
        <div style={CARD_TITLE}>Read these with care</div>
        <div>{formatCareSentence(trainedOn)}</div>
        <Button
          data-testid="txr-results-chance-link"
          variant="link"
          className="p-0 self-start"
          style={{ fontSize: 14, color: 'var(--txr-brand)' }}
          onClick={onOpenChance}
        >
          How the chance is calculated
        </Button>
      </div>
    </div>
  )
}
