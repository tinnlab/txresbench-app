// tooltipModel.ts — the pure, O(1) DATA MODEL behind the GPU hover tooltip.
//
// PERFORMANCE CONTRACT (the defining requirement — read before editing):
//   • Tooltip data access is IMMEDIATE / O(1) / SYNCHRONOUS even at millions of points.
//   • The data is ALREADY resident as columnar typed arrays (positions Float32Array[N*2],
//     categorical `codes Uint16Array[N]` + `categories string[]`, value/continuous
//     Float32Arrays, the aggregated heatmap matrix). GPU picking hands us an INDEX
//     (scatter) or a texel [col,row] (heatmap) with NO CPU scan.
//   • A tooltip row is built by O(1) ARRAY INDEXING into those resident columns:
//     `positions[2*i]`, `categories[codes[i]]`, `valueCol[i]`,
//     `matrix.values[row*ncols+col]`. Constant-time regardless of N — an accessor
//     touches ONE index; `resolve*` is O(fields), never O(N).
//   • NEVER fetch on hover. Any column a field references MUST already be resident.
//     Throttle only the RENDER (rAF-batch the React setState); the data access itself is
//     immediate. This module contains ZERO async, ZERO allocation-over-N, ZERO loops over N.
//
// CUSTOMIZABLE: every surface builds a sensible DEFAULT field list, and callers pass
// `extra: TooltipField[]` to add arbitrary resident columns (each `extra` accessor must
// itself be O(1) — read one index of a resident array).

const EM_DASH = '—'

export type TooltipValue = string | number | null

/**
 * One declarative tooltip field. `accessor(idx)` reads a RESIDENT typed array at `idx`
 * in O(1) — it must NOT scan or allocate over N. `format` optionally overrides the
 * default value → string rendering.
 */
export interface TooltipField {
  readonly key: string
  readonly label: string
  readonly accessor: (idx: number) => TooltipValue
  readonly format?: (v: TooltipValue) => string
}

/** A matrix (row,col) field — the heatmap analog of `TooltipField`. O(1) per accessor. */
export interface MatrixTooltipField {
  readonly key: string
  readonly label: string
  readonly accessor: (row: number, col: number) => TooltipValue
  readonly format?: (v: TooltipValue) => string
}

export interface TooltipRow {
  readonly label: string
  readonly value: string
}

export interface TooltipResult {
  readonly rows: TooltipRow[]
}

/**
 * The resident columns bundle for a SCATTER surface. Every member is a typed array (or
 * category label list) already in JS memory — indexing them is O(1). Nothing here is
 * fetched on hover.
 */
export interface TooltipContext {
  /** interleaved xy, length N*2. `positions[2*i]` = x, `positions[2*i+1]` = y. */
  readonly positions: Float32Array
  /** per-point categorical codes (the grouping column), length N. */
  readonly codes?: Uint16Array
  /** category labels; `categories[codes[i]]` is point i's group. */
  readonly categories?: readonly string[]
  /** arbitrary resident value/continuous columns, keyed by name (`columns[key][i]`). */
  readonly columns?: Readonly<Record<string, Float32Array | Uint16Array>>
  /** the active color-by value column (continuous), length N — shown as its own row. */
  readonly colorValue?: Float32Array
  /**
   * when the color-by is CATEGORICAL, `colorValue` holds codes and these are the labels
   * (`colorCategories[colorValue[i]]`). When absent, `colorValue` renders as a number.
   */
  readonly colorCategories?: readonly string[]
}

/** Optional display labels (a caller maps these from the `DatasetCatalog`). */
export interface TooltipCatalogLabels {
  readonly group?: string
  readonly color?: string
  readonly x?: string
  readonly y?: string
}

/** The heatmap matrix seen by the tooltip: resident row-major values + axis labels. */
export interface TooltipMatrix {
  readonly rows: readonly string[]
  readonly cols: readonly string[]
  /** row-major, length rows×cols. `values[row*cols.length + col]`. */
  readonly values: Float32Array
  /** OPTIONAL per-cell n/count (row-major, same shape) — shown when present. */
  readonly counts?: Float32Array | Uint32Array | Uint16Array
}

// ── formatting (pure, allocation-light) ───────────────────────────────────────

/** Compact numeric formatting: integers verbatim, small/large → exponential, else 4dp. */
export function formatNumber(v: number): string {
  if (!Number.isFinite(v)) return EM_DASH
  if (Number.isInteger(v)) return String(v)
  const abs = Math.abs(v)
  if (abs !== 0 && (abs < 1e-3 || abs >= 1e6)) return v.toExponential(2)
  // Trim trailing zeros from a 4-dp fixed form (12.3400 → 12.34).
  return String(Number(v.toFixed(4)))
}

/** Default value → display string: null / NaN → an em-dash (never a crash). */
export function defaultFormat(v: TooltipValue): string {
  if (v === null || v === undefined) return EM_DASH
  if (typeof v === 'number') return formatNumber(v)
  return v
}

// ── scatter field builders (O(1) accessors) ───────────────────────────────────

/**
 * Build the DEFAULT scatter tooltip fields (group, color-by value, x, y) + any custom
 * `extra` fields. Every accessor closes over a resident typed array and reads ONE index —
 * O(1), no scan. Fields whose source column is absent are simply omitted.
 *
 * The field spec is CUSTOMIZABLE: pass `extra` to surface arbitrary resident columns,
 * e.g. `{ key:'qc', label:'QC score', accessor: i => ctx.columns!.qcA[i] }`.
 */
export function buildScatterTooltipFields(
  ctx: TooltipContext,
  catalog?: TooltipCatalogLabels,
  extra: readonly TooltipField[] = [],
): TooltipField[] {
  const fields: TooltipField[] = []

  // group: categories[codes[i]] — a double O(1) index.
  if (ctx.codes && ctx.categories) {
    const codes = ctx.codes
    const categories = ctx.categories
    fields.push({
      key: 'group',
      label: catalog?.group ?? 'Group',
      accessor: i => categories[codes[i]] ?? null,
    })
  }

  // active color-by value (categorical → label, else numeric).
  if (ctx.colorValue) {
    const colorValue = ctx.colorValue
    const colorCategories = ctx.colorCategories
    fields.push({
      key: 'color',
      label: catalog?.color ?? 'Value',
      accessor: colorCategories
        ? i => colorCategories[colorValue[i]] ?? null
        : i => (Number.isFinite(colorValue[i]) ? colorValue[i] : null),
    })
  }

  // x / y coordinate — direct interleaved indexing.
  const positions = ctx.positions
  fields.push({
    key: 'x',
    label: catalog?.x ?? 'x',
    accessor: i => positions[2 * i],
  })
  fields.push({
    key: 'y',
    label: catalog?.y ?? 'y',
    accessor: i => positions[2 * i + 1],
  })

  // custom fields last (caller-supplied, must be O(1) themselves).
  for (const f of extra) fields.push(f)
  return fields
}

/**
 * Resolve the scatter tooltip at point `idx`: map each field's accessor(idx) → a
 * formatted row. O(fields), NOT O(N) — no column is scanned, only indexed at `idx`.
 */
export function resolveTooltip(
  fields: readonly TooltipField[],
  idx: number,
): TooltipResult {
  const rows: TooltipRow[] = []
  for (const f of fields) {
    const raw = f.accessor(idx)
    rows.push({ label: f.label, value: (f.format ?? defaultFormat)(raw) })
  }
  return { rows }
}

// ── heatmap-matrix field builders (O(1) accessors) ────────────────────────────

/**
 * Build the DEFAULT heatmap matrix tooltip fields (group=row label, feature=col label,
 * value, coordinate, + n/count when the matrix carries it) plus any custom `extra`.
 * `values[row*ncols+col]` is a single O(1) index; the labels are O(1) array reads.
 */
export function buildMatrixTooltipFields(
  matrix: TooltipMatrix,
  catalog?: { group?: string; feature?: string; value?: string },
  extra: readonly MatrixTooltipField[] = [],
): MatrixTooltipField[] {
  const { rows, cols, values, counts } = matrix
  const ncols = cols.length
  const fields: MatrixTooltipField[] = [
    {
      key: 'group',
      label: catalog?.group ?? 'Group',
      accessor: (row, _col) => rows[row] ?? null,
    },
    {
      key: 'feature',
      label: catalog?.feature ?? 'Feature',
      accessor: (_row, col) => cols[col] ?? null,
    },
    {
      key: 'value',
      label: catalog?.value ?? 'Value',
      accessor: (row, col) => {
        const v = values[row * ncols + col]
        return v === undefined || !Number.isFinite(v) ? null : v
      },
    },
    {
      key: 'coord',
      label: 'Cell',
      accessor: (row, col) => `${row}, ${col}`,
    },
  ]
  if (counts) {
    fields.push({
      key: 'n',
      label: 'n',
      accessor: (row, col) => {
        const c = counts[row * ncols + col]
        return c === undefined ? null : c
      },
    })
  }
  for (const f of extra) fields.push(f)
  return fields
}

/**
 * Resolve the heatmap tooltip at texel (`row`,`col`). O(fields), NOT O(N×M) — the matrix
 * is a single O(1) index; no scan over the matrix.
 */
export function resolveMatrixTooltip(
  fields: readonly MatrixTooltipField[],
  row: number,
  col: number,
): TooltipResult {
  const rows: TooltipRow[] = []
  for (const f of fields) {
    const raw = f.accessor(row, col)
    rows.push({ label: f.label, value: (f.format ?? defaultFormat)(raw) })
  }
  return { rows }
}
