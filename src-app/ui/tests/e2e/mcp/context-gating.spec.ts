import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { authToken, createProjectViaApi, invokeCapability, loginAsOwner } from './helpers'

// TEST-108 (PLAN.md ITEM-4) — the AI path of context gating, end-to-end through
// the REAL registry → engine → agent channel (no mock of any part):
//   • `invoke_capability('analysis.launch')` while the live browser is NOT in
//     the workbench relays the engine's `CONTEXT_INACTIVE: workbench` verdict as
//     an `isError` tool result (the context guard fires BEFORE the instance
//     guard, so even a placeholder `view_id` gets `CONTEXT_INACTIVE`);
//   • once the browser navigates into the workbench (the section registers the
//     `'workbench'` context active + its live instance), the SAME invoke no
//     longer returns `CONTEXT_INACTIVE`.
//
// RUNS in Phase 8 (per TESTS.md) — the "succeeds once active" leg depends on the
// W2 dock registering the live `'workbench'` instance whose `view_id` the invoke
// targets (resolved here via the `views.list` world-model read).

/** Flatten a tool result's content + structuredContent to searchable text. */
function resultText(result: Record<string, unknown> | undefined): string {
  return JSON.stringify(result ?? {})
}

/** Resolve the live `view_id` of the first instance of `type` via `views.list`. */
async function viewIdOfType(
  request: APIRequestContext,
  token: string,
  type: string,
): Promise<string | undefined> {
  const { result } = await invokeCapability(request, token, 'views.list', {})
  const content = (result?.content as Array<{ type: string; text?: string }> | undefined) ?? []
  const text = content.find(c => c.type === 'text')?.text
  const raw = text ?? resultText(result)
  try {
    const parsed = JSON.parse(raw) as unknown
    const list = Array.isArray(parsed)
      ? parsed
      : ((parsed as { views?: unknown[]; instances?: unknown[] }).views ??
        (parsed as { instances?: unknown[] }).instances ??
        [])
    return (list as Array<{ id?: string; type?: string }>).find(v => v.type === type)?.id
  } catch {
    return undefined
  }
}

test('invoke_capability(analysis.launch) is CONTEXT_INACTIVE off the workbench and passes the guard on it', async ({
  page,
  request,
}) => {
  await loginAsOwner(page) // lands on /projects; the agent engine auto-connects

  // The engine's own SSE control connection must be live before dispatching.
  await page.goto('/settings/ai-access')
  await expect(page.getByTestId('ai-access-connection-status')).toContainText('Connected', {
    timeout: 20_000,
  })
  const token = await authToken(page)

  // ── Off the workbench: the context guard rejects BEFORE the instance guard.
  const off = await invokeCapability(request, token, 'analysis.launch', {
    view_id: 'placeholder',
    analysis_id: 'demo',
  })
  expect(off.status, 'invoke HTTP status').toBe(200)
  expect(off.error, `unexpected JSON-RPC error: ${JSON.stringify(off.error)}`).toBeUndefined()
  expect(off.result?.isError, `expected an isError result: ${resultText(off.result)}`).toBeTruthy()
  const offText = resultText(off.result)
  expect(offText).toContain('CONTEXT_INACTIVE')
  expect(offText).toContain('workbench')

  // ── Navigate the live browser into the workbench → `'workbench'` context
  //    active + its instance registered.
  const project = await createProjectViaApi(request, token, `Ctx-MCP ${Date.now()}`)
  await page.goto(`/projects/${project.id}/workspace`)
  await page.getByTestId('workbench-shell').waitFor({ state: 'visible', timeout: 20_000 })

  // Resolve the live workbench instance's view_id (world-model read).
  const workbenchViewId = await viewIdOfType(request, token, 'workbench')
  expect(workbenchViewId, 'a live workbench instance view_id must be resolvable').toBeTruthy()

  // ── On the workbench: the SAME invoke no longer returns CONTEXT_INACTIVE
  //    (the context guard now passes; the run pane opens).
  const on = await invokeCapability(request, token, 'analysis.launch', {
    view_id: workbenchViewId as string,
    analysis_id: 'demo',
  })
  expect(on.status).toBe(200)
  expect(resultText(on.result)).not.toContain('CONTEXT_INACTIVE')
})
