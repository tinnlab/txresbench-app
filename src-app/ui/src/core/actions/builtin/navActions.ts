import { z } from 'zod'
import { Permissions } from '@/api-client/permissions'
import { defineAction } from '../defineAction'

// Slice 2 (PLAN.md ITEM-2) — registers navigation to txr's key SETTINGS
// pages as global `defineAction`s, delegating to `ctx.navigate` (the same
// primitive `app.navigate` uses, see `./appActions.ts`). Each action's
// `permission` is the EXACT permission the target route itself requires
// (its module's `routes[].permission` — see `modules/mcp/module.tsx`), so
// the palette + the AI agent only ever offer a destination the user can
// actually open. `/settings/general` has no route-level
// permission gate (any authenticated user), so it has no natural
// `Permissions` value to require and is deliberately not registered here —
// every action's permission must be a REAL requirement, not a proxy.
//
// STRIP (single-cell): the jobs/sandbox/provenance/projects-admin navigation
// left with their modules (`modules/{jobs,sandbox,provenance,project}`), and
// the profile/session-settings navigation left with the removed auth/account
// settings screens — none of those routes exists in the app any more, so a
// palette/AI entry would navigate to a 404.

const NAV_PAGES = [
  {
    id: 'nav.aiAccess',
    title: 'Go to AI Assistant Access settings',
    path: '/settings/ai-access',
    permission: Permissions.McpUse,
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
