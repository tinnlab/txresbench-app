import { ApiClient, getAuthToken } from '@/api-client'
import { getBaseUrl } from '@/api-client/getBaseURL'
import { type ExportScope, defaultExportScope, exportScopeToWire } from '@/modules/provenance/types'
import { defineStore, registerLazyStore } from '@txresbench/framework/store-kit'

type Phase = 'idle' | 'building' | 'ready' | 'error'

/**
 * The export-bundle build + download flow (ITEM-16). `openFor(projectId, target)`
 * seeds + opens the drawer (the `open` boolean state drives the Sheet);
 * `build()` calls `POST /provenance/export` for the bundle
 * handle, then downloads the plain-zip `GET /provenance/export/{id}` through an
 * authed fetch (the generated ApiClient always JSON-parses, so the binary zip
 * rides a hand-written fetch — same token-inject / base-url path as the
 * workstore binary client). Phase is surfaced to the UI (building → ready →
 * downloaded) so the Build button is never a silent spinner.
 */
const ProvenanceExportDef = defineStore('ProvenanceExport', {
  state: {
    open: false,
    projectId: null as string | null,
    /** The run/artifact to walk back from when scope === 'run' (null = project). */
    target: null as string | null,
    scope: 'project' as ExportScope,
    phase: 'idle' as Phase,
    exportId: null as string | null,
    error: null as string | null,
  },
  actions: (set, get) => ({
    openFor: (projectId: string, target: string | null) => {
      set({
        open: true,
        projectId,
        target,
        // Default to the tightest scope when a concrete run is in view (ITEM-62).
        scope: defaultExportScope(target),
        phase: 'idle',
        exportId: null,
        error: null,
      })
    },
    close: () => set({ open: false }),
    setScope: (scope: ExportScope) => set({ scope, phase: 'idle', error: null }),
    build: async (): Promise<boolean> => {
      const { projectId, scope, target } = get()
      if (!projectId) return false
      set({ phase: 'building', error: null, exportId: null })
      try {
        const { export_id } = await ApiClient.Provenance.export({
          project_id: projectId,
          scope: exportScopeToWire(scope),
          target: scope === 'run' ? (target ?? undefined) : undefined,
        })
        // Download the built zip through an authed fetch (binary → blob).
        const base = await getBaseUrl()
        const token = getAuthToken()
        const headers = new Headers()
        if (token) headers.set('Authorization', `Bearer ${token}`)
        const res = await fetch(`${base}/api/provenance/export/${export_id}`, { headers })
        if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`)
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `provenance-export-${export_id}.zip`
        document.body.appendChild(a)
        a.click()
        a.remove()
        URL.revokeObjectURL(url)
        set({ phase: 'ready', exportId: export_id })
        return true
      } catch (e) {
        set({
          phase: 'error',
          error: e instanceof Error ? e.message : 'Failed to build export',
        })
        return false
      }
    },
  }),
})

export const useProvenanceExportStore = ProvenanceExportDef.store

/**
 * The reactive store PROXY — the direct handle consumers import.
 * `registerLazyStore` builds it ONCE and self-registers it under `'ProvenanceExport'`, so a
 * `stores: [...]` entry (if any remains) REUSES this instance rather than building a
 * second one with an independent ref count — which would run `init` (and every
 * `sync:*` listener it registers) twice.
 */
export const ProvenanceExport = registerLazyStore(ProvenanceExportDef)
