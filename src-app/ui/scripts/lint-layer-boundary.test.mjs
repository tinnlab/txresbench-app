// Tests for `lint-layer-boundary.mjs` — ITEM-21 (INV-3 / INV-8).
//
// The guard is only worth having if it (a) FAILS on each of the three boundary
// violations, (b) PASSES on a legal barrel import, (c) PASSES on the edges that
// are BASELINED (the tree does not satisfy INV-3/INV-8 today and the guard says
// so honestly), and (d) FAILS when a baselined edge is removed without tightening
// the baseline — otherwise the count silently drifts back up. Every case builds a
// self-contained temp workbench tree and points the guard at it via the documented
// `LINT_LAYER_BOUNDARY_ROOT` / `_BASELINE` / `_MIN_FILES` overrides.
//
// The FINAL tests run the REAL guard over the REAL tree.
//
// Run directly:  node --test scripts/lint-layer-boundary.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const GUARD = path.join(__dirname, 'lint-layer-boundary.mjs')
const REAL_BASELINE = path.join(__dirname, 'layer-boundary-baseline.json')

function withTree(files, fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'layerbound-'))
  try {
    for (const [rel, body] of Object.entries(files)) {
      const abs = path.join(dir, rel)
      mkdirSync(path.dirname(abs), { recursive: true })
      writeFileSync(abs, body)
    }
    const baselinePath = path.join(dir, '.baseline.json')
    const run = (extraEnv = {}) => {
      const r = spawnSync(process.execPath, [GUARD], {
        encoding: 'utf8',
        env: {
          ...process.env,
          LINT_LAYER_BOUNDARY_ROOT: dir,
          LINT_LAYER_BOUNDARY_BASELINE: baselinePath,
          LINT_LAYER_BOUNDARY_MIN_FILES: '1',
          ...extraEnv,
        },
      })
      return { code: r.status, stdout: r.stdout, stderr: r.stderr }
    }
    const write = () => {
      spawnSync(process.execPath, [GUARD, '--write'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          LINT_LAYER_BOUNDARY_ROOT: dir,
          LINT_LAYER_BOUNDARY_BASELINE: baselinePath,
          LINT_LAYER_BOUNDARY_MIN_FILES: '1',
        },
      })
    }
    return fn({ dir, run, write, baselinePath })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The minimum legal tree: two barrels and nothing else. */
const BARRELS = {
  'core/index.ts': `export const CORE = 1\n`,
  'extensions/index.ts': `export const EXT = 1\n`,
}

// ── (a) each of the three rules FAILS ───────────────────────────────────────

test('[ITEM-21][R1] FAILS on a deep import PAST `core/index.ts`', () => {
  withTree(
    {
      ...BARRELS,
      'extensions/data/dataHost.ts': `import { thing } from '@/modules/workbench/core/runtime/store'\nexport const x = thing\n`,
    },
    ({ run }) => {
      const { code, stderr } = run()
      assert.equal(code, 1, 'reaching past the core barrel is a boundary violation')
      assert.match(stderr, /deep-import-across-layer/)
      assert.match(stderr, /core\/runtime\/store/)
    },
  )
})

test('[ITEM-21][R3] FAILS on an extension importing ANOTHER extension internals', () => {
  withTree(
    {
      ...BARRELS,
      'extensions/analysis/RerunPane.tsx': `import { useRunArtifacts } from '../jobs/useRunArtifacts'\nexport const p = useRunArtifacts\n`,
      'extensions/jobs/useRunArtifacts.ts': `export const useRunArtifacts = () => []\n`,
    },
    ({ run }) => {
      const { code, stderr } = run()
      assert.equal(code, 1)
      assert.match(stderr, /cross-extension-internal/)
      assert.match(stderr, /extensions\/jobs\/useRunArtifacts/)
    },
  )
})

test('[ITEM-21][R2] FAILS on a NEW `core/` → `extensions/` edge', () => {
  withTree(
    {
      ...BARRELS,
      'core/runtime/register.ts': `import { installBuiltinWidgets } from '@/modules/workbench/extensions'\nexport const r = installBuiltinWidgets\n`,
    },
    ({ run }) => {
      const { code, stderr } = run()
      assert.equal(code, 1, 'the dependency arrow points one way, barrel or not')
      assert.match(stderr, /core-imports-extensions/)
    },
  )
})

// ── (a′) [F2] the SAME violation, written across LINES ──────────────────────
//
// `3f345cc4` cut the TDZ import cycle `extensions/canvas/canvasDataSource` →
// `core/host/createHost` and recorded that "that ratchet is now the guard against
// re-introducing this edge". It was not. The scanner's static-import pattern used
// `[^;\n]*?` between `import` and `from`, so it saw a one-line import and nothing else:
// the one-line re-add failed, the five-line re-add — the spelling biome actually
// produces — exited 0 and silently restored the cycle.
//
// So the claim is now a TEST, and it asserts BOTH spellings on the SAME edge. A guard
// that catches only the formatting nobody uses is not a guard.

/** The exact edge `3f345cc4` cut, as its two spellings. */
const CUT_EDGE_TARGET = '../../core/host/createHost'
const CUT_EDGE = {
  'one-line': `import { workbenchLattice } from '${CUT_EDGE_TARGET}'\nexport const d = workbenchLattice\n`,
  'multi-line': `import {\n  workbenchLattice,\n  type DatatypeLattice,\n} from '${CUT_EDGE_TARGET}'\nexport const d: DatatypeLattice = workbenchLattice\n`,
}

for (const [spelling, body] of Object.entries(CUT_EDGE)) {
  test(`[F2][R1] FAILS on the re-introduced TDZ-cycle edge written ${spelling}`, () => {
    withTree(
      {
        ...BARRELS,
        'core/host/createHost.ts': `export const workbenchLattice = {}\nexport type DatatypeLattice = object\n`,
        'extensions/canvas/canvasDataSource.ts': body,
      },
      ({ run }) => {
        const { code, stderr } = run()
        assert.equal(code, 1, `a ${spelling} re-add is the SAME boundary violation:\n${stderr}`)
        assert.match(stderr, /deep-import-across-layer/)
        assert.match(stderr, /core\/host\/createHost/)
      },
    )
  })
}

test('[F2] a multi-line import THROUGH the barrel is still legal (no false positive)', () => {
  withTree(
    {
      ...BARRELS,
      'extensions/canvas/canvasDataSource.ts':
        `import {\n  CORE,\n  type Thing,\n} from '@/modules/workbench/core'\nexport const d: Thing = CORE\n`,
      // …and the multi-line `export … from` re-export form, which the barrels themselves use.
      'extensions/canvas/index.ts': `export {\n  d,\n} from './canvasDataSource'\n`,
    },
    ({ run }) => {
      const { code, stderr } = run()
      assert.equal(code, 0, `widening the clause must not criminalise the sanctioned form:\n${stderr}`)
    },
  )
})

test('[F2] the widened clause does not run past its own statement, and counts each edge ONCE', () => {
  withTree(
    {
      ...BARRELS,
      // Statement-initial `export`s whose clause characters are legal-looking, placed
      // BEFORE the only real import. A gap that could cross a statement would reach the
      // specifier below and record it a second time — inflating the tally and failing the
      // ratchet with a phantom "the count went up". The `{}` block is the shape that gets
      // closest: it is `export` + identifiers + braces, and only the `=` stops it.
      'extensions/data/dataHost.ts':
        `export const CONFIG = {\n  a: 1,\n}\n\nexport default CONFIG\n\n` +
        `import {\n  s,\n} from '@/modules/workbench/core/runtime/store'\nexport const a = s\n`,
    },
    ({ run, write, baselinePath }) => {
      write()
      const b = JSON.parse(readFileSync(baselinePath, 'utf8'))
      assert.equal(b.total, 1, `the one edge must be counted once, not twice: ${JSON.stringify(b.entries)}`)
      assert.deepEqual(Object.keys(b.entries), [
        'extensions/data/dataHost.ts|deep-import-across-layer|core/runtime/store',
      ])
      assert.equal(run().code, 0)
    },
  )
})

// ── (a″) [F3] the same violation again, with a COMMENT in the clause ─────────
//
// The [F2] widening replaced `[^;\n]*?` with the bounded class `[A-Za-z0-9_$,{}*\s]`,
// which excludes `/`. Any clause containing a comment therefore became invisible — and
// for the ONE-LINE spelling that was a strict REGRESSION, because `[^;\n]` allowed `/`
// and had matched it. A synthetic root with three real `core → extensions` edges (plain,
// inline block comment, wrapped line comment) reported ONE.
//
// Both comment spellings are asserted on the SAME rule as the plain form, so neither can
// silently stop being seen again. `[F3-neg]` below is the paired negative control: the
// fix must not turn comment PROSE into edges.

/** The three spellings of one `core/` → `extensions/` edge. Only the clause differs. */
const COMMENTED_EDGE = {
  plain: `import { EXT } from '@/modules/workbench/extensions'\nexport const a = EXT\n`,
  'inline block comment': `import { EXT /* the widget installer */ } from '@/modules/workbench/extensions'\nexport const a = EXT\n`,
  'wrapped line comment': `import {\n  EXT, // defensive install, see ITEM-21\n} from '@/modules/workbench/extensions'\nexport const a = EXT\n`,
}

for (const [spelling, body] of Object.entries(COMMENTED_EDGE)) {
  test(`[F3][R2] FAILS on a core → extensions edge whose clause has ${spelling}`, () => {
    withTree({ ...BARRELS, 'core/runtime/register.ts': body }, ({ run }) => {
      const { code, stderr } = run()
      assert.equal(code, 1, `a comment in the clause does not make the edge legal:\n${stderr}`)
      assert.match(stderr, /core-imports-extensions/)
    })
  })
}

test('[F3] all three spellings in ONE tree are counted — the 3-reported-as-1 symptom', () => {
  withTree(
    {
      ...BARRELS,
      'core/a/plain.ts': COMMENTED_EDGE.plain,
      'core/b/inline.ts': COMMENTED_EDGE['inline block comment'],
      'core/c/wrapped.ts': COMMENTED_EDGE['wrapped line comment'],
    },
    ({ write, baselinePath }) => {
      write()
      const b = JSON.parse(readFileSync(baselinePath, 'utf8'))
      assert.equal(b.total, 3, `three real edges, three counted: ${JSON.stringify(b.entries)}`)
      assert.deepEqual(Object.keys(b.entries).sort(), [
        'core/a/plain.ts|core-imports-extensions|extensions',
        'core/b/inline.ts|core-imports-extensions|extensions',
        'core/c/wrapped.ts|core-imports-extensions|extensions',
      ])
    },
  )
})

test('[F3-neg] a comment that MENTIONS `from \'…\'` mints no phantom edge', () => {
  withTree(
    {
      ...BARRELS,
      // Prose, not code. Each form gets its OWN file, so neither leg can be carried by the
      // other, and each names a target that WOULD be a real `core-imports-extensions`
      // violation if the scan reached it.
      //
      // The LINE-comment file is the one with teeth: `//[^\n]*` can stop ANYWHERE, so a
      // backtrackable alternative lets the trailing `\bfrom\s*'…'` match inside the
      // sentence and mint an edge out of it — measured, it does. Consuming the comment
      // ATOMICALLY is what forbids that. The BLOCK-comment file is a control: `/\*…\*/`
      // must end at a terminator, so that form was never reachable; it is pinned so a
      // future rewrite of the clause cannot quietly make it so.
      'core/runtime/register.ts':
        `export {}\n` +
        `// historically re-exported from '@/modules/workbench/extensions' — no longer\n` +
        `export const ok = 1\n`,
      'core/render/install.ts':
        `export {}\n` +
        `/*\n * and the block form: from '@/modules/workbench/extensions/canvas/dataSource'\n */\n` +
        `export const ok = 1\n`,
    },
    ({ run, write, baselinePath }) => {
      write()
      const b = JSON.parse(readFileSync(baselinePath, 'utf8'))
      assert.equal(b.total, 0, `comment prose is not an import: ${JSON.stringify(b.entries)}`)
      assert.equal(run().code, 0)
    },
  )
})

// ── (b) legal imports PASS ──────────────────────────────────────────────────

test('[ITEM-21] PASSES on legal BARREL imports across the boundary', () => {
  withTree(
    {
      ...BARRELS,
      'extensions/data/dataHost.ts': `import { CORE } from '@/modules/workbench/core'\nexport const a = CORE\n`,
      'extensions/jobs/jobsHost.ts': `import { CORE } from '../../core/index.ts'\nexport const b = CORE\n`,
      'module.tsx': `import { EXT } from '@/modules/workbench/extensions'\nexport const c = EXT\n`,
    },
    ({ run }) => {
      const { code, stdout, stderr } = run()
      assert.equal(code, 0, `a barrel import is the SANCTIONED form:\n${stderr}`)
      assert.match(stdout, /ZERO new/)
    },
  )
})

test('[ITEM-21] PASSES on intra-layer + out-of-workbench imports (not this rule’s business)', () => {
  withTree(
    {
      ...BARRELS,
      // intra-core (the `core/spec/schema.ts` → `core/render/registry` shape)
      'core/spec/schema.ts': `import { hasWidget } from '../render/registry'\nexport const s = hasWidget\n`,
      'core/render/registry.ts': `export const hasWidget = () => true\n`,
      // intra-extension
      'extensions/jobs/RunPane.tsx': `import { j } from './jobsHost'\nexport const r = j\n`,
      'extensions/jobs/jobsHost.ts': `export const j = 1\n`,
      // outside the workbench entirely
      'extensions/canvas/viz.tsx': `import { Viz } from '@ziee/viz'\nimport { api } from '@/core/workstore/arrowClient'\nexport const v = [Viz, api]\n`,
    },
    ({ run }) => {
      const { code, stderr } = run()
      assert.equal(code, 0, `only CROSS-layer edges are in scope:\n${stderr}`)
    },
  )
})

test('[ITEM-21] `extensions/index.ts` composing its own extensions is NOT an R3 violation', () => {
  withTree(
    {
      'core/index.ts': `export const CORE = 1\n`,
      'extensions/index.ts': `export { d } from './data/contract'\nexport { j } from './jobs/contract'\n`,
      'extensions/data/contract.ts': `export const d = 1\n`,
      'extensions/jobs/contract.ts': `export const j = 1\n`,
    },
    ({ run }) => {
      const { code, stderr } = run()
      assert.equal(code, 0, `the layer barrel's JOB is to compose the layer:\n${stderr}`)
    },
  )
})

test('[ITEM-21] `*.test.ts` files are exempt (a test reaching in is not an architecture violation)', () => {
  withTree(
    {
      ...BARRELS,
      'extensions/data/dataHost.test.ts': `import { s } from '@/modules/workbench/core/runtime/store'\nexport const t = s\n`,
    },
    ({ run }) => {
      assert.equal(run().code, 0)
    },
  )
})

// ── (c) + (d) the RATCHET ───────────────────────────────────────────────────

test('[ITEM-21][ratchet] PASSES on the BASELINED edges, then FAILS when a new one is added', () => {
  withTree(
    {
      ...BARRELS,
      'extensions/data/dataHost.ts': `import { s } from '@/modules/workbench/core/runtime/store'\nexport const a = s\n`,
    },
    ({ run, write, dir, baselinePath }) => {
      write()
      assert.equal(run().code, 0, 'a baselined edge is accepted')
      const b = JSON.parse(readFileSync(baselinePath, 'utf8'))
      assert.equal(b.total, 1)

      // add a SECOND, unlisted violation
      mkdirSync(path.join(dir, 'extensions', 'jobs'), { recursive: true })
      writeFileSync(
        path.join(dir, 'extensions', 'jobs', 'jobsHost.ts'),
        `import { g } from '@/modules/workbench/core/runtime/gate'\nexport const b = g\n`,
      )
      const { code, stderr } = run()
      assert.equal(code, 1, 'the boundary may not get WORSE')
      assert.match(stderr, /1 NEW layer-boundary violation/)
    },
  )
})

test('[ITEM-21][ratchet] FAILS when an edge is REMOVED but the baseline entry is not', () => {
  withTree(
    {
      ...BARRELS,
      'extensions/data/dataHost.ts': `import { s } from '@/modules/workbench/core/runtime/store'\nexport const a = s\n`,
    },
    ({ run, write, dir }) => {
      write()
      assert.equal(run().code, 0)

      // FIX the import (through the barrel) but leave the baseline alone
      writeFileSync(
        path.join(dir, 'extensions', 'data', 'dataHost.ts'),
        `import { CORE } from '@/modules/workbench/core'\nexport const a = CORE\n`,
      )
      const { code, stderr } = run()
      assert.equal(code, 1, 'a stale baseline lets the count drift back up silently')
      assert.match(stderr, /STALE baseline/)
      assert.match(stderr, /tightened/)
    },
  )
})

test('[ITEM-21][ratchet] the same violation appearing TWICE in one file is counted, not deduped', () => {
  withTree(
    {
      ...BARRELS,
      'extensions/data/dataHost.ts': `import { s } from '@/modules/workbench/core/runtime/store'\nexport const a = s\n`,
    },
    ({ run, write, dir }) => {
      write()
      writeFileSync(
        path.join(dir, 'extensions', 'data', 'dataHost.ts'),
        `import { s } from '@/modules/workbench/core/runtime/store'\n` +
          `import type { T } from '@/modules/workbench/core/runtime/store'\n` +
          `export const a: T = s\n`,
      )
      assert.equal(run().code, 1, 'going from 1 to 2 on the SAME key is still getting worse')
    },
  )
})

// ── ITEM-37 floor ───────────────────────────────────────────────────────────

test('[ITEM-37] FAILS when the workbench root collapses (floor left at its committed value)', () => {
  withTree(BARRELS, ({ dir }) => {
    const empty = path.join(dir, 'nothing-here')
    mkdirSync(empty, { recursive: true })
    const r = spawnSync(process.execPath, [GUARD], {
      encoding: 'utf8',
      env: {
        ...process.env,
        LINT_LAYER_BOUNDARY_ROOT: empty,
        LINT_LAYER_BOUNDARY_BASELINE: path.join(dir, '.b.json'),
        LINT_LAYER_BOUNDARY_MIN_FILES: undefined,
      },
    })
    assert.equal(r.status, 1, 'a collapsed scan set is a BROKEN guard, never a pass')
    assert.match(r.stderr, /SCAN SET COLLAPSED/)
  })
})

// ── the REAL tree ───────────────────────────────────────────────────────────

test('[ITEM-21] the REAL workbench tree matches its committed baseline exactly', () => {
  const r = spawnSync(process.execPath, [GUARD], { encoding: 'utf8' })
  assert.equal(r.status, 0, `layer boundary drifted:\n${r.stdout}\n${r.stderr}`)
  assert.match(r.stdout, /ZERO new \(ITEM-21 ratchet, INV-3\/INV-8\)/)
})

test('[ITEM-21] the committed baseline is HONEST — it records real, nonzero debt', () => {
  const b = JSON.parse(readFileSync(REAL_BASELINE, 'utf8'))
  assert.ok(b.total > 0, 'a baseline of 0 would mean the rule is already satisfied — it is not')
  assert.equal(
    b.total,
    Object.values(b.entries).reduce((a, c) => a + c, 0),
    'the recorded total must equal the sum of its entries',
  )
  const kinds = new Set(Object.keys(b.entries).map(k => k.split('|')[1]))
  // All three rules have real debt today; if one ever empties, DELETE its entries
  // and let this assertion tell you the rule graduated from ratchet to law.
  assert.deepEqual(
    [...kinds].sort(),
    ['core-imports-extensions', 'cross-extension-internal', 'deep-import-across-layer'],
  )
})
