import { expect, test } from '@playwright/test'

// TEST-CUT-HP [positive-control] (#64) — the HAPPY path for a PERMITTED admin: the live
// object-store hot-cutover status/progress view renders populated, in a real browser, across its
// lifecycle states. Driven through the component gallery's seeded surfaces
// (`src/modules/infra/gallery.tsx`), which render the props-driven `LiveCutoverStatusView` with
// `canManage` true — the same view the `LiveCutoverStatusCard` container mounts once its poll of
// the live saas route `GET /api/admin/infra/migration` (see `api-client-saas/apiEndpoints.ts`)
// returns a `MigrationStatusView`. The container's data wiring against that exact route is pinned
// by the store unit test (`InfraSettings.store.test.ts` — `getInfraMigration`/`ackInfraMigrationCost`).
//
// A route mock is deliberately not used here: the view is props-driven, so there is nothing to
// intercept — seeding the props IS the "permitted admin, populated data" fixture, without a
// backend. The gate proves the states are user-visible (a real %, N/M + phase, the cost-ack
// affordance, the cut-over-live + old-store-retained notes) rather than a bare spinner.

const surface = (slug: string) => `/gallery.html?surface=${slug}&auth=admin`

test.describe('live object-store cutover — populated admin view (#64)', () => {
  test('an automatic copy in flight shows a real %, N/M blobs and the phase', async ({ page }) => {
    await page.goto(surface('infra-cutover-copying-auto'))

    const card = page.getByTestId('infra-live-cutover-card')
    await expect(card).toBeVisible({ timeout: 30_000 })

    // Distinguishes an auto-started (config-switch) cutover from a manual one.
    await expect(page.getByTestId('infra-cutover-auto')).toBeVisible()
    await expect(page.getByTestId('infra-cutover-phase')).toHaveText(/Copying/)

    // User-visible progress — a percentage, not a bare spinner — and the N/M + byte counts.
    const progress = page.getByTestId('infra-cutover-progress')
    await expect(progress).toBeVisible()
    await expect(progress).toContainText('%')
    await expect(page.getByTestId('infra-cutover-counts')).toContainText('/4820 blobs')
  })

  test('a parked cross-cloud move shows the estimate and the cost-ack button', async ({ page }) => {
    await page.goto(surface('infra-cutover-awaiting-cost-ack'))

    await expect(page.getByTestId('infra-live-cutover-card')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('infra-cutover-phase')).toHaveText(/awaiting cost/i)

    const costAck = page.getByTestId('infra-cutover-cost-ack')
    await expect(costAck).toBeVisible()
    await expect(costAck).toContainText('4820 blob') // the estimate is surfaced
    await expect(costAck).toContainText('egress')
    await expect(page.getByTestId('infra-cutover-cost-ack-btn')).toBeVisible()
    // A cost-ack is a start affordance, not progress — no progress bar yet.
    await expect(page.getByTestId('infra-cutover-progress')).toHaveCount(0)
  })

  test('cut over live shows the retained-old-store note and a completed retire-readiness check', async ({
    page,
  }) => {
    await page.goto(surface('infra-cutover-live-retire-ready'))

    await expect(page.getByTestId('infra-live-cutover-card')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('infra-cutover-phase')).toHaveText(/Cut over live/)

    // The old store is retained as the read fallback and is not auto-deleted.
    const note = page.getByTestId('infra-cutover-old-store-note')
    await expect(note).toBeVisible()
    await expect(note).toContainText(/retire it manually/i)
    await expect(note).toContainText(/NEVER deleted automatically/i)

    // The reused retire-source readiness check reports safe-to-retire + its message.
    await expect(page.getByTestId('infra-cutover-retire-check')).toBeVisible()
    const result = page.getByTestId('infra-cutover-retire-result')
    await expect(result).toBeVisible()
    await expect(result).toContainText(/Safe to retire/)
  })
})

// TEST-FE4 — happy-path cutover status render (#64 ITEM-8)
