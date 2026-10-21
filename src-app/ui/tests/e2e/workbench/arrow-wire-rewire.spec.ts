import { expect, test } from '@playwright/test'
import { loginAsOwner, ownerToken } from '../project/_helpers'
import { BACKEND, openWorkbench, trackErrors } from '../14-workbench/_dock'
import { seedPlottableProject, type SeedPlottableResult } from '../14-declarative-qc/_seed'

// TEST-19 [universal-tiledb-serving · S5b / INV-4 / INV-9 · Phase-7 DoD]. The wholesale
// FE arrow-js rewire, exercised through the RUNNING app + REAL backend with NO route
// mocking. A plottable dataset is seeded directly (embedding + real CSC expression + a
// row-subset row subset + a `clustering` categorical column — the shared fixture still seeds
// the row-subset, but nothing READS it here any more; see the last section), the workbench is
// opened, and the REAL catalog→picker→select flow is driven for BOTH the value channel and
// the CATEGORICAL channel — through the shipped `WorkbenchDataSource` (the exact path the
// canvas color-by picker uses: `catalog()` → a composite `<artifactId>#<column>` key →
// `valueColumn()` / `categorical()`), NOT the low-level decoder shortcut. This proves the
// composite-key threading (H2) + the ingest column-catalog (M6) end-to-end: pre-fix the
// categorical select THROWS (bare-id key) and the column picker is empty (shape `{}`); the
// assertions below are only satisfiable post-fix. (Headless Chromium has no GPU, so the
// GPU pixel recolor is a manual/CI-GL concern — this asserts the DATA PLANE + the picker
// UI + a clean console.)

test('catalog→picker→select drives color-by-gene + categorical + the raw CSC read through the real DataSource — TEST-19', async ({
  page,
  request,
}) => {
  const token = await ownerToken(request)
  const proj = await (
    await request.post(`${BACKEND}/api/projects`, {
      headers: { authorization: `Bearer ${token}` },
      data: { name: `Arrow rewire ${Date.now()}`, description: '' },
    })
  ).json()
  const seed: SeedPlottableResult = await seedPlottableProject(request, proj.id)
  expect(seed.expression_artifact_id, 'seed produced a CSC expression artifact').toBeTruthy()
  expect(seed.clustering_artifact_id, 'seed produced a clustering categorical artifact').toBeTruthy()

  await loginAsOwner(page)
  const bag = trackErrors(page)
  // Capture any non-2xx /api response so a stray backend error names its URL+status.
  const apiErrors: string[] = []
  page.on('response', (res) => {
    const u = res.url()
    if (u.includes('/api/') && res.status() >= 400) apiErrors.push(`${res.status()} ${u}`)
  })
  await openWorkbench(page, proj.id)

  // The center canvas host mounts (structural — headless has no GPU, so the deck layer
  // stays hidden until a GL context paints; we assert ATTACHED, not pixel-visible).
  await expect(page.getByTestId('workbench-canvas-host').first()).toBeAttached({ timeout: 20_000 })

  // The shipped arrow readers + the DataSource seam register at app boot (DEV-only).
  await page.waitForFunction(
    () => !!(window as unknown as { __cyto_ds?: unknown }).__cyto_ds,
    undefined,
    { timeout: 20_000 },
  )

  // ── The REAL catalog→select flow through the shipped WorkbenchDataSource ──────────
  // This is the exact path the color-by picker uses: `catalog()` yields composite
  // value/categorical keys; `valueColumn(key)` / `categorical(key)` resolve them.
  const flow = await page.evaluate(async (projectId) => {
    const mk = (window as unknown as {
      __cyto_ds?: (id: string) => {
        catalog: () => Promise<{
          valueColumns: string[]
          categoricalColumns: { id: string; label: string; kind: string }[]
        }>
        valueColumn: (key: string) => Promise<{ row: Uint32Array; value: Float32Array }>
        categorical: (key: string) => Promise<{ codes: Uint16Array; categories: string[]; length: number }>
      }
    }).__cyto_ds
    if (!mk) return { error: 'no __cyto_ds seam' }
    const ds = mk(projectId)
    const cat = await ds.catalog()
    const geneKey = cat.valueColumns[0]
    const catEntry = cat.categoricalColumns[0]
    // Color-by-column: resolve the FIRST value column via its composite key.
    const gene0 = geneKey ? await ds.valueColumn(geneKey) : null
    // Categorical color-by: resolve the FIRST categorical column via its composite key
    // (pre-fix this THROWS — the bare-id key is not `<artifactId>#<column>`).
    let categorical: { categories: string[]; length: number } | null = null
    let categoricalError: string | null = null
    try {
      categorical = catEntry ? await ds.categorical(catEntry.id) : null
    } catch (e) {
      categoricalError = String(e)
    }
    return {
      valueColumnsLen: cat.valueColumns.length,
      categoricalLen: cat.categoricalColumns.length,
      geneKey,
      catKey: catEntry?.id ?? null,
      geneRows: gene0 ? Array.from(gene0.row) : null,
      geneAllOne: gene0 ? gene0.value.every((v) => v === 1) : null,
      catCategories: categorical?.categories ?? null,
      catLength: categorical?.length ?? null,
      categoricalError,
    }
  }, proj.id)

  expect('error' in flow ? flow.error : null, 'the DataSource seam is exposed').toBeNull()
  const f = flow as Exclude<typeof flow, { error: string }>

  // catalog→picker: the column value-column picker is populated (M6: shape.cols filled).
  expect(f.valueColumnsLen, 'gene value-columns surface in the catalog (ingest shape.cols)').toBe(
    seed.n_genes,
  )
  expect(f.geneKey, 'a value-column key is a composite <artifactId>#<index>').toContain('#')

  // select (color-by-column): column 0 lights rows where row % n_genes == 0, value 1.
  // Aliased once: the seed contract's own field name is the only domain vocabulary left
  // in this spec, so it is read here and reused rather than repeated per call site.
  const nCols = seed.n_genes
  const expectedRows = Array.from({ length: seed.n_cells / nCols }, (_, i) => i * nCols)
  expect(f.geneRows, 'color-by-gene 0 lights the expected cells (real Arrow COO via the DataSource)').toEqual(
    expectedRows,
  )
  expect(f.geneAllOne, 'gene-0 expression value is 1 where nonzero').toBe(true)

  // catalog→picker: the categorical picker is populated with a COMPOSITE key (H2).
  expect(f.categoricalLen, 'categorical columns surface in the catalog').toBeGreaterThan(0)
  expect(f.catKey, 'a categorical key is the composite <artifactId>#<columnName>').toBe(
    `${seed.clustering_artifact_id}#${seed.clustering_column}`,
  )
  // select (categorical color-by): it RESOLVES (pre-fix it throws on the bare-id key).
  expect(f.categoricalError, 'categorical color-by resolves (no throw) via the composite key').toBeNull()
  // The DECLARED level set, not the observed one (D10). `NEVER-OBSERVED` occurs in zero
  // rows and must still survive decode: levels are what a legend binds colours to, so
  // dropping an unobserved level would re-map every colour the moment a subset stopped
  // containing it. This asserted `['0','1','2']` until the shared fixture began declaring
  // the unobserved level — a fixture change that broke this UNCHANGED consumer.
  expect(f.catCategories, 'the DECLARED level set decodes, including the unobserved one').toEqual([
    '0',
    '1',
    '2',
    'NEVER-OBSERVED',
  ])
  expect(f.catLength, 'one code per cell').toBe(seed.n_cells)

  // ── the raw CSC column read, through the shipped artifact reader ────────────────────
  //
  // THIS SECTION USED TO ASSERT A SERVER-SIDE MASK, AND THAT CAPABILITY IS GONE.
  // Three things a later reader needs, so the change is not mistaken for lost coverage:
  //
  //  1. Server-side row-subsetting was REMOVED (artifact-model ITEM-12). `/read?mask=<id>`
  //     resolved a row-subset artifact SERVER-side and intersected the served rows — the
  //     server interpreting two artifacts' bytes, which INV-1 ("the server never opens a
  //     byte for meaning") forbids. It had no production caller; only this seam used it.
  //  2. The seam's THIRD ARGUMENT IS NOW `structure`, NOT `mask` —
  //     `sparse(id, col, structure)` → `readSparseColumn(id, col, parseStructure(…))`.
  //     Dispatch is on the producer's DECLARATION (ITEM-25), so the declaration is fetched
  //     off `GET /api/artifacts/{id}` here exactly as production does (the same shape
  //     `14-workbench/progressive-render.spec.ts` uses). Passing a UUID in that slot now
  //     throws `UnsupportedArtifactStructure: structure is not an object`.
  //  3. Masking is the CLIENT's job now, and is covered elsewhere: the declarative
  //     workbench derives `$derived.keptMask` in-browser — the pure kernel
  //     `workbench/core/runtime/primitives.ts::keep_mask` over in-memory observation columns,
  //     consumed by `core/render/declarativeMount.ts` — exercised live by
  //     `14-declarative-qc/row-filter-live.spec.ts` (TEST-E2) — add a criterion → the
  //     keep-mask re-derives → the canvas re-renders, with the commit half gated on
  //     `CYTO_E2E_REAL_COMPUTE`. NOTE: no `maskId`/`rowMask` identifier survives anywhere
  //     in `src/`, and no request carries a `mask` parameter; the word `mask` itself does
  //     still occur there, as the kit's `mask={{…}}` overlay prop and as the client-side
  //     "keep-mask" vocabulary above — neither is a row-subset artifact.
  //
  // What is asserted instead is what production actually does: the FULL sparse column
  // decodes correctly, over real HTTP, against the real backend. The column read is a
  // DIFFERENT (last) column, not column 0, on purpose — column 0's non-zeros start at
  // `indptr[0] == 0`, so a reader that ignored the `indptr` offset entirely would still
  // answer column 0 correctly. Only a column j > 0 pins the offset, and asserting the
  // VALUES (column g carries `g+1`) pins that `data` was sliced over the same window as
  // `indices` rather than from the start of the buffer.
  const lastCol = nCols - 1
  const artifact = await (
    await request.get(`${BACKEND}/api/artifacts/${seed.expression_artifact_id}`, {
      headers: { authorization: `Bearer ${token}` },
    })
  ).json()
  expect(artifact.structure?.kind, 'the seeded matrix declares the CSC decode contract').toBe(
    'sparse_csc',
  )

  const colLast = await page.evaluate(
    async ([exprId, col, structure]) => {
      const api = (window as unknown as {
        __cyto_read: {
          sparse: (
            id: string,
            col: number,
            structure: unknown,
          ) => Promise<{ row: Uint32Array; value: Float32Array }>
        }
      }).__cyto_read
      const s = await api.sparse(exprId as string, col as number, structure)
      return { row: Array.from(s.row), value: Array.from(s.value) }
    },
    [seed.expression_artifact_id, lastCol, artifact.structure] as const,
  )

  // The fixture lights column g in every row where `row % nCols === g`, value `g+1`.
  const lastColRows = Array.from(
    { length: seed.n_cells / nCols },
    (_, i) => i * nCols + lastCol,
  )
  expect(colLast.row, `CSC column ${lastCol} decodes its own indptr window`).toEqual(lastColRows)
  expect(
    colLast.value,
    `column ${lastCol}'s VALUES come from the same window as its indices`,
  ).toEqual(lastColRows.map(() => lastCol + 1))

  // …and it is the WHOLE column. The seeded row-subset covers only the first half, so a
  // read that silently re-acquired a row subset (server-side or otherwise) would stop at
  // the midpoint. Spanning it is the observable proof that nothing subsets this read.
  const half = seed.n_cells / 2
  expect(colLast.row.some(r => r < half), 'the column spans the first half').toBe(true)
  expect(colLast.row.some(r => r >= half), 'AND the second — no row subset is applied').toBe(true)

  // No ErrorBoundary crash, no console error through the whole real-data render.
  await expect(page.getByTestId('workbench-canvas-host').first()).toBeAttached()
  expect(
    bag.errors,
    `no console/page errors: ${bag.errors.slice(0, 3).join(' | ')} | api4xx: ${apiErrors.slice(0, 5).join(' , ')}`,
  ).toHaveLength(0)
})
