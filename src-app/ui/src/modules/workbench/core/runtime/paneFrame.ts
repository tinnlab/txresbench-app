// THE FRAME, NAMED (visualize-pane ITEM-35 / ITEM-43 / ITEM-19).
//
// ── The problem this exists to solve ────────────────────────────────────────────────────
//
// Pane scope carries the frame as IDENTITIES — `$scope.axis` is an `AxisSummary.content_hash`
// and `$scope.coordinate` is an artifact id — because identity is `(artifact, selector)` and
// nothing may key on a display name (INV-1). That is right, and it leaves every surface that
// has to SAY what the frame is with two opaque strings.
//
// Two surfaces need to say it, and neither can derive it:
//
//   · § Coordinates' bare-frame ▶ (ITEM-43) has to read *"Plot <that>"* — a control named for
//     the verb rather than for its subject is forty rows called "Plot" (ITEM-30).
//   · An emitted plot's TITLE (ITEM-35) has to read `Batch A · projection · a column`, which
//     is R10 at the plot level and is *"what makes a canvas holding two row spaces
//     readable"*. The colouring section holds the column name and NEITHER of the other two,
//     and it cannot ask § Coordinates for them: pane state is closed at two values (INV-13)
//     and sections have isolated stores (§4.5).
//
// So the engine resolves the frame's NAMES once, from the catalog, and hands them over as
// data. One resolver, so the anchor control, the ▶ and every plot title spell one fact the
// same way.
//
// ── It reads `meta` and NOTHING else ────────────────────────────────────────────────────
//
// Zero data-plane reads, like `row_space_columns` beside it (INV-11): every field is a
// producer declaration on a catalog row the pane has already fetched. `paneFrame.test.ts`
// asserts that against a spying port.
//
// ── Nothing here belongs to any domain ──────────────────────────────────────────────────
//
// No datatype, no axis label, no column name, no modality. It joins two identities to their
// declared labels.
//
// It used to also report the A3 state of the coordinate, as `coordinate_alignment_unknown` +
// `coordinate_alignment_mark` — the two fields § Coordinates' alert and every emitted plot's
// `provenanceNote` were bound to. Both are DELETED (owner, ledger #28 + #29); see the note at
// the top of `rowSpaceColumns.ts` for the whole retirement and for what it did NOT change.

import type { AxisSummary } from '@/api-client/types'
import type { ArtifactRow } from '@/modules/workbench/core/artifacts/catalog'
import { candidateLabel, resolveRowSpaceAnchor } from './axisSource'
import { NO_ANCHOR_REFUSAL, NO_COORDINATE_REFUSAL } from './rowSpaceColumns'
import { rowSpaceOptions } from './rowSpaces'

/** The `data.<slice>.source` value that selects this resolver. */
export const PANE_FRAME_SOURCE = 'pane_frame'

/** What a coordinate reads as before one is chosen. It is not a name and is never rendered as
 *  one: every consumer gates on {@link PaneFrame.framed} first. */
export const NO_COORDINATE = ''

/** What the frame's ▶ names before a coordinate is chosen. Deliberately NOT a name (there is
 *  none) and deliberately not empty: the control is RENDERED-and-refused now rather than
 *  hidden, and `Plot ` with a hole where its subject goes reads as a bug. */
export const NO_COORDINATE_LABEL = 'coordinates'

/** The resolved frame — the two pane identities plus what each of them READS as. */
export interface PaneFrame {
  /** a row space is anchored (A0 vs anchored). */
  anchored: boolean
  /** the anchor's identities, verbatim from pane scope — EVERY axis the chosen coordinate rests
   *  on (ITEM-8), `[]` when nothing is anchored. Consumers that need to KEY on the row space use
   *  this; the labels below are display only. */
  axis: readonly string[]
  /** where the anchored rows CAME FROM — the provenance name the anchor control shows, so a
   *  plot title and the anchor cannot name one row space two ways. */
  row_space: string
  /**
   * the anchored axis's declared label, and its length. Display only (INV-1).
   *
   * SINGLE-AXIS-TODAY (ITEM-8). These NAME one row space, and an integrated coordinate resting
   * on two has no one name and no one length — so with several axes they read as their empty
   * values (`''` / `0`) rather than as one of the pair's, which would put a name on a picture
   * drawn from something wider. What must arrive with the integrated case is a joined NAME for
   * the pair (the design's §2.1 pair, spelled for display) and a length that is the GATHERED
   * length, not either parent's; both are the plotting surface's to decide, and neither is
   * derivable here from a list of hashes. `anchored` is still `true` in that state — the frame
   * IS anchored; it is only unnamed.
   */
  row_space_label: string
  row_space_length: number
  /** the chosen coordinate artifact's id, or `null`. */
  coordinate: string | null
  /** what the coordinate READS as — the producer's declared display name. */
  coordinate_name: string
  /** BOTH values are chosen. The one gate a consumer of the frame needs: a plot cannot be
   *  drawn from half a frame, and the two are absent for different reasons and at different
   *  times, so collapsing them into one truthiness test would say the wrong thing about the
   *  intermediate state. */
  framed: boolean
  /**
   * THE PRESENCE WITNESS — always `true` on any resolved frame, and the ONLY thing a view can
   * gate a control on when the question is *"did this slice answer at all?"*.
   *
   * It exists because a REFUSAL cannot answer that question. `refusalReason` (renderers.tsx)
   * returns `undefined` for anything that is not a non-empty string, and a slice that FAILED
   * (`status: 'error'`) contributes no payload at all — so `$data.frame.plot_refusal` resolves
   * to `undefined` in exactly the state where refusing matters most, and "no refusal" and "the
   * refusal never resolved" become the same thing. A control gated only on the refusal is
   * therefore ENABLED on a backend blip, and clicking it emits with an `undefined` coordinate:
   * the `layouts[0]` wrong-frame picture, re-entered through the error path.
   *
   * Widgets do NOT unmount on `error`/`empty` (only on `loading`), so this is reachable. The
   * frame's ▶ carries `when: "$data.frame.resolved"` ALONGSIDE its `unavailableReason`: absent
   * slice ⇒ the control is not offered at all (the section's own status banner is what speaks),
   * resolved-but-unframed ⇒ offered and refused WITH the reason.
   */
  resolved: true
  /** What the frame's OWN ▶ says when it cannot emit, or `null` when it can (ITEM-39/ITEM-43).
   *
   *  The bare-frame ▶ used to be gated with `when: $data.frame.framed`, i.e. it VANISHED
   *  before a coordinate was chosen. A control that disappears cannot say why, and the user
   *  who never opens § Coordinates never learns that the frame is what is missing — which is
   *  the same dead end the colouring rows' silent-wrong-plot defect had, one surface over.
   *  It is the SAME two sentences those rows use, from the same constants, so the pane cannot
   *  spell one refusal three ways. */
  plot_refusal: string | null
  /** What the frame's ▶ NAMES (ITEM-30 — name the subject, never the verb). The coordinate's
   *  own display name once one is chosen; a neutral stand-in before that, so a rendered-but-
   *  refused control does not read as a bare `Plot ` with a hole where its subject goes. */
  coordinate_label: string
}

/** The empty frame — what every consumer gets before an anchor exists. */
export const NO_PANE_FRAME: PaneFrame = {
  anchored: false,
  axis: [],
  row_space: '',
  row_space_label: '',
  row_space_length: 0,
  coordinate: null,
  coordinate_name: NO_COORDINATE,
  framed: false,
  resolved: true,
  plot_refusal: NO_ANCHOR_REFUSAL,
  coordinate_label: NO_COORDINATE_LABEL,
}

/** The `args` a `pane_frame` slice declares. Both are `$`-refs into pane scope; a slice that
 *  names anything else is answering about something that is not the pane's frame. */
export interface PaneFrameArgs {
  axis?: string
  coordinate?: string
}

/**
 * Resolve the frame. PURE over the catalog — no read port, no network, no column bodies.
 *
 * ── THE FRAME IS THE COORDINATE (owner, 2026-08-13) ────────────────────────────────────
 *
 * This used to open `if (!anchor) return NO_PANE_FRAME` — no axis, no frame, and therefore a
 * DEAD ▶ however plainly the user had picked a set of positions. That gate was right for
 * exactly as long as the axis was the user's OWN answer, given in the pane's first block. That
 * control is deleted, and the axis is now a CONSEQUENCE of the pick (`coordinateAxis.ts`):
 * it names the rows and scopes the other sections. It is not a precondition for drawing points.
 *
 * Plotting positions needs positions. So the refusal is keyed on the COORDINATE, and a project
 * whose coordinate set cannot be joined to any axis — nothing declares alignment and its
 * dataset publishes no key artifact — still plots its bare frame. What it does NOT get is a
 * colouring, which is correct and is the other sections' own business: painting one dataset's
 * columns on another's coordinates, with no declaration linking them, is the failure this pane
 * exists against.
 *
 * An UNRESOLVABLE identity still yields absence rather than a guess (INV-4): a coordinate whose
 * artifact is gone is not chosen, and an axis that is not in the catalog is not anchored.
 * Substituting the project's first anything would put a name on a picture drawn from something
 * else — the `layouts[0]` defect, one layer up from where ITEM-29 removed it.
 */
export function resolvePaneFrame(
  axes: readonly AxisSummary[],
  artifacts: readonly ArtifactRow[],
  axis: readonly string[] | null | undefined,
  coordinate: string | null | undefined,
): PaneFrame {
  // OPTIONAL now. `undefined` is an ordinary state — a picked coordinate whose rows no
  // declaration identifies — and every field derived from it degrades to its own absence
  // rather than taking the whole frame down with it.
  const anchor = resolveRowSpaceAnchor(artifacts, axis, coordinate)
  const coordRow =
    typeof coordinate === 'string' && coordinate !== ''
      ? artifacts.find(a => a.id === coordinate)
      : undefined
  if (!anchor && !coordRow) return NO_PANE_FRAME
  // The SAME join the plot titles render from (`rowSpaceOptions`), so the rows are named
  // identically in the ▶'s label and in every plot title. A second formatter here would drift
  // the moment either learned a new fallback, and the drift would be invisible — both would
  // look like a name.
  //
  // The SOLE axis, or none (ITEM-8). `rowSpaceOptions` names ONE row space, so a frame resting
  // on several has no option to find — see {@link PaneFrame.row_space_label} for what has to
  // arrive with the integrated case. Never `axes[0]`: naming half a frame is the `layouts[0]`
  // guess, and it is worse here than absence because it reads as a complete answer.
  const soleAxis = anchor?.axes.length === 1 ? anchor.axes[0] : undefined
  const option = soleAxis
    ? rowSpaceOptions(axes, artifacts).find(o => o.contentHash === soleAxis.contentHash)
    : undefined
  return {
    anchored: anchor !== undefined,
    axis: anchor?.axes.map(a => a.contentHash) ?? [],
    row_space: option?.provenance ?? '',
    row_space_label: option?.label ?? '',
    row_space_length: option?.length ?? 0,
    coordinate: coordRow?.id ?? null,
    coordinate_name: coordRow ? candidateLabel(coordRow) : NO_COORDINATE,
    // BOTH halves, unchanged: a plot TITLE is drawn from the pair, and a consumer that needs
    // the pair still asks this. What changed is that the ▶ no longer does.
    framed: coordRow !== undefined,
    resolved: true,
    // THE COORDINATE, and only the coordinate. This is the line the defect was in.
    plot_refusal: coordRow !== undefined ? null : NO_COORDINATE_REFUSAL,
    coordinate_label: coordRow ? candidateLabel(coordRow) : NO_COORDINATE_LABEL,
  }
}
