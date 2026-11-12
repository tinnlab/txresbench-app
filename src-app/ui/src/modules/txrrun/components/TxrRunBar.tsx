/**
 * TxrRunBar — the E screen's ITEM-2 sticky run bar (qa-fixes3 ITEM-2 (c)),
 * the choose-methods page's own bar (the shared `TxrListBottomBar` stays
 * for the D/I model screens, where the board's bar is still the look):
 *
 * - line 1: "6 methods selected · about 2 min (3 at a time on 8 CPUs)"
 *   (the count is the picker's own `countSelected`; the total is the
 *   estimate response's bytes — `formatRunBarTime`, never a local sum,
 *   INV-4; the lanes come from the settings);
 * - the "Save the trained models" switch with its one-line meaning;
 *   the research-use notice ONCE, small, on the bar's second line;
 * - the primary "Run N methods" button, DISABLED with the reason beside
 *   it when nothing is selected ("Select at least one method");
 * - the bar is the page's last flex child — it never overlaps content
 *   (the page scrolls above it); at the phone width it is the compact
 *   two-line bar (line 1: count + time; line 2: the controls).
 *
 * The bar is CONTROLLED and presentational: the count, the time text and
 * the options are the host's; Run hands the host the run OPTIONS (the run
 * KEYS remain the selection × cards property the page owns).
 */
import type { CSSProperties } from 'react'
import { Button, Switch } from '@txresbench/kit'
import { pluralize } from '@/modules/txrlist'
import { RESEARCH_NOTICE } from '../lib/format'
import { RUN_BAR_EMPTY_REASON, SAVE_MODELS_MEANING } from '../lib/runBar'

export interface TxrRunBarProps {
  /** The selected count ("6 methods selected"). Host-owned (countSelected). */
  selectedCount: number
  /** The time line's text (formatRunBarTime), or null for the "…" slot. */
  timeText: string | null
  /** The lanes the run will use (the settings' "How many run at once"). */
  atATime: number
  /** The save-the-trained-models toggle (checked, change). */
  saveModels: { checked: boolean; onChange(v: boolean): void }
  /** Run clicked (the options; the keys are the page's). */
  onRun(opts: { atATime: number; saveModels: boolean }): void
}

/** The board bar's container look (the E run bar's own two-line grid). */
const BAR: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '2px 18px',
  padding: '10px 36px',
  borderTop: '1px solid var(--txr-border)',
  background: 'var(--txr-surface-dim)',
}

/** Line 1 (the count + the time). */
const LINE_1: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' }

const COUNT: CSSProperties = { fontWeight: 700 }

/** The total line's look (the board's `var(--txr-text-2)` 14px). */
const TOTAL_LINE: CSSProperties = { color: 'var(--txr-text-2)', fontSize: 14 }

/** The notice's look (the board's `var(--txr-muted)` 12.5px — line 2). */
const NOTICE: CSSProperties = { fontSize: 12.5, color: 'var(--txr-muted)' }

/** The save toggle's look (the board's label line + the one-line meaning). */
const SAVE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
  fontSize: 13.5,
}

const SAVE_LABEL: CSSProperties = {
  display: 'flex',
  gap: 6,
  alignItems: 'center',
  minHeight: 44,
}

const SAVE_MEANING: CSSProperties = { fontSize: 12.5, color: 'var(--txr-muted)' }

/** The Run button's board-primary look (over the kit's default variant). */
const RUN_BUTTON: CSSProperties = {
  padding: '10px 22px',
  borderRadius: 8,
  background: 'var(--txr-brand)',
  color: 'var(--txr-on-brand)',
  fontWeight: 700,
  height: 'auto',
  fontSize: 14,
  minHeight: 44,
}

/** The right-hand controls row (the save toggle + the Run button). */
const ACTION_ROW: CSSProperties = {
  marginLeft: 'auto',
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 14,
  minWidth: 0,
}

/** The disabled reason beside the button (the plan's words). */
const EMPTY_REASON: CSSProperties = { fontSize: 13, color: 'var(--txr-muted)' }

export function TxrRunBar({ selectedCount, timeText, atATime, saveModels, onRun }: TxrRunBarProps) {
  const empty = selectedCount === 0
  return (
    <div data-testid="txr-run-bar" className="txr-run-bar" style={BAR}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <div data-testid="txr-run-bar-summary" style={LINE_1}>
          <span data-testid="txr-run-bar-count" style={COUNT}>
            {selectedCount} {pluralize('method', selectedCount)} selected
          </span>
          <span data-testid="txr-run-bar-time" style={TOTAL_LINE}>
            {timeText ?? '…'}
          </span>
        </div>
        <span data-testid="txr-run-bar-notice" style={NOTICE}>
          {RESEARCH_NOTICE}
        </span>
      </div>
      <div className="txr-run-bar-action" style={ACTION_ROW}>
        <label data-testid="txr-run-bar-save" style={SAVE}>
          <span style={SAVE_LABEL}>
            <Switch
              data-testid="txr-run-bar-save-models"
              className="txr-run-bar-switch"
              aria-label="Save the trained models"
              checked={saveModels.checked}
              onCheckedChange={checked => saveModels.onChange(checked === true)}
            />
            Save the trained models
          </span>
          <span style={SAVE_MEANING}>{SAVE_MODELS_MEANING}</span>
        </label>
        {empty ? (
          <span data-testid="txr-run-bar-empty-reason" style={EMPTY_REASON}>
            {RUN_BAR_EMPTY_REASON}
          </span>
        ) : null}
        <Button
          data-testid="txr-run-bar-run"
          style={RUN_BUTTON}
          disabled={empty}
          onClick={() => onRun({ atATime, saveModels: saveModels.checked })}
        >
          Run {selectedCount} {pluralize('method', selectedCount)}
        </Button>
      </div>
    </div>
  )
}
