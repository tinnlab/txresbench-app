#!/usr/bin/env node
/**
 * ai-actions ITEM-12 — "action coverage" sub-check.
 *
 * The rule: a `<Button onClick={...}>` (NOT `<ActionButton>`) whose inline handler
 * directly invokes a store action (`Stores.<X>.<method>(...)`) bypasses the action
 * registry (the assistant and the permission gate cannot see it). It should be
 * `<ActionButton action="...">` delegating to that same store action instead.
 *
 * `onClick={() => setOpen(true)}` / `onClick={() => navigate(...)}` (local UI state /
 * navigation, not a store mutation) are NOT flagged — they aren't "AI-controllable
 * actions" in scope for this rule.
 *
 * SCOPE IS DERIVED, NOT LISTED. Every non-test `.ts`/`.tsx` file under `<ui>/src` is
 * checked. (DEC-6 kept this opt-in because a repo-wide hard-fail was feared to be
 * noisy; the heuristic above is narrow, and the whole tree has 0 findings, so the
 * opt-in list only ever shrank: nine of its ten entries named deleted files and the
 * guard silently checked one file.)
 *
 * `scripts/action-coverage-allowlist.txt` is the OPPOSITE of what it was: a list of
 * globs (relative to `<ui>/src`) of files ALLOWED to call a store from an inline
 * `<Button onClick>`, one per line, each with a reason in a comment above it. It ships
 * empty. An entry that matches no file FAILS the guard, so the list cannot rot.
 *
 * Usage:
 *   node scripts/action-coverage.mjs
 *
 * Test-only overrides (used by `action-coverage.test.mjs` to point the check
 * at self-contained temp fixtures instead of the real project — never set
 * these in normal use):
 *   ACTION_COVERAGE_SRC_ROOT        — replaces `<ui>/src` as the scan root
 *   ACTION_COVERAGE_ALLOWLIST_PATH  — replaces the committed allowlist path
 *   ACTION_COVERAGE_MIN_SOURCE_FILES — lowers the ITEM-37 scan floor so a tiny
 *                                     synthetic fixture can exercise the RULES. The
 *                                     floor itself is proved by `guard-floors.test.mjs`,
 *                                     which leaves this UNSET.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const UI_ROOT = path.resolve(__dirname, '..')

const SRC_ROOT = process.env.ACTION_COVERAGE_SRC_ROOT
  ? path.resolve(process.env.ACTION_COVERAGE_SRC_ROOT)
  : path.join(UI_ROOT, 'src')

const ALLOWLIST_PATH = process.env.ACTION_COVERAGE_ALLOWLIST_PATH
  ? path.resolve(process.env.ACTION_COVERAGE_ALLOWLIST_PATH)
  : path.join(__dirname, 'action-coverage-allowlist.txt')

/** Recursively list every `.ts`/`.tsx` file under `dir` (skips
 *  `node_modules`/dot-directories and `*.test.ts(x)`/`*.spec.ts(x)`) —
 *  same convention as `collect-actions.mjs` / `action-refs-lint.mjs`. */
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
const SOURCE_FILE_FLOOR = Number(process.env.ACTION_COVERAGE_MIN_SOURCE_FILES ?? MIN_SOURCE_FILES)

function assertScanFloor(count, floor, what, root) {
  if (count >= floor) return
  console.error(
    `[action-coverage] SCAN SET COLLAPSED — found ${count} ${what} under ${root}, below the ` +
      `committed floor of ${floor}. A hard-coded path no longer resolves, so this guard was ` +
      `about to PASS having checked almost nothing. Re-point it, or lower the floor deliberately.`,
  )
  process.exit(1)
}

/** Parse the allowlist file into a list of non-comment, non-blank glob
 *  patterns. Missing file ⇒ empty list, same as an existing but empty file. */
function readAllowlistPatterns() {
  if (!existsSync(ALLOWLIST_PATH)) return []
  const lines = readFileSync(ALLOWLIST_PATH, 'utf8').split('\n')
  return lines
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#'))
}

/** Convert one allowlist glob to a RegExp. Supports `**` (any chars incl.
 *  `/`), `*` (any chars except `/`), `?` (one char except `/`), and a
 *  trailing `/` meaning "everything under this directory" (equivalent to
 *  appending `**`). Matched against a `src`-relative, forward-slash path. */
function globToRegExp(glob) {
  let pattern = glob.endsWith('/') ? glob + '**' : glob
  let re = '^'
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*'
        i++
        if (pattern[i + 1] === '/') i++
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c
    } else {
      re += c
    }
  }
  re += '$'
  return new RegExp(re)
}

/** The files each allowlist pattern matches (`src`-relative, forward slashes). */
function matchesPerPattern(patterns, files) {
  const rels = files.map(file => path.relative(SRC_ROOT, file).split(path.sep).join('/'))
  return patterns.map(pattern => {
    const re = globToRegExp(pattern)
    return { pattern, matched: rels.filter(rel => re.test(rel)) }
  })
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

/** Extract the `{...}` expression body of `attrName` from a JSX tag's source
 *  text, brace-depth aware (handles a nested `{}` inside the handler body). */
function extractAttrExpr(tagSrc, attrName) {
  const re = new RegExp(`\\b${attrName}\\s*=\\s*\\{`)
  const m = re.exec(tagSrc)
  if (!m) return null
  const openIdx = m.index + m[0].length - 1
  let depth = 0
  for (let i = openIdx; i < tagSrc.length; i++) {
    if (tagSrc[i] === '{') depth++
    else if (tagSrc[i] === '}') {
      depth--
      if (depth === 0) return tagSrc.slice(openIdx + 1, i)
    }
  }
  return null
}

/** A direct `Stores.<X>.<method>(...)` invocation — the "bypasses the
 *  action registry" signal. */
const STORE_MUTATION_CALL_RE = /\bStores\s*\.\s*\w+\s*\.\s*\w+\s*\(/

/** Find every `<Button onClick={...}>` (not `<ActionButton>`) in `content`
 *  whose `onClick` body directly calls a store action. */
function findViolations(file, content) {
  const violations = []
  const buttonOpenRe = /<Button\b/g
  let m
  while ((m = buttonOpenRe.exec(content))) {
    const tag = extractTag(content, m.index)
    const onClickExpr = extractAttrExpr(tag, 'onClick')
    if (!onClickExpr) continue
    if (STORE_MUTATION_CALL_RE.test(onClickExpr)) {
      violations.push({ file, line: lineAt(content, m.index) })
    }
  }
  return violations
}

function main() {
  // ITEM-37: assert the ROOT resolves first, so a collapsed `SRC_ROOT` is caught.
  const sources = listSourceFiles(SRC_ROOT)
  assertScanFloor(sources.length, SOURCE_FILE_FLOOR, 'source file(s)', SRC_ROOT)

  // An allowlist entry that names no file is dead: it would exempt a future file of that
  // name without anyone seeing it. Fail instead of ignoring it.
  const patterns = readAllowlistPatterns()
  const perPattern = matchesPerPattern(patterns, sources)
  const dead = perPattern.filter(p => p.matched.length === 0).map(p => p.pattern)
  if (dead.length > 0) {
    console.error(
      `[action-coverage] FAILED — ${dead.length} allowlist entr${dead.length === 1 ? 'y' : 'ies'} match no source file under ${SRC_ROOT}:`,
    )
    for (const pattern of dead) console.error(`  - ${pattern}`)
    console.error('\nDelete the entr(ies) from scripts/action-coverage-allowlist.txt (the file was moved or removed).')
    process.exitCode = 1
    return
  }
  const exempt = new Set(perPattern.flatMap(p => p.matched))

  const files = sources.filter(file => !exempt.has(path.relative(SRC_ROOT, file).split(path.sep).join('/')))
  const allViolations = []
  for (const file of files) {
    const content = readFileSync(file, 'utf8')
    allViolations.push(...findViolations(file, content))
  }

  if (allViolations.length > 0) {
    const relPath = f => path.relative(UI_ROOT, f)
    console.error(
      `[action-coverage] FAILED — ${allViolations.length} <Button onClick={...}> that directly call(s) a store action instead of a registered defineAction:`,
    )
    for (const v of allViolations) {
      console.error(`  - ${relPath(v.file)}:${v.line}`)
    }
    console.error(
      '\nReplace the inline `<Button onClick={() => Stores.X.method(...)}>` with `<ActionButton action="...">` ' +
        'delegating to that same store action (register it as a defineAction first if it isn\'t one yet).',
    )
    process.exitCode = 1
    return
  }

  console.log(
    `[action-coverage] OK — ${files.length} source file(s) checked (${exempt.size} allowlisted), 0 un-registered inline store mutations.`,
  )
}

main()
