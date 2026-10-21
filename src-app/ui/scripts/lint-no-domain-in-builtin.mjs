#!/usr/bin/env node
/**
 * processor-separability ITEM-11 + ITEM-18 — the un-gameable "no domain
 * knowledge in the app builtin" grep guard (TEST-15 / TEST-21).
 *
 * Backs invariants INV-1 (app backend builtin datatype-free), INV-2 (workbench
 * app FE datatype-free), INV-3 (the maximal strip — no PRODUCTION domain
 * datatype-id literal survives anywhere in the app surface). It scans the
 * APP-BUILTIN production surface and HARD-FAILS (non-zero exit) if ANY domain
 * datatype id / title / lattice-branch literal is found. The domain lattice
 * lives as DATA in `packages/single-cell-types/manifest.yaml`; the app must
 * carry ZERO of it.
 *
 * ── SCOPE (the app-builtin production surface) ──────────────────────────────
 * (WS-R3 §2: and every `.sql` / `.py` / `.json` / `.yaml` file the app embeds or
 * ships — see the extension-policy block at `CODE_EXTS_RUST`.)
 * Backend (Rust): **EVERY** `.rs` file under `src-app/server/src/modules/`
 *   (ITEM-30). It used to be 5 hand-listed files plus a recursive walk of
 *   `soma_serve/` — 9 of 162 files (5.6%), touching 4 of 17 modules and none of
 *   them fully, with 4 of the 9 being feature-gated-OFF reader files a stock
 *   build does not even compile. A hand-listed set also means a NEW module is
 *   unguarded by default, which is backwards: the app surface is the default,
 *   and an exemption must be argued. So the walk is now the whole module tree.
 * Frontend (TS/TSX, under `src-app/ui/src/`):
 *   - `modules/workbench/**`       (the workbench app builtin)
 *   - `core/datatypes/builtin.ts`  (the FE bootstrap lattice — roots only)
 *   - `modules/datasets/components/UploadPanel.tsx`  (catalog-derived — ITEM-16)
 *
 * ── WS-C (2026-07-28): the scan set is now THE TREE ─────────────────────────
 * The scope above still described more than half the codebase as invisible: the
 * FE scan reached `modules/workbench/**` plus TWO named files, and the Rust scan
 * stopped at `modules/`. Measured, that left **165 code + 204 prose** hits in
 * `ui/src` outside the workbench alone. Seven roots are now scanned, each with
 * its own committed file-count floor (`SCAN_FLOORS`):
 *   rust        `server/src/modules/**.rs`   (minus test-only-by-declaration)
 *   rustRoot    `server/src/*.rs` OUTSIDE `modules/`   ← NEW
 *   buildHelper `server/build_helper/**.rs`            ← NEW
 *   desktop     `desktop/**.{rs,ts,tsx}`               ← NEW
 *   workbenchFe `ui/src/modules/workbench/**.{ts,tsx}`
 *   uiFe        ALL the rest of `ui/src/**.{ts,tsx}`   ← NEW
 *   packagesFe  `packages/<SCANNED_PACKAGES>/**.{ts,tsx}` ← NEW
 * `libs/viz` is a DOCUMENTED CARVE-OUT by construction — see
 * `SCANNED_PACKAGES` / `UNSCANNED_PACKAGES` for the mechanism and its measured
 * cost. Any other package that is neither scanned nor documented FAILS the guard.
 *
 * ── DOCUMENTED CARVE-OUT EXCLUSIONS (DEC-10) ────────────────────────────────
 * The former carve-outs were exclusions by CONSTRUCTION (paths simply absent
 * from a hand-listed scan set). Widening the backend scan to the whole module
 * tree removes that mechanism, so each one was re-decided on evidence:
 *   - `predicate/**` — the cell-set query DSL. GONE: the module was deleted, so
 *     the carve-out is ended rather than renewed (there is nothing to exempt).
 *   - `jobs/sse.rs` + `sandbox/streaming.rs` — the `phase` progress string.
 *     DROPPED as a carve-out: re-measured under the widened scan, both files
 *     produce ZERO findings, so the exemption was protecting nothing. They are
 *     now scanned like every other file, which is strictly stronger — a future
 *     real domain literal in either is caught instead of silently permitted.
 * The only surviving backend exemption is STRUCTURAL, not topical:
 *   - a Rust file whose `mod` declaration is `#[cfg(test)]` (see
 *     `testOnlyRustModules`). Such a file is a TEST that never ships, and the
 *     grep-guards among them legitimately spell out the forbidden vocabulary as
 *     literals in order to search for it. Exempting them by DECLARATION (parsed
 *     out of the parent `mod.rs`) rather than by name keeps this un-gameable:
 *     you cannot dodge the guard without making your file genuinely test-only,
 *     at which point it is not in the shipped binary.
 *
 * ── WS-R3 (2026-07-28): the guard stops REFUSING TO LOOK ────────────────────
 * An adversarial audit found the round-2 green was partly an artifact of what the
 * guard declined to read. Four holes, all closed here (the scan set goes 633 → 702
 * files, the ledger 67 → 197 code entries and 0 → 69 LITERAL hits — nothing new was
 * added to the tree; all of it was already there and invisible):
 *   §1 `#[cfg(debug_assertions)]` item blocks were BLANKED, which hid almost all of
 *      `workstore/data_api.rs` — a file registering SIX real HTTP routes — behind a
 *      baseline of 104 prose / ZERO code. Un-blanked. `#[cfg(test)]` stays blanked;
 *      the decision, and its measured cost, are in `stripCfgBlocks`.
 *   §2 only `.rs`/`.ts`/`.tsx` were read — 633 of the 1108 app+test code files.
 *      `.sql`/`.py`/`.json`/`.yaml` are now read too, with a per-root policy stated
 *      at `CODE_EXTS_RUST`/`DATA_EXTS`, and `ui/openapi/openapi.json` (a SHIPPED
 *      CONTRACT) gets its own root.
 *   §3 five tokens (`PBMC`, `nCount`, `pct_ribo`, `ident`, `10x`) were missing from
 *      the vocabulary while present in files the guard already read.
 *   §4 the ratchet itself: the prose tier is now per (file, TOKEN) instead of a
 *      fungible per-file total; every scan floor is back to a ≈⅔ collapse-detector
 *      margin instead of sitting ON its own measurement; `MUST_SCAN_KEYS` pins one
 *      real production file per root; and the `gallery.tsx`/`cassette.ts` BASENAME
 *      exemption (10 files, 190 hits, claimable by naming a file) is gone.
 *
 * ── EXEMPT (DEC-9 — non-production) ─────────────────────────────────────────
 * Within the scoped files, the following are stripped BEFORE matching (they may
 * name domain ids freely — the generic declarative engine explains capabilities
 * with example ids, and test oracles assert on concrete ids):
 *   - comments, for the datatype-ID / TITLE vocabulary ONLY. Domain NOUNS in
 *     comments are NOT exempt any more: they are scanned as their own lower
 *     severity (`domain-prose`) with its own baseline. See WS-B below.
 *   - Rust `#[cfg(test)]` item blocks (code AND the comments inside them).
 *     `#[cfg(debug_assertions)]` is NO LONGER stripped — WS-R3 §1.
 *   - whole files matching `*.test.*` / `*.spec.*`, `__fixtures__/**`,
 *     `__testutil__/**`. (`gallery.tsx` / `cassette.ts` were here until WS-R3 §4.)
 * (`ui/src/processor-packages/**` — the contributed single-cell FE-code package — used to
 * be exempted here; ITEM-15 deleted the directory and ITEM-20 deleted the exemption with
 * it, so nothing is carved out for it any more. The blanket `/gallery/` DIRECTORY
 * exemption went the same way in WS-B — `core/gallery/*.ts` are ordinary production
 * core files; only the dev ENTRY (`gallery.tsx`) and two named seed fixtures remain.)
 *
 * ── WS-B (2026-07-28 DOMAIN_AUDIT §0) ───────────────────────────────────────
 * The full-tree audit found 25 HIGH domain leaks NO guard in the tree could see,
 * across four blind spots — all four closed here:
 *   1. the noun vocabulary omitted `cell`/`obs`/`sample`/`n_cells`/`embedding`,
 *      i.e. the nouns the data model is built out of → widened to 24 tokens;
 *   2. the noun scan skipped the ENTIRE Rust module tree ("It is NOT applied to
 *      the Rust module tree", this file, pre-WS-B) → it now covers it;
 *   3. (`server/tests/domain_surface/mod.rs`, the Rust twin — widened there);
 *   4. `\b` does not fire inside `n_cells` (`_` is a word char) and a letter
 *      boundary alone misses `inputCells` → letter + camelCase-hump boundary.
 * Widening a guard onto a tree with 25 known leaks makes it red. The leaks are
 * therefore RECORDED, per file per token with their DOMAIN_AUDIT finding id, in
 * `domain-baseline.json` — a shrink-only ratchet. Narrowing the guard until it is
 * green is the exact failure this round exists to stop.
 *
 * A domain id in code is ALWAYS a string literal (`"embedding"`,
 * `id === 'clustering'`, `registry.get('single-cell/anndata')`). So bare-word
 * ids are matched ONLY quote-delimited — which is what makes the guard both
 * un-gameable (a real dispatch is caught: `x['embedding']`, `=== "de"`) AND
 * false-positive-free (the host data-channel key `clustering:`, the ref prefix
 * `'clustering:'`, and error copy `` `embedding "…"` `` all fail the anchor).
 * Slash/compound ids never occur generically, so they match as raw substrings.
 *
 * ── WS-R4 (2026-07-28): the TEST TREES stop being invisible ─────────────────
 * `server/tests/**` (≈1258 hits) and `ui/tests/**` (≈449) were in NO scan root at
 * all. That is a stronger statement than "`#[cfg(test)]` blanking hid them" — the
 * blanking never even applied, because the walk never reached the directories.
 * Nobody had ever looked. Four TEST roots are added (`serverTests`,
 * `serverTestsData`, `uiTests`, `uiSpecs`), the `*.test.*`/`*.spec.*` +
 * `__fixtures__`/`__testutil__` exemptions are RETIRED, and the whole residue is
 * baselined in its OWN namespace (`testCode`/`testProse`/`testLiterals`) under
 * `R4-TESTS-*` finding ids. See `isTestTierFile`, `TEST_SCAN_FLOORS` and
 * `CARDINALITY_CERTIFICATIONS`.
 *
 * ── WS-R5 §1 (2026-07-28): the OVERRIDE CLASS is FAIL-CLOSED ────────────────
 * `LINT_NO_DOMAIN_SCAN_OVERRIDE='[]'` used to print ✓ and exit 0 having scanned
 * ZERO files — bypassing SCAN_FLOORS, MUST_SCAN_KEYS, FORMAT_COVERAGE_PINS, the
 * baseline ratchet AND the cardinality certifications simultaneously. That is
 * verbatim the "PASS having scanned nothing" failure `SCAN_FLOORS` exists to stop,
 * reachable from the environment by anyone who can set a variable. THREE env
 * overrides existed and all three were fail-open in that direction (the baseline
 * one differently in shape, identically in effect: point it at a hand-crafted file
 * that matches the observation exactly and every code/prose finding is absorbed).
 *
 * Test-only overrides. They exist because the guard's own suite plants leaks in
 * self-contained temp fixtures and probes collapsed roots, so they cannot be
 * deleted — they are GATED instead. Each is honored ONLY when the opt-in
 * `LINT_NO_DOMAIN_SELFTEST=1` is set; without it the guard IGNORES the override
 * AND fails, naming the variable. Nothing in `npm run check`, the justfile or CI
 * sets the opt-in, and `--require-full-scan` (what CI invokes) rejects it outright.
 *   LINT_NO_DOMAIN_SCAN_OVERRIDE     — JSON `[{ "path": "<abs>", "lang": "rust"|"ts" }]`
 *                                      replaces the default scan set.
 *   LINT_NO_DOMAIN_ROOTS_OVERRIDE    — JSON `{ "<root>": "<abs>", … }` re-points the
 *                                      real root discovery (collapsed-root probes).
 *   LINT_NO_DOMAIN_BASELINE_OVERRIDE — absolute path to a substitute baseline JSON.
 * Independently of that gate, a run that scans ZERO files is a HARD ERROR even
 * under the opt-in, and a NON-override run is held to an aggregate scanned floor —
 * so "told to scan nothing" cannot pass by any route, admitted or not.
 * See `overrideAdmissionViolations` + `scanVolumeViolations`.
 *
 * Usage:  node scripts/lint-no-domain-in-builtin.mjs
 *         node scripts/lint-no-domain-in-builtin.mjs --require-full-scan   (CI)
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UI_ROOT = path.resolve(__dirname, '..') // src-app/ui
const SRC_APP = path.resolve(UI_ROOT, '..') // src-app
const REPO_ROOT = path.resolve(SRC_APP, '..')

// ════════════════════════════════════════════════════════════════════════════
//  WS-R5 §1 — OVERRIDE ADMISSION. The whole class, fail-closed.
// ════════════════════════════════════════════════════════════════════════════
//
// WHY A GATE AND NOT A DELETION. The three overrides are the guard's only seam for
// testing ITSELF: the suite plants a leak in a temp fixture (`SCAN_OVERRIDE`), points a
// root at an empty tree to prove it fails rather than passes vacuously (`ROOTS_OVERRIDE`),
// and swaps a doctored ledger in to drive the ratchet in both directions
// (`BASELINE_OVERRIDE`). Delete them and the guard becomes untestable, which trades one
// hole for a bigger one.
//
// WHY AN OPT-IN AND NOT "KEEP THE FLOORS LIVE UNDER OVERRIDE". Keeping the floors live is
// only coherent for `ROOTS_OVERRIDE` (where they already ARE live — that is what makes the
// collapsed-root probes work). For `SCAN_OVERRIDE` the floors describe THIS repository and
// a three-file temp fixture can never satisfy them, so "keep the floors live" is
// indistinguishable from "delete the override". The separable property is not
// "which checks run" but "who is allowed to ask": a self-test knows it is a self-test; a
// gate run does not, and must not be persuadable that it is one.
//
// So: an override is honored ONLY under `LINT_NO_DOMAIN_SELFTEST=1`. Without it the guard
// (a) IGNORES the override entirely — the real roots, the real baseline and the real scan
// set are used — and (b) FAILS, naming the variable. Both halves matter: reporting alone
// would leave a `--prune-baseline` run silently honoring a hostile baseline path, and
// ignoring alone would let a CI job think it had run something it had not.
//
// The opt-in is defence in DEPTH, not in isolation. It is one deliberate `export` away
// from being set in a CI env block, which is why two further checks sit under it and do
// not consult it at all:
//   * `--require-full-scan` (what the CI workflow invokes) rejects the opt-in AND every
//     override outright, so a `LINT_NO_DOMAIN_SELFTEST=1` smuggled into a workflow env
//     fails the step that would have benefited from it;
//   * `scanVolumeViolations` makes a zero-file scan a hard error under EVERY mode,
//     admitted or not — the specific bypass this section is named for cannot be reached
//     even by a caller holding the opt-in.
const OVERRIDE_ENV_NAMES = [
  'LINT_NO_DOMAIN_SCAN_OVERRIDE',
  'LINT_NO_DOMAIN_ROOTS_OVERRIDE',
  'LINT_NO_DOMAIN_BASELINE_OVERRIDE',
]
const SELFTEST_ENV_NAME = 'LINT_NO_DOMAIN_SELFTEST'

/** @returns {string[]} the override env vars actually set (non-empty) in `env`. */
export function presentOverrides(env = process.env) {
  return OVERRIDE_ENV_NAMES.filter(n => (env[n] ?? '') !== '')
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} argv
 * @returns {string[]} one message per inadmissible override; empty = this run may proceed.
 */
export function overrideAdmissionViolations(env = process.env, argv = process.argv) {
  const out = []
  const set = presentOverrides(env)
  const optIn = env[SELFTEST_ENV_NAME] === '1'
  const fullScan = argv.includes('--require-full-scan')
  if (fullScan) {
    for (const n of set) {
      out.push(
        `--require-full-scan was given but ${n} is set. This mode exists so a CI job can ` +
          `assert it scanned the REAL tree; honoring — or even tolerating — a test-only ` +
          `override here would defeat the assertion. Unset ${n}.`,
      )
    }
    if (optIn) {
      out.push(
        `--require-full-scan was given but ${SELFTEST_ENV_NAME}=1 is set. The self-test opt-in ` +
          `is for this guard's OWN suite; a gate run that carries it is a gate run that can be ` +
          `told what to scan. Unset ${SELFTEST_ENV_NAME}.`,
      )
    }
    return out
  }
  if (set.length > 0 && !optIn) {
    for (const n of set) {
      out.push(
        `${n} is set but ${SELFTEST_ENV_NAME}=1 is not. That override replaces what this guard ` +
          `looks at, so it is honored ONLY for the guard's own test suite — it is being IGNORED ` +
          `for this run, and this run FAILS rather than reporting a result about a tree it was ` +
          `told to substitute. (An override set to '[]' or an empty tree is how a guard prints ` +
          `✓ having scanned NOTHING; that is the failure SCAN_FLOORS exists to stop, and it ` +
          `must not be reachable from the environment.)`,
      )
    }
  }
  return out
}

/** True when this process may honor the test-only overrides. */
const OVERRIDES_ADMITTED =
  process.env[SELFTEST_ENV_NAME] === '1' &&
  !process.argv.includes('--require-full-scan') &&
  overrideAdmissionViolations().length === 0

/** Read an override env var, or `undefined` when this run may not honor it. */
const overrideEnv = name => {
  if (!OVERRIDES_ADMITTED) return undefined
  const v = process.env[name] ?? ''
  return v === '' ? undefined : v
}

// Test-only ROOT override (used by `lint-no-domain-in-builtin.test.mjs` to point the
// REAL scan-set discovery — and therefore the ITEM-37 floors — at an empty temp tree,
// proving the guard FAILS rather than passing vacuously when its hard-coded paths stop
// resolving. Never set in normal use; gated by `OVERRIDES_ADMITTED` above.
//   LINT_NO_DOMAIN_ROOTS_OVERRIDE — JSON `{ "serverModules": "<abs>", "uiSrc": "<abs>" }`
const ROOTS_RAW = overrideEnv('LINT_NO_DOMAIN_ROOTS_OVERRIDE')
const ROOTS = ROOTS_RAW ? JSON.parse(ROOTS_RAW) : {}
const SERVER_MODULES = ROOTS.serverModules ?? path.join(SRC_APP, 'server', 'src', 'modules')
const UI_SRC = ROOTS.uiSrc ?? path.join(UI_ROOT, 'src')
// WS-C roots. Overridable by the same test-only env var so the collapsed-root
// test can point EVERY root at an empty temp tree.
const SERVER_SRC = ROOTS.serverSrc ?? path.join(SRC_APP, 'server', 'src')
const BUILD_HELPER = ROOTS.buildHelper ?? path.join(SRC_APP, 'server', 'build_helper')
const DESKTOP = ROOTS.desktop ?? path.join(SRC_APP, 'desktop')
const PACKAGES = ROOTS.packages ?? path.join(SRC_APP, 'libs')
// ── WS-R4: the TEST TREES. Overridable by the same test-only env var. ───────
const SERVER_TESTS = ROOTS.serverTests ?? path.join(SRC_APP, 'server', 'tests')
const UI_TESTS = ROOTS.uiTests ?? path.join(UI_ROOT, 'tests')

// ── WS-C: `packages/` — the viz CARVE-OUT, by construction ──────────────────
//
// `SCANNED_PACKAGES` is a HAND-LISTED allowlist, not a directory walk with a
// skip-filter. `libs/viz` is therefore excluded BY CONSTRUCTION: there is no
// filter to widen, no exclusion regex to relax — the path is simply never built,
// so no edit short of adding 'viz' to this array can bring it in or take another
// package out unnoticed.
//
// WHAT THE CARVE-OUT COSTS (owner decision, 2026-07-28 — the owner is not working
// in `libs/viz` this round). Measured, not assumed:
//   * **62 true-domain tokens in the library CORE** stay invisible — worst
//     `libs/viz/src/index.ts` (15) and `libs/viz/src/core.ts` (7).
//   * **144 more in `libs/viz/showcase/stories`**.
//   * Nothing prevents NEW ones: `libs/viz` is unguarded, so the count above
//     is a floor on the debt, not a bound on it. It will have grown by the time
//     someone reads this.
// Ending the carve-out is a one-word edit (`'viz'` into the array) plus a
// baseline pass over ~206 hits. That is the whole cost — it is deferred, not
// impossible.
const SCANNED_PACKAGES = ['dock']

/**
 * Every OTHER directory under `packages/` must appear here with a reason, or the
 * guard FAILS. `SCANNED_PACKAGES` alone would silently ignore a package added
 * tomorrow; this makes "not scanned" a decision someone has to write down.
 */
const UNSCANNED_PACKAGES = {
  viz: 'owner decision 2026-07-28 — out of scope this round; see the SCANNED_PACKAGES comment for the measured cost (62 library-core + 144 showcase domain tokens invisible).',
}

// ════════════════════════════════════════════════════════════════════════════
//  The forbidden domain vocabulary — DERIVED FROM THE MANIFESTS (WS-R5 G2)
// ════════════════════════════════════════════════════════════════════════════
//
// It used to be a HAND-LISTED mirror, introduced as "the 16 domain datatype ids (DATA in
// `single-cell-types/manifest.yaml`)". It had drifted, in both directions at once:
//
//   * `de` was listed but had been PRUNED — it does not ship. The guard was spending a
//     quoted-id token, and a `QUOTED_TITLE` entry (`'Differential expression'`), on a
//     type that no longer exists.
//   * FIVE shipped ids were absent — `cell-set` (caught incidentally by the `cell` noun,
//     i.e. by luck) plus `geneset/collection`, `graph/attributed`, `de/result` and
//     `annotation-table`, FOUR of which were invisible to every tier. Note that the
//     `gene` noun does NOT rescue `geneset/collection`: the lowercase `s` fails the
//     right-hand letter/camel boundary.
//   * TWO of the three contributing packages were unaccounted for entirely. The comment
//     named ONE manifest; `open-kinds` (3 datatypes) and `anndata-import` (1) were never
//     in anybody's mental model of "the lattice".
//
// A hardcoded mirror of DATA drifts again the moment a package contributes a type, and
// the failure mode is SILENT (a new contributed id is simply never forbidden). So the
// list is now READ from the same manifests the loader reads. A future contributed id is
// forbidden on arrival, with no edit here at all, and the parse is held to
// `contributedVocabularyViolations` so a broken parse fails loudly instead of yielding a
// short vocabulary that quietly forbids less.
const PROCESSORS_DIR = path.join(SRC_APP, 'packages')

/**
 * Every `contributes.datatypes[]` entry across every processor package's manifest.
 *
 * A deliberately minimal, INDENTATION-EXACT slice reader rather than a YAML dependency:
 * this file has no dependencies by design (it is a gate, and a gate that can be broken by
 * a transitive dep bump is a worse gate). It reads only what it needs — the `datatypes:`
 * block under `contributes:`, at the exact indentation every manifest in the tree uses —
 * and `contributedVocabularyViolations` turns any drift in that shape into a hard failure
 * rather than a short list.
 *
 * The `datatypes:` slice matters: `title:` also appears at the same depth under
 * `analyses:`, `converters:` and `views:`, so a whole-file `title:` grep would sweep
 * analysis labels ("Cell filter", "Compute QC metrics") into the DATATYPE title tier.
 *
 * @param {string} dir the processors directory
 * @returns {{pkg:string,id:string,title:string|null}[]}
 */
export function contributedDatatypes(dir = PROCESSORS_DIR) {
  const out = []
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!e.isDirectory()) continue
    const file = path.join(dir, e.name, 'manifest.yaml')
    if (!existsSync(file)) continue
    let inDatatypes = false
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      if (/^\s*(#|$)/.test(raw)) continue
      const indent = raw.length - raw.trimStart().length
      if (!inDatatypes) {
        if (indent === 2 && /^\s*datatypes:\s*$/.test(raw)) inDatatypes = true
        continue
      }
      if (indent <= 2) {
        inDatatypes = false
        continue
      }
      let m = raw.match(/^ {4}- id:\s*(.+?)\s*$/)
      if (m) {
        out.push({ pkg: e.name, id: m[1].replace(/^["']|["']$/g, ''), title: null })
        continue
      }
      m = raw.match(/^ {6}title:\s*(.+?)\s*$/)
      if (m && out.length > 0 && out[out.length - 1].title === null) {
        out[out.length - 1].title = m[1].replace(/^["']|["']$/g, '')
      }
    }
  }
  return out
}

/**
 * WS-R5 G2 — fail-closed on the DERIVATION itself.
 *
 * Deriving the vocabulary from DATA removes the drift, and replaces it with a new way to
 * be silently wrong: if the manifests move, or the indentation shape changes, the parse
 * yields a SHORT list and the guard forbids less while still printing ✓. That is the same
 * "scoped just narrowly enough" failure `SCAN_FLOORS` exists to stop, one level up. So the
 * derivation gets its own floor, its own completeness rule, and its own package census.
 * @returns {string[]}
 */
export function contributedVocabularyViolations(entries = CONTRIBUTED_DATATYPES) {
  const out = []
  if (entries.length < CONTRIBUTED_DATATYPE_FLOOR) {
    out.push(
      `the processor manifests yielded ${entries.length} contributed datatype(s), below the ` +
        `committed floor of ${CONTRIBUTED_DATATYPE_FLOOR}. The vocabulary this guard forbids is ` +
        `DERIVED from ${path.relative(SRC_APP, PROCESSORS_DIR)}/*/manifest.yaml; a short parse ` +
        `means the manifests moved or their shape changed, and the guard is now forbidding ` +
        `LESS than the tree contributes. Re-point \`contributedDatatypes\`, or lower ` +
        `CONTRIBUTED_DATATYPE_FLOOR deliberately if the lattice really shrank.`,
    )
  }
  const pkgs = new Set(entries.map(e => e.pkg))
  if (pkgs.size < CONTRIBUTING_PACKAGE_FLOOR) {
    out.push(
      `only ${pkgs.size} package(s) were seen contributing datatypes (${[...pkgs].join(', ') || 'none'}), ` +
        `below the committed floor of ${CONTRIBUTING_PACKAGE_FLOOR}. The pre-WS-R5 hand-list ` +
        `mirrored ONE manifest and two contributing packages went unaccounted for; this is what ` +
        `notices if the walk regresses to that.`,
    )
  }
  for (const e of entries) {
    if (!e.title) {
      out.push(
        `contributed datatype "${e.id}" (${e.pkg}) has no \`title:\` in the slice this guard ` +
          `reads. The TITLE tier would then silently under-cover it — a hardcoded label is as ` +
          `much of a leak as a hardcoded id.`,
      )
    }
  }
  return out
}

/** Measured 2026-07-28: 20 across 3 packages. A floor, not an equality — a NEW
 *  contributed id must be forbidden on arrival without anyone editing this file.
 *
 *  LOWERED 20 -> 19 (artifact-model ITEM-38), taking the branch this floor's own failure
 *  text offers ("lower CONTRIBUTED_DATATYPE_FLOOR deliberately if the lattice really
 *  shrank"). It shrank by exactly one: the lossless multi-file store type left
 *  `single-cell-types` at its 0.6.0, because ITEM-27 had already deleted the only thing
 *  that could produce it. This is not the failure the floor catches — that one is a
 *  collapsed/mis-pointed parse, a LARGE drop toward zero — the walk still reads 3
 *  packages, and a re-added id is still forbidden on arrival with no edit here. Lowered
 *  in lockstep with the Rust twin's constant of the same name in
 *  `server/tests/domain_surface/mod.rs`; the two must agree or neither checks the other. */
const CONTRIBUTED_DATATYPE_FLOOR = 19
const CONTRIBUTING_PACKAGE_FLOOR = 3

const CONTRIBUTED_DATATYPES = contributedDatatypes()

/** The domain datatype ids, as contributed. */
const DATATYPE_IDS = CONTRIBUTED_DATATYPES.map(e => e.id)

/** Their display titles (a hardcoded label like `'AnnData'` is a regression). */
const DATATYPE_TITLES = CONTRIBUTED_DATATYPES.map(e => e.title).filter(Boolean)

/**
 * Slash / compound tokens — never occur in generic code, so matched as raw
 * substrings. `single-cell` (no slash) also catches the relocated-widget paths
 * (`single-cell-widgets`, a hardcoded `processor-packages/single-cell/…`) that
 * INV-2 forbids the workbench app from naming.
 *
 * WS-R5 G2 — the SLASH ids are now DERIVED too, and that closed a hole the hand-list
 * created: `QUOTED_ID_TOKENS` excludes any id containing `/` (a slash id is never
 * quote-delimited in a path), on the understanding that this list picks them up. It did —
 * for the three that were written down. `geneset/collection`, `graph/attributed` and
 * `de/result` were in NEITHER, so those ids were matched by nothing at all; only their
 * TITLES were. (`geneset/collection` is not rescued by the `gene` noun either: the
 * lowercase `s` in `geneset` fails the right-hand letter boundary.) The union is
 * order-stable and de-duplicated so the alternation is deterministic.
 */
/** Structural PATH prefixes — not datatype ids. Each SUBSUMES every id beneath it. */
const SUBSTRING_PREFIXES = ['single-cell']
const SUBSTRING_TOKENS = [
  ...new Set([
    ...SUBSTRING_PREFIXES,
    // Slash ids NOT already subsumed by a prefix above. The subsumption filter is
    // load-bearing, not tidiness: substring tokens are matched INDEPENDENTLY (unlike the
    // nouns, which arbitrate longest-first), so adding `single-cell/expression` alongside
    // `single-cell` double-counts every site — measured, 60+ duplicate findings — and
    // every one of those sites is already caught by the prefix.
    ...DATATYPE_IDS.filter(
      id => id.includes('/') && !SUBSTRING_PREFIXES.some(p => id.startsWith(`${p}/`)),
    ),
  ]),
]

// ── ITEM-19 + WS-B: the domain NOUN vocabulary ───────────────────────────────
//
// Until ITEM-19 the guard's whole vocabulary was datatype IDS + TITLES — it did
// not contain a single domain NOUN. That is why `core/**` could pass the guard
// while `core/columns/ref.ts` still declared a `{ gene }` ref variant and
// `DataCtx.geneIndex()`: no id, no title, no finding.
//
// ITEM-19 closed that with SEVEN nouns. The 2026-07-28 full-tree domain audit
// (`.lifecycle/processor-ui-language/DOMAIN_AUDIT.md`) then found **25 HIGH
// domain leaks the guard could not see**, and §0 names why: the word list omitted
// `cell`, `obs`, `sample`, `n_cells` and `embedding` — i.e. it omitted the nouns
// the actual data model is built out of. `ProjectCatalog { n_cells, n_genes }`
// (E1), `ResidentInput { inputCells, inputFeatures }` (E5) and
// `FAKE_HOST_N_CELLS` (C4) each sat in a scanned file and produced ZERO findings.
//
// So the list below is the DATA-MODEL vocabulary, not a spot-fix. Three groups:
//   * structural axis nouns — `cell(s)`, `gene(s)`, `obs`, `sample(s)`,
//     `feature(s)`, `barcode(s)`: the two-axis assumption §1 identifies as the
//     root cause. These are the ones that catch a STRUCTURAL commitment
//     (`{n_cells, n_genes}`) rather than a label.
//   * derived-artifact nouns — `embedding(s)`, `leiden`, `umap`, `cellset`.
//   * format / tool nouns — `adata`, `anndata`, `h5ad`, `soma`, `cellranger`,
//     `genome`.
//
// `obs` is now IN the vocabulary, reversing the ITEM-19 exclusion — but ONLY
// because it is now BASELINED rather than ignored. DEC-J is still in force: `obs`
// is a declared `view_spec` LANGUAGE key (`keep_mask.obs`, `columns_of.obs`), a
// logical dataset-id grammar (`obs` / `obs.kept` / `<ds>.obs`) and a server data
// path (`/obs`), and renaming it is a versioned LANGUAGE change. Excluding the
// token entirely, however, also hid C6/C7/C8 — core PRIVILEGING a slice named
// `obs`, which is a leak and not a language key. The three sites that motivated
// this (`GateData`, `extractObsSlice`, `DeclarativeRegion`'s hardcoded slice key)
// have since been DELETED — round 3's `r3fedead` removed the last of them — so
// they are named here as the historical WHY, not as live code. Baselining lets
// the DEC-J uses pass under a stated note while a NEW `obs` privilege is caught.
// ── WS-C (2026-07-28) — the vocabulary GAP ──────────────────────────────────
//
// WS-B widened the list to the 24 tokens below the divider. Widening the SCAN
// SET to the whole tree (WS-C) immediately showed the vocabulary was still
// short of the domain the tree actually speaks: `DE` tables, `enrichment`,
// `pct_mito`, `QC`, `scanpy`, `seurat`, `mtx` trios, `h5mu`, `transcriptome`,
// `BAM`, `GRCh38`, `vis2D` and `tiledbsoma` were all invisible — including
// `vis2D`, which is the LITERAL that DOMAIN_AUDIT E6 is about (core substring-
// matching `vis2D` to detect a data precondition), and `tiledbsoma`, which the
// existing `soma` token cannot see because the camel/letter boundary refuses a
// lowercase-letter left neighbour (`tiledb` + `soma`).
//
// These are added HERE, in the same case-insensitive letter/camel tier, EXCEPT
// the three short ALL-CAPS acronyms — see ACRONYM_NOUNS below for why they need
// their own boundary.
const DOMAIN_NOUNS = [
  // ITEM-19 (unchanged)
  'gene', 'genes', 'leiden', 'umap', 'cellset', 'cell-set', 'cell_set',
  // WS-B — structural axis nouns (DOMAIN_AUDIT §1 root cause)
  'cell', 'cells', 'obs', 'sample', 'samples', 'feature', 'features',
  'barcode', 'barcodes',
  // WS-B — derived artifacts
  'embedding', 'embeddings',
  // WS-B — format / tool nouns
  'adata', 'anndata', 'h5ad', 'soma', 'cellranger', 'genome',
  // WS-C — derived artifacts + assay vocabulary
  'enrichment', 'pct_mito', 'transcriptome', 'vis2D',
  // WS-C — format / tool nouns. `tiledbsoma` is listed EXPLICITLY even though
  // `soma` is already a token: the left boundary rejects `…dbsoma` (lowercase
  // neighbour, lowercase match start), so the single most common spelling of the
  // store API in this tree was invisible. Longest-first alternation makes this
  // entry win over `soma`, so each site still counts ONCE.
  'scanpy', 'seurat', 'mtx', 'h5mu', 'tiledbsoma', 'GRCh38',
  // ── WS-R3 §3 — four tokens that were absent for no reason but omission ─────
  // MEASURED present in files the guard ALREADY reads, and invisible only because
  // nobody had listed them (`PBMC` is in ACRONYM_NOUNS below; these four here):
  //   `nCount`   — the Seurat count-depth column. Its sibling `nFeature` was
  //                already caught, but only ACCIDENTALLY: `feature` is a token and
  //                the camel hump makes `nFeature` match. `nCount` has no such
  //                luck because `count` is (correctly) not a token.
  //   `pct_ribo` — the direct sibling of `pct_mito`, which HAS been in the list
  //                since WS-C. One of the pair being listed and the other not is
  //                the clearest possible statement that the list is hand-curated
  //                rather than derived.
  //   `ident`    — the Seurat cluster/sample identity column. See
  //                `NON_DOMAIN_IDENTIFIERS` + `isRustMacroFragment` for the two
  //                boundary rules that keep `identity` / `identifier` / `IDENTICAL`
  //                and Rust's `$x:ident` macro fragment out, without dropping it.
  //   `10x`      — the vendor. DIGIT-initial, so it gets the stricter left
  //                boundary in `matchNouns` (see `isAlnum(prev)` there) — otherwise
  //                `110x` would match.
  'nCount', 'pct_ribo', 'ident', '10x',
]

/**
 * WS-C — SHORT ALL-CAPS ACRONYMS, matched CASE-SENSITIVELY with a
 * NON-ALPHANUMERIC boundary on both sides.
 *
 * `DE` (differential expression), `QC` (quality control) and `BAM` cannot go in
 * the tier above. Measured on the widened scan set, case-insensitive + the
 * letter/camel boundary gives `DE` **1575** hits — `DERIVED`, `DESIGN`, `DEC-5`,
 * `DEFAULT` — because an uppercase neighbour is treated as a camel continuation.
 * That is not a vocabulary, it is noise, and a noisy guard gets narrowed.
 *
 * The stricter rule (case-sensitive; previous and next char must not be
 * `[A-Za-z0-9]`) measures **DE 41 / QC 103 / BAM 6**, and every sampled hit is a
 * genuine domain reference (`a (comparison,gene) DE table`, `a QC metric column`,
 * `Zarr chunk-dir / BAM+bai`). The cost is stated plainly: lowercase `de` / `qc`
 * / `bam` as bare words are NOT matched by this tier. `'de'` and `'report/qc'`
 * are already covered as a quoted datatype id and a substring token
 * respectively, so the uncovered remainder is a lowercase acronym in running
 * prose — the cheapest possible miss, and the alternative was 1500 false reds.
 */
/*
 * WS-R3 §3 adds `PBMC` here rather than to `DOMAIN_NOUNS`: it is a SHORT ALL-CAPS
 * acronym and gets the identical treatment for the identical reason. Case-sensitive
 * + non-alphanumeric boundary measures 4 raw hits and every one is a genuine domain
 * reference (a fixture filename `PBMC_donor1.h5ad`; two FE comments that literally
 * record having REMOVED "e.g. PBMC atlas" from placeholder copy — i.e. the prose
 * tier catching the residue of an earlier strip, which is what it is for).
 */
const ACRONYM_NOUNS = ['DE', 'QC', 'BAM', 'PBMC']

/**
 * Longest-first so `cellranger` / `cell_set` / `embeddings` win the alternation
 * over their own prefixes (`cell`, `embedding`) and each site counts ONCE.
 */
const NOUN_ALT = [...DOMAIN_NOUNS].sort((a, b) => b.length - a.length).map(escapeRe).join('|')
const NOUN_RE = new RegExp(`(${NOUN_ALT})`, 'gi')

/** WS-C acronym tier — CASE-SENSITIVE (no `i` flag), non-alphanumeric boundary. */
const ACRONYM_ALT = [...ACRONYM_NOUNS].sort((a, b) => b.length - a.length).map(escapeRe).join('|')
const ACRONYM_RE = new RegExp(`(${ACRONYM_ALT})`, 'g')

const isLetter = ch => ch !== undefined && ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z'))
const isUpper = ch => ch !== undefined && ch >= 'A' && ch <= 'Z'
const isLower = ch => ch !== undefined && ch >= 'a' && ch <= 'z'

/**
 * The BOUNDARY — WS-B blind spot #4, and the single most load-bearing fix here.
 *
 * `\b` treats `_`/`-`/digits as word characters, so `\bcell\b` does NOT match
 * `n_cells`. That one fact hid `ProjectCatalog { n_cells, n_genes }` — the
 * structural two-axis commitment the whole audit turns on — from every guard in
 * the tree. ITEM-19 already replaced `\b` with a LETTER boundary for its seven
 * nouns, which fixes `n_genes` / `X_umap` / `cell-set`.
 *
 * A letter boundary alone is still fail-open on camelCase: `inputCells` (E5),
 * `nCells`, `cellCount` all have a LETTER on the joining side. So the rule is:
 *
 *   LEFT  ok when the preceding char is not a letter, OR when it is a
 *         lowercase letter/digit and the match starts UPPERCASE (a camel hump:
 *         `inputCells`, `nObs`). A preceding UPPERCASE letter is never a hump
 *         (`Jobs`, `EXCELLENT`).
 *   RIGHT ok when the following char is not a LOWERCASE letter. An uppercase
 *         letter continues the camel word (`cellsById` → still `cells`), a
 *         lowercase one means we matched a PREFIX of a longer word
 *         (`generic`, `generator`, `observed`, `resampled`, `Somatic`).
 *
 * Net: matches `n_cells`, `MAX_CELLS`, `inputCells`, `X_umap`, `cell-set`,
 * `nObs`, `.h5ad`; misses `generic`, `general`, `generated`, `generator`,
 * `degenerate`, `jobs`/`Jobs`/`JOBS`, `observed`, `obsolete`, `excellent`,
 * `resample`, `Somatic`.
 */
/**
 * LANGUAGE-LEVEL identifiers that merely CONTAIN a vocabulary noun and are not
 * domain references in any deployment — the same class as DOMAIN_AUDIT §7's
 * `std::marker::PhantomData` (which needs no entry here only because `marker` is
 * not in the vocabulary). `OnceCell` / `once_cell` / `RefCell` are Rust std and
 * crate types; there are ~40 of them across the server and every future one would
 * be a nuisance red. They are suppressed STRUCTURALLY — matched on the WHOLE
 * surrounding identifier, so a domain `cell_count` next door is untouched — and
 * the list is deliberately tiny and unambiguous.
 *
 * NOT in this list, on purpose: the dock's GRID `cells`, `onCellClose`,
 * `CellCloseRouter`. Those really are ambiguous English, so they are BASELINED
 * (visible, with a FALSE-POSITIVE tag and a note) rather than suppressed — an
 * invisible suppression of an ambiguous word is how the next `n_cells` hides.
 */
const NON_DOMAIN_IDENTIFIERS = new Set([
  'oncecell', 'once_cell', 'refcell', 'ref_cell', 'unsafecell', 'unsafe_cell',
  'lazycell', 'lazy_cell', 'syncunsafecell', 'oncelock',
  // ── WS-C: the ALL-CAPS blind spot of the RIGHT boundary ───────────────────
  // `rightOk` accepts an uppercase next char because it continues a camel word
  // (`cellsById` → still `cells`). In an ALL-CAPS word every next char is
  // uppercase, so `GENERIC` matches `gene`, `OBSERVED` matches `obs`, `SOMATIC`
  // matches `soma` — the very cases the lowercase rule already rejects
  // (`generic`, `observed`, `somatic`). Prose is written in emphasis caps, so
  // widening the scan to the whole tree made this the single largest source of
  // nuisance red.
  //
  // These are DIFFERENT WORDS, not ambiguous ones — the same class as
  // DOMAIN_AUDIT §7's `std::marker::PhantomData`, not the same class as the
  // dock's GRID `cells` (which stays BASELINED, visibly). Suppression is
  // STRUCTURAL: the WHOLE surrounding identifier must equal one of these, so a
  // real `gene_generic` or `GENERIC_CELL_CAP` is untouched.
  'generic', 'general', 'generate', 'generates', 'generated', 'generator',
  'generators', 'generation', 'degenerate', 'regenerate',
  'observed', 'observe', 'observer', 'observation', 'observable', 'obsolete',
  'somatic',
  // ── WS-R3 §3: the ALL-CAPS blind spot again, for the new `ident` token ─────
  // Same class, same mechanism: `IDENTICAL` / `IDENTITY` are DIFFERENT WORDS, and
  // the lowercase spellings are already rejected by `rightOk` (next char is a
  // lowercase letter). Only the emphasis-caps spellings leak through, so only they
  // need an entry. The suppression is on the WHOLE surrounding identifier, so a
  // real `ident_col` or `SAMPLE_IDENT` is untouched.
  'identical', 'identically', 'identity', 'identities', 'identifier', 'identifiers',
  'identified', 'identify', 'identifies', 'identification', 'identifying',
])

/**
 * WS-R3 §3 — Rust MACRO FRAGMENT SPECIFIERS, the other half of making `ident`
 * usable as a vocabulary token.
 *
 * `ident` is a Rust macro_rules FRAGMENT KIND, and this tree writes a lot of
 * declarative macros: `($static:ident, $id:literal, $ctor:ident)`,
 * `($ident:ident, $name:literal, …)`, `pub struct $ident;`. Those are LANGUAGE
 * syntax with no domain content whatsoever — the same class as `OnceCell` above —
 * and they are ~30 of the 60 raw `ident` hits in the tree. Left un-handled they
 * would make the token pure noise, and a noisy token gets deleted.
 *
 * They are suppressed STRUCTURALLY, by SHAPE, not by name: a match is a fragment
 * specifier iff it is preceded by `$` (the metavariable `$ident`) or by `:` that is
 * itself preceded by a `$`-prefixed metavariable name (`$x:ident`). A domain
 * `"ident"` column key, `obj.get("ident")`, `{criterion: {ident: […]}}` or
 * `for (ident, range)` has neither shape and is still caught. Rust only — the
 * shape does not exist in the other dialects.
 */
function isRustMacroFragment(text, start) {
  const prev = start > 0 ? text[start - 1] : undefined
  if (prev === '$') return true
  if (prev !== ':') return false
  let a = start - 1
  while (a > 0 && isIdentChar(text[a - 1])) a--
  return a > 0 && text[a - 1] === '$'
}

/**
 * WS-R8 — RUST CARGO / `cfg` BUILD-CONFIGURATION `feature`: the other un-rewordable
 * software sense of a domain token.
 *
 * `feature` is a single-cell noun (the gene/measured-variable axis), but it is ALSO the
 * Cargo keyword for a compile-time build flag. The compute + accounts epics gate whole
 * modules behind `#[cfg(feature = "saas")]`, so every saas-gated module now carries the
 * attribute — and it RECURS by construction on the next gated module. Baselining 30+
 * `#[cfg(feature = "saas")]` lines would be per-module whack-a-mole that re-reds on the
 * next file; the attribute is a build token with ZERO domain content, so it is excluded
 * by CONTEXT instead. (This matches the pre-existing GENERIC baselines for software
 * `feature` in prose — `lib.rs` "cargo feature", `build_helper/mod.rs` "the feature
 * self-disables" — extended to the recurring cfg/cargo GRAMMAR so it needs no baseline.)
 *
 * The exclusion is SHAPE-based and Rust-only, and fires ONLY on the cargo/cfg grammar,
 * never on a bare `feature` in prose or an identifier — so a genuine genomic `feature`
 * (`the feature matrix`, `n_features`, `feature_id`) is STILL caught (negative-control
 * test). A `feature`/`features` token is a cargo/cfg build token iff:
 *   - it is followed by `= "…"` / `="…"`                        → the cfg predicate KEY
 *   - it is preceded by `cfg(` / `not(` / `all(` / `any(`       → the cfg predicate
 *   - it is preceded by `default-` / `--`  (`default-features`, `--features`) → cargo manifest/CLI
 *   - it is preceded by `cargo ` / `cargo-`                     → a prose "cargo feature"
 * A genomic `feature` is never written in any of these shapes.
 */
function isCargoCfgFeatureToken(text, start, end) {
  const after = text.slice(end, end + 4)
  const before = text.slice(Math.max(0, start - 16), start)
  if (/^\s*=\s*"/.test(after)) return true // feature = "…"
  if (/(?:^|[^A-Za-z_])(?:cfg!?|not|all|any)\s*\(\s*$/.test(before)) return true // cfg(feature …
  if (/(?:^|[^A-Za-z_])(?:no-)?default-$/.test(before)) return true // (no-)default-features
  if (/(?:^|\s)--$/.test(before)) return true // --features
  if (/(?:^|[^A-Za-z_])cargo[ \t-]$/.test(before)) return true // cargo feature
  return false
}

/**
 * ── WS-R9: the SAAS/CARGO `feature` PROSE class ─────────────────────────────
 *
 * `isCargoCfgFeatureToken` above excludes `feature`/`features` when it sits in the
 * cfg/cargo GRAMMAR itself (`cfg(feature = "…")`, `--features`, `default-features`,
 * `cargo feature`). The saas billing epic (and the sibling compute/accounts epic)
 * gate whole modules behind `#[cfg(feature = "saas")]`, and their prose therefore
 * refers to "the feature" / "the `saas` feature" / crate "features" (sqlx's
 * `chrono`+`time`) in ordinary sentences that carry NONE of that grammar —
 * `repository.rs` "sqlx has BOTH the chrono and time features", `common/mod.rs`
 * "the rollup loop is gated on the feature", the migration comments "regardless of
 * the `saas` cargo feature". Baselining each of those 24 lines is per-module
 * whack-a-mole that re-reds on the next saas-gated module; the token is a cargo/
 * software one with ZERO genomic content, so it is excluded by CONTEXT.
 *
 * Two additional signals compose with the grammar rule (any one suffices):
 *   P2 FILE-CONTEXT — a Rust file that carries a `#[cfg(feature = "…")]` attribute
 *      IS a cargo-feature-gated module; bare "feature" in its prose is that cargo
 *      feature. A genuine genomic `feature` (`feature matrix`, `n_features`,
 *      `feature_id`) lives in a NON-gated file — Python/TS or an ungated .rs — and
 *      STILL fires (negative-control test). `scanFile` computes the flag per file.
 *   P3 LINE-CONTEXT — a CARGO/cfg-SPECIFIC context word on the SAME line
 *      (`saas` / `cargo` / `cfg` / `sqlx` / `crate` / `--features` /
 *      `default-features` / `build.rs`). These are cargo/build vocabulary that never
 *      sits on a line describing a genomic feature/var, so a genuine domain `feature`
 *      is untouched. The set is deliberately KEPT to the cargo/cfg register (no
 *      generic `compile`/`gate`) so it cannot reach a software-or-genomic `feature`
 *      in an unrelated file. This is what clears the two saas-gated files that carry
 *      no cfg attribute of their own (`repository.rs` via `sqlx`, `common/mod.rs` via
 *      `saas`) and the SQL migration comments (not Rust, so P2 does not apply —
 *      `saas`/`cargo`/`cfg`/`build.rs` on the line does). P3 is gated to `rust`/`sql`
 *      — the only dialects where this register is cargo grammar; in TS/JS/Python the
 *      same words are ordinary code and the token stays CAUGHT.
 *
 * NOTE the grammar rule (P1) stays RUST-ONLY: outside Rust, `features = "…"` is an
 * ordinary assignment (e.g. the 10x `features.tsv` fixture `features = "".join(…)`),
 * NOT a cfg predicate key, and must still fire as a genomic token.
 */
const CARGO_FEATURE_CONTEXT_RE =
  /\b(?:saas|cargo|cfg|sqlx|crate|default-features|build\.rs)\b|--features?\b/i

/** The physical source line the offset `pos` sits on (newline-delimited window). */
function lineWindow(text, pos) {
  let a = pos
  while (a > 0 && text[a - 1] !== '\n') a--
  let b = pos
  while (b < text.length && text[b] !== '\n') b++
  return text.slice(a, b)
}

/**
 * True when a `feature`/`features` token at [start,end) is the CARGO/software sense,
 * not the genomic sense. Composes three precise signals — the cfg/cargo grammar (P1,
 * Rust only), the file being a cfg-feature-gated Rust module (P2), and a cargo/cfg
 * context word on the token's own line (P3).
 */
function isCargoFeatureSense(text, start, end, lang, fileHasCfgFeatureAttr) {
  if (lang === 'rust' && isCargoCfgFeatureToken(text, start, end)) return true // P1
  if (lang === 'rust' && fileHasCfgFeatureAttr) return true // P2
  // P3 fires only where the cargo/cfg register is a real dialect: Rust and its
  // migration SQL. In TS/JS/Python a `saas`/`feature` line is NOT cargo grammar (e.g.
  // TS `const feature = "saas"` is an ordinary assignment that must stay CAUGHT).
  if (lang === 'rust' || lang === 'sql') {
    return CARGO_FEATURE_CONTEXT_RE.test(lineWindow(text, start))
  }
  return false
}

const isIdentChar = ch =>
  ch !== undefined && (isLetter(ch) || (ch >= '0' && ch <= '9') || ch === '_')

/** The full `[A-Za-z0-9_]` identifier the match at [start,end) sits inside. */
function surroundingIdentifier(text, start, end) {
  let a = start
  let b = end
  while (a > 0 && isIdentChar(text[a - 1])) a--
  while (b < text.length && isIdentChar(text[b])) b++
  return text.slice(a, b)
}

/**
 * ── WS-R4: the SEGMENT the match sits in ────────────────────────────────────
 *
 * `NON_DOMAIN_IDENTIFIERS` is checked against the WHOLE surrounding identifier, and
 * that is deliberate for the `once_cell` / `refcell` class — the entry IS the whole
 * name. But it makes the suppression useless the moment the different-word lands
 * inside a COMPOUND name, which is the normal case in `SCREAMING_SNAKE`:
 * `CYTO_ENV_IMAGE_IDENTITY_REGEXP` (`sandbox/env_image.rs`) yields the whole-identifier
 * string `cyto_env_image_identity_regexp`, which is not in the set, so the `identity`
 * entry never fires and the round-3 `ident` token reports 3 hits on an operator-facing
 * env-var name with no domain content whatsoever. Same for `DEFAULT_IDENTITY_RE` and
 * `identity_re` in the same file. That is fresh fallout from adding `ident`, and a noisy
 * token is a token that gets deleted — so the boundary is fixed, not the vocabulary.
 *
 * The rule is now: suppress when the WHOLE identifier is a non-domain identifier (the
 * `once_cell` case, unchanged) **OR** when the SEGMENT the match sits in is one (the
 * `…_IDENTITY_…` case). Segments split on `_` and on camel humps.
 *
 * WHY BOTH AND NOT JUST SEGMENTS: `once_cell` segments to `once` + `cell`, and `cell` is
 * a real vocabulary token — a segment-only rule would UN-suppress every `once_cell` in
 * the server. And why segments do not over-suppress: this file's own header promises
 * `GENERIC_CELL_CAP` stays caught, and it does — the `gene` inside `GENERIC` is
 * suppressed (segment `generic`, which is correct: that `gene` is not a domain
 * reference), while the `CELL` match segments to `cell`, which is NOT in the set and is
 * still reported. Likewise a real `SAMPLE_IDENT` segments to `ident`, not in the set,
 * still reported.
 */
function segmentContaining(ident, offset) {
  const bounds = [0]
  for (let i = 1; i < ident.length; i++) {
    const prev = ident[i - 1]
    const cur = ident[i]
    if (cur === '_') {
      bounds.push(i, i + 1)
      continue
    }
    if (prev === '_') continue
    // camel hump: lower/digit → Upper, or Upper → Upper followed by lower (`HTTPServer`)
    if (isUpper(cur) && (!isUpper(prev) || isLower(ident[i + 1]))) bounds.push(i)
  }
  bounds.push(ident.length)
  const uniq = [...new Set(bounds)].sort((x, y) => x - y)
  for (let i = 0; i < uniq.length - 1; i++) {
    if (offset >= uniq[i] && offset < uniq[i + 1]) {
      return ident.slice(uniq[i], uniq[i + 1]).replace(/_/g, '').toLowerCase()
    }
  }
  return ident.toLowerCase()
}

/** True when the match at [start,end) sits in a LANGUAGE identifier, not a domain one. */
function isNonDomainIdentifier(text, start, end) {
  let a = start
  while (a > 0 && isIdentChar(text[a - 1])) a--
  const ident = surroundingIdentifier(text, start, end)
  if (NON_DOMAIN_IDENTIFIERS.has(ident.toLowerCase())) return true
  return NON_DOMAIN_IDENTIFIERS.has(segmentContaining(ident, start - a))
}

const isAlnum = ch =>
  ch !== undefined && (isLetter(ch) || (ch >= '0' && ch <= '9'))

/** WS-C — the acronym tier's own scan (see ACRONYM_NOUNS for the boundary rationale). */
export function matchAcronyms(text, onHit) {
  ACRONYM_RE.lastIndex = 0
  let m
  while ((m = ACRONYM_RE.exec(text)) !== null) {
    const start = m.index
    const end = start + m[0].length
    const prev = start > 0 ? text[start - 1] : undefined
    const next = end < text.length ? text[end] : undefined
    // WS-R8 — `DE-INV-<n>` is the compute/accounts epic's DEPLOYMENT-invariant label
    // family (`DE-INV-1` desktop/single-box parity, `DE-INV-10` metering-compiles-out-of-
    // desktop, `DE-INV-7` per-class node pools, `DE-INV-13` native-GCS), NOT the `DE`
    // domain acronym (differential expression). Every metering/deployment invariant is
    // tagged `DE-INV-N`, so it RECURS by construction; excluding it by CONTEXT (rather than
    // baselining each line) keeps the whole family clean now and in future. The shape is
    // exact — `DE` immediately followed by `-INV` — so a genuine `(comparison,gene) DE
    // table` / `DE/obs page` reference is untouched.
    const isDeployInvariantLabel = m[0] === 'DE' && text.slice(end, end + 4) === '-INV'
    if (!isAlnum(prev) && !isAlnum(next) && !isDeployInvariantLabel) onHit(start, m[0])
    ACRONYM_RE.lastIndex = end
  }
}

export function matchNouns(text, onHit, lang, fileHasCfgFeatureAttr = false) {
  NOUN_RE.lastIndex = 0
  let m
  while ((m = NOUN_RE.exec(text)) !== null) {
    const start = m.index
    const end = start + m[0].length
    const prev = start > 0 ? text[start - 1] : undefined
    const next = end < text.length ? text[end] : undefined
    // WS-R3 §3 — a DIGIT-initial token (`10x`) gets a stricter LEFT boundary. The
    // letter+camel rule accepts any non-LETTER neighbour, so `110x` would match
    // `10x`; requiring a non-ALPHANUMERIC neighbour is the same rule the acronym
    // tier already uses, and it costs nothing (`strip_10x_suffix`, `(10x`, ` 10x`
    // all still match).
    const digitInitial = m[0][0] >= '0' && m[0][0] <= '9'
    const leftOk = digitInitial
      ? !isAlnum(prev)
      : !isLetter(prev) || (!isUpper(prev) && isUpper(m[0][0]))
    const rightOk = !isLower(next)
    if (leftOk && rightOk) {
      if (
        !isNonDomainIdentifier(text, start, end) &&
        !(lang === 'rust' && isRustMacroFragment(text, start)) &&
        !(/^features?$/i.test(m[0]) &&
          isCargoFeatureSense(text, start, end, lang, fileHasCfgFeatureAttr)) &&
        // WS-R9 — `stripe-samples` is Stripe's OSS example-server repo, cited in the
        // billing client/handlers/webhook "Patterns" prose — a REPO NAME, not the
        // genomic single-cell `samples`. Exclude PLURAL `samples` ONLY when it is the
        // tail of a hyphenated identifier (`<alnum>-samples`, e.g. `stripe-samples`); a
        // bare genomic `samples` (space/paren/quote before it) is NOT hyphen-tailed and
        // STILL fires. Kept to the PLURAL: the genomic corpus uses SINGULAR hyphenated
        // forms (`per-sample`, cross-`sample`), which must stay caught, and the Stripe
        // repo is `stripe-samples` (plural).
        !(m[0].toLowerCase() === 'samples' && prev === '-' && isAlnum(text[start - 2]))
      ) {
        onHit(start, m[0])
      }
      NOUN_RE.lastIndex = end
    } else {
      NOUN_RE.lastIndex = start + 1
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  WS-R7 — the SECOND AXIS: a shipped package's OWN ids (PACKAGE VOCABULARY)
// ════════════════════════════════════════════════════════════════════════════
//
// Everything above this point polices ONE axis: the single-cell LATTICE — datatype ids,
// their titles, and the domain NOUNS the data model is built out of. That axis has been
// widened five times and is now derived from the manifests. It is still only one axis.
//
// THE MISS THAT MOTIVATED THIS. `mcp/view_spec_actions.rs` carried
//
//     const RETIRED_BY_VIEW_REWRITE: &[&str] = &["qc.compute::qc.setModality"];
//
// — a shipped processor's view id and action id, hardcoded in the app BACKEND — and this
// guard said nothing, across every one of those five rounds. Nor did it object to
// `namespacing_is_idempotent` exercising a package-AGNOSTIC helper against `qc.compute` /
// `qc.addHb`. Both were found by a human READING the file. A guard that a human
// out-reads on its own stated subject ("the app must carry ZERO of it") is not a guard;
// it is a guard-shaped object with one blind side.
//
// The invariant is UNCHANGED — the app carries none of what belongs to the packages. What
// changes is that "what belongs to the packages" now includes the things a package NAMES,
// not only the types it CONTRIBUTES. Lowercase `qc` is invisible to every tier above:
// it is not a datatype id, `QC` is matched case-SENSITIVELY (deliberately — see
// ACRONYM_NOUNS), and no noun covers it.
//
// ── DERIVED FROM THE TREE, never hand-listed ────────────────────────────────
//
// Same rule, same reason, as WS-R5 G2 did for the lattice: a hardcoded list of package
// names goes stale the moment someone adds a package, and then reports CLEAN. That
// failure is silent, and this repo has paid for the silent-guard failure mode twice
// already (the activity rail's 20 non-converging audit rounds; the `gate-ui` port guard).
// So the ids are read from `packages/*/manifest.yaml` (package id, `contributes.
// analyses[].id`, `contributes.converters[].id`) and `packages/*/ui/*.yaml` (the view
// `id`, and every `actions[].id`). A package added tomorrow is policed on arrival with no
// edit here, and `packageVocabularyViolations` turns a collapsed parse into a hard failure
// instead of a short list that quietly forbids less.
//
// The `actions:` SLICE matters for the same reason the `datatypes:` slice did upstairs:
// `widgets:` also carries `- id:` at the same depth, and sweeping widget ids in would put
// `runBtn` / `noInputAlert` — view-internal names nobody can address — into a vocabulary
// meant for addressable capability ids.

/** Directories under `packages/` that are not packages. */
const NON_PACKAGE_DIRS = new Set(['_lib', '_helpers', '__pycache__'])

/**
 * Every id a shipped processor package NAMES: the package itself, its analyses, its
 * converters, its views, its actions, and each action's NAMESPACED `<view>::<action>`
 * form (the exact spelling the miss above was written in).
 *
 * A deliberately minimal indentation-exact slice reader, for the same stated reason
 * `contributedDatatypes` is one: this file has no dependencies by design, and a gate that
 * a transitive dep bump can break is a worse gate.
 *
 * @param {string} dir the processors directory
 * @returns {{pkg:string,id:string,source:'package'|'analysis'|'converter'|'view'|'action'|'namespaced'}[]}
 */
export function contributedPackageIds(dir = PROCESSORS_DIR) {
  const out = []
  if (!existsSync(dir)) return out
  const push = (pkg, id, source) => {
    const clean = String(id).trim().replace(/^["']|["']$/g, '')
    if (clean !== '') out.push({ pkg, id: clean, source })
  }
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!e.isDirectory() || NON_PACKAGE_DIRS.has(e.name)) continue
    const manifest = path.join(dir, e.name, 'manifest.yaml')
    if (!existsSync(manifest)) continue
    // The DIRECTORY name is an id in its own right: it is what `include_dir!` bakes and
    // what every `packages/<name>/…` path in the app would spell.
    push(e.name, e.name, 'package')
    // ── manifest: top-level `id:`, plus the `analyses:` / `converters:` slices ──
    let slice = null
    for (const raw of readFileSync(manifest, 'utf8').split('\n')) {
      if (/^\s*(#|$)/.test(raw)) continue
      const indent = raw.length - raw.trimStart().length
      if (indent === 0) {
        slice = null
        const m = raw.match(/^id:\s*(.+?)\s*$/)
        if (m) push(e.name, m[1], 'package')
        continue
      }
      if (indent === 2) {
        const m = raw.match(/^\s*(analyses|converters):\s*$/)
        slice = m ? m[1] : null
        continue
      }
      if (slice === null) continue
      const m = raw.match(/^ {4}- id:\s*(.+?)\s*$/)
      if (m) push(e.name, m[1], slice === 'analyses' ? 'analysis' : 'converter')
    }
    // ── ui/*.yaml: the view `id:` and the `actions:` slice ─────────────────────
    const uiDir = path.join(dir, e.name, 'ui')
    if (!existsSync(uiDir) || !statSync(uiDir).isDirectory()) continue
    for (const f of readdirSync(uiDir).sort()) {
      if (!f.endsWith('.yaml') && !f.endsWith('.yml')) continue
      let viewId = null
      let inActions = false
      const actions = []
      for (const raw of readFileSync(path.join(uiDir, f), 'utf8').split('\n')) {
        if (/^\s*(#|$)/.test(raw)) continue
        const indent = raw.length - raw.trimStart().length
        if (indent === 0) {
          inActions = /^actions:\s*$/.test(raw)
          const m = raw.match(/^id:\s*(.+?)\s*$/)
          if (m && viewId === null) viewId = m[1].trim().replace(/^["']|["']$/g, '')
          continue
        }
        if (!inActions) continue
        const m = raw.match(/^ {2}- id:\s*(.+?)\s*$/)
        if (m) actions.push(m[1].trim().replace(/^["']|["']$/g, ''))
      }
      if (viewId) push(e.name, viewId, 'view')
      for (const a of actions) {
        push(e.name, a, 'action')
        // The namespaced form is what the backend's frontend-action catalog uses, and it
        // is the exact spelling of the const this tier exists to have caught.
        if (viewId) push(e.name, `${viewId}::${a}`, 'namespaced')
      }
    }
  }
  return out
}

/**
 * PRECISION over reach — a token qualifies only if it is UNAMBIGUOUS.
 *
 * Two filters, and both cost real coverage that is stated rather than hidden:
 *
 *  1. **SEPARATOR + LENGTH.** An id must contain `.`, `-` or `/` and be ≥ 5 chars. This
 *     drops the bare package ids `qc` and `cellranger`. `qc` as a bare word is ordinary
 *     English-adjacent noise, and the `DE`/`QC`/`BAM` measurement upstairs (case-
 *     insensitive `DE` = 1575 hits, all junk) is the standing evidence for what a noisy
 *     token does: it gets baselined into silence, which is strictly worse than a narrower
 *     token that is believed. THE COST: a future package whose id carries no separator
 *     (`spatial`, `velocity`) is invisible to this tier until it names an analysis, a view
 *     or an action — which every real package does, because those ids are how the
 *     workbench addresses it.
 *  2. **NOT ALREADY CAUGHT.** A token is dropped if scanning the token STRING ITSELF with
 *     the LATTICE matchers already yields a hit. `cell.filter` fires `cell`,
 *     `anndata.import` fires `anndata`, `qc.setGeneNames` fires `gene` — recording them
 *     here too would double-count every site, which is the measured failure
 *     (60+ duplicates) that the SUBSTRING_PREFIXES subsumption filter exists to prevent.
 *     This is computed, not curated, so it stays correct as the lattice vocabulary moves.
 *
 * What survives is exactly the coverage that is NEW: `qc.compute`, `qc.run`, `qc.addHb`,
 * `cf.addCriterion`, `cr.run`, `annotation-integrate`, … — package vocabulary no tier
 * above could see.
 */
const PACKAGE_IDS_ALL = contributedPackageIds()

/** True when the LATTICE tiers already match somewhere inside `tok`. */
function latticeAlreadyMatches(tok) {
  if (SUBSTRING_TOKENS.some(s => tok.includes(s))) return true
  let hit = false
  matchNouns(tok, () => void (hit = true), 'ts')
  if (hit) return true
  matchAcronyms(tok, () => void (hit = true))
  return hit
}

export const PACKAGE_ID_TOKENS = [
  ...new Set(
    PACKAGE_IDS_ALL.map(e => e.id)
      .filter(id => id.length >= 5 && /[.\-/]/.test(id))
      // A contributed DATATYPE id belongs to the lattice tier, which already owns it.
      .filter(id => !DATATYPE_IDS.includes(id))
      .filter(id => !latticeAlreadyMatches(id)),
  ),
  // Longest-first so `<view>::<action>` wins over its own two halves and each site is
  // counted ONCE — the same arbitration the noun alternation uses.
].sort((a, b) => b.length - a.length)

/**
 * Fail CLOSED on the DERIVATION, exactly as `contributedVocabularyViolations` does for the
 * lattice. If the manifests move or their shape changes, the parse yields a SHORT list and
 * the guard forbids LESS while still printing ✓ — the same "scoped just narrowly enough"
 * failure one level up.
 * @returns {string[]}
 */
export function packageVocabularyViolations(
  entries = PACKAGE_IDS_ALL,
  tokens = PACKAGE_ID_TOKENS,
) {
  const out = []
  const pkgs = new Set(entries.map(e => e.pkg))
  if (pkgs.size < PACKAGE_FLOOR) {
    out.push(
      `only ${pkgs.size} processor package(s) were parsed for their OWN ids ` +
        `(${[...pkgs].join(', ') || 'none'}), below the committed floor of ${PACKAGE_FLOOR}. ` +
        `The package vocabulary is DERIVED from ${path.relative(SRC_APP, PROCESSORS_DIR)}/*/` +
        `manifest.yaml + ui/*.yaml; a short walk means the tree moved and this tier is now ` +
        `forbidding less than the packages name.`,
    )
  }
  for (const src of ['analysis', 'view', 'action']) {
    if (!entries.some(e => e.source === src)) {
      out.push(
        `the package walk found ZERO \`${src}\` ids. Every shipped package declares at ` +
          `least one, so an empty class means the slice reader stopped matching that block's ` +
          `shape — the SILENT half of a stale derivation.`,
      )
    }
  }
  if (tokens.length < PACKAGE_TOKEN_FLOOR) {
    out.push(
      `the package vocabulary reduced to ${tokens.length} usable token(s), below the ` +
        `committed floor of ${PACKAGE_TOKEN_FLOOR}. Either the walk collapsed or the ` +
        `precision filters (separator+length, not-already-caught) grew teeth they should ` +
        `not have. Lower the floor deliberately if a package genuinely went away.`,
    )
  }
  return out
}

/** Measured 2026-08-03: 8 package dirs, 82 declared ids, **34** usable tokens after the
 *  two precision filters. Floors at ≈⅔, the collapse-detector margin every other floor in
 *  this file uses — NOT a tripwire sitting on its own measurement (see the WS-R3 §4 note
 *  on SCAN_FLOORS for why that distinction is load-bearing: a floor set one below its
 *  measurement trains everyone to treat a red floor as paperwork).
 *
 *  The 82 → 34 reduction is almost entirely filter 2 (`latticeAlreadyMatches`), and it is
 *  the filter working: `cell.filter::cf.run` is dropped because `cell` already fires
 *  there, `qc.compute::qc.setGeneNames` because `gene` does. What survives is the set
 *  NOTHING upstairs could see — the `qc.*` / `cf.*` / `cr.*` action ids, the `qc.compute`
 *  view id, `annotation-integrate`, `open-kinds`. */
const PACKAGE_FLOOR = 5
const PACKAGE_TOKEN_FLOOR = 22

/**
 * Scan `text` for package ids. Raw substrings with a NON-IDENTIFIER boundary on both
 * sides: every surviving token carries a `.`/`-`/`/`, so it cannot occur as an accident of
 * ordinary code — the same argument SUBSTRING_TOKENS makes. Longest-first with an
 * occupied-range map, so `qc.compute::qc.run` counts once, not three times.
 */
/**
 * Which BASELINE SECTION each package kind ratchets against. The package tier shares the
 * noun tiers' sections (identical disposition vocabulary, identical ratchet) but keeps its
 * own KIND so the lattice-measured observation floors stay lattice-measured.
 */
const PACKAGE_KIND_BUCKET = { 'package-id': 'domain-noun', 'package-prose': 'domain-prose' }

export function matchPackageIds(text, onHit, tokens = PACKAGE_ID_TOKENS) {
  const taken = new Uint8Array(text.length)
  for (const tok of tokens) {
    let from = 0
    let idx
    while ((idx = text.indexOf(tok, from)) !== -1) {
      const end = idx + tok.length
      const prev = idx > 0 ? text[idx - 1] : undefined
      const next = end < text.length ? text[end] : undefined
      let free = true
      for (let i = idx; i < end; i++) if (taken[i]) { free = false; break }
      if (free && !isIdentChar(prev) && !isIdentChar(next)) {
        for (let i = idx; i < end; i++) taken[i] = 1
        onHit(idx, tok)
      }
      from = idx + 1
    }
  }
}

// ── ITEM-37 + WS-B: fail CLOSED on a collapsed scan set ─────────────────────
//
// Every path in `defaultScanSet()` is hard-coded. A rename moves the subject out
// from under the guard, which then reports PASS having scanned (almost) nothing.
// This round produced FOUR such live incidents in the very commits that moved the
// subject. A committed FLOOR per root turns that silent pass into a hard failure:
// shrinking coverage now requires an explicit, reviewable edit to these constants.
//
// WS-C adds FIVE new roots, each with its own floor, for the same reason: the
// widening is worth nothing if a rename can quietly take a root back out.
//
// ── WS-R3 §4: the floors are COLLAPSE DETECTORS, restored to a ~⅔ margin ─────
//
// SEVEN of the eight floors were sitting AT or ONE BELOW their own measurement
// (`rust` 161/160, `rustRoot` 5/5, `buildHelper` 3/3, `desktop` 6/6, `workbenchFe`
// 190/189, `packagesFe` 8/8, `extraFe` 2/2). That is a TRIPWIRE, not a collapse
// detector: deleting one legitimate file turns the gate red, and the only available
// response is to edit the constant down by one — which trains everyone to treat a
// red floor as paperwork. It is also, verbatim, the antipattern this file's own twin
// warns about (`domain_surface/mod.rs:255-262`, "a floor set just under the
// measurement is a floor that a normal, correct fix breaks"), and it is HOW THE TWIN
// WENT RED UNNOTICED in round 1 and stayed red across a merge.
//
// Every floor below is now ≈⅔ of its 2026-07-28 measurement, with the measurement
// recorded next to it. A drop past ⅔ is not a refactor; a drop of one file is.
// `extraFe` is GONE — it was a presence assertion wearing a floor's clothes, and it
// is replaced by `MUST_SCAN_KEYS`, which names the file that went missing.
const SCAN_FLOORS = {
  /** `server/src/modules/**.rs` minus `#[cfg(test)] mod` declarations. Measured 161. */
  rust: 107,
  /** WS-C: `server/src/*.rs` OUTSIDE `modules/` (lib/main/openapi/config/database). Measured 5. */
  rustRoot: 3,
  /** WS-C: `server/build_helper/**.rs` (mod / processor_manifest / sandbox_rootfs). Measured 3. */
  buildHelper: 2,
  /** WS-C: `desktop/**` `.rs`/`.ts`/`.tsx` (the Tauri harness). Measured 6. */
  desktop: 4,
  /** `ui/src/modules/workbench/**.{ts,tsx}` minus the DEC-9 exemptions. Measured 191. */
  workbenchFe: 127,
  /** WS-C: ALL the rest of `ui/src/**.{ts,tsx}` minus the DEC-9 exemptions. Measured 269. */
  uiFe: 179,
  /** WS-C: the scanned `packages/*` (see SCANNED_PACKAGES) minus exemptions. Measured 8. */
  packagesFe: 5,
  /**
   * WS-R3: `server/src/**` + `build_helper/**` `.sql`/`.py`/`.json`/`.yaml`.
   *
   * ROUND-4 RECONCILIATION RE-MEASURED **12** (was 53); floor LOWERED 35 -> 8 (⅔).
   * Fully accounted for by ONE workstream: r4squash collapsed the 49 module-local
   * migrations into 8 per-module baselines, so the root is now 8 `.sql` + 2
   * `include_str!`-ed `.py` seed drivers + 2 `.json` manifests. This is the ONLY
   * floor in this file that a merge drove BELOW itself, and it is exactly what a
   * collapse detector is supposed to do — it fired, named the root, and the drop
   * turned out to be accounted rather than a collapsed walk. (`datatype/tests/
   * lattice_golden.json` is on disk but NOT in the count: its directory is declared
   * `#[cfg(test)] mod tests;`, so the test-only-BY-DECLARATION exclusion covers it.)
   */
  serverData: 8,
  /**
   * WS-R3: `ui/src/**` + `desktop/**` + scanned `packages/*` data files. Measured 5.
   *
   * ROUND-3 RECONCILIATION — this root is the one whose measurement is NOT a property
   * of the commit. A worktree that has run a `cargo build` also carries four UNTRACKED,
   * tauri-CODEGEN'd files (`desktop/tauri/gen/schemas/{acl-manifests,capabilities,
   * desktop-schema,linux-schema}.json`), so the walk reports 9 there and 5 in a clean
   * checkout. Verified by moving `gen/schemas` aside: the count drops 9 → 5 and the guard
   * stays green (those four carry ZERO domain hits, so neither hit-count floor moves).
   * The floor therefore stays anchored to the COMMITTED measurement of 5 — raising it to
   * ⅔ of 9 would make a clean CI checkout fail a floor it cannot satisfy.
   */
  feData: 3,
  /** WS-R3: `ui/openapi/**.json` — the shipped contract. Measured 1; a 1-file root. */
  uiOpenapi: 1,
  // ── WS-R4: the TEST roots. Same ≈⅔ collapse-detector basis as every floor
  // above — these are the roots MOST likely to be silently dropped, because a
  // "why is the linter reading my tests" impulse is a one-line edit away.
  /** `server/tests/**.rs` — the backend integration suite. ROUND-4 RE-MEASURED **119**
   *  (118 + r4dataapi's new `workstore/seed_debug_test.rs`); floor 78 -> 79 (⅔).
   *  ROUND-5 RE-MEASURED **120** (+1: r5card's `datatype/cross_side_test.rs`, the
   *  cross-side agreement test whose absence let two enforcers of one behaviour assert
   *  opposite things); floor 79 -> 80 (⅔). The new file contributes ZERO hits in either
   *  tier — it states the contract as a DERIVED property rather than spelling it — so
   *  this is the one root whose file count moved without moving any observation. */
  serverTests: 80,
  /** `server/tests/**` `.py`/`.yaml`/`.json`/`.sql` fixtures. Measured 14. */
  serverTestsData: 9,
  /** `ui/tests/**` `.ts`/`.tsx` (+ data exts, none today). ROUND-4 RE-MEASURED **185**
   *  (184 + r4dataapi's new `14-declarative-qc/_fixtures.ts`); floor 122 -> 123 (⅔). */
  uiTests: 123,
  /** The ex-BASENAME-exemption root: `*.{test,spec}.*` + `__fixtures__`/`__testutil__`
   *  under `ui/src` / `desktop` / the scanned packages. Measured 132. */
  uiSpecs: 88,
}

/** Bare-word ids — matched ONLY when quote-delimited (see header). */
const QUOTED_ID_TOKENS = DATATYPE_IDS.filter(
  id => !id.includes('/') && !SUBSTRING_TOKENS.includes(id),
) // → ['embedding','clustering','metadata-column','de']

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ════════════════════════════════════════════════════════════════════════════
//  WS-R8 — the ID-STEM tier: a lattice id used as a SEGMENT, not as a literal
// ════════════════════════════════════════════════════════════════════════════
//
// THE MISS. `QUOTED_ID_RE` requires the WHOLE quoted literal to BE the id, and that
// anchor is deliberate — it is what keeps the guard false-positive-free (the header's
// own examples: the channel key `clustering:`, the ref prefix `'clustering:'`). The cost
// nobody had measured is that an id used as a STEM is invisible. Verbatim, from the
// provenance action registry before this round:
//
//     let cref = req_str(recipe, "clustering_ref", action_type)?;
//     dispatch("selection.clustering", D::LabelSet),
//     pub enum SelectionRecipe { Clustering { clustering_ref: String, .. }, .. }
//
// Three app-tier commitments naming a CONTRIBUTED datatype id, in the one place the app
// declares its own wire vocabulary — and the guard was green. `embedding_hash`, the
// sibling in the same file, WAS caught, but only by accident: `embedding` is separately
// a DOMAIN NOUN. `clustering` is not, so nothing saw it.
//
// WHY THE HYPOTHESIS "a fourth axis over declared FIELD/COLUMN names" would not have
// helped: `clustering_ref` and `embedding_hash` are declared as a field or column name
// NOWHERE in `packages/` — they are app-invented. The gap is the ANCHOR, not the
// vocabulary source. So this tier reuses the SAME derived lattice ids and only changes
// what may stand next to them.
//
// SCOPE: the `scan` projection ONLY — executable code and string literals, production
// tier. Deliberately NOT comments and NOT the test tier: a comment that says "the demo
// `clustering` view" and a fixture that seeds a demo datatype id are not commitments,
// and measured, they are the ENTIRE current yield (7 prose hits, 29 test hits, 0
// production-code hits). Including them would mean ~17 new ledger entries and four
// ceiling raises to fund findings that are all dispositions, which is the "baselined
// into silence" outcome this repo has paid for. Narrow and believed beats wide and muted.
//
// PRECISION FILTERS, each with its measured reason:
//   1. length >= 5      — drops `de`, whose segment form is 80 raw hits of noise
//                         (`de_page`, `mode.de`, …) for one 2-character id.
//   2. separator-free   — drops `metadata-column`. Measured, ALL 7 of its production
//                         hits are the CAPABILITY name `metadata-column-family`, which
//                         is the app's own registry-derived vocabulary and the correct
//                         domain-free pattern. An id that is ITSELF a multi-word phrase
//                         is where the compound-English false positives live.
//   3. not already      — drops `embedding` (a DOMAIN NOUN, already matched inside
//      matched            `embedding_hash`). Without this the tier double-counts, the
//                         same `latticeAlreadyMatches` filter WS-R7 applies.
// Measured 2026-08-05: 4 quoted-id tokens -> 1 stem token (`clustering`).

/**
 * A lattice id may stand as a SEGMENT next to one of these, on either side.
 *
 * `:` and `/` are DELIBERATELY ABSENT, and that is not a taste call — the first draft
 * included them and the guard's own pre-existing false-positive-free acceptance
 * (`[acceptance][INV-2] PASSES: declarative-engine example strings + host keys`) went
 * RED on `k.startsWith('clustering:')`. That is verbatim one of the three shapes this
 * file's header already names as the reason the quoted anchor exists ("the ref prefix
 * `'clustering:'`"), so a stem tier that convicts it would be re-opening a hole the
 * anchor was chosen to close. `/` goes with it: a compound id is already a
 * SUBSTRING_TOKEN, so the only `/`-adjacent hits left are filesystem paths.
 *
 * What remains — `_`, `.`, `-` — is exactly the identifier/wire-key joining set, which
 * is where the motivating leaks lived (`clustering_ref`, `selection.clustering`).
 */
const ID_STEM_SEPARATORS = '[_.-]'

/** Bare-word lattice ids that may be matched as a SEGMENT of a longer identifier or
 *  literal. See the block above for each filter's measured cost. */
const ID_STEM_TOKENS = QUOTED_ID_TOKENS.filter(
  id => id.length >= 5 && !/[.\-/_]/.test(id) && !latticeAlreadyMatches(id),
)

/** The floor is a COLLAPSE detector, not a target. It is 1 because the filtered set is
 *  1 today and saying so is the honest form; the tier's value is prospective — every
 *  future single-word contributed id (`spatial`, `velocity`, `pathway`) joins it with no
 *  edit here. A 0-token tier would print ✓ having matched nothing, which is the failure
 *  every other floor in this file exists to stop. */
export const ID_STEM_TOKEN_FLOOR = 1

/** Fail CLOSED on the derivation, exactly as the lattice and package tiers do. */
export function idStemVocabularyViolations(tokens = ID_STEM_TOKENS) {
  const out = []
  if (tokens.length < ID_STEM_TOKEN_FLOOR) {
    out.push(
      `the ID-STEM vocabulary COLLAPSED: ${tokens.length} token(s) < ID_STEM_TOKEN_FLOOR ` +
        `(${ID_STEM_TOKEN_FLOOR}). Derived from QUOTED_ID_TOKENS; a guard that forbids ` +
        `nothing still prints ✓.`,
    )
  }
  return out
}

/** Which baseline SECTION the stem kind ratchets against — the code section, like the
 *  package tier, while keeping its OWN kind so the lattice-measured observation floors
 *  stay lattice-measured. */
const ID_STEM_KIND_BUCKET = { 'id-stem': 'domain-noun' }

/**
 * Match each stem token where it sits as a SEGMENT: a separator on one side and a
 * non-identifier character (or the string edge) on the other. A BARE occurrence — the
 * id standing alone, quoted — is left to `QUOTED_ID_RE`, so the two tiers never
 * double-report the same byte.
 */
export function matchIdStems(text, onHit, tokens = ID_STEM_TOKENS) {
  for (const tok of tokens) {
    const t = escapeRe(tok)
    const re = new RegExp(
      `(?<=${ID_STEM_SEPARATORS})${t}(?![A-Za-z0-9])|(?<![A-Za-z0-9])${t}(?=${ID_STEM_SEPARATORS})`,
      'g',
    )
    let m
    while ((m = re.exec(text)) !== null) onHit(m.index, tok)
  }
}

const QUOTE = "['\"`]"
const QUOTED_ID_RE = new RegExp(`${QUOTE}(${QUOTED_ID_TOKENS.map(escapeRe).join('|')})${QUOTE}`, 'g')
const QUOTED_TITLE_RE = new RegExp(
  `${QUOTE}(${DATATYPE_TITLES.map(escapeRe).join('|')})${QUOTE}`,
  'g',
)

// ── Tokenizer: classify every char as code | comment | string ───────────────
// Produces two derived texts (both newline-preserving so line numbers survive):
//   scanText  — comments blanked (string + code kept — that's where ids live)
//   skeleton  — comments AND string CONTENTS blanked (only `code` kept), used
//               to locate `#[cfg(...)]` attrs + brace-match without miscounting
//               braces/attrs that sit inside string literals.

const CODE = 0
const COMMENT = 1
const STRING = 2

/** @returns {Uint8Array} per-char class for `src` in `lang` ('rust'|'ts'). */
function classify(src, lang) {
  const n = src.length
  const mask = new Uint8Array(n) // default CODE (0)
  let i = 0
  const isRust = lang === 'rust'

  const looksLikeCharLiteral = () => {
    // Rust: distinguish a char literal `'x'` / `'\n'` from a lifetime `'a`.
    if (src[i + 1] === '\\') return true // '\n', '\'' → char literal
    // single char then closing quote: 'x'
    return src[i + 2] === "'"
  }

  while (i < n) {
    const c = src[i]
    const c2 = src[i + 1]

    // line comment
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') {
        mask[i] = COMMENT
        i++
      }
      continue
    }
    // block comment (Rust block comments nest; TS do not)
    if (c === '/' && c2 === '*') {
      let depth = 1
      mask[i] = COMMENT
      mask[i + 1] = COMMENT
      i += 2
      while (i < n && depth > 0) {
        if (isRust && src[i] === '/' && src[i + 1] === '*') {
          mask[i] = COMMENT
          mask[i + 1] = COMMENT
          depth++
          i += 2
          continue
        }
        if (src[i] === '*' && src[i + 1] === '/') {
          mask[i] = COMMENT
          mask[i + 1] = COMMENT
          depth--
          i += 2
          continue
        }
        mask[i] = COMMENT
        i++
      }
      continue
    }
    // Rust raw string: r"...", r#"..."#, br#"..."#
    if (isRust && (c === 'r' || (c === 'b' && c2 === 'r'))) {
      let j = c === 'r' ? i + 1 : i + 2
      if (src[j] === '#' || src[j] === '"') {
        let hashes = 0
        while (src[j] === '#') {
          hashes++
          j++
        }
        if (src[j] === '"') {
          // consume raw string until closing "###...
          const closing = '"' + '#'.repeat(hashes)
          for (let k = i; k < j + 1; k++) mask[k] = STRING
          let p = j + 1
          while (p < n) {
            if (src.startsWith(closing, p)) {
              for (let k = p; k < p + closing.length; k++) mask[k] = STRING
              p += closing.length
              break
            }
            mask[p] = STRING
            p++
          }
          i = p
          continue
        }
      }
    }
    // string / template literal
    if (c === '"' || c === '`' || (c === "'" && (!isRust || looksLikeCharLiteral()))) {
      const quote = c
      mask[i] = STRING
      i++
      while (i < n) {
        if (src[i] === '\\') {
          mask[i] = STRING
          mask[i + 1] = STRING
          i += 2
          continue
        }
        mask[i] = STRING
        if (src[i] === quote) {
          i++
          break
        }
        i++
      }
      continue
    }
    // ordinary code char (incl. a Rust lifetime `'`)
    i++
  }
  return mask
}

// ── WS-R3 §2: the DATA dialects (`.sql` / `.py` / `.json` / `.yaml`) ────────
//
// Both guards read only `.rs` / `.ts` / `.tsx`, i.e. 633 of the 1108 app+test code
// files in the tree (57%). Everything the app EMBEDS or SHIPS in another format was
// structurally invisible. `classifyData` is the string-aware tokenizer for those
// four formats; it produces the same COMMENT / STRING / CODE mask `classify` does,
// so every downstream tier (scan / prose / literals) works unchanged.
//
// Per-format comment + string rules:
//   sql  — `--` to EOL, `/* … */`; strings `'…'`, quoted identifiers `"…"`.
//   py   — `#` to EOL; strings `'…'` / `"…"`; and TRIPLE-quoted blocks are classed
//          as COMMENT (prose tier), because a Python docstring IS that language's
//          documentation convention — `seed_multimodal.py`'s module docstring is
//          three paragraphs of domain intent, which belongs in the prose tier next
//          to a Rust `//!` header, not in the executable tier.
//   yaml — `#` to EOL (only when it opens a token — `a#b` is not a comment);
//          strings `'…'` / `"…"`.
//   json — no comments at all; strings `"…"` only (a bare `'` is an apostrophe).
// There is no `#[cfg(…)]` concept in any of them, so `skeleton` is only used for
// the (unused) brace-matching and is produced for shape-compatibility.
const DATA_DIALECTS = new Set(['sql', 'py', 'yaml', 'json'])

/** @returns {Uint8Array} per-char class for `src` in a DATA dialect. */
function classifyData(src, lang) {
  const n = src.length
  const mask = new Uint8Array(n)
  const hashComment = lang === 'py' || lang === 'yaml'
  const dashComment = lang === 'sql'
  const blockComment = lang === 'sql'
  const singleQuote = lang !== 'json'
  const triple = lang === 'py'
  let i = 0
  while (i < n) {
    const c = src[i]
    const c2 = src[i + 1]
    if (hashComment && c === '#') {
      // YAML: `#` only opens a comment at start-of-token (start, or after space).
      const prev = i > 0 ? src[i - 1] : undefined
      if (lang === 'yaml' && prev !== undefined && prev !== ' ' && prev !== '\t' && prev !== '\n') {
        i++
        continue
      }
      while (i < n && src[i] !== '\n') mask[i++] = COMMENT
      continue
    }
    if (dashComment && c === '-' && c2 === '-') {
      while (i < n && src[i] !== '\n') mask[i++] = COMMENT
      continue
    }
    if (blockComment && c === '/' && c2 === '*') {
      mask[i] = COMMENT
      mask[i + 1] = COMMENT
      i += 2
      while (i < n) {
        if (src[i] === '*' && src[i + 1] === '/') {
          mask[i] = COMMENT
          mask[i + 1] = COMMENT
          i += 2
          break
        }
        mask[i++] = COMMENT
      }
      continue
    }
    if (triple && (src.startsWith('"""', i) || src.startsWith("'''", i))) {
      const closing = src.slice(i, i + 3)
      for (let k = i; k < i + 3; k++) mask[k] = COMMENT
      let p = i + 3
      while (p < n && !src.startsWith(closing, p)) mask[p++] = COMMENT
      for (let k = p; k < Math.min(p + 3, n); k++) mask[k] = COMMENT
      i = Math.min(p + 3, n)
      continue
    }
    if (c === '"' || (singleQuote && c === "'")) {
      const quote = c
      mask[i] = STRING
      i++
      while (i < n) {
        if (src[i] === '\\' && lang !== 'sql') {
          mask[i] = STRING
          if (i + 1 < n) mask[i + 1] = STRING
          i += 2
          continue
        }
        mask[i] = STRING
        if (src[i] === quote) {
          i++
          break
        }
        // an unterminated quote must not swallow the rest of the file
        if (src[i] === '\n' && !triple) {
          i++
          break
        }
        i++
      }
      continue
    }
    i++
  }
  return mask
}

/**
 * Three newline-preserving projections of `src` (line numbers survive in all of
 * them):
 *   scan     — comments blanked, code + string literals kept. The EXECUTABLE
 *              surface; a domain literal here is a real dispatch.
 *   skeleton — comments AND string CONTENTS blanked. Used to locate
 *              `#[cfg(...)]` attrs + brace-match without miscounting braces that
 *              sit inside string literals.
 *   prose    — the INVERSE of `scan`: only comments kept. WS-B blind spot #1 —
 *              the guard used to blank comments and throw them away, so domain
 *              INTENT stated in a doc header ("this is the single-cell QC table")
 *              was invisible to every gate. It is now scanned as its own lower
 *              severity (`domain-prose`) with its own baseline.
 */
function deriveTexts(src, lang) {
  const mask = DATA_DIALECTS.has(lang) ? classifyData(src, lang) : classify(src, lang)
  const scan = new Array(src.length)
  const skel = new Array(src.length)
  const prose = new Array(src.length)
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    const nl = c === '\n'
    const blank = nl ? '\n' : ' '
    if (mask[i] === COMMENT) {
      scan[i] = blank
      skel[i] = blank
      prose[i] = c
    } else if (mask[i] === STRING) {
      scan[i] = c
      skel[i] = blank
      prose[i] = blank
    } else {
      scan[i] = c
      skel[i] = c
      prose[i] = blank
    }
  }
  return { scan: scan.join(''), skeleton: skel.join(''), prose: prose.join('') }
}

/**
 * Blank every Rust `#[cfg(test)]` item block out of `scanText`, located +
 * brace-matched against `skeleton` (so braces inside strings don't miscount). A
 * non-block item (`#[cfg(test)] use …;`) is removed up to its `;`.
 *
 * ── WS-R3 §1: `#[cfg(debug_assertions)]` IS NO LONGER BLANKED ───────────────
 *
 * It used to be, "for the reason DOMAIN_AUDIT §7 gives: every fn/const/route in
 * `workstore/data_api.rs` is `#[cfg(debug_assertions)]`". That is a description of
 * the SUBJECT, not a reason to stop looking at it — and it is exactly why the
 * guard was green: `data_api.rs` is almost entirely `#[cfg(debug_assertions)]`, so
 * the baseline recorded 104 prose hits and **ZERO code hits** for a file that
 * measures ~398 raw vocabulary hits. Un-blanking surfaces, in production server
 * source, MEASURED 2026-07-28:
 *   * `data_api.rs` — 243 code-tier noun hits, 70 additional prose hits, and
 *     **23 LITERAL hits** (16 `substring` + 7 `quoted-id`) — the hardest INV-3
 *     kind, against a `LITERAL_HITS_CEILING` that was sitting at 0. Including
 *     `:551` `"matched_genes": { "pct_mito": ["MT-CO1","MT-ND1"], "pct_ribo":
 *     ["RPS12","RPL13"] }` — literal mitochondrial and ribosomal GENE SYMBOLS.
 *   * `workstore/routes.rs` — 2 code, 7 prose. It registers SIX real HTTP routes
 *     under the same attribute (`routes.rs:58,62,66,70,74,84`).
 * `#[cfg(debug_assertions)]` is not a non-shipping guarantee in the sense
 * `#[cfg(test)]` is: it compiles into every dev/debug binary and here it registers
 * live Axum routes. "Dev-only" is a deployment argument, not a structural one, and
 * this guard honours only structural exemptions. Bounded, so this is cheap: only
 * FIVE files in the tree use the attribute at all, and two of them
 * (`provenance/verify/runner.rs`, `sandbox/env_image.rs`) contribute ZERO.
 *
 * ── WS-R3 §1: `#[cfg(test)]` STAYS blanked — the decision, and its cost ──────
 *
 * DECISION: keep blanking. The exemption is COMPILER-ENFORCED, and therefore
 * un-gameable in the exact sense this guard cares about: you cannot claim it
 * without your code genuinely not being in the shipped binary. It is the same
 * argument `testOnlyRustModules` already makes at FILE granularity, applied at ITEM
 * granularity — blanking one and scanning the other would be incoherent. It also
 * keeps the guard from flagging its own twin: the in-tree grep-guards live in
 * `#[cfg(test)]` and must spell the forbidden vocabulary out in order to search
 * for it.
 *
 * THE COST, MEASURED (2026-07-28) rather than assumed — the number nobody had ever
 * written down. Scanning `#[cfg(test)]` too would surface **633 further code-tier
 * noun hits, 180 prose hits and 69 literal hits** across ~40 files, led by
 * `dataset/repository.rs` (69), `provenance/export/methods.rs` (62),
 * `provenance/criteria_script.rs` (60), `extensions/loader.rs` (44),
 * `datatype/types.rs` (40). Most of it is a generic engine being tested against a
 * concrete contributed domain, which is what a generic engine's tests SHOULD do.
 * No ceiling is put on that number on purpose: a ceiling over test code fires on
 * every legitimately-added test, and a nuisance-red gate gets narrowed — which is
 * the failure this whole round exists to stop.
 *
 * WHAT THE DECISION DOES **NOT** COVER (finding R3-F1, for a sibling round):
 * `#[cfg(test)]` blanking concerns IN-SOURCE test modules only. The test TREES
 * (`server/tests/**` ≈1258 hits, `ui/tests/**` ≈449, `ui/src/**` `*.test.ts`) are
 * in NO scan root, so nothing here reaches them — and that is where the
 * exact-cardinality certifications of the contributed domain bundle live (a test
 * asserting the catalog holds exactly N entries pins the app suite to ONE domain
 * bundle's cardinality, which is a real coupling and not an incidental example).
 * Closing it is a scan-SET expansion with its own baseline discipline.
 */
function stripCfgBlocks(scanText, skeleton) {
  const attrRe = /#\[\s*cfg\s*\(([^\]]*)\)\s*\]/g
  const scan = scanText.split('')
  let m
  while ((m = attrRe.exec(skeleton)) !== null) {
    const args = m[1]
    // WS-R5 G1 — `/\btest\b/` also matches `not(test)`, i.e. the attribute that marks
    // code compiled ONLY OUTSIDE tests: the exact opposite of the exemption's premise.
    // A `#[cfg(not(test))] mod ship { … }` was therefore blanked out of the scan, and a
    // domain literal inside it was invisible to both enforcers. Latent rather than live
    // (no cfg attribute in the tree carries `test` in any other form today) — and a
    // one-line fix in each, which is the only reason it stayed cheap.
    const isTest = /\btest\b/.test(args) && !/\bnot\s*\(\s*test\s*\)/.test(args)
    if (!isTest) continue
    const attrStart = m.index
    let p = m.index + m[0].length
    // find the first `{` or `;` after the attribute (in the skeleton)
    while (p < skeleton.length && skeleton[p] !== '{' && skeleton[p] !== ';') p++
    if (p >= skeleton.length) continue
    let end
    if (skeleton[p] === ';') {
      end = p + 1
    } else {
      // brace-match from p
      let depth = 0
      let q = p
      for (; q < skeleton.length; q++) {
        if (skeleton[q] === '{') depth++
        else if (skeleton[q] === '}') {
          depth--
          if (depth === 0) {
            q++
            break
          }
        }
      }
      end = q
    }
    for (let k = attrStart; k < end; k++) {
      if (scan[k] !== '\n') scan[k] = ' '
    }
    attrRe.lastIndex = end
  }
  return scan.join('')
}

// ── File exemptions + scan-set discovery ────────────────────────────────────

/**
 * ── WS-R4: the TEST TIER — a CLASSIFIER, not an exemption ───────────────────
 *
 * THE QUESTION this round had to answer. Round 3 kept `#[cfg(test)]` blanked
 * (compiler-enforced, therefore un-gameable) but flagged, as finding R3-F1, that the
 * `*.test.*` / `*.spec.*` BASENAME exemption has the same theoretical weakness as the
 * `gallery.tsx` basename exemption it had just removed: it is claimable by NAMING a
 * file. Adding `ui/tests/**` as a root makes that unavoidable — 169 of its 184 `.ts`
 * files are `*.spec.ts`, so declaring the directory a root while keeping the basename
 * exemption would add a root that scans 15 of its own 184 files. A root you refuse to
 * read is worse than no root: it looks like coverage in the log line.
 *
 * THE RESOLUTION, and why it is coherent with keeping `#[cfg(test)]` blanked:
 *
 *   `#[cfg(test)]` is a STRUCTURAL exemption — you cannot claim it without the
 *   compiler genuinely omitting your code from the shipped binary. Its justification
 *   is an INV-1/INV-3 argument: the app BINARY must carry no domain. That argument is
 *   sound and it is kept, unchanged, with the cost round 3 measured (633 code / 180
 *   prose / 69 literal hits) still on the record.
 *
 *   A basename has no such enforcement. vitest/playwright collect by exactly this
 *   glob, so a production file named `x.test.ts` would be RUN as a test — but the
 *   same property that makes the glob a reliable COLLECTOR makes it a reliable
 *   DODGE: any leak, anywhere, becomes invisible by renaming the file. So the
 *   basename is kept as a CLASSIFIER (it decides which TIER a finding lands in) and
 *   retired as an EXEMPTION (it no longer decides whether the file is READ).
 *
 * Net: a file that is test-shaped is SCANNED, and its residue is ratcheted in the
 * test namespace (`testCode`/`testProse`/`testLiterals`) with its own floors. A
 * `ui/src/modules/x/leak.spec.ts` can no longer hide; it just gets recorded next to
 * the other tests instead of failing the production tier.
 *
 * The `__fixtures__/` + `__testutil__/` DIRECTORY exemptions are retired on the
 * identical grounds — claimable by naming a directory — and their 3 files join the
 * same tier. Every by-name exemption in this guard is now gone; the only survivors
 * are the two NAMED workbench gallery-seed data files below (dev-only DATA, argued
 * individually) and the compiler-enforced Rust ones.
 *
 * @returns {boolean} true when `file` belongs to the TEST tier.
 */
function isTestTierFile(file) {
  const norm = file.replace(/\\/g, '/')
  const under = d => {
    const nd = d.replace(/\\/g, '/')
    return norm === nd || norm.startsWith(`${nd}/`)
  }
  // The two TEST TREES (WS-R4's headline addition — they were in no root at all).
  if (under(SERVER_TESTS) || under(UI_TESTS)) return true
  // The retired BASENAME exemption, now a classifier.
  if (/\.(test|spec)\.(ts|tsx|mjs|js)$/.test(path.basename(file))) return true
  // The retired DIRECTORY exemptions — test-only helpers/fakes that FEED the suites.
  if (norm.includes('/__fixtures__/') || norm.includes('/__testutil__/')) return true
  return false
}

function isExemptFile(file) {
  // ── WS-R3 §4: the `gallery.tsx` / `cassette.ts` BASENAME exemption is GONE ──
  //
  // It exempted 10 files carrying 190 hits, and it was claimable by NAMING a file:
  // any leak could be moved into a new `modules/<x>/gallery.tsx` and vanish. That is
  // the identical property this file's own WS-B header condemns in the `/gallery/`
  // DIRECTORY exemption it removed — "a topical carve-out masquerading as a
  // structural one" — kept alive in its basename form for one more round.
  //
  // The 10 files (9 `gallery.tsx` + `dev/gallery/fixtures/cassette.ts`) are now
  // SCANNED and their residue BASELINED, per file per token, tagged R3-GALLERY.
  // COST: +190 baselined hits, visible and shrink-only. The alternative — a genuinely
  // structural rule ("unreachable from the production entry") — needs a bundler-level
  // reachability analysis this guard has no business owning, and until someone builds
  // it, "baseline it" is strictly stronger than "stop looking".
  //
  // WS-R4 — `*.test.*` / `*.spec.*` NO LONGER EXEMPTS. Neither do `__fixtures__/` /
  // `__testutil__/`. R3-F1 is CLOSED: all three were claimable by naming a file or a
  // directory, and all three are now CLASSIFIERS feeding `isTestTierFile` above,
  // which decides the TIER a finding lands in rather than whether the file is read.
  // COST: +128 `*.test.*`/`*.spec.*` files and +3 `__fixtures__`/`__testutil__` files
  // in the scan set, all baselined under `R4-TESTS-UNIT` / `R4-TESTS-SUPPORT`.
  const norm = file.replace(/\\/g, '/')
  // WS-B blind spot #1c — the BLANKET `/gallery/` directory exemption is GONE.
  // It exempted every file under any `gallery/` dir, which is a topical carve-out
  // masquerading as a structural one: `core/gallery/fixtureSpecs.ts` and
  // `core/gallery/DeclarativeFixtureStories.tsx` are PRODUCTION `core/**` files
  // (imported by the dev gallery entry, but ordinary core code with ordinary core
  // imports), and the exemption meant nothing in them was ever scanned. The
  // surviving exemptions are the DEV ENTRY POINT itself (`gallery.tsx`, matched by
  // basename above — tree-shaken from the prod bundle) and the two named
  // gallery-only datatype SEED fixtures below. Both are files, not directories, so
  // a new file dropped into a `gallery/` dir is scanned like any other.
  // ITEM-20 removed the `/processor-packages/**` exemption together with the directory it
  // exempted (`ui/src/processor-packages/single-cell`, the last processor FE-CODE package —
  // ITEM-15). A relocated-not-eliminated exemption is exactly how domain code hides, so the
  // branch does not outlive its subject.
  //
  // ITEM-39 removed the `core/(dsl|interaction)/**` exemption the same way. It covered 9
  // `[quoted-id]` hits (`'clustering'` ×7, `'embedding'` ×1 in `dsl/{eval,validate,
  // vocabulary}.ts` + `'clustering'` ×3 in `interaction/recipe.ts`) that were VERSIONED
  // WIRE-GRAMMAR tokens of a bounded query language rather than datatype ids — a real
  // carve-out, but one that had already outlived two deadlines (ITEM-4, then ITEM-9).
  // The query language is now DELETED: ITEM-39 removed the four general dimension
  // primitives (no shipping processor spec instantiated any of their widget kinds), which
  // were its last consumers, and the evaluator / validator / vocabulary / classifier went
  // with them. The tokens are gone, so the exemption is gone — ended, not renewed.
  // The workbench gallery-seed fixtures are DEV-ONLY DATA reachable ONLY from `gallery.tsx`
  // (the dev gallery entry, tree-shaken from the prod bundle). They legitimately declare
  // domain datatype DATA (the image fixture + its seed) to SEED the gallery registry the way
  // a backend would. EXEMPT the SPECIFIC dev-seed files, NOT the whole directory (B-2) — so a
  // future PROD-imported file dropped into `fixtures/` is NOT silently exempted; only these
  // two named, gallery-only seeds are (their `.test.` sibling is already exempt above).
  if (/\/modules\/workbench\/fixtures\/(imageDatatype|galleryDatatypeSeed)\.ts$/.test(norm)) return true
  return false
}

function listFiles(dir, exts, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      listFiles(full, exts, out)
      continue
    }
    if (!exts.some(e => entry.name.endsWith(e))) continue
    out.push(full)
  }
  return out
}

/**
 * Every Rust file that is TEST-ONLY BY DECLARATION — i.e. some `mod.rs` under the
 * server module tree declares it `#[cfg(test)] mod <name>;`. Such a file is compiled
 * only for `cargo test` and never ships, and the in-tree grep-guards among them
 * (e.g. `workstore/no_legacy_wire.rs`) must spell the forbidden vocabulary out as
 * literals in order to search for it — scanning them would make the guard flag its
 * own twin.
 *
 * Resolved from the DECLARATION, never from a name pattern, so the exemption cannot
 * be claimed by anything that actually ships. Covers both `#[cfg(test)] mod x;`
 * (→ `x.rs`) and a test-only submodule DIRECTORY (→ everything under `x/`).
 *
 * WS-R3 §2 — the directory case now sweeps EVERY extension, not just `.rs`. Adding
 * the data dialects made that load-bearing: `datatype/tests/lattice_golden.json` is
 * a 93-hit domain-lattice oracle sitting inside a directory `datatype/mod.rs`
 * declares `#[cfg(test)] mod tests;`. It is exempt for exactly the same
 * compiler-enforced reason its `mod.rs` sibling is — by DECLARATION, not because it
 * is named "golden". `mcp/testdata/*.json`, by contrast, is NOT under a declared
 * test module, so it is scanned like any other data file.
 *
 * @returns {Set<string>} absolute paths.
 */
function testOnlyRustModules() {
  const out = new Set()
  // `#[cfg(test)]` (possibly with other attrs/comments between) then `mod <name>;`
  const declRe = /#\[\s*cfg\s*\(\s*test\s*\)\s*\]\s*(?:pub\s*(?:\([^)]*\)\s*)?)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/g
  for (const modFile of listFiles(SERVER_MODULES, ['mod.rs'])) {
    const src = readFileSync(modFile, 'utf8')
    const dir = path.dirname(modFile)
    let m
    while ((m = declRe.exec(src)) !== null) {
      const asFile = path.join(dir, `${m[1]}.rs`)
      if (existsSync(asFile)) out.add(asFile)
      const asDir = path.join(dir, m[1])
      if (existsSync(asDir) && statSync(asDir).isDirectory()) {
        for (const f of listFiles(asDir, ALL_EXTS)) out.add(f)
      }
    }
  }
  return out
}

/**
 * @returns {{set: {path:string,lang:'rust'|'ts'}[], counts: {rust:number,workbenchFe:number,extraFe:number}}}
 * the app-builtin production surface, plus the per-root counts ITEM-37 floors.
 */
/** Extension → tokenizer dialect. */
function langOf(file) {
  if (file.endsWith('.rs')) return 'rust'
  if (file.endsWith('.sql')) return 'sql'
  if (file.endsWith('.py')) return 'py'
  if (file.endsWith('.json')) return 'json'
  if (file.endsWith('.yaml') || file.endsWith('.yml')) return 'yaml'
  return 'ts'
}

/**
 * ── WS-R3 §2: WHICH extensions apply to WHICH root ──────────────────────────
 *
 * THE RULE, stated once: **a root is scanned in every format the app EMBEDS,
 * EXECUTES or SHIPS from that tree, and in no others.** Concretely —
 *
 *   `server/src/**`, `server/build_helper/**`  →  CODE `.rs`
 *                                              +  DATA `.sql` `.py` `.json` `.yaml`
 *       The server EMBEDS all four: `.sql` migrations are compiled in and run at
 *       boot; `seed_multimodal.py` / `seed_anndata_import.py` are literally
 *       `include_str!`-ed by `workstore/data_api.rs:1184,1470` and executed;
 *       `mcp/frontend-actions.json` is a baked manifest. A domain literal in any of
 *       them ships exactly like one in a `.rs` file.
 *   `ui/src/**`, `packages/<scanned>/**`, `desktop/**`  →  CODE `.ts` `.tsx` (`.rs`
 *                                              for the Tauri half) + DATA `.json`
 *                                              `.yaml`
 *       Bundled or read at runtime.
 *   `ui/openapi/**`  →  DATA `.json` ONLY, and it is its OWN root.
 *       `openapi.json` is a SHIPPED CONTRACT (33 measured hits) and it is
 *       GENERATED, so it is the one file where a leak arrives without anyone
 *       typing it. No root reached it at all before. Its own root + floor means a
 *       relocation of the emitter cannot silently drop it.
 *
 * NOT SCANNED, by decision, each with its measured cost:
 *   `packages/**` — the CONTRIBUTED DOMAIN ITSELF, as DATA. Scanning it would be
 *       a category error: `packages/single-cell-types/manifest.yaml` IS the
 *       lattice the app must not contain. It is not in, and never has been in, any
 *       root; recorded here so the omission is a decision on the record.
 *   `env-rootfs/**` — `env-rootfs/single-cell/Dockerfile`, 27 measured hits
 *       (`scanpy`, `anndata`, `tiledbsoma`, `cellranger`, `squidpy`…). Same class:
 *       it is the DEFINITION of one domain's environment image, published to GHCR
 *       and lazy-fetched by a generic `OciEnvImageProvider` — the env analogue of a
 *       processor package, not app-builtin code. It is also extensionless
 *       (`Dockerfile`), so admitting it means admitting extensionless files, which
 *       is a different and much larger decision. THE RESIDUAL FINDING (R3-F2) is
 *       not the file's CONTENT but its PATH: the directory is named `single-cell`
 *       and `sandbox/env_image.rs:50` still documents the OCI ref
 *       `ghcr.io/ziee-ai/cyto-env/single-cell`, so the app still knows one domain's
 *       env by name. That belongs to a sibling round.
 *   `libs/viz` — the pre-existing owner carve-out (see `SCANNED_PACKAGES`).
 */
const CODE_EXTS_RUST = ['.rs']
const CODE_EXTS_FE = ['.ts', '.tsx']
const DATA_EXTS = ['.sql', '.py', '.json', '.yaml', '.yml']
/** Every extension any root scans — used by the test-only-by-declaration sweep. */
const ALL_EXTS = [...CODE_EXTS_RUST, ...CODE_EXTS_FE, ...DATA_EXTS]

export function defaultScanSet() {
  const set = []
  const seen = new Set()
  const counts = {
    rust: 0,
    rustRoot: 0,
    buildHelper: 0,
    desktop: 0,
    workbenchFe: 0,
    uiFe: 0,
    packagesFe: 0,
    // WS-R3 §2 — the DATA roots.
    serverData: 0,
    feData: 0,
    uiOpenapi: 0,
    // WS-R4 — the TEST roots.
    serverTests: 0,
    serverTestsData: 0,
    uiTests: 0,
    uiSpecs: 0,
  }
  /** add `f` under root `root`; returns false if already in the set. */
  const add = (f, root) => {
    if (seen.has(f)) return false
    if (isExemptFile(f)) return false
    seen.add(f)
    set.push({ path: f, lang: langOf(f) })
    counts[root]++
    return true
  }

  // ── WS-R4: the TEST roots, walked FIRST ────────────────────────────────────
  //
  // ORDER IS LOAD-BEARING. `ui/src/**/*.test.ts` (124 files) and
  // `libs/dock/**/*.test.ts` (4) sit INSIDE the `uiFe` / `packagesFe` root
  // DIRECTORIES; they were invisible only because the basename exemption dropped
  // them before `add()`. Now that they are read, they must be attributed to the TEST
  // tier, not to `uiFe` — otherwise 128 test files and their residue would land on
  // the PRODUCTION floors and ceilings and destroy exactly the signal those floors
  // exist to carry. Walking the test roots first lets `seen` do that attribution,
  // and `productionOnly` below is the belt-and-braces restatement so the invariant
  // does not depend on statement order alone.
  //
  // ── THE EXTENSION RULE FOR A TEST ROOT (WS-R4), stated once ────────────────
  //
  // Round 3's production rule is "a root is scanned in every format the app EMBEDS,
  // EXECUTES or SHIPS from that tree, and no others." A test tree SHIPS NOTHING, so
  // that rule does not transfer; the analogue has to be derived from what makes a
  // domain literal in a test tree load-bearing in the first place. It is not that it
  // ships — it is that the SUITE RUNS IT. An executed assertion against a contributed
  // domain id is a COUPLING: it makes the app's own suite fail when the contributed
  // bundle changes. A fixture the suite reads and compares against is the same thing
  // one indirection away (a golden oracle is an assertion in data form). A format the
  // suite neither compiles nor reads is inert. Hence:
  //
  //   **A test root is scanned in every format the SUITE COMPILES, EXECUTES or
  //   ASSERTS AGAINST from that tree, and in no others.**
  //
  //   `server/tests/**`  →  `.rs` (compiled + run by `cargo test --test
  //                         integration_tests`) + `.py`/`.yaml`/`.json`/`.sql`
  //                         (fixture data the suite reads: the 12 processor-manifest
  //                         lint fixtures, `make_mtx_trio.py`, `gen_oracle.py`).
  //   `ui/tests/**`      →  `.ts`/`.tsx` (compiled + run by Playwright) + the same
  //                         data formats (none present today — the root is declared
  //                         in both formats so a fixture added tomorrow is covered).
  //   `uiSpecs`          →  `.ts`/`.tsx` only; it is a BASENAME root, and the
  //                         basename glob the runners collect by is `.ts`/`.tsx`.
  //
  // NOT SCANNED, by decision, each with its reason:
  //   `.sh` — `server/tests/dataset/fixtures/fetch.sh`,
  //       `ui/tests/e2e/project-admin/run-e2e.sh`. There is NO `.sh` dialect in
  //       either tokenizer, and adding one is a new-dialect decision (it needs a
  //       `classifyData` arm and a byte-identical Rust port) far larger than the two
  //       runner wrappers justify. Recorded so the omission is on the record.
  //   `.gz` / `.h5ad` — binary. Not text; nothing to tokenize.
  //   `packages/**` incl. `packages/*/tests/**` (~16 pytest files) — the
  //       CONTRIBUTED DOMAIN ITSELF, as DATA. `packages/single-cell-types/
  //       manifest.yaml` IS the lattice the app must not contain, and a processor's
  //       own pytest suite is that package testing its own domain, which is exactly
  //       what a contributed package is FOR. Scanning it would be a category error —
  //       the same one round 3 recorded for the production side. EXPLICITLY out.
  //   `libs/viz/tests/**` (20 `.mjs`) — the pre-existing owner carve-out (see
  //       `SCANNED_PACKAGES`); the tests follow the package.
  //   `server/src/modules/**/tests/**` — TEST-ONLY BY DECLARATION, the
  //       compiler-enforced exclusion. Unchanged; see `stripCfgBlocks` for why, and
  //       `CARDINALITY_CERTIFICATIONS` for the one thing it costs that this round
  //       had to answer for anyway.
  for (const f of listFiles(SERVER_TESTS, CODE_EXTS_RUST)) add(f, 'serverTests')
  for (const f of listFiles(SERVER_TESTS, DATA_EXTS)) add(f, 'serverTestsData')
  for (const f of listFiles(UI_TESTS, [...CODE_EXTS_FE, ...DATA_EXTS])) add(f, 'uiTests')
  // `uiSpecs` — the ex-BASENAME-exemption root: every `*.{test,spec}.{ts,tsx}` and
  // every `__fixtures__`/`__testutil__` file under the FE production trees. It is a
  // PREDICATE root rather than a directory root, because the files it collects are
  // scattered through `ui/src/**` and the scanned packages by design.
  for (const dir of [UI_SRC, DESKTOP, ...SCANNED_PACKAGES.map(p => path.join(PACKAGES, p))]) {
    for (const f of listFiles(dir, [...CODE_EXTS_FE, ...DATA_EXTS])) {
      if (!isTestTierFile(f)) continue
      add(f, 'uiSpecs')
    }
  }
  /** WS-R4 — a production root never takes a test-tier file (see the order note). */
  const productionOnly = f => !isTestTierFile(f)

  // ── Backend ────────────────────────────────────────────────────────────────
  // The WHOLE module tree (ITEM-30), minus files that are test-only by
  // declaration. No hand-listed allowlist — a new module is guarded on arrival.
  const testOnly = testOnlyRustModules()
  for (const f of listFiles(SERVER_MODULES, ['.rs'])) {
    if (testOnly.has(f)) continue
    add(f, 'rust')
  }
  // WS-C: `server/src` OUTSIDE `modules/`. `lib.rs` is the whole boot assembly
  // and `main.rs` is the CLI — the two files an operator reads first — and both
  // were outside every guard in the tree. (`main.rs:11` names the domain in the
  // binary's own `--help` blurb; see the baseline.)
  const modulesPrefix = SERVER_MODULES + path.sep
  for (const f of listFiles(SERVER_SRC, ['.rs'])) {
    if (f.startsWith(modulesPrefix)) continue
    if (testOnly.has(f)) continue
    add(f, 'rustRoot')
  }
  // WS-C: the build helpers. They RUN at build time and bake paths into the
  // binary, so a domain path here ships exactly like one in `modules/`.
  for (const f of listFiles(BUILD_HELPER, ['.rs'])) add(f, 'buildHelper')
  // WS-C: the desktop harness (Tauri). Small and, as measured, already clean —
  // which is precisely why it is cheap to guard and expensive to leave open.
  for (const f of listFiles(DESKTOP, ['.rs', '.ts', '.tsx'])) {
    if (!productionOnly(f)) continue
    add(f, 'desktop')
  }

  // ── Frontend ───────────────────────────────────────────────────────────────
  // The workbench app builtin keeps its OWN root + floor (it is the subject of
  // INV-2 and of most of the audit's FE findings), so a collapse there cannot
  // hide inside the bulk `uiFe` count.
  for (const f of listFiles(path.join(UI_SRC, 'modules', 'workbench'), ['.ts', '.tsx'])) {
    if (!productionOnly(f)) continue
    add(f, 'workbenchFe')
  }
  // WS-C: EVERYTHING else under `ui/src` — `modules/*` (datasets, projects,
  // visualization, …), `core/`, `dev/`, `api-client/`, `components/`, `hooks/`,
  // `lib/`, `utils/`. Pre-WS-C the guard saw exactly TWO files out of this whole
  // tree. It is scanned wholesale now: the app surface is the default, and an
  // exemption has to be argued (`isExemptFile`), never assumed.
  for (const f of listFiles(UI_SRC, CODE_EXTS_FE)) {
    if (!productionOnly(f)) continue
    add(f, 'uiFe')
  }
  // WS-C: `packages/*`, allowlisted (see SCANNED_PACKAGES + the viz carve-out).
  for (const pkg of SCANNED_PACKAGES) {
    for (const f of listFiles(path.join(PACKAGES, pkg), CODE_EXTS_FE)) {
      if (!productionOnly(f)) continue
      add(f, 'packagesFe')
    }
  }

  // ── WS-R3 §2: the DATA roots (see the extension-policy block above) ────────
  // `serverData` — everything the server EMBEDS in a non-Rust format. Same
  // test-only-by-declaration exclusion as the `.rs` walk, which is what keeps
  // `datatype/tests/lattice_golden.json` out by DECLARATION rather than by name.
  for (const f of listFiles(SERVER_SRC, DATA_EXTS)) {
    if (testOnly.has(f)) continue
    if (!productionOnly(f)) continue
    add(f, 'serverData')
  }
  for (const f of listFiles(BUILD_HELPER, DATA_EXTS)) add(f, 'serverData')
  // `feData` — the same for the three frontend trees.
  for (const f of listFiles(UI_SRC, DATA_EXTS)) {
    if (!productionOnly(f)) continue
    add(f, 'feData')
  }
  for (const f of listFiles(DESKTOP, DATA_EXTS)) {
    if (!productionOnly(f)) continue
    add(f, 'feData')
  }
  for (const pkg of SCANNED_PACKAGES) {
    for (const f of listFiles(path.join(PACKAGES, pkg), DATA_EXTS)) {
      if (!productionOnly(f)) continue
      add(f, 'feData')
    }
  }
  // `uiOpenapi` — the SHIPPED CONTRACT, its own root (see the policy block).
  for (const f of listFiles(path.join(UI_ROOT, 'openapi'), ['.json'])) add(f, 'uiOpenapi')

  return { set, counts }
}

/**
 * WS-R3 §4 — ONE REAL PRODUCTION FILE PER ROOT that the walk MUST reach.
 *
 * The per-root file-count floors prove a root found SOMETHING; they cannot prove it
 * found the RIGHT something, and three roots (`rustRoot` 0 code/2 prose,
 * `buildHelper` 0/3, `desktop` 0/1) carry so little residue that a no-op walk there
 * would pass every hit-count floor silently — the global `MIN_NOUN_*` floors are
 * global, so a single collapsed root disappears into the total.
 *
 * This is the JS side of the Rust twin's `MUST_SCAN_KEYS`, deliberately the SAME
 * mechanism rather than a new one: pin a real, load-bearing production file per
 * root. Unlike a residue witness (which asserts a LEAK still exists and therefore
 * self-destructs the moment someone fixes it) this keeps working as the tree gets
 * clean.
 *
 * It also REPLACES the `extraFe` floor. `extraFe` was a count-of-2 standing in for
 * "these two named files are still present", which is a presence assertion wearing a
 * floor's clothes — it could not say WHICH one went missing. The two files are now
 * pinned here by name, where a failure names them.
 */
const MUST_SCAN_KEYS = [
  // ROOT `rust`. This pinned `workstore/serve_core.rs` until artifact-model ITEM-12
  // DELETED it — the Selection→Arrow serve core behind `GET /artifacts/{id}/read`, gone
  // along with the Selection grammar and the tier routing, because `/data[/{*member}]`
  // is now the only read surface and the server never decodes. The witness went missing
  // and this check fired, which is exactly what it is for.
  //
  // Re-pointed at `workstore/data_api.rs`, byte-for-byte the same key the Rust twin
  // (`server/tests/domain_surface/mod.rs::MUST_SCAN_KEYS`) re-pointed to, so the two
  // enforcers keep naming the same file. It is the same module, the same root, and now
  // the file that actually serves the bytes — the root's coverage is unchanged in
  // substance — and it is the largest surviving file in the root, which makes it a good
  // liveness witness rather than an arbitrary one.
  ['rust', 'server/src/modules/workstore/data_api.rs'],
  ['rustRoot', 'server/src/main.rs'],
  ['rustRoot', 'server/src/lib.rs'],
  ['buildHelper', 'server/build_helper/sandbox_rootfs.rs'],
  ['desktop', 'desktop/tauri/src/main.rs'],
  ['workbenchFe', 'ui/src/modules/workbench/core/index.ts'],
  // the two formerly hand-listed FE subjects (ITEM-16 + the bootstrap lattice),
  // which used to be asserted only as `extraFe === 2`.
  ['uiFe', 'ui/src/core/datatypes/builtin.ts'],
  ['uiFe', 'ui/src/modules/datasets/components/UploadPanel.tsx'],
  ['packagesFe', 'libs/dock/src/index.ts'],
  // ── ROUND-4 RECONCILIATION — the `serverData` witnesses, re-decided on evidence ──
  //
  // WS-R4 de-anchored the `.py` witness (`seed_multimodal.py`) because the two seed
  // drivers were "under active review for deletion", and re-anchored on a MIGRATION plus
  // `frontend-actions.json`, arguing "migrations are append-only and are never deleted".
  // The round-4 merge falsified BOTH halves of that in one shot:
  //   * r4squash collapsed 49 module-local migrations into 8 baselines, DELETING
  //     `202608020001_workstore_open_axes.sql` — so the "append-only" witness is the one
  //     that went missing, and the guard correctly went red and named it. Re-pointed at
  //     the surviving baseline. This is kept as a NAMED witness rather than downgraded:
  //     a squash IS a coverage-relevant event, the check fired, and re-pointing it is a
  //     one-line reviewable edit in the commit that moves the file. What it must NOT be
  //     is the ONLY thing standing between this root and a silently-dropped format —
  //     hence `FORMAT_COVERAGE_PINS` below.
  //   * r4dataapi RESOLVED the review the `.py` de-anchoring was hedging against: the six
  //     subject-specific debug routes were replaced by ONE generic engine, and both seed
  //     drivers SURVIVED as its `include_str!`-ed payload. They are still
  //     `#[cfg(debug_assertions)]`-gated, so they are still deletable by a future round,
  //     and re-pinning one by NAME would just re-create the brittleness WS-R4 removed.
  // DECISION (the recorded answer to "is a `.py` root with no durable identity pin
  // acceptable?"): no, and it does not have to be. The gap WS-R4 named is not really
  // "which file" — it is "did this root silently stop covering this FORMAT", and that is
  // answerable WITHOUT naming a file. `FORMAT_COVERAGE_PINS` (below) probes the tree for
  // the extension independently of the walk and fails only when files of that format
  // EXIST but the walk reached none. It cannot be broken by deleting a file (if the last
  // one goes, the pin goes vacuous) and it cannot be dodged by an exemption. `.py` is
  // covered by that, not by a name.
  ['serverData', 'server/src/modules/workstore/migrations/202608030004_workstore_baseline.sql'],
  ['serverData', 'server/src/modules/mcp/frontend-actions.json'],
  ['feData', 'ui/src/modules/workbench/core/manifest/schema.json'],
  ['uiOpenapi', 'ui/openapi/openapi.json'],
  // ── WS-R4 — one REAL witness per TEST root. Same mechanism as every entry
  // above (pin a load-bearing file by name; fail when the walk stops reaching
  // it), deliberately NOT a new one. Two of the four are the files carrying the
  // exact-cardinality certifications this round exists to surface, so a rename
  // that would take a certification out of the guard's sight fails HERE and
  // names the file.
  ['serverTests', 'server/tests/integration_tests.rs'],
  ['serverTests', 'server/tests/datatype/mod.rs'],
  // Both durable by the same standard applied to `serverData` above: the manifest
  // fixture backs the processor-manifest LINT suite (deleting it deletes the test), and
  // `make_mtx_trio.py` is the documented regenerator for the committed mtx-trio fixture,
  // cited by `dataset/mtx_trio_convert_test.rs:13,38,147`. Neither is a debug-route
  // accessory.
  ['serverTestsData', 'server/tests/fixtures/processor_manifest_lint/ok/goodpkg/manifest.yaml'],
  ['serverTestsData', 'server/tests/dataset/fixtures/make_mtx_trio.py'],
  ['uiTests', 'ui/tests/e2e/datatype/registry.spec.ts'],
  ['uiSpecs', 'ui/src/modules/workbench/core/__testutil__/fakes.ts'],
]

/**
 * @param {{path:string}[]} set
 * @returns {string[]} one message per MUST_SCAN key the walk did not reach.
 */
export function mustScanViolations(set) {
  const keys = new Set(set.map(e => baselineKey(e.path)))
  const out = []
  for (const [root, key] of MUST_SCAN_KEYS) {
    if (keys.has(key)) continue
    out.push(
      `scan-set root "${root}" did NOT reach "${key}" — a file this guard pins as proof the ` +
        `root is really walked. Either the file moved (re-point MUST_SCAN_KEYS in the same ` +
        `commit as the move) or the root's walk/extension policy silently stopped covering it, ` +
        `which is the collapse this check exists to catch.`,
    )
  }
  return out
}

/**
 * ROUND-4 — the PER-FORMAT identity pin, and the answer to the `.py` gap WS-R4
 * recorded (see the `serverData` block in `MUST_SCAN_KEYS`).
 *
 * `MUST_SCAN_KEYS` pins a FILE, so a format whose only files are individually
 * deletable cannot be pinned at all without making the guard hostage to an unrelated
 * round's deletion — which is how the `.py` witness was lost, and how the `.sql` one
 * broke when r4squash deleted the migration it named.
 *
 * This pins the FORMAT instead. For each (root, extension) it probes the root's
 * directories with an INDEPENDENT walk that applies ONLY the extension — no
 * extension policy, no exemptions, nothing the guard could have broken — and fails
 * when that probe finds files but the resolved scan set contains none of them. So:
 *   * dropping `.py` from `DATA_EXTS`, or adding an exemption that swallows the seed
 *     drivers, fails HERE and names the format;
 *   * deleting the last `.py` file makes the pin VACUOUS rather than red, which is
 *     the brittleness that made a named `.py` witness unusable;
 *   * it cannot be satisfied by renaming anything, because it names no file.
 * KNOWN LIMIT, stated: the probe is deliberately dumber than the walk, so if a root's
 * ONLY file in a format were legitimately excluded (e.g. every `.sql` moving under a
 * `#[cfg(test)] mod`), this fires. That is a review-worthy event, not a false alarm.
 * @type {[string, string, string[]][]} [root, extension, probe dirs]
 */
const FORMAT_COVERAGE_PINS = [
  ['serverData', '.py', [SERVER_SRC, BUILD_HELPER]],
  ['serverData', '.sql', [SERVER_SRC, BUILD_HELPER]],
  ['serverData', '.json', [SERVER_SRC, BUILD_HELPER]],
]

/**
 * @param {{path:string}[]} set
 * @returns {string[]} one message per (root, format) the walk stopped covering.
 */
export function formatCoveragePinViolations(set) {
  const scanned = new Set(set.map(e => e.path))
  const out = []
  for (const [root, ext, dirs] of FORMAT_COVERAGE_PINS) {
    const present = dirs.flatMap(d => listFiles(d, [ext]))
    if (present.length === 0) continue // vacuous by design — nothing to cover
    if (present.some(f => scanned.has(f))) continue
    out.push(
      `scan-set root "${root}" reached ZERO "${ext}" file(s) although ${present.length} exist(s) ` +
        `on disk (e.g. "${baselineKey(present[0])}"). The root's extension policy or an ` +
        `exemption silently stopped covering the format — the collapse a per-FILE witness ` +
        `cannot see once that file is deletable. Restore coverage, or remove the pin from ` +
        `FORMAT_COVERAGE_PINS deliberately, with the reason.`,
    )
  }
  return out
}

// ════════════════════════════════════════════════════════════════════════════
//  WS-R5 G3 — the TREE CENSUS. "Not scanned" must be a DECISION, everywhere.
// ════════════════════════════════════════════════════════════════════════════
//
// `packageDeclarationViolations` made "not scanned" a written-down decision for exactly
// one level: the children of `packages/`. Everywhere else it was a property of which
// paths the walk happens to name — so THREE whole trees were in no scan root AND in no
// declared-exclusion list, and nothing said so:
//
//   * `src-app/testdata/`   — 334 findings (300 in one JSON corpus)
//   * repo-root `scripts/`  — 78 findings, including 3 quote-delimited datatype ids
//   * `src-app/ui/scripts/` — 3901 findings
//
// The guard documents `packages/**`, `libs/viz`, `.sh`, `.gz`, `.h5ad` as "NOT
// SCANNED, by decision" with measured costs; these three appeared nowhere. This check is
// the generalisation of the packages one: at each census LEVEL, every child directory is
// either REACHED by the resolved scan set or named in `UNSCANNED_TREES` with a reason.
// A fourth undeclared tree is now a failure, not a silence.
//
// The levels are the directories at which a tree can hide from a walk whose roots are
// named one level down. `packages/` keeps its own dedicated check (it carries the
// SCANNED/UNSCANNED pair and its own message); this is the sweep around it.
const TREE_CENSUS_LEVELS = [
  REPO_ROOT,
  SRC_APP,
  path.join(SRC_APP, 'ui'),
  path.join(SRC_APP, 'server'),
  path.join(SRC_APP, 'desktop'),
]

/** Build/vendor output. Not a decision anybody makes — skipped by name, not declared. */
const CENSUS_SKIP_DIRS = new Set(['node_modules', 'target', 'dist', 'build', 'coverage'])

/**
 * Every tree the guard does NOT walk, with the REASON and the MEASURED cost.
 *
 * Costs measured 2026-07-28 by running this guard's own tokenizer over each tree via the
 * self-test scan override, mapping each extension to its nearest dialect. That is a PROBE,
 * not the committed extension policy (`.md`, `.sh`, `.txt` have no dialect here at all),
 * so read the numbers as the order of magnitude they are — which is what a decision of
 * this kind needs.
 */
const UNSCANNED_TREES = {
  // ── repo root ──
  'agent-kit':
    'a git SUBMODULE (ziee-ai/agent-kit) — shared framework docs + skills, owned by another repo. ' +
    'A guard in THIS repo cannot ratchet a tree this repo does not author; a leak there is a ' +
    'finding for its own repo. Not measured.',
  sdk: 'a git SUBMODULE (ziee-ai/sdk). Same argument as agent-kit: not authored here, so not ratcheted here.',
  docs: 'PROSE-ONLY research + design notes; measured 7377 findings (6271 code-tier / 1106 prose / ' +
    '349 literal), 92 files, led by docs/research/data-processing/*.md (699/593/540). These are ' +
    'notes ABOUT the domain — the single place in the repo where naming the domain is the POINT — ' +
    'and nothing under docs/ compiles, ships or is read at runtime. Scanning them would be the ' +
    'same category error already recorded for packages/**. EXPLICITLY out.',
  scripts:
    'repo-root dev/gate scripts; measured 78 findings (32 code / 46 prose / 2 literal) over 11 files. ' +
    'The literals are BACKTICKED IDS IN SHELL COMMENTS inside sibling grep-guards ' +
    '(check-no-legacy-wire.sh names `geneset/collection`/`graph/attributed`/`de/result`, ' +
    'check-kinds-zero-core.sh names `graph/attributed`) — a guard has to spell the vocabulary it ' +
    'searches for, the same self-reference this guard is exempted from by NON_DOMAIN_IDENTIFIERS. ' +
    'The bulk is the criteria-coercion PARITY runner (coercion-parity{,-ts,-ws-check}.mjs + ' +
    'coercion-parity-kernel.py, 60 of 78), which is a THREE-READER conformance harness over the ' +
    'contributed criteria corpus. Also: .sh and .mjs have NO dialect in either tokenizer, so ' +
    'scanning this tree is a new-dialect decision (a classifyData arm + a byte-identical Rust ' +
    'port) and not a root edit. DEFERRED, not impossible.',
  // ── src-app ──
  packages:
    'the CONTRIBUTED DOMAIN ITSELF, as DATA. packages/single-cell-types/manifest.yaml IS the ' +
    'lattice the app must not contain; it is now READ by contributedDatatypes() as the source of ' +
    'the forbidden vocabulary. Scanning the source of the vocabulary against the vocabulary is a ' +
    'category error. EXPLICITLY out (the pre-existing decision, recorded in defaultScanSet).',
  'cloud-sim':
    'the LOCAL cloud-deployment SIMULATION scaffolding added by the compute/accounts epic — a ' +
    'kind (k8s-in-docker) config, a KEDA ScaledObject, a worker Dockerfile + deployment scaffold, ' +
    'a docker-compose and a README, used to exercise the saas ComputeBackend::Kubernetes path off a ' +
    'developer box. It is TRACKED (7 files) and NOT gitignored, so the runtime-artefact rule does ' +
    'not skip it. Measured 0 findings: the only files with a dialect this guard tokenises are the ' +
    '`.yaml` (k8s/KEDA/compose infra manifests, no domain vocabulary); the Dockerfile / .md / ' +
    '.gitignore have no dialect. Out for the same reason as `server/config` and `env-rootfs` — ' +
    'operator/deploy infra, not shipped source — recorded so the zero is on the record.',
  'billing-sim':
    'the LOCAL Stripe SIMULATION substrate added by the billing epic (B0) — the billing ' +
    'analogue of the compute epic`s `cloud-sim`. One `stripe/stripe-mock` container (a ' +
    'docker-compose + README + a gitignored env contract) that stands up a credential-free, ' +
    'no-network Stripe mock on loopback so the billing tiers are provable without a real ' +
    'Stripe key. It is TRACKED (3 files: docker-compose.billing-sim.yaml, README.md, ' +
    '.gitignore) and NOT gitignored, so the runtime-artefact rule does not skip it. Measured ' +
    '0 findings: the only file with a dialect this guard tokenises is the `.yaml` (compose ' +
    'infra, no domain vocabulary); the `.md` and `.gitignore` have no dialect. Out for the ' +
    'same reason as `cloud-sim` and `server/config` — deploy/test infra, not shipped source ' +
    '— recorded so the zero is on the record.',
  'env-rootfs':
    'the analysis container recipe (Dockerfiles + apt/pip lists). Measured 0 findings in any ' +
    'dialect this guard has. The rootfs is the domain ENVIRONMENT by construction — it is what ' +
    'the contributed processors run inside — so it is out for the same reason packages/ is.',
  testdata:
    'FIXTURE CORPORA for the criteria-coercion parity gate; measured 334 findings over 2 files ' +
    '(300 in criteria-coercion-corpus.json, 34 in its README). A golden corpus of contributed-domain ' +
    'criteria is the domain in DATA form, like a processor manifest. Bringing it under the ratchet ' +
    'is a ~300-entry hand-authored baseline pass in the TEST tier; DEFERRED with the cost on the ' +
    'record rather than left invisible, which is the whole point of this list.',
  // ── src-app/ui ──
  'ui/scripts':
    'the GUARD TOOLING ITSELF; measured 3901 findings over 31 files, of which 3760 (96%) are this ' +
    "guard's own three artefacts — domain-baseline.json (3088: it IS the ledger of domain tokens), " +
    'lint-no-domain-in-builtin.mjs (376) and its test file (296). Every one of those has to spell ' +
    'the vocabulary out in order to search for it; this is the self-reference NON_DOMAIN_IDENTIFIERS ' +
    'and the "[WS-B] the guard does NOT flag its own forbidden-string list" test already handle at ' +
    'file granularity. The RESIDUE outside the three is ~141 findings over 28 files (worst: ' +
    'surface-baseline-expected-delta.json 109, capture-surface-baseline.test.mjs 10, viz-bench.mjs 8). ' +
    'Also .mjs has no dialect in either tokenizer. DEFERRED, with the residue measured.',
  'ui/openapi-saas':
    'the saas-ON GENERATED OpenAPI spec (#50), a build artefact of `cargo run --features saas -- ' +
    '--generate-openapi-saas`. It is TRACKED (1 file: openapi.json) and NOT gitignored, so the ' +
    'runtime-artefact rule does not skip it — hence declared here. It is a byte-equivalent TWIN of ' +
    'the already-scanned ui/openapi/openapi.json ON THE DOMAIN SURFACE (measured DIFF = 0: the ' +
    'billing/saas superset adds account/subscription/credit vocabulary, ZERO genomic nouns), so it ' +
    'would contribute the SAME 8 code (file, token) pairs (sample 3 / obs 2 / gene 1 / cells 2 / ' +
    'genes 2 / de 1 / features 23 / feature 9) + 1 literal (annotation-table 3) already baselined ' +
    'for the default spec — zero NEW domain signal. That identical vocabulary is ALREADY ratcheted ' +
    'in two scanned places: its SOURCE (the server `#[derive(JsonSchema)]` doc-comments under ' +
    'server/**, walked by both guards) and the shipped client ui/src/api-client-saas/types.ts ' +
    '(scanned by the uiFe root, baselined this same commit). Scanning a second serialized copy of ' +
    'the same generated vocabulary is the category error already recorded for `packages`/`docs`. ' +
    'Out, with the (zero-new) cost on the record.',
  // GENERATED + GITIGNORED (`.gitignore`: src-app/ui/test-results/, src-app/ui/playwright-report/).
  // Playwright's two default output trees. Declared rather than name-skipped for exactly the
  // reason `server/binaries` is: `CENSUS_SKIP_DIRS` is for universally-recognisable build output,
  // and a reader deserves to be told what a repo-specific artefact tree is. Both are absent from a
  // clean checkout and appear the moment anyone runs the e2e suite — which is how the census first
  // fired on a developer machine at the round-5 reconciliation, on a tree that is by construction
  // not source. Measured (this guard's tokenizer, via the self-test scan override): test-results
  // = 1 candidate file (`.last-run.json`), 0 findings in any dialect; playwright-report is HTML +
  // `.zip` traces, which have NO dialect in either tokenizer, so its measured cost is 0 by
  // construction.
  //
  // WS-R6 — THESE FOUR ARE NOW REDUNDANT, AND KEPT ON PURPOSE. The runtime-artefact rule
  // above covers every one of them: measured 2026-07-28 with all four materialised on disk,
  // `git check-ignore` reports IGNORED and `git ls-files` reports 0 TRACKED files for
  // `ui/test-results`, `ui/playwright-report`, `server/binaries` and `server/migrations-merged`
  // alike — so deleting all four declarations would leave the census green. They stay because:
  //   (1) the git rule can say "artefact", it cannot say WHAT the artefact is or what its
  //       MEASURED cost was — and that prose is the whole point of this list; and
  //   (2) they are the fail-CLOSED half of a belt-and-braces pair. The git rule needs `git`;
  //       in a tarball export or a no-`.git` build container it skips nothing, and these four
  //       trees (which exist precisely on machines that have built or tested) would go red for
  //       the same reason `cytoanalyst-data` did.
  // The cost of keeping them is one narrow fail-OPEN: if a file were ever COMMITTED into one of
  // these four, the git rule would correctly stop skipping it but the by-name declaration would
  // keep excluding it. `server/config` below shows the shape that matters — it is tracked (4
  // files) and NOT ignored, so its declaration is load-bearing, not redundant.
  'ui/test-results':
    'GENERATED + gitignored: Playwright per-run output (traces, screenshots, `.last-run.json`). ' +
    'Measured 0 findings. Not source; absent from a clean checkout.',
  'ui/playwright-report':
    'GENERATED + gitignored: the Playwright HTML report. No file in it has a dialect in either ' +
    'tokenizer (HTML + zipped traces), so it carries no coverage to lose. Absent from a clean checkout.',
  // ── src-app/server ──
  // GENERATED + GITIGNORED. Declared rather than name-skipped: `CENSUS_SKIP_DIRS` is for
  // universally-recognisable build output (`node_modules`, `target`), and these two are
  // repo-specific enough that a reader deserves to be told what they are. Neither exists in
  // a clean checkout — `binaries/` is staged by `build.rs`, `migrations-merged/` is composed
  // at build time from the module-local migration sets — so both declarations are ordinarily
  // vacuous and cost nothing.
  'server/binaries': 'GENERATED + gitignored: build-staged binary payloads. Not source; absent from a clean checkout.',
  'server/migrations-merged':
    'GENERATED + gitignored: the build-time composition of the module-local migration sets. ' +
    'The SOURCES are `server/src/modules/**/migrations/*.sql`, which ARE scanned (serverData) ' +
    'and pinned by FORMAT_COVERAGE_PINS — so this tree carries no coverage of its own to lose.',
  'server/config':
    'deployment YAML (dev/e2e configs). Measured 0 findings. Out because it is per-machine ' +
    'operator config, not shipped source; recorded so the zero is on the record rather than assumed.',
}

// ── THE RUNTIME-ARTEFACT RULE (WS-R6) ───────────────────────────────────────
//
// The census as first shipped made "not scanned" a decision for every tree ON DISK,
// which is not the same set as every tree the repo AUTHORS. `cytoanalyst-data/` — the
// app's runtime data directory (embedded-Postgres cluster, `dev/`, `e2e/`, artifacts;
// 922 MB on a used machine) — is created the moment anyone runs the server. It is
// gitignored, carries ZERO tracked files, and appeared in no declaration, so the guard
// was RED on every developer machine that had ever booted the app and GREEN only on a
// fresh clone and in CI. A gate that is red for everyone who actually runs the product
// is a gate people learn to ignore, which would quietly undo the five rounds of work
// this census exists to protect.
//
// `UNSCANNED_TREES` already carried four "GENERATED + gitignored" entries, each added
// the first time somebody tripped over it. Adding a fifth by name is unbounded
// whack-a-mole: the next stray runtime tree on the next machine fires again. So the
// rule is derived from GIT, which is the only authority on what this repo authors:
//
//     a census candidate is SKIPPED iff  git says it is IGNORED
//                                  AND  git says it holds ZERO TRACKED FILES.
//
// WHY BOTH CONDITIONS — they are not redundant.
//   * IGNORED alone is not enough. A file committed BEFORE its ignore rule landed stays
//     tracked, and `git add -f` puts tracked content under an ignored path deliberately.
//     Such a tree ships source and genuinely could carry a leak, so it must still be
//     declared. MEASURED 2026-07-28: `git ls-files | git check-ignore --no-index --stdin`
//     returns ZERO paths in this repo today — so this condition is currently vacuous,
//     which is precisely why it is asserted rather than assumed. The day it stops being
//     vacuous is the day an ignore-only rule would start hiding source.
//   * ZERO-TRACKED alone is not enough either. An untracked-but-NOT-ignored tree is
//     the ordinary shape of a brand-new, not-yet-`git add`ed feature directory — the
//     exact thing the census must catch on its way in, before it is committed.
//   Git's own `check-ignore` happens to already refuse to report a directory that
//   contains tracked content (it consults the index), so the second condition is
//   usually redundant IN PRACTICE. It is asserted explicitly anyway: that behaviour is
//   an implementation detail of one git subcommand, `--no-index` flips it, and this
//   guard's whole posture is that a structural property should be checked, not
//   inherited from something's incidental behaviour.
//
// FAIL-CLOSED. If `git` is missing, or the tree is not a repository, or either call
// errors, NOTHING is skipped and the census behaves exactly as it did before. A guard
// that goes quiet when its authority is unavailable is the failure mode this whole file
// is written against.
//
// BATCHED. The census runs on every guard invocation, so this is exactly TWO git
// processes for the WHOLE census (one `check-ignore --stdin`, one `ls-files` limited to
// the ignored subset), not one per directory — the candidate list is collected first and
// asked about once. MEASURED 2026-07-28 on this tree: the git pair is 9.2 ms (mean of 10),
// the whole census 15.0 ms, a whole guard run 1.59 s. The authority costs 0.6% of a run,
// and its cost does not grow with the number of trees on disk.

/**
 * Run `git` in the repo root, returning `null` on any failure the caller should treat
 * as "git has no answer" (fail-closed).
 *
 * `git check-ignore` exits **1** to mean "none of the given paths are ignored", which is
 * a legitimate empty answer and not an error; every other non-zero status is.
 * @param {string[]} args
 * @param {string|undefined} input
 * @param {boolean} oneIsEmpty treat exit status 1 as an empty (successful) result
 * @param {string} cwd
 * @returns {string|null}
 */
function gitOut(args, input, oneIsEmpty, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (e) {
    if (oneIsEmpty && e && e.status === 1) return typeof e.stdout === 'string' ? e.stdout : ''
    return null
  }
}

/**
 * The subset of `rels` that git says is IGNORED **and** holds ZERO TRACKED FILES —
 * i.e. runtime/build artefacts this repo does not author. Two git processes total.
 * @param {string[]} rels repo-root-relative, `/`-separated directory paths
 * @param {string} [cwd] the repository to ask (defaults to this repo; the self-test
 *   points it at a scratch repo so the two conditions can be exercised for real
 *   without mutating this one's index)
 * @returns {Set<string>}
 */
export function gitRuntimeArtefactTrees(rels, cwd = REPO_ROOT) {
  if (rels.length === 0) return new Set()
  // `-z` on both sides: NUL-delimited in AND out, so a path containing a newline
  // cannot smuggle an extra entry into either answer.
  const ignoredRaw = gitOut(['check-ignore', '-z', '--stdin'], rels.join('\0') + '\0', true, cwd)
  if (ignoredRaw === null) return new Set() // fail CLOSED
  const ignored = ignoredRaw.split('\0').filter(Boolean)
  if (ignored.length === 0) return new Set()
  // Pathspec-limited to the ignored subset only. `ls-files` lists INDEX entries, so
  // ignore status does not filter it — which is precisely what makes it the independent
  // second condition rather than a restatement of the first.
  const trackedRaw = gitOut(['ls-files', '-z', '--', ...ignored], undefined, false, cwd)
  if (trackedRaw === null) return new Set() // fail CLOSED
  const tracked = trackedRaw.split('\0').filter(Boolean)
  return new Set(ignored.filter(rel => !tracked.some(f => f === rel || f.startsWith(rel + '/'))))
}

/**
 * @param {{path:string}[]} set the resolved scan set
 * @returns {string[]} one message per tree that is neither reached nor declared.
 */
export function treeDeclarationViolations(set) {
  const scanned = set.map(e => e.path)
  /** @type {string[]} */
  const candidates = []
  const seen = new Set()
  for (const level of TREE_CENSUS_LEVELS) {
    if (!existsSync(level)) continue
    for (const e of readdirSync(level, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.') || CENSUS_SKIP_DIRS.has(e.name)) continue
      const abs = path.join(level, e.name)
      const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/')
      if (seen.has(rel)) continue
      seen.add(rel)
      // `packages/` has its own dedicated SCANNED/UNSCANNED pair + message.
      if (abs === PACKAGES) continue
      const prefix = abs + path.sep
      if (scanned.some(f => f.startsWith(prefix))) continue
      const key = rel.startsWith('src-app/') ? rel.slice('src-app/'.length) : rel
      if (UNSCANNED_TREES[key] || UNSCANNED_TREES[rel]) continue
      candidates.push(rel)
    }
  }
  // Batched, once, over everything the census would otherwise name.
  const artefacts = gitRuntimeArtefactTrees(candidates)
  return candidates
    .filter(rel => !artefacts.has(rel))
    .map(
      rel =>
        `"${rel}" is in NO scan root and in NO declared exclusion. Every tree is guarded by ` +
        `default; leaving one out is a DECISION that has to be written down — with its MEASURED ` +
        `cost — in UNSCANNED_TREES. (Three trees hid here before WS-R5 G3: src-app/testdata, ` +
        `repo-root scripts/ and ui/scripts, 4313 findings between them, declared nowhere.) ` +
        `A tree that is GITIGNORED **and** holds zero tracked files is a runtime/build ` +
        `artefact and is skipped automatically (WS-R6) — this one is not.`,
    )
}

/**
 * WS-C — every directory under `packages/` is either SCANNED or DOCUMENTED as
 * unscanned. A package that is neither fails the guard, so the viz carve-out
 * cannot quietly acquire company.
 * @returns {string[]} one message per undeclared package.
 */
export function packageDeclarationViolations() {
  if (!existsSync(PACKAGES)) return []
  const out = []
  for (const e of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue
    if (SCANNED_PACKAGES.includes(e.name)) continue
    if (UNSCANNED_PACKAGES[e.name]) continue
    out.push(
      `packages/${e.name} is neither in SCANNED_PACKAGES nor in UNSCANNED_PACKAGES. ` +
        `Every package is guarded by default; leaving one out is a DECISION that has to be ` +
        `written down (with its measured cost) in UNSCANNED_PACKAGES.`,
    )
  }
  return out
}

/**
 * ITEM-37 — the fail-CLOSED check. @returns {string[]} one message per root whose
 * resolved file count fell below its committed floor (empty = every root is intact).
 */
export function floorViolations(counts) {
  const out = []
  for (const [root, floor] of Object.entries(SCAN_FLOORS)) {
    const got = counts[root] ?? 0
    if (got < floor) {
      out.push(
        `scan-set root "${root}" resolved to ${got} file(s), below the committed floor of ${floor}. ` +
          `A hard-coded path no longer exists (moved/renamed), so this guard was about to PASS ` +
          `having scanned almost nothing. Re-point the path, or lower SCAN_FLOORS.${root} deliberately.`,
      )
    }
  }
  return out
}

/**
 * WS-R5 §1 — the AGGREGATE scan-volume check. Deliberately NOT part of `SCAN_FLOORS`.
 *
 * `SCAN_FLOORS` is per ROOT and is computed from `defaultScanSet()`, so it is skipped
 * wholesale the moment a scan set is supplied from outside — which is precisely how
 * `LINT_NO_DOMAIN_SCAN_OVERRIDE='[]'` printed ✓ over zero files. This check reads the
 * number of files the run ACTUALLY OPENED, so no override can route around it:
 *
 *   * `scanned === 0` fails in EVERY mode, including under the self-test opt-in. A
 *     fixture-driven self-test always writes at least one file, so this costs the suite
 *     nothing and closes the bypass for a caller who holds the opt-in.
 *   * a run with no scan override is additionally held to `SCANNED_TOTAL_FLOOR`. Measured
 *     1111 on 2026-07-28; the floor is ≈2/3 of that, the same collapse-detector margin
 *     every other floor in this file uses, so an ordinary deletion pass never trips it.
 *     ROUND-5 RECONCILIATION RE-MEASURED **1112** (+1, r5card's new cross-side test);
 *     floor 740 -> 741. Anchored to the CLEAN-CHECKOUT count on the same basis as
 *     `SCAN_FLOORS.feData`: a worktree that has run `cargo build` also carries four
 *     tauri-CODEGEN'd, gitignored `desktop/tauri/gen/schemas/*.json`, so the walk
 *     reports 1116 there and 1112 in a clean checkout. Anchoring to 1116 would set a
 *     floor a clean CI checkout satisfies only by accident.
 *
 * @param {number} scanned files actually opened and scanned
 * @param {boolean} overridden whether the scan set came from the test-only override
 * @returns {string[]}
 */
export function scanVolumeViolations(scanned, overridden) {
  const out = []
  if (scanned === 0) {
    out.push(
      `the guard scanned ZERO files. A run that opened nothing certifies nothing; printing ✓ ` +
        `here is the exact "scoped just narrowly enough to miss what it forbids" failure this ` +
        `guard exists to stop. This is a hard error in EVERY mode — including under ` +
        `${SELFTEST_ENV_NAME}=1 — so it cannot be reached by supplying an empty scan set.`,
    )
    return out
  }
  if (!overridden && scanned < SCANNED_TOTAL_FLOOR) {
    out.push(
      `the guard scanned ${scanned} file(s) in total, below the committed aggregate floor of ` +
        `${SCANNED_TOTAL_FLOOR}. The per-root floors can each be satisfied while the walk as a ` +
        `whole has collapsed; this is the total. If the shrink is real, lower ` +
        `SCANNED_TOTAL_FLOOR deliberately.`,
    )
  }
  return out
}

/** ≈2/3 of the 1111 files measured on 2026-07-28. See `scanVolumeViolations`. */
const SCANNED_TOTAL_FLOOR = 741

// ── Scan one file ───────────────────────────────────────────────────────────

function lineColOf(text, index) {
  let line = 1
  let last = -1
  for (let i = 0; i < index; i++) {
    if (text[i] === '\n') {
      line++
      last = i
    }
  }
  return { line, col: index - last }
}

function scanFile(file, lang, nouns, srcOverride) {
  const src = srcOverride ?? readFileSync(file, 'utf8')
  let { scan, skeleton, prose } = deriveTexts(src, lang)
  if (lang === 'rust') {
    scan = stripCfgBlocks(scan, skeleton)
    // The same `#[cfg(test)]` blocks come out of the PROSE projection too: a comment
    // inside a test module is as non-shipping as the code it documents.
    // `#[cfg(debug_assertions)]` is NOT stripped from either projection any more —
    // see `stripCfgBlocks`.
    prose = stripCfgBlocks(prose, skeleton)
  }

  const findings = []
  const record = (index, token, kind) => {
    const { line, col } = lineColOf(src, index)
    findings.push({ file, line, col, token, kind })
  }

  // substring tokens (single-cell / report/qc / sequence/fastq)
  for (const tok of SUBSTRING_TOKENS) {
    let from = 0
    let idx
    while ((idx = scan.indexOf(tok, from)) !== -1) {
      record(idx, tok, 'substring')
      from = idx + tok.length
    }
  }
  // quoted bare-word ids
  let m
  QUOTED_ID_RE.lastIndex = 0
  while ((m = QUOTED_ID_RE.exec(scan)) !== null) record(m.index, m[1], 'quoted-id')
  // quoted titles
  QUOTED_TITLE_RE.lastIndex = 0
  while ((m = QUOTED_TITLE_RE.exec(scan)) !== null) record(m.index, m[1], 'quoted-title')

  // Domain NOUNS — TWO tiers, both now scanned on the WHOLE surface (Rust module
  // tree included; WS-B blind spot #2).
  //   `domain-noun`  — in code + string literals. An executable commitment.
  //   `domain-prose` — in comments only. Lower severity, separate baseline: it is
  //                    EVIDENCE of purpose, not a dispatch. DOMAIN_AUDIT §0's
  //                    exemplar (`StandardResultTable`, wholly a single-cell
  //                    deliverable) was legible ONLY from its doc header.
  // WS-R9 — is this a cargo-feature-gated Rust module? (`#[cfg(feature = "…")]`,
  // incl. `not(feature=…)` / `all(feature=…)`.) Its prose "the feature" is the cargo
  // feature, not a genomic one; drives the P2 signal in `isCargoFeatureSense`.
  const fileHasCfgFeatureAttr =
    lang === 'rust' && /#\s*\[\s*cfg\b[^\]]*\bfeature\s*=/.test(src)

  if (nouns) {
    matchNouns(scan, (i, tok) => record(i, tok, 'domain-noun'), lang, fileHasCfgFeatureAttr)
    matchNouns(prose, (i, tok) => record(i, tok, 'domain-prose'), lang, fileHasCfgFeatureAttr)
    // WS-C acronym tier — same two severities, same baseline tiers.
    matchAcronyms(scan, (i, tok) => record(i, tok, 'domain-noun'))
    matchAcronyms(prose, (i, tok) => record(i, tok, 'domain-prose'))
  }

  // WS-R7 PACKAGE tier — the second axis (see `contributedPackageIds`). Same two
  // severities and the SAME baseline sections as the noun tiers (`code`/`prose` +
  // their `test*` twins), because the disposition vocabulary and the ratchet are
  // identical: a package id in executable code is a commitment, one in a comment is
  // evidence of purpose.
  //
  // It gets its OWN KINDS rather than reusing `domain-noun`/`domain-prose`, and that
  // is load-bearing in one specific way: `OBSERVATION_FLOORS.domainNoun` and its
  // three siblings are COLLAPSE DETECTORS measured on the LATTICE vocabulary. Folding
  // a second vocabulary into the same total silently re-bases all four — a collapse of
  // the lattice walk could then be masked by package hits, which is verbatim the
  // "disappears into the total" failure `MUST_SCAN_KEYS` was invented for. Separate
  // kinds keep every existing measurement meaning exactly what it meant.
  matchPackageIds(scan, (i, tok) => record(i, tok, 'package-id'))
  matchPackageIds(prose, (i, tok) => record(i, tok, 'package-prose'))

  // WS-R8 ID-STEM tier — a lattice id used as a SEGMENT (`clustering_ref`,
  // `selection.clustering`). CODE ONLY, by the argument at `ID_STEM_TOKENS`: a comment
  // naming a demo type is not a commitment, and funding those dispositions is how a
  // guard gets muted. The test-tier split still applies downstream, so a fixture is
  // ratcheted in the test sections like every other finding.
  matchIdStems(scan, (i, tok) => record(i, tok, 'id-stem'))

  return findings
}

// ── Main ────────────────────────────────────────────────────────────────────

/**
 * Is `file` in the noun scope? WS-B blind spot #2: the answer used to be "only
 * under `ui/src/modules/workbench/`" — the guard's own source said *"It is NOT
 * applied to the Rust module tree"*, which made `gene`, `cell`, `barcode`, `obs`,
 * `adata`, `soma` and `cellranger` invisible across all ~160 production `.rs`
 * files, i.e. across ALL ELEVEN of the audit's server findings (S1-S11). The
 * answer is now "everything in the scan set". The DEC-M wire fields that
 * motivated the carve-out are BASELINED (with the DEC-M rationale attached to
 * each entry) rather than unscanned — which is the difference between a decision
 * that is recorded and one that is invisible.
 *
 * Under an explicit scan OVERRIDE (tests) the temp fixtures live outside the real
 * roots, so the entry's own `nouns` flag still decides.
 */
function inNounScope(_file, entry) {
  if (typeof entry.nouns === 'boolean') return entry.nouns
  return true
}

/** relative-to-`src-app` key used by the baseline (posix separators). */
export function baselineKey(file) {
  return path.relative(SRC_APP, file).split(path.sep).join('/')
}

// ── The committed BASELINE (a shrink-only ratchet) ──────────────────────────
//
// The widened vocabulary above goes red on contact: the 2026-07-28 audit found 25
// HIGH leaks that are IN THE TREE TODAY, and narrowing the guard until it is green
// is the exact failure this whole round exists to stop. So today's violations are
// recorded, per file per token, in `domain-baseline.json`, and every `code` entry
// carries the DOMAIN_AUDIT finding id (E1-E6, C1-C8, S1-S11, B1-B3) — or an
// explicit non-finding tag (`DEC-J`, `DEC-M`, `FALSE-POSITIVE`, `GENERIC`) — so
// the file reads as a WORKLIST rather than as amnesia.
//
// RATCHET semantics, identical in spirit to the INV-3 / INV-8 ratchets:
//   observed >  baseline → the excess is REPORTED (a new leak fails the gate)
//   observed <  baseline → STALE: the entry must be shrunk in the same commit
//                          (`node scripts/lint-no-domain-in-builtin.mjs
//                            --prune-baseline` does it mechanically)
//   observed >  0, no entry → every occurrence is reported
// So the residue can only shrink, and only deliberately.
//
// ── HOUSE STYLE THAT FALLS OUT OF THIS: shared test helpers stay TOKEN-FREE ──
//
// The ratchet is shrink-only PER FILE, and a file with no entry has a budget of ZERO. That
// is not a quirk to be worked around; it is the rule doing its job, and it decides how test
// code is factored — so it is written here, beside the mechanism, rather than living in one
// commit message where the next person will not find it.
//
//   A NEW shared helper cannot carry a domain token AT ALL. Not "one", not "the same number
//   the spec had": a file the baseline does not list is at 0, so the first occurrence is a
//   new leak and the gate goes red. `--prune-baseline` cannot help — it only ever LOWERS or
//   REMOVES entries, never adds one; a new entry has to be argued for by hand, and "I moved
//   some code" is not an argument for widening a domain ledger.
//
//   SO: a helper takes the token as a PARAMETER and the caller supplies it. Anything that
//   addresses the DOM by a domain-flavoured attribute or test-id prefix (`viz-cell-*` and
//   friends — `cell` is a token) stays in the SPEC, which already carries that residue and
//   whose count therefore does not move. The helper receives the selector, the attribute
//   name, or the prefix, and stays generic. `tests/viz-e2e/_helpers.ts` is the worked
//   example: zero `viz-cell` occurrences in the helper, every one of them in the specs that
//   pass them in.
//
//   WHY NOT EXEMPT TEST DIRECTORIES INSTEAD. Because the test trees were invisible to this
//   guard until WS-R4 and that invisibility was itself the finding (≈1258 + ≈449 unlooked-at
//   hits). An exemption re-creates it, and it would apply to exactly the code most likely to
//   spread a spelling: a helper is imported by many specs, so one token in it is a token in
//   all of them. The constraint is mildly annoying and it produces the better factoring,
//   which is the argument for keeping it.
//
//   COST, stated so it is chosen and not discovered: this makes some helpers take an
//   argument they would not otherwise need. That is the price of the residue only ever
//   shrinking, and it is cheaper than the alternative of a ledger that grows whenever code
//   is rearranged.
// Test-only override (used by the test file to point the ratchet at a temp
// baseline and prove BOTH directions fire — never set in normal use):
//   LINT_NO_DOMAIN_BASELINE_OVERRIDE — absolute path to a baseline JSON.
// WS-R5 §1 — gated by `OVERRIDES_ADMITTED`. Un-gated this was the quietest of the
// three bypasses: hand-craft a ledger whose counts EQUAL the observation and every
// code/prose finding is absorbed with no floor tripped, no constant edited and the
// committed baseline never read. `--prune-baseline` would then also WRITE to the
// substituted path, which is why the override has to be ignored and not merely
// reported.
const BASELINE_PATH =
  overrideEnv('LINT_NO_DOMAIN_BASELINE_OVERRIDE') ?? path.join(__dirname, 'domain-baseline.json')

export function loadBaseline() {
  const empty = {
    code: {},
    prose: {},
    literals: {},
    testCode: {},
    testProse: {},
    testLiterals: {},
  }
  if (!existsSync(BASELINE_PATH)) return empty
  const raw = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
  return {
    code: raw.code ?? {},
    prose: raw.prose ?? {},
    literals: raw.literals ?? {},
    // WS-R4 — the TEST tier's own namespace (see the split in `runGuard`).
    testCode: raw.testCode ?? {},
    testProse: raw.testProse ?? {},
    testLiterals: raw.testLiterals ?? {},
    meta: raw,
  }
}

/**
 * WS-C — the `literals` tier CEILING.
 *
 * `substring` / `quoted-id` / `quoted-title` are the HARD INV-3 kinds: a
 * PRODUCTION domain datatype-id literal. Until WS-C the guard had no baseline
 * for them at all, i.e. the tolerance was exactly zero — which is the right
 * target and was only survivable because half the tree was unscanned. Widening
 * the scan set surfaced THREE real ones (`--help` copy in `main.rs`; the
 * `env-rootfs/single-cell/` Dockerfile path, twice, in `build_helper`).
 *
 * They are recorded rather than fixed here (this workstream owns the guard and
 * the ledger, not `server/**` production code) — but recorded under a CEILING,
 * not a ratchet with room: the number of literal HITS may only go DOWN. Adding
 * one requires editing this constant upward in the same commit, which is a
 * reviewable admission that a datatype id was hardcoded on purpose.
 *
 * ROUND-2 RECONCILIATION — LOWERED 3 → 0, and the tier was EMPTY. WS-E removed the
 * `main.rs` `--help` domain clause (1 literal) and WS-I turned the two
 * `env-rootfs/single-cell/` build paths into build INPUTS (2 literals).
 *
 * ── WS-R3: RAISED 0 → 69, and this is the loudest single result of the round ──
 *
 * "Zero hardcoded domain datatype ids anywhere in the scan set" was never true. It
 * was an artifact of the three things the guard refused to look at, and un-refusing
 * them surfaced **69 literal hits in 8 files** — every one present in the tree the
 * whole time, none added by this round:
 *   * `workstore/data_api.rs` 23  — inside `#[cfg(debug_assertions)]` (§1):
 *     `single-cell` ×11, `report/qc` ×5, `metadata-column` ×3, `embedding` ×2,
 *     `clustering` ×2. `:669` `"single-cell/expression"` / `:688` `"report/qc"` /
 *     `:708` `"metadata-column"` are executable dispatch, not copy.
 *   * `ui/src/modules/datasets/gallery.tsx` 13, `modules/workbench/gallery.tsx` 6,
 *     `dev/gallery/fixtures/cassette.ts` 8, `dataset/project-extension/gallery.tsx`
 *     3, `modules/processors/gallery.tsx` 1 — the removed BASENAME exemption (§4).
 *   * `ui/openapi/openapi.json` 12 — the SHIPPED API CONTRACT (§2): `single-cell`
 *     ×7 plus three parameter descriptions reading "The target datatype (e.g.
 *     `de`)". Generated, so nobody types it and nobody reviews it.
 *   * `server/src/modules/workstore/seed_anndata_import.py` 3 — an
 *     `include_str!`-embedded, executed driver (§2).
 * Raising the constant is exactly the "explicit, reviewable admission" this tier was
 * designed to force — here it admits a MEASUREMENT, not a new hardcoding. The tier
 * stays shrink-only from 69: the fixes belong to sibling rounds, each lowering this
 * number in the same commit.
 *
 * ROUND-3 RECONCILIATION RE-MEASURED **69** — UNCHANGED. WS-R3 set this against its own
 * pre-sibling tree, so it was the ceiling most at risk of being stale; it is not. None of
 * the six sibling workstreams touched a quoted datatype id: r3canvas/r3fedead/r3crit moved
 * NOUNS (`obs`, `cell`) which are a different tier, r3methods/r3docs/r3persona rewrote
 * prose. The Rust twin's server-side ceiling is likewise re-measured UNCHANGED at 26.
 *
 * ── ROUND-4 RECONCILIATION: LOWERED 69 -> 34, the biggest single drop this tier has
 * had, and the first one where the number moved because the LITERALS WENT AWAY rather
 * than because the guard started looking. Every one of the 35 is attributed:
 *   r4dataapi  23  `workstore/data_api.rs` -> **0**. The six subject-specific
 *                  `_debug/seed-*` routes were replaced by one generic engine that
 *                  frames bytes and reads ids off the driver's own manifest, so
 *                  `single-cell` x11 / `report/qc` x5 / `metadata-column` x3 /
 *                  `embedding` x2 / `clustering` x2 are simply not written down any
 *                  more. `:669` / `:688` / `:708` — the executable DISPATCH lines
 *                  WS-R3 called out by number — are gone with them.
 *   r4spec     12  `ui/openapi/openapi.json` -> **0**. Fixed at the Rust source (25
 *                  doc-comments) and regenerated, so the SHIPPED CONTRACT no longer
 *                  spells a domain datatype id anywhere.
 * What SURVIVES at 34: the five `gallery.tsx`/`cassette.ts` dev-fixture files (31) and
 * `seed_anndata_import.py` (3). Both were already recorded; neither moved this round.
 * NOTE the accompanying rise in `TEST_LITERAL_HITS_CEILING` (543 -> 548): 9 of the 23
 * r4dataapi removed were RELOCATED into the e2e fixture module rather than deleted.
 * Net across both tiers is 612 -> 582, and the 35 that left THIS tier are the ones
 * that count — they are the ones the app used to ship.
 *
 * ── WS-R5 (2026-07-28): 34 -> 36. AN ADMISSION, and a re-measurement. ───────────────
 * The mechanism worked exactly as designed here, so it is worth stating plainly: G2
 * replaced the HAND-LISTED datatype vocabulary with one DERIVED from the processor
 * manifests, that widening surfaced literals nobody could see, and the ceiling REFUSED to
 * absorb them until this constant was edited. Two movements, netting +2:
 *   -1  `ui/src/dev/gallery/fixtures/cassette.ts` `'Differential expression'` -> 0. Not a
 *       fix: the TITLE was for `de`, an id that had been PRUNED from the lattice and was
 *       still in the hand-list. The guard had been spending a token on a type that does
 *       not ship.
 *   +3  `ui/openapi/openapi.json` `annotation-table` (R5-G2-SPEC). The SHIPPED CONTRACT
 *       spells a contributed datatype id in three `description` strings — a REGRESSION
 *       against r4spec's "-> 0", except it never was 0: `annotation-table` is contributed
 *       by `anndata-import`, one of the two packages the 16-id hand-list never mentioned.
 *       Recorded, not waived; the fix is at the Rust doc-comments + a regen.
 * Read that as the honest scoreboard: r4spec took the twelve literals it could SEE to
 * zero, and three it could not see were there the whole time.
 */
const LITERAL_HITS_CEILING = 36

/**
 * WS-B — the POSITIVE EXPECTED COUNT. `floorViolations` already fails a collapsed
 * FILE set; this fails a collapsed MATCH set. Six guards this round were scoped
 * just narrowly enough to miss what they forbid and four reported PASS having
 * scanned zero files, so "no violations found" is never accepted as evidence on
 * its own: the widened vocabulary is KNOWN to match a large, measured residue, and
 * if it stops doing so the vocabulary/boundary/tokenizer has broken and the guard
 * is lying. Both numbers are floors (deliberate shrinkage lowers them by hand).
 */
const OBSERVATION_FLOORS = {
  /**
   * `domain-noun` hits (code + string literals) across the WHOLE scan set.
   * Measured at 807 on 2026-07-28. The floor is deliberately set WELL BELOW the
   * measurement: it is a COLLAPSE detector, not a second ratchet. Fixing leaks
   * (which is the point) legitimately lowers the observation; the per-entry
   * baseline ratchet is what makes each of those a deliberate edit. A drop to
   * ~half means the vocabulary, the boundary or the tokenizer broke.
   *
   * RE-MEASURED at 549 on 2026-07-28 after the five-workstream merge + this
   * reconciliation (the floor is UNCHANGED — 549 still clears it). Headroom is now
   * thin by design: the next real fix pass that drops below 500 lowers this floor
   * deliberately, in the same commit, with the new measurement recorded here.
   *
   * WS-C RE-MEASURED at 596 (scan set 353 → 633 files, vocabulary 24 → 34 nouns +
   * 3 acronyms, minus the ALL-CAPS `GENERIC`/`OBSERVED`/`SOMATIC` identifier
   * suppressions). Floor UNCHANGED at 500 — deliberately, because it is a
   * COLLAPSE detector and the whole point of WS-C is that fixes should be able to
   * drive this number down.
   *
   * ROUND-2 RE-MEASURED at 463 — and this is the case the paragraph above predicted:
   * the eleven round-2 workstreams drove the number below the floor, so the floor is
   * LOWERED 500 → 300 (≈2/3 of the new measurement) rather than the measurement being
   * argued up. 572 → 463 is 109 hits, and every one is attributed to a merged
   * workstream by the `--prune-baseline` diff in this same commit:
   *   WS-A  24  C3, `workbench/core/columns/{errors,fixtureCtx,ref,resolve}.ts`
   *   WS-J  14  S2, `workstore/{serve_core,ingest}.rs`
   *   WS-C  13  E1, `AnalysisRunPanel.tsx` + `workbenchDataSource.ts`
   *   WS-B  11  C1/W9, `core/runtime/primitives.ts` + `core/form/defaults.ts`
   *   WS-G  11  S9, `tiledb_serve/{array_source/{mod,tiledb},mod}.rs`
   *   WS-FT 11  its own `CellSet` → `RowSet` in `workstore/axes.rs`
   *   WS-D   8  C5, `canvas/vizState.store.ts`
   *   WS-H   8  DEC-M/W7, `project/{models,repository}.rs` + the `types.ts` regen
   *   WS-E   5  W1/W8, `main.rs` + `datatype/builtin.rs` + `workstore/routes.rs`
   *   WS-I   4  S8/W2, `rootfs/version.rs` + `build_helper/sandbox_rootfs.rs`
   * (WS-P contributes 0 here by construction — it rewrote PROSE, which the tier below
   * measures.) The scan set is UNCHANGED at 633 files, which is what says this is a
   * cleaner tree and not a collapsed walk.
   *
   * WS-R3 RE-MEASURED at **1197** (463 → 1197, +734) on a scan set of 702 files
   * (633 → 702). The increase is entirely the four holes this round closed, and it
   * is attributed per (file, token) by the `finding` tags in `domain-baseline.json`:
   *   R3-EXT     264  the four data formats — `.sql` migrations, the two
   *                   `include_str!`-embedded `seed_*.py` drivers (51 + 47),
   *                   `openapi.json` (108), `mcp/testdata/*.json` (21)
   *   R3-DEBUG   245  un-blanking `#[cfg(debug_assertions)]` (`data_api.rs` 243,
   *                   `workstore/routes.rs` 2)
   *   R3-GALLERY 199  the removed `gallery.tsx` / `cassette.ts` basename exemption
   *   R3-TOKEN    26  `PBMC` / `nCount` / `pct_ribo` / `ident` / `10x`
   * RAISED 300 → 800 (≈⅔ of 1197), which is what keeps it a COLLAPSE detector at the
   * new measurement. A sibling round that fixes leaks legitimately drives this down
   * and lowers the floor deliberately in the same commit — the designed motion, not
   * a failure.
   *
   * ROUND-3 RECONCILIATION RE-MEASURED **1118** (1197 → 1118, −79) — the designed motion
   * the paragraph above predicts, on the scan set the widening established. WS-R3 set 800
   * against ITS tree (built on `c3313502`, i.e. BEFORE the six sibling workstreams landed);
   * 800/1118 = 71.5% is a tripwire, not a ⅔ collapse detector, so it is LOWERED 800 → 745
   * (⅔ of 1118). Every one of the 79 is attributed to a merged workstream by the
   * `--prune-baseline` diff in this same commit — an UNACCOUNTED drop is the exact
   * signature this floor exists to catch:
   *   r3canvas 45  `canvas/viz.tsx` −27, `core/runtime/store.ts` −7, `canvasBinding.ts` −6,
   *                `canvasFeed.ts` −3, `core/gallery/fixtureSpecs.ts` −2 (the literal
   *                `'obs'` de-privileged behind `WIDGET_DATASET_ID` / `widgetFrame`)
   *   r3crit   18  `provenance/criteria_script.rs` −7, `core/criteria/criteria.ts` −8,
   *                `core/runtime/primitives.ts` −3 (`_CELL_WS`→`VALUE_WS`, `parseCell`→
   *                `parseValue`)
   *   r3methods 10 `provenance/export/methods.rs` — the whole code entry
   *                (`sample` 5 / `ident` 3 / `samples` 2) removed with the alias probe
   *   r3fedead  6  `core/runtime/viewData.ts` — `extractObsSlice`/`ObsArtifactPayload` deleted
   * (r3docs and r3persona contribute 0 here by construction — they rewrote PROSE.)
   *
   * ROUND-4 RECONCILIATION RE-MEASURED **726** (1118 -> 726, -392) — the floor of 745
   * FIRED, which is the designed motion: a drop of this size must be accounted for
   * before it is absorbed. It is, entirely, by the `--prune-baseline` diff in this same
   * commit (per FILE, `code` tier):
   *   r4dataapi 257  `workstore/data_api.rs` 261 -> 6, `workstore/routes.rs` 2 -> 0
   *   r4spec     94  `ui/openapi/openapi.json` 107 -> 13 (fixed at the Rust source +
   *                  regenerated; the shipped contract stopped naming the domain)
   *   r4squash   37  the 5 module-local migrations that carried domain column comments,
   *                  collapsed into the 8 baselines: `workstore_axes` 22,
   *                  `workstore_open_axes` 10, `dataset_*` 5
   * 4 residual hits sit in files whose baseline entry was LOWERED rather than removed.
   * LOWERED 745 -> 484 (⅔ of 726) to put the collapse-detector margin back.
   *
   * ROUND-5 RECONCILIATION RE-MEASURED **726** — UNCHANGED, to the hit. All three
   * round-5 workstreams landed in the TEST tier and in this guard's own tooling, so the
   * PRODUCTION observation is byte-identical to round 4's. Floor unchanged at 484. An
   * unmoved production number across a merge is evidence, not an omission: it is what
   * says the round did not quietly re-scope the production walk.
   */
  domainNoun: 484,
  /**
   * `domain-prose` hits (comments only). Measured at 1183 on 2026-07-28;
   * re-measured at 1085 after the merge + this reconciliation (floor unchanged).
   * WS-C RE-MEASURED at 1399 after the widening (floor unchanged).
   * ROUND-2 RE-MEASURED at 1268 (WS-P's arrowClient/datasets prose rewrite is the
   * largest single contributor at 30, WS-J's `serve_core.rs` next at 17). Floor
   * UNCHANGED at 700 — still well below the ≈2/3 line (845), so it remains a
   * collapse detector with room for the next honest prose sweep.
   * WS-R3 RE-MEASURED at **1553** (1268 → 1553): the `#[cfg(debug_assertions)]`
   * prose that came back with §1 (`data_api.rs` +81, `workstore/routes.rs` +7), the
   * data dialects' comment tiers (`.sql` `--` headers; the Python module DOCSTRINGS
   * — `classifyData` explains why a docstring is classed as prose), and the 10
   * ex-exempt gallery/cassette files. RAISED 700 → 1035 (≈⅔ of 1553).
   *
   * ROUND-3 RECONCILIATION RE-MEASURED **1443** (1553 → 1443, −110). 1035/1443 = 71.7%
   * is a tripwire, so it is LOWERED 1035 → 962 (⅔ of 1443). Attribution — all 110:
   *   r3docs   45  `datatype/types.rs` −5, `workstore/artifact/mod.rs` −4,
   *                `workstore/axes.rs` −10, `core/runtime/primitives.ts` −25,
   *                `canvas/viz.tsx` −1
   *   r3canvas 44  `core/manifest/viewSpec.ts` −10, `canvasBinding.ts` −18,
   *                `core/runtime/store.ts` −6 (entry removed), `canvas/viz.tsx` −9,
   *                `canvasFeed.ts` −1 net (−3 baselined, +2 meta-prose, below)
   *   r3fedead 12  `core/runtime/viewData.ts` 28 → 16
   *   r3crit    9  `core/criteria/criteria.ts` −4, `core/runtime/primitives.ts` −5
   *   r3methods 0  `provenance/export/methods.rs` −1 `cell`, +1 `sample` meta-prose
   * TWO entries ROSE and are argued for BY HAND in `domain-baseline.json` under the
   * `R3-META` tag, because `--prune-baseline` is shrink-only and cannot raise them:
   * `canvasFeed.ts` `obs` 7 → 9 and `methods.rs` `sample` 3 → 4. Both are the FIXING
   * commit's own removal-documenting comment naming the token it deleted — the same
   * class as the E4 doc block in `analysis/paramPreview.ts`, verified by `git blame`
   * to `ff20bf1c` (r3canvas) and `1c9c3361` (r3methods). Not a new leak.
   *
   * ROUND-4 RECONCILIATION RE-MEASURED **1035** (1443 -> 1035, -408). 962/1035 = 93% is
   * a TRIPWIRE, not a ⅔ collapse detector — it stayed technically green only because the
   * drop stopped three hits short of it — so it is LOWERED 962 -> 690 (⅔ of 1035).
   * Attribution, per FILE, from the `--prune-baseline` diff in this same commit:
   *   r4dataapi 180  `workstore/data_api.rs` 185 -> 12, `workstore/routes.rs` 8 -> 1
   *   r4spec    148  `ui/src/api-client/types.ts` 74 -> 11 (regen), `datatype/types.rs`
   *                  58 -> 5, `extensions/types.rs` 18 -> 1, `dataset/models.rs` 4 -> 0,
   *                  `jobs/models.rs` 4 -> 1, + 6 smaller module files
   *   r4squash   78  the `--` header comments of the 20 module-local migrations that
   *                  carried domain prose, collapsed into the 8 baselines
   *   r4embed     1  `sandbox/env_image.rs` `cell` 3 -> 2
   * A prose drop of this size is the one that most deserves suspicion (prose is where a
   * "delete the comment to satisfy the scanner" cheat would show up); it does not apply
   * here — 226 of the 408 are files that were REGENERATED or DELETED, not reworded.
   *
   * ROUND-5 RECONCILIATION RE-MEASURED **1035** — UNCHANGED. Floor unchanged at 690.
   */
  domainProse: 690,
  /**
   * `code` entries in `domain-baseline.json`. Measured at 152 on 2026-07-28 with the
   * floor at 100 (≈2/3 of the measurement).
   *
   * LOWERED to 60 on 2026-07-28 (same day, after the five parallel workstreams landed):
   * the open-axis data-model migration, the domain-guard rebuild, the MCP manifest
   * change and the two domain strips FIXED enough leaks that `--prune-baseline`
   * removed 61 entries outright, taking the honest measurement to 92. That is real
   * progress, not a collapsed scan — the two hit-count floors below (the actual
   * collapse detectors, which a broken vocabulary/boundary/tokenizer would zero)
   * still measure 549 nouns / 1085 prose. The floor keeps the same ≈2/3 margin
   * against the new measurement so it stays a collapse detector, not a second
   * ratchet.
   *
   * ROUND-2 RE-MEASURED at 67 (101 at the branch point): the eleven workstreams fixed
   * 34 (file, token) pairs outright. 67 against a floor of 60 is a TRIPWIRE, not a
   * collapse detector — the next single fix pass would trip it — which is the exact
   * defect that left the Rust twin red from round-1's merge onward. LOWERED 60 → 44 to
   * put the ≈2/3 margin back.
   *
   * WS-R3 RE-MEASURED at **197** code entries in 76 files (67 in 57). RAISED 44 →
   * 131 (≈⅔). Every one of the 130 new entries carries an R3-* finding tag naming
   * WHICH hole surfaced it, so the ledger still reads as a worklist and not as a
   * bulk amnesty.
   *
   * ROUND-3 RECONCILIATION RE-MEASURED **192** code entries in 73 files (197 in 76).
   * LOWERED 131 → 128 (⅔ of 192). The five removed entries are exactly the five files
   * whose code residue went to ZERO: `provenance/export/methods.rs` ×3
   * (`sample`/`ident`/`samples`, r3methods), `core/runtime/primitives.ts` `cell`
   * (r3crit), `core/runtime/viewData.ts` `obs` (r3fedead).
   *
   * ROUND-4 RECONCILIATION RE-MEASURED **147** code entries in 66 files (192 in 73).
   * LOWERED 128 -> 98 (⅔ of 147). The 45 removed entries are the SAME eight files as the
   * `domainNoun` attribution above: `data_api.rs` (18 entries -> 2), `openapi.json`
   * (11 -> 3), `routes.rs` (1 -> 0) and the five squashed migrations (their whole
   * entries, 12). The worklist got shorter because work was DONE, not because it was
   * amnestied — the ledger's own per-entry ratchet is what proves that.
   *
   * ROUND-5 RECONCILIATION RE-MEASURED **147** code entries in 66 files — UNCHANGED.
   * Floor unchanged at 98; `BASELINE_ENTRY_CEILINGS.code` stays 147, at the measurement.
   */
  baselineEntries: 98,
}

// ════════════════════════════════════════════════════════════════════════════
//  WS-R5 §4 — ADDING A BASELINE ENTRY CANNOT BE SILENT
// ════════════════════════════════════════════════════════════════════════════
//
// The ratchet is shrink-only PER ENTRY: an entry may not be raised, `--prune-baseline`
// never adds one, and `finding` is mandatory. What it did NOT have was an aggregate
// bound on the `code` / `prose` / `testCode` / `testProse` tiers — only the two LITERAL
// tiers had real ceilings. So a brand-new production leak could be made green by
// hand-adding ONE entry tagged `GENERIC`: no constant edited, no admission forced, no
// reviewer prompted by anything except a diff hunk in a 10 000-line JSON file.
//
// THE OBJECTION, WEIGHED. A ceiling that fires on every legitimate addition becomes a
// nuisance that gets raised reflexively, and this codebase has already paid for that
// lesson (a FLOOR set just under its own measurement is how the Rust twin went silently
// red). It does not transfer, and the asymmetry is the reason:
//   * a FLOOR fires on a DECREASE, and decreases are the normal outcome of the work — a
//     fix pass trips it, so it needs slack, and slack is where a collapse hides;
//   * a CEILING fires on an INCREASE, and an increase in this ledger is never ordinary
//     work. `--prune-baseline` cannot cause one. A fix cannot cause one. A rename cannot
//     (the key changes, the count does not). Only two things can: admitting a NEW leak,
//     which is exactly what must not be silent, and a deliberate guard-WIDENING round,
//     which edits a dozen constants anyway.
// So these sit AT the measurement, with no headroom, on the same basis the literal
// ceilings already do — and unlike a floor, sitting at the measurement costs nothing,
// because the ledger shrinking never fires them.
//
// WHAT A CEILING STILL DOES NOT DO, stated so nobody over-reads it: it bounds the SIZE
// of the ledger, not the CONTENT. Deleting one entry and adding another is net-zero and
// passes. That hole is closed from the other side by `VALID_FINDING_TAGS` (a new entry
// must name a disposition from a CLOSED set — inventing `R6-WHATEVER` fails) and by
// `rationaleFreshnessViolations` (its note may not cite symbols that no longer exist).
// The three together are what make an addition visible.
// ── artifact-model RECONCILIATION — all four ceilings LOWERED onto the new measurement ──
//
// A ceiling fires on an INCREASE, so lowering it is strictly a TIGHTENING: this is the
// opposite of laundering, and it is the edit this file's own §4 comment demands in the
// same commit as a prune ("these sit AT the measurement, with no headroom").
//
// The prune that moved them is deletion-driven and was audited key by key. Every removed
// key is either (a) in a file artifact-model DELETED — `workstore/{serve_core,artifact/coo}.rs`,
// all five `tiledb_serve/*.rs`, the seven `tests/{tiledb_serve,workstore}/*` suites that
// tested them, `core/workstore/arrowClient{,.test}.ts`, `tests/e2e/datatype/data-source.spec.ts`
// — or (b) in a surviving file whose token count genuinely reached ZERO (verified
// individually: `artifact/mod.rs` cell/feature/gene, `routes.rs` embedding,
// `dataHost.ts` soma, `workbenchDataSource.ts` obs, `datatypes/dataSource.ts` cell/gene,
// and four `feature`/`obs`/`genes`/`anndata` entries in the server test tree). No entry
// was retired on the strength of a file MOVE: the one relocation
// (`COLUMN_ENVELOPE_KEYS = ["obs"]`, serve_core.rs -> ingest.rs) is RE-BASELINED at its
// new home under the same S2 finding rather than pruned, which is why `code` fell by 7
// and not 8.
//
// ── artifact-model ITEM-14 COMPLETION — a SECOND deletion-driven prune ──
//
// Finishing ITEM-14 (dropping the retired `selector_map` / `tiers` keys from the two
// processor manifests, then deleting the `RetiredDeclaration` accept-and-discard seam)
// landed a further prune: 19 entries removed, 11 lowered, 0 added, 0 raised. All four
// ceilings are LOWERED again onto the new measurement — still a tightening, never a
// widening. Attribution of the 19 REMOVALS, audited key by key:
//   * 12 in files this branch DELETED — `datatype/layout.rs` (cell, gene; the
//     `resolve_tier` router ITEM-14 removed), `workstore/axes.rs` (cell, cells, de,
//     gene, genes, obs, sample; ITEM-8's `an axis IS its key artifact`), and
//     `workstore/project_extension/repository.rs` (cells, gene, genes).
//   * 7 in SURVIVING files whose token count genuinely reached zero, each verified by
//     grepping the file rather than inferred: `workstore/ingest.rs` code[obs] (its last
//     `obs` is now the single line-272 COMMENT, which is exactly why prose[obs] LOWERED
//     3 -> 1 instead of being removed) and prose[gene]; `workstore/mod.rs` prose[cell],
//     prose[gene]; `tests/dataset/promote_test.rs` testCode[cells];
//     `tests/datatype/mod.rs` testProse[gene]; `tests/workstore/mod.rs` testProse[obs].
// Per tier the removals are code -1, prose -15, testCode -1, testProse -2 = 19, which is
// exactly the four deltas below. Of the 11 LOWERED entries, 4 are this change's own
// manifest/test edits and 7 are the in-flight workstore/datatype test rewrites; a
// lowering does not move an entry COUNT, so none of them touches a ceiling.

//
// ── artifact-model DRIFT-3 (INV-5 residue triage) — a THIRD deletion/fix-driven prune ──
//
// The round that closed the 42-finding server-side backlog the staleness fix had been
// MASKING. `--prune-baseline` removed 8 entries and lowered 16; 0 raised, 0 added by the
// tool. All four ceilings are LOWERED onto the new measurement — a tightening, as before.
// Audited key by key, and NONE of the 8 removals is a file deletion: every one is a
// surviving file whose token count genuinely reached zero, verified by grepping the file
//   * `workbenchDataSource.test.ts` testCode[leiden]=0, testCode[ncount]=0
//   * `runDiff.test.ts` testProse[cells]=0, testProse[features]=0
//   * `convert_soma_test.rs` testProse[cell]=0, testProse[tiledbsoma]=0, testProse[umap]=0
//     (its ONE surviving `tiledbsoma` is the code-tier constant, admitted by hand)
//   * `mtx_trio_convert_test.rs` testCode[barcode]=0 (its 6 remaining occurrences are all
//     comments, i.e. the prose tier, which LOWERED rather than being removed)
// Per tier: testCode -3, testProse -5 = 8, which is exactly the two deltas below; `code`
// and `prose` lost no ENTRY (prose lowered one count).
// SIX entries were then ADDED BY HAND, all in `testCode`, each with an argued admission
// and a tag from the CLOSED set: 1 `R4-TESTS-RS` (the single named occurrence of a retired
// library, inside the test that asserts its ABSENCE — irreducible by construction) and 5
// `R4-TESTS-E2E` (two NEW read-path specs whose every hit is a field read off the
// pre-existing e2e seed fixture API, not vocabulary the specs introduce). A further 9
// entries were RAISED by hand with the reason appended to each note (5 testCode, 2
// testProse, 1 testLiterals, all in the shared `14-declarative-qc` fixture module and the
// data-source unit suite); a raise moves a COUNT, never an entry count.
// So: `testCode` 782 -> 773 by the prune -> 779 with the six admissions; `testProse`
// 583 -> 578; `prose` 401 -> 399; `code` unchanged at 139.
const BASELINE_ENTRY_CEILINGS = {
  /** (file, token) pairs. Measured 147 on 2026-07-28.
   *  ARTIFACT-MODEL RE-MEASURED **140**: -8 removed by the deletion-driven prune, +1 for
   *  the S2 `ingest.rs` `obs` relocation. LOWERED 147 -> 140, back onto the measurement.
   *  ITEM-14 COMPLETION RE-MEASURED **139**: -1, `ingest.rs` code[obs] went to zero (its
   *  last occurrence is a comment, so it survives in `prose`). LOWERED 140 -> 139.
   *  WS-R7 RE-MEASURED **135**: -4. The manifest/UI-separation round fixed production
   *  prose+code at source rather than recording it (19 files reworded), and the dock's
   *  pane-map binding was renamed off the vocabulary, so the tier SHRANK while a second
   *  vocabulary axis was being added to the guard. LOWERED 139 -> 135.
   *  WS-R8 RE-MEASURED **132**: -3, all from de-leaking the provenance recipe wire rather
   *  than recording it. `action_registry.rs` and `interaction.rs` each lost their `embedding`
   *  code entry when the `embedding_hash` payload key was renamed to what it actually is (an
   *  attestation string pinning a coordinate source), and `ui/openapi/openapi.json` lost the
   *  copy the doc comment shipped into the CONTRACT. LOWERED 135 -> 132.
   *  RUN-SUPERSEDES-ITS-OWN-OUTPUT RE-MEASURED **131**: -1. `ui/openapi/openapi.json` lost its
   *  `qc` entry when the `ListedArtifact` doc comment stopped naming two analyses by name to
   *  say which inputs a picker tells apart — the row gained a field that answers WHO PRODUCED
   *  it, and the sentence describing the endpoint no longer needs an example to be concrete.
   *  Fixed at the SERVER doc comment (`workstore/data_api.rs`, whose own `qc` prose entry went
   *  with it), so the generated contract and the generated `types.ts` shed theirs too — three
   *  entries removed by `--prune-baseline` across the two tiers, none added, none raised.
   *  LOWERED 132 -> 131.
   *  LINK-SPACE-BY-COORDINATE RAISED **132**: +1, and it is an ADMISSION, deliberately made
   *  here rather than absorbed. `canvasHostProvider.ts` gains `cells` (count 1) — the single
   *  read of viz's `GridWorkspace` pane map that the read-only `__canvasPanes` e2e seam needs
   *  in order to report each pane's RESOLVED coordinate-space key (ledger #34: link-zoom is
   *  scoped by that key, and the pane's declared coordinates never reached it). It is the same
   *  confirmed FALSE-POSITIVE class as the `cell` entry already on that file and as the dock's
   *  `cells: Record<string, WorkbenchPane>` (DOMAIN_AUDIT §7): a GRID pane, not a biological
   *  one. It is recorded rather than reworded because `libs/viz` owns the property name and is
   *  byte-unchanged by that ledger row, so there is nothing to rename; the local it binds to is
   *  `gridPanes`. The alternative was to recompute the space key from the DECLARATION in the
   *  seam, which is precisely the mistake #34 is about — a reader asserting on the declaration
   *  watches the half that was already right. RAISED 131 -> 132.
 *  WS-R8 LOWERED 132 -> **131**: `sandbox/probes.rs`'s `feature` code entry (a host CAPABILITY
 *  probe behind `#[cfg(feature = "saas")]`, a SOFTWARE build token) was removed by
 *  `--prune-baseline` once the WS-R8 cargo/cfg-`feature` CONTEXT rule started excluding the
 *  `#[cfg(feature="saas")]` grammar — the recurring form that the compute/accounts epics gate
 *  whole modules with. Recorded here so the drop is deliberate, not a silent collapse. */
  code: 165, /* TXRBENCH STRIP LOWERED 171 -> 165 (-6): the deletion-driven prune removed the entries of the deleted SaaS/auth/account UI modules, the api-client-saas twin, the feature-flags per-account store and the stripped server modules. | #54 (mcp-settings) RAISED 170 -> 171 (+1 ADMISSION, FALSE-POSITIVE): completes the workstore-settings (#54) merge omission — `server/src/modules/workstore/settings_cache.rs` carries `cell` (count 4), the Rust interior-mutability `fn cell()` accessor idiom, IDENTICAL to the already-baselined `sandbox/`+`provenance/settings_cache.rs` twins; that merge added neither the baseline entry nor this ceiling bump, leaving main red on this lint. The NEW mcp file `mcp/settings_cache.rs` deliberately renamed its accessor `cell`->`slot`, so this feature itself adds ZERO code-tier domain tokens. +1 is the exact count, an equality. #53 (per-account overrides + clear) RAISED 169 -> 170 (+1 ADMISSION, GENERIC): the new per-account picker store `ui/src/modules/features/stores/FeatureFlagAccounts.store.ts` carries the software product-flag word "feature" (not a genomic feature). +1 is the exact count, an equality. MERGED #48+#50 on base 157 (169 = 157+6+6, an equality). #48 (feature-flags toggle) +6: `builtin/featureFlagActions.ts`, `modules/features/gallery.tsx`, and the regenerated `mcp/frontend-actions.json` manifest carry the software product-flag word "feature(s)" — not a genomic feature. #50 (saas-client-seam) +6: the saas-ON generated api-client twin `ui/src/api-client-saas/{apiEndpoints,permissionDescriptions,permissions,types}.ts` is a domain-surface copy of the default api-client carrying the SAME software feature tokens, GENERATED from `--features saas` and reworded only at the server source (kept IN scope to match the guard's stance on generated trees). #40 (feature-flags epic) RAISED 131 -> 157 (+26 ADMISSION, GENERIC): the runtime feature-flags admin subsystem uses "feature" as a SOFTWARE product flag; module name, feature_flags table, features::manage permission and /api/admin/features routes are the mandated public surface and cannot be reworded. */
  /** (file, token) pairs — NOT files: the prose tier has been per-token since WS-R3. 455.
   *  ARTIFACT-MODEL RE-MEASURED **416** (-39 removed, 3 lowered, 0 added). LOWERED 455 -> 416.
   *  ITEM-14 COMPLETION RE-MEASURED **401**: -15 (12 in the deleted `datatype/layout.rs`,
   *  `workstore/axes.rs` and `workstore/project_extension/repository.rs`; 3 in surviving
   *  `workstore/{ingest,mod}.rs` verified to zero by grep). LOWERED 416 -> 401.
   *  ROUND-5 FINDING 9 RE-MEASURED **396**: -3. Rewriting the four false
   *  `output_id`-as-axis-contract comments (`sandbox/{inputs,spec}.rs`,
   *  `anndata-import/compute/h5ad_import.py`) dropped 5 domain-noun occurrences in
   *  `sandbox/spec.rs` alone (`barcodes` 1->0, `cells` 2->1, `gene` 1->0, `genes` 3->2)
   *  because the corrected text no longer needs per-axis examples to say what the
   *  query keys on. `--prune-baseline` lowered 2 and removed 3; nothing was raised.
   *  LOWERED 399 -> 396.
   *  WS-R7 RE-MEASURED **386**: -10, and it was 395 before this round even started (one
   *  unit of headroom, which §4 forbids — see the testCode note below for why that matters).
   *  The drop is the production doc-comment sweep: the domain NARRATIVE moved to
   *  docs/design/processor-manifest-ui-separation.md and core now states the SHAPE, so the
   *  illustrations that carried the vocabulary are gone rather than recorded.
   *  LOWERED 396 -> 386.
   *  WS-R8 RE-MEASURED **382**: -1. `extensions/types.rs` lost its `embedding` prose token
   *  with the same rename (the `ActionRecipeDialect` doc comment no longer cites the old
   *  payload key). LOWERED 383 -> 382.
   *  DECLARATIVE-FORM-VALIDATION RE-MEASURED **381**: -1. `core/spec/schema.ts` lost its
   *  last `cell` prose token when the three hand-listed per-row dispatch sites became one
   *  generic enumeration, and `--prune-baseline` removed the entry. LOWERED 382 -> 381.
   *  RUN-SUPERSEDES-ITS-OWN-OUTPUT RE-MEASURED **379**: -2. `workstore/data_api.rs` lost its
   *  `qc` prose token when the `ListedArtifact` doc comment stopped naming two analyses to say
   *  which inputs a picker tells apart, and `ui/src/api-client/types.ts` — which is GENERATED
   *  from exactly that comment — lost the mirror. One server-side fix, two entries, and the
   *  third (the `openapi.json` copy) went from the `code` tier above. LOWERED 381 -> 379.
   *  PANE-SUBJECTS-AND-TAB-ARIA RE-MEASURED **378**: -1. `regions/RegionShell.tsx` lost its
   *  `cell` prose token when the two hand-rolled region tabs became ONE shared primitive
   *  (`regions/RegionTab.tsx`): the surviving comment says the tab is named by the title a
   *  contribution DECLARED, where the deleted per-strip copy had illustrated that with a
   *  contributed analysis by name. One entry removed by `--prune-baseline`; none added, none
   *  raised. LOWERED 379 -> 378. */
  prose: 399, /* TXRBENCH STRIP LOWERED 408 -> 399 (-9): the deletion-driven prune removed the doc-comment entries of the deleted SaaS/auth/account modules, the api-client-saas twin, the feature-flags per-account store and the stripped server module docs. | #54 (mcp-settings) RAISED 407 -> 408 (+1 ADMISSION, GENERIC): completes the workstore-settings (#54) merge omission — `server/src/modules/workstore/settings.rs` doc-comment prose names the software `feature` (this admin-settings feature, INV-1), not a genomic feature; that merge left it unbaselined and main red on this lint. The NEW mcp source adds ZERO prose-tier domain tokens. +1 is the exact count, an equality. #53 (per-account overrides + clear) RAISED 405 -> 407 (+2 ADMISSION, GENERIC): comment prose in the new per-account picker store `FeatureFlagAccounts.store.ts` names the software feature flags it documents ("feature"/"features", not genomic). +2 is the exact count, an equality. MERGED #48+#50 on base 392 (405 = 392+6+7, an equality). #48 (feature-flags toggle) +6: toggle-editor comment prose names the software feature flags it documents (`featureFlagActions.ts`, `features/gallery.tsx`, `FeatureFlags.store.ts`, `module.tsx`). #50 (saas-client-seam) +7: the saas-ON twin `ui/src/api-client-saas/types.ts` mirrors the SAME server `#[derive(JsonSchema)]` doc-comment prose as `api-client/types.ts` (cells 2 / de 1 / gene 1 / genes 2 / obs 2 / sample 2 / features 2), GENERATED from `--features saas`; fixed at the server doc-comment or not at all. #40 (feature-flags epic) RAISED 374 -> 392 (+18 ADMISSION, GENERIC): comment prose in modules/features + its FE page + the JSDoc mirrored into the generated api-client. A4 (accounts epic) +1; WS-R8 net 0 (379); WS-R9 379 -> 374 (-5): the billing epic's saas-`feature` prose-context rule excludes bare `feature` in five saas-gated backend files. */
  /** 834 measured, 835 as committed: +1 for the R5-GUARD-SELF code entry the Rust twin's
   *  own new drift-pinning test costs it.
   *
   *  ROUND-5 RECONCILIATION LOWERED 835 -> **834**, back onto the measurement. The +1 of
   *  headroom was never slack: it was written in a worktree that did not yet carry the
   *  CARD-10 fix, and the entry it anticipated is the one `--prune-baseline` removed here
   *  (`ui/tests/e2e/datatype/sniff.spec.ts`, whose last token went to 0 when the spec
   *  stopped naming an id and started DERIVING it from the registry). A ceiling with one
   *  unit of headroom is one silent addition, which is exactly what §4 forbids — and the
   *  guard's own suite asserts the equality, so this could not have been left.
   *
   *  MAIN LOWERED 834 -> **833** (`8711b2c1`, "lower two entry ceilings to their measurement"),
   *  landing while feat/viz-render-perf was in flight. This merge takes that corrected base.
   *
   *  RENDER-PERF RAISED 833 -> **847** (+14). The render-perf feature added NINE specs under
   *  ui/tests/viz-e2e/ AFTER the WS-R4 sweep took its census, so that directory's standing
   *  disposition (R4-TESTS-E2E — the Playwright suite is RECORDED, not fixed) had never been
   *  applied to them, and the guard read all 180 of their hits as new leaks. This admits exactly
   *  the same thing WS-R4 already admitted for the other 66 specs in the same directory, extended
   *  to the nine it could not have seen. The vocabulary is the grid's own — a cell here is a PANE
   *  of the workspace grid, not biology — which is why the disposition is RECORD and not FIX.
   *  +14 is the exact count of new (file, token) pairs, so this stays an equality, not slack.
   *  (The pre-merge comment cited 834 as its base; the arithmetic 833+14=847 shows it was
   *  computed against the measurement main has now codified, so the value is unchanged.)
   *
   *  DEC-48 RAISED 847 -> **848** (+1). TEST-15 / TEST-28 / TEST-29 introduced ONE new (file,
   *  token) pair — the plural `cells` in `render-perf-parity.spec.ts`, from clauses that iterate
   *  the four panes at once. Same directory, same standing R4-TESTS-E2E disposition, same reason
   *  it is a RECORD and not a FIX: a cell here is a PANE of the workspace grid. +1 is the exact
   *  count, so this stays an equality.
   *
   *  ARTIFACT-MODEL MERGE LOWERED 848 -> **792**. Neither side's number described the merged
   *  tree: main raised this ceiling as it ADDED viz-e2e specs (833 -> 848) while artifact-model
   *  lowered it as it DELETED the serve-core / workstore suites (834 -> 778). A merge is not a
   *  place to pick one of two stale measurements, so the baseline was rebuilt as the UNION of
   *  both sides' entries and then `--prune-baseline`d against the merged tree; 792 is what that
   *  measured. It is BELOW both inputs because the union's stale half — entries for suites this
   *  branch deleted on purpose — pruned away, which is the shrink-only ratchet working.
   *
   *  e2e-RESIDUE LOWERED 792 -> **789** (-3). The six stale dataset/job specs were ported off
   *  surfaces the product deliberately removed, and the two that drive the type-first upload
   *  wizard now DERIVE the type's option label from `GET /api/datatypes` instead of naming it
   *  (`_helpers.ts::singleFileTypeTitle`) — the same move `datatype/sniff.spec.ts` made earlier.
   *  `--prune-baseline` removed the entries whose last occurrence went to zero; nothing was
   *  raised or added. This ceiling follows it down in the SAME commit, because equality — not
   *  slack — is the point.
   *
   *  NOTE the pre-WS-R7 measurement was **788**, i.e. this constant carried ONE unit of
   *  headroom — the exact "one silent addition" shape §4 forbids, and the guard's own suite
   *  was red on it. Corrected to an equality below.
   *
   *  ══ WS-R7 RAISED 789 -> **802** (+13) ══
   *  The FIRST raise this tier has taken for a guard WIDENING rather than for new specs, and
   *  the header's own rule names exactly two things that may raise it — "admitting a NEW leak,
   *  and a deliberate guard-widening round". This is the second, plus a bounded amount of the
   *  first, and the two are separable by TAG so the admission is readable rather than a lump:
   *
   *    R7-PKG     (19 of the 75 new pairs across both test tiers) — newly VISIBLE, nothing
   *               moved. WS-R7 gave the guard a SECOND vocabulary axis: a shipped package's OWN
   *               ids (package / analysis / view / action), derived from the processor manifests
   *               and view specs. Lowercase `qc` was invisible to every tier above it — it is
   *               not a datatype id, and `QC` is matched case-SENSITIVELY on purpose — which is
   *               how a hardcoded view+action id sat in the app backend across five widening
   *               rounds unremarked. Same class of admission as R3-EXT (a format no guard read)
   *               and R4-TESTS-* (a tree no root reached).
   *    R7-ACCEPT  (56 of 75) — a genuine NEW admission, argued per file. These are
   *               acceptance tests written THIS round whose SUBJECT is a shipped package: each
   *               reads packages/ at test time and drives the real chain, so the package
   *               vocabulary is what is under test rather than an incidental fixture.
   *               Genericizing them would not clean them, it would delete what they assert.
   *               The bar is mechanical and was checked file-by-file, not asserted: the file
   *               must really read packages/ (or, for an e2e spec, drive the shipped view).
   *               `workbenchDataSource.test.ts` FAILED that bar on inspection — it never reads
   *               packages/ — so its 53 findings were FIXED (fixture renamed to neutral
   *               names, the measured 1-of-9 forecast ratio kept intact and mutation-proved)
   *               instead of landing here. That is the check doing its job.
   *
   *  What did NOT raise it: every unit test of a domain-agnostic engine whose fixtures merely
   *  reached for domain words. Those were genericized (10 files this round), which is why the
   *  production `code` and `prose` ceilings LOWERED in the same commit that this one rose.
   *
   *  ── processor-manifest-ui-separation: 802 -> **805**, and the ARITHMETIC, because the two
   *  numbers happening to differ by three hides a bigger move underneath. `--prune-baseline`
   *  first took the measurement 802 -> 797 (five pairs went to zero: a retired package action
   *  id, two preset tokens in the qc surface spec whose assertions were deleted with the
   *  modality picker, and two fixture tokens in a unit spec that was genericized). EIGHT new
   *  pairs are then admitted by hand on top of that, 797 -> 805 — so this constant sits AT the
   *  measurement, not three units above the old one.
   *
   *  The eight, each with the reason it could not be genericized instead:
   *    +2 `feature` / `features` in `server/tests/extensions/datatype_contribution_test.rs`
   *       (R4-TESTS-CARD). `test7`'s field-parity table had been RED and stale since the axes
   *       moved onto the analysable types — it still expected `axes: &[]` on every row and
   *       failed on the first one — so making it pass means the per-modality peers' second axis
   *       (`features` / `feature_id`) is now ASSERTED where it previously was not mentioned at
   *       all. Those peers measure over a DIFFERENT second axis than the RNA types; the name is
   *       the assertion, and a placeholder would assert nothing.
   *    +2 `obs` / `qc.addIsotype` in `ui/src/modules/workbench/core/runtime/qcSurface.test.ts`
   *       (R7-ACCEPT). The file drives the SHIPPED view spec through the real interpreter — it
   *       is what caught a shipped action emitting a pattern-less metric whose empty regex
   *       matched every symbol — so the ids it names are the shipped package's own.
   *    +2 `cf.run` / `h5ad` in `ui/tests/e2e/14-declarative-qc/cell-filter-live.spec.ts`,
   *    +1 `10x` in `.../declarative-processor-ui.spec.ts`,
   *    +1 `enrichment` in `.../modality-symmetry.spec.ts` (all R7-ACCEPT). The acceptance layer
   *       was REPAIRED this round: its seed used to post raw container bytes that both shipped
   *       computes refuse at exit 2, so every real-compute spec downstream was skipping or
   *       failing. Repaired, the specs assert the shipped analysis id, the shipped action ids
   *       and the shipped compute's own report over a really-imported artifact.
   *
   *  WITHDRAWN in the same commit, and worth recording because an earlier pass of this feature
   *  had already argued for it here: `pct_mito` in the same server test file. The argument on
   *  file was "a labels map keyed on a neutral name would prove nothing about that contract".
   *  That was wrong. The subject is a SYNTHETIC third-party package the test writes to a temp
   *  dir, whose ids were already neutral; the DEC-4 claim it proves is that a declared lookup
   *  map survives five layers byte-for-byte, and the map's keys are payload. They were
   *  genericized instead, which also took `genes` (-6), `cells` (-1) and `barcode` (-1) off
   *  that file's RAISES. A "the domain term IS the point" disposition has to survive being
   *  asked what would actually be lost; this one did not.
   *
   *  What did NOT raise it either: the INV-7 opaque-container block derives its container set
   *  from the lattice (`descendants('data/opaque')`) instead of naming ids, and binds its shape
   *  probe once instead of twice — which took that change's above-baseline findings from 46 to
   *  0 on the two server test files.
   *
   *  ══ ANALYSIS-HARNESS FIXTURE MIGRATION LOWERED 805 -> **794** (-11) ══
   *  The four `analysis::qc_*` / `provenance::verify_test` fixtures were staging the
   *  PRE-MIGRATION input contract (a single opaque upload, resolved on a retired slot) and
   *  went red when the computes' contract landed. They now stage the real artifacts through
   *  the converter's OWN writers, which took the AnnData-era vocabulary out of all four:
   *  -13 removed by `--prune-baseline` (`anndata` / `h5ad` / `scanpy` reached zero in every
   *  one of them, and `obs` / `cell` / `samples` in the two rewritten test bodies), +2
   *  hand-added under `R4-RELOCATED`.
   *  The +2 are `server/tests/analysis/mod.rs` `gene` (1) and `cells` (2) — the SLOT names
   *  `gene_names` / `cells_index` and the axis name `cells`, now spelled ONCE as constants
   *  the two test files read instead of re-spelling per test. They are a RELOCATION, not an
   *  admission: the same commit takes `qc_metrics_test.rs` + `qc_apply_test.rs` from 54 + 46
   *  code hits to 26 + 17. A slot name cannot be genericized away — it is the key
   *  `/inputs/inputs.json` carries, and a harness that stages an input has to name the slot
   *  it stages it on. Net -11, so this stays an equality.
   *
   *  ══ e2e LAUNCH-ROUTING PORT LOWERED 792 -> **785** (-7) ══
   *  A PURE prune: 0 added, 0 raised. The workbench launch/run e2e specs were brought onto the
   *  new routing contract (a launch REVEALS the analysis' own pane when it ships a form, and
   *  opens a run pane only when it does not), and every one of them stopped NAMING the package
   *  it happens to drive. They now read the LIVE contribution catalog through
   *  `window.__workbenchRegistry` and split it on whether the analysis registered a view
   *  (`_analysis.ts::{viewBackedAnalyses,formBackedAnalyses}`) — the same move
   *  `datatype/sniff.spec.ts` and the upload-wizard specs already made, and the reason the
   *  specs got STRONGER: they now assert the routing contract over whatever the tree ships
   *  instead of over two hardcoded ids.
   *  Seven (file, token) pairs reached zero and were removed by `--prune-baseline`:
   *  `_analysis.ts`, `analysis-launcher.spec.ts` (x2, incl. its `cellranger` gated-row pair),
   *  `analysis-launch-action.spec.ts`, `run-pane.spec.ts`, `artifact-delete-selfclose.spec.ts`
   *  and `14-declarative-qc/flow-guidance.spec.ts`. One entry LOWERED (the shared
   *  `14-declarative-qc/_seed.ts` fixture module, whose run helper stopped spelling the
   *  analysis id into four selectors and now returns it once). Net -7, so this stays an
   *  equality.
   *
   *  INSPECTOR-PANE-DELETION RAISED 785 -> **786** (+1): ONE new (file, token) pair,
   *  `ui/src/modules/workbench/core/shell/dock/retiredSelectionPane.test.tsx` / `cells`. The
   *  suite drives the persisted-layout migration that retires the `selection` ("Inspector")
   *  pane, and a test of a migration over `@ziee/dock`'s pane map cannot avoid naming the field
   *  that map is stored under. It is the SAME false positive the sibling dock entries already
   *  record (a dock pane map, not the domain noun), and it was driven from 27 occurrences down
   *  to 2 at source first — every read funnels through one `panesOf` accessor and the fixtures
   *  are seeded from `defaultMainSlice()` — so what is admitted here is only the irreducible
   *  remainder: the accessor body and one popup-slice fixture key. +1 is the exact count of new
   *  (file, token) pairs, so this stays an equality.
   *
   *  ══ PROCESSOR-FORM-CONFORMANCE RAISED 786 -> **789** (+3) ══
   *  Three new (file, token) pairs, from the two test tiers this round adds:
   *    · `shippedFormConformance.test.tsx` [cell] — a FALSE POSITIVE. This is the `cell:` key
   *      on a view_spec table COLUMN, which the tier reads when it walks a form's dispatch
   *      sites looking for actions with no way in. It is the same reading the pre-existing
   *      `schema.ts` / `renderers.tsx` [cell] entries already carry, and it is irreducible:
   *      the vocabulary key IS `cell`, so a test that inspects it must name it.
   *    · `full-journey.spec.ts` [h5ad] + [gene] — R4-TESTS-E2E, the standing disposition for
   *      this directory. One committed input-fixture path, and one shipped widget testid. The
   *      spec is the end-to-end journey (a real UI upload → the real import → the picker →
   *      a real click → Run → assertions on the produced artifact's bytes); it cannot upload
   *      a file without naming the file, and it cannot click a control without naming it.
   *  Both remainders were driven down at source first — everything else in both files is
   *  derived at runtime from the shipped packages, or from `_fixtures`' `DT` map, rather than
   *  written as a literal. +3 is the exact count of new pairs, so this stays an equality.
   *
   *  ══ QC-METRIC-AGGREGATION RAISED 789 -> **791** (+2) ══
   *  Two new (file, token) pairs, both irreducible and both FALSE POSITIVES of a different
   *  kind from each other:
   *    · `tableSelectCell.test.tsx` [cell] — the unit suite for the `select` table-COLUMN
   *      primitive this round adds (a closed-set control on one row's field). `cell` is the
   *      view_spec vocabulary key on a table column, not the biological noun; it is the same
   *      reading the pre-existing `schema.ts` / `renderers.tsx` / `shippedFormConformance`
   *      entries already carry. Driven from 18 occurrences down to 5 at source first — every
   *      line of prose now says `column` or `per-row control` — so what is admitted is only
   *      the `cell:` key inside the two fixture specs the suite mounts. A test that declares
   *      a table column cannot avoid spelling the key the vocabulary uses.
   *    · `qcSurface.test.ts` [pct_ribo] — NOT a false positive: a genuine domain literal, and
   *      it is the PRODUCT of the change rather than incidental vocabulary. The QC metric
   *      table gained an explicit `Aggregation` column, which made the compute's
   *      `pct_counts_<name>` decoration unstateable (it would have to vary by aggregation),
   *      so the emitted column name is now the row's `name` verbatim and the shipped default
   *      previously called `ribo` is called `pct_ribo`. This file asserts the shipped default
   *      set against the real YAML — that assertion is the reason the rename cannot drift.
   *      Its sibling `pct_mito` was already a recorded pair and is RAISED, not added.
   *  +2 is the exact count of new pairs, so this stays an equality.
   *
   *  ══ WS-R8 RAISED 791 -> **803** (+12) ══
   *  The ID-STEM tier (see `ID_STEM_TOKENS`) closes the anchor gap that let a lattice id
   *  used as a SEGMENT — `clustering_ref`, `selection.clustering` — sit in production
   *  Rust with the guard green. Widening a matcher onto a tree makes it red; the residue
   *  is recorded rather than the matcher narrowed, which is the rule this ledger exists
   *  to enforce.
   *  All 12 pairs are TEST-tier and all are the SAME token (`clustering`): 5 e2e specs /
   *  seeds that drive the REAL lattice through the demo type, 5 unit suites over the
   *  contribution + manifest engines, 2 `__testutil__` fixtures they share. They are
   *  irreducible for the reason the surrounding entries already state — a suite that
   *  exercises the real registry has to name a real type — and every one of these files
   *  ALREADY carries a whole-literal `clustering` entry, so the tier is recording a
   *  second READING of text it was already looking at, not new text.
   *  PRODUCTION additions: ZERO. The tier is scoped to the `scan` projection (code +
   *  string literals) and skips comments precisely so it stays believable; the 7
   *  production occurrences are all prose and are deliberately not funded here.
   *  It landed at +12 and settled at +9: the guard's OWN pre-existing false-positive-free
   *  acceptance went red on `startsWith('clustering:')` and forced `:`/`/` out of the
   *  separator set (see `ID_STEM_SEPARATORS`), which took three pairs with it. That is
   *  the negative control doing its job, and the tier is narrower for it.
   *  +9 is the exact count of new pairs, so this stays an equality.
   *  QC-CANVAS-REMOVAL RE-MEASURED **799**: -1. Deleting this analysis' `canvas:` block
   *  deleted the two tests that asserted it, taking `qcSurface.test.ts` code[obs] to zero
   *  (the whole entry removed) and code[pct_mito] 6 -> 4. LOWERED 800 -> 799, by
   *  `--prune-baseline`, which lowers and removes but never raises.
   *  PICKER-HIERARCHY RE-MEASURED **798**: -1. `artifact-picker-datasets.spec.ts` was repointed
   *  from the generic fallback form (a surface this analysis no longer renders — it declares a
   *  view) to the declarative picker, which dropped its last analysis-id literal. LOWERED
   *  799 -> 798, by `--prune-baseline`, which lowers and removes but never raises.
   *  QC-PRESET-CATALOG RE-MEASURED **794**: -4, and ZERO admissions. Two shipped action ids
   *  left the vocabulary when the per-preset add ACTIONS (`qc.addHb` / `qc.addIsotype`) were
   *  replaced by ONE generic add over a preset catalog carried as `const` DATA, which took
   *  their entries in `qcSurface.test.ts` and the committed surface fixture to zero; the qc
   *  surface spec lost a `cell` pair and the cell-filter surface spec two `pct_mito` pairs
   *  when both stopped restating a name they can read off the spec. Nothing was admitted:
   *  every new test this round names the vocabulary through the spec it is testing rather
   *  than restating it. LOWERED 798 -> 794, by `--prune-baseline`.
   *  SURFACE-BASELINE RE-CAPTURE RAISED 794 -> **796** (+2 net: `--prune-baseline` removed
   *  `cellset` and `enrichment`, and four tokens were admitted — `cells`, `cf.setExpression`,
   *  `qc.addPreset`, `qc.setMatrices`). This is the one raise in this ledger that nobody
   *  TYPED, and it is worth being precise about why it is not a leak. The file is
   *  `__fixtures__/surface-baseline.main.json`, a MACHINE-GENERATED capture of the lowered
   *  form of `packages/{cell-filter,qc}/ui/*.yaml`. Its entries had been pinned to a
   *  capture taken 621 commits earlier (06d99c65), so the ledger was measuring a frozen
   *  artifact; re-capturing it against current main moved 10 counts and surfaced 4 tokens
   *  that main's processor specs had been carrying, unrecorded, the whole time. Every one
   *  of them originates in `packages/**`, which this guard deliberately does NOT scan
   *  because it IS the contributed domain. The correct reading is a STALE MEASUREMENT
   *  CORRECTED, not vocabulary admitted into app code — and the only way to lower these is
   *  for a processor author to rename a metric, which is the right owner. Recorded here
   *  rather than dodged: exempting a generated file would have contradicted this guard's
   *  own stance on `openapi.json` (kept IN scope precisely BECAUSE generated), and moving
   *  the fixture into the deferred `ui/scripts` area would have been narrowing to stay
   *  green.
   *
   *  CELLFILTER-VIOLIN-EMPTY RAISED 796 -> **799** (+3, R4-TESTS-E2E). ONE new spec,
   *  `ui/tests/e2e/14-declarative-qc/cell-filter-violin-paints.spec.ts`, contributing exactly
   *  three (file, token) pairs — `cell` (5), `cells` (2), `ncount` (1). It is the same standing
   *  disposition this directory has carried since WS-R4 (the Playwright suite is RECORDED, not
   *  fixed) applied to a spec written after that census, and the admission is bounded because
   *  the round FIRST genericized everything that could be: the prose, the describe title, the
   *  project name and the diagnostic message were rewritten in pane/filter-surface vocabulary,
   *  taking the file from 18 findings to 8 before a single one was recorded. What is left is
   *  structural — the seed helper + row-count constant it imports BY NAME
   *  (`awaitCellFilterSurface`, `TINY_COUNTS_CELLS`, the `nCells` seed field), the fixture
   *  column the criterion is built on (`nCount`, the ramp `_fixtures.ts` seeds and the only one
   *  whose range makes the threshold a strict subset rather than a degenerate keep-all), and the
   *  `viz-cell-view-<pane>` testid @ziee/viz stamps on every grid pane. The last is the same
   *  "a cell here is a PANE of the workspace grid, not biology" reading the RENDER-PERF raise
   *  above already recorded for `ui/tests/viz-e2e/`. +3 is the exact count, so this stays an
   *  equality, not slack.
   *
   *  PROJECT-SUMMARY-ROLLUP LOWERED 799 -> **797** (-2, R4-TESTS-E2E). Both entries for
   *  `ui/tests/e2e/project/project-extensions.spec.ts` (`cells`, `genes`) went to zero: the
   *  spec's TEST-10 no longer spells the two axis names, it SEARCHES the processor manifests
   *  for whichever package declares them and asserts on what it read. That is the stronger
   *  assertion as well as the smaller residue — the old literals passed for any phrase
   *  containing the word, where the read one fails if the summary stops naming what the
   *  producer DECLARED. Removed by `--prune-baseline`, in the commit that earned it. */
  /** ══ REFUSALS-WITHOUT-REASONS RE-MEASURED **796**: -1 ══
   *  A PURE prune, 0 added, 0 raised. `14-workbench/viewer-readonly.spec.ts` selected its
   *  launcher row by a domain-named testid. The viewer model changed under it (a viewer may
   *  now OPEN an analysis form; the refusal moved to Run), the block was rewritten, and the
   *  row is now selected by PREFIX and discriminated by `data-availability` — which is also
   *  the stronger assertion, since the old one could not tell an availability refusal from a
   *  role refusal. The entry is removed, not lowered. LOWERED 797 -> 796. */
  /** ══ FIVE-BRANCH-MERGE RE-MEASURED **793**: -3 ══
   *  A PURE prune, 0 added, 0 raised. The merge of five individually-green branches landed
   *  three NEW test-tier leaks that no branch carried alone, and they were FIXED at source
   *  rather than recorded — which took the (file, token) pairs they belonged to all the way
   *  to zero, so `--prune-baseline` removed three entries rather than lowering them:
   *    - `canvas/viz.test.ts` [`ident`] and [`pct_mito`]: the fixture frame's two column
   *      names. The columns are FIXTURE columns for a generic lowering test, so they were
   *      renamed to `group` / `ratio` at every occurrence — the fixture, `scope()`, and all
   *      13 assertions — and each token went 10 -> 0 and 15 -> 0 rather than being trimmed
   *      back to its baseline. The test still projects a real column.
   *    - `jobs/JobFlowGuidance.test.ts` [`cell`]: the `analyses` fixture registered a
   *      domain-named analysis id. Renamed `cell.filter` -> `rows.filter` across the WHOLE
   *      fixture, so the positive test and its `analysisId` negative control keep asserting
   *      against the SAME registered id (a divergent id would make the negative control pass
   *      because the id is unregistered rather than because the key is wrong). 5 -> 0.
   *  LOWERED 796 -> 793.
   *
   *  ACCEPTANCE-TIER-VISIBILITY LOWERED 793 -> **791**: -2, a PURE prune, 0 added, 0 raised.
   *  `provenance/filter-save-records-recipe.spec.ts` lost its last `cells` and `ncount` code
   *  tokens. Both were carried by the seeding this branch replaced — `nCells:
   *  TINY_COUNTS_CELLS` and a criterion built on the fixture column `nCount`. The spec now
   *  PRODUCES its criterion column by really running the upstream analysis over the imported
   *  matrix, so it names the column that run emits and neither fixture token survives; the
   *  entries went to 0 and `--prune-baseline` removed them rather than lowering them.
   *
   *  Worth recording WHY this residue outlived every sweep that should have caught it: the
   *  spec is `@acceptance`-tagged and so excluded from every default run, and the commit
   *  that made its seeding obsolete (`c6a2e01a`) updated the two sibling specs that DO run
   *  and could not have been told about this one. The same branch makes that exclusion
   *  announce itself.
   *
   *  RAISED by the VISUALIZE-PANE round, for ONE argued entry:
   *  `tests/e2e/15-visualize/a3-marker.spec.ts` [`embedding` x3]. TEST-A9 [acceptance,
   *  INV-9] must drive a MIXED alignment offer — one set of positions aligned to the
   *  anchored row space and one not — because a per-candidate mark only carries
   *  information where there are two candidates to tell apart, and ITEM-20's all-A3
   *  stand-down is only provable as a RULE against a fixture that can also reach the
   *  other state. Seeding a second `plottable-xy` artifact means naming a concrete
   *  DATATYPE ID, which is the lattice's word. The token is confined to an 8-line
   *  fixture builder inside the spec: never a selector, never an assertion, and NOT in
   *  `_visualize.ts` — the shared helper was cleaned to ZERO tokens to keep the house
   *  rule true (one token in a helper is a token in every spec that imports it). The
   *  picker under test is itself datatype-agnostic (it selects on the `plottable-xy`
   *  CAPABILITY, which TEST-55 pins), so nothing in the ASSERTIONS knows this word.
   *
   *  MERGE OF THE TWO MOVES ABOVE, arithmetic and not a choice: the common base was 793,
   *  main PRUNED 2 (the acceptance-tier-visibility branch) and this round ADDED 1 (argued),
   *  so 793 - 2 + 1 = **792**. Taking either side's number would have silently reverted the
   *  other's move — a prune reverted is a leak re-admitted, and a raise reverted is a red
   *  gate with no entry to explain it. The resolution was done as a THREE-WAY delta against
   *  the merge base, not by keeping one side's file: both sides also MOVED entries (this
   *  round's `packages/` -> `libs/` relocation), and a whole-file pick would have silently
   *  reverted whichever set it did not choose while still counting to a plausible total —
   *  it did, on the first attempt, and the count matched anyway. `--prune-baseline` then
   *  took the residue the two merged trees no longer produce (1 lowered, 1 removed, in the
   *  prose/literal tiers); it never adds or raises.
   *
   *  FIRST-OF-N-BINDING RE-MEASURED **787**: -5. The binding-refusal work rewrote four
   *  app-tier test fixtures onto NEUTRAL vocabulary rather than baselining them — the ratchet
   *  fired on new fixtures that had reached for single-cell column names, and the resolution
   *  was to stop naming the domain, not to record it. That sweep also cleared the PRE-EXISTING
   *  vocabulary those same files carried, which is why the drop is larger than the change that
   *  provoked it. `--prune-baseline` lowered 1 and removed 8; nothing was raised or added.
   *  LOWERED 792 -> 787.
 *
 *  ══ BINDING-REFUSAL-E2E MERGE RAISED 787 -> **790** (+3, R4-TESTS-E2E) ══
 *  ONE new spec, `ui/tests/e2e/14-declarative-qc/binding-refusal-is-visible.spec.ts`,
 *  contributing exactly three (file, token) pairs — cell (4), cells (2), ncount (1). It is
 *  the twin of the CELLFILTER-VIOLIN-EMPTY raise recorded above (5/2/1), one `cell` smaller,
 *  carrying the same standing R4-TESTS-E2E disposition for the same directory.
 *
 *  It is worth recording that this went red only on MERGE, because the shape recurs: the spec
 *  was green on its own branch and the ratchet still fired here. A NEW file's token budget is
 *  ZERO, and every one of these ceilings sits AT its measurement by rule — so the branch that
 *  spent the tier down to an equality and the branch that added a file to it are each green
 *  alone and red together. The composition is the finding; neither branch is at fault, and the
 *  resolution is an admission at merge, not a revert.
 *
 *  What is admitted is structural and was checked against the reword bar first: an imported
 *  seed helper and row-count constant, the seed field they are passed on, the fixture column
 *  the criterion is built on, and the viz-cell-view-<pane> testids the spec locates its two
 *  panes by. Every one is a REFERENCE to a name the spec does not own — renaming it in the
 *  spec breaks the reference, and renaming it at its source would rename a shipped view, a
 *  shipped fixture or a shipped viz testid to satisfy a text scan. The one sentence that WAS
 *  rewordable (a pane described as a "chart cell render") was reworded rather than recorded.
 *  +3 is the exact count of new pairs, so this stays an equality.
 *
 *  ══ VISUALIZE-PANE-UX, on ITS base of 792, RAISED 792 -> 793 (+1, R4-TESTS-E2E) ══
 *  +1, ONE argued entry, for `15-visualize/pane-legibility.spec.ts` — the populated-render
 *  review the pane was rejected for not having. It is a NEW SPEC, not a new leak: the token
 *  is the datatype id a seed plan must declare, also carried by a shared fixture helper's
 *  exported symbol name (imported under a neutral alias), and every value the fixture chooses
 *  is neutral. It is confined to the SPEC and NOT added to `_visualize.ts`, whose own note
 *  above records the house rule this obeys — one token in a shared helper is a token in every
 *  spec that imports it, so the helper stays at zero.
 *
 *  ══ VISUALIZE-PANE-UX MERGE: 791 ══
 *  Arithmetic over the COMMON BASE 792, not a pick: main moved -5/+3 (net 790) and this
 *  branch moved +1 (793), so 792 - 5 + 3 + 1 = **791**. Neither side's number is the answer —
 *  790 would revert the branch's argued spec entry (a red gate with no entry to explain it)
 *  and 793 would revert main's neutral-vocabulary sweep (a prune reverted is a leak
 *  re-admitted). Resolved as a THREE-WAY delta of the baseline JSON against the merge base at
 *  (file, token) granularity — no side's file was kept — which reported zero overlapping
 *  edits: main removed 5 pairs and added 3, this branch added 1
 *  (`15-visualize/pane-legibility.spec.ts` / `embedding`). The merged file MEASURES 791 pairs
 *  in this tier, so the ceiling stays an equality, and `--prune-baseline` over the merged tree
 *  is a no-op.
 *
 *  ══ VIZ-STREAMING-READS (slice D) RAISED 791 -> **792** (+1) ══
 *  TEST-42's new `14-declarative-qc/cell-filter-regression.spec.ts` — the criteria REGRESSION
 *  gate this slice exists to add — contributes exactly two (file, token) pairs: `cell` (4) and
 *  `clustering` (1). Both are references to identifiers the APP owns, not domain reasoning in the
 *  spec: two `cell` are the imported helper name `awaitCellFilterSurface`, two are the literal
 *  store type `'cell.filter'`, and `clustering` is the seed's real `clustering_levels` field, used
 *  to assert the DECLARED-but-unobserved level case. The spec's own vocabulary is deliberately
 *  neutral — it locates the columnar slice STRUCTURALLY rather than by name and talks about rows —
 *  so what remains cannot be spelled any other way from a spec that drives that surface.
 *  +1 is the exact count of new pairs after the spec settled on the shared QC seed (its first draft
 *  also carried a `clustering` pair, pruned when the seed changed). The tier MEASURES 792, so the
 *  ceiling stays an equality.
 *  ══ GENESET-INCREMENT-1 RAISED 792 -> 805 (+16) ══ the geneset increment adds TEST files that
 *  legitimately name gene-set domain nouns in fixture data. Server integration tests:
 *  freeze_test.rs (cell, cells, genes, pbmc = 4 pairs) + draft_lifecycle_test.rs (genes, cells,
 *  pbmc = 3) drive the real geneset producer with genuine gene symbols + cell-type set names. UI
 *  unit tests: gmtParse.test.ts + gmtSerialize.test.ts (one cells pair each = 2). e2e specs
 *  (tests/e2e/14-geneset): curate-freeze (cell, cells, genes, pbmc = 4) + draft-binding (genes = 1)
 *  + restricted-user (genes, gene = 2). testCode NEW pairs = 9 + 7 = 16; 789 measured today + 16 =
 *  805, each recorded under R4-TESTS-RS / R4-TESTS-UNIT / R4-TESTS-E2E in domain-baseline.json.
 *  ══ MERGE origin/main LOWERED 805 -> 804 (-1) ══ main's `open_kinds_serve_test.rs` de/result
 *  2D-table reshape pruned one testCode baseline entry; the union baseline therefore MEASURES 804,
 *  and this ceiling is an EQUALITY (the [WS-R5][§4] meta-test asserts ceiling == measurement — the
 *  lint's own `<=` is lenient, the meta-test is strict), so it tracks the measurement down by one.
 *  ══ MERGE epic/accounts RAISED 804 -> 805 (+1 ADMISSION, R4-TESTS-RS) ══ an un-rewordable Rust
 *  `cfg(feature="saas")`/sqlx `time feature` in the A1/A3 `server/tests/account/saas_gating_test.rs`
 *  backend file — a SOFTWARE feature flag, not a genomic feature. Backend items skip the UI domain
 *  gate, so this one (file, token) pair surfaced only when the merged tree ran the gate; recorded
 *  in domain-baseline.json, not reworded. +1 is the exact count of the new pair, an equality.
 *  ══ WS-R8 LOWERED 805 -> 804 (-1) ══ the accounts admission above is now SUPERSEDED by the
 *  WS-R8 cargo/cfg-`feature` CONTEXT rule: `#[cfg(feature = "saas")]` / `#![cfg(feature="saas")]`
 *  / `cfg!(feature = "saas")` are excluded by grammar, so `saas_gating_test.rs`'s `feature`
 *  testCode entry was pruned. The rule handles the whole recurring family instead of one pair.
 *  ══ WS-R9 LOWERED 804 -> 802 (-2) ══ the billing epic's saas-`feature` PROSE-context rule (P2:
 *  the file carries a `#[cfg(feature = "saas")]` attribute) now excludes bare `feature`/`features`
 *  in a cfg-feature-gated Rust file. `server/tests/domain_surface/mod.rs` — itself gated by
 *  `#[cfg(feature = "latest")]` test fixtures — shed its `feature` and `features` testCode entries
 *  (the guard's own vocabulary-list strings; its genuine domain tokens `barcodes`/`cellset`/
 *  `samples`/`anndata` on those lines still fire). `--prune-baseline` removed both; -2 is the exact
 *  count, an equality. */
  testCode: 834, /* TXRBENCH STRIP RAISED 833 -> 834 (+1 ADMISSION, R4-TESTS-RS): `server/tests/integration_tests.rs`'s `mod features;` registration became visible to the scan when the strip removed the file's own `#[cfg(feature = "saas")]` lines that had carried it under the WS-R9 file-context rule; recorded in the same file's ledger entry (software product flag, not a genomic feature). | VISIUM-HD-BIN-CONTROL RAISED 826 -> 833 (+7 ADMISSION, R7-ACCEPT): the two new acceptance tests whose SUBJECT is the shipped spatial-import-visium-hd view + spatial-types container declaration (`containerMembers.shipped.test.ts`, `visiumHdRunInputs.test.ts`) name the shipped package vocabulary they drive and assert (the view/analysis ids, the hd.setBin/hd.run action ids, the container declaration). +7 is the exact count, an equality. | #53 (per-account overrides + clear) RAISED 824 -> 826 (+2 ADMISSION, GENERIC): the new clear-override backend integration test `server/tests/features/delete_test.rs` (features) + the per-account e2e `ui/tests/e2e/feature-flags/feature-flags-per-account.spec.ts` (feature) exercise the software feature-flags subsystem; not a genomic feature. +2 is the exact count, an equality. | #48 render test TEST-10: +2 (FALSE-POSITIVE) FeatureFlagsPage.test.tsx feature,features — software flag, not genomic.*/ /* #48 (feature-flags toggle) RAISED 817 -> 822 (+5 ADMISSION, FALSE-POSITIVE): the new unit specs for the toggle (`featureFlagActions.test.ts`, `FeatureFlags.store.test.ts`, `gallery.test.ts`) reference the software feature-flags identifiers under test. Not a genomic feature. +5 is the exact count, an equality. | #40 (feature-flags epic) RAISED 802 -> 817 (+15 ADMISSION, GENERIC): the backend integration tests (server/tests/features) + the FE e2e (ui/tests/e2e/feature-flags) exercise the software feature-flags subsystem; "feature(s)" is the mandated identifier surface, not a genomic feature. Recorded per (file, token) under the test tier. +15 is the exact count, an equality. */
  /** ══ VIZ-STREAMING-READS (slice D) RAISED +1 ══ the prose half of the same admission: the new
   *  `cell-filter-regression.spec.ts` carries one `feature` prose token, same R4-TESTS-E2E
   *  disposition. +1 is the exact count of new pairs.
   *
   *  639 measured, 640 as committed: +1, same cause. ROUND-5 RECONCILIATION LOWERED
   *  640 -> **639**: `--prune-baseline` took `server/tests/datatype/mod.rs`'s last
   *  `de` prose token to 0 with the same CARD-10 fix.
   *
   *  e2e-ROUTING LOWERED 639 -> **638**: `ui/tests/e2e/datasets/detail.spec.ts` lost its
   *  last `cell` prose token when that spec's Pipeline-tab leg was rewritten out — the
   *  tab was removed ON PURPOSE by `e4ac4af7`, so the spec had been asserting a surface
   *  that no longer exists. `--prune-baseline` removed the entry; this ceiling follows it
   *  down in the SAME commit, because equality (not slack) is the point.
   *
   *  MAIN LOWERED 638 -> **634** (`8711b2c1`), landing while feat/viz-render-perf was in flight.
   *  This merge takes that corrected base.
   *
   *  RENDER-PERF RAISED 634 -> **651** (+17), the prose half of the same admission: the same nine
   *  ui/tests/viz-e2e/ specs the render-perf feature added after the WS-R4 census, carrying the
   *  same R4-TESTS-E2E disposition. +17 is the exact count of new (file, token) pairs.
   *  (The pre-merge comment cited 638 as its base; 634+17=651 shows it was computed against the
   *  measurement main has now codified, so the value is unchanged.)
   *
   *  DEC-48 RAISED 651 -> **652** (+1): the plural `cells` in `render-perf-parity.spec.ts`'s
   *  prose, the exact twin of the testCode +1 above and admitted for the same reason.
   *
   *  ARTIFACT-MODEL MERGE LOWERED 652 -> **587**, the prose half of the testCode note above:
   *  same union-then-prune against the merged tree, same reason it lands below both inputs.
   *
   *  e2e-RESIDUE LOWERED 587 -> **579** (-8), the prose half of the testCode note above: the
   *  ported specs stopped describing the removed Pipeline-tab launch path, and with it the
   *  domain vocabulary that description carried. Same prune, same equality rule.
   *
   *  WS-R7 RAISED 579 -> **608** (+29), the prose half of the testCode note above — same two
   *  tags (R7-PKG for what the new package-vocabulary axis made visible, R7-ACCEPT for the
   *  acceptance tests deliberately bound to a shipped package), same per-file argument, same
   *  mechanical bar. It rises MORE than testCode (+29 vs +13) for a structural reason worth
   *  stating: these tests explain themselves at length in comments, and a comment that says
   *  WHY a package's own action id is under test necessarily names it. Deleting that
   *  explanation to satisfy the scanner is the failure the prose severity exists to prevent.
   *
   *  Its pre-WS-R7 measurement was 578 — the same one unit of headroom testCode carried, and
   *  corrected to an equality here for the same reason.
   *
   *  processor-manifest-ui-separation RAISED 608 -> **617** (+9), the prose half of the
   *  testCode note above and — as in WS-R7 — a LARGER move than its code twin (+9 vs +8), for
   *  the same structural reason: these tests argue for themselves in comments, and a comment
   *  that explains why a shipped package's own vocabulary is under test has to name it.
   *  `--prune-baseline` first took the measurement 608 -> 607 (one token in the qc surface
   *  spec went to zero with the assertions the modality picker's removal deleted); the ten new
   *  (file, token) pairs then land on top, 607 -> 617. Per file:
   *    +1 `server/tests/domain_surface/mod.rs` — the Rust twin ledger, RE-ANCHORING its half of
   *       the dual-ledger axis-name certification. An anchor quotes the source text it pins,
   *       and a re-anchor has to record what it replaced or a move cannot be told from a
   *       rewrite. (The JS twin had been re-anchored rounds earlier and this copy was missed —
   *       which is exactly the two-anchor failure the entry now warns about in writing.)
   *    +5 `ui/src/modules/workbench/core/runtime/qcSurface.test.ts` — the rewritten suite over
   *       the SHIPPED view spec, incl. the written-out record of the defect it caught.
   *    +1 `.../cell-filter-live.spec.ts` and +3 `.../modality-symmetry.spec.ts` — the repaired
   *       acceptance layer, and the spec whose subject (a modality selector over a closed
   *       three-name list) was DELETED, replaced by an absence assertion plus a pointer to the
   *       importer-side classifier that makes the set open.
   *  Every one of the ten lands in a file whose prose entry ALREADY carries a `finding`, so
   *  TEST_BARE_PROSE_CEILING stays 0 and nothing was admitted unexplained.
   *
   *  ══ ANALYSIS-HARNESS FIXTURE MIGRATION LOWERED 617 -> **605** (-12) ══
   *  The companion of the testCode note above, and it is a PURE prune — 0 added, 0 raised.
   *  The four rewritten fixtures stopped narrating the AnnData-era input (`anndata` /
   *  `h5ad` / `scanpy` / `barcodes` reached zero across `analysis/{mod,qc_apply_test,
   *  qc_metrics_test}.rs` and `provenance/verify_test.rs`), and the two test headers now
   *  reference the slot CONSTANTS rather than re-spelling the slot names in prose.
   *
   *  ══ e2e LAUNCH-ROUTING PORT LOWERED 605 -> **595** (-10) ══
   *  The companion of the testCode note above, and it is likewise a PURE prune — 0 added, 0
   *  raised. It falls FURTHER than its code twin (-10 vs -7) rather than less, which inverts
   *  the usual asymmetry and is worth saying why: these specs' headers had to explain the
   *  routing contract, and the contract is not about any package — "an analysis that ships its
   *  own form is revealed in it" says the whole thing without naming one. The abstract sentence
   *  turned out to be the shorter and the more accurate one, so the vocabulary left the prose
   *  along with the literals.
   *  Ten (file, token) pairs reached zero: `_analysis.ts` (3), `analysis-launcher.spec.ts` (4),
   *  `analysis-launch-action.spec.ts` (1), `artifact-delete-selfclose.spec.ts` (1) and
   *  `run-config.spec.ts` (1). Three entries LOWERED (two in the shared `_seed.ts` fixture
   *  module, one in `flow-guidance.spec.ts`). Net -10, so this stays an equality.
   *  AXIS-KEY-CONTROL REMOVAL RE-MEASURED **594**: -1. Deleting the view's axis-key picker
   *  took the last prose occurrence of its vocabulary in `cellFilterRunInputs.test.ts` with
   *  it (the entry is removed, not lowered). LOWERED 595 -> 594, by `--prune-baseline`.
   *
   *  ══ LIVE-RESHAPE ASSERTION RE-MEASURED **593**: -1 ══
   *  A PURE prune again — 0 added, 0 raised, and the tier's ONE change is an entry reaching
   *  zero. `cell-filter-live.spec.ts` used to explain its reshape step by naming the setter
   *  the keystroke dispatches; that step now asserts the ROW COUNT the pane resolved instead
   *  of that the render survived, and the sentence explaining it is about the pane, not about
   *  the dispatch — so the last occurrence of that action id in the file's prose went with the
   *  assertion it was excusing. The entry is removed, not lowered.
   *  LOWERED 594 -> 593, by `--prune-baseline`.
   *
   *  ══ QC-PRESET-CATALOG RE-MEASURED **592**: -1 ══
   *  A PURE prune again, and the same shape: the qc surface spec's prose named the retired
   *  per-preset add action while explaining what that action appended. The action is gone —
   *  its preset is a row of a `const` catalog now — so the sentence went with it. The entry is
   *  removed, not lowered. LOWERED 593 -> 592, by `--prune-baseline`.
   *
   *  ══ SYNC-AUDIENCE RE-MEASURED **587**: -5 ══
   *  A PURE prune again, and the same shape as the two above: 0 added, 0 raised, five
   *  entries reaching zero. `supporting_files_test.rs` explained its fixture by naming the
   *  datatype the extension sniffs to, and the axes that datatype declares, in order to say
   *  why a supporting file has something to bind to. Its helper is now
   *  `upload_typed_dataset` (it was `upload_h5ad_dataset` — a SHARED helper carrying a
   *  domain token in its NAME, which the test-helper rule in the README forbids and which
   *  spread that token to every one of its ~9 call sites), the prose describes the fixture
   *  structurally, and the one test added in that round DISCOVERS its axis from
   *  `GET /datatypes` at runtime rather than spelling it. The five prose entries are
   *  removed, not lowered. LOWERED 592 -> 587, by `--prune-baseline`.
   *
   *  ══ REFUSALS-WITHOUT-REASONS RE-MEASURED **584**: -3 ══
   *  A PURE prune, 0 added, 0 raised. `14-workbench/viewer-readonly.spec.ts` explained its
   *  subject by naming the analysis it drives, and named a deleted fixture analysis while
   *  saying which one had replaced it. The block was rewritten when the viewer model changed
   *  (a viewer may now OPEN an analysis form; the refusal moved to Run, where it is true), and
   *  the new prose identifies the row structurally — "the row must render its own title", "the
   *  name must BE the row" — with no analysis named. The three entries are removed, not
   *  lowered. LOWERED 587 -> 584, by `--prune-baseline`.   *
   *  FIRST-OF-N-BINDING RE-MEASURED **582**: -2. The binding-refusal work rewrote four
   *  app-tier test fixtures onto NEUTRAL vocabulary rather than baselining them — the ratchet
   *  fired on new fixtures that had reached for single-cell column names, and the resolution
   *  was to stop naming the domain, not to record it. That sweep also cleared the PRE-EXISTING
   *  vocabulary those same files carried, which is why the drop is larger than the change that
   *  provoked it. `--prune-baseline` lowered 1 and removed 8; nothing was raised or added.
   *  LOWERED 584 -> 582.
 *
 *  ══ BINDING-REFUSAL-E2E MERGE RAISED 582 -> **583** (+1, R4-TESTS-E2E) ══
 *  The prose half of the testCode note above: ONE new (file, token) pair, `cell` (4), in the
 *  same new spec, and the same merge-composition cause. It rises by ONE where its code twin
 *  rises by three — the inverse of this tier's usual asymmetry — because all four occurrences
 *  are the SAME token and all four are CITATIONS: the shipped view spec whose declared encode
 *  makes the refusal unreachable (quoted with its line), the component-tier test that CAN
 *  reach it, the render chain the changed resolver sits in, and the sibling spec this one
 *  shares its pixel-measuring helper with. The spec's header exists to state a reachability
 *  finding the enumeration got wrong, and a finding is only checkable against the paths it
 *  names; genericizing them would leave the claim and delete its evidence. +1 is the exact
 *  count of new pairs, so this stays an equality.
 *
 *  ══ VIRTUAL-DATASET-MASK RAISED 584 -> **586** (+2 net, R4-TESTS-RS / R4-TESTS-FIXTURE) ══
 *  The same merge's prose half: doc comments + reproduction commands in the new workstore tests
 *  and the `stage_and_align.py` fixture name the SHIPPED `embedding-integrate` producer package
 *  by its id / tool path. Four new (file, token) `embedding` prose pairs land (alignment_seam,
 *  creator_real_run, stage_and_align, workstore/mod.rs); the net is +2 because the same commit's
 *  helper rename (`awaitCellFilterSurface` -> `awaitFilterSurface`) pruned two prose pairs to
 *  zero. Shipped ids, recorded not renamed.
 *
 *  ══ GENESET-INCREMENT-1 RAISED 586 -> **599** (+13, R4-TESTS-RS / R4-TESTS-UNIT / R4-TESTS-E2E) ══
 *  prose/comment tokens in the geneset test tree. Server + unit: freeze_test.rs (one cell doc token)
 *  + mod.rs (a gene doc token + the freeze producer id named once in a comment) + gmtSerialize unit
 *  test (one gene doc token) = 4. e2e specs (tests/e2e/14-geneset): curate-freeze (gene, cell, cells,
 *  de = 4) + draft-binding (gene, cell, geneset.curate = 3) + restricted-user (gene, geneset.curate =
 *  2) = 9. Total 13 new (file, token) prose pairs. Legitimate test-tree prose, recorded, not fixed.
 *  ══ MERGE origin/main LOWERED 599 -> 598 (-1) ══ the same `open_kinds_serve_test.rs` de/result
 *  reshape on origin/main pruned one testProse (file, token) pair; the union baseline MEASURES 598.
 *  Like testCode, this ceiling is an EQUALITY the [WS-R5][§4] meta-test asserts against the
 *  measurement, so it tracks down by one.
 *  ══ MERGE epic/accounts RAISED 598 -> 599 (+1 ADMISSION, R4-TESTS-RS) ══ the prose half of the
 *  testCode note above: the same un-rewordable Rust `cfg(feature="saas")`/sqlx `time feature` in
 *  `server/tests/account/saas_gating_test.rs` — ONE new (file, token) prose pair, same reason,
 *  recorded not reworded. +1 is the exact count of the new pair, an equality.
 *  ══ WS-R8 LOWERED 599 -> 597 (-2) ══ the WS-R8 cargo/cfg-`feature` CONTEXT rule now excludes
 *  the `#[cfg(feature="saas")]` grammar (in code AND doc-comment prose), so `--prune-baseline`
 *  removed TWO testProse `feature` pairs it made stale: `saas_gating_test.rs` (the accounts
 *  admission above, now superseded by the rule) and `domain_surface/mod.rs` (a pre-existing
 *  cfg-`feature` prose pair). Both are software build tokens; the rule covers the whole family.
 *  ══ WS-R9 LOWERED 597 -> 596 (-1) ══ the billing epic's saas-`feature` LINE-context rule (P3: a
 *  cargo/cfg word — `saas`/`cargo`/`cfg`/`sqlx`/`build.rs`/`--features` — on the token's own line,
 *  Rust+SQL only) excludes `server/tests/workstore/mod.rs`'s `feature` doc-comment pair ("its Cargo
 *  feature", behind `#[cfg(feature = "saas")]`). A software build token; `--prune-baseline` removed
 *  it; -1 is the exact count, an equality. */
  testProse: 618, /* VISIUM-HD-BIN-CONTROL RAISED 613 -> 618 (+5 ADMISSION, R7-ACCEPT): comment prose in the two new acceptance tests whose SUBJECT is the shipped spatial-import-visium-hd view + spatial-types container declaration (`containerMembers.shipped.test.ts`, `visiumHdRunInputs.test.ts`) names the shipped package vocabulary those tests drive and assert (the view/analysis ids, the hd.setBin/hd.run action ids, the container declaration). +5 is the exact count, an equality. | #53 (per-account overrides + clear) RAISED 611 -> 613 (+2 ADMISSION, GENERIC): comment prose in the new clear-override integration test `delete_test.rs` (features) + the per-account e2e spec (features) names the software feature flags under test; not a genomic feature. +2 is the exact count, an equality. | #48 render test TEST-10: +1 (FALSE-POSITIVE) FeatureFlagsPage.test.tsx prose feature.*/ /* #48 (feature-flags toggle) RAISED 606 -> 610 (+4 ADMISSION, FALSE-POSITIVE): comment prose in the new toggle unit specs names the software feature flags under test. Same disposition as testCode. +4 is the exact count, an equality. | #40 (feature-flags epic) RAISED 596 -> 606 (+10 ADMISSION, GENERIC): comment prose in the feature-flags integration + e2e tests names the software feature flags under test. Same disposition as testCode — a product flag, not a genomic feature. +10 is the exact count, an equality. */
}

/**
 * The CLOSED set of dispositions a baseline entry may carry.
 *
 * `finding` was mandatory but UNVALIDATED — any non-empty string passed, so the
 * vocabulary the error message advertised ("E1-E6 / C1-C8 / S1-S11 / B1-B3 / DEC-J /
 * DEC-M / FALSE-POSITIVE / GENERIC") was enforced only by a TEST, and only for two of the
 * six sections. A new entry could invent its own tag and the guard would take it. Closing
 * the set here means a NEW entry has to name a disposition that already means something,
 * and a NEW round's tag family has to be added to this constant — one more reviewable
 * edit in the commit that admits the leak.
 */
/*
 * ── WS-R7 adds TWO tags, and the reason each needed one ─────────────────────
 *
 *   R7-PKG     a finding that became visible only when WS-R7 added the PACKAGE-VOCABULARY
 *              axis (`contributedPackageIds`). Provenance, exactly like `R3-EXT` ("newly
 *              visible: a format no guard read") and `R4-TESTS-*` ("newly visible: a tree
 *              no root reached"). Nothing in the tree moved; the guard grew a second side.
 *
 *   R7-ACCEPT  a test whose SUBJECT IS a shipped processor package: it reads
 *              `packages/**` at test time and drives the real chain, so the package's
 *              own vocabulary is what is under test. This is a DISPOSITION, not
 *              provenance, and no existing tag carried it — `DOC-EXAMPLE` is for a domain
 *              ILLUSTRATION on a domain-agnostic mechanism, and the `R4-TESTS-*` family
 *              all mean "was here all along and invisible". These tests were WRITTEN this
 *              round, deliberately, against the shipped packages: genericizing their
 *              fixtures would not clean them, it would delete what they assert.
 *              The bar for the tag is mechanical and checkable — the file must actually
 *              read `packages/` (or, for an e2e spec, drive the shipped view) — so it
 *              cannot become a synonym for "inconvenient to fix".
 */
export const VALID_FINDING_TAGS =
  /^(E[1-6]|C[1-8]|S([1-9]|1[01])|B[1-3]|W([1-9]|1[0-2])|DEC-[A-Z]|FALSE-POSITIVE|GENERIC|DOC-EXAMPLE|DOC-CHANGELOG|R3-(DEBUG|EXT|GALLERY|TOKEN)|R4-TESTS-(CARD|RS|FIXTURE|E2E|UNIT|SUPPORT)|R4-RELOCATED|R5-G2-(SPEC|TESTS)|R5-GUARD-SELF|R7-(PKG|ACCEPT))$/

/**
 * WS-R5 §H/A — the RATIONALE-FRESHNESS check.
 *
 * The ratchet pins COUNTS. Nothing pinned the ARGUMENT. `--prune-baseline` is mechanical:
 * when a leak is partly fixed the count drops and the note explaining why the residue is
 * retained is never re-read — so a retention argument can outlive every symbol it names
 * and still read as authoritative. The sharpest instance found: `criteria.ts`'s `cell`
 * entry argued the hits must STAY so `CELL_WS_CLASS` / `CELL_WS_LEAD` / `CELL_WS_TRAIL` /
 * `parseCell` / `_CELL_WS` / `_cell_float` stay identifiable across four readers. All
 * seven named symbols had been renamed to `VALUE_WS_*` / `parseValue` / `_VALUE_WS` /
 * `_value_float` a round earlier; `count: 3` survived on three unrelated `cell` hits.
 *
 * THE RULE. Every CODE-SYMBOL-SHAPED token a note names in backticks must still resolve
 * somewhere in the repo. "Code-symbol-shaped" is deliberately narrow — a bare identifier
 * with an underscore or an internal capital (`n_cells`, `parseCell`, `CELL_WS_CLASS`) —
 * so paths (`/`), datatype ids (`-`, `/`), file names (`.`) and ordinary prose words
 * (`note`, `count`) are all excluded by shape and cannot false-fire.
 *
 * THE ESCAPE HATCH, and why it is this one: a note that legitimately needs to name a dead
 * symbol (`was renamed from CELL_WS_LEAD`) spells it WITHOUT backticks. That is a
 * convention a reader already follows — backticks mean "this exists, go look" — so making
 * the guard mean the same thing costs nothing and needs no per-entry opt-out field.
 */
const RATIONALE_SYMBOL_RE = /`([A-Za-z_][A-Za-z0-9_]*)`/g
const RATIONALE_CORPUS_EXTS = ['.rs', '.ts', '.tsx', '.mjs', '.js', '.py', '.sql', '.sh', '.yaml', '.yml']

/** See the exclusion note in `rationaleSymbolIndex` — these quote the notes themselves. */
const GUARD_OWN_ARTEFACTS = [
  path.join(UI_ROOT, 'scripts', 'lint-no-domain-in-builtin.mjs'),
  path.join(UI_ROOT, 'scripts', 'lint-no-domain-in-builtin.test.mjs'),
  path.join(SRC_APP, 'server', 'tests', 'domain_surface'),
]

/** Lazily-built, once per process: every identifier token in the repo's SOURCE. */
let rationaleIndex = null
function rationaleSymbolIndex() {
  if (rationaleIndex) return rationaleIndex
  const dirs = [
    path.join(SRC_APP, 'server'),
    UI_SRC,
    UI_TESTS,
    path.join(UI_ROOT, 'scripts'),
    DESKTOP,
    PACKAGES,
    PROCESSORS_DIR,
    path.join(REPO_ROOT, 'scripts'),
  ]
  const idx = new Set()
  const idRe = /[A-Za-z_][A-Za-z0-9_]*/g
  for (const d of dirs) {
    for (const f of listFiles(d, RATIONALE_CORPUS_EXTS)) {
      // THE GUARD'S OWN ARTEFACTS ARE EXCLUDED, and that exclusion IS the check.
      //
      // The notes live in the baseline; this file and the Rust twin quote them (verbatim,
      // in several cases) in their own explanatory comments. A corpus containing any of the
      // three resolves a cited symbol against THE SENTENCE THAT CITES IT, and the whole
      // mechanism becomes a tautology — measured, not hypothesised: with them in, the
      // `criteria.ts` entry (whose seven named symbols were ALL renamed a round earlier)
      // came back CLEAN, because CELL_WS_CLASS / _CELL_WS / parseCell survive nowhere in
      // the repo EXCEPT this file and domain_surface/mod.rs. The corpus has to be the tree
      // the note is ARGUING ABOUT, never the guard's own prose about it.
      if (f === BASELINE_PATH) continue
      if (GUARD_OWN_ARTEFACTS.some(g => f === g || f.startsWith(g + path.sep))) continue
      let src
      try {
        src = readFileSync(f, 'utf8')
      } catch {
        continue
      }
      const m = src.match(idRe)
      if (m) for (const t of m) idx.add(t)
    }
  }
  rationaleIndex = idx
  return idx
}

/**
 * @param {object} baseline
 * @returns {string[]} one message per note citing a symbol that no longer resolves.
 */
export function rationaleFreshnessViolations(baseline) {
  const out = []
  const notes = []
  for (const sec of ['code', 'literals', 'testCode', 'testLiterals']) {
    for (const [k, toks] of Object.entries(baseline[sec] ?? {})) {
      for (const [tok, spec] of Object.entries(toks)) {
        if (spec && typeof spec === 'object' && spec.note) {
          notes.push([`${sec}["${k}"]["${tok}"]`, spec.note, k])
        }
      }
    }
  }
  for (const sec of ['prose', 'testProse']) {
    for (const [k, spec] of Object.entries(baseline[sec] ?? {})) {
      if (spec && typeof spec === 'object' && spec.note) notes.push([`${sec}["${k}"]`, spec.note, k])
    }
  }
  if (notes.length === 0) return out
  const idx = rationaleSymbolIndex()
  /** The SUBJECT file's own text, for the guard-artefact entries the corpus excludes. */
  const subjectText = key => {
    const abs = path.join(SRC_APP, key)
    if (!existsSync(abs)) return ''
    try {
      return readFileSync(abs, 'utf8')
    } catch {
      return ''
    }
  }
  for (const [where, note, key] of notes) {
    const dead = new Set()
    let subject = null
    for (const m of note.matchAll(RATIONALE_SYMBOL_RE)) {
      const sym = m[1]
      // Shape gate: an underscore or an internal capital. Excludes prose words and
      // single-word tokens like `note` / `count` / `cell` (which are VOCABULARY, not
      // symbols, and are legitimately named in every note in the file).
      if (!/_/.test(sym) && !/^[A-Za-z][a-z0-9]*[A-Z]/.test(sym)) continue
      if (sym.length < 4) continue
      if (idx.has(sym)) continue
      // FALLBACK: the entry's OWN file. Needed because the corpus excludes the guard's
      // three artefacts, and an entry ABOUT one of them (e.g. the `domain_surface/mod.rs`
      // testProse entry naming `MIN_NOUN_HITS`) would otherwise false-fire. This does not
      // re-open the tautology: it resolves against the SUBJECT of the note, which is the
      // one file a note is entitled to be talking about.
      subject = subject ?? subjectText(key)
      if (new RegExp(`(^|[^A-Za-z0-9_])${escapeRe(sym)}([^A-Za-z0-9_]|$)`).test(subject)) continue
      dead.add(sym)
    }
    // ── The COUNT half of the same rot ────────────────────────────────────────
    // A note can also be measurably false about NUMBERS: `api-client/types.ts` claimed
    // "all 88 prose hits … the largest single prose entry in the ledger" while its own
    // `tokens` map, in the same object, summed to 11 (31st of 173; the largest is
    // `criteria.ts` at 58). Same cause as the dead symbols — a prune moved the counts and
    // nobody re-read the sentence.
    //
    // DELIBERATELY NARROW. Only the two phrasings that make a claim about THIS entry's OWN
    // current total are checked. Notes legitimately cite other files' counts, historical
    // measurements ("down from 65") and zero-measurements ("measured 0 occurrences"); a
    // general number-checker would fire on all of them and be turned off within a round.
    const own = entryTotal(where, baseline)
    if (own !== null) {
      for (const re of [/\ball (\d+) (?:prose |code )?hits?\b/g, /\bRe-measured at (\d+) hits?\b/g]) {
        for (const m of note.matchAll(re)) {
          if (Number(m[1]) === own) continue
          out.push(
            `domain-baseline.json ${where}: its note claims "${m[0]}" but the entry's own tokens ` +
              `sum to ${own}. The counts moved (a prune, a fix, a re-measure) and the sentence ` +
              `did not. Re-measure and rewrite it — a ledger whose prose disagrees with its own ` +
              `numbers is worse than one with no prose at all.`,
          )
        }
      }
    }
    if (dead.size > 0) {
      out.push(
        `domain-baseline.json ${where}: its note cites ${dead.size} symbol(s) that no longer ` +
          `resolve anywhere in the repo — ${[...dead].map(s => `\`${s}\``).join(', ')}. ` +
          `\`--prune-baseline\` moves COUNTS and never re-reads the ARGUMENT, so a retention ` +
          `rationale can outlive every symbol it names (a \`criteria.ts\` entry argued for ` +
          `keeping three hits so seven since-renamed symbols would stay identifiable). ` +
          `Re-verify the note against the file and rewrite it, or — if the symbol is named ` +
          `precisely BECAUSE it is gone — say so without backticks.`,
      )
    }
  }
  return out
}

/** The entry's OWN current total, or null when it has no per-token map. */
function entryTotal(where, baseline) {
  const m = where.match(/^(\w+)\["(.+?)"\](?:\["(.+?)"\])?$/)
  if (!m) return null
  const [, sec, key, tok] = m
  const spec = baseline[sec]?.[key]
  if (!spec) return null
  if (tok !== undefined) {
    const s = spec[tok]
    return typeof s === 'number' ? s : (s?.count ?? null)
  }
  if (!spec.tokens) return null
  return Object.values(spec.tokens).reduce((a, x) => a + x, 0)
}

/**
 * @param {object} baseline
 * @returns {string[]} tier-size + disposition-vocabulary violations.
 */
export function baselineAdmissionViolations(baseline) {
  const out = []
  const size = {
    code: Object.values(baseline.code ?? {}).reduce((a, o) => a + Object.keys(o).length, 0),
    testCode: Object.values(baseline.testCode ?? {}).reduce((a, o) => a + Object.keys(o).length, 0),
    prose: Object.values(baseline.prose ?? {}).reduce(
      (a, s) => a + Object.keys(s?.tokens ?? {}).length,
      0,
    ),
    testProse: Object.values(baseline.testProse ?? {}).reduce(
      (a, s) => a + Object.keys(s?.tokens ?? {}).length,
      0,
    ),
  }
  for (const [tier, ceiling] of Object.entries(BASELINE_ENTRY_CEILINGS)) {
    if (size[tier] > ceiling) {
      out.push(
        `domain-baseline.json ${tier} holds ${size[tier]} (file, token) entr(ies), above the ` +
          `committed ceiling of ${ceiling}. Only TWO things raise this tier: admitting a NEW ` +
          `leak, and a deliberate guard-widening round. Neither may be silent — a new entry ` +
          `tagged GENERIC used to slip through with no constant edited at all. Raise ` +
          `BASELINE_ENTRY_CEILINGS.${tier} in the SAME commit, with the reason.`,
      )
    }
  }
  const tagged = []
  for (const sec of ['code', 'literals', 'testCode', 'testLiterals']) {
    for (const [k, toks] of Object.entries(baseline[sec] ?? {})) {
      for (const [tok, spec] of Object.entries(toks)) {
        if (spec && typeof spec === 'object' && spec.finding) {
          tagged.push([`${sec}["${k}"]["${tok}"]`, spec.finding])
        }
      }
    }
  }
  for (const sec of ['prose', 'testProse']) {
    for (const [k, spec] of Object.entries(baseline[sec] ?? {})) {
      if (spec && typeof spec === 'object' && spec.finding) tagged.push([`${sec}["${k}"]`, spec.finding])
    }
  }
  for (const [where, tag] of tagged) {
    if (VALID_FINDING_TAGS.test(tag)) continue
    out.push(
      `domain-baseline.json ${where} is tagged "${tag}", which is not in the CLOSED set of ` +
        `dispositions (VALID_FINDING_TAGS). \`finding\` used to accept ANY non-empty string, so ` +
        `a new entry could invent its own tag and mean nothing. Use an existing disposition, or ` +
        `add the new round's tag family to VALID_FINDING_TAGS in the same commit.`,
    )
  }
  return out
}


/**
 * The number of prose entries still recorded as a BARE COUNT — the 2026-07-28 WS-B
 * bulk sweep, taken before this tier carried per-entry reasons. Measured at 124 after
 * the 2026-07-28 reconciliation. It is a CEILING, not a floor: `--prune-baseline`
 * lowering it is progress, but a new bare entry means a leak got baselined without
 * saying why, which is what the code tier's `finding` requirement has always forbidden.
 *
 * WS-R3 — the tier migrated from a per-FILE total to per (file, TOKEN), and the
 * migration CARRIED each entry's `finding`/`note` across unchanged, so the count of
 * UNEXPLAINED entries is still exactly 70 and the ceiling is UNCHANGED. "Bare" now
 * means "no `finding`" rather than "spelled as a bare number" (the bare-number
 * spelling is rejected outright — see the prose tier in `runGuard`); the two
 * definitions coincide on the grandfathered set, which is why the number did not
 * move. Every one of the 124 prose entries WS-R3 added carries an R3-* finding.
 */
// ARTIFACT-MODEL RE-ANCHORED 67 -> 66. The branch's prose strip took one BARE entry to
// zero and `--prune-baseline` removed it, but the ceiling was left at 67 — i.e. the
// reclaimed slot was BANKED, which is precisely what every re-anchor note above forbids
// ("the reclaimed slots are GIVEN UP in the same commit, never banked as free passes").
// It was not a theoretical hole: the guard's own negative control
// ([reconcile] a NEW UNEXPLAINED prose entry FAILS the grandfather ceiling) strips the
// `finding` off ONE explained entry and asserts the ceiling fires; with 66 measured and
// the ceiling at 67 the doctored ledger sat exactly AT the limit and the control went
// green over a leak it is built to catch. Found by that test failing on this branch and
// passing at its merge-base.
//
// ── WS-R7: THE SAME DEFECT RECURRED, by the mechanism this comment predicts ──
// LOWERED 66 -> **65**. `--prune-baseline` removed the whole prose entry for
// `ui/src/modules/workbench/core/manifest/processorPackage.ts` (its last unexplained token
// went to zero when that file's domain comment was reworded), so the measurement dropped
// 66 -> 65 and this constant was left one unit above it — reopening exactly the hole the
// paragraph above describes, and turning the negative control green again.
//
// The lesson is not "remember to lower it": a ceiling that is only correct while nothing
// shrinks will drift open every time the tree improves, which is the perverse direction.
// It is that this constant must be re-measured in ANY commit that prunes prose, and the
// control is what notices — it failed here, loudly, and named the ceiling. Both times the
// bug was found by a test, not by review.
//
// ── WS-R8: RE-MEASURED 64 -> **61** (-3), the same motion the paragraph above demands ──
// This commit reduced the UNEXPLAINED prose count three ways: (1) `jobs/runner.rs` and
// (2) `jobs/scheduler.rs` each gained a `finding` (GENERIC — a resource-metric `sample`,
// not a biological one) when the compute epic's metering residue RAISED their token count,
// which a raise requires; and (3) `sandbox/probes.rs`'s bare prose `feature` entry was
// removed by `--prune-baseline` once the WS-R8 cargo/cfg-`feature` context rule excluded it.
// Found (as the comment above predicts) by the `[reconcile]` negative control, which named
// this ceiling. The three reclaimed slots are GIVEN UP here, not banked.
//
// ── WS-R9: RE-MEASURED 61 -> **59** (-2), same motion again ──
// The billing epic's saas-`feature` prose-context rule (P2 file cfg-attr + P3 cargo/cfg line
// word) made two BARE prose entries stale — `server/src/modules/mod.rs` and
// `server/src/modules/project/repository.rs`, each a lone bare `feature` token (a cargo build
// token, not genomic). `--prune-baseline` removed both files' entries; a third bare `feature`
// TOKEN dropped out of `dataset/repository.rs` but that FILE keeps other bare tokens, so it
// stays counted. Again found by the `[reconcile]` control naming this ceiling; the two
// reclaimed slots are GIVEN UP, not banked.
const BARE_PROSE_CEILING = 59
// WS-C RE-ANCHORED 124 -> 99. The bulk record is being PAID DOWN, not grandfathered
// forever: 22 entries were RAISED by the widened vocabulary and converted to the
// {count, finding, note} form in the same pass (a raised budget must say why it
// rose), `--prune-baseline` removed 3 more, and the 24 LARGEST remaining bare entries
// (287 of the 445 bare hits) were explained by hand — 124 -> 99 -> 75 entries,
// 158 bare hits left across 75 small entries (median 1, max 4).
// Lowering the ceiling in the same commit is what makes that irreversible —
// otherwise the reclaimed slots become free passes for the next unexplained entry.
//
// ROUND-2 RE-ANCHORED 75 -> 70. `--prune-baseline` removed five bare entries whose
// prose residue went to zero (WS-P's `arrowClient.ts` + four `modules/datasets/**`
// files, WS-B's `core/shell/types.ts`, WS-A's `columns/{errors,fixtureCtx,ref,
// resolve}.ts`, WS-D's `vizState.store.ts`, WS-I's `build_helper/sandbox_rootfs.rs`,
// WS-H's `project/models.rs` — 15 prose entries in total, 5 of them bare). Same
// discipline as above: the reclaimed slots are given up, not banked.
//
// ROUND-3 RECONCILIATION RE-MEASURED 70 — UNCHANGED, so the ceiling holds. The one prose
// entry `--prune-baseline` removed this round (`core/runtime/store.ts`, r3canvas took its
// residue to zero) carried a `finding`, so no bare slot was reclaimed and none is banked.
//
// ROUND-4 RECONCILIATION RE-ANCHORED 70 -> 67. Three bare entries were removed outright by
// `--prune-baseline` (their prose residue went to zero with the squashed migrations and the
// r4spec doc rewrites). Same discipline as every re-anchor above: the reclaimed slots are
// GIVEN UP in the same commit, never banked as free passes for the next unexplained entry.
//
// DECLARATIVE-FORM-VALIDATION RE-ANCHORED 65 -> 64. One bare entry went outright:
// `core/spec/schema.ts`'s prose residue reached zero when the three hand-listed per-row
// dispatch sites became one generic enumeration, so `--prune-baseline` removed it. The
// reclaimed slot is given up here rather than banked — which is exactly what the
// `[reconcile]` control noticed when it was not.

// ════════════════════════════════════════════════════════════════════════════
//  WS-R4 — the TEST tier's own calibration
// ════════════════════════════════════════════════════════════════════════════

/**
 * The TEST-tier literal ceiling. Same semantics as `LITERAL_HITS_CEILING` (shrink-only;
 * raising it is an explicit admission), different SEVERITY and therefore a different
 * number: a production literal is a datatype id the app SHIPS, a test literal is a
 * datatype id the app's own SUITE asserts on. The second is a coupling, not a dispatch —
 * real, worth a worklist, and not the same thing.
 *
 * MEASURED **543** on 2026-07-28, the first time anyone looked. Set AT the measurement
 * (a ceiling, not a floor with room) and shrink-only from there. Per-root split:
 *   R4-TESTS-CARD    146  the 8 test files carrying an exact-cardinality certification
 *   R4-TESTS-UNIT    186  `*.test.*` under `ui/src` — the retired BASENAME exemption
 *   R4-TESTS-RS      184  `server/tests/**.rs`
 *   R4-TESTS-E2E      18  `ui/tests/**`
 *   R4-TESTS-SUPPORT   9  `__fixtures__/` + `__testutil__/`
 * For scale: the PRODUCTION ceiling is 69. A test literal is an assertion ON a domain
 * id, not a shipped dispatch OF one — a real coupling, a different severity, and the
 * reason these are two constants and not one.
 *
 * ── ROUND-4 RECONCILIATION: RAISED 543 -> 548. This is the "explicit, reviewable
 * admission" the tier was designed to force, so here is the admission in full.
 *   -4  `server/tests/sandbox/env_image_test.rs` `single-cell` 4 -> 0 (r4embed, a real
 *       fix: the env-image test stopped naming a domain rootfs flavour).
 *   +9  `ui/tests/e2e/14-declarative-qc/_fixtures.ts` 7 + `_seed.ts` 2 (r4dataapi).
 * The +9 are NOT new couplings. They are 9 of the 23 literals r4dataapi deleted from
 * `workstore/data_api.rs`, RELOCATED: the six subject-specific debug seed routes were an
 * e2e fixture surface that had been compiled into the server crate, and replacing them
 * with one generic engine moved their vocabulary to where the callers already live. The
 * same bytes crossed from a tier that SHIPS to a tier that only RUNS, which is the whole
 * strategy of this round — so refusing the raise would be refusing the strip.
 * The honest scoreboard is BOTH constants together: 69 + 543 = 612 -> 34 + 548 = 582,
 * and the 35 that left are the ones the binary used to carry. Baselined under the
 * `R4-RELOCATED` finding tag, which exists so this move is auditable in the ledger and
 * not just in a commit message. Shrink-only from 548.
 *
 * ── WS-R5 (2026-07-28): 548 -> 546, and it went DOWN. ───────────────────────────────
 *  -16  `de` + `'Differential expression'` across 9 test files, pruned mechanically. Not
 *       a fix — the id was pruned from the lattice rounds ago and only the hand-list kept
 *       it alive. Sixteen recorded "couplings" to a type that does not exist.
 *  +14  `cell-set` (6 sites) + `annotation-table` (8) under `R5-G2-TESTS`. Real couplings,
 *       invisible until the vocabulary was derived from the manifests: `cell-set` arrived
 *       with `single-cell-types` 0.3.0 and `annotation-table` comes from `anndata-import`.
 *  +13  `de/result` (6) + `graph/attributed` (4) + `geneset/collection` (3) across three
 *       `server/tests/workstore/*_serve_test.rs`, also R5-G2-TESTS. These are contributed by
 *       the `open-kinds` package and were matched by NOTHING at all before this round —
 *       `SUBSTRING_TOKENS` was a hand-list of three, `QUOTED_ID_TOKENS` drops any id with a
 *       slash, and the `gene` noun does not reach `geneset` (the lowercase `s` fails the
 *       right-hand letter boundary). Deriving the slash ids from the manifests is what
 *       surfaced them.
 *  +11  `server/tests/domain_surface/mod.rs` (10) + `datatype_contribution_test.rs` (1),
 *       R5-GUARD-SELF. The Rust twin has to SPELL the vocabulary it searches for, and this
 *       round added a test pinning the exact G2 drift by naming the five ids that arrived
 *       unnoticed and the one that left. The JS twin escapes this only because `ui/scripts`
 *       is a declared UNSCANNED tree; the Rust twin sits inside a scanned root and pays for
 *       its own prose. The guard REFUSED to absorb it silently, which is the ceiling working.
 *  -20  the same file again, in the other direction and for the same reason: porting its
 *       hand-listed `QUOTED_TITLE_TOKENS` / `QUOTED_ID_TOKENS` / `SUBSTRING_TOKENS` consts to
 *       a manifest derivation DELETED twenty verbatim datatype titles and ids from the twin's
 *       own source. The single largest literal shrink of the round came from making the guard
 *       stop hardcoding the thing it forbids hardcoding.
 * Net 548 -> 550, at the measurement with no slack. A tier ceiling that absorbs +38 real
 * couplings, sheds 16 recorded against a type that does not exist and 20 the enforcer itself
 * was carrying, is the shape to want from a vocabulary WIDENING.
 *
 * ROUND-5 RECONCILIATION RE-MEASURED **550** — UNCHANGED, and worth recording because a
 * decrease was PREDICTED and did not happen. The round-5 handoff expected the CARD-10 fix
 * to take this to 549 via `sniff.spec.ts`. It did not, and the reason is a ledger fact
 * rather than a rounding one. At `a1358707` that spec did carry a LITERAL entry — the id
 * it asserted on. That entry is already gone at the merge: G2's derivation dropped the id
 * from the vocabulary outright (it had been PRUNED from the lattice rounds earlier and only
 * the hand-list kept it alive), so the literal stopped being counted by the WIDENING, not by
 * the fix. What the CARD-10 fix left for `--prune-baseline` was the spec's `testCode` NOUN
 * entry plus two `testProse` tokens — three entries, none of them in this tier. The lesson
 * is the one this file keeps relearning: re-measure, never carry a number forward from an
 * argument about it.
 */
// WS-R7 LOWERED 550 -> **508**, back onto the measurement. It had drifted 42 units open:
// this round genericized ten unit-test fixtures off the contributed datatype ids, and
// `--prune-baseline` removed the literals that went to zero. A hit ceiling with 42 units of
// slack is 42 silent admissions waiting to happen — the same 'equality, not slack' rule the
// entry ceilings above state, and the same reason BARE_PROSE_CEILING had to follow its own
// measurement down twice. Raising it again is an explicit, reviewable admission.
//
// processor-manifest-ui-separation RAISED 508 -> **510** (+2), and this is the tier where a
// raise deserves the most suspicion, so both are itemised:
//   +1 `ui/tests/e2e/14-declarative-qc/_seed.ts` — the repaired acceptance seed asserts that
//      importing the committed fixture through the deployment's OWN converter produced EXACTLY
//      ONE artifact of the shipped primary datatype. The id is the thing under test: a seed
//      that asserted "some artifact appeared" is what let the previous seed ship while both
//      shipped computes were refusing its output at exit 2.
//   +1 `.../cell-filter-live.spec.ts` — the real-compute arm asserts the committed mask's
//      datatype is the shipped one the manifest declares that processor produces. Written
//      against a capability instead, it would pass for any artifact carrying that capability,
//      which is precisely the regression (a run emitting the wrong product) it exists to catch.
// Both are ACCEPTANCE assertions over the shipped packages (R7-ACCEPT), not fixtures reaching
// for a convenient string; a fixture-derived id is the correct answer for the OTHER kind and is
// why this ceiling dropped 42 units in WS-R7.
//
// SURFACE-BASELINE RE-CAPTURE RAISED 510 -> **513** (+3 net: -2 as `--prune-baseline` took
// `report/qc` to zero, +4 `single-cell`, +1 `metadata-column`). Itemised, because this tier
// deserves the most suspicion: all five are inside
// `__fixtures__/surface-baseline.main.json`, a MACHINE-GENERATED capture of the lowered
// `packages/{cell-filter,qc}/ui/*.yaml`. Nobody wrote a test asserting on a hardcoded
// datatype id — the fixture had simply been pinned to a 621-commit-old capture (06d99c65),
// so the literal count was measuring a frozen artifact. Re-capturing against current main
// corrected the measurement. A fixture-derived id is not available here and would defeat the
// device: the whole point of the facet is to compare the LOWERED SPEC LITERALLY, so that a
// changed datatype id in a shipped processor is exactly what shows up as a difference.
//
// DELETING THE STEPPED/WIZARD FORM LOWERED 513 -> **500** (-13). Shrink-only working as
// intended, so the arithmetic is stated rather than fitted: observed was 511 against a
// ceiling of 513 (2 units of headroom), and rewriting `core/form/schema-types.test.ts`
// down to TEST-17 alone — TEST-18 (code-form), TEST-401 ×2 and TEST-402 (stepped) all
// went with the shapes they exercised — took observed to 498. 511 - 498 = 13, so the
// ceiling drops by exactly 13 and the SAME 2 units of pre-existing headroom survive.
// It is deliberately NOT set to 498: that would also spend headroom this deletion did
// not earn, which is a separate decision from removing the wizard.
//
// VIRTUAL-DATASET-MASK RAISED 497 -> **513** (+16, R4-TESTS-RS / R4-TESTS-FIXTURE). The merge
// added the workstore alignment/gather integration tests plus three producer-shaped
// `stage1_alignment*` fixture manifests, which legitimately assert on — or declare — the
// SHIPPED, package-contributed datatype ids `dataset-alignment`, `metadata-column`, `report/qc`
// and the model-coverage SUBJECT `graph/attributed`. A test that filters produced artifacts by
// datatype, or a fixture that mirrors producer output, cannot spell those ids any other way:
// they are stored contracts, recorded here (not renamed). +16 is the exact count of the new
// literal hits, so this stays an equality.
//
// DOMAIN-LINT-REGRESSION LOWERED 513 -> **512** (-1, from origin/main). `server/tests/workstore/
// open_kinds_serve_test.rs` was reshaped (the `de/result` 2D-table rework), dropping one of its
// four `de/result` code literals to three. `--prune-baseline` lowered that entry 4 -> 3, so the
// tier total falls by exactly one (literal ceilings sit AT the measurement).
//
// GENESET-INCREMENT-1 RAISED 512 -> **521** (+9, R4-TESTS-RS / R4-TESTS-E2E). The geneset
// freeze/draft-lifecycle integration tests + the 14-geneset e2e specs assert on the SHIPPED
// `geneset/collection` datatype id (freeze_test.rs ×3, draft_lifecycle_test.rs ×1, curate-freeze ×2,
// draft-binding ×1, restricted-user ×1 = 8) and name the `single-cell` rootfs once in a skip message
// (freeze_test.rs ×1). A test that freezes a draft and reads back its minted artifact's datatype,
// drives the curate UI, or skips when the rootfs is absent, cannot spell those ids any other way —
// stored/environment contracts, recorded here. +9 is the exact count of the new literal hits.
//
// UNION of both deltas on the merged tree: 513 - 1 (main's prune) + 9 (geneset) = 521.
const TEST_LITERAL_HITS_CEILING = 521

/** No grandfathered bulk record exists in the test tier — it was created in one commit. */
const TEST_BARE_PROSE_CEILING = 0

/**
 * The TEST tier's COLLAPSE detectors, on the same ≈⅔-of-measurement basis as
 * `OBSERVATION_FLOORS`. Separate constants, not a merged total: see the tier-split
 * rationale in `runGuard`. A refusal to read the test trees — the single most likely
 * future edit to this guard — drives all three of these to zero and fails loudly,
 * instead of shaving a few percent off a merged number nobody would notice.
 */
const TEST_OBSERVATION_FLOORS = {
  /**
   * `domain-noun` hits across the four TEST roots. Measured **3826** on 2026-07-28.
   * ROUND-4 RE-MEASURED **4011** (+185): r4dataapi's `_fixtures.ts` (+115) and the
   * `_seed.ts` growth (+70) — the relocated debug-seed vocabulary. RAISED 2550 -> 2674
   * (⅔ of 4011); the tier went UP because production went down by more.
   *
   * ROUND-5 RECONCILIATION RE-MEASURED **4020** (+9). RAISED 2674 -> 2680 (⅔ of 4020).
   * Attributed per FILE, guard held CONSTANT across the two trees (the round-5 vocabulary
   * derivation touches the LITERAL tiers, not this one, so `a1358707` and HEAD are
   * directly comparable):
   *   +8  `server/tests/domain_surface/mod.rs`                    r5guard — its own new
   *       drift-pinning test, which has to SPELL what it searches for (R5-GUARD-SELF)
   *   +2  `server/tests/extensions/datatype_contribution_test.rs` r5guard — the CARD-05
   *       re-anchor, correcting a coverage claim that was false as written
   *   -1  `ui/tests/e2e/datatype/sniff.spec.ts`                   r5card — the spec stopped
   *       naming an id and now DERIVES it from the same registry the server serves
   */
  testDomainNoun: 2680,
  /**
   * `domain-prose` hits across the four TEST roots. Measured **1780** on 2026-07-28.
   * ROUND-4 RE-MEASURED **1844** (+64): +58 from the same two r4dataapi files as above,
   * and +6 hand-argued under `R3-META` in `server/tests/domain_surface/mod.rs` — this
   * reconciliation's own doc comments recording WHAT r4dataapi deleted (the three
   * executable-dispatch literal lines, by number). RAISED 1186 -> 1229 (⅔ of 1844).
   *
   * ROUND-5 RECONCILIATION RE-MEASURED **1853** (+9). RAISED 1229 -> 1235 (⅔ of 1853).
   * Same three files as the noun tier above, same attribution:
   *   +10 `server/tests/domain_surface/mod.rs`                    r5guard
   *   +2  `server/tests/extensions/datatype_contribution_test.rs` r5guard
   *   -3  `server/tests/datatype/mod.rs`                          r5card — the CARD-10 fix
   *       removed the prose that described a type the lattice no longer contains
   */
  testDomainProse: 1235,
  /**
   * `testCode` entries in `domain-baseline.json`. Measured **816** on 2026-07-28.
   * ROUND-4 RE-MEASURED **834**: +21 hand-argued `R4-RELOCATED` entries in the two
   * r4dataapi files, -3 removed by `--prune-baseline`. RAISED 544 -> 556 (⅔ of 834).
   * ROUND-5 RECONCILIATION RE-MEASURED **834** — UNCHANGED as a count. The round's
   * `--prune-baseline` removed one entry and the ledger had gained one, so the floor
   * stays 556 (⅔ of 834). (The ENTRY-COUNT ceiling did move, 835 -> 834: it sits AT the
   * measurement where this floor sits at ⅔ of it. Both are correct; that asymmetry is
   * the point — see the header of `BASELINE_ENTRY_CEILINGS`.)
   */
  testBaselineEntries: 556,
}

export function testObservationFloorViolations(observedNoun, observedProse, baselineEntries) {
  const out = []
  const check = (name, got, floor, what) => {
    if (got < floor) {
      out.push(
        `${name}: ${got} ${what}, below the committed floor of ${floor}. The TEST roots ` +
          `(serverTests / serverTestsData / uiTests / uiSpecs) stopped matching. Either the ` +
          `roots were dropped, the basename classifier was turned back into an exemption, or ` +
          `the vocabulary / boundary / tokenizer broke. If the drop is real progress — a ` +
          `sibling round actually fixing test-tree coupling — lower ` +
          `TEST_OBSERVATION_FLOORS.${name} deliberately, in the same commit, with the new ` +
          `measurement recorded here.`,
      )
    }
  }
  check('testDomainNoun', observedNoun, TEST_OBSERVATION_FLOORS.testDomainNoun, 'test-tier domain-noun hit(s)')
  check('testDomainProse', observedProse, TEST_OBSERVATION_FLOORS.testDomainProse, 'test-tier domain-prose hit(s)')
  check(
    'testBaselineEntries',
    baselineEntries,
    TEST_OBSERVATION_FLOORS.testBaselineEntries,
    'baselined testCode entries',
  )
  return out
}

// ════════════════════════════════════════════════════════════════════════════
//  WS-R4 — EXACT-CARDINALITY CERTIFICATIONS (finding R4-TESTS-CARD)
// ════════════════════════════════════════════════════════════════════════════

/**
 * The qualitatively different finding this round surfaced, and the one thing a
 * VOCABULARY guard structurally cannot catch.
 *
 * A cardinality certification is a test assertion that makes the app's OWN SUITE FAIL
 * if the contributed domain bundle is deleted or changes size. It is not "a test using
 * a domain id as an example input" (that is incidental, and there are hundreds); it is
 * the app's build depending on ONE domain bundle's cardinality or membership.
 *
 * WHY IT NEEDS ITS OWN MECHANISM, and why widening the scan set does NOT reach it:
 *
 *   1. The load-bearing text carries NO vocabulary token at all.
 *      `assert_eq!(reg.len(), lattice.len())` is a NUMERIC assertion. No noun, no
 *      datatype id, no acronym — a grep guard over the domain vocabulary is blind to
 *      it by construction. The audit found these by READING. Scanning the trees would
 *      not have found them, and pretending otherwise would be the same "green because
 *      we did not look" the last two rounds existed to stop.
 *   2. FOUR OF THE FOURTEEN ARE NOT IN THE TEST TREES.
 *      `datatype/tests/mod.rs` and `mcp/view_spec_actions.rs` are IN-SOURCE
 *      `#[cfg(test)]` — the compiler-enforced exemption round 3 kept, for a reason
 *      that remains sound (an INV-1/INV-3 argument about what the BINARY carries).
 *      But a cardinality certification is not an INV-3 violation: nothing ships. It is
 *      a BUILD-TIME COUPLING, and the shipping argument is simply irrelevant to it.
 *      So the answer is not to un-blank `#[cfg(test)]` — that re-opens the 633 code /
 *      180 prose / 69 literal hits round 3 measured and correctly declined, almost all
 *      of it a generic engine being tested against a concrete domain, which is what a
 *      generic engine's tests SHOULD do. The answer is a targeted, named ledger.
 *
 * MECHANISM — deliberately `MUST_SCAN_KEYS`, not something new: pin the certification
 * by FILE + a load-bearing ANCHOR string. If the anchor stops being present, the guard
 * FAILS and names the file, so a certification cannot be silently moved, renamed or
 * rewritten out from under the ledger. The list is SHRINK-ONLY by
 * `CARDINALITY_CERTIFICATION_CEILING`: removing one (by fixing it) is a two-line edit
 * here; ADDING one requires raising a constant, which is a reviewable admission that a
 * new test was pinned to a contributed bundle's size.
 *
 * ── WHAT THIS LEDGER ACTUALLY COVERS (WS-R5 — the previous claim was false) ─────────
 *
 * It used to open "MEASURED: FOURTEEN, not the three the round started from", which reads
 * as a census. It is not one, and the difference matters because every downstream reader
 * treated it as the population. What the ledger holds is FOURTEEN HAND-ASSEMBLED ANCHORS,
 * and it is incomplete inside its OWN declared scope in three specific, measured ways:
 *
 *   1. ONE ANCHOR PER FILE. The pin is (file, anchor), and the sweep recorded one per
 *      file — so a certification rewritten AROUND its anchor leaves every sibling in the
 *      same file live and green. ~30 un-anchored certifications were subsequently found
 *      INSIDE files this ledger already names: `qcSurface.test.ts` (+8),
 *      `cellFilterSurface.test.ts` (+12), `api_test.rs:72`, `sniff.rs:90,98`. That is a
 *      structural weakness in the mechanism, not a gap in one sweep.
 *   2. THE "CARDINALITY" FRAMING BIASES TOWARD `.len()`. The largest un-ledgered class is
 *      exact-VALUE and exact-ORDER-HEAD pins — `dataset/repository.rs:1381-1385` pins a
 *      value AND an order via `.first()` — which are just as bundle-coupled but carry no
 *      cardinal number, so they fall outside the ledger's own stated criterion. Six more
 *      were found beyond CARD-15, including a hardcoded 3-row table pinning the entire
 *      `open-kinds` package. CARD-15 itself is one of these: an exact ORDERED vector, not
 *      a count. The name has outlived its accuracy.
 *   3. IT IS A SAMPLE, NOT A POPULATION. Nothing in this file counts the population, so
 *      no number here can be a completeness claim. The honest statement is: fourteen
 *      certifications are PINNED; the true population is larger and unmeasured.
 *
 * The PREMISE still holds and is worth restating, because it is what justifies a
 * hand-assembled ledger at all: a vocabulary grep is structurally blind to these (see (1)
 * at the top of this comment — the load-bearing text carries no vocabulary token), so
 * there is no widening of the scan set that reaches them. What was wrong was the
 * EXECUTION — one-per-file, `.len()`-shaped, and presented as a measurement.
 *
 * NOT EXPANDED IN THIS COMMIT, deliberately. Growing the ledger to the full population is
 * a scoping decision for the owner, and an accurate statement of coverage is worth more
 * right now than a longer list assembled by the same method. A further ~16 SOFT membership
 * certifications (assert a domain id is PRESENT but tolerate additions) are recorded in
 * `domain-baseline.json`'s README rather than pinned here.
 *
 * Composition of the fourteen: four in-source `#[cfg(test)]` (R4-CARD-01..04 — plus
 * CARD-15, also in-source), four in `server/tests/**` (05..08), one in `ui/tests/**` (09;
 * 10 was RETIRED WS-R5, see below) and four `*.test.ts` under `ui/src` that the BASENAME
 * exemption hid (11..14).
 *
 * These are RECORDED, not FIXED. Fixing them is a later decision (see the ranked
 * worklist in `domain-baseline.json`'s README) — a certification is legitimate ONCE the
 * thing it certifies is derived from the manifest rather than hardcoded.
 */
const CARDINALITY_CERTIFICATIONS = [
  // ── in-source `#[cfg(test)]` — NOT reachable by the test-tree roots ────────
  // ── R4-CARD-01 — RETIRED (fix/zero-core-derived): FIXED, not moved, not re-anchored ──
  //
  // The entry was `server/src/modules/datatype/tests/mod.rs` + the anchor
  // `seed registry has a different type count than the golden lattice`, i.e.
  // `assert_eq!(reg.len(), lattice.len())` against a `lattice` array frozen inside
  // `lattice_golden.json`. It was the ledger's OWN example of the failure mode ("the
  // itemisation is ALREADY STALE while the assertion still passes — the clearest possible
  // demonstration that nobody was watching this coupling").
  //
  // It is retired on the FIXED branch, not the moved or rewritten one: there is no
  // replacement number anywhere. The `lattice` key is deleted from the fixture and the
  // expected type set is now DERIVED — the Rust roots UNION every declared
  // `contributes.datatypes[].id` across `src-app/packages/*/manifest.yaml`, compared as a
  // SET with per-id `extends`/`is_abstract`. So the app's build is no longer coupled to the
  // contributed bundle's CARDINALITY at all; it is coupled to its DECLARATION, which is the
  // disposition this ledger describes as legitimate. Contributing a datatype consequently
  // costs zero edits under `src-app/server/src/`, which the previous state made impossible.
  //
  // Two consequences worth stating because they are what the ledger is for:
  //   * the certification did not become weaker. A count cannot distinguish an added type
  //     from a removed one and cannot see a package that failed to LOAD; the derivation
  //     fails loudly on both.
  //   * this is a DUAL-LEDGER entry, so the Rust twin's `CERTIFICATION_CEILING` moves
  //     8 -> 7 in this same commit, exactly as the WS-R5 CARD-02 retirement did.
  //
  // Design: docs/design/derived-guards.md §4. Entry removed and
  // CARDINALITY_CERTIFICATION_CEILING lowered 12 -> 11 here, in the same commit.
  // ── R4-CARD-02 — RETIRED 2026-08-03, not re-anchored ──────────────────────
  //
  // The entry was `server/src/modules/mcp/view_spec_actions.rs` + the anchor
  // `equivalence_with_the_previously_baked_20_entries`. Its history in ONE round, because
  // both halves matter and the second overtook the first:
  //
  //   1. The test was RENAMED to `surviving_baked_entries_still_match_field_for_field`
  //      (the frozen `== 20` equality had discharged its purpose and would have failed on
  //      every honest view edit). That is a REWRITE, so the entry was re-anchored on an
  //      assertion message and the ceiling was deliberately NOT moved.
  //   2. The whole module was then DELETED — view-scoped capability registration moved out
  //      of the server, taking `view_spec_actions.rs`, `testdata/scanned_view_actions.json`
  //      and `testdata/baked_view_actions_before.json` with it.
  //
  // After (2) there is no certification left to pin: the app crate no longer scans
  // `packages/*/ui/*.yaml` for actions at all, so nothing in it can be coupled to that
  // bundle's SIZE. This is the ledger's documented "it was genuinely retired" branch —
  // entry removed, `CARDINALITY_CERTIFICATION_CEILING` lowered 14 -> 13 in the same commit,
  // and the Rust twin's `CERTIFICATION_CEILING` 9 -> 8 in lockstep (it held the same entry;
  // the two halves must agree or neither checks the other).
  //
  // Recorded at this length ON PURPOSE. A deletion is the one disposition that leaves no
  // trace in the ledger, and "the ledger became amnesia" is the failure this mechanism was
  // built against — the note is what stops a future reader concluding the pin was simply
  // lost. It was the ledger's own top-ranked retirement candidate ("a behaviour-preservation
  // proof for a migration that has landed … the most likely of the fourteen to be retirable
  // outright"), and it retired by its subject leaving rather than by being fixed.
  {
    // RE-ANCHORED (artifact-model ITEM-27), 5 -> 4, same reason and same commit as
    // R4-CARD-08 below. NOTE what this pair caught, because it is evidence for §1 of the
    // WS-R5 note above (ONE ANCHOR PER FILE): the REST-surface half moved with the
    // manifest and this in-source half did not, so `embedded_tree_builds` was FAILING
    // while its ledger anchor still matched exactly. The ledger cannot see a certification
    // it has not anchored, and it cannot see a certification going STALE either — only
    // one being moved out from under it.
    id: 'R4-CARD-03',
    file: 'server/src/modules/extensions/loader.rs',
    anchor: 'assert_eq!(conv.produces.len(), 4);',
    where: 'in-source #[cfg(test)]',
    note:
      'Over the REAL extracted seed folder: converters.len()==1, produces.len()==4, and ' +
      'conv.env == Some("single-cell"). Exact cardinality of ONE contributed manifest. ' +
      'Was 5 until artifact-model ITEM-27 removed the `single-cell/soma` output.',
  },
  {
    id: 'R4-CARD-04',
    file: 'server/src/modules/datatype/sniff.rs',
    anchor: 'assert_eq!(sniff(&r, "x.h5ad", b""), Some("single-cell/anndata".into()));',
    where: 'in-source #[cfg(test)]',
    note:
      'Over build_from_embedded(). The comment encodes the SORT ORDERING between two domain ids ' +
      '(`single-cell/anndata` < `single-cell/expression`), so adding a sniffable domain type ' +
      'breaks it; and `sniff("results.csv") == None` breaks if a csv-claiming type returns.',
  },
  // ── `server/tests/**` — IN the new serverTests root ────────────────────────
  {
    id: 'R4-CARD-05',
    file: 'server/tests/extensions/datatype_contribution_test.rs',
    anchor: 'all 15 domain types are covered by the parity table',
    where: 'server/tests/** (serverTests root)',
    note:
      'assert_eq!(table.len(), 15) over a HARDCODED 15-row parity table spelling out ' +
      'id/title/extends/ancestors/viewers/selectors/axes/caps for every single-cell type, ' +
      'verified against the merged registry. The single largest verbatim copy of the ' +
      'contributed lattice inside the app suite. artifact-model ITEM-38 moved it 15 -> 14 rows ' +
      '(one contributed type removed); the RUST twin re-anchored on the assertion message, ' +
      'while THIS anchor is the pre-WS-R5 sentence quoted in the surrounding comment and is ' +
      'therefore unaffected — the two ledgers pin different strings in the same file.',
  },
  {
    id: 'R4-CARD-06',
    file: 'server/tests/datatype/mod.rs',
    anchor: 'test22_merged_registry_reproduces_the_domain_lattice_no_regression',
    where: 'server/tests/** (serverTests root)',
    note:
      'A hardcoded 15-id domain list asserted present, 15 hardcoded is_a triples, and EXACT ' +
      'viewer lists (`vf("embedding") == ["embedding-scatter","matrix-grid","table"]`). The test ' +
      'NAME itself certifies a cardinality ("test22"), and the lattice is now 26.',
  },
  {
    id: 'R4-CARD-07',
    file: 'server/tests/extensions/api_test.rs',
    anchor: 'two primary + two supporting (cells/genes annotation) accepts',
    where: 'server/tests/** (serverTests root)',
    note:
      'assert_eq!(accepts.len(), 4) — exact cardinality of the contributed anndata-import ' +
      'manifest\'s accepts list, over the REST surface.',
  },
  // RE-ANCHORED (artifact-model ITEM-27). The anchor was `five declared produces entries`;
  // ITEM-27 deleted the TileDB-SOMA write, so `single-cell/soma` left the manifest's
  // `produces` list and the assertion became `assert_eq!(produces.len(), 4)`. The
  // certification was REWRITTEN, not FIXED — it is still an exact cardinality pinned to
  // the contributed bundle's size — so per this ledger's own instruction the entry is
  // re-anchored rather than removed, and the ceiling is untouched.
  //
  // The anchor deliberately keeps the NUMBER in it. A number-free anchor
  // (`assert_eq!(produces.len()`) would survive the count changing, and then the ledger
  // would stop noticing exactly the event it exists to surface: the contributed bundle's
  // cardinality moving under a test that hardcodes it. Re-anchoring on each such move is
  // the intended cost.
  {
    id: 'R4-CARD-08',
    file: 'server/tests/extensions/api_test.rs',
    anchor: 'four declared produces entries',
    where: 'server/tests/** (serverTests root)',
    note:
      'assert_eq!(produces.len(), 4) — the produces half of R4-CARD-07, and the REST-surface ' +
      'twin of R4-CARD-03. Listed separately because they are separate assertions that would be ' +
      'fixed separately. Was 5 until artifact-model ITEM-27 removed the `single-cell/soma` ' +
      'output (the transpose BUFFER, never a real product).',
  },
  // ── `ui/tests/**` — IN the new uiTests root ────────────────────────────────
  {
    id: 'R4-CARD-09',
    file: 'ui/tests/e2e/datatype/registry.spec.ts',
    anchor: 'golden parity failures',
    where: 'ui/tests/** (uiTests root)',
    note:
      'Replays the SHARED golden JSON in the browser: EXACT viewersFor list comparison plus ' +
      'is_a / accepts / layoutKind. It never read the `lattice` array in that fixture, so when ' +
      'fix/zero-core-derived deleted that array (retiring R4-CARD-01, above) this half was ' +
      'unaffected and stands alone — it pins CASES over the lattice, not the SIZE of it. ' +
      'This file is also a MUST_SCAN witness for the uiTests root.',
  },
  // ── R4-CARD-10 was HERE. RETIRED WS-R5: it was FIXED, not deferred. ────────
  //
  // It pinned `expect(results.csv.datatype).toBe('de')` — a hard membership claim on a
  // datatype that had been PRUNED from the lattice. The sibling workstream that fixed it
  // established something this round's §2 should be read alongside: the assertion was not
  // "green and wrong", it was UNRUN and wrong. Built and executed, the server returns
  // `null`, so `toBe('de')` fails outright and cannot have passed since the prune. The
  // divergence survived for rounds because the two enforcers sit on runners with different
  // COSTS — `cargo test` gets run, the Playwright suite does not — which is the same root
  // cause as "the guard runs in no CI workflow at all", seen from the other end. The fix
  // moved the FE-side check onto `cargo test` rather than leaving it in a suite nothing
  // invokes. Removing this entry is therefore a genuine shrink of the ledger; the CEILING
  // does not move because CARD-15 lands in the same commit (see the ceiling note).
  // ── `*.test.ts` under `ui/src` — the ex-BASENAME-exemption (uiSpecs root) ──
  {
    id: 'R4-CARD-11',
    file: 'ui/src/modules/workbench/core/runtime/qcSurface.test.ts',
    anchor: "expect(a.produces).toEqual(['metadata-column', 'report/qc'])",
    where: '*.test.ts under ui/src (uiSpecs root — was BASENAME-exempt)',
    note:
      'EXACT-SET equality against the produces list read out of the SHIPPED ' +
      '`packages/qc/manifest.yaml`. Invisible for the whole life of the guard purely because ' +
      'the file is named `*.test.ts`.',
  },
  // ── R4-CARD-12 — RETIRED (processor-manifest-ui-separation). GENUINELY retired. ──
  //
  // The entry was `ui/src/modules/workbench/core/runtime/qcSurface.test.ts` + the anchor
  // `['atac', 'prot', 'rna']`, an EXACT-SET equality over the contributed per-modality preset
  // families. It is the ledger's "it was FIXED" branch, not its "it was rewritten" one, and the
  // distinction is worth stating because the anchor text still occurs in the file:
  //
  //   1. The SUBJECT is gone. The contributed package no longer declares per-modality preset
  //      FAMILIES and the view no longer carries a modality picker or a `$state.modality` — the
  //      owner's question ("what if the modality is not in the list") had no answer, because the
  //      picked value became the emitted column prefix, so anything outside the three was
  //      silently mis-prefixed. The modality is now stamped by the importer into each matrix's
  //      own structure and read off the store; the view neither picks nor relays one.
  //   2. What survives in the file is the exact INVERSE assertion — the three names are bound
  //      once, as a set the spec proves NOTHING carries. A negative control over a retired
  //      vocabulary is not a certification of a contributed bundle's cardinality: it cannot fail
  //      when that bundle GROWS, which is the only event this ledger exists to notice. Re-
  //      anchoring on it would pin a permanent green.
  //
  // So: entry removed, CARDINALITY_CERTIFICATION_CEILING lowered 13 -> 12 in the same commit.
  // The Rust twin does NOT hold this entry (it is a frontend certification; the twin carries the
  // eight server-side ones), so its own CERTIFICATION_CEILING is deliberately UNCHANGED —
  // checked rather than assumed, because R4-CARD-15 was mis-handled this way earlier in this
  // very feature: a dual-ledger entry has TWO anchors and fixing one leaves the other dangling.
  // R4-CARD-13 REMOVED — the certification was FIXED, not lost. The exact-set equality it
  // pinned (`expect(a.produces).toEqual([...])` in `cellFilterSurface.test.ts`) broke `main`
  // the moment the analysis legitimately gained a QC report output. It is now asserted as a
  // PROPERTY — the produced set must contain the annotation column and must NOT contain the
  // datatype the analysis consumes, that datatype DERIVED from the analysis's own `appliesTo`
  // slot rather than restated. So the assertion no longer carries a domain literal at all,
  // which is why the entry goes away instead of being re-anchored.
  // Per this ledger's own rule: entry removed, CARDINALITY_CERTIFICATION_CEILING lowered
  // 12 -> 11 in the same commit.
  //
  // NOTE for whoever touches R4-CARD-14 next: it is the SAME shape, still live
  // (`toEqual(['single-cell/expression'])` in `launcherAvailability.test.ts`). It has not
  // broken yet only because that manifest key has not grown. Left alone deliberately here —
  // this commit exists to un-break `main`, not to re-open a second certification.
  {
    id: 'R4-CARD-14',
    file: 'ui/src/modules/workbench/extensions/analysis/launcherAvailability.test.ts',
    anchor: "toEqual(['single-cell/expression'])",
    where: '*.test.ts under ui/src (uiSpecs root — was BASENAME-exempt)',
    note:
      'EXACT-SET equality on missingInputs() against the shipped cell-filter manifest\'s accepts. ' +
      'Its sibling `nextSteps.test.ts` carries the same class ' +
      "(`producedSummary(qc) === 'metadata-column and report/qc'`, `analysisId === 'cell.filter'`) " +
      'and is baselined under R4-TESTS-UNIT rather than pinned here, to keep this ledger to ' +
      'ONE entry per distinct certification SHAPE.',
  },
  // ── WS-R5 — contributed by the CARD-10 fix workstream ─────────────────────
  {
    id: 'R4-CARD-15',
    file: 'server/src/modules/datatype/mod.rs',
    anchor: '("embedding", &["cells", "dims"], &["barcode", "dim_index"]),',
    where: 'in-source `#[cfg(test)]` — NOT reachable by any scan root',
    note:
      'An EXACT ORDERED vector of single-cell axis NAMES — the axis assumption ' +
      'DOMAIN_AUDIT §1 identifies as the root cause, asserted as a literal. A server ' +
      'certification, so it is pinned in BOTH ledgers (Rust CERTIFICATION_CEILING 8 -> 9). It ' +
      'is also a good example of the SHAPE problem stated in the header: it certifies exact ' +
      'VALUES and ORDER, not a count, so the word "cardinality" does not really describe it. ' +
      'RE-ANCHORED (processor-manifest-ui-separation, ITEM-12/13). The old anchor was ' +
      '`assert_eq!(names, vec!["cells", "genes"], "{id} carries the cells+genes axes inline")`, ' +
      'a single assertion over `single-cell/anndata` + `single-cell/matrix-mtx`. The axes moved ' +
      'ONTO the ANALYSABLE types, so the anchored test is now a ten-row table. Re-anchored ' +
      'rather than removed because the certification was WIDENED, not fixed: it went from 2 ' +
      'datatypes to 10, and the literals are still exact and still ordered. Recording it as ' +
      'fixed would have been the amnesia this ledger exists to prevent — and the widening is ' +
      'defensible only because `axes_for` is a FLAT lookup, so enumerating every subtype is ' +
      'what catches one silently losing its axes. ' +
      'NOTE CORRECTED (same feature, later commit): this note used to add that the two import ' +
      'formats "became OPAQUE import formats declaring no axes at all". The first half holds ' +
      '(they extend `data/opaque`); the second does NOT, and asserting it cost a working ' +
      'feature — `dataset/routes.rs` validates a supporting file\'s axis against ' +
      '`axes_for(dataset.datatype)`, which for an uploaded h5ad IS the container, so axis-less ' +
      'meant every attachment 422\'d (7 integration tests). Opacity (lattice position) and axis ' +
      'IDENTITY are now asserted independently, and the identity half — ' +
      '`import_format_primaries_are_opaque_but_still_declare_axis_identity`, carrying ' +
      '`assert_eq!(names, vec!["cells", "genes"], …)` — is the ORIGINAL anchor text, alive again ' +
      'in the same file and NOT pinned. A third instance of the ONE-ANCHOR-PER-FILE weakness §1 ' +
      'states; recorded here rather than minted as R4-CARD-16, because raising ' +
      'CARDINALITY_CERTIFICATION_CEILING is the owner\'s admission to make, not a triage pass\'s.',
  },
]

/**
 * SHRINK-ONLY. Adding a certification means raising this in the same commit.
 *
 * WS-R5 — STAYS AT 14, and the arithmetic is worth writing down because the guard's own
 * failure text does not cover this case. R4-CARD-10 was REMOVED (fixed) and R4-CARD-15 was
 * ADDED in the same commit: 14 - 1 + 1 = 14. The message on the anchor-missing path says
 * "remove this entry AND lower CARDINALITY_CERTIFICATION_CEILING in the same commit", which
 * is UNSATISFIABLE when a removal and an addition land together — lowering it would then
 * fail the length check the next line runs. Read the instruction as "the ledger may not GROW
 * silently": a net-zero swap needs no edit here, and the reviewable artefact is the pair of
 * entries, not the constant. Stating this beats leaving the next reader to conclude the
 * check misfired.
 */
// LOWERED 13 -> **12** (processor-manifest-ui-separation): R4-CARD-12 was RETIRED by its
// subject leaving — the contributed package stopped declaring per-modality preset families and
// the view stopped picking a modality, so there is no bundle cardinality left to pin. See the
// written-out retirement note in the list above; the ceiling moves in the SAME commit as the
// removal because nothing was added to offset it (unlike the WS-R5 net-zero swap described
// above, where a removal and an addition landed together and the constant correctly stood still).
// COUNT LOWERED 11 -> 10 (main, semantic merge repair). Two commits retired one
// certification each, independently and correctly: `d8d121e6` retired R4-CARD-13 and
// `fix/zero-core-derived` retired R4-CARD-01. Each was cut from a tree where the ceiling
// read 12, so each lowered it 12 -> 11 and BOTH wrote the literal `11`. git merged the two
// identical lines without a conflict, so two removals produced one decrement and the ceiling
// silently drifted one above the ledger. Neither commit was wrong; the counter was.
// This is why the count is asserted in three places (ledger, ceiling, test) rather than
// derived — but note the three-sided rule does NOT protect against this shape, because a
// textual merge of two equal edits is invisible to it. The `npm run check` twin below is
// what actually caught it.
const CARDINALITY_CERTIFICATION_CEILING = 10

/**
 * @returns {string[]} one message per certification whose anchor went missing, plus one
 * if the ledger grew past its ceiling.
 */
export function cardinalityCertificationViolations() {
  const out = []
  if (CARDINALITY_CERTIFICATIONS.length > CARDINALITY_CERTIFICATION_CEILING) {
    out.push(
      `CARDINALITY_CERTIFICATIONS has ${CARDINALITY_CERTIFICATIONS.length} entries, above the ` +
        `committed ceiling of ${CARDINALITY_CERTIFICATION_CEILING}. The ledger is SHRINK-ONLY.`,
    )
  }
  for (const c of CARDINALITY_CERTIFICATIONS) {
    const abs = path.join(SRC_APP, c.file)
    if (!existsSync(abs)) {
      out.push(
        `${c.id}: "${c.file}" no longer exists. A cardinality certification cannot be moved out ` +
          `from under this ledger silently — re-point the entry in the same commit as the move, ` +
          `or delete it if the certification was genuinely retired (and lower ` +
          `CARDINALITY_CERTIFICATION_CEILING).`,
      )
      continue
    }
    if (!readFileSync(abs, 'utf8').includes(c.anchor)) {
      out.push(
        `${c.id}: the anchor \`${c.anchor}\` is gone from "${c.file}". Either the certification ` +
          `was FIXED — remove this entry AND lower CARDINALITY_CERTIFICATION_CEILING in the same ` +
          `commit — or it was rewritten, in which case re-anchor it. Silently losing the anchor ` +
          `is how a ledger becomes amnesia.`,
      )
    }
  }
  return out
}

export function observationFloorViolations(observedNoun, observedProse, baselineEntries) {
  const out = []
  const check = (name, got, floor, what) => {
    if (got < floor) {
      out.push(
        `${name}: ${got} ${what}, below the committed floor of ${floor}. Either the scan set ` +
          `collapsed, or the noun vocabulary / letter-and-camel boundary / tokenizer stopped ` +
          `matching. A guard that suddenly sees NOTHING is broken, not green — this is the ` +
          `"scoped just narrowly enough to miss what it forbids" failure the WS-B round exists ` +
          `to stop. If the drop is real progress, lower OBSERVATION_FLOORS.${name} deliberately.`,
      )
    }
  }
  check('domainNoun', observedNoun, OBSERVATION_FLOORS.domainNoun, 'domain-noun hit(s) observed')
  check('domainProse', observedProse, OBSERVATION_FLOORS.domainProse, 'domain-prose hit(s) observed')
  check(
    'baselineEntries',
    baselineEntries,
    OBSERVATION_FLOORS.baselineEntries,
    'baselined code entries',
  )
  return out
}

export function runGuard() {
  let scanSet
  let counts = null
  let baselined = true
  const scanOverride = overrideEnv('LINT_NO_DOMAIN_SCAN_OVERRIDE')
  if (scanOverride) {
    scanSet = JSON.parse(scanOverride)
    // An override replaces the real tree, so neither the per-root floors nor the
    // baseline apply — they describe THIS repo, not a temp fixture.
    baselined = false
  } else {
    const d = defaultScanSet()
    scanSet = d.set
    counts = d.counts
  }
  const allFindings = []
  let scanned = 0
  for (const entry of scanSet) {
    const file = entry.path
    if (!existsSync(file) || !statSync(file).isFile()) continue
    if (isExemptFile(file)) continue
    scanned++
    allFindings.push(...scanFile(file, entry.lang, inNounScope(file, entry)))
  }

  const floors = counts ? floorViolations(counts) : []
  const packageDecls = counts ? packageDeclarationViolations() : []
  const mustScan = counts ? mustScanViolations(scanSet) : []
  const formatPins = counts ? formatCoveragePinViolations(scanSet) : []
  // WS-R5 G3 — the tree census reads the RESOLVED scan set, so it is meaningless
  // against a supplied fixture set; same `counts &&` gating as every other structural
  // check. WS-R5 G2 — the vocabulary derivation is NOT gated: a broken parse forbids
  // less in every mode, including a self-test, and a self-test that silently stopped
  // forbidding things would certify the wrong thing about its own fixtures.
  const treeDecls = counts ? treeDeclarationViolations(scanSet) : []
  const vocabulary = [
    ...contributedVocabularyViolations(),
    ...packageVocabularyViolations(),
    ...idStemVocabularyViolations(),
  ]

  // ── WS-R4: the findings SPLIT BY TIER before anything is counted ───────────
  //
  // WHY A SEPARATE NAMESPACE AND NOT THE EXISTING TIERS. Dumping the ~1900 test-tree
  // hits into `code`/`prose`/`literals` would have been one line of code and would
  // have destroyed the only three numbers in this guard that carry a hard meaning:
  //   * `LITERAL_HITS_CEILING` (69) says "this many hardcoded domain datatype ids
  //     SHIP". Folding 322 test literals in takes it to 391 and it now says nothing —
  //     an `assert_eq!(x, "single-cell/expression")` is a COUPLING, not a shipped
  //     dispatch, and they are not the same severity.
  //   * `OBSERVATION_FLOORS.domainNoun` (745) is a COLLAPSE detector for the
  //     PRODUCTION scan. Add ~1500 test hits to the same total and a total collapse
  //     of the production walk still clears the floor — which is verbatim the
  //     "a single collapsed root disappears into the total" failure `MUST_SCAN_KEYS`
  //     was invented for, reintroduced at the tier level.
  //   * `OBSERVATION_FLOORS.baselineEntries` (128) is the size of the production
  //     WORKLIST. Merging makes the worklist unreadable.
  // So the test tier gets its OWN baseline sections, its OWN floors and its OWN
  // ceiling, and a production regression stays visible at production scale.
  const prodFindings = allFindings.filter(f => !isTestTierFile(f.file))
  const testFindings = allFindings.filter(f => isTestTierFile(f.file))

  /** observed[kind][path][token] = count */
  const bucketize = list => {
    const out = { 'domain-noun': {}, 'domain-prose': {}, literal: {} }
    for (const f of list) {
      if (f.kind !== 'substring' && f.kind !== 'quoted-id' && f.kind !== 'quoted-title') continue
      const k = baselineKey(f.file)
      const tok = f.token.toLowerCase()
      out.literal[k] = out.literal[k] ?? {}
      out.literal[k][tok] = (out.literal[k][tok] ?? 0) + 1
    }
    for (const f of list) {
      // WS-R7 — the PACKAGE tier shares the noun tiers' baseline SECTIONS (its
      // dispositions and its ratchet are identical) while keeping its own KIND, so the
      // lattice-measured `OBSERVATION_FLOORS` totals below are untouched by it.
      const bucket = out[PACKAGE_KIND_BUCKET[f.kind] ?? ID_STEM_KIND_BUCKET[f.kind] ?? f.kind]
      if (!bucket) continue
      const k = baselineKey(f.file)
      const tok = f.token.toLowerCase()
      bucket[k] = bucket[k] ?? {}
      bucket[k][tok] = (bucket[k][tok] ?? 0) + 1
    }
    return out
  }
  const observed = bucketize(prodFindings)
  const observedTest = bucketize(testFindings)
  const totalNoun = prodFindings.filter(f => f.kind === 'domain-noun').length
  const totalProse = prodFindings.filter(f => f.kind === 'domain-prose').length
  const testTotalNoun = testFindings.filter(f => f.kind === 'domain-noun').length
  const testTotalProse = testFindings.filter(f => f.kind === 'domain-prose').length

  const baselineErrors = []
  let findings = allFindings
  let baseline = { code: {}, prose: {} }
  let observationFloors = []
  if (baselined) {
    baseline = loadBaseline()

    // ── CODE tier: per (file, token) counts, each carrying a finding id ──
    /** @type {Record<string, Record<string, number>>} budget consumed while filtering */
    const budget = {}
    let baselineEntries = 0
    for (const [k, toks] of Object.entries(baseline.code)) {
      budget[k] = {}
      for (const [tok, spec] of Object.entries(toks)) {
        const want = typeof spec === 'number' ? spec : spec.count
        const finding = typeof spec === 'number' ? undefined : spec.finding
        baselineEntries++
        budget[k][tok] = want
        // WS-C — `RESIDUE` is RETIRED. It was the "real domain vocabulary, not
        // individually triaged" bucket: 9 entries / 37 hits / 6 files, the only
        // sizeable pocket of domain surface with no owner and no decision. All
        // nine were triaged (2 → the new W8, 1 → W5, 1 → W9, 3 → DEC-M/FALSE-
        // POSITIVE on the project-repository SQL, 27 hits → FALSE-POSITIVE grid
        // cells). The tag is now REJECTED so the bucket cannot refill: a new
        // leak gets a finding id, or a stated non-finding tag, or a fix.
        if (finding === 'RESIDUE') {
          baselineErrors.push(
            `domain-baseline.json code["${k}"]["${tok}"] is tagged RESIDUE — that tag is RETIRED ` +
              `(WS-C triaged the last nine). Give this entry a real disposition: a DOMAIN_AUDIT ` +
              `finding id, or FALSE-POSITIVE / GENERIC / DEC-* with the usage cited, or fix it.`,
          )
        }
        if (!finding) {
          baselineErrors.push(
            `domain-baseline.json code["${k}"]["${tok}"] has no \`finding\` — every baselined ` +
              `leak must name its DOMAIN_AUDIT id (E1-E6 / C1-C8 / S1-S11 / B1-B3) or an explicit ` +
              `non-finding tag (DEC-J / DEC-M / FALSE-POSITIVE / GENERIC). Without one the ` +
              `baseline is amnesia, not a worklist.`,
          )
        }
        const got = observed['domain-noun'][k]?.[tok] ?? 0
        if (got < want) {
          baselineErrors.push(
            `domain-baseline.json code["${k}"]["${tok}"] = ${want} but only ${got} remain — STALE. ` +
              `Run \`node scripts/lint-no-domain-in-builtin.mjs --prune-baseline\` in this commit: ` +
              `the residue may only shrink DELIBERATELY.`,
          )
        }
      }
    }
    // ── PROSE tier: per (file, TOKEN) counts — WS-R3 §4 ───────────────────────
    //
    // It used to be a per-FILE TOTAL, decremented WITHOUT inspecting the token, unlike
    // the code tier three lines up. That made 1268 hits across 168 files FUNGIBLE: any
    // file with an existing entry could absorb a brand-new leak of a DIFFERENT token
    // for free, as long as the file's total did not rise. Worst offenders were exactly
    // the files where that matters most — `workstore/data_api.rs` (104),
    // `api-client/types.ts` (74, GENERATED: regenerated wholesale, so a new domain
    // doc-comment in a backend type lands here and is absorbed silently) and
    // `workbench/.../canvasBinding.ts` (69).
    //
    // The shape is therefore `{ tokens: {tok: n, …}, finding?, note? }`, with
    // `finding`/`note` staying at FILE level (a prose rationale is about the file, and
    // duplicating it per token would be noise). The old bare-number and
    // `{count, finding, note}` spellings are REJECTED outright rather than
    // grandfathered: a fungible entry is the bug, so leaving a fungible spelling
    // readable would leave the hole open.
    /** @type {Record<string, Record<string, number>>} */
    const proseBudget = {}
    let bareProseEntries = 0
    for (const [k, spec] of Object.entries(baseline.prose)) {
      if (typeof spec === 'number' || !spec.tokens) {
        baselineErrors.push(
          `domain-baseline.json prose["${k}"] is in the RETIRED per-file-total form. The prose ` +
            `tier is per (file, TOKEN) as of WS-R3: use ` +
            `{"tokens": {"<token>": <count>}, "finding": …, "note": …}. A per-file total is ` +
            `FUNGIBLE — it lets this file absorb a brand-new leak of a different token for free.`,
        )
        continue
      }
      if (!spec.finding) bareProseEntries++
      if (spec.finding === 'RESIDUE') {
        baselineErrors.push(
          `domain-baseline.json prose["${k}"] is tagged RESIDUE — that tag is RETIRED (WS-C). ` +
            `Give it a real disposition.`,
        )
      }
      proseBudget[k] = {}
      for (const [tok, want] of Object.entries(spec.tokens)) {
        proseBudget[k][tok] = want
        const got = observed['domain-prose'][k]?.[tok] ?? 0
        if (got < want) {
          baselineErrors.push(
            `domain-baseline.json prose["${k}"].tokens["${tok}"] = ${want} but only ${got} ` +
              `remain — STALE. Run \`--prune-baseline\` in this commit.`,
          )
        }
      }
    }
    // The bare-number form is GRANDFATHERED, not open. Without a ceiling the
    // `finding` requirement above is opt-in — a new leak could be baselined as a
    // bare number and skip the reason entirely. The count may only go DOWN
    // (`--prune-baseline` removing a fixed entry); anything NEW has to be explained.
    if (bareProseEntries > BARE_PROSE_CEILING) {
      baselineErrors.push(
        `domain-baseline.json has ${bareProseEntries} UNEXPLAINED prose entries (no \`finding\`), ` +
          `above the committed ceiling of ${BARE_PROSE_CEILING} (the 2026-07-28 bulk record, ` +
          `carried through the WS-R3 per-token migration). A prose entry added or raised since ` +
          `then must carry a \`finding\` — the unexplained form is grandfathered, not an escape ` +
          `hatch.`,
      )
    }

    // ── LITERAL tier: the HARD INV-3 kinds, under a shrink-only CEILING ──
    /** @type {Record<string, Record<string, number>>} */
    const literalBudget = {}
    let literalHits = 0
    for (const [k, toks] of Object.entries(baseline.literals ?? {})) {
      literalBudget[k] = {}
      for (const [tok, spec] of Object.entries(toks)) {
        const want = typeof spec === 'number' ? spec : spec.count
        const finding = typeof spec === 'number' ? undefined : spec.finding
        literalBudget[k][tok] = want
        literalHits += want
        if (!finding) {
          baselineErrors.push(
            `domain-baseline.json literals["${k}"]["${tok}"] has no \`finding\` — a hardcoded ` +
              `domain datatype LITERAL is the hardest INV-3 violation there is; recording one ` +
              `without naming it is not a ledger.`,
          )
        }
        const got = observed.literal[k]?.[tok] ?? 0
        if (got < want) {
          baselineErrors.push(
            `domain-baseline.json literals["${k}"]["${tok}"] = ${want} but only ${got} remain — ` +
              `STALE. Run \`--prune-baseline\` in this commit AND lower LITERAL_HITS_CEILING.`,
          )
        }
      }
    }
    if (literalHits > LITERAL_HITS_CEILING) {
      baselineErrors.push(
        `domain-baseline.json records ${literalHits} literal hit(s), above the committed ceiling ` +
          `of ${LITERAL_HITS_CEILING}. The literal tier is SHRINK-ONLY: a new hardcoded datatype ` +
          `id must be removed, not baselined. Raising this constant is an explicit admission.`,
      )
    }

    // ── WS-R4: the TEST tier, ratcheted in its OWN namespace ─────────────────
    //
    // Same three sub-tiers, same per-(file,token) shape, same shrink-only
    // semantics, same `finding`-is-mandatory rule — deliberately identical
    // discipline, so a reader who knows the production ledger knows this one.
    // What differs is only the CALIBRATION (its own floors + its own ceiling)
    // and one rule that is STRICTER: there is no grandfathered bare-prose
    // allowance. Every entry here was created in one commit, so every entry can
    // carry a `finding`, and `TEST_BARE_PROSE_CEILING` is 0.
    const testBudget = {}
    const testProseBudget = {}
    const testLiteralBudget = {}
    let testBaselineEntries = 0
    let testLiteralHits = 0
    let testBareProseEntries = 0
    for (const [k, toks] of Object.entries(baseline.testCode ?? {})) {
      testBudget[k] = {}
      for (const [tok, spec] of Object.entries(toks)) {
        const want = typeof spec === 'number' ? spec : spec.count
        const finding = typeof spec === 'number' ? undefined : spec.finding
        testBaselineEntries++
        testBudget[k][tok] = want
        if (!finding) {
          baselineErrors.push(
            `domain-baseline.json testCode["${k}"]["${tok}"] has no \`finding\` — every baselined ` +
              `test-tree leak must name its R4-TESTS-* id (…-RS / -FIXTURE / -E2E / -UNIT / ` +
              `-SUPPORT / -CARD). Without one the test ledger is amnesia, not a worklist.`,
          )
        }
        const got = observedTest['domain-noun'][k]?.[tok] ?? 0
        if (got < want) {
          baselineErrors.push(
            `domain-baseline.json testCode["${k}"]["${tok}"] = ${want} but only ${got} remain — ` +
              `STALE. Run \`--prune-baseline\` in this commit: the residue may only shrink ` +
              `DELIBERATELY, in the test tier exactly as in the production tier.`,
          )
        }
      }
    }
    for (const [k, spec] of Object.entries(baseline.testProse ?? {})) {
      if (typeof spec === 'number' || !spec.tokens) {
        baselineErrors.push(
          `domain-baseline.json testProse["${k}"] must be ` +
            `{"tokens": {"<token>": <count>}, "finding": …}. A per-file total is FUNGIBLE — it ` +
            `lets this file absorb a brand-new leak of a different token for free.`,
        )
        continue
      }
      if (!spec.finding) testBareProseEntries++
      testProseBudget[k] = {}
      for (const [tok, want] of Object.entries(spec.tokens)) {
        testProseBudget[k][tok] = want
        const got = observedTest['domain-prose'][k]?.[tok] ?? 0
        if (got < want) {
          baselineErrors.push(
            `domain-baseline.json testProse["${k}"].tokens["${tok}"] = ${want} but only ${got} ` +
              `remain — STALE. Run \`--prune-baseline\` in this commit.`,
          )
        }
      }
    }
    if (testBareProseEntries > TEST_BARE_PROSE_CEILING) {
      baselineErrors.push(
        `domain-baseline.json has ${testBareProseEntries} UNEXPLAINED testProse entries (no ` +
          `\`finding\`), above the committed ceiling of ${TEST_BARE_PROSE_CEILING}. The test tier ` +
          `has NO grandfathered bulk record to protect — it was created in one commit — so every ` +
          `entry must say which R4-TESTS-* hole surfaced it.`,
      )
    }
    for (const [k, toks] of Object.entries(baseline.testLiterals ?? {})) {
      testLiteralBudget[k] = {}
      for (const [tok, spec] of Object.entries(toks)) {
        const want = typeof spec === 'number' ? spec : spec.count
        const finding = typeof spec === 'number' ? undefined : spec.finding
        testLiteralBudget[k][tok] = want
        testLiteralHits += want
        if (!finding) {
          baselineErrors.push(
            `domain-baseline.json testLiterals["${k}"]["${tok}"] has no \`finding\` — a test ` +
              `asserting on a hardcoded domain datatype id is the COUPLING this round exists to ` +
              `surface; recording one without naming it is not a ledger.`,
          )
        }
        const got = observedTest.literal[k]?.[tok] ?? 0
        if (got < want) {
          baselineErrors.push(
            `domain-baseline.json testLiterals["${k}"]["${tok}"] = ${want} but only ${got} ` +
              `remain — STALE. Run \`--prune-baseline\` in this commit AND lower ` +
              `TEST_LITERAL_HITS_CEILING.`,
          )
        }
      }
    }
    if (testLiteralHits > TEST_LITERAL_HITS_CEILING) {
      baselineErrors.push(
        `domain-baseline.json records ${testLiteralHits} TEST literal hit(s), above the committed ` +
          `ceiling of ${TEST_LITERAL_HITS_CEILING}. Shrink-only: a NEW test asserting on a ` +
          `hardcoded domain datatype id must be written against a capability or a fixture-derived ` +
          `id instead, not baselined. Raising this constant is an explicit admission.`,
      )
    }

    findings = allFindings.filter(f => {
      const k = baselineKey(f.file)
      // WS-R4 — dispatch on TIER. A test-tree finding is ratcheted against the
      // `test*` sections; a production finding against the production ones. The two
      // budgets never see each other, which is the whole point of the split.
      const isTest = isTestTierFile(f.file)
      const codeB = isTest ? testBudget : budget
      const proseB = isTest ? testProseBudget : proseBudget
      const litB = isTest ? testLiteralBudget : literalBudget
      if (f.kind === 'substring' || f.kind === 'quoted-id' || f.kind === 'quoted-title') {
        const tok = f.token.toLowerCase()
        if ((litB[k]?.[tok] ?? 0) > 0) {
          litB[k][tok]--
          return false
        }
        return true
      }
      // WS-R7 — `package-id` ratchets against the CODE budget and `package-prose`
      // against the PROSE one, per the shared-sections decision in `bucketize`.
      if (f.kind === 'domain-noun' || f.kind === 'package-id' || f.kind === 'id-stem') {
        const tok = f.token.toLowerCase()
        if ((codeB[k]?.[tok] ?? 0) > 0) {
          codeB[k][tok]--
          return false
        }
        return true
      }
      if (f.kind === 'domain-prose' || f.kind === 'package-prose') {
        const tok = f.token.toLowerCase()
        if ((proseB[k]?.[tok] ?? 0) > 0) {
          proseB[k][tok]--
          return false
        }
        return true
      }
      return true
    })

    // WS-R5 §4 + §H/A — the ledger's SIZE, its DISPOSITION VOCABULARY and the FRESHNESS
    // of its arguments. All three are properties of the committed baseline, so they run
    // only in the baselined mode, alongside the per-entry ratchet they complete.
    baselineErrors.push(...baselineAdmissionViolations(baseline))
    baselineErrors.push(...rationaleFreshnessViolations(baseline))

    observationFloors = observationFloorViolations(totalNoun, totalProse, baselineEntries)
    observationFloors.push(
      ...testObservationFloorViolations(testTotalNoun, testTotalProse, testBaselineEntries),
    )
    baselineErrors.push(...cardinalityCertificationViolations())
  }

  return {
    scanned,
    overridden: Boolean(scanOverride),
    admission: overrideAdmissionViolations(),
    scanVolume: scanVolumeViolations(scanned, Boolean(scanOverride)),
    findings,
    floors,
    packageDecls,
    treeDecls,
    vocabulary,
    mustScan,
    formatPins,
    baselineErrors,
    observationFloors,
    observed,
    observedTest,
    counts,
    totals: { domainNoun: totalNoun, domainProse: totalProse },
    testTotals: { domainNoun: testTotalNoun, domainProse: testTotalProse },
    baseline,
  }
}

/**
 * `--prune-baseline` — the SHRINK-ONLY updater. It lowers (or deletes) entries
 * whose residue has gone down and NEVER raises or adds one: a new leak still has
 * to be argued for by hand, with a finding id. That asymmetry is what keeps the
 * file a ratchet instead of a rubber stamp, while letting the four workstreams
 * that are actually FIXING these leaks re-green the gate mechanically.
 */
function pruneBaseline() {
  const { observed, observedTest } = runGuard()
  const raw = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
  let lowered = 0
  let removed = 0
  for (const [k, toks] of Object.entries(raw.code ?? {})) {
    for (const [tok, spec] of Object.entries(toks)) {
      const want = typeof spec === 'number' ? spec : spec.count
      const got = observed['domain-noun'][k]?.[tok] ?? 0
      if (got >= want) continue
      if (got === 0) {
        delete toks[tok]
        removed++
      } else {
        if (typeof spec === 'number') toks[tok] = got
        else spec.count = got
        lowered++
      }
    }
    if (Object.keys(toks).length === 0) delete raw.code[k]
  }
  // WS-R4 — the TEST tier prunes exactly like the production tier, against its OWN
  // observation. A shared pruner over a merged observation would silently move a
  // production entry's residue into a test entry and vice versa; the two never mix.
  for (const [k, toks] of Object.entries(raw.testCode ?? {})) {
    for (const [tok, spec] of Object.entries(toks)) {
      const want = typeof spec === 'number' ? spec : spec.count
      const got = observedTest['domain-noun'][k]?.[tok] ?? 0
      if (got >= want) continue
      if (got === 0) {
        delete toks[tok]
        removed++
      } else {
        if (typeof spec === 'number') toks[tok] = got
        else spec.count = got
        lowered++
      }
    }
    if (Object.keys(toks).length === 0) delete raw.testCode[k]
  }
  for (const [k, toks] of Object.entries(raw.testLiterals ?? {})) {
    for (const [tok, spec] of Object.entries(toks)) {
      const want = typeof spec === 'number' ? spec : spec.count
      const got = observedTest.literal[k]?.[tok] ?? 0
      if (got >= want) continue
      if (got === 0) {
        delete toks[tok]
        removed++
      } else {
        if (typeof spec === 'number') toks[tok] = got
        else spec.count = got
        lowered++
      }
    }
    if (Object.keys(toks).length === 0) delete raw.testLiterals[k]
  }
  for (const [k, spec] of Object.entries(raw.testProse ?? {})) {
    if (typeof spec === 'number' || !spec.tokens) continue
    for (const [tok, want] of Object.entries(spec.tokens)) {
      const got = observedTest['domain-prose'][k]?.[tok] ?? 0
      if (got >= want) continue
      if (got === 0) {
        delete spec.tokens[tok]
        removed++
      } else {
        spec.tokens[tok] = got
        lowered++
      }
    }
    if (Object.keys(spec.tokens).length === 0) delete raw.testProse[k]
  }
  for (const [k, toks] of Object.entries(raw.literals ?? {})) {
    for (const [tok, spec] of Object.entries(toks)) {
      const want = typeof spec === 'number' ? spec : spec.count
      const got = observed.literal[k]?.[tok] ?? 0
      if (got >= want) continue
      if (got === 0) {
        delete toks[tok]
        removed++
      } else {
        if (typeof spec === 'number') toks[tok] = got
        else spec.count = got
        lowered++
      }
    }
    if (Object.keys(toks).length === 0) delete raw.literals[k]
  }
  // WS-R3 — the prose tier is per (file, token), so prune it per token, exactly
  // like the code tier. Lowering an EXPLAINED entry keeps its `finding` + `note`:
  // the reason the residue is retained does not stop being true because some of it
  // was fixed.
  for (const [k, spec] of Object.entries(raw.prose ?? {})) {
    if (typeof spec === 'number' || !spec.tokens) continue // retired form; reported, not pruned
    for (const [tok, want] of Object.entries(spec.tokens)) {
      const got = observed['domain-prose'][k]?.[tok] ?? 0
      if (got >= want) continue
      if (got === 0) {
        delete spec.tokens[tok]
        removed++
      } else {
        spec.tokens[tok] = got
        lowered++
      }
    }
    if (Object.keys(spec.tokens).length === 0) delete raw.prose[k]
  }
  writeFileSync(BASELINE_PATH, `${JSON.stringify(raw, null, 2)}\n`)
  console.log(`✓ domain-baseline.json pruned: ${lowered} entr(ies) lowered, ${removed} removed.`)
  console.log(`  NOTHING was raised or added — a NEW leak must still be argued for by hand.`)
}

function main() {
  // WS-R5 §1 — the admission check runs BEFORE anything else, including
  // `--prune-baseline`: an inadmissible `LINT_NO_DOMAIN_BASELINE_OVERRIDE` must not get
  // as far as a `writeFileSync`, and a run that was told to substitute its subject must
  // not report a result about the tree it actually read either.
  const admission = overrideAdmissionViolations()
  if (admission.length > 0) {
    console.error(`\n✖ no-domain-in-builtin: an INADMISSIBLE override (WS-R5 §1 fail-closed).\n`)
    for (const m of admission) console.error(`  ${m}`)
    console.error('')
    process.exit(1)
  }
  if (process.argv.includes('--prune-baseline')) {
    pruneBaseline()
    return
  }
  const {
    scanned,
    overridden,
    scanVolume,
    findings,
    floors,
    packageDecls,
    treeDecls,
    vocabulary,
    mustScan,
    formatPins,
    baselineErrors,
    observationFloors,
    totals,
    testTotals,
    baseline,
    counts,
  } = runGuard()
  const rootForRel = process.cwd()
  // Every category is reported in ONE run — a guard that stops at the first
  // problem sends you round the loop once per problem.
  let failed = false
  if (scanVolume.length > 0) {
    failed = true
    console.error(`\n✖ no-domain-in-builtin: the run scanned (near-)NOTHING (WS-R5 §1).\n`)
    for (const m of scanVolume) console.error(`  ${m}`)
    console.error('')
  }
  if (floors.length > 0) {
    failed = true
    console.error(`\n✖ no-domain-in-builtin: the scan set COLLAPSED (ITEM-37 fail-closed).\n`)
    for (const m of floors) console.error(`  ${m}`)
    console.error('')
  }
  if (vocabulary && vocabulary.length > 0) {
    failed = true
    console.error(
      `\n✖ no-domain-in-builtin: the FORBIDDEN VOCABULARY could not be derived (WS-R5 G2).\n`,
    )
    for (const m of vocabulary) console.error(`  ${m}`)
    console.error('')
  }
  if (packageDecls && packageDecls.length > 0) {
    failed = true
    console.error(`\n✖ no-domain-in-builtin: an UNDECLARED package (WS-C).\n`)
    for (const m of packageDecls) console.error(`  ${m}`)
    console.error('')
  }
  if (treeDecls && treeDecls.length > 0) {
    failed = true
    console.error(`\n✖ no-domain-in-builtin: an UNDECLARED tree (WS-R5 G3 census).\n`)
    for (const m of treeDecls) console.error(`  ${m}`)
    console.error('')
  }
  if (mustScan && mustScan.length > 0) {
    failed = true
    console.error(`\n✖ no-domain-in-builtin: a root's MUST_SCAN witness went missing (WS-R3 §4).\n`)
    for (const m of mustScan) console.error(`  ${m}`)
    console.error('')
  }
  if (formatPins && formatPins.length > 0) {
    failed = true
    console.error(
      `\n✖ no-domain-in-builtin: a root stopped covering a FORMAT (round-4 FORMAT_COVERAGE_PINS).\n`,
    )
    for (const m of formatPins) console.error(`  ${m}`)
    console.error('')
  }
  if (observationFloors.length > 0) {
    failed = true
    console.error(
      `\n✖ no-domain-in-builtin: the guard stopped MATCHING (WS-B positive-count fail-closed).\n`,
    )
    for (const m of observationFloors) console.error(`  ${m}`)
    console.error('')
  }
  if (baselineErrors.length > 0) {
    failed = true
    console.error(`\n✖ no-domain-in-builtin: the domain baseline is out of date.\n`)
    for (const m of baselineErrors) console.error(`  ${m}`)
    console.error('')
  }
  if (findings.length === 0 && failed) process.exit(1)
  if (findings.length > 0) {
    const code = findings.filter(f => f.kind !== 'domain-prose' && f.kind !== 'package-prose')
    const prose = findings.filter(f => f.kind === 'domain-prose' || f.kind === 'package-prose')
    console.error(
      `\n✖ no-domain-in-builtin: ${findings.length} domain finding(s) outside the committed baseline` +
        ` (${code.length} in code, ${prose.length} in prose).\n` +
        `  The domain lattice is DATA (packages/single-cell-types/manifest.yaml); the app must carry ZERO of it.\n` +
        `  A leak that is KNOWN belongs in scripts/domain-baseline.json with its DOMAIN_AUDIT finding id — not in the code.\n`,
    )
    for (const f of findings) {
      const rel = path.relative(rootForRel, f.file)
      console.error(`  ${rel}:${f.line}:${f.col}  [${f.kind}]  ${f.token}`)
    }
    console.error('')
    process.exit(1)
  }
  // WS-R5 §1 — a SELF-TEST green may never look like a REPOSITORY green. Under an
  // admitted override the floors, the pins, the certifications and the baseline are all
  // out of the picture by construction, so the ✓ below is a statement about a temp
  // fixture and nothing else. Say so, on stderr, unmissably.
  if (overridden) {
    console.error(
      `⚠ ${SELFTEST_ENV_NAME} MODE — the scan set was SUPPLIED, not discovered. ` +
        `Floors, MUST_SCAN witnesses, format pins, the certification ledger and the ` +
        `baseline ratchet are all inert. This run certifies NOTHING about the repository.`,
    )
  }
  const codeEntries = Object.values(baseline.code).reduce((a, o) => a + Object.keys(o).length, 0)
  const literalHits = Object.values(baseline.literals ?? {}).reduce(
    (a, o) => a + Object.values(o).reduce((x, s) => x + (typeof s === 'number' ? s : s.count), 0),
    0,
  )
  console.log(
    `✓ no-domain-in-builtin: ${scanned} app-builtin file(s) scanned; domain datatype LITERALS ` +
      `(INV-1/INV-2/INV-3) = ${literalHits}, all recorded + shrink-only ` +
      `(ceiling ${LITERAL_HITS_CEILING}).`,
  )
  console.log(
    `  roots: ${Object.entries(counts ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')}  (packages scanned: ${SCANNED_PACKAGES.join(',') || 'none'}; ` +
      `carved out: ${Object.keys(UNSCANNED_PACKAGES).join(',') || 'none'})`,
  )
  console.log(
    `  nouns [${DOMAIN_NOUNS.length} tokens, letter+camel boundary; ` +
      `${ACRONYM_NOUNS.length} acronyms, case-sensitive non-alnum boundary] over code AND prose, ` +
      `the whole Rust tree + the whole FE tree:`,
  )
  console.log(
    `    ${totals.domainNoun} code hit(s) / ${totals.domainProse} prose hit(s) observed — ` +
      `ALL inside the committed baseline (${codeEntries} code entr(ies) in ` +
      `${Object.keys(baseline.code).length} file(s), ${Object.keys(baseline.prose).length} prose file(s)).`,
  )
  // ── WS-R4 — the TEST tier is reported SEPARATELY, on purpose ───────────────
  // A merged line would let a production regression hide inside a four-figure test
  // total, which is the whole reason the tiers are split. Printing both makes the
  // relative scale of the two ledgers impossible to miss.
  const testCodeEntries = Object.values(baseline.testCode ?? {}).reduce(
    (a, o) => a + Object.keys(o).length,
    0,
  )
  const testLiteralHits = Object.values(baseline.testLiterals ?? {}).reduce(
    (a, o) => a + Object.values(o).reduce((x, sp) => x + (typeof sp === 'number' ? sp : sp.count), 0),
    0,
  )
  console.log(
    `  TEST tier [WS-R4: server/tests, ui/tests, *.{test,spec}.*, __fixtures__/__testutil__] — ` +
      `its OWN baseline + floors + ceiling, never merged with production:`,
  )
  console.log(
    `    ${testTotals.domainNoun} code hit(s) / ${testTotals.domainProse} prose hit(s) / ` +
      `${testLiteralHits} datatype LITERAL(s) (ceiling ${TEST_LITERAL_HITS_CEILING}) — ALL inside ` +
      `the committed baseline (${testCodeEntries} testCode entr(ies) in ` +
      `${Object.keys(baseline.testCode ?? {}).length} file(s), ` +
      `${Object.keys(baseline.testProse ?? {}).length} testProse file(s)).`,
  )
  console.log(
    `    exact-cardinality certifications pinned: ${CARDINALITY_CERTIFICATIONS.length} ` +
      `(ceiling ${CARDINALITY_CERTIFICATION_CEILING}, shrink-only) — see CARDINALITY_CERTIFICATIONS.`,
  )
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
