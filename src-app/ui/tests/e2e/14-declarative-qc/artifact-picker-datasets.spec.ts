import { expect, test } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'
import { createProject, openWorkbench } from '../14-workbench/_dock'
import { awaitQcSurface, seedProjectDataset } from './_seed'

// TEST-22 (ITEM-22) — with two datasets attached to a project, the artifact-ref picker GROUPS +
// LABELS candidates by their SOURCE DATASET, derived from provenance
// (`ProvenanceRepository::source_dataset_of` → surfaced on the `ListedArtifact` catalog row →
// `ArtifactRefField` renders a `SelectOptionGroup` per dataset). Now WIRED (was DEFERRED at
// FIX_ROUND-1): the backend derives + returns the source dataset, and the picker groups by it.
//
// Driveable WITHOUT a compute run/rootfs: the debug `_debug/seed` route
// (`#[cfg(debug_assertions)]`) creates a real `datasets` row + `project_datasets` link + a
// dataset-scoped `single-cell/expression` artifact per dataset; `source_dataset_of` resolves each
// artifact to its own dataset (an ingested file IS its own dataset). The QC (`qc.10x`) form's
// `matrix` artifact-ref picker (accepts `subtypes_of single-cell/expression`) then lists both,
// grouped under the two dataset names.

test.describe('artifact-ref picker groups by source dataset (ITEM-22)', () => {
  test('two datasets → picker candidates are grouped + labelled by their source dataset', async ({
    page,
    request,
  }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `Picker Datasets ${Date.now()}`)

    // Two REAL project-attached datasets, each with a `single-cell/expression` artifact.
    const nameA = `Aorta ${Date.now()}`
    const nameB = `Brain ${Date.now()}`
    const dsA = await seedProjectDataset(request, id, nameA)
    const dsB = await seedProjectDataset(request, id, nameB)

    await openWorkbench(page, id)
    await awaitQcSurface(page)

    // The DECLARATIVE pane's own picker, not the generic schema form.
    //
    // This spec used to drive `schemaform-field-matrix` — the fallback form built from
    // `appliesTo` — which this analysis no longer renders at all: it declares `ui:`, so it gets
    // its declared view instead. The spec had therefore been testing a surface that does not
    // exist, and its slot had also been renamed (`matrix` -> `matrices`) underneath it. It is
    // pointed at the real control here rather than deleted, because its INTENT — a picker that
    // says which dataset each candidate came from — is now genuinely implemented.
    const picker = page.getByTestId('widget-matrixPicker-select')
    await picker.waitFor({ state: 'visible', timeout: 20_000 })
    await picker.click()

    // BOTH candidates are offered, unranked.
    for (const artifactId of [dsA.expression_artifact_id, dsB.expression_artifact_id]) {
      await expect(page.getByTestId(`widget-matrixPicker-select-opt-${artifactId}`)).toBeVisible({
        timeout: 20_000,
      })
    }

    // …and each sits under a HEADING naming its dataset. A heading rather than a suffix on the
    // option text: a suffix goes on the end, which is exactly where truncation removes it, so
    // the part that tells two similar candidates apart is the first thing to disappear.
    for (const name of [nameA, nameB]) {
      await expect(page.getByRole('group', { name }).first()).toBeVisible({ timeout: 20_000 })
    }
  })
})
