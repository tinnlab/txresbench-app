// A MINIMAL bootstrap lattice (ITEM-6) so `isA`/`ancestors`/`descendants` work in
// the brief window before `GET /api/datatypes` populates the registry. This is a
// skeleton (edges only — no capabilities/viewers/storage detail); the BACKEND is
// the source of truth and REPLACES this wholesale on populate (`boot.ts`). It is
// deliberately NOT a full hand-maintained mirror — the parity gate (ITEM-7) checks
// the API-populated registry, not this bootstrap.

import type { Datatype, LayoutKind } from './types'

function lite(id: string, ext: string | null, isAbstract: boolean, layout: LayoutKind): Datatype {
  return {
    id,
    extends: ext,
    title: id,
    description: '',
    storage: {
      layout,
      format: '',
      selector_map: {},
      file_layout: 'single',
      tiers: ['tier1_range_client_decode'],
    },
    capabilities: [],
    viewers: [],
    converters: [],
    is_abstract: isAbstract,
  }
}

const DENSE: LayoutKind = { kind: 'chunked_dense' }
const TABLE: LayoutKind = { kind: 'columnar_table' }
const OPAQUE: LayoutKind = { kind: 'opaque_as_is' }

/**
 * The bootstrap seed edges (id + extends + abstract) — the SIX UNIVERSAL ROOTS ONLY
 * (processor-separability Phase 5 / ITEM-9, DEC-2). These are the datatype-SYSTEM
 * primitives (`data`/`data/opaque`/`tabular`/`matrix`/`report/html`/`file/upload`),
 * identical to the backend's roots-only `datatype/builtin.rs`. ZERO domain datatype
 * ids/edges (no `single-cell/*`, `embedding`, `clustering`, `metadata-column`, `de`):
 * the whole domain lattice is contributed DATA the FE gets from `GET /api/datatypes`
 * (23 types), which REPLACES this skeleton wholesale on populate (`boot.ts`).
 */
export const BOOTSTRAP_LATTICE: Datatype[] = [
  lite('data', null, true, OPAQUE),
  lite('data/opaque', 'data', false, OPAQUE),
  lite('tabular', 'data', true, TABLE),
  lite('matrix', 'tabular', true, DENSE),
  lite('report/html', 'data', false, OPAQUE),
  lite('file/upload', 'data', false, OPAQUE),
]
