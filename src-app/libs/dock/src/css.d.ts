// Ambient declaration for side-effect CSS imports, mirroring `@ziee/kit`'s own `src/css.d.ts`.
// `ContainerWindows` imports `@ziee/kit` (for `PortalContainerProvider`), and the kit barrel
// reaches a component that does `import 'overlayscrollbars/overlayscrollbars.css'` — without this
// declaration `tsc --noEmit` in this package fails on that side-effect import. The app and viz
// resolve it through their bundler config; a type-only pass needs it spelled out.
declare module '*.css';
