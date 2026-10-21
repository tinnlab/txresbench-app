import { test, expect, type Page } from '@playwright/test'
import { trackErrors } from './_helpers'

// STORY ISOLATION — the module-singleton viz stores must be untouched by every Showcase story.
//
// THE DEFECT THIS EXISTS FOR. The four viz coordination stores (+ the dataset store) exist both as
// per-instance sets (`createVizStores()`, what `<Viz>` mounts) and as MODULE SINGLETONS
// (`defaultVizStores`, what an unprovided subtree resolves to). A story that drives a
// `VizController` — or calls `useXStore.getState().mutate(...)` — without its own
// `<VizStoresProvider>` writes the SINGLETONS. That write is PROCESS-GLOBAL: it outlives the story
// switch and is inherited by every story mounted later in the SAME page load.
//
// Measured instance: `00-capabilities.story.tsx` is registered first, so the Showcase mounts it at
// LANDING on every page load; its `setOption({replace:true})` hydrated `gridLinked` (auto-derived
// TRUE for two scatter series over one layout) into the singleton, so the grid story then mounted
// ALREADY LINKED and `linked-panels` TEST-17's permissive "click it if it isn't on" seed silently
// did nothing — the spec failed for a reason that had nothing to do with the product.
//
// WHY IT NEEDS ITS OWN SPEC, AND WHY IT IS A WALK. The failure is INVISIBLE in a single-story run:
// open the victim story alone and it behaves, because there is no earlier story to inherit from. It
// only appears in a full-suite page load, where story N inherits stories 1..N-1. So no per-story
// assertion — in this file or in the victim's own spec — can catch it. The assertion has to be over
// the SEQUENCE: mount every registered story in registration order in ONE page load and watch the
// singletons. This spec is that walk.
//
// It also enumerates the stories from the LIVE sidebar rather than a hand-written list, so a story
// added tomorrow is covered by this gate the day it lands.

/** Keys where the module singletons differ from a never-touched `createVizStores()` set. */
type ResidueDiff = { key: string; pristine: unknown; actual: unknown }[]

/** The probe `@ziee/viz`'s Showcase entry installs (`showcase/singletonResidue.ts`). Re-declared
 *  here because the ui test project does not compile the viz package's own global augmentation. */
type ResidueWindow = Window & { __VIZ_SINGLETON_RESIDUE__?: () => ResidueDiff }

/**
 * Read the probe, retrying once on "Execution context was destroyed". Navigating by hash fires a
 * frame-navigation event even though the JS context survives, and an `evaluate` that overlaps it is
 * rejected by Playwright — a harness race, not a product signal, and one that would otherwise abort
 * the walk mid-way and take the whole gate with it.
 */
async function readResidue(page: Page): Promise<ResidueDiff | 'PROBE MISSING'> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await page.evaluate(
        () => (window as ResidueWindow).__VIZ_SINGLETON_RESIDUE__?.() ?? ('PROBE MISSING' as const),
      )
    } catch (e) {
      if (attempt >= 2 || !/Execution context was destroyed|Target closed/.test(String(e))) throw e
      await page.waitForTimeout(300)
    }
  }
}

const fmt = (d: ResidueDiff | 'PROBE MISSING'): string =>
  d === 'PROBE MISSING'
    ? d
    : d.length === 0
      ? 'clean'
      : d.map(x => `${x.key}: ${JSON.stringify(x.pristine)} → ${JSON.stringify(x.actual)}`).join(', ')

/**
 * Navigate by URL HASH, not by clicking the sidebar. `ShowcaseApp` drives `activeId` off
 * `hashchange`, and at least one story renders a viewport-filling `#deckgl-overlay` that intercepts
 * pointer events over the sidebar — a real defect, but one that must not be able to silently
 * shorten this walk.
 */
async function gotoStory(page: Page, id: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      await page.evaluate(i => {
        window.location.hash = `#${encodeURIComponent(i)}`
      }, id)
      return
    } catch (e) {
      if (attempt >= 2 || !/Execution context was destroyed|Target closed/.test(String(e))) throw e
      await page.waitForTimeout(300)
    }
  }
}

/**
 * Read residue until it STOPS moving (two equal reads) or `maxMs` elapses. A fixed sleep would make
 * this gate weaker the slower a story is: a story whose `setOption` resolves after the sleep would
 * be reported clean. Settling on the value instead means a fast story costs one tick and a slow one
 * is still observed after it has written.
 */
async function settledResidue(page: Page, maxMs = 2_500): Promise<ResidueDiff | 'PROBE MISSING'> {
  let prev = fmt(await readResidue(page))
  const deadline = Date.now() + maxMs
  for (;;) {
    await page.waitForTimeout(250)
    const now = await readResidue(page)
    const s = fmt(now)
    if (s === prev || Date.now() > deadline) return now
    prev = s
  }
}

test('the landing story leaves the module-singleton viz stores pristine', async ({ page }) => {
  // The cheap pin for the measured instance: the FIRST-registered story mounts before `openStory`
  // clicks anything, so if it writes the singletons every spec in the suite starts contaminated.
  const bag = trackErrors(page)
  await page.goto('/viz-showcase.html', { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="showcase-sidebar"]', { timeout: 20_000 })
  const residue = await settledResidue(page)
  expect(residue, 'the residue probe is installed (see showcase/singletonResidue.ts)').not.toBe(
    'PROBE MISSING',
  )
  expect(
    fmt(residue),
    'the landing story must not write the process-global viz stores — it is mounted before every spec',
  ).toBe('clean')
  expect(bag.errors, `no console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})

test('no story contaminates the module-singleton viz stores for the stories after it', async ({
  page,
}) => {
  // 90+ stories mounted back-to-back under headless swiftshader, each settling on its own residue.
  // The budget is deliberately generous: this box is shared, and a walk that times out under load
  // would turn a real invariant into a flake nobody trusts.
  test.setTimeout(1_800_000)
  await page.goto('/viz-showcase.html', { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="showcase-sidebar"]', { timeout: 20_000 })

  const ids = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="showcase-story-"]')).map(b =>
      (b.getAttribute('data-testid') ?? '').replace('showcase-story-', ''),
    ),
  )
  expect(ids.length, 'the sidebar lists the registered stories').toBeGreaterThan(10)

  const landing = await settledResidue(page)
  expect(landing, 'the residue probe is installed').not.toBe('PROBE MISSING')

  // ATTRIBUTED, not cumulative. Residue is sticky, so once one story dirties it every later story
  // reads dirty too; reporting the DELTA across each transition names the story that wrote and
  // keeps the report from cascading into noise.
  let prev = fmt(landing)
  const offenders: { from: string; to: string; residue: string }[] = []
  const unreadable: string[] = []
  let from = `(landing) ${ids[0]}`
  for (const id of ids) {
    try {
      await gotoStory(page, id)
      const now = fmt(await settledResidue(page))
      if (now !== prev) offenders.push({ from, to: id, residue: now })
      prev = now
    } catch (e) {
      // A story that takes the page down with it is its own finding — record it, then RELOAD and
      // re-baseline so one casualty cannot blind the remaining stories (a walk that aborts at
      // story 40 silently certifies stories 41..96 as clean).
      unreadable.push(`${id}: ${String(e).split('\n')[0].slice(0, 140)}`)
      await page.goto('/viz-showcase.html', { waitUntil: 'networkidle' })
      await page.waitForSelector('[data-testid="showcase-sidebar"]', { timeout: 20_000 })
      prev = fmt(await settledResidue(page))
    }
    from = id
  }

  // And nothing may be left behind once the walk is over.
  const final = fmt(await settledResidue(page))

  expect(
    offenders,
    `these transitions changed the PROCESS-GLOBAL viz stores — the story mounted at each one drives a\n` +
      `VizController / a singleton store without its own <VizStoresProvider>, so everything after it\n` +
      `inherits the write (fix: createVizStores() + <VizStoresProvider>, see 00-capabilities.story.tsx):\n` +
      offenders.map(o => `  ${o.from} → ${o.to}\n      ${o.residue}`).join('\n'),
  ).toEqual([])
  expect(
    unreadable,
    `these stories could not be measured — the page went away while they were mounted:\n  ` +
      unreadable.join('\n  '),
  ).toEqual([])
  expect(final, 'the walk leaves the module-singleton viz stores pristine').toBe('clean')
})
