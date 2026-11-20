import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { Button, Input } from '@txresbench/kit'

/**
 * A day chosen from the checked files: suggested days as buttons, a number
 * box for any other day, and the lines under it (what the day covers, a
 * warning, or why a typed day cannot be used). Used by the study step's
 * "Last draw you will use", step 4's decision day and step 4's look-ahead.
 *
 * The field never stores a day itself: a suggestion click and a typed day
 * (on Enter or when the box loses focus) go to `onChoose`, which runs the
 * registered action, so the AI and the person take the same path.
 */
export interface TxrDayFieldProps {
  /** The test id prefix (`<id>-input`, `<id>-suggestion-<day>`, `<id>-coverage`, ...). */
  testId: string
  /** The accessible name of the number box. */
  label: string
  /** The chosen day, or null when none is chosen yet. */
  value: number | null
  /** The suggested days (none: no suggestion row). */
  suggestions: readonly number[]
  /** The label of a suggestion button (default "Day N"). */
  suggestionLabel?: (day: number) => string
  /** Store a day (the registered action). */
  onChoose: (day: number) => void
  /** Why a typed day cannot be used, or null. */
  check: (day: number) => string | null
  /** Text beside the box (the months of a look-ahead). */
  beside?: string | null
  /** The coverage line of the chosen day. */
  coverage?: string | null
  /** A warning about the chosen day (it can still be used). */
  warning?: string | null
  /** Why the chosen day cannot be used (blocks the run). */
  blocked?: string | null
  /** A line shown when there are no facts to suggest from. */
  noFacts?: string | null
  /** The field cannot be changed (the day is the model's own). */
  locked?: boolean
}

const ROW: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }

const CHIP: CSSProperties = {
  borderRadius: 999,
  padding: '3px 11px',
  fontSize: 13,
  fontWeight: 500,
  border: '1px solid var(--txr-border)',
  background: 'var(--txr-surface)',
  color: 'var(--txr-text-2)',
}

const CHIP_SELECTED: CSSProperties = {
  ...CHIP,
  border: '1px solid var(--txr-brand)',
  background: 'var(--txr-accent-soft)',
  color: 'var(--txr-brand-ink)',
  fontWeight: 600,
}

const BOX: CSSProperties = { width: 96 }

const BESIDE: CSSProperties = { fontSize: 13, color: 'var(--txr-text-2)' }

const LINE: CSSProperties = { margin: '6px 0 0', fontSize: 13, color: 'var(--txr-text-2)' }

const WARNING: CSSProperties = { ...LINE, color: 'var(--txr-warning)' }

const ERROR: CSSProperties = { ...LINE, color: 'var(--txr-danger)' }

const defaultLabel = (day: number): string => `Day ${day}`

export function TxrDayField({
  testId,
  label,
  value,
  suggestions,
  suggestionLabel = defaultLabel,
  onChoose,
  check,
  beside = null,
  coverage = null,
  warning = null,
  blocked = null,
  noFacts = null,
  locked = false,
}: TxrDayFieldProps) {
  const [draft, setDraft] = useState(value === null ? '' : String(value))
  const [typedError, setTypedError] = useState<string | null>(null)

  // The box follows the chosen day (a suggestion click, an AI change).
  useEffect(() => {
    setDraft(value === null ? '' : String(value))
    setTypedError(null)
  }, [value])

  const commit = (): void => {
    const text = draft.trim()
    if (text === '') {
      setDraft(value === null ? '' : String(value))
      setTypedError(null)
      return
    }
    const day = Number(text)
    const problem = Number.isFinite(day) ? check(day) : 'Type a day as a number.'
    if (problem !== null) {
      setTypedError(problem)
      return
    }
    setTypedError(null)
    if (day !== value) onChoose(day)
  }

  return (
    <div data-testid={testId}>
      <div style={ROW}>
        {suggestions.length > 0 && !locked ? (
          <div style={ROW} role="group" aria-label={`Suggested days for ${label.toLowerCase()}`} data-testid={`${testId}-suggestions`}>
            {suggestions.map(day => {
              const selected = day === value
              return (
                <Button
                  key={day}
                  data-testid={`${testId}-suggestion-${day}`}
                  variant="outline"
                  aria-pressed={selected}
                  style={selected ? CHIP_SELECTED : CHIP}
                  onClick={() => {
                    if (!selected) onChoose(day)
                  }}
                >
                  {suggestionLabel(day)}
                </Button>
              )
            })}
          </div>
        ) : null}
        <Input
          data-testid={`${testId}-input`}
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          aria-label={label}
          aria-invalid={typedError !== null || blocked !== null}
          invalid={typedError !== null || blocked !== null}
          placeholder="Day"
          size="sm"
          readOnly={locked}
          value={draft}
          onChange={event => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={event => {
            if (event.key === 'Enter') commit()
          }}
          style={BOX}
          allowStyle
        />
        {beside !== null ? (
          <span style={BESIDE} data-testid={`${testId}-beside`}>
            {beside}
          </span>
        ) : null}
      </div>
      {typedError !== null ? (
        <p role="alert" style={ERROR} data-testid={`${testId}-error`}>
          {typedError}
        </p>
      ) : null}
      {coverage !== null ? (
        <p style={LINE} data-testid={`${testId}-coverage`}>
          {coverage}
        </p>
      ) : null}
      {noFacts !== null ? (
        <p style={LINE} data-testid={`${testId}-no-facts`}>
          {noFacts}
        </p>
      ) : null}
      {blocked !== null ? (
        <p role="alert" style={ERROR} data-testid={`${testId}-blocked`}>
          {blocked}
        </p>
      ) : null}
      {warning !== null ? (
        <p style={WARNING} data-testid={`${testId}-warning`}>
          {warning}
        </p>
      ) : null}
    </div>
  )
}
