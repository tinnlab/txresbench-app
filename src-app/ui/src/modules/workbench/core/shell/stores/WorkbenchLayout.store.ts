import { createJSONStorage } from 'zustand/middleware'
import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'
import { type DockArea, type ProjectLayout, defaultProjectLayout } from '../types'

// Guarded persistence storage (mirrors AppLayout.store / ConfigClient.store):
// localStorage throws in locked-down contexts (private mode, sandboxed iframe).
// Probe once and fall back to in-memory so store creation never takes the app down;
// the layout just won't survive a reload there.
const safeStorage = createJSONStorage(() => {
  try {
    const probe = '__cyto_wb_ls_probe__'
    window.localStorage.setItem(probe, probe)
    window.localStorage.removeItem(probe)
    return window.localStorage
  } catch {
    const mem = new Map<string, string>()
    return {
      getItem: (name: string) => mem.get(name) ?? null,
      setItem: (name: string, value: string) => {
        mem.set(name, value)
      },
      removeItem: (name: string) => {
        mem.delete(name)
      },
    }
  }
})

/**
 * The workbench dock layout store (ITEM-2). Holds per-dock UI state keyed
 * per-project (`byProject`) so switching projects restores that project's layout, plus a
 * `resetToken` the shell watches to re-mount the resizable panel group on reset.
 * Persisted per-USER to localStorage (only `byProject`); ephemeral fields recompute.
 * Mirrors `layouts/app-layout/AppLayout.store.ts`.
 */
const WorkbenchLayoutDef = defineStore('WorkbenchLayout', {
  persist: {
    name: 'cyto.wb.layout',
    storage: safeStorage,
    // Persist ONLY the per-project dock layout; `activeProjectId`/`resetToken` are
    // ephemeral (recomputed on mount).
    partialize: (state: { byProject: Record<string, ProjectLayout> }) => ({ byProject: state.byProject }),
  },
  state: {
    byProject: {} as Record<string, ProjectLayout>,
    activeProjectId: null as string | null,
    /** bumped by resetLayout(); the shell keys the ResizablePanelGroup on it. */
    resetToken: 0,
  },
  actions: (set, get) => {
    /** The layout for the active project, defaulting if unseen. Read-only helper. */
    const layoutOf = (projectId: string): ProjectLayout =>
      get().byProject[projectId] ?? defaultProjectLayout()

    const patchProject = (projectId: string, patch: (l: ProjectLayout) => ProjectLayout) =>
      set((s: { byProject: Record<string, ProjectLayout> }) => ({
        byProject: { ...s.byProject, [projectId]: patch(layoutOf(projectId)) },
      }))

    return {
      /** Ensure a project has a layout slice + make it active (called on shell mount).
       *  Never overwrites an existing (persisted) layout. */
      ensureProject: (projectId: string) => {
        if (!get().byProject[projectId]) patchProject(projectId, l => l)
        set({ activeProjectId: projectId })
      },
      /** The current active project's layout (snapshot). */
      current: (): ProjectLayout => layoutOf(get().activeProjectId ?? ''),
      setCollapsed: (area: DockArea, collapsed: boolean) => {
        const id = get().activeProjectId
        if (!id) return
        patchProject(id, l => ({ ...l, [area]: { ...l[area], collapsed } }))
      },
      setSize: (area: DockArea, size: number) => {
        const id = get().activeProjectId
        if (!id) return
        patchProject(id, l => ({ ...l, [area]: { ...l[area], size: Math.max(0, Math.round(size)) } }))
      },
      setActiveTab: (area: DockArea, tabId: string) => {
        const id = get().activeProjectId
        if (!id) return
        patchProject(id, l => ({ ...l, activeTab: { ...l.activeTab, [area]: tabId } }))
      },
      /** Restore IA defaults for the active project + bump the reset token. */
      resetLayout: () => {
        const id = get().activeProjectId
        if (!id) return
        set((s: { byProject: Record<string, ProjectLayout>; resetToken: number }) => ({
          byProject: { ...s.byProject, [id]: defaultProjectLayout() },
          resetToken: s.resetToken + 1,
        }))
      },
    }
  },
})

export const useWorkbenchLayoutStore = WorkbenchLayoutDef.store

/**
 * The reactive store PROXY — the direct handle consumers import.
 * `registerLazyStore` builds it ONCE and self-registers it under `'WorkbenchLayout'`, so a
 * `stores: [...]` entry (if any remains) REUSES this instance rather than building a
 * second one with an independent ref count — which would run `init` (and every
 * `sync:*` listener it registers) twice.
 */
export const WorkbenchLayout = registerLazyStore(WorkbenchLayoutDef)


/**
 * The active project's layout, read REACTIVELY (subscribes to `byProject`/`activeProjectId`
 * so a collapse/size/reset re-renders). Use this in render bodies — NOT the
 * `current()` action, which is a non-subscribing getState snapshot for handlers.
 */
export function useCurrentLayout(): ProjectLayout {
  const { byProject, activeProjectId } = WorkbenchLayout
  return byProject[activeProjectId ?? ''] ?? defaultProjectLayout()
}

