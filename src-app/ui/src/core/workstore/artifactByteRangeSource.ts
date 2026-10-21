// artifactByteRangeSource.ts — the storage half of the client OME-TIFF pyramid reader (#158).
//
// `@ziee/viz`'s `loadOmeTiffPyramid` opens a pyramidal OME-TIFF over byte ranges and knows
// NOTHING about where the bytes live: its whole seam to storage is a `ByteRangeSource` — a
// byte length and `read(start, endInclusive)`. This module is the one implementation of that
// seam over the artifact byte plane, and it is deliberately the thinnest thing that can be.
//
// ── IT BUILDS NO URL, SETS NO HEADER, AND CALLS NO `fetch` ───────────────────────────────
// `fetchArtifactRange` already does all three, through the generated client, and therefore
// already carries the bearer token, the silent 401-refresh-and-retry, the retryable-GET
// backoff and the typed `WorkstoreHttpError` mapping. Re-implementing any of that here would
// also be refused outright: this directory is scanned for hand-rolled transport.
//
// ── ONE OBJECT, NOT ONE MEMBER, AND THAT IS A REFUSAL RATHER THAN AN OMISSION ────────────
// An earlier cut took an optional `memberPath` while clamping against the ARTIFACT's
// `stored_bytes`. For a multi-member artifact that number is the SUM over all members, so the
// clamp would be too large for the member and the last read would reach past the member's end
// — which is exactly the 416 this module exists to prevent, arriving by the one route nothing
// would check. There is no members API and no per-member size on the wire, so the safe length
// cannot be obtained; and the kind this reads is declared `file_layout: single`, so a member
// path is not needed either. Adding one back requires a member-scoped length, not a
// member-scoped path.
//
// ── WHY `byteLength` IS A PARAMETER AND NOT SOMETHING WE DISCOVER ────────────────────────
// The `?range=` dialect refuses `a-b` when `b` names a byte the object does not have — a
// **416**, not a clamp (only the `Range:` HEADER form clamps). A block-aligned reader asks
// past the end of the file on the LAST block of every object, and for a pyramid that block
// is where the level directories live. So the length is not a nicety, it is what makes the
// last read answerable — and it is already on the wire as the artifact's `stored_bytes`,
// exact for a single-file artifact. Discovering it instead would cost an extra round trip to
// read a header the transport does not even surface.

import { fetchArtifactRange } from './binaryClient'

/**
 * A byte length plus an inclusive-span read.
 *
 * Declared here rather than imported so this module compiles against the SHAPE the reader
 * needs and not against a specific version of it; it is structurally identical to
 * `@ziee/viz`'s `ByteRangeSource` and is checked against it where the two meet.
 */
export interface ArtifactByteRangeSource {
  readonly byteLength: number
  /**
   * The bytes `[start, endInclusive]`. `signal` is geotiff's, forwarded from
   * `getTile({ signal })` — which is how deck.gl abandons a tile the user panned away from,
   * so forwarding it is what stops an abandoned viewport's reads competing with the live one.
   */
  read(start: number, endInclusive: number, signal?: AbortSignal): Promise<ArrayBuffer>
}

/** Raised when a caller asks for a source over an object whose size it does not know. */
export class UnknownArtifactLengthError extends Error {
  constructor(artifactId: string) {
    super(
      `cannot range-read artifact ${artifactId}: its byte length is unknown. Pass the value ` +
        "of the artifact row's `stored_bytes` — a ranged read whose end is not clamped " +
        'against the real length is answered 416, not truncated.',
    )
    this.name = 'UnknownArtifactLengthError'
  }
}

/**
 * A `ByteRangeSource` over one artifact (optionally one member of it).
 *
 * `byteLength` comes from the artifact row (`stored_bytes`), which is exact for a
 * single-file artifact. Every read is clamped into `[0, byteLength - 1]` before it is spelled
 * as a `?range=` span, so this source can never emit the request the byte plane answers 416 —
 * the reader above it may, and does, ask past the end.
 */
export function artifactByteRangeSource(
  artifactId: string,
  byteLength: number,
): ArtifactByteRangeSource {
  if (!Number.isInteger(byteLength) || byteLength <= 0) {
    throw new UnknownArtifactLengthError(artifactId)
  }
  return {
    byteLength,
    async read(start: number, endInclusive: number, signal?: AbortSignal): Promise<ArrayBuffer> {
      // A bad START is REFUSED, never repaired. Clamping it up to 0 would silently SHIFT the
      // read — and the reader above records the response under the offset it ASKED for, so a
      // shifted span is sliced into the wrong place and decodes as plausible garbage. Only the
      // END is clamped, and only downwards, because the reader legitimately asks past the end
      // of the file and the byte plane answers that with a 416 rather than a truncation.
      if (!Number.isInteger(start) || start < 0 || start >= byteLength) {
        throw new RangeError(
          `refusing a byte span starting at ${start} of artifact ${artifactId} ` +
            `(${byteLength} bytes): a start must be a whole byte inside the object. Clamping ` +
            'it would shift every byte that came back.',
        )
      }
      if (!Number.isFinite(endInclusive)) {
        throw new RangeError(
          `refusing a byte span ending at ${endInclusive} of artifact ${artifactId}: an ` +
            'inclusive end must be a number.',
        )
      }
      const end = Math.min(byteLength - 1, Math.trunc(endInclusive))
      if (end < start) {
        // An empty span is never sent. `?range=` with no value is a 400, and OMITTING the
        // parameter is a request for the WHOLE object — the silent whole-file read this entire
        // item exists to avoid. Refusing is the only answer that cannot degrade into it.
        throw new RangeError(
          `refusing an empty byte span ${start}-${endInclusive} of artifact ${artifactId} ` +
            `(${byteLength} bytes): a range read must name at least one byte.`,
        )
      }
      // The transport has no cancellation to offer: `fetchArtifactRange` takes no signal, and
      // widening it would mean changing the shared byte client for this one caller — which is
      // the shared-infrastructure edit that is exactly not this item's to make. What CAN be
      // done here is refuse to START a read for a tile the viewport has already abandoned,
      // which is the common case (deck.gl aborts on every pan) and costs nothing. The seam
      // above carries the signal so an implementation that CAN cancel needs no contract change.
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new DOMException('the read was aborted before it began', 'AbortError')
      }
      return await fetchArtifactRange(artifactId, undefined, { start, end })
    },
  }
}
