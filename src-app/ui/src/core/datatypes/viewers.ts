// Viewer dispatch resolver (ITEM-19). Resolves a datatype to its `ViewerRef[]` UP
// the subtype lattice (a `matrix`-family viewer applies to `single-cell/expression`).
// This module DISPATCHES; the canvas extension RENDERS — each `view_kind_id` names
// a renderer in canvas's own chart-type registry (DEC-7). It once named a
// workbench-core `registerViewKind` registry, deleted in processor-ui-language
// DEC-L for having zero production registrants. This module never renders.

import { datatypeRegistry } from './registry'
import type { ViewerRef } from './types'

/** The viewers that can render an artifact of `datatype`, most-specific first. */
export function viewersFor(datatype: string): ViewerRef[] {
  return datatypeRegistry.viewersFor(datatype)
}
