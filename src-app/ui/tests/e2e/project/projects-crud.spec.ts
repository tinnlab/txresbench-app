import { expect, test } from '@playwright/test'
import { loginAsOwner } from './_helpers'

// TEST-33/35: the top-level Projects page (the app's home content surface) renders
// after login; create via the drawer, search, duplicate, delete-with-confirm.
test('projects page + CRUD happy path', async ({ page }) => {
  await loginAsOwner(page) // lands on /projects (projects-page visible)
  await expect(page.getByTestId('projects-page')).toBeVisible()

  // Create via the drawer (typed name/description).
  const name = `E2E Project ${Date.now()}`
  await page.getByTestId('projects-new-button').click()
  await page.getByTestId('project-name-input').fill(name)
  await page.getByTestId('project-description-input').fill('made by e2e')
  await page.getByTestId('project-form-submit').click()

  // EXACT title match (anchored regex) — `name` is a substring of `name (copy 1)`,
  // so a substring `hasText` would conflate the original with its duplicate.
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const exactTitle = (t: string) =>
    page.getByTestId('project-card-title').filter({
      hasText: new RegExp(`^${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
    })
  await expect(exactTitle(name)).toBeVisible()

  // Search filters to it (debounced).
  await page.getByTestId('projects-search').fill(name)
  await expect(exactTitle(name)).toBeVisible()
  await page.getByTestId('projects-search').fill('')
  await expect(exactTitle(name)).toBeVisible()

  // Duplicate via the card action menu → a "(copy 1)" appears.
  void esc
  const cardRoot = page
    .locator('[data-testid^="project-card-"]')
    .filter({ has: exactTitle(name) })
    .first()
  await cardRoot.getByRole('button', { name: /project actions/i }).click()
  await page.getByRole('menuitem', { name: /duplicate/i }).click()
  await expect(exactTitle(`${name} (copy 1)`)).toBeVisible()

  // Delete the original (with the confirm dialog). The copy stays.
  await cardRoot.getByRole('button', { name: /project actions/i }).click()
  await page.getByRole('menuitem', { name: /^delete$/i }).click()
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: /^delete$/i })
    .click()
  await expect(exactTitle(name)).toHaveCount(0)
  await expect(exactTitle(`${name} (copy 1)`)).toBeVisible()
})
