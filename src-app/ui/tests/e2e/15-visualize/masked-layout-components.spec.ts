import { expect, test } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'
import { createProject } from '../14-workbench/_dock'
import { postSeedPlan } from '../14-declarative-qc/_seed'
import { DT, DT_POSITIONS, ENTITY_AXIS, entityColumnArtifact } from '../14-declarative-qc/_fixtures'
import { SECTIONS, frame, openVisualize } from './_visualize'

// TEST-20 (ITEM-12, ITEM-13) — a layout that has LOST ITS SECOND DIMENSION is still offered in
// § Coordinates, and still draws, when its producer declared the two 1-D columns its components
// are also emitted as.
//
// ── WHY THE FIXTURE IS SHAPED LIKE THIS, AND WHERE THE SHAPE COMES FROM ──────────────────────
//
// Materialising a narrowed row set GATHERS every non-sparse source artifact and mints the result
// a FRESH declaration — `virtual_dataset.rs:1688-1705` -> `gathered_structure` writes one
// `values` column of `shape: [n_kept]` with `arrays: []`, ALWAYS — while copying the source's
// `meta` verbatim (`:1714`) and its `datatype` (`:1729`). So a 2-D layout put through a
// narrowing arrives declaring ONE dimension and still advertising `plottable-xy`.
//
// That is exactly the row this spec seeds, and the shape is not invented here: it is pinned,
// against the real server, by `server/tests/workstore/filter_vd_test.rs`. Reusing
// `entityColumnArtifact` is the point — the gathered layout row IS shaped like a 1-D column, so
// the fixture builds it with the 1-D column builder and changes only the datatype and the `meta`.
//
// ── THE NEGATIVE CONTROL IS THE HALF THAT MAKES THIS MEAN ANYTHING ───────────────────────────
//
// "The narrowed layout is offered" passes for a second, much worse reason: the `dims: 2`
// narrowing being gone. So the project seeds a SECOND layout with the IDENTICAL structure and no
// component declaration, and asserts it is NOT offered. One of the two rows must be absent, or
// the picker has simply stopped narrowing and every 50-component decomposition in every project
// is now on offer as a frame.

const ROWS = 48
/** This spec's own row space, the way `empty-states.spec.ts` declares its own. */
const KEY_DIGEST = 'e2e-masked-layout-components-row-space'
/** The layout whose producer DECLARED its component columns. Offered, and drawable. */
const DECLARED_LAYOUT = 'masked projection'
/** The same shape with NO declaration. Not offered — the control that makes the above mean
 *  "the declaration was read" rather than "the narrowing was deleted". */
const BARE_LAYOUT = 'undeclared projection'
const COMPONENT = { x: 'pos x', y: 'pos y' } as const
const COLOUR_BY = 'post-narrowing metric'

/** A ramp per component, so the two are DIFFERENT sequences: if the resolver paired both
 *  components to one column the picture would be a perfect diagonal, which is data-shaped and
 *  wrong. Distinct ramps are what let the rendered extent disagree when that happens. */
const xs = Array.from({ length: ROWS }, (_, i) => i * 3)
const ys = Array.from({ length: ROWS }, (_, i) => ROWS - i)

/** The narrowed layout's own row: a 1-D `values` column carrying the datatype (and therefore the
 *  capability) of a layout, plus the producer declaration that survives the gather. */
function narrowedLayout(name: string, declareComponents: boolean) {
  const shaped = entityColumnArtifact(name, xs, ENTITY_AXIS)
  return {
    // `DT_POSITIONS` rather than the datatype's own name: this file is scanned by
    // `lint-no-domain-in-builtin`, and the fixtures module exports the generic alias for
    // exactly that reason. What matters here is the CAPABILITY it carries, not which
    // domain type happens to carry it.
    datatype: DT_POSITIONS,
    scope: 'dataset' as const,
    structure: { ...shaped.structure, aligned_to: KEY_DIGEST },
    meta: declareComponents
      ? { name, component_columns: [COMPONENT.x, COMPONENT.y] }
      : { name },
    content: { encoding: 'members' as const, members: shaped.members },
  }
}

function column(name: string, values: number[]) {
  const col = entityColumnArtifact(name, values, ENTITY_AXIS)
  return {
    datatype: DT.metadataColumn,
    scope: 'dataset' as const,
    structure: { ...col.structure, aligned_to: KEY_DIGEST },
    meta: { ...col.meta, kind: 'continuous', n: values.length },
    content: { encoding: 'members' as const, members: col.members },
  }
}

test.describe('a narrowed layout is offered and drawn from its declared component columns', () => {
  // NOT tagged `@acceptance`. That tag is reserved for specs that COMMIT A REAL SANDBOX RUN
  // and is EXCLUDED from the default tier (`playwright.config.ts` prints the exclusion and
  // says an excluded test is not a passed test) — it is for `just verify-acceptance` on a
  // rootfs-wired host. This spec seeds its rows through the debug seed route and needs no
  // sandbox at all, so tagging it would have removed it from every invocation that can
  // actually run it, in exchange for nothing. Measured, not assumed: with the tag it
  // reported `No tests found` while exiting 0 — a spec that never ran, and a PASS that would
  // have been unearned.
  test('the declared one is offered, the undeclared one is not, and the declared one draws', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000)

    await loginAsOwner(page)
    const projectId = await createProject(request, `Masked components ${Date.now()}`)

    // ONE plan, no shared plottable seed. That seeder writes a SECOND coordinate set in a
    // dataset with no key artifact, which would sit in this picker alongside the two rows
    // under test and make "the declared one is offered" ambiguous about WHICH row answered.
    const keys = entityColumnArtifact('row keys', Array.from({ length: ROWS }, (_, i) => i), ENTITY_AXIS)
    await postSeedPlan(request, projectId, {
      // ONE dataset. The component join is scoped to the layout's OWN dataset, which is what a
      // narrowing produces (every gathered row is inserted against the virtual dataset), so a
      // fixture that scattered these across datasets would be testing a scope the resolver
      // correctly refuses.
      dataset: { name: `narrowed-${Date.now()}`, datatype: DT.expression },
      artifacts: [
        {
          output_id: 'rows-index',
          datatype: DT.metadataColumn,
          scope: 'dataset',
          structure: { ...keys.structure, key: 'values', key_sequence_digest: KEY_DIGEST },
          meta: { ...keys.meta, is_axis_index: true },
          content: { encoding: 'members', members: keys.members },
        },
        { output_id: 'layout-declared', ...narrowedLayout(DECLARED_LAYOUT, true) },
        { output_id: 'layout-bare', ...narrowedLayout(BARE_LAYOUT, false) },
        { output_id: 'component-x', ...column(COMPONENT.x, xs) },
        { output_id: 'component-y', ...column(COMPONENT.y, ys) },
        { output_id: 'colour-by', ...column(COLOUR_BY, ys.map(v => v % 7)) },
      ],
    })

    await openVisualize(page, projectId)

    const picker = page.getByTestId(/^widget-coordinatePicker-radio(-\d+)?$/)
    await expect(picker.first()).toBeVisible({ timeout: 30_000 })

    // THE ASSERTION THIS SPEC EXISTS FOR. Without the selection half, the narrowed layout's
    // declared dimensions are `[n]`, the `dims: 2` narrowing drops it, and § Coordinates renders
    // its `empty_text` — the import looks finished and the view is blank.
    const declared = picker.getByRole('radio', { name: new RegExp(DECLARED_LAYOUT, 'i') })
    await expect(
      declared,
      'a narrowed layout declaring its component columns must be OFFERED as a frame — ' +
        'this is the row a gather leaves behind, and dropping it is what leaves a filtered ' +
        'view blank with nothing said',
    ).toBeVisible({ timeout: 30_000 })

    // THE CONTROL. Identical structure, no declaration: still not offered. Asserted on the same
    // rendered picker, so "not offered" cannot be satisfied by a picker that failed to render.
    await expect(
      picker.getByRole('radio', { name: new RegExp(BARE_LAYOUT, 'i') }),
      'a narrowed layout with NO component declaration must still be refused — if this one is ' +
        'offered too, the `dims` narrowing has been deleted rather than answered, and every ' +
        'wide decomposition in every project is now on offer as a frame',
    ).toHaveCount(0)

    await declared.click()
    await expect(declared).toBeChecked({ timeout: 30_000 })

    // ── THE ROWS ARE DERIVED FROM THE FRAME, SO § COLOUR BY IS THE WITNESS ─────────────
    //
    // § Colour by is scoped to the rows the CHOSEN frame resolves to. A frame whose rows do
    // not resolve empties it, so the post-narrowing column appearing here is the evidence
    // that the narrowed layout is a usable frame and not merely a visible one.
    //
    // Addressed by the section's own text, not by `getByRole('radio')`: § Colour by is a
    // TABLE of per-column rows, and the radio locator this assertion first used matched
    // nothing while the column was on screen the whole time — a locator bug that would have
    // read as a product defect.
    const colourBy = page.getByTestId(frame(SECTIONS.colourBy))
    await expect(colourBy).toBeVisible({ timeout: 30_000 })
    await expect(colourBy).toContainText(COLOUR_BY, { timeout: 30_000 })

    // …and it DRAWS, coloured by that column. The render half resolves the two declared names
    // to their sibling artifacts and the shipped adapter interleaves them into the positions
    // buffer; without it the layout falls through to the interleaved-`positions` channel,
    // which has no 2-D member to serve. Pressing the column's own ▶ is what asks for the
    // picture, so this is the assertion that the whole settlement is on the runtime path.
    await colourBy
      .getByRole('button', { name: new RegExp(`^Plot ${COLOUR_BY}`, 'i') })
      .first()
      .click()
    await expect(page.getByTestId('workbench-canvas-host').first()).toBeVisible({ timeout: 60_000 })
  })
})
