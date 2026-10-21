// TEST-14 [covers ITEM-6] — the client mirror of the core's declared-depth member
// matcher (#160, DEC-2 / DEC-7).
//
// Folder mode's whole promise is that a user points at ONE directory and is told,
// before anything is transferred, which declared member bound to which relative path
// and what is wrong when one did not. That promise is this function: `matchMembers`
// over a picked list plus a declaration list. It is pure, so it is asserted directly —
// no DOM, no store, no network.
//
// The declarations here are SYNTHETIC and deliberately neutral. The real ones live as
// DATA in the contributed package manifests (and are exercised end to end by the
// browser spec); what is under test is the RULE, which knows nothing about any vendor,
// and `scripts/lint-no-domain-in-builtin.mjs` is what keeps a vendor declaration out
// of the app tree — this file included.

import { describe, expect, it } from 'vitest'
import { matchMembers, matchesMember, memberPathSegments, memberRows } from './memberMatch'

/** A picked entry carrying its directory-relative path — what a `webkitdirectory`
 *  picker produces. `webkitRelativePath` is read-only, hence `defineProperty`. */
function pickedAt(relativePath: string): File {
  const f = new File(['x'], relativePath.slice(relativePath.lastIndexOf('/') + 1))
  Object.defineProperty(f, 'webkitRelativePath', { value: relativePath })
  return f
}

/** A picked entry with NO relative path — every non-directory picker, and every DROP. */
const picked = (name: string): File => new File(['x'], name)

const BINS = ['grid_002', 'grid_008', 'grid_016']
const PER_BIN = ['counts.h5', 'geo/positions.parquet', 'geo/scale.json', 'geo/preview.png']

/** Twelve depth-carrying members: three sibling directories holding the same four
 *  names, at the TWO depths such a container really has. */
const NESTED = BINS.flatMap(b => PER_BIN.map(n => `${b}/${n}`))
/** The same four names declared FLAT — one segment each. */
const FLAT = PER_BIN.map(n => n.slice(n.lastIndexOf('/') + 1))

const slotOf = (declaration: string) =>
  declaration.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
const asMembers = (declarations: string[]) =>
  declarations.map(d => ({ id: slotOf(d), declaration: d }))

/** A realistic picked tree: the twelve declared entries under a root the user named
 *  themselves, plus the noise a real run directory carries — which must be SCANNED
 *  (it is in the count) and never transferred. */
const TREE: File[] = [
  ...NESTED.map(m => pickedAt(`RunA_outs/binned/${m}`)),
  pickedAt('RunA_outs/summary.html'),
  pickedAt('RunA_outs/binned/grid_008/stats/groups/table.csv'),
  pickedAt('RunA_outs/binned/grid_002/counts/values.bin.gz'),
  pickedAt('RunA_outs/binned/grid_016/notes.txt'),
]

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
describe('memberPathSegments — the normalization the core applies', () => {
  it('splits on BOTH separators, drops empty segments and lowercases each', () => {
    expect(memberPathSegments('A//B\\C.TSV')).toEqual(['a', 'b', 'c.tsv'])
    expect(memberPathSegments('/lead/and/name.tsv')).toEqual(['lead', 'and', 'name.tsv'])
  })

  it('a name ENDING in a separator names a directory and yields nothing', () => {
    // The core returns nothing for these, and it matters twice: the shipped normalizer
    // matched a trailing-separator name against nothing, and dropping the trailing empty
    // segment would strip a compression suffix off a DIRECTORY.
    expect(memberPathSegments('/lead/and/trail/')).toEqual([])
    expect(memberPathSegments('archive.gz/')).toEqual([])
    expect(matchesMember('outs/counts.h5/', 'counts.h5')).toBe(false)
  })

  it('lowercases ASCII ONLY, exactly as the core does', () => {
    // JS `toLowerCase` folds all of Unicode; the core uses `to_ascii_lowercase`. A mirror
    // that is WIDER than the core promises an upload the server will refuse.
    expect(memberPathSegments('\u212A.h5')).toEqual(['\u212A.h5'])
    expect(matchesMember('\u212A.h5', 'k.h5')).toBe(false)
    expect(matchesMember('K.h5', 'k.h5')).toBe(true)
  })

  it('strips ONE compression suffix, from the LAST segment only', () => {
    // A directory called `a.gz` is a directory, not a compressed thing.
    expect(memberPathSegments('a.GZ/b.tsv.gz')).toEqual(['a.gz', 'b.tsv'])
    expect(memberPathSegments('b.tsv.gz.gz')).toEqual(['b.tsv.gz'])
    expect(memberPathSegments('t.bin.zst')).toEqual(['t.bin'])
    expect(memberPathSegments('t.bin.bz2')).toEqual(['t.bin'])
    expect(memberPathSegments('t.bin.xz')).toEqual(['t.bin'])
  })

  it('leaves a bare name alone', () => {
    expect(memberPathSegments('table.tsv')).toEqual(['table.tsv'])
  })
})

describe('matchesMember — the declared member decides the depth', () => {
  it('a member with no separator matches on the last segment, anywhere', () => {
    expect(matchesMember('any/where/at/all/table.tsv', 'table.tsv')).toBe(true)
    expect(matchesMember('table.tsv', 'table.tsv')).toBe(true)
  })

  it('a member with K separators matches only the last K+1 segments', () => {
    expect(matchesMember('root/grid_008/geo/scale.json', 'grid_008/geo/scale.json')).toBe(true)
    expect(matchesMember('root/grid_002/geo/scale.json', 'grid_008/geo/scale.json')).toBe(false)
    // Anchored at the SUFFIX: the root the user picked is never load-bearing.
    expect(matchesMember('geo/scale.json', 'grid_008/geo/scale.json')).toBe(false)
  })

  it('refuses when the candidate has FEWER segments than the member declares', () => {
    expect(matchesMember('scale.json', 'geo/scale.json')).toBe(false)
  })

  it('each `|`-alternative carries its OWN depth', () => {
    const m = 'legacy.json|grid_008/geo/scale.json'
    expect(matchesMember('somewhere/legacy.json', m)).toBe(true)
    expect(matchesMember('root/grid_008/geo/scale.json', m)).toBe(true)
    expect(matchesMember('root/grid_002/geo/scale.json', m)).toBe(false)
  })
})

describe('TEST-14 — matchMembers over a picked directory', () => {
  it('binds each of the twelve members to the ONE entry that satisfies it', () => {
    const r = matchMembers(TREE, asMembers(NESTED))
    expect(r.matched).toHaveLength(12)
    expect(r.missing).toEqual([])
    expect(r.ambiguous).toEqual([])
    expect(r.multiClaim).toEqual([])
    // Every bound path is DISTINCT and carries its own directory — a result that bound
    // twelve rows to one entry would pass a length check and fail this.
    const bound = r.matched.map(m => m.file.webkitRelativePath)
    expect(new Set(bound).size).toBe(12)
    expect(r.matched.map(m => m.member)).toEqual(NESTED)
    for (const m of r.matched) {
      expect(m.file.webkitRelativePath).toBe(`RunA_outs/binned/${m.member}`)
    }
  })

  it('reports the whole picked count, and transfers only what bound', () => {
    const r = matchMembers(TREE, asMembers(NESTED))
    expect(r.scanned).toBe(TREE.length)
    expect(r.scanned).toBeGreaterThan(r.matched.length)
    const boundPaths = new Set(r.matched.map(m => m.file.webkitRelativePath))
    expect(boundPaths.has('RunA_outs/summary.html')).toBe(false)
    expect(boundPaths.has('RunA_outs/binned/grid_002/counts/values.bin.gz')).toBe(false)
  })

  it('names the members with NO candidate, as declared', () => {
    const partial = TREE.filter(
      f => !/grid_016\/geo\/(scale\.json|positions\.parquet)$/.test(f.webkitRelativePath),
    )
    const r = matchMembers(partial, asMembers(NESTED))
    expect(r.missing).toEqual(['grid_016/geo/positions.parquet', 'grid_016/geo/scale.json'])
    expect(r.matched).toHaveLength(10)
    expect(r.ambiguous).toEqual([])
  })

  it('names the member and its candidate count when several entries satisfy it', () => {
    // The FLAT declaration over the nested tree: each of the four names occurs once
    // per directory, so every member has three candidates and NONE binds.
    const r = matchMembers(TREE, asMembers(FLAT))
    expect(r.matched).toEqual([])
    expect(r.ambiguous).toEqual([
      { member: 'counts.h5', candidates: 3 },
      { member: 'positions.parquet', candidates: 3 },
      { member: 'scale.json', candidates: 3 },
      { member: 'preview.png', candidates: 3 },
    ])
    expect(r.missing).toEqual([])
  })

  it('an entry satisfying TWO declared members counts toward neither', () => {
    const members = asMembers(['geo/scale.json', 'scale.json'])
    const r = matchMembers([pickedAt('root/geo/scale.json')], members)
    expect(r.multiClaim).toEqual([
      { name: 'root/geo/scale.json', members: ['geo/scale.json', 'scale.json'] },
    ])
    expect(r.matched).toEqual([])
    expect(r.missing).toEqual(['geo/scale.json', 'scale.json'])
  })

  it('DEC-7 — a DROPPED directory carries no relative paths and is called out', () => {
    const dropped = ['summary.html', 'counts.h5', 'notes.txt'].map(picked)
    const r = matchMembers(dropped, asMembers(NESTED))
    expect(r.noRelativePaths).toBe(true)
    expect(r.scanned).toBe(3)
    expect(r.matched).toEqual([])
    expect(r.missing).toHaveLength(12)
  })

  it('a PICKED directory is not mistaken for a dropped one', () => {
    expect(matchMembers(TREE, asMembers(NESTED)).noRelativePaths).toBe(false)
    // Nothing picked at all is neither — the panel says "choose a folder" instead.
    expect(matchMembers([], asMembers(NESTED)).noRelativePaths).toBe(false)
  })

  it('falls back to the bare name when there is no relative path (a flat declaration)', () => {
    const r = matchMembers(['counts.h5', 'preview.png'].map(picked), asMembers(FLAT))
    expect(r.matched.map(m => m.member)).toEqual(['counts.h5', 'preview.png'])
    expect(r.missing).toEqual(['positions.parquet', 'scale.json'])
  })

  it('a compressed picked entry still satisfies an uncompressed declaration', () => {
    const r = matchMembers([pickedAt('root/grid_008/geo/scale.json.gz')], asMembers(['grid_008/geo/scale.json']))
    expect(r.matched).toHaveLength(1)
  })
})

describe('memberRows — one row per DECLARED member, bounded by the declaration', () => {
  it('renders a dozen rows for a tree of any size, in declared order', () => {
    const members = asMembers(NESTED)
    const rows = memberRows(members, matchMembers(TREE, members))
    expect(rows).toHaveLength(12)
    expect(rows.map(r => r.member)).toEqual(NESTED)
    expect(rows.every(r => r.candidates === 1 && r.file != null)).toBe(true)
  })

  it('a row says WHY it did not bind — nothing found, or too many', () => {
    const flat = asMembers(FLAT)
    const ambiguousRows = memberRows(flat, matchMembers(TREE, flat))
    expect(ambiguousRows.map(r => r.candidates)).toEqual([3, 3, 3, 3])
    expect(ambiguousRows.every(r => r.file == null)).toBe(true)

    const nested = asMembers(NESTED)
    const emptyRows = memberRows(nested, matchMembers([], nested))
    expect(emptyRows.every(r => r.candidates === 0 && r.file == null)).toBe(true)
  })
})

// TEST-22 — the committed case table, from the MIRROR's side.
//
// `src-app/server/src/modules/dataset/member_match_cases.json` is the one authority the
// core, this mirror and a contributed package's Python mirror all answer to. The mirror
// exists so the panel can tell the user which member bound to which file BEFORE anything
// is transferred; if it drifts WIDER it promises an upload the server refuses, and if it
// drifts NARROWER it silently blocks a valid one with no server-side signal. The table
// makes either a red test on BOTH sides — the Rust half is
// `repository.rs::the_matcher_agrees_with_the_committed_case_table`.
describe('TEST-22 — the mirror agrees with the core\'s committed case table', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url))
  const TABLE = path.resolve(
    HERE,
    '../../../../../server/src/modules/dataset/member_match_cases.json',
  )
  const cases = JSON.parse(readFileSync(TABLE, 'utf8')).cases as {
    file: string
    member: string
    matches: boolean
    why: string
  }[]

  it('the table resolves and is not degenerate', () => {
    // Without this the loop below iterates nothing (a moved path, a renamed key) and
    // reports the same green as a mirror that agrees on everything.
    expect(cases.length).toBeGreaterThanOrEqual(20)
    const positives = cases.filter(c => c.matches).length
    expect(positives).toBeGreaterThanOrEqual(5)
    expect(cases.length - positives).toBeGreaterThanOrEqual(5)
  })

  it.each(cases.map(c => [c.file, c.member, c.matches, c.why] as const))(
    '%s vs %s → %s (%s)',
    (file, member, want) => {
      // BOTH the exported predicate and the one `matchMembers` actually runs. The panel
      // does not call `matchesMember` — the per-pair comparison is inlined into
      // `matchMembers` for the O(files x members) win — so asserting only the export would
      // point this whole drift guard at a copy nothing runs.
      expect(matchesMember(file, member)).toBe(want)
      const live = matchMembers([pickedAt(file)], [{ id: 'm', declaration: member }])
      expect(live.matched.length === 1, `live matchMembers disagrees for ${file} vs ${member}`).toBe(
        want,
      )
    },
  )

  // The GROUP half. The pair cases above pin only the PREDICATE; the DECISION is where
  // the one-bundle-root rule lives, and a mirror implementing only the predicate is
  // silently WIDER than the core exactly there — which is what shipped in the first cut.
  const groups = JSON.parse(readFileSync(TABLE, 'utf8')).groups as {
    name: string
    files: string[]
    members: string[]
    grouped: boolean
    gap?: string
  }[]

  it('the group table resolves and is not degenerate', () => {
    expect(groups.length).toBeGreaterThanOrEqual(8)
    const yes = groups.filter(g => g.grouped).length
    expect(yes).toBeGreaterThanOrEqual(3)
    expect(groups.length - yes).toBeGreaterThanOrEqual(3)
  })

  it.each(groups.map(g => [g.name, g] as const))('group: %s', (_name, g) => {
    const files = g.files.map(pickedAt)
    const members = g.members.map((declaration, i) => ({ id: `m${i}`, declaration }))
    const result = matchMembers(files, members)
    expect(result.grouped).toBe(g.grouped)
    if (g.grouped) {
      expect(result.matched).toHaveLength(members.length)
      expect(result.scattered).toEqual([])
      expect(result.ambiguous).toEqual([])
      expect(result.missing).toEqual([])
      expect(result.multiClaim).toEqual([])
    } else {
      // Refused — and refused for the RIGHT reason, or "it refused" is satisfied by
      // refusing over something else entirely. Note `matched` may be FULL here: a
      // scattered refusal binds every member and refuses on WHERE they came from, and
      // blanking those bindings made the panel tell the user twelve present files were
      // "Not found".
      const kind = g.gap as 'scattered_roots' | 'ambiguous' | 'missing' | 'multi_claim'
      // The BINDINGS must survive a scattered refusal. Restoring `matched.length = 0` in
      // the matcher leaves `grouped` false and `scattered` non-empty, so every other
      // assertion here passes while the panel goes back to telling the user that twelve
      // present files were "Not found". Asserted, not commented.
      if (g.gap === 'scattered_roots') {
        expect(result.matched).toHaveLength(members.length)
        expect(result.scattered).toHaveLength(
          members.filter(m => /[/\\]/.test(m.declaration)).length,
        )
      }
      const present = {
        scattered_roots: result.scattered.length > 0,
        ambiguous: result.ambiguous.length > 0,
        missing: result.missing.length > 0,
        multi_claim: result.multiClaim.length > 0,
      }[kind]
      expect(present, `expected gap kind ${kind}, got ${JSON.stringify(result)}`).toBe(true)
    }
  })
})

