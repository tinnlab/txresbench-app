/**
 * txrrun — the run screens' own vocabulary (PROV-UI-RUN-2).
 *
 * Screen F (`BusyRunning.dc.html`) renders one row per method and its four
 * tabs (All / Working / Finished / Failed) — `TxrRunBucket` is that tab
 * set, and `bucketOf` in `lib/format.ts` assigns each per-method state to
 * its tab. The F screen never re-derives or guesses tab membership: the
 * engine's per-method state vocabulary (`TxrMethodState`, generated) maps
 * 1:1 onto the three non-All buckets, a complete partition.
 *
 * The values here are the run screens' OWN vocabulary. The wire vocabulary
 * (states, frames, reasons) stays the generated api-client types —
 * provider-owned regen output this node never vendors or regenerates
 * (DEC-14).
 */
export type TxrRunBucket = 'all' | 'working' | 'finished' | 'failed'
