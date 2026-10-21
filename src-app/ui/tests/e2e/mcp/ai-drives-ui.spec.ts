import { expect, test } from '@playwright/test'
import { authToken, createProjectViaApi, invokeCapability, loginAsOwner } from './helpers'

// TEST-18 [THE FLAGSHIP]: a real logged-in browser (the frontend action
// engine — `src/core/actions/engine.ts` — auto-connects the agent SSE stream
// for any authenticated `mcp::use` holder, started headlessly by
// `modules/actions/module.tsx` regardless of which page is open) while THIS
// TEST acts as the external MCP client: `POST /api/mcp` `tools/call
// invoke_capability` of the frontend action `project.openProject` (CONTRACT.md /
// `defineAction` in `src/core/actions/builtin/appActions.ts`) must make the
// LIVE BROWSER NAVIGATE to `/projects/:id` — proving `defineAction` + the
// engine + the agent channel end-to-end in the real UI, not a mock of any
// part of that path.
//
// The owner (first-run admin) holds every permission (`mcp::use` +
// `projects::use`), so its own already-authenticated token is both the
// browser's session AND the "external assistant"'s credential here — the
// dispatch is routed by `user_id` (agent_channel.rs), not by which HTTP
// request carried the bearer, so this is a faithful proof of the channel.

test('invoking project.openProject over /api/mcp navigates the real connected browser', async ({
  page,
  request,
}) => {
  await loginAsOwner(page) // lands on /projects; the agent engine auto-connects

  // Confirm the engine's OWN SSE connection (not the pairing flow — that's a
  // separate mint-a-code affordance) is actually live before dispatching, per
  // CONTRACT.md: "No live control session at dispatch → FRONTEND_NOT_CONNECTED".
  await page.goto('/settings/ai-access')
  await expect(page.getByTestId('ai-access-connection-status')).toContainText('Connected', {
    timeout: 20_000,
  })

  const token = await authToken(page)
  const project = await createProjectViaApi(request, token, `AI-Drive ${Date.now()}`)

  const { status, result, error } = await invokeCapability(request, token, 'project.openProject', {
    project_id: project.id,
  })
  expect(status, `invoke_capability HTTP status`).toBe(200)
  expect(error, `unexpected JSON-RPC error: ${JSON.stringify(error)}`).toBeUndefined()
  expect(
    result?.isError,
    `frontend-action tool call reported an error: ${JSON.stringify(result)}`,
  ).toBeFalsy()

  // The live browser — untouched by this test's own navigation calls — must
  // have moved to the project's detail route as a side effect of the AI's call.
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}`), { timeout: 20_000 })
  await expect(page.getByTestId('project-detail-page')).toBeVisible()
})
