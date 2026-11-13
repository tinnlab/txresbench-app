import { z } from 'zod'
import { Permissions } from '@/api-client/permissions'
import { defineAction } from '../defineAction'

// The real GLOBAL action proving the puppet vertical this slice
// (PLAN.md ITEM-16). Importing this module for its side effect registers it
// with the global action registry — see
// `src/modules/actions/module.tsx`, which is the sole import site.
//
// `project.openProject` left with the single-cell project module: the app
// has no project screens, and `/projects/*` no longer answers.

defineAction({
  id: 'app.navigate',
  title: 'Navigate the app to a route',
  permission: Permissions.McpUse,
  mutating: true,
  params: z.object({ path: z.string() }),
  run: ({ path }, ctx) => {
    ctx.navigate(path)
  },
})
