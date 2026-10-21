import { expect, test } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'

// TEST-23 (ITEM-21, ITEM-22) — P5 `@/modules/workbench/core` end-to-end in the shipped app.
// The `workbench` FE module runs built-in + processor-package discovery at boot and
// exposes the REAL contribution registry on `window.__workbenchRegistry` (the same
// testability seam as `core/datatypes`' `__datatypeRegistry`). No vitest runner exists
// for the app, so this browser spec is the genuine end-to-end proof of the contract: the
// registry is populated, and availability gating computes against the REAL P2 lattice.
//
// Repointed off the retired `demo.leiden` fixture (the `demo-analysis` builtin was
// deleted in Slice 5). ITEM-15/16 then deleted the last FE-CODE package
// (`processor-packages/single-cell`) and with it the `selection.demo` dogfood, so every
// registered analysis is now DATA-declared by a `packages/*` package — which is the
// stronger statement this spec now makes.

type Wb = {
  analyses: () => string[]
  views: () => string[]
  available: (id: string, typeIds?: string[]) => boolean
  catalog: (typeIds?: string[]) => { version: string; entries: Array<{ id: string; available: boolean; kind: string }> }
  version: string
}

test('the workbench registry is populated with the discovered contributions at boot — TEST-23', async ({ page }) => {
  await loginAsOwner(page)

  // Discovery runs at module import; wait for the seam + the registrations.
  await page.waitForFunction(() => {
    const r = (window as unknown as { __workbenchRegistry?: Wb }).__workbenchRegistry
    return Boolean(r && r.analyses().includes('qc.10x'))
  }, undefined, { timeout: 20_000 })

  const info = await page.evaluate(() => {
    const r = (window as unknown as { __workbenchRegistry: Wb }).__workbenchRegistry
    return { analyses: r.analyses(), views: r.views(), version: r.version }
  })
  // Every registered analysis is DATA-declared by a `packages/*` package (no FE-code
  // package contributes one any more — ITEM-15).
  expect(info.analyses).toEqual(expect.arrayContaining(['qc.10x', 'cell.filter', 'cellranger.count']))
  // NOTE: no per-analysis view pane is registered (ITEM-32/14/15 — analyses contribute
  // no view panes; the declarative surfaces are `view_spec` DATA).
  expect(info.version).toBe('1.0.0')
})

test('availability gating computes against the REAL P2 datatype lattice — TEST-23', async ({ page }) => {
  await loginAsOwner(page)

  // Wait for BOTH the workbench registry AND the datatype lattice to know the types the
  // availability check needs (isA(single-cell/counts, single-cell/expression)).
  await page.waitForFunction(() => {
    const r = (window as unknown as { __workbenchRegistry?: Wb }).__workbenchRegistry
    const dt = (window as unknown as { __datatypeRegistry?: { all: () => string[] } }).__datatypeRegistry
    return Boolean(r && r.analyses().includes('qc.10x') && dt && dt.all().includes('single-cell/counts'))
  }, undefined, { timeout: 20_000 })

  const gating = await page.evaluate(() => {
    const r = (window as unknown as { __workbenchRegistry: Wb }).__workbenchRegistry
    return {
      // qc.10x accepts `subtypes_of: single-cell/expression` — a raw count matrix IS one.
      withCounts: r.available('qc.10x', ['single-cell/counts']),
      // clustering is NOT a subtype of single-cell/expression → gated.
      withClustering: r.available('qc.10x', ['clustering']),
      catalogWithCounts: r.catalog(['single-cell/counts']).entries.find(e => e.id === 'qc.10x'),
      catalogGated: r.catalog([]).entries.find(e => e.id === 'qc.10x'),
    }
  })
  expect(gating.withCounts).toBe(true)
  expect(gating.withClustering).toBe(false)
  // The MCP metadata projection reflects availability (the AI's tool set == valid-now).
  expect(gating.catalogWithCounts?.available).toBe(true)
  expect(gating.catalogWithCounts?.kind).toBe('analysis')
  expect(gating.catalogGated?.available).toBe(false)
})
