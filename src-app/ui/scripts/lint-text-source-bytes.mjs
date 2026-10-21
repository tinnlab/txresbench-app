#!/usr/bin/env node
// lint-text-source-bytes — NO source file may contain a byte that makes git call it BINARY.
//
// ── Why this exists, and why it is a lint rather than a test ────────────────────────────
//
// A section-reorder sentinel was written as `const APPEND_MARK = '\0append'` — a literal NUL
// byte inside a `.tsx`. Git's binary heuristic is "a NUL in the first 8000 bytes", so from that
// commit on the file was a BINARY blob: `git diff` and `git show` printed
//
//     Binary files a/…/SectionStack.tsx and b/…/SectionStack.tsx differ
//
// for a change of 11k → 20k bytes. The code compiled, every test passed, and the review process
// simply stopped seeing the file. A blind auditor instructed to cover every hunk covered every
// hunk it was shown, and the single largest production change in the commit was not one of them.
//
// That is the failure this guard is written against: not a wrong value, but a value that makes
// the DIFF stop working — which defeats every review gate downstream at once, silently, and gets
// quieter the bigger the change is.
//
// It is a LINT and deliberately NOT a source-scanning test. This repo has twice paid for
// hand-written source-scanning guards whose evasion space turned out to be unbounded (the
// activity rail's 20 non-converging audit rounds; the gate-ui port guard). The difference here
// is that the property is not a code SHAPE that can be spelled a dozen ways — it is a BYTE, and
// "does this file contain a byte from this set" has exactly one answer. There is nothing to
// evade, which is why a mechanical check is the right tool for this one and was the wrong tool
// for those.
//
// `.gitattributes` is the belt to this brace: `*.tsx text diff` forces git to render these files
// as text even if one slips in. Both are cheap; neither alone is sufficient — the attribute fixes
// the SYMPTOM (the diff) and leaves the byte in the source, which is its own hazard (a NUL in a
// string literal is invisible in every editor and compares unequal to what the reader sees).

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Where source lives. Fixtures and generated trees are excluded by the walk below, not by an
 *  allowlist of files — an allowlist is the thing that goes stale. */
const SCAN = ['src', 'tests', 'scripts']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.vite', 'test-results', 'playwright-report'])
const EXT = /\.(ts|tsx|js|jsx|mjs|cjs|css|json|md|yaml|yml|html)$/

/**
 * The bytes that make git call a file binary, plus the ones that make it unreviewable.
 *
 * NUL is the one git actually keys on. The other C0 controls are included because they are
 * invisible in every editor and diff, so a literal one is never what the author meant to write
 * and is always a hazard to the next reader — TAB, LF and CR are the three that are.
 */
const BANNED = new Set([...Array(32).keys()].filter(b => b !== 9 && b !== 10 && b !== 13))
const NAME = (b) => (b === 0 ? 'NUL' : `0x${b.toString(16).padStart(2, '0')}`)

function* walk(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue
    const p = `${dir}/${e.name}`
    if (e.isDirectory()) yield* walk(p)
    else if (EXT.test(e.name) && statSync(p).size > 0) yield p
  }
}

const findings = []
let scanned = 0
for (const root of SCAN) {
  for (const file of walk(`${ROOT}/${root}`)) {
    scanned += 1
    const buf = readFileSync(file)
    for (let i = 0; i < buf.length; i++) {
      if (!BANNED.has(buf[i])) continue
      // The LINE, so the message points at something a human can find — a byte offset into a
      // 20k-byte file is not an address anyone can act on.
      const line = buf.subarray(0, i).toString('utf8').split('\n').length
      findings.push({ file: file.slice(ROOT.length), line, byte: NAME(buf[i]) })
      break // one per file is enough to act on; the rest are the same edit
    }
  }
}

if (findings.length > 0) {
  console.error(`✖ text-source-bytes: ${findings.length} source file(s) carry a control byte git treats as BINARY.`)
  console.error('  A file with a NUL in its first 8000 bytes stops being diffable: `git diff` prints')
  console.error('  "Binary files … differ" and every review gate downstream reads an empty change.')
  for (const f of findings) console.error(`  ${f.file}:${f.line}  [${f.byte}]`)
  console.error('  Spell the value with an escape the compiler resolves, not with the byte itself.')
  process.exit(1)
}
console.log(`✓ text-source-bytes: ${scanned} source file(s) scanned; none carries a diff-breaking control byte.`)
