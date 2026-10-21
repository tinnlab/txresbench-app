// The nine user stores are consumed via their DIRECT handles (the proxies each
// `*.store.ts` exports through `registerLazyStore`), not through a global
// registry lookup — so there is no `RegisteredStores` declaration-merge block
// here any more. Reintroducing one would only re-enable `Stores.Users`, the
// synchronous lookup that forces every store to be registered (and therefore
// bundled) at boot.

export * from './GroupWidget'
