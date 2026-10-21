// decodeCounter — count DECODES, not requests (ITEM-11).
//
// ── WHY REQUESTS ARE THE WRONG THING TO COUNT ────────────────────────────────────────────
//
// Artifact bytes are served `Cache-Control: immutable` (`data_api.rs`), so a second read of the
// same member very often issues NO second HTTP request — the browser answers it from cache. A test
// that counts requests therefore reports "1" for both the good case (the read was shared) and the
// bad one (the read was repeated and merely cheap), which makes it useless for the invariant it is
// usually written to protect: "changing the encoding fetches ONE column, not a reload".
//
// A DECODE is the honest unit. Every repeat costs a real inflate + unshuffle + typed-array
// materialisation whether or not the bytes came off the wire, and it is exactly what a shared
// stream / an in-flight multicast is supposed to eliminate. So the counter sits at the point where
// a chunk is actually turned back into numbers.
//
// ── OFF BY DEFAULT, AND INERT WHEN OFF ───────────────────────────────────────────────────
//
// Recording is opt-in. Left always-on, the map would grow with every member a long session ever
// touched — an unbounded cache keyed by user browsing, which is precisely the class of leak this
// codebase makes a rule of avoiding. Disabled, `countDecode` is one boolean test.

/** `<artifactId>|<member path>` — the granularity every assertion in the plan is written at. */
export type DecodeKey = string

/**
 * Recording can also be armed AT MODULE LOAD, by a page that set `window.__cyto_count_decodes`
 * before any app script ran (an e2e `addInitScript`).
 *
 * That entry point exists because `enable()` is unusable for the invariant it was written for.
 * INV-6 is about the FIRST read of a member: `zarrReader` caches decoded chunks, so by the time a
 * spec has a page to call `enable()` on, the surface it is about to exercise may already have
 * decoded — and every subsequent read is then served from that cache, recording ZERO decodes. A
 * spec built on `enable()` therefore reports "no repeat decode" for a correct implementation AND
 * for one with the multicast removed, which is the vacuous shape this branch keeps catching.
 * Measured, not reasoned: TEST-8's first run recorded `{"|values/values": 2}` and no positions
 * decode at all, because the coordinate section had already read them.
 *
 * Gated exactly like `window.__cyto_read` — dev server or the e2e preview build
 * (`VITE_ENABLE_TEST_SEAMS=1`), absent from a release bundle, so a shipped app can never be talked
 * into growing this map by a page-set global.
 */
let recording =
  (import.meta.env.DEV || import.meta.env.VITE_ENABLE_TEST_SEAMS) &&
  typeof window !== 'undefined' &&
  (window as unknown as { __cyto_count_decodes?: unknown }).__cyto_count_decodes === true

const counts = new Map<DecodeKey, number>()

/** Start recording, from a clean slate. Returns the stop function for symmetry with a fixture. */
export function enableDecodeCounter(): () => void {
  recording = true
  counts.clear()
  return () => {
    recording = false
    counts.clear()
  }
}

/** Drop every recorded count, leaving recording as it is. */
export function resetDecodeCounts(): void {
  counts.clear()
}

/** A snapshot of the counts so far, as a plain object (structured-clone safe for an e2e seam). */
export function decodeCounts(): Record<DecodeKey, number> {
  return Object.fromEntries(counts)
}

/** Decodes recorded for one member, or 0. */
export function decodeCountFor(artifactId: string, path: string): number {
  return counts.get(`${artifactId}|${path}`) ?? 0
}

/**
 * Record one decode of `path` within `artifactId`.
 *
 * Called from the chunk-decode path. `artifactId` is unknown to the zarr layer (it addresses a
 * store, not an artifact), so callers that have it pass it; the store-only path passes `''` and the
 * key degrades to `|<path>`, which is still enough to see a member decoded twice.
 */
export function countDecode(artifactId: string, path: string): void {
  if (!recording) return
  const key = `${artifactId}|${path}`
  counts.set(key, (counts.get(key) ?? 0) + 1)
}
