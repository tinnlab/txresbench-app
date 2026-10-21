import { z } from 'zod'
import { Permissions } from '@/api-client/permissions'
import { defineAction } from '../defineAction'

// The two real GLOBAL actions proving the puppet vertical this slice
// (PLAN.md ITEM-16). Importing this module for its side effect registers
// both with the global action registry — see
// `src/modules/actions/module.tsx`, which is the sole import site.

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

defineAction({
  id: 'project.openProject',
  title: "Open a project's detail page",
  permission: Permissions.ProjectsUse,
  mutating: true,
  params: z.object({ project_id: z.string() }),
  run: ({ project_id }, ctx) => {
    ctx.navigate(`/projects/${project_id}`)
  },
})
