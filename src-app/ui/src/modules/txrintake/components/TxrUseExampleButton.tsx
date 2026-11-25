/**
 * TxrUseExampleButton — qa-fixes3 ITEM-4, re-wired by the predict-card
 * merge (round 1): the ONE "Use example" action of the two paths, backed by
 * the registered `flow.useExample` action (the cards' buttons and the AI
 * agent drive the SAME path — the example adoption + set-ensure live behind
 * the action, never a second implementation in the button), with the plan's
 * states:
 *
 * - an accessible name naming the path (the two landing-card buttons are
 *   indistinguishable by the shared visible label, so the ARIA name names
 *   the path the button starts);
 * - a loading state (the table fetch + adoption, and on the predict path
 *   the example-set training progress: the button stays mounted and the
 *   progress line reports the ITEM-3 poll's run state while `creating`,
 *   the UI's job state the plan asks for) — the action streams the
 *   set-training state to the host through the ctx progress channel;
 * - an error state with the honest line and the button as Retry.
 *
 * Inline confirm: the example never overwrites files the user already
 * loaded. A click on a path whose slot(s) hold a user's own file (the
 * example flag is false) asks FIRST — "Use the example instead" /
 * "Keep my files" — and only then adopts.
 *
 * The component owns ONLY the click state; the flow (adoption + answers +
 * set-ensure) is the registered `flow.useExample` action (the same
 * `lib/example.ts`'s `runExampleFlow` behind it), and navigation is the
 * action's (it opens the path's file step; the file screens stay put —
 * their own flows pick the cards up).
 *
 * Placement: by default the button and its message (the confirm question,
 * the progress line, the error) render as one column, the message under
 * the button. A host that sits the button in a row with other buttons
 * passes `layout` and places the two parts apart (the Start cards put the
 * message under the whole button row, across the card), so a long message
 * never widens the button's slot in the row.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Button } from '@txresbench/kit'
import type { ExampleSetResponse } from '@/api-client/types'
import { useStore } from 'zustand'
import { useTxrIntakeStore } from '../stores/TxrIntake.store'
import { exampleSlotsFor } from '../lib/example'
import type { IntakeIntent } from '../types'
import { createActionContext } from '@/core/actions/ctx'
import { runAction } from '@/core/actions/defineAction'

/** The accessible name of each path's button (the plan's name rule). */
const ACCESSIBLE_NAMES: Record<IntakeIntent, string> = {
  predict: 'Use example data: predict new patients',
  train: 'Use example data: learn from my data',
}

/** The visible label (the plan's words; the per-path name is the ARIA's). */
const LABEL = 'Use example'

/** The inline-confirm question (the plan's no-silent-overwrite rule). */
const CONFIRM_QUESTION =
  'Use the example data instead of the files you have loaded? The example will replace them.'

/** The confirm's two actions. */
const CONFIRM_BUTTONS = { yes: 'Use the example instead', no: 'Keep my files' } as const

/** The predict-path progress line (the honest job state; no fixed time). */
const SET_PROGRESS_LINE = (count: number): string =>
  count === 0
    ? 'Preparing the example models…'
    : `Preparing the example models — training ${count === 1 ? '1 method' : `${count} methods`}…`

const BUTTON: CSSProperties = {
  borderRadius: 8,
  background: 'var(--txr-surface)',
  color: 'var(--txr-text)',
  fontWeight: 600,
  border: '1px solid var(--txr-border)',
}

const ERROR_LINE: CSSProperties = { color: 'var(--txr-danger)', fontSize: 13.5 }

const PROGRESS_LINE: CSSProperties = {
  color: 'var(--txr-text-2)',
  fontSize: 13.5,
  margin: 0,
}

/** The button + message column (the default placement, and the message's own stack). */
const COLUMN: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8 }

/** The two parts a host places apart through `layout`. */
export interface TxrUseExampleParts {
  /** The "Use example" / "Try again" button alone; null while the confirm question is open. */
  action: ReactNode
  /** What the click produced: the confirm question with its two buttons, or the
   *  progress line and/or the error line. Null when there is nothing to say. */
  message: ReactNode
}

export interface TxrUseExampleButtonProps {
  path: IntakeIntent
  /** Called after the action prepared the store AND navigated (the hosts
   *  that only needed the flow keep no onDone — the action navigates). */
  onDone?: () => void
  /** The visible label (default: the board's "Use example"; qa-fixes3
   *  ITEM-5's Help cards pass the plan's one line "Try it with example
   *  data" — the per-path accessible name never changes). */
  label?: string
  style?: CSSProperties
  /** Place the button and its message apart (see the header). Without it
   *  the message renders under the button, in one column. */
  layout?(parts: TxrUseExampleParts): ReactNode
}

/** True when the action's progress `data` is the example-set response (the
 *  state the progress line renders — anything else is ignored). */
function isExampleSetResponse(data: unknown): data is ExampleSetResponse {
  return (
    data !== null &&
    typeof data === 'object' &&
    'state' in data &&
    (data as { state?: unknown }).state !== undefined
  )
}

export function TxrUseExampleButton({ path, onDone, label, style, layout }: TxrUseExampleButtonProps) {
  const occupied = useStore(
    useTxrIntakeStore,
    s => {
      const exampleSlots = s.exampleSlots
      return exampleSlotsFor(path).some(slot => {
        const file = s[slot]
        return file !== null && exampleSlots[slot] !== true
      })
    },
  )

  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<ExampleSetResponse | null>(null)
  // A click on "Try again" keeps that label while the retry loads, so the
  // button keeps the width it had (see the label below).
  const [retrying, setRetrying] = useState(false)
  const cancelled = useRef(false)
  // The action's host channel: the host aborts the flow on unmount (the
  // button's own `cancelled` flag is passed to the action as a ctx signal).
  const cancelController = useRef<AbortController | null>(null)
  // Keyboard focus follows the confirm: the question takes it when it opens
  // (the button it replaced held it), and "Keep my files" gives it back to
  // the button, which is mounted again by then.
  const questionRef = useRef<HTMLParagraphElement>(null)
  const buttonRef = useRef<HTMLButtonElement | HTMLAnchorElement>(null)
  const refocusButton = useRef(false)
  useLayoutEffect(() => {
    if (confirming) questionRef.current?.focus()
    else if (refocusButton.current) {
      refocusButton.current = false
      buttonRef.current?.focus()
    }
  }, [confirming])

  useEffect(() => {
    cancelled.current = false
    return () => {
      cancelled.current = true
      cancelController.current?.abort()
    }
  }, [])

  const start = async (retry: boolean): Promise<void> => {
    setBusy(true)
    setRetrying(retry)
    setError(null)
    setProgress(null)
    cancelController.current = new AbortController()
    const ctx = createActionContext({
      signal: cancelController.current.signal,
      // The action streams the example-set poll state; the host renders it
      // as the honest progress line (the agent sees the same as a note).
      onProgress: (_message, data) => {
        if (isExampleSetResponse(data)) setProgress(data)
      },
    })
    try {
      await runAction('flow.useExample', { intent: path }, ctx)
      onDone?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The example could not be loaded. Try again.')
    } finally {
      setBusy(false)
      setRetrying(false)
    }
  }

  const onClick = (): void => {
    const retry = error !== null
    setError(null)
    if (occupied) {
      setConfirming(true)
      return
    }
    void start(retry)
  }

  // The confirm question REPLACES the button while it is open.
  // Loading keeps the button's width: the kit Button puts its spinner BEFORE
  // the label, which widened the button by the spinner and its gap and pushed
  // the Start cards' button rows to the card border. While busy, index.css
  // (`.txr-use-example-button`) centres the spinner over the label's place
  // and hides the label, which still holds the width. The name is the
  // aria-label, so hiding the label changes nothing for a screen reader.
  const action: ReactNode = confirming ? null : (
    <Button
      ref={buttonRef}
      data-testid={`txr-use-example-${path}`}
      aria-label={ACCESSIBLE_NAMES[path]}
      className="txr-use-example-button"
      style={{ ...BUTTON, ...style }}
      loading={busy}
      onClick={onClick}
    >
      <span className="txr-use-example-label">
        {error !== null || retrying ? 'Try again' : (label ?? LABEL)}
      </span>
    </Button>
  )

  const lines: ReactNode = confirming ? (
    <>
      <p
        ref={questionRef}
        tabIndex={-1}
        role="alert"
        style={{ margin: 0, fontSize: 13.5, color: 'var(--txr-text-2)', outline: 'none' }}
        data-testid="txr-use-example-confirm"
      >
        {CONFIRM_QUESTION}
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        <Button
          data-testid="txr-use-example-confirm-yes"
          style={BUTTON}
          onClick={() => {
            setConfirming(false)
            void start(false)
          }}
        >
          {CONFIRM_BUTTONS.yes}
        </Button>
        <Button
          data-testid="txr-use-example-confirm-no"
          style={BUTTON}
          onClick={() => {
            refocusButton.current = true
            setConfirming(false)
          }}
        >
          {CONFIRM_BUTTONS.no}
        </Button>
      </div>
    </>
  ) : progress !== null || error !== null ? (
    <>
      {progress !== null ? (
        <p data-testid={`txr-use-example-progress-${path}`} style={PROGRESS_LINE} role="status">
          {SET_PROGRESS_LINE(progress.methods.length)}
        </p>
      ) : null}
      {error !== null ? (
        <p data-testid={`txr-use-example-error-${path}`} style={ERROR_LINE} role="alert">
          {error}
        </p>
      ) : null}
    </>
  ) : null

  if (layout !== undefined) {
    return (
      <>
        {layout({
          action,
          message:
            lines === null ? null : (
              <div data-testid={`txr-use-example-message-${path}`} style={COLUMN}>
                {lines}
              </div>
            ),
        })}
      </>
    )
  }

  return (
    <div style={COLUMN}>
      {action}
      {lines}
    </div>
  )
}
