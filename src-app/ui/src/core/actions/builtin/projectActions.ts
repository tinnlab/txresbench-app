import { z } from 'zod'
import { Permissions } from '@/api-client/permissions'
import { Projects } from '@/modules/project/stores/Projects.store'
import { defineAction } from '../defineAction'

// Slice 2 (PLAN.md ITEM-2) — registers cyto's real PROJECT user actions as
// global `defineAction`s, delegating to the existing `Projects` store
// actions (`src/modules/project/stores/Projects.store.ts`) — no logic
// duplication. These are the same actions the project grid's "New project" /
// per-card "Duplicate"/"Delete" affordances already call
// (`ProjectsPage.tsx`, `ProjectCard.tsx`); `project.openProject` (navigate to a
// project's detail page) is already registered in `./appActions.ts` (slice 1).
//
// Every action here requires `projects::use` — the same permission that gates
// the `/projects` route and the `Projects` store's own self-gate
// (`hasPermissionNow(Permissions.ProjectsUse)`), so the palette + the AI agent
// see exactly what a human with project access can do. Per-project ownership
// (edit/duplicate/delete) is enforced server-side per request; the client
// only decides whether the AFFORDANCE is offered, matching `ProjectCard.tsx`.

defineAction({
  id: 'project.create',
  title: 'Create a new project',
  permission: Permissions.ProjectsUse,
  mutating: true,
  params: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
  }),
  run: async ({ name, description }, ctx) => {
    const project = await Projects.createProject({ name, description })
    if (project) ctx.navigate(`/projects/${project.id}`)
    return project
  },
})

defineAction({
  id: 'project.duplicate',
  title: 'Duplicate a project',
  permission: Permissions.ProjectsUse,
  mutating: true,
  params: z.object({ project_id: z.string() }),
  run: ({ project_id }) => Projects.duplicateProject(project_id),
})

defineAction({
  id: 'project.delete',
  title: 'Delete a project',
  permission: Permissions.ProjectsUse,
  mutating: true,
  // Destructive/hard-to-undo — mirrors `ProjectCard.tsx`'s required delete
  // confirm dialog (`@ziee/kit`'s `Confirm`). The command palette
  // interposes its own confirmation step before invoking a `dangerous`
  // action (`CommandPalette.tsx`); see `ActionMeta.dangerous`.
  dangerous: true,
  params: z.object({ project_id: z.string() }),
  run: ({ project_id }) => Projects.deleteProject(project_id),
})

defineAction({
  id: 'project.list',
  title: 'Go to your projects',
  permission: Permissions.ProjectsUse,
  mutating: true,
  params: z.object({}),
  run: (_params, ctx) => {
    ctx.navigate('/projects')
  },
})
