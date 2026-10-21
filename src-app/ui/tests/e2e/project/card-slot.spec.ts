import { expect, test } from '@playwright/test'
import { BACKEND, loginAsOwner, ownerToken } from './_helpers'

// TEST-6: the ProjectCard renders the `card_tags` slot, now driven by the project
// EXTENSION registry (which superseded the old `projectCardTags` placeholder). The
// dataset project-extension contributes an "N datasets" tag — proving the FE
// registry + slots + glob auto-discovery + the dataset extension + the card
// wiring end-to-end. The old duplicated `project-dataset-count` Tag is gone.
test('project card renders the dataset extension card tag', async ({ page, request }) => {
  const admin = await ownerToken(request)
  const name = `Slot Project ${Date.now()}`

  // Seed a project + a dataset + attach, via REST.
  const project = await request
    .post(`${BACKEND}/api/projects`, {
      headers: { authorization: `Bearer ${admin}` },
      data: { name, description: '' },
    })
    .then(r => r.json())
  const ds = await request
    .post(`${BACKEND}/api/datasets`, {
      headers: { authorization: `Bearer ${admin}` },
      data: { name: `ds-${Date.now()}` },
    })
    .then(r => r.json())
  const attach = await request.post(
    `${BACKEND}/api/projects/${project.id}/datasets/${ds.id}`,
    { headers: { authorization: `Bearer ${admin}` } },
  )
  expect(attach.ok()).toBeTruthy()

  await loginAsOwner(page)

  const cardRoot = page
    .locator('[data-testid^="project-card-"]')
    .filter({ has: page.getByTestId('project-card-title').filter({ hasText: name }) })
    .first()

  // The slot container seam is present, and the dataset extension's tag renders.
  await expect(cardRoot.getByTestId('project-card-tags')).toHaveCount(1)
  await expect(cardRoot.getByTestId('project-card-dataset-tag')).toContainText(/1 dataset/i)
  // The permission badge still renders; the old bespoke count Tag is gone.
  await expect(cardRoot.getByTestId('project-permission-badge')).toHaveText(/owner/i)
  await expect(cardRoot.getByTestId('project-dataset-count')).toHaveCount(0)
})
