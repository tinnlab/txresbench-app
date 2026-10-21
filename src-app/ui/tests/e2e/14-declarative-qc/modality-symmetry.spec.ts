import { expect, test } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'
import { createProject, openWorkbench } from '../14-workbench/_dock'
import { seedQcDataset, awaitQcSurface, PRESET_PICKER, QC } from './_seed'

// TEST-A8 (e2e) [invariant: INV-6 / INV-8] — NO MODALITY IS PRIVILEGED by the QC view.
//
// ── WHAT THIS SPEC USED TO ASSERT, AND WHY IT WAS REWRITTEN ──────────────────────────────
//
// It drove `widget-modalityPicker` (`$state.modality`), switched it rna→prot, and asserted the
// preset affordances swapped while the core surface stayed identical. Every mechanism in that
// sentence is deleted: `ui/qc.yaml` has no `modalityPicker` and no `$state.modality`, and the
// per-family affordances no longer gate on a picked modality at all. So the spec could not pass,
// and — worse — the thing it was proving had become false in a specific way. Its "symmetry" was
// symmetry across a CLOSED list of three (`[rna, prot, atac]`). The picker's value became the
// emitted column prefix, so an `hto` or `crispr` run had no correct answer and the wrong one was
// silently applied; the canvas violins bound `rna:total_counts` while the run emitted
// `crispr:total_counts`, and drew empty panes with no error. A spec asserting that the picker
// switched cleanly between two of three privileged names was, in effect, certifying the defect.
//
// ── THE INVARIANT SURVIVES; ONLY THE MECHANISM DIED ──────────────────────────────────────
//
// The property the owner asked for by name — "what if the modality is not in the list of rna,
// atac, prot?" — is now upheld structurally: the modality is stamped by the importer into each
// matrix's OWN `structure` (`classify_feature_type` is open by construction — an unrecognized
// feature type maps to a sanitized modality of its own, NEVER dropped, NEVER folded into RNA),
// the compute reads it off the staged store, and the view neither picks nor relays one. So the
// VIEW's half of the invariant is now an ABSENCE plus a substitution, and that is what this
// spec asserts:
//
//   1. there is no modality selector, and the metric table has no modality column — the closed
//      list is gone from BOTH surfaces it lived on (it outlived the picker as a read-only
//      "Modality" column on every metric row, claiming an artifact source it never had, which
//      is the shape a deletion-only fix would have left behind);
//   2. the surviving family affordances gate on the resolved dataset's CAPABILITIES (`has:` —
//      a fact about the data) rather than on a user-restated modality, so on an RNA-only
//      project the protein and ATAC affordances are absent and the ungated one is present;
//   3. the core surface (metric table + Run) is present regardless — the modality-invariant part.
//
// ── WHAT IS COVERED ELSEWHERE, NAMED SO THE CLAIM IS CHECKABLE ───────────────────────────
//
// The DATA half — that an arbitrary key really does prefix its own columns and is never folded
// into `rna` — is pinned by `src-app/packages/qc/tests/test_modality_open_set.py`, whose keys
// (`crispr`, and `custom_assay_v2` sanitized from the unrecognized feature-type string "Custom
// Assay v2") are COMPUTED from the importer's own `classify_feature_type` rather than written
// down, and which includes `test_nothing_is_folded_into_rna` plus a non-vacuity test asserting
// both keys are genuinely outside the retired closed list.
//
// That split is not a dodge, it is where the evidence is. Proving the open set END TO END needs
// an ingest whose `feature_types` are unrecognized, i.e. a new binary fixture — and even then
// the view-layer consequence (`$derived.metricColumns` = `columns_of($data.obs)`, the canvas
// iterating the columns the run EMITTED rather than a guessed prefix) is not readable from any
// shipped e2e seam: `window.__declarativeStores` exposes `state` and the cell-filter `keptMask`,
// not arbitrary derived values. Recorded as a gap rather than papered over with a weaker
// assertion.
//
// PURE — no compute. `seedQcDataset` seeds obs directly.

/** The RETIRED modality picker's testid. Deliberately written here rather than kept in `_seed.ts`'s
 *  `QC` table: that table is the list of widgets that EXIST, and a helper for driving a deleted
 *  control invites the next spec to reach for it. This is the one place the id may appear, and it
 *  appears only inside an assertion that it is absent. */
const RETIRED_MODALITY_PICKER = 'widget-modalityPicker'

test.describe('the QC view privileges no modality — the closed list is gone (INV-6/INV-8, TEST-A8)', () => {
  test('no modality selector, no modality column; family affordances follow the DATA capabilities', async ({
    page,
    request,
  }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `Modality Symmetry ${Date.now()}`)
    // An RNA-only project: a `single-cell/expression` artifact + its obs. Nothing here declares a
    // protein modality or a fragments linkage, which is what makes (2) below discriminating.
    await seedQcDataset(request, id, { annotated: true })
    await openWorkbench(page, id)
    await awaitQcSurface(page)

    // (1a) NO modality selector. The user is never asked to restate what the data declares.
    await expect(
      page.getByTestId(RETIRED_MODALITY_PICKER),
      'the modality picker offered a CLOSED [rna, prot, atac] list whose value became the emitted ' +
        'column prefix — an `hto`/`crispr` run had no correct answer. It must not come back.',
    ).toHaveCount(0)

    // (1b) NO modality column on the metric table. The picker died first and the closed list then
    // survived lower down, as a `modality:` literal on every metric row rendered as a read-only
    // column. A metric is a question about GENE NAMES asked of every bound matrix; the answering
    // matrix's own `structure.modality` supplies the prefix, so a row cannot carry one.
    const headers = page.locator('[data-testid="widget-metricTable"] thead th')
    await expect(headers.first()).toBeVisible({ timeout: 20_000 })
    const headerText = (await headers.allInnerTexts()).map(t => t.trim().toLowerCase())
    expect(
      headerText.filter(h => h.includes('modality')),
      `the metric table still renders a modality column (headers: ${JSON.stringify(headerText)}) — ` +
        'that is the closed list one level down, presented as though it came from the artifact',
    ).toEqual([])

    // (2) The predefined metrics gate on the resolved dataset's CAPABILITIES, not on a picked
    // modality. They used to be one BUTTON each; they are OPTIONS of one catalog picker now, and
    // the gate moved with them — from the widget onto the option — so this asks the same
    // question of the same grammar one level down: which metrics is this data OFFERED?
    const picker = page.getByTestId(PRESET_PICKER)
    await picker.waitFor({ state: 'visible', timeout: 20_000 })
    await picker.click()
    // The read below is a ONE-SHOT `evaluateAll` over whatever is in the DOM at that instant,
    // and the popover's rows do not exist until it OPENS. Without this wait the whole assertion
    // block races the open: it read `[]` and then reported the ungated metric as "not offered",
    // which is indistinguishable from the gate being wrong. Observed as a failure inside a
    // full-directory sweep while the same spec passed alone — i.e. load-dependent, which is what
    // an unwaited-for transition looks like.
    //
    // The condition is the control's OWN state (`aria-expanded`), never a sleep: the kit `Select`
    // stamps it on the trigger this testid names, so it flips exactly when the rows exist.
    await expect(picker).toHaveAttribute('aria-expanded', 'true', { timeout: 20_000 })
    const offered = await page
      .locator(`[role="option"][data-testid^="${PRESET_PICKER}-opt-"]`)
      .evaluateAll((nodes, prefix) => nodes.map(n => (n.getAttribute('data-testid') ?? '').slice(prefix.length)), `${PRESET_PICKER}-opt-`)
    await page.keyboard.press('Escape')
    expect(
      offered,
      'the ungated (%hemoglobin) metric is offered without asking the user to pick a modality',
    ).toContain('pct_hb')
    expect(
      offered,
      'the protein metric is gated `has:protein` — a fact about the DATA. This project has no ' +
        'protein modality, so offering it would mean the gate is gone, not that prot is supported.',
    ).not.toContain('pct_isotype')
    expect(
      offered.filter(v => /enrich/i.test(v)),
      'the ATAC affordance is gated `has:fragments` (TSS enrichment is NOT derivable from a peak ' +
        'matrix) — absent here, and it must degrade to hidden rather than to a broken control',
    ).toEqual([])

    // (3) The core surface is modality-invariant: it is the same table and the same Run for any
    // modality, because nothing about it is per-modality any more.
    await expect(page.getByTestId(QC.table)).toBeVisible()
    await expect(page.getByTestId(QC.run)).toBeVisible()
  })
})
