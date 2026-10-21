/**
 * Tests for the DECLARED-SURFACE-DRIFT device itself.
 *
 * WHAT THIS SUITE NOW ASSERTS, after the 2026-08-10 re-capture. The device's claim is:
 * "this tree's workbench surface does not differ from the surface captured from main
 * except where the delta manifest declares it, every declared difference is attributed to
 * an authorising item and bound to the ONE change it permits, and every relocated /
 * unexported / relocated-installer claim is VERIFIED against the tree rather than
 * believed."  Each clause of that sentence has a test below, driven through `evaluate()` —
 * the pure verdict function — with synthetic facets, in both directions (declared =>
 * green, undeclared => RED). Every guard `evaluate()` applies has a test that FAILS when
 * that guard alone is removed; verified by mutation, since a guard nobody can kill is a
 * guard nobody is testing.
 *
 * WHAT IT USED TO ASSERT, and why that is gone. The previous suite pinned the baseline to
 * `layout: 'pre'` at commit 06d99c65, six exact facet counts (109/280/9/13/16/16),
 * `expected.length >= 250`, `relocated === 10`, `relocated-installer === 5`, and the
 * presence of seven named plan items. Those pins encoded the INV-4 BEFORE/AFTER
 * EQUIVALENCE argument for the `processor-ui-language` round. That argument is RETIRED
 * (see the manifest's `$comment`): the pre-refactor snapshot had drifted 621 commits
 * behind main and 28 of its 257 viewSpecs allowances were depth-<=2 blanket permits, under
 * which a brand-new schema-valid `check` in the shipped cell-filter.yaml produced 602
 * differences and ZERO UNEXPECTED.
 *
 * The pins were not merely stale — they were the WRONG SHAPE OF TEST. Counting how many
 * entries in the manifest say `relocated` was a proxy for "the relocation verification is
 * switched on"; the moment the manifest legitimately empties, the proxy reads as failure
 * while the logic is untouched. So the counts are replaced by direct tests of the LOGIC,
 * which hold whether the manifest carries 0 entries or 600.
 *
 * TWO THINGS THIS SUITE DELIBERATELY DOES NOT ASSERT:
 *   - that the manifest is EMPTY. It is empty on main, but a feature branch declaring a
 *     legitimate surface change must still pass `npm run check`. Emptiness on main needs
 *     no pin: `compare` already fails any declared-but-absent entry, so a leftover
 *     allowance cannot survive a merge that made it stale.
 *   - the expensive real-tree comparison (two full TS loads, ~2 min). That is
 *     `npm run check:surface-baseline`, wired into `npm run check`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve as presolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import {
  FLOORS,
  BLANKET_ALLOWANCE_DEPTH,
  DIFFED_SET_FACETS,
  allowanceDepth,
  allowanceProblems,
  assertFloors,
  assertPopulations,
  diffFacets,
  evaluate,
  detectLayout,
} from './capture-surface-baseline.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const UI = presolve(HERE, '..')
const REPO = presolve(UI, '../..')
const BASELINE = join(UI, 'src/modules/workbench/core/__fixtures__/surface-baseline.main.json')
const DELTA = join(HERE, 'surface-baseline-expected-delta.json')

const full = () => ({
  apiValueExports: Array.from({ length: 60 }, (_, i) => `v${i}`),
  apiDeclaredExports: Array.from({ length: 90 }, (_, i) => `d${i}`),
  contributionKinds: ['analyses', 'views', 'statusBarItems'],
  paneKinds: Array.from({ length: 12 }, (_, i) => `p${i}`),
  widgetKinds: Array.from({ length: 10 }, (_, i) => `w${i}`),
  formWidgetKinds: Array.from({ length: 10 }, (_, i) => `w${i}`),
  viewSpecs: { 'cell-filter': { id: 'cell.filter' }, qc: { id: 'qc' } },
  // The three sets the disposition claims are verified against.
  extensionExports: ['RelocatedContract'],
  moduleExports: ['NarrowedSymbol'],
})

const entry = o => ({ item: 'ITEM-X', disposition: 'deleted', why: 'a rationale long enough to pass the shape rule', ...o })
/** A viewSpecs allowance must be content-bound; `detail` comes off the observed diff. */
const specEntry = (b, a, name, extra = {}) => {
  const d = diffFacets(b, a).find(x => x.facet === 'viewSpecs' && x.name === name)
  return entry({ facet: 'viewSpecs', kind: 'changed', name, detail: d ? d.detail : '(no such difference)', ...extra })
}

// --- the committed baseline is REAL, and it is the SAME TREE SHAPE as the tree ---------

test('the committed baseline is a real, non-truncated capture of main', () => {
  assert.ok(existsSync(BASELINE), `baseline fixture missing at ${BASELINE}`)
  const b = JSON.parse(readFileSync(BASELINE, 'utf8'))

  // A full 40-hex sha, not a placeholder or an abbreviation. WHICH commit is deliberately
  // NOT pinned to a literal here: pinning it is what made re-capturing a test rewrite. The
  // PROPERTY the old literal carried — "captured from main, not from this branch" — is
  // asserted mechanically below instead.
  assert.match(
    b.capturedFrom.commit,
    /^[0-9a-f]{40}$/,
    'the baseline must record the real commit it was captured from',
  )

  // The load-bearing property, and the one that replaced `layout === 'pre'`: the baseline
  // must be the SAME tree shape as the tree under test. Exact-set comparison across two
  // different shapes compares apples to oranges; the old device tolerated that only
  // because its allowance list absorbed the whole difference.
  assert.equal(
    b.capturedFrom.layout,
    detectLayout(REPO).layout,
    'the baseline layout must match the layout of the tree it is compared against',
  )

  // Not a machine path: this file is COMMITTED, and the capturing machine's filesystem is
  // not part of the surface.
  assert.equal(b.capturedFrom.root, undefined, 'the baseline must not embed an absolute capture root')
  assert.ok(b.capturedFrom.barrel && !b.capturedFrom.barrel.startsWith('/'), 'barrel must be repo-relative')

  // Non-truncated, by the device's own fail-closed rule rather than by hand-copied counts
  // that go stale on every re-capture.
  assertFloors(b.facets, 'the committed baseline')

  // The lowered specs are real parse output, not stubs.
  assert.deepEqual(Object.keys(b.facets.viewSpecs).sort(), ['cell-filter', 'qc'])
  assert.equal(b.facets.viewSpecs['cell-filter'].id, 'cell.filter')
  assert.ok(Array.isArray(b.facets.viewSpecs['cell-filter'].actions))
  assert.ok(b.facets.viewSpecs['cell-filter'].actions.length >= 8)
  // The three verification sets must be present, or every disposition claim would be
  // unverifiable and the manifest could assert anything.
  assert.ok(Array.isArray(b.facets.extensionExports) && b.facets.extensionExports.length > 0)
  assert.ok(Array.isArray(b.facets.moduleExports) && b.facets.moduleExports.length > 0)
})

test('THE ANTI-SELF-COMPARISON RULE: the baseline commit is ON MAIN, not on this branch', () => {
  // The successor to the old `commit === '06d99c65…'` literal. That literal existed for ONE
  // reason — "a baseline captured from the tree under test proves nothing" — and dropping it
  // for a shape check would have retired the property along with the snapshot. The property
  // does not depend on WHICH commit it is, only that the commit is one main actually has.
  //
  // Without this, the loop is: change the surface -> `npm run capture:surface-baseline`
  // (whose --root defaults to the WORKING TREE) -> green, empty manifest, nothing said.
  const b = JSON.parse(readFileSync(BASELINE, 'utf8'))
  const sha = b.capturedFrom.commit

  // (a) file-level consistency, always available: the manifest names the same commit.
  const d = JSON.parse(readFileSync(DELTA, 'utf8'))
  assert.ok(
    sha.startsWith(d.baseline.commit),
    `the manifest declares baseline ${d.baseline.commit} but the fixture was captured at ${sha} — ` +
      're-capturing updates BOTH, in the same commit',
  )

  // (b) the real check: the captured commit is an ancestor of main. FAIL-CLOSED — if no
  // main ref resolves we say so rather than skipping, because a skip here restores exactly
  // the hole this test exists to close.
  const git = (...a) => spawnSync('git', a, { cwd: REPO, encoding: 'utf8' })
  const ref = ['origin/main', 'main', 'refs/remotes/origin/main'].find(
    r => git('rev-parse', '--verify', '--quiet', `${r}^{commit}`).status === 0,
  )
  assert.ok(ref, 'no main ref resolves in this checkout — fetch origin/main; this check does not skip')
  assert.equal(
    git('merge-base', '--is-ancestor', sha, ref).status,
    0,
    `the baseline was captured at ${sha.slice(0, 8)}, which is NOT an ancestor of ${ref}. A baseline ` +
      'captured from the branch under test compares the tree against itself and passes unconditionally.',
  )
})

// --- the manifest's SHAPE contract, which holds at any length ------------------------

test('the committed manifest satisfies the allowance shape rule', () => {
  const d = JSON.parse(readFileSync(DELTA, 'utf8'))
  assert.ok(Array.isArray(d.expected), 'the manifest must carry an `expected` array')
  assert.equal(d.baseline.ref, 'origin/main', 'the manifest must name the ref its baseline came from')
  // NOTE this loop is VACUOUS while the manifest is empty (which is its steady state on
  // main), so it is NOT where the shape rule is tested — the synthetic table below is.
  // Enforcement lives in `allowanceProblems`, which `evaluate` calls on every entry, so
  // this cannot become the only guard again.
  for (const e of d.expected) assert.deepEqual(allowanceProblems(e), [], `malformed allowance: ${JSON.stringify(e)}`)
})

test('the allowance shape rule REJECTS every way an allowance can be unattributed', () => {
  const ok = {
    facet: 'apiValueExports',
    kind: 'removed',
    name: 'X',
    item: 'ITEM-9',
    disposition: 'deleted',
    why: 'a rationale long enough to pass the shape rule',
  }
  assert.deepEqual(allowanceProblems(ok), [], 'the positive control must be accepted')

  const rejects = (mutate, expectMatch) => {
    const e = { ...ok }
    mutate(e)
    const problems = allowanceProblems(e)
    assert.ok(problems.length > 0, `should have been rejected: ${JSON.stringify(e)}`)
    assert.ok(
      problems.some(p => expectMatch.test(p)),
      `rejected for the wrong reason (${problems.join('; ')}) on ${JSON.stringify(e)}`,
    )
  }
  rejects(e => delete e.item, /item/)
  rejects(e => delete e.disposition, /disposition/)
  rejects(e => (e.disposition = 'R6-WHATEVER'), /disposition/) // the set is CLOSED
  rejects(e => delete e.why, /why/)
  rejects(e => (e.why = 'too short'), /why/)
  rejects(e => delete e.name, /facet\/kind\/name/)
  // A viewSpecs allowance must be CONTENT-BOUND, not merely path-shaped.
  rejects(e => {
    e.facet = 'viewSpecs'
    e.name = 'qc/widgets/0/title'
  }, /detail/)
  assert.deepEqual(
    allowanceProblems({ ...ok, facet: 'viewSpecs', name: 'qc/widgets/0/title', detail: '"a" -> "b"' }),
    [],
  )
})

test('an unattributed allowance FAILS the comparison (not just a test)', () => {
  const b = full()
  const a = full()
  a.apiDeclaredExports = a.apiDeclaredExports.filter(x => x !== 'd7')
  // The exact shape that used to pass while the CLI printed "item-attributed".
  const r = evaluate(b, a, [{ facet: 'apiDeclaredExports', kind: 'removed', name: 'd7' }])
  assert.equal(r.ok, false)
  assert.equal(r.unexpected.length, 0, 'it MATCHES the difference — which is exactly why it used to pass')
  assert.equal(r.malformed.length, 1)
  assert.match(r.malformed[0], /no authorising `item`/)
})

// --- the device's CLAIM, clause by clause, through evaluate() -------------------------

test('an UNDECLARED difference fails the comparison', () => {
  const b = full()
  const a = full()
  a.apiDeclaredExports = a.apiDeclaredExports.filter(x => x !== 'd7')
  const r = evaluate(b, a, [])
  assert.equal(r.ok, false)
  assert.deepEqual(r.unexpected.map(d => d.name), ['d7'])
})

test('the SAME difference, declared and item-attributed, passes', () => {
  const b = full()
  const a = full()
  a.apiDeclaredExports = a.apiDeclaredExports.filter(x => x !== 'd7')
  const r = evaluate(b, a, [entry({ facet: 'apiDeclaredExports', kind: 'removed', name: 'd7' })])
  assert.equal(r.ok, true)
  assert.equal(r.unexpected.length, 0)
  assert.equal(r.diffs.length, 1, 'the difference is still REPORTED, merely allowed')
})

test('RED: a declared difference that does NOT materialise fails (a stale allowance cannot widen the gate)', () => {
  const r = evaluate(full(), full(), [entry({ facet: 'apiDeclaredExports', kind: 'removed', name: 'neverHappened' })])
  assert.equal(r.ok, false)
  assert.deepEqual(r.unmet, ['apiDeclaredExports:removed:neverHappened'])
})

test('RED: a "relocated" claim absent from the extensions barrel is a DELETION in disguise', () => {
  const claimEntry = entry({ facet: 'apiDeclaredExports', kind: 'removed', name: 'd7', disposition: 'relocated' })
  const b = full()
  const a = full()
  a.apiDeclaredExports = a.apiDeclaredExports.filter(x => x !== 'd7')

  const bad = evaluate(b, a, [claimEntry])
  assert.equal(bad.ok, false)
  assert.deepEqual(bad.badRelocations, ['d7'], 'd7 is not in extensionExports, so the claim is unverifiable')

  // The honest shape: the symbol really did land in the extensions barrel. That ADDITION is
  // itself a surface difference now (extensionExports is a diffed facet — it is a published
  // entry point), so it must be declared too.
  a.extensionExports = [...a.extensionExports, 'd7']
  const good = evaluate(b, a, [
    claimEntry,
    entry({ facet: 'extensionExports', kind: 'added', name: 'd7', disposition: 'relocated' }),
  ])
  assert.equal(good.ok, true)
  assert.equal(good.relocationsVerified, 2, 'the relocation is VERIFIED, not merely allowed')
})

test('the extensions barrel is a DIFFED facet, not merely evidence for a relocation claim', () => {
  assert.ok(DIFFED_SET_FACETS.includes('extensionExports'))
  assert.ok(!DIFFED_SET_FACETS.includes('moduleExports'), 'the INTERNAL export set must not gate')
  const b = full()
  const a = full()
  a.extensionExports = [] // the whole second public entry point emptied
  const r = evaluate(b, a, [])
  assert.equal(r.ok, false, 'wiping the extensions barrel must FAIL, not pass silently')
  assert.deepEqual(r.unexpected.map(d => `${d.facet}:${d.kind}:${d.name}`), ['extensionExports:removed:RelocatedContract'])
})

test('RED: an "unexported" claim absent from every module is a DELETION mislabelled as a narrowing', () => {
  const b = full()
  const a = full()
  a.apiValueExports = a.apiValueExports.filter(x => x !== 'v3')
  const e = entry({ facet: 'apiValueExports', kind: 'removed', name: 'v3', disposition: 'unexported' })
  const bad = evaluate(b, a, [e])
  assert.equal(bad.ok, false)
  assert.deepEqual(bad.badUnexported, ['v3'])

  a.moduleExports = [...a.moduleExports, 'v3']
  const good = evaluate(b, a, [e])
  assert.equal(good.ok, true)
  assert.equal(good.narrowingsVerified, 1)
})

test('RED: a "relocated-installer" claim not reachable from the mount path is a widget that renders nothing', () => {
  const b = full()
  const a = full()
  a.formWidgetKinds = a.formWidgetKinds.filter(x => x !== 'w3')
  a.widgetKinds = a.widgetKinds.filter(x => x !== 'w3') // NOT re-registered anywhere
  const e = [
    entry({ facet: 'formWidgetKinds', kind: 'removed', name: 'w3', disposition: 'relocated-installer' }),
    entry({ facet: 'widgetKinds', kind: 'removed', name: 'w3', disposition: 'relocated-installer' }),
  ]
  const bad = evaluate(b, a, e)
  assert.equal(bad.ok, false)
  assert.ok(bad.badInstaller.includes('w3'))

  // The legitimate shape: it leaves the form installer but the canonical mount path still
  // registers it, so only the formWidgetKinds facet differs.
  const a2 = full()
  a2.formWidgetKinds = a2.formWidgetKinds.filter(x => x !== 'w3')
  const good = evaluate(b, a2, [entry({ facet: 'formWidgetKinds', kind: 'removed', name: 'w3', disposition: 'relocated-installer' })])
  assert.equal(good.ok, true)
  assert.equal(good.installerMovesVerified, 1)
})

// --- the blind spot that motivated the re-capture, closed ----------------------------

test('RED: a shallow viewSpecs allowance is REJECTED as a blanket permit', () => {
  const b = full()
  const a = full()
  b.viewSpecs['cell-filter'] = { id: 'cell.filter' } // no `checks` key — the pre-move shape
  a.viewSpecs['cell-filter'] = { id: 'cell.filter', checks: [{ id: 'a' }] }

  // Depth 1 — `cell-filter/checks` — is the exact shape that made the old device blind.
  const blanket = evaluate(b, a, [specEntry(b, a, 'cell-filter/checks')])
  assert.equal(blanket.ok, false)
  assert.deepEqual(blanket.blanketPermits, ['cell-filter/checks'])

  // Declared ON PURPOSE it is permitted, and the comparison PASSES — the point is that a
  // blanket permit must be said out loud, not that it is forbidden.
  const onPurpose = evaluate(b, a, [specEntry(b, a, 'cell-filter/checks', { blanket: true })])
  assert.equal(onPurpose.blanketPermits.length, 0)
  assert.equal(onPurpose.ok, true)
})

test('a deep viewSpecs allowance is accepted without a blanket marker', () => {
  const b = full()
  const a = full()
  b.viewSpecs.qc = { id: 'qc', widgets: [{ id: 'w', title: 'before' }] }
  a.viewSpecs.qc = { id: 'qc', widgets: [{ id: 'w', title: 'after' }] }
  // `#w` rather than `0`: the widget is named by its authored id (see the identity section
  // below). The DEPTH the blanket rule reads is unchanged — one segment per element, keyed
  // or not — which is exactly why re-keying could not weaken that guard.
  const r = evaluate(b, a, [specEntry(b, a, 'qc/widgets/#w/title')])
  assert.equal(allowanceDepth('qc/widgets/#w/title'), 3)
  assert.equal(r.ok, true)
  assert.equal(r.blanketPermits.length, 0)
})

test('CONTENT-BINDING: an allowance permits ONE change, not a path — at ANY depth', () => {
  // The depth rule alone cannot close this: `dkey` is facet:kind:name and ignores content,
  // so a DEEP allowance would otherwise stand permit over whatever that path later becomes.
  // Depth 3 was the modal depth in the old manifest, so this is the common case.
  const b = full()
  b.viewSpecs.qc = { id: 'qc', widgets: [{ id: 'w' }] }
  const a1 = full()
  a1.viewSpecs.qc = { id: 'qc', widgets: [{ id: 'w', options: { a: 1 } }] }
  const a2 = full()
  a2.viewSpecs.qc = { id: 'qc', widgets: [{ id: 'w', options: { a: 2, evil: 'anything at all' } }] }

  const allowance = specEntry(b, a1, 'qc/widgets/#w/options')
  assert.equal(allowanceDepth('qc/widgets/#w/options'), 3, 'deep enough to clear the blanket rule')
  assert.equal(evaluate(b, a1, [allowance]).ok, true, 'the change it was written for passes')

  // Same facet, same kind, same pointer — a DIFFERENT change. Without content-binding this
  // is byte-identical to the allowed case as far as allowance matching is concerned.
  const reused = evaluate(b, a2, [allowance])
  assert.equal(reused.unexpected.length, 0, 'the key still matches — which is the whole problem')
  assert.equal(reused.blanketPermits.length, 0, 'and the depth rule does not fire')
  assert.equal(reused.ok, false, 'so content-binding is what has to catch it')
  assert.equal(reused.contentMismatch.length, 1)
  assert.match(reused.contentMismatch[0], /qc\/widgets\/#w\/options/)
})

test('THE REGRESSION: a brand-new check in a shipped spec is REPORTED, not absorbed', () => {
  // The experiment that exposed the hole, in miniature. Against the re-captured
  // (same-shape) baseline a new check produces its own pointer and fails an empty
  // manifest — which is the whole point of re-capturing.
  const b = full()
  const a = full()
  b.viewSpecs['cell-filter'] = { id: 'cell.filter', checks: [{ id: 'minAboveMax' }, { id: 'columnOffAxis' }] }
  a.viewSpecs['cell-filter'] = {
    id: 'cell.filter',
    checks: [{ id: 'minAboveMax' }, { id: 'columnOffAxis' }, { id: 'probeInsertedCheck', fails_when: 'x' }],
  }

  const r = evaluate(b, a, [])
  assert.equal(r.ok, false, 'a new check must fail an empty manifest')
  // Named by the check that arrived, not by the slot it landed in — the same regression,
  // reported at an identity that survives the next insertion above it.
  assert.deepEqual(r.unexpected.map(d => d.name), ['cell-filter/checks/#probeInsertedCheck'])

  // And an allowance for an UNRELATED check does not cover it.
  const other = evaluate(b, a, [
    entry({ facet: 'viewSpecs', kind: 'changed', name: 'cell-filter/checks/#minAboveMax/id', detail: 'x -> y' }),
  ])
  assert.ok(other.unexpected.some(d => d.name === 'cell-filter/checks/#probeInsertedCheck'))
})

test('THE ABSORPTION MECHANISM: a shallow allowance makes an entire subtree permanently invisible', () => {
  // This is HOW the old device went blind, reproduced exactly rather than described.
  // `checks:` did not exist in the pre-refactor lowered spec at all, so `pointerDiff` —
  // which reports the SHALLOWEST differing path — collapsed the whole array into ONE
  // entry, `cell-filter/checks`. That entry was declared. Adding a check therefore did
  // not change the reported diff SET, so the gate had nothing new to report: measured on
  // the real tree, "602 differences; 0 UNEXPECTED".
  const b = full()
  b.viewSpecs['cell-filter'] = { id: 'cell.filter' } // no `checks` key — the pre shape
  const withTwo = full()
  withTwo.viewSpecs['cell-filter'] = { id: 'cell.filter', checks: [{ id: 'one' }, { id: 'two' }] }
  const withThree = full()
  withThree.viewSpecs['cell-filter'] = {
    id: 'cell.filter',
    checks: [{ id: 'one' }, { id: 'two' }, { id: 'BRAND_NEW' }],
  }

  // The diff KEY SET is identical either way — the new check is genuinely invisible to
  // allowance matching. This assertion is the bug, stated as a fact about the algorithm.
  const keys = f => diffFacets(b, f).map(d => `${d.facet}:${d.kind}:${d.name}`)
  assert.deepEqual(keys(withTwo), ['viewSpecs:changed:cell-filter/checks'])
  assert.deepEqual(keys(withThree), keys(withTwo), 'adding a check does not change the reported pointer')

  // So allowance matching ALONE cannot save us, and the old device had only that: the
  // allowance written for TWO checks matches when there are THREE, and the third sails
  // through `unexpected[]`.
  const shallow = [specEntry(b, withTwo, 'cell-filter/checks')]
  assert.equal(evaluate(b, withThree, shallow).unexpected.length, 0, 'unexpected[] cannot see it — by construction')

  // Two independent narrowings catch it. Content-binding fires because the `detail` the
  // allowance was written for is not what the tree now shows…
  const r = evaluate(b, withThree, shallow)
  assert.equal(r.ok, false)
  assert.equal(r.contentMismatch.length, 1)
  // …and the depth rule refuses the allowance outright, which is the backstop for the case
  // where the subtree is large enough that `detail`'s 200-char truncation stops discriminating.
  assert.deepEqual(r.blanketPermits, ['cell-filter/checks'])
})

// --- fail-closed on a collapsed scan set --------------------------------------------

test('RED: a facet below its committed floor throws instead of reporting identity', () => {
  for (const k of Object.keys(FLOORS)) {
    const f = full()
    f[k] = Array.isArray(f[k]) ? [] : {}
    assert.throws(
      () => assertFloors(f, 'synthetic'),
      /SCAN SET COLLAPSED/,
      `floor for ${k} does not fire when the facet is empty`,
    )
  }
})

test('RED: a facet that merely SHRANK below the floor also throws', () => {
  const f = full()
  f.apiDeclaredExports = f.apiDeclaredExports.slice(0, FLOORS.apiDeclaredExports - 1)
  assert.throws(() => assertFloors(f, 'synthetic'), /SCAN SET COLLAPSED/)
})

test('a full synthetic capture passes the floors', () => {
  assertFloors(full(), 'synthetic')
})

// --- collapse vs change: the floor stops answering the wrong question ------------------
//
// `contributionKinds` sits at EXACTLY its committed floor (3), so the next legitimate
// removal used to ABORT the capture rather than report a difference — the operator saw the
// tool refusing to run instead of a diff naming what changed. The floor is unchanged and
// unlowered; what changed is WHICH QUESTION it is asked. "Did the scan load anything?"
// cannot be answered by a fixed number for a facet whose healthy population IS a handful,
// so where a REFERENCE population exists (the baseline being compared against, or the
// baseline being re-captured over) the question is asked of retention instead.

test('RED: a facet that falls by ONE from a healthy reference is a DIFFERENCE, not a collapse', () => {
  const reference = full()
  const now = full()
  now.contributionKinds = reference.contributionKinds.slice(0, 2)

  // Two below the committed floor of 3 — and NOT a collapse, because two thirds of the
  // population is still there.
  assert.ok(now.contributionKinds.length < FLOORS.contributionKinds)
  assert.doesNotThrow(() => assertPopulations(now, reference, 'synthetic'))

  // …and it comes out the far end as what it is: a named removal the manifest must declare.
  const r = evaluate(reference, now, [])
  assert.deepEqual(
    r.unexpected.map(d => `${d.facet}:${d.kind}:${d.name}`),
    ['contributionKinds:removed:statusBarItems'],
  )
  assert.equal(r.ok, false, 'still a failure — but one that NAMES the change')
})

test('RED: a facet that collapses against the same reference still ABORTS', () => {
  const reference = full()
  for (const remaining of [1, 0]) {
    const now = full()
    now.contributionKinds = reference.contributionKinds.slice(0, remaining)
    assert.throws(
      () => assertPopulations(now, reference, 'synthetic'),
      /SCAN SET COLLAPSED/,
      `${remaining} of ${reference.contributionKinds.length} left must still read as a collapse`,
    )
  }
})

test('RED: the relative rule BITES on a well-populated facet the flat floor would wave through', () => {
  // The real shape: `apiDeclaredExports` has a floor of 80 against a population of 223, so
  // more than half of the barrel can vanish while still clearing the flat floor. That is a
  // broken load wearing a refactor's clothes, and the floor waves it through — the relative
  // rule is STRICTER here, which is the other half of the trade.
  const reference = { ...full(), apiDeclaredExports: Array.from({ length: 223 }, (_, i) => `d${i}`) }
  const now = { ...full(), apiDeclaredExports: reference.apiDeclaredExports.slice(0, FLOORS.apiDeclaredExports + 1) }
  assert.doesNotThrow(() => assertFloors(now, 'synthetic'), 'the flat floor is satisfied')
  assert.throws(() => assertPopulations(now, reference, 'synthetic'), /SCAN SET COLLAPSED/)
})

test('a facet the reference does not carry falls back to the committed floor', () => {
  const reference = full()
  delete reference.contributionKinds
  const now = full()
  now.contributionKinds = ['analyses']
  assert.throws(() => assertPopulations(now, reference, 'synthetic'), /SCAN SET COLLAPSED/)
  assert.doesNotThrow(() => assertPopulations(full(), reference, 'synthetic'))
})

test('assertFloors is exactly the reference-less case, so the two rules cannot drift apart', () => {
  const f = full()
  f.paneKinds = []
  let fromFloors
  let fromPopulations
  try {
    assertFloors(f, 'synthetic')
  } catch (e) {
    fromFloors = e.message
  }
  try {
    assertPopulations(f, null, 'synthetic')
  } catch (e) {
    fromPopulations = e.message
  }
  assert.equal(fromPopulations, fromFloors)
  assert.match(String(fromFloors), /SCAN SET COLLAPSED/)
})

/** Inflate one facet of the committed baseline past twice its real size, and write it to a
 *  temp file. The real tree then RETAINS less than half of it, so any code path that uses
 *  this file as a reference must read the tree as collapsed. */
function inflatedBaselineFile(facet = 'paneKinds') {
  const real = JSON.parse(readFileSync(BASELINE, 'utf8'))
  const grown = [...real.facets[facet]]
  while (grown.length < real.facets[facet].length * 2 + 2) grown.push(`synthetic-${facet}-${grown.length}`)
  const tmp = join(mkdtempSync(join(tmpdir(), 'surface-baseline-')), 'inflated.json')
  writeFileSync(tmp, JSON.stringify({ ...real, facets: { ...real.facets, [facet]: grown } }))
  return tmp
}

const cli = (...args) =>
  spawnSync(process.execPath, [join(HERE, 'capture-surface-baseline.mjs'), ...args], { cwd: UI, encoding: 'utf8' })

test('RED: a TRUNCATED baseline file aborts the comparison outright', () => {
  // The baseline has nothing behind it to be relative to, so it keeps the ABSOLUTE floor —
  // and it must fail as a collapsed SCAN SET, not as "the tree grew 400 exports".
  const tmp = join(mkdtempSync(join(tmpdir(), 'surface-baseline-')), 'truncated.json')
  const real = JSON.parse(readFileSync(BASELINE, 'utf8'))
  writeFileSync(tmp, JSON.stringify({ ...real, facets: { ...real.facets, paneKinds: [] } }))
  const r = cli('compare', '--baseline', tmp)
  assert.notEqual(r.status, 0)
  assert.match(r.stderr + r.stdout, /SCAN SET COLLAPSED in BASELINE/)
})

test('RED: a RE-CAPTURE measures itself against the baseline it is about to replace', () => {
  // `capture --out <existing>` overwrites the last healthy scan of this same tree, which is
  // a better collapse detector than a fixed number — and is what lets a legitimate removal
  // be re-captured at all. If the CLI stopped reading it, the tree would clear the flat
  // floor and a broken scan would be written over the good one.
  const tmp = inflatedBaselineFile()
  const r = cli('capture', '--out', tmp)
  assert.notEqual(r.status, 0, 'a capture that retains less than half the previous population must abort')
  assert.match(r.stderr + r.stdout, /SCAN SET COLLAPSED/)
  assert.equal(
    JSON.parse(readFileSync(tmp, 'utf8')).facets.paneKinds.length > 20,
    true,
    'and it must not have overwritten the file it refused',
  )
})

test('RED: `compare` measures the current tree against the BASELINE population, not the flat floor', () => {
  // The wiring, held open by a fixture rather than argued: a baseline whose facet is more
  // than twice the real tree's makes the REAL capture read as collapsed. If `compare`
  // stopped threading the baseline through — the one line that could silently revert this —
  // the tree would clear the flat floor (paneKinds 15 >= 10) and the run would proceed.
  const r = cli('compare', '--baseline', inflatedBaselineFile())
  assert.notEqual(r.status, 0, 'a collapsed comparison must exit non-zero')
  assert.match(r.stderr + r.stdout, /SCAN SET COLLAPSED in capture of/)
})

// --- the diff itself -----------------------------------------------------------------

test('RED: a symbol dropped from the barrel is reported removed', () => {
  const b = full()
  const a = full()
  a.apiDeclaredExports = a.apiDeclaredExports.filter(x => x !== 'd7')
  const diffs = diffFacets(b, a)
  assert.equal(diffs.length, 1)
  assert.deepEqual(diffs[0], { facet: 'apiDeclaredExports', kind: 'removed', name: 'd7' })
})

test('RED: a widget kind that stops being registered is reported removed', () => {
  const b = full()
  const a = full()
  a.widgetKinds = a.widgetKinds.filter(x => x !== 'w3')
  const diffs = diffFacets(b, a)
  assert.deepEqual(
    diffs.map(d => `${d.facet}:${d.kind}:${d.name}`),
    ['widgetKinds:removed:w3'],
  )
})

test('two identical captures diff to nothing', () => {
  assert.equal(diffFacets(full(), full()).length, 0)
  assert.equal(evaluate(full(), full(), []).ok, true, 'and an empty manifest is the steady state')
})

test('RED: a lowered view_spec change is reported at JSON-Pointer granularity', () => {
  const b = full()
  const a = full()
  a.viewSpecs['cell-filter'] = { id: 'cell.filter', title: 'new' }
  const diffs = diffFacets(b, a)
  assert.equal(diffs.length, 1)
  assert.equal(diffs[0].facet, 'viewSpecs')
  assert.equal(diffs[0].name, 'cell-filter/title', 'the path must name the changed key, not the whole spec')
})

test('RED: TWO unrelated changes to one spec are TWO allowances, not one blanket "changed"', () => {
  const b = full()
  const a = full()
  b.viewSpecs.qc = { id: 'qc', title: 't', permission: 'p' }
  a.viewSpecs.qc = { id: 'qc', title: 'CHANGED', permission: 'ALSO-CHANGED' }
  const names = diffFacets(b, a)
    .map(d => d.name)
    .sort()
  assert.deepEqual(names, ['qc/permission', 'qc/title'])
})

test('RED: a slash-bearing spec key cannot inflate its depth past the blanket guard', () => {
  // `state`/`data`/`derived`/`const` keys are free-form, so `report/qc` is expressible (the
  // domain ledger shows this fixture has carried exactly that token). Unescaped, its pointer
  // would read as depth 2 and slip a guard meant to fire at depth 1.
  const b = full()
  const a = full()
  b.viewSpecs.qc = { id: 'qc' }
  a.viewSpecs.qc = { id: 'qc', 'report/qc': { anything: 1 } }
  const d = diffFacets(b, a).find(x => x.facet === 'viewSpecs')
  assert.equal(d.name, 'qc/report~1qc', 'the `/` in the KEY must be RFC-6901 escaped, not emitted raw')
  assert.equal(allowanceDepth(d.name), 1, 'so it is still one segment below the spec')
  const r = evaluate(b, a, [entry({ facet: 'viewSpecs', kind: 'changed', name: d.name, detail: d.detail })])
  assert.deepEqual(r.blanketPermits, [d.name], 'and the blanket guard still fires on it')
})

test('an added array element is ONE entry, not one per leaf — keyed or positional', () => {
  const b = full()
  const a = full()
  b.viewSpecs.qc = { id: 'qc', actions: [{ id: 'a' }] }
  a.viewSpecs.qc = { id: 'qc', actions: [{ id: 'a' }, { id: 'b', body: [1, 2, 3] }] }
  const diffs = diffFacets(b, a)
  assert.equal(diffs.length, 1)
  assert.equal(diffs[0].name, 'qc/actions/#b')

  // The same collapse holds on the POSITIONAL branch, which id-keying did not replace: an
  // appended id-less step is still one entry, not one per leaf.
  const b2 = full()
  const a2 = full()
  b2.viewSpecs.qc = { id: 'qc', actions: [{ id: 'a', body: [{ set: { x: 1 } }] }] }
  a2.viewSpecs.qc = { id: 'qc', actions: [{ id: 'a', body: [{ set: { x: 1 } }, { run: { deep: { er: [1, 2] } } }] }] }
  const d2 = diffFacets(b2, a2)
  assert.equal(d2.length, 1)
  assert.equal(d2[0].name, 'qc/actions/#a/body/1')
})

// --- IDENTITY, not position: an insertion is ONE difference ---------------------------
//
// THE DEFECT THESE PIN. `pointerDiff` compared array elements POSITIONALLY, so inserting
// one widget at index N reported every element after N as changed. Measured on the real
// tree: adding ONE alert to `cell-filter.yaml` demanded 72 allowances — 71 pure
// renumbering plus 1 blanket for the shifted trailing element — instead of the 1 real
// difference. 71 meaningless entries is not a manifest anyone reads; it is the same
// failure mode as the whole-subtree blanket permits removed in f5943a4d, arrived at from
// the other direction.
//
// An array is IDENTITY-KEYED when every element on BOTH sides is an object carrying a
// non-empty string `id` unique within its own side — which is exactly `widgets`, `checks`,
// `actions`, `canvas/datasets` and `canvas/series`, and is NOT `columns`, `parts`, `body`,
// `switchTo` or any array of primitives. Anything else keeps the positional rule.
//
// The keyed segment is `#<id>` and not the bare id: a bare id would be indistinguishable
// from an array INDEX, so an allowance written for positional `/widgets/2` would silently
// match a keyed element whose id happens to be the string "2".

const names = (b, a) =>
  diffFacets(b, a)
    .map(d => d.name)
    .sort()

test('RED: inserting a widget mid-array is ONE difference, and its siblings are untouched', () => {
  const b = full()
  const a = full()
  b.viewSpecs.qc = { id: 'qc', widgets: [{ id: 'w0' }, { id: 'w1' }, { id: 'w2' }, { id: 'w3' }] }
  a.viewSpecs.qc = {
    id: 'qc',
    widgets: [{ id: 'w0' }, { id: 'inserted', kind: 'alert' }, { id: 'w1' }, { id: 'w2' }, { id: 'w3' }],
  }
  assert.deepEqual(names(b, a), ['qc/widgets/#inserted'])
})

test('RED: THE MEASURED DEFECT — one widget inserted into the REAL captured spec is ONE difference', () => {
  // The experiment that exposed it, against the committed capture of main rather than a
  // 4-element toy: this is the 72 the manifest actually had to carry.
  const b = JSON.parse(readFileSync(BASELINE, 'utf8')).facets
  const a = structuredClone(b)
  a.viewSpecs['cell-filter'].widgets.splice(2, 0, {
    id: 'probeInsertedWidget',
    kind: 'alert',
    text: 'a probe, inserted where the renumbering used to start',
  })
  assert.deepEqual(
    diffFacets(b, a).map(d => `${d.facet}:${d.kind}:${d.name}`),
    ['viewSpecs:changed:cell-filter/widgets/#probeInsertedWidget'],
  )
  // …and it is still a CHANGE that must be declared: fewer entries, not a weaker gate.
  assert.equal(evaluate(b, a, []).ok, false)
})

test('RED: a real edit to a surviving sibling is still reported, named by the id that owns it', () => {
  // The property an insertion must not swallow: renumbering goes away, real content
  // changes do not. Both differences are reported, each against its own element.
  const b = full()
  const a = full()
  b.viewSpecs.qc = { id: 'qc', widgets: [{ id: 'w0' }, { id: 'w1', title: 'before' }] }
  a.viewSpecs.qc = { id: 'qc', widgets: [{ id: 'inserted' }, { id: 'w0' }, { id: 'w1', title: 'after' }] }
  assert.deepEqual(names(b, a), ['qc/widgets/#inserted', 'qc/widgets/#w1/title'])
})

test('RED: removing a widget names the widget that LEFT, not the index it vacated', () => {
  const b = full()
  const a = full()
  b.viewSpecs.qc = { id: 'qc', widgets: [{ id: 'w0' }, { id: 'doomed' }, { id: 'w2' }] }
  a.viewSpecs.qc = { id: 'qc', widgets: [{ id: 'w0' }, { id: 'w2' }] }
  const d = diffFacets(b, a)
  assert.deepEqual(
    d.map(x => x.name),
    ['qc/widgets/#doomed'],
  )
  assert.match(d[0].detail, /^removed: /)
})

test('RED: REORDERING widgets with no content change is a surface change, and is REPORTED', () => {
  // Keying by id would otherwise make render ORDER invisible — a real regression traded
  // for the noise fix. The order of the SURVIVING elements is compared in its own right,
  // so a swap is one difference at the array itself.
  const b = full()
  const a = full()
  b.viewSpecs.qc = { id: 'qc', widgets: [{ id: 'first' }, { id: 'second' }, { id: 'third' }] }
  a.viewSpecs.qc = { id: 'qc', widgets: [{ id: 'second' }, { id: 'first' }, { id: 'third' }] }
  const d = diffFacets(b, a)
  assert.deepEqual(
    d.map(x => x.name),
    ['qc/widgets'],
  )
  assert.match(d[0].detail, /^reordered: /)
  assert.equal(evaluate(b, a, []).ok, false, 'and it fails an empty manifest like any other change')
})

test('RED: an insertion alone is NOT a reorder — the comparison is of the SURVIVING order', () => {
  // The over-strict mistake this rules out: comparing the FULL id sequences would report
  // every insertion as a reorder too, and the 1-entry result would be 2.
  const b = full()
  const a = full()
  b.viewSpecs.qc = { id: 'qc', widgets: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }
  a.viewSpecs.qc = { id: 'qc', widgets: [{ id: 'a' }, { id: 'b' }, { id: 'NEW' }, { id: 'c' }] }
  assert.deepEqual(names(b, a), ['qc/widgets/#NEW'])
})

test('RED: an id-keyed pointer is still bound to ONE change, and still blanket-guarded', () => {
  // The two f5943a4d narrowings must survive the re-keying. `qc/widgets/#w` is depth 2 —
  // a whole list element, where `detail`'s 200-char truncation stops discriminating — so
  // it must say `blanket: true` out loud exactly as `qc/widgets/1` had to.
  const b = full()
  const a = full()
  b.viewSpecs.qc = { id: 'qc', widgets: [{ id: 'keeper' }] }
  a.viewSpecs.qc = { id: 'qc', widgets: [{ id: 'keeper' }, { id: 'w' }] }
  assert.equal(allowanceDepth('qc/widgets/#w'), 2)
  const bare = evaluate(b, a, [specEntry(b, a, 'qc/widgets/#w')])
  assert.deepEqual(bare.blanketPermits, ['qc/widgets/#w'])
  assert.equal(bare.ok, false)
  assert.equal(evaluate(b, a, [specEntry(b, a, 'qc/widgets/#w', { blanket: true })]).ok, true)

  // …and content-binding still fires on a keyed pointer reused for a different change.
  const a2 = full()
  a2.viewSpecs.qc = { id: 'qc', widgets: [{ id: 'keeper' }, { id: 'w', kind: 'something else entirely' }] }
  const reused = evaluate(b, a2, [specEntry(b, a, 'qc/widgets/#w', { blanket: true })])
  assert.equal(reused.unexpected.length, 0, 'the key matches — which is why content-binding is what catches it')
  assert.equal(reused.contentMismatch.length, 1)
  assert.equal(reused.ok, false)
})

// --- and where identity is NOT available, the positional rule is unchanged ------------

test('an array whose elements carry no id keeps POSITIONAL pointers', () => {
  // `body` steps, `columns`, `parts`, `switchTo` — none of them are authored with an id,
  // and inventing one for them is not this change. Note the OUTER array is keyed and the
  // INNER one is not, in a single pointer.
  const b = full()
  const a = full()
  b.viewSpecs.qc = { id: 'qc', actions: [{ id: 'qc.run', body: [{ set: { x: 1 } }] }] }
  a.viewSpecs.qc = { id: 'qc', actions: [{ id: 'qc.run', body: [{ set: { x: 1 } }, { set: { y: 2 } }] }] }
  assert.deepEqual(names(b, a), ['qc/actions/#qc.run/body/1'])
})

test('an array of PRIMITIVES keeps positional pointers', () => {
  // `state.qc_metrics.default` and `const.aggregations` are string lists; asking a string
  // for its `.id` is how a naive keying rule silently collapses them into one element.
  const b = full()
  const a = full()
  b.viewSpecs.qc = { id: 'qc', const: { aggregations: ['mean', 'median', 'sum'] } }
  a.viewSpecs.qc = { id: 'qc', const: { aggregations: ['mean', 'MEDIAN', 'sum'] } }
  assert.deepEqual(names(b, a), ['qc/const/aggregations/1'])
})

test('a MIXED array — some elements with an id, some without — keeps positional pointers', () => {
  const b = full()
  const a = full()
  b.viewSpecs.qc = { id: 'qc', widgets: [{ id: 'w0' }, { kind: 'anonymous' }] }
  a.viewSpecs.qc = { id: 'qc', widgets: [{ id: 'w0' }, { kind: 'ANONYMOUS' }] }
  assert.deepEqual(names(b, a), ['qc/widgets/1/kind'])
})

test('RED: DUPLICATE ids fall back to positional rather than dropping an element', () => {
  // Ids are unique by convention, not by construction. Keyed by a Map, a duplicate would
  // silently overwrite its twin and the second element would stop being compared at all.
  const b = full()
  const a = full()
  b.viewSpecs.qc = { id: 'qc', widgets: [{ id: 'dup', v: 1 }, { id: 'dup', v: 2 }] }
  a.viewSpecs.qc = { id: 'qc', widgets: [{ id: 'dup', v: 1 }, { id: 'dup', v: 3 }] }
  assert.deepEqual(names(b, a), ['qc/widgets/1/v'], 'the SECOND duplicate must still be compared')
})

test('RED: a slash- or tilde-bearing id is RFC-6901 escaped, so it cannot inflate its depth', () => {
  // Ids are author-controlled strings. Unescaped, `a/b` would read as two segments and a
  // depth-2 whole-element allowance would present itself as a depth-3 leaf, slipping the
  // blanket guard — the same hole `report/qc` opened on the object side.
  const b = full()
  const a = full()
  b.viewSpecs.qc = { id: 'qc', widgets: [{ id: 'keeper' }] }
  a.viewSpecs.qc = { id: 'qc', widgets: [{ id: 'keeper' }, { id: 'a/b~c' }] }
  const d = diffFacets(b, a)
  assert.deepEqual(
    d.map(x => x.name),
    ['qc/widgets/#a~1b~0c'],
  )
  assert.equal(allowanceDepth(d[0].name), 2, 'still ONE segment below the array, so the blanket guard fires')
  assert.deepEqual(evaluate(b, a, [specEntry(b, a, d[0].name)]).blanketPermits, [d[0].name])
})

test('RED: a keyed pointer cannot be confused with a positional one', () => {
  // Ids are strings, and "2" is a string. Without the `#` marker, an allowance written
  // for positional `qc/widgets/2` would match the element whose id is "2" — two different
  // elements sharing one permit.
  const b = full()
  const a = full()
  b.viewSpecs.qc = { id: 'qc', widgets: [{ id: '2', v: 1 }] }
  a.viewSpecs.qc = { id: 'qc', widgets: [{ id: '2', v: 9 }] }
  assert.deepEqual(names(b, a), ['qc/widgets/#2/v'])
})

// --- tree-shape detection spans the move ---------------------------------------------

test('the layout detector recognises THIS (post-refactor) tree', () => {
  const L = detectLayout(REPO)
  assert.equal(L.layout, 'post')
  for (const k of ['barrel', 'extBarrel', 'paneModel', 'installWidgets', 'widgetRegistry', 'schema'])
    assert.ok(existsSync(L[k]), `detected ${k} does not exist: ${L[k]}`)
})

test('RED: an unrecognised tree throws rather than capturing an empty surface', () => {
  assert.throws(() => detectLayout('/nonexistent-root-for-test'), /no recognised workbench layout/)
})
