// @vitest-environment jsdom
//
// A SURFACE THAT REFUSES A USER MUST SAY WHY — asserted by reading the RENDERED DOM.
//
// ── The defect these tests were written against ───────────────────────────────────────────
// Eight drawers/forms answer a missing permission the same silent way: `<Form disabled>`
// greys every field AND the submit button is dropped from the footer entirely. The user is
// left with a form they cannot type into, no Save, and NO SENTENCE anywhere saying which
// permission they lack or that the surface is read-only. The settings PAGES already solved
// this (`JobSettingsPage` → `job-settings-readonly-alert`); the drawers never got it.
//
// ── Why the rendered DOM and not props/source ─────────────────────────────────────────────
// `disabled={!canX}` is a source fact; "the user is told why" is a behaviour. A prop
// assertion stays green if the Alert is rendered inside a branch that never mounts (exactly
// the shape of the `UserGroupsSettings` finding below, where the drawer is only reachable
// to a holder). So every assertion here queries the DOM after a real render, and every
// case carries a NEGATIVE CONTROL with the permission PRESENT — without which "there is
// always an alert" would pass just as well as the fix.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'

// ── the permission primitive (the one thing a jsdom unit cannot supply) ───────────────────
// A live set, flipped per test. `Can` and `usePermission` are re-exports of the SAME SDK
// module (`@/core/permissions/index.ts`), so one mock covers both gating layers.
let granted = new Set<string>()
vi.mock('@/core/permissions', () => ({
  usePermission: (perm: unknown) => granted.has(String(perm)),
  hasPermissionNow: (perm: unknown) => granted.has(String(perm)),
  Can: ({ permission, children }: { permission: unknown; children: unknown }) =>
    granted.has(String(permission)) ? (children as never) : null,
}))

// ── stores ────────────────────────────────────────────────────────────────────────────────
// Each drawer imports its store's DIRECT handle, so the mocks intercept the store MODULE
// specifiers. Every drawer is mounted OPEN — the read-only state is only observable once
// the panel is on screen.
const users = {
  creating: false,
  createUser: vi.fn(),
  updateUser: vi.fn(),
  resetUserPassword: vi.fn(),
}
vi.mock('@/modules/user/stores/Users.store', () => ({ Users: users }))

const userGroups = {
  groups: [{ id: 'g1', name: 'Analysts' }],
  total: 1,
  currentPage: 1,
  pageSize: 20,
  loadingGroups: false,
  error: null as string | null,
  loadUserGroups: vi.fn(),
  createUserGroup: vi.fn(),
  updateUserGroup: vi.fn(),
  deleteUserGroup: vi.fn(),
  assignUserToUserGroup: vi.fn(),
  clearError: vi.fn(),
}
vi.mock('@/modules/user/stores/UserGroups.store', () => ({ UserGroups: userGroups }))

vi.mock('@/modules/user/components/user/CreateUserDrawer.store', () => ({
  CreateUserDrawer: { isOpen: true, closeCreateUserDrawer: vi.fn() },
}))
vi.mock('@/modules/user/components/user/EditUserDrawer.store', () => ({
  EditUserDrawer: {
    isOpen: true,
    editingUser: { id: 'u1', username: 'ada', display_name: 'Ada', is_active: true },
    closeEditUserDrawer: vi.fn(),
  },
}))
vi.mock('@/modules/user/components/user/ResetPasswordDrawer.store', () => ({
  ResetPasswordDrawer: { isOpen: true, user: { id: 'u1', username: 'ada' }, closeResetPasswordDrawer: vi.fn() },
}))
vi.mock('@/modules/user/components/user/AssignGroupDrawer.store', () => ({
  AssignGroupDrawer: { isOpen: true, user: { id: 'u1', username: 'ada' }, closeAssignGroupDrawer: vi.fn() },
}))
vi.mock('@/modules/user/components/group/EditUserGroupDrawer.store', () => ({
  EditUserGroupDrawer: {
    isOpen: true,
    editingGroup: { id: 'g1', name: 'Analysts', description: '', permissions: [], is_active: true },
    closeUserGroupDrawer: vi.fn(),
  },
}))
vi.mock('@/modules/user/components/group/GroupMembersDrawer.store', () => ({
  GroupMembersDrawer: { isOpen: false, group: null, openGroupMembersDrawer: vi.fn(), closeGroupMembersDrawer: vi.fn() },
}))
vi.mock('@/modules/user/components/group/GroupMembersDrawer.tsx', () => ({
  GroupMembersDrawer: () => null,
}))

const projectDrawer = {
  formOpen: true,
  editing: null as { id: string; name: string; description: string; effective_permission: string } | null,
  closeForm: vi.fn(),
}
vi.mock('@/modules/project/stores/ProjectDrawer.store', () => ({ ProjectDrawer: projectDrawer }))
vi.mock('@/modules/project/stores/Projects.store', () => ({
  Projects: { mutating: false, createProject: vi.fn(), updateProject: vi.fn() },
}))

// ── the components under test (imported AFTER the mocks) ──────────────────────────────────
const { CreateUserDrawer } = await import('@/modules/user/components/user/CreateUserDrawer')
const { EditUserDrawer } = await import('@/modules/user/components/user/EditUserDrawer')
const { ResetPasswordDrawer } = await import('@/modules/user/components/user/ResetPasswordDrawer')
const { AssignGroupDrawer } = await import('@/modules/user/components/user/AssignGroupDrawer')
const { EditUserGroupDrawer } = await import('@/modules/user/components/group/EditUserGroupDrawer')
const { UserGroupsSettings } = await import('@/modules/user/components/group/UserGroupsSettings')
const { GroupEntityAssignmentDrawer } = await import(
  '@/components/common/group-entity-assignment/GroupEntityAssignmentDrawer'
)
const { ProjectFormDrawer } = await import('@/modules/project/components/ProjectFormDrawer')

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as never
  globalThis.matchMedia ??= ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false
    },
  })) as never
  ;(Element.prototype as { getAnimations?: () => unknown[] }).getAnimations ??= () => []
  ;(Element.prototype as { scrollIntoView?: () => void }).scrollIntoView ??= () => {}
  if (!globalThis.CSS) (globalThis as { CSS?: unknown }).CSS = { escape: (v: string) => v }
})

beforeEach(() => {
  granted = new Set<string>()
  projectDrawer.editing = null
})

afterEach(cleanup)

/** Everything currently in the document, portals included (a Drawer renders into body). */
const find = (testid: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${testid}"]`)

const mount = async (node: React.ReactNode): Promise<void> => {
  await act(async () => {
    render(node as never)
  })
}

/**
 * The whole contract for one refused surface:
 *   the alert EXISTS, and it SAYS something (a rendered-but-empty banner explains nothing).
 */
function expectExplained(testid: string): void {
  const el = find(testid)
  expect(
    el,
    `${testid}: a form whose every field is greyed and whose Save button is gone must state ` +
      'WHY — the user is otherwise refused with no reason anywhere on screen',
  ).not.toBeNull()
  expect(
    (el?.textContent ?? '').trim().length,
    `${testid}: the read-only banner rendered EMPTY — a blank banner is the same silence`,
  ).toBeGreaterThan(0)
}

/** NEGATIVE CONTROL — with the permission held, no banner (else "always an alert" passes). */
function expectNoBanner(testid: string): void {
  expect(
    find(testid),
    `${testid}: a user who HOLDS the permission must not be told the surface is read-only`,
  ).toBeNull()
}

describe('user drawers explain a permission-refused form', () => {
  it('CreateUserDrawer without users::create', async () => {
    await mount(<CreateUserDrawer />)
    expect(find('user-create-form'), 'the form must actually mount').not.toBeNull()
    expect(find('user-create-submit-button'), 'the defect: submit silently absent').toBeNull()
    expectExplained('user-create-readonly-alert')
  })

  it('NEGATIVE CONTROL — CreateUserDrawer with users::create', async () => {
    granted.add('users::create')
    await mount(<CreateUserDrawer />)
    expect(find('user-create-submit-button')).not.toBeNull()
    expectNoBanner('user-create-readonly-alert')
  })

  it('EditUserDrawer without users::edit', async () => {
    await mount(<EditUserDrawer />)
    expect(find('user-edit-form')).not.toBeNull()
    expectExplained('user-edit-readonly-alert')
  })

  it('NEGATIVE CONTROL — EditUserDrawer with users::edit', async () => {
    granted.add('users::edit')
    await mount(<EditUserDrawer />)
    expectNoBanner('user-edit-readonly-alert')
  })

  it('ResetPasswordDrawer without users::reset_password', async () => {
    await mount(<ResetPasswordDrawer />)
    expect(find('user-reset-password-form')).not.toBeNull()
    expectExplained('user-reset-password-readonly-alert')
  })

  it('NEGATIVE CONTROL — ResetPasswordDrawer with users::reset_password', async () => {
    granted.add('users::reset_password')
    await mount(<ResetPasswordDrawer />)
    expectNoBanner('user-reset-password-readonly-alert')
  })

  it('AssignGroupDrawer without groups::assign_users', async () => {
    await mount(<AssignGroupDrawer />)
    expect(find('user-assign-group-form')).not.toBeNull()
    expectExplained('user-assign-group-readonly-alert')
  })

  it('NEGATIVE CONTROL — AssignGroupDrawer with groups::assign_users', async () => {
    granted.add('groups::assign_users')
    await mount(<AssignGroupDrawer />)
    expectNoBanner('user-assign-group-readonly-alert')
  })

  it('EditUserGroupDrawer without groups::edit', async () => {
    await mount(<EditUserGroupDrawer />)
    expect(find('user-edit-group-form')).not.toBeNull()
    expectExplained('user-edit-group-readonly-alert')
  })

  it('NEGATIVE CONTROL — EditUserGroupDrawer with groups::edit', async () => {
    granted.add('groups::edit')
    await mount(<EditUserGroupDrawer />)
    expectNoBanner('user-edit-group-readonly-alert')
  })
})

describe('UserGroupsSettings create-group drawer', () => {
  // Reaching the refused state here needs a FIXTURE, because the opener is itself
  // `<Can permission={GroupsCreate}>`-gated: a user who never had groups::create can't open
  // this drawer at all. The state IS reachable — permissions are live (a `Session` sync
  // signal re-bootstraps /auth/me), so a holder who opens the drawer and is then removed
  // from the group keeps the panel open with `canCreate` now false. That is the case
  // asserted: open as a holder, revoke, re-render.
  const openThenRevoke = async (): Promise<void> => {
    granted.add('groups::create')
    const view = render(<UserGroupsSettings />)
    await act(async () => {
      fireEvent.click(find('user-groups-create-button') as HTMLElement)
    })
    expect(find('user-create-group-form'), 'the create drawer must be open').not.toBeNull()
    granted.delete('groups::create')
    await act(async () => {
      view.rerender(<UserGroupsSettings />)
    })
  }

  it('an open create-group drawer whose groups::create was revoked explains itself', async () => {
    await openThenRevoke()
    expect(find('user-create-group-submit-button'), 'the defect: submit silently absent').toBeNull()
    expectExplained('user-create-group-readonly-alert')
  })

  it('NEGATIVE CONTROL — while groups::create is still held there is no banner', async () => {
    granted.add('groups::create')
    await mount(<UserGroupsSettings />)
    await act(async () => {
      fireEvent.click(find('user-groups-create-button') as HTMLElement)
    })
    expect(find('user-create-group-submit-button')).not.toBeNull()
    expectNoBanner('user-create-group-readonly-alert')
  })
})

describe('GroupEntityAssignmentDrawer explains a read-only assignment list', () => {
  const props = {
    isOpen: true,
    group: { id: 'g1', name: 'Analysts' } as never,
    title: 'Assign System Skills',
    testidPrefix: 'skill-group-assign',
    allEntities: [{ id: 'e1' }],
    loadAssigned: () => Promise.resolve([]),
    save: () => Promise.resolve(),
    onClose: () => {},
    entityLabel: () => 'Skill One',
  }

  it('every row switch disabled and no Save → the reason must be on screen', async () => {
    await mount(<GroupEntityAssignmentDrawer {...props} canManage={false} />)
    expect(find('skill-group-assign-switch-e1')).not.toBeNull()
    expect(find('skill-group-assign-save-btn'), 'the defect: Save silently absent').toBeNull()
    expectExplained('skill-group-assign-readonly-alert')
  })

  it('NEGATIVE CONTROL — a manager gets Save and no banner', async () => {
    await mount(<GroupEntityAssignmentDrawer {...props} canManage />)
    expect(find('skill-group-assign-save-btn')).not.toBeNull()
    expectNoBanner('skill-group-assign-readonly-alert')
  })
})

describe('ProjectFormDrawer explains BOTH of its read-only causes', () => {
  it('without projects::use', async () => {
    await mount(<ProjectFormDrawer />)
    expect(find('project-form')).not.toBeNull()
    expect(find('project-form-submit'), 'the defect: submit silently absent').toBeNull()
    expectExplained('project-form-readonly-alert')
  })

  it('with projects::use but editing a project as a VIEWER', async () => {
    granted.add('projects::use')
    projectDrawer.editing = { id: 'p1', name: 'P', description: '', effective_permission: 'viewer' }
    await mount(<ProjectFormDrawer />)
    expect(find('project-form-submit')).toBeNull()
    expectExplained('project-form-readonly-alert')
  })

  it('NEGATIVE CONTROL — an owner editing their own project gets no banner', async () => {
    granted.add('projects::use')
    projectDrawer.editing = { id: 'p1', name: 'P', description: '', effective_permission: 'owner' }
    await mount(<ProjectFormDrawer />)
    expect(find('project-form-submit')).not.toBeNull()
    expectNoBanner('project-form-readonly-alert')
  })

  it('NEGATIVE CONTROL — creating a new project with projects::use gets no banner', async () => {
    granted.add('projects::use')
    await mount(<ProjectFormDrawer />)
    expect(find('project-form-submit')).not.toBeNull()
    expectNoBanner('project-form-readonly-alert')
  })
})
