// The P2 datatype registry + data plane (core/, survives the P5 package split).
// The registry (`isA`/`accepts`/`viewersFor`/`matches`/`artifactsOfType`) is the FE
// mirror populated from `/api/datatypes` at boot; the data source is the layout-keyed
// client reader-dispatch. P5's `@/modules/workbench/core` later re-exports this contract
// as the `datatypes` contribution point (ITEM-25) — no logic moves.

import { datatypeRegistry } from './registry'
import { sniffFile as sniffFileImpl } from './sniff'

export { DatatypeRegistry, datatypeRegistry } from './registry'
export type { ArtifactLike } from './registry'
export { viewersFor } from './viewers'
export { sniffFile } from './sniff'
export type { SniffResult } from './sniff'
export { populateDatatypeRegistry, resetDatatypeRegistry, seedBootstrap } from './boot'
export { BOOTSTRAP_LATTICE } from './builtin'
export { fetchColumn, fetchRange, UnsupportedClientDecode } from './dataSource'
export type { ArtifactRef } from './dataSource'
export type {
  AccessTier,
  AnnotationType,
  AxisSpec,
  ConverterRef,
  ConverterRun,
  Datatype,
  FileLayout,
  IngestSpec,
  LayoutIndexRef,
  LayoutKind,
  SparseOrientation,
  StorageSpec,
  TypeSelector,
  ViewerRef,
} from './types'

// Expose the registry on `window.__datatypeRegistry` so an e2e can exercise the
// REAL shipped lattice logic (`isA`/`accepts`/`viewersFor`) in the browser against
// the shared golden fixture — the app is served as a preview build with no `/src`
// imports and there is no vitest runner (mirrors `core/workstore`'s `__workstore`
// seam). Read-only pure logic — a negligible, harmless testability seam.
if (typeof window !== 'undefined') {
  ;(window as unknown as { __datatypeRegistry?: unknown }).__datatypeRegistry = {
    isA: (sub: string, sup: string) => datatypeRegistry.isA(sub, sup),
    accepts: (dt: string, sel: unknown) =>
      datatypeRegistry.accepts(dt, (sel ?? {}) as Record<string, never>),
    viewersFor: (dt: string) => datatypeRegistry.viewersFor(dt).map(v => v.view_kind_id),
    all: () => datatypeRegistry.all().map(d => d.id),
    size: () => datatypeRegistry.size,
    // The serde-tagged layout kind the backend ships (parity-checked vs the golden).
    layoutKind: (dt: string) => datatypeRegistry.get(dt)?.storage.layout.kind ?? null,
    // Capabilities are only populated by the API (the bootstrap skeleton has none) —
    // an e2e reads this to prove the authoritative populate actually happened.
    capabilities: (dt: string) => datatypeRegistry.get(dt)?.capabilities ?? [],
    // NOTE (artifact-model ITEM-12/ITEM-25): the `readPlan` seam is GONE. It resolved an
    // ACCESS TIER — server-side Selection slice vs client byte-Range decode — and with
    // `/read` deleted every read is a client decode, so the negotiation had exactly one
    // possible outcome. Its e2e (`tests/e2e/datatype/data-source.spec.ts`) asserted the
    // tier decision itself, so it goes with the seam rather than being re-pointed at a
    // constant.
    // The FE sniff round-trip (ITEM-13) — exercised end-to-end by the e2e.
    sniffFile: (file: File) => sniffFileImpl(file),
    // The ingest hints a type DECLARES (`null` when it declares none — which is also
    // exactly what makes it invisible to the sniffer). Exposed so the sniff e2e can
    // DERIVE which type, if any, claims a given extension from the live registry
    // rather than hardcoding an id that goes stale the moment a type is added or
    // pruned. Enforced by `server/tests/datatype/cross_side_test.rs`.
    ingestFor: (dt: string) => datatypeRegistry.get(dt)?.ingest ?? null,
  }
}
