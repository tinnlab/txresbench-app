// registry.ts — the tool vocabulary (`vocabulary.ts`) decorated with ICONS, for UI surfaces.
//
// The icon map is keyed by GESTURE, not by tool id. That is the whole trick: "two entries with the
// same gesture carry the same glyph" is then true BY CONSTRUCTION — it is not possible to express
// the shipped bug where `select.polygon` was a `Lasso` and `annotate.polygon` was a `PenTool`.
// The remaining half of INV-14 (two DIFFERENT gestures must never share a glyph) is not structural,
// so `registry.test.ts` asserts it — icon drift becomes a failing build, not a review question.
//
// Icon choices worth stating, because several are corrections of shipped defects:
//   • `pan` takes ✥ (`Move`). ✥ is the universal "pan the view" affordance in QuPath / ImageJ /
//     Photoshop / OpenSeadragon. It was previously bound to move-SELECTION, while the tool that
//     actually pans wore a magnifier — so reaching for ✥ to pan dragged your selection instead (DEC-3).
//   • `moveSelection` takes `Move3d`, which is visibly not ✥, so the two can no longer be confused (DEC-3).
//   • `pickData` / `pickAnnotation` and `brushRegion` / `brushMask` are the finding-#13 SPLITS: each
//     pair was one gesture, so each pair rendered one glyph for two different verbs. See the SEMANTIC
//     GESTURE IDENTITY note on `Gesture` in `vocabulary.ts`.
//   • `point` takes `Crosshair`, not `MapPin` (finding #12). The tool marks CELLS / NUCLEI and its job
//     is COUNTING them; a teardrop map pin is a GEOGRAPHIC metaphor, is bottom-anchored (so its visual
//     anchor is ambiguous exactly where precision matters) and reads as heavy chrome at 16px in a
//     dense nuclei field. A crosshair is centre-anchored, symmetric and says "this exact spot".

import {
  Brush, ChartScatter, Combine, Crosshair, Download, Grid2x2, Highlighter, Move, Move3d, Palette,
  PenTool, Pencil, Scissors, Shapes, SplinePointer, Square, SquareDashedMousePointer, Table2, Tag,
  Waypoints,
} from 'lucide-react'
import {
  TOOL_VOCABULARY,
  vocabularyById,
  vocabularyFor,
  vocabularyForSurface,
  type Gesture,
  type ToolEntry,
  type ToolId,
  type ToolSurface,
} from './vocabulary'

export type {
  Gesture,
  ToolEntry,
  ToolEntryData,
  ToolId,
  ToolKeyFor,
  ToolKeyOfKind,
  ToolKind,
  ToolSurface,
} from './vocabulary'
export {
  TOOL_VOCABULARY,
  labelFor,
  toolKeysForSurface,
  vocabularyById,
  vocabularyFor,
  vocabularyForSurface,
} from './vocabulary'

/** A lucide icon component. Matches the shape every surface already renders (`<Icon className/>`). */
export type ToolIcon = typeof Move

/** gesture → glyph. TOTAL over `Gesture` (the compiler enforces exhaustiveness via `Record`), and
 *  INJECTIVE (asserted in `registry.test.ts`). Keying by gesture is what makes same-gesture-same-icon
 *  structural rather than aspirational. */
export const GESTURE_ICON: Record<Gesture, ToolIcon> = {
  pan: Move,                                  // ✥ — the view. DEC-3.
  // A DASHED MARQUEE box with a pointer inside it — "drag a region over the data points". Reads as
  // selection-of-many at 16px; the dashed edge is the marquee affordance every plotting tool uses.
  pickData: SquareDashedMousePointer,
  // A pointer ON A SPLINE with its control point — "grab this OBJECT and reshape it". The curve is
  // the annotation; visually nothing like the dashed marquee box above.
  pickAnnotation: SplinePointer,
  // Overlapping SHAPES — the pane's annotation OBJECTS. Not `Pencil`: `Pencil` is `editPlot` and the
  // two now sit in the SAME pane toolbar, so the shipped two-pencils collision (finding #14) would be
  // side by side rather than one rail apart.
  annotateMode: Shapes,
  segmentMode: Grid2x2,      // a labelled RASTER partition.
  rect: Square,
  polygon: PenTool,          // ONE glyph for click-vertex polygon, on both select and annotate.
  point: Crosshair,          // centre-anchored, symmetric — "this exact spot". Finding #12.
  // An angled MARKER laying down a translucent swathe — a VECTOR region painted over the image, not
  // pixels replaced. Distinct silhouette from the round-tipped `Brush` below.
  brushRegion: Highlighter,
  // A round-tipped PAINTBRUSH, filled — "replace these raster pixels' label".
  brushMask: Brush,
  moveSelection: Move3d,     // deliberately NOT ✥. DEC-3.
  relabel: Tag,
  split: Scissors,
  merge: Combine,
  // ── per-pane toolbar actions. Registered so the "no two visible glyphs mean different things"
  //    invariant covers the pane toolbar too — it was the SEVENTH unregistered vocabulary.
  linkFilter: Waypoints,     // connected nodes; distinct from the rail's `Link2` link-ZOOM toggle.
  editPlot: Pencil,
  exportPane: Download,
  dataTable: Table2,
  // The two PINNED config pickers, used ONLY by their collapsed icon-only form (convergence-5 HIGH).
  // A scatter of POINTS = "which plot type"; a PALETTE = "which column paints the colour". Neither
  // collides with a registered glyph or with the unregistered chrome (`registry.test.ts` asserts both).
  plotKind: ChartScatter,
  colorBy: Palette,
}

/** A vocabulary entry plus its resolved glyph — what UI surfaces render.
 *  An intersection, not an `interface … extends`: `ToolEntry` is a UNION of literal entry types,
 *  which an interface cannot extend. */
export type ToolDescriptor = ToolEntry & { readonly Icon: ToolIcon }

function decorate<E extends ToolEntry>(entry: E): E & { readonly Icon: ToolIcon } {
  return { ...entry, Icon: GESTURE_ICON[entry.gesture] }
}

/** Every tool of one surface, in registry order, each with its glyph. The ONLY thing a surface
 *  should map over — it supplies ids, labels, icons, cursors AND order together. */
export function toolsForSurface<S extends ToolSurface>(
  surface: S,
): readonly (Extract<ToolEntry, { surface: S }> & { readonly Icon: ToolIcon })[] {
  return vocabularyForSurface(surface).map(e => decorate(e as ToolEntry)) as unknown as readonly (
    Extract<ToolEntry, { surface: S }> & { readonly Icon: ToolIcon }
  )[]
}

/** One tool by canonical namespaced id. */
export function toolById(id: ToolId): ToolDescriptor {
  return decorate(vocabularyById(id))
}

/** One tool by (surface, unprefixed key) — the form surfaces hold in state. */
export function toolFor(surface: ToolSurface, key: string): ToolDescriptor {
  return decorate(vocabularyFor(surface, key))
}

/** The glyph for a semantic gesture, independent of which surface exposes it. */
export function iconForGesture(gesture: Gesture): ToolIcon {
  return GESTURE_ICON[gesture]
}

/** Every descriptor, registry order preserved within each surface. */
export function allTools(): readonly ToolDescriptor[] {
  return TOOL_VOCABULARY.map(decorate)
}
