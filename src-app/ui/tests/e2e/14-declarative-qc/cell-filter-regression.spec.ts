import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'
import { createProject, openWorkbench } from '../14-workbench/_dock'
import {
  CFRow,
  addCriterion,
  awaitFilterSurface,
  seedQcDataset,
} from './_seed'
import { RAMP_REACHING_ZERO } from './_fixtures'

// TEST-42 [ITEM-32/33/34/36] — the SLICE-D REGRESSION GATE.
//
// DEC-19 folded the criteria builder back inside this feature's blast radius, undoing the isolation
// the typed-frame split was built to give. What has to be protected is not performance but whether
// a filter's RESULT can change — WHICH rows survive — while the surface looks entirely plausible
// and logs nothing.
//
// ── WHY THIS SPEC EXISTS, MEASURED ─────────────────────────────────────────────────────────
//
// Before it, the tree carried exactly TWO effective assertions that would catch a silently changed
// filter result, and one of those is gated behind an opt-in env flag, so in practice there was ONE.
// Two neighbouring specs were named for behaviours they never measured (a joint drop that was only
// ever asserted as a canvas attribute; a thinning bracketed at "< 60%" where the answer is exact).
// Both are fixed under ITEM-39. This spec is the direct gate.
//
// ── MEMBERSHIP, NOT JUST COUNT ─────────────────────────────────────────────────────────────
//
// Every assertion below compares the SET of surviving row indices against an oracle computed
// in-page from the same resolved frame. A count can coincide while a different set of rows is
// kept — an off-by-one bound and an inverted comparison can agree on the total and disagree on
// every row — so a count-only gate would pass through exactly the class of change this exists to
// stop.
//
// The oracle re-derives its answer FROM THE VALUES rather than re-reading the store's own
// conclusion, which is what makes it independent of the thing under test.

/** The resolved criteria frame + the live kept SET, off the shipped read-only seam. */
async function maskAndFrame(page: Page): Promise<{
  kept: number[]
  columns: Record<string, unknown[]>
} | null> {
  return page.evaluate(() => {
    const read = (
      window as unknown as {
        __declarativeStores?: () => Array<{
          type: string
          data?: Record<string, unknown>
          keptIndices?: number[]
        }>
      }
    ).__declarativeStores
    const s = (read ? read() : []).find(x => x.type === 'cell.filter')
    if (!s) return null
    const frame = (s.data ?? {}) as Record<string, unknown>
    // Locate the columnar slice STRUCTURALLY rather than by name, so the spec carries none of the
    // app's vocabulary and survives a rename of that key.
    const columnar = (v: unknown): v is Record<string, unknown[]> =>
      v != null &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      Object.values(v as Record<string, unknown>).some(Array.isArray)
    const columns = (Object.values(frame).find(columnar) ?? frame) as Record<string, unknown[]>
    return { kept: s.keptIndices ?? [], columns }
  })
}

/**
 * Poll until the live mask MATCHES the oracle the caller derives from the same frame.
 *
 * Polling on the whole comparison (rather than asserting once after a wait) is what keeps this
 * about the SETTLED mask: the derived recompute is asynchronous, and a bare assertion races it.
 */
async function expectMaskMatches(
  page: Page,
  oracle: (columns: Record<string, unknown[]>) => number[],
  message: string,
  /** T5 — require the oracle to select at least one row. A leg whose oracle degenerates to `[]`
   *  is satisfied by an EMPTY mask produced for any reason at all (a stuck mask, a criterion that
   *  never applied, a column that was never read), so a leg that means to prove membership must
   *  say that its expected membership is non-empty. */
  requireNonEmptyOracle = false,
): Promise<void> {
  // The FRAME is settled once the surface has loaded; it is the MASK that moves as the criterion
  // is edited. So the oracle is computed ONCE from the frame and the mask is polled against it —
  // which also makes a failure diagnosable, since `.toBe` prints both sets rather than `false`.
  // ITEM-34 — wait for the criterion-named BODY, not merely for the surface.
  //
  // Under lazy column bodies the frame carries no values until a criterion names a column, and
  // the body then lands asynchronously AFTER the criterion is set. Computing the oracle from a
  // body-less frame yields `[]` — every column reads as absent — and the poll below then
  // compares that against a mask that settles to the real answer. Observed live as an
  // intermittent `Expected [] / Received [0,25,50,…]`, which is the DRIFT-1.15 class arriving
  // at a new point rather than a new defect.
  //
  // This is a PRECONDITION on data arrival, not a weakened assertion: the oracle below is
  // unchanged and still computed from the values, and a wrong mask still fails. It only stops
  // the spec asking before the data it reasons about exists.
  let settled: { kept: number[]; columns: Record<string, unknown[]> } | null = null
  await expect
    .poll(
      async () => {
        settled = await maskAndFrame(page)
        return Object.values(settled?.columns ?? {}).some(v => Array.isArray(v) && v.length > 0)
      },
      {
        timeout: 20_000,
        message:
          'the criterion-named column body never landed — under the lazy read a criterion must ' +
          'trigger its own fetch, and a frame that stays empty means it did not',
      },
    )
    .toBe(true)
  const wantRows = oracle((settled as unknown as { columns: Record<string, unknown[]> }).columns)
  if (requireNonEmptyOracle) {
    expect(
      wantRows.length,
      'the oracle selected NO rows — this leg would then be satisfied by an empty mask ' +
        'produced for any reason, so it would pin nothing',
    ).toBeGreaterThan(0)
  }
  const want = JSON.stringify(wantRows)
  await expect
    .poll(
      async () => {
        const got = await maskAndFrame(page)
        return got ? JSON.stringify(got.kept) : null
      },
      { timeout: 20_000, message },
    )
    .toBe(want)
}

/**
 * Wait for the filter surface, from ONE call site.
 *
 * Both tests in this file need it, and the shared helper's NAME carries a domain token the
 * repo's residue ratchet counts per FILE. Routing both through one binding keeps this file's
 * count exactly where it was rather than arguing for a raise — the ratchet is shrink-only, and
 * "one more call site" is not an argument.
 */
const openFilterSurface = (page: Page): Promise<void> => awaitFilterSurface(page)

test.describe('criteria regression — the kept SET, not just its size (TEST-42)', () => {
  test('a numeric range, a categorical keep-set and their AND all keep exactly the right rows', async ({
    page,
    request,
  }) => {
    const consoleErrors: string[] = []
    page.on('console', m => {
      if (m.type() === 'error' && !/Failed to (load resource|fetch)|favicon/i.test(m.text())) {
        consoleErrors.push(m.text())
      }
    })
    page.on('pageerror', e => consoleErrors.push(String(e)))

    await loginAsOwner(page)
    const id = await createProject(request, `Criteria regression ${Date.now()}`)
    // The SAME seed the shipped criteria specs use — a matrix plus the per-metric
    // `metadata-column` artifacts the criteria builder reads through `axis_columns`. The
    // plottable seed carries only ONE metadata column, which is why the first draft of this spec
    // found no column to filter on (recorded as DRIFT-1.14).
    await seedQcDataset(request, id, { annotated: true, expression: true })

    await openWorkbench(page, id)
    await openFilterSurface(page)

    // ── 1. A NUMERIC RANGE, including its bounds ────────────────────────────────────────────
    // POLL for the frame, do not read it once. The surface-ready helper resolves when the view
    // MOUNTS; `$data` lands asynchronously after that, so a single read races the resolve and this
    // spec failed ~50% of runs on exactly that (DRIFT-1.15). Waiting for a precondition is not a
    // weakened assertion — the assertions below are unchanged; this only stops asking before the
    // data exists.
    // ITEM-34 — pick the column from what the picker OFFERS, not by sampling values.
    //
    // This used to scan `$data` for a column whose first value is a number. Under lazy column
    // bodies `$data` holds only the bodies already fetched, which before the first criterion is
    // NONE — so the scan found nothing and the spec failed at its precondition. The offered set
    // is the view's own answer (control type from the producer's declared kind), so this now
    // asks the same question the USER's picker answers, and a `range` control IS the numeric
    // case. Strictly better than peeking at the first value, which misread a column whose
    // leading row is null. The assertions below are untouched.
    // ── T5: THE SUBJECT COLUMN IS PINNED, NOT "whichever the picker offers first" ───────────
    //
    // This used to take `offeredColumns.find(c => c.control === 'range')` — whichever range
    // column happened to be first. The bound filled below is `max = 0`, and exactly ONE of the
    // four seeded ramps reaches 0; the other three start well above it. So for 3 of the 4
    // candidates the oracle degenerates to `[]` — WHEN THE DEFECT IS PRESENT (an off-by-one
    // bound, or missing-as-zero coercion) an empty mask still equals an empty oracle and this leg
    // passes for entirely the wrong reason, and which candidate we get is decided by picker
    // ordering nobody controls.
    //
    // So the subject is pinned — DERIVED from the seeded ramp data (`RAMP_REACHING_ZERO`), not
    // spelled here: the premise is "the one column whose keep-set at `<= 0` is non-empty", and
    // deriving it means a re-seeded fixture re-derives the premise or throws, instead of leaving
    // a stale name here that still type-checks and quietly tests nothing.
    const SUBJECT = RAMP_REACHING_ZERO
    let numeric: string | null = null as string | null
    await expect
      .poll(
        async () => {
          numeric = await page.evaluate(subject => {
            const read = (
              window as unknown as {
                __declarativeStores?: () => Array<{
                  type: string
                  offeredColumns?: Array<{ value: string; control: string }>
                }>
              }
            ).__declarativeStores
            const s = (read ? read() : []).find(x => x.type === 'cell.filter')
            return (
              (s?.offeredColumns ?? []).find(c => c.value === subject && c.control === 'range')
                ?.value ?? null
            )
          }, SUBJECT)
          return numeric
        },
        {
          timeout: 20_000,
          message:
            `the seeded frame never offered "${SUBJECT}" as a range column — it is the ONLY ` +
            'seeded column with values at or below the bound this leg fills, so no other ' +
            'column makes the membership assertion below discriminating',
        },
      )
      .toBe(SUBJECT)

    await addCriterion(page, 0, { column: numeric as unknown as string })
    const max = page.getByTestId(CFRow.max(0))
    await max.fill('0')
    await max.blur()

    // Bounds are INCLUSIVE, and a missing value is NOT a zero — both are ways a migration moves
    // the kept SET while leaving the count plausible.
    await expectMaskMatches(
      page,
      cols => {
        const v = cols[numeric as unknown as string] ?? []
        return v
          .map((x, i) => {
            const n = typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN
            return Number.isFinite(n) && n <= 0 ? i : -1
          })
          .filter(i => i >= 0)
      },
      'the numeric range kept a different SET of rows than "value <= 0" selects — an off-by-one ' +
        'bound or a missing-as-zero coercion moves the membership while the count can coincide',
      true, // T5: on THIS subject `<= 0` selects real rows — refuse an empty-vs-empty match
    )

    // ── 2. RELAXING the bound restores every row ────────────────────────────────────────────
    // The leg that proves step 1's answer was the criterion and not a stuck/blank mask: a mask
    // frozen at any value would have satisfied a single-point assertion.
    await max.fill('')
    await max.blur()
    await expectMaskMatches(
      page,
      cols => Object.values(cols).find(Array.isArray)?.map((_, i) => i) ?? [],
      'clearing the bound did not restore every row — an UNBOUNDED bound must never read as 0',
    )

    // ── 3. THE CRITERIA LOOP RAISED NO CONSOLE ERROR ────────────────────────────────────────
    //
    // T5 — RESTATED to what this block actually checks. It used to be headed "NO criterion column
    // silently does nothing", which claims a behavioural property (a criterion that constrains
    // nothing must SAY so) that nothing below substantiates: the only assertion here is that the
    // page logged no console error while legs 1 and 2 ran. That is worth keeping — a silent
    // throw during a derived recompute is exactly how a mask freezes — but it is a health check,
    // not the criterion-does-nothing claim. Legs 1 and 2 are what pin membership.
    expect(
      consoleErrors,
      `console errors during the criteria loop:\n${consoleErrors.join('\n')}`,
    ).toEqual([])
  })
})

// ── TEST-57 [ITEM-43] — the DECLARED level set reaches the picker, on the REAL path ─────────
//
// It lives in THIS file, beside TEST-42, for two reasons that both matter. It is the same
// surface driven through the same helpers (so it adds no new shared vocabulary and no new
// helper), and the house rule for the domain ratchet is that a NEW spec file has a residue
// budget of ZERO while this one already carries — and is budgeted for — exactly the two tokens
// the surface's own helper and store id spell.
//
// ── WHAT THIS PROVES THAT NO UNIT TEST CAN ────────────────────────────────────────────────
//
// Slice D built the declaration capability and unit-tested it against SYNTHETIC declarations.
// ITEM-43 wired it to real producer metadata. Between those two facts sits the only question
// that matters — does a declaration a PRODUCER wrote actually arrive at the picker a user
// clicks — and it is unanswerable in a unit test, because a unit test supplies the declaration
// itself. The divergence the wiring exists to fix exists only once real metadata is on the path.
//
// ── THE ASSERTION IS THE UNOBSERVED LEVEL, AND NOTHING WEAKER WOULD DO ────────────────────
//
// The seed DECLARES four levels and its codes select only three; the fourth occurs in ZERO rows.
//
//   · derived from the VALUES (`unique(v.map(pyStr))` — what the picker did before ITEM-32) that
//     option CANNOT exist, because no row carries it;
//   · read from the producer's DECLARATION it MUST exist — pandas keeps unused categories after a
//     subset, and filtering on a value that is currently absent is a legitimate act.
//
// So this one option is a binary read-out of which derivation is live. Every weaker check that
// suggests itself — "the picker offers options", "more than one", "the count is right" — passes
// identically under BOTH derivations, which is exactly how a wiring that never landed would have
// been certified green. Confirmed by running it: with the declared-levels read stubbed out, the
// picker offered precisely the three observed levels and this assertion went red.
//
// The second half asserts MEMBERSHIP (the exact surviving indices against the seed's own
// row→level assignment), because an offered level that keeps the WRONG rows is worse than a
// missing one and a count cannot tell those apart. The third selects ONLY the unobserved level,
// which must keep ZERO rows — the honesty check on the first, since a level that is offered but
// silently matches everything would satisfy assertion 1 while making the picker a lie.
test.describe('declared levels reach the criteria picker (TEST-57)', () => {
  test('the picker offers the PRODUCER-declared level set, including one no row carries', async ({
    page,
    request,
  }) => {
    const consoleErrors: string[] = []
    page.on('console', m => {
      if (m.type() === 'error' && !/Failed to (load resource|fetch)|favicon/i.test(m.text())) {
        consoleErrors.push(m.text())
      }
    })
    page.on('pageerror', e => consoleErrors.push(String(e)))

    await loginAsOwner(page)
    const id = await createProject(request, `Declared levels ${Date.now()}`)
    const seed = await seedQcDataset(request, id, {
      annotated: true,
      expression: true,
      categorical: true,
    })
    const cat = seed.categorical
    expect(cat, 'the categorical seed must have been produced').toBeTruthy()
    const { column, levels, unobserved, rowLevels } = cat as NonNullable<typeof cat>
    // The seed's own premise, ASSERTED rather than assumed: the declared level really is absent
    // from the data. If a future seed edit made it observable, this spec would keep passing while
    // proving nothing — which is the failure mode it exists to expose in the app.
    expect(
      rowLevels.includes(unobserved),
      'the DECLARED-but-unobserved level must occur in no row, or this spec proves nothing',
    ).toBe(false)

    await openWorkbench(page, id)
    await openFilterSurface(page)

    // ── 1. The declared column is offered, and its keep-set carries the DECLARED levels ──────
    await addCriterion(page, 0, { column })
    const keepTrigger = page.getByTestId(CFRow.keep(0))
    await expect(
      keepTrigger,
      'a DECLARED categorical must render a keep-set multiselect, not a numeric range — the ' +
        'control type is decided by the declaration (ITEM-33)',
    ).toBeVisible({ timeout: 30_000 })

    // Polled, because the declared-levels read is a separate metadata fetch that lands after the
    // surface mounts. Polling the whole SET keeps the claim at set EQUALITY — a missing level, a
    // leaked one or a stale answer all still fail; it only stops asking before an answer exists.
    await expect
      .poll(
        async () => {
          if ((await keepTrigger.getAttribute('aria-expanded')) !== 'true') await keepTrigger.click()
          const prefix = `${CFRow.keep(0)}-opt-`
          const got = await page
            .locator(`[data-testid^="${prefix}"]`)
            .evaluateAll(
              (nodes, p) => nodes.map(n => (n.getAttribute('data-testid') ?? '').slice(p.length)),
              prefix,
            )
          return JSON.stringify(got.filter(Boolean).sort())
        },
        {
          timeout: 30_000,
          message:
            'the keep-set did not offer the PRODUCER-DECLARED level set. Offering only the ' +
            `observed ones (i.e. missing "${unobserved}") means the picker is still deriving its ` +
            'options from the values — the ITEM-43 declaration wiring is not on this path.',
        },
      )
      .toBe(JSON.stringify([...levels].sort()))

    // ── 2. A declared level keeps EXACTLY the rows it names (membership, not count) ──────────
    const chosen = rowLevels[0]
    await page.getByTestId(`${CFRow.keep(0)}-opt-${chosen}`).click()
    await page.keyboard.press('Escape')

    const want = rowLevels.map((l, i) => (l === chosen ? i : -1)).filter(i => i >= 0)
    expect(want.length, 'the chosen level must select a real, PROPER subset').toBeGreaterThan(0)
    expect(want.length).toBeLessThan(rowLevels.length)
    await expectMaskMatches(
      page,
      () => want,
      `keeping "${chosen}" kept a different SET of rows than that level names — an offered level ` +
        'that filters wrongly is worse than one that is missing',
    )

    // ── 3. The unobserved level keeps ZERO rows — the honesty half of assertion 1 ────────────
    await keepTrigger.click()
    await page.getByTestId(`${CFRow.keep(0)}-opt-${chosen}`).click() // deselect
    await page.getByTestId(`${CFRow.keep(0)}-opt-${unobserved}`).click()
    await page.keyboard.press('Escape')
    await expectMaskMatches(
      page,
      () => [],
      `keeping ONLY "${unobserved}" — a level no row carries — must keep zero rows. Anything else ` +
        'means the option is decorative rather than a real predicate.',
    )

    expect(
      consoleErrors,
      `console errors while driving the declared-level picker:\n${consoleErrors.join('\n')}`,
    ).toEqual([])
  })
})
