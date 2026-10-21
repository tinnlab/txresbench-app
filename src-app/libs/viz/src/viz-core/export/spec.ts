// spec.ts — the serializable WORKSPACE SPEC (DEC-31 "Spec" family): a plain, JSON-able
// description of the grid layout tree + per-cell view config, so a workspace can be
// exported to JSON and re-imported EXACTLY (round-trips deep-equal). Framework-agnostic
// (viz-core), generic naming (DEC-28): `cell`/`kind`/`colorBy`, no domain terms.

/** A single grid cell's view configuration (a leaf of the layout tree). */
export interface CellSpec {
  /** Stable cell id (referenced by layout leaves). */
  id: string
  /** The view-kind rendered in this cell (e.g. 'scatter', 'image', 'heatmap'). */
  kind: string
  /** The active color-by key/mode descriptor, or null when unset. */
  colorBy?: string | null
}

/** A leaf of the layout tree — occupies its slot with one cell. */
export interface LayoutLeaf {
  type: 'leaf'
  cellId: string
}

/** A split node — lays its children out along a direction with fractional sizes. */
export interface LayoutSplit {
  type: 'split'
  direction: 'row' | 'column'
  /** Fractional sizes (parallel to `children`); should sum to ~1. */
  sizes: number[]
  children: LayoutNode[]
}

export type LayoutNode = LayoutLeaf | LayoutSplit

/** A complete, JSON-serializable workspace: layout tree + the cells it references. */
export interface WorkspaceSpec {
  version: number
  layout: LayoutNode
  cells: CellSpec[]
}

/** Serialize a spec to a JSON string (stable: preserves object insertion order). */
export function serializeSpec(spec: WorkspaceSpec): string {
  return JSON.stringify(spec)
}

/** Parse a spec JSON string back into a WorkspaceSpec. Inverse of `serializeSpec`. */
export function deserializeSpec(json: string): WorkspaceSpec {
  return JSON.parse(json) as WorkspaceSpec
}

/**
 * True iff `spec` survives a serialize → deserialize → serialize round-trip
 * byte-for-byte (i.e. it is a plain JSON-able shape with no lossy fields).
 */
export function specRoundTrips(spec: WorkspaceSpec): boolean {
  const once = serializeSpec(spec)
  return serializeSpec(deserializeSpec(once)) === once
}
