#!/usr/bin/env node
/**
 * lint-layer-boundary.mjs — ITEM-21, the workbench LAYER-BOUNDARY ratchet
 * (INV-3 / INV-8).
 *
 * ## The rule INV-3/INV-8 want
 *
 *   1. ONE public entry per layer — `core/index.ts` and `extensions/index.ts`.
 *      Nothing outside a layer may import past its barrel (R1).
 *   2. `core/` may NEVER import from `extensions/` — the dependency arrow points
 *      one way (R2).
 *   3. An extension may not import ANOTHER extension's internals (R3).
 *
 * ## Why this is a RATCHET and not a greenfield rule
 *
 * THE TREE DOES NOT SATISFY THAT RULE TODAY, and this guard does not pretend it
 * does. The `core/`+`extensions/` restructure made a large set of pre-existing
 * edges VISIBLE (most are ordinary component imports that were intra-directory
 * before the split), plus two that are STRUCTURAL and DELIBERATE:
 *
 *   • `core/spec/schema.ts` → `core/render/registry` (`hasWidget`, the open
 *     widget-kind check) — an intra-CORE spec→render edge the capability broker
 *     cannot dissolve. (Intra-core, so not a boundary violation; noted because it
 *     is the sibling of the two below in the ITEM-21 discussion.)
 *   • three defensive `installBuiltinWidgets()` calls in `core/{runtime,render}`
 *     that exist so a canvas-owned plot kind VALIDATES rather than fail-closing.
 *
 * So the guard commits the CURRENT violation set as a BASELINE that may only
 * SHRINK:
 *   • a NEW violation (an unlisted file/kind/target, or a listed one whose count
 *     went UP) FAILS — the boundary cannot get worse;
 *   • a REMOVED violation whose baseline entry was not deleted ALSO FAILS — so
 *     the count cannot silently drift back up after someone fixes something and
 *     forgets to tighten the baseline.
 * Fixing an edge is therefore a two-line change (the import + the baseline), and
 * the baseline file is the reviewable record of exactly how much debt is left.
 *
 * ## Scope + exemptions (stated, not accidental)
 *
 *   • Scanned: every `.ts`/`.tsx` under `src/modules/workbench/`.
 *   • `*.test.*` / `*.spec.*` are EXEMPT. A test reaching into an internal is a
 *     test-authoring choice, not an architecture violation, and including them
 *     would triple the baseline with entries nobody should be pressured to "fix"
 *     by weakening a test. (Same DEC-9 rationale as `lint-no-domain-in-builtin`.)
 *   • `extensions/index.ts` is EXEMPT from R3. It is the layer's own public entry
 *     — composing the extensions is precisely its job.
 *   • Only WORKBENCH-INTERNAL specifiers are considered (`@/modules/workbench/…`
 *     and relatives that resolve inside the workbench). An import of `@/core/…`,
 *     `@txresbench/viz`, react, … is out of scope.
 *
 * ## Usage
 *   node scripts/lint-layer-boundary.mjs           # check (exit 1 on drift)
 *   node scripts/lint-layer-boundary.mjs --write   # rewrite the baseline file
 *
 * Test-only override (used by `lint-layer-boundary.test.mjs`; never set in normal use):
 *   LINT_LAYER_BOUNDARY_ROOT      — scan this dir instead of `src/modules/workbench`
 *   LINT_LAYER_BOUNDARY_BASELINE  — read/write this baseline JSON instead of the committed one
 *   LINT_LAYER_BOUNDARY_MIN_FILES — lower the ITEM-37 scan floor so a tiny synthetic
 *                                   fixture can exercise the RULES. The floor itself is
 *                                   proved by a test that leaves this UNSET and points the
 *                                   root at an empty dir. Setting it in CI would be as
 *                                   visible an edit as lowering the constant.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UI_ROOT = path.resolve(__dirname, '..')
const WORKBENCH = process.env.LINT_LAYER_BOUNDARY_ROOT
  ? path.resolve(process.env.LINT_LAYER_BOUNDARY_ROOT)
  : path.join(UI_ROOT, 'src', 'modules', 'workbench')
const BASELINE_PATH = process.env.LINT_LAYER_BOUNDARY_BASELINE
  ? path.resolve(process.env.LINT_LAYER_BOUNDARY_BASELINE)
  : path.join(__dirname, 'layer-boundary-baseline.json')

/**
 * ITEM-37 — FAIL CLOSED on a collapsed scan set. `WORKBENCH` is a hard-coded root;
 * a rename that moves it makes the walk yield nothing and a naive guard reports
 * "0 violations" — a PASS that measured nothing. Committed constant: lowering it
 * requires an explicit, reviewable edit.
 */
const MIN_SCANNED_FILES = Number(process.env.LINT_LAYER_BOUNDARY_MIN_FILES ?? 150)

const WRITE = process.argv.includes('--write')

// ── file discovery ──────────────────────────────────────────────────────────

function listFiles(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      listFiles(full, out)
      continue
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue
    out.push(full)
  }
  return out
}

/** Tests are exempt (see header). */
function isExempt(rel) {
  return /\.(test|spec)\.(ts|tsx)$/.test(rel)
}

// ── import extraction ───────────────────────────────────────────────────────

/**
 * Every module specifier in `src`, with its 1-indexed line. Covers static
 * `import`/`export … from '…'`, side-effect `import '…'`, and dynamic
 * `import('…')` — the three forms the workbench actually uses.
 *
 * ## The clause may SPAN LINES, and until 2026-07-30 this could not see one
 *
 * The static pattern was `…(?:import|export)\b[^;\n]*?\bfrom…` — `[^;\n]` forbids a
 * newline, so it matched a one-line import and NOTHING ELSE. Every multi-line import in
 * the tree was invisible: 821 specifiers seen out of 886, 65 missed, and with them **5
 * real boundary violations** the guard reported as zero. It is the dominant spelling —
 * biome wraps any import that does not fit — so the blind spot was not an edge case.
 *
 * That made a RECORD false, which is the failure this branch keeps repeating.
 * `3f345cc4` cut a TDZ import cycle (`canvasDataSource` → `core/host/createHost`) and its
 * message claimed *"that ratchet is now the guard against re-introducing this edge"*. It
 * was not: a one-line re-add failed the guard and a five-line re-add exited 0 and silently
 * restored the strongly-connected component. Both spellings are pinned by tests now
 * (`lint-layer-boundary.test.mjs`, `[F2]`), because "the guard covers this" is a claim
 * about behaviour and behaviour is what a test holds.
 *
 * ## Why the widened clause is a CHARACTER CLASS and not `[\s\S]*?`
 *
 * An unrestricted lazy gap would let a statement-initial `import`/`export` run past the
 * end of its own statement to the next `from '…'` in the file. The middle of an import
 * clause is only ever identifiers, `,`, `{`, `}`, `*` and whitespace (`type`, `as` and
 * `default` are identifiers) — so `[A-Za-z0-9_$,{}*\s]` bounds the scan at the first
 * character no clause can contain (`=`, `(`, `:`, `;`, a quote), which is what every
 * non-import statement hits almost immediately.
 *
 * ## …but a bounded class must also admit COMMENTS, or it regresses on one-liners
 *
 * That class excludes `/`, so ANY clause containing a comment was invisible — in BOTH
 * spellings:
 *
 *     import { EXT /* the installer *\/ } from './extensions'   // one line
 *     import {
 *       EXT, // defensive install
 *     } from './extensions'                                     // wrapped
 *
 * For the ONE-LINE form that was a strict REGRESSION of the widening itself: the old
 * `[^;\n]*?` allowed `/` and matched it; the class did not. A synthetic root with three
 * real `core → extensions` edges — plain, inline-block-comment, wrapped-line-comment —
 * reported ONE. So the clause now admits the two comment forms explicitly.
 *
 * They are consumed ATOMICALLY, via the `(?=(…))\N` idiom, and that is load-bearing
 * rather than decorative. A plain lazy alternative would let the engine BACKTRACK INTO a
 * comment, so prose like `// re-exported from './core/host' historically` would satisfy
 * the trailing `\bfrom\s*'…'` and mint a PHANTOM edge out of a sentence. Consumed
 * atomically the comment is opaque: whatever it says, the specifier must come from real
 * code after it. The bound is otherwise unchanged — a lone `/` still starts neither
 * comment and still terminates the scan, so `const x = a / b` stops at the `=` exactly
 * as before.
 *
 * ## …and why a duplicate is impossible even if it did over-reach
 *
 * Each hit is keyed by the OFFSET OF ITS SPECIFIER (the `d` flag's capture indices), so
 * three patterns that all reach the same `'…'` occurrence record it once. Without that a
 * spurious wide match that happened to end on a specifier another pattern also found would
 * count that edge TWICE and fail the ratchet with a phantom "the count went up".
 * (The specifier is a NAMED group so the atomic-comment backreferences above can take the
 * numbered slots without moving it.)
 */

/** One character of an import clause: identifiers, separators, whitespace. */
const CLAUSE_CHAR = '[A-Za-z0-9_$,{}*\\s]'
/** `// …` to end of line, consumed atomically — see the note above. */
const LINE_COMMENT = '(?=(//[^\\n]*))\\1'
/** `/* … *\/`, consumed atomically up to its FIRST terminator. */
const BLOCK_COMMENT = '(?=(/\\*[\\s\\S]*?\\*/))\\2'
/** The whole clause between `import`/`export` and its `from`. */
const CLAUSE = `(?:${CLAUSE_CHAR}|${LINE_COMMENT}|${BLOCK_COMMENT})*?`

function specifiersOf(src) {
  /** @type {Map<number, {spec: string, line: number}>} keyed by the specifier's offset. */
  const byOffset = new Map()
  const res = [
    new RegExp(
      `(?:^|\\n)[ \\t]*(?:import|export)\\b${CLAUSE}\\bfrom\\s*['"](?<spec>[^'"]+)['"]`,
      'gd',
    ),
    /(?:^|\n)[ \t]*import\s*['"](?<spec>[^'"]+)['"]/gd,
    /\bimport\s*\(\s*['"](?<spec>[^'"]+)['"]\s*\)/gd,
  ]
  for (const re of res) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(src)) !== null) {
      const at = m.indices.groups.spec[0]
      if (byOffset.has(at)) continue
      byOffset.set(at, {
        spec: m.groups.spec,
        // The STATEMENT's line, not the specifier's — for a wrapped import that is the
        // `import {` a reader has to go and edit.
        line: src.slice(0, m.index).split('\n').length + (m[0][0] === '\n' ? 1 : 0),
      })
    }
  }
  return [...byOffset.values()]
}

/** @returns {string|null} the workbench-relative target of `spec`, or null if it leaves the workbench. */
function resolveTarget(fileAbs, spec) {
  if (spec.startsWith('@/modules/workbench/')) return spec.slice('@/modules/workbench/'.length)
  if (spec === '@/modules/workbench') return ''
  if (!spec.startsWith('.')) return null
  const abs = path.resolve(path.dirname(fileAbs), spec)
  if (abs !== WORKBENCH && !abs.startsWith(WORKBENCH + path.sep)) return null
  return path.relative(WORKBENCH, abs).split(path.sep).join('/')
}

/** `core` | `extensions` | `other` — which layer a workbench-relative path belongs to. */
function layerOf(rel) {
  if (rel === 'core' || rel.startsWith('core/')) return 'core'
  if (rel === 'extensions' || rel.startsWith('extensions/')) return 'extensions'
  return 'other'
}

/** True when `rel` names a layer BARREL rather than something behind it. */
function isBarrel(rel) {
  return (
    rel === 'core' ||
    rel === 'core/index' ||
    rel === 'core/index.ts' ||
    rel === 'extensions' ||
    rel === 'extensions/index' ||
    rel === 'extensions/index.ts'
  )
}

/** The extension a path belongs to (`extensions/<name>/…`), or null. */
function extensionOf(rel) {
  const m = /^extensions\/([^/]+)\//.exec(rel)
  return m ? m[1] : null
}

// ── the three rules ─────────────────────────────────────────────────────────

export function collectViolations() {
  const files = listFiles(WORKBENCH)
  const violations = []
  let scanned = 0

  for (const abs of files) {
    const rel = path.relative(WORKBENCH, abs).split(path.sep).join('/')
    if (isExempt(rel)) continue
    scanned++
    const fromLayer = layerOf(rel)
    const src = readFileSync(abs, 'utf8')

    for (const { spec, line } of specifiersOf(src)) {
      const target = resolveTarget(abs, spec)
      if (target === null) continue
      const toLayer = layerOf(target)

      // R2 — core may never depend on extensions (barrel OR deep; both are the
      // arrow pointing the wrong way).
      if (fromLayer === 'core' && toLayer === 'extensions') {
        violations.push({ file: rel, kind: 'core-imports-extensions', target, line })
        continue
      }

      // R1 — nothing outside a layer may import PAST its barrel.
      if (fromLayer !== toLayer && toLayer !== 'other' && !isBarrel(target)) {
        violations.push({ file: rel, kind: 'deep-import-across-layer', target, line })
        continue
      }

      // R3 — an extension may not reach into ANOTHER extension's internals.
      // `extensions/index.ts` is the layer's public entry; composing them is its job.
      if (fromLayer === 'extensions' && toLayer === 'extensions' && rel !== 'extensions/index.ts') {
        const a = extensionOf(rel)
        const b = extensionOf(target)
        if (a && b && a !== b) {
          violations.push({ file: rel, kind: 'cross-extension-internal', target, line })
        }
      }
    }
  }
  return { scanned, violations }
}

// ── baseline (file+kind+target → count; LINE NUMBERS DELIBERATELY EXCLUDED so
//    an unrelated edit above an import does not churn the baseline) ──────────

const keyOf = v => `${v.file}|${v.kind}|${v.target}`

function tally(violations) {
  /** @type {Record<string, number>} */
  const out = {}
  for (const v of violations) out[keyOf(v)] = (out[keyOf(v)] ?? 0) + 1
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)))
}

function readBaseline() {
  if (!existsSync(BASELINE_PATH)) return {}
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).entries ?? {}
}

export function diffAgainstBaseline(observed, baseline) {
  const added = []
  const stale = []
  for (const [k, got] of Object.entries(observed)) {
    const want = baseline[k] ?? 0
    if (got > want) added.push({ key: k, got, want })
  }
  for (const [k, want] of Object.entries(baseline)) {
    const got = observed[k] ?? 0
    if (got < want) stale.push({ key: k, got, want })
  }
  return { added, stale }
}

// ── main ────────────────────────────────────────────────────────────────────

function main() {
  const { scanned, violations } = collectViolations()

  if (scanned < MIN_SCANNED_FILES) {
    console.error(
      `\n✖ lint-layer-boundary: SCAN SET COLLAPSED — ${scanned} file(s) under ${WORKBENCH}, ` +
        `below the committed floor of ${MIN_SCANNED_FILES}. A hard-coded path no longer resolves, ` +
        `so this guard was about to report "0 violations" having read almost nothing.\n`,
    )
    process.exit(1)
  }

  const observed = tally(violations)
  const total = Object.values(observed).reduce((a, b) => a + b, 0)

  if (WRITE) {
    writeFileSync(
      BASELINE_PATH,
      JSON.stringify(
        {
          $comment:
            'ITEM-21 layer-boundary RATCHET baseline — the violations that EXIST TODAY. ' +
            'It may only SHRINK: adding an entry means the boundary got worse (fix the import ' +
            'instead), and removing an edge without deleting its entry fails too, so the count ' +
            'cannot drift back up. Regenerate with `node scripts/lint-layer-boundary.mjs --write` ' +
            'ONLY when you have genuinely removed edges.',
          total,
          entries: observed,
        },
        null,
        2,
      ) + '\n',
    )
    console.log(`✓ lint-layer-boundary: baseline written — ${total} violation(s) in ${Object.keys(observed).length} entries.`)
    return
  }

  const baseline = readBaseline()
  const { added, stale } = diffAgainstBaseline(observed, baseline)

  if (added.length > 0) {
    console.error(`\n✖ lint-layer-boundary: ${added.length} NEW layer-boundary violation(s).\n`)
    for (const a of added) {
      const [file, kind, target] = a.key.split('|')
      const lines = violations.filter(v => keyOf(v) === a.key).map(v => v.line)
      console.error(`  ${file}:${lines.join(',')}  [${kind}] → ${target}  (baseline ${a.want}, now ${a.got})`)
    }
    console.error(
      `\n  INV-3/INV-8: one public entry per layer (core/index.ts, extensions/index.ts);\n` +
        `  no deep import past a barrel; no core → extensions edge; no extension reaching\n` +
        `  into another extension's internals. Import through the barrel instead.\n`,
    )
  }
  if (stale.length > 0) {
    console.error(`\n✖ lint-layer-boundary: ${stale.length} STALE baseline entr(ies) — the ratchet must be tightened.\n`)
    for (const s of stale) {
      console.error(`  ${s.key}  (baseline ${s.want}, now ${s.got})`)
    }
    console.error(
      `\n  You removed a boundary violation — thank you. Tighten the baseline in the SAME commit\n` +
        `  (\`node scripts/lint-layer-boundary.mjs --write\`) so the count cannot drift back up.\n`,
    )
  }
  if (added.length > 0 || stale.length > 0) process.exit(1)

  console.log(
    `✓ lint-layer-boundary: ${scanned} workbench file(s) scanned; ${total} baselined ` +
      `boundary violation(s), ZERO new (ITEM-21 ratchet, INV-3/INV-8).`,
  )
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
