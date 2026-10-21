// extension.ts — the `use(installer)` extension surface (EXTENSIBILITY_STUDY §3.3), a
// near-verbatim port of Apache ECharts' `src/extension.ts`. Everything opt-in flows
// through ONE install contract: `use(ext)` hands each installer the entire `registers`
// object, and an installer registers its own pieces (STEP 1: `registerChartType`).
//
// Idempotent by installer identity — a module `use`d twice (e.g. `installBuiltins()`
// called from both the grid and the popout entry) installs exactly once.

import { registerChartType } from './registry/registry'
import { registerCoordinateSystem } from './registry/coordSystem'

// ── register surface ──────────────────────────────────────────────────────────
// `registerChartType` (STEP 1) + `registerCoordinateSystem` (STEP 5) are real. The
// remaining register slots are the ECharts-shaped seams the later steps (Selection /
// DataZoom components, the `option` pipeline) fill in — no-op stubs for now so an
// installer can already reference them without a signature change when they go live.

/** Priority buckets for pipeline handlers (ECharts `PRIORITY`). Stubbed until the pipeline step. */
const PRIORITY = {
  PROCESSOR: { FILTER: 1000, STATISTIC: 5000 },
  VISUAL: { BRUSH: 2000, CHART_ITEM: 3000 },
} as const

/* eslint-disable @typescript-eslint/no-unused-vars */
function registerComponent(_desc: unknown): void {}
function registerAction(_type: unknown, _handler?: unknown): void {}
function registerLayout(_handler: unknown): void {}
function registerVisual(_handler: unknown): void {}
function registerProcessor(_priority: unknown, _handler?: unknown): void {}
/* eslint-enable @typescript-eslint/no-unused-vars */

/** The full register surface handed to every installer. */
const registers = {
  registerChartType,
  registerCoordinateSystem,
  registerComponent,
  registerAction,
  registerLayout,
  registerVisual,
  registerProcessor,
  PRIORITY,
  /** Nested `use` so an installer can pull in its dependencies (ECharts pattern). */
  use,
}

/** The register surface an installer receives (EXTENSIBILITY_STUDY §3.3). */
export type InstallRegisters = typeof registers
/** An installer function. */
export type Installer = (r: InstallRegisters) => void
/** An extension object exposing an installer. */
export interface Extension {
  install: Installer
}

/** Already-installed extensions (idempotency guard, by identity — ECharts `extensions`). */
const installed = new Set<Installer | Extension>()

/**
 * Install one extension, an `{ install }` object, or an array of either — handing each
 * the whole `registers` surface. Idempotent by identity: a re-`use` of the same
 * installer / extension is a no-op (ECharts `use`).
 */
export function use(
  ext: Installer | Extension | Array<Installer | Extension>,
): void {
  if (Array.isArray(ext)) {
    for (const e of ext) use(e)
    return
  }
  if (installed.has(ext)) return
  installed.add(ext)
  const install = typeof ext === 'function' ? ext : ext.install
  install(registers)
}
