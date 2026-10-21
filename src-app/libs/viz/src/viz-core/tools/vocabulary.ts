// vocabulary.ts — THE tool vocabulary (INV-14). Exactly one module declares which tools exist,
// what they are called, how they are ordered, and which semantic GESTURE each performs.
//
// WHY THIS EXISTS. Six independent restatements of the tool vocabulary had drifted apart:
//   1. `VizToolRail.tsx`  `VizTool`   2. `VizToolRail.tsx`  `SelShape` (+ its own label strings)
//   3. `annotateModel.ts` `AnnotateTool`                    4. `MaskReviewControls.tsx` `MaskTool` (text-only, no icons)
//   5. `areaGestures.ts`  `SelectionTool` + `SELECTION_TOOL_LABEL` — which already declared itself
//      "one definition, consumed by every host" and which `VizToolRail` never imported
//   6. `GridWorkspace.tsx` an inline `useState<'rect' | 'polygon' | 'move'>` that did not even
//      reference `SelShape`
// The observable damage: the SAME polygon gesture was a `Lasso` in one bar and a `PenTool` in
// another; `pan` and `move` sat in ONE array while the ✥ glyph (universally "pan the view") was
// bound to move-SELECTION and the pan tool wore a magnifier; the bare string `'polygon'` meant
// three different things across three vocabularies and `'brush'` meant two.
//
// PURITY. This module is DATA ONLY — no react, no lucide, no deck. `selection/areaGestures.ts` is
// a documented pure module and consumes this directly. Icons live in the sibling `registry.ts`,
// which is the module UI surfaces import.

/** The surface a tool belongs to. Namespacing is what makes the collided bare strings distinct:
 *  `select.polygon` ≠ `annotate.polygon`, `annotate.brush` ≠ `mask.brush`. Namespacing makes them
 *  ADDRESSABLE; a distinct `gesture` (finding #13) is what makes them LOOK different. */
export type ToolSurface = 'view' | 'select' | 'annotate' | 'mask' | 'pane'

/** How an entry is rendered/behaves within its surface.
 *  - `mode`   — an exclusive top-level rail mode (the camera, select, annotate, segment).
 *  - `shape`  — describes HOW a region is drawn (rect, polygon).
 *  - `action` — operates on something that ALREADY exists; disabled until it does.
 *  - `tool`   — an authoring/correction tool within a surface panel.
 *  - `pane`   — a PER-PANE toolbar action: it opens/closes THAT pane's own surface. The seventh
 *               unregistered vocabulary was `PaneToolbar.tsx` importing its glyphs straight from
 *               lucide, which is how a second `Pencil` (Edit) ended up beside the rail's `Pencil`
 *               (Annotate) meaning something else. */
export type ToolKind = 'mode' | 'shape' | 'action' | 'tool' | 'pane'

/** The SEMANTIC key. Two entries with the same gesture do the same thing to different targets and
 *  therefore MUST carry the same glyph; two entries with different gestures MUST NOT (INV-14).
 *  `registry.ts` keys its icon map by gesture, so the first half of that rule holds BY CONSTRUCTION.
 *
 *  **GESTURE IDENTITY IS SEMANTIC — the VERB plus its TARGET, never merely the input motion.**
 *  `pick`-with-a-mouse is not ONE gesture just because the mouse moves the same way. This is the half
 *  of INV-14 the original taxonomy got wrong: it collapsed genuinely different actions into a single
 *  gesture, so `GESTURE_ICON` dutifully gave them a single glyph and the injectivity test passed
 *  while the USER saw two identical glyphs meaning two different verbs. The guard had been built one
 *  level ABOVE where the error lived. Concretely (finding #13):
 *    • `pickData` — marquee / lasso over plot POINTS (`view.select`)  vs
 *      `pickAnnotation` — grab / move / reshape an annotation OBJECT (`annotate.select`).
 *      Both were `pick`.
 *    • `brushRegion` — paint a VECTOR region (`annotate.brush`)  vs
 *      `brushMask` — paint RASTER pixels into a label mask (`mask.brush`).
 *      Both were `brush`, excused as "`surface` supplies context". With per-pane docks (ROOT 2) the
 *      annotate and segment panels are open SIMULTANEOUSLY, so surface-as-context is not available
 *      to the user's eye — two identical brushes sit side by side meaning different things.
 *  `registry.test.ts` pins every `(surface, key)` → gesture and requires any gesture used by MORE
 *  THAN ONE entry to be declared shared with a justification, so adding an entry that reuses an
 *  existing gesture fails the build rather than passing review.
 *
 *  `pan` (move the VIEW) and `moveSelection` (move a committed SELECTION) are deliberately distinct:
 *  conflating them is what put ✥ on the wrong control. */
export type Gesture =
  | 'pan'
  | 'pickData'
  | 'pickAnnotation'
  | 'annotateMode'
  | 'segmentMode'
  | 'rect'
  | 'polygon'
  | 'point'
  | 'brushRegion'
  | 'brushMask'
  | 'moveSelection'
  | 'relabel'
  | 'split'
  | 'merge'
  // ── per-pane toolbar actions (finding #14) ──
  | 'linkFilter'
  | 'editPlot'
  | 'exportPane'
  | 'dataTable'
  // The two PINNED left-group config pickers. Registered because at narrow pane widths they COLLAPSE
  // to an icon-only trigger (convergence-5 HIGH), and an icon rendered on the pane toolbar must come
  // from the ONE vocabulary — an unregistered glyph there is exactly how two Pencils shipped
  // (finding #14). Expanded they show their VALUE as text and use no glyph at all.
  | 'plotKind'
  | 'colorBy'

export interface ToolEntryData {
  /** Canonical namespaced id, `surface.key`. */
  readonly id: string
  /** The unprefixed segment. Surface-local unions + stable `data-testid`s derive from this — it is
   *  a projection of `id`, never an independent name. */
  readonly key: string
  readonly surface: ToolSurface
  readonly kind: ToolKind
  readonly gesture: Gesture
  /** TOOLTIP prose — a full sentence is fine and expected (it is what a hover reveals). */
  readonly label: string
  /**
   * BLIND-AUDIT M15 — the BUTTON-TEXT form, for surfaces that render a tool's name as visible text
   * rather than as a tooltip. `SELECTION_TOOL_LABEL` derives from the registry and its consumers
   * (`SelectableScatter`'s `sel-tool-*` strip) print it INSIDE the button, so deriving from `label`
   * put the 47-character sentence "Pan + zoom (scroll to zoom, hold Space or drag to pan)" into a
   * button and blew it out to 499px. Absent ⇒ `label` (fine when the two coincide).
   */
  readonly shortLabel?: string
  /** CSS cursor while this tool is active. */
  readonly cursor: 'default' | 'crosshair' | 'grab' | 'move'
  /** Sole ordering source (DEC-5): ascending by geometric primitive complexity —
   *  point (0-D) → polygon (2-D) → brush (raster) — with `select` first and operations on
   *  existing geometry last. No surface may re-sort. */
  readonly order: number
}

/** The vocabulary. Every id appears exactly once; every surface's tools are contiguous. */
export const TOOL_VOCABULARY = [
  // ── view: the exclusive top-level rail modes ────────────────────────────────────────────────
  // VIEW-LEVEL ONLY. `view.annotate` / `view.segment` are DELETED (finding #14): a global rail mode
  // that opened EVERY capable pane at once is the "one global control acting across panes" shape the
  // owner rejected from the start, and it made annotating a SINGLE pane impossible. Their entry point
  // is now the per-pane `pane.annotate` / `pane.segment` toolbar buttons below, siblings of `pane.edit`
  // — literally *"like the edit form, when we click on it, it opens separate form for each pane"*.
  { id: 'view.pan', key: 'pan', surface: 'view', kind: 'mode', gesture: 'pan',
    label: 'Pan + zoom (scroll to zoom, hold Space or drag to pan)', shortLabel: 'Pan',
    cursor: 'grab', order: 0 },
  { id: 'view.select', key: 'select', surface: 'view', kind: 'mode', gesture: 'pickData',
    label: 'Select (marquee / lasso)', cursor: 'default', order: 10 },

  // ── select: selection SHAPES, then the selection ACTION (DEC-4 — `move` is not a shape) ─────
  { id: 'select.rect', key: 'rect', surface: 'select', kind: 'shape', gesture: 'rect',
    label: 'Rectangle select', shortLabel: 'Rect', cursor: 'crosshair', order: 10 },
  { id: 'select.polygon', key: 'polygon', surface: 'select', kind: 'shape', gesture: 'polygon',
    label: 'Polygon select', shortLabel: 'Polygon', cursor: 'crosshair', order: 20 },
  { id: 'select.move', key: 'move', surface: 'select', kind: 'action', gesture: 'moveSelection',
    label: 'Move selection', shortLabel: 'Move', cursor: 'move', order: 90 },

  // ── annotate: select first, then creation tools by primitive complexity ─────────────────────
  // (`reshape` was folded into `select` per DEC-18 — selecting an annotation reveals its vertex
  //  handles, so the capability is retained without a separate mode.)
  { id: 'annotate.select', key: 'select', surface: 'annotate', kind: 'tool', gesture: 'pickAnnotation',
    label: 'Select / move / reshape', cursor: 'default', order: 0 },
  { id: 'annotate.point', key: 'point', surface: 'annotate', kind: 'tool', gesture: 'point',
    label: 'Drop point', cursor: 'crosshair', order: 10 },
  { id: 'annotate.polygon', key: 'polygon', surface: 'annotate', kind: 'tool', gesture: 'polygon',
    label: 'Draw polygon', cursor: 'crosshair', order: 20 },
  { id: 'annotate.brush', key: 'brush', surface: 'annotate', kind: 'tool', gesture: 'brushRegion',
    label: 'Brush region', cursor: 'crosshair', order: 30 },

  // ── mask: label-mask corrections (all operate on existing geometry) ─────────────────────────
  { id: 'mask.relabel', key: 'relabel', surface: 'mask', kind: 'tool', gesture: 'relabel',
    label: 'Relabel', cursor: 'crosshair', order: 10 },
  { id: 'mask.split', key: 'split', surface: 'mask', kind: 'tool', gesture: 'split',
    label: 'Split', cursor: 'crosshair', order: 20 },
  { id: 'mask.merge', key: 'merge', surface: 'mask', kind: 'tool', gesture: 'merge',
    label: 'Merge', cursor: 'crosshair', order: 30 },
  { id: 'mask.brush', key: 'brush', surface: 'mask', kind: 'tool', gesture: 'brushMask',
    label: 'Brush mask pixels', cursor: 'crosshair', order: 40 },

  // ── pane: the per-pane TOOLBAR actions, in the toolbar's fixed RIGHT-GROUP order ─────────────
  // `order` IS that order, so "the fixed right-group order" stops being a comment someone has to
  // remember and becomes the registry's job. Chrome that is not a TOOL (drag grip, Split, New window,
  // Close) stays out of the vocabulary — `registry.test.ts` asserts those glyphs collide with none of
  // the registered ones instead.
  { id: 'pane.link', key: 'link', surface: 'pane', kind: 'pane', gesture: 'linkFilter',
    label: 'Link filtering to other plots', cursor: 'default', order: 10 },
  { id: 'pane.edit', key: 'edit', surface: 'pane', kind: 'pane', gesture: 'editPlot',
    label: 'Edit this plot', cursor: 'default', order: 20 },
  { id: 'pane.annotate', key: 'annotate', surface: 'pane', kind: 'pane', gesture: 'annotateMode',
    label: 'Annotate this pane', cursor: 'default', order: 30 },
  { id: 'pane.segment', key: 'segment', surface: 'pane', kind: 'pane', gesture: 'segmentMode',
    label: 'Review + correct this pane\u2019s mask', cursor: 'default', order: 40 },
  { id: 'pane.export', key: 'export', surface: 'pane', kind: 'pane', gesture: 'exportPane',
    label: 'Export this pane', cursor: 'default', order: 50 },
  { id: 'pane.data', key: 'data', surface: 'pane', kind: 'pane', gesture: 'dataTable',
    label: 'Show plotting data as a table', cursor: 'default', order: 60 },
  // The PINNED left-group pickers. `order` is negative because they render BEFORE the right group,
  // beside the drag grip — they are not part of the fixed right-group order above and never fold.
  { id: 'pane.kind', key: 'kind', surface: 'pane', kind: 'pane', gesture: 'plotKind',
    label: 'Plot type', cursor: 'default', order: -20 },
  { id: 'pane.colorby', key: 'colorby', surface: 'pane', kind: 'pane', gesture: 'colorBy',
    label: 'Color by', cursor: 'default', order: -10 },
] as const satisfies readonly ToolEntryData[]

export type ToolEntry = (typeof TOOL_VOCABULARY)[number]
export type ToolId = ToolEntry['id']

/** The unprefixed keys of one surface — the surface-local union, DERIVED not declared. */
export type ToolKeyFor<S extends ToolSurface> = Extract<ToolEntry, { surface: S }>['key']
/** The keys of one surface restricted to a kind (e.g. selection SHAPES, excluding the move action). */
export type ToolKeyOfKind<S extends ToolSurface, K extends ToolKind> = Extract<
  ToolEntry,
  { surface: S; kind: K }
>['key']

// The two helpers below narrow a UNION of literal entry types by a runtime field. TS cannot connect
// a `.filter()` predicate to `Extract<…>`, so each casts through `unknown` — the cast is sound
// because the predicate tests exactly the field the `Extract` selects on, and `registry.test.ts`
// asserts the resulting partition per surface.

/** Entries of one surface, in registry order. The single ordering source (DEC-5). */
export function vocabularyForSurface<S extends ToolSurface>(
  surface: S,
): readonly Extract<ToolEntry, { surface: S }>[] {
  const rows = TOOL_VOCABULARY.filter(e => e.surface === surface)
  return [...rows].sort((a, b) => a.order - b.order) as unknown as readonly Extract<
    ToolEntry,
    { surface: S }
  >[]
}

/** Ordered unprefixed keys of one surface — what a surface renders and what its union contains. */
export function toolKeysForSurface<S extends ToolSurface>(surface: S): readonly ToolKeyFor<S>[] {
  return vocabularyForSurface(surface).map(e => e.key) as unknown as readonly ToolKeyFor<S>[]
}

/** Exact-match lookup by canonical id. */
export function vocabularyById(id: ToolId): ToolEntry {
  const found = TOOL_VOCABULARY.find(e => e.id === id)
  if (!found) throw new Error(`vocabularyById: unknown tool id "${id}"`)
  return found
}

/** Lookup by (surface, unprefixed key) — the form a surface component holds in state. */
export function vocabularyFor<S extends ToolSurface>(surface: S, key: string): ToolEntry {
  const found = TOOL_VOCABULARY.find(e => e.surface === surface && e.key === key)
  if (!found) throw new Error(`vocabularyFor: unknown tool "${surface}.${key}"`)
  return found
}

/** The human label for a (surface, key) pair. Replaces every per-surface label table. */
export function labelFor(surface: ToolSurface, key: string): string {
  return vocabularyFor(surface, key).label
}

/** The BUTTON-TEXT label (M15): `shortLabel` when the entry declares one, else `label`.
 *  Use this wherever a tool's name is rendered as visible text instead of a tooltip. */
export function shortLabelFor(surface: ToolSurface, key: string): string {
  // `TOOL_VOCABULARY` is `as const`, so an entry WITHOUT a `shortLabel` has no such property on its
  // literal type — narrow with `in` rather than widening the whole vocabulary's declared type.
  const v = vocabularyFor(surface, key)
  return 'shortLabel' in v && typeof v.shortLabel === 'string' ? v.shortLabel : v.label
}
