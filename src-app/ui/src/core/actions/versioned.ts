// The read-before-write / stale-state guard's ground truth (PLAN.md ITEM-7;
// ARCHITECTURE.md Layer 6). A per-instance `version` bumps on EVERY
// mutation — human click AND AI action alike go through the SAME `mutate`/
// `set` call, so the version can never drift out of sync with reality
// (ARCHITECTURE.md: "the checkbox calls the SAME method the AI action
// calls"). A read stamps the live `_state_token` (`${instanceId}@${version}`)
// onto its snapshot; a mutating+stateful write must present a MATCHING
// token or is rejected — enforced by the engine (`./engine.ts`), never here.
//
// Deliberately pure / framework-free (no React, no store-kit) so it's
// directly unit-testable with a plain node harness (`scripts/actions-unit.
// test.mjs`, TEST-2) and reusable from any future instance-store shape.

export interface Versioned<T extends Record<string, unknown>> {
  /** Current value, WITHOUT `_state_token` (call `.snapshot()` for that). */
  readonly value: T
  /** Current version number (starts at 0; bumps by 1 on every `set`/`mutate`). */
  readonly version: number
  /** Current `${instanceId}@${version}` token. */
  readonly token: string
  /** `{ ...value, _state_token: token }` — what a read action / `useAction`
   *  `getSnapshot` should return. */
  snapshot(): T & { _state_token: string }
  /** Replace the value wholesale; bumps the version. Returns the new token. */
  set(next: T): string
  /** Derive the next value from the previous one; bumps the version.
   *  Returns the new token. */
  mutate(updater: (prev: T) => T): string
}

/** Create a versioned container for one instance's state. `instanceId` is
 *  baked into every stamped token so a token from one instance can never be
 *  mistaken for a match against another (ARCHITECTURE.md's "gone/replaced
 *  instance" — a stale `v2` token is meaningless once `v2` is torn down and
 *  a NEW instance registers under a fresh id, never a reused one). */
export function createVersioned<T extends Record<string, unknown>>(
  instanceId: string,
  initial: T,
): Versioned<T> {
  let version = 0
  let value = initial

  const token = () => `${instanceId}@${version}`

  return {
    get value() {
      return value
    },
    get version() {
      return version
    },
    get token() {
      return token()
    },
    snapshot() {
      return { ...value, _state_token: token() }
    },
    set(next) {
      value = next
      version += 1
      return token()
    },
    mutate(updater) {
      value = updater(value)
      version += 1
      return token()
    },
  }
}

/** Pure `expected`-vs-current token compare (ARCHITECTURE.md Layer 6):
 *  - `'missing'` — no `expected` presented (`READ_REQUIRED`).
 *  - `'stale'` — `expected` presented but doesn't match `current` (`STALE_STATE`).
 *  - `'ok'` — matches; the write may proceed. */
export function checkExpectedToken(
  current: string,
  expected: string | undefined,
): 'ok' | 'stale' | 'missing' {
  if (expected === undefined) return 'missing'
  return expected === current ? 'ok' : 'stale'
}
