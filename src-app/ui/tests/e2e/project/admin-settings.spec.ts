import { expect, test } from '@playwright/test'
import { loginAsOwner } from './_helpers'

// TEST-29: the admin opens /settings/projects, toggles transfer_enabled off, and
// it persists (reload shows off). The owner admin holds project::settings::manage.
test('admin toggles the ownership-transfer setting and it persists', async ({ page }) => {
  await loginAsOwner(page)

  await page.goto('/settings/projects')
  await expect(page.getByTestId('project-settings-card')).toBeVisible()
  const toggle = page.getByTestId('project-settings-transfer-toggle')
  await expect(toggle).toBeVisible()

  // Default ON → turn OFF + save.
  const wasOn = (await toggle.getAttribute('aria-checked')) === 'true'
  if (wasOn) {
    await toggle.click()
    await page.getByTestId('project-settings-save').click()
  }

  // Reload → the setting persisted (off).
  await page.reload()
  await expect(page.getByTestId('project-settings-transfer-toggle')).toHaveAttribute(
    'aria-checked',
    'false',
  )

  // Restore ON for other specs.
  await page.getByTestId('project-settings-transfer-toggle').click()
  await page.getByTestId('project-settings-save').click()
})
