/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string
  // Build-time opt-in for the read-only workstore data-plane test seams
  // (`window.__cyto_read` / `window.__cyto_ds`): set by the e2e preview build so the
  // real catalog→select flow is drivable, UNSET in a real release (→ tree-shaken out).
  readonly VITE_ENABLE_TEST_SEAMS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
