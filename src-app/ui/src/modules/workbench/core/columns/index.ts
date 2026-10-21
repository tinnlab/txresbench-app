// The per-position value-reference vocabulary + the dense column-reading substrate.
// (`fixtureCtx.ts` is deliberately NOT re-exported — it is test support, reachable by
// an explicit deep import from a `*.test.ts`, exactly as its predecessor was.)

export * from './ref.ts'
export * from './errors.ts'
export * from './resolve.ts'
