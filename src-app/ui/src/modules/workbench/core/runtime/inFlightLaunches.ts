// inFlightLaunches — which launches are currently in the air.
//
// The guard this backs is against the ACCIDENTAL second click, not against the user. A run that
// has reached a terminal phase is re-runnable with identical inputs: re-running is a legitimate
// act (the repo has a re-run affordance and a provenance model built around it), and a compute
// is not required to be deterministic. So membership here is exactly "submitted and not yet
// finished" — never "has ever been run".
//
// Deliberately a module-level set rather than a store slice: it is process-local, ephemeral, and
// must NOT be persisted. A launch that was in flight when the tab closed is not in flight when it
// reopens, and a restored "busy" that nothing will ever clear is a Run button disabled forever.

type Listener = () => void

const inFlight = new Map<string, number>()
const listeners = new Set<Listener>()

let version = 0

function emit(): void {
  version += 1
  for (const l of [...listeners]) l()
}

/** A monotonic snapshot for `useSyncExternalStore`. A number rather than the map itself: the
 *  store's identity never changes, so a snapshot of it would compare equal on every change and
 *  the subscriber would never re-render. */
export function inFlightVersion(): number {
  return version
}

/**
 * Mark a launch in flight. Returns a `release` that is safe to call more than once — the caller
 * clears on a terminal frame AND on an error path, and a double release must not decrement a
 * later launch of the same identity to zero.
 *
 * Counted rather than a plain set: two launches CAN share an identity legitimately (the second
 * click that raced past the guard, a scripted caller), and a set would let the first to finish
 * clear the flag while the other is still running.
 */
export function markInFlight(identity: string): () => void {
  inFlight.set(identity, (inFlight.get(identity) ?? 0) + 1)
  emit()
  let released = false
  return () => {
    if (released) return
    released = true
    const n = (inFlight.get(identity) ?? 1) - 1
    if (n > 0) inFlight.set(identity, n)
    else inFlight.delete(identity)
    emit()
  }
}

/** Is a launch with this exact identity in the air right now? */
export function isInFlight(identity: string): boolean {
  return (inFlight.get(identity) ?? 0) > 0
}

/** Subscribe to changes (the render layer re-reads on every change). */
export function subscribeInFlight(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test seam — a module-level set survives between cases otherwise. */
export function __resetInFlightForTests(): void {
  inFlight.clear()
  listeners.clear()
}
