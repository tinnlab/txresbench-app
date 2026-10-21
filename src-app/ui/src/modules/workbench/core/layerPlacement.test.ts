// TEST-4 (ITEM-2) — every `declarative/` source file at origin/main landed in EXACTLY
// one destination, and every destination is a named layer.
//
// ITEM-2 split a 32-file directory across `core/spec` (the pure front end),
// `core/runtime` (the pure runtime), `core/render` (the React half) and two
// extensions. The failure mode a file-count or a `tsc` pass cannot see is a file
// DROPPED (its behaviour silently gone) or DUPLICATED (two copies drifting). So the
// inventory is derived from git at test time — `git ls-tree` at the merge-base for the
// "before", `git diff -M` for the placement — never from a list transcribed into this
// file, which would only ever re-state what the author believed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../../../../../..')
const BASE = '06d99c65' // origin/main — the same commit the surface baseline was captured from
const DECL = 'src-app/ui/src/modules/workbench/declarative/'
const WB = 'src-app/ui/src/modules/workbench/'

/** The legal destinations. `core/{spec,runtime,render}` are the three engine layers
 *  ITEM-2 names; `core/gallery` + `core/__fixtures__` are the fixture surfaces that
 *  travelled with them (they are not engine code and were never going to land in one of
 *  the three); `extensions/*` are the named extensions ITEM-8/13/36 give ownership to. */
const LEGAL = [
  'core/spec/',
  'core/runtime/',
  'core/render/',
  'core/gallery/',
  'core/__fixtures__/',
  'extensions/canvas/',
  'extensions/widgets/',
]

/** BASE-inventory files DELETED ON PURPOSE since the move, keyed by their PRE-move path.
 *  These clauses guard against a file being silently dropped BY THE MOVE; a later,
 *  deliberate deletion is a different act, and it is recorded here with its reason rather
 *  than by weakening the assertion. The entries are checked for HONESTY below: an entry not
 *  in the base inventory, or one whose file still has a destination in HEAD, fails.
 *
 *  - `declarative/gate.ts` (moved to `core/runtime/gate.ts`, then deleted) — DOMAIN_AUDIT C6.
 *    It was unreachable: its only caller was `DeclarativeRegion`'s `region === 'center'`
 *    branch, and `fanViewSpecToContributions` DROPS a declared `center` region. It was also
 *    domain-coupled while dead — core hardcoded that a view's `const.criteria` MEANT "the
 *    required obs metric columns", and `GateData` privileged a slice named `obs`. */
const DELETED_ON_PURPOSE = new Set([`${DECL}gate.ts`])

/**
 * Base files whose destination git can no longer DETECT, because the file was rewritten
 * past the similarity threshold after the move. Not an excuse list — the opposite: git's
 * rename detection is a heuristic, and a substantial rewrite is a legitimate outcome, so
 * losing the edge is a failure of the DETECTOR, not of the placement. Naming the
 * destination here keeps the pin POSITIVE (the checks below still assert it exists on
 * disk and lands in a legal layer) instead of quietly lowering the expected count, which
 * would let a genuinely dropped file hide behind the same arithmetic.
 *
 * `declarative/seam.ts` → `core/runtime/seam.ts`: the layout collapse rewrote it
 * (`fanViewSpecToContributions` → `viewSpecToContribution`, the `::region::` alias ids and
 * `regionPanels` gone). Verified: `git diff -M10%` still reports it as a plain delete, so
 * this is not a threshold that could simply be loosened.
 *
 * Every entry is honesty-checked below: it must really be undetectable, and it must really
 * be on disk.
 */
const REWRITTEN_PAST_RENAME_DETECTION = new Map<string, string>([
  [`${DECL}seam.ts`, `${WB}core/runtime/seam.ts`],
  // `declarative/register.ts` → `core/runtime/register.ts`: the analysis-keyed pane collapse
  // rewrote it (`registerDeclarativeView` → `registerDeclarativeViews`, one contribution per
  // ANALYSIS carrying an ordered `views[]` instead of one per spec). Verified the same way as
  // its sibling: `git diff -M10%` still reports a plain delete, so this is not a threshold that
  // could be loosened.
  //
  // Two entries is the point at which this deserves a note rather than another line: both were
  // caused by the SAME change, and both were found only because the count assertion failed. The
  // honesty test below is what keeps the pair from rotting — an override that becomes detectable
  // again, or points at a file no longer on disk, fails rather than silently standing in.
  [`${DECL}register.ts`, `${WB}core/runtime/register.ts`],
  // `declarative/store.ts` → `core/runtime/store.ts`: the SAME layer-core collapse (commit
  // 170a9986) that rewrote `seam.ts`/`register.ts` past detection also moved the declarative
  // store into the runtime layer. This third sibling was MISSED when the pair above was recorded,
  // so `store.ts` counted as a deleted-with-no-destination base file and the count assertion read
  // 30 instead of 31 (a pre-existing red on origin/main, unrelated to #50; recorded here on the
  // way past). Like the `DeclarativeRegion.tsx` entry below it is a THRESHOLD effect, not a plain
  // delete: `git diff -M10%` still reports the rename (R028) to `core/runtime/store.ts`, so the
  // lineage is intact and only the 30%-similarity confidence dropped. The honesty test below
  // fails if it becomes detectable at 30% again or if the destination stops existing.
  [`${DECL}store.ts`, `${WB}core/runtime/store.ts`],
  // `declarative/widgets/DeclarativeRegion.tsx` → `core/render/DeclarativeRegion.tsx`: the pane
  // grew things the original file never had — the per-analysis run list, the derived target for
  // an actionable alert, the artifact-picker grouping threaded to its widgets — and fell under
  // the 30% similarity this guard asks for.
  //
  // UNLIKE the two entries above, this one IS a threshold effect and says so: `git diff -M10%`
  // still reports the rename (R028), so the lineage is intact and only the confidence dropped.
  // Recorded rather than loosening the threshold, because a lower `-M` across the whole diff
  // would start inventing renames between unrelated files. The honesty test below fails if it
  // becomes detectable at 30% again, or if the destination stops existing.
  [`${DECL}widgets/DeclarativeRegion.tsx`, `${WB}core/render/DeclarativeRegion.tsx`],
  // `declarative/schema.ts` → `core/spec/schema.ts`: the SAME threshold effect as the entry
  // above, and it crossed the line during the visualize-pane round. The parser has taken on
  // three refusals the original file never had — the `""`-as-closed-set-default refusal (R1),
  // the canvas validation, and the entry-disposition gates (INV-19) — and similarity fell to
  // 27%.
  //
  // MEASURED, not assumed, on the same rule the entry above states: `git diff -M20%` (and
  // -M10%, and -M5%) still reports `R027`, so the lineage is intact and only git's confidence
  // dropped. Recorded here rather than loosening `-M30%` for the whole diff, which would start
  // inventing renames between unrelated files. The honesty test below fails if it becomes
  // detectable at 30% again, or if the destination stops existing.
  [`${DECL}schema.ts`, `${WB}core/spec/schema.ts`],
  // `declarative/canvasFeed.ts` → `extensions/canvas/canvasFeed.ts`: the content-addressed wire
  // ids (a digest of each resolved slice + keep-mask, plus the reverse map the resolver answers
  // through) and the declared per-plot placement roughly doubled the file. It crossed the edge
  // between two commits and nothing else changed about it: the SAME diff reports R049 one commit
  // earlier and R029 now, so the lineage is intact and only the detector's confidence moved. The
  // honesty test below fails if it becomes detectable at 30% again, or if the destination stops
  // existing — which is what keeps this from standing in for a genuinely dropped file.
  [`${DECL}canvasFeed.ts`, `${WB}extensions/canvas/canvasFeed.ts`],
  // `declarative/registry.ts` → `core/render/registry.ts`: declared per-input validation gave every
  // widget renderer a verdict to carry, which rewrote the registry's dispatch around it. Same
  // threshold effect as the two above and measured the same way — the SAME diff reports R039 one
  // commit earlier and D+A now, and `-M10%` still reports the rename (R028), so the lineage is
  // intact and only the detector's confidence moved.
  //
  // This is the THIRD such entry, and the pattern is worth naming: a destination file that keeps
  // growing eventually falls under 30% similarity to the file it came from, so this list grows by
  // one every time substantial work lands in a moved file. That is the cost of proving the
  // move with rename detection, and it is still the right trade — the alternative, lowering `-M`
  // globally, would start inventing renames between unrelated files. The honesty test below is
  // what makes each entry safe: it fails if the rename becomes detectable at 30% again, or if the
  // destination stops existing, so a pin can never stand in for a genuinely dropped file.
  [`${DECL}registry.ts`, `${WB}core/render/registry.ts`],
  // `declarative/widgets/renderers.tsx` → `extensions/widgets/renderers.tsx`: the closed-set
  // controls, the two-line option row and the per-row part renderers grew it past the edge.
  // Measured the same way as its siblings — R031 one commit earlier, D+A now, and `-M10%` still
  // reports the rename (R029), so the lineage is intact and only the detector's confidence moved.
  //
  // FOURTH entry. The note on the one above predicted exactly this, and it is worth stating what
  // the pattern costs rather than repeating the prediction: this list grows by one every time
  // substantial work lands in a file that was moved, so it is a maintenance tax on the moved set,
  // not a sign that anything is wrong. The tax is preferable to the alternative — lowering `-M`
  // globally would start inventing renames between unrelated files, which is a worse failure than
  // an over-long override list. The honesty checks below are what keep each entry from rotting.
  [`${DECL}widgets/renderers.tsx`, `${WB}extensions/widgets/renderers.tsx`],
  // `declarative/viewData.ts` → `core/runtime/viewData.ts`: the emit model's two new slice
  // readers (`pane_frame`, `column_values`) pushed it over the edge. Measured exactly as its
  // siblings were — `-M30%` reports D+A, `-M10%` still reports the rename (R028), so the lineage
  // is intact and only the detector's confidence moved.
  //
  // FIFTH entry, and the prediction two notes above holds unchanged: this list grows by one every
  // time substantial work lands in a file that was moved. It is a maintenance tax on the moved
  // set, not a symptom — and the honesty checks below are what stop a pin ever standing in for a
  // genuinely dropped file.
  [`${DECL}viewData.ts`, `${WB}core/runtime/viewData.ts`],
  // `declarative/hostCtx.ts` → `core/runtime/hostCtx.ts`: the binding-origin round gave
  // `resolveInputs` a per-slot origin to carry — the caller's for a supplied slot, `auto` for
  // the LAUNCH-time sole-candidate bind — and that plus its rationale pushed the file over the
  // edge. Measured exactly as its five siblings were: `-M30%` reported `R030` one commit
  // earlier and reports `D` now, while `-M10%` still reports the rename (`R028`), so the
  // lineage is intact and only the detector's confidence moved.
  //
  // SIXTH entry, and it is the prediction three notes above coming true on schedule rather
  // than anything new: this list grows by one every time substantial work lands in a file that
  // was moved. Recorded rather than loosening `-M30%` globally, which would start inventing
  // renames between unrelated files — a worse failure than a long override list. The honesty
  // test above is what keeps it safe: it fails the moment this becomes detectable at 30%
  // again, or if the destination stops existing, so the pin can never stand in for a genuinely
  // dropped file.
  [`${DECL}hostCtx.ts`, `${WB}core/runtime/hostCtx.ts`],
  // `declarative/dataStatus.ts` → `core/runtime/dataStatus.ts`: the failure-surface vocabulary
  // rounds (an unresolvable source is CLASSIFIED not skipped; a located-and-refused artifact is
  // `unreadable` and names its missing source; a mixed unsupported+error state gets its own type)
  // rewrote the status model the runtime carries and pushed the file past the edge. Measured the
  // same way as its siblings: `-M30%` reports D+A, while `-M10%` still reports the rename (R025),
  // so the lineage is intact and only the detector's confidence moved.
  //
  // SEVENTH entry, on the schedule the notes above predicted — this list grows by one every time
  // substantial work lands in a moved file. Recorded rather than loosening `-M30%` globally, which
  // would start inventing renames between unrelated files. The honesty test above fails if it
  // becomes detectable at 30% again, or if the destination stops existing on disk.
  [`${DECL}dataStatus.ts`, `${WB}core/runtime/dataStatus.ts`],
  // `declarative/gallery/DeclarativeFixtureStories.tsx` → `core/gallery/DeclarativeFixtureStories.tsx`:
  // the gallery fixture surface travelled with the engine (it is not engine code — see the LEGAL
  // `core/gallery/` entry) and the domain-lint + inset/scrollbar rounds rewrote its stories past
  // the edge. Measured exactly as its siblings: `-M30%` reports D+A, while `-M10%` still reports the
  // rename (R023), so the lineage is intact and only the detector's confidence moved.
  //
  // EIGHTH entry, same maintenance tax as the seven above and preferable to a global `-M` loosening.
  // The honesty test above fails if it becomes detectable at 30% again, or if the destination stops
  // existing on disk.
  [`${DECL}gallery/DeclarativeFixtureStories.tsx`, `${WB}core/gallery/DeclarativeFixtureStories.tsx`],
  // `declarative/gallery/fixtureSpecs.ts` → `core/gallery/fixtureSpecs.ts`: NINTH entry, BRANCH-LOCAL
  // to `feat/geneset-increment-1` — the same threshold effect on schedule: the increment-1 branch
  // added the `widget-kit` fixture (a new fixture key + the slug-count golden, fix-round-3 FIX 4),
  // and that content pushed the file past the `-M30%` similarity: on `origin/main` `-M30%` still
  // reports the rename, on this branch it reports a plain delete while `-M10%` still reports the
  // rename, so the lineage is intact and only git's confidence moved. Recorded here (the list's own
  // stated mechanism) rather than reverting a legitimate golden update or loosening `-M30%` globally.
  // Branch-local by construction: the honesty test above REMOVES it the day the edit is absent
  // (on main it is still detectable, so this pin belongs only where the branch's edit lives).
  [`${DECL}gallery/fixtureSpecs.ts`, `${WB}core/gallery/fixtureSpecs.ts`],
])

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

/** The pre-refactor inventory, read out of git — NOT a hand-written list. */
function baseInventory(): string[] {
  return git('ls-tree', '-r', BASE, '--name-only')
    .split('\n')
    .filter(p => p.startsWith(DECL))
    .filter(p => !/\.test\.(ts|tsx)$/.test(p))
    .sort()
}

/** source -> destination, from git's own rename detection across the whole diff. */
function renameMap(): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const line of git('diff', '-M30%', '--name-status', BASE, 'HEAD').split('\n')) {
    const parts = line.split('\t')
    if (!parts[0]?.startsWith('R') || parts.length < 3) continue
    const [, from, to] = parts
    if (!from.startsWith(DECL)) continue
    out.set(from, [...(out.get(from) ?? []), to])
  }
  // Fill in the edges git cannot see. Only where it saw NOTHING — an override that would
  // contradict a detected rename is a stale entry, and the honesty test below fails on it
  // rather than letting it silently win.
  for (const [from, to] of REWRITTEN_PAST_RENAME_DETECTION) {
    if (!out.has(from)) out.set(from, [to])
  }
  return out
}

/** The raw git view, with no overrides — what the honesty test measures against. */
function detectedRenameMap(): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const line of git('diff', '-M30%', '--name-status', BASE, 'HEAD').split('\n')) {
    const parts = line.split('\t')
    if (!parts[0]?.startsWith('R') || parts.length < 3) continue
    const [, from, to] = parts
    if (!from.startsWith(DECL)) continue
    out.set(from, [...(out.get(from) ?? []), to])
  }
  return out
}

test('TEST-4: every rename-detection override is still NEEDED and still TRUE', () => {
  const detected = detectedRenameMap()
  const inv = baseInventory()
  for (const [from, to] of REWRITTEN_PAST_RENAME_DETECTION) {
    assert.ok(inv.includes(from), `${from} is overridden but was not in the base inventory`)
    assert.equal(
      detected.has(from),
      false,
      `${from} is detectable again — remove the override rather than letting it shadow git`,
    )
    assert.ok(existsSync(path.join(REPO, to)), `${from} is overridden to ${to}, which is not on disk`)
  }
})

test('TEST-4: the pre-refactor `declarative/` inventory is the expected size', () => {
  const inv = baseInventory()
  // POSITIVE expected count. TESTS.md said 31; the measured inventory at 06d99c65 is 32
  // (see the TESTS.md amendment note). Pinning the number means an inventory that
  // collapsed — the way every check in this round that "found no violations" collapsed —
  // fails here instead of reporting a clean placement over three files.
  assert.equal(inv.length, 32, `expected 32 non-test declarative/ files at ${BASE}, got ${inv.length}`)
})

test('TEST-4: every `declarative/` file landed in EXACTLY ONE destination', () => {
  const inv = baseInventory()
  const map = renameMap()
  const dropped: string[] = []
  const duplicated: string[] = []
  for (const f of inv) {
    const dests = map.get(f)
    if (DELETED_ON_PURPOSE.has(f)) {
      // HONESTY: an allowlisted file must really have NO destination in HEAD. If it comes
      // back (or never went away), the entry is stale and this fails rather than excusing it.
      assert.deepEqual(dests ?? [], [], `${f} is allowlisted as deleted but still has a destination`)
      continue
    }
    if (!dests || dests.length === 0) dropped.push(f)
    else if (dests.length > 1) duplicated.push(`${f} -> ${dests.join(' AND ')}`)
  }
  assert.deepEqual(dropped, [], 'these files have no detected destination — dropped in the move')
  assert.deepEqual(duplicated, [], 'these files landed in more than one place — duplicated in the move')
  // And the reverse: no two sources claim the same destination.
  const byDest = new Map<string, string[]>()
  for (const [from, dests] of map) for (const d of dests) byDest.set(d, [...(byDest.get(d) ?? []), from])
  const collisions = [...byDest].filter(([, srcs]) => srcs.length > 1)
  assert.deepEqual(collisions, [], 'two source files collapsed onto one destination')
})

test('TEST-4: every destination is one of the NAMED layers', () => {
  const inv = baseInventory()
  const map = renameMap()
  const illegal: string[] = []
  for (const f of inv) {
    for (const d of map.get(f) ?? []) {
      const rel = d.startsWith(WB) ? d.slice(WB.length) : d
      if (!LEGAL.some(l => rel.startsWith(l))) illegal.push(`${f} -> ${d}`)
    }
  }
  assert.deepEqual(illegal, [], `these files landed outside the named layers (legal: ${LEGAL.join(', ')})`)
})

test('TEST-4: all three ENGINE layers actually received files', () => {
  const inv = baseInventory()
  const map = renameMap()
  const dests = inv.flatMap(f => map.get(f) ?? []).map(d => d.slice(WB.length))
  // A placement that swept everything into one layer would satisfy "exactly one
  // destination" perfectly. The split is the point, so each layer's share is asserted
  // as a positive count.
  const count = (p: string) => dests.filter(d => d.startsWith(p)).length
  assert.ok(count('core/spec/') >= 3, `core/spec received ${count('core/spec/')}`)
  assert.ok(count('core/runtime/') >= 12, `core/runtime received ${count('core/runtime/')}`)
  assert.ok(count('core/render/') >= 6, `core/render received ${count('core/render/')}`)
  assert.ok(count('extensions/') >= 5, `extensions received ${count('extensions/')}`)
})

test('TEST-4: every detected destination EXISTS ON DISK', () => {
  // The three assertions above read COMMITTED history (`git diff BASE HEAD`), which is
  // exactly right for "was anything dropped in the move" and exactly wrong for "is it
  // still here". Without this clause the suite stays green after a destination file is
  // deleted from the working tree — verified: the red demo for the placement clauses did
  // not fire until this was added.
  const inv = baseInventory()
  const map = renameMap()
  const missing: string[] = []
  let checked = 0
  for (const f of inv) {
    if (DELETED_ON_PURPOSE.has(f)) continue
    for (const d of map.get(f) ?? []) {
      checked++
      if (!existsSync(path.join(REPO, d))) missing.push(d)
    }
  }
  // 32 base files minus the ones deliberately deleted since. Still a POSITIVE pin: a
  // collapsed rename map fails here rather than reporting a clean placement over nothing.
  const expected = 32 - DELETED_ON_PURPOSE.size
  assert.equal(checked, expected, `expected to check ${expected} destinations, checked ${checked}`)
  // The allowlist must stay HONEST: every entry names a file the base inventory really held.
  const notInBase = [...DELETED_ON_PURPOSE].filter(f => !inv.includes(f))
  assert.deepEqual(notInBase, [], 'a DELETED_ON_PURPOSE entry is not in the base inventory')
  assert.deepEqual(missing, [], 'these destinations were recorded by the move but are not on disk')
})

test('TEST-4: the `declarative/` directory itself no longer exists', () => {
  assert.equal(existsSync(path.join(REPO, DECL)), false)
})
