import { useEffect, useId, useRef, useState } from 'react'
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
 *
 * The number box is view state (study-step-ui-tweaks): after the suggestion
 * chips one "Other values" chip opens it, and it stays open (showing the
 * stored day) while the chosen day is outside the suggestions. Selecting it
 * never calls `onChoose` — the box only READS and COMMITS days, it never
 * stores one.
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
  // The box's open/closed state is VIEW ONLY (study-step-ui-tweaks): the
  // "Other values" chip presses it, and it never stores a day itself.
  const [otherOpen, setOtherOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const focusBoxOnNextRender = useRef(false)
  // The lines under the box are the box's own messages: the input names the
  // ones shown (a screen reader hears why a typed day is refused or what the
  // day covers), each line has a stable id of its own.
  const errorId = useId()
  const coverageId = useId()
  const blockedId = useId()
  const warningId = useId()
  const describedBy =
    [
      typedError !== null ? errorId : null,
      coverage !== null ? coverageId : null,
      blocked !== null ? blockedId : null,
      warning !== null ? warningId : null,
    ]
      .filter((id): id is string => id !== null)
      .join(' ') || undefined

  // The box follows the chosen day (a suggestion click, an AI change).
  useEffect(() => {
    setDraft(value === null ? '' : String(value))
    setTypedError(null)
  }, [value])

  // "Other values" reads pressed while the user opened it, AND while the
  // stored day is outside the suggestions (typed before or restored). A day
  // that changed INTO a suggestion closes the box again. The effect depends
  // on `outside` only: `suggestions` is a fresh array on most parent renders
  // (step 4 maps its choices), so depending on it would close a box the user
  // just opened even though nothing changed.
  const outside = value !== null && !suggestions.includes(value)
  useEffect(() => {
    setOtherOpen(outside)
  }, [outside])

  const hasSuggestions = suggestions.length > 0 && !locked
  // The box is shown directly when there is nothing to suggest or the field
  // is locked (the old behaviour); with suggestions it opens only through
  // the "Other values" chip.
  const showBox = locked || !hasSuggestions || otherOpen
  const otherPressed = hasSuggestions && otherOpen

  // Opening the box (the chip click) moves focus into it, so a keyboard user
  // can type at once. Gated on the click: an always-visible box (no
  // suggestions, locked) never steals focus, and neither does a day restored
  // from the store behind the user's back.
  useEffect(() => {
    if (showBox && focusBoxOnNextRender.current) {
      focusBoxOnNextRender.current = false
      inputRef.current?.focus()
    }
  }, [showBox])

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
        {hasSuggestions ? (
          <>
            <div style={ROW} role="group" aria-label={`Suggested days for ${label.toLowerCase()}`} data-testid={`${testId}-suggestions`}>
              {suggestions.map(day => {
                // A suggestion chip reads pressed only when it IS the chosen
                // day AND the box is closed — so exactly one chip (the
                // chosen suggestion, or "Other values") is pressed.
                const selected = day === value && !otherPressed
                return (
                  <Button
                    key={day}
                    data-testid={`${testId}-suggestion-${day}`}
                    variant="outline"
                    aria-pressed={selected}
                    style={selected ? CHIP_SELECTED : CHIP}
                    onClick={() => {
                      // A suggestion click closes the box; a NEW day still
                      // goes to onChoose exactly as before. Even when the
                      // clicked day equals the stored one (onChoose skipped)
                      // the click clears a stale typed error and resets the
                      // draft, so no red line stays under the hidden box.
                      setOtherOpen(false)
                      setTypedError(null)
                      setDraft(value === null ? '' : String(value))
                      if (day !== value) onChoose(day)
                    }}
                  >
                    {suggestionLabel(day)}
                  </Button>
                )
              })}
            </div>
            <Button
              data-testid={`${testId}-other`}
              variant="outline"
              aria-pressed={otherPressed}
              style={otherPressed ? CHIP_SELECTED : CHIP}
              onClick={() => {
                // Focus only when the click is what OPENS the box (an
                // already-open box keeps its focus).
                if (!otherOpen) focusBoxOnNextRender.current = true
                setOtherOpen(true)
              }}
            >
              Other values
            </Button>
          </>
        ) : null}
        {showBox ? (
          <>
            <Input
              ref={inputRef}
              data-testid={`${testId}-input`}
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              aria-label={label}
              aria-describedby={describedBy}
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
          </>
        ) : null}
      </div>
      {typedError !== null ? (
        <p role="alert" id={errorId} style={ERROR} data-testid={`${testId}-error`}>
          {typedError}
        </p>
      ) : null}
      {coverage !== null ? (
        <p id={coverageId} style={LINE} data-testid={`${testId}-coverage`}>
          {coverage}
        </p>
      ) : null}
      {noFacts !== null ? (
        <p style={LINE} data-testid={`${testId}-no-facts`}>
          {noFacts}
        </p>
      ) : null}
      {blocked !== null ? (
        <p role="alert" id={blockedId} style={ERROR} data-testid={`${testId}-blocked`}>
          {blocked}
        </p>
      ) : null}
      {warning !== null ? (
        <p role="status" id={warningId} style={WARNING} data-testid={`${testId}-warning`}>
          {warning}
        </p>
      ) : null}
    </div>
  )
}
