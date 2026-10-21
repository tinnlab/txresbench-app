// The draftable editor's live-session REGISTRIES — the shared, side-effect-free state the
// resolver (`draftBinding.ts`) and the module actions (`draftActions.ts`) BOTH read.
//
// ── WHY THIS MODULE EXISTS (the import-cycle fix) ──────────────────────────────────────────────
// `draftBinding.ts` pulls in `draftActions.ts` for its `defineAction` registration side-effect,
// and `draftActions.ts` needs the instance / launch-intent accessors. Having the actions import
// those back from `draftBinding.ts` closed a cycle THROUGH a module that calls an imported binding
// at top level (`defineAction(...)`) — a temporal-dead-zone crash waiting for the bundler to enter
// the graph at the wrong root, and exactly the class `importCycles.test.ts` gates. Hoisting the
// shared state into this third, CALL-FREE module (it registers nothing at import) breaks the edge:
// both modules now depend on this one, and nothing depends back on the actions.
//
// It is DOMAIN-FREE (INV-1): it carries the opaque package `kind`/`freeze`, never interprets them.

/**
 * Per-view draft INSTANCE binding: `viewId` → the draft it edits + the context the package's
 * module actions (freeze / export) need. Populated by the mount-glue when a draftable editor
 * mounts; read by those actions via the dispatched `view_id`. In-memory (a live-session fact) —
 * a full page reload re-resolves through the mount.
 */
export interface DraftInstance {
  draftId: string
  projectId: string
  /** The opaque draft `kind` (never interpreted here). */
  kind: string
  /** The freeze producer analysis id (opaque; the server re-resolves it from `kind`). */
  freeze: string
}

const instances = new Map<string, DraftInstance>()

export function bindDraftInstance(viewId: string, inst: DraftInstance): void {
  instances.set(viewId, inst)
}
export function getDraftInstance(viewId: string): DraftInstance | undefined {
  return instances.get(viewId)
}
export function unbindDraftInstance(viewId: string): void {
  instances.delete(viewId)
}

// ── EXPLICIT draft-id threading (the launcher → editor seam) ──────────────────────────────────
//
// A launcher action (`draft.launchEditor` / `draft.editFork`) CREATES the exact draft the editor
// must open, then records its id here keyed by the editor's `viewId` BEFORE opening the pane.
// `resolveDraftBinding` consumes it — so the editor binds to THAT draft deterministically (never
// the "most-recent open draft" guess), which both disambiguates several open drafts of one kind
// and lets an edit-fork seed the new draft from a frozen artifact.
const launchIntents = new Map<string, string>()

/** Record the draft a launcher just created for the editor identified by `viewId`. */
export function setDraftLaunchIntent(viewId: string, draftId: string): void {
  launchIntents.set(viewId, draftId)
}
/** Read + clear the pending launch intent for `viewId` (single-use). */
export function takeDraftLaunchIntent(viewId: string): string | undefined {
  const id = launchIntents.get(viewId)
  if (id !== undefined) launchIntents.delete(viewId)
  return id
}

// ── in-flight dedup, keyed by viewId (StrictMode double-invoke safety) ─────────────────────────
//
// React.StrictMode invokes the resolve effect twice on the first mount. Without dedup, both
// invocations see no bound draft and BOTH call `Drafts.create` → two POST /api/drafts → an orphan
// draft on every first editor open. Keying the in-flight promise by `viewId` makes the second
// invocation reuse the first's promise, so exactly one draft is created / resolved per editor open.
// Typed loosely (`Promise<unknown>`) so this module needs no import of the resolver's binding type
// — keeping it dependency-free of `draftBinding`.
export const inFlight = new Map<string, Promise<unknown>>()

/** Test-only reset of every live-session registry. */
export function __resetDraftInstancesForTests(): void {
  instances.clear()
  launchIntents.clear()
  inFlight.clear()
}
