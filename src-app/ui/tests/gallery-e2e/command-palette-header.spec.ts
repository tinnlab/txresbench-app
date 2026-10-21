// The command palette's search field must read as a HEADER — a solid surface, visually detached
// from the list below it.
//
//   "the command list background in the search command input search on top should have solid
//    background and appear on top of everything else"
//
// It was `p-1 pb-0` with NO background, so it was transparent and sat flush against the first list
// row: with the list scrolled, a half-clipped row of text abuts the field directly and the whole
// thing reads as one continuous stack rather than a field above a list.
//
// WHY THIS IS AN E2E TEST. The property is CSS — an alpha channel and a rendered gap. jsdom never
// compiles Tailwind, so `getComputedStyle` would return nothing and the only thing left to assert
// would be the class string, a source-text assertion this repo has twice rejected. So this measures
// COMPUTED values in a real browser, in BOTH themes: a mismatched surface token is exactly the kind
// of mistake that looks right in one theme and wrong in the other.

import { expect, test, type Page } from '@playwright/test'

const SURFACE = (theme: string) =>
  `/gallery.html?surface=command-palette-open&state=open&theme=${theme}`

/** Parse any computed colour to [r,g,b,a]; alpha 1 means fully opaque. */
function alphaOf(color: string): number {
  const m = color.match(/^rgba?\(([^)]+)\)/)
  if (m) {
    const parts = m[1].split(/[,/]/).map(p => p.trim())
    return parts.length >= 4 ? parseFloat(parts[3]) : 1
  }
  // oklab()/oklch()/color() forms carry alpha after a slash.
  const slash = color.match(/\/\s*([0-9.]+%?)\s*\)/)
  if (slash) {
    const raw = slash[1]
    return raw.endsWith('%') ? parseFloat(raw) / 100 : parseFloat(raw)
  }
  if (color === 'transparent') return 0
  return 1
}

async function openPalette(page: Page, theme: string) {
  await page.goto(SURFACE(theme), { waitUntil: 'domcontentloaded' })
  await page.locator('[data-slot="command-input-wrapper"]').waitFor({ state: 'visible', timeout: 30_000 })
  // Scroll the list — the defect is only visible once content reaches the top edge.
  await page.evaluate(() => {
    const list = document.querySelector('[data-slot="command-list"]')
    if (list) list.scrollTop = 120
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`[${theme}] the palette header is a SOLID surface, not transparent`, async ({ page }) => {
    await openPalette(page, theme)

    const measured = await page.evaluate(() => {
      const wrapper = document.querySelector('[data-slot="command-input-wrapper"]')
      const root = document.querySelector('[data-slot="command"]')
      if (!wrapper || !root) return null
      return {
        header: getComputedStyle(wrapper).backgroundColor,
        surface: getComputedStyle(root).backgroundColor,
      }
    })
    expect(measured, 'palette did not render').not.toBeNull()

    // The header must be opaque — this is the assertion the defect fails (it measured
    // `rgba(0, 0, 0, 0)`).
    expect(
      alphaOf(measured!.header),
      `header background ${measured!.header} is not opaque`,
    ).toBe(1)

    // …and it must resolve to the SAME colour the palette surface uses. A hardcoded colour or a
    // mismatched token would pass the opacity check above while being visibly wrong in one theme —
    // which is why this runs in both. Swapping in `bg-muted` fails here.
    //
    // KNOWN LIMIT, stated rather than papered over: this measures the rendered COLOUR, so it cannot
    // distinguish `bg-popover` from `bg-card` — `--card` and `--popover` are byte-identical in both
    // themes (tokens.css), so that substitution is semantically wrong but produces identical pixels.
    // Catching it would need a class-string assertion, which this repo has rejected.
    expect(measured!.header, 'header does not use the palette surface token').toBe(measured!.surface)
  })

  test(`[${theme}] the palette header is visually detached from the list`, async ({ page }) => {
    await openPalette(page, theme)

    const gap = await page.evaluate(() => {
      const group = document.querySelector('[data-slot="command-input-wrapper"] [data-slot="input-group"]')
      const list = document.querySelector('[data-slot="command-list"]')
      if (!group || !list) return null
      return {
        gap: list.getBoundingClientRect().top - group.getBoundingClientRect().bottom,
        listScrolled: list.scrollTop,
        scrollable: list.scrollHeight > list.clientHeight,
      }
    })
    expect(gap, 'palette did not render').not.toBeNull()

    // Non-vacuous: the list must actually be scrolled, or "content abuts the field" is untestable.
    expect(gap!.scrollable, 'the command list does not scroll — the symptom cannot occur').toBe(true)
    expect(gap!.listScrolled).toBeGreaterThan(0)

    // The search field's bottom edge must not touch the list. It measured exactly 0 before, and is
    // one 4px padding step after — asserted as "clearly non-zero" rather than "=== 4" because
    // fractional layout rounds it (3.9967px was observed), and the property is the separation
    // existing, not its exact size.
    expect(
      gap!.gap,
      `only ${gap!.gap}px between the search field and the list — clipped content sits flush against it`,
    ).toBeGreaterThan(2)
  })
}

test('the header keeps the search field readable over it (the field keeps its own tint)', async ({
  page,
}) => {
  // The fix makes the HEADER solid, deliberately not the field: flattening `bg-input/30` to an
  // opaque fill would change the design language for every consumer of InputGroup. This pins that
  // choice — the field stays a translucent tint, and it is the header behind it that is solid.
  await openPalette(page, 'light')
  const field = await page.evaluate(() => {
    const group = document.querySelector('[data-slot="command-input-wrapper"] [data-slot="input-group"]')
    return group ? getComputedStyle(group).backgroundColor : null
  })
  expect(field).not.toBeNull()
  expect(alphaOf(field!), `the field should stay a tint, measured ${field}`).toBeLessThan(1)
})
