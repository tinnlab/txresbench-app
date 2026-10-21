// frameDepth (incremental-landing ITEM-4) — the INDEX-PARALLEL gate for the compute kernels.
//
// ── WHY THIS EXISTS (INV-10) ────────────────────────────────────────────────────────────────
//
// The design's INV-10 (`canvasFeed.ts:146`, renegotiated) says a landing may be INCREMENTAL, but
// no consumer may ever let global row `i` mean two different rows across the buffers it holds —
// so *every frame a kernel or the keep-mask observes is INDEX-PARALLEL*. While landing was atomic
// that held for free: `store.setData` replaced `$data` wholesale, so every column of a frame had
// the same depth by construction. Incremental landing ends that guarantee, and the OLD
// `columnLength`'s `Math.max(v.length)` (`primitives.ts:260`) — and `or_masks`/`keep_and`'s
// "pad to the longest mask" — would size a mask to the DEEPEST column and silently mis-align every
// shorter one: a full-length, plausible, wrong result with a clean console, the exact failure
// class this change exists to stop.
//
// So the kernels stop computing over a mixed-depth frame and REFUSE it (a thrown, named error).
// The refusal is a guardrail, not a normal path: `store`'s recompute always runs over the
// ACCUMULATED, index-parallel frame (DEC-3), so it never fires there — it fires only when a bug
// (or a test) hands a kernel columns of differing depth. An EQUAL-depth frame computes unchanged
// (the positive control).
//
// Depth is measured over columns that have a BODY (`columnCoerce.isColumn`, so a TypedArray counts
// — that is the other half of ITEM-4). A declared-but-absent column (no body) is not present and
// is excluded, so the ITEM-34 "declared column with no body still offers its levels" affordance is
// untouched.

/** The `name` of the thrown refusal, so a catcher (or a test) can recognise it without matching prose. */
export const FRAME_DEPTH_MISMATCH = 'FrameDepthMismatch'

/** A frame handed to a kernel whose PRESENT columns landed to different depths — refused, not
 *  computed over (INV-10). Carries the observed depths for a debuggable message. */
export class FrameDepthMismatchError extends Error {
  constructor(where: string, depths: readonly number[]) {
    super(
      `${where}: refused a mixed-depth frame — its present columns landed to different depths ` +
        `[${depths.join(', ')}]. A kernel must only ever observe an INDEX-PARALLEL frame ` +
        `(INV-10); computing over this would silently mis-align rows.`,
    )
    this.name = FRAME_DEPTH_MISMATCH
  }
}

/**
 * Assert two or more arrays that are supposed to be index-parallel (a kernel's paired operands —
 * `filter_mask`'s values+group_of, `count_by`'s group+hidden, a set of masks for
 * `or_masks`/`keep_and`) are all the same length, else THROW. This is the parallel-array form of
 * `frameDepth`: those kernels take arrays, not a `{column: values}` frame, but the invariant is the
 * same — a differing NON-EMPTY length means two buffers at different depths, and combining them
 * mis-aligns.
 *
 * ── WHY EMPTY OPERANDS ARE SKIPPED ────────────────────────────────────────────────────────────
 *
 * A length-0 operand is ABSENT, not a mixed-depth PARTIAL: `count_by` with an empty `hidden` is the
 * unfiltered default (nothing hidden ⇒ every row counted `after`), `filter_mask` with an empty
 * `group_of` keeps every row, and an empty mask among `or_masks`/`keep_and` contributes nothing.
 * These are legitimate "not provided" states that every shipped view-spec relies on (the
 * `compare.yaml` `count_by` derived lands `group` before any `hidden` mask exists). The mis-address
 * INV-10 forbids is between two buffers that BOTH carry rows at DIFFERENT depths — a partial
 * landing — so only NON-EMPTY operands are compared; an absent one defaults as it always did.
 */
export function assertIndexParallel(where: string, arrays: ReadonlyArray<{ length: number }>): void {
  let depth: number | undefined
  for (const a of arrays) {
    const len = a.length
    if (len === 0) continue // absent operand — the legitimate default, not a mixed-depth partial
    if (depth === undefined) depth = len
    else if (depth !== len) throw new FrameDepthMismatchError(where, arrays.map(x => x.length))
  }
}
