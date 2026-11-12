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
 * - the three verdict colours are the board literals `var(--txr-success)` (can),
 *   `var(--txr-warning)` (some) and `var(--txr-danger)` (cannot);
 * - a `cannot` row renders disabled (checkbox disabled, row at the
 *   board's `opacity: 0.8` / `var(--txr-bg)`);
 * - a checked row is the board's selected look (2 px `var(--txr-brand)` border on
 *   `var(--txr-accent-softer)`), an unchecked one the 1 px `var(--txr-border)` border on white;
 * - the chip palettes: neutral `var(--txr-success-soft)`/`var(--txr-success-ink)` (method group chips),
 *   accent `var(--txr-accent-soft)`/`var(--txr-brand-ink)` (Published / Learned here / Trained by
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
import { Button, Checkbox } from '@txresbench/kit'
import type { TxrListChipTone, TxrListRow, TxrRunStatus } from '../types'

/** The three status colours, verbatim from the boards (DEC-8). */
export const TXRLIST_STATUS_COLORS: Record<TxrRunStatus, string> = {
  can: 'var(--txr-success)',
  some: 'var(--txr-warning)',
  cannot: 'var(--txr-danger)',
}

/** The two chip palettes, verbatim from the boards (DEC-8). */
export const TXRLIST_CHIP_TONES: Record<TxrListChipTone, CSSProperties> = {
  neutral: { background: 'var(--txr-success-soft)', color: 'var(--txr-success-ink)' },
  accent: { background: 'var(--txr-accent-soft)', color: 'var(--txr-brand-ink)' },
}

/** The board's chip pill shape (shared by both tones). */
const CHIP_PILL: CSSProperties = {
  fontSize: 12.5,
  padding: '2px 10px',
  borderRadius: 999,
  textAlign: 'center',
}

/** The board's action-link look (a text button, not navigation). */
const ACTION_LINK: CSSProperties = { fontSize: 13, color: 'var(--txr-brand)' }

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
        borderColor: 'var(--txr-border)',
        background: 'var(--txr-bg)',
        opacity: 0.8,
      }
    : isChecked
      ? {
          borderWidth: 2,
          borderStyle: 'solid',
          borderColor: 'var(--txr-brand)',
          background: 'var(--txr-accent-softer)',
        }
      : {
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: 'var(--txr-border)',
          background: 'var(--txr-surface)',
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
        className="txr-list-checkbox"
        aria-label={`Select ${row.name}`}
        checked={isChecked}
        disabled={disabled}
        onCheckedChange={() => onToggle?.(row)}
      />
      <div style={{ flex: '1 1 240px', minWidth: 0 }}>
        <div style={{ fontFamily: "'Source Code Pro', monospace", fontSize: 13, fontWeight: 500 }}>
          {row.name}
        </div>
        <div style={{ fontSize: 13, color: 'var(--txr-text-2)' }}>{row.tag}</div>
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
            color: 'var(--txr-text-2)',
          }}
        >
          {row.performanceText}
        </span>
      ) : null}
      <span style={{ minWidth: 215, fontSize: 13.5 }}>
        <b style={{ color: TXRLIST_STATUS_COLORS[row.run.status] }}>{row.run.headline}</b>
        <span style={{ display: 'block', fontSize: 12.5, color: 'var(--txr-muted)' }}>
          {row.run.detail}
        </span>
      </span>
      {row.timeText ? (
        <span style={{ fontSize: 13, color: 'var(--txr-muted)', minWidth: 78, textAlign: 'right' }}>
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
