/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string
  // Build-time opt-in for the read-only workstore data-plane test seams
  // (`window.__cyto_read` / `window.__cyto_ds`): set by the e2e preview build so the
  // real catalog→select flow is drivable, UNSET in a real release (→ tree-shaken out).
  readonly VITE_ENABLE_TEST_SEAMS?: string
  // Two-spec client seam (#50): set (`1`/`true`) by the hosted-web `build:saas` so the
  // presence-gate enum client aliases to `api-client-saas` (billing::admin present). UNSET on
  // the desktop/default build → `@/api-client/*` stays the saas-OFF client. See
  // `scripts/saas-client-alias.mjs`.
  readonly VITE_SAAS?: string
  // Add more env variables as needed
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
