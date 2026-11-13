#!/usr/bin/env node
/**
 * ai-actions ITEM-10 — completeness gate: "references-a-real-action" lint.
 *
 * Scans `src/**` for every place UI code REFERENCES an action id —
 * `<ActionButton action="X">` / `action={'X'}` and `runAction('X', ...)` /
 * `runAction("X", ...)` — and HARD-FAILS (non-zero exit) if any referenced id
 * is not a REGISTERED `defineAction` id (catches dangling/typo'd ids: a
 * button wired to an action that was renamed or never registered).
 *
 * The set of REGISTERED ids is read the same way `collect-actions.mjs` does
 * (DEC-7 / B6: no `.lifecycle/` reads) — bundle every `defineAction(...)`
 * call-site with esbuild into a throwaway Node ESM module, execute it for
 * real, and read the ids back off `getActionRegistry()`. This script keeps
 * its own copy of that machinery (see the module comment on
 * `collectRegisteredActionIds` below) rather than importing from
 * `collect-actions.mjs`, which exposes no importable API (it is a
 * `main()`-only CLI script) — see PLAN.md ITEM-10 / "Patterns to follow".
 *
 * A reference whose id is NOT a string literal (e.g. `action={someVar}` or
 * `runAction(actionId, ...)`) is NOT statically decidable, so it is reported
 * as SKIPPED (informational) rather than failed — see DEC-6.
 *
 * Usage:
 *   node scripts/action-refs-lint.mjs
 *
 * Test-only overrides (used by `action-refs-lint.test.mjs` to point the lint
 * at self-contained temp fixtures instead of the real project — never set
 * these in normal use):
 *   ACTION_REFS_LINT_SRC_ROOT   — replaces `<ui>/src` as the scan root (both
 *                                 for finding `defineAction` registrations
 *                                 AND for finding action-id references)
 *   ACTION_REFS_LINT_MIN_SOURCE_FILES
 *                               — lowers the ITEM-37 scan floor so a tiny synthetic
 *                                 fixture can exercise the RULES. The floor itself is
 *                                 proved by `guard-floors.test.mjs`, which leaves this
 *                                 UNSET.
 */

import { build } from 'esbuild'
import { readFileSync, readdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Always the REAL `src-app/ui` directory (this script's parent) — same
// rationale as `collect-actions.mjs`'s `UI_ROOT`: the throwaway bundle file
// must live somewhere with a real `node_modules` in its ancestry so bare
// imports (`zod`, ...) resolve, even when `ACTION_REFS_LINT_SRC_ROOT` points
// at an unrelated temp-dir fixture.
const UI_ROOT = path.resolve(__dirname, '..')

const SRC_ROOT = process.env.ACTION_REFS_LINT_SRC_ROOT
  ? path.resolve(process.env.ACTION_REFS_LINT_SRC_ROOT)
  : path.join(UI_ROOT, 'src')

const TSCONFIG_PATH = path.join(UI_ROOT, 'tsconfig.json')
const DEFINE_ACTION_PATH = path.join(SRC_ROOT, 'core', 'actions', 'defineAction.ts')

/** Recursively list every `.ts`/`.tsx` file under `dir` (skips
 *  `node_modules`/dot-directories and `*.test.ts(x)`/`*.spec.ts(x)`) —
 *  identical convention to `collect-actions.mjs`'s `listSourceFiles`. */
function listSourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      listSourceFiles(full, out)
      continue
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue
    if (/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) continue
    out.push(full)
  }
  return out
}

/**
 * ITEM-37 — FAIL CLOSED on a collapsed scan set. `SRC_ROOT` is a HARD-CODED root; a
 * rename that moves the subject out from under it makes the walk yield (almost)
 * nothing and this guard reports OK having checked nothing. Four such live fail-open
 * incidents happened in this round alone. The floor is a COMMITTED constant, so
 * shrinking coverage requires an explicit, reviewable edit.
 */
// STRIP (single-cell): 400 -> 200 — the removed single-cell modules/core/libs
// took the scan set from 715 non-test TS/TSX files to 300.
const MIN_SOURCE_FILES = 200

// Test-only floor override (the `LINT_LAYER_BOUNDARY_MIN_FILES` precedent). The floor
// above stays a COMMITTED LITERAL — this only lets a suite that deliberately points
// the guard at a tiny temp fixture exercise the RULES instead of tripping the floor
// first. Leaving it UNSET is production behaviour, and that is what
// `guard-floors.test.mjs` asserts (it overrides only the ROOT, so the floor fires).
const SOURCE_FILE_FLOOR = Number(process.env.ACTION_REFS_LINT_MIN_SOURCE_FILES ?? MIN_SOURCE_FILES)

function assertScanFloor(count, floor, what, root) {
  if (count >= floor) return
  console.error(
    `[action-refs-lint] SCAN SET COLLAPSED — found ${count} ${what} under ${root}, below the ` +
      `committed floor of ${floor}. A hard-coded path no longer resolves, so this guard was ` +
      `about to PASS having checked almost nothing. Re-point it, or lower the floor deliberately.`,
  )
  process.exit(1)
}

/** Every source file under `SRC_ROOT` (other than `defineAction.ts` itself)
 *  that calls `defineAction(`. */
function findActionSourceFiles() {
  // Must stay identical to `collect-actions.mjs`'s matcher: the two scan the SAME tree,
  // and a call form only one of them recognizes means this lint validates references
  // against an INCOMPLETE registered-id set (a live reference to the missed action would
  // be reported as dangling). The explicit-type-argument form
  // `defineAction<TParams, TResult>({…})` is the one that was invisible. The
  // fail-closed audit for an UNPARSABLE call form lives in `collect-actions.mjs`, which
  // scans the same tree and runs first in `npm run check`.
  const DEFINE_ACTION_CALL = /\bdefineAction\s*(?:<[^;{}()]*>\s*)?\(/
  const definitionFile = path.resolve(DEFINE_ACTION_PATH)
  return listSourceFiles(SRC_ROOT).filter(file => {
    if (path.resolve(file) === definitionFile) return false
    return DEFINE_ACTION_CALL.test(readFileSync(file, 'utf8'))
  })
}

/** esbuild plugin: leave relative/absolute/alias imports to esbuild's normal
 *  (tsconfig-aware) resolution + bundling; anything else is a real npm
 *  package, kept EXTERNAL so Node resolves it for real at import time.
 *  Identical to `collect-actions.mjs`'s `externalBareImportsPlugin`. */
const externalBareImportsPlugin = {
  name: 'external-bare-imports',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /.*/ }, args => {
      if (args.kind === 'entry-point') return null
      const p = args.path
      if (p.startsWith('.') || p.startsWith('/') || p.startsWith('@/') || p.startsWith('@txresbench/')) {
        return null
      }
      return { path: p, external: true }
    })
  },
}

/** Bundle + execute every action source file in a real Node ESM module, then
 *  read back the REAL registered action ids off `getActionRegistry()`. This
 *  is the same technique `collect-actions.mjs` uses (see its module
 *  comment) — duplicated here rather than imported, since that script
 *  exposes no importable API. */
async function collectRegisteredActionIds() {
  if (!existsSync(DEFINE_ACTION_PATH)) {
    throw new Error(`[action-refs-lint] cannot find ${DEFINE_ACTION_PATH}`)
  }
  const actionFiles = findActionSourceFiles()
  const entryLines = actionFiles.map(file => `import ${JSON.stringify(file)};`)
  entryLines.push(`import { getActionRegistry } from ${JSON.stringify(DEFINE_ACTION_PATH)};`)
  entryLines.push(
    'globalThis.__TXR_COLLECTED_ACTION_IDS__ = Array.from(getActionRegistry().keys());',
  )
  const entryContents = entryLines.join('\n')

  const result = await build({
    stdin: {
      contents: entryContents,
      resolveDir: UI_ROOT,
      loader: 'ts',
      sourcefile: 'action-refs-lint-entry.ts',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    tsconfig: TSCONFIG_PATH,
    // `import.meta.env` is injected by VITE and is UNDEFINED under the plain
    // Node runtime this bundle executes in, so any app/SDK module that reads it
    // at module scope (e.g. `@txresbench/framework/store-kit`'s
    // `import.meta.env.VITE_STORE_PREFETCH`) throws the instant it is evaluated.
    // Reachable here since the action modules were repointed off the global
    // `Stores` shim onto each store's direct `registerLazyStore` handle. See the
    // long-form rationale in `collect-actions.mjs`.
    define: { 'import.meta.env': '{}' },
    plugins: [externalBareImportsPlugin],
    logLevel: 'silent',
  })

  const bundleCode = result.outputFiles[0].text
  const tmpFile = path.join(UI_ROOT, `.action-refs-lint-${randomUUID()}.mjs`)
  writeFileSync(tmpFile, bundleCode)
  try {
    await import(pathToFileURL(tmpFile).href)
  } finally {
    unlinkSync(tmpFile)
  }

  const collected = globalThis.__TXR_COLLECTED_ACTION_IDS__
  delete globalThis.__TXR_COLLECTED_ACTION_IDS__
  if (!Array.isArray(collected)) {
    throw new Error('[action-refs-lint] bundle did not populate the collected-ids global')
  }
  return new Set(collected)
}

/** 1-indexed line number of `index` within `content`. */
function lineAt(content, index) {
  let line = 1
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n') line++
  }
  return line
}

/** Scan `content` from an opening `<Tag` at `startIdx` for the end of that
 *  JSX opening tag, tracking `{}` brace depth so a `>` inside an attribute
 *  expression (e.g. `icon={<Foo/>}`) doesn't prematurely end the tag. */
function extractTag(content, startIdx) {
  let depth = 0
  for (let i = startIdx; i < content.length; i++) {
    const ch = content[i]
    if (ch === '{') depth++
    else if (ch === '}') depth--
    else if (ch === '>' && depth === 0) {
      return content.slice(startIdx, i + 1)
    }
  }
  return content.slice(startIdx)
}

/** Extract every action-id reference (and every non-literal/dynamic
 *  reference, reported separately) from one file's content. */
function extractReferences(file, content) {
  const refs = []
  const skipped = []

  // <ActionButton ... action="X" ...> / action={'X'} / action={"X"}
  const actionButtonOpenRe = /<ActionButton\b/g
  let m
  while ((m = actionButtonOpenRe.exec(content))) {
    const tag = extractTag(content, m.index)
    const staticMatch = tag.match(
      /\baction\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*(['"])([^'"]*)\3\s*\})/,
    )
    if (staticMatch) {
      const id = staticMatch[1] ?? staticMatch[2] ?? staticMatch[4]
      refs.push({ id, file, line: lineAt(content, m.index), kind: 'ActionButton' })
    } else if (/\baction\s*=\s*\{/.test(tag)) {
      skipped.push({ file, line: lineAt(content, m.index), kind: 'ActionButton (dynamic action=)' })
    }
    // else: no `action=` attribute at all — not our concern (a different lint's job).
  }

  // runAction('X', ...) / runAction("X", ...)
  const runActionRe = /\brunAction\s*\(\s*(?:"([^"]*)"|'([^']*)')/g
  while ((m = runActionRe.exec(content))) {
    const id = m[1] ?? m[2]
    refs.push({ id, file, line: lineAt(content, m.index), kind: 'runAction' })
  }

  // runAction(<non-string-literal>, ...) — dynamic, skipped.
  const runActionDynamicRe = /\brunAction\s*\(\s*(?!["'])(?=[^)])/g
  while ((m = runActionDynamicRe.exec(content))) {
    // Only report as dynamic-skip if it wasn't already captured as a static
    // reference at the same call site (the static regex above already
    // consumed those); a cheap way to avoid double-reporting is to re-check
    // the immediate next non-whitespace char isn't a quote.
    const rest = content.slice(m.index + m[0].length)
    if (/^\s*["']/.test(rest)) continue
    skipped.push({ file, line: lineAt(content, m.index), kind: 'runAction (dynamic id)' })
  }

  return { refs, skipped }
}

async function main() {
  assertScanFloor(listSourceFiles(SRC_ROOT).length, SOURCE_FILE_FLOOR, 'source file(s)', SRC_ROOT)
  if (!existsSync(SRC_ROOT)) {
    throw new Error(`[action-refs-lint] cannot find src root ${SRC_ROOT}`)
  }

  const registeredIds = await collectRegisteredActionIds()

  const files = listSourceFiles(SRC_ROOT)
  const allRefs = []
  const allSkipped = []
  for (const file of files) {
    const content = readFileSync(file, 'utf8')
    const { refs, skipped } = extractReferences(file, content)
    allRefs.push(...refs)
    allSkipped.push(...skipped)
  }

  const relPath = file => path.relative(UI_ROOT, file)

  const offenders = allRefs.filter(ref => !registeredIds.has(ref.id))

  if (allSkipped.length > 0) {
    console.log(
      `[action-refs-lint] skipped ${allSkipped.length} dynamic (non-string-literal) reference(s) — not statically decidable:`,
    )
    for (const s of allSkipped) {
      console.log(`  - ${relPath(s.file)}:${s.line} (${s.kind})`)
    }
  }

  if (offenders.length > 0) {
    console.error(
      `[action-refs-lint] FAILED — ${offenders.length} referenced action id(s) are NOT registered:`,
    )
    for (const o of offenders) {
      console.error(`  - "${o.id}" referenced at ${relPath(o.file)}:${o.line} (${o.kind})`)
    }
    console.error(
      `\nRegistered action ids (${registeredIds.size}): ${[...registeredIds].sort().join(', ') || '(none)'}`,
    )
    console.error(
      '\nEvery `action="..."` / `runAction(\'...\')` reference must name a real, registered `defineAction` id. ' +
        'Register the action, or fix the typo/stale reference.',
    )
    process.exitCode = 1
    return
  }

  console.log(
    `[action-refs-lint] OK — ${allRefs.length} action-id reference(s) checked against ${registeredIds.size} registered action(s), 0 dangling.`,
  )
}

main().catch(err => {
  console.error('[action-refs-lint] fatal:', err)
  process.exitCode = 1
})
