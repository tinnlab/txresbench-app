// Per-instance mutation serialization — closes a stale-guard race the
// engine's pre-dispatch check alone can't (audit HIGH finding on
// `./engine.ts`'s `checkInstanceGuard`, ~ line 325).
//
// `checkInstanceGuard` is a one-shot, SYNCHRONOUS pre-dispatch check: it
// reads the instance's current `_state_token` and compares it against the
// invoke's `expected_token` in a single JS tick, with no `await` in between
// — atomic against anything else running "at the same instant" in a
// single-threaded runtime. But a `defineAction.run` for a mutating instance
// action is `async` and MAY itself `await` (a store call, `Stores.X.foo()`,
// …) before it actually applies the mutation that bumps the token. Two
// concurrent `agent_invoke` frames for the SAME instance, both carrying the
// same (soon-to-be-stale) `expected_token`, can each pass the synchronous
// pre-check BEFORE either one's `run` has landed its mutation — then both
// proceed to mutate, the second silently clobbering the first instead of
// being rejected `STALE_STATE`.
//
// `runSerialized` fixes this the same way a real critical section would:
// mutating invokes for one `instanceId` are chained onto a per-instance
// promise tail so they run STRICTLY one at a time, in arrival order. The
// caller is expected to RE-CHECK the guard synchronously as the very first
// statement inside its queued `task` (see `./engine.ts`'s `dispatch`) — by
// the time a queued task actually starts, every earlier same-instance task
// has fully settled, so a re-check at that point sees the LIVE token, not
// the one that was current when the invoke first arrived. That makes the
// check-then-apply pair atomic across the `await` without needing a real
// lock primitive: nothing else touching this instance can run between the
// re-check and the mutation, because nothing else touching this instance
// runs at all until this task's promise settles.
//
// Deliberately pure / framework-free (no React, no SSE/engine types) so it's
// directly unit-testable (`scripts/actions-unit.test.mjs`) independent of
// the transport plumbing around it.

const tails = new Map<string, Promise<void>>()

/**
 * Queue `task` to run only after every previously-queued task for
 * `instanceId` has SETTLED (success OR failure — a failing task never
 * wedges the queue for the next caller). Returns a promise that
 * resolves/rejects with `task`'s own outcome, unchanged.
 *
 * Invokes for DIFFERENT `instanceId`s never wait on each other — this is
 * per-instance serialization, not a global lock.
 */
export function runSerialized<T>(
  instanceId: string,
  task: () => Promise<T> | T,
): Promise<T> {
  const prior = tails.get(instanceId) ?? Promise.resolve()
  // `task` runs as either the fulfillment OR rejection handler of `prior` —
  // i.e. unconditionally, once `prior` settles — so one failing invoke can
  // never starve every invoke queued behind it.
  const outcome = prior.then(task, task)

  // Track completion for chaining purposes only (never rejects), so this
  // task's own rejection can't short-circuit the NEXT caller's `.then`.
  const tracking = outcome.then(
    () => undefined,
    () => undefined,
  )
  tails.set(instanceId, tracking)

  // Once nothing is queued behind this task, drop the tail entry so the map
  // doesn't grow forever across every instance id ever mutated (an instance
  // is typically mounted/unmounted many times over an app session).
  void tracking.then(() => {
    if (tails.get(instanceId) === tracking) tails.delete(instanceId)
  })

  return outcome
}

/** Test-only reset. Never called from production code. */
export function __resetInstanceLocksForTests(): void {
  tails.clear()
}
