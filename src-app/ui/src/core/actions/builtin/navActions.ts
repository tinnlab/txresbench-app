import { z } from 'zod'
import { Permissions } from '@/api-client/permissions'
import { defineAction } from '../defineAction'

// Slice 2 (PLAN.md ITEM-2) — registers navigation to txr's key SETTINGS
// pages as global `defineAction`s, delegating to `ctx.navigate` (the same
// primitive `app.navigate` uses, see `./appActions.ts`). Each action's
// `permission` is the EXACT permission the target route itself requires
// (its module's `routes[].permission` — see e.g. `modules/mcp/module.tsx`,
// `modules/jobs/module.tsx`), so the palette + the AI agent only ever
// offer a destination the user can actually open. `/projects` and
// project-domain navigation live in `./projectActions.ts` (`project.list` /
// `project.openProject`), not here. `/settings/general` has no route-level
// permission gate (any authenticated user), so it has no natural
// `Permissions` value to require and is deliberately not registered here —
// every action's permission must be a REAL requirement, not a proxy.

const NAV_PAGES = [
  {
    id: 'nav.aiAccess',
    title: 'Go to AI Assistant Access settings',
    path: '/settings/ai-access',
    permission: Permissions.McpUse,
  },
  {
    id: 'nav.jobsSettings',
    title: 'Go to Jobs settings',
    path: '/settings/jobs',
    permission: Permissions.JobsSettingsRead,
  },
  {
    id: 'nav.sandboxSettings',
    title: 'Go to Sandbox settings',
    path: '/settings/sandbox',
    permission: Permissions.SandboxSettingsRead,
  },
  {
    id: 'nav.provenanceSettings',
    title: 'Go to Provenance settings',
    path: '/settings/provenance',
    permission: Permissions.ProvenanceSettingsRead,
  },
  {
    id: 'nav.profileSettings',
    title: 'Go to your profile settings',
    path: '/settings/profile',
    permission: Permissions.ProfileEdit,
  },
  {
    id: 'nav.sessionSettings',
    title: 'Go to session settings',
    path: '/settings/sessions',
    permission: Permissions.SessionSettingsRead,
  },
  {
    id: 'nav.projectAdmin',
    title: 'Go to Projects admin',
    path: '/settings/projects',
    permission: Permissions.ProjectAdminRead,
  },
] as const

for (const page of NAV_PAGES) {
  defineAction({
    id: page.id,
    title: page.title,
    permission: page.permission,
    mutating: true,
    params: z.object({}),
    run: (_params, ctx) => {
      ctx.navigate(page.path)
    },
  })
}
