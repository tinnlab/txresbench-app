import { type APIRequestContext, expect, type Page } from '@playwright/test'
import { loginViaUi, waitForToken } from '../_owner'

// Local e2e helpers for the `mcp` (AI-controllable actions) suite. The owner
// identity and first-run setup come from `tests/e2e/_owner.ts` — the ONE owner
// for the whole directory (see that file for why a per-suite owner was a bug).
// Everything below is mcp-specific. The backend lives behind `vite preview`'s
// `/api` proxy at the configured `baseURL` (`playwright.config.ts`), so every
// request below uses a relative path.

export { OWNER, loginAsOwner, logout } from '../_owner'

/** Log in as an already-created user via the login form (fresh session). */
export async function loginAs(page: Page, username: string, password: string): Promise<void> {
  await loginViaUi(page, username, password)
  await waitForToken(page)
}

/** Wait for + return the persisted access token (the same token
 *  `@ziee/framework/api-client`'s `getAuthToken()` reads — see
 *  `Auth.store.ts` / `core/actions/engine.ts`). */
export async function authToken(page: Page): Promise<string> {
  return waitForToken(page)
}

/** Navigate to /projects and wait for it to render. */
export async function gotoProjects(page: Page): Promise<void> {
  await page.goto('/projects')
  await page.getByTestId('projects-page').waitFor({ state: 'visible', timeout: 20_000 })
}

/**
 * Create a user that LACKS `mcp::use` via the admin REST API.
 *
 * `mcp::use` is granted ONLY via the default "Users" group (see
 * `server/src/modules/mcp/migrations/202607200001_mcp_grants.sql`), and the
 * ADMIN-create endpoint (`POST /api/users`) always best-effort-adds the new
 * user to that default group regardless of the `permissions` field passed
 * (`modules/user/handlers.rs::create_user`) — so that path can't produce a
 * restricted account here. Self-service register has the same default-group
 * assignment (`create_local_user_with_default_group`), so the only reliable
 * way to strip `mcp::use` is register-then-explicitly-remove-from-Users,
 * mirroring `tests/e2e/jobs/helpers.ts::createRestrictedUser`.
 */
export async function createRestrictedUser(
  request: APIRequestContext,
  adminToken: string,
  username: string,
  password: string,
): Promise<void> {
  const hdr = { Authorization: `Bearer ${adminToken}` }

  const reg = await request.post('/api/auth/register', {
    data: { username, email: `${username}@cyto.test`, password, display_name: username },
  })
  expect(reg.ok(), `register ${username} -> ${reg.status()} ${await reg.text()}`).toBeTruthy()
  const userToken = (await reg.json()).access_token as string

  const me = await (
    await request.get('/api/auth/me', { headers: { Authorization: `Bearer ${userToken}` } })
  ).json()
  const userId = me.user.id as string

  const groups = await (await request.get('/api/groups', { headers: hdr })).json()
  const usersGroup = (groups.groups as Array<{ id: string; name: string }>).find(
    g => g.name === 'Users',
  )
  expect(usersGroup, 'default "Users" group must exist').toBeTruthy()

  const removed = await request.delete(`/api/groups/${userId}/${usersGroup!.id}/remove`, {
    headers: hdr,
  })
  expect(removed.ok(), `remove ${username} from Users group -> ${removed.status()}`).toBeTruthy()
}

/** Create a project via the REST API (need the id to drive `project.openProject`). */
export async function createProjectViaApi(
  request: APIRequestContext,
  token: string,
  name: string,
): Promise<{ id: string; name: string }> {
  const res = await request.post('/api/projects', {
    headers: { Authorization: `Bearer ${token}` },
    data: { name },
  })
  expect(res.ok(), `create project -> ${res.status()} ${await res.text()}`).toBeTruthy()
  return res.json()
}

/** One JSON-RPC 2.0 call against `POST /api/mcp` (CONTRACT.md). */
export async function mcpRpc(
  request: APIRequestContext,
  token: string,
  method: string,
  params: unknown,
): Promise<{ status: number; jsonrpc: Record<string, unknown> }> {
  const res = await request.post('/api/mcp', {
    headers: { Authorization: `Bearer ${token}` },
    data: { jsonrpc: '2.0', id: Date.now(), method, params },
  })
  return { status: res.status(), jsonrpc: await res.json() }
}

/**
 * `tools/call invoke_capability` for either a REST operation (e.g.
 * `Project.create`) or a frontend action (e.g. `project.openProject`). Both kinds
 * take their payload in the SAME `body` argument — `handlers.rs::InvokeArgs`
 * reuses the REST shape's `body` field as a frontend action's `params`
 * (`invoke_frontend`: `args.body.clone().unwrap_or_else(|| json!({}))`).
 */
export async function invokeCapability(
  request: APIRequestContext,
  token: string,
  operationId: string,
  body: Record<string, unknown> = {},
): Promise<{ status: number; result?: Record<string, unknown>; error?: Record<string, unknown> }> {
  const { status, jsonrpc } = await mcpRpc(request, token, 'tools/call', {
    name: 'invoke_capability',
    arguments: { operation_id: operationId, body },
  })
  return {
    status,
    result: jsonrpc.result as Record<string, unknown> | undefined,
    error: jsonrpc.error as Record<string, unknown> | undefined,
  }
}
