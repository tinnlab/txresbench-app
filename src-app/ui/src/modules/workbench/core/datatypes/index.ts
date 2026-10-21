// The `datatypes` contribution point barrel (ITEM-7). Types-only re-export of the
// P2 datatype contract + the host-injected lattice seam + the WhenClause engine.
export type {
  Datatype,
  TypeSelector,
  StorageSpec,
  LayoutKind,
  SparseOrientation,
  FileLayout,
  AccessTier,
  LayoutIndexRef,
  ViewerRef,
  ConverterRef,
  ConverterRun,
  IngestSpec,
} from './types.ts'
export type { DatatypeLattice } from './lattice.ts'
export { identityLattice } from './lattice.ts'
export { PLOTTABLE_XY_CAPABILITY, declaresPositions } from './plottable.ts'
export type { WhenClause, WhenContext, ValuePredicate } from './when.ts'
export { evaluateWhen } from './when.ts'
