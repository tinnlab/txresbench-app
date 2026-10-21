// THE POPULATED-RENDER REVIEW, made into a test.
//
// ── Why this spec exists ─────────────────────────────────────────────────────────────────
//
// The Visualize pane shipped with every gate green and was rejected on sight. The reason the
// gates could not see it is structural, and worth stating rather than fixing quietly: every one
// of them reads SOURCE or asserts STRUCTURE, and no assertion about structure can observe that a
// column of ten identical words is useless. Nor could the fixtures have shown it — every other
// spec in this directory seeds the MINIMUM its rule needs, and each of the reported defects is
// invisible below about three rows:
//
//   · one dataset publishing two axes reads as TWO DATASETS only when both are on screen;
//   · a picker of same-named options is only useless once there are several;
//   · a subtitle repeating a constant carries no information — but at N=1 there is no constant
//     to notice.
//
// So this spec drives the ORDINARY case (one dataset, two axes, three coordinate sets, two dozen
// columns) and asserts the two properties a person actually checks by looking:
//
//   A. no two options in one list read the same;
//   B. no slot that is meant to distinguish options holds the same string on every one of them.
//
// It runs at the pane's REAL width and at a phone width, because both are shipped surfaces and
// the second is where a repeated string wraps and costs three lines instead of one. The
// screenshots it writes are the review artifact.
//
// The same two properties are asserted on rendered DOM in
// `core/render/distinguishableOptions.test.tsx`, at the unit tier and with a negative control.
// This is the same class at the other end of the stack: there, against fabricated candidates;
// here, against the real resolver, the real widget registry and a real backend.

import { expect, test } from '@playwright/test'

import { loginAsOwner } from '../project/_helpers'
import { createProject } from '../14-workbench/_dock'
import { frameThePane, openVisualize } from './_visualize'
import { postSeedPlan } from '../14-declarative-qc/_seed'
import {
  DT,
  ENTITY_AXIS,
  entityColumnArtifact,
  zarrClusteringArtifact,
  zarrEmbeddingArtifact as zarrPositionsArtifact,
  DT_POSITIONS,
} from '../14-declarative-qc/_fixtures'
import type { APIRequestContext } from '@playwright/test'

// ── THE POPULATED PROJECT (`pane-legibility.spec.ts`) ────────────────────────────────────
//
// Every other fixture in this suite is MINIMAL — two columns, one coordinate set, one row
// space — because each spec is about one rule. That is why the pane could pass all of them and
// still be rejected on sight: the defects the owner reported are all defects of a POPULATED
// list, and a list of two never shows them. One dataset publishing two axes reads as two
// datasets only when both are on screen; a picker of same-named options is only useless once
// there are several of them; a subtitle that repeats a constant is invisible at N=1.
//
// So this fixture is deliberately the ordinary case rather than the small one.


/** The two axes ONE dataset publishes. Their lengths differ, which is the fact that proves they
 *  are two row spaces and not two names for one (§7.5.2) — and, once the shared provenance is
 *  hoisted, the only thing left distinguishing the two options. */
export const POPULATED = {
  primaryRows: 3460,
  secondaryRows: 1477,
  /** How many columns § Colour by lists. Enough that a repeated per-row string is furniture. */
  columns: 24,
  /** The dataset name, in the shape the owner's own project carries it: a content-addressed
   *  export filename. It is a real dataset name (the upload path preserves the client filename
   *  verbatim), which is exactly why it must be said ONCE. */
  datasetName: '1ddf5a78-4a2c-11ef-9c3d-0242ac120002.dat',
} as const

const POP_KEY_PRIMARY = 'e2e-populated-primary'
const POP_KEY_SECONDARY = 'e2e-populated-secondary'

/**
 * ONE dataset, TWO axes, THREE coordinate sets that all declare the same `meta.name`, and two
 * dozen columns.
 *
 * The coordinate sets reproduce the shipped producer's payload SHAPE: `meta.name` is one
 * identical word on all three (so they collide), `meta.source_key` differs (so something DOES
 * distinguish them), and their declared component counts differ (so coverage distinguishes two
 * of them and not the third).
 */
export async function seedPopulatedProject(
  request: APIRequestContext,
  projectId: string,
): Promise<{ datasetId: string; columns: string[] }> {
  const nA = POPULATED.primaryRows
  const nB = POPULATED.secondaryRows
  const keysA = entityColumnArtifact('primary keys', Array.from({ length: nA }, (_, i) => i), ENTITY_AXIS)
  const keysB = entityColumnArtifact('secondary keys', Array.from({ length: nB }, (_, i) => i), 'secondary')
  const columns = Array.from({ length: POPULATED.columns }, (_, i) => `measure_${String(i + 1).padStart(2, '0')}`)
  // Three coordinate sets on the PRIMARY axis. Same declared name, different declared key.
  const coords = [
    { id: 'K_alpha', dims: 2 },
    { id: 'K_beta', dims: 50 },
    { id: 'K_gamma', dims: 2 },
  ]
  const seeded = await postSeedPlan(request, projectId, {
    dataset: { name: POPULATED.datasetName, datatype: DT.expression },
    artifacts: [
      {
        output_id: 'rows-primary',
        datatype: DT.metadataColumn,
        scope: 'dataset',
        structure: { ...keysA.structure, key: 'values', key_sequence_digest: POP_KEY_PRIMARY },
        meta: { ...keysA.meta, is_axis_index: true },
        content: { encoding: 'members', members: keysA.members },
      },
      {
        output_id: 'rows-secondary',
        datatype: DT.metadataColumn,
        scope: 'dataset',
        structure: { ...keysB.structure, key: 'values', key_sequence_digest: POP_KEY_SECONDARY },
        meta: { ...keysB.meta, is_axis_index: true },
        content: { encoding: 'members', members: keysB.members },
      },
      ...coords.map(({ id, dims }) => {
        const emb = zarrPositionsArtifact(nA)
        return {
          output_id: `coords-${id}`,
          datatype: DT.embedding,
          scope: 'dataset' as const,
          // The helper's OWN member declaration, with only the component count varied — the
          // member PATH is the reader's, not this fixture's to restate.
          structure: {
            ...emb.structure,
            aligned_to: POP_KEY_PRIMARY,
            arrays: (emb.structure.arrays as Array<Record<string, unknown>>).map(a => ({ ...a, shape: [nA, dims] })),
          },
          // The SHIPPED payload's SHAPE: one identical declared name across the whole set (the
          // producer used to default it to its datatype word), plus the declared key that does
          // tell them apart. Stated in neutral terms — the defect is not about any particular
          // science, and this tree carries no domain vocabulary it does not have to.
          meta: { name: 'positions', kind: 'positions', axis: ENTITY_AXIS, n: nA, n_dims: dims, source_key: id },
          content: { encoding: 'members' as const, members: emb.members },
        }
      }),
      // POSITIONS ON THE SECONDARY AXIS TOO — so this project holds TWO ROW SPACES.
      //
      // It used to hold two AXES and one plottable row space, and the picker listed both
      // because the offer was an enumeration of axes. That is the defect fixed in
      // `rowSpaces.ts`: an axis nothing can be drawn on is not a row space, so the old fixture
      // now collapses to a single candidate and this spec's subject — a picker whose options
      // must be distinguishable from each other — would not exist. The fixture gains a second
      // genuinely plottable row space rather than the assertion being weakened.
      (() => {
        const emb = zarrPositionsArtifact(nB)
        return {
          output_id: 'coords-secondary',
          // The NEUTRAL alias (`_fixtures.ts`), so this addition spends no domain token.
          datatype: DT_POSITIONS,
          scope: 'dataset' as const,
          structure: {
            ...emb.structure,
            axis: 'secondary',
            aligned_to: POP_KEY_SECONDARY,
            arrays: (emb.structure.arrays as Array<Record<string, unknown>>).map(a => ({ ...a, shape: [nB, 2] })),
          },
          meta: { name: 'positions', kind: 'positions', axis: 'secondary', n: nB, n_dims: 2, source_key: 'K_delta' },
          content: { encoding: 'members' as const, members: emb.members },
        }
      })(),
      // A CATEGORICAL column too, so § Colour by lists BOTH of its blocks. With only one
      // populated the section reads as a single grid and the "which heading is for what"
      // complaint cannot be observed at all — which is how the shipped pane got here.
      (() => {
        const cat = zarrClusteringArtifact(nA)
        return {
          output_id: 'pop-cat',
          datatype: DT.metadataColumn,
          scope: 'dataset' as const,
          structure: { ...cat.structure, aligned_to: POP_KEY_PRIMARY },
          meta: {
            name: 'grouping',
            kind: 'categorical',
            categories: cat.levels,
            n_categories: cat.levels.length,
            n: nA,
          },
          content: { encoding: 'members' as const, members: cat.members },
        }
      })(),
      ...columns.map((name, ci) => {
        const col = entityColumnArtifact(name, Array.from({ length: nA }, (_, i) => (i % 11) + ci), ENTITY_AXIS)
        return {
          output_id: `pop-col-${ci}`,
          datatype: DT.metadataColumn,
          scope: 'dataset' as const,
          structure: { ...col.structure, aligned_to: POP_KEY_PRIMARY },
          meta: { ...col.meta, kind: 'continuous', min: ci, max: 10 + ci, n: nA },
          content: { encoding: 'members' as const, members: col.members },
        }
      }),
    ],
  })
  return { datasetId: seeded.dataset_id as string, columns }
}


/**
 * The two SHIPPED surfaces, and the reason both are driven.
 *
 * `desktop` uses a full window and screenshots the PANE — the pane is a docked column a few
 * hundred pixels wide inside a wide app, so shrinking the window instead would drive the mobile
 * shell and prove nothing about it. `phone` is below the 768px threshold where `WorkbenchShell`
 * hands over to `MobileShell` and the same stack becomes a full-width sheet, which is where a
 * repeated string stops costing one line and starts costing three.
 */
const SURFACES = {
  desktop: { width: 1440, height: 1000 },
  phone: { width: 390, height: 844 },
} as const

/** Every option of a radio group, as the lines a person reads top to bottom. */
async function optionLines(group: import('@playwright/test').Locator): Promise<string[][]> {
  return group.evaluate(el =>
    [...el.querySelectorAll('[role="radio"], [role="radiogroup"] label')]
      .map(o => (o.textContent ?? '').trim())
      .filter(t => t !== '')
      .map(t => t.split('\n').map(x => x.trim()).filter(Boolean)),
  )
}

/** CLAUSE A — no two rows read the same. */
function expectDistinguishable(rows: readonly string[], what: string): void {
  const seen = new Map<string, number>()
  for (const r of rows) {
    const k = r.replace(/\s+/g, ' ').trim()
    seen.set(k, (seen.get(k) ?? 0) + 1)
  }
  expect(
    [...seen.entries()].filter(([, n]) => n > 1).map(([k, n]) => `${n}× "${k}"`),
    `${what}: options a user cannot tell apart`,
  ).toEqual([])
}

/** CLAUSE B — no positional slot holds one constant across every row. */
function expectNoConstantSlot(lines: readonly (readonly string[])[], what: string): void {
  if (lines.length < 2) return
  const width = Math.max(...lines.map(l => l.length))
  const offenders: string[] = []
  for (let i = 0; i < width; i++) {
    const col = lines.map(l => (l[i] ?? '').replace(/\s+/g, ' ').trim())
    if (col.every(v => v !== '' && v === col[0])) offenders.push(`slot ${i} is always "${col[0]}"`)
  }
  expect(offenders, `${what}: a distinguishing slot repeats one constant`).toEqual([])
}

test.describe('the populated pane is legible', () => {
  for (const [surface, viewport] of Object.entries(SURFACES)) {
    test(`on the ${surface} surface (${viewport.width}px): every list distinguishes its own options`, async ({
      page,
      request,
    }, testInfo) => {
      test.setTimeout(240_000)
      await page.setViewportSize(viewport)
      const name = surface
      const projectId = await createProject(request, `viz-legibility-${surface} ${Date.now()}`)
      await seedPopulatedProject(request, projectId)
      await loginAsOwner(page)
      if (surface === 'phone') {
        // Below 768px the stack lives in `MobileShell`'s LEFT sheet, and the sheet has to be
        // opened by its own affordance — `openVisualize`'s dock tab does not exist there.
        await page.goto(`/projects/${projectId}/workspace`)
        const shell = page.getByTestId('workbench-shell')
        await shell.waitFor({ state: 'visible', timeout: 60_000 })
        await expect(shell).toHaveAttribute('data-workbench-mobile', 'true')
        const trigger = page.getByRole('button', { name: 'Visualize', exact: true }).first()
        if (await trigger.count()) await trigger.click()
        await expect(page.getByTestId('section-stack-visualize')).toBeVisible({ timeout: 60_000 })
      } else {
        await openVisualize(page, projectId)
      }
      /** The surface under review — the pane column itself, so a desktop screenshot shows the
       *  few-hundred-pixel column a user meets and not 1440px of window around it. */
      const paneShot = async (file: string): Promise<void> => {
        const el = page.getByTestId('section-stack-visualize')
        await el.screenshot({ path: testInfo.outputPath(file) }).catch(async () => {
          await page.screenshot({ path: testInfo.outputPath(file), fullPage: true })
        })
      }

      // ── § COORDINATES (owner findings #1, #2, #3, #5, #8) ───────────────────────────
      //
      // WHAT WAS HERE, AND WHY IT IS NOT (owner, 2026-08-13). This block used to review the
      // pane's first block: a ROW-SPACE PICKER, a control asking WHICH ROWS, whose options had
      // to be distinguishable from each other and whose shared provenance had to be hoisted out
      // of the rows and stated once above them. The owner ruled that control out of existence —
      // *"there is no such thing as a row space"* — and it is deleted, along with its
      // `row-space-anchor*` testids and its heading.
      //
      // The RULE it was reviewed against is not deleted: it is a rule about any list of
      // options this pane offers, and § Coordinates is the surface that inherited it. It is now
      // the pane's FIRST block, it lists immediately with nothing chosen, and — because its
      // source is project-wide — it is where the several-options-that-look-alike problem now
      // lives. So the same two clauses run here, and the pane's opening screen is still the one
      // under review.
      // Addressed by the CONTROL'S STABLE TESTID rather than by `getByRole('radiogroup', {name:
      // 'Coordinates'})`. The offer is grouped under a dataset heading ALWAYS now (ledger
      // #8/#16), and when it groups, the control's own name moves to the wrapping group box
      // while each inner radiogroup is named by its dataset — which is the shape-independent
      // address the widget documents and the reason the testid exists.
      const coords = page.getByTestId('widget-coordinatePicker-radio')
      await expect(coords).toBeVisible({ timeout: 60_000 })
      const coordLines = await optionLines(coords)
      // THREE are OFFERED of the four seeded: `K_beta` declares fifty components and
      // § Coordinates declares `dims: 2`, so it is not offered at all — no component picker and
      // no silent "first two". The other three are the two 2-D sets on the primary axis plus
      // the one on the secondary, which reach one list because this picker is no longer scoped
      // to an answered question.
      expect(coordLines.length, 'the four seeded sets, less the one wider than 2-D').toBe(3)

      expectDistinguishable(coordLines.map(l => l.join(' ')), 'coordinates picker')
      expectNoConstantSlot(coordLines, 'coordinates picker')
      // The DECLARED key is what tells them apart — never eight characters of content hash,
      // which is what a picker falls back to when the distinguishing declaration is unread.
      const coordText = coordLines.flat().join(' | ')
      for (const key of ['K_alpha', 'K_gamma', 'K_delta']) expect(coordText).toContain(key)
      // …and the >2-D set is absent by NAME too, so "three options" cannot be satisfied by the
      // wrong three.
      expect(coordText, 'a set wider than 2-D was offered').not.toContain('K_beta')
      // The LENGTHS still distinguish, and they are the discriminator the shared-provenance
      // hoist must not take with it: with one source dataset the dataset name is a constant of
      // the whole list, so it is said once (or not at all) and never under every option.
      expect(coordText).toContain(POPULATED.primaryRows.toLocaleString())
      expect(coordText).toContain(POPULATED.secondaryRows.toLocaleString())
      for (const name of coordLines.map(l => l[0] ?? '')) {
        expect(name, 'an option qualified by content hash instead of a declared name').not.toMatch(
          /\b[0-9a-f]{8}\b/,
        )
      }
      // The dataset is a constant here too, and it is not repeated under every option.
      expect(coordText, 'the dataset repeated under every coordinate option').not.toContain('1ddf5a78')

      // ── THE WORD IS NOT SAID TWICE (owner finding #3) ───────────────────────────────
      //
      // The section header says "Coordinates". The picker inside it used to as well, one line
      // apart. The ACCESSIBLE name is unaffected — the radiogroup above was found BY that name,
      // so this assertion and the locator above cannot both pass unless the two were separated.
      const section = page.locator('[data-section-id="sc.viz.coordinates"]')
      const saidTwice = await section.evaluate(el =>
        [...el.querySelectorAll('*')]
          .filter(n => n.children.length === 0 && (n.textContent ?? '').trim() === 'Coordinates')
          .length,
      )
      expect(saidTwice, '"Coordinates" rendered more than once in its own section').toBeLessThanOrEqual(1)

      // ── NO ALIGNMENT STATEMENT AT ALL (owner, ledger #28 + #29) ─────────────────────
      //
      // This clause has been tightened twice. It began as *"not three"* — the same paragraph in
      // three places is how a real warning stops being read — and was capped at one per section.
      // The owner then asked for the last alert to go (#28) and for the mark an emitted plot
      // carried to go with it (#29), which retires the rule rather than another instance of it.
      // So the count is ZERO, on the RENDERED page, which is the surface the owner reads.
      //
      // SCOPED TO THE PANE, and the scope is a finding rather than a convenience: run
      // page-wide, this reports one match that is NOT the pane's — a `SPAN` reading exactly
      // `alignment`, which is a manifest KEY rendered by the project's artifact surface (an
      // importer package's supporting-input slots declare an `alignment:` block, and that
      // surface prints a declaration's key names). It is a different surface, a different
      // author and a different fact, and the owner's two rows are about the Visualize pane. The
      // offenders are LISTED rather than counted so the next one is identified instead of
      // merely tallied — which is how this scope was found.
      const offenders = await page.evaluate(() => {
        const pane = document.querySelector('[data-testid="section-stack-visualize"]')
        return [...(pane?.querySelectorAll('*') ?? [])]
          .filter(n => n.children.length === 0 && /alignment/i.test(n.textContent ?? ''))
          .map(n => `${n.tagName}[${n.getAttribute('data-testid') ?? ''}] ${(n.textContent ?? '').slice(0, 90)}`)
      })
      expect(offenders, 'the pane still tells the user about alignment').toEqual([])

      // ── FRAME THE PANE BEFORE REVIEWING THE SECTIONS BELOW § COORDINATES ───────────
      //
      // Everything above this line is the pane's OPENING screen, reviewed with nothing chosen —
      // which is the state the owner meets and the one the legibility clauses are about.
      // Everything below is about § Colour by, and § Colour by has nothing to be legible ABOUT
      // until a coordinate set is picked: the rows it scopes to are DERIVED from that pick
      // (owner, 2026-08-13), and nothing is chosen for the user.
      //
      // This used to need no gesture, because the pane's deleted first block auto-bound the
      // project's sole row space. Do not "restore" an auto-selection to remove this line — the
      // owner asked for the selection to go, and a pane that chooses for you is what went.
      await frameThePane(page)

      // ── EVERY BLOCK SAYS WHAT IT IS (owner finding #2) ──────────────────────────────
      const colour = page.locator('[data-section-id="sc.viz.colour-by"]')
      await expect(colour).toBeVisible({ timeout: 60_000 })
      // `Groups` and `Values` were the two TABLE headings until ledger #32 made the section one
      // searchable list; they are its two GROUP headings now — the same two words, in the same
      // order, saying the same thing about the same rows. The clause is unchanged: every block
      // says what it is. It is read off the rendered text rather than off a per-table testid,
      // because the list numbers its groups and a `toHaveText` on the whole heading would be
      // asserting the count as well as the name.
      await expect(colour.getByTestId('widget-columns-group-Groups')).toContainText('Groups')
      await expect(colour.getByTestId('widget-columns-group-Values')).toContainText('Values')

      // ── SECTIONS ARE VISIBLY SEPARATE (owner findings #2, #7) ───────────────────────
      //
      // Asserted on COMPUTED style rather than on a class name: the defect was that kit's only
      // separator (`not-last:border-b` on an accordion item) can never match, because each
      // section mounts its own single-item accordion — i.e. a class was present and drew
      // nothing. A class assertion would have passed throughout.
      const framed = await page
        .locator('[data-section-id] [data-testid^="section-frame-"]')
        .first()
        .evaluate(el => {
          const s = getComputedStyle(el)
          return { border: parseFloat(s.borderTopWidth || '0'), radius: parseFloat(s.borderTopLeftRadius || '0') }
        })
      expect(framed.border, 'a section draws no boundary of its own').toBeGreaterThan(0)
      expect(framed.radius).toBeGreaterThan(0)

      // ── THE EMIT GLYPH IS NOT A TRANSPORT ▶ (owner finding #6) ──────────────────────
      //
      // Read off the rendered SVG, not off the yaml: the registry silently degrades an
      // unregistered icon name to a wordy text button, so a spec that read the declaration
      // would pass on a pane that draws no glyph at all.
      const emit = colour.getByRole('button', { name: /^Plot / }).first()
      await expect(emit).toBeVisible({ timeout: 60_000 })
      const glyph = await emit.locator('svg').first().getAttribute('class')
      expect(glyph ?? '', 'the emit button still draws a play triangle').not.toMatch(/lucide-play\b/)

      // ── THE EMIT BUTTON IS REACHABLE WITHOUT SCROLLING SIDEWAYS ────────────────────
      //
      // The clause is unchanged; its subject moved. It used to measure the colouring section's
      // TABLE GRID against its box, because a `table` scrolls inside itself when it cannot fit
      // — right for a data grid, wrong for this section, whose entire purpose is that button:
      // a purpose you reach by scrolling a grid sideways, with no scrollbar visible until you
      // try, is a purpose most users never find. There is no grid any more (ledger #32 made the
      // section one list), so the measurement is taken on THE BUTTON ITSELF against the
      // section's content box — which is what the clause was always about and is now control-
      // agnostic: it survives the next change of control as the grid measurement did not.
      const fit = await emit.evaluate(el => {
        const box = el.closest('[data-testid^="section-frame-"]')
        const b = el.getBoundingClientRect()
        const o = (box ?? el).getBoundingClientRect()
        return { right: Math.round(b.right), edge: Math.round(o.right), width: Math.round(b.width) }
      })
      expect(fit.width, 'the emit button collapsed to nothing').toBeGreaterThan(0)
      expect(fit.right, `the emit button sits past the section's edge (${fit.right}px vs ${fit.edge}px)`)
        .toBeLessThanOrEqual(fit.edge)

      // ── A ROW IS SHORT, AND HAS NO RULE UNDER IT (owner, ledger #31) ────────────────
      //
      //   *"each row in the group and values are too tall, we do not need row line"*
      //
      // Measured on the RENDERED row, because both halves are claims about what the owner sees
      // and neither is visible in a class list: a `divide-y` on a parent draws the rule on the
      // child, and a row's height is whatever its tallest child makes it.
      const row = await colour.getByRole('button', { name: /^Plot / }).first().evaluate(el => {
        const li = el.closest('li')
        const s = li ? getComputedStyle(li) : null
        return {
          height: Math.round(li?.getBoundingClientRect().height ?? 0),
          rules: s
            ? [s.borderBottomWidth, s.borderTopWidth].map(v => parseFloat(v || '0')).filter(v => v > 0).length
            : -1,
        }
      })
      expect(row.rules, 'a list row draws a separator').toBe(0)
      // 36px = the 28px emit control plus its line-box slack. A bound rather than an equality:
      // what the owner reported is a row that is TOO TALL, and pinning the exact pixel would go
      // red on a font-metric change that nobody would call a regression.
      expect(row.height, `a list row is ${row.height}px tall`).toBeLessThanOrEqual(36)

      await paneShot(`pane-${name}-populated.png`)
    })
  }
})
