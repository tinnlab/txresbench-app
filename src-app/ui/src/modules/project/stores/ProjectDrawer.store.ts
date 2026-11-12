import { type ProjectDto } from '@/api-client/types'
import { defineStore, registerLazyStore } from '@txresbench/framework/store-kit'

/** UI-only store for the project create/edit form drawer + the share + transfer
 *  drawers (which entity they target lives in ProjectDetail). */
const ProjectDrawerDef = defineStore('ProjectDrawer', {
  state: {
    formOpen: false,
    /** null → create; a project → edit. */
    editing: null as ProjectDto | null,
    shareOpen: false,
    transferOpen: false,
  },
  actions: set => ({
    openCreate: () => set({ formOpen: true, editing: null }),
    openEdit: (project: ProjectDto) => set({ formOpen: true, editing: project }),
    closeForm: () => set({ formOpen: false, editing: null }),
    openShare: () => set({ shareOpen: true }),
    closeShare: () => set({ shareOpen: false }),
    openTransfer: () => set({ transferOpen: true }),
    closeTransfer: () => set({ transferOpen: false }),
  }),
})

export const useProjectDrawerStore = ProjectDrawerDef.store

/**
 * The reactive store PROXY — the direct handle consumers import.
 * `registerLazyStore` builds it ONCE and self-registers it under `'ProjectDrawer'`, so a
 * `stores: [...]` entry (if any remains) REUSES this instance rather than building a
 * second one with an independent ref count — which would run `init` (and every
 * `sync:*` listener it registers) twice.
 */
export const ProjectDrawer = registerLazyStore(ProjectDrawerDef)
