// sourceScan.ts — the ONE comment stripper every source-text guard in this package reads through
// (FIX_ROUND-2 / C15).
//
// WHY IT LIVES HERE. Two suites scan product source as text: `gridDecomposition.test.ts` (the INV-10
// structural guard) and `paneToolbarItems.test.ts` (the pane-toolbar layout guard). The first routed
// every assertion through a purpose-built stripper with its own four-case suite, precisely because
// "a source-text guard that reads prose is the vacuity this file exists to defeat". The second read
// RAW SOURCE — so any future docblock in `PaneToolbar.tsx` quoting one of its anchors verbatim (the
// same file's own header already quotes `menuItems.length > 0 && (`-shaped code in prose) would keep
// it green after the real code was deleted. Copying the stripper into the second suite would have
// left the package with two implementations of one rule, which is the defect class
// `gridDecomposition.test.ts` itself polices with its "exactly one definition in the package"
// sweeps. So it moved OUT of both, to a module under `tests/` — outside `src/`, therefore not
// product source, not scanned by the guards that import it, and not collected by vitest
// (`include: ['src/**/*.test.ts']`).
//
// ── The bug this implementation exists to not have (DRIFT-50) ────────────────────────────────────
// The original was two regexes, block-comments first. Applied to the shell's real header line —
// `// viz-core rule: depends only on @deck.gl/* + react …` — the `/*` inside a LINE comment opened a
// block match that ran to the end of the next docblock, ~7,100 characters later, deleting every
// import before any assertion saw it. An absence assertion about an import was then evaluated
// against an empty string and could never fail. This is a single-pass scanner over the four states a
// `//` or `/*` can be in — normal, line comment, block comment, string/template literal. The string
// state is not optional: it is why `'@deck.gl/*'` in an import specifier cannot re-open the hole.
// Its four-case suite lives in `gridDecomposition.test.ts`, which owns the guard's own guards.

export const stripComments = (src: string): string => {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '/' && d === '/') {
      while (i < src.length && src[i] !== '\n') i++
    } else if (c === '/' && d === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
    } else if (c === '"' || c === "'" || c === '`') {
      out += c
      i++
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') {
          out += src[i]
          i++
        }
        if (i < src.length) {
          out += src[i]
          i++
        }
      }
      if (i < src.length) {
        out += src[i]
        i++
      }
    } else {
      out += c
      i++
    }
  }
  return out
}
