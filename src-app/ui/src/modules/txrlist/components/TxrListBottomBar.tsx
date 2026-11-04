/**
 * TxrListBottomBar — the boards' sticky bottom bar (`Busy.dc.html`,
 * `Pretrained.dc.html`, `Saved.dc.html`): the "N methods selected" count,
 * the total-time line, the run-N-at-a-time select (screen E only), the
 * Save-the-trained-models toggle (screen E only), the research notice
 * (screens D/I), and the Run button.
 *
 * Board-copy facts of this layout (DEC-8/DEC-12):
 * - the bar is the board's sticky line — `#f7f6f3`, `1px #cfcdc7` top
 *   border, `14px 36px` padding, 18px gaps;
 * - "5 methods selected" is bold; the total line is the board's long form
 *   ("about 14 minutes in total on this computer") — `formatTotalTime`'s,
 *   passed in by the host — and the at-a-time segment is the board's
 *   "run <select> at a time" with the select's options 1–4 (the
 *   BusyRunning board's own option set);
 * - "Save the trained models" is the E checkbox; the notice is the
 *   board's "For research. Not for deciding a patient's treatment."
 *   (rendered only when the host passes it — DEC-13);
 * - the Run button is the board's primary: `#1d4e89`, white bold text,
 *   `10px 22px` padding, 8px radius; its label is `runLabel` ("Run 5
 *   methods" / "Run 3 models").
 *
 * The bar is CONTROLLED and presentational: the values come from the host
 * (the selected count, the total text, the at-a-time value, the save
 * checkbox) and every change reports up. The Run click hands the host the
 * run OPTIONS; the run KEYS the list computes (`TxrSelectList` wires
 * `onRun(opts)` to the host's `bottomBar.onRun(keys, opts)`), because the
 * keys are a selection×rows property this bar does not own.
 *
 * When a control is absent (screens D/I: no at-a-time select, no save
 * toggle) the bar omits it entirely and the Run options fall to the
 * defaults: `atATime: 3` (the boards' own value) and `saveModels: false`
 * (nothing to save on the D/I paths). The total slot never renders blank:
 * a `null` totalText shows the loading ellipsis (EXAMPLE-UL-7).
 */
import type { CSSProperties } from 'react'
import { Button, Checkbox, Select } from '@ziee/kit'
import { pluralize, runLabel } from '../lib/format'

/** The at-a-time choices — the BusyRunning board's own option set (3, 1, 2, 4). */
export const TXRLIST_AT_A_TIME_OPTIONS = [1, 2, 3, 4] as const

/** The default at-a-time for a bar without the control (the boards' value). */
export const TXRLIST_DEFAULT_AT_A_TIME = 3

export interface TxrListBottomBarProps {
  /** "method" on E, "model" on D/I — the count and Run labels' plural. */
  itemLabel: 'method' | 'model'
  /** The selected count ("5 methods selected"). Host-owned (countSelected). */
  selectedCount: number
  /** The total line's text (formatTotalTime), or null for the "…" slot. */
  totalTimeText: string | null
  /** The run-N-at-a-time select (screen E); absent on D/I (EXAMPLE-UL-3). */
  atATime?: { value: number; onChange(v: number): void }
  /** The save-the-trained-models toggle (screen E); absent on D/I. */
  saveModels?: { checked: boolean; onChange(v: boolean): void }
  /** The research-use notice (DEC-13); not rendered when null. */
  notice?: string | null
  /** Run clicked: the options (keys are wired by TxrSelectList). */
  onRun(opts: { atATime: number; saveModels: boolean }): void
}

/** The board bar's container look. */
const BAR: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 18,
  padding: '14px 36px',
  borderTop: '1px solid #cfcdc7',
  background: '#f7f6f3',
}

/** The total line's look (the board's `#3a3a3a` 14px). */
const TOTAL_LINE: CSSProperties = { color: '#3a3a3a', fontSize: 14 }

/** The notice's look (the board's `#5e5e5e` 12.5px). */
const NOTICE: CSSProperties = { fontSize: 12.5, color: '#5e5e5e' }

/** The save toggle's look (the board's label line). */
const SAVE_LABEL: CSSProperties = { fontSize: 13.5, display: 'flex', gap: 6, alignItems: 'center' }

/** The Run button's board-primary look (over the kit's default variant). */
const RUN_BUTTON: CSSProperties = {
  padding: '10px 22px',
  borderRadius: 8,
  background: '#1d4e89',
  color: '#ffffff',
  fontWeight: 700,
  height: 'auto',
  fontSize: 14,
}

export function TxrListBottomBar({
  itemLabel,
  selectedCount,
  totalTimeText,
  atATime,
  saveModels,
  notice,
  onRun,
}: TxrListBottomBarProps) {
  return (
    <div data-testid="txr-list-bottom-bar" style={BAR}>
      <span data-testid="txr-list-selected-count" style={{ fontWeight: 700 }}>
        {selectedCount} {pluralize(itemLabel, selectedCount)} selected
      </span>
      <span data-testid="txr-list-total-time" style={TOTAL_LINE}>
        {totalTimeText ?? '…'}
        {atATime ? (
          <>
            {' · '}
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              run
              <Select
                data-testid="txr-list-at-a-time"
                aria-label="Run at the same time"
                size="sm"
                options={TXRLIST_AT_A_TIME_OPTIONS.map(v => ({ value: String(v), label: String(v) }))}
                value={String(atATime.value)}
                onValueChange={v => atATime.onChange(Number(v))}
              />
              at a time
            </label>
          </>
        ) : null}
      </span>
      <span style={{ flexGrow: 1 }} />
      {saveModels ? (
        <label style={SAVE_LABEL}>
          <Checkbox
            data-testid="txr-list-save-models"
            aria-label="Save the trained models"
            checked={saveModels.checked}
            onCheckedChange={checked => saveModels.onChange(checked === true)}
          />
          Save the trained models
        </label>
      ) : null}
      {notice !== null && notice !== undefined ? <span style={NOTICE}>{notice}</span> : null}
      <Button
        data-testid="txr-list-run"
        style={RUN_BUTTON}
        onClick={() =>
          onRun({ atATime: atATime?.value ?? TXRLIST_DEFAULT_AT_A_TIME, saveModels: saveModels?.checked ?? false })
        }
      >
        {runLabel(itemLabel, selectedCount)}
      </Button>
    </div>
  )
}
