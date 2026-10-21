import { z } from 'zod'
import { Permissions } from '@/api-client/permissions'
import { defineAction } from '../defineAction'
import { UserGroups } from '@/modules/user/stores/UserGroups.store'

// The user-group management mutations (#49) — every admin write declared ONCE as a
// permissioned `defineAction`, so each is EQUALLY drivable by a human (the Groups page +
// the assign/edit drawers) and by the AI agent (`invoke_capability`) — never a bare inline
// onClick (`.claude/skills/ai-controllable-actions`; INV-1/INV-2). Each `run` is a THIN
// wrapper over the SAME `UserGroups`-store method the human handler already called; the
// permission is the EXACT key that gated the human affordance (INV-2).
//
// Sole runtime import site: `src/modules/user/module.tsx` (unconditional — default-build perms).

const groupId = z.string().min(1).describe('The user-group id to act on.')
const userIdRef = z.string().min(1).describe('The user id.')

defineAction({
  id: 'group.assignUser',
  title: 'Assign a user to a group',
  permission: Permissions.GroupsAssignUsers,
  mutating: true,
  surfaces: { palette: true, ai: true },
  group: 'Admin',
  description: "Add a user to a user group (grants the group's permissions to that user).",
  params: z.object({ user_id: userIdRef, group_id: groupId }),
  run: async ({ user_id, group_id }) => UserGroups.assignUserToUserGroup(user_id, group_id),
})

defineAction({
  id: 'group.removeUser',
  title: 'Remove a user from a group',
  permission: Permissions.GroupsAssignUsers,
  mutating: true,
  // Destructive: revokes the group's permissions from the user.
  dangerous: true,
  surfaces: { palette: true, ai: true },
  group: 'Admin',
  description: "Remove a user from a user group.",
  params: z.object({ user_id: userIdRef, group_id: groupId }),
  run: async ({ user_id, group_id }) => UserGroups.removeUserFromUserGroup(user_id, group_id),
})

defineAction({
  id: 'group.create',
  title: 'Create a user group',
  permission: Permissions.GroupsCreate,
  mutating: true,
  surfaces: { palette: true, ai: true },
  group: 'Admin',
  description: 'Create a new user group with a name, optional description, and a permission set.',
  params: z.object({
    name: z.string().min(1).describe('The group name.'),
    description: z.string().optional().describe('Optional description.'),
    permissions: z.array(z.string()).describe('The permission keys the group grants.'),
  }),
  run: async ({ name, description, permissions }) =>
    UserGroups.createUserGroup({ name, description, permissions }),
})

defineAction({
  id: 'group.update',
  title: 'Edit a user group',
  permission: Permissions.GroupsEdit,
  mutating: true,
  surfaces: { palette: true, ai: true },
  group: 'Admin',
  description: "Update a group's name, description, active status, or permission set.",
  params: z.object({
    id: groupId,
    name: z.string().optional().describe('New name (omit to leave unchanged).'),
    description: z.string().optional().describe('New description (omit to leave unchanged).'),
    is_active: z.boolean().optional().describe('New active status (omit to leave unchanged).'),
    permissions: z
      .array(z.string())
      .optional()
      .describe('New permission set (omit to leave unchanged).'),
  }),
  run: async ({ id, name, description, is_active, permissions }) =>
    UserGroups.updateUserGroup(id, { name, description, is_active, permissions }),
})

defineAction({
  id: 'group.delete',
  title: 'Delete a user group',
  permission: Permissions.GroupsDelete,
  mutating: true,
  // Destructive: removes the group.
  dangerous: true,
  surfaces: { palette: true, ai: true },
  group: 'Admin',
  description: 'Permanently delete a user group.',
  params: z.object({ id: groupId }),
  run: async ({ id }) => UserGroups.deleteUserGroup(id),
})
