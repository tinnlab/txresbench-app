import { expect, test } from '@playwright/test'

/**
 * masked-field-caps (RENDERED-DOM half) — no masked field in the live DOM declares a
 * truncating cap.
 *
 * ── THE DEFECT THIS PINS ──────────────────────────────────────────────────────
 * `maxlength` enforces a limit by silently DISCARDING the overflow: the browser keeps a
 * prefix, fires no event, and shows no difference. On a masked field the user cannot see
 * which happened — and when the confirm field carries the SAME cap, the two truncated
 * halves agree, so even the mismatch check goes quiet.
 *
 * It shipped: the profile page capped both new-password fields at 72, so a longer
 * passphrase was cut in both, the two matched, the change succeeded, and the passphrase
 * the user recorded was not the one that had been set.
 *
 * ── WHY THIS HALF EXISTS ──────────────────────────────────────────────────────
 * `scripts/lint-secret-input-caps.mjs` is the cheap half: a regex over first-party JSX.
 * It cannot see a cap arriving through a spread, a variable `type`, or a dependency —
 * and this repo has twice paid for guards that read SOURCE TEXT and lost (the activity
 * rail's static analyser; `gate-ui`'s port guard). This half reads the value the browser
 * would actually enforce, off the element that was actually rendered.
 *
 * It matters most for `<Input type="password">`, which the kit's type-level ban cannot
 * reach — as far as the types are concerned that is an ordinary Input, and the first-run
 * setup page renders exactly that shape.
 *
 * ── WHY A FIXED SURFACE LIST, NOT A SWEEP ─────────────────────────────────────
 * The first draft swept all 94 gallery surfaces. Its floor immediately failed it: the
 * sweep inspected ZERO masked fields. The gallery seeds an authenticated admin, so the
 * login/register/link surfaces render signed-in and `/settings/profile`'s password card
 * does not render at all under the seeded permissions — the fields this rule is about
 * are structurally unreachable from a blanket crawl. Publishing a green sweep over
 * nothing would have been worse than publishing no sweep, so the surfaces are named,
 * with the auth mode each one needs and a floor on the fields seen.
 *
 * `/settings/profile` (the site of the original defect) is therefore covered by the
 * jsdom test that renders that page directly:
 * `src/modules/profile/pages/passwordNoSilentTruncation.test.tsx`.
 *
 * ── NO BASELINE ───────────────────────────────────────────────────────────────
 * Unlike its native-controls sibling there is no ledger and no ratchet. The count is
 * zero, and a truncating cap on a secret is never the right answer, so the only correct
 * ledger is the empty one.
 */

/** Surfaces that actually render a masked field, with the auth mode each one needs. */
const MASKED_SURFACES: ReadonlyArray<{ slug: string; auth: string; expect: number }> = [
  // The login form (`PasswordInput`, an existing secret — must never carry a cap).
  { slug: 'auth', auth: 'none', expect: 1 },
  // First-run setup: TWO `<Input type="password">` — the shape the kit's type ban cannot
  // see, and the reason this DOM half exists at all.
  { slug: 'setup', auth: 'none', expect: 2 },
]

/** The floor that makes a clean result mean something rather than "nothing rendered". */
const MIN_MASKED_SEEN = MASKED_SURFACES.reduce((n, s) => n + s.expect, 0)

interface Masked {
  testid: string
  cap: number
  name: string
}

/**
 * Masked fields in the document, and which of them declare a cap.
 *
 * A field the user has REVEALED (the kit's eye toggle flips `type` to `text`) is still a
 * secret field, so the query matches `autocomplete` as well as `type`.
 */
async function scanMasked(
  page: import('@playwright/test').Page,
): Promise<{ total: number; capped: Masked[] }> {
  return page.$$eval(
    'input[type="password"], input[autocomplete="new-password"], input[autocomplete="current-password"]',
    els => ({
      total: els.length,
      capped: (els as HTMLInputElement[])
        .filter(el => el.maxLength >= 0)
        .map(el => ({
          testid: el.getAttribute('data-testid') ?? '',
          cap: el.maxLength,
          name: el.getAttribute('name') ?? '',
        })),
    }),
  )
}

test.describe('no masked field declares a truncating cap', () => {
  /**
   * POSITIVE CONTROL — the sweep below reports zero, so the first thing that has to be
   * true is that the detector can report anything at all.
   *
   * It also pins the reveal case: the kit's eye toggle flips `type` to `text`, and a
   * detector keyed on `type="password"` alone would go blind exactly when the user
   * unmasks the field — and pins the scope, since a cap on a VISIBLE field is legitimate.
   */
  test('the detector reports a capped masked field, including a revealed one', async ({ page }) => {
    await page.goto('/gallery.html')
    await page.evaluate(() => {
      const mk = (html: string) => {
        const d = document.createElement('div')
        d.innerHTML = html
        document.body.appendChild(d.firstElementChild as Element)
      }
      mk('<input type="password" maxlength="72" data-testid="probe-capped" />')
      mk('<input type="password" data-testid="probe-uncapped" />')
      mk('<input type="text" autocomplete="new-password" maxlength="72" data-testid="probe-revealed" />')
      mk('<input type="text" maxlength="255" data-testid="probe-visible" />')
    })

    const { total, capped } = await scanMasked(page)
    expect(total, 'the probes were not even in the document').toBeGreaterThanOrEqual(3)
    const ids = capped.map(c => c.testid)
    expect(ids).toContain('probe-capped')
    expect(ids).toContain('probe-revealed')
    expect(ids).not.toContain('probe-uncapped')
    expect(ids).not.toContain('probe-visible')
  })

  test('no rendered masked field carries a cap', async ({ page }) => {
    test.setTimeout(5 * 60_000)

    const capped: string[] = []
    let maskedSeen = 0

    for (const { slug, auth, expect: want } of MASKED_SURFACES) {
      await page.goto(`/gallery.html?surface=${slug}&auth=${auth}`)
      await page
        .waitForSelector(`[data-testid="gallery-page-${slug}"]`, { timeout: 30_000 })
        .catch(() => null)
      // The masked fields sit inside a lazily-loaded page; settle before reading.
      await expect
        .poll(async () => (await scanMasked(page)).total, {
          timeout: 30_000,
          message: `surface "${slug}" never rendered its ${want} masked field(s)`,
        })
        .toBeGreaterThanOrEqual(want)

      const scan = await scanMasked(page)
      maskedSeen += scan.total
      for (const c of scan.capped) capped.push(`${slug}  ${c.testid || c.name}  maxlength=${c.cap}`)
    }

    console.log(
      `masked-field-caps(DOM): ${MASKED_SURFACES.length} surface(s), ${maskedSeen} masked ` +
        `field(s) inspected, ${capped.length} capped`,
    )
    expect(
      maskedSeen,
      `inspected only ${maskedSeen} masked field(s) (< ${MIN_MASKED_SEEN}) — a query that matches ` +
        'nothing reports a flawless run forever',
    ).toBeGreaterThanOrEqual(MIN_MASKED_SEEN)

    expect(
      capped.join('\n'),
      'A cap on a masked field discards what the user typed where they cannot see it, and a ' +
        'confirm field with the same cap hides even the mismatch. State the limit and REFUSE ' +
        'past it (`core/passwordPolicy`) — never truncate a secret.',
    ).toBe('')
  })
})
