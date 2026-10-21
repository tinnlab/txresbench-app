// dataSeamGate.test.ts — the DATA-BEARING e2e seams must fold out of a release bundle.
//
// ── WHAT THIS PINS, AND WHY IT IS A SOURCE CHECK ────────────────────────────────────────────────
// The streaming stretch added a family of `window.__*` seams that hand a spec the REAL data plane:
// resolved `$data` frames, decoded column bodies, per-stream chunk accounting. Unlike the older
// registry/pane seams (which expose a manifest or a list of pane ids), these expose LIVE BUFFERS BY
// REFERENCE — `__declarativeStores().data` is the very frame `canvasBinding` aliases into the render
// path and into the keep-mask derivation, so a write through the seam reaches both. Shipping that in
// a release bundle is the finding this guard closes (`declarativeMount.ts` shipped gated only on
// `typeof window`, while its five siblings were gated correctly).
//
// The property is BUILD-TIME FOLDING: `import.meta.env.DEV || import.meta.env.VITE_ENABLE_TEST_SEAMS`
// is what Vite substitutes with `false || undefined` in a release build so the whole block is dropped.
// That is a property of the SOURCE EXPRESSION — there is no runtime state to observe in vitest, where
// `import.meta.env.DEV` is true by construction and every seam is therefore present. A behavioural
// test here would pass under both the gated and the ungated source, i.e. it would be vacuous. Hence a
// static check on the one thing that actually decides the outcome.
//
// ── SCOPE: the data-bearing seams, deliberately not every `window.__*` ──────────────────────────
// The tree also carries older seams (`__workbench`, `__workbenchRegistry`, `__workbenchPanes`,
// `__canvasPanes`, `__actions`, `__datatypeRegistry`) gated only on `typeof window`. They expose
// registry/layout metadata, not data buffers, they predate this stretch, and widening this guard to
// them would be a separate change with its own risk. This list is the class this stretch introduced;
// ADD TO IT when a new seam hands out data.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const srcRoot = path.resolve(here, '../..')

/** file → the seam identifier whose install must be gated. */
const DATA_BEARING_SEAMS: ReadonlyArray<readonly [file: string, seam: string]> = [
  ['modules/workbench/core/render/declarativeMount.ts', '__declarativeStores'],
  ['core/workstore/index.ts', '__cyto_read'],
  ['core/workstore/decodeCounter.ts', '__cyto_count_decodes'],
  ['modules/workbench/extensions/data/projectSources.ts', '__cyto_stream'],
  ['modules/workbench/extensions/data/workbenchDataSource.ts', '__cyto_ds'],
]

/** The exact expression Vite folds. Whitespace-tolerant, token-exact. */
const GATE = /import\.meta\.env\.DEV\s*\|\|\s*import\.meta\.env\.VITE_ENABLE_TEST_SEAMS/

describe('data-bearing e2e seams are gated so they fold out of a release build', () => {
  for (const [file, seam] of DATA_BEARING_SEAMS) {
    it(`${seam} (${file}) installs only under DEV || VITE_ENABLE_TEST_SEAMS`, () => {
      const source = readFileSync(path.join(srcRoot, file), 'utf8')

      // Non-vacuity: this guard is worthless if the seam it names has been renamed or removed and
      // the assertion below then trivially holds over a file that no longer installs anything.
      const install = source
        .split('\n')
        .map((line, i) => [i + 1, line] as const)
        .filter(([, line]) => line.includes(`.${seam}`) && line.includes('='))
      expect(install.length, `no install site for ${seam} — update this guard`).toBeGreaterThan(0)

      // The gate must appear, and it must appear BEFORE the install (a gate written after the
      // assignment guards nothing).
      const gateAt = source.search(GATE)
      expect(gateAt, `${seam} is not gated on DEV || VITE_ENABLE_TEST_SEAMS`).toBeGreaterThanOrEqual(0)
      const gateLine = source.slice(0, gateAt).split('\n').length
      for (const [lineNo] of install) {
        expect(gateLine, `${seam} is assigned at line ${lineNo}, above its gate`).toBeLessThan(lineNo)
      }
    })
  }
})
