// serveBench.test.ts — the ONE unit-testable contract of the prod-bench harness (FIX_ROUND-2 / C21).
//
// Placed in `grid/` for the same reason `renderPerfBudgets.test.ts` is: this directory already owns
// the unit half of the render-perf gate, including the parts of it that live under `scripts/`.
//
// ── C21: TEST-23's freshness contract is SELF-SATISFYING under its own runner ────────────────────
// `playwright.viz.config.ts`'s bench `webServer` runs `serve-bench.mjs`, whose `buildIfStale()`
// rebuilds on a hash mismatch and WRITES `dist-bench/.buildinfo` from the current tree before the
// server reports ready. TEST-23 then asserts `.buildinfo.buildHash === computeBuildHash()` — equal
// BY CONSTRUCTION on any run where the webServer actually started it. The staleness it was written
// for ("a stale prod bundle does not fail a perf gate, it reports the OLD numbers, which reads
// exactly like a successful fix") cannot arise on the path the test runs on.
//
// What CAN be tested, and is the actual property the contract rests on, is that the hash is
// SENSITIVE: that a change to a build input moves it. If it were not, the whole buildinfo contract
// would be decorative no matter which path evaluated it. This is a PURE function over a temp dir —
// no processes, no ports, no stand-ins — which is why it is the half that belongs in a unit suite.
//
// ── WHAT WAS DELETED HERE, AND WHY (DEC-45 / FIX_ROUND-6) ────────────────────────────────────────
// This file also carried a five-test guard over B5 — "the preview teardown reaps the GRANDCHILD" —
// that tried to pin, from a unit suite, the property *the process serving :1422 is reachable by
// Playwright's own group kill*. It has been REMOVED, by owner decision, and replaced by TEST-F6 in
// `src-app/ui/tests/viz-e2e/render-perf-ms.spec.ts`, which asserts the property on the REAL server.
//
// The reason is not that the guard was badly written; it is that the property is not a unit
// property. A unit stand-in cannot see the runner's teardown contract, so every version of the
// guard approximated it with a source/shape predicate, and a shape predicate over a SEMANTIC
// property has an unbounded evasion space. Measured: rounds 3, 4 and 5 of the fix loop each found a
// NEW spelling of the SAME defect (the guard's subject is not the production call) — first the
// spawn was injectable, then the argv, then the cwd went unobserved — and round 4 re-introduced the
// literal B5 root cause with every clause green. 14 of the last 14 findings landed on this guard
// and its records; zero on the feature. See DEC-45.


import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — a .mjs script with no type declarations; this test IS its type contract.
import { computeBuildHash } from '../../../scripts/serve-bench.mjs'

describe('serve-bench — the build hash is SENSITIVE (C21)', () => {
  it('changes when a build input changes, and is stable when nothing does', () => {
    const root = mkdtempSync(join(tmpdir(), 'bench-hash-'))
    try {
      mkdirSync(join(root, 'src'))
      writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1\n')
      writeFileSync(join(root, 'viz-showcase.html'), '<html></html>')
      writeFileSync(join(root, 'vite.config.ts'), 'export default {}')
      writeFileSync(join(root, 'vite.bench.config.ts'), 'export default {}')
      writeFileSync(join(root, 'package.json'), '{"sideEffects":["**/*.css"]}')

      const h0 = computeBuildHash(root)
      expect(h0, 'a hash must be produced at all').toMatch(/^[0-9a-f]{8,}$/)
      expect(computeBuildHash(root), 'the same bytes must hash the same — content, not mtimes').toBe(h0)

      // A source edit moves it. This is the property TEST-23's contract rests on and cannot itself
      // exercise (its webServer rebuilds before it looks).
      writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 2\n')
      expect(computeBuildHash(root), 'a src change must invalidate the bundle').not.toBe(h0)

      // …and so does `package.json`, which is in the input set because `sideEffects` is a rollup
      // TREE-SHAKING DIRECTIVE: mis-set, the bundle builds clean, serves 200, and contains no
      // stories. The comment in `serve-bench.mjs` records that; nothing asserted it.
      writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1\n')
      expect(computeBuildHash(root)).toBe(h0)
      writeFileSync(join(root, 'package.json'), '{"sideEffects":false}')
      expect(computeBuildHash(root), 'a sideEffects flip must invalidate the bundle').not.toBe(h0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
