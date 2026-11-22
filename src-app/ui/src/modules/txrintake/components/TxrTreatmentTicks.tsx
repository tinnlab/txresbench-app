/**
 * txrintake screen B — the treatment multi-tick (step2-filters, brief 5b).
 *
 * Replaces the single treatment `Select`: the base treatment classes of the
 * method catalogue's `filter_options` vocabulary as a kit `Checkbox` list,
 * one per class with its display label, plus the board's hint line. Nothing
 * ticked means no treatment filter; several ticks are a combination.
 *
 * Every toggle writes the WHOLE new tick set — the current ticks with the
 * toggled one flipped — in VOCABULARY order (the order the classes list
 * them, never the click order); an empty set is the call's answer, and the
 * registered `intake.setStudyAnswers` action maps it to the store's
 * unanswered spelling (`treatments: null` — a request then omits the
 * field, the provider reads "any"). A persisted multi-tick renders all of
 * its ticks (each checkbox state is the membership test, nothing collapses
 * to a single choice).
 *
 * The next set is built from the store's CURRENT treatments at CLICK time,
 * never from the render-time `value` alone (brief 5b2 ITEM-2): the write
 * goes through the async validating action, so two ticks inside one tick —
 * before the first write has landed — would otherwise BOTH read the same
 * render-time value and the second write would overwrite the first's tick.
 * A same-burst merge is kept in a ref (the store cannot be ahead of the
 * click for a burst inside one render), re-seeded whenever the incoming
 * `value` moves (the store reflects a landed write).
 */
import { useRef } from 'react'
import { Checkbox } from '@txresbench/kit'
import type { TreatmentClass } from '@/api-client/types'
import { TREATMENT_MULTI_HINT } from '../lib/format'
import { useTxrIntakeStore } from '../stores/TxrIntake.store'

export interface TxrTreatmentTicksProps {
  /** The ticked class ids, `null` when the question is unanswered. */
  value: string[] | null
  /** The vocabulary's base classes (the id + the display label). */
  treatments: TreatmentClass[]
  /** The WHOLE new tick set in vocabulary order (empty = none ticked). */
  onChange: (ids: string[]) => void
}

export function TxrTreatmentTicks({ value, treatments, onChange }: TxrTreatmentTicksProps) {
  const ticked = new Set(value ?? [])
  // The intended ticks of the burst not yet reflected by the store (the
  // async `intake.setStudyAnswers` write). Re-seeded when the incoming
  // `value` moves, so an externally-changed answer (the AI, a reconcile)
  // is never masked by a stale burst.
  const pendingRef = useRef<ReadonlySet<string> | null>(null)
  const seenValueRef = useRef(value)
  if (seenValueRef.current !== value) {
    seenValueRef.current = value
    pendingRef.current = null
  }
  return (
    <div>
      <div
        role="group"
        aria-label="Treatment"
        data-testid="txr-intake-study-treatment"
        style={{ display: 'flex', flexDirection: 'column', gap: 2 }}
      >
        {treatments.map(treatment => (
          <Checkbox
            key={treatment.id}
            data-testid={`txr-intake-study-treatment-${treatment.id}`}
            label={treatment.label}
            checked={ticked.has(treatment.id)}
            onCheckedChange={checked => {
              // The base is the store's CURRENT value at click time (it may
              // be ahead of this render when an earlier write landed),
              // merged with the burst's pending ticks — a second click in
              // the same render must never see the pre-click value again.
              const base = pendingRef.current ?? new Set(useTxrIntakeStore.getState().study.treatments ?? [])
              const next = new Set(base)
              if (checked) next.add(treatment.id)
              else next.delete(treatment.id)
              pendingRef.current = next
              onChange(treatments.filter(item => next.has(item.id)).map(item => item.id))
            }}
          />
        ))}
      </div>
      <p
        data-testid="txr-intake-study-treatment-hint"
        style={{ margin: '6px 0 0', fontSize: 12.5, color: 'var(--txr-muted)' }}
      >
        {TREATMENT_MULTI_HINT}
      </p>
    </div>
  )
}
