/**
 * TxrUseExampleButton — qa-fixes3 ITEM-4: the ONE "Use example" action of
 * the three paths, with the plan's three states:
 *
 * - an accessible name naming the path (the three landing-card buttons are
 *   indistinguishable by the shared visible label, so the ARIA name names
 *   the path the button starts);
 * - a loading state (the table fetch + adoption, and — reuse path only —
 *   the example-set training progress: the button stays mounted and the
 *   progress line reports the ITEM-3 poll's run state while `creating`,
 *   the UI's job state the plan asks for);
 * - an error state with the honest line and the button as Retry.
 *
 * Inline confirm: the example never overwrites files the user already
 * loaded. A click on a path whose slot(s) hold a user's own file (the
 * example flag is false) asks FIRST — "Use the example instead" /
 * "Keep my files" — and only then adopts.
 *
 * The component owns ONLY the click state; the flow (adoption + answers +
 * set-ensure) is `lib/example.ts`'s `runExampleFlow`, and navigation is
 * the host's `onDone` (the landing card goes to the path's file step; the
 * file screens stay put — their own flows pick the cards up).
 *
 * Placement: by default the button and its message (the confirm question,
 * the progress line, the error) render as one column, the message under
 * the button. A host that sits the button in a row with other buttons
 * passes `layout` and places the two parts apart (the Start cards put the
 * message under the whole button row, across the card), so a long message
 * never widens the button's slot in the row.
 */
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Button } from '@txresbench/kit'
import type { ExampleSetResponse } from '@/api-client/types'
import { useStore } from 'zustand'
import { useTxrIntakeStore } from '../stores/TxrIntake.store'
import { exampleSlotsFor, runExampleFlow } from '../lib/example'
import type { IntakeIntent } from '../types'

/** The accessible name of each path's button (the plan's name rule). */
const ACCESSIBLE_NAMES: Record<IntakeIntent, string> = {
  pretrained: 'Use example data: predict with a pretrained model',
  train: 'Use example data: learn from my data',
  reuse: 'Use example data: use a model I saved',
}

/** The visible label (the plan's words; the per-path name is the ARIA's). */
const LABEL = 'Use example'

/** The inline-confirm question (the plan's no-silent-overwrite rule). */
const CONFIRM_QUESTION =
  'Use the example data instead of the files you have loaded? The example will replace them.'

/** The confirm's two actions. */
const CONFIRM_BUTTONS = { yes: 'Use the example instead', no: 'Keep my files' } as const

/** The reuse-path progress line (the honest job state; no fixed time). */
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
  /** The host's navigation after the flow prepared the store. */
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
  const cancelled = useRef(false)

  useEffect(() => {
    cancelled.current = false
    return () => {
      cancelled.current = true
    }
  }, [])

  const start = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setProgress(null)
    try {
      await runExampleFlow(path, {
        onSetProgress: setProgress,
        cancelled: () => cancelled.current,
      })
      onDone?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The example could not be loaded. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const onClick = (): void => {
    setError(null)
    if (occupied) {
      setConfirming(true)
      return
    }
    void start()
  }

  // The confirm question REPLACES the button while it is open.
  const action: ReactNode = confirming ? null : (
    <Button
      data-testid={`txr-use-example-${path}`}
      aria-label={ACCESSIBLE_NAMES[path]}
      style={{ ...BUTTON, ...style }}
      loading={busy}
      onClick={onClick}
    >
      {error !== null ? 'Try again' : (label ?? LABEL)}
    </Button>
  )

  const lines: ReactNode = confirming ? (
    <>
      <p style={{ margin: 0, fontSize: 13.5, color: 'var(--txr-text-2)' }} data-testid="txr-use-example-confirm">
        {CONFIRM_QUESTION}
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        <Button
          data-testid="txr-use-example-confirm-yes"
          style={BUTTON}
          onClick={() => {
            setConfirming(false)
            void start()
          }}
        >
          {CONFIRM_BUTTONS.yes}
        </Button>
        <Button
          data-testid="txr-use-example-confirm-no"
          style={BUTTON}
          onClick={() => setConfirming(false)}
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
