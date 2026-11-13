#!/usr/bin/env node
/**
 * lint-native-controls — app code renders KIT controls, not raw
 * `<button>` / `<input>` / `<select>` / `<textarea>`.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────────
 *
 * txresbench enforces this with a Biome `noRestrictedImports` + raw-element guardrail.
 * TxResBench had the hardcoded-colour lint and the domain ratchet but NO such
 * guard, and the consequence is measurable: the last live native `<select>` and a
 * raw `<button>` in this tree were found by a human READING the code, not by any
 * gate. A raw control silently opts out of the whole design contract at once —
 * the token palette, the focus ring, the disabled/invalid states, the accessible
 * name the kit's props force you to supply, the `data-slot` every kit control
 * stamps (which is what the e2e/visual tiers select on) — and it does so while
 * looking perfectly normal in review.
 *
 * ── WHY A SOURCE SCAN IS ONLY HALF ────────────────────────────────────────────
 *
 * This repo has twice paid for guards that read SOURCE TEXT: the activity rail's
 * static analyser took 20 audit rounds without converging, and `gate-ui`'s port
 * guard was evaded by a shape nobody enumerated. A regex over JSX cannot see
 * `React.createElement('button')`, a `styled('input')`, a component spread from a
 * variable, or anything a dependency renders. Its evasion space is unbounded.
 *
 * So this file is deliberately the CHEAP half, and it is paired with a RENDERED-DOM
 * invariant that reads the same rule off real output rather than off text:
 * `tests/gallery-e2e/native-controls.spec.ts` walks every gallery surface and
 * asserts that every native control element in the live DOM carries a `data-slot`
 * (the kit stamps one on every control it renders; a hand-rolled control carries
 * none). Source-text evasion does not help you there — whatever produced the
 * element, the element is either stamped or it is not. Neither half is sufficient;
 * the source lint is what makes a violation cheap to catch at edit time, and the
 * DOM invariant is what makes the rule true rather than merely well-typed.
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────────
 *
 * In first-party frontend source (`src-app/ui/src`),
 * a JSX opening tag for `button` / `input` / `select` / `textarea` is a violation.
 * The `sdk/` submodule is not scanned: the kit is where these elements are
 * DEFINED, and that is the whole point of having a kit.
 *
 * ── SHRINK-ONLY BASELINE (the same shape as the domain / positional ratchets) ──
 *
 * Existing violations live in `native-controls-baseline.json`, keyed
 * `<src-app-relative path>|<element>` with a count. A NEW hit fails; a STALE entry
 * (the ledger claims more than the tree has) also fails, so the ledger cannot rot
 * into decoration. That is what lets this land today instead of after a big-bang
 * rewrite, while making the number monotonically shrink.
 *
 * The ledger read 61 until the multi-line match below landed, and re-deriving it moved it to
 * 218 (111 keys) — 178 in `libs/viz`, 40 in `ui`. That is not a regression and nothing was
 * added to the tree: 61 was the count of raw controls written on ONE line, because a tag name
 * that ended its line matched nothing (see `TAG_RE`). 218 is what was always there. Every entry
 * was checked to be a real JSX opening tag, and none sits inside a multi-line template literal
 * (the one false-positive class matching across lines could introduce).
 *
 * ── THE OPT-OUT IS NARROW ON PURPOSE ──────────────────────────────────────────
 *
 * There is no directory exclusion and no file-level disable. A single line is
 * exempted by the marker `native-control-ok` on that line or within the 3 lines
 * above it, and the convention is to write the reason after it:
 *
 *     // native-control-ok: the file input is invisible; the visible affordance is <Button>
 *     <input type="file" ref={ref} className="hidden" … />
 *
 * A directory exclusion is how a guard quietly stops covering the code that needs
 * it most; a per-line marker with a reason is reviewable in the diff.
 *
 * Usage:  node scripts/lint-native-controls.mjs
 *         node scripts/lint-native-controls.mjs --write   (regenerate the baseline)
 *         node scripts/lint-native-controls.mjs --list    (print every hit)
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UI_ROOT = path.resolve(__dirname, '..') // src-app/ui
const SRC_APP = path.resolve(UI_ROOT, '..') // src-app
const BASELINE_PATH = path.join(__dirname, 'native-controls-baseline.json')

/** The controls the kit owns. Kept explicit: this is a rule about a closed set of
 *  HTML elements, not a vocabulary that grows. */
export const NATIVE_CONTROLS = ['button', 'input', 'select', 'textarea']

/** The per-line escape hatch. Narrow by construction — one line, with a reason. */
export const OPT_OUT_MARKER = 'native-control-ok'

/** How many lines ABOVE a hit the marker may sit (so it can precede a multi-line tag). */
const MARKER_LOOKBACK = 3

/** Collapse detector. A guard that scanned (almost) nothing must not pass.
 *  Measured 2026-08-09: 1063 first-party `.ts`/`.tsx` files.
 *  STRIP (single-cell) RE-MEASURED 433 on the ITEM-4 tree (the workbench/dock/viz/mcp
 *  single-cell modules left); LOWERED 700 -> 289 (≈2/3 of 433). */
export const MIN_SCANNED_FILES = 289

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.vite', '.git'])
const SCAN_EXT = /\.(ts|tsx)$/

/** First-party frontend source roots. `sdk/` is absent DELIBERATELY — see the header. */
export function scanRoots(srcApp = SRC_APP) {
  const roots = [path.join(srcApp, 'ui', 'src')]
  const pkgs = path.join(srcApp, 'libs')
  if (existsSync(pkgs))
    for (const e of readdirSync(pkgs, { withFileTypes: true })) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue
      const s = path.join(pkgs, e.name, 'src')
      if (existsSync(s)) roots.push(s)
    }
  return roots.filter(r => existsSync(r))
}

function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, acc)
    else if (SCAN_EXT.test(e.name)) acc.push(p)
  }
  return acc
}

export function scanFiles(roots = scanRoots()) {
  const out = []
  for (const r of roots) if (statSync(r).isDirectory()) walk(r, out)
  return out.sort()
}

/**
 * Blank comments, newline-preserving so line numbers survive. Prose that discusses
 * `<button>` — this file's own header is an example — must not be a violation.
 */
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

/**
 * `<button`, `<input …`, `<textarea>` … — a JSX/HTML OPENING tag, not a closing one and not
 * `<ButtonSomething>` (the next char must end the tag name).
 *
 * Matched over the WHOLE (comment-blanked) file, never line by line. The pattern is unchanged —
 * `\s` already includes `\n`, so `<button` followed by a newline has always satisfied it — but
 * running it per line handed it strings with the newline cut off, and a tag name that ENDED its
 * line therefore had nothing after it to match:
 *
 *     <button          ← invisible to the guard
 *       type="button"
 *     >
 *
 * That is the prevailing formatting in this tree, so the ledger was not a measurement of what
 * exists; re-deriving it after this change GREW it, which is the honest number and not a
 * regression. (The old command palette's `<button role="option">` was one of the absentees.)
 *
 * The header's stance — a source scan accepts false negatives, and the rendered-DOM invariant in
 * `tests/gallery-e2e/native-controls.spec.ts` is the half that makes the rule true — is unchanged
 * and still correct. Missing an exotic evasion is that stance. Missing the COMMON way the code is
 * written is a broken guard wearing the stance as cover.
 */
const TAG_RE = new RegExp(`<(${NATIVE_CONTROLS.join('|')})(?=[\\s/>])`, 'g')

/** Byte offset of the start of each line, so a whole-file match index maps back to (line, column)
 *  — which is what keeps the quote heuristic and the opt-out lookback PER LINE (see below). */
function lineStarts(lines) {
  const out = []
  let at = 0
  for (const l of lines) {
    out.push(at)
    at += l.length + 1 // + the '\n' that `split` removed
  }
  return out
}

/** The line containing byte offset `idx`. Binary search — `collectViolations` runs this per hit
 *  over ~1300 files, and a linear scan per hit is quadratic in a long file. */
function lineIndexOf(starts, idx) {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= idx) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * Column ranges of QUOTED spans on one line (', ", `). A test that asserts
 *
 *     expect(el.tagName, 'a native <select> is not the kit control').not.toBe('SELECT')
 *
 * is the guard working, not a violation — and if it stayed in the ledger, rewording
 * that message would turn the ratchet red for nothing.
 *
 * Deliberately PER LINE, not a whole-file tokenizer: a file-wide state machine has to
 * understand template-literal interpolation, escapes and regex literals to stay in
 * sync, and one desync silently disables the guard for the rest of the file. The
 * per-line version can only ever mis-handle its own line, and its failure direction
 * is a false NEGATIVE on that line — never a false alarm that trains people to add
 * exclusions.
 */
export function quotedRanges(line) {
  const ranges = []
  let quote = null
  let start = -1
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '\\') {
      i++
      continue
    }
    if (quote === null) {
      if (c === "'" || c === '"' || c === '`') {
        quote = c
        start = i
      }
    } else if (c === quote) {
      ranges.push([start, i])
      quote = null
    }
  }
  return ranges
}

const inQuotes = (ranges, col) => ranges.some(([a, b]) => col > a && col < b)

/** True when the per-line opt-out marker covers `lineIdx` (0-based) of `rawLines`. */
export function isOptedOut(rawLines, lineIdx) {
  for (let i = Math.max(0, lineIdx - MARKER_LOOKBACK); i <= lineIdx; i++)
    if (rawLines[i]?.includes(OPT_OUT_MARKER)) return true
  return false
}

/** `<src-app-relative path>|<element>` — no line number, so an unrelated edit above a
 *  hit does not churn the ledger (the same choice the two sibling ratchets made). */
export function violationKey(file, element, srcApp = SRC_APP) {
  return `${path.relative(srcApp, file).split(path.sep).join('/')}|${element}`
}

/**
 * The scan. The TAG match spans line boundaries; the quote heuristic and the opt-out lookback stay
 * PER LINE — deliberately, and the split is the whole point:
 *
 *   · Matching the tag file-wide costs nothing in correctness. A JSX tag NAME cannot contain a
 *     newline, so `<button` followed by one is a `button` tag and nothing else; the same lookahead
 *     decides it, just with the newline actually present in the string.
 *   · Deciding QUOTES file-wide would cost a great deal. A whole-file tokenizer has to track
 *     template-literal interpolation, escapes and regex literals to stay in sync, and one desync
 *     silently disables the guard for the REST OF THE FILE. The per-line version can only ever
 *     mis-handle its own line, and its failure direction there is a false negative — never a false
 *     alarm that trains people to add exclusions. That reasoning (from this file's original
 *     header) is unaffected by where the tag match happens, so it is kept exactly.
 *
 * A hit is attributed to the line the TAG is on, which is what the opt-out lookback measures from
 * and what a reader is sent to.
 */
export function collectViolations(files) {
  const out = []
  for (const f of files) {
    const raw = readFileSync(f, 'utf8')
    const rawLines = raw.split('\n')
    const src = stripComments(raw)
    const lines = src.split('\n')
    const starts = lineStarts(lines)
    const rangesByLine = new Map()
    TAG_RE.lastIndex = 0
    let m
    while ((m = TAG_RE.exec(src)) !== null) {
      const idx = lineIndexOf(starts, m.index)
      if (isOptedOut(rawLines, idx)) continue
      if (!rangesByLine.has(idx)) rangesByLine.set(idx, quotedRanges(lines[idx]))
      if (inQuotes(rangesByLine.get(idx), m.index - starts[idx])) continue
      out.push({ file: f, line: idx + 1, element: m[1], snippet: rawLines[idx].trim().slice(0, 120) })
    }
  }
  return out
}

function loadBaseline(p = BASELINE_PATH) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return { entries: {}, notes: {} }
  }
}

/** `{added, stale}` vs the committed ledger. BOTH fail — an added hit is a new raw
 *  control; a stale one means the ledger describes code that is gone, and a ledger
 *  nobody re-derives is how a ratchet quietly stops ratcheting. */
export function diffAgainstBaseline(violations, baseline, srcApp = SRC_APP) {
  const observed = {}
  for (const v of violations) {
    const key = violationKey(v.file, v.element, srcApp)
    observed[key] = (observed[key] ?? 0) + 1
  }
  const committed = baseline.entries ?? {}
  const added = []
  const stale = []
  for (const [key, count] of Object.entries(observed))
    if (count > (committed[key] ?? 0)) added.push({ key, count, allowed: committed[key] ?? 0 })
  for (const [key, allowed] of Object.entries(committed)) {
    const count = observed[key] ?? 0
    if (count < allowed) stale.push({ key, count, allowed })
  }
  return { added, stale, observed }
}

function main() {
  const write = process.argv.includes('--write')
  const list = process.argv.includes('--list')

  const roots = scanRoots()
  const files = scanFiles(roots)
  if (files.length < MIN_SCANNED_FILES) {
    console.error(
      `✖ native-controls: the scan set COLLAPSED — ${files.length} file(s) < MIN_SCANNED_FILES ` +
        `(${MIN_SCANNED_FILES}) over roots [${roots.map(r => path.relative(SRC_APP, r)).join(', ')}]. ` +
        `A guard that matches nothing passes vacuously.`,
    )
    process.exit(1)
  }

  const violations = collectViolations(files)

  if (list) {
    for (const v of violations)
      console.log(`${path.relative(SRC_APP, v.file)}:${v.line}  <${v.element}>  ${v.snippet}`)
    console.log(`\n${violations.length} hit(s) in ${files.length} file(s).`)
    return
  }

  if (write) {
    const prev = loadBaseline()
    const entries = {}
    for (const v of violations) {
      const key = violationKey(v.file, v.element)
      entries[key] = (entries[key] ?? 0) + 1
    }
    writeFileSync(
      BASELINE_PATH,
      `${JSON.stringify(
        {
          $comment:
            'Raw <button>/<input>/<select>/<textarea> in first-party frontend source. ' +
            'SHRINK-ONLY: a new hit fails, and a stale entry (ledger > tree) fails too. ' +
            'Do not add to this file to land a new raw control — use the kit, or mark the ' +
            'single line with `native-control-ok: <reason>`. Regenerate after a genuine ' +
            'removal: node scripts/lint-native-controls.mjs --write',
          total: violations.length,
          entries: Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))),
          notes: prev.notes ?? {},
        },
        null,
        2,
      )}\n`,
    )
    console.log(`✓ native-controls baseline written: ${violations.length} hit(s).`)
    return
  }

  const baseline = loadBaseline()
  const { added, stale } = diffAgainstBaseline(violations, baseline)
  if (added.length === 0 && stale.length === 0) {
    console.log(
      `✓ native-controls: ${files.length} file(s) scanned, ${violations.length} raw control(s), ` +
        `all in the ledger (shrink-only).`,
    )
    return
  }

  console.error('✖ native-controls: first-party code renders a RAW HTML control.\n')
  const byKey = new Map()
  for (const v of violations) {
    const key = violationKey(v.file, v.element)
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(v)
  }
  for (const a of added) {
    console.error(`  NEW   ${a.key}  (${a.count} hit(s), ledger allows ${a.allowed})`)
    for (const v of byKey.get(a.key) ?? [])
      console.error(`        ${path.relative(SRC_APP, v.file)}:${v.line}  ${v.snippet}`)
  }
  for (const s of stale)
    console.error(`  STALE ${s.key}  (ledger says ${s.allowed}, only ${s.count} remain)`)
  console.error(
    `\n  Use the kit control (Button / Input / Select / Textarea from @txresbench/kit): it carries the\n` +
      `  tokens, the focus ring, the disabled+invalid states, the accessible-name props and the\n` +
      `  \`data-slot\` the e2e and visual tiers select on. If this ONE line genuinely needs the raw\n` +
      `  element, mark it: \`// ${OPT_OUT_MARKER}: <reason>\`. After removing a hit, re-derive the\n` +
      `  ledger: node scripts/lint-native-controls.mjs --write`,
  )
  process.exit(1)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
