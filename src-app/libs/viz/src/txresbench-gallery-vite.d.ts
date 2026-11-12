// Ambient types for the plain-JS Vite plugins shipped by `@txresbench/gallery`.
//
// The package's `vite/` entrypoints are `.js` with no declarations, and this package's
// tsconfig does not enable `allowJs`, so importing one from `vite.config.ts` (which IS
// in the tsconfig `include`) fails with TS7016. The plugin lives in the `sdk` submodule
// — another repo's source — so the declaration belongs here, in the consumer, not there.
//
// Typed as `Plugin` from vite (not `any`) so a signature change in the SDK shows up as a
// type error here instead of being silently swallowed.
//
// This mirrors `src-app/ui/src/txresbench-gallery-vite.d.ts`, which solves the identical problem
// for the identical specifier. It is a second copy rather than a shared file on purpose:
// the two workspaces have separate TS programs and neither may reach into the other's
// `src/`, which is also why `src-app/ui`'s copy did not cover this one — viz's own `tsc`
// had no caller until #276, so the gap was invisible.
declare module '@txresbench/gallery/vite/vite-plugin-gallery-sentinel.js' {
  import type { Plugin } from 'vite'
  /** Dev/preview-only middleware serving this server's worktree root at `/__worktree`. */
  export function gallerySentinelPlugin(): Plugin
}
