import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'

// P2 datatype-system FE (ITEM-7/21/19). The FE registry populates from
// `GET /api/datatypes` at boot and is exposed on `window.__datatypeRegistry` (the
// app is served as a preview build with no /src imports + there is no vitest
// runner — same seam as `core/workstore`'s `__workstore`). These specs exercise
// the REAL shipped lattice logic in the browser.

const here = dirname(fileURLToPath(import.meta.url))
// The SINGLE shared golden fixture — the Rust golden test reads the same file.
//
// TEST-15 (fix/zero-core-derived): the fixture's `lattice` array is GONE, so the type no
// longer declares it. That array enumerated every type in the registry and was asserted
// against `reg.len()` on the Rust side, which made contributing a datatype cost an edit to
// a file under `src-app/server/src/` — mutually unsatisfiable with the zero-core invariant.
// The full type set is now DERIVED there from the package manifests
// (docs/design/derived-guards.md §4). This spec never read `lattice`; it replays the four
// behavioural CASE tables below, which are cases OVER the lattice rather than an
// enumeration OF it, so a new datatype does not invalidate them and they are unchanged.
const golden = JSON.parse(
  readFileSync(
    resolve(here, '../../../../server/src/modules/datatype/tests/lattice_golden.json'),
    'utf8',
  ),
) as {
  is_a: { sub: string; sup: string; expect: boolean }[]
  accepts: { datatype: string; selector: Record<string, unknown>; expect: boolean }[]
  viewers_for: { datatype: string; expect: string[] }[]
  layout_kind: { datatype: string; expect: string }[]
}

type Reg = {
  isA: (a: string, b: string) => boolean
  accepts: (dt: string, sel: unknown) => boolean
  viewersFor: (dt: string) => string[]
  all: () => string[]
  size: () => number
  layoutKind: (dt: string) => string | null
  capabilities: (dt: string) => string[]
}

function reg(): Reg {
  return (window as unknown as { __datatypeRegistry: Reg }).__datatypeRegistry
}

// TEST-27 — the FE registry populates from /api/datatypes at boot. Proven by
// asserting AUTHORITATIVE data only the API provides (capabilities + viewers) — the
// 10-entry bootstrap skeleton has neither, so this cannot pass on the bootstrap alone.
test('the FE datatype registry populates from the backend at boot — TEST-27', async ({ page }) => {
  await loginAsOwner(page)
  // Wait for the API populate specifically: capabilities are empty in the bootstrap,
  // so a non-empty capability set proves the authoritative fetch replaced it.
  await page.waitForFunction(() => {
    const r = (window as unknown as { __datatypeRegistry?: Reg }).__datatypeRegistry
    return Boolean(r && r.capabilities('single-cell/expression').length > 0)
  }, undefined, { timeout: 20_000 })

  const info = await page.evaluate(() => {
    const r = (window as unknown as { __datatypeRegistry: Reg }).__datatypeRegistry
    return {
      ids: r.all(),
      caps: r.capabilities('single-cell/expression'),
      viewers: r.viewersFor('single-cell/expression'),
    }
  })
  for (const id of ['data', 'matrix', 'single-cell/expression', 'embedding', 'report/html']) {
    expect(info.ids).toContain(id)
  }
  // API-only payload — absent from the bootstrap skeleton.
  expect(info.caps).toContain('has-obs')
  expect(info.viewers).toContain('matrix-grid')
})

// TEST-28 — the FE registry computes every golden is_a/accepts/viewers_for case
// identically to the Rust registry (the TS half of the parity gate, ITEM-7).
test('the FE registry matches the shared golden lattice fixture — TEST-28', async ({ page }) => {
  await loginAsOwner(page)
  await page.waitForFunction(() => {
    const r = (window as unknown as { __datatypeRegistry?: { size: () => number } }).__datatypeRegistry
    // Wait for the FULL API populate (viewers present), not just the bootstrap.
    return Boolean(
      r && r.size() >= 10 &&
      (window as unknown as { __datatypeRegistry: Reg }).__datatypeRegistry.viewersFor('single-cell/expression').length > 0,
    )
  }, undefined, { timeout: 20_000 })

  const result = await page.evaluate((g) => {
    const r = (window as unknown as { __datatypeRegistry: Reg }).__datatypeRegistry
    const fails: string[] = []
    for (const c of g.is_a) {
      if (r.isA(c.sub, c.sup) !== c.expect) fails.push(`is_a(${c.sub},${c.sup})=${!c.expect}`)
    }
    for (const c of g.accepts) {
      if (r.accepts(c.datatype, c.selector) !== c.expect) fails.push(`accepts(${c.datatype})=${!c.expect}`)
    }
    // EXACT viewer list (not just containment) — catches a divergent/re-ordered viewer.
    for (const c of g.viewers_for) {
      const got = r.viewersFor(c.datatype)
      if (JSON.stringify(got) !== JSON.stringify(c.expect)) {
        fails.push(`viewersFor(${c.datatype})=[${got}] != [${c.expect}]`)
      }
    }
    // layout.kind serde tag parity (guards the chunked_1d class of rename bug).
    for (const c of g.layout_kind) {
      const got = r.layoutKind(c.datatype)
      if (got !== c.expect) fails.push(`layoutKind(${c.datatype})=${got} != ${c.expect}`)
    }
    return fails
  }, golden)

  expect(result, `golden parity failures: ${result.join('; ')}`).toEqual([])
})

// TEST-30 — viewer dispatch resolves UP the lattice (ITEM-19).
test('viewersFor resolves the matrix-family viewer up the lattice — TEST-30', async ({ page }) => {
  await loginAsOwner(page)
  await page.waitForFunction(() => {
    const r = (window as unknown as { __datatypeRegistry?: Reg }).__datatypeRegistry
    return Boolean(r && r.viewersFor('single-cell/expression').length > 0)
  }, undefined, { timeout: 20_000 })

  const viewers = await page.evaluate(() => ({
    expr: (window as unknown as { __datatypeRegistry: Reg }).__datatypeRegistry.viewersFor('single-cell/expression'),
    emb: (window as unknown as { __datatypeRegistry: Reg }).__datatypeRegistry.viewersFor('embedding'),
    report: (window as unknown as { __datatypeRegistry: Reg }).__datatypeRegistry.viewersFor('report/html'),
  }))
  // expr inherits matrix-grid from `matrix`.
  expect(viewers.expr).toContain('matrix-grid')
  // emb has its OWN scatter first, then inherits matrix-grid.
  expect(viewers.emb[0]).toBe('embedding-scatter')
  expect(viewers.emb).toContain('matrix-grid')
  // report has its own viewer, not a matrix one.
  expect(viewers.report).toContain('report')
  expect(viewers.report).not.toContain('matrix-grid')
})

// TEST-35 — an IN-SESSION logout (no page reload) resets the registry to the
// non-sensitive bootstrap, so a subsequent (possibly restricted) login never
// inherits the prior account's authoritative lattice (the resetDatatypeRegistry
// logout-latch fix). Exercises the module.tsx `!isAuthenticated` else-branch.
test('in-session logout resets the registry to the bootstrap — TEST-35', async ({ page }) => {
  await loginAsOwner(page)
  // Wait for the authoritative populate (viewers are API-only).
  await page.waitForFunction(() => {
    const r = (window as unknown as { __datatypeRegistry?: Reg }).__datatypeRegistry
    return Boolean(r && r.viewersFor('single-cell/expression').length > 0)
  }, undefined, { timeout: 20_000 })

  // In-session logout via the user menu → Stores.Auth.logoutUser() (no reload).
  await page.getByTestId('user-profile-widget').click()
  await page.getByText('Logout', { exact: true }).click()

  // The routerEffects boot effect sees isAuthenticated=false → resets the registry
  // to the bootstrap (viewers empty) WITHOUT a reload — the singleton persists.
  await page.waitForFunction(() => {
    const r = (window as unknown as { __datatypeRegistry?: Reg }).__datatypeRegistry
    return Boolean(r && r.viewersFor('single-cell/expression').length === 0)
  }, undefined, { timeout: 15_000 })
})
