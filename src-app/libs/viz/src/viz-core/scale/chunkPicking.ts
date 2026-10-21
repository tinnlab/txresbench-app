// chunkPicking.ts — pure local→global index mapping for ChunkedScatter picking (ITEM-62).
//
// Each chunk is rendered as its OWN ScatterplotLayer, so deck.gl's `info.index` on a hover
// is LOCAL to that one chunk layer (0..chunk.count-1). To resolve it back to a point index
// in the (possibly LOD-reduced) rendered buffer, add the chunk's `start` offset. `planChunks`
// emits chunks with `index === array position` and contiguous, gap-free `start` offsets, so a
// chunk's ordinal (parsed from the `chunk-<n>` layer id) is a direct array index here.
//
// LOD caveat: when the dataset is over-budget, ChunkedScatter chunks the DOWNSAMPLED set, so
// the `chunks` passed here belong to the reduced render plan and `chunk.start` is an index into
// the downsampled buffer. The returned global index is therefore a position within the rendered
// reduced set — which is exactly the point the user hovered in the LOD overview (correct).
//
// No deck.gl / DOM / React dependency: plain integer math, so it unit-tests in node.

import type { Chunk } from './chunking'

/**
 * Resolve a chunk-local point index to its GLOBAL index in the rendered buffer:
 * `chunks[chunkOrdinal].start + localIndex`. Returns -1 when the ordinal is out of range or
 * the local index falls outside `[0, chunk.count)` (a defensive guard — deck should never
 * report an out-of-range local index for a layer, but a stale hover across a re-plan could).
 */
export function globalIndexFor(
  chunks: readonly Chunk[],
  chunkOrdinal: number,
  localIndex: number,
): number {
  const chunk = chunks[chunkOrdinal]
  if (!chunk) return -1
  if (localIndex < 0 || localIndex >= chunk.count) return -1
  return chunk.start + localIndex
}

/**
 * Parse a chunk layer id of the form `chunk-<ordinal>` back to its numeric ordinal. Returns
 * -1 when the id doesn't match (a non-chunk layer). Mirrors the id ChunkedScatter assigns
 * each layer (`chunk-${chunk.index}`).
 *
 * This IS a layer-id parse, the shape that broke grid routing twice (`layers/layerIds.ts`), and it
 * is deliberately left alone. Two reasons, in order: `ChunkedScatter` renders into its OWN deck and
 * never publishes into the shared grid deck, so a composed `<viewId>::<paneId>::` prefix cannot
 * reach these ids at all; and the regex is anchored at BOTH ends, so it would answer -1 rather than
 * a wrong ordinal if one ever did. Nothing to fix — recorded so the next sweep does not re-derive it.
 */
export function chunkOrdinalFromLayerId(id: string | null | undefined): number {
  if (!id) return -1
  const m = /^chunk-(\d+)$/.exec(id)
  return m ? Number(m[1]) : -1
}
