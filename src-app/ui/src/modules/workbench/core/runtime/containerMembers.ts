// THE DECLARED MEMBER GROUPS OF A MANIFEST CONTAINER (issue #361) — the `container_members`
// data source: what a `{ requires: 'manifest', members: [...] }` datatype DECLARES it is
// delivered as, offered as `{ value, label }` options for a picker.
//
// ── WHY IT EXISTS ────────────────────────────────────────────────────────────────────────
//
// A datatype whose `input_requirements` is a manifest names its members as PATHS, and the
// leading segment of each path is a GROUP the container is delivered in — a member
// `group_008/…` says the container carries a group called `group_008`. A form that must let
// a human choose WHICH group to process has no way to know the groups exist except by
// reading the declaration: the set is a property of the CONTAINER, not of the app, and a
// literal copy in the view would drift the moment the container's declaration changed.
//
// So this source derives the offered groups from the datatype's OWN declaration, through the
// already-populated client-side datatype registry (`core/datatypes`). The declaration is the
// single source of truth; the app carries zero of the domain's vocabulary.
//
// ── WHY IT IS PURE ───────────────────────────────────────────────────────────────────────
//
// The registry lookup is the ONLY IO, and it is a synchronous in-memory read of data the
// client already holds. The pure core (`resolveContainerMembers`) takes the declared
// `InputRequirements` and returns the option list, so the whole derivation is unit-testable
// with no registry, no network and no mounting.
//
// ── WHAT "NOT THERE YET" MEANS ───────────────────────────────────────────────────────────
//
// The registry is populated asynchronously after auth (`core/datatypes/boot.ts`), so a
// slice resolved before the populate lands sees NO datatype and must answer EMPTY — never an
// error. The same is true of a datatype that declares no manifest: absence is the honest
// answer, not a fault.

import type { InputRequirements } from '@/core/datatypes/types'

/** The `data.<slice>.source` value that selects this resolver. */
export const CONTAINER_MEMBERS_SOURCE = 'container_members'

/** One offered group of a manifest container, as a picker option. */
export interface ContainerMemberOption {
  /** The group's single embedded integer when the segment carries exactly one run of
   *  digits, else the segment text itself. */
  value: string | number
  /** The leading path segment, verbatim. */
  label: string
}

/** The `args` a `container_members` slice declares. */
export interface ContainerMembersArgs {
  /** The datatype id whose declared manifest is being offered. */
  datatype?: string
}

/** The single run of digits a segment embeds, when it embeds exactly one. `undefined` for a
 *  segment with no digits or with several runs — both fall back to the segment text. */
function singleDigitRun(segment: string): number | undefined {
  const runs = segment.match(/\d+/g)
  if (!runs || runs.length !== 1) return undefined
  return Number(runs[0])
}

/**
 * Resolve the offered groups of a manifest container's declaration.
 *
 * PURE over the declared `InputRequirements` — no registry, no network, no reads. The
 * caller (the `container_members` slice reader in `viewData.ts`) supplies the declaration
 * it looked up, so this whole derivation is unit-testable with no mounting.
 *
 * The rules, exactly:
 *   · no declaration, or a non-manifest one, or an empty member list → `[]`.
 *   · a member with NO `/` is not a group — it sits at the container's ROOT, not in a
 *     group — so it contributes nothing. Only a member that carries a path contributes.
 *   · each member path contributes its LEADING segment (the text before the first `/`),
 *     and DISTINCT segments are offered once.
 *   · a segment that contains exactly one run of digits offers that integer as its `value`
 *     (e.g. `group_008` → `8`); any other segment offers its own text.
 *   · two segments that map to the SAME value are an ambiguous offer and are NOT both
 *     emitted: the renderer stringifies option values (`String(rec.value)`), so two
 *     options sharing a value are indistinguishable to the widget — a user picking the
 *     second would see the first's label. The FIRST declared segment wins,
 *     deterministically.
 *   · the offer is sorted ascending by numeric `value` when every value is a number,
 *     otherwise lexicographically by `label`.
 */
export function resolveContainerMembers(
  inputRequirements: InputRequirements | null | undefined,
): ContainerMemberOption[] {
  if (
    !inputRequirements ||
    inputRequirements.requires !== 'manifest' ||
    inputRequirements.members.length === 0
  ) {
    return []
  }
  const bySegment = new Map<string, ContainerMemberOption>()
  for (const member of inputRequirements.members) {
    // A member with NO `/` sits at the container's ROOT, not in a group — the leading
    // segment of a PATH is a group, and a member with no path has no leading segment.
    // Treating the whole filename as a group would mint a bogus option out of a member
    // that is not grouped at all (and, when the filename embeds a digit run, a bogus
    // numeric value) — so such a member contributes nothing.
    const slash = member.indexOf('/')
    if (slash === -1) continue
    const segment = member.slice(0, slash)
    if (bySegment.has(segment)) continue
    const run = singleDigitRun(segment)
    bySegment.set(segment, {
      value: run === undefined ? segment : run,
      label: segment,
    })
  }
  const options = [...bySegment.values()]
  // Two segments that map to the SAME value are an ambiguous offer: the renderer
  // stringifies option values (`String(rec.value)`), so `group_008` and `group_8` both
  // become `"8"` and the widget's label lookup finds the FIRST — a user picking the
  // second row would see the first row's label. Two options indistinguishable to the
  // widget must not both be emitted; the FIRST declared segment wins, deterministically.
  const seen = new Set<string | number>()
  const deduped: ContainerMemberOption[] = []
  for (const option of options) {
    if (seen.has(option.value)) continue
    seen.add(option.value)
    deduped.push(option)
  }
  const allNumeric = deduped.every(o => typeof o.value === 'number')
  if (allNumeric) {
    deduped.sort(
      (a, b) => (a.value as number) - (b.value as number) || a.label.localeCompare(b.label),
    )
  } else {
    deduped.sort((a, b) => a.label.localeCompare(b.label))
  }
  return deduped
}
