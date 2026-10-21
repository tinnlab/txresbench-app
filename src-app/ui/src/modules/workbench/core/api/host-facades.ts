// The `ui` / `storage` / `events` facades (ITEM-13). Thin, per-extension wrappers
// over the injected host services. `storage` is namespaced by `extension_id` so
// one extension can NEVER read another's keys; `events` bridges to the framework
// EventBus with auto-cleanup.

import type { EventBusLike, KeyValueBackend, Disposable } from './host.ts'

export interface KeyValue {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<string[]>
}

export interface EventsApi {
  on(event: string, cb: (payload: unknown) => void): Disposable
  emit(event: string, payload: unknown): void
}

/** Per-extension KV — every key is prefixed with `ext:<extensionId>:` so the
 *  namespace is isolated (the extension only ever sees its own keys). NOTE the
 *  deliberate ASYMMETRY with `events` below: `storage` is PRIVATE per extension,
 *  but the `events` bus is intentionally SHARED — extensions coordinate through
 *  the event bus + the typed data contract (§2), while their persisted KV is
 *  private. The `extensionId` charset is validated at manifest load
 *  (`manifest/validate.ts` `MANIFEST_ID_RE`) so the `:`-delimited prefix stays
 *  injective (audit SEC-1). */
export function createStorageApi(backend: KeyValueBackend, extensionId: string): KeyValue {
  const prefix = `ext:${extensionId}:`
  return {
    get: key => backend.get(prefix + key),
    set: (key, value) => backend.set(prefix + key, value),
    delete: key => backend.delete(prefix + key),
    keys: async () => (await backend.keys(prefix)).map(k => k.slice(prefix.length)),
  }
}

export function createEventsApi(bus: EventBusLike): EventsApi {
  return {
    on: (event, cb) => bus.on(event, cb),
    emit: (event, payload) => bus.emit(event, payload),
  }
}
// (no createUiApi wrapper — the shell's `UiHost` is passed through directly in
// createWorkbenchApi; there is no per-extension scoping to add, audit APIFRIEND-4.)
