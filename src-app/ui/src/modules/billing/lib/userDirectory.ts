import { ApiClient } from '@/api-client'
import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'

/**
 * Best-effort resolver of the raw `*_by` user ids the billing API returns
 * (`granted_by`, `revoked_by`, `admin_suspended_by`, `plan_override_by`,
 * `set_by`) to HUMAN names — so no surface ever renders a bare 36-char UUID
 * where a person's name belongs (the usability hard-rule; DEC-5).
 *
 * The distinct actor-id set on one account's ledger/status is tiny (a handful of
 * admins), so we resolve per-id via `User.get` and cache. A resolution that fails
 * (permission, deleted user) caches a LABELED SHORT FORM — never the raw UUID.
 */

/** A stable, human-readable label for an id we could not resolve to a name. Uses
 *  the id's first 8 chars so it is still traceable, but is clearly labeled as an
 *  identifier rather than being presented as if it were a name. */
export function shortActorLabel(id: string): string {
  const head = (id ?? '').replace(/-/g, '').slice(0, 8) || 'unknown'
  return `admin ·${head}`
}

type NameState = { names: Record<string, string>; pending: Record<string, boolean> }

const UserDirectoryDef = defineStore('BillingUserDirectory', {
  state: { names: {} as Record<string, string>, pending: {} as Record<string, boolean> },
  actions: (set, get) => {
    const resolve = async (id: string | undefined | null): Promise<void> => {
      if (!id) return
      const cur = get() as NameState
      if (cur.names[id] || cur.pending[id]) return
      set({ pending: { ...get().pending, [id]: true } })
      try {
        const user = await ApiClient.User.get({ user_id: id })
        const label = user.display_name || user.username || shortActorLabel(id)
        set({
          names: { ...get().names, [id]: label },
          pending: { ...get().pending, [id]: false },
        })
      } catch {
        // Best-effort: an unresolvable id gets a labeled short form, NEVER a raw UUID.
        set({
          names: { ...get().names, [id]: shortActorLabel(id) },
          pending: { ...get().pending, [id]: false },
        })
      }
    }
    return {
      /** Kick off resolution for a batch of ids (idempotent, de-duped). */
      resolveMany: (ids: (string | undefined | null)[]) => {
        for (const id of ids) void resolve(id)
      },
      resolve,
    }
  },
})

export const useBillingUserDirectoryStore = UserDirectoryDef.store
export const BillingUserDirectory = registerLazyStore(UserDirectoryDef)

/**
 * Read a resolved name from a names map for `id`. Returns the cached human name,
 * or a labeled short form while it resolves / if it never resolves — so a caller
 * renders a readable label on the very first paint and NEVER a raw UUID.
 */
export function nameFor(names: Record<string, string>, id: string | undefined | null): string {
  if (!id) return '—'
  return names[id] ?? shortActorLabel(id)
}
