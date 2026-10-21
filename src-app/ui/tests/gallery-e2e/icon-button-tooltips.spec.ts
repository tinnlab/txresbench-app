import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// THE DETECTOR + THE PURE HALVES ARE SHARED (`tests/_iconButtonScan.ts`) with the viz sweep, so
// both surface families are judged by byte-identical logic. See that file's header for the two
// widenings a second surface forced (a glyph is an icon; an ancestor `title` is hover text).
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
 * icon-button-tooltips — an icon with no words must SAY what it does, to everyone.
 *
 * ── THE TWO AFFORDANCES, AND WHY BOTH ─────────────────────────────────────────
 * A button whose whole content is a glyph is unexplained to a sighted user who does
 * not recognise the glyph. `aria-label` does not help that user at all — it is read
 * by assistive tech and rendered by nothing. A tooltip does not help a screen-reader
 * user either — it exists in the tree only while it is open. They are DIFFERENT
 * affordances for DIFFERENT people, so an icon-only control needs BOTH:
 *
 *   1. an accessible NAME  (aria-label / aria-labelledby / title / sr-only text)
 *   2. a TOOLTIP           (the kit's, or a native `title`)
 *
 * ── AND THEY MUST AGREE ───────────────────────────────────────────────────────
 * A tooltip saying one thing while the accessible name says another is worse than
 * either alone: two users of the same product are told different things about the
 * same button, and neither can tell. So the third test asserts the text a sighted
 * user actually reads is either the control's NAME or its DESCRIPTION
 * (`aria-describedby`) — never a third string. The description arm is deliberate,
 * not a loophole: it is how this repo already carries "why this is unavailable" on a
 * blocked control while the NAME stays the action (`viz` PaneToolbar `blockedAction`,
 * commit 93167985 — "a pane that cannot be closed says so").
 *
 * ── WHY THE RENDERED DOM AND NOT THE SOURCE ───────────────────────────────────
 * A source scan cannot see what a component renders, and this repo has twice paid
 * for a guard that read source text (the activity rail's static analyser, 20 audit
 * rounds and never converged; `gate-ui`'s port guard). Worse, here the source LIES
 * in a specific, load-bearing way: `sdk/packages/kit/src/kit/button.tsx` computes
 * `iconOnly = icon != null && children == null`, so
 *
 *     <Button size="icon" aria-label="Close"><X /></Button>
 *
 * type-checks, satisfies the kit's own "icon-only Button needs tooltip (or
 * aria-label)" manifest rule, and renders NO TOOLTIP AT ALL — the aria-label→tooltip
 * promotion only fires for the `icon={...}` prop form. A source scan sees a compliant
 * call site; the DOM sees a mute button. Hence: assert on what is in the document.
 *
 * ── HOW "has a tooltip" IS READ OFF THE DOM ───────────────────────────────────
 * Base UI stamps `data-base-ui-tooltip-trigger` on the element a tooltip is attached
 * to (see `@base-ui/react/tooltip/trigger/TooltipTrigger.js`, `TOOLTIP_TRIGGER_IDENTIFIER`),
 * `data-trigger-disabled` when that trigger is switched off, and the kit's own
 * `<Tooltip>` wrapper additionally stamps `data-tooltip-wrapped`. A native `title`
 * counts too — it is a real, if weak, tooltip. Any of those, on the control or on an
 * ancestor (the repo wraps a disabled control in a focusable `<span>` so the tooltip
 * still opens — `SettingsFormActions`), means "explained on hover".
 *
 * ── SHRINK-ONLY, like `native-controls.spec.ts` ───────────────────────────────
 * Known offenders live in `icon-button-tooltips-baseline.json` keyed by the CONTROL,
 * counted across every surface it renders on.
 * A NEW bare icon button fails. A STALE entry fails too, so the ledger cannot rot
 * into decoration. Regenerate ONLY after a genuine fix:
 *   ICON_BUTTON_TOOLTIPS_WRITE=1 npx playwright test -c playwright.gallery.config.ts \
 *     tests/gallery-e2e/icon-button-tooltips.spec.ts
 *
 * WHAT IS IN THE LEDGER TODAY, and why it is not simply fixed: 4 rows / 13 sightings, every
 * one of them is drawn by the KIT itself, which is a submodule this repo consumes and
 * does not edit —
 *   · `Close` × 9             the Dialog's built-in close (`shadcn/dialog.tsx`), an
 *                             `<XIcon/>` plus `<span class="sr-only">Close</span>`;
 *   · `auth-link-account-error-close`    the Alert's dismiss (`kit/alert.tsx`);
 *   · `Show password`         the PasswordInput's reveal toggle;
 *   · `…-tag-s2-close` × 2    the Tag's remove (`kit/tag.tsx`).
 * All four are named (the sr-only text is a perfectly good accessible name) and none
 * of them draws hover text. Fixing them means one `tooltip` on each in
 * `sdk/packages/kit`, after which these rows must be deleted or the STALE half of the
 * ledger fails — which is the point of having that half.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BASELINE = path.join(__dirname, 'icon-button-tooltips-baseline.json')

async function scan(page: Page): Promise<Scan> {
  return (await page.evaluate(SCAN)) as Scan
}

async function allSurfaces(page: Page): Promise<string[]> {
  await page.goto('/gallery.html')
  await page.waitForFunction(
    () => typeof (window as never as Record<string, unknown>).__GALLERY_LIST_ALL_SURFACES__ === 'function',
    null,
    { timeout: 60_000 },
  )
  await expect
    .poll(
      async () => page.evaluate(() => document.querySelectorAll('[data-testid^="gallery-page-"]').length),
      { timeout: 60_000, message: 'the gallery browse canvas never listed a page surface' },
    )
    .toBeGreaterThan(0)
  const classes = await page.evaluate(() =>
    (
      window as never as {
        __GALLERY_LIST_ALL_SURFACES__: () => { pages: string[]; overlays: string[]; deep: string[]; seeded: string[] }
      }
    ).__GALLERY_LIST_ALL_SURFACES__(),
  )
  return [...new Set([...classes.pages, ...classes.overlays, ...classes.deep, ...classes.seeded])]
}

/** Open a surface and let it finish arriving. Seeded/deep surfaces run their seed recipe
 *  at 1200ms and overlays at 700ms, so a surface read too early contributes ZERO controls
 *  and would silently read as clean — the same false-clean this file's floor guards. */
async function openSurface(page: Page, slug: string): Promise<void> {
  await page.goto(`/gallery.html?surface=${slug}`)
  await page.waitForSelector(`[data-testid="gallery-page-${slug}"]`, { timeout: 15_000 }).catch(() => null)
  await page.waitForTimeout(1_500)
  let last = -1
  for (let i = 0; i < 24; i++) {
    const n = await page.evaluate(() => document.querySelectorAll('button, [role="button"]').length)
    if (n === last && i >= 2) return
    last = n
    await page.waitForTimeout(250)
  }
}

/**
 * The surfaces the BEHAVIOURAL half drives. A hand-list, because hovering every one of
 * the ~94 swept surfaces is a runtime cost this guard deliberately does not pay — but a
 * hand-list that shrinks silently is the failure mode this whole file exists to stop, so
 * it is floored and validated below.
 */
export const BEHAVIOURAL_SLUGS = [
  'workbench-empty',
  'workbench-pane-inset',
  'workbench-lineage',
  'settings-general',
  'datasets',
] as const

/**
 * The committed floor (the ITEM-37 idiom, cf. `MIN_NODE_TEST_FILES` /
 * `MIN_GATED_PACKAGES`). Dropping a slug removes a whole `test()` from the run, and a
 * run with fewer tests looks exactly like a run with fewer tests — all green. Lowering
 * this is then an explicit, reviewable edit rather than a deletion nobody sees.
 */
const MIN_BEHAVIOURAL_SLUGS = 5

async function sweep(page: Page, surfaces: string[]) {
  const observed: Record<string, number> = {}
  const detail: Record<string, (IconButton & { surface: string })[]> = {}
  let seen = 0
  for (const slug of surfaces) {
    await openSurface(page, slug)
    const s = await scan(page)
    seen += s.total
    for (const b of s.noTooltip) {
      // KEYED BY THE CONTROL, NOT BY `<surface>|<control>`, for two reasons. One kit defect is
      // ONE row rather than nine near-identical ones (the Dialog close renders on nine surfaces
      // and is a single missing `tooltip` in `sdk`). And a ledger keyed by surface names the
      // gallery's SLUGS, several of which are file formats — domain vocabulary this app is
      // required to carry none of (`lint-no-domain-in-builtin`), in a GENERATED file that would
      // have to be re-registered in the domain ledger on every regeneration. The count still
      // ratchets per control, so a tenth bare `Close` anywhere fails; WHERE it is lives in the
      // failure detail, which is written at the moment of failure and committed to nothing.
      observed[b.id] = (observed[b.id] ?? 0) + 1
      ;(detail[b.id] ??= []).push({ ...b, surface: slug })
    }
  }
  return { observed, detail, seen }
}

/**
 * The floor that makes a clean sweep mean something. Measured on this tree: 94 surfaces
 * render ~280 visible icon-only controls. If a refactor (or a mistimed wait) makes the
 * sweep read empty pages, this fails instead of reporting a flawless run. Its premise —
 * that the sweep CAN come back empty — is pinned by the `a swept surface that renders
 * nothing is a floor failure` test, so lowering this constant is not a free green.
 */
const MIN_ICON_BUTTONS_SEEN = 150

test.describe('every icon-only button explains itself', () => {
  /**
   * POSITIVE CONTROL — the sweep is meant to come back near-zero, so the FIRST thing that
   * has to be true is that the detector can report anything at all, and that each allowance
   * is exactly as wide as it claims. Every branch of `visibleText` and `tooltipMarker` has a
   * probe here; widen one and a probe flips.
   */
  test('the detector reports a bare icon button and honours exactly its stated allowances', async ({
    page,
  }) => {
    await page.goto('/gallery.html')
    await page.evaluate(() => {
      const host = document.createElement('div')
      host.id = 'probe-host'
      document.body.appendChild(host)
      host.innerHTML = `
        <button type="button" data-testid="probe-bare-icon" aria-label="Bare"><svg width="16" height="16"></svg></button>
        <button type="button" data-testid="probe-sr-only-label"><svg width="16" height="16"></svg><span style="position:absolute;width:1px;height:1px;overflow:hidden">Close</span></button>
        <button type="button" data-testid="probe-aria-hidden-text" aria-label="Hidden text"><span aria-hidden="true">Save</span></button>
        <button type="button" data-testid="probe-nameless"><svg width="16" height="16"></svg></button>
        <button type="button" data-testid="probe-text-button">Save changes</button>
        <button type="button" data-testid="probe-icon-plus-text" aria-label="X"><svg width="16" height="16"></svg><span>Export</span></button>
        <button type="button" data-testid="probe-native-title" aria-label="T" title="Titled"><svg width="16" height="16"></svg></button>
        <button type="button" data-testid="probe-base-ui" aria-label="B" data-base-ui-tooltip-trigger=""><svg width="16" height="16"></svg></button>
        <button type="button" data-testid="probe-trigger-disabled" aria-label="D" data-trigger-disabled=""><svg width="16" height="16"></svg></button>
        <span data-tooltip-wrapped="Wrapped"><button type="button" data-testid="probe-wrapped" aria-label="W"><svg width="16" height="16"></svg></button></span>
        <span data-base-ui-tooltip-trigger="" tabindex="0"><button type="button" data-testid="probe-wrapped-span" aria-label="S" disabled><svg width="16" height="16"></svg></button></span>
        <button type="button" data-testid="probe-display-none-anchor" class="probe-hide" aria-label="Anchor"><svg width="16" height="16"></svg></button>
        <button type="button" data-testid="probe-zero-box" style="width:0;height:0;padding:0;border:0;overflow:hidden" aria-label="Zero"></button>
        <div role="button" data-testid="probe-role-button" aria-label="Role"><svg width="16" height="16"></svg></div>
        <button type="button" data-testid="probe-glyph-icon" aria-label="Glyph"><span>▢</span></button>
        <button type="button" data-testid="probe-glyph-nameless">▣</button>
        <button type="button" data-testid="probe-cjk-text">保存</button>
        <span title="Ancestor tip"><button type="button" data-testid="probe-ancestor-title" aria-label="A"><svg width="16" height="16"></svg></button></span>
      `
      const style = document.createElement('style')
      style.textContent = '.probe-hide{display:none}'
      document.head.appendChild(style)
    })

    const s = await scan(page)
    const noTip = s.noTooltip.map(b => b.id)
    const noName = s.noName.map(b => b.id)

    expect(s.total, 'the probes were not even in the document').toBeGreaterThanOrEqual(8)

    // REPORTED — an icon and nothing that explains it on hover.
    expect(noTip, 'a bare icon button must be reported').toContain('probe-bare-icon')
    // The kit's own Dialog close is EXACTLY this shape: an svg plus an `sr-only` label.
    // Counting sr-only text as "visible" would erase a whole class of offenders.
    expect(noTip, 'sr-only text is not a visible label').toContain('probe-sr-only-label')
    // `aria-hidden` says "this is decoration"; taking it as the label would let any
    // button opt out by hiding its own text from the a11y tree.
    expect(noTip, 'aria-hidden text is not a visible label').toContain('probe-aria-hidden-text')
    expect(noTip, 'a role=button icon must be reported too').toContain('probe-role-button')
    // A GLYPH IS AN ICON however it is drawn. Without this, a control whose whole content is
    // `▢` counts as LABELLED and is skipped by BOTH halves — the exact hole the viz legend's
    // per-category show/hide toggle sat in, unreported by a guard reporting a clean tree.
    expect(noTip, 'a glyph is an icon, not a label').toContain('probe-glyph-icon')

    // NOT REPORTED — each of these is a stated allowance, pinned so it cannot widen.
    expect(noTip, 'a button with real visible text is not icon-only').not.toContain('probe-text-button')
    expect(noTip, 'icon + visible text is not icon-only').not.toContain('probe-icon-plus-text')
    expect(noTip, 'a native title IS a tooltip').not.toContain('probe-native-title')
    expect(noTip, 'the base-ui trigger marker is a tooltip').not.toContain('probe-base-ui')
    expect(noTip, 'a disabled base-ui trigger still carries its tooltip').not.toContain('probe-trigger-disabled')
    expect(noTip, "the kit <Tooltip> wrapper's marker counts on an ancestor").not.toContain('probe-wrapped')
    expect(noTip, 'a focusable trigger SPAN around a disabled button counts').not.toContain('probe-wrapped-span')
    // Never rendered → nothing to explain. Both the CSS route and the zero-box route.
    expect(noTip, 'a display:none anchor is not a button a user meets').not.toContain(
      'probe-display-none-anchor',
    )
    expect(noTip, 'a zero-box control is not a button a user meets').not.toContain('probe-zero-box')
    // …and the widening stops at GLYPHS. A word in any script is a label, so a CJK-labelled
    // button is not icon-only — otherwise `\p{L}` would have been the wrong predicate and a
    // whole tree of localised buttons would have been reported.
    expect(noTip, 'a word in any script is a label').not.toContain('probe-cjk-text')
    // A native `title` on an ANCESTOR really is shown when the child is hovered, so reporting
    // such a control as unexplained is a false finding. (The markers below it were always read
    // with `closest`; `title` was the odd one out.)
    expect(noTip, "an ancestor's native title is hover text").not.toContain('probe-ancestor-title')

    // The name half is a separate report, and sr-only text DOES name a control.
    expect(noName, 'an icon button with no name in any channel must be reported').toContain(
      'probe-nameless',
    )
    expect(noName, 'sr-only text is a perfectly good accessible name').not.toContain(
      'probe-sr-only-label',
    )
    expect(noName, 'aria-label names a control').not.toContain('probe-bare-icon')
    // A name made of nothing but glyphs is not a name — announcing "▣" identifies nothing.
    expect(noName, 'a glyph is not an accessible name').toContain('probe-glyph-nameless')
    expect(noName, 'a word in any script IS a name').not.toContain('probe-cjk-text')
  })

  /**
   * The two pure halves of the guard, exercised against fixtures rather than against the tree.
   *
   * Both exist because the tree cannot hold the state they defend: a STALE ledger entry only
   * appears after someone fixes a control and forgets the ledger, and a DISAGREEING tooltip only
   * appears after someone writes one — so on a green tree both branches are unreachable, and a
   * mutation to either would survive every sweep. Deleting them instead would be worse: they are
   * the halves that keep the ledger from rotting into decoration and keep the hover text honest.
   */
  test('the ledger diff reports a stale entry, not just a new one', () => {
    expect(diffLedger({ 'a|x': 1 }, {}).added, 'a new offender must be reported').toHaveLength(1)
    expect(diffLedger({ 'a|x': 1 }, { 'a|x': 1 }).added, 'a ledgered offender is allowed').toHaveLength(0)
    // The half a mutation would quietly drop: a fixed control whose ledger row survived.
    expect(diffLedger({}, { 'a|x': 1 }).stale, 'a fixed offender must retire its ledger row').toHaveLength(1)
    expect(diffLedger({ 'a|x': 1 }, { 'a|x': 2 }).stale, 'a shrunk count must shrink the row').toHaveLength(1)
    expect(diffLedger({ 'a|x': 2 }, { 'a|x': 1 }).added, 'a grown count is new offence').toHaveLength(1)
  })

  test('the behavioural pass refuses to call a mostly-skipped run clean', () => {
    expect(sweptEnough(10, 0), 'a full pass is enough').toBe(true)
    expect(sweptEnough(10, 3), 'a few skips among many checks is enough').toBe(true)
    // The states a mutation would quietly wave through:
    expect(sweptEnough(0, 8), 'nothing checked is never enough').toBe(false)
    expect(sweptEnough(3, 8), 'more skipped than checked is not enough').toBe(false)
    expect(sweptEnough(2, 0), 'two controls is too thin to call a surface swept').toBe(false)
  })

  test('the agreement rule accepts a shorter form and rejects a different one', () => {
    // Accept — the tooltip drops context the name needs and the screen already shows.
    expect(tooltipAgrees('Share', 'Share Row Three', '')).toBe(true)
    expect(tooltipAgrees('Attach to project', 'Attach Row Three to a project', '')).toBe(true)
    expect(tooltipAgrees('Close Canvas', 'Close Canvas', '')).toBe(true)
    // Accept — a blocked control's tooltip is its REASON, which is the description.
    expect(tooltipAgrees('This is the last open pane', 'Close Canvas', 'This is the last open pane')).toBe(true)
    // Reject — every real disagreement this tree actually had.
    expect(tooltipAgrees('Open the analysis form', 'Open Row Three form', '')).toBe(false)
    expect(tooltipAgrees('Open sidebar', 'Open navigation menu', '')).toBe(false)
    expect(tooltipAgrees('Add to folder', 'Folders for Row Three', '')).toBe(false)
    // Reject — a reason that matches NO channel is not excused by having a description.
    expect(tooltipAgrees('Something else entirely', 'Close Canvas', 'This is the last open pane')).toBe(false)
    // Reject — an empty tooltip is not agreement, it is absence.
    expect(tooltipAgrees('', 'Close Canvas', '')).toBe(false)
  })

  /**
   * The FIXTURE that makes `MIN_ICON_BUTTONS_SEEN` a live assertion rather than a comment:
   * it proves the sweep really can come back with nothing, which is the state the floor
   * exists to reject. Without this, lowering the floor to 0 would cost nothing.
   */
  test('a swept surface that renders nothing is a floor failure', async ({ page }) => {
    const { seen } = await sweep(page, ['__no_such_surface__'])
    expect(seen, 'a surface that does not exist cannot contribute controls').toBe(0)
    expect(
      seen >= MIN_ICON_BUTTONS_SEEN,
      'the floor must REJECT an empty sweep — if this passes, the floor is decoration',
    ).toBe(false)
  })

  test('no gallery surface renders an icon-only button that explains itself to nobody', async ({
    page,
  }) => {
    test.setTimeout(25 * 60_000)

    const surfaces = await allSurfaces(page)
    expect(
      surfaces.length,
      'the surface enumeration collapsed — a sweep over nothing is not a pass',
    ).toBeGreaterThan(20)

    const { observed, detail, seen } = await sweep(page, surfaces)
    const totalBad = Object.values(observed).reduce((a, b) => a + b, 0)
    console.log(
      `icon-button-tooltips: ${surfaces.length} surface(s), ${seen} visible icon-only control(s), ` +
        `${totalBad} with no tooltip`,
    )
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
              'Visible icon-only controls rendered with NOTHING that explains them on hover, ' +
              'keyed by the CONTROL and counted across every gallery surface it renders on. ' +
              'SHRINK-ONLY: a new one fails, a stale entry fails. Regenerate with ' +
              'ICON_BUTTON_TOOLTIPS_WRITE=1 after a genuine fix — never to make a red run green.',
            surfaces: surfaces.length,
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
      const seen = detail[key] ?? []
      return `${line}  on [${[...new Set(seen.map(d => d.surface))].join(', ')}]  ${JSON.stringify(seen.slice(0, 2))}`
    })

    expect(
      [...added, ...stale].sort().join('\n'),
      'An icon with no words and no tooltip is unexplained to every sighted user who does not ' +
        'already recognise the glyph — an aria-label reaches assistive tech only. Give the control ' +
        'a `tooltip` (kit Button) or wrap it in <Tooltip>. After a genuine fix, re-derive the ' +
        'ledger with ICON_BUTTON_TOOLTIPS_WRITE=1.',
    ).toBe('')
  })

  /**
   * The BEHAVIOURAL half. The sweep above reads a marker; this opens the real tooltip and
   * reads what a user reads — which is the only way to catch (a) a tooltip that renders
   * into the wrong place, and (b) a tooltip that DISAGREES with the accessible name.
   *
   * The agreement rule: the visible tooltip must be the control's NAME or its
   * DESCRIPTION. A third string means a pointer user and a screen-reader user are told
   * different things about the same button.
   *
   * `workbench-lineage` is in this list because it was NOT, and the omission hid a
   * blank surface. The first run of this guard reported every
   * `workbench-lineage-export-*` on `workbench-pane-inset` as UNREACHABLE — recorded,
   * counted, and (correctly) not a tooltip failure. Hand-probed, the reason turned out
   * not to be the pannable-canvas clip that outcome was written for: the DAG's own
   * gallery frame was a `display:block` box, `LineageView`'s root is `flex-1 min-h-0`,
   * `flex-1` is inert outside a flex parent, and the whole view resolved to ZERO
   * height inside a 520px frame. The surface rendered an EMPTY BOX; the buttons had
   * layout rects and were clipped out of existence. `elementFromPoint` at a node's
   * centre returned the frame div, and a real `mouse.click` fired no handler.
   *
   * So a control the harness could not hit really was a control a user could not
   * reach — on that surface. Driving the surface here is what keeps it that way: with
   * the frame fixed the six controls are hovered for real, and if the frame collapses
   * again `sweptEnough` fails instead of logging a line nobody reads.
   */
  test('the behavioural surface list has not silently shrunk, and every slug is real', async ({
    page,
  }) => {
    // Nothing else in this file can notice a slug going missing: each one generates its
    // own `test()`, so removing one removes the only thing that would have failed. And a
    // slug that names no surface renders an empty page, which sweeps zero controls and
    // reads as clean — the same false-clean the floors above guard.
    expect(
      BEHAVIOURAL_SLUGS.length,
      `the behavioural surface list is down to ${BEHAVIOURAL_SLUGS.length} (floor ` +
        `${MIN_BEHAVIOURAL_SLUGS}) — a surface stopped being hovered and no test failed`,
    ).toBeGreaterThanOrEqual(MIN_BEHAVIOURAL_SLUGS)
    const real = new Set(await allSurfaces(page))
    expect(real.size, 'the gallery listed no surfaces at all').toBeGreaterThan(10)
    expect(
      BEHAVIOURAL_SLUGS.filter(s => !real.has(s)),
      'these behavioural slugs name no gallery surface, so they hover nothing',
    ).toEqual([])
  })

  for (const slug of BEHAVIOURAL_SLUGS) {
    test(`on ${slug}, every icon button's tooltip opens and agrees with its name`, async ({
      page,
    }) => {
      test.setTimeout(8 * 60_000)
      await openSurface(page, slug)

      const targets = await page.evaluate(SCAN_TARGETS)
      expect(targets.length, `${slug} rendered no icon-only control to hover`).toBeGreaterThan(3)

      const problems: string[] = []
      const unreachable: string[] = []
      let checked = 0
      for (const t of targets) {
        const el = page.locator(`[data-testid="${t.testid}"]`).first()
        if ((await el.count()) === 0) continue
        await el.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => null)
        // A pointer cannot open a tooltip on a control it cannot land on. Some surfaces clip a
        // pannable canvas, so a node's button sits outside the clip at this scroll position —
        // real, but a fact about the FIXTURE, not about the tooltip. Recorded and counted
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
          problems.push(`${t.testid}: hovering opened no tooltip (name="${t.name}")`)
          continue
        }
        if (!tooltipAgrees(shown, t.name, t.desc)) {
          problems.push(
            `${t.testid}: tooltip says "${shown}" but the accessible name is "${t.name}"` +
              (t.desc ? ` and the description is "${t.desc}"` : ' and it has no description'),
          )
        }
        // move away so the next hover is a fresh open
        await page.mouse.move(2, 2)
        await expect(content).toHaveCount(0, { timeout: 5_000 }).catch(() => null)
      }

      console.log(
        `icon-button-tooltips(${slug}): ${checked} hovered, ${unreachable.length} not hit-testable` +
          (unreachable.length ? ` [${unreachable.join(', ')}]` : ''),
      )
      expect(
        sweptEnough(checked, unreachable.length),
        `only ${checked} of ${checked + unreachable.length} tooltip claimant(s) on ${slug} could be ` +
          'hovered — a run that skipped almost everything is a broken fixture, not a pass',
      ).toBe(true)
      expect(
        problems.join('\n'),
        'A tooltip that never opens explains nothing, and one that disagrees with the accessible ' +
          'name tells two users two different things about the same control.',
      ).toBe('')
    })
  }

  /**
   * THE UNAVAILABLE CASE, driven as a journey rather than asserted from a fixture.
   *
   * A greyed-out control whose only explanation is a tooltip is the worst of both worlds if that
   * tooltip cannot open — and the usual implementation drops it silently, because a disabled
   * control is commonly given `pointer-events: none`. So the shell carries the reason in BOTH
   * channels: a tooltip for hover, and an sr-only `aria-describedby` node for everything else.
   * This test holds the pointer half open.
   *
   * ── WHAT CHANGED, AND WHY THE ASSERTIONS MOVED ──────────────────────────────────────────────
   *
   * This test used to read `toBeDisabled()` and `aria-label` off the TAB'S CLOSE, because that
   * close was a focusable `aria-disabled` <button> INSIDE the `role="tab"`. That construction is
   * axe `nested-interactive` (WCAG 4.1.2) — a composite widget owning a second interactive node —
   * and it is now fixed (`regions/RegionTab.tsx`): the X is an `aria-hidden` pointer affordance,
   * and the close is reachable by `Delete` on the focused tab.
   *
   * So the SUBJECT is unchanged — an unavailable control must still explain itself, on hover and
   * in the accessibility tree — and only the element carrying each half moved. The ARIA half is
   * now on the TAB, which is the node a user is actually on and the node that refuses the key;
   * the HOVER half is still on the X, which is where a pointer goes. The PANE HEADER's close (a
   * side region's, not inside any tab) is still a real `aria-disabled` button and is covered by
   * the sweep above.
   *
   * The blocked state is REACHED, not staged: close panes through the real UI until one is left,
   * which is exactly how a user meets it (and, unlike a hand-set prop, it also proves the shell
   * still refuses to close the last pane).
   */
  test("the last pane's blocked close says WHY, on hover, while unavailable", async ({ page }) => {
    test.setTimeout(5 * 60_000)
    await openSurface(page, 'workbench-empty')

    const closes = () => page.locator('[data-testid^="region-tab-close-"]')
    const blocked = () => page.locator('[data-testid^="region-tab-close-"][data-close-blocked]')
    const before = await closes().count()
    expect(before, 'need several panes to close down from').toBeGreaterThan(1)

    for (let i = 0; i < 20; i++) {
      if ((await blocked().count()) > 0) break
      const first = closes().first()
      await first.click({ force: true }).catch(() => null)
      await page.waitForTimeout(250)
      if ((await closes().count()) <= 1 && (await blocked().count()) > 0) break
    }

    const last = closes().first()
    await expect(last, 'the shell must still offer the close, not remove it').toBeVisible()
    // UNAVAILABLE — marked rather than natively `disabled`, because the element is no longer a
    // control at all in the accessibility tree.
    await expect(last, 'the last pane cannot be closed').toHaveAttribute('data-close-blocked', '')
    // …and it is genuinely out of that tree, which is what makes the tab ONE node.
    await expect(last).toHaveAttribute('aria-hidden', 'true')

    // The TAB is the node the reason and the name hang off now.
    const paneId = ((await last.getAttribute('data-testid')) ?? '').slice('region-tab-close-'.length)
    const tab = page.getByTestId(`region-tab-${paneId}`)

    // (a) the reason is in the accessibility tree, for anyone not using a pointer …
    const whyId = await tab.getAttribute('aria-describedby')
    expect(whyId, 'a tab whose close is blocked must point at its reason').toBeTruthy()
    const why = ((await page.locator(`#${whyId}`).textContent()) ?? '').trim()
    expect(why, 'the reason must actually say something').not.toBe('')

    // … (b) and a sighted user gets it on hover, even though the control is unavailable.
    await last.hover({ force: true })
    const content = page.locator('[data-slot="tooltip-content"]')
    await expect(
      content,
      'an unavailable control whose only explanation is a tooltip must still be able to show it',
    ).toHaveCount(1, { timeout: 10_000 })
    expect((await content.first().textContent())?.trim()).toBe(why)

    // … (c) and the NAME still says WHICH pane this is — the reason must not swallow it.
    expect(await tab.getAttribute('aria-label')).toBeTruthy()
    // … (d) and the close a keyboard user has is ANNOUNCED, since the X is no longer a tab stop.
    await expect(tab).toHaveAttribute('aria-keyshortcuts', 'Delete')
  })
})
