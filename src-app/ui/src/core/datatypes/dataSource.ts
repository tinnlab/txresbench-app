// The client reader-dispatch data plane (ITEM-11) — "given (artifact, selector), pick
// the right request + decode". It DISPATCHES ON THE PRODUCER'S DECLARATION
// (`Artifact.structure`), never on the data domain (DEC-4) and — since artifact-model
// ITEM-25 — no longer on the datatype registry's tier/selector map either.
//
// ── WHAT ITEM-12 CHANGED HERE ──────────────────────────────────────────────────────
//
// This module used to resolve an ACCESS TIER before reading: `readPlan` consulted the
// datatype's declared `tiers` + `selector_map` to choose between a server-side Tier-2
// slice (`GET /read?col=<i>` → Arrow) and a Tier-1 client byte-Range decode, mirroring
// the Rust `layout::resolve_tier` so "server + client never disagree".
//
// There is no longer anything to agree about. `/read` is deleted (INV-1: the server
// serves bytes and never opens one for meaning), so EVERY read is a client decode over
// byte ranges and the tier question has one answer. Keeping `readPlan` would have left a
// negotiation whose only possible outcome was "Tier-1" — dead branching that reads like
// live policy. `fetchColumn` now dispatches on `structure.encoding`, which is the
// producer's own statement about what it wrote.
//
// The tier VOCABULARY itself (`AccessTier`, `selector_map`, `datatype/layout.rs`) is
// registry DATA and is removed by ITEM-14, not here.

import { fetchArtifactRange, type ByteRange, type SparseColumn } from '@/core/workstore'
import {
  describeStructure,
  parseStructure,
  readSparseColumn,
  UnsupportedArtifactStructure,
} from '@/core/workstore/artifactReader'

/** Raised when an artifact's declaration names an encoding this client cannot decode.
 *  Kept as the module's own name (the reader throws
 *  {@link UnsupportedArtifactStructure}, which this extends) so existing `catch` sites
 *  and the `@/core/datatypes` barrel keep their meaning. */
export class UnsupportedClientDecode extends UnsupportedArtifactStructure {
  constructor(artifactId: string, declared: unknown, detail: string) {
    super(artifactId, declared, detail)
    this.name = 'UnsupportedClientDecode'
  }
}

/** The minimum an artifact row needs for reader dispatch (a P1 catalog row).
 *
 *  `structure` is the producer's decode contract and is REQUIRED — the column is
 *  `NOT NULL` with no default (ITEM-5), so a caller that cannot supply it is holding a
 *  partial row, not an artifact without a declaration.
 *
 *  ITEM-7 dropped `storage_layout` from this ref along with the column. It was never a
 *  decode instruction — `fetchColumn` below has always dispatched on the declaration —
 *  so carrying it obliged every caller to thread a second, weaker answer to a question
 *  `structure` already answers exactly. */
export interface ArtifactRef {
  id: string
  datatype: string
  structure: unknown
}

/**
 * Fetch + decode a single sparse (CSC) column of a matrix artifact — the column-read
 * 60fps hot path.
 *
 * Three element ranges over `GET /artifacts/{id}/data/{member}`: probe
 * `indptr[col..col+2]` for the column's non-zero window, then read `indices` + `data`
 * across it (issued together). Previously one `GET /read?col=<i>` that made the SERVER
 * slice the CSC, build an Arrow COO `RecordBatch` and stream it as IPC.
 *
 * Throws `UnsupportedClientDecode` when the artifact's declaration is not a `sparse_csc` —
 * the same failure the tier-based `strategy !== 'slice'` check used to produce, now
 * carrying the actual declaration in its message instead of a layout string. Both Zarr
 * artifacts share `encoding: "zarr_v3"`, so the `kind` is what discriminates: without it a
 * table would reach the trio lookup and fail on a missing member instead of on being the
 * wrong artifact.
 */
export async function fetchColumn(artifact: ArtifactRef, column: number): Promise<SparseColumn> {
  let structure
  try {
    structure = parseStructure(artifact.id, artifact.structure)
  } catch (e) {
    throw new UnsupportedClientDecode(
      artifact.id,
      artifact.structure,
      e instanceof Error ? e.message : String(e),
    )
  }
  if (structure.encoding !== 'zarr_v3' || structure.kind !== 'sparse_csc') {
    throw new UnsupportedClientDecode(
      artifact.id,
      structure,
      `a sparse column read needs a \`zarr_v3\` \`sparse_csc\` artifact, not ${describeStructure(structure)}`,
    )
  }
  return readSparseColumn(artifact.id, column, structure)
}

/**
 * Raw byte-Range read of an artifact (or a named member of a multi-file artifact).
 * Returns the `ArrayBuffer` for an external/client decoder.
 */
export async function fetchRange(
  artifact: ArtifactRef,
  memberPath?: string,
  range?: ByteRange,
): Promise<ArrayBuffer> {
  return fetchArtifactRange(artifact.id, memberPath, range)
}
