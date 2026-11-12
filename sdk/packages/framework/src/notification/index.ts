// SDK notification feature — the per-module renderer-registry seam (frontend).
// The durable inbox store + bell shell are wired by the consuming app today
// (dogfooding surfaced that the SDK needs a kit-having UI home before the bell
// can move here — see txresbench SDK_GAPS). The extensibility SEAM lives here.
export * from './types'
export * from './registry'
