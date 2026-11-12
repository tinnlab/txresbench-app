import { type APIRequestContext, expect } from '@playwright/test'
import { BACKEND, ownerApiToken } from '../_owner'

// Provenance-e2e helpers. Reuses the project module's PAGE-based login helpers
// (baseURL-relative → port-agnostic) and adds the API-request helpers the
// provenance specs need. The owner identity + first-run setup come from
// `tests/e2e/_owner.ts` — the ONE owner for the whole directory (see that file
// for why a per-suite owner was a bug). The backend base is env-overridable
// (default: the standard committed :3155) so a run can be isolated onto private
// ports/DB without editing the shared harness.
export {
  loginAsOwner,
  loginViaUi,
  loginMemberToProjects,
  MEMBER_PASSWORD,
} from '../project/_helpers'

export { BACKEND } from '../_owner'

// The seeded system "Users" group (projects::use + provenance::read).
const USERS_GROUP_ID = '79668b78-16ff-4d3f-80e6-afdbb3236dc9'

/** An admin API token (first-run setup or login), for REST-driving sub-users. */
export async function ownerToken(request: APIRequestContext): Promise<string> {
  return ownerApiToken(request)
}

/** Create a project owned by the admin. */
export async function createProject(request: APIRequestContext, admin: string, name: string) {
  const r = await request.post(`${BACKEND}/api/projects`, {
    headers: { authorization: `Bearer ${admin}` },
    data: { name, description: '' },
  })
  expect(r.ok(), `create project -> ${r.status()}`).toBeTruthy()
  return r.json()
}

/** Create a Users-group member (holds projects::use + provenance::read). */
export async function createMember(
  request: APIRequestContext,
  admin: string,
  username: string,
): Promise<string> {
  const r = await request.post(`${BACKEND}/api/users`, {
    headers: { authorization: `Bearer ${admin}` },
    data: { username, email: `${username}@txresbench.test`, password: 'memberPassw0rd!' },
  })
  expect(r.ok(), `create user -> ${r.status()}`).toBeTruthy()
  return (await r.json()).id
}

/**
 * Create a user who has `projects::use` (project access) but NOT `provenance::read`.
 * A normal member gets both via the Users group, so we: create a custom group
 * holding ONLY `projects::use` (no provenance::*), add the user to it, then strip
 * the Users group — isolating `provenance::read` away from a project-capable user.
 */
export async function createProjectsOnlyMember(
  request: APIRequestContext,
  admin: string,
  username: string,
): Promise<void> {
  const groupResp = await request.post(`${BACKEND}/api/groups`, {
    headers: { authorization: `Bearer ${admin}` },
    data: {
      name: `projects-only-${username}-${Date.now()}`,
      description: 'projects::use without provenance::read (negative-perm isolation)',
      permissions: ['projects::use'],
    },
  })
  expect(groupResp.ok(), `create group -> ${groupResp.status()}`).toBeTruthy()
  const groupId = (await groupResp.json()).id

  const userId = await createMember(request, admin, username)
  const assignResp = await request.post(`${BACKEND}/api/groups/assign`, {
    headers: { authorization: `Bearer ${admin}` },
    data: { user_id: userId, group_id: groupId },
  })
  expect(assignResp.ok(), `assign -> ${assignResp.status()}`).toBeTruthy()

  const removeResp = await request.delete(
    `${BACKEND}/api/groups/${userId}/${USERS_GROUP_ID}/remove`,
    { headers: { authorization: `Bearer ${admin}` } },
  )
  expect(removeResp.ok(), `remove from Users -> ${removeResp.status()}`).toBeTruthy()
}
