import { z } from 'zod'
import { Permissions } from '@/api-client/permissions'
import { defineAction } from '../defineAction'
import { Users } from '@/modules/user/stores/Users.store'

// The Users-admin identity CRUD mutations (#49) — every admin write declared ONCE as a
// permissioned `defineAction`, so it is EQUALLY drivable by a human (the Users page
// buttons / drawers / confirms) and by the AI agent (`invoke_capability`) — never a bare
// inline onClick reachable only by the human path (`.claude/skills/ai-controllable-actions`;
// admin-console-shell.md §non-negotiables, INV-1/INV-2). Each `run` is a THIN wrapper over
// the SAME `Users`-store method the human handler already called; the store owns the
// `ApiClient`/`SaasApiClient` call + list refetch, the action owns permission + AI-drivability.
//
// The permission on each action is the EXACT key that gated the human affordance before the
// conversion (INV-2) — behavior and gate are unchanged.
//
// Sole runtime import site: `src/modules/user/module.tsx` (unconditional — these are
// default-build permissions, unlike the saas-gated `userTierActions`).

const userId = z.string().min(1).describe('The user id to act on (the row `id`).')

defineAction({
  id: 'user.create',
  title: 'Create a user',
  permission: Permissions.UsersCreate,
  mutating: true,
  surfaces: { palette: true, ai: true },
  group: 'Admin',
  description:
    'Create a new user account with a username, email, password, and optional display name / permissions.',
  params: z.object({
    username: z.string().min(1).describe('The unique username.'),
    email: z.string().min(1).describe("The user's email address."),
    password: z.string().min(1).describe('The initial password.'),
    display_name: z.string().optional().describe('Optional human-friendly display name.'),
    permissions: z
      .array(z.string())
      .optional()
      .describe('Optional list of permission keys to grant the user.'),
  }),
  run: async ({ username, email, password, display_name, permissions }) =>
    Users.createUser({ username, email, password, display_name, permissions }),
})

defineAction({
  id: 'user.update',
  title: "Edit a user's profile",
  permission: Permissions.UsersEdit,
  mutating: true,
  surfaces: { palette: true, ai: true },
  group: 'Admin',
  description: "Update a user's username, display name, or active status.",
  params: z.object({
    id: userId,
    username: z.string().optional().describe('New username (omit to leave unchanged).'),
    display_name: z.string().optional().describe('New display name (omit to leave unchanged).'),
    is_active: z.boolean().optional().describe('New active status (omit to leave unchanged).'),
  }),
  run: async ({ id, username, display_name, is_active }) =>
    Users.updateUser(id, { username, display_name, is_active }),
})

defineAction({
  id: 'user.resetPassword',
  title: "Reset a user's password",
  permission: Permissions.UsersResetPassword,
  mutating: true,
  // Dangerous: replaces the user's credential.
  dangerous: true,
  surfaces: { palette: true, ai: true },
  group: 'Admin',
  description: "Set a new password for a user (an admin reset, not a self-service change).",
  params: z.object({
    id: userId,
    new_password: z.string().min(1).describe('The new password to set.'),
  }),
  run: async ({ id, new_password }) => Users.resetUserPassword(id, new_password),
})

defineAction({
  id: 'user.toggleActive',
  title: "Toggle a user's active status",
  permission: Permissions.UsersToggleStatus,
  mutating: true,
  surfaces: { palette: true, ai: true },
  group: 'Admin',
  description:
    "Activate or deactivate a user account (flips the current active status). A deactivated user cannot sign in.",
  params: z.object({ id: userId }),
  run: async ({ id }) => Users.toggleUserActiveStatus(id),
})

defineAction({
  id: 'user.delete',
  title: 'Delete a user',
  permission: Permissions.UsersDelete,
  mutating: true,
  // Destructive: removes the user account.
  dangerous: true,
  surfaces: { palette: true, ai: true },
  group: 'Admin',
  description: 'Permanently delete a user account.',
  params: z.object({ id: userId }),
  run: async ({ id }) => Users.deleteUser(id),
})
