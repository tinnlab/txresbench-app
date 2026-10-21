// TEST-34 (ITEM-25) — ONE entity, ONE name (INV-10's first half).
//
// "Result" is an invented entity: the server has no result concept — no `/result`
// endpoint, no results table, only artifacts. The invention already caused a bug
// (`pickNewest` sorted ALL project artifacts of a datatype while claiming to list "the
// run's results"). ITEM-25 renamed the entity to `artifact` throughout.
//
// The assertion has to be two-sided, because a naive `/Result/` ban would also delete
// `ParseResult`, `GateResult`, `ValidationResult` — generic OUTCOME types that are not
// the entity and were never in scope. So: zero ENTITY-sense `Result*` exports, and the
// generic outcome types still present and still exported.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WB = path.resolve(HERE, '../..')

/** The ENTITY sense: a `Result` used as the noun for "a thing a run produced".
 *  `Result` alone, or `Result` immediately followed by one of the entity-role suffixes.
 *  A generic outcome type is always `<Verb>Result` (Parse/Gate/Validation/Batch/…), i.e.
 *  `Result` at the END with a qualifier before it — which this deliberately does not match. */
const ENTITY_RE = /^(Result|Result(Contribution|Renderer|Panel|Kind|Registry|Row|Ref|Detail|Pane|View))$/
const ENTITY_LOWER_RE = /^(result|resultRenderers|resultKind|resultRegistry)$/

/** Generic outcome types that must SURVIVE — the over-deletion guard.
 *  `GateResult` was dropped from this list when `core/runtime/gate.ts` was deleted whole
 *  (DOMAIN_AUDIT C6): the module was unreachable — its only caller was the `region ===
 *  'center'` branch of `DeclarativeRegion`, and `fanViewSpecToContributions` DROPS a
 *  declared `center` region — and domain-coupled while dead. The removal is the module,
 *  not a casualty of the `Result` → `Artifact` rename this guard watches. */
const GENERIC = ['ParseResult', 'ValidationResult']

interface Export {
  name: string
  file: string
}

function allExports(): Export[] {
  const out: Export[] = []
  const EXPORT_RE =
    /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:type|interface|class|enum|function|const|let|var)\s+([A-Za-z_$][\w$]*)/gm
  const REEXPORT_RE = /^export\s*(?:type\s*)?\{([^}]*)\}/gm
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        walk(p)
        continue
      }
      if (!/\.(ts|tsx)$/.test(e.name)) continue
      if (/\.test\.(ts|tsx)$/.test(e.name)) continue
      const src = readFileSync(p, 'utf8')
      const rel = path.relative(WB, p)
      for (const m of src.matchAll(EXPORT_RE)) out.push({ name: m[1], file: rel })
      for (const m of src.matchAll(REEXPORT_RE))
        for (const raw of m[1].split(',')) {
          const n = raw.trim().split(/\s+as\s+/).pop()?.trim()
          if (n && /^[A-Za-z_$][\w$]*$/.test(n)) out.push({ name: n, file: rel })
        }
    }
  }
  walk(path.join(WB, 'core'))
  walk(path.join(WB, 'extensions'))
  return out
}

test('TEST-34: the export scan actually sees the surface (positive count)', () => {
  const ex = allExports()
  // Without this a scan that walked the wrong directory would report "no Result-entity
  // exports found" and read exactly like compliance.
  assert.ok(ex.length >= 400, `export scan collapsed: ${ex.length} export(s) found under core/ + extensions/`)
  assert.ok(new Set(ex.map(e => e.file)).size >= 120, 'the scan should cover ≥120 source files')
})

test('TEST-34: NO exported symbol under core/** or extensions/** uses the `Result` ENTITY sense', () => {
  const offenders = allExports().filter(e => ENTITY_RE.test(e.name) || ENTITY_LOWER_RE.test(e.name))
  assert.deepEqual(
    offenders.map(e => `${e.name} (${e.file})`),
    [],
    'the invented `result` entity survived the ITEM-25 rename',
  )
})

test('TEST-34: the GENERIC outcome types are untouched (the over-deletion guard)', () => {
  const names = new Set(allExports().map(e => e.name))
  const missing = GENERIC.filter(g => !names.has(g))
  assert.deepEqual(missing, [], 'a generic `<Verb>Result` outcome type was deleted along with the entity')
})

test('TEST-34: the entity matcher separates the two senses', () => {
  // The matcher is the whole test. If it were a bare /Result/ it would ban
  // `ParseResult`; if it were anchored too tightly it would miss `ResultRenderer`.
  for (const n of ['Result', 'ResultRenderer', 'ResultContribution', 'ResultPanel', 'ResultKind'])
    assert.ok(ENTITY_RE.test(n), `entity matcher missed ${n}`)
  for (const n of ['ParseResult', 'BatchResult', 'GateResult', 'ValidationResult', 'ConvertResult', 'SniffResult'])
    assert.ok(!ENTITY_RE.test(n), `entity matcher wrongly claimed the generic outcome type ${n}`)
})

test('TEST-34: the `artifact` name IS the one in use (the rename landed somewhere)', () => {
  // A tree with neither `Result*` nor `Artifact*` would pass every assertion above.
  const names = allExports().map(e => e.name)
  const artifactNamed = names.filter(n => /^Artifact|Artifact(Renderer|Contribution|Kind|Row|Query|Read)$/.test(n))
  assert.ok(
    artifactNamed.length >= 5,
    `expected the artifact vocabulary to be in use; found ${artifactNamed.length}: ${artifactNamed}`,
  )
})
