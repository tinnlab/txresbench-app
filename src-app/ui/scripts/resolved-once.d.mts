// Hand-written types for the runnable `.mjs`. Same reason as `resolve-viz-port.d.mts`:
// the implementation stays a plain `.mjs` because the Playwright configs import it
// while ALSO being loaded by esbuild-CJS, and a `.ts` would need a loader.

export declare function resolvedOnce<T>(name: string, resolve: () => T): T
