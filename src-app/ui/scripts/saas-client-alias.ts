// Two-spec client seam (#50) — the build-time selector for the presence-gate enum client.
//
// The saas admin pages (#45/#46/#47) self-hide on the PRESENCE of their backend permission
// in the generated `Permissions` enum (`src/core/permissions/saasGating.ts` reads
// `Object.values(Permissions)` from `@/api-client/permissions`). The repo commits TWO generated
// clients from the SAME backend: `api-client` (default/saas-OFF, `billing::admin` ABSENT) and
// `api-client-saas` (saas-ON, `billing::admin` PRESENT).
//
// This helper is the FRONTEND twin of the backend `--features saas` split: the hosted-web build
// runs with `VITE_SAAS` set (see `package.json` `build:saas`), which aliases the presence-gate
// enum client to `api-client-saas` so `isKnownPermission('billing::admin')` is TRUE. The
// desktop/default build leaves `VITE_SAAS` unset, so this returns [] and `@/api-client/*` keeps
// resolving to the default `api-client` — `billing::admin` is absent there and the pages stay
// hidden, EVEN for a root admin (the design's non-negotiable). Nothing hardcodes `isSaas`; the
// single source of truth remains whether the backend generated the permission.
//
// Only the ENUM surface (`permissions` + `permissionDescriptions`) is mode-selected. Endpoints
// and types for saas pages are imported from the FIXED `@/api-client-saas/*` path directly, so
// they resolve in BOTH modes — which is what lets `tsc` (run in default mode) still see the
// billing symbols even though those pages are dead-code-hidden on desktop.
//
// A plain-node .ts module (no DOM, no app imports): loaded by `vite.config.ts` via esbuild and
// by the vitest acceptance test; kept out of `src/` so it is not app runtime code.

import path from 'node:path'

/** One Vite `resolve.alias` array entry. */
export interface AliasEntry {
  find: string
  replacement: string
}

type EnvLike = Record<string, string | undefined>

/** Is this a hosted-web (saas-ON) build? Mirrors the backend `--features saas` default-OFF. */
export function isSaasBuild(env: EnvLike = process.env): boolean {
  const v = env.VITE_SAAS
  return v === '1' || v === 'true'
}

/**
 * Vite `resolve.alias` entries to PREPEND (more-specific-first) for a saas build.
 * Returns `[]` for the default/desktop build so `@/api-client/*` is left untouched.
 *
 * @param srcDir absolute path to the app `src` directory
 */
export function saasClientAlias(srcDir: string, env: EnvLike = process.env): AliasEntry[] {
  if (!isSaasBuild(env)) return []
  return [
    {
      find: '@/api-client/permissions',
      replacement: path.resolve(srcDir, 'api-client-saas/permissions'),
    },
    {
      find: '@/api-client/permissionDescriptions',
      replacement: path.resolve(srcDir, 'api-client-saas/permissionDescriptions'),
    },
  ]
}
