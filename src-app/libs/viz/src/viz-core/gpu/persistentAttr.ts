// persistentAttr.ts — persistent (reused-in-place) typed-array attribute buffers, to cut the
// per-recolor / per-select allocation churn (and the GC stalls it feeds) on the 10M path.
//
// The naive recolor/select path allocates a FRESH typed array each time — a new
// Float32Array[N] (~40 MB at 10M) for the color value or the selected mask — bumps an epoch,
// and lets the old array become garbage. At 10M that's ~40 MB of garbage per interaction on a
// heap already holding ~150 MB of resident buffers, which triggers major-GC pauses (the
// periodic multi-hundred-ms stalls). Instead we keep ONE buffer per attribute and write the
// new contents INTO it in place; deck re-uploads it (a bufferSubData into its existing GPU
// buffer) on the bumped updateTrigger, so only the changed attribute re-uploads, positions
// never move, and no large allocation happens per interaction.
//
// Pure + framework-agnostic (no deck.gl / DOM) → unit-testable in node. The component owns the
// refs that hold the persistent buffers across renders; these functions do the reuse decision
// + the in-place writes.

/**
 * Return a `Float32Array` of exactly `length`, REUSING `existing` when its length already
 * matches (zero allocation — the whole point) — otherwise allocate a new one (first use, or a
 * genuine N change). Callers stash the result back into their ref so the next call reuses it.
 */
export function ensureFloat32(
  existing: Float32Array | null | undefined,
  length: number,
): Float32Array {
  const len = Math.max(0, Math.floor(length))
  if (existing && existing.length === len) return existing
  return new Float32Array(len)
}

/**
 * Write a 0/1 `Uint8` selection mask into a `Float32` buffer in place — deck's instanced
 * `getSelected` attribute is float32, so the mask must be widened, but into the SAME reused
 * buffer (no `new Float32Array(mask)` per selection). Writes `min(dst.length, mask.length)`
 * elements; when `dst` is longer, the tail is left as-is (callers size `dst` to `mask.length`).
 */
export function writeMaskAsFloat(dst: Float32Array, mask: Uint8Array): void {
  const n = Math.min(dst.length, mask.length)
  for (let i = 0; i < n; i++) dst[i] = mask[i]
}

/**
 * Copy a dense value column into a persistent buffer in place (reused allocation). Used so a
 * recolor writes the new column into the SAME buffer instead of holding a fresh 40 MB array;
 * deck then re-uploads the (stable-reference) buffer on the bumped color epoch. Copies
 * `min(dst.length, src.length)` elements.
 */
export function writeColumn(dst: Float32Array, src: Float32Array): void {
  if (src.length === dst.length) {
    dst.set(src)
  } else if (src.length < dst.length) {
    dst.set(src)
  } else {
    dst.set(src.subarray(0, dst.length))
  }
}
