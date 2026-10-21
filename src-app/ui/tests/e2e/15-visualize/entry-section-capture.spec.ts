// THE ENTRY SECTION, PHOTOGRAPHED IN BOTH OF ITS STATES.
//
// ── Why both, and why this file is a CAPTURE rather than a claim ──────────────────────────────
//
// The three fixes this round made to the entry section are about what a row RENDERS: the
// per-source sub-row (a datatype id and a matrix's dimensions, identical under every entry in
// the list, carrying a second emit control that did what the row's own already did) is gone
// unless an entry genuinely resolves to more than one source, and the mockup's inline second
// annotation is back. Those are asserted as a CLASS in `extensions/visualize/entryList.test.tsx`
// — over whatever the list rendered, with a positive control — because a per-instance assertion
// is what let the defect through the last review.
//
// What a test cannot do is let the owner LOOK at it, and this section is the one they reported.
// So this file exists to produce the images.
//
// ── IT OPENS. THAT IS THE DEFAULT, AND THIS FILE PINS IT ──────────────────────────────────────
//
// The section shipped `collapsed: true`, declared UNCONDITIONALLY on the manifest entry
// (`collapsed?: boolean` — a static boolean; the contribution contract has no predicate form and
// the stack resolves it as `override ?? declared ?? false`). The binding mockup
// (`docs/design/visualize-pane-mockup.html`) renders this section OPEN, with its annotation
// select, its search box, its group headings and its entries — so the shipped default
// contradicted the binding reference, and nothing in the tree read that reference until a gate
// was written for it.
//
// The owner settled it on 2026-08-13: flip it to `collapsed: false`. So there is no longer a
// "collapsed shot" to take, because there is no collapsed state to be honest about — and the
// image that used to be labelled "the shipped default" would now be a lie, which is why it is
// gone rather than renamed in place.
//
// What this file captures instead is the section AS IT OPENS, with its content, and it ASSERTS
// the default rather than merely photographing it: an image can go stale silently, and the
// assertion is what makes a future flip back to `true` fail here instead of quietly changing
// what the owner meets.

import { expect, test } from '@playwright/test'

import { loginAsOwner } from '../project/_helpers'
import { createProject } from '../14-workbench/_dock'
import { capture } from './_capture'
import { CONTESTED, frameThePane, openVisualize, seedContestedEntryProject } from './_visualize'

const ENTRIES = '[data-section-id="sc.viz.entries"]'

test.describe('the entry section — the capture', () => {
  test("it OPENS by default, with its content — the mockup's own shape", async ({ page, request }) => {
    test.setTimeout(240_000)
    const projectId = await createProject(request, `entries-capture ${Date.now()}`)
    await seedContestedEntryProject(request, projectId)
    await loginAsOwner(page)
    await openVisualize(page, projectId)
    // The section lists the entries of the frame's sibling axis, so the pane has to be framed
    // before there is anything to photograph.
    await frameThePane(page)

    const section = page.locator(ENTRIES)
    await expect(section).toBeVisible({ timeout: 60_000 })

    // ── THE DEFAULT, ASSERTED BEFORE IT IS PHOTOGRAPHED ───────────────────────────────────
    //
    // NO GESTURE has been made at this point, and none is made in this file. The section is open
    // because the package declares it open — which is the whole of what changed — so this is
    // what the owner meets. Addressed by the ARIA state the accordion trigger owns rather than
    // by the section's title: the title is the shipped package's word and this file carries none
    // of it.
    const trigger = section.locator('[aria-expanded]').first()
    await expect(trigger).toHaveAttribute('aria-expanded', 'true', { timeout: 60_000 })

    const list = section.getByTestId('widget-entries')
    await expect(list).toBeVisible({ timeout: 60_000 })
    // Non-vacuous: the fixture's entries actually rendered, so the image is of a POPULATED
    // section rather than of an empty one that happened to open.
    await expect(section.getByTestId(`widget-entries-entry-${CONTESTED.keys[0]}`)).toBeVisible({ timeout: 60_000 })

    await capture(test.info(), section, 'entry-section-open-by-default.png')

    // ── WHAT THE IMAGE SHOULD SHOW, asserted so the picture cannot quietly stop matching ──
    // ONE control per row (the row's own ▶) where the entry resolves to a single source, and
    // no sub-row repeating that source's name under every entry.
    const firstRow = section.getByTestId(`widget-entries-entry-${CONTESTED.keys[0]}`)
    expect(await firstRow.locator('button').count()).toBe(1)
    // …and the row's OTHER annotation, inline — the mockup's `CD3E  ENSG…98851`.
    await expect(section.getByTestId(`widget-entries-second-${CONTESTED.keys[0]}`)).toBeVisible()
  })
})
