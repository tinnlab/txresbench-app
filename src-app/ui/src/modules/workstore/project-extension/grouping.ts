// The Artifacts pane's two pure decisions — WHERE a listed row belongs, and WHAT a set
// of rows of one datatype SAYS. React-free, so both are directly testable.
//
// ── WHERE: the SCOPE decides, and it is one rule with no branches ───────────────
//
// A project's catalog read (`list_for_project_scope`) returns two populations in one
// list: the rows scoped to the project itself, and the rows scoped to each dataset
// attached to it (`WHERE project_id = $1 OR dataset_id IN (…)`). Those are the two
// things a reader is looking at — what came IN with a dataset, and what this project
// PRODUCED — so they are the grouping.
//
// `artifacts.project_id` and `artifacts.dataset_id` are BOTH nullable and there is NO
// CHECK constraint pairing them. "Exactly one is set" is a convention the writing code
// maintains, not something the schema enforces, so a row with BOTH or with NEITHER is
// storable today and this pane may not crash on one or quietly lose it. The rule is
// therefore stated once and positively — THE DATASET SCOPE DECIDES — and both
// degenerate rows fall out of it with no special case:
//
//   dataset_id set (with or without project_id)  → that dataset's group
//   dataset_id absent (with or without project_id) → the UNASSIGNED group
//
// so nothing can be dropped: every row matches exactly one arm. `grouping.test.ts`
// pins both, plus the "no row is ever dropped" invariant over a mixed input.
//
// ITEM-48 renamed the second arm. It is NOT "what this project produced" — that was a
// provenance claim the scope column does not support (see `UNASSIGNED_SCOPE_LABEL`); it
// is the rows whose subject dataset could not be derived.
//
// ── Why SCOPE and not PROVENANCE ───────────────────────────────────────────────
//
// The artifact-ref pickers group their candidates by `source_dataset_id` — the derived
// LINEAGE — so an analysis output made from a dataset is offered under that dataset.
// That is right for a picker (you are choosing an input by where the data came from)
// and wrong here: this pane answers "what is in this project, and where does it live",
// and a run's output does not live under the dataset it read. The two surfaces group by
// two different keys because they answer two different questions; sharing one function
// between them would only make that difference harder to see.
//
// Lineage is not discarded — it is what NAMES a group: `source_dataset_of` returns an
// artifact's OWN `dataset_id` first ("the artifact's own dataset scope wins"), so for a
// dataset-scoped row the derived `source_dataset_name` IS its scope's name and this
// pane needs no second read to head the group with.
//
// ── WHAT: the phrase comes from the owning PACKAGE, through the existing seam ───
//
// A per-datatype summary already exists and is already contributed as data:
// `packages/*/dataset-preview.yaml` → `datasetPreviewRegistry.phraseFor(group,
// lattice, title)`. Its contribution shape is "one group of artifacts of ONE datatype →
// a phrase", which is exactly what a type section here needs, so this module builds the
// group the registry expects and calls `describePart`. It declares NO second file, NO
// second registry and NO wording of its own — a parallel declaration would be two
// sources of truth for one sentence, and drift between them is the failure that seam
// exists to prevent.
//
// The one thing generalised on the way: `DatasetPreviewContribution.order` was
// documented as a position in the dataset's one-line summary. It is now documented as a
// position when several phrases are shown together — a line there, a stack of sections
// here. The declaration format is untouched and no shipped file changes.

import type { DatasetArtifactGroup, ListedArtifact } from '@/api-client/types'
import { representativeOf, sourceDatasetLabel } from '@/core/workstore'
import { describePart, type SummaryDeps } from '@/modules/dataset/project-extension/preview'

/**
 * What the rows that are NOT stored under a dataset are called (ITEM-48).
 *
 * ## Why this pane's words FORKED from the pickers' — the bucket split in two
 *
 * This used to be `export const PROJECT_SCOPE_LABEL = PROJECT_PRODUCED_LABEL`, sharing
 * "Produced in this project" with the two artifact pickers so a user met one sentence
 * for one fact. That unification was correct **while both buckets meant the same thing**,
 * and it stopped being correct without anything in the code changing:
 *
 *   · a picker groups by LINEAGE (`source_dataset_id`). Empty means "no dataset fed
 *     this", and "a run in this project made it" is then a true and useful sentence.
 *   · this pane groups by SCOPE (`dataset_id`). Under DEC-C/ITEM-47 an empty scope means
 *     the row's subject dataset **could not be derived** — it is UNASSIGNED. Telling that
 *     reader "produced in this project" asserts a provenance nobody established, and
 *     dresses an absence up as a category.
 *
 * That is `BASE.md`'s bucket rule arriving at a LABEL instead of at an error: *name the
 * action a reader should take on seeing it; if two members call for different actions, it
 * is two buckets.* Here they call for different READINGS, which is the same test. So the
 * words fork and `PROJECT_PRODUCED_LABEL` is left exactly as it is for the pickers —
 * unifying was never the mistake; unifying two things that had drifted apart was.
 *
 * The sentence states the absence and claims nothing else. It must not name the project
 * (that is the claim being withdrawn) and must not read as a type of artifact.
 */
export const UNASSIGNED_SCOPE_LABEL = 'No dataset recorded'

/**
 * Why the unassigned rows still get a heading at all.
 *
 * ITEM-47 keeps `dataset_id` NULLABLE precisely so an underivable association is never
 * invented, and those rows have to be somewhere — a row with no defined home is a row
 * that vanishes. What ITEM-48 removes is the bucket reading as a TAXONOMY, not the bucket.
 */
export const UNASSIGNED_SCOPE_KEY = 'unassigned'

/** One scope's worth of the catalog. */
export interface ArtifactScopeGroup {
  /** The dataset these rows are STORED UNDER; `null` for the unassigned bucket. */
  datasetId: string | null
  /** A stable key for React + `data-testid` — the dataset id, or {@link UNASSIGNED_SCOPE_KEY}. */
  key: string
  /** The heading: the dataset's name, its id when no name travelled, or {@link UNASSIGNED_SCOPE_LABEL}. */
  label: string
  artifacts: ListedArtifact[]
}

/**
 * The heading for a dataset group, given the rows in it.
 *
 * The name is read off whichever row carries one (they all carry the same one — the
 * server derives it from the row's own `dataset_id`), and falls back to the ID rather
 * than to blank: what is known beats nothing, and a heading is the only thing telling
 * two groups apart. The name-then-id rule itself is `sourceDatasetLabel`, shared with
 * both artifact pickers; only WHICH row supplies the name is this pane's business.
 */
function datasetLabel(datasetId: string, artifacts: readonly ListedArtifact[]): string {
  return sourceDatasetLabel(datasetId, artifacts.find(a => a.source_dataset_name)?.source_dataset_name)
}

/**
 * Partition a project's catalog into its scope groups, in FIRST-APPEARANCE order.
 *
 * Deliberately not re-sorted: the endpoint already ordered the rows (`created_at DESC`),
 * so the group a reader meets first is the one holding the most recent artifact. Sorting
 * here — alphabetically, or datasets-before-unassigned — would override a decision made
 * with more context than this function has, which is the same reason `groupCandidates`
 * leaves its order alone.
 */
export function groupArtifactsByScope(
  artifacts: readonly ListedArtifact[],
): ArtifactScopeGroup[] {
  const groups: ArtifactScopeGroup[] = []
  // Keyed on the nullable id itself, so a dataset whose id happened to spell the
  // unassigned bucket's DOM key could not collide with it.
  const byScope = new Map<string | null, ArtifactScopeGroup>()
  for (const a of artifacts) {
    const datasetId = a.dataset_id ?? null
    let group = byScope.get(datasetId)
    if (!group) {
      group = {
        datasetId,
        key: datasetId ?? UNASSIGNED_SCOPE_KEY,
        label: UNASSIGNED_SCOPE_LABEL,
        artifacts: [],
      }
      byScope.set(datasetId, group)
      groups.push(group)
    }
    group.artifacts.push(a)
  }
  // Labels last: a dataset's name is read off the group's members, and the first one
  // seen may be the one row whose name failed to resolve.
  for (const g of groups) {
    if (g.datasetId !== null) g.label = datasetLabel(g.datasetId, g.artifacts)
  }
  return groups
}

/**
 * The `DatasetArtifactGroup` a set of same-datatype rows amounts to — the CLIENT-SIDE
 * restatement of the grouping the artifact-summary endpoint does in SQL, so a
 * contribution written for that endpoint's groups renders identically here.
 *
 * The representative is chosen by {@link representativeOf} — the endpoint's
 * `ARRAY_AGG(… ORDER BY …)[1]` rule, restated rather than re-decided.
 *
 * One population difference is deliberate and stated: the endpoint counts only the
 * `usable_artifacts` population (`status='ready' AND NOT hidden AND role='artifact'` — ONE
 * definition, a database view, which BOTH server totals read), while this pane lists the
 * whole catalog it was given (hidden rows are already dropped server-side, but pending,
 * failed and intermediate ones are not). The pane's job is to show what is there, so its counts
 * are over what it shows. A contribution reads only the count and the two producer
 * declarations, so it stays well-formed either way.
 *
 * That difference used to be documented HERE and nowhere the user could see it, so the
 * same datatype reported two numbers on two surfaces with nothing on screen accounting
 * for the gap. {@link describeReadiness} is now what accounts for it, in the pane, from
 * the same rows.
 */
export function typeGroupOf(artifacts: readonly ListedArtifact[]): DatasetArtifactGroup {
  const representative = representativeOf(artifacts)
  return {
    datatype: representative.datatype,
    count: artifacts.length,
    // LOGICAL, mirroring the server aggregate. An artifact whose logical size is
    // UNKNOWN contributes nothing rather than a fabricated 0 — the same arithmetic
    // SQL `sum` does one level down, so this mirror and the server cannot disagree.
    // Reading `stored_bytes` here would count a gathered artifact as empty.
    logical_bytes: artifacts.reduce((n, a) => n + (a.logical_bytes ?? 0), 0),
    representative_output_id: representative.output_id,
    representative_meta: representative.meta,
    representative_structure: representative.structure,
  }
}

/**
 * WHY this pane's number and the dataset summary's number differ, said out loud.
 *
 * The two surfaces count different populations, and both are right to: the dataset
 * summary describes what is USABLE (`status='ready' AND NOT hidden AND role='artifact'`,
 * `dataset/repository.rs`), and this pane shows what is THERE. The defect was never
 * either number — it was that the same datatype reported two of them with nothing on
 * screen accounting for the gap, so a reader could only conclude one surface was broken.
 *
 * So the pane states its own composition wherever it is not uniform. When every row IS
 * usable the two numbers are provably equal and `text` is null — nothing is drawn, and
 * the qualifier's PRESENCE is therefore exactly the signal "these will not match".
 */
export interface ReadinessBreakdown {
  /** How many of these rows the dataset artifact-summary endpoint would count. */
  usable: number
  /** How many rows this pane lists. */
  total: number
  /** `3 ready · 1 failed`, or null when every row is usable (nothing to explain). */
  text: string | null
  /** The one-sentence account of the gap, for the qualifier's hover. Null with `text`. */
  detail: string | null
}

/** One datatype's section of a scope group. */
export interface TypeSection {
  datatype: string
  /** The datatype's DECLARED display title — never the raw id, unless nothing declares one. */
  title: string
  /** The owning package's phrase, or the app's count-and-title fallback. */
  summary: string
  /** True when a package's declaration supplied `summary`. */
  contributed: boolean
  /** What `summary`'s count is MADE OF, when it is not all usable rows. */
  readiness: ReadinessBreakdown
  artifacts: ListedArtifact[]
}

/**
 * The bucket one row belongs to.
 *
 * `role` is checked FIRST and deliberately: an intermediate is excluded from the summary
 * because of what it IS, not what state it reached, so a ready intermediate and a failed
 * intermediate are both "intermediate" rather than one of each. Every row lands in exactly
 * one bucket — an unrecognised `status` becomes its own bucket named by that raw word
 * rather than being dropped or silently counted as ready.
 */
function readinessBucket(a: ListedArtifact): string {
  return a.role === 'artifact' ? a.status : a.role
}

/** Buckets in the order a reader should meet them: what is usable first, then why the
 *  rest are not. An unrecognised bucket sorts after these, alphabetically (below).
 *
 *  `unresolvable` (ITEM-41) sits next to `failed` because both mean "not readable", and
 *  BEFORE `intermediate` because both are conditions a user may need to act on while
 *  `intermediate` is a permanent property of the row. It is a SEPARATE bucket from
 *  `failed` on purpose: the two need opposite remedies (see `./artifactStatus`), so
 *  counting them together would produce a breakdown that cannot be acted on.
 *
 *  Ordering here is a ranking, not a filter — `readinessBucket` already gives an
 *  unrecognised status its own bucket named by the raw word, so a value missing from this
 *  list is ranked last rather than dropped. The cost of the omission is therefore
 *  presentational, which is exactly why it went unnoticed and why `warnOnUnknownBucket`
 *  below now says so out loud in development. */
const BUCKET_ORDER = ['ready', 'pending', 'failed', 'unresolvable', 'intermediate']

/** Buckets that are legitimately outside {@link BUCKET_ORDER} — `role` values, which are
 *  a different vocabulary from `status` and are not this list's business. */
const NON_STATUS_BUCKETS = new Set(['intermediate'])

/** Already-warned buckets, so a list of 500 unknown rows produces ONE line, not 500. */
const warnedBuckets = new Set<string>()

/**
 * Say so when a bucket is not in {@link BUCKET_ORDER} — LOUDLY, in development.
 *
 * The coordinator's question was whether adding one entry is enough, and it is not: the
 * omission of `unresolvable` was invisible because an unranked bucket still renders, just
 * in the wrong place. So the NEXT status the server grows would be silently mis-ranked
 * the same way. This closes the class rather than the instance.
 *
 * Deliberately a dev-only `console.warn` and not a throw: a client that is merely older
 * than its server must keep working — the row still renders, still counts, and still
 * carries its own name. Being out of date is not a reason to break the pane.
 */
function warnOnUnknownBucket(bucket: string): void {
  if (!import.meta.env.DEV) return
  if (NON_STATUS_BUCKETS.has(bucket) || BUCKET_ORDER.includes(bucket) || warnedBuckets.has(bucket)) return
  warnedBuckets.add(bucket)
  console.warn(
    `[workstore] artifact bucket "${bucket}" is not in BUCKET_ORDER, so it is ranked last. ` +
      'If the server grew a new artifact status, add it to BUCKET_ORDER and to ' +
      "modules/workstore/project-extension/artifactStatus.ts's vocabulary.",
  )
}

/**
 * What a set of rows of one datatype is MADE OF — see {@link ReadinessBreakdown}.
 *
 * `hidden` is not a bucket: those rows are dropped server-side on this pane's own read
 * (`data_api.rs`), so they are not among the rows passed here and cannot account for a
 * gap the reader can see.
 */
export function describeReadiness(artifacts: readonly ListedArtifact[]): ReadinessBreakdown {
  const counts = new Map<string, number>()
  for (const a of artifacts) {
    const bucket = readinessBucket(a)
    warnOnUnknownBucket(bucket)
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1)
  }
  const usable = counts.get('ready') ?? 0
  const total = artifacts.length
  if (usable === total) return { usable, total, text: null, detail: null }

  const rank = (b: string) => {
    const i = BUCKET_ORDER.indexOf(b)
    return i === -1 ? BUCKET_ORDER.length : i
  }
  const text = [...counts.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
    .map(([bucket, n]) => `${n} ${bucket}`)
    .join(' · ')
  return {
    usable,
    total,
    text,
    detail:
      `This list shows everything in the store; summaries count only ready artifacts ` +
      `(${usable} of ${total} here).`,
  }
}

/**
 * The per-datatype sections for one scope group, in the order the contributing packages
 * DECLARED.
 *
 * Ties (and datatypes nobody contributes for, which sort last) fall back to the
 * endpoint's own within-dataset ordering — `cnt DESC, datatype` — so a datatype occupies
 * the same position here as in the dataset summary line built from the same rows.
 */
export function describeTypeSections(
  artifacts: readonly ListedArtifact[],
  deps: SummaryDeps,
): TypeSection[] {
  const byDatatype = new Map<string, ListedArtifact[]>()
  for (const a of artifacts) {
    const rows = byDatatype.get(a.datatype)
    if (rows) rows.push(a)
    else byDatatype.set(a.datatype, [a])
  }
  return [...byDatatype.values()]
    .sort((a, b) => b.length - a.length || a[0].datatype.localeCompare(b[0].datatype))
    .map(rows => ({ rows, part: describePart(typeGroupOf(rows), deps) }))
    // Two UNCONTRIBUTED datatypes both sort at `Infinity`, so this subtracts Infinity from
    // Infinity and yields NaN. That is safe rather than undefined: `SortCompare` specifies
    // a NaN comparator result as +0, and `Array#sort` has been stable since ES2019, so the
    // pair keeps the count-desc order established above. (An explicit equality guard was
    // written first and then removed — it could not change any outcome, and a branch no
    // input can reach is worse than the line it was guarding.)
    .sort((a, b) => a.part.order - b.part.order)
    .map(({ rows, part }) => ({
      datatype: part.datatype,
      title: part.title,
      summary: part.text,
      contributed: part.contributed,
      readiness: describeReadiness(rows),
      artifacts: rows,
    }))
}
