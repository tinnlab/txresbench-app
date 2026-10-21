import { ApiClient } from '@/api-client'
import { Permissions } from '@/api-client/permissions'
import { type CreateDraftRequest, type Draft, type FreezeResponse } from '@/api-client/types'
import { hasPermissionNow } from '@/core/permissions'
import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'

/**
 * The client `Drafts` store (draftable-entity ITEM-11) — the API + sync surface the
 * declarative `$state`↔draft binding (ITEM-10) calls into. A draft is a domain-free,
 * project-scoped working document (`{id, kind, project_id, data, status,
 * frozen_artifact_id}`); core interprets NOTHING about `kind`/`data`, and neither
 * does this store — it caches rows by id and exposes create/get/put/freeze/delete +
 * a debounced `persist` for the edit-view write chokepoint.
 *
 * Self-gated on `drafts::use` (the read-perm the `GET /api/drafts` refetch enforces),
 * and refetches on `sync:draft` / `sync:reconnect` — the no-403-on-reconnect rule
 * (mirrors `Datasets.store`). Drafts are not a single global list, so the sync
 * handler refetches only the rows this store currently holds.
 */

/** The per-draft debounce delay for `persist` (the edit view calls it on every
 *  keystroke; one PUT per pause keeps the server write rate sane — LWW, DEC-4). */
const PERSIST_DEBOUNCE_MS = 400

const DraftsDef = defineStore('Drafts', {
  state: {
    /** Cache of loaded drafts, keyed by id. */
    byId: {} as Record<string, Draft>,
    error: undefined as string | undefined,
  },
  actions: set => {
    // Per-draft debounce timers for `persist` (module-scoped to the store instance).
    const persistTimers = new Map<string, ReturnType<typeof setTimeout>>()

    const cache = (draft: Draft): Draft => {
      set(state => ({ byId: { ...state.byId, [draft.id]: draft } }))
      return draft
    }

    // Sibling actions referenced by `persist`/`remove` — `get()` returns STATE, not
    // actions, so cross-action calls go through these local bindings.
    const put = async (id: string, data: unknown): Promise<Draft> => {
      try {
        return cache(await ApiClient.Draft.update({ id, data }))
      } catch (error) {
        set({ error: error instanceof Error ? error.message : 'Failed to save draft' })
        throw error
      }
    }
    const evict = (id: string): void => {
      set(state => {
        const byId = { ...state.byId }
        delete byId[id]
        return { byId }
      })
    }

    return {
      /** Fetch one draft by id and cache it. */
      get: async (id: string): Promise<Draft> => {
        try {
          return cache(await ApiClient.Draft.get({ id }))
        } catch (error) {
          set({ error: error instanceof Error ? error.message : 'Failed to load draft' })
          throw error
        }
      },

      /** List a project's drafts (optionally filtered by opaque `kind`) and cache them. */
      listForProject: async (projectId: string, kind?: string): Promise<Draft[]> => {
        try {
          const resp = await ApiClient.Draft.list({ project_id: projectId, kind })
          set(state => {
            const byId = { ...state.byId }
            for (const d of resp.drafts) byId[d.id] = d
            return { byId }
          })
          return resp.drafts
        } catch (error) {
          set({ error: error instanceof Error ? error.message : 'Failed to list drafts' })
          throw error
        }
      },

      /** Create a draft (opaque `kind` + `data`) in a project. */
      create: async (req: CreateDraftRequest): Promise<Draft> => {
        try {
          return cache(await ApiClient.Draft.create(req))
        } catch (error) {
          set({ error: error instanceof Error ? error.message : 'Failed to create draft' })
          throw error
        }
      },

      /** Replace a draft's `data` immediately (the un-debounced write). */
      put,

      /** Debounced persist — the edit-view `set()` chokepoint calls this on every
       *  change; the trailing PUT lands after `PERSIST_DEBOUNCE_MS` of quiet. */
      persist: (id: string, data: unknown): void => {
        const existing = persistTimers.get(id)
        if (existing) clearTimeout(existing)
        persistTimers.set(
          id,
          setTimeout(() => {
            persistTimers.delete(id)
            void put(id, data)
          }, PERSIST_DEBOUNCE_MS),
        )
      },

      /** Freeze a draft → the `FreezeResponse` (the still-open `draft` + the enqueued
       *  producer `freeze_job_id` to poll). The returned draft (still `open` until the
       *  async producer completes) is cached; the row flips to `frozen` on the next
       *  `sync:draft` refetch. */
      freeze: async (id: string): Promise<FreezeResponse> => {
        try {
          const resp = await ApiClient.Draft.freeze({ id })
          cache(resp.draft)
          return resp
        } catch (error) {
          set({ error: error instanceof Error ? error.message : 'Failed to freeze draft' })
          throw error
        }
      },

      /** Drop a draft from the local cache WITHOUT an API call (a row deleted
       *  elsewhere, discovered via a sync-driven refetch 404). */
      evict,

      /** Delete a draft and drop it from the cache. */
      remove: async (id: string): Promise<void> => {
        try {
          await ApiClient.Draft.delete({ id })
          evict(id)
        } catch (error) {
          set({ error: error instanceof Error ? error.message : 'Failed to delete draft' })
          throw error
        }
      },
    }
  },
  init: ({ on, actions, get }) => {
    // No-403-on-reconnect: self-gate the refetch on the read-perm the endpoint
    // enforces. On any draft change (or a reconnect) refetch every cached row — a
    // deleted row 404s and is dropped.
    const reload = () => {
      if (!hasPermissionNow(Permissions.DraftsUse)) return
      for (const id of Object.keys(get().byId)) {
        void actions.get(id).catch(() => {
          // A 404 means the row was deleted elsewhere — drop it from the cache.
          actions.evict(id)
        })
      }
    }
    on('sync:draft', reload)
    on('sync:reconnect', reload)
  },
})

export const useDraftsStore = DraftsDef.store

/** The reactive store PROXY — the direct handle the binding + views import. */
export const Drafts = registerLazyStore(DraftsDef)
