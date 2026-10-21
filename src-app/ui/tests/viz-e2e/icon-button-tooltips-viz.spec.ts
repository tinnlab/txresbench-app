import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SCAN,
  SCAN_TARGETS,
  diffLedger,
  sweptEnough,
  tooltipAgrees,
  type IconButton,
  type Scan,
} from '../_iconButtonScan'

/**
 * icon-button-tooltips (VIZ) — the same claim as `gallery-e2e/icon-button-tooltips.spec.ts`, over
 * the surfaces that guard cannot reach.
 *
 * ── WHY A SECOND SWEEP, AND NOT A WIDER FIRST ONE ─────────────────────────────────────────────
 * That guard walks 94 GALLERY surfaces and comes back clean. Not one of them mounts a `@ziee/viz`
 * component — `modules/visualization/gallery.tsx` is registered `{ crawlOnly: true }`, and the
 * workbench surfaces that do appear mount shell chrome, not the plotting package. So the whole of
 * `libs/viz` — pane chrome, tool rails, the legend, the timeline transport, the tree panel —
 * was outside the guard entirely, and its green verdict said exactly nothing about any of it. A
 * guard whose silence is indistinguishable between "clean" and "never looked" is the failure mode
 * this repo keeps paying for, so the fix is to LOOK, from the runner that can render these
 * components: the showcase, which is what the viz tier already boots.
 *
 * Making the gallery sweep render viz instead would mean un-`crawlOnly`-ing that module and
 * mounting deck.gl/WebGL2 surfaces in the gallery config, which runs without a GL context — the
 * grid would render its no-GL fallback and contribute a handful of controls rather than the real
 * chrome. The viz config already launches software WebGL for exactly this reason. Two sweeps, ONE
 * detector (`tests/_iconButtonScan.ts`), so a widening on either side lands on both.
 *
 * ── WHAT IT ASSERTS ───────────────────────────────────────────────────────────────────────────
 * Identical in shape to its sibling: a shrink-only ledger keyed by the CONTROL, a floor that makes
 * a clean sweep mean something, and a behavioural pass that opens the tooltips which CLAIM to
 * exist and checks they say what the control is called.
 *
 * The baseline has TWO shrink-only sections, because the first run found two different states.
 * BOTH ARE NOW EMPTY, and the second one is the more interesting of the two:
 *   · `entries`    — icon-only, and NOTHING explains it on hover. Empty because every one the
 *                    first run found was fixable in this repo and was fixed.
 *   · `neverOpens` — it CLAIMS a tooltip (the marker is in the DOM, the source reads fine) and
 *                    hovering opens nothing. This is the state a marker-only sweep cannot see at
 *                    all, which is exactly why the behavioural half exists. It held ten rows, all
 *                    of them `sdk/packages/kit` composing a tooltip onto an element that was
 *                    ALREADY a Popover/Dropdown trigger — a submodule this repo consumes and does
 *                    not edit, so they were ledgered rather than asserted. The kit then fixed it
 *                    (`iconOnly` became renders-no-words, and a Tooltip composes transparently
 *                    onto an existing trigger), all ten opened, and the STALE half of the ledger
 *                    turned red until they were deleted — which is the mechanism working: a
 *                    ledger that cannot go stale is an allowance nobody ever revisits.
 *
 * An EMPTY shrink-only section is not a weaker assertion than a hard one — a new offender fails
 * on the `added` half exactly as it would on an assertion — but it keeps the two verdicts (the
 * marker sweep's and the behavioural pass's) separately readable.
 *
 * Regenerate ONLY after a genuine fix:
 *   ICON_BUTTON_TOOLTIPS_WRITE=1 npx playwright test -c playwright.viz.config.ts \
 *     tests/viz-e2e/icon-button-tooltips-viz.spec.ts
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BASELINE = path.join(__dirname, 'icon-button-tooltips-viz-baseline.json')

/**
 * The floor that makes a clean sweep mean something. Measured on this tree: the showcase's stories
 * render well over a hundred visible icon-only controls between them. If a refactor (or a mistimed
 * wait) makes the sweep read empty pages, this fails instead of reporting a flawless run. Its
 * premise — that the sweep CAN come back empty — is pinned by the `a story that does not exist is a
 * floor failure` test, so lowering this constant is not a free green.
 */
const MIN_ICON_BUTTONS_SEEN = 60

/**
 * How long ONE story gets to mount before the sweep moves on.
 *
 * The showcase deliberately holds scale/perf stories that mount millions of points; under software
 * WebGL a handful of them take minutes EACH, and a sweep that waits for every one ran past a
 * 25-minute budget twice without reaching its assertion — a guard that can only ever time out is
 * worse than no guard. What this file is about is CHROME (buttons), which mounts with the story
 * component and not with its canvas, so a bounded wait costs coverage only on the stories whose
 * chrome is genuinely slow to appear. Those are COUNTED as `unswept` and the run fails if they are
 * more than a small minority — the honest form of "we did not look at everything".
 */
const STORY_BUDGET_MS = 15_000

/** At most this fraction of the showcase may go unswept before the run is a broken fixture. */
const MAX_UNSWEPT_FRACTION = 0.2

async function scan(page: Page): Promise<Scan> {
  return (await page.evaluate(SCAN)) as Scan
}

/**
 * Every story the showcase registers, DISCOVERED off its own sidebar rather than listed here.
 * A hand-kept list is a list that goes stale silently, and — the harder constraint — the ids name
 * what each story plots, which is vocabulary this file is not permitted to carry (the domain
 * ratchet scans `tests/**` and a new file's budget is zero). Reading them at runtime spells none.
 */
async function allStories(page: Page): Promise<string[]> {
  await page.goto('/viz-showcase.html', { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="showcase-sidebar"]', { timeout: 30_000 })
  const ids = await page.$$eval('[data-testid^="showcase-story-"]', els =>
    els.map(e => (e.getAttribute('data-testid') as string).slice('showcase-story-'.length)),
  )
  return [...new Set(ids)].filter(Boolean)
}

/** Load the showcase shell once; a story switch is a CLICK, not a navigation (see `openStorySlug`). */
async function ensureShowcase(page: Page): Promise<void> {
  if (page.url().includes('viz-showcase.html')) return
  await page.goto('/viz-showcase.html', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="showcase-sidebar"]', { timeout: 30_000 }).catch(() => null)
}

/**
 * Open a story and let it finish arriving — several mount a real GL surface and settle late.
 *
 * A CLICK on the sidebar rather than a `goto` per story, which its gallery sibling can afford and
 * this one cannot: measured, a full reload for each of ~90 stories under software WebGL ran past a
 * 25-minute budget without finishing the sweep, so the guard could not have been green or red — it
 * could only time out. The showcase mounts exactly one story at a time and unmounts the previous
 * one, so what a scan sees is still this story's DOM; the risk that remains (a story leaking DOM
 * across a switch) can only ADD a finding, never hide one, so it cannot make a broken tree read
 * clean — and `story-isolation.spec.ts` already drives that residue question directly.
 */
async function openStorySlug(page: Page, id: string): Promise<boolean> {
  await ensureShowcase(page)
  const entry = page.locator(`[data-testid="showcase-story-${id}"]`)
  if ((await entry.count()) === 0) return true
  try {
    // `dispatchEvent`, NOT `click`. Playwright's click waits for ACTIONABILITY, and on this
    // surface the thing blocking it is usually the PREVIOUS story's canvas still rasterising —
    // so the wait is spent on a story we have already swept. Measured: 65 of 96 stories timed out
    // that way, i.e. the guard lost two thirds of its coverage to a wait about the wrong page.
    // The sidebar entry is an ordinary always-mounted list item; dispatching its click is exactly
    // what the user gesture does to it, without the idle-page precondition.
    await entry.first().dispatchEvent('click', { timeout: STORY_BUDGET_MS })
    await page.waitForTimeout(400)
    // Settle on the control COUNT, exactly as the gallery sweep does: a surface read before its
    // chrome mounts contributes zero controls and reads as clean.
    let last = -1
    for (let i = 0; i < 8; i++) {
      const n = await page.evaluate(() => document.querySelectorAll('button, [role="button"]').length)
      if (n === last && i >= 1) return true
      last = n
      await page.waitForTimeout(150)
    }
    return true
  } catch {
    return false
  }
}

async function sweep(page: Page, stories: string[]) {
  const observed: Record<string, number> = {}
  const detail: Record<string, (IconButton & { surface: string })[]> = {}
  const unswept: string[] = []
  let seen = 0
  for (const id of stories) {
    if (!(await openStorySlug(page, id))) {
      // COUNTED, never silently dropped: a run that could not open most of the showcase is a
      // broken fixture, and the coverage assertion below is what says so.
      unswept.push(id)
      continue
    }
    const s = await scan(page)
    seen += s.total
    for (const b of s.noTooltip) {
      // KEYED BY THE CONTROL, not by `<story>|<control>` — one defect is one row, and the story
      // ids are vocabulary this file may not carry (see `allStories`). WHERE it was seen lives in
      // the failure detail, which is written at the moment of failure and committed to nothing.
      observed[b.id] = (observed[b.id] ?? 0) + 1
      ;(detail[b.id] ??= []).push({ ...b, surface: id })
    }
  }
  return { observed, detail, seen, unswept }
}

test.describe('every icon-only control in the plotting package explains itself', () => {
  /**
   * The FIXTURE that makes `MIN_ICON_BUTTONS_SEEN` a live assertion rather than a comment: it
   * proves the sweep really can come back short, which is the state the floor exists to reject.
   * Without this, lowering the floor to 0 would cost nothing.
   *
   * It differs from its gallery sibling in one measured way, and the difference is the finding: a
   * gallery URL naming no surface renders NOTHING, but a showcase URL always renders its own shell
   * (sidebar, theme toggle) whichever story is selected. So an unknown story id does NOT produce a
   * zero here — it produces the shell — and asserting `=== 0` on it would have been a fixture that
   * cannot hold. Both halves are asserted: the accumulator really can be zero (an empty story
   * list), and an unknown story contributes only chrome, which is far under the floor.
   */
  test('a sweep that visits nothing, and one that visits only chrome, are both floor failures', async ({
    page,
  }) => {
    const empty = await sweep(page, [])
    expect(empty.seen, 'sweeping no story at all cannot contribute controls').toBe(0)
    expect(
      empty.seen >= MIN_ICON_BUTTONS_SEEN,
      'the floor must REJECT an empty sweep — if this passes, the floor is decoration',
    ).toBe(false)

    const chromeOnly = await sweep(page, ['__no_such_story__'])
    expect(
      chromeOnly.seen >= MIN_ICON_BUTTONS_SEEN,
      "the showcase shell alone must not clear the floor, or a sweep that never opened a story " +
        'would report a flawless run',
    ).toBe(false)
  })

  test('no showcase story renders an icon-only control that explains itself to nobody', async ({
    page,
  }) => {
    test.setTimeout(45 * 60_000)

    const stories = await allStories(page)
    expect(
      stories.length,
      'the story enumeration collapsed — a sweep over nothing is not a pass',
    ).toBeGreaterThan(20)

    const { observed, detail, seen, unswept } = await sweep(page, stories)
    const totalBad = Object.values(observed).reduce((a, b) => a + b, 0)
    console.log(
      `icon-button-tooltips(viz): ${stories.length} story surface(s), ${seen} visible icon-only ` +
        `control(s), ${totalBad} with no hover text, ${unswept.length} unswept` +
        (unswept.length ? ` [${unswept.join(', ')}]` : ''),
    )
    expect(
      unswept.length,
      `${unswept.length} of ${stories.length} stories did not mount inside their budget ` +
        `[${unswept.join(', ')}] — a sweep that skipped most of the showcase is a broken fixture, ` +
        'not a clean package',
    ).toBeLessThanOrEqual(Math.floor(stories.length * MAX_UNSWEPT_FRACTION))
    expect(
      seen,
      `the sweep inspected only ${seen} icon-only control(s) (< ${MIN_ICON_BUTTONS_SEEN}) — a query ` +
        'that matches nothing reports a flawless run forever',
    ).toBeGreaterThanOrEqual(MIN_ICON_BUTTONS_SEEN)

    if (process.env.ICON_BUTTON_TOOLTIPS_WRITE) {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(
        BASELINE,
        `${JSON.stringify(
          {
            $comment:
              'Visible icon-only controls in the plotting package rendered with NOTHING that ' +
              'explains them on hover, keyed by the CONTROL and counted across every showcase ' +
              'story it renders on. SHRINK-ONLY: a new one fails, a stale entry fails. Regenerate ' +
              'with ICON_BUTTON_TOOLTIPS_WRITE=1 after a genuine fix — never to make a red run green.',
            surfaces: stories.length,
            total: totalBad,
            entries: Object.fromEntries(Object.entries(observed).sort(([a], [b]) => a.localeCompare(b))),
          },
          null,
          2,
        )}\n`,
      )
      return
    }

    let committed: Record<string, number> = {}
    try {
      committed = JSON.parse(readFileSync(BASELINE, 'utf8')).entries ?? {}
    } catch {
      committed = {}
    }

    const { added: addedKeys, stale } = diffLedger(observed, committed)
    const added = addedKeys.map(line => {
      const key = line.split(/\s{2,}/)[1] ?? ''
      const s = detail[key] ?? []
      return `${line}  on [${[...new Set(s.map(d => d.surface))].join(', ')}]  ${JSON.stringify(s.slice(0, 2))}`
    })

    expect(
      [...added, ...stale].sort().join('\n'),
      'An icon with no words and no hover text is unexplained to every sighted user who does not ' +
        'already recognise the glyph — an aria-label reaches assistive tech only. This package is ' +
        'mostly plain DOM, so the fix is usually a native `title` carrying the SAME string as the ' +
        'aria-label. After a genuine fix, re-derive the ledger with ICON_BUTTON_TOOLTIPS_WRITE=1.',
    ).toBe('')
  })

  /**
   * The BEHAVIOURAL half, on the story that renders the most chrome. The sweep above reads a
   * marker; this opens the real tooltip and reads what a user reads — the only way to catch a
   * tooltip that never opens, and one that DISAGREES with the accessible name.
   */
  test("every claimed tooltip on the grid surface opens and agrees with its control's name", async ({
    page,
  }) => {
    test.setTimeout(8 * 60_000)
    const stories = await allStories(page)
    // A busy surface, chosen by MEASUREMENT rather than by naming one — naming a story id would
    // spell vocabulary this file may not carry. Walk until a story offers a real crop of claimants
    // and take it; scanning ALL of them to find the single busiest costs a second full sweep for a
    // strictly-worse question (the point is to open tooltips, not to rank stories).
    const ENOUGH = 8
    let best = { id: '', n: 0 }
    for (const id of stories) {
      await openStorySlug(page, id)
      const n = (await page.evaluate(SCAN_TARGETS)).length
      if (n > best.n) best = { id, n }
      if (best.n >= ENOUGH) break
    }
    expect(best.n, 'no showcase story claims a single tooltip — the detector found nothing to open').toBeGreaterThan(3)

    await openStorySlug(page, best.id)
    const targets = await page.evaluate(SCAN_TARGETS)

    const problems: string[] = []
    /** Claimants whose tooltip did not open — ledgered, see the `neverOpens` note below. */
    const silent: Record<string, number> = {}
    const unreachable: string[] = []
    let checked = 0
    for (const t of targets) {
      const el = page.locator(`[data-testid="${t.testid}"]`).first()
      if ((await el.count()) === 0) continue
      await el.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => null)
      // A pointer cannot open a tooltip on a control it cannot land on. Recorded and counted
      // rather than silently skipped, so "all of them were unreachable" can never read clean.
      const hittable = await el.evaluate(e => {
        const r = e.getBoundingClientRect()
        const top = e.ownerDocument.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return top != null && (top === e || e.contains(top))
      })
      if (!hittable) {
        unreachable.push(t.testid)
        continue
      }
      checked += 1
      await el.hover({ force: true }).catch(() => null)
      const content = page.locator('[data-slot="tooltip-content"]')
      let shown = ''
      try {
        await expect(content).toHaveCount(1, { timeout: 5_000 })
        shown = ((await content.first().textContent()) ?? '').replace(/\s+/g, ' ').trim()
      } catch {
        // LEDGERED, not asserted — see `neverOpens` in the baseline. A claimant whose tooltip does
        // not open is a real defect, but when this was written every instance on the tree was ONE
        // upstream KIT defect this repo consumes and cannot edit, so a hard assertion would have
        // been a permanent red over someone else's code. Counted instead, shrink-only, so a NEW
        // one still fails and the rows had to be deleted the moment the kit fix landed (the STALE
        // half) — which is what happened: the ledger is empty now.
        silent[t.testid] = (silent[t.testid] ?? 0) + 1
        continue
      }
      if (!tooltipAgrees(shown, t.name, t.desc)) {
        problems.push(
          `${t.testid}: tooltip says "${shown}" but the accessible name is "${t.name}"` +
            (t.desc ? ` and the description is "${t.desc}"` : ' and it has no description'),
        )
      }
      await page.mouse.move(2, 2)
      await expect(content).toHaveCount(0, { timeout: 5_000 }).catch(() => null)
    }

    console.log(
      `icon-button-tooltips(viz/${best.id}): ${checked} hovered, ${unreachable.length} not hit-testable` +
        (unreachable.length ? ` [${unreachable.join(', ')}]` : ''),
    )
    expect(
      sweptEnough(checked, unreachable.length),
      `only ${checked} of ${checked + unreachable.length} tooltip claimant(s) could be hovered — a ` +
        'run that skipped almost everything is a broken fixture, not a pass',
    ).toBe(true)
    // A tooltip that DISAGREES with the name is always a hard failure: it is this repo's own
    // string, and it tells a pointer user and a screen-reader user two different things.
    expect(
      problems.join('\n'),
      'A tooltip that disagrees with the accessible name tells two users two different things ' +
        'about the same control.',
    ).toBe('')

    // …and the SILENT claimants ratchet.
    let committedSilent: Record<string, number> = {}
    try {
      committedSilent = JSON.parse(readFileSync(BASELINE, 'utf8')).neverOpens ?? {}
    } catch {
      committedSilent = {}
    }
    if (process.env.ICON_BUTTON_TOOLTIPS_WRITE) {
      console.log(`neverOpens observed: ${JSON.stringify(silent, null, 2)}`)
      return
    }
    const silentDiff = diffLedger(silent, committedSilent)
    expect(
      [...silentDiff.added, ...silentDiff.stale].sort().join('\n'),
      'A control that CLAIMS a tooltip and never opens one is worse than one that claims nothing: ' +
        'both markers and source read fine while the user gets nothing. Every row in `neverOpens` ' +
        'is a control this repo cannot fix — it is composed onto something that is ALREADY a ' +
        'trigger (a Popover/Dropdown), which `sdk/packages/kit` renders as a trigger that never ' +
        'opens. When the kit fixes that, these rows go STALE and must be deleted.',
    ).toBe('')
  })
})
