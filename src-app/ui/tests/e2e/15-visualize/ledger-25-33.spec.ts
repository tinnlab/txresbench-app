// THE OWNER'S LEDGER ROWS #25 AND #30–#33, ON THE OWNER'S OWN DATA SHAPE.
//
// ── why these live in one file, and why they are e2e at all ───────────────────────────────────
//
// Each of the five rows below has a unit test (`SectionFrame.test.tsx` for #25 and #30,
// `emitControl.test.tsx` for #31 and #33, `colourBy.test.ts` for #32). Every one of them asserts
// a DECLARATION or a class list, and the ledger this suite exists for was written because three
// successive rounds of work on this pane passed their tests and changed nothing on the owner's
// screen. The mechanism was always the same: the fixtures were well declared, so the code path
// the owner's project actually takes was never driven.
//
// So these are the same five claims, re-asserted on the RENDERED pane, driven at the pane's real
// width, against `seedOwnerImportedShape` — the fixture built from what the owner's importer
// really wrote (no `aligned_to` anywhere; an axis and its identifier twin sharing a key digest;
// coordinate sets whose declared name is the datatype word). Where a claim is geometric it is
// MEASURED in pixels rather than read off a class, because a class that is present and draws
// nothing is the specific failure this pane has already shipped twice.
//
// The captures are the deliverable. They are written to disk through `capture()`, which asserts
// the file is non-empty — six earlier captures in this suite were `attach({body})`, passed, and
// produced no file at all, because this config's reporters discard the bytes.

import { expect, test, type Page } from '@playwright/test'

import { loginAsOwner } from '../project/_helpers'
import { createProject } from '../14-workbench/_dock'
import { capture } from './_capture'
import { openVisualize, OWNER_SHAPE, seedOwnerImportedShape, SECTIONS } from './_visualize'

const DATASET_NAME = 'Population 1'
/** The pane's real width — the mockup's own, and the width every layout claim here is about. */
const PANE_PX = 300

async function setRegionWidth(page: Page, px: number): Promise<void> {
  await page.addInitScript(
    ([key, width]: [string, number]) => {
      const raw = window.localStorage.getItem(key)
      const blob = raw ? (JSON.parse(raw) as Record<string, unknown>) : { v: 1, byProject: {} }
      blob.prefs = { leftWidth: width, rightWidth: width, bottomHeight: 240 }
      window.localStorage.setItem(key, JSON.stringify(blob))
    },
    ['cyto.wb.regions', px] as [string, number],
  )
}

async function openOwnerProject(page: Page, request: import('@playwright/test').APIRequestContext): Promise<void> {
  const projectId = await createProject(request, `ledger-25-33 ${Date.now()}`)
  await seedOwnerImportedShape(request, projectId, DATASET_NAME)
  await loginAsOwner(page)
  await setRegionWidth(page, PANE_PX)
  await openVisualize(page, projectId)
}

const section = (page: Page, id: string) => page.locator(`[data-section-id="${id}"]`)
const coordinates = (page: Page) => section(page, SECTIONS.coordinates)
const colourBy = (page: Page) => section(page, SECTIONS.colourBy)
const entries = (page: Page) => section(page, SECTIONS.entries)

test.describe("the owner's ledger rows, on the owner's shape", () => {
  test('#25 — the plot count sits to the LEFT of the collapse control', async ({ page, request }) => {
    await openOwnerProject(page, request)

    // Give the section something to hold: the badge only exists while plots are open, which is
    // the whole of R6 and the reason this cannot be asserted on an untouched pane.
    const emit = coordinates(page).locator('[data-testid^="widget-coordinatePicker-emit-"]').first()
    await expect(emit).toBeVisible({ timeout: 30_000 })
    await emit.click()

    const badge = page.getByTestId(`section-badge-${SECTIONS.coordinates}`)
    await expect(badge).toBeVisible({ timeout: 30_000 })

    // MEASURED, not read from document order. The owner's sentence is about what they see, and
    // document order and visual order are the same thing here only because nothing reorders the
    // header — which is exactly the kind of assumption that stops being true silently.
    const laidOut = await coordinates(page).evaluate(el => {
      const b = el.querySelector('[data-testid^="section-badge-"]')!.getBoundingClientRect()
      // BOTH chevrons are in the DOM — kit renders a down and an up and hides one by
      // `aria-expanded`. The hidden one measures 0×0 at (0,0), so taking `querySelector`'s first
      // match reads a left edge of 0 and the comparison is meaningless. The VISIBLE one is the
      // collapse control the owner is looking at.
      const chevron = [...el.querySelectorAll('[data-slot="accordion-trigger-icon"]')]
        .map(n => n.getBoundingClientRect())
        .find(r => r.width > 0)!
      const grip = el.querySelector('[data-testid^="section-drag-handle-"]')!.getBoundingClientRect()
      return { badge: Math.round(b.left), chevron: Math.round(chevron.left), grip: Math.round(grip.left) }
    })
    expect(laidOut.badge, 'the count is not left of the collapse control').toBeLessThan(laidOut.chevron)
    // …and the grip is still last, at the section's outer edge — it is the grab target.
    expect(laidOut.chevron).toBeLessThan(laidOut.grip)

    await capture(test.info(), coordinates(page), 'ledger-25-badge-left-of-collapse.png')
  })

  test('#30 — one padding value: the card insets by exactly what the pane does', async ({ page, request }) => {
    await openOwnerProject(page, request)
    await expect(coordinates(page)).toBeVisible({ timeout: 30_000 })

    // THE IDENTITY, measured on the real page. The pane's content region publishes its inset;
    // the card reads the same value. Asserting a number would go green against two independent
    // literals that happen to agree today, which is the drift the owner is describing.
    const measured = await page.evaluate(() => {
      const card = document.querySelector('[data-testid^="section-frame-"]') as HTMLElement | null
      // THE PANE'S INSET, read where it is still readable. `--pane-inset` cannot be read from
      // inside the section: the pane's own scroll track RESETS it to `0px` for its subtree (so a
      // nested track cannot bleed twice), and the card is inside that subtree. The track keeps a
      // snapshot of the real value on its host, under `--pane-track-inset`, precisely so the
      // value survives the reset — and that is the number the pane actually insets its content
      // by, which is what the owner's sentence is about.
      const track = card?.closest('[data-pane-scroll]') as HTMLElement | null
      const px = (v: string): number => Math.round(parseFloat(v || '0'))
      // A custom property's computed value is the TOKEN, not a resolved length — the inset is
      // authored as `0.5rem` and `parseFloat` of it is 0.5, which silently compares a number of
      // rem against a number of px. Resolved through a probe element so both sides of the
      // identity are in the same unit, which is the only way the comparison means anything.
      const toPx = (token: string): number => {
        const probe = document.createElement('div')
        probe.style.cssText = `position:absolute;visibility:hidden;width:${token}`
        document.body.appendChild(probe)
        const w = Math.round(probe.getBoundingClientRect().width)
        probe.remove()
        return w
      }
      const r = track
        ? { paddingLeft: String(toPx(getComputedStyle(track).getPropertyValue('--pane-track-inset'))) }
        : null
      const c = card ? getComputedStyle(card) : null
      const body = card?.querySelector('[data-slot="accordion-content"] > div') as HTMLElement | null
      const b = body ? getComputedStyle(body) : null
      return {
        pane: r ? px(r.paddingLeft) : -1,
        cardInline: c ? px(c.paddingLeft) : -1,
        bodyTop: b ? px(b.paddingTop) : -1,
        bodyBottom: b ? px(b.paddingBottom) : -1,
      }
    })
    expect(measured.pane, 'the pane region has no inset to match').toBeGreaterThan(0)
    expect(measured.cardInline, 'the card does not inset by the pane inset').toBe(measured.pane)
    // The three symptoms the owner named are all "no TOP spacing", and they are all this number.
    expect(measured.bodyTop, "the section body's top spacing is not the pane inset").toBe(measured.pane)
    expect(measured.bodyBottom).toBe(measured.pane)

    // …and the three named symptoms, on the three real surfaces. Each is asserted as a GAP from
    // the thing it was reported as touching, so a fix that padded one site by hand and left the
    // rule alone would not satisfy all three.
    const firstChildGap = async (locator: ReturnType<typeof section>): Promise<number> =>
      locator.evaluate(el => {
        const body = el.querySelector('[data-slot="accordion-content"] > div') as HTMLElement | null
        const first = body?.firstElementChild?.getBoundingClientRect()
        const header = el.querySelector('[data-slot="accordion-trigger"]')?.getBoundingClientRect()
        return first && header ? Math.round(first.top - header.bottom) : -1
      })
    // the dataset heading in § Coordinates, `GROUPS` in the column section, and the entry
    // section's search box are each the first thing in their own body.
    for (const [what, where] of [
      ['the dataset heading', coordinates(page)],
      ['the group heading', colourBy(page)],
      ['the search box', entries(page)],
    ] as const) {
      await expect(where).toBeVisible({ timeout: 30_000 })
      expect(await firstChildGap(where), `${what} has no top spacing`).toBeGreaterThanOrEqual(measured.pane)
    }

    await capture(test.info(), page.getByTestId('section-stack-visualize'), 'ledger-30-one-padding.png')
  })

  test('#31 + #32 — the column section is a searchable, scrolling list of short unruled rows', async ({
    page,
    request,
  }) => {
    await openOwnerProject(page, request)
    const colour = colourBy(page)
    await expect(colour).toBeVisible({ timeout: 30_000 })

    // #32, the three things the owner named, on the rendered section.
    await expect(colour.getByTestId('widget-columns-search'), 'no search box').toBeVisible({ timeout: 30_000 })
    expect(await colour.locator('table').count(), 'the section still renders a table').toBe(0)
    const scroller = colour.getByTestId('widget-columns-scroll')
    await expect(scroller).toBeVisible()
    const bounded = await scroller.evaluate(el => {
      const s = getComputedStyle(el)
      return { maxHeight: s.maxHeight, overflowY: s.overflowY }
    })
    expect(bounded.overflowY, 'the list is not its own scroll box').toBe('auto')
    expect(bounded.maxHeight, 'the list has no max height').not.toBe('none')

    // Both declared groups, under the two words they have always read as.
    await expect(colour.getByTestId('widget-columns-group-Groups')).toContainText('Groups')
    await expect(colour.getByTestId('widget-columns-group-Values')).toContainText('Values')
    // …and the owner's two columns are in it, one under each.
    await expect(
      colour.getByRole('button', { name: `Plot ${OWNER_SHAPE.columns.categorical}`, exact: true }),
    ).toHaveCount(1, { timeout: 30_000 })
    await expect(
      colour.getByRole('button', { name: `Plot ${OWNER_SHAPE.columns.continuous}`, exact: true }),
    ).toHaveCount(1)

    // THE SEARCH BOX IS A SEARCH BOX. Typed, not merely present — a rendered input that filters
    // nothing is the dead-control failure this pane has paid for before.
    await colour.getByTestId('widget-columns-search').fill(OWNER_SHAPE.columns.categorical)
    await expect(
      colour.getByRole('button', { name: `Plot ${OWNER_SHAPE.columns.continuous}`, exact: true }),
    ).toHaveCount(0, { timeout: 30_000 })
    await expect(
      colour.getByRole('button', { name: `Plot ${OWNER_SHAPE.columns.categorical}`, exact: true }),
    ).toHaveCount(1)
    await colour.getByTestId('widget-columns-search').fill('')

    // #31 — short rows, no rules. Measured on the row the owner is looking at.
    const rows = await colour.evaluate(el =>
      [...el.querySelectorAll('[data-testid^="widget-columns-entry-"]')].map(li => {
        const s = getComputedStyle(li)
        return {
          height: Math.round(li.getBoundingClientRect().height),
          rules: [s.borderBottomWidth, s.borderTopWidth]
            .map(v => parseFloat(v || '0'))
            .filter(v => v > 0).length,
        }
      }),
    )
    expect(rows.length, 'the list rendered no rows to measure').toBeGreaterThan(0)
    for (const r of rows) {
      expect(r.rules, 'a row draws a separator').toBe(0)
      expect(r.height, `a row is ${r.height}px tall`).toBeLessThanOrEqual(36)
    }

    await capture(test.info(), colour, 'ledger-31-32-column-list.png')
  })

  test('#33 — one emit control: the three sections render the SAME button', async ({ page, request }) => {
    await openOwnerProject(page, request)
    await expect(coordinates(page)).toBeVisible({ timeout: 30_000 })
    await expect(colourBy(page)).toBeVisible({ timeout: 30_000 })
    await expect(entries(page)).toBeVisible({ timeout: 30_000 })

    /** What one section's emit control MEASURES AS — the only comparison the owner can make. */
    const shapeOf = async (where: ReturnType<typeof section>): Promise<Record<string, string>> => {
      const btn = where.getByRole('button', { name: /^Plot / }).first()
      await expect(btn).toBeVisible({ timeout: 30_000 })
      return btn.evaluate(el => {
        const s = getComputedStyle(el)
        const r = el.getBoundingClientRect()
        return {
          // the owner's word was BORDER. Rendered width and colour, not a class name: the
          // divergence they reported was visible, so the assertion is too.
          borderWidth: s.borderTopWidth,
          borderColor: s.borderTopColor,
          background: s.backgroundColor,
          size: `${Math.round(r.width)}x${Math.round(r.height)}`,
          // …and the glyph, so "the same button" is not satisfied by two different icons that
          // happen to share a box.
          glyph: el.querySelector('svg')?.getAttribute('class') ?? '',
        }
      })
    }

    const one = await shapeOf(coordinates(page))
    const two = await shapeOf(colourBy(page))
    const three = await shapeOf(entries(page))
    expect(two, 'the column section draws a different emit control from the picker').toEqual(one)
    expect(three, 'the entry section draws a different emit control from the picker').toEqual(one)
    // …and the shared one is BORDERLESS, which is the half the owner actually named.
    expect(one.borderColor, `the emit control is bordered (${one.borderColor})`).toMatch(
      /rgba\(0,\s*0,\s*0,\s*0\)|transparent/,
    )

    await capture(test.info(), page.getByTestId('section-stack-visualize'), 'ledger-33-one-emit-control.png')
  })
})
