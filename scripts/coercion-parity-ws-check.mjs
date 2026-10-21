// A tiny cross-language check that the hand-mirrored whitespace strip sets are literally
// the same sets of codepoints. A one-codepoint drift between any two copies is exactly the
// R3-108 divergence class the enumeration exists to close — silently, at rc=0, in the
// direction of whichever reader is missing the character.
//
// TWO different sets are checked, because the feature has two:
//
//   1. the CELL strip set (`_VALUE_WS` / `VALUE_WS_CLASS`, 30 codepoints) — 3 copies;
//   2. the SIX-ASCII BOUND + column-NAME trim (space, tab, LF, VT, FF, CR) — 6 copies.
//
// ROUND-6 (B3): only (1) was checked, and the header said so. (2) had ZERO cross-check
// while being mirrored in `cell-filter.py` twice, in `criteria_script.rs` twice (the
// emitted prelude's `_decimal` and Rust's own `trim_ascii_ws`) and in
// `criteriaPredicate.ts` twice — so dropping `\v` from any ONE of them produced a real
// cross-reader divergence with the whole gate at rc 0 (the corpus' only padded-bound case
// omitted U+000B, and its min bound was vacuous). Both holes are closed: the six copies
// are cross-checked here AND `A05`/`J05` now carry VT.
//
// Invoked by `scripts/coercion-parity.mjs`, so it runs under `just check-coercion`.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The canonical set: Unicode `White_Space` ∪ U+001C–U+001F (python's `str.strip()`) ∪
 *  U+FEFF (JS `trim()`). Written out so a reader can audit it against the standard. */
const EXPECTED = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x1c, 0x1d, 0x1e, 0x1f, 0x85, 0xa0, 0x1680, 0x2000,
  0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028,
  0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
].sort((a, b) => a - b)

/** The SIX-ASCII BOUND / column-NAME trim: space, tab, LF, VT, FF, CR — the INTERSECTION
 *  of the three languages' native trims, and a DIFFERENT (narrower) set than the lenient
 *  cell strip above. See `criteria_script::trim_ascii_ws`' doc for why exactly six. */
const EXPECTED_SIX = [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20].sort((a, b) => a - b)

const problems = []
const show = cps => cps.map(c => `U+${c.toString(16).toUpperCase().padStart(4, '0')}`).join(' ')

function diffAgainst(want, label, cps) {
  const got = [...new Set(cps)].sort((a, b) => a - b)
  const missing = want.filter(c => !got.includes(c))
  const extra = got.filter(c => !want.includes(c))
  if (missing.length) problems.push(`${label}: MISSING ${show(missing)}`)
  if (extra.length) problems.push(`${label}: EXTRA ${show(extra)}`)
}

const diff = (label, cps) => diffAgainst(EXPECTED, label, cps)

/** Decode the escapes python's own parser would: \xNN, \uNNNN, \t \n \r \f \v, literals. */
const pyDecode = s =>
  s
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\t/g, '\t')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\f/g, '\f')
    .replace(/\\v/g, '\v')

/** Pull the codepoints out of a python `_VALUE_WS = ( "…" "…" )` literal. */
function pythonSet(text, file) {
  const m = text.match(/_VALUE_WS = \(([\s\S]*?)\n\)/)
  if (!m) {
    problems.push(`${file}: no \`_VALUE_WS = ( … )\` literal found`)
    return []
  }
  const cps = []
  for (const piece of m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    for (const ch of pyDecode(piece[1])) cps.push(ch.codePointAt(0))
  }
  return cps
}

/** Every python `.strip("…")` whose literal is a WHITESPACE set — i.e. a six-ASCII trim
 *  mirror. Selected by "contains a space or a tab" rather than by its contents, so a copy
 *  that DROPPED a character is still selected (and then reported as MISSING it) while an
 *  unrelated `.strip("_")` is not. */
function pyStripSets(text) {
  const out = []
  for (const m of text.matchAll(/\.strip\("((?:[^"\\]|\\.)*)"\)/g)) {
    const s = pyDecode(m[1])
    if (!/[ \t]/.test(s)) continue
    out.push([...s].map(ch => ch.codePointAt(0)))
  }
  return out
}

/** Rust's own copy: `trim_matches(|c: char| matches!(c, ' ' | '\t' | … ))`. */
function rustTrimSets(text) {
  const out = []
  // Scoped to `trim_matches(|c: char| matches!(…))` so an unrelated `matches!(c, …)`
  // elsewhere in the file is not counted as a trim mirror (a false RED).
  for (const m of text.matchAll(/trim_matches\(\|c: char\| matches!\(c, ([^)]*'\s*)\)/g)) {
    const cps = []
    for (const lit of m[1].matchAll(/'((?:\\.|\\u\{[0-9a-fA-F]+\}|[^'])+)'/g)) {
      const raw = lit[1]
      const u = raw.match(/^\\u\{([0-9a-fA-F]+)\}$/)
      if (u) cps.push(parseInt(u[1], 16))
      else cps.push(pyDecode(raw).codePointAt(0))
    }
    out.push(cps)
  }
  return out
}

/** The TS copies: the `[…]` class of each `ASCII_WS_LEAD` / `ASCII_WS_TRAIL` regex. */
function tsAsciiSets(text) {
  const out = []
  for (const m of text.matchAll(/const ASCII_WS_(?:LEAD|TRAIL) = \/[^[]*\[([^\]]*)\]/g)) {
    out.push([...pyDecode(m[1])].map(ch => ch.codePointAt(0)))
  }
  return out
}

/** Check every copy found in `text`, and that the EXPECTED NUMBER of copies was found —
 *  a mirror that is deleted (or renamed out of the pattern) must not silently pass. */
function checkSix(label, sets, want) {
  if (sets.length !== want) {
    problems.push(`${label}: found ${sets.length} six-ASCII trim copies, expected ${want}`)
  }
  sets.forEach((cps, i) => diffAgainst(EXPECTED_SIX, `${label} copy ${i + 1}`, cps))
}

/** Every codepoint the TS `VALUE_WS_CLASS` regex actually matches, by probing it. */
function tsSet(text, file) {
  const m = text.match(/const VALUE_WS_CLASS =\s*\n?\s*'(.*)'/)
  if (!m) {
    problems.push(`${file}: no \`VALUE_WS_CLASS\` literal found`)
    return []
  }
  const re = new RegExp(`^${m[1].replace(/\\\\/g, '\\')}$`)
  const cps = []
  // Probe the whole BMP: the class is small, so an exhaustive probe is both exact and
  // instant, and it cannot be fooled by a range the author mis-typed.
  for (let c = 0; c <= 0xffff; c++) {
    if (re.test(String.fromCodePoint(c))) cps.push(c)
  }
  return cps
}

const KERNEL = 'src-app/packages/cell-filter/compute/cell-filter.py'
const PRELUDE = 'src-app/server/src/modules/provenance/criteria_script.rs'
// The criteria VOCABULARY (ITEM-4: relocated out of `core/dsl/criteriaPredicate.ts`,
// which also held a criteria->predicate lift that is now deleted; the coercion +
// spelling rules the surviving `criteria` encoding is built on moved here intact).
// It holds BOTH TS mirrors this file checks: the value strip class (1) and the two
// six-ASCII bound trims (2).
//
// STALE-PATH FIX: this pointed the strip-set probe at `core/runtime/primitives.ts`,
// which is where the class lived until the C1/C2 relocation moved it here (and left
// `primitives.ts` re-exporting the parser only). The probe then found no literal and
// this whole gate exited 1 — `just check-coercion` aborted at the ws-check step and the
// three corpus readers never ran at all. A guard that names a file by path must be moved
// with the symbol it guards; see the `checkSix` copy-count assertion for the same idea
// applied to deletion.
const VOCAB = 'src-app/ui/src/modules/workbench/core/criteria/criteria.ts'

const kernelSrc = readFileSync(resolve(ROOT, KERNEL), 'utf8')
const preludeSrc = readFileSync(resolve(ROOT, PRELUDE), 'utf8')
const vocabSrc = readFileSync(resolve(ROOT, VOCAB), 'utf8')

// (1) the CELL strip set — 3 copies.
diff(`kernel (${KERNEL})`, pythonSet(kernelSrc, KERNEL))
diff(`emitted prelude (${PRELUDE})`, pythonSet(preludeSrc, PRELUDE))
diff(`preview (${VOCAB})`, tsSet(vocabSrc, VOCAB))

// (2) the SIX-ASCII bound / column-name trim — 6 copies.
// The prelude's copy is read from INSIDE the `CRITERIA_PRELUDE` raw string, so the
// six-character set quoted in the doc-comment above `trim_ascii_ws` is not counted as a
// mirror (it is prose, not a reader).
const preludePy = preludeSrc.match(/const CRITERIA_PRELUDE: &str = r#"([\s\S]*?)"#;/)
if (!preludePy) problems.push(`${PRELUDE}: no \`CRITERIA_PRELUDE\` raw string found`)
checkSix(`kernel (${KERNEL})`, pyStripSets(kernelSrc), 2)
checkSix(`emitted prelude (${PRELUDE})`, pyStripSets(preludePy?.[1] ?? ''), 1)
checkSix(`rust trim_ascii_ws (${PRELUDE})`, rustTrimSets(preludeSrc), 1)
checkSix(`criteria vocabulary (${VOCAB})`, tsAsciiSets(vocabSrc), 2)

if (problems.length) {
  process.stderr.write(`the mirrored whitespace strip sets have drifted:\n  ${problems.join('\n  ')}\n`)
  process.exit(1)
}
process.stdout.write(
  `coercion-parity: the 3 VALUE_WS strip sets are identical (${EXPECTED.length} codepoints) ` +
    `and the 6 six-ASCII bound/column trims are identical (${EXPECTED_SIX.length} codepoints)\n`,
)
