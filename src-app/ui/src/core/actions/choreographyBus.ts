// The CHOREOGRAPHY event bus (richer-actions ITEM-6). A module-level singleton the
// runner (`./choreography.ts`) emits step events on and the overlay
// (`ChoreographyOverlay`) subscribes to — decoupled so the runner (core) never
// imports a React component. Each `spotlight` names an affordance
// (`./affordances.ts`) to ring + an optional caption; `clear` tears the overlay
// down (run finished / interrupted).
//
// A read-only `window.__choreography` seam records every emitted event (the last
// event + the full step log) so an e2e can assert the EXACT visible sequence
// deterministically, without racing the animation (DEC-13; mirrors the existing
// `window.__workbench` seam). Read-only: tests observe, never drive.

export interface SpotlightEvent {
  type: 'spotlight'
  /** The affordance name to ring (looked up via `getAffordance`). */
  name: string
  /** The narration caption (present only on a fully-narrated / AI run). */
  caption?: string
}
export interface ClearEvent {
  type: 'clear'
}
export type ChoreographyEvent = SpotlightEvent | ClearEvent

type Listener = (e: ChoreographyEvent) => void
const listeners = new Set<Listener>()

interface ChoreographySeam {
  /** The most recent event (or null after a clear / before any run). */
  last: ChoreographyEvent | null
  /** Append-only log of every event this session (for e2e sequence assertions). */
  log: ChoreographyEvent[]
}

function seam(): ChoreographySeam | undefined {
  if (typeof window === 'undefined') return undefined
  const w = window as unknown as { __choreography?: ChoreographySeam }
  if (!w.__choreography) w.__choreography = { last: null, log: [] }
  return w.__choreography
}

/** Emit a choreography event to the overlay + record it on the seam. */
export function emitChoreography(event: ChoreographyEvent): void {
  const s = seam()
  if (s) {
    s.last = event.type === 'clear' ? null : event
    s.log.push(event)
  }
  for (const l of listeners) l(event)
}

/** Subscribe to choreography events (for the overlay). Returns an unsubscribe. */
export function subscribeChoreography(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Test-only: clear the seam log + listeners between tests. */
export function __resetChoreographyBusForTests(): void {
  listeners.clear()
  const s = seam()
  if (s) {
    s.last = null
    s.log = []
  }
}
