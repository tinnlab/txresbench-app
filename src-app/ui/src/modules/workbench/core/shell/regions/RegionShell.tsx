// RegionShell (Phase 2 · fixed 4-region shell) — replaces the free-form dock. Panes are grouped into
// LEFT / CENTER / RIGHT / BOTTOM by kind (regionModel), each region shows its panes as tabs:
//   · center + bottom → a horizontal tab bar on top.
//   · left + right    → a VERTICAL tab strip on the OUTER border, collapsible to just that strip.
// Panes still live in `WorkbenchDock.store.cells` (add/remove/reconciliation reuse it); this only
// arranges them. Resize via simple pointer dividers; sizes/active/collapse persist in the regions store.

import { useEffect, useState, type ReactNode } from 'react'
import { useStore } from 'zustand'
import { Button, Popover, ScrollArea, Tooltip } from '@ziee/kit'
import { X, Plus, ExternalLink, ChevronsLeft, ChevronsRight, PanelLeftClose, PanelRightClose, PanelLeftOpen, PanelRightOpen } from 'lucide-react'
import { Auth } from '@/modules/auth/Auth.store'
import { evaluatePermission } from '@/core/permissions'
import { cn } from '@/lib/utils'
import { workbenchDockStore } from '@/modules/workbench/core/shell/dock/WorkbenchDock.store'
import { type WorkbenchPane, type PaneKind, resolvePaneRenderer, paneTitle, paneKindLabel, paneInsetStyle, isPaneHostedSurface, usePaneSubjectEpoch } from '@/modules/workbench/core/shell/dock/paneModel'
import { closeHostedSurface } from './paneSurfaceHost'
import { paneKindIcon } from '@/modules/workbench/core/shell/dock/paneIcons'
import { clearPaneState } from '@/modules/workbench/core/shell/dock/paneState'
import { destroy as destroyDeclarativeMount } from '@/modules/workbench/core/render/declarativeMount'
import { dismissView } from '@/modules/workbench/core/shell/dock/paneReconcile'
import { RegionTab } from './RegionTab'
import { type Region, regionOfKind, ADDABLE_PANE_KINDS, PANE_KIND_PERMISSION } from './regionModel'
import { workbenchRegionsStore } from './WorkbenchRegions.store'
import { regionPopOut } from './regionPopout'
import { attributeAtPoint, reorderBefore, startPointerDrag } from './pointerDrag'

/**
 * The addable pane kinds the CURRENT session is permitted to open (R4C-05).
 *
 * Mirrors the project-extension registry's own filtering (`useProjectDetailPanels` /
 * `useProjectNavEntries`): read `Auth` reactively, then `evaluatePermission` each
 * gated kind — so an entry appears/disappears as the session's permissions change (a
 * group edit fans a `sync:session` signal), and no fixed-order hook is needed per kind.
 *
 * The "+" menu and the centre empty-picker are the only two places a user can open a pane
 * BY NAME, and before this both offered `reproducibility` to a user without
 * `provenance::read` (the surface moved out of the permission-filtered section nav in
 * 6d231748 and the filter did not move with it).
 */
function usePermittedAddablePaneKinds(): readonly PaneKind[] {
  const { user, permissions } = Auth
  return ADDABLE_PANE_KINDS.filter(k => {
    const required = PANE_KIND_PERMISSION[k]
    return !required || evaluatePermission(user, permissions, required)
  })
}

/** The "+" affordance next to each region's pop-out button: a popover listing the pane
 *  kinds NOT yet open, each of which is added to THIS region (regionModel ITEM — the
 *  `regionOverride` path, like a drag) + focused. `triggerClassName` matches the sibling
 *  pop-out/collapse button so it fits the region's chrome (horizontal bar or vertical strip). */
function AddPaneMenu({
  region,
  triggerClassName,
  side,
}: {
  region: Region
  triggerClassName: string
  side: 'bottom' | 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const cells = useStore(workbenchDockStore, s => s.cells)
  const openKinds = new Set(Object.values(cells).map(c => c.kind))
  const addable = usePermittedAddablePaneKinds().filter(k => !openKinds.has(k))
  const add = (kind: PaneKind) => {
    const id = workbenchDockStore.getState().requestAddPane(kind)
    if (id) workbenchRegionsStore.getState().moveToRegion(id, region)
    setOpen(false)
  }
  return (
    // The tooltip composes straight onto the Popover's trigger. It used to need a wrapper span:
    // a second Base UI trigger on the same element was stamped but never opened, because
    // Tooltip.Trigger keys its store on the `id` it is GIVEN while the Popover's injected `id`
    // won the DOM node. `@ziee/kit` now hoists that `id` onto the trigger (kit/tooltip.tsx,
    // kit/button.tsx), so one element is both triggers again and the wrapper is gone.
    <Popover
      open={open}
      onOpenChange={setOpen}
      side={side}
      align="end"
      className="w-48 p-1"
      content={
        <div className="flex flex-col" data-testid={`region-add-pane-menu-${region}`}>
          {addable.length ? (
            addable.map(k => (
              <button
                key={k}
                type="button"
                onClick={() => add(k)}
                data-testid={`region-add-pane-item-${k}`}
                className="w-full rounded-sm px-2 py-1.5 text-start text-xs text-popover-foreground hover:bg-accent hover:text-accent-foreground"
              >
                {paneKindLabel(k)}
              </button>
            ))
          ) : (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">All panes are open</div>
          )}
        </div>
      }
    >
      {/* A bare "+" on a tab strip is the most-guessed and least-explained glyph in this shell. */}
      <Tooltip content="Add a pane">
        <button
          type="button"
          aria-label="Add a pane"
          data-testid={`region-add-pane-${region}`}
          className={triggerClassName}
        >
          <Plus className="size-3.5" />
        </button>
      </Tooltip>
    </Popover>
  )
}

/** The CENTER region's empty state: instead of a bare "no panes" message, offer the
 *  panes the user can open here — CANVAS always first (the center hero) — each a
 *  click-to-open button that adds it to the center. Excludes already-open panes. */
function CenterEmptyPicker() {
  const cells = useStore(workbenchDockStore, s => s.cells)
  const openKinds = new Set(Object.values(cells).map(c => c.kind))
  const permitted = usePermittedAddablePaneKinds()
  const ordered: PaneKind[] = ['canvas', ...permitted.filter(k => k !== 'canvas')]
  const available = ordered.filter(k => !openKinds.has(k))
  const open = (kind: PaneKind) => {
    const id = workbenchDockStore.getState().requestAddPane(kind)
    if (id) workbenchRegionsStore.getState().moveToRegion(id, 'center')
  }
  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6"
      data-region="center"
      data-testid="region-center"
    >
      <p className="text-sm text-muted-foreground">Open a pane to get started</p>
      <div
        className="flex max-w-lg flex-wrap items-center justify-center gap-2"
        data-testid="center-empty-panes"
      >
        {available.map(k => (
          <button
            key={k}
            type="button"
            onClick={() => open(k)}
            data-testid={`center-open-pane-${k}`}
            className="rounded-md border border-border bg-card px-3 py-1.5 text-sm text-foreground hover:bg-accent hover:text-accent-foreground"
          >
            {paneKindLabel(k)}
          </button>
        ))}
      </div>
      <RegionDropOverlay region="center" />
    </div>
  )
}

/** The panes assigned to a region (kind default + per-pane override), sorted by the region's explicit
 *  tab `order` (drag-reordered ids first; the rest keep cells insertion order). */
function panesInRegion(
  cells: Record<string, WorkbenchPane>,
  override: Record<string, Region>,
  region: Region,
  order: Partial<Record<Region, string[]>>,
): WorkbenchPane[] {
  const list = Object.values(cells).filter(p => (override[p.id] ?? regionOfKind(p.kind)) === region)
  const ord = order[region]
  if (!ord) return list
  const rank = (id: string) => {
    const i = ord.indexOf(id)
    return i === -1 ? Number.MAX_SAFE_INTEGER : i
  }
  return [...list].sort((a, b) => rank(a.id) - rank(b.id))
}

/**
 * WHY A PANE MAY NOT BE CLOSEABLE RIGHT NOW — stated, never a dead button.
 *
 * It is a STATE, not a kind: the dock keeps ≥1 pane across all containers, or the workspace
 * strands with nothing to open anything from. So the LAST pane's close is rendered DISABLED with
 * that as its reason (the `93167985` precedent: a pane that cannot be closed says so, instead of
 * offering a control that silently does nothing).
 *
 * The REASON comes from the dock store (`removeBlockedReason`), which is where the rule is
 * enforced — an affordance that restated the condition here would be a second source, and the two
 * would eventually disagree about whether the click will do anything.
 */
function paneCloseBlockedReason(): string | null {
  return workbenchDockStore.getState().removeBlockedReason()
}

function closePane(id: string) {
  // Capture kind/ref BEFORE removal so a closed contributed-view pane can be recorded as dismissed
  // (else the view-reconciliation effect re-mounts it on the next pass — "closes then reopens").
  const pane = workbenchDockStore.getState().cells[id]
  // A HOSTED SURFACE's close is the SURFACE's, delegated — never `removePane`. The pane is a
  // projection of that surface being open, so removing it alone would leave the surface mounted in
  // a detached container: invisible, with its plot's toggle still lit. `closeHostedSurface` asks the
  // surface to close and the projection follows (the container empties → `retireHost` → this pane
  // goes). Only `no-surface` — a stale/hydrated pane with nothing behind it — falls through to the
  // ordinary removal below, and then there is nothing to strand.
  if (pane && isPaneHostedSurface(pane.kind) && closeHostedSurface(pane.kind, pane.ref ?? '') !== 'no-surface') {
    return
  }
  if (workbenchDockStore.getState().removePane(id)) {
    clearPaneState(id)
    // The pane is GONE, so its declarative store — and the plots that store publishes — go with
    // it. A tab switch does NOT come here (that only unmounts the region), which is the
    // distinction that keeps a user's form and canvas alive across tabs while still releasing a
    // closed pane.
    //
    // Keyed on the pane's `ref` (the ANALYSIS), not on `id`: a declarative store is keyed by its
    // own view-file id, so the pane id matched nothing and disposed nothing.
    if (pane?.kind === 'view' && pane.ref) {
      destroyDeclarativeMount(pane.ref)
      dismissView(pane.ref)
    }
  }
}

// WHERE A PANE'S TITLE LIVES, and it depends on the region's TAB SHAPE rather than on the pane.
//
// A horizontal strip (top/bottom) renders each tab as icon + title, so the title is already on
// screen and readable; a pane header there would print it a second time directly beneath the
// tab and spend a row of height doing it. A side strip (left/right) is an activity-bar: its
// tabs are 36px wide with the title rotated into vertical writing mode, which is an indicator,
// not a legible label. So the side regions carry the title as an ordinary header on top of the
// pane body, and the horizontal ones do not.
//
// This used to be keyed on the pane KIND — only `run`/`rerun`/`artifact`/`compare`/`view` got a
// header — which produced both reported defects at once: a duplicated title on the bottom, and
// NO readable title at all for the durable panes (datasets, visualize, provenance, jobs,
// analyses, artifacts) in the left and right regions, where they mostly live.
//
// EVERY PANE CAN BE CLOSED, FROM ITS TITLE — in both places a title is drawn.
//
// A pane's title appears in exactly two shapes: the region TAB (every region) and the pane HEADER
// (the side regions, where the tab is a 36px vertical indicator rather than a legible label). The
// close lives on BOTH, for every kind, so "where do I close this?" has the same answer wherever a
// user is looking. It used to be neither-for-some: hosted surfaces were excluded outright, and the
// header's X was gated on the DISMISSABLE set below.
//
// What the kind still decides is only VISIBILITY on the tab: a transient, action-created pane
// shows its X always (a user who opened one by gesture must see how to get rid of it), a durable
// structural pane shows it on hover (an always-on X on every tab is noise). A hosted surface is
// transient by construction — it exists only while its canvas surface is open — so it joins the
// always-visible set by DERIVATION rather than by being written into it.

const DISMISSABLE_PANE_KINDS: ReadonlySet<PaneKind> = new Set<PaneKind>([
  'run',
  'rerun',
  'artifact',
  'compare',
  'view',
])

/** Is this pane's tab close always visible (vs. shown on hover)? */
function tabCloseAlwaysVisible(kind: PaneKind): boolean {
  return DISMISSABLE_PANE_KINDS.has(kind) || isPaneHostedSurface(kind)
}

/**
 * …and no POP-OUT either, for the same reason one layer down.
 *
 * A popped-out pane renders its body into ANOTHER OS WINDOW's document
 * (`RegionPopoutWindows` → `@ziee/dock`'s `ContainerWindows`). A hosted surface's body is a
 * container the OWNING engine has already portaled a React tree into, in THIS document, with
 * this document's stylesheet and this document's overlay roots. Moving that node across
 * documents is not a thing the shell can promise, so the affordance is withheld rather than
 * offered and silently broken. The plot it belongs to is in this window anyway.
 */
function paneHasShellPopOut(kind: PaneKind): boolean {
  return !isPaneHostedSurface(kind)
}

/** A pane's chrome + content. Exported so the gallery can mount the REAL pane body for every
 *  kind in the registry (`workbench-pane-padding`) — the pane's content inset is a shell
 *  property, and a property of the shell has to be measurable on the shell's own element. */
export function PaneBody({ pane, titled }: { pane: WorkbenchPane; titled: boolean }) {
  // A pane's TITLE is not a pure function of the pane map: a `jobs` pane is opened with a job id
  // and learns the job's NAME on a later poll (`paneModel`'s subject resolvers). This is the one
  // subscription that lets the header re-read it — ONE per component, never one per pane, so the
  // hook count cannot depend on how many panes are open.
  usePaneSubjectEpoch()
  const Renderer = resolvePaneRenderer(pane.kind)
  const Icon = paneKindIcon(pane.kind)
  const closeBlocked = paneCloseBlockedReason()
  return (
    // THE PANE BODY CARRIES NO INSET. It is a full-bleed column of [header bar][content region],
    // and the shell's ONE inset lives on the region (`paneInsetStyle`) — see `paneModel`'s
    // "WHERE IT LANDS". Putting it here instead inset all three of the pane's boxes at once:
    // the header's border stopped short of both edges, the scroll viewport's bar floated 8px
    // inside the pane, and there was no way left to state the gap UNDER the header.
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      data-testid={`region-pane-body-${pane.id}`}
    >
      {/* FULL-BLEED header bar: its `border-b` spans the pane edge to edge and its background
          reaches both sides, so it reads as the pane's header rather than as a card floating
          inside it. `ps-3 pe-1.5` is the BAR's own internal padding — not the shell's content
          inset, which is on the region below and must not reach up here.
          A HOSTED SURFACE gets this same header (viz renders the surface headerless underneath
          it, `PaneEditForm`/`PlotDataTable` `hosted`), so exactly one title is on screen. */}
      {titled ? (
        <div
          className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border bg-muted/40 ps-3 pe-1.5"
          data-testid={`pane-header-${pane.id}`}
        >
          <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{paneTitle(pane)}</span>
          {/* WHAT THE HOVER TEXT SAYS DEPENDS ON WHETHER THE CLOSE WORKS — and the accessible
              NAME never changes. Live: the tooltip is the name, because an X is only obvious
              until there are four of them on one strip. Blocked: the tooltip is the REASON,
              which is what the native `title` used to carry — the kit tooltip replaces it so
              the two states use one mechanism instead of "styled tooltip, except when it
              matters". The reason ALSO reaches assistive tech through `aria-describedby` on an
              sr-only node, because a tooltip is in the tree only while it is open, and a
              a blocked close is `aria-disabled`, NOT natively `disabled`.

              THAT DISTINCTION IS WHY THE HOVER TEXT CAN EXIST AT ALL, and it was measured
              rather than assumed — twice, because the first measurement was the wrong one. A
              `mouseenter` listener attached DIRECTLY to a natively-disabled <button> does fire,
              which reads like "hover works". But `mouseover` does not ESCAPE the element: a
              document-level listener sees nothing at all (measured: zero events, capture and
              bubble), and React delegates at the root, so no React handler ever runs and the
              tooltip cannot open no matter what `pointer-events` says. `aria-disabled` keeps ONE
              element that is hoverable, focusable and announced unavailable, with activation
              refused structurally by passing no handler — the kit's own idiom for `loading`, and
              the `93167985` precedent from the viz pane toolbar.
              The name is deliberately NOT swallowed by the reason: see the same call in
              `viz` PaneToolbar's `blockedAction`. */}
          <Tooltip content={closeBlocked ?? `Close ${paneTitle(pane)}`}>
            <button
              type="button"
              aria-label={`Close ${paneTitle(pane)}`}
              aria-describedby={closeBlocked ? `pane-header-close-why-${pane.id}` : undefined}
              data-testid={`pane-header-close-${pane.id}`}
              // NO `onClick` when blocked: activation is refused STRUCTURALLY, by there being no
              // handler, rather than by a guard inside a live one that someone can forget.
              onClick={closeBlocked ? undefined : () => closePane(pane.id)}
              aria-disabled={closeBlocked !== null || undefined}
              className="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground aria-disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:hover:bg-transparent"
            >
              <X className="size-4" />
            </button>
          </Tooltip>
          {closeBlocked ? (
            <span id={`pane-header-close-why-${pane.id}`} className="sr-only">
              {closeBlocked}
            </span>
          ) : null}
        </div>
      ) : null}
      {/* THE CONTENT REGION — the one element the shell's inset is on. Its TOP side is what
          clears the header's border (the body would otherwise start against it and the title
          would read as fused to the content); the other three are the pane's content inset. A
          pane's own scroll track bleeds back out of the horizontal half (`PaneScroll`) so its
          bar sits at the pane's edge with the content still inset. */}
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        style={paneInsetStyle(pane.kind)}
        data-testid={`region-pane-content-${pane.id}`}
      >
        <Renderer pane={pane} />
      </div>
    </div>
  )
}

// ── drag panes BETWEEN regions ──────────────────────────────────────────────────────────────────
// A tab is a drag source (click-vs-drag threshold: a plain click activates; movement starts a drag).
// While dragging, the region under the cursor (hit-tested via `data-region` + elementFromPoint) is the
// drop target; releasing over a region moves the pane there (`moveToRegion`). Each region shows a drop
// overlay while a drag is live; an EMPTY region shows a thin drop strip so you can move a pane into it.
function regionAtPoint(x: number, y: number): Region | null {
  const r = attributeAtPoint(x, y, 'data-region')
  return r === 'left' || r === 'center' || r === 'right' || r === 'bottom' ? r : null
}
/** The pane id of the tab under the cursor (for reorder insert-position), or null (drop past the tabs). */
function tabAtPoint(x: number, y: number): string | null {
  const t = document.elementFromPoint(x, y)?.closest('[role="tab"]')?.getAttribute('data-testid')
  return t?.startsWith('region-tab-') ? t.slice('region-tab-'.length) : null
}
/**
 * A tab press → a possible region drag. The threshold, the ghost, the selection suppression
 * and the elementFromPoint resolution all live in `pointerDrag` now (visualize-pane ITEM-9
 * needed the same mechanism vertically, and one drag stack is the point); what stays here is
 * the only part that is about REGIONS — which target a drop resolves to, and what moving a
 * pane there means.
 */
function startTabDrag(paneId: string, label: string, e: React.PointerEvent) {
  startPointerDrag({
    label,
    event: e,
    onStart: () => workbenchRegionsStore.getState().startDrag(paneId),
    onMove: (x, y) => workbenchRegionsStore.getState().setDragOver(regionAtPoint(x, y)),
    // A CANCELLED drag (an interrupted touch, Escape) never reaches `onDrop`, so the drag
    // state this handler put into the store has to be torn down on that path too — otherwise
    // `dragPaneId`/`dragOverRegion` stay set and the drop overlays hang on a highlighted
    // region until the next drag happens to clear them. The primitive grew `pointercancel`
    // handling for the SECTION drag; this is the tab drag's half of the same fix, and it is
    // the reason `onCancel` is a callback of its own rather than `onDrop(moved: false)`.
    onCancel: () => workbenchRegionsStore.getState().endDrag(),
    onDrop: (x, y, moved) => {
      if (!moved) return
      const target = regionAtPoint(x, y)
      const s = workbenchRegionsStore.getState()
      if (target) {
        // Insert the dragged pane before the tab under the cursor (reorder), or append when dropped past
        // the tabs / on the body. Works both WITHIN a region (reorder) and ACROSS regions (move + place).
        const cells = workbenchDockStore.getState().cells
        const ids = panesInRegion(cells, s.regionOverride, target, s.order).map(p => p.id)
        s.moveToRegion(paneId, target)
        s.setRegionOrder(target, reorderBefore(ids, paneId, tabAtPoint(x, y)))
      }
      s.endDrag()
    },
  })
}

/** The drop-target highlight drawn on a region while a pane is being dragged. */
function RegionDropOverlay({ region }: { region: Region }) {
  const dragging = useStore(workbenchRegionsStore, s => s.dragPaneId !== null)
  const over = useStore(workbenchRegionsStore, s => s.dragOverRegion === region)
  if (!dragging) return null
  return (
    <div
      aria-hidden="true"
      data-testid={`region-drop-${region}`}
      className={cn(
        'pointer-events-none absolute inset-0 z-40 border-2 transition-colors',
        over ? 'border-primary bg-primary/15' : 'border-dashed border-primary/25',
      )}
    />
  )
}

/** A thin drop strip shown (only while dragging) so a pane can be moved into an EMPTY region. */
function EmptyDropZone({ region, orientation }: { region: Region; orientation: 'v' | 'h' }) {
  const over = useStore(workbenchRegionsStore, s => s.dragOverRegion === region)
  return (
    <div
      data-region={region}
      data-testid={`region-empty-drop-${region}`}
      className={cn(
        'flex shrink-0 items-center justify-center border-dashed border-primary/40 text-[11px] text-muted-foreground transition-colors',
        orientation === 'v' ? 'w-10 border-x' : 'h-10 border-y',
        over ? 'bg-primary/20 text-primary' : 'bg-muted/30',
      )}
    >
      <span className={orientation === 'v' ? '[writing-mode:vertical-rl]' : ''}>Drop here</span>
    </div>
  )
}

// ── THE TAB STRIPS SCROLL ON THE KIT TRACK, AND THE TABLIST STILL OWNS ITS TABS ────────────────
//
// Both strips used a native `overflow-*-auto` while every other scrolling surface in the
// workbench had moved to the kit `ScrollArea` (overlayscrollbars). 74d7ed9c excluded these two
// deliberately, and the reason it gave was real but narrower than it read:
//
//   "OverlayScrollbars interposes wrapper divs that break the composite role's required
//    parent-child relation (axe aria-required-children)."
//
// That is true of REPLACING a composite element with the scroller — the react component renders
// `<host data-overlayscrollbars-initialize><div data-overlayscrollbars-contents>{children}</div>`,
// so a `role="tablist"` turned into the host has a plain div between it and its `role="tab"`
// children, and `aria-required-children` fails. It is NOT true of WRAPPING it: the interposed div
// lands ABOVE the tablist, and tablist → tab stays a direct parent-child relation.
//
// So the strips are wrapped, never converted. The horizontal strip already had a wrapper (the
// scroller was never the tablist there); the vertical rail did not, and gets one. Both properties
// are measured rather than asserted in prose — `tests/e2e/14-workbench/region-tab-strip.spec.ts`
// checks the overlay bar appears on real overflow AND runs axe over the rendered rail.
//
// `autoHide="leave"` (the kit dropdown's setting) rather than the `scroll` default: a tab strip
// is 32px/36px of chrome, and a bar that only appears mid-gesture never tells a user there is
// more to reach. It still takes no layout space, which is why the strip did not have to give up
// any of its 36px.
/**
 * The scroll track a region's tab strip sits on. `children` must contain the `role="tablist"`
 * element itself — this wraps it, and must never become it.
 *
 * NO `axis`, and that is a measured decision rather than an omission. Pinning each strip to its
 * one axis reads like the obvious thing to state, but neither strip can overflow on its CROSS
 * axis — a horizontal bar's tabs are `h-full` inside a 32px row and a rail tab's vertical label
 * `truncate`s inside 36px — so `overflow: hidden` and `overflow: scroll` there render identically.
 * A mutation dropping the prop was killed by NOTHING at either tier, and no fixture can hold a
 * window the layout does not have. It is gone rather than kept as belt-and-braces that hides
 * which mechanism is load-bearing (`AnalysisRunList`'s `shrink-0`/`w-full` precedent).
 */
function TabStripScroll({
  region,
  className,
  children,
}: {
  region: Region
  className: string
  children: ReactNode
}) {
  return (
    <ScrollArea
      autoHide="leave"
      className={className}
      data-testid={`region-tabs-scroll-${region}`}
    >
      {children}
    </ScrollArea>
  )
}

// ── horizontal top-tab regions (center / bottom) ────────────────────────────────────────────────
function TopTabRegion({ region, panes, activeId }: { region: Region; panes: WorkbenchPane[]; activeId: string }) {
  const active = panes.find(p => p.id === activeId) ?? panes[0]
  // Recomputed on every render of this region (`cells` drives it, and a region re-renders when a
  // pane is added or removed) — so the last pane's close disables and re-enables with the count.
  const closeBlocked = paneCloseBlockedReason()
  // The BOTTOM region gets two edge toggles that extend the bottom panel under the
  // left / right side region (a full-width bottom panel).
  const isBottom = region === 'bottom'
  const extendLeft = useStore(workbenchRegionsStore, s => s.bottomExtendLeft)
  const extendRight = useStore(workbenchRegionsStore, s => s.bottomExtendRight)
  const extendBtnClass = (active: boolean) =>
    cn(
      'flex shrink-0 items-center justify-center px-2 hover:bg-accent hover:text-foreground',
      active ? 'bg-accent text-foreground' : 'text-muted-foreground',
    )
  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-col bg-card" data-region={region} data-testid={`region-${region}`}>
      <div className="flex h-8 shrink-0 items-stretch border-b border-border bg-muted/40">
       {/* A double chevron whose direction FLIPS with state is the least self-explaining glyph
           on this bar — it says "sideways", not what it does. The hover text is the accessible
           name, so the two cannot drift. */}
       {isBottom ? (
         <Tooltip content="Extend the bottom panel under the left region">
         <button
           type="button"
           onClick={() => workbenchRegionsStore.getState().toggleBottomExtend('left')}
           aria-label="Extend the bottom panel under the left region"
           aria-pressed={extendLeft}
           data-testid="region-bottom-extend-left"
           className={cn(extendBtnClass(extendLeft), 'border-e border-border')}
         >
           {/* Direction reflects state: not-extended → push left; extended → pull back right. */}
           {extendLeft ? <ChevronsRight className="size-3.5" /> : <ChevronsLeft className="size-3.5" />}
         </button>
         </Tooltip>
       ) : null}
       <TabStripScroll region={region} className="min-w-0 flex-1">
        {/* One flex ROW inside the track's viewport: the viewport itself is a plain block the
            scroller owns, so the strip's own layout (tabs stretched to the bar's height, then
            the "+") is stated here rather than on it. */}
        <div className="flex h-full items-stretch">
        <div role="tablist" className="flex items-stretch">
        {panes.map(p => {
          const isActive = p.id === active?.id
          const Icon = paneKindIcon(p.kind)
          return (
            <RegionTab
              key={p.id}
              pane={p}
              isActive={isActive}
              closeBlocked={closeBlocked}
              onActivate={() => workbenchRegionsStore.getState().setActive(region, p.id)}
              onClose={() => closePane(p.id)}
              onDragStart={e => startTabDrag(p.id, paneTitle(p), e)}
              // Text is CENTERED; the close X is absolutely positioned so it doesn't shift the label
              // (the tab reads centered when the X is hidden).
              className={cn(
                // Symmetric px reserves room for the absolutely-positioned close X on the right — the
                // label stays centered AND never sits under it (min-w keeps short tabs usable).
                'group/tab relative flex min-w-24 max-w-48 cursor-default select-none items-center justify-center gap-1.5 border-e border-border px-5 text-xs',
                isActive ? 'bg-card font-medium text-foreground' : 'text-muted-foreground hover:bg-accent',
              )}
              closeClassName={cn(
                'absolute end-0.5 top-1/2 size-4 -translate-y-1/2',
                // A blocked close must be VISIBLE to state its reason — a hover-only unavailable
                // control is a control the user never finds out about.
                tabCloseAlwaysVisible(p.kind) || closeBlocked ? 'opacity-100' : 'opacity-0 group-hover/tab:opacity-100',
              )}
            >
              <Icon aria-hidden className="size-3.5 shrink-0" />
              <span className="min-w-0 truncate">{paneTitle(p)}</span>
            </RegionTab>
          )
        })}
        </div>
        <AddPaneMenu
          region={region}
          side="bottom"
          triggerClassName="flex shrink-0 items-center justify-center px-2 text-muted-foreground hover:bg-accent hover:text-foreground"
        />
        </div>
       </TabStripScroll>
       {active && paneHasShellPopOut(active.kind) ? (
         <Tooltip content={`Open ${paneTitle(active)} in a window`}>
         <button
           type="button"
           onClick={() => regionPopOut(active.id)}
           aria-label={`Open ${paneTitle(active)} in a window`}
           data-testid={`region-popout-${active.id}`}
           className="flex shrink-0 items-center justify-center border-s border-border px-2 text-muted-foreground hover:bg-accent hover:text-foreground"
         >
           <ExternalLink className="size-3.5" />
         </button>
         </Tooltip>
       ) : null}
       {isBottom ? (
         <Tooltip content="Extend the bottom panel under the right region">
         <button
           type="button"
           onClick={() => workbenchRegionsStore.getState().toggleBottomExtend('right')}
           aria-label="Extend the bottom panel under the right region"
           aria-pressed={extendRight}
           data-testid="region-bottom-extend-right"
           className={cn(extendBtnClass(extendRight), 'border-s border-border')}
         >
           {extendRight ? <ChevronsLeft className="size-3.5" /> : <ChevronsRight className="size-3.5" />}
         </button>
         </Tooltip>
       ) : null}
      </div>
      {active ? <PaneBody pane={active} titled={false} /> : null}
      <RegionDropOverlay region={region} />
    </div>
  )
}

// ── side regions (left / right) — vertical border tab strip + collapse ──────────────────────────
function SideRegion({ region, panes, activeId }: { region: 'left' | 'right'; panes: WorkbenchPane[]; activeId: string }) {
  const collapsed = useStore(workbenchRegionsStore, s => s.collapsed[region])
  const leftWidth = useStore(workbenchRegionsStore, s => s.leftWidth)
  const rightWidth = useStore(workbenchRegionsStore, s => s.rightWidth)
  const active = panes.find(p => p.id === activeId) ?? panes[0]
  const closeBlocked = paneCloseBlockedReason()
  const isLeft = region === 'left'
  const width = isLeft ? leftWidth : rightWidth

  const strip = (
    <div className={cn('flex w-9 shrink-0 flex-col bg-muted/40', isLeft ? 'border-e' : 'border-s', 'border-border')} data-testid={`region-strip-${region}`}>
      {/* THE RAIL SCROLLS, and that is load-bearing rather than cosmetic. The tabs carry
          VERTICAL text, so a pane with a long title is tall; two panes overflow a normal-height
          rail. Without a scroll track the list simply grew past its bounds and everything after
          it — including the "Add a pane" trigger that used to live INSIDE this list — was laid
          out on top of the fixed controls below, where the pop-out button silently intercepted
          its pointer events. The control was visible, enabled and stable, and unclickable.
          The track is now the kit's (see TabStripScroll): it WRAPS the tablist rather than
          being it, so `tablist → tab` stays a direct parent-child relation and the composite
          role survives — the `min-h-0 flex-1` bound moves onto the track, and the tablist keeps
          only its own column layout. */}
      <TabStripScroll region={region} className="min-h-0 flex-1">
      <div role="tablist" aria-orientation="vertical" className="flex flex-col">
        {panes.map(p => {
          const isActive = !collapsed && p.id === active?.id
          const Icon = paneKindIcon(p.kind)
          const activateTab = () => {
            workbenchRegionsStore.getState().setActive(region, p.id)
            if (collapsed) workbenchRegionsStore.getState().toggleCollapse(region)
          }
          return (
            <RegionTab
              key={p.id}
              pane={p}
              isActive={isActive}
              closeBlocked={closeBlocked}
              onActivate={activateTab}
              onClose={() => closePane(p.id)}
              onDragStart={e => startTabDrag(p.id, paneTitle(p), e)}
              title={paneTitle(p)}
              // Active indicator = a pseudo border on the INNER edge (left region → right, right region →
              // left), FLUSH with the strip's border (no margin). Icon stacks upright ABOVE the
              // vertical label (activity-bar style).
              className={cn(
                'group/tab relative flex shrink-0 cursor-default flex-col items-center justify-center gap-1.5 py-5 text-xs',
                'after:pointer-events-none after:absolute after:inset-y-0 after:w-0.5 after:content-[""]',
                isLeft ? 'after:right-0' : 'after:left-0',
                isActive
                  ? 'bg-card font-medium text-foreground after:bg-primary'
                  : 'text-muted-foreground after:bg-transparent hover:bg-accent hover:text-accent-foreground',
              )}
              closeClassName={cn(
                // `left-1/2` + `-translate-x-1/2` is the symmetric CENTERING idiom: it centres
                // identically under either direction, where `start-1/2` would not.
                'absolute left-1/2 top-1 size-4 -translate-x-1/2', // rtl-ok: centering anchor
                tabCloseAlwaysVisible(p.kind) || closeBlocked ? 'opacity-100' : 'opacity-0 group-hover/tab:opacity-100',
              )}
            >
              <Icon aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate [writing-mode:vertical-rl]" style={isLeft ? { transform: 'rotate(180deg)' } : undefined}>
                {paneTitle(p)}
              </span>
            </RegionTab>
          )
        })}
      </div>
      </TabStripScroll>
      {/* OUTSIDE the scrolling list: "add a pane" must stay reachable no matter how many panes
          are open. Inside it, the affordance for opening one more pane was the first thing to
          scroll away once enough panes existed to need it. */}
      <AddPaneMenu
        region={region}
        side={isLeft ? 'right' : 'left'}
        triggerClassName="flex h-8 shrink-0 items-center justify-center border-t border-border text-muted-foreground hover:bg-accent hover:text-foreground"
      />
      {active && paneHasShellPopOut(active.kind) ? (
        <Tooltip content={`Open ${paneTitle(active)} in a window`}>
        <button
          type="button"
          onClick={() => regionPopOut(active.id)}
          aria-label={`Open ${paneTitle(active)} in a window`}
          data-testid={`region-popout-${active.id}`}
          className="flex h-8 items-center justify-center border-t border-border text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ExternalLink className="size-4" />
        </button>
        </Tooltip>
      ) : null}
      {/* Default side, like every peer on this strip. A lone dissenter is its own lint finding
          (J9 — peer buttons in one group must agree), and base-ui flips a tooltip that will not
          fit anyway, so a hand-picked side buys nothing here. */}
      <Tooltip content={collapsed ? `Expand ${region} panel` : `Collapse ${region} panel`}>
      <button
        type="button"
        aria-label={collapsed ? `Expand ${region} panel` : `Collapse ${region} panel`}
        data-testid={`region-collapse-${region}`}
        onClick={() => workbenchRegionsStore.getState().toggleCollapse(region)}
        className="flex h-8 items-center justify-center border-t border-border text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        {isLeft
          ? collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />
          : collapsed ? <PanelRightOpen className="size-4" /> : <PanelRightClose className="size-4" />}
      </button>
      </Tooltip>
    </div>
  )

  const content = collapsed ? null : (
    <div className="flex min-h-0 min-w-0 flex-col bg-card" style={{ width }} data-testid={`region-${region}`}>
      {active ? <PaneBody pane={active} titled /> : null}
    </div>
  )

  const divider = collapsed ? null : (
    <ResizeDivider axis="x" onDelta={dx => {
      const s = workbenchRegionsStore.getState()
      isLeft ? s.setLeftWidth(s.leftWidth + dx) : s.setRightWidth(s.rightWidth - dx)
    }} />
  )

  // Left: [strip][content][divider] · Right: [divider][content][strip] — the strip hugs the OUTER edge.
  return (
    <div className="relative flex h-full min-h-0 shrink-0" data-region={region}>
      {isLeft ? <>{strip}{content}{divider}</> : <>{divider}{content}{strip}</>}
      <RegionDropOverlay region={region} />
    </div>
  )
}

// ── a pointer-drag resize divider ───────────────────────────────────────────────────────────────
function ResizeDivider({ axis, onDelta }: { axis: 'x' | 'y'; onDelta: (delta: number) => void }) {
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const start = axis === 'x' ? e.clientX : e.clientY
    let last = start
    const onMove = (ev: PointerEvent) => {
      const cur = axis === 'x' ? ev.clientX : ev.clientY
      onDelta(cur - last)
      last = cur
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  // Fixed 1px line — a `::before` pseudo widens the GRAB/hover area WITHOUT changing the line's size
  // (no layout shift on hover). Only the color changes on hover.
  return (
    <div
      role="separator"
      onPointerDown={onPointerDown}
      className={cn(
        'relative z-10 shrink-0 bg-border transition-colors hover:bg-primary/50 before:absolute before:content-[""]',
        axis === 'x'
          ? 'w-px cursor-col-resize before:inset-y-0 before:-inset-x-1'
          : 'h-px cursor-row-resize before:inset-x-0 before:-inset-y-1',
      )}
    />
  )
}

export function RegionShell() {
  // Re-render every tab strip when a pane's SUBJECT may have changed (a job's name arriving on a
  // poll). One subscription for the whole shell — the tab components below are not memoised, so
  // this render reaches all of them. See `PaneBody` for why it is not per-tab.
  usePaneSubjectEpoch()
  const cells = useStore(workbenchDockStore, s => s.cells)
  const active = useStore(workbenchRegionsStore, s => s.active)
  const collapsedBottom = useStore(workbenchRegionsStore, s => s.collapsed.bottom)
  const bottomHeight = useStore(workbenchRegionsStore, s => s.bottomHeight)
  const override = useStore(workbenchRegionsStore, s => s.regionOverride)
  const order = useStore(workbenchRegionsStore, s => s.order)
  const poppedOut = useStore(workbenchRegionsStore, s => s.poppedOut)
  const dragging = useStore(workbenchRegionsStore, s => s.dragPaneId !== null)
  const extendLeftRaw = useStore(workbenchRegionsStore, s => s.bottomExtendLeft)
  const extendRightRaw = useStore(workbenchRegionsStore, s => s.bottomExtendRight)
  const activeHistory = useStore(workbenchRegionsStore, s => s.activeHistory)

  // Prune region-arrangement entries for panes no longer open (covers EVERY removal path —
  // close button, action, entity self-close — since this re-runs whenever the pane map changes).
  useEffect(() => {
    workbenchRegionsStore.getState().reconcilePanes(Object.keys(cells))
  }, [cells])

  const activeIn = (region: Region, panes: WorkbenchPane[]): string => {
    const a = active[region]
    if (a && panes.some(p => p.id === a)) return a
    // The active tab was closed → activate the most-recently-active pane still open
    // (the PREVIOUS active), not always the first tab.
    const prev = (activeHistory[region] ?? []).find(id => panes.some(p => p.id === id))
    return prev ?? panes[0]?.id ?? ''
  }

  const notPopped = (p: WorkbenchPane) => !poppedOut[p.id]
  const left = panesInRegion(cells, override, 'left', order).filter(notPopped)
  const center = panesInRegion(cells, override, 'center', order).filter(notPopped)
  const right = panesInRegion(cells, override, 'right', order).filter(notPopped)
  const bottom = panesInRegion(cells, override, 'bottom', order).filter(notPopped)

  // The bottom pane can EXTEND under a side region (a full-width bottom panel). Only
  // meaningful when a bottom pane exists; an extended side sits ABOVE the bottom
  // (inside the middle "extended column") instead of full-height beside it.
  const hasBottom = bottom.length > 0
  const extendLeft = hasBottom && extendLeftRaw
  const extendRight = hasBottom && extendRightRaw

  const leftRegion =
    left.length > 0 ? (
      <SideRegion region="left" panes={left} activeId={activeIn('left', left)} />
    ) : dragging ? (
      <EmptyDropZone region="left" orientation="v" />
    ) : null
  const rightRegion =
    right.length > 0 ? (
      <SideRegion region="right" panes={right} activeId={activeIn('right', right)} />
    ) : dragging ? (
      <EmptyDropZone region="right" orientation="v" />
    ) : null
  const centerContent =
    center.length > 0 ? (
      <TopTabRegion region="center" panes={center} activeId={activeIn('center', center)} />
    ) : (
      <CenterEmptyPicker />
    )

  return (
    <div className="flex min-h-0 flex-1" data-testid="workbench-region-shell">
      {/* left FULL-height beside the bottom, UNLESS the bottom extends under it. */}
      {!extendLeft && leftRegion}

      {/* The "extended column": (top row: [extL left] center [extR right]) over the bottom,
          so the bottom spans the width of whatever the extended sides added. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 min-w-0 flex-1">
          {extendLeft && leftRegion}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">{centerContent}</div>
          {extendRight && rightRegion}
        </div>
        {hasBottom ? (
          <>
            {!collapsedBottom ? (
              <ResizeDivider axis="y" onDelta={dy => {
                const s = workbenchRegionsStore.getState()
                s.setBottomHeight(s.bottomHeight - dy)
              }} />
            ) : null}
            <div className="flex shrink-0 flex-col" style={{ height: collapsedBottom ? 32 : bottomHeight }} data-testid="region-bottom-wrap">
              <TopTabRegion region="bottom" panes={bottom} activeId={activeIn('bottom', bottom)} />
            </div>
          </>
        ) : dragging ? (
          <EmptyDropZone region="bottom" orientation="h" />
        ) : null}
      </div>

      {/* right FULL-height beside the bottom, UNLESS the bottom extends under it. */}
      {!extendRight && rightRegion}
    </div>
  )
}
