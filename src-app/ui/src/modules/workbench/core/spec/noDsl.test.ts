// TEST-20 (ITEM-4 / ITEM-18) + TEST-24 (ITEM-9 / ITEM-24) — the two big deletions are
// GONE from the frontend, not merely unreferenced.
//
// Both deletions are real today (verified by grep at phase 8), but nothing ASSERTED them:
// the coverage had collapsed from "a repo-wide guard" to "true if you go and look". That
// is the precise shape of every regression this round is guarding against — the deletion
// holds until the next refactor quietly reintroduces one of the names, and no gate speaks.
//
// So both are repo-wide scans over `core/**` + `extensions/**`, each with:
//   * a POSITIVE FILE COUNT, so a scan that collapsed cannot report "nothing forbidden
//     found" and read as compliance;
//   * a NEGATIVE CONTROL on the same scanner, so a typo in the forbidden vocabulary
//     cannot make it permanently, silently green;
//   * an OVER-DELETION guard — the things that must SURVIVE each deletion.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WB = path.resolve(HERE, '../..')
const UI_SRC = path.resolve(WB, '../..')

/** ITEM-4: the predicate DSL. A SECOND encoding of a filter whose real encoding is
 *  `criteria` — two encodings of one input can disagree, and repeatedly did. */
const DSL_SYMBOLS = [
  'CellSetPredicate',
  'criteriaToPredicate',
  'criteriaPredicate',
  'evalPredicate',
  'validatePredicate',
  'predicateToMethodsText',
  'DslOperatorRegistry',
  'seedDslOperators',
  'EVALUATOR_VERSION',
  'lassoToPredicate',
]

/** ITEM-9 / ITEM-24: the workbench selection feature. */
const SELECTION_SYMBOLS = [
  'SelectionApi',
  'SelectionRuntime',
  'SelectionActionContribution',
  'selectionActions',
  'createSelectionRuntime',
  'CellSet',
  'BrushRange',
  'cellSetSelectorCore',
]

/** `.ts`/`.tsx` production sources under `core/` + `extensions/`. Test files are excluded:
 *  a suite must be able to NAME a forbidden symbol in order to assert it is gone. */
function productionSources(): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    if (!existsSync(d)) return
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        walk(p)
        continue
      }
      if (!/\.(ts|tsx)$/.test(e.name)) continue
      if (/\.test\.(ts|tsx)$/.test(e.name)) continue
      out.push(p)
    }
  }
  walk(path.join(WB, 'core'))
  walk(path.join(WB, 'extensions'))
  return out
}

/** Executable code only — line + block comments stripped. Both deletions are explained at
 *  length in surviving comments ("ITEM-9 deleted the workbench SELECTION feature…"), and a
 *  scan that failed on those would force deleting the explanation to go green. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(l => !/^\s*\/\//.test(l))
    .join('\n')
}

/** Files whose executable code names any of `symbols`, with a letter boundary so
 *  `CellSet` does not claim `CellSettings`. */
function offenders(symbols: string[]): string[] {
  const re = new RegExp(`(?<![A-Za-z])(${symbols.join('|')})(?![A-Za-z])`)
  return productionSources()
    .filter(f => re.test(code(f)))
    .map(f => path.relative(WB, f))
}

test('the scan set is real (positive count) — shared precondition for both deletions', () => {
  const files = productionSources()
  assert.ok(
    files.length >= 180,
    `scan set collapsed: ${files.length} production file(s) under core/ + extensions/`,
  )
  assert.ok(files.some(f => f.includes('/core/')), 'core/ is in the scan')
  assert.ok(files.some(f => f.includes('/extensions/')), 'extensions/ is in the scan')
})

// ── TEST-20 — the DSL ────────────────────────────────────────────────────────

test('TEST-20: no production module under core/** or extensions/** names a DSL symbol', () => {
  assert.deepEqual(offenders(DSL_SYMBOLS), [], 'the predicate DSL survived ITEM-4 in these files')
})

test('TEST-20: the `dsl/` and `interaction/` directories are gone', () => {
  for (const d of ['core/dsl', 'core/interaction', 'dsl', 'interaction'])
    assert.equal(existsSync(path.join(WB, d)), false, `${d} still exists`)
})

test('TEST-20: `$derived.criteriaPredicate` resolves to nothing in either shipping spec', () => {
  // The specific site ITEM-4 removed: `cell-filter.yaml` lifted its criteria into a DSL
  // predicate and sent BOTH. Asserted on the shipping DATA, since that is what the
  // runtime actually reads.
  const processors = path.resolve(UI_SRC, '../../packages')
  const specs = ['cell-filter/ui/cell-filter.yaml', 'qc/ui/qc.yaml'].map(p => path.join(processors, p))
  for (const s of specs) assert.ok(existsSync(s), `shipping spec missing: ${s}`)
  for (const s of specs) {
    const src = readFileSync(s, 'utf8')
    const lines = src.split('\n').filter(l => !/^\s*#/.test(l))
    const hits = lines.filter(l => /criteriaPredicate|criteria_predicate/.test(l))
    assert.deepEqual(hits, [], `${path.basename(s)} still derives a predicate from its criteria`)
  }
  // Over-deletion guard, scoped to the spec that HAS a filter: `criteria` — the ONE
  // surviving encoding, the one the compute kernel reads — must still be there. (`qc.yaml`
  // is the metrics surface and carries no criteria at all, so asserting it there would be
  // asserting a fact about the wrong file.)
  const cf = readFileSync(specs[0], 'utf8')
  assert.ok(cf.includes('$state.criteria'), 'cell-filter.yaml lost its criteria encoding entirely')
})

test('TEST-20: the DSL scanner has a working negative control', () => {
  const re = new RegExp(`(?<![A-Za-z])(${DSL_SYMBOLS.join('|')})(?![A-Za-z])`)
  assert.ok(re.test('const p: CellSetPredicate = x'), 'scanner must catch a planted DSL symbol')
  assert.ok(re.test('import { evalPredicate } from "./x"'), 'scanner must catch an import')
  assert.ok(!re.test('const criteriaPredicateHelperName = 1'), 'letter boundary must hold')
})

// ── TEST-24 — the selection feature ─────────────────────────────────────────

test('TEST-24: no production module names a selection symbol', () => {
  assert.deepEqual(
    offenders(SELECTION_SYMBOLS),
    [],
    'the workbench selection feature survived ITEM-9 in these files',
  )
})

test('TEST-24: OVER-DELETION guard — @txresbench/viz still exports its own selection API', () => {
  // ITEM-9 deletes the WORKBENCH selection feature. The canvas library's own
  // point/lasso selection is a different thing and must NOT have gone with it — deleting
  // it would silently remove the ability to select anything on a plot at all.
  const vizSrc = path.resolve(UI_SRC, '../../libs/viz/src')
  assert.ok(existsSync(vizSrc), `@txresbench/viz sources not found at ${vizSrc}`)
  const found: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        walk(p)
        continue
      }
      if (!/\.(ts|tsx)$/.test(e.name) || /\.test\./.test(e.name)) continue
      if (/\btoIndices\b/.test(readFileSync(p, 'utf8'))) found.push(path.relative(vizSrc, p))
    }
  }
  walk(vizSrc)
  assert.ok(
    found.length >= 1,
    "@txresbench/viz's `toIndices` selection API is gone — ITEM-9 over-deleted past the workbench",
  )
})

test('TEST-24: the selection scanner has a working negative control', () => {
  const re = new RegExp(`(?<![A-Za-z])(${SELECTION_SYMBOLS.join('|')})(?![A-Za-z])`)
  assert.ok(re.test('export type X = { s: SelectionApi }'), 'scanner must catch a planted symbol')
  assert.ok(re.test('const keep: CellSet = y'), 'scanner must catch CellSet')
  assert.ok(!re.test('const CellSettings = {}'), 'letter boundary must hold — CellSettings is not CellSet')
})
