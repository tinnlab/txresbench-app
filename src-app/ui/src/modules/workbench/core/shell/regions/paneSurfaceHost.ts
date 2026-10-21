// paneSurfaceHost — the HOST-CONTAINER seam that lets a surface belonging to the centre
// canvas grid render as a REAL WORKBENCH PANE instead of inside the grid.
//
// ── The defect this removes ─────────────────────────────────────────────────────────────
// `@ziee/viz`'s grid resolves a host container per open surface and, when the host returns
// none, stacks the surface in its OWN internal right panel — a 300px column INSIDE the grid
// that occupies grid width, so opening a plot's "Edit plot" or "View table" shrank the plot
// being edited. The workbench passed no resolver at all, so every surface took that path.
//
// ── The contract this implements (viz INV-8, host side) ─────────────────────────────────
// The grid calls the resolver ONCE PER OPEN PANE, with that pane's id, and portals THAT
// pane's surface into whatever node comes back. A host that answers with one shared node
// therefore renders every open surface on top of the others and the user cannot tell which
// plot they are editing. So this module mints ONE container per (kind, plot pane id) and
// never hands the same node to two ids: N open surfaces are N containers, N workbench panes,
// N independently operable instances.
//
// ── Why the node is minted DETACHED, and why that is load-bearing ───────────────────────
// The resolver is called during the GRID's render, at which point the workbench pane that
// will host the surface does not exist yet. A resolver that answered `null` until it did
// would send the surface into the grid's internal panel for that frame — the exact defect
// above, intermittently. So the answer is always a real node, created on first ask and kept
// for the life of the surface; the workbench pane adopts it a tick later. The surface is
// never rendered inside the grid, not even for one frame.
//
// Keeping ONE node per surface across the pane's mounts is what also makes a region tab
// switch non-destructive: the node (and the React tree the grid portaled into it) survives
// being detached, so a half-typed plot title is still there when the tab comes back.
//
// ── Lifetime is a PROJECTION, and it is OBSERVED rather than inferred ───────────────────
// The workbench pane exists exactly while the grid has a surface portaled into that
// container. The container's CHILD LIST is that signal — children appear on the commit that
// opens the surface and disappear on the one that closes it — and it is read with a
// `MutationObserver`, i.e. from the state, not from the calling pattern.
//
// Inferring it from the resolver CALL instead cannot see a close: a closed surface simply
// stops being asked about, and "was not asked this render" is indistinguishable from "the
// grid did not re-render". The empty-set transition produces no call at all, so the pane
// would outlive its surface as a dead tab. Observing the container answers open AND close
// with one mechanism and no cadence assumptions.

// ── Why the pane OPEN/CLOSE arrives as an injected PORT ─────────────────────────────────
// This module is re-exported by the workbench's public barrel (`core/index.ts`), and that
// barrel must stay loadable under the `node:test` strip-types runner — no JSX anywhere in its
// import graph (`core/index.test.ts`). Importing the dock store here would pull `@ziee/dock`'s
// `ContainerWindows.tsx` in behind it and break that, so the two store calls this needs arrive
// as `SurfacePaneLifecycle`, installed by `panes.tsx` at boot beside the renderer registration
// (`paneSurfaceLifecycle.ts`). It also leaves this module a pure DOM + registry unit.

/** The pane kinds whose body is a canvas-grid surface hosted here. A narrowing of `PaneKind`
 *  (not a second list): a value outside it cannot reach these containers, and `panes.tsx` is
 *  where the two are tied together by registering exactly these kinds' renderers. */
export type SurfacePaneKind = 'edit-plot' | 'data-table' | 'export'

// ── WHAT "ONE CONTAINER PER SURFACE" MEANS FOR A GRID-SCOPED SURFACE ────────────────────
//
// `edit-plot` and `data-table` are PLOT-scoped: their surface id is always a grid pane id, and
// N may be open at once. The EXPORT surface is not. viz owns ONE export target and resolves
// this container with that target's grid pane id — or, for a whole-grid export, with the
// reserved sentinel below (`GridDockLayer.tsx`). So the surface's subject is EITHER a single
// plot OR the whole grid, and only one export is open at a time.
//
// The identity rule is unchanged, applied verbatim: ONE CONTAINER PER SUBJECT, with the whole
// grid taking viz's reserved sentinel as its subject id. Because viz permits a single open
// export, that yields AT MOST ONE export pane at any moment; retargeting retires the previous
// subject's container (and its pane) and mints the new one, so the pane always describes the
// thing actually being exported, and the per-plot export path keeps its own identity instead
// of being absorbed into a grid-wide one.
//
// The alternative — ONE shared container for every export target — was rejected twice over:
// the pane's `ref` would no longer name what is being exported, and re-opening export while
// its tab is backgrounded would never re-reveal the pane, because the container never empties
// and so no OPEN transition is observed (see `syncOpenState`).
//
/** viz's reserved subject id for a WHOLE-GRID export (`GridWorkspace.exportDialogContainer`
 *  is documented to pass it in place of a pane id). It is an IDENTITY, not a label — no plot
 *  pane can carry it, which is exactly why it is safe as a container key and as a pane `ref`;
 *  `paneTitle` is where it is turned back into words for the tab. */
export const GRID_EXPORT_SURFACE_ID = '__grid__'

interface HostEntry {
  /** The container the grid portals this surface into. Detached until a pane adopts it. */
  readonly node: HTMLElement
  readonly observer: MutationObserver
  /** Last OBSERVED open state (does the container hold the surface?), so each transition acts once. */
  open: boolean
  /** The workbench pane hosting it, as `revealPane` returned it ('' = none). Kept here rather than
   *  re-derived from the pane map: this module is the only thing that opens or closes these panes,
   *  so the id it was given IS the answer, and re-searching the map would be a second source. */
  paneId: string
}

/** The two shell operations this module drives, injected so the module stays barrel-safe. */
export interface SurfacePaneLifecycle {
  /** Reveal (or focus) the workbench pane hosting this surface; returns its pane id ('' if none). */
  open(kind: SurfacePaneKind, surfaceId: string): string
  /** Close the pane again, once its surface is gone. */
  close(paneId: string): void
}

let lifecycle: SurfacePaneLifecycle | null = null

/** Install the shell operations. Called once, from the boot registrar that also registers the
 *  renderers — the two must arrive together or a registered pane kind would have no way to open. */
export function installSurfacePaneLifecycle(next: SurfacePaneLifecycle): void {
  lifecycle = next
}

/** (kind, plot pane id) → its container. Module-level: one per document, like the pane-state map. */
const hosts = new Map<string, HostEntry>()

/** A NUL joiner so no pair of (kind, id) values can collide into one key. */
const keyOf = (kind: SurfacePaneKind, surfaceId: string): string => `${kind}\u0000${surfaceId}`

/** The container class: a hosted surface fills the pane body and owns its own scrolling. */
const HOST_CLASS = 'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden'

// ── CLOSING A HOSTED SURFACE FROM THE SHELL ─────────────────────────────────────────────────
//
// The pane is a PROJECTION of the surface being open, so the shell's close cannot be
// `removePane`: that would drop the projection and leave the surface mounted in a detached
// container — invisible, with its plot's Edit / Show-data toggle still lit, and no way back
// except toggling that plot twice. The close that works is the SURFACE's own, and viz now hands
// it over (`GridWorkspace.registerHostedSurfaceClose`); `CanvasView` installs it here.
//
// Once the surface closes, the container empties, the `MutationObserver` above sees it and
// `retireHost` removes the pane — so the projection follows the surface rather than the other
// way round. That is why this returns "handled" without touching the dock.

/** Close one hosted surface — installed by `CanvasView` from viz's `HostedSurfaceClose`. */
export type HostedSurfaceCloser = (kind: SurfacePaneKind, surfaceId: string) => void

let surfaceCloser: HostedSurfaceCloser | null = null

/** Install (or withdraw, with `null`) the viz-provided closer. */
export function installHostedSurfaceCloser(next: HostedSurfaceCloser | null): void {
  surfaceCloser = next
}

/** What the shell's close did with a hosted-surface pane. */
export type HostedSurfaceCloseResult =
  /** The surface was asked to close; its pane will be retired when the container empties. */
  | 'delegated'
  /** No live surface stands behind this pane (a hydrated layout, a stale ref) — nothing to
   *  strand, so the caller should simply remove the pane. */
  | 'no-surface'
  /** A live surface, but no closer installed. REFUSED rather than stranded — see the header. */
  | 'unavailable'

/**
 * Close the SURFACE behind a hosted-surface pane. Never removes the pane itself.
 */
export function closeHostedSurface(
  /** A `PaneKind`, deliberately unnarrowed: a kind that hosts no surface simply misses the map and
   *  reports `no-surface`, so the caller needs no second list of which kinds those are. */
  kind: string,
  surfaceId: string,
): HostedSurfaceCloseResult {
  if (!surfaceId || !hosts.has(keyOf(kind as SurfacePaneKind, surfaceId))) return 'no-surface'
  if (!surfaceCloser) {
    // LOUD, and deliberately inert: dropping the pane here is the strand this seam exists to
    // prevent, and it is worse than a close that visibly did nothing.
    console.error(
      `[workbench] no hosted-surface closer installed; refusing to close "${kind}" for "${surfaceId}" ` +
        'because removing the pane alone would leave the surface open and unreachable.',
    )
    return 'unavailable'
  }
  surfaceCloser(kind as SurfacePaneKind, surfaceId)
  return 'delegated'
}

/** TEST SEAM — the workbench pane hosting `(kind, surfaceId)`, or null when the surface is not
 *  open. Nothing in production asks (the module acts on the id it was handed); a test asks so it
 *  can address the pane's body. The lifecycle's `open` is idempotent (it focuses an existing pane
 *  of that kind + ref rather than opening a second), so one surface never acquires two panes. */
export function surfacePaneId(kind: SurfacePaneKind, surfaceId: string): string | null {
  return hosts.get(keyOf(kind, surfaceId))?.paneId || null
}

/** React to the container's child list: content ⇒ the surface is open ⇒ a pane hosts it;
 *  emptied ⇒ the surface closed ⇒ the pane goes with it (and the container is retired). */
function syncOpenState(kind: SurfacePaneKind, surfaceId: string): void {
  const entry = hosts.get(keyOf(kind, surfaceId))
  if (!entry) return
  const open = entry.node.childElementCount > 0
  if (open === entry.open) return
  entry.open = open
  if (open) {
    if (!lifecycle) {
      // LOUD, because the silent version of this is the defect: the surface would stay mounted
      // in a container attached to nothing — open, invisible, and with no pane to reach it by.
      console.error(
        '[workbench] a plot surface opened before installSurfacePaneLifecycle(); it has no pane to render in.',
      )
      return
    }
    entry.paneId = lifecycle.open(kind, surfaceId)
    return
  }
  retireHost(kind, surfaceId)
}

/** Drop the pane + the container for a surface that has closed. Idempotent. */
function retireHost(kind: SurfacePaneKind, surfaceId: string): void {
  const key = keyOf(kind, surfaceId)
  const entry = hosts.get(key)
  if (!entry) return
  entry.observer.disconnect()
  entry.node.remove()
  hosts.delete(key)
  if (entry.paneId) lifecycle?.close(entry.paneId)
}

/**
 * The resolver the canvas hands the grid: the container THIS surface renders into, minted on
 * first ask. Never null in a DOM environment — see the header for why a null answer is the
 * defect rather than a safe default.
 */
function hostContainer(kind: SurfacePaneKind, surfaceId: string): HTMLElement | null {
  if (typeof document === 'undefined' || !surfaceId) return null
  const key = keyOf(kind, surfaceId)
  const found = hosts.get(key)
  if (found) return found.node
  const node = document.createElement('div')
  node.className = HOST_CLASS
  // A stable hook for a geometry assertion: "this surface is inside a pane body, not inside
  // the grid" is a question about ancestry, and ancestry needs a named node to ask about.
  node.setAttribute('data-pane-surface-host', `${kind}:${surfaceId}`)
  const observer = new MutationObserver(() => syncOpenState(kind, surfaceId))
  observer.observe(node, { childList: true })
  hosts.set(key, { node, observer, open: false, paneId: '' })
  return node
}

/**
 * The resolvers `CanvasView` passes to `<GridWorkspace>`. A frozen module-level object of
 * stable functions: the grid memoizes on prop identity, so a fresh closure per render would
 * re-render the dock layer on every canvas render for no reason.
 */
export const workbenchPlotSurfaceContainers = Object.freeze({
  editForm: (plotPaneId: string): HTMLElement | null => hostContainer('edit-plot', plotPaneId),
  dataTable: (plotPaneId: string): HTMLElement | null => hostContainer('data-table', plotPaneId),
  /** The export dialog's container. `subject` is a plot pane id for a per-plot export, or
   *  `GRID_EXPORT_SURFACE_ID` for the whole grid — viz passes whichever the open target is,
   *  and this hands back that subject's own container (see the grid-scope note above). */
  exportDialog: (subject: string): HTMLElement | null => hostContainer('export', subject),
})

/** The container a mounted pane ADOPTS, or undefined when no live surface stands behind that
 *  pane. Adoption is a MOVE of an existing node, never a creation: a pane with no surface (a
 *  hydrated layout, a stale id) must show an honest empty body rather than mint a container that
 *  would then never be filled or retired. */
export function adoptableHost(kind: SurfacePaneKind, surfaceId: string): HTMLElement | undefined {
  return surfaceId ? hosts.get(keyOf(kind, surfaceId))?.node : undefined
}

/** TEST SEAM — drop every container + observer (module-level state outlives a test's render). */
export function resetPaneSurfaceHosts(): void {
  for (const entry of hosts.values()) {
    entry.observer.disconnect()
    entry.node.remove()
  }
  hosts.clear()
  surfaceCloser = null
}

/** TEST SEAM — the live container for a surface, or undefined. Lets a test assert the INV-8
 *  property directly ("two open surfaces resolved to two DIFFERENT nodes"). */
export function peekPaneSurfaceHost(kind: SurfacePaneKind, surfaceId: string): HTMLElement | undefined {
  return hosts.get(keyOf(kind, surfaceId))?.node
}
