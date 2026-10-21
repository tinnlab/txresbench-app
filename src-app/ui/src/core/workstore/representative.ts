// WHICH member of a same-datatype group supplies the group's producer declarations.
//
// ── What a representative is for ─────────────────────────────────────────────────
//
// A group of same-datatype artifacts ships ONE member's `meta` + `structure` for a
// preview contribution to read. What makes a member a good one is therefore its
// DECLARATION — so that is what the rule is about, and nothing else is.
//
// ── What it used to be ───────────────────────────────────────────────────────────
//
// `size_bytes DESC, id` — in SQL (`dataset::repository::artifact_summary_rows`) and
// restated twice in TS. The magnitude of a byte count decided whose declaration
// shipped, which is incidental; the server model's own comment named it *"a size rule,
// not a semantic one"*. Worse, every tie fell through to `id`, which is
// `gen_random_uuid()`: two ingests of the SAME data, at the same sizes, picked
// different representatives at random.
//
// ── The rule now ─────────────────────────────────────────────────────────────────
//
// Best-declared, then most recent, then a total order. Restated here rather than
// re-decided: `dataset::models::DatasetArtifactGroup` is where it is defined, and the
// SQL `ORDER BY` and these two functions must stay the same rule. A client-side group
// that answered differently from the endpoint's would put two representatives on screen
// for one set of rows.

import type { DatasetArtifactGroup, ListedArtifact } from '@/api-client/types'

/**
 * Does this producer declaration SAY anything?
 *
 * Faithful to the server's `<> '{}'::jsonb`: the columns are `NOT NULL jsonb`, so the
 * only value that declares nothing is the empty object. Anything else — including a
 * JSON `null` or an array — is a statement the producer made, and outranks silence.
 */
export function declaresSomething(declaration: unknown): boolean {
  const isEmptyObject =
    typeof declaration === 'object' &&
    declaration !== null &&
    !Array.isArray(declaration) &&
    Object.keys(declaration).length === 0
  return !isEmptyObject
}

/** `true` before `false`, matching SQL's `boolean DESC`. */
function declaredFirst(a: boolean, b: boolean): number {
  return Number(b) - Number(a)
}

/**
 * The member of `artifacts` whose declarations represent the group.
 *
 * The SQL restated: `ORDER BY structure <> '{}' DESC, meta <> '{}' DESC,
 * created_at DESC, output_id, id`. `structure` outranks `meta` because it is the half a
 * preview usually needs (a producer states dimensions there); recency settles members
 * that declare equally well; `output_id` then `id` make the rule name exactly one row,
 * so identical data always yields the identical representative.
 *
 * Callers pass a non-empty group — a group with no members is not a group. Returning
 * `undefined` for the empty case would push a null check into every caller for a state
 * none of them can produce.
 */
export function representativeOf(artifacts: readonly ListedArtifact[]): ListedArtifact {
  return [...artifacts].sort(
    (a, b) =>
      declaredFirst(declaresSomething(a.structure), declaresSomething(b.structure)) ||
      declaredFirst(declaresSomething(a.meta), declaresSomething(b.meta)) ||
      b.created_at.localeCompare(a.created_at) ||
      a.output_id.localeCompare(b.output_id) ||
      a.id.localeCompare(b.id),
  )[0]
}

/**
 * Merging two already-summarised groups of the SAME datatype across datasets: whose
 * representative declaration survives into the project-wide rollup.
 *
 * The same rule one level up, with the one substitution the type forces: a group carries
 * no `created_at`, so RECENCY is unavailable and the count stands in for it — the group
 * contributing more artifacts is the more representative statement about the datatype.
 * `representative_output_id` is the total order, in place of the row id.
 *
 * It is emphatically NOT `size_bytes`, for the reason in this file's header: which of two
 * datasets holds more bytes says nothing about which describes the datatype.
 */
export function preferredGroup(
  a: DatasetArtifactGroup,
  b: DatasetArtifactGroup,
): DatasetArtifactGroup {
  const order =
    declaredFirst(
      declaresSomething(a.representative_structure),
      declaresSomething(b.representative_structure),
    ) ||
    declaredFirst(
      declaresSomething(a.representative_meta),
      declaresSomething(b.representative_meta),
    ) ||
    b.count - a.count ||
    a.representative_output_id.localeCompare(b.representative_output_id)
  return order <= 0 ? a : b
}
