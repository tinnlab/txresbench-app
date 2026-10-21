import { expect, test } from '@playwright/test'
import { gotoProjects, loginAsOwner } from '../mcp/helpers'

// TEST-10 (`.lifecycle/ai-actions/TESTS.md`) — running a `defineAction`
// FROM the command palette actually calls the SAME `runAction(id, params)`
// the AI agent engine calls (`@/core/actions/engine.ts`), so this drives the
// real app end to end (real router navigation, real store mutation) rather
// than asserting internal palette state.
//
// Two shapes, both real (PLAN.md ITEM-1):
//  - a no-param GLOBAL action (`nav.aiAccess`) runs immediately on select
//    (`CommandPalette.tsx::handleSelect` — `paramSchemaToFields` returns `[]`).
//  - a param-bearing action (`project.create`) shows the inline scalar-only
//    param form first (ITEM-14); submitting it runs the SAME action with the
//    filled params.

test.describe('command palette runs real actions', () => {
  test('selecting a no-param nav action navigates the app and closes the palette', async ({
    page,
  }) => {
    await loginAsOwner(page)
    await gotoProjects(page)
    expect(page.url()).not.toContain('/settings/ai-access')

    await page.keyboard.press('Control+K')
    await expect(page.getByTestId('command-palette-input')).toBeVisible()

    await page.getByTestId('command-palette-item-nav.aiAccess').click()

    // The real router bridge navigated the SPA (not just internal state) —
    // the target page's own content renders.
    await expect(page).toHaveURL(/\/settings\/ai-access$/)
    await expect(page.getByTestId('ai-access-page')).toBeVisible()

    // A no-param action runs-and-closes in one step (`runWithParams` calls
    // `closeCommandPalette()` on success) — never shows the param form.
    await expect(page.getByTestId('command-palette-param-form')).toHaveCount(0)
    await expect(page.getByTestId('command-palette-input')).toBeHidden()
  })

  test('submitting the param form for project.create creates the project and navigates to its detail page', async ({
    page,
  }) => {
    await loginAsOwner(page)
    await gotoProjects(page)

    const projectName = `Palette Project ${Date.now()}`

    await page.keyboard.press('Control+K')
    await expect(page.getByTestId('command-palette-input')).toBeVisible()

    await page.getByTestId('command-palette-item-project.create').click()

    // `project.create`'s zod params (`name` required, `description` optional)
    // produce a two-field inline form instead of an immediate run.
    const form = page.getByTestId('command-palette-param-form')
    await expect(form).toBeVisible()
    await expect(page.getByTestId('command-palette-input')).toHaveCount(0)

    await page.getByTestId('command-palette-param-name').fill(projectName)
    await page.getByTestId('command-palette-run').click()

    // The action's own `run` navigates to the freshly created project
    // (`ctx.navigate('/projects/${project.id}')`) via `Stores.Projects.createProject`
    // — a real backend mutation, not a mock. The detail page then redirects to its
    // default section, which is the full-bleed `workspace` (the workbench registers the
    // ONLY `project_nav` entry), hence the trailing `(\/.*)?`.
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}(\/.*)?$/)
    await expect(page.getByTestId('project-detail-page')).toBeVisible()
    // The created project's NAME is the payload assertion — it proves the value typed into
    // the param form reached the real mutation. It reads from the WORKBENCH header, which
    // is where a full-bleed project surfaces its identity. (Was `project-detail-name`, the
    // sectioned shell's header — unreachable on every project URL since a7c75ef1 made the
    // full-bleed workbench the default section.)
    await expect(page.getByTestId('workbench-project-name')).toHaveText(projectName)

    // Palette closed on the successful run.
    await expect(page.locator('[data-slot="dialog-content"]')).toHaveCount(0)

    // Independently confirm the project is real (persisted, listed) by going
    // back to /projects and finding it in the grid the store now reflects.
    // (Scoped to the project card title — the same name also appears in a
    // separate "recent projects" row, so an unscoped text locator is
    // ambiguous.)
    await gotoProjects(page)
    await expect(page.getByTestId('project-card-title').filter({ hasText: projectName })).toBeVisible()
  })
})
