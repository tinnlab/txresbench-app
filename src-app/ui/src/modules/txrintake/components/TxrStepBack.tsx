/**
 * The Back button of the step views (B, C, N, E, D, I) and the hook each
 * step page calls to join the step trail (`lib/stepTrail.ts`).
 *
 * - `useStepBack(...)` records the step in the trail on mount (and on a
 *   search change), declares the `txr.step` context (so the palette and the
 *   AI offer `flow.back` only on a step view) and keeps the step's Back
 *   facts current: the fallback for an empty trail, the reason Back is not
 *   possible (a run is starting), and whether a page dialog is open.
 * - `<TxrStepBack />` is the button. It sits directly left of the step's
 *   proceed button, in the same row, and runs the registered `flow.back`
 *   action: the button and the AI take the same path.
 * - `<TxrStepBackBar />` is the bottom bar of a state with no proceed
 *   button: Back at the right end, where the proceed button sits otherwise.
 */
import { useEffect } from 'react'
import type { CSSProperties } from 'react'
import { useLocation } from 'react-router-dom'
import { useStore } from 'zustand'
import { FiArrowLeft } from 'react-icons/fi'
import { Button, message } from '@txresbench/kit'
import { runAction } from '@/core/actions/defineAction'
import { useActiveContext } from '@/core/actions/activeContext'
import { PageFooterBar } from '@/modules/txrshell/components/PageFooterBar'
import { recordStep, TXR_STEP_CONTEXT, useStepTrailStore, type TxrStepId } from '../lib/stepTrail'

/** The reason Back is not possible while a run is being started. */
export const STEP_BACK_STARTING_REASON = 'Starting the run…'

export interface UseStepBackOptions {
  /** Which step view this is. */
  step: TxrStepId
  /** Where Back goes when the trail has nothing before this step (a reload, a deep link). */
  fallback: string
  /** Why Back is not possible right now, or null. */
  blockedReason?: string | null
  /** A page dialog is open (Back from the palette or the AI refuses). */
  dialogOpen?: boolean
}

/** Join the step trail: called once by each step page, in every state. */
export function useStepBack({
  step,
  fallback,
  blockedReason = null,
  dialogOpen = false,
}: UseStepBackOptions): void {
  const location = useLocation()
  const url = `${location.pathname}${location.search}`
  useActiveContext(TXR_STEP_CONTEXT, { entityId: step })

  useEffect(() => {
    recordStep(url)
  }, [url])

  useEffect(() => {
    useStepTrailStore.setState({ current: { step, url, fallback, blockedReason, dialogOpen } })
  }, [step, url, fallback, blockedReason, dialogOpen])

  useEffect(
    () => () => {
      // Leaving the step view: forget it, unless another step already took its place.
      if (useStepTrailStore.getState().current?.step === step) {
        useStepTrailStore.setState({ current: null, leaving: false })
      }
    },
    [step],
  )
}

/**
 * The button's look per row: `footer` next to the kit-sized Continue of
 * B/C/N; `run-bar` next to the 44 px Run of E; `list-bar` next to the Run of
 * the D/I list bar.
 */
export type TxrStepBackLook = 'footer' | 'run-bar' | 'list-bar'

const BASE: CSSProperties = {
  borderRadius: 8,
  background: 'var(--txr-surface)',
  color: 'var(--txr-text)',
  fontWeight: 600,
  border: '1px solid var(--txr-border)',
}

const LOOKS: Record<TxrStepBackLook, CSSProperties> = {
  footer: BASE,
  'run-bar': { ...BASE, height: 'auto', minHeight: 44, padding: '10px 18px', fontSize: 14 },
  'list-bar': { ...BASE, height: 'auto', padding: '10px 18px', fontSize: 14 },
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not go back.'
}

export function TxrStepBack({ look = 'footer' }: { look?: TxrStepBackLook }) {
  const blockedReason = useStore(useStepTrailStore, s => s.current?.blockedReason ?? null)
  return (
    <Button
      data-testid="txr-step-back"
      variant="outline"
      icon={<FiArrowLeft />}
      style={LOOKS[look]}
      unavailableReason={blockedReason ?? undefined}
      onClick={() => {
        // A Back already left this step; the route is changing (a second click does nothing).
        if (useStepTrailStore.getState().leaving) return
        runAction('flow.back', {}).catch((error: unknown) => {
          message.error(errorText(error))
        })
      }}
    >
      Back
    </Button>
  )
}

/** The bottom bar of a step state with no proceed button: Back at the right end. */
export function TxrStepBackBar() {
  return (
    <PageFooterBar testId="txr-step-back-bar">
      <span style={{ flexGrow: 1 }} />
      <TxrStepBack />
    </PageFooterBar>
  )
}
