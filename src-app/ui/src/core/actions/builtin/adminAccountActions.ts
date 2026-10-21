import { z } from 'zod'
import { Permissions } from '@/api-client/permissions'
import { defineAction } from '../defineAction'
import { AdminAccounts } from '@/modules/admin-accounts/stores/AdminAccounts.store'
import { AccountMembers } from '@/modules/admin-accounts/stores/AccountMembers.store'

// The Accounts-admin mutations (#44, ITEM-7) — every user-triggerable account
// mutation declared ONCE as a permissioned `defineAction`, so it is EQUALLY
// drivable by a human (button / ⌘K palette) and by the AI agent
// (`invoke_capability`) — never a bare inline onClick only the human path can
// reach (`.claude/skills/ai-controllable-actions`). Each `run` is a THIN wrapper
// that delegates to the SAME store method a human handler calls; the store owns
// the mutation + refetch, the action owns permission + AI-drivability.
//
// Import this module for its side effect to register the actions — the sole
// import site is `src/modules/admin-accounts/module.tsx`.

const roleSchema = z
  .enum(['member', 'admin', 'owner'])
  .describe('The coarse account role: member | admin | owner.')

defineAction({
  id: 'admin.account.createOrg',
  title: 'Create an organization account',
  // The SAME permission a human needs to see the Create button (the `<Can>` gate
  // + the `POST /api/accounts` route are on `account::manage`).
  permission: Permissions.AccountManage,
  mutating: true,
  surfaces: { palette: true, ai: true },
  group: 'Admin',
  description:
    'Create a new organization account, optionally seeding its owner (defaults to the caller).',
  params: z.object({
    name: z
      .string()
      .min(1)
      .describe('The organization display name (non-empty).'),
    owner_id: z
      .string()
      .optional()
      .describe('User id to seed as the owner member. Omit to default to the caller.'),
  }),
  run: async ({ name, owner_id }) => {
    // Thin wrapper — the SAME store method the Create drawer's submit calls.
    return AdminAccounts.createOrg({ name, ...(owner_id ? { owner_id } : {}) })
  },
})

defineAction({
  id: 'admin.account.addMember',
  title: 'Add a member to an account',
  permission: Permissions.AccountManage,
  mutating: true,
  surfaces: { palette: true, ai: true },
  group: 'Admin',
  description: 'Add a user to an account with a coarse role (member/admin/owner).',
  params: z.object({
    user_id: z.string().min(1).describe('The user to add.'),
    role: roleSchema,
  }),
  run: async ({ user_id, role }) => {
    return AccountMembers.addMember(user_id, role)
  },
})

defineAction({
  id: 'admin.account.setMemberRole',
  title: "Change a member's role on an account",
  permission: Permissions.AccountManage,
  mutating: true,
  surfaces: { palette: true, ai: true },
  group: 'Admin',
  description:
    "Change an existing member's coarse role. The backend refuses (422 LAST_OWNER) demoting the sole owner.",
  params: z.object({
    user_id: z.string().min(1).describe('The member to change.'),
    role: roleSchema,
  }),
  run: async ({ user_id, role }) => {
    return AccountMembers.setRole(user_id, role)
  },
})

defineAction({
  id: 'admin.account.removeMember',
  title: 'Remove a member from an account',
  permission: Permissions.AccountManage,
  mutating: true,
  // Destructive — the palette interposes a confirm; the app's own remove
  // affordance already wraps this in a `Confirm` (mirroring the Users list).
  dangerous: true,
  surfaces: { palette: true, ai: true },
  group: 'Admin',
  description:
    'Remove a user from an account. The backend refuses (422 LAST_OWNER) removing the sole owner.',
  params: z.object({
    user_id: z.string().min(1).describe('The member to remove.'),
  }),
  run: async ({ user_id }) => {
    return AccountMembers.removeMember(user_id)
  },
})
