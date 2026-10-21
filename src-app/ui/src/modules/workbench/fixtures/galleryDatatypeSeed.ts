// dimension-primitives ITEM-9 — the gallery declared-annotation SEED. The component
// gallery is backend-free (no `GET /api/datatypes` populate), so the datatype registry is
// empty and the general dimension/annotation primitives have no declared axis-annotation
// schema to render their pickers from. This seeds the registry with the two datatypes the
// selection stories bind to — the single-cell `expression` matrix (so the single-cell
// dimension-selector story populates + drives a live count) and the non-single-cell image
// fixture (the INV-3 drop-in story) — WITH their `AxisSpec.annotations`. Additive: the
// shell/canvas stories reference other datatype ids (embedding/clustering) not seeded here,
// so their availability is unchanged.

import { BOOTSTRAP_LATTICE, datatypeRegistry, type Datatype } from '@/core/datatypes'
import { imageDatatype } from './imageDatatype'

/** A gallery-representative `single-cell/expression` matrix carrying the declared cells +
 *  genes axis annotations (a subset of the production manifest, same names/types) so the
 *  single-cell dimension-selector story renders real declared pickers. */
const singleCellExpressionGallerySeed: Datatype = {
  id: 'single-cell/expression',
  extends: 'matrix',
  title: 'Expression matrix',
  description: 'A single-cell expression matrix (cells × genes).',
  is_abstract: false,
  storage: {
    layout: { kind: 'chunked_sparse', orientation: 'csc' },
    format: 'zarr',
    selector_map: { gene: { index: 'column' }, cell: { index: 'row' } },
    file_layout: 'single',
    tiers: ['tier1_range_client_decode', 'tier2_layout_slice'],
  },
  capabilities: ['sliceable', 'has-obs', 'has-var'],
  viewers: [],
  converters: [],
  // Axis IDENTITY only (INV-5). Each axis used to enumerate the columns it "would" carry
  // (`cell_type`/`cluster`/`total_counts`/`pct_mito`, `highly_variable`/`mean_counts`) —
  // a forecast, and in the gallery's case a doubly-fictional one, since no artifact backs
  // it. Column lists are read from the artifacts that landed.
  axes: [
    { name: 'cells', key_label: 'barcode' },
    { name: 'genes', key_label: 'gene_id' },
  ],
  // The entity axis, by NAME — mirroring what the real manifest declares. Without it a
  // multi-axis datatype resolves to NOTHING (the resolver refuses to guess) and the
  // gallery would render every point count off the catalog's own axis order, with a
  // console warning per surface.
  entity_axis: 'cells',
}

let seeded = false

/** Seed the gallery datatype registry once (idempotent). Includes the six bootstrap roots
 *  so `matrix` (the ancestor of both seeded types) resolves for `isA`. */
export function seedGalleryDatatypes(): void {
  if (seeded) return
  seeded = true
  datatypeRegistry.replaceAll([...BOOTSTRAP_LATTICE, singleCellExpressionGallerySeed, imageDatatype])
}
