/**
 * TxrListRow — ONE selectable method/model row, board-exact layout
 * (`Busy.dc.html` / `Pretrained.dc.html` / `Saved.dc.html`).
 *
 * The boards' row is: checkbox, name/tag block, group/model-kind chip,
 * performance column (D/I), status line (headline + detail), time entry,
 * and the action link. The row is CONTROLLED: `checked` comes from the
 * host's selection set and the checkbox reports the toggle via `onToggle`
 * — the component never holds selection state (DEC-3).
 *
 * Board-copy facts of this layout (DEC-8/DEC-12):
 * - the three verdict colours are the board literals `#1f6b3a` (can),
 *   `#8a5a00` (some) and `#b3261e` (cannot);
 * - a `cannot` row renders disabled (checkbox disabled, row at the
 *   board's `opacity: 0.8` / `#fbfaf8`);
 * - a checked row is the board's selected look (2 px `#1d4e89` border on
 *   `#f4f8fc`), an unchecked one the 1 px `#cfcdc7` border on white;
 * - the chip palettes: neutral `#eef0e6`/`#3d4a14` (method group chips),
 *   accent `#e8eef6`/`#143a68` (Published / Learned here / Trained by
 *   you) — the kit `Badge` tones do not carry these exact bytes, so the
 *   chip is a styled span in ONE shared constant here (DEC-8);
 * - `performanceText === null` renders NO performance column and
 *   `timeText === null` renders NO time entry (never an empty box);
 * - the action is a slot: `onAction(row)` fires, the dialog is the
 *   host's (DEC-16).
 *
 * The row's height is deliberately fixed by its constant padding + the
 * kit controls' fixed heights, so the windowed list (`TxrSelectList`) can
 * measure one row height; a long name or detail wraps inside the row
 * instead of growing it beyond the board's two-line height.
 */
import type { CSSProperties } from 'react'
import { Button, Checkbox } from '@ziee/kit'
import type { TxrListChipTone, TxrListRow, TxrRunStatus } from '../types'

/** The three status colours, verbatim from the boards (DEC-8). */
export const TXRLIST_STATUS_COLORS: Record<TxrRunStatus, string> = {
  can: '#1f6b3a',
  some: '#8a5a00',
  cannot: '#b3261e',
}

/** The two chip palettes, verbatim from the boards (DEC-8). */
export const TXRLIST_CHIP_TONES: Record<TxrListChipTone, CSSProperties> = {
  neutral: { background: '#eef0e6', color: '#3d4a14' },
  accent: { background: '#e8eef6', color: '#143a68' },
}

/** The board's chip pill shape (shared by both tones). */
const CHIP_PILL: CSSProperties = {
  fontSize: 12.5,
  padding: '2px 10px',
  borderRadius: 999,
  textAlign: 'center',
}

/** The board's action-link look (a text button, not navigation). */
const ACTION_LINK: CSSProperties = { fontSize: 13, color: '#1d4e89' }

export interface TxrListRowProps {
  /** The row to render (the normalized contract shape, hosts built it). */
  row: TxrListRow
  /** Whether the host's selection set holds this row's key. */
  checked: boolean
  /** The checkbox changed (a `cannot` row never fires — the control is disabled). */
  onToggle?: (row: TxrListRow) => void
  /** The row action slot was clicked (About / Model card / Details). */
  onAction?: (row: TxrListRow) => void
}

export function TxrListRowView({ row, checked, onToggle, onAction }: TxrListRowProps) {
  const disabled = row.run.disabled
  // A stale host selection can hold a disabled row's key (a row that became
  // `cannot` after it was picked); the board never shows a `cannot` row
  // checked and the count ignores it (lib/selection.ts) — the checkbox
  // masks it here too.
  const isChecked = checked && !disabled
  const rowStyle: CSSProperties = disabled
    ? {
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: '#cfcdc7',
        background: '#fbfaf8',
        opacity: 0.8,
      }
    : isChecked
      ? {
          borderWidth: 2,
          borderStyle: 'solid',
          borderColor: '#1d4e89',
          background: '#f4f8fc',
        }
      : {
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: '#cfcdc7',
          background: '#ffffff',
        }
  return (
    <div
      data-testid={`txr-list-row-${row.key}`}
      style={{
        ...rowStyle,
        borderRadius: 10,
        padding: '10px 16px',
        display: 'flex',
        flexWrap: 'wrap',
        gap: '6px 14px',
        alignItems: 'center',
        boxSizing: 'border-box',
      }}
    >
      <Checkbox
        data-testid={`txr-list-checkbox-${row.key}`}
        aria-label={`Select ${row.name}`}
        checked={isChecked}
        disabled={disabled}
        onCheckedChange={() => onToggle?.(row)}
      />
      <div style={{ flex: '1 1 240px', minWidth: 0 }}>
        <div style={{ fontFamily: "'Source Code Pro', monospace", fontSize: 13, fontWeight: 500 }}>
          {row.name}
        </div>
        <div style={{ fontSize: 13, color: '#3a3a3a' }}>{row.tag}</div>
      </div>
      {row.chip ? (
        <span
          data-tone={row.chip.tone}
          style={{ ...CHIP_PILL, ...TXRLIST_CHIP_TONES[row.chip.tone] }}
        >
          {row.chip.label}
        </span>
      ) : null}
      {row.performanceText ? (
        <span
          style={{
            fontSize: 13,
            fontVariantNumeric: 'tabular-nums',
            minWidth: 150,
            color: '#3a3a3a',
          }}
        >
          {row.performanceText}
        </span>
      ) : null}
      <span style={{ minWidth: 215, fontSize: 13.5 }}>
        <b style={{ color: TXRLIST_STATUS_COLORS[row.run.status] }}>{row.run.headline}</b>
        <span style={{ display: 'block', fontSize: 12.5, color: '#5e5e5e' }}>
          {row.run.detail}
        </span>
      </span>
      {row.timeText ? (
        <span style={{ fontSize: 13, color: '#5e5e5e', minWidth: 78, textAlign: 'right' }}>
          {row.timeText}
        </span>
      ) : null}
      {row.action ? (
        <Button
          data-testid={`txr-list-row-${row.key}-action`}
          variant="link"
          style={{
            ...ACTION_LINK,
            height: 'auto',
            padding: 0,
          }}
          onClick={() => onAction?.(row)}
        >
          {row.action.label}
        </Button>
      ) : null}
    </div>
  )
}
