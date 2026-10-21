// The self-test for `lint-positional-declaration.mjs`.
//
// The discipline is the one `lint-no-domain-in-builtin.test.mjs` paid for twice: a guard
// that has never been OBSERVED failing on its motivating case is not evidence. So every
// acceptance here PLANTS the real shape and asserts the guard names it, each is paired
// with a NEGATIVE CONTROL in the same position and dialect that must NOT fire, and
// nothing is asserted against the guard's source TEXT — only against its exported
// behaviour, so a refactor of a branch cannot pass by keeping a comment alive.
//
// R20 §1 (inherited): this file never writes to a tracked file. Plants go into temp
// copies; the real tree is read-only here.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  CATALOG_COLLECTIONS,
  DECLARATION_SCHEMAS,
  MIN_DECLARED_FIELDS,
  STRUCTURE_COLLECTIONS,
  MIN_SCANNED_FILES,
  positionalScanSet,
  collectViolations,
  declaredCollectionFields,
  diffAgainstBaseline,
  scanFloorViolations,
  stripComments,
  violationKey,
} from './lint-positional-declaration.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UI_ROOT = path.resolve(__dirname, '..')
const SRC_APP = path.resolve(UI_ROOT, '..')
const OPENAPI = path.join(UI_ROOT, 'openapi', 'openapi.json')

const FIELDS = declaredCollectionFields(OPENAPI).fields

function withTmp(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'posdecl-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Write `src` as one scannable file and return the violations found in it. */
function scan(name, src) {
  return withTmp(dir => {
    const file = path.join(dir, name)
    writeFileSync(file, src)
    return collectViolations([{ path: file }], FIELDS)
  })
}

// ─────────────────────────── the derivation ───────────────────────────

test('[derivation] the field set is DERIVED from the contract, not hand-listed', () => {
  const { fields, missing } = declaredCollectionFields(OPENAPI)
  assert.deepEqual(missing, [], 'every DECLARATION_SCHEMAS name must resolve in the contract')
  assert.ok(fields.length >= MIN_DECLARED_FIELDS, `derived only ${fields.length} field(s)`)
  // The load-bearing one: `axes` is the field the guard exists for, and it is derived
  // (it is a property of the `Datatype`/`AxisSpec` schemas), never written down here.
  assert.ok(fields.includes('axes'), 'the derivation must reach `axes`')
  assert.ok(fields.includes('dims') && fields.includes('arrays'), 'and the sibling declarations')
  for (const stated of STRUCTURE_COLLECTIONS) assert.ok(fields.includes(stated))
})

test('[derivation] a schema that vanishes from the contract FAILS BY NAME, not silently', () => {
  withTmp(dir => {
    const spec = JSON.parse(readFileSync(OPENAPI, 'utf8'))
    delete spec.components.schemas.Datatype
    const p = path.join(dir, 'openapi.json')
    writeFileSync(p, JSON.stringify(spec))
    const { missing } = declaredCollectionFields(p)
    assert.deepEqual(missing, ['Datatype'])
  })
})

test('[derivation] an EMPTY contract collapses the field set below its floor', () => {
  withTmp(dir => {
    const p = path.join(dir, 'openapi.json')
    writeFileSync(p, JSON.stringify({ components: { schemas: {} } }))
    const { fields } = declaredCollectionFields(p)
    // Only the stated structure collections survive — well under the floor, which is
    // what makes `main()` refuse rather than pass having matched nothing.
    assert.ok(fields.length < MIN_DECLARED_FIELDS, `collapsed set was ${fields.length}`)
  })
})

// ─────────────────────── acceptance: the real leak ───────────────────────

test('[acceptance] FIRES on `rowAxisFor`s pre-fix form — the defect this guard is built from', () => {
  // Verbatim the line that shipped, and the reason the guard exists: it resolved a
  // datatype's ENTITY axis as its FIRST declared axis.
  const found = scan(
    'workbenchDataSource.ts',
    `const deps = {\n  rowAxisFor: id => datatypeRegistry.get(id)?.axes?.[0]?.name,\n}\n`,
  )
  assert.equal(found.length, 1)
  assert.equal(found[0].field, 'axes')
  assert.equal(found[0].index, 0)
  assert.equal(found[0].line, 2)
})

test('[acceptance] FIRES on `declaredAxisOf`s `structure.axes?.[0]` (the artifact-side twin)', () => {
  const found = scan(
    'workbenchDataSource.ts',
    `const declared = structure.kind === 'sparse_csc' ? structure.axes?.[0] : structure.axis\n`,
  )
  assert.equal(found.length, 1)
  assert.equal(found[0].field, 'axes')
})

test('[acceptance] FIRES in RUST too, not only TS', () => {
  const found = scan('types.rs', `    assert_eq!(dt.axes[0].name, "x");\n`)
  assert.equal(found.length, 1)
  assert.equal(found[0].field, 'axes')
})

test('[acceptance] FIRES on a NON-ZERO index — the rule is positional, not zero-specific', () => {
  const found = scan('loader.rs', `    let second = decl.dims[1];\n`)
  assert.equal(found.length, 1)
  assert.equal(found[0].index, 1)
})

// ───────────────────────── negative controls ─────────────────────────
//
// Each is the same shape in the same position, differing in exactly the property the
// guard is supposed to key on. These are what tell a real rule from a shape-matcher.

test('[negative-control] a NAME-keyed read of the same collection does NOT fire', () => {
  const found = scan(
    'workbenchDataSource.ts',
    `const declared = dt.entity_axis\nconst hit = dt.axes.find(a => a.name === declared)\n`,
  )
  assert.deepEqual(found, [])
})

test('[negative-control] a VARIABLE index does NOT fire (it is not a positional claim)', () => {
  const found = scan('workbenchDataSource.ts', `for (const i of range) use(dt.axes[i])\n`)
  assert.deepEqual(found, [])
})

test('[negative-control] a collection the contract does NOT declare does NOT fire', () => {
  // `positions` is a runtime Float32Array — indexing it is the whole point of it.
  const found = scan('viz.ts', `const x = positions[0]\nconst y = positions[1]\n`)
  assert.deepEqual(found, [])
  assert.ok(!FIELDS.includes('positions'), 'sanity: `positions` is not a declared collection')
})

test('[negative-control] the same subscript inside a COMMENT does NOT fire', () => {
  // This is not a nicety: the doc comments that EXPLAIN the fix all quote `axes[0]`, and
  // a guard that reports its own rationale gets muted.
  const found = scan(
    'types.rs',
    `/// The consumer used to take `.concat('`axes[0]`') + `, the FIRST declared axis.\n// see axes[0]\nlet ok = 1;\n`,
  )
  assert.deepEqual(found, [])
})

test('[stripComments] blanks comments while preserving line numbers', () => {
  const out = stripComments('a\n// x\n/* y\n z */\nb\n')
  assert.equal(out.split('\n').length, 6)
  assert.match(out.split('\n')[0], /^a$/)
  assert.match(out.split('\n')[4], /^b$/)
})

// ─────────────────────────── the ratchet ───────────────────────────

test('[ratchet] an ADDED hit fails; a hit already in the ledger does not', () => {
  const file = path.join(SRC_APP, 'ui/src/x.ts')
  const v = [{ file, line: 1, field: 'axes', index: 0, snippet: '' }]
  const key = violationKey(file, 'axes')
  assert.equal(key, 'ui/src/x.ts|axes')

  const clean = diffAgainstBaseline(v, { entries: { [key]: 1 } })
  assert.deepEqual(clean.added, [])
  assert.deepEqual(clean.stale, [])

  const added = diffAgainstBaseline([...v, { ...v[0], line: 2 }], { entries: { [key]: 1 } })
  assert.equal(added.added.length, 1)
  assert.equal(added.added[0].count, 2)
})

test('[ratchet] a STALE ledger entry fails too — a ledger nobody re-derives stops guarding', () => {
  const key = 'ui/src/gone.ts|axes'
  const { stale } = diffAgainstBaseline([], { entries: { [key]: 3 } })
  assert.equal(stale.length, 1)
  assert.equal(stale[0].allowed, 3)
  assert.equal(stale[0].count, 0)
})

test('[ledger] every committed entry names a file that still exists', () => {
  const baseline = JSON.parse(
    readFileSync(path.join(__dirname, 'positional-declaration-baseline.json'), 'utf8'),
  )
  const keys = Object.keys(baseline.entries)
  assert.ok(keys.length > 5, `non-vacuity: the ledger must have entries (saw ${keys.length})`)
  for (const key of keys) {
    const rel = key.slice(0, key.lastIndexOf('|'))
    readFileSync(path.join(SRC_APP, rel), 'utf8') // throws if the file is gone
  }
  // …and every NOTE names a real entry, so an annotation cannot outlive its finding.
  for (const key of Object.keys(baseline.notes ?? {})) {
    assert.ok(key in baseline.entries, `note for a key that is not in the ledger: ${key}`)
  }
})

test('[ledger] the production entries that are NOT self-evident carry a disposition', () => {
  const baseline = JSON.parse(
    readFileSync(path.join(__dirname, 'positional-declaration-baseline.json'), 'utf8'),
  )
  // The file the guard exists for must be annotated: its hits are a MIX of legitimate
  // (sole-element, storage-positional, documented last resort) and the fixed leak, and an
  // unannotated count there is exactly the amnesia this ledger must not become.
  const key = 'ui/src/modules/workbench/extensions/data/workbenchDataSource.ts|axes'
  assert.ok(key in baseline.entries, 'the motivating file must be in the ledger')
  assert.match(baseline.notes?.[key] ?? '', /SOLE element|sole element|SOLE ELEMENT/)
})

// ─────────────────────── the guard's own fail-closed edges ───────────────────────

test('[collapse] a scan set that collapsed FAILS rather than passing vacuously', () => {
  assert.deepEqual(scanFloorViolations(MIN_SCANNED_FILES), [])
  const v = scanFloorViolations(3)
  assert.equal(v.length, 1)
  assert.match(v[0], /COLLAPSED/)
  assert.deepEqual(scanFloorViolations(0).length, 1, 'zero files is the loudest case')
})

test('[fail-closed] the sibling guard`s override class is REFUSED, not inherited', () => {
  // This guard imports `defaultScanSet` from the domain guard, whose override env is
  // read at MODULE LOAD while its admission gate lives in its own `main()`. Without an
  // explicit refusal here, `LINT_NO_DOMAIN_ROOTS_OVERRIDE` would re-point THIS guard's
  // scan set with nothing said — a bypass acquired by borrowing.
  const r = spawnSync(process.execPath, [path.join(__dirname, 'lint-positional-declaration.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, LINT_NO_DOMAIN_ROOTS_OVERRIDE: '{}' },
  })
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stderr, /LINT_NO_DOMAIN_ROOTS_OVERRIDE/)
})

test('[gate-wiring] the guard is invoked by `npm run check`', () => {
  const pkg = JSON.parse(readFileSync(path.join(UI_ROOT, 'package.json'), 'utf8'))
  assert.match(pkg.scripts.check, /lint-positional-declaration/)
})

// ---------------------------------------------------------------------------
// TEST-18 — the guard actually covers `libs/viz` and the catalog collections.
//
// It did not, and that is why it saw none of the first-of-N binding family: `libs/viz` was
// outside the scan set it inherits from the domain guard (a DOMAIN-vocabulary carve-out that
// was never a decision about positional picks), and the catalog collection names were absent
// from its field set. The epicenter — `registry/model.ts` binding every chart channel to
// `categoricalColumns[ordinal] ?? 'group'` on every cell render — sat in the intersection of
// the two blind spots.
//
// These assert the COVERAGE, not the current hit list: a guard whose subject silently shrinks
// is the failure mode the whole file is built around.
// ---------------------------------------------------------------------------

test('[TEST-18][coverage] the scan set includes libs/viz — the carve-out is closed', () => {
  const set = positionalScanSet()
  const viz = set.filter(e => e.path.includes(`${path.sep}libs${path.sep}viz${path.sep}`))
  assert.ok(viz.length > 100, `expected libs/viz sources in the scan set, found ${viz.length}`)
  // the specific file the family lived in
  assert.ok(
    set.some(e => e.path.endsWith(path.join('viz-core', 'registry', 'model.ts'))),
    'the resolver at the centre of the defect family is not scanned',
  )
  // …and the shared app set is still there (this WIDENED, it did not replace)
  assert.ok(
    set.some(e => e.path.includes(path.join('ui', 'src', 'modules', 'workbench'))),
    'the inherited app scan set was lost',
  )
})

test('[TEST-18][coverage] the catalog collections are in the field set', () => {
  const fields = declaredCollectionFields(OPENAPI).fields
  for (const f of CATALOG_COLLECTIONS) {
    assert.ok(fields.includes(f), `${f} is not a guarded collection field`)
  }
  assert.ok(CATALOG_COLLECTIONS.includes('categoricalColumns'))
  assert.ok(CATALOG_COLLECTIONS.includes('layouts'))
})

test('[TEST-18][detection] a NEW catalog subscript in a scanned file is reported', () => {
  // The synthetic subject stands in for the shape that shipped for real:
  //   `catalog.categoricalColumns[0]?.id ?? 'group'`
  const dir = mkdtempSync(path.join(tmpdir(), 'posdecl-'))
  try {
    const file = path.join(dir, 'model.ts')
    writeFileSync(
      file,
      [
        "// a comment mentioning categoricalColumns[0] must NOT count",
        "const g = catalog.categoricalColumns[0]?.id ?? 'group'",
        "const c = catalog.continuousColumns[ordinal]?.id",
        "const l = catalog.layouts[0]?.id",
      ].join('\n'),
    )
    const fields = declaredCollectionFields(OPENAPI).fields
    const hits = collectViolations([{ path: file }], fields)
    const byField = hits.map(h => h.field).sort()
    // `continuousColumns[ordinal]` is NOT a literal subscript, so it is out of the guard's
    // stated rule — recorded here so the limit is known rather than assumed.
    assert.deepEqual(byField, ['categoricalColumns', 'layouts'])
    assert.equal(hits.length, 2, 'the comment line was counted')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('[TEST-18][ledger] every baselined entry carries a note saying WHY', () => {
  // The baseline is the TRIAGE, and an entry with no note is a hit somebody silenced rather
  // than argued. Checked only for the collections this change added, so the pre-existing
  // ledger is not retroactively re-litigated here.
  const baseline = JSON.parse(
    readFileSync(path.join(__dirname, 'positional-declaration-baseline.json'), 'utf8'),
  )
  const notes = baseline.notes ?? {}
  const unexplained = Object.keys(baseline.entries ?? {})
    .filter(k => CATALOG_COLLECTIONS.includes(k.split('|')[1]))
    .filter(k => !k.includes('test') && !k.includes('spec') && !k.includes('tests/'))
    .filter(k => !notes[k])
  assert.deepEqual(unexplained, [], 'baselined catalog subscripts with no written argument')
})
