import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { loginAsOwner, ownerToken } from '../project/_helpers'
import { BACKEND, createProject, openWorkbench } from './_dock'
import {
  CF,
  CFRow,
  awaitFilterSurface,
  addCriterion,
  seedAnndataImport,
  type SeedAnndataImportResult,
} from '../14-declarative-qc/_seed'

// cell-filter-scatter-wiring — the END-TO-END proof that the declarative cell-filter EMBEDDING
// SCATTER (a) PAINTS real UMAP coordinates (Bug 2: the scatter now binds the real `embedding`
// artifact's positions, not the fabricated first-two-metric-columns) and (b) VISIBLY THINS as a
// keep-mask applies (the `.kept` source masks the real positions to the surviving cells), with the
// categorical keep-set now actually populated (Bug 3: `critKeep.options` = the column's distinct
// categories via the new `categories_by_column` derivation).
//
// Seed = the REAL `anndata-import` converter: `POST /_debug/seed` (driver `single-file-import`) runs the production
// `h5ad_import.py` over a genuine pbmc68k UMAP `.h5ad` (700 cells, `obsm['X_umap']` + `bulk_labels`/
// `louvain`/`n_counts`) on the host python, cataloging a genuine `embedding` (real UMAP coords) +
// a `report/qc` obs.json (the criterion columns). No mock — the coordinates ARE the dataset's X_umap.
//
// The proof is DATA-PLANE (headless swiftshader paints the deck scatter only faintly, so a pixel
// COUNT is not a reliable "thinning" signal): (1) the cataloged `embedding` artifact's served bytes
// decode to the real X_umap coords the scatter binds; (2) applying the filter re-derives the store's
// `keptMask` (read via the `window.__declarativeStores` seam) — the surviving-cell count that feeds
// the `obs.kept` scatter drops well below the total; (3) `critKeep` lists the real categories (Bug 3).
// A render check confirms the scatter is non-blank (real positions reach deck); screenshots attached.
//
// The h5ad fixture is machine-staged (4.5 MB of real data, not committed); the spec reads it from
// the repo's own staging directory and self-describes if absent (never a silent skip-as-pass).
//
// THE DEFAULT MUST BE DISCOVERABLE INSIDE THIS REPO. It used to be an absolute path under
// `/data/…/tmp/` on one developer's box, pointing into a DIFFERENT repository. On every other
// machine (and on that one, once the scratch dir was cleaned) the fixture was absent, so this
// spec skipped — and `just e2e-processors` treats ANY skip as a hard FAIL, so the missing file
// was load-bearing in a way nobody would expect from reading the tier.
// `.cyto-cache/fixtures/` is the convention the recipe already stages into; `CYTO_E2E_FIXTURES`
// relocates the whole staging dir, and `CELLFILTER_H5AD` still overrides this one file.
const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = process.env.CYTO_E2E_FIXTURES ?? resolve(HERE, '../../../../../.cyto-cache/fixtures')
const H5AD_PATH = process.env.CELLFILTER_H5AD ?? resolve(FIXTURES, 'pbmc68k_reduced.h5ad')
// Screenshot sink: Playwright's own per-test output dir (`test-results/…`, gitignored + reported)
// unless overridden. The previous default wrote PNGs into that same foreign absolute path.
const SHOTS_OVERRIDE = process.env.CELLFILTER_SHOTS
const HAVE_H5AD = existsSync(H5AD_PATH)

type SeedResp = SeedAnndataImportResult

/** The surviving-cell count the active declarative store's `keptMask` derives (the mask that feeds
 *  the `obs.kept` scatter) — read from the read-only `window.__declarativeStores` e2e seam. This is
 *  the DATA-PLANE proof that a form edit re-derives the keep-mask, independent of headless-GL pixels. */
const FILTER_SPEC_TYPE = 'cell.filter'

async function keptInfo(page: Page, specType = FILTER_SPEC_TYPE): Promise<{ keptTotal: number; keptCount: number }> {
  return page.evaluate((type) => {
    const read = (window as unknown as {
      __declarativeStores?: () => Array<{ type: string; keptTotal: number; keptCount: number }>
    }).__declarativeStores
    const stores = read ? read() : []
    const s = stores.find(x => x.type === type)
    return { keptTotal: s?.keptTotal ?? 0, keptCount: s?.keptCount ?? 0 }
  }, specType)
}

// The grid renders ONE shared `<DeckGL>` canvas spanning every pane (GridWorkspace), so per-cell
// point coverage is measured by CROPPING that shared canvas to the cell's on-screen rect (the same
// technique as `visualization/grid-multispace.spec.ts`) and counting painted (non-transparent) deck
// pixels — deck paints opaque points over a transparent background, so alpha coverage == points.

/** Painted (alpha > 8) deck pixels of the shared canvas CROPPED to cell `cellId`'s rect, PLUS the
 *  cropped region's area — so callers can compute a size-INVARIANT point DENSITY (painted/area).
 *  The auto-grid gives the two embedding panes different sizes, and each isolated pane auto-fits its
 *  own data, so density (not raw count) is the fair "how full of points" measure. `painted:-1` when
 *  the cell/canvas is absent. */
async function cellPaint(page: Page, cellId: string): Promise<{ painted: number; area: number }> {
  return page.evaluate((id) => {
    const cell = document.querySelector(`[data-testid="viz-cell-view-${id}"]`)
    const canvas = document.querySelectorAll('canvas')[0] as HTMLCanvasElement | undefined
    if (!cell || !canvas) return { painted: -1, area: 0 }
    const cr = canvas.getBoundingClientRect()
    const er = cell.getBoundingClientRect()
    if (cr.width <= 0 || cr.height <= 0) return { painted: -1, area: 0 }
    const scaleX = canvas.width / cr.width
    const scaleY = canvas.height / cr.height
    const sx = Math.max(0, Math.round((er.left - cr.left) * scaleX))
    const sy = Math.max(0, Math.round((er.top - cr.top) * scaleY))
    const sw = Math.min(canvas.width - sx, Math.round(er.width * scaleX))
    const sh = Math.min(canvas.height - sy, Math.round(er.height * scaleY))
    if (sw <= 0 || sh <= 0) return { painted: -1, area: 0 }
    const off = document.createElement('canvas')
    off.width = canvas.width
    off.height = canvas.height
    const ctx = off.getContext('2d')
    if (!ctx) return { painted: -1, area: 0 }
    try {
      ctx.drawImage(canvas, 0, 0)
      const { data } = ctx.getImageData(sx, sy, sw, sh)
      let n = 0
      for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 8) n++
      return { painted: n, area: sw * sh }
    } catch {
      return { painted: -1, area: 0 }
    }
  }, cellId)
}

test.describe('cell-filter embedding scatter paints real UMAP + thins on filter', () => {
  test.skip(
    !HAVE_H5AD,
    `pbmc68k UMAP .h5ad not staged at ${H5AD_PATH} — stage it there, or set CYTO_E2E_FIXTURES ` +
      `(the staging dir) / CELLFILTER_H5AD (this one file)`,
  )
  // A large viewport so the auto-grid's before/after panes (2 emb + the criteria's violin/bar
  // panes) all fit + the emb panes stay on-screen + measurable.
  test.use({ viewport: { width: 1720, height: 1400 } })

  test('the embedding scatter binds real UMAP + the keep-mask (feeding it) thins on filter', async ({
    page,
    request,
  }) => {
    const shots = SHOTS_OVERRIDE ?? test.info().outputPath('shots')
    mkdirSync(shots, { recursive: true })

    await loginAsOwner(page)
    const id = await createProject(request, `CellFilter Scatter ${Date.now()}`)
    const seed = await seedAnndataImport(request, id, readFileSync(H5AD_PATH))
    expect(seed.n_cells).toBeGreaterThan(100)
    // Bug-3 precondition: the converter produced the categorical columns the keep-set will offer.
    expect(seed.obs_columns).toContain('louvain')
    expect(seed.obs_columns).toContain('n_counts')

    // ── Bug 2, DATA PLANE: the scatter's x/y come from the REAL `embedding` artifact (X_umap), not
    //    the fabricated obs metric columns. Fetch the cataloged embedding's served bytes (the SAME
    //    `/api/artifacts/{id}/data` path `WorkbenchDataSource.positions()` reads) and assert they
    //    decode to the pbmc68k X_umap coordinates — a genuine 2-D float embedding, ≈ the known first
    //    UMAP point. This is what `canvasBinding`'s `positionsFor` now feeds the scatter. ───────────
    const token = await ownerToken(request)
    const embRes = await request.get(`${BACKEND}/api/artifacts/${seed.embedding_artifact_id}/data`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(embRes.ok(), `embedding artifact bytes must be served (${embRes.status()})`).toBeTruthy()
    const embBuf = await embRes.body()
    expect(embBuf.byteLength % 4).toBe(0)
    const coords = new Float32Array(embBuf.buffer, embBuf.byteOffset, Math.floor(embBuf.byteLength / 4))
    expect(coords.length, 'a 2-D embedding: 2 floats per cell').toBe(seed.n_cells * 2)
    // The real X_umap first point (from the pbmc68k dataset) — proves these are genuine UMAP coords,
    // NOT interleaved obs metric columns (which would be counts/scores in the thousands).
    expect(coords[0]).toBeCloseTo(-1.99, 1)
    expect(coords[1]).toBeCloseTo(8.58, 1)

    await openWorkbench(page, id)
    await awaitFilterSurface(page)

    // ── Baseline (no criteria): the keep-mask keeps ALL cells (obs.kept == obs). Read it from the
    //    read-only store seam — the DATA-PLANE value that feeds the obs.kept scatter. ──────────────
    let base = { keptTotal: 0, keptCount: 0 }
    await expect
      .poll(async () => (base = await keptInfo(page)).keptTotal, {
        timeout: 20_000,
        message: 'the cell-filter store exposes its keptMask',
      })
      .toBe(seed.n_cells)
    expect(base.keptCount, 'no criteria ⇒ every cell kept (obs.kept == all cells)').toBe(seed.n_cells)

    // ── Apply BOTH a continuous threshold (n_counts ≤ 3000) AND a categorical keep (louvain 0/1). ──
    await addCriterion(page, 0, { column: 'n_counts' })
    const max = page.getByTestId(CFRow.max(0))
    await max.fill('3000')
    await max.blur()

    // Bug 3 — the keep-set multiselect is POPULATED with the column's distinct categories (before the
    // fix `critKeep.options` was unset → an empty list → a categorical keep-set could never be built).
    await addCriterion(page, 1, { column: 'louvain' })
    const keepTrigger = page.getByTestId(CFRow.keep(1))
    await keepTrigger.click()
    const options = page.locator(`[data-testid^="${CFRow.keep(1)}-opt-"]`)
    await expect(options.first()).toBeVisible({ timeout: 10_000 })
    const optionCount = await options.count()
    expect(optionCount, 'the keep-set multiselect must list the column categories (Bug 3)').toBeGreaterThan(1)
    await page.getByTestId(`${CFRow.keep(1)}-opt-1`).click()
    await page.getByTestId(`${CFRow.keep(1)}-opt-0`).click()
    await page.keyboard.press('Escape')

    // ── Bug 2 wiring, DATA PLANE: the form edits RE-DERIVE the keptMask that feeds the obs.kept
    //    scatter — the surviving-cell count drops well below the total. This is the definitive proof
    //    the filter thins what the scatter plots (the masked embedding positions), independent of
    //    headless-GL pixels. ────────────────────────────────────────────────────────────────────
    let masked = base
    await expect
      .poll(async () => (masked = await keptInfo(page)).keptCount, {
        timeout: 20_000,
        message: 'applying the filter re-derives the keptMask (fewer surviving cells)',
      })
      .toBeLessThan(seed.n_cells)
    expect(masked.keptTotal, 'the mask still spans every cell').toBe(seed.n_cells)
    expect(masked.keptCount, 'the keep-mask kept a real, non-empty subset (louvain 0/1 survive)').toBeGreaterThan(0)
    // ── ITEM-39: the DETERMINATE answer, not a bracket ───────────────────────────────────────
    //
    // This used to assert `keptCount < n_cells * 0.6`. The criteria applied above —
    // `n_counts <= 3000` AND `louvain in {0,1}` — have exactly ONE right answer on this fixture,
    // so a bracket accepted a large family of WRONG masks: an off-by-one bound, a criterion
    // silently doing nothing while the other carried the drop, an OR where an AND was meant.
    // All of those land comfortably under 60%.
    //
    // The oracle is computed IN-PAGE from the same `$data` frame the mask read, so it stays
    // correct if the fixture changes and it is genuinely INDEPENDENT of the mask: it re-derives
    // the answer from the values rather than re-reading the store's own conclusion.
    const oracle = await page.evaluate((specType) => {
      const read = (window as unknown as {
        __declarativeStores?: () => Array<{ type: string; data?: Record<string, unknown> }>
      }).__declarativeStores
      const s = (read ? read() : []).find(x => x.type === specType)
      const frame = (s?.data ?? {}) as Record<string, unknown>
      // Find the columnar slice WITHOUT naming it: the resolved frame either IS the columns or
      // holds them under one slice key. Locating it structurally keeps this spec free of the
      // app's domain vocabulary AND survives a rename of that key.
      const columnar = (v: unknown): v is Record<string, unknown> =>
        v != null && typeof v === 'object' && !Array.isArray(v) &&
        Object.values(v as Record<string, unknown>).some(Array.isArray)
      const cols = (Object.values(frame).find(columnar) ?? frame) as Record<string, unknown>
      const counts = cols['n_counts']
      const louvain = cols['louvain']
      if (!Array.isArray(counts) || !Array.isArray(louvain)) return null
      let kept = 0
      for (let i = 0; i < counts.length; i++) {
        const c = Number(counts[i])
        const l = String(louvain[i])
        if (Number.isFinite(c) && c <= 3000 && (l === '0' || l === '1')) kept++
      }
      return { kept, n: counts.length }
    }, FILTER_SPEC_TYPE)
    expect(oracle, 'the oracle needs both criterion columns in the resolved frame').not.toBeNull()
    expect(
      masked.keptCount,
      `the keep-mask must equal the answer "n_counts <= 3000 AND louvain in {0,1}" has on this ` +
        `fixture (oracle=${oracle?.kept}, got=${masked.keptCount}). A bracket would accept an ` +
        'off-by-one bound, an OR where an AND was meant, or one criterion silently doing nothing.',
    ).toBe(oracle?.kept)

    // ── Bug 2 render: open the embedding panes and confirm the scatter actually PAINTS real UMAP
    //    (non-blank canvas pixels) — the real positions reach deck.gl. (Under headless swiftshader the
    //    deck frame is faint; we assert only that it is non-blank, not a fragile pixel count.) ──────
    await page.getByTestId('widget-showEmbeddingBtn').first().click()
    const embBefore = page.getByTestId('viz-cell-view-emb-before')
    const embAfter = page.getByTestId('viz-cell-view-emb-after')
    await expect(embBefore).toBeAttached({ timeout: 20_000 })
    await expect(embAfter).toBeAttached({ timeout: 20_000 })
    await expect
      .poll(async () => {
        await embBefore.scrollIntoViewIfNeeded().catch(() => {})
        await embAfter.scrollIntoViewIfNeeded().catch(() => {})
        const b = (await cellPaint(page, 'emb-before')).painted
        const a = (await cellPaint(page, 'emb-after')).painted
        return Math.min(b, a)
      }, { timeout: 30_000, message: 'both embedding scatter panes paint real UMAP pixels (Bug 2)' })
      .toBeGreaterThan(0)
    await embBefore.scrollIntoViewIfNeeded().catch(() => {})
    await embBefore.screenshot({ path: resolve(shots, 'scatter-before.png') })
    await embAfter.scrollIntoViewIfNeeded().catch(() => {})
    await embAfter.screenshot({ path: resolve(shots, 'scatter-after.png') })
  })
})
