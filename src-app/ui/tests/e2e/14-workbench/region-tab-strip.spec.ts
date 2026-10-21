import { expect, test, type Locator, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { loginAsOwner, ownerToken } from '../project/_helpers'
import { BACKEND, createProject, openWorkbench, trackErrors } from './_dock'

// THE REGION TAB STRIPS: an OVERLAY scroll track, and a tablist assistive tech can still parse.
//
// ── Why this needed measuring rather than a find-and-replace ─────────────────────────────────
// Every other scrolling surface in the workbench moved to the kit `ScrollArea`
// (overlayscrollbars) in 74d7ed9c. Two were deliberately left on native `overflow-*-auto`, with
// a stated reason: overlayscrollbars renders `host > [data-overlayscrollbars-contents] >
// children`, so a composite-role element that BECOMES the scroller gets a plain div between it
// and its required children and axe's `aria-required-children` fails.
//
// That is true of CONVERTING the tablist and false of WRAPPING it — the interposed div lands
// ABOVE the tablist, and `tablist → tab` stays a direct parent-child relation. Nothing in the
// source distinguishes the two, so both halves are measured here, on the real rendered shell:
//
//   1. GEOMETRY — the strip genuinely overflows (scroll extent > visible extent), the overlay
//      bar becomes visible on it, and the bar takes NO layout space (that is what an overlay
//      scrollbar buys, and it is why a 36px rail could afford one).
//   2. A11Y — axe over the rendered strip reports no violation, `aria-required-children`
//      included, and every tab is still a DIRECT child of its tablist.
//
// …and the third property, which is about naming rather than scrolling:
//
//   3. NO TAB PRINTS A RAW UUID, for any pane kind that happens to be open. A `jobs` pane
//      deep-linked by `revealPane('jobs', job.id)` used to read `Jobs · 3f2a1c8e-…`; it now
//      reads the job's NAME. Asserted as a CLASS over every rendered tab, not as one expected
//      string, because a hand-listed case lets the next kind regress silently.

/** A uuid ANYWHERE in a string — the shape a user must never read off a tab. */
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

interface StripGeometry {
  /** Does the track's viewport actually have more content than it can show? */
  overflows: boolean
  scrollExtent: number
  clientExtent: number
  /** Did scrolling move it? (proof the overflow is REACHABLE, not merely clipped.) */
  scrolledTo: number
  /** The bar's own box — it must overlay, i.e. take no room from the strip. */
  barOverlays: boolean
  /** The tablist's parent chain never makes the tablist itself the scroller. */
  tablistIsTheHost: boolean
  /** Every `role="tab"` under the tablist is a DIRECT child of it. */
  allTabsDirectChildren: boolean
  tabCount: number
}

/**
 * Measure one region's tab strip in the page. Reads real layout numbers off the real nodes —
 * never a class name: a strip could carry every expected utility class and still not scroll.
 */
async function measureStrip(page: Page, region: string, axis: 'x' | 'y'): Promise<StripGeometry> {
  return page.evaluate(
    ({ region, axis }) => {
      const track = document.querySelector(`[data-testid="region-tabs-scroll-${region}"]`)
      if (!track) throw new Error(`no tab-strip track for region ${region}`)
      const viewport = track.querySelector('[data-overlayscrollbars-viewport]') as HTMLElement | null
      if (!viewport) throw new Error(`the ${region} track is not an overlayscrollbars scroller`)
      const tablist = track.querySelector('[role="tablist"]') as HTMLElement | null
      if (!tablist) throw new Error(`no tablist inside the ${region} track`)

      const scrollExtent = axis === 'x' ? viewport.scrollWidth : viewport.scrollHeight
      const clientExtent = axis === 'x' ? viewport.clientWidth : viewport.clientHeight
      // Drive the scroll to prove the overflow is reachable rather than merely clipped.
      if (axis === 'x') viewport.scrollLeft = 9999
      else viewport.scrollTop = 9999
      const scrolledTo = axis === 'x' ? viewport.scrollLeft : viewport.scrollTop

      const bar = track.querySelector(
        axis === 'x' ? '.os-scrollbar-horizontal' : '.os-scrollbar-vertical',
      ) as HTMLElement | null
      const barStyle = bar ? getComputedStyle(bar) : null
      // An OVERLAY bar is positioned, so it claims none of the strip's own box.
      const barOverlays = !bar || barStyle!.position === 'absolute'

      const tabs = [...tablist.querySelectorAll('[role="tab"]')]
      return {
        overflows: scrollExtent > clientExtent,
        scrollExtent,
        clientExtent,
        scrolledTo,
        barOverlays,
        tablistIsTheHost: tablist.hasAttribute('data-overlayscrollbars-initialize'),
        allTabsDirectChildren: tabs.every(t => t.parentElement === tablist),
        tabCount: tabs.length,
      }
    },
    { region, axis },
  )
}

/**
 * Is the overlay bar for this axis VISIBLE right now?
 *
 * Separate from {@link measureStrip} and POLLED by the callers, because `autoHide="leave"` shows
 * the bar on pointer-enter through a 0.15s opacity transition and overlayscrollbars re-measures
 * asynchronously after a window resize. A single reading taken the instant after `hover()` can
 * legitimately land mid-transition; the property under test is "it becomes visible", not "it is
 * visible within one frame".
 */
async function barIsVisible(page: Page, region: string, axis: 'x' | 'y'): Promise<boolean> {
  return page.evaluate(
    ({ region, axis }) => {
      const track = document.querySelector(`[data-testid="region-tabs-scroll-${region}"]`)
      const bar = track?.querySelector(
        axis === 'x' ? '.os-scrollbar-horizontal' : '.os-scrollbar-vertical',
      ) as HTMLElement | null
      if (!bar) return false
      const st = getComputedStyle(bar)
      return st.visibility !== 'hidden' && Number(st.opacity) > 0
    },
    { region, axis },
  )
}

/** Put the pointer ON the strip, with a real movement — `autoHide="leave"` keys off pointer
 *  ENTER, and a `hover()` that lands where the pointer already sits moves nothing. */
async function hoverStrip(page: Page, region: string): Promise<void> {
  const track = page.getByTestId(`region-tabs-scroll-${region}`)
  const box = await track.boundingBox()
  expect(box, `the ${region} strip must have a layout box`).not.toBeNull()
  await page.mouse.move(0, 0)
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
}

/**
 * Add `kinds` to `region` through the region's OWN "+" menu — the affordance a user has, which is
 * also the only thing that places a pane in a region other than its kind's home (`AddPaneMenu`
 * adds, then `moveToRegion`s). Driving the store directly would place panes the shell never has
 * to place and would not exercise the strip growing under a real interaction.
 *
 * The menu only offers kinds that are NOT already open anywhere, so these are the ones the
 * default IA leaves closed (`defaultLayout`: visualize + datasets left, canvas centre, launcher
 * right). Asking it for an open kind is a harness bug, not a product one — hence the explicit
 * wait + failure message rather than a silent no-op.
 */
async function addPanesToRegion(page: Page, region: string, kinds: readonly string[]): Promise<void> {
  for (const kind of kinds) {
    await page.getByTestId(`region-add-pane-${region}`).click()
    const item = page.getByTestId(`region-add-pane-item-${kind}`)
    await item.waitFor({ state: 'visible', timeout: 10_000 })
    await item.click()
    await expect(page.getByTestId(`region-add-pane-menu-${region}`)).toHaveCount(0)
  }
}

/** Every rendered region tab's accessible name. */
async function tabLabels(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="region-tab-"][role="tab"]')].map(
      el => el.getAttribute('aria-label') ?? el.textContent ?? '',
    ),
  )
}

/**
 * THE ALLOW-LIST IS GONE.
 *
 * It held exactly one rule id: `nested-interactive`. A tab's close "X" was a real `<button>`
 * INSIDE the `role="tab"` element, in both strips, and had been since before the scroll-track
 * migration that first pointed axe at this rail — a genuine finding, about a tab OWNING a
 * control rather than about a scroll track, so it was allow-listed by that ONE id (never "any
 * violation") instead of being fixed in that lane.
 *
 * It is fixed now (`regions/RegionTab.tsx`): the X is an `aria-hidden` pointer affordance and
 * the close is reachable by `Delete` on the focused tab, so the tab is ONE node in the
 * accessibility tree again. The allowance therefore has to go with the defect — a ledger entry
 * kept past its cause is how a guard stops guarding.
 */
async function axeViolations(page: Page, selector: string): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .include(selector)
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze()
  return results.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`)
}

/** Every axe rule id the selector reports — used to PROVE the scan actually ran (a scan that
 *  found nothing at all would look identical to a clean tree once the allowance is applied). */
async function axeRuleIds(page: Page, selector: string): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .include(selector)
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze()
  return [...new Set([...results.violations.map(v => v.id), ...results.passes.map(p => p.id)])]
}

test.describe('region tab strips scroll on the kit track', () => {
  test('the CENTER strip overflows onto an overlay bar, and its tablist stays a tablist', async ({
    page,
    request,
  }) => {
    const bag = trackErrors(page)
    await loginAsOwner(page)
    const id = await createProject(request, `Tab strip ${Date.now()}`)
    await openWorkbench(page, id)

    // Open the extra panes at the DEFAULT window size, then narrow it. Both halves are the user's
    // own actions and the ORDER is load-bearing: in an already-narrow window the centre "+" sits
    // under the right region's resize divider, so the click is intercepted — the pane count is set
    // up first and the RESIZE is what creates the overflow, which is the state a user arrives in.
    await addPanesToRegion(page, 'center', ['reproducibility', 'jobs', 'artifacts'])
    // Below 768px `WorkbenchShell` swaps in `MobileShell` (no region tabs at all), so stay above
    // that. The side regions are `shrink-0` (~296px + ~336px), so the centre is what is left of
    // the window after them AND after the app's own nav — and a tab's floor is `min-w-24` (96px),
    // so four tabs plus the "+" need ~414px and cannot fit.
    await page.setViewportSize({ width: 1000, height: 720 })
    const track = page.getByTestId('region-tabs-scroll-center')
    await expect(track).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-testid="region-tabs-scroll-center"] [role="tab"]')).toHaveCount(4)

    // The overlay bar is `autoHide="leave"`: it shows while the pointer is on the strip. Move the
    // pointer onto it the way a user reaching for it would.
    await hoverStrip(page, 'center')
    // ORDER IS LOAD-BEARING: assert the bar on the HOVER ALONE, before `measureStrip` drives the
    // viewport. `autoHide="leave"` means "visible while the pointer is on the strip"; the kit
    // default (`scroll`) means "visible only DURING a scroll gesture", and a user who has not
    // scrolled yet would then get no indication that there is more strip to reach. Polling after
    // the programmatic scroll cannot tell the two apart — measured: the mutation survived.
    await expect
      .poll(() => barIsVisible(page, 'center', 'x'), { timeout: 10_000 })
      .toBe(true)

    const geo = await measureStrip(page, 'center', 'x')
    expect(geo.tabCount, 'the strip holds the tabs we opened').toBeGreaterThanOrEqual(4)
    expect(
      geo.overflows,
      `the strip must actually overflow to be worth a scrollbar (scroll ${geo.scrollExtent} vs client ${geo.clientExtent})`,
    ).toBe(true)
    expect(geo.scrolledTo, 'the overflow is REACHABLE — scrolling moved the viewport').toBeGreaterThan(0)
    expect(geo.barOverlays, 'an overlay bar takes no layout space from the strip').toBe(true)

    // …and the composite role survived the track.
    expect(geo.tablistIsTheHost, 'the tablist must WRAP in the track, never BE it').toBe(false)
    expect(geo.allTabsDirectChildren, 'every tab is a DIRECT child of its tablist').toBe(true)
    expect(
      await axeViolations(page, '[data-testid="region-tabs-scroll-center"]'),
      'the scrolled tab strip must be axe-clean — aria-required-children included',
    ).toEqual([])
    // NON-VACUITY: prove axe actually EVALUATED the two rules this strip is about rather than
    // skipping them (an "inapplicable" rule reports neither a pass nor a violation, and would
    // read identically to a clean tree).
    const centerRules = await axeRuleIds(page, '[data-testid="region-tabs-scroll-center"]')
    expect(centerRules, 'axe must have evaluated aria-required-children on this strip').toContain(
      'aria-required-children',
    )
    // `nested-interactive` used to be allow-listed here. It gates again, so it MUST be in the
    // evaluated set — otherwise removing the allowance bought nothing and nobody could tell.
    expect(centerRules, 'axe must have evaluated nested-interactive on this strip').toContain(
      'nested-interactive',
    )

    expect(bag.errors, `no console errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
  })

  test('the LEFT vertical rail does the same, with vertical tab text', async ({ page, request }) => {
    const bag = trackErrors(page)
    await loginAsOwner(page)
    const id = await createProject(request, `Rail strip ${Date.now()}`)
    await openWorkbench(page, id)

    // Several panes, then a SHORT window: the rail's tabs carry VERTICAL text, so each is tall and
    // a handful overflow a normal-height rail — the exact state the rail's own comment describes.
    // Panes first, for the same reason as the centre: a resized window moves the affordances.
    await addPanesToRegion(page, 'left', ['jobs', 'artifacts'])
    await page.setViewportSize({ width: 1100, height: 460 })
    const track = page.getByTestId('region-tabs-scroll-left')
    await expect(track).toBeVisible({ timeout: 20_000 })
    await hoverStrip(page, 'left')
    // Same order, same reason as the centre.
    await expect
      .poll(() => barIsVisible(page, 'left', 'y'), { timeout: 10_000 })
      .toBe(true)

    const geo = await measureStrip(page, 'left', 'y')
    expect(
      geo.overflows,
      `the rail must overflow (scroll ${geo.scrollExtent} vs client ${geo.clientExtent})`,
    ).toBe(true)
    expect(geo.scrolledTo, 'the rail scrolls').toBeGreaterThan(0)
    expect(geo.barOverlays, 'it overlays the 36px rail rather than narrowing it').toBe(true)
    expect(geo.tablistIsTheHost, 'the rail tablist must WRAP in the track, never BE it').toBe(false)
    expect(geo.allTabsDirectChildren, 'every rail tab is a DIRECT child of its tablist').toBe(true)

    // The rail is the surface 74d7ed9c named as the reason not to migrate. axe over the RENDERED
    // rail is what settles it.
    expect(
      await axeViolations(page, '[data-testid="region-tabs-scroll-left"]'),
      'the vertical rail must be axe-clean — aria-required-children included',
    ).toEqual([])
    const railRules = await axeRuleIds(page, '[data-testid="region-tabs-scroll-left"]')
    expect(railRules, 'axe must have evaluated aria-required-children on the rail').toContain(
      'aria-required-children',
    )
    expect(railRules, 'axe must have evaluated nested-interactive on the rail').toContain(
      'nested-interactive',
    )

    // The "add a pane" trigger stays OUTSIDE the scrolling list and reachable (the invariant the
    // rail's scroll exists to protect — see `railReachability.test.tsx`).
    const add: Locator = page.getByTestId('region-add-pane-left')
    await expect(add).toBeVisible()
    expect(
      await add.evaluate(el => !el.closest('[data-testid="region-tabs-scroll-left"]')),
      'the add trigger must not scroll away with the tabs',
    ).toBe(true)

    expect(bag.errors, `no console errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
  })
})

// A KEYBOARD USER CAN REACH EVERY TAB AND CLOSE ONE.
//
// This is the deliverable the axe score above is only a proxy for. The tab's close X left the
// focus tree (it had to — a `role="tab"` may not own a second interactive node), so the close
// has to be reachable another way or it is not a close at all, it is a mouse gesture. The
// replacement is `Delete` on the focused tab, and the only honest place to prove a KEY works is
// a real browser driving a real key: jsdom's `fireEvent.keyDown` synthesises the event React
// would have received, which says nothing about whether focus can get to the element in the
// first place.
test.describe('the tab strip is operable from the keyboard alone', () => {
  test('Tab reaches a region tab, and Delete closes that pane', async ({ page, request }) => {
    const bag = trackErrors(page)
    await loginAsOwner(page)
    const id = await createProject(request, `Tab keys ${Date.now()}`)
    await openWorkbench(page, id)

    // A pane the strip can afford to lose (the dock keeps ≥1 overall).
    await addPanesToRegion(page, 'center', ['jobs'])
    const tabs = page.locator('[data-testid="region-tabs-scroll-center"] [role="tab"]')
    await expect(tabs).toHaveCount(2)
    const target = tabs.last()
    const targetTestId = await target.getAttribute('data-testid')
    expect(targetTestId, 'the tab identifies its pane').toBeTruthy()

    // REACHED BY KEYBOARD, not by a click: walk the tab order from the strip's first tab until
    // focus lands on the target. A bounded walk, so a strip that cannot be reached fails here
    // rather than hanging.
    await tabs.first().focus()
    let reached = false
    for (let i = 0; i < 12 && !reached; i += 1) {
      reached = await page.evaluate(
        t => document.activeElement?.getAttribute('data-testid') === t,
        targetTestId,
      )
      if (!reached) await page.keyboard.press('Tab')
    }
    expect(reached, 'every tab must be reachable with the Tab key').toBe(true)

    // …and the accessible name the AT reads carries the shortcut that closes it, so it is
    // documented rather than folklore.
    await expect(target).toHaveAttribute('aria-keyshortcuts', 'Delete')

    await page.keyboard.press('Delete')
    await expect(page.getByTestId(targetTestId as string)).toHaveCount(0)
    await expect(tabs).toHaveCount(1)

    expect(bag.errors, `no console errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
  })

  test('the close X is a pointer affordance only — hidden from AT, out of the tab order', async ({
    page,
    request,
  }) => {
    // The other half: the X still WORKS for a mouse (nothing was taken away from the pointer
    // user), while being invisible to the accessibility tree — which is what makes the tab one
    // node and the `nested-interactive` allowance removable.
    await loginAsOwner(page)
    const id = await createProject(request, `Tab X ${Date.now()}`)
    await openWorkbench(page, id)
    await addPanesToRegion(page, 'center', ['jobs'])

    const tab = page.locator('[data-testid="region-tabs-scroll-center"] [role="tab"]').last()
    const paneId = ((await tab.getAttribute('data-testid')) ?? '').slice('region-tab-'.length)
    const close = page.getByTestId(`region-tab-close-${paneId}`)

    await expect(close).toHaveAttribute('aria-hidden', 'true')
    expect(
      await close.evaluate(el => el.hasAttribute('tabindex')),
      'an aria-hidden control must not be a focus stop that announces nothing',
    ).toBe(false)

    await tab.hover()
    await close.click()
    await expect(page.getByTestId(`region-tab-${paneId}`)).toHaveCount(0)
  })
})

test.describe('a pane tab names its subject, never its id', () => {
  test('a jobs tab reads the JOB NAME, and no tab anywhere shows a uuid', async ({ page, request }) => {
    await loginAsOwner(page)
    const token = await ownerToken(request)
    const id = await createProject(request, `Job title ${Date.now()}`)

    // A long project-scoped job so it is still around while we read its tab.
    const jobName = `Nightly filter ${Date.now()}`
    const created = await request.post(`${BACKEND}/api/jobs`, {
      headers: { authorization: `Bearer ${token}` },
      data: { job_type: 'stub', name: jobName, project_id: id, params: { steps: 40 } },
    })
    expect(created.ok(), `create scoped job -> ${created.status()}`).toBeTruthy()
    const jobId = (await created.json()).id as string
    expect(jobId, 'the job id is a uuid — the thing that used to be on the tab').toMatch(UUID_ANYWHERE)

    await openWorkbench(page, id)
    await page.waitForFunction(() => !!(window as { __workbenchPanes?: unknown }).__workbenchPanes, undefined, {
      timeout: 20_000,
    })
    // The deep-link the completion toast and the per-analysis run list both take.
    const paneId = await page.evaluate(
      jid =>
        (window as unknown as { __workbenchPanes: { open: (k: string, r?: string) => string } })
          .__workbenchPanes.open('jobs', jid),
      jobId,
    )
    const tab = page.getByTestId(`region-tab-${paneId}`)
    await tab.waitFor({ state: 'visible', timeout: 20_000 })

    // The name is FETCHED (the workbench status bar's project poll feeds it), so the tab starts
    // honest and becomes specific. Both states are acceptable; a uuid never is.
    await expect
      .poll(async () => tab.getAttribute('aria-label'), { timeout: 20_000 })
      .toBe(`Jobs · ${jobName}`)

    // THE CLASS ASSERTION — over every tab the shell is rendering, whatever kind it is.
    const labels = await tabLabels(page)
    expect(labels.length, 'there are tabs to check').toBeGreaterThan(0)
    expect(
      labels.filter(l => UUID_ANYWHERE.test(l)),
      'no pane tab may print a raw uuid at the user',
    ).toEqual([])

    // Non-vacuity: the detector is real, and the id it must never find IS present in the page's
    // own data (we opened the pane with it).
    expect(UUID_ANYWHERE.test(jobId)).toBe(true)

    // …AND THE SAME NAME REACHES THE TWO KINDS THAT USED TO SAY NOTHING.
    //
    // An `artifact` pane's `run::<id>` form reviews ONE RUN's whole output, and a compute run's
    // id IS its job's id (`job.run_id.unwrap_or(job.id)`, `jobs/scheduler.rs`) — a claim that is
    // only worth making if something checks it against a real backend, which is what this is.
    const artifactPane = await page.evaluate(
      jid =>
        (window as unknown as { __workbenchPanes: { open: (k: string, r?: string) => string } })
          .__workbenchPanes.open('artifact', `run::${jid}`),
      jobId,
    )
    const artifactTab = page.getByTestId(`region-tab-${artifactPane}`)
    await artifactTab.waitFor({ state: 'visible', timeout: 20_000 })
    await expect
      .poll(async () => artifactTab.getAttribute('aria-label'), { timeout: 20_000 })
      .toBe(`Artifact · ${jobName}`)

    // A `compare` pane's ref is a comma-joined run list: named once every run in the set is
    // named, and an exact COUNT until then — never a partial set wearing a complete set's label.
    const comparePane = await page.evaluate(
      jid =>
        (window as unknown as { __workbenchPanes: { open: (k: string, r?: string) => string } })
          .__workbenchPanes.open('compare', jid),
      jobId,
    )
    const compareTab = page.getByTestId(`region-tab-${comparePane}`)
    await compareTab.waitFor({ state: 'visible', timeout: 20_000 })
    await expect
      .poll(async () => compareTab.getAttribute('aria-label'), { timeout: 20_000 })
      .toBe(`Compare · ${jobName}`)

    // The class assertion again, now over the two kinds that just gained subjects.
    expect((await tabLabels(page)).filter(l => UUID_ANYWHERE.test(l))).toEqual([])
  })
})
