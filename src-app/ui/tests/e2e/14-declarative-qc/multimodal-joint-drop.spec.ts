// COVERAGE: this spec is env-gated on `CYTO_E2E_MULTIMODAL` and is therefore UNCOVERED in a
// default e2e run — see `tests/e2e/E2E_NEGATIVE_CONTROLS.md` for what must be seeded to run it.

import { expect, test } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'
import { createProject, openWorkbench } from '../14-workbench/_dock'
import {
  awaitFilterSurface,
  addCriterion,
  chooseSurfaceDataset,
  expectCriteriaColumns,
  addCriterionRow,
  pickCriterionColumn,
  seedMultimodalDataset,
  CF_DATASET,
  CFRow,
} from './_seed'

// TEST-E5 (e2e) [covers: ITEM-20, ITEM-27] — on a REAL multi-modal (RNA + protein) CITE-seq dataset,
// a cell-filter criterion on ONE modality's obs metric (`prot:total_counts`) drops the PAIRED cell
// across ALL modalities (JOINT DROP, DEC-27): the keep-mask is ONE per-cell boolean over the SHARED
// obs, so a criterion on any modality's column drops the whole cell. A second criterion on a
// DIFFERENT modality (`rna:total_counts`) ANDs onto the SAME shared cells — the cross-modality joint
// composition.
//
// REAL DATA + REAL READER. The dataset is a genuine 10x CITE-seq matrix (Gene Expression + Antibody
// Capture) — `pbmc_1k_protein_v3` (10x Genomics, CC BY 4.0), subsampled to 200 cells. The
// `CYTO_E2E_MULTIMODAL` seed harness (`/_debug/seed`, driver `modality-split`) runs the SAME `multimodal.py`
// reader the production `anndata-import` converter composes (`split_by_feature_types` +
// `modality_prefixed` + `modality_datatype` + `align_barcodes` + `detect_isotype_controls`) over the
// real matrix, deriving per-modality `total_counts` / `n_features` / `pct_mito` into the shared obs,
// `modality:`-prefixed (MULTIMODAL_qc_metrics.md §4 — every modality independently produces
// `total_counts`, so a shared-obs metric MUST be prefixed or the modalities clobber). No SOMA / no
// tiledbsoma (the reader kernels are numpy/scipy/anndata-only), so no TileDB `bad_alloc`.
//
// Those metrics reach this surface as ONE `metadata-column` artifact each, DATASET-scoped and
// DECLARING the shared axis — the shape a real import produces, and the shape the view's
// `axis_columns` slice reads. The seed used to catalogue them as scope-less, declaration-less f32
// blobs, which was invisible while the surface read its frame out of the `report/qc` artifact and
// became fatal the moment that slice became an axis relation. See `_seed.ts::seedMultimodalDataset`.
//
// The joint-mask derive + before/after rebuild are proven CLIENT-SIDE (the shared-store input↔plot
// loop). Headless Chromium cannot paint the deck.gl grid, so the loop is asserted via the STRUCTURAL
// canvas flip (`data-viz-framework`) + a clean interpreter/store/viz console (the derive→render loop
// ran without throwing), not GL pixels — the same DR-2 constraint the cell-filter-live spec (E2)
// documents.
// FIXTURE-CAPABILITY gate. Applied as a describe-level `test.skip` (never an
// `if (MULTIMODAL) { … }` wrapper): the spec is then COLLECTED unconditionally and a run without
// the fixture REPORTS it as skipped, naming the env var — see `../14-workbench/_analysis.ts` for
// the measurement that made the wrapper form untenable.
const MULTIMODAL = !!process.env.CYTO_E2E_MULTIMODAL
const MULTIMODAL_SKIP =
  'needs the real CITE-seq multimodal seed fixture — set CYTO_E2E_MULTIMODAL=1 to run'

// THERE IS NO CANVAS-NOISE ALLOWANCE. See the header of the sibling `…-live.spec.ts` for why the
// one that used to sit here was deleted rather than narrowed: every alternative in it either
// swallowed a REAL `VizController.setOption failed` — the single console.error this app raises when
// the canvas refuses an option — or matched a string the app never emits.

test.describe('multimodal criterion joint-drops across all modalities (DEC-27, TEST-E5)', () => {
  test.skip(!MULTIMODAL, MULTIMODAL_SKIP)


// ── ITEM-39 — MEASURE the joint drop this spec is named for ────────────────────────────────
//
// Every assertion in this file used to be a canvas ATTRIBUTE, a picker state, or
// `consoleErrors === []`. None of them measured a drop, so the spec passed whether the joint mask
// worked, kept everything, or kept nothing. The answers here are DETERMINATE — the seeded values
// are all >= 0, so `max = -1` keeps zero and `max = 999999` keeps all — and a bracket like
// "> 0 and < 0.6N" would be a third spec of the kind this round exists to stop.
const BEFORE_PANE = 'before-violin-0'
const AFTER_PANE = 'after-violin-0'

interface CanvasPane {
  id: string
  rows: number | null
}

/** Rows the pane at `coordId` actually RESOLVED, off the shipped `window.__canvasPanes` seam. */
async function paneRows(
  page: import('@playwright/test').Page,
  coordId: string,
): Promise<number | null> {
  const panes = await page.evaluate(() => {
    const seam = (window as unknown as { __canvasPanes?: () => CanvasPane[] }).__canvasPanes
    return seam ? seam() : []
  })
  return panes.find(p => p.id === coordId)?.rows ?? null
}

/** Poll the AFTER pane until it reports `rows`, so the assertion is about the SETTLED mask. */
async function expectAfterRows(
  page: import('@playwright/test').Page,
  rows: number,
  message: string,
): Promise<void> {
  await expect
    .poll(async () => await paneRows(page, AFTER_PANE), { timeout: 20_000, message })
    .toBe(rows)
}

  test('a criterion on prot:total_counts joint-drops paired rows; a second on rna:total_counts ANDs the same rows', async ({
    page,
    request,
  }) => {
    const consoleErrors: string[] = []
    const keep = (t: string) => {
      if (!/Failed to (load resource|fetch)|favicon/i.test(t)) consoleErrors.push(t)
    }
    page.on('console', m => {
      if (m.type() === 'error') keep(m.text())
    })
    page.on('pageerror', e => keep(String(e)))

    await loginAsOwner(page)
    const id = await createProject(request, `Joint Drop ${Date.now()}`)

    // Ingest the REAL CITE-seq dataset through the real multimodal.py reader.
    const seed = await seedMultimodalDataset(request, id)
    // Real-reader structural proof: BOTH modalities split out; the shared obs carries per-modality
    // `modality:`-prefixed metrics (one row per row across modalities — the joint-drop axis).
    expect(seed.modalities, `real reader split: ${seed.modalities.join(',')}`).toEqual(
      expect.arrayContaining(['rna', 'prot']),
    )
    expect(seed.obs_columns).toEqual(
      expect.arrayContaining(['prot:total_counts', 'rna:total_counts', 'rna:pct_mito']),
    )

    await openWorkbench(page, id)
    await awaitFilterSurface(page)

    // No criteria yet → the canvas is its honest empty hero.
    const host = page.getByTestId('workbench-canvas-host')
    await expect(host).toBeAttached({ timeout: 20_000 })
    await expect(page.getByTestId('workbench-canvas-empty')).toBeAttached({ timeout: 20_000 })

    // ── CHOOSE the dataset — and note WHY there is a choice to make ──────────────────────
    //
    // The reader splits the matrix into one artifact per modality, and the protein datatype
    // EXTENDS the expression one in the lattice, so BOTH satisfy the picker's `subtypes_of`
    // source. Two candidates ⇒ the picker deliberately
    // pre-selects neither, which is exactly the state this spec used to sit in without noticing:
    // `$state.expression` stayed empty, the axis-scoped metadata slice resolved to nothing, and
    // the column picker offered "No options yet" — for two minutes, then a timeout.
    //
    // Either modality anchors the SAME axis (they are one dataset — that is the joint-drop
    // premise), so choosing the RNA one is a choice about which artifact is NAMED, not about
    // which metadata is read. The next assertion is what says so.
    await expect(
      page.getByTestId(CF_DATASET.select),
      'both modalities are candidates (protein extends expression), so the picker offers two ' +
        'and chooses neither',
    ).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId(CF_DATASET.summary)).toHaveCount(0)
    await chooseSurfaceDataset(page, seed.matrix_artifact_ids.rna)

    // THE JOINT AXIS, as the builder sees it: anchoring on the RNA matrix offers EVERY
    // modality's metrics, protein included. That is the shared-frame claim stated as an
    // observation rather than inferred from one column happening to be pickable — a per-modality
    // frame would offer the rna columns alone and still let every assertion below pass.
    await addCriterionRow(page)
    await expectCriteriaColumns(
      page,
      0,
      seed.metric_columns,
      'anchored on the RNA matrix, the builder offers the SHARED frame — every modality’s metrics',
    )

    // Criterion on the PROTEIN modality's shared metric → the joint before/after pair drives the
    // ONE canvas grid. The picker exposing `prot:total_counts` proves the protein modality is
    // first-class in the SHARED frame the mask operates over.
    await pickCriterionColumn(page, 0, { column: 'prot:total_counts' })
    await expect(host).toHaveAttribute('data-viz-framework', 'true', { timeout: 20_000 })

    // JOINT DROP: tighten below every value (all ≥ 0) → the derived keep-mask (one per-row boolean
    // over the shared obs) empties, dropping every PAIRED row across all modalities. The declared
    // `cf.setCriterionField` dispatches + `$derived.keptMask` recomputes.
    const protMax = page.getByTestId(CFRow.max(0))
    await protMax.fill('-1')
    await protMax.blur()
    await expect(host).toHaveAttribute('data-viz-framework', 'true')
    // THE JOINT DROP, MEASURED. Every seeded value is >= 0, so a `max = -1` on the PROTEIN
    // metric drops every PAIRED row across both modalities — the whole point of the spec.
    await expectAfterRows(
      page,
      0,
      'the protein criterion did not joint-drop: a non-zero AFTER count here means the mask ' +
        'never reached the paired rows, which every previous assertion in this spec would miss',
    )
    // The BEFORE side is the control that makes it a comparison — it must NOT move.
    expect(await paneRows(page, BEFORE_PANE), 'the BEFORE side never masks').toBe(seed.n_cells)

    // Second criterion on a DIFFERENT modality (`rna:total_counts`) → the combined mask ANDs both
    // modalities' criteria on the SAME shared rows (the cross-modality joint composition, DEC-27).
    await addCriterion(page, 1, { column: 'rna:total_counts' })
    await expect(host).toHaveAttribute('data-viz-framework', 'true')
    const rnaMax = page.getByTestId(CFRow.max(1))
    await rnaMax.fill('999999')
    await rnaMax.blur()
    await expect(host).toHaveAttribute('data-viz-framework', 'true')
    // AND, not replace: a permissive RNA bound cannot resurrect what the protein criterion
    // dropped. If the two criteria composed as OR — or if the second silently replaced the
    // first — this would come back non-zero.
    await expectAfterRows(
      page,
      0,
      'the second criterion did not AND with the first: a permissive bound on another ' +
        'modality must not resurrect rows the protein criterion dropped',
    )

    // Removing the protein criterion clears its before/after pair; the rna one (and its joint mask)
    // survive — the canvas stays a framework surface.
    await page.getByTestId(CFRow.remove(0)).click()
    await expect(host).toHaveAttribute('data-viz-framework', 'true')
    // Removing the dropping criterion RESTORES the rows: only the permissive RNA bound is left,
    // which keeps every one. This is the leg that proves the earlier zero was the criterion and
    // not a broken pane — a pane stuck at zero would pass every assertion above.
    await expectAfterRows(
      page,
      seed.n_cells,
      'removing the protein criterion did not restore the rows — an AFTER pane stuck at 0 ' +
        'would have satisfied every assertion before this one',
    )

    // The derive→render joint-mask loop ran clean over the shared multimodal obs (no interpreter /
    // store / viz throw).
    expect(consoleErrors, `console errors during the joint-drop loop:\n${consoleErrors.join('\n')}`).toEqual([])
  })
})
