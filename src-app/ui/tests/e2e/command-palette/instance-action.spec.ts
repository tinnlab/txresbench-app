import { expect, test } from '@playwright/test'
import { authToken, invokeCapability, loginAs } from '../mcp/helpers'
import { createMember, MEMBER_PASSWORD, ownerToken } from '../project/_helpers'

// TEST-11 (`.lifecycle/ai-actions/TESTS.md`) — the instance-action path end
// to end, on the real `/instance-harness` demonstrator page (PLAN.md ITEM-9;
// DECISIONS.md DEC-4): `useAction` registers the page's freshly-minted
// `view_id` into the instance registry on mount; THIS TEST acts as an
// external MCP client (mirrors `tests/e2e/mcp/ai-drives-ui.spec.ts`'s
// pattern) and drives `invoke_capability('harness.setValue', ...)` with the
// LIVE `view_id` read straight off the page — proving the real
// `useAction -> engine -> agent-channel -> dispatch -> stale-guard` path,
// not a mock of any part of it. A second invoke presenting the NOW-STALE
// token must be rejected `STALE_STATE`.
//
// ── Why this spec has its OWN user (and must keep it) ────────────────────────
//
// The agent channel binds exactly ONE control session PER USER —
// `server/src/modules/mcp/agent_channel.rs`: `sessions: HashMap<user_id,
// ControlSession>`, where `bind_session` does a plain `insert` ("One session per
// user (a reconnect REBINDS rather than adding a second entry)"), and
// `current_sender(user_id)` re-resolves that single binding on every dispatch.
// Every authenticated `mcp::use` holder's browser auto-connects the engine
// headlessly (`modules/actions/module.tsx`), and `tests/e2e/_owner.ts`
// deliberately gives the whole directory ONE owner — so at `--workers=2` both
// workers' pages are the SAME user, the one that navigated most recently owns the
// binding, and an `invoke_capability` can land in the OTHER worker's page. Its
// instance registry has never heard of this page's `view_id`, so the invoke comes
// back `NOT_FOUND: no live instance "<view_id>"` — measured: 5/5 green at
// `--workers=1`, reproducibly red at `--workers=2`, failing on whichever of the two
// invokes happened to be dispatched while the other page held the binding.
//
// That is the server's intended design (one live UI per user), so the fix is here:
// a dedicated Users-group member owns its own control session and cannot be
// displaced by any other spec. Reverting to the shared owner reintroduces the race.

test('AI-driven instance invoke mutates the live harness instance; a stale token is rejected', async ({
  page,
  request,
}) => {
  const admin = await ownerToken(request)
  const username = `harness-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await createMember(request, admin, username)
  await loginAs(page, username, MEMBER_PASSWORD)

  await page.goto('/instance-harness')
  await expect(page.getByTestId('instance-harness-page')).toBeVisible()

  // The agent engine auto-connects for any authenticated `mcp::use` holder
  // (started headlessly by `modules/actions/module.tsx`) — confirm it before
  // dispatching, per ARCHITECTURE.md Layer 7: "no live control session ->
  // FRONTEND_NOT_CONNECTED".
  await page.goto('/settings/ai-access')
  await expect(page.getByTestId('ai-access-connection-status')).toContainText('Connected', {
    timeout: 20_000,
  })
  await page.goto('/instance-harness')
  await expect(page.getByTestId('instance-harness-page')).toBeVisible()

  const viewId = await page.getByTestId('instance-harness-view-id').innerText()
  const initialToken = await page.getByTestId('instance-harness-token').innerText()
  await expect(page.getByTestId('instance-harness-value')).toHaveText('0')

  const token = await authToken(page)

  // ---- 1. A correctly-tokened AI-driven mutation succeeds end to end. ----
  const first = await invokeCapability(request, token, 'harness.setValue', {
    view_id: viewId,
    value: 7,
    expected: initialToken,
  })
  expect(first.status, 'invoke_capability HTTP status').toBe(200)
  expect(first.result?.isError, `unexpected error: ${JSON.stringify(first.result)}`).toBeFalsy()
  const firstStructured = first.result?.structuredContent as
    | { result?: { value?: number; _state_token?: string } }
    | undefined
  expect(firstStructured?.result?.value).toBe(7)
  const nextToken = firstStructured?.result?._state_token
  expect(nextToken).toBeTruthy()
  expect(nextToken).not.toBe(initialToken)

  // The LIVE, untouched-by-this-test browser page reflects the AI's mutation
  // — the same handler the local "Increment (local)" button would have
  // called, driven instead by the agent channel.
  await expect(page.getByTestId('instance-harness-value')).toHaveText('7')
  await expect(page.getByTestId('instance-harness-token')).toHaveText(nextToken!)

  // ---- 2. Re-using the NOW-STALE original token is rejected. ----
  const stale = await invokeCapability(request, token, 'harness.setValue', {
    view_id: viewId,
    value: 99,
    expected: initialToken, // stale — the live token already advanced above
  })
  expect(stale.status).toBe(200)
  expect(stale.result?.isError, 'a stale expected token must be rejected').toBeTruthy()
  const staleStructured = stale.result?.structuredContent as
    | { ok?: boolean; error?: string }
    | undefined
  expect(staleStructured?.ok).toBe(false)
  expect(staleStructured?.error ?? '').toContain('STALE_STATE')

  // The rejected write must NOT have applied — the value/token are unchanged
  // from step 1.
  await expect(page.getByTestId('instance-harness-value')).toHaveText('7')
  await expect(page.getByTestId('instance-harness-token')).toHaveText(nextToken!)
})
