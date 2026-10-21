// coordSystem/installCoordSystems.ts — register the three built-in coordinate systems
// (EXTENSIBILITY_STUDY Part 6 STEP 5) through the `use(installer)` extension surface, the
// coord-system sibling of `charts/installBuiltins.tsx`. `world2d` / `chart2d` / `matrix2d`
// each register via `registers.registerCoordinateSystem(id, def)`.
//
// Idempotent by installer identity (ECharts `use`), so calling `installCoordSystems()` from
// every entry (the grid, the popout, tests) registers exactly once. Call it once at grid
// setup — alongside `installBuiltins()` — so a chart descriptor's `coordinateSystem` string
// resolves to a registered system before any cell renders.

import { use, type InstallRegisters } from '../extension'
import { world2d } from './world2d'
import { chart2d } from './chart2d'
import { matrix2d } from './matrix2d'

/** The single installer: registers the three built-in coordinate systems. Stable
 *  module-level reference so `use()` dedupes it across repeated calls. */
const coordSystemsInstaller = (r: InstallRegisters): void => {
  r.registerCoordinateSystem(world2d.id, world2d)
  r.registerCoordinateSystem(chart2d.id, chart2d)
  r.registerCoordinateSystem(matrix2d.id, matrix2d)
}

/**
 * Register the three built-in coordinate systems into the registry. Idempotent (registers
 * exactly once regardless of how many entries call it). Call once at grid setup so every
 * chart descriptor's `coordinateSystem` resolves to a registered system.
 */
export function installCoordSystems(): void {
  use(coordSystemsInstaller)
}
