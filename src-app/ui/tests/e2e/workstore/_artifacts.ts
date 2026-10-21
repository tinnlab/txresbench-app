import { expect, type Page } from '@playwright/test'

// Shared workstore-e2e helpers. The Artifacts surface is a workbench PANE, not a project
// SECTION: commit a7c75ef1 made the project detail page the full-bleed workbench and the
// workstore project-extension stopped contributing a `project_nav` entry (it contributes
// only `detail_panels`, rendered as the `artifacts` pane by `panes.tsx`'s `SectionPane`).
//
// The consequence both specs in this directory now encode: `/projects/<id>/artifacts` is
// NOT an artifacts URL any more. `ProjectDetailPage` sees a `:section` that matches no
// registered nav entry and REDIRECTS to the default section (`workspace`) — for EVERY
// user, permitted or not. Asserting `toHaveCount(0)` on `project-artifacts-card` at that
// URL therefore passes for a fully-permitted owner too; it is not a permission assertion.

/** The one URL that actually reaches the workbench. */
export async function openWorkspace(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}/workspace`)
  await page.getByTestId('workbench-shell').waitFor({ state: 'visible', timeout: 30_000 })
}

/** Open the right region's "+" (add-pane) menu — one of only two user affordances that
 *  open a pane BY NAME (the other is the centre empty-picker). */
export async function openAddPaneMenu(page: Page): Promise<void> {
  const add = page.getByTestId('region-add-pane-right')
  await expect(add).toBeVisible({ timeout: 30_000 })
  await add.click()
  await expect(page.getByTestId('region-add-pane-menu-right')).toBeVisible()
}

/** Open the Artifacts pane through the REAL user affordance (the "+" menu) and wait for
 *  the workstore panel to mount inside it. Returns nothing — callers assert. */
export async function openArtifactsPane(page: Page): Promise<void> {
  await openAddPaneMenu(page)
  const item = page.getByTestId('region-add-pane-item-artifacts')
  await expect(item, 'the "+" menu offers the Artifacts pane').toHaveCount(1)
  // A PLAIN POINTER CLICK — the affordance a user has.
  //
  // This used to be `focus()` + Enter, because the toast layer and this menu are both anchored
  // bottom-right and the toast won the overlap: sonner's layer is `z-index: 999999999`, above
  // every kit overlay. Worse, the obstruction was SELF-SUSTAINING — sonner expands its stack
  // while the pointer is over it, so a click aimed at a covered item held the cursor exactly
  // where it kept the stack expanded, and Playwright's auto-retry could not break out (measured
  // at 1367 retries across 12.5 minutes on an item it reported "visible, enabled and stable"
  // every single time). Whether a toast happened to be on screen was a timing accident, which is
  // why this passed alone and failed inside a full-directory sweep.
  //
  // The keyboard activation was a harness mitigation for an APP defect, and the app defect is
  // fixed: the notification layer now sits below the kit's overlay floor (`src/index.css`), so an
  // open menu paints — and receives pointer events — above any toast. Guarded by
  // `tests/e2e/14-workbench/toast-menu-stacking.spec.ts`, which raises a real permanent toast,
  // parks the pointer on it, and asserts every menu item is the topmost element at its own
  // coordinates. Clicking here again means this helper is once more evidence that the affordance
  // works for a mouse.
  //
  // (Still NOT a toast dismissal: a helper may not reach into DOM the app owns — removing toast
  // nodes under React's feet is what once turned this suite's second run into an app-wide
  // "Something went wrong", see `14-declarative-qc/_seed.ts::runQcToCompletion`.)
  await item.click()

  // A region renders only its ACTIVE pane's body, so "the pane was added" and "the pane is
  // visible" are different claims. When they diverge, the bare `toBeVisible` failure names
  // neither — it says an element is missing and leaves the reader to guess whether the add was
  // refused, landed in another region, or landed unfocused. So the failure carries the region
  // state that distinguishes those.
  //
  // Gathered ON FAILURE, in a catch. `expect(value, message)` takes a STRING, so the lazy
  // builder this used to pass as `message` was never called and none of the state below ever
  // reached the report — the reader got exactly the bare "element is missing" this comment says
  // it exists to avoid. It typechecked nowhere, because the tests tree was outside `tsc`.
  // A catch is also the only place the state is worth reading: at the moment it actually failed.
  const body = page.getByTestId('workbench-section-pane-artifacts')
  try {
    await expect(body).toBeVisible({ timeout: 30_000 })
  } catch (err) {
    const tabs = await page
      .locator('[data-testid="region-strip-right"] [role="tab"]')
      .evaluateAll(els =>
        (els as HTMLElement[]).map(e => ({
          name: e.getAttribute('aria-label'),
          selected: e.getAttribute('aria-selected'),
        })),
      )
      .catch(() => [] as { name: string | null; selected: string | null }[])
    throw new Error(
      'the Artifacts pane never rendered its body. Right-region tabs and which is active: ' +
        JSON.stringify(tabs) +
        ' — a tab named "Artifacts" that is NOT selected means the pane was added and then ' +
        'something else took the region back; no Artifacts tab at all means the add itself was ' +
        `refused.\n\nunderlying: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}