// dataKey.ts — a stable STRUCTURAL restart key for a `<Viz data>` source (STREAMING_PROGRESSIVE_PLAN,
// B-H1). The progressive stream-start effect must fire ONLY on a genuine data change, never on a
// parent re-render that rebuilds an inline `data={{ positions, labels, value }}` object with the SAME
// underlying refs. Keying that effect on raw `data` identity restart-loops (a stream frame →
// `onProgress` → parent setState → new inline object → restart → …). `dataKeyOf` collapses value-equal
// sources to the same string, mirroring the `option` (`stableOptionKey`) / `colorBy` (`colorByKeyOf`)
// guards elsewhere.
//
// Keying rules (the MEANINGFUL parts only):
//   • a URL string           → keyed BY VALUE (two equal URL strings ⇒ same key).
//   • a Float32Array / Uint8Array / ReadableStream / AsyncIterable (a bare source, or a positions/
//     labels/value CHANNEL) → keyed by a stable per-REFERENCE id (a module `WeakMap<object,number>`
//     assigning monotonic ids — the SAME ref always maps to the SAME id, a different ref to a new one).
//   • a `{ url }` wrapper    → keyed by its url value; a `{ stream }` wrapper → by reference.
//   • the object form        → `positions|labels|value|stride|packed|total` composited from the above.
//
// Pure (no deck.gl / DOM / React), so it unit-tests in node. The type-only `VizData` import is erased.

import type { VizData } from '../../adapter/vizData'

// Per-REFERENCE identity: the same object always yields the same id, so a stable ref ⇒ a stable key
// even though a ref is not stringifiable. A `WeakMap` never pins the object alive (GC-safe).
const refIds = new WeakMap<object, number>()
let nextRefId = 1
function refId(o: object): number {
  let id = refIds.get(o)
  if (id === undefined) {
    id = nextRefId++
    refIds.set(o, id)
  }
  return id
}

/** Key one MEANINGFUL part (a positions/labels/value source, or a scalar option). Strings + a `{url}`
 *  wrapper key by VALUE; every other object (typed array / stream / iterable / `{stream}`) by reference. */
function partKey(part: unknown): string {
  if (part == null) return '∅'
  if (typeof part === 'string') return `s:${part}`
  if (typeof part === 'number' || typeof part === 'boolean') return `v:${part}`
  if (typeof part === 'object') {
    const url = (part as { url?: unknown }).url
    if (typeof url === 'string') return `u:${url}`
    return `r:${refId(part as object)}`
  }
  return '?' // symbol / function — not a valid source; single bucket
}

/** True when `data` is the object form (`{ positions, … }`) rather than a bare source. Local copy of
 *  the {@link CpuRasterView} predicate so this module stays deck-free (node-testable). */
function isObjectForm(data: VizData): data is Extract<VizData, { positions: unknown }> {
  return (
    data != null &&
    typeof data === 'object' &&
    !(data instanceof Float32Array) &&
    !(data instanceof Uint8Array) &&
    'positions' in (data as Record<string, unknown>)
  )
}

/**
 * A stable structural key for a `<Viz data>` source. Two calls with value-equal content (same URL
 * string, or the same underlying positions/labels/value REFERENCES) return the SAME string; any
 * genuine change (a new ref, a different URL, a changed stride/packed/total) returns a different one.
 */
export function dataKeyOf(data: VizData): string {
  if (typeof data === 'string') return `url:${data}`
  if (isObjectForm(data)) {
    return [
      'obj',
      partKey(data.positions),
      partKey(data.labels),
      partKey(data.value),
      `stride=${data.stride ?? ''}`,
      `packed=${data.packed ? 1 : 0}`,
      `total=${data.total ?? ''}`,
    ].join('|')
  }
  // A bare Float32Array / ReadableStream / AsyncIterable source → per-reference id.
  return partKey(data)
}
