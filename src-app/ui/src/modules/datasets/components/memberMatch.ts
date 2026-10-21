/**
 * ITEM-6 (#160, DEC-2/DEC-7) — the CLIENT mirror of the core's declared-depth
 * member matcher.
 *
 * A container declares its members as DATA (`input_requirements.members`), and the
 * core decides membership by the declared member's OWN segment count anchored at the
 * path SUFFIX (`dataset/repository.rs::member_path_segments` / `::matches_member` /
 * `::explain_manifest_group`). A member declaring no path separator matches on the
 * basename — byte-identically to every container shipped before #160 — and a member
 * declaring K separators matches iff the candidate's last K+1 normalized segments
 * equal the member's. Each `|`-alternative carries its own depth.
 *
 * WHY A MIRROR AND NOT A ROUND TRIP. Folder mode hands the user a picker over a tree
 * that can hold thousands of entries, and the only two things the panel must say
 * BEFORE anything is transferred are *which declared member bound to which relative
 * path* and *what is wrong*. Asking the server would mean uploading the tree to find
 * out it does not group. So the rule is evaluated here, on the picked list, and the
 * server still decides — the panel never widens what the core accepts, it only
 * refuses earlier and by name.
 *
 * This module is PURE (no React, no store, no network): the whole surface is
 * `matchMembers` over a list plus a declaration list, which is what makes the
 * behaviour testable without a DOM.
 */

/** One declared member's outcome over the picked list — exactly one row per member. */
export interface MemberMatch {
  /** The member as DECLARED (possibly a `|`-alternation), verbatim. */
  member: string
  /** The slot id derived for that member (`memberSlot().id` — the row key/testid). */
  slotId: string
  /** The single file that satisfied it, or `null` when 0 or >1 did. */
  file: File | null
  /** How many picked files satisfied it (0 = absent, 1 = bound, >1 = ambiguous). */
  candidates: number
}

/** The verdict over a whole picked folder. Every kind of gap is reported at once —
 *  a real tree usually hits more than one, and naming only the first sends the user
 *  to fix the wrong thing (the same reason the core's gap struct carries all three). */
export interface MatchResult {
  /** May these entries be uploaded as this type? False when ANY gap below is non-empty.
   *  `matched` stays truthful either way — a refusal must not make a bound member render
   *  as "not found". */
  grouped: boolean
  /** Bound members, in DECLARED order. */
  matched: { member: string; slotId: string; file: File }[]
  /** Members satisfied by MORE than one picked file — a refusal, never a pick. */
  ambiguous: { member: string; candidates: number }[]
  /** Members satisfied by NO picked file, as declared. */
  missing: string[]
  /** Picked paths satisfying more than one declared member — an ambiguous
   *  DECLARATION rather than a bad pick. Such a path counts toward NO member. */
  multiClaim: { name: string; members: string[] }[]
  /** Every member resolved, but the entries do not come from ONE bundle — as
   *  `(member, the directory it was found under)`. Non-empty means the group does NOT
   *  form, and `matched` is emptied so nothing can be uploaded from it. */
  scattered: { member: string; root: string }[]
  /** How many entries the pick carried (reported as ONE line — never listed). */
  scanned: number
  /** DEC-7: a folder DROP yields top-level entries with no relative path in any
   *  browser, so the panel says that rather than silently binding nothing. True only
   *  when something was picked and NOTHING in it carries a relative path. */
  noRelativePaths: boolean
}

/** What a picked entry is matched on: its vendor-relative path when the picker
 *  carried one, else its bare name (every non-directory picker leaves this empty). */
export function relativePathOf(file: File): string {
  const rel = file.webkitRelativePath
  return rel != null && rel.length > 0 ? rel : file.name
}

const COMPRESSION_SUFFIXES = ['.gz', '.bz2', '.xz', '.zst']

/**
 * Split a name into the normalized SEGMENTS matching compares — the mirror of
 * `member_path_segments`.
 *
 * Both separators are honoured (a browser may send either), a name ENDING in a
 * separator names a directory and yields nothing, empty segments are dropped, each
 * segment is lowercased ASCII-ONLY, and ONE compression suffix is stripped from the
 * LAST segment only: a directory called `archive.gz` is a directory, not a compressed
 * thing. All of it is generic file-transport convention.
 *
 * ASCII-only is not fussiness. The core uses `to_ascii_lowercase`; JS `toLowerCase`
 * folds the whole of Unicode, so `K.h5` (U+212A KELVIN SIGN) would match a member
 * `k.h5` HERE and not on the server — the panel would report every member matched,
 * enable Upload, transfer the bytes, and the server would answer
 * `MANIFEST_GROUP_INCOMPLETE`. A mirror that is WIDER than the core is worse than no
 * mirror: it promises an upload that cannot happen.
 */
const asciiLower = (s: string): string => s.replace(/[A-Z]/g, c => c.toLowerCase())

export function memberPathSegments(name: string): string[] {
  if (name.endsWith('/') || name.endsWith('\\')) return []
  const segs = name
    .split(/[/\\]/)
    .filter(s => s.length > 0)
    .map(asciiLower)
  if (segs.length > 0) {
    const last = segs[segs.length - 1]
    for (const suffix of COMPRESSION_SUFFIXES) {
      if (last.endsWith(suffix)) {
        segs[segs.length - 1] = last.slice(0, last.length - suffix.length)
        break
      }
    }
  }
  return segs
}

/** Does `name` satisfy the declared `member` (possibly a `|`-alternation)? An
 *  alternative's K segments must equal the candidate's LAST K segments. */
export function matchesMember(name: string, member: string): boolean {
  const got = memberPathSegments(name)
  return member.split('|').some(alt => {
    const want = memberPathSegments(alt.trim())
    if (want.length === 0 || got.length < want.length) return false
    const start = got.length - want.length
    return want.every((seg, i) => got[start + i] === seg)
  })
}

/** Where in the picked tree a member was found: the segments BEFORE its own declared
 *  segments. `null` when the path does not satisfy the member at all. Mirrors
 *  `repository.rs::member_root`. */
export function memberRoot(name: string, member: string): string[] | null {
  const got = memberPathSegments(name)
  // The DEEPEST matching alternative decides, not the first one written: a mixed-depth
  // alternation can have both alternatives match one path, and taking whichever came first
  // made the bundle root — and so the one-bundle verdict — depend on declaration ORDER.
  let best: string[] | null = null
  let bestDepth = -1
  for (const alt of member.split('|')) {
    const want = memberPathSegments(alt.trim())
    if (want.length === 0 || got.length < want.length) continue
    const start = got.length - want.length
    if (want.every((seg, i) => got[start + i] === seg) && want.length > bestDepth) {
      bestDepth = want.length
      best = got.slice(0, start)
    }
  }
  return best
}

/** Do the matched entries all come from ONE bundle? Mirrors
 *  `repository.rs::shares_one_bundle_root`: the roots must form a CHAIN under "is a
 *  prefix of", which is one bundle with members at different depths inside it. */
export function sharesOneBundleRoot(roots: string[][]): boolean {
  if (roots.length === 0) return true
  let longest = roots[0]
  for (const r of roots) if (r.length > longest.length) longest = r
  return roots.every(r => r.length <= longest.length && r.every((seg, i) => longest[i] === seg))
}

/**
 * Bind each declared member to the ONE picked entry that satisfies it, and say why
 * when that is impossible.
 *
 * The verdict is the core's verdict: a member with two candidates, a member with
 * none, or a path claiming two members is a refusal — this never picks one. AND, for a
 * declaration that carries a path segment, the matched entries must all come from ONE
 * bundle.
 *
 * That last clause was MISSING in the first cut, and it is the one direction this module
 * must never drift: pointing the picker at a parent folder holding two sibling runs binds
 * every member exactly once, so the panel would report "12 of 12 matched", enable Upload,
 * transfer the bytes, and the server would refuse them — for a bundle whose size is the
 * whole reason the folder picker exists. Pinned to the core by the `groups` half of
 * `member_match_cases.json`.
 */
export function matchMembers(
  files: File[],
  members: { id: string; declaration: string }[],
): MatchResult {
  const candidates: number[][] = members.map(() => [])
  const multiClaim: { name: string; members: string[] }[] = []

  // Both sides of the comparison are derived ONCE. A picked tree can hold tens of
  // thousands of entries, and `matchesMember` re-split BOTH the candidate path and every
  // alternative of a declaration that never changes, on every pair — so a 50k pick against
  // a twelve-member declaration re-derived the same fixed declarations 600,000 times,
  // synchronously inside render.
  const wanted: string[][][] = members.map(m =>
    m.declaration
      .split('|')
      .map(alt => memberPathSegments(alt.trim()))
      .filter(w => w.length > 0),
  )
  const suffixMatches = (got: string[], want: string[]): boolean =>
    got.length >= want.length &&
    want.every((seg, i) => got[got.length - want.length + i] === seg)

  for (let i = 0; i < files.length; i += 1) {
    const rel = relativePathOf(files[i])
    const got = memberPathSegments(rel)
    const hits: number[] = []
    for (let m = 0; m < members.length; m += 1) {
      if (wanted[m].some(want => suffixMatches(got, want))) hits.push(m)
    }
    if (hits.length === 1) candidates[hits[0]].push(i)
    else if (hits.length > 1) {
      multiClaim.push({ name: rel, members: hits.map(m => members[m].declaration) })
    }
  }

  const matched: { member: string; slotId: string; file: File }[] = []
  const ambiguous: { member: string; candidates: number }[] = []
  const missing: string[] = []
  for (let m = 0; m < members.length; m += 1) {
    const found = candidates[m]
    if (found.length === 1) {
      matched.push({
        member: members[m].declaration,
        slotId: members[m].id,
        file: files[found[0]],
      })
    } else if (found.length === 0) {
      missing.push(members[m].declaration)
    } else {
      ambiguous.push({ member: members[m].declaration, candidates: found.length })
    }
  }

  // The one-bundle-root rule, applied exactly where the core applies it: only when the
  // declaration carries a path segment (for a bare-basename member a "root" is simply
  // wherever that file happened to be).
  const scattered: { member: string; root: string }[] = []
  // The bindings are NOT thrown away when the group is refused. A refusal used to empty
  // `matched`, so every row rendered "Not found" and the summary read "0 of 12 members
  // matched" — for an upload in which all twelve were found and the ONLY problem was where
  // they came from. The rows are the first thing the eye lands on, so they were telling the
  // user to go hunting for files that were all present. `grouped` is what the panel gates
  // the Upload button on; `matched` stays truthful.
  // ONLY the members that CARRY a path segment are constrained — a bare-basename member
  // declared that it does not care where it sits, and holding it to a bundle root
  // contradicts its own declaration. With fewer than two deep members there is nothing to
  // compare, which is a stated LIMIT of the rule rather than an oversight.
  const deepMatches = matched.filter(m => /[/\\]/.test(m.member))
  if (matched.length === members.length && deepMatches.length >= 2) {
    const roots = deepMatches.map(m => memberRoot(relativePathOf(m.file), m.member) ?? [])
    if (!sharesOneBundleRoot(roots)) {
      for (let i = 0; i < deepMatches.length; i += 1) {
        // The user's OWN CASE. `roots` comes from the NORMALIZED segments (lowercased,
        // that being what matching compares), and echoing those back told a user who
        // picked `Exp/RunA` about `exp/runa`.
        const original = relativePathOf(deepMatches[i].file)
          .split(/[/\\]/)
          .filter(seg => seg.length > 0)
        scattered.push({
          member: deepMatches[i].member,
          root: original.slice(0, roots[i].length).join('/') || roots[i].join('/'),
        })
      }
    }
  }

  return {
    // The one question the panel asks: may these files be uploaded as this type? It is a
    // field rather than a derivation at the call site so the panel and its tests cannot
    // disagree about which gaps are fatal.
    grouped:
      matched.length === members.length &&
      ambiguous.length === 0 &&
      missing.length === 0 &&
      multiClaim.length === 0 &&
      scattered.length === 0,
    matched,
    ambiguous,
    missing,
    multiClaim,
    scattered,
    scanned: files.length,
    noRelativePaths:
      files.length > 0 && files.every(f => (f.webkitRelativePath ?? '').length === 0),
  }
}

/**
 * One row PER DECLARED MEMBER, in declared order — what the panel renders. The list
 * is bounded by the DECLARATION (never by the picked tree, which is why a folder of
 * thousands still renders a dozen rows).
 */
export function memberRows(
  members: { id: string; declaration: string }[],
  result: MatchResult,
): MemberMatch[] {
  const bound = new Map(result.matched.map(m => [m.slotId, m.file]))
  const manyOf = new Map(result.ambiguous.map(a => [a.member, a.candidates]))
  return members.map(m => ({
    member: m.declaration,
    slotId: m.id,
    file: bound.get(m.id) ?? null,
    candidates: bound.has(m.id) ? 1 : (manyOf.get(m.declaration) ?? 0),
  }))
}
