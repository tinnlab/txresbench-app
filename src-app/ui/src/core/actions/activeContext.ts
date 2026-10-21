import { useEffect } from 'react'
import { useSyncExternalStore } from 'react'

// The ACTIVE-CONTEXT registry (PLAN.md ITEM-2). A module-level singleton — the
// SAME out-of-React-singleton + `useSyncExternalStore` shape as the command
// palette's open-state (`modules/command-palette/paletteState.ts`) and the
// instance registry (`./instanceRegistry.ts`). It exists because the
// palette (`CommandPalette.tsx`) + the AI engine (`./engine.ts`) are
// non-React singletons that must know WHICH page context is currently active
// to gate a `defineAction` by its `context` — but "which page am I on" lives
// in React context (`WorkbenchContext`) today, unreachable from those
// singletons. So a surface (the workbench "Workspace" section, a dataset
// detail page) MIRRORS its context into this module singleton from a mount
// effect via `useActiveContext`, and the palette/engine read it.
//
// Purely LOCAL (per-user, in-memory) — NO sync/SSE path: context liveness
// isn't cross-device (INFRA_INTEGRATION.md entity-lifecycle walk). The only
// hazard is a leaked entry on unmount, which `useActiveContext`'s cleanup
// unregisters.

/** What a surface declares when it makes a context active. */
export interface ActiveContextOptions {
  /** The focused ENTITY id for this context (e.g. the dataset id for the
   *  `'dataset'` context) — read by a context-scoped action's `run`
   *  (`getActiveEntity`). Omit for a context with no single focused entity
   *  (e.g. the workbench shell keyed only by the project it's already in). */
  entityId?: string
}

interface ContextEntry {
  entityId?: string
}

// Module-level singleton: context name -> its live entry. `has(name)` is the
// "is this context active" ground truth; last-registration-wins for a given
// name (mirrors `instanceRegistry`'s replace-on-remount shape — two surfaces
// declaring the same context is not a throw-worthy programmer error).
const contexts = new Map<string, ContextEntry>()

const listeners = new Set<() => void>()

/** An immutable snapshot of the whole registry, for `useSyncExternalStore`.
 *  A NEW object reference is produced on every mutation (via `emit`) and kept
 *  stable between mutations, so a subscriber only re-renders on a real
 *  change (`Object.is` comparison). */
export interface ActiveContextSnapshot {
  /** Monotonic version bumped on every mutation (change detection). */
  version: number
  /** context name -> `{entityId?}`, materialized at snapshot time. */
  byName: Readonly<Record<string, ContextEntry>>
}

let snapshot: ActiveContextSnapshot = { version: 0, byName: {} }

function rebuildSnapshot(): void {
  const byName: Record<string, ContextEntry> = {}
  for (const [name, entry] of contexts) {
    byName[name] = { ...entry }
  }
  snapshot = { version: snapshot.version + 1, byName }
}

function emit(): void {
  rebuildSnapshot()
  listeners.forEach(listener => listener())
}

/** Declare `name` active (optionally carrying its focused `entityId`).
 *  Called from `useActiveContext`'s mount effect.
 *
 *  SINGLE-INSTANCE-PER-CONTEXT-NAME assumption (not refcounted): registration is
 *  last-writer-wins and `unregisterActiveContext` deletes the whole entry. This is
 *  sound because a given context name is declared by at most ONE mounted surface at a
 *  time in the current tree — the routed pages (`'dataset'` on DatasetDetailPage,
 *  `'workbench'` on WorkbenchSection) never co-mount, and a popped-out window is a
 *  SEPARATE JS realm with its own module singleton. If a future surface ever declares
 *  the same context name concurrently (e.g. two same-context panes in one realm), add
 *  per-name refcounting here so one surface's unmount can't clear the other's context. */
export function registerActiveContext(name: string, options: ActiveContextOptions = {}): void {
  const prev = contexts.get(name)
  // No-op if nothing changed — avoids a spurious snapshot bump/re-render when
  // the same surface re-registers with an identical entity id.
  if (prev && prev.entityId === options.entityId) return
  contexts.set(name, { entityId: options.entityId })
  emit()
}

/** Clear `name` (called from `useActiveContext`'s unmount cleanup). A no-op
 *  if `name` isn't currently active. */
export function unregisterActiveContext(name: string): void {
  if (!contexts.delete(name)) return
  emit()
}

/** Is `name` currently an active context? `'global'` is NEVER registered
 *  here — callers (the palette / `checkContextGuard`) special-case it as
 *  always-available, so a `'global'` lookup here is legitimately `false`. */
export function isContextActive(name: string): boolean {
  return contexts.has(name)
}

/** The focused entity id declared for `name`, or `undefined` when the
 *  context is inactive or was declared without one. */
export function getActiveEntity(name: string): string | undefined {
  return contexts.get(name)?.entityId
}

/** Subscribe to any registry mutation (for `useSyncExternalStore`). Returns
 *  an unsubscribe fn. */
export function subscribeActiveContext(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The current immutable snapshot (stable reference between mutations). */
export function getActiveContextSnapshot(): ActiveContextSnapshot {
  return snapshot
}

/** React hook: reactively read the active-context snapshot. A consumer that
 *  must recompute on any context change (e.g. `CommandPalette` re-gating its
 *  list) subscribes through this. */
export function useActiveContextSnapshot(): ActiveContextSnapshot {
  return useSyncExternalStore(
    subscribeActiveContext,
    getActiveContextSnapshot,
    getActiveContextSnapshot,
  )
}

/**
 * The hook a surface calls to DECLARE its context active for as long as it is
 * mounted (PLAN.md ITEM-2). Registers `name` (+ optional `entityId`) on mount,
 * unregisters on unmount — mirroring `useAction`'s instance-registry
 * mount/unmount join (`./useAction.ts`). Re-registers when `name` or the
 * focused `entityId` changes.
 *
 * Example: the workbench "Workspace" section calls `useActiveContext('workbench')`;
 * a dataset detail page calls `useActiveContext('dataset', { entityId: datasetId })`.
 */
export function useActiveContext(name: string, options: ActiveContextOptions = {}): void {
  const entityId = options.entityId
  useEffect(() => {
    registerActiveContext(name, { entityId })
    return () => unregisterActiveContext(name)
  }, [name, entityId])
}
