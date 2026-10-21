// THE A3 EXIT METRIC (visualize-pane ITEM-21) — how far this project has got with declaring
// which row space its artifacts line up with.
//
// ── Why a migration needs a progress indicator ──────────────────────────────────────────
//
// The Visualize pane OFFERS a candidate whose producer declared no alignment, and MARKS it
// (A3, DEC-11: *"unknown alignment is offered but MARKED"*). That is the right call while the
// declaration is spreading, and it has a failure mode the design names outright: *"a migration
// state with no progress indicator becomes permanent, and the marker becomes noise everyone
// learns to skip."* A number that moves is what makes the marker's eventual disappearance
// something anyone is working toward.
//
// ── Where it lives, and where it does NOT ───────────────────────────────────────────────
//
// Not in the Visualize pane. A per-project migration statistic is a fact about the project's
// DATA, and it belongs where the project's data is already described — the artifacts panel,
// which already reads this exact catalog and already groups it. Putting it beside the marker
// would make it a footnote to one pane; putting it here makes it a property of the project.
//
// Pure over catalog rows, so it costs nothing (the panel has already fetched them) and is
// directly testable. Nothing here belongs to any domain.

/** The catalog fields this metric reads. Structural, so both `ListedArtifact` and the
 *  workbench's own `ArtifactRow` satisfy it without either being imported. */
export interface AlignmentCarrier {
  structure: unknown
  meta?: unknown
}

/** The `structure` keys that decide an artifact's place in the metric. */
function structureOf(row: AlignmentCarrier): { axis?: unknown; key?: unknown; aligned_to?: unknown } {
  const s = row.structure
  return s != null && typeof s === 'object' ? (s as Record<string, unknown>) : {}
}

const nonEmpty = (v: unknown): boolean => typeof v === 'string' && v !== ''

/**
 * Is this row an artifact whose alignment is a QUESTION?
 *
 * It has to sit on an axis (an artifact with no axis has no row space to line up with), and it
 * must not BE one: a key artifact IS the row space, so asking it to declare alignment to itself
 * is not a migration step anybody can take. Counting key artifacts in the denominator would put
 * a permanent floor under the percentage and make 100% unreachable — the exact way a progress
 * indicator stops being read.
 */
export function alignmentApplies(row: AlignmentCarrier): boolean {
  const s = structureOf(row)
  if (!nonEmpty(s.axis)) return false
  if (nonEmpty(s.key)) return false
  const meta = row.meta
  if (meta != null && typeof meta === 'object' && (meta as Record<string, unknown>).is_axis_index === true) {
    return false
  }
  return true
}

/** Has this artifact's producer declared which row space it lines up with? */
export function declaresAlignment(row: AlignmentCarrier): boolean {
  return nonEmpty(structureOf(row).aligned_to)
}

export interface AlignmentCoverage {
  /** artifacts whose producer declared `structure.aligned_to`. */
  declared: number
  /** artifacts for which the question applies at all. */
  total: number
  /** `declared / total`, or `null` when the question applies to nothing — which is NOT zero
   *  percent. A project with no such artifacts has not failed to migrate anything, and a tile
   *  reading "0%" about it would be a reproach for nothing. Absence is the honest answer and
   *  the panel renders none. */
  ratio: number | null
}

/** The project's alignment coverage. PURE. */
export function alignmentCoverage(rows: readonly AlignmentCarrier[]): AlignmentCoverage {
  let total = 0
  let declared = 0
  for (const row of rows) {
    if (!alignmentApplies(row)) continue
    total += 1
    if (declaresAlignment(row)) declared += 1
  }
  return { declared, total, ratio: total === 0 ? null : declared / total }
}

/** What the tile READS. Rounded toward zero so a project one artifact short of complete never
 *  reads "100%" — the one rounding error that would make the indicator claim the migration is
 *  over while the marker is still on screen. */
export function alignmentCoverageLabel(c: AlignmentCoverage): string {
  if (c.ratio === null) return ''
  const pct = c.declared === c.total ? 100 : Math.floor(c.ratio * 100)
  return `${pct}% · ${c.declared.toLocaleString()} of ${c.total.toLocaleString()}`
}
