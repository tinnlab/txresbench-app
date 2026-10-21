// Turning a dataset's artifact summary into the line the attach picker shows.
//
// PURE and DOM-free, so it is directly testable. Everything a reader actually reads
// arrives through an injected dependency: the datatype's display title comes from the
// datatype registry (declared by the package that declares the type), and the phrases
// come from the preview contribution registry. Nothing here knows what any datatype
// is, and nothing here composes a sentence of its own.
//
// ── What the app contributes to the line, and it is very little ─────────────────
//
// Sorting, joining, and one honest fallback. It used to contribute a great deal more
// — an artifact COUNT and a byte SIZE, in front of everything a package had to say —
// and both were wrong for the reader: "artifact" is this app's storage vocabulary,
// and nobody picks a dataset by megabytes. Neither is in the line now.
//
//   before:  65 artifacts · 41.5 MB · 1 <declared title> (<contributed facts>) · …
//   after:   <package A's phrase> · <package B's phrase> · <package C's phrase>
//
// The size did not become secret — it moved to the row's hover, where a reader who
// wants it can find it and a reader choosing a dataset never has to step over it.

import type { DatasetArtifactGroup, DatasetArtifactSummary } from '@/api-client/types'
import { preferredGroup } from '@/core/workstore'
import { formatBytes } from '@/modules/datasets/lib/format'
import type { DatasetPreviewRegistry } from './registry'
import type { PreviewLattice } from './types'

export interface SummaryDeps {
  /** Proper supertypes, nearest first — `datatypeRegistry.ancestors`. */
  lattice: PreviewLattice
  /** Display title for a datatype id. MUST fall back to the id, never to a guess. */
  title: (datatype: string) => string
  registry: DatasetPreviewRegistry
}

/** One group's contribution to the line. */
export interface PartDisplay {
  datatype: string
  /**
   * The group's datatype's DECLARED display title, as resolved by `deps.title` — the
   * same string handed to the contribution's `{title}` and the same one the fallback is
   * built from.
   *
   * Carried out rather than left for the caller to re-resolve, for the reason
   * {@link describePart} resolves it once: a surface that renders the title BESIDE the
   * phrase (the artifacts pane heads each type section with it) would otherwise call
   * `deps.title` a second time, and two reads of an injected resolver is exactly how
   * the heading and the sentence under it drift apart.
   */
  title: string
  /** What this group says — a contributed phrase, or the app's fallback. */
  text: string
  /** True when a contribution supplied `text`. */
  contributed: boolean
  /** Where it sorts. `Infinity` for a datatype nobody contributes for. */
  order: number
}

export interface SummaryDisplay {
  parts: PartDisplay[]
  /** The one-line row text. */
  line: string
  /** The fuller form — for the row's hover + accessible text. */
  detail: string
}

/**
 * The part of a `DatasetArtifactSummary` the composer actually reads.
 *
 * Named so a PROJECT-level rollup — several datasets' groups merged into one set —
 * can be composed by exactly this function rather than by a second one. A rollup has
 * no single `dataset_id`, and requiring one would have forced either a fake id or a
 * parallel composer; a parallel composer is how the project summary ended up with a
 * hardcoded phrase of its own in the first place.
 */
export type HoldingsTotals = Pick<
  DatasetArtifactSummary,
  'groups' | 'artifact_count' | 'total_logical_bytes'
>

/**
 * Several datasets' holdings as ONE set of groups, for a project-level line.
 *
 * Merged per datatype: counts and bytes SUM, and the declarations travel with the
 * contributor {@link preferredGroup} selects — the BEST-DECLARED group, then the
 * larger contributor, then `representative_output_id` as a total order.
 *
 * That rule is not invented here: it is the rule the server applies WITHIN a dataset,
 * carried one level up so a reader meets one contract rather than two. It used to be
 * "the contributor holding more BYTES", mirroring a server rule that was itself keyed
 * on `size_bytes` and documented as *"a size rule, not a semantic one"*. Both were
 * changed together — which of two datasets holds more bytes says nothing about which
 * describes the datatype, and the byte comparison silently preferred a group whose
 * declaration was empty over one a contribution could actually read.
 *
 * The result is a function of the input alone and not of iteration order: every step of
 * the comparison is a total order, so no tie can fall through to "whichever came first".
 *
 * `artifact_count` sums the datasets' OWN totals, not the visible groups: the wire
 * caps `groups` but counts every artifact, and summing the groups instead would drop
 * the tail that {@link remainderText} exists to report.
 *
 * `null` in the empty case ⇒ the caller renders NO line, which is different from a
 * project that holds nothing and must stay different.
 */
export function rollupHoldings(summaries: readonly HoldingsTotals[]): HoldingsTotals | null {
  if (summaries.length === 0) return null
  const byDatatype = new Map<string, DatasetArtifactGroup>()
  for (const s of summaries) {
    for (const g of s.groups) {
      const prev = byDatatype.get(g.datatype)
      if (!prev) {
        byDatatype.set(g.datatype, { ...g })
        continue
      }
      // Whose declaration survives the merge — `preferredGroup`, the same rule the
      // server applies one level down, NOT whichever group happens to hold more bytes.
      const representative = preferredGroup(prev, g)
      byDatatype.set(g.datatype, {
        ...representative,
        count: prev.count + g.count,
        logical_bytes: prev.logical_bytes + g.logical_bytes,
      })
    }
  }
  return {
    // Most-numerous first, as the per-dataset read orders its own groups; the
    // datatype id breaks ties so two runs over the same data agree.
    groups: [...byDatatype.values()].sort(
      (a, b) => b.count - a.count || a.datatype.localeCompare(b.datatype),
    ),
    artifact_count: summaries.reduce((n, s) => n + s.artifact_count, 0),
    total_logical_bytes: summaries.reduce((n, s) => n + s.total_logical_bytes, 0),
  }
}

/**
 * What ONE PROJECT holds, selected out of the batched read of everything the user
 * can see. Pure, for the reason `attachOptions.ts` is pure: the two decisions below
 * are the ones a rendered panel makes silently and a reader cannot check.
 *
 *   · SCOPE — the batched read covers every dataset the user can see, not this
 *     project's. Rolling up the whole map would put another project's datasets in
 *     this project's header, and it would look entirely plausible.
 *   · COMPLETENESS — the linked list is PAGED. Summarising the loaded page as if it
 *     were the project states a total nobody counted, so a partial page answers
 *     `null` and the caller prints the count alone, which is still true. This is the
 *     same refusal {@link holdingsFor} makes for an id missing from a landed map.
 *
 * `null` for a read that has not landed, for a partial page, and for a project with
 * no linked datasets — all three render no line rather than a wrong one.
 */
export function projectHoldings(
  byDatasetId: ReadonlyMap<string, HoldingsTotals> | null,
  linkedIds: readonly string[],
  linkedTotal: number,
): HoldingsTotals | null {
  if (!byDatasetId) return null
  if (linkedIds.length < linkedTotal) return null
  const linked: HoldingsTotals[] = []
  for (const id of linkedIds) {
    const s = byDatasetId.get(id)
    // A linked dataset ABSENT from a landed response holds nothing counted (the read
    // is complete when it arrives), so it contributes nothing — not a gap.
    if (s) linked.push(s)
  }
  return rollupHoldings(linked)
}

/**
 * What a group with NO usable contribution says: its count and its datatype's
 * declared title, and nothing else.
 *
 * This is the whole app-generic vocabulary, and it is deliberately made of only two
 * things it is entitled to: a number it computed, and a word the datatype's own
 * package chose. The title is used VERBATIM — inventing a plural for it would be the
 * app editing another package's word, and every rule for doing that is language- and
 * term-specific. A datatype the registry has never heard of shows its raw id, which
 * is at least true.
 */
export function fallbackPartText(group: DatasetArtifactGroup, title: string): string {
  return `${group.count} ${title}`
}

/** What a dataset the read COUNTED AS ZERO reads as.
 *
 *  Not "No artifacts yet": `artifact` is this app's storage noun for a row in its own
 *  table, and it tells a reader nothing about whether there is anything here to work
 *  with. The honest statement is the one the app can actually make — it counted, and
 *  found nothing. */
export const EMPTY_SUMMARY_TEXT = 'Nothing in this dataset yet'

/**
 * What the groups PAST the server's cap add up to, when there are any.
 *
 * The endpoint returns at most `GROUP_CAP` groups but counts every artifact, so a
 * dataset with more datatypes than that would otherwise under-report silently. The
 * app used to carry the total count at the head of the line, which covered this by
 * accident; stating the remainder covers it on purpose, and only when it exists.
 */
export function remainderText(remaining: number): string | null {
  return remaining > 0 ? `+${remaining} more` : null
}

/** One group's display — the contributed phrase if there is one, else the fallback. */
export function describePart(group: DatasetArtifactGroup, deps: SummaryDeps): PartDisplay {
  // Resolved ONCE and used for both: the word a contribution's `{title}` asks for and
  // the word the fallback is built from are the same word, and reading it twice from
  // an injected resolver is how they would drift.
  const title = deps.title(group.datatype)
  const resolved = deps.registry.phraseFor(group, deps.lattice, title)
  return {
    datatype: group.datatype,
    title,
    text: resolved?.text ?? fallbackPartText(group, title),
    contributed: resolved?.text != null,
    // A contribution that DECLINED keeps its declared position, so a dataset whose
    // producer omitted one declaration does not visibly re-order.
    order: resolved?.order ?? Number.POSITIVE_INFINITY,
  }
}

/**
 * The whole summary as display strings.
 *
 * The parts are sorted by the order their contributions DECLARED, ties and
 * uncontributed groups keeping the server's own order (most-numerous first). That is
 * the app's entire say in what the line reads like.
 *
 * `null` in ⇒ `null` out, which the caller renders as NO second line. That is the
 * "not loaded yet" state; a dataset that is loaded and holds nothing is `undefined`
 * from the lookup and gets [`EMPTY_SUMMARY_TEXT`] instead. The two are different
 * sentences and the caller must not merge them.
 */
export function describeSummary(
  summary: HoldingsTotals | null | undefined,
  deps: SummaryDeps,
): SummaryDisplay | null {
  if (!summary) return null
  const parts = summary.groups
    .map((g, index) => ({ ...describePart(g, deps), index }))
    .sort((a, b) => a.order - b.order || a.index - b.index)
  const shown = summary.groups.reduce((n, g) => n + g.count, 0)
  const remainder = remainderText(summary.artifact_count - shown)
  const line = [...parts.map(p => p.text), remainder].filter(Boolean).join(' · ')
  // The hover is where the row's non-headline detail lives, and it is not truncated —
  // so the byte total goes here: available to a reader who wants it, out of the way
  // of the one who is choosing a dataset.
  const detail = [line, formatBytes(summary.total_logical_bytes)].filter(Boolean).join(' · ')
  return { parts: parts.map(({ index: _index, ...p }) => p), line, detail }
}

/**
 * The holdings line for ONE dataset id, given the batched read's result.
 *
 * Three states, and keeping them apart is the whole job:
 *
 *   · `summaries === null` — the read has not landed (or failed) ⇒ `null`, no line.
 *   · the id is MISSING from a landed map — the dataset was past the read's cap, so
 *     nobody counted it ⇒ `null`, no line. Printing the empty sentence here would be
 *     a confident claim about something never looked at, which is exactly why the
 *     server sends a zero row for every dataset it DID count.
 *   · present ⇒ the empty sentence at zero, the full line otherwise.
 */
export function holdingsFor(
  summaries: ReadonlyMap<string, DatasetArtifactSummary> | null,
  datasetId: string,
  deps: SummaryDeps,
): { text: string; detail: string } | null {
  if (!summaries) return null
  const s = summaries.get(datasetId)
  if (!s) return null
  if (s.artifact_count === 0) return { text: EMPTY_SUMMARY_TEXT, detail: EMPTY_SUMMARY_TEXT }
  const d = describeSummary(s, deps)
  return d ? { text: d.line, detail: d.detail } : null
}
