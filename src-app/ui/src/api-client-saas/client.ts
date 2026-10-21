import {
  ApiEndpointParameters,
  ApiEndpointResponses,
} from '@/api-client-saas/types'
import { ApiEndpoint, ApiEndpoints } from '@/api-client-saas/apiEndpoints'
import { createApiClient } from '@ziee/framework/api-client'
import type {
  FileUploadProgressCallback,
  SSECallback,
} from '@ziee/framework/api-client'

// The SAAS runtime ApiClient — completing the #50 seam (which wired permission
// PRESENCE gating but NOT invocation).
//
// The shipped default `ApiClient` (`@/api-client`) is built from the DEFAULT
// (saas-OFF) endpoint map, so the saas-only billing/credit/quota endpoints do NOT
// exist on it — even on the hosted-web build (#50's vite alias swaps ONLY the
// permission ENUM surface, not `apiEndpoints`). This module binds the SAME generic
// transport factory to the SAAS endpoint map so those endpoints are callable.
//
// It reuses the transport that `@/api-client` already registered globally
// (`setBaseUrlResolver`, auth token, refresh, retry, SSE) — `createApiClient` is a
// per-endpoint-map instance over that shared transport, so this needs NO config
// duplication (that was DEC-2's only concern with broadening the alias, and it does
// not apply to a second endpoint-map instance).
//
// The saas endpoint map + types are committed at FIXED paths present in BOTH
// builds, so this file compiles in the default build too; the billing pages that
// call it are presence-hidden on desktop, so nothing invokes it there. Mirrors the
// `GeneratedApiClient` construction in `@/api-client/index.ts` (lines 40-120).

type ExtractNamespace<T extends string> = T extends `${infer N}.${string}`
  ? N
  : never
type Namespaces = ExtractNamespace<ApiEndpoint>

type Evaluate<T> = T extends infer U ? { [K in keyof U]: U[K] } : never

type ResolveParams<K extends ApiEndpoint> =
  K extends keyof ApiEndpointParameters ? ApiEndpointParameters[K] : never

type ResolveResponse<K extends ApiEndpoint> =
  K extends keyof ApiEndpointResponses ? ApiEndpointResponses[K] : never

type NamespaceMethods<N extends Namespaces> = Evaluate<{
  [K in ApiEndpoint as K extends `${N}.${infer M}` ? M : never]: (
    params: ResolveParams<K>,
    callbacks?: {
      SSE?: SSECallback<ResolveResponse<K>>
      fileUploadProgress?: FileUploadProgressCallback
      responseType?: 'stream'
    },
  ) => Promise<ResolveResponse<K>>
}>

type SaasGeneratedApiClient = Evaluate<{
  [N in Namespaces]: NamespaceMethods<N>
}>

/** The saas ApiClient — one non-generic function per saas endpoint, typed from the
 *  saas param/response maps, over the shared global transport. */
export const SaasApiClient: SaasGeneratedApiClient =
  createApiClient<SaasGeneratedApiClient>(ApiEndpoints)
