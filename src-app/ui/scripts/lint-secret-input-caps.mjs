#!/usr/bin/env node
/**
 * lint-secret-input-caps — a MASKED field never carries a truncating cap.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────────
 *
 * `maxlength` enforces a length limit by DISCARDING the overflow. `clamp-notice.tsx`
 * already names that class ("characters past a cap") and requires it to announce what
 * was kept and what was dropped. On a MASKED field neither branch of that rule is
 * available: the user cannot read what survived, so the truncation is undetectable —
 * and announcing "kept 72, dropped 18" would be announcing that the app picked a
 * credential the user did not.
 *
 * It shipped. `ProfileSettingsPage` capped BOTH the new-password and confirm-password
 * fields at 72. A longer passphrase was cut identically in both, so the two matched,
 * `refine` passed, the request succeeded, and the page said "Password changed." The
 * user stored the passphrase they typed and could never sign in again — with no signal
 * anywhere in that sequence that anything had been dropped.
 *
 * The kit now omits `maxLength` from `PasswordInputProps` and strips it at runtime, so
 * that door is shut by the type system. This guard covers the OTHER door: a plain
 * `<Input type="password">`, which is an ordinary kit Input as far as the types are
 * concerned and which this app does render (the first-run setup page).
 *
 * ── WHY A SOURCE SCAN IS ONLY HALF ────────────────────────────────────────────
 *
 * Same lesson as `lint-native-controls.mjs`, and it is not a cheap one here: this repo
 * has twice paid for guards that read SOURCE TEXT (the activity rail's static analyser,
 * 20 rounds without converging; `gate-ui`'s port guard). A regex cannot see a cap
 * arriving through a spread, a variable, or a dependency. So the rule is ALSO asserted
 * on rendered state by `tests/gallery-e2e/masked-field-caps.spec.ts`, which reads
 * `maxLength` off every `input[type=password]` in the live DOM of every gallery
 * surface. Whatever produced the element, the element either declares a cap or it does
 * not. This half is what makes a violation cheap to catch at edit time; that half is
 * what makes the rule true.
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────────
 *
 * In first-party frontend source, a JSX opening tag that is `<PasswordInput …>` or
 * carries `type="password"` must not also carry `maxLength`. There is NO baseline and
 * no ratchet: the count is zero today and a cap on a secret is never the right answer,
 * so the correct ledger is the empty one.
 *
 * A LENGTH LIMIT IS STILL LEGITIMATE — it is stated and REFUSED (`core/passwordPolicy`),
 * never applied by discarding what the user typed.
 *
 * ── THE OPT-OUT ───────────────────────────────────────────────────────────────
 *
 * A single line is exempted by the marker `secret-cap-ok` on that line or within the 3
 * lines above it, with the reason written after it. Per-line and reviewable in the
 * diff, deliberately — a directory exclusion is how a guard quietly stops covering the
 * code that needs it most.
 *
 * Usage:  node scripts/lint-secret-input-caps.mjs
 *         node scripts/lint-secret-input-caps.mjs --list
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UI_ROOT = path.resolve(__dirname, '..')
const SRC_APP = path.resolve(UI_ROOT, '..')

export const OPT_OUT_MARKER = 'secret-cap-ok'
const MARKER_LOOKBACK = 3

/** Collapse detector — a guard that scanned (almost) nothing must not pass. */
export const MIN_SCANNED_FILES = 700

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.vite', '.git'])
const SCAN_EXT = /\.(ts|tsx)$/

/** First-party frontend source roots. `sdk/` is absent: the kit is where the component
 *  is DEFINED, and its own ban is enforced by the type system + a kit test. */
export function scanRoots(srcApp = SRC_APP) {
  const roots = [path.join(srcApp, 'ui', 'src')]
  const pkgs = path.join(srcApp, 'packages')
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

/** Blank comments, newline-preserving so line numbers survive. This file's own header
 *  discusses `maxLength` on a password field and must not be a violation. */
export function stripComments(src) {
  let out = ''
  let i = 0
  while (i < src.length) {
    if (src[i] === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') {
        out += ' '
        i++
      }
    } else if (src[i] === '/' && src[i + 1] === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' '
        i++
      }
      out += '  '
      i += 2
    } else {
      out += src[i]
      i++
    }
  }
  return out
}

/** JSX opening tags, across lines (a tag whose name ends its line must still match). */
const TAG_RE = /<([A-Za-z][\w.]*)((?:[^<>]|>(?=\s*[\w"'{]))*?)\/?>/gs

/**
 * Hits in one source string. A hit is a tag that is masked AND capped.
 *
 * "Masked" is `PasswordInput` (whatever it is imported as is out of scope here — the
 * kit's own type ban covers that call anyway) or an explicit `type="password"`. A
 * dynamic `type={…}` is NOT treated as masked: it would be a guess, and the rendered-DOM
 * twin sees the real value.
 */
export function findHits(source) {
  const src = stripComments(source)
  const lines = source.split('\n')
  const hits = []
  for (const m of src.matchAll(TAG_RE)) {
    const [full, tag, attrs = ''] = m
    const masked = tag === 'PasswordInput' || /\btype\s*=\s*["']password["']/.test(attrs)
    if (!masked) continue
    if (!/\bmaxLength\b/.test(attrs)) continue
    const line = src.slice(0, m.index).split('\n').length
    const from = Math.max(0, line - 1 - MARKER_LOOKBACK)
    const window = lines.slice(from, line).join('\n')
    if (window.includes(OPT_OUT_MARKER)) continue
    hits.push({ line, tag, snippet: full.replace(/\s+/g, ' ').slice(0, 120) })
  }
  return hits
}

function main() {
  const list = process.argv.includes('--list')
  const files = scanFiles()
  if (files.length < MIN_SCANNED_FILES) {
    console.error(
      `lint-secret-input-caps: scanned only ${files.length} file(s) (< ${MIN_SCANNED_FILES}) — ` +
        'a guard that looks at nothing reports a clean tree forever.',
    )
    process.exit(1)
  }
  const found = []
  for (const f of files) {
    for (const h of findHits(readFileSync(f, 'utf8'))) {
      found.push(`${path.relative(SRC_APP, f)}:${h.line}  ${h.snippet}`)
    }
  }
  if (list) for (const f of found) console.log(f)
  if (found.length > 0) {
    console.error(
      `lint-secret-input-caps: ${found.length} masked field(s) carry a truncating cap:\n` +
        found.map(f => `  ${f}`).join('\n') +
        '\n\n`maxLength` on a masked field discards the overflow where the user cannot see it, and a\n' +
        'confirm field with the same cap hides even the mismatch. State the limit and REFUSE past it\n' +
        '(`core/passwordPolicy`), or mark the line `secret-cap-ok` with a reason.',
    )
    process.exit(1)
  }
  console.log(`lint-secret-input-caps: ${files.length} file(s) scanned, 0 masked field(s) capped.`)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
