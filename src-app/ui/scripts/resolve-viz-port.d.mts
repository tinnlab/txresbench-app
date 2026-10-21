// Hand-written types for the runnable `.mjs` resolver.
//
// The implementation must stay a plain `.mjs`: `playwright.viz.config.ts` and the
// `e2e-viz-package` justfile recipe both invoke it as `node scripts/resolve-viz-port.mjs`,
// and a `.ts` would need a loader in both. So the module keeps its runtime form and TS
// consumers (the ms-leg spec asserts the derived bands) read the shape from here.

export interface PortBand {
  floor: number
  span: number
}

export type VizLeg = 'vizShowcase' | 'vizBench'

export declare const VIZ_PORT_FLOORS: Record<VizLeg, PortBand>
export declare const VIZ_PORT_ENV: Record<VizLeg, string>

export declare function resolveVizPort(
  which: VizLeg,
  opts?: { env?: Record<string, string | undefined>; maxAttempts?: number; start?: number | null; allowReuse?: boolean },
): Promise<{ port: number; reused: boolean; pinned: boolean }>
