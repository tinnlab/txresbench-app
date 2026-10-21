// manifest.ts — the FIGURE PROVENANCE MANIFEST (ITEM-6 / ITEM-7). A figure is "reproducible" only if it
// stays linked to BOTH the data it derived from AND the steps that produced it (the reproducibility
// literature + journal Source-Data policy). The tool owns that state, so every export can emit a
// `manifest.json` capturing: the dataset id + a CONTENT HASH of the plotted values, the encoding + filter/
// transform chain, the RNG seed (so stochastic steps are re-runnable), and the tool/library version +
// timestamp. Pure + node-safe: the caller (GridWorkspace) assembles the input from state it already holds.

/** FNV-1a (32-bit) → 8 hex chars. Two passes with different init give a 16-hex content hash with low
 *  collision risk, dep-free (matches the repo's FNV stable-hash idiom; no crypto dep — DEC-7). */
function fnv1a(str: string, init: number): number {
  let h = init >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
const hex8 = (n: number) => n.toString(16).padStart(8, '0')

/** A stable content hash of the plotted rows — same data ⇒ same hash, changed data ⇒ different. */
export function hashRows(rows: ReadonlyArray<ReadonlyArray<number | string>>): string {
  const s = JSON.stringify(rows)
  return hex8(fnv1a(s, 0x811c9dc5)) + hex8(fnv1a(s, 0x7a646e4d))
}

import type { VizSelectionOp, VizSelectionContext } from '../option/types'

export interface FigureManifestInput {
  cellId: string
  kind: string
  datasetId?: string | null
  /** The exact plotted values (post-transform) — hashed, NOT stored, into `data.contentHash`. */
  sourceRows?: ReadonlyArray<ReadonlyArray<number | string>>
  colorBy?: { mode?: string; key?: string; colormap?: string; scale?: string } | null
  valueRange?: readonly [number, number] | null
  hiddenGroups?: readonly (number | string)[]
  linkValueFilters?: ReadonlyArray<{ column: string; range: readonly [number, number] }>
  /** The RNG seed that drove every stochastic step (jitter/subsample/sketch) — re-run to reproduce. */
  seed: number
  toolVersion: string
  vizVersion: string
  /** ITEM-17 — HOW the selection was made (the ordered op recipe + the display context it was made
   *  under), so an exported figure carries its provenance and not just its outcome. Optional: a
   *  figure exported with no selection simply omits it, and `schema` stays `'ziee-viz-figure/1'`. */
  selection?: { ops: readonly VizSelectionOp[]; context?: VizSelectionContext } | null
}

export interface FigureManifest {
  schema: 'ziee-viz-figure/1'
  createdAt: string
  cell: { id: string; kind: string }
  data: { datasetId: string | null; contentHash: string | null }
  encoding: { colorBy: FigureManifestInput['colorBy'] }
  filters: {
    valueRange: readonly [number, number] | null
    hiddenGroups: readonly (number | string)[]
    link: ReadonlyArray<{ column: string; range: readonly [number, number] }>
  }
  reproducibility: { seed: number; toolVersion: string; vizVersion: string }
  /** ITEM-17 — present only when the figure was exported with a live selection. */
  selection?: { ops: readonly VizSelectionOp[]; context?: VizSelectionContext }
}

/** Assemble the manifest from captured cell state. `now` is injectable so tests are deterministic. */
export function buildFigureManifest(input: FigureManifestInput, now: () => string = () => new Date().toISOString()): FigureManifest {
  return {
    schema: 'ziee-viz-figure/1',
    createdAt: now(),
    cell: { id: input.cellId, kind: input.kind },
    data: {
      datasetId: input.datasetId ?? null,
      contentHash: input.sourceRows ? hashRows(input.sourceRows) : null,
    },
    encoding: { colorBy: input.colorBy ?? null },
    filters: {
      valueRange: input.valueRange ?? null,
      hiddenGroups: input.hiddenGroups ?? [],
      link: input.linkValueFilters ?? [],
    },
    reproducibility: { seed: input.seed, toolVersion: input.toolVersion, vizVersion: input.vizVersion },
    // ITEM-17 — omitted entirely when there is no selection, so a figure exported without one is
    // byte-identical to before this feature.
    ...(input.selection && input.selection.ops.length > 0
      ? {
          selection: {
            ops: [...input.selection.ops],
            ...(input.selection.context ? { context: input.selection.context } : {}),
          },
        }
      : {}),
  }
}

/** Serialize the manifest to pretty JSON (the `manifest.json` bundle entry). */
export function manifestToJSON(m: FigureManifest): string {
  return JSON.stringify(m, null, 2)
}
