// Ambient types for the plain-JS Vite plugins shipped by `@txresbench/gallery`.
//
// The package's `vite/` entrypoints are `.js` with no declarations, and this app's
// tsconfig does not enable `allowJs`, so importing one from `vite.config.ts` (which
// IS in the tsconfig `include`) fails with TS7016. The plugin lives in the `sdk`
// submodule — another repo's source — so the declaration belongs here, in the
// consumer, not there.
//
// Typed as `Plugin` from vite (not `any`) so a signature change in the SDK shows up
// as a type error here instead of being silently swallowed.
declare module '@txresbench/gallery/vite/vite-plugin-gallery-sentinel.js' {
  import type { Plugin } from 'vite'
  /** Dev/preview-only middleware serving this server's worktree root at `/__worktree`. */
  export function gallerySentinelPlugin(): Plugin
}
