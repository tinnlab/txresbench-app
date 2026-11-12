// AnnotateControls.tsx — the annotation tool rail + class/label panel for one image cell.
// Presentational shell over the per-cell `AnnotateStore` (read through the `AnnotateContext`):
//   • a vertical TOOL RAIL (Select / Polygon / Point / Brush / Reshape) with an active-edge
//     indicator, mirroring `controls/VizToolRail`; plus Undo/Redo + Finish (while drawing).
//   • a CLASS/LABEL panel — a class list with a colour swatch + inline rename + add-class,
//     mirroring `PaneEditForm`'s `Categories` rows.
// Every action routes to the store; no local editing state lives here (the drawing gesture is
// owned by `useAnnotateEditor`). Built on @txresbench/kit + lucide to match the workbench chrome.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type React from 'react'
import { Button, Input } from '@txresbench/kit'
// BLIND-AUDIT M12/M14: `Download` was ALSO the pane toolbar's registered "Export this pane" glyph
// and the rail's "Export whole grid" — three verbs, one glyph, all reachable on one screen. Handing
// counted points to a segmenter is not an export, so it gets its own mark. `CircleDot` distinguishes
// class-ACTIVATE (a mode switch) from `Check` = Finish-the-polygon (a commit) inside this one dock.
// CONVERGENCE (low) — `Ban`, not `Eraser`: the rail already uses `Eraser` for "Clear selection", and
// two different verbs wearing one glyph on the same screen is the collision INV-14 exists to stop.
// Cancelling an in-progress polygon is an ABORT, which `Ban` reads as; `Eraser` reads as "wipe what
// is committed", which is the rail's verb, not this one.
import { Undo2, Redo2, Check, CircleDot, Plus, Sprout, Ban } from 'lucide-react'
import { useAnnotate, useAnnotateStore } from './AnnotateContext'
import { annotationTally, pointSeedFeatures } from './Annotate.store'
import type { GeoFeature } from './processorPort'
import { toolsForSurface } from '../tools/registry'
import type { AnnotateTool } from './annotateModel'

const ICON = 'size-3.5'

/** A default swatch for a freshly-added class (overridable via the colour input). */
const DEFAULT_NEW_CLASS_COLOR: [number, number, number] = [37, 99, 235]

function rgbToHex(c: readonly [number, number, number]): string {
  return '#' + c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')
}
function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim())
  if (!m) return DEFAULT_NEW_CLASS_COLOR
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]
}

export interface AnnotateControlsProps {
  /** in-progress polygon vertex count (from `useAnnotateEditor`) — drives Finish. */
  readonly polyDraftLength?: number
  readonly onFinishPolygon?: () => void
  /** BLIND-AUDIT M8 — abandon an in-progress polygon at ANY vertex count. Finish needs 3 and the
   *  close-target is inert below 3, so a 1-2 vertex draft previously had no way out at all. */
  readonly onCancelPolygon?: () => void
  /**
   * ITEM-16 — hand this pane's counted points OUT as `ProcessorPort` `GeoFeature`s (click/marker
   * seeds for an external segmenter). Optional: the button appears only when a host wires it, so
   * a viewer-only embed shows no dead affordance. The editor still runs no model (INV-3).
   */
  readonly onExportSeeds?: (features: GeoFeature[]) => void
  /**
   * BLIND-AUDIT H4 (DEC-16) — when `true`, this dock ALSO answers the 1-9 class hotkeys while focus
   * is anywhere in the document, not just inside its own subtree.
   *
   * The hotkeys used to be bound ONLY as an `onKeyDown` on this focusable root. That is dead in the
   * one workflow they exist for: dropping a point presses the pane's draw overlay, which moves DOM
   * focus out of the panel, so every subsequent digit went nowhere — "the counter's hand stays on
   * the keyboard while the other clicks" was never delivered. (The e2e passed only because it called
   * `.focus()` immediately before the keypress — the test manufactured the one condition that made
   * the feature work.)
   *
   * The original objection to a global binding — "with N panes open there is no active pane a global
   * hotkey could unambiguously target" — is answered by the pane the user is CLICKING IN: the host
   * already tracks it synchronously to route the gesture, exactly one pane holds it, and it is
   * visible (that is the pane taking the points). This is not a hidden mode; it is the same binding
   * the pointer already uses. Hosts pass `hotkeyActive={boundPane === thisPane}`; a standalone
   * single-pane host can leave it unset and keep the focus-scoped behaviour.
   */
  readonly hotkeyActive?: boolean
  /**
   * Stretch the rail + class panel to the container's FULL height (`h-full`). `true` (default) for a
   * DEDICATED, full-height host container — the showcase asides, where a rail that stopped mid-panel
   * would read as unfinished.
   *
   * Pass `false` when these controls are ONE OF N STACKED docks (the grid's internal right panel, via
   * `InternalDockSection`). There the percentage resolved against the whole dock's flex-resolved
   * height and pushed the sibling `AnnotateHierarchyPanel` OUTSIDE the dock's box, where it painted
   * over the next pane's dock — the per-pane overlap defect. Sized to its content the dock lays out
   * cleanly and the dock's own scroll area absorbs any excess.
   */
  readonly fill?: boolean
  readonly 'data-testid'?: string
}

/** The annotate tools, in registry order with registry labels + glyphs (INV-14). Ordering is the
 *  registry's `order` — ascending primitive complexity, select → point (0-D) → polygon (2-D) →
 *  brush (raster) — so it cannot drift apart from the other surfaces again. */
const ANNOTATE_TOOLS = toolsForSurface('annotate')

/** Marks an annotate-controls root so the 1-9 window listener can tell "this keystroke originated
 *  inside SOME dock" (⇒ that dock's own React handler owns it) from "focus has left every dock"
 *  (⇒ the armed dock owns it). Keyed off a data attribute rather than a testid so the scoping rule
 *  survives any testid rename (convergence H4). */
export const DOCK_SCOPE_ATTR = 'data-annotate-dock'

export function AnnotateControls({
  polyDraftLength = 0,
  onFinishPolygon,
  onCancelPolygon,
  onExportSeeds,
  hotkeyActive = false,
  fill = true,
  'data-testid': testId = 'annotate-controls',
}: AnnotateControlsProps) {
  const store = useAnnotateStore()
  // Authoring intent (tool / class vocabulary / active class) is strictly PER-PANE (DEC-17, amended
  // INV-11). The workspace-shared authoring store that used to intercept these writes is deleted:
  // with N datasets side by side, pane A brushing Tumour while pane B outlines Stroma is the point,
  // not an edge case. Every write goes straight to this pane's own store.
  const authoring = {
    setTool: (t: AnnotateTool) => store.getState().setTool(t),
    setActiveClass: (id: string | null) => store.getState().setActiveClass(id),
    addClass: (c: { name: string; color: readonly [number, number, number] }) =>
      store.getState().addClass(c),
    updateClass: (id: string, p: { name?: string; color?: readonly [number, number, number] }) =>
      store.getState().updateClass(id, p),
  }
  const activeTool = useAnnotate(s => s.activeTool)
  const activeClassId = useAnnotate(s => s.activeClassId)
  const classes = useAnnotate(s => s.classes)
  const canUndo = useAnnotate(s => s.canUndo)
  const canRedo = useAnnotate(s => s.canRedo)
  // ITEM-16 — the tally is DERIVED from the committed annotations on every render, never stored, so
  // an undo / delete / reclass can never leave a stale number on screen (TEST-19). `byId` identity
  // is the store's mutation signal, so this recomputes exactly when the collection changes.
  //
  // DRIFT-3.8 — it counts EVERY object of a class (points + polygons + brush regions), not points
  // only. The number sits beside a class name under a heading that reads *Classes*, so it answers
  // "how many things of this class exist" — and it is derived from the same `{byId, ids}` the
  // hierarchy panel's `Objects (N)` counts, so the two cannot disagree. The seed export below is
  // the one readout that stays point-scoped, because points are what it hands out.
  const byId = useAnnotate(s => s.byId)
  const ids = useAnnotate(s => s.ids)
  const tally = annotationTally({ byId, ids })

  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState(rgbToHex(DEFAULT_NEW_CLASS_COLOR))

  // `key` rides the returned <span> (the direct `.map()` child) — NOT the inner Button — so
  // React gets a stable list key on the element it actually reconciles (no unique-key warning).
  const railItem = (key: string, active: boolean, node: ReactNode) => (
    <span key={key} className="relative flex w-full items-center justify-center">
      {node}
      {active && <span className="pointer-events-none absolute inset-y-0 end-0 w-0.5 bg-primary" />}
    </span>
  )

  const addClass = () => {
    const name = newName.trim()
    if (!name) return
    const id = authoring.addClass({ name, color: hexToRgb(newColor) })
    authoring.setActiveClass(id)
    setNewName('')
  }

  // ITEM-16 — number-key class switching (1-9) for rapid counting: the counter's hand stays on the
  // keyboard while the other clicks. TWO bindings, one predicate (blind-audit H4):
  // NOTE the window listener resolves ownership by DOM ORIGIN (see `DOCK_SCOPE_ATTR` below), not by
  // "every listener that is not excluded" — that inversion is what leaked a digit across panes.
  //   1. this root's `onKeyDown` — while focus is inside the controls (single-pane / story hosts);
  //   2. a document listener, mounted ONLY while `hotkeyActive` — the pane the user is clicking in.
  // (2) is what makes the counting loop actually work: dropping a point moves focus to the draw
  // overlay, so a focus-scoped-only binding is dead exactly when it is needed.
  // Read the class list through a ref so the document listener never closes over a stale vocabulary.
  const classesRef = useRef(classes)
  classesRef.current = classes
  const setActiveClassRef = useRef(authoring.setActiveClass)
  setActiveClassRef.current = authoring.setActiveClass

  /** Shared predicate: map a key event to a class slot, or null. Never steals a digit being typed. */
  const classForKey = useCallback((key: string, target: EventTarget | null, mod: boolean) => {
    if (mod) return null
    const t = target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return null
    const n = Number(key)
    if (!Number.isInteger(n) || n < 1 || n > 9) return null
    return classesRef.current[n - 1] ?? null
  }, [])

  const onHotKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const cls = classForKey(e.key, e.target, e.altKey || e.ctrlKey || e.metaKey)
    if (!cls) return
    e.preventDefault()
    authoring.setActiveClass(cls.id)
  }

  useEffect(() => {
    if (!hotkeyActive) return
    const onKey = (e: KeyboardEvent) => {
      // CONVERGENCE H4 — decline any event originating inside ANY annotate dock, not merely this
      // one. The previous guard excluded only its OWN subtree, so the armed dock ALSO answered
      // digits the user was aiming at a different open dock: with pane A armed and focus on a
      // button inside dock B, pressing `1` re-pointed BOTH panes, and A then silently took its
      // next points under a class the user never chose for it.
      // The dock that OWNS the focus handles the key through its own React `onKeyDown` below; this
      // window listener exists ONLY for the case where focus has left every dock — which is exactly
      // the counting loop, where clicking the canvas hands focus to the draw overlay.
      const t = e.target
      if (t instanceof Element && t.closest(`[${DOCK_SCOPE_ATTR}]`)) return
      const cls = classForKey(e.key, e.target, e.altKey || e.ctrlKey || e.metaKey)
      if (!cls) return
      e.preventDefault()
      setActiveClassRef.current(cls.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hotkeyActive, classForKey])

  return (
    <div
      data-testid={testId}
      data-hotkey-active={hotkeyActive ? '1' : undefined}
      {...{ [DOCK_SCOPE_ATTR]: '1' }}
      // BLIND-AUDIT M16 — `min-w-0` + `overflow-x-auto`: the root is intrinsically ~196px (36px rail
      // + a `min-w-40` class panel) and defaulted to `min-width: auto`, so in any parent narrower
      // than that it pushed the PAGE sideways instead of shrinking. Two showcase stories overflowed
      // 66px at a real 390px viewport because of it. Now the controls scroll inside their own box —
      // the same "scroll, never clip, never spill" rule the stacked docks follow.
      className={
        (fill ? 'flex h-full items-stretch' : 'flex items-stretch') + ' min-w-0 overflow-x-auto'
      }
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a focusable scope is what
      // makes the 1-9 hotkeys PER-PANE; see `onHotKey`.
      tabIndex={0}
      role="group"
      aria-label="Annotation controls"
      onKeyDown={onHotKey}
    >
      {/* ── tool rail ── */}
      <div
        role="toolbar"
        aria-orientation="vertical"
        aria-label="Annotation tools"
        data-testid={`${testId}-rail`}
        className="flex w-9 shrink-0 flex-col items-center gap-0.5 border-e border-border bg-muted/40 py-1"
      >
        {ANNOTATE_TOOLS.map(({ key, label, Icon }) => {
          const tool = key as AnnotateTool
          return railItem(
            tool,
            activeTool === tool,
            <Button
              size="icon"
              variant="ghost"
              tooltip={label}
              tooltipSide="right"
              aria-pressed={activeTool === tool}
              data-testid={`${testId}-tool-${tool}`}
              onClick={() => authoring.setTool(tool)}
            >
              <Icon className={ICON} />
            </Button>,
          )
        })}

        {/* Every refusal on this rail is `unavailableReason`, NOT `disabled`. These are icon-only
            controls whose entire identity is a glyph, and a natively `disabled` button is
            pointer-events:none AND out of the tab order — so it could open no tooltip at all and
            take no focus. A greyed ↶ that says nothing on hover is unexplained to every sighted
            user who does not already recognise the mark, which is exactly the muteness the
            icon-only tooltip guard exists to stop; the marker it reads was still being stamped,
            so nothing failed. The NAME stays the verb; the hover text becomes the reason. */}
        {activeTool === 'polygon' && (
          <Button
            size="icon"
            variant="ghost"
            tooltip={polyDraftLength < 3 ? 'Finish polygon' : `Finish polygon (${polyDraftLength})`}
            tooltipSide="right"
            unavailableReason={
              polyDraftLength < 3
                ? `A polygon needs at least 3 points — ${polyDraftLength} so far`
                : undefined
            }
            data-testid={`${testId}-finish`}
            onClick={onFinishPolygon}
          >
            <Check className={ICON} />
          </Button>
        )}

        {/* M8 — Cancel is available from the FIRST vertex, unlike Finish (which needs 3). */}
        {activeTool === 'polygon' && onCancelPolygon && (
          <Button
            size="icon"
            variant="ghost"
            tooltip="Cancel polygon"
            tooltipSide="right"
            unavailableReason={polyDraftLength < 1 ? 'No polygon in progress' : undefined}
            data-testid={`${testId}-cancel`}
            onClick={onCancelPolygon}
          >
            <Ban className={ICON} />
          </Button>
        )}

        <div className="my-1 h-px w-6 shrink-0 bg-foreground/25" />

        <Button
          size="icon"
          variant="ghost"
          tooltip="Undo"
          tooltipSide="right"
          unavailableReason={canUndo ? undefined : 'Nothing to undo'}
          data-testid={`${testId}-undo`}
          onClick={() => store.getState().undo()}
        >
          <Undo2 className={ICON} />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          tooltip="Redo"
          tooltipSide="right"
          unavailableReason={canRedo ? undefined : 'Nothing to redo'}
          data-testid={`${testId}-redo`}
          onClick={() => store.getState().redo()}
        >
          <Redo2 className={ICON} />
        </Button>
      </div>

      {/* ── class / label panel ── */}
      <div className="flex min-w-40 flex-1 flex-col gap-2 p-2" data-testid={`${testId}-classes`}>
        {/* ITEM-15 / INV-15 — the in-progress polygon read out as a STATE, not just a canvas
            squiggle: how many vertices are down, and how to finish. Absent when nothing is open,
            so it never reads as permanent chrome. */}
        {activeTool === 'polygon' && polyDraftLength > 0 && (
          <div
            data-testid={`${testId}-draft-status`}
            role="status"
            className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
          >
            <span data-testid={`${testId}-draft-count`}>{polyDraftLength}</span>{' '}
            {polyDraftLength === 1 ? 'vertex' : 'vertices'}
            {polyDraftLength >= 3 ? ' · click the first point to close' : ' · 3 needed to close'}
          </div>
        )}

        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">Classes</span>
          {/* ITEM-16 — the counting job's entire deliverable is the NUMBER; show it where the
              clicking happens, not behind a menu. DRIFT-3.8 — it is the OBJECT total (the sum of the
              per-class numbers + unclassified), so header and rows describe one set. */}
          {tally.total > 0 && (
            <span
              data-testid={`${testId}-objects-total`}
              className="text-xs tabular-nums text-muted-foreground"
            >
              {tally.total} {tally.total === 1 ? 'object' : 'objects'}
            </span>
          )}
        </div>
        <ul className="flex flex-col gap-1.5">
          {classes.map(cls => (
            <li
              key={cls.id}
              data-testid={`${testId}-class-${cls.id}`}
              className="flex items-center gap-2"
            >
              <span className="relative inline-block size-5 shrink-0">
                <span
                  className="block size-5 rounded-md border border-border"
                  style={{ backgroundColor: rgbToHex(cls.color) }}
                  data-allow-custom-color
                />
                <input
                  type="color"
                  aria-label={`Color for ${cls.name}`}
                  data-testid={`${testId}-class-color-${cls.id}`}
                  value={rgbToHex(cls.color)}
                  onChange={e => authoring.updateClass(cls.id, { color: hexToRgb(e.target.value) })}
                  className="absolute inset-0 size-5 cursor-pointer opacity-0"
                  data-allow-custom-color
                />
              </span>
              <Input
                size="sm"
                className="min-w-0 flex-1"
                aria-label={`Rename ${cls.name}`}
                data-testid={`${testId}-class-label-${cls.id}`}
                value={cls.name}
                onChange={e => authoring.updateClass(cls.id, { name: e.target.value })}
              />
              {/* live per-class tally (ITEM-16) — derived, so undo/delete move it for free, and
                  DRIFT-3.8 counts every object of the class, not just its points. */}
              <span
                data-testid={`${testId}-class-count-${cls.id}`}
                aria-label={`${cls.name}: ${tally.byClass[cls.id] ?? 0} ${
                  (tally.byClass[cls.id] ?? 0) === 1 ? 'object' : 'objects'
                }`}
                className="min-w-6 shrink-0 text-end text-xs tabular-nums text-muted-foreground"
              >
                {tally.byClass[cls.id] ?? 0}
              </span>
              <Button
                size="icon"
                variant={activeClassId === cls.id ? 'secondary' : 'ghost'}
                tooltip="Use for new annotations"
                aria-pressed={activeClassId === cls.id}
                data-testid={`${testId}-class-activate-${cls.id}`}
                onClick={() => authoring.setActiveClass(activeClassId === cls.id ? null : cls.id)}
              >
                <CircleDot className={ICON} />
              </Button>
            </li>
          ))}
          {classes.length === 0 && (
            <li className="text-xs text-muted-foreground">No classes yet.</li>
          )}
          {tally.unclassified > 0 && (
            <li
              data-testid={`${testId}-objects-unclassified`}
              className="text-xs text-muted-foreground"
            >
              {tally.unclassified} unclassified
            </li>
          )}
        </ul>

        {/* ITEM-16 — hand the counted points out as ProcessorPort seeds. Host-wired, so no dead
            button in a viewer-only embed. Gated + labelled on `tally.points`, NOT `tally.total`
            (DRIFT-3.8): the payload is points only, so a pane holding polygons and no points must
            show no button rather than one offering an empty export. */}
        {onExportSeeds && tally.points > 0 && (
          <Button
            variant="outline"
            data-testid={`${testId}-export-seeds`}
            onClick={() => onExportSeeds(pointSeedFeatures({ byId, ids }))}
          >
            <Sprout className={ICON} />
            Use {tally.points} {tally.points === 1 ? 'point' : 'points'} as seeds
          </Button>
        )}

        {/* add-class row */}
        <div className="flex items-center gap-2 pt-1">
          <span className="relative inline-block size-5 shrink-0">
            <span
              className="block size-5 rounded-md border border-border"
              style={{ backgroundColor: newColor }}
              data-allow-custom-color
            />
            <input
              type="color"
              aria-label="New class color"
              data-testid={`${testId}-newclass-color`}
              value={newColor}
              onChange={e => setNewColor(e.target.value)}
              className="absolute inset-0 size-5 cursor-pointer opacity-0"
              data-allow-custom-color
            />
          </span>
          <Input
            size="sm"
            className="min-w-0 flex-1"
            aria-label="New class name"
            placeholder="New class…"
            data-testid={`${testId}-newclass-name`}
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') addClass()
            }}
          />
          <Button
            size="icon"
            variant="ghost"
            tooltip="Add class"
            unavailableReason={newName.trim() ? undefined : 'Type a class name first'}
            data-testid={`${testId}-newclass-add`}
            onClick={addClass}
          >
            <Plus className={ICON} />
          </Button>
        </div>
      </div>
    </div>
  )
}
