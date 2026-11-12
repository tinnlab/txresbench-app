import {
  ApiEndpointParameters,
  ApiEndpointResponses,
} from '@/api-client/types'
import {
  ApiEndpoint,
  ApiEndpoints,
} from '@/api-client/apiEndpoints'
import {
  createApiClient,
  getAuthToken,
  setBaseUrlResolver,
} from '@txresbench/framework/api-client'
import type {
  FileUploadProgressCallback,
  SSECallback,
} from '@txresbench/framework/api-client'
import { getBaseUrl } from '@/api-client/getBaseURL'
// TYPE-ONLY, and deliberately so: the workstore reader imports `ApiClient` for its
// transport, so a runtime import back would close a cycle. `import type` is fully
// erased, and the typed read reaches its implementation through a dynamic `import()`
// below — which resolves after this module has finished evaluating.
import type {
  ColumnFor,
  ColumnKind,
  ReadColumnParams,
  WorkstoreByteReads,
  WorkstoreTypedReads,
} from '@/core/workstore/typedRead'

// Per-app binding of the framework ApiClient runtime.
//
// The transport (`createApiClient`, `callAsync`, auth/refresh/retry/SSE) moved
// into `@txresbench/framework/api-client`; the generated per-endpoint types
// (`ApiEndpoints`, `ApiEndpointParameters`, `ApiEndpointResponses`) stay
// per-app OUTPUT in this app's `api-client/types.ts`. This file is the thin
// binding layer that supplies those concrete types to the generic factory —
// the runtime is identical to before, only the type-map is app-owned.

// Register this app's base-URL resolver with the framework transport. The
// resolver is `@/api-client/getBaseURL`, which the desktop build swaps for the
// Tauri dynamic-port variant via its `.desktop` override — so the framework
// stays platform-agnostic while the desktop base-URL behavior is preserved.
setBaseUrlResolver(getBaseUrl)

// Re-export utility functions
export { getAuthToken }

// Helper types for automatic namespace/method extraction
type ExtractNamespace<T extends string> = T extends `${infer N}.${string}`
  ? N
  : never
type Namespaces = ExtractNamespace<ApiEndpoint>

// Force TypeScript to evaluate and display concrete types
type Evaluate<T> = T extends infer U ? { [K in keyof U]: U[K] } : never

// Force resolution of parameter types using identity function
type ResolveParams<K extends ApiEndpoint> =
  K extends keyof ApiEndpointParameters ? ApiEndpointParameters[K] : never

// Force resolution of response types
type ResolveResponse<K extends ApiEndpoint> =
  K extends keyof ApiEndpointResponses ? ApiEndpointResponses[K] : never

// Dynamic namespace methods with concrete type resolution
type NamespaceMethods<N extends Namespaces> = Evaluate<{
  [K in ApiEndpoint as K extends `${N}.${infer M}` ? M : never]: (
    params: ResolveParams<K>,
    callbacks?: {
      SSE?: SSECallback<ResolveResponse<K>>
      fileUploadProgress?: FileUploadProgressCallback
      /** ITEM-17 — ask the shared transport for the RAW body instead of the parse
       *  switch. Resolves to `response.body` at HEADERS, so bytes can be consumed
       *  progressively. Additive: omitting it is every existing call. */
      responseType?: 'stream'
    },
  ) => Promise<ResolveResponse<K>>
}>

// The client exactly as CODEGEN describes it — one non-generic function per
// endpoint, response type straight from `ApiEndpointResponses`.
type GeneratedApiClient = Evaluate<{
  [N in Namespaces]: NamespaceMethods<N>
}>

// ─────────────── The workstore byte-read override (artifact-model ITEM-29/30) ──
//
// `GET /artifacts/{id}/data[/{*member}]` is declared `application/octet-stream`, so
// codegen has no schema to type it from and emits `Promise<any>` — and an `any` at a
// call site disables checking on everything downstream of it. Worse, the useful
// signature for these reads ("the output type depends on the VALUE of an input field")
// is structurally inexpressible in a mapped type that emits one non-generic function per
// endpoint: no generator change produces it.
//
// So the three workstore read methods are OVERRIDDEN — `Omit`ed out of the generated
// namespace and replaced by hand-written signatures. Every OTHER generated method,
// in this namespace and every other, is carried through untouched.
type WorkstoreOverrides = WorkstoreByteReads & WorkstoreTypedReads

type ApiClientType = Omit<GeneratedApiClient, 'Workstore'> & {
  Workstore: Omit<GeneratedApiClient['Workstore'], keyof WorkstoreOverrides> & WorkstoreOverrides
}

// The transport hands back a `Blob` for any non-JSON, non-text content type. Every
// consumer of these routes wants bytes, and the conversion belongs here — at the one
// boundary — rather than in each caller.
const toBytes = async (body: unknown): Promise<Uint8Array> => {
  if (body instanceof Uint8Array) return body
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return new Uint8Array(await body.arrayBuffer())
  }
  // Not a body shape an octet-stream response can produce. Fail loudly rather than
  // handing a decoder something it will silently mis-read.
  throw new TypeError(`artifact data: expected binary body, got ${typeof body}`)
}

const generated = createApiClient<GeneratedApiClient>(ApiEndpoints)

// Export the main ApiClient — the generic framework factory instantiated with
// this app's generated `ApiEndpoints` map, with the workstore reads spliced in.
export const ApiClient: ApiClientType = {
  ...generated,
  Workstore: {
    ...generated.Workstore,
    async getArtifactData(params: { id: string; range?: string }): Promise<Uint8Array> {
      return toBytes(await generated.Workstore.getArtifactData(params))
    },
    async getArtifactDataMember(params: {
      id: string
      '*member': string
      range?: string
    }): Promise<Uint8Array> {
      return toBytes(await generated.Workstore.getArtifactDataMember(params))
    },
    // ── ITEM-17: the STREAMING siblings of the two byte routes ─────────────────────
    //
    // Siblings, not replacements: `toBytes` above still serves every caller that wants
    // the whole thing, and these add the progressive entry the reader needs. They go
    // through the SAME generated method — same auth, same base URL, same silent
    // 401-refresh, same retry-once, same `?range=` handling — and differ only in
    // asking the transport not to parse. That is what keeps INV-7 true and what stops
    // this becoming the second transport `typedRead.test.ts:610` forbids.
    //
    // `null` is a real answer (a bodyless response) and is passed through rather than
    // coerced to an empty stream: a caller that cannot proceed without bytes should
    // fail on the absence, not silently read zero of them.
    async getArtifactDataStream(params: {
      id: string
      range?: string
    }): Promise<ReadableStream<Uint8Array> | null> {
      return (await generated.Workstore.getArtifactData(params, {
        responseType: 'stream',
      })) as unknown as ReadableStream<Uint8Array> | null
    },
    async getArtifactDataMemberStream(params: {
      id: string
      '*member': string
      range?: string
    }): Promise<ReadableStream<Uint8Array> | null> {
      return (await generated.Workstore.getArtifactDataMember(params, {
        responseType: 'stream',
      })) as unknown as ReadableStream<Uint8Array> | null
    },
    async readColumn<K extends ColumnKind>(params: ReadColumnParams<K>): Promise<ColumnFor<K>> {
      return (await import('@/core/workstore/typedRead')).readColumn(params)
    },
  },
}
