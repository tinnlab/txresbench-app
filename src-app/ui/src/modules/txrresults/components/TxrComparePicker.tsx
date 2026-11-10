/**
 * TxrComparePicker — which two methods the H compare tab compares
 * (qa-fixes2 R2-07): the board's two-method card was ALWAYS the first two
 * columns, with no control and no clue why those two. The picker is two kit
 * Selects — "Compare <A> with <B>" — over the active outcome tab's method
 * columns (the same column set the table shows); the pair's reports (the
 * card, the "Show only the patients where they differ" filter, the
 * first-method sort) all follow the pick, and the picker can never produce
 * an A == B pair: picking the other method's column in one select swaps
 * them (one visible rule, no hidden state), so the two selects always read
 * two distinct methods.
 *
 * The component is presentational: `columns` are the tab's columns, `pair`
 * is the effective pair (the page's default-first-two resolution), and
 * `onChange` reports the picked pair. Everything else stays the H page's
 * derivation.
 */
import type { CSSProperties } from 'react'
import { Select } from '@ziee/kit'
import type { TxrHeatmapColumn } from '../types'

const ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
  fontSize: 13.5,
}

const LABEL: CSSProperties = { color: 'var(--txr-text-2)' }

export interface TxrComparePair {
  a: string
  b: string
}

export interface TxrComparePickerProps {
  /** The active outcome tab's columns (the pickable set). */
  columns: ReadonlyArray<TxrHeatmapColumn>
  /** The effective pair (the page's default-first-two resolution). */
  pair: TxrComparePair
  /** The picked pair (the page stores it; an invalid pick re-defaults). */
  onChange: (pair: TxrComparePair) => void
}

export function TxrComparePicker({ columns, pair, onChange }: TxrComparePickerProps) {
  const options = columns.map(column => ({ value: column.methodId, label: column.label }))
  const optionOf = (id: string) => options.find(option => option.value === id)
  return (
    <div
      data-testid="txr-compare-picker"
      className="txr-compare-picker"
      style={ROW}
    >
      <span style={LABEL}>Compare</span>
      <Select
        data-testid="txr-compare-picker-a"
        aria-label="First method to compare"
        size="sm"
        options={options}
        value={pair.a}
        onValueChange={value => {
          // A == B pick keeps both distinct: the other select takes the
          // previous A (the swap rule) — the visible pair always changes.
          if (value !== pair.a && value !== pair.b) {
            onChange({ a: value, b: pair.b })
          } else if (value === pair.b) {
            onChange({ a: pair.b, b: pair.a })
          }
        }}
      />
      <span style={LABEL}>with</span>
      <Select
        data-testid="txr-compare-picker-b"
        aria-label="Second method to compare"
        size="sm"
        options={options}
        value={pair.b}
        onValueChange={value => {
          if (value !== pair.b && value !== pair.a) {
            onChange({ a: pair.a, b: value })
          } else if (value === pair.a) {
            onChange({ a: pair.b, b: pair.a })
          }
        }}
      />
      {optionOf(pair.a) !== undefined && optionOf(pair.b) !== undefined ? (
        <span style={{ fontSize: 12.5, color: 'var(--txr-muted)' }}>
          The card and the divergent filter follow the pair.
        </span>
      ) : null}
    </div>
  )
}
