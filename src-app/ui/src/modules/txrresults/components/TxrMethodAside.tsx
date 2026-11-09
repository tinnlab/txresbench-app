/**
 * TxrMethodAside — the H screen's explanatory column (`Results.dc.html`'s
 * aside): the "Read these with care" card (the board's sentence, with the
 * cohort size from the run — never a board number), the
 * "How the chance is calculated" link that opens `TxrChanceDialog`, the
 * "Saved in <dir>" line with the desktop-gated "Open the folder" action
 * (the board's `Documents/TxResBench/…` path is a design example; the run's
 * real `dir` renders as-is, INV-5), and — for the one-method tab — the
 * method's own facts card (qa-fixes RES-11): the coverage ("Scored for 68 of
 * 94 patients"), the prob-source sentence (a `none` column explains that no
 * chances are shown — RES-05) and the "Show the log" link.
 *
 * The open-folder seam (INV-6, PROV-UR-7): the button renders ONLY under
 * `isDesktop()` — the pure `@/core/platform` predicate — and reports the
 * click through `onOpenFolder(dir)`; the reveal invoke itself is ITEM-10's
 * `lib/reveal.ts` (`revealRunDir`), which the page wires here. In web mode
 * the path text renders with no button (the positive control TEST-UR-16
 * names: the path present, the button absent — a desktop gate, not a
 * never-rendered line). A rejection is swallowed by the page's reveal
 * helper, so the path-only rendering stays.
 *
 * The component is presentational: `dir`/`trainedOn` are the run's facts,
 * the two callbacks are the page's wiring (store actions today, the reveal
 * seam at ITEM-10).
 */
import type { CSSProperties } from 'react'
import { Button } from '@ziee/kit'
import { isDesktop } from '@/core/platform'
import type { TxrHeatmapColumn } from '../types'
import { formatCoverage, formatProbSourceLine, formatSavedIn } from '../lib/format'

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

const SAVED_IN: CSSProperties = {
  fontSize: 13.5,
  color: 'var(--txr-muted)',
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 6,
}

const MONO_FONT = "'Source Code Pro', ui-monospace, monospace"

const PATH_SPAN: CSSProperties = { fontFamily: MONO_FONT, fontSize: 12.5, overflowWrap: 'anywhere' }

/** The care-card sentence (the board's words; the cohort size is the run's fact). */
export function formatCareSentence(trainedOn: number | null): string {
  const cohort =
    trainedOn === null || !Number.isFinite(trainedOn)
      ? 'your patients'
      : `your ${trainedOn} ${trainedOn === 1 ? 'patient' : 'patients'}`
  return `The chances come from methods learned on ${cohort}. They estimate risk for patients like yours; they are not a diagnosis or a treatment decision.`
}

export interface TxrMethodAsideProps {
  /** `run.dir` — the line's path (the aside omits the line when absent). */
  dir: string | null
  /** `run.input_summary.patients` — the care card's cohort size (omitted when null). */
  trainedOn: number | null
  /** Opens `TxrChanceDialog` (the aside's "How the chance is calculated" link). */
  onOpenChance: () => void
  /** "Open the folder" — the page's reveal wiring (ITEM-10: `revealRunDir`). */
  onOpenFolder: (dir: string) => void
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
  dir,
  trainedOn,
  onOpenChance,
  onOpenFolder,
  method,
  onShowLog,
}: TxrMethodAsideProps) {
  const savedIn = formatSavedIn(dir)
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
            {formatProbSourceLine(method.probSource)}
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
      {savedIn !== null ? (
        <div data-testid="txr-results-saved-in" style={SAVED_IN}>
          <span>Saved in</span>
          <span style={PATH_SPAN}>{savedIn}</span>
          {isDesktop() ? (
            <Button
              data-testid="txr-results-open-folder"
              variant="link"
              className="p-0"
              style={{ fontSize: 13.5, color: 'var(--txr-brand)' }}
              onClick={() => onOpenFolder(dir ?? '')}
            >
              Open the folder
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
