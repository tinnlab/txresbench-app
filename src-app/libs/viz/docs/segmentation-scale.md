# Segmentation-scale — design (in-grid masks · shared-across-panes · hierarchy)

Governing design for the `segmentation-scale` feature in `@txresbench/viz` (frontend
only). Extends the shipped `annotation-surface` (see `annotation-surface.md`) with
three capabilities the user chose the maximal version of. Grounded in
`.lifecycle/segmentation-scale/RESEARCH.md` (findings `F-HIER-*`, `F-TILE-*`).

Still an **editor** — no model inference, no bundled AI (INV-3 preserved).
Segmentation is produced by an external processor via the existing `ProcessorPort`;
this feature is about **rendering, correcting, organizing, and scaling** those
masks across panes and levels.

## §1 The prerequisite nobody sees yet

`annotation-surface` intentionally shipped mask review/correct as **standalone
stories only** — there is no in-grid `GridCell` label-mask RENDER surface
(`GridWorkspace.tsx` §"Mask review + correction … NOT mounted in the grid"). Every
capability below needs masks visible *in the grid*, so **Track 0 builds that render
surface first**; A/B/C are impossible without it.

## §2 Surfaces

- **(0) In-grid mask** — a `GridCell` renders a label mask through `LabelMaskLayer`
  into the shared deck; the review/correct panel (hide/solo + relabel/split/merge/
  brush) mounts in-grid, portaled through a host-container seam
  (`maskControlsContainer`, twin of `annotateControlsContainer`).
- **(A) Shared mask across panes** — one world-space raster attached to a **link
  group**; every cell in the group is a windowed VIEW. A brush stroke started in one
  pane and dragged into another writes the ONE raster continuously across the seam;
  the dirty rect fans out to every viewing pane (each re-uploads only its
  intersection). One raster, one undo stack (INV-8/9).
- **(B) Object hierarchy** — a single-parent object tree with a configurable level
  vocabulary (tissue → region → cell → nucleus). A **tree/level panel** (collapsible
  tree grouped by level, level picker + breadcrumb, show-only-level, select-in-tree
  ↔ select-on-canvas). Containment auto-parents (full-ROI for regions, centroid for
  points, per QuPath F-HIER-1) on draw + an explicit **Resolve hierarchy** action.
  Split/merge/relabel preserve parentage (INV-10). Round-trips through GeoJSON.
- **(C) Shared authoring state + propagate** — active tool + class vocabulary +
  active level live at WORKSPACE scope so they follow focus across panes (per-cell
  geometry/undo stay isolated — INV-11); a "apply to link group" action propagates
  channel/contrast/colormap + class palette across a link group (reusing
  `linkGroups`).

## §3 JTBD (per surface)

A pathologist opens a slide already segmented by an external model, sees the mask
in the grid, and **corrects** the residual bad cells (0). They open the same WSI as
a montage of linked panes and **paint a correction that crosses the pane seam** as
if it were one canvas (A). They **organize** objects into tissue→region→cell→nucleus,
collapse to the level they're reviewing, and trust that splitting a gland keeps its
cells parented (B). They pick "Tumor" + Brush once and it **follows them** pane to
pane, then **propagate** the contrast they tuned to every linked pane in one click
(C). Every job is manipulate/organize/scale — the producing (AI) is elsewhere.

## §4 Invariants

Carried verbatim from `annotation-surface.md` §6 (INV-1..7) plus the new
INV-8..11. See PLAN.md `## Invariants` for the authoritative list + `(grounds:)`
tags; each is pinned to an `[acceptance]` test in Phase 3 and audited for
conformance in Phase 6.
