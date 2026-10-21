// The backend extension-manifest store (ITEM-15). Fetches `GET /api/extensions`
// — the backend-owned registry of the converters + views (+ reserved datatypes)
// each extension contributes — so the workbench holds the backend-declared
// contributions as DATA. This makes the registry backend-SOURCED for its DATA.
//
// HYBRID (this round): the CODE refs (the React view components, the analysis
// param schemas) are still supplied by the build-time glob in `discover.ts`
// (`import.meta.glob('./extensions/*/extension.ts')`); this store adds the backend
// manifests alongside as the authoritative DATA projection. A later round can
// resolve the glob's code refs AGAINST these manifests (data drives which code
// registers); for now the two coexist and this store is the read surface for the
// backend truth.
//
// Self-gated on `projects::use` (the exact permission `GET /api/extensions`
// enforces — `extensions/routes.rs`), so a user lacking it never 403s; honest
// loading / error state. Mirrors `datasets/stores/Datasets.store.ts`.

import { ApiClient } from '@/api-client'
import { type ExtensionManifest } from '@/api-client/types'
import { Permissions } from '@/api-client/permissions'
import { hasPermissionNow } from '@/core/permissions'
import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'
import { useEffect } from 'react'

const ExtensionsDef = defineStore('Extensions', {
  state: {
    /** The backend-declared extension manifests (converters + views). */
    manifests: [] as ExtensionManifest[],
    loading: false,
    /** Latched true after the first successful fetch (so the hook stops re-firing). */
    loaded: false,
    error: null as string | null,
  },
  actions: (set, get) => {
    const load = async (force = false): Promise<void> => {
      // Self-gate: skip the fetch entirely when the user lacks `projects::use`
      // (no 403 spam) — the manifests are non-sensitive metadata but the endpoint
      // gates on the reused project permission (DEC-13).
      if (!hasPermissionNow(Permissions.ProjectsUse)) return
      if ((get().loaded || get().loading) && !force) return
      set({ loading: true, error: null })
      try {
        const manifests = await ApiClient.Extension.list()
        set({ manifests, loaded: true, loading: false })
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e), loading: false })
      }
    }
    return { load }
  },
  init: ({ on, actions }) => {
    // Fetch once on registration (post-auth: the workbench module loads after the
    // app boots). `sync:reconnect` re-fetches so a permission/connection recovery
    // refreshes the manifests; self-gated inside `load`.
    on('sync:reconnect', () => void actions.load(true))
    if (hasPermissionNow(Permissions.ProjectsUse)) void actions.load()
  },
})

export const useExtensionsStore = ExtensionsDef.store

/**
 * The reactive store PROXY — the direct handle consumers import.
 * `registerLazyStore` builds it ONCE and self-registers it under `'Extensions'`, so a
 * `stores: [...]` entry (if any remains) REUSES this instance rather than building a
 * second one with an independent ref count — which would run `init` (and every
 * `sync:*` listener it registers) twice.
 */
export const Extensions = registerLazyStore(ExtensionsDef)


/** The read surface a component uses. */
export interface UseExtensions {
  extensions: ExtensionManifest[]
  loading: boolean
  error: string | null
}

/**
 * Reactive read of the backend extension manifests. Reads the store fields in
 * render (subscribes), and lazily triggers the fetch on first mount if it hasn't
 * loaded yet (the store's `init` already fires it post-auth; this covers the case
 * where a component mounts before that / after a reset). A prior error is NOT
 * auto-retried (avoids a tight failing loop — `sync:reconnect` is the retry path).
 */
export function useExtensions(): UseExtensions {
  const { manifests, loading, loaded, error } = Extensions
  useEffect(() => {
    if (!loaded && !loading && !error) void Extensions.load()
  }, [loaded, loading, error])
  return { extensions: manifests, loading, error }
}

