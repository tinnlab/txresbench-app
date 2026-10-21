// The ONE derivation of "what is this artifact called, for a human".
//
// ── Why this is one module and not three copies ─────────────────────────────────────────────
//
// The same question was answered in two places, by two functions, with two different rules:
//
//   · `workbench/extensions/provenance/lineageGraph.ts`   `${datatype || 'artifact'} · ${id8}`
//   · `workbench/extensions/widgets/form/fields/artifactLabel.ts`
//                                                        `datatype · dims · relative-date`
//
// so the SAME artifact read one way as a node in the lineage DAG and another way as an option
// in the picker that consumes it. That is one fact described by two sentences, and which one a
// user read depended on which surface they opened — exactly the drift `sourceDataset.ts` (next
// door) was written to end for the artifact-GROUPING vocabulary. The words live here now, for
// the same reason and in the same place.
//
// A THIRD surface now asks the same question — a workbench `artifact` pane's tab, which since
// `27b19e86` must name its subject rather than print the ref's uuid. It reads this, rather than
// growing a fourth spelling.
//
// ── The rule, and why the id is the LAST segment rather than the first ──────────────────────
//
// The label is a list of segments, most-identifying first, each degrading independently:
//
//     datatype  ·  dimensions  ·  when it was made
//
// and, only when NOTHING else was available to say, the short id. That last clause is
// load-bearing, not defensive: a bare datatype in a picker of six artifacts SHARING that
// datatype renders six identical strings, which is the defect `axisSource.candidateLabel`'s own
// header describes meeting ("a picker of six real, different columns rendered as six identical
// strings"). What is known beats blank — the same argument `sourceDatasetLabel`'s id fallback
// makes.
//
// It also makes the convergence a NO-OP for the lineage DAG, which supplies neither a structure
// nor a timestamp and therefore always lands on `datatype · id8` — byte for byte what it drew
// before. The picker changes only in the one case where it previously said the datatype and
// nothing else (no declared dimensions AND an unparseable `created_at`).
//
// ── What is deliberately NOT here ───────────────────────────────────────────────────────────
//
// `runtime/axisSource.candidateLabel` names an artifact's MEMBER for an axis picker (a producer
// display name, else a single member's name) and falls back to this shape rather than being it.
// That is a different question — "which column is this?" — and its own header argues the split.

import { declaredDimsForDisplay } from './artifactReader'

/** As much of an artifact as naming needs. Structural, so an `ArtifactRow`, an `Artifact`, a
 *  provenance `ArtifactNodeDto` and a test row all satisfy it without a cast. */
export interface ArtifactLabelParts {
  readonly id: string
  readonly datatype?: string | null
  /** The PRODUCER-DECLARED structure (`declaredDimsForDisplay`'s input). Absent ⇒ no dims segment. */
  readonly structure?: unknown
  readonly created_at?: string | null
}

/** What an artifact with no datatype is called. Named rather than blank: a label is read by a
 *  person, and an empty one reads as a rendering bug. */
export const UNTYPED_ARTIFACT_LABEL = 'artifact'

/** The identifying prefix of a generated id — enough to tell two artifacts apart on one screen,
 *  short enough not to read as the machine identity it is. */
export function shortArtifactId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

/** A dimension list (`[5000, 2]`) → `5000×2`; empty → null (the segment degrades out). */
export function formatDims(dims: number[]): string | null {
  return dims.length > 0 ? dims.join('×') : null
}

/** A compact, dependency-free relative time ("just now" / "5m ago" / "3d ago" / "2mo ago" /
 *  "1y ago"). `now` is injectable so tests are deterministic. Returns null when `iso` does not
 *  parse (the segment is then dropped). */
export function formatRelativeTime(iso: string, now: number = Date.now()): string | null {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  const secs = Math.max(0, Math.round((now - t) / 1000))
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  const mos = Math.floor(days / 30)
  if (mos < 12) return `${mos}mo ago`
  return `${Math.floor(mos / 12)}y ago`
}

/**
 * The segments naming one artifact, in order. Exported so a caller that needs to compose them
 * differently (a two-line card, a tooltip) uses the SAME segments rather than re-deriving them.
 */
export function artifactLabelSegments(a: ArtifactLabelParts, now?: number): string[] {
  const parts: string[] = [a.datatype?.trim() || UNTYPED_ARTIFACT_LABEL]
  if (a.structure !== undefined && a.structure !== null) {
    const dims = formatDims(declaredDimsForDisplay(a.id, a.structure))
    if (dims) parts.push(dims)
  }
  if (a.created_at) {
    const rel = formatRelativeTime(a.created_at, now)
    if (rel) parts.push(rel)
  }
  // Nothing distinguished it — so the id does. See the header.
  if (parts.length === 1 && a.id) parts.push(shortArtifactId(a.id))
  return parts
}

/** One artifact's human label — `datatype · dimensions · relative-date`, degrading segment by
 *  segment, with the short id as the last resort. `now` is injectable for deterministic tests. */
export function artifactLabel(a: ArtifactLabelParts, now?: number): string {
  return artifactLabelSegments(a, now).join(' · ')
}
