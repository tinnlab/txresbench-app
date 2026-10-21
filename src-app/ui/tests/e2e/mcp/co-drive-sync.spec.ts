import { expect, test } from '@playwright/test'
import { authToken, gotoProjects, invokeCapability, loginAsOwner } from './helpers'

// TEST-19: co-drive — with the projects list already open, invoking the
// backend mutation `Project.create` over `/api/mcp` (`tools/call
// invoke_capability`, REST kind — CONTRACT.md / `handlers.rs::invoke_rest`)
// must make the open list update LIVE, WITHOUT a page reload. `invoke_rest`
// forwards the caller's bearer over loopback but deliberately does NOT
// forward `x-sync-connection-id` ("an AI-driven mutation SHOULD reach the
// acting user's other open devices" — `handlers.rs`), so the resulting sync
// event's `origin` is `None` and this tab's own SSE connection is NOT
// self-echo-suppressed — mirrors `project/sync-live.spec.ts`'s cross-tab proof,
// but here the "other device" driving the mutation is the AI channel itself.

test('invoking Project.create over /api/mcp updates the open projects list live, no reload', async ({
  page,
  request,
}) => {
  await loginAsOwner(page)
  await gotoProjects(page)
  const token = await authToken(page)

  const name = `Co-drive ${Date.now()}`
  const { status, result, error } = await invokeCapability(request, token, 'Project.create', {
    name,
  })
  expect(status, `invoke_capability HTTP status`).toBe(200)
  expect(error, `unexpected JSON-RPC error: ${JSON.stringify(error)}`).toBeUndefined()
  expect(
    result?.isError,
    `Project.create tool call reported an error: ${JSON.stringify(result)}`,
  ).toBeFalsy()

  // No reload anywhere in this test — the new project must appear via the sync
  // fan-out driving the projects store's live refetch.
  await expect(page.getByTestId('project-card-title').filter({ hasText: name })).toBeVisible({
    timeout: 20_000,
  })
})
