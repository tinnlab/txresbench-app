import { expect, type APIRequestContext, type Page } from '@playwright/test'
import { ownerToken } from '../project/_helpers'

// Shared harness for the workbench (RegionShell) e2e specs. The workbench shell + `demo-analysis`
// built-in mount on a real project's `/workspace`. Panes live in the fixed 4-region shell
// (RegionShell): each carries a stable `region-tab-<id>` (its tab) and, when active, a
// `region-pane-body-<id>` (its body). (The former free-form dock — `workbench-pane-frame-<id>`
// grip chrome + cross-window grip-drag — was removed; its specs went with it.)

// The backend base for API-request helpers. Imported from `_owner`, which derives it from
// `E2E_BACKEND` — the value `playwright.config.ts` assigns from the port it RESOLVED for this
// run. There is deliberately no `?? 'http://127.0.0.1:3155'` fallback any more: a committed
// default is only correct while every run uses the same port, and the moment ports became
// per-worktree it would have aimed these helpers at whatever else happened to be on :3155.
import { BACKEND } from '../_owner'
// Re-exported: the specs in this directory import it from here.
export { BACKEND }

export async function createProject(request: APIRequestContext, name: string): Promise<string> {
  const admin = await ownerToken(request)
  const r = await request.post(`${BACKEND}/api/projects`, {
    headers: { authorization: `Bearer ${admin}` },
    data: { name, description: '' },
  })
  expect(r.ok()).toBeTruthy()
  return (await r.json()).id
}

export async function openWorkbench(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}/workspace`)
  const shell = page.getByTestId('workbench-shell')
  await shell.waitFor({ state: 'visible', timeout: 20_000 })
  // Below 768px `WorkbenchShell` renders `MobileShell` instead of `RegionShell` — the center
  // canvas stays the permanent hero and the edge docks become sheets, so there are no region
  // TABS and therefore no `region-pane-body-<id>`. The mobile shell marks itself, so a
  // narrow-viewport spec waits for the equivalent center surface (`PlacedArea('center')`)
  // rather than for a desktop-only node that can never appear. Both branches assert the same
  // thing — the center region mounted its body — in the vocabulary that branch actually uses.
  const mobile = (await shell.getAttribute('data-workbench-mobile')) === 'true'
  const body = mobile
    ? page.locator('[data-testid^="workbench-area-center"]')
    : page.locator('[data-testid^="region-pane-body-"]')
  await body.first().waitFor({ state: 'visible', timeout: 20_000 })
}

/** Collect console + page errors (dock interactions must not throw). */
// A transient network race (the app's own background loads racing a busy preview backend under a
// full parallel suite) surfaces as `TypeError: Failed to fetch` — environmental noise, NOT the
// dock logic these specs assert. Drop only that class; every real console error is captured.
const TRANSIENT_NETWORK_ERROR = /Failed to fetch|NetworkError|ERR_CONNECTION|Load failed/i
export function trackErrors(page: Page): { errors: string[] } {
  const bag = { errors: [] as string[] }
  const keep = (text: string) => {
    if (!TRANSIENT_NETWORK_ERROR.test(text)) bag.errors.push(text)
  }
  page.on('console', m => {
    if (m.type() === 'error') keep(m.text())
  })
  page.on('pageerror', e => keep(String(e)))
  return bag
}
