#!/usr/bin/env node
/**
 * lint-positional-declaration — the app may not take element N of a DECLARED
 * collection.
 *
 * ── WHY THIS EXISTS (the defect it is built from) ──────────────────────────────
 *
 * `WorkbenchDataSource.rowAxisFor` resolved a datatype's ENTITY axis — the axis whose
 * cardinality becomes every point count, layout length and dense column extent — as
 * `datatypeRegistry.get(id)?.axes?.[0]?.name`. `AxisSpec`'s own contract says the core
 * knows an axis has a `name` and a `key_label` and NEVER what the axis represents, and
 * says nothing about position 0. So the app asserted a semantic its own contract
 * disclaims, and it was already wrong on axis sets declared in this tree (a microscopy
 * image resolved a raster dimension; two contributed composite kinds are dense over the
 * axis they declare SECOND). Every wrong answer was a plausible NUMBER.
 *
 * ── WHY NO EXISTING GUARD COULD SEE IT ────────────────────────────────────────
 *
 * `axes[0]` carries NO TOKEN. `lint-no-domain-in-builtin` is a vocabulary scanner over
 * derived domain ids and nouns; no widening of a vocabulary can ever match a subscript.
 * It is not a "cardinality certification" either — nothing asserts a count. And
 * `lint-layer-boundary` sees only import edges. This is a third property and it gets a
 * third guard, deliberately: folding a structural rule into the domain scanner would
 * make that guard's floors, ceilings and finding tags mean two different things.
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────────
 *
 * In app-tier `.rs`/`.ts`/`.tsx` code (comments stripped), FAIL on
 *
 *     <field> [ <integer literal> ]        e.g. `axes[0]`, `dims[1]`, `arrays?.[0]`
 *
 * where `<field>` is a DECLARED-COLLECTION field name (below). "Declared" is the whole
 * point: these are collections a CONTRIBUTOR authors in a manifest, in whatever order
 * they wrote them, and nothing in the contract promises that order means anything.
 *
 * A literal index is not always wrong — `axes.length === 1 ? axes[0]` picks the SOLE
 * element, which is not a choice at all, and a positional last resort that is licensed
 * by documented silence is a legitimate design. Those live in the BASELINE with a note
 * saying which they are. The baseline is the triage, exactly as it is for the two
 * sibling guards; what the guard buys is that a NEW one has to be argued for.
 *
 * ── THE FIELD SET IS DERIVED ──────────────────────────────────────────────────
 *
 * Not a hand list: `declaredCollectionFields()` reads every array-typed property of the
 * DECLARATION-LAYER schemas out of the shipped OpenAPI contract, so a new declared
 * collection is covered on the next `just openapi-regen`. `DECLARATION_SCHEMAS` names
 * WHICH schemas count as the declaration layer — that list is stated, and a schema that
 * disappears from the contract fails BY NAME rather than silently narrowing the guard.
 *
 * The one stated addition is `STRUCTURE_COLLECTIONS`: the producer-declared artifact
 * `structure` is carried as OPAQUE JSON on the wire (`Artifact.structure` is `unknown`),
 * so its collections have no schema to derive from — they are named here, from
 * `ui/src/core/workstore`'s `ArtifactStructure`, with this sentence as the reason.
 *
 * Usage:  node scripts/lint-positional-declaration.mjs
 *         node scripts/lint-positional-declaration.mjs --write   (regenerate baseline)
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { defaultScanSet, presentOverrides } from './lint-no-domain-in-builtin.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UI_ROOT = path.resolve(__dirname, '..')
const SRC_APP = path.resolve(UI_ROOT, '..')
const OPENAPI_PATH = path.join(UI_ROOT, 'openapi', 'openapi.json')
const BASELINE_PATH = path.join(__dirname, 'positional-declaration-baseline.json')

/**
 * The schemas that ARE the declaration layer — the shapes a contributor authors in a
 * `manifest.yaml` and the app merely reads. Stated (not derived): "which schemas are
 * declarations" is a judgement, and writing it down is what makes it reviewable. A name
 * here that no longer resolves in the contract is a HARD ERROR, so a schema rename
 * cannot quietly shrink the guard.
 */
export const DECLARATION_SCHEMAS = [
  'Datatype',
  'AxisSpec',
  'ArrayDecl',
  'ArrayAttr',
  'DatatypeContribution',
  'StorageSpec',
  'IngestSpec',
  'ViewerRef',
  'InputRequirements',
  'ExtensionManifest',
  'Contributes',
]

/**
 * Collections of the producer-declared artifact `structure`. Not derivable: `structure`
 * rides the wire as opaque JSON (`unknown`), so the contract has no schema for it — see
 * the header. Sourced from `ui/src/core/workstore`'s `ArtifactStructure`.
 */
export const STRUCTURE_COLLECTIONS = ['columns', 'levels']

/**
 * Collections of the viz DATASET CATALOG. Not derivable for the same reason
 * `STRUCTURE_COLLECTIONS` is not: `DatasetCatalog` is a `@txresbench/viz` PACKAGE type, so it has no
 * wire schema in `openapi.json` to read properties off. Named here, from
 * `libs/viz/src/viz-core/data/wire.ts`, with this sentence as the reason.
 *
 * ── WHY THEY BELONG IN THIS GUARD ──────────────────────────────────────────────────────────
 * The guard's subject is "a collection somebody DECLARED, in whatever order they wrote it,
 * where nothing in the contract promises the order means anything." A catalog's columns are
 * exactly that — a producer emits them in whatever order its writer walked, and `[0]` then
 * asserts that order is a ranking.
 *
 * Measured cost of the gap: `registry/model.ts` resolved EVERY chart channel as
 * `categoricalColumns[ordinal]?.id ?? 'group'` on every cell render, and `gridModel.ts` held a
 * byte-identical second copy. Four owner-reported defects came out of that predicate. This
 * guard could not see any of it — partly because these field names were absent, and partly
 * because `libs/viz` was outside the scan set entirely (see `positionalScanSet`).
 */
export const CATALOG_COLLECTIONS = [
  'categoricalColumns',
  'continuousColumns',
  'valueColumns',
  'layouts',
  'datasets',
]

/** A collapse detector on the DERIVATION itself (the guard's own `SCAN_FLOORS` idea):
 *  an openapi.json that stopped carrying properties would silently make this guard
 *  match nothing at all. Measured 2026-08-05: 14 derived + 2 stated = 16.
 *  RE-MEASURED 2026-08-13 after `CATALOG_COLLECTIONS` was added: 15 derived + 7 stated = 22.
 *  The floor moves with it — a floor that stays below the old measurement would let the new
 *  stated block be deleted again for free, which is the weakening the ratchet exists to make
 *  visible. */
export const MIN_DECLARED_FIELDS = 17

/** Same idea for the scan set. Measured 2026-08-05: 856 `.rs`/`.ts`/`.tsx` files.
 *  RE-MEASURED 2026-08-13 after `positionalScanSet()` folded in `libs/viz`: 1982 files.
 *  The floor is raised past the OLD measurement deliberately — at 560 the `libs/viz` half of
 *  the scan set could be dropped again and this guard would still congratulate itself, which
 *  is exactly the collapse the floor is for. */
export const MIN_SCANNED_FILES = 1400

/** Every DECLARED-COLLECTION field name, derived + stated. */
export function declaredCollectionFields(openapiPath = OPENAPI_PATH) {
  const spec = JSON.parse(readFileSync(openapiPath, 'utf8'))
  const schemas = spec.components?.schemas ?? {}
  const fields = new Set([...STRUCTURE_COLLECTIONS, ...CATALOG_COLLECTIONS])
  const missing = []
  for (const name of DECLARATION_SCHEMAS) {
    const s = schemas[name]
    if (!s) {
      missing.push(name)
      continue
    }
    for (const [key, value] of Object.entries(s.properties ?? {})) {
      const type = value.type ?? value.allOf?.[0]?.type ?? value.anyOf?.find(v => v.type)?.type
      const isArray =
        type === 'array' || Boolean(value.items) || Boolean(value.anyOf?.some(v => v.type === 'array' || v.items))
      if (isArray) fields.add(key)
    }
  }
  return { fields: [...fields].sort(), missing }
}

/** Blank out comments, newline-preserving so line numbers survive. Strings are LEFT
 *  ALONE: a subscript inside a string literal is vanishingly rare, while a doc comment
 *  discussing `axes[0]` is common — this very file is one — and stripping comments is
 *  what stops the guard reporting the prose that explains it. */
export function stripComments(src) {
  let out = ''
  let i = 0
  while (i < src.length) {
    if (src[i] === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') {
        out += ' '
        i++
      }
      continue
    }
    if (src[i] === '/' && src[i + 1] === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' '
        i++
      }
      out += '  '
      i += 2
      continue
    }
    out += src[i]
    i++
  }
  return out
}

/** `<field>[<int>]`, allowing an optional-chain `?.` and inner whitespace. */
function subscriptRe(fields) {
  return new RegExp(`\\b(${fields.join('|')})\\s*(?:\\?\\.)?\\[\\s*(\\d+)\\s*\\]`, 'g')
}

/** `<srcApp-relative path>|<field>` — the baseline key. Deliberately WITHOUT a line
 *  number, so an unrelated edit above a hit does not churn the ledger (the same choice
 *  `lint-layer-boundary` made, for the same reason). */
export function violationKey(file, field) {
  return `${path.relative(SRC_APP, file)}|${field}`
}

/**
 * THIS guard's scan set: the shared app set, PLUS `libs/viz` sources.
 *
 * ── WHY IT IS ITS OWN SET AND NOT A WIDENING OF THE SIBLING'S ──────────────────────────────
 *
 * `libs/viz` is a documented carve-out from `lint-no-domain-in-builtin`'s `defaultScanSet()`,
 * and that carve-out is a DOMAIN-VOCABULARY decision — "the viz package has its own owner, and
 * its domain terms are that owner's business." It was never a decision about POSITIONAL picks,
 * which this guard is about; the two properties simply arrived at the same scan set by
 * inheritance.
 *
 * The cost of that inheritance was measured: `viz-core/registry/model.ts` bound every chart
 * channel to `categoricalColumns[ordinal] ?? 'group'` on every cell render, `gridModel.ts` held
 * a byte-identical copy, and `useGridData.ts` picked `layouts[0]` — the whole epicenter of a
 * defect family, sitting in the one directory this guard could not look at. The sibling guard's
 * own header even records the exposure ("Nothing prevents NEW ones: `libs/viz` is unguarded").
 *
 * It is added HERE rather than by editing `defaultScanSet()` because that function is shared
 * infrastructure under active per-(file,token) ratchet development by another owner, and its
 * `SCAN_FLOORS` are per-root measured constants — widening it would move a different guard's
 * floors as a side effect of this change. A guard needing a wider view takes the wider view
 * itself and owns its own floor for it.
 */
export function positionalScanSet() {
  const { set } = defaultScanSet()
  const vizRoot = path.join(SRC_APP, 'libs', 'viz', 'src')
  const extra = []
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue
        walk(p)
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        extra.push({ path: p })
      }
    }
  }
  if (existsSync(vizRoot)) walk(vizRoot)
  return [...set, ...extra]
}

/** Collect every violation over `scanSet` (defaults to the shared app scan set). */
export function collectViolations(scanSet, fields) {
  const re = subscriptRe(fields)
  const out = []
  for (const entry of scanSet) {
    if (!/\.(rs|ts|tsx)$/.test(entry.path)) continue
    const src = stripComments(readFileSync(entry.path, 'utf8'))
    const lines = src.split('\n')
    lines.forEach((line, idx) => {
      re.lastIndex = 0
      let m
      while ((m = re.exec(line)) !== null) {
        out.push({ file: entry.path, line: idx + 1, field: m[1], index: Number(m[2]), snippet: line.trim().slice(0, 120) })
      }
    })
  }
  return out
}

function loadBaseline(baselinePath = BASELINE_PATH) {
  try {
    return JSON.parse(readFileSync(baselinePath, 'utf8'))
  } catch {
    return { entries: {}, notes: {} }
  }
}

/** `{added, stale}` against the committed ledger. BOTH fail: an added hit is a new
 *  positional assumption; a stale one means the ledger describes code that is gone, and
 *  a ledger nobody re-derives is how a guard quietly stops guarding. */
export function diffAgainstBaseline(violations, baseline) {
  const observed = {}
  for (const v of violations) {
    const key = violationKey(v.file, v.field)
    observed[key] = (observed[key] ?? 0) + 1
  }
  const committed = baseline.entries ?? {}
  const added = []
  const stale = []
  for (const [key, count] of Object.entries(observed)) {
    const allowed = committed[key] ?? 0
    if (count > allowed) added.push({ key, count, allowed })
  }
  for (const [key, allowed] of Object.entries(committed)) {
    const count = observed[key] ?? 0
    if (count < allowed) stale.push({ key, count, allowed })
  }
  return { added, stale, observed }
}

/** Violations of the SCAN-SET floor — a guard that scanned (almost) nothing must exit
 *  non-zero rather than congratulate itself. Exported so it is testable without having
 *  to collapse the real tree. */
export function scanFloorViolations(scannedCount) {
  if (scannedCount >= MIN_SCANNED_FILES) return []
  return [
    `the scan set COLLAPSED — ${scannedCount} file(s) < MIN_SCANNED_FILES (${MIN_SCANNED_FILES}).`,
  ]
}

function main() {
  const write = process.argv.includes('--write')

  // FAIL-CLOSED on the sibling guard's override class. This guard borrows
  // `defaultScanSet()` from `lint-no-domain-in-builtin`, and that module reads
  // `LINT_NO_DOMAIN_ROOTS_OVERRIDE`/`_SCAN_OVERRIDE` at MODULE LOAD — its admission gate
  // lives in ITS `main()`, which never runs here. So an override that the sibling would
  // refuse would silently re-point THIS guard's scan set. Refuse instead: reusing a scan
  // set must not mean inheriting a bypass.
  const overrides = presentOverrides()
  if (overrides.length > 0) {
    console.error(
      `✖ positional-declaration: ${overrides.join(', ')} is set. This guard borrows the\n` +
        `  domain guard's scan set and does NOT honour its self-test overrides — unset it.`,
    )
    process.exit(1)
  }

  const { fields, missing } = declaredCollectionFields()
  const problems = []

  if (missing.length > 0) {
    problems.push(
      `DECLARATION_SCHEMAS names ${missing.length} schema(s) the contract no longer has: ` +
        `${missing.join(', ')}. Rename or remove them DELIBERATELY — a silently missing ` +
        `schema narrows this guard with nothing said.`,
    )
  }
  if (fields.length < MIN_DECLARED_FIELDS) {
    problems.push(
      `the derived field set COLLAPSED: ${fields.length} field(s) < MIN_DECLARED_FIELDS ` +
        `(${MIN_DECLARED_FIELDS}). A guard that matches nothing passes vacuously.`,
    )
  }
  if (problems.length > 0) {
    console.error('✖ positional-declaration: the guard cannot trust its own inputs.\n')
    for (const p of problems) console.error(`  ${p}`)
    process.exit(1)
  }

  const scanned = positionalScanSet().filter(e => /\.(rs|ts|tsx)$/.test(e.path))
  const collapsed = scanFloorViolations(scanned.length)
  if (collapsed.length > 0) {
    console.error(`✖ positional-declaration: ${collapsed.join(' ')}`)
    process.exit(1)
  }

  const violations = collectViolations(scanned, fields)

  if (write) {
    const baseline = loadBaseline()
    const entries = {}
    for (const v of violations) {
      const key = violationKey(v.file, v.field)
      entries[key] = (entries[key] ?? 0) + 1
    }
    const out = {
      $comment:
        'Every place the app indexes a DECLARED collection by a literal integer. A hit ' +
        'is NOT automatically a defect — the sole-element and documented-last-resort ' +
        'forms are legitimate — but a NEW one must be argued for. Regenerate with ' +
        '`node scripts/lint-positional-declaration.mjs --write`; annotate in `notes`.',
      total: violations.length,
      entries: Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))),
      notes: baseline.notes ?? {},
    }
    writeFileSync(BASELINE_PATH, `${JSON.stringify(out, null, 2)}\n`)
    console.log(`✓ positional-declaration baseline written: ${violations.length} hit(s).`)
    return
  }

  const baseline = loadBaseline()
  const { added, stale } = diffAgainstBaseline(violations, baseline)
  if (added.length === 0 && stale.length === 0) {
    console.log(
      `✓ positional-declaration: ${scanned.length} file(s) scanned, ${fields.length} declared ` +
        `collection field(s) [${fields.join(' ')}]; ${violations.length} hit(s), all in the ledger.`,
    )
    return
  }

  console.error('✖ positional-declaration: the app takes element N of a DECLARED collection.\n')
  const byKey = new Map()
  for (const v of violations) {
    const key = violationKey(v.file, v.field)
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(v)
  }
  for (const a of added) {
    console.error(`  NEW  ${a.key}  (${a.count} hit(s), ledger allows ${a.allowed})`)
    for (const v of byKey.get(a.key) ?? []) {
      console.error(`       ${path.relative(SRC_APP, v.file)}:${v.line}  ${v.snippet}`)
    }
  }
  for (const s of stale) {
    console.error(`  STALE ${s.key}  (ledger says ${s.allowed}, only ${s.count} remain)`)
  }
  console.error(
    '\n  A declared collection is authored by a CONTRIBUTOR, in whatever order they wrote it;\n' +
      '  the contract promises nothing about position. Read the value by NAME, or — if the\n' +
      '  index is genuinely the sole element or a documented last resort — record it with a\n' +
      '  note: node scripts/lint-positional-declaration.mjs --write',
  )
  process.exit(1)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
