/**
 * txrrun — the run screens' own vocabulary (PROV-UI-RUN-2).
 *
 * Screen F (`BusyRunning.dc.html`) renders one row per method and its tab
 * chips — `TxrRunBucket` is that tab set, and `bucketOf` in `lib/format.ts`
 * assigns each per-method state to its tab. The F screen never re-derives
 * or guesses tab membership: the engine's per-method state vocabulary
 * (`TxrMethodState`, generated) maps onto the non-All buckets, a complete
 * partition.
 *
 * The partition is the engine's own state words (qa-fixes ITEM-3, RP-3 — a
 * state is never re-labelled by its bucket: a `skipped` method is not
 * counted as `finished`, a `cannot_run` method is not counted as `failed`).
 * The buckets are `working` (waiting / downloading / running — the board's
 * one "working" tab over the three doing states) plus one bucket PER
 * terminal state, so the tab counts match the counts strip's own state
 * counters one to one.
 *
 * The values here are the run screens' OWN vocabulary. The wire vocabulary
 * (states, frames, reasons) stays the generated api-client types —
 * provider-owned regen output this node never vendors or regenerates
 * (DEC-14).
 */
export type TxrRunBucket =
  | 'all'
  | 'working'
  | 'finished'
  | 'failed'
  | 'stopped'
  | 'skipped'
  | 'cannot_run'
