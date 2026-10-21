// rasterFirst.ts — the pure RASTER-FIRST gate (PERFORMANCE_PLAN.md Phase 2). Under a software
// renderer the dense cloud is drawn as ONE CPU-binned BitmapLayer quad (CpuRasterView), so the
// GL point path must NEVER build: constructing a ScatterplotLayer for N points allocates an O(N)
// interleaved GPU buffer + the per-point color VALUE array — exactly the work that stalled 10M
// LOAD under SwiftShader. `CategoricalPointsView` keeps its hooks unconditional (stable order) and
// routes each point-layer memo body through these predicates, so a 10M dataset in raster mode
// allocates NONE of it.
//
// PURE + framework-agnostic (no deck.gl / React) so the gate is unit-tested directly, rather than
// inferred from a rendered component.

const EMPTY_F32 = new Float32Array(0)

/**
 * True when the GL point/density layers should be built AT ALL — i.e. NOT in CPU-raster mode.
 * The single source of truth for the raster-first short-circuit: `layers` returns `[]` and every
 * O(N) point-layer memo early-outs when this is false.
 */
export function shouldBuildPointLayers(rasterActive: boolean): boolean {
  return !rasterActive
}

/**
 * The per-point color VALUE buffer the categorical scatter uploads (the category code as float,
 * sampled against the palette LUT in-shader) — or an EMPTY array in raster mode. Returning the
 * shared empty array in raster mode is the load fix: NO 4·N-byte allocation happens for a cloud
 * that will render as a BitmapLayer quad.
 */
export function pointColorValue(categoryCodes: Uint16Array, rasterActive: boolean): Float32Array {
  return rasterActive ? EMPTY_F32 : Float32Array.from(categoryCodes)
}
