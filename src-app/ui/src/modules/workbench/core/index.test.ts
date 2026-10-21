// TEST-1 (ITEM-1) — the public barrel re-exports the full surface + every
// declared `exports` subpath resolves under the node:test strip-types runner.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  WORKBENCH_API_VERSION,
  isApiVersionCompatible,
  Registry,
  workbenchRegistry,
  createWorkbenchApi,
  validateManifest,
  buildContributionCatalog,
  evaluateWhen,
  MANIFEST_SCHEMA,
} from './index.ts'

test('TEST-1: the public barrel exports the full surface', () => {
  assert.equal(WORKBENCH_API_VERSION, '1.0.0')
  assert.equal(typeof isApiVersionCompatible, 'function')
  assert.equal(typeof Registry, 'function')
  assert.ok(workbenchRegistry.analyses)
  assert.equal(typeof createWorkbenchApi, 'function')
  assert.equal(typeof validateManifest, 'function')
  assert.equal(typeof buildContributionCatalog, 'function')
  assert.equal(typeof evaluateWhen, 'function')
})

test('TEST-1: the published manifest schema is importable JSON', () => {
  assert.equal((MANIFEST_SCHEMA as { title: string }).title, 'CytoAnalyst extension manifest')
})

// TEST-1's second + third clauses (ITEM-1 / ITEM-22), which the spot-checks above do not
// carry: SET EQUALITY of this barrel against a captured baseline, and ZERO remaining
// `@cyto/workbench-api` importers.
//
// Neither is re-implemented here — both are already enforced, and pointing at the
// enforcement is more honest than a second, weaker copy of it:
//   * set equality → `scripts/capture-surface-baseline.mjs compare` diffs this barrel's
//     full DECLARED export set (types included, `export * from` followed transitively)
//     against the surface captured from origin/main, and FAILS on any difference not
//     declared in `surface-baseline-expected-delta.json`;
//   * zero importers → `core/aliasRemoval.test.ts` scans ui/src + ui/tests (≥700 files)
//     and additionally proves the specifier is UNRESOLVABLE from the ui workspace.
//
// What this asserts is that those two devices EXIST and are wired, so TEST-1 cannot be
// satisfied by a barrel that quietly stopped being compared to anything.
//
// RE-CAPTURED 2026-08-10. This test used to pin the baseline to `layout: 'pre'` at commit
// 06d99c65 and to exactly 280 declared exports — the PRE-`processor-ui-language` snapshot
// that carried the round's INV-4 equivalence argument. That baseline had gone blind (28 of
// its 257 viewSpecs allowances were depth-≤2 blanket permits, under which a brand-new
// schema-valid `check` in a shipped ui/*.yaml produced ZERO unexpected differences), so it
// was re-captured against current main and the equivalence argument was retired. The pins
// below are therefore properties that survive a re-capture — the baseline is REAL, it is
// the SAME TREE SHAPE as the tree it gates, and it is WIRED — rather than a transcription
// of one snapshot's numbers, which is what made re-capturing a test rewrite.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const T1_HERE = path.dirname(fileURLToPath(import.meta.url))
const T1_UI = path.resolve(T1_HERE, '../../../..')

test('TEST-1: the barrel is compared to a REAL baseline captured from main, and it is wired', () => {
  const fixture = path.join(T1_HERE, '__fixtures__/surface-baseline.main.json')
  assert.ok(existsSync(fixture), 'the barrel baseline fixture is missing')
  const baseline = JSON.parse(readFileSync(fixture, 'utf8'))
  assert.match(
    baseline.capturedFrom.commit,
    /^[0-9a-f]{40}$/,
    'the baseline must record the real commit it was captured from',
  )
  assert.equal(
    baseline.capturedFrom.barrel,
    'src-app/ui/src/modules/workbench/core/index.ts',
    'the baseline must be a capture of THIS barrel',
  )
  // POSITIVE COUNT, not an exact transcription: a truncated fixture would make the
  // set-equality comparison trivially satisfiable, and that is the property worth pinning.
  // The exact count is owned by the fixture and by capture-surface-baseline.test.mjs's
  // floor check, so a legitimate re-capture is not a test rewrite.
  assert.ok(
    baseline.facets.apiDeclaredExports.length >= 150,
    `the baseline declares only ${baseline.facets.apiDeclaredExports.length} symbols — truncated?`,
  )
  assert.ok(baseline.facets.apiValueExports.length >= 80)

  // The comparison is a wired gate, not a script nobody runs.
  const pkg = JSON.parse(readFileSync(path.join(T1_UI, 'package.json'), 'utf8'))
  assert.ok(pkg.scripts['check:surface-baseline'], 'the baseline comparison is not an npm script')
  assert.match(pkg.scripts['check:surface-baseline'], /capture-surface-baseline\.mjs compare/)
  assert.ok(existsSync(path.join(T1_UI, 'scripts/surface-baseline-expected-delta.json')))
})

test('TEST-1: the zero-importer scan exists and is a real scan', () => {
  const spec = path.join(T1_HERE, 'aliasRemoval.test.ts')
  assert.ok(existsSync(spec), 'the alias-removal suite is missing')
  const src = readFileSync(spec, 'utf8')
  assert.match(src, /scan set collapsed/, 'the importer scan must carry a positive-count floor')
  assert.match(src, /MODULE_NOT_FOUND/, 'the specifier must be proven UNRESOLVABLE, not merely unused')
})

// ══════════════════════════════════════════════════════════════════════════════════════════
// TEST-31 (binding-origin / ITEM-23) — the ratchet is resolved by DECLARATION, not by muting.
//
// Two ratchets move when a new symbol leaves the `core` barrel: `check:surface-baseline`
// (which fails on an UNDECLARED difference AND on a declared-but-absent one) and, for a new
// file, the domain guard's default-zero budget. Both were resolved, and this asserts HOW —
// because "the gate is green" is equally true of a gate that was widened, and the difference
// between those two is the whole point of having a ratchet.
// ══════════════════════════════════════════════════════════════════════════════════════════

test('TEST-31: the binding-origin vocabulary is exported from the barrel exactly once', async () => {
  const mod = (await import('./index.ts')) as Record<string, unknown>
  for (const name of ['ORIGIN_USER', 'ORIGIN_AUTO', 'strongerOrigin', 'BINDING_ORIGIN_COPY']) {
    assert.ok(name in mod, `${name} must reach the barrel — four surfaces read it, and two of them are extensions`)
  }
  // ONE definition, not a re-export of a second literal: the barrel's object must be the very
  // object the vocabulary module defines. Two copies of a mark's wording is the drift this
  // change exists to end, so it is asserted rather than trusted.
  const src = (await import('./runtime/bindingOrigin.ts')) as Record<string, unknown>
  assert.equal(mod.BINDING_ORIGIN_COPY, src.BINDING_ORIGIN_COPY, 'the barrel must re-export, not re-declare')
  assert.equal(mod.strongerOrigin, src.strongerOrigin)
})

test('TEST-31: every barrel-exported origin symbol is DECLARED in the surface-baseline delta', () => {
  // The ratchet's contract is symmetric — an undeclared difference fails, and a declared one
  // that never materializes fails too. This pins the first half from the code's side: a symbol
  // added to the barrel without a delta entry fails HERE, at the commit that adds it, rather
  // than in a gate run someone might be tempted to re-baseline.
  const deltaPath = path.join(T1_HERE, '../../../../scripts/surface-baseline-expected-delta.json')
  const declared = JSON.parse(readFileSync(deltaPath, 'utf8')) as {
    expected: Array<{ facet: string; name: string; item?: string; why?: string }>
  }
  const names = new Set(
    declared.expected.filter(e => e.facet === 'apiValueExports').map(e => e.name),
  )
  for (const name of ['ORIGIN_USER', 'ORIGIN_AUTO', 'strongerOrigin', 'BINDING_ORIGIN_COPY']) {
    assert.ok(names.has(name), `${name} is exported but not declared in the surface-baseline delta`)
  }
  // …and each declaration carries its authorising item + a reason. A delta entry with no
  // rationale is a mute wearing a longer file.
  for (const e of declared.expected.filter(x => names.has(x.name) && x.facet === 'apiValueExports')) {
    assert.ok(e.item, `${e.name} is declared with no authorising ITEM`)
    assert.ok((e.why ?? '').length > 40, `${e.name} is declared with no real rationale`)
  }
})

test('TEST-32: the vocabulary module needs NO domain-baseline entry (default-zero budget)', () => {
  // A new file's domain-token budget is zero, so a vocabulary module that named a domain noun
  // would have to be added to `domain-baseline.json` to pass. Asserting its ABSENCE from the
  // baseline is what proves the neutrality was achieved rather than recorded — the guard alone
  // cannot tell "clean" from "clean because it was granted an allowance".
  const baselinePath = path.join(T1_HERE, '../../../../scripts/domain-baseline.json')
  const raw = readFileSync(baselinePath, 'utf8')
  assert.ok(!raw.includes('bindingOrigin'), 'bindingOrigin.ts must carry no domain-baseline allowance')
})
