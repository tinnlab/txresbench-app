// A DOMAIN-FREE membership-diff over two frozen artifacts' `structure.sets` (INV-7 / DEC-11).
//
// The frozen-version lineage view renders a per-version delta — "this version = the prior one,
// plus these members, minus those, in this set". This helper computes that diff PURELY and in a
// domain-agnostic way: it knows nothing about what a "set" or a "member" IS. The field names ride
// in as params (`nameField` identifies a set; `valuesField` holds its member list), so this helper
// serves any draftable kind whose freeze producer emits a `sets: [{ <name>, <values>[] }]`
// structure — the domain noun (the member field's name) lives only in the package view config,
// passed in via `valuesField`, never here.

/** One set's per-member change between two versions. */
export interface SetMemberDelta {
  /** The set's identity (its `nameField` value). */
  name: string
  /** Members present in the current version's set but not the prior version's. */
  added: string[]
  /** Members present in the prior version's set but not the current version's. */
  removed: string[]
}

/** The full membership delta between a PRIOR and a CURRENT frozen structure. */
export interface MembershipDelta {
  /** Sets present in the current version, absent in the prior (whole-set additions). */
  addedSets: string[]
  /** Sets present in the prior version, absent in the current (whole-set removals). */
  removedSets: string[]
  /** Sets in BOTH versions whose member list changed (unchanged sets omitted). */
  changed: SetMemberDelta[]
}

/** Options carrying the (domain-owned) field names the diff reads — never hardcoded here. */
export interface MembershipDeltaOptions {
  /** The set-record field holding the set's display name/identity (default `name`). */
  nameField?: string
  /** The set-record field holding the member list (the domain noun rides here — REQUIRED). */
  valuesField: string
}

function asRecordArray(raw: unknown): Array<Record<string, unknown>> {
  return Array.isArray(raw)
    ? raw.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r))
    : []
}

function memberList(rec: Record<string, unknown>, valuesField: string): string[] {
  const v = rec[valuesField]
  return Array.isArray(v) ? v.map(String) : []
}

/** Index a set array by its name field, first-seen wins (a canonicalized frozen structure has
 *  unique set names by construction; a duplicate is ignored rather than silently merged). */
function byName(
  sets: Array<Record<string, unknown>>,
  nameField: string,
): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>()
  for (const s of sets) {
    const name = typeof s[nameField] === 'string' ? (s[nameField] as string) : ''
    if (name !== '' && !out.has(name)) out.set(name, s)
  }
  return out
}

/**
 * Compute the membership delta from `parentStructure.sets` → `currentStructure.sets`.
 *
 * Pure + total: any non-array/absent input degrades to an empty side (so a first version — no
 * parent — yields no delta, and a malformed structure never throws). Set-matching is by
 * `nameField`; per-set member diffs are by string equality over `valuesField`. Added/removed
 * lists preserve the current/prior version's own member order.
 */
export function computeMembershipDelta(
  parentSets: unknown,
  currentSets: unknown,
  opts: MembershipDeltaOptions,
): MembershipDelta {
  const nameField = opts.nameField ?? 'name'
  const valuesField = opts.valuesField
  const parent = byName(asRecordArray(parentSets), nameField)
  const current = byName(asRecordArray(currentSets), nameField)

  const addedSets: string[] = []
  const removedSets: string[] = []
  const changed: SetMemberDelta[] = []

  for (const [name, rec] of current) {
    const prior = parent.get(name)
    if (!prior) {
      addedSets.push(name)
      continue
    }
    const priorMembers = new Set(memberList(prior, valuesField))
    const currentMembers = new Set(memberList(rec, valuesField))
    const added = memberList(rec, valuesField).filter(m => !priorMembers.has(m))
    const removed = memberList(prior, valuesField).filter(m => !currentMembers.has(m))
    if (added.length > 0 || removed.length > 0) changed.push({ name, added, removed })
  }
  for (const name of parent.keys()) {
    if (!current.has(name)) removedSets.push(name)
  }
  return { addedSets, removedSets, changed }
}

/** True when a delta carries no change at all (identical membership) — the lineage view uses it
 *  to suppress an empty "changes" line. */
export function isEmptyDelta(d: MembershipDelta): boolean {
  return d.addedSets.length === 0 && d.removedSets.length === 0 && d.changed.length === 0
}
