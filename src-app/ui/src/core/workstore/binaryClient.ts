// Workstore data-plane transport — the ONE path every artifact byte travels
// (P1 · ITEM-11, routed through the generated client by artifact-model ITEM-29/30).
//
// ── WHAT CHANGED, AND WHY IT MATTERS ───────────────────────────────────────────────
//
// This module used to hand-roll its own transport: `getBaseUrl()` + `getAuthToken()` +
// a raw `fetch` with a `Range:` header. So did `zarrReader.ts`. Two hand-rolled copies
// of "attach the bearer token, resolve the base URL, ask for these bytes" — a direct
// violation of the "call the generated ApiClient method, never a raw fetch" rule, and
// two places for an auth/base-URL/refresh behaviour to drift apart from the rest of the
// app (the silent 401-refresh + retry-once in `callAsync` reached NEITHER copy, so an
// access token that expired mid-read failed the read instead of rotating).
//
// ITEM-30 declared `GET /artifacts/{id}/data[/{*member}]` in OpenAPI as
// `application/octet-stream`, which produced `Workstore.getArtifactData` /
// `Workstore.getArtifactDataMember` in the generated client. This module now calls
// those and holds NO transport of its own — auth, base URL, the 401-refresh, the
// transient-failure retry and the `?range=` query param are all applied by that one
// path. No module under `core/workstore/` reaches for those three primitives in CODE any
// more; TEST-41 scans the comment-stripped source of every module here for exactly that.
//
// ── `?range=` IS A QUERY PARAM, NOT A HEADER (ITEM-36) ─────────────────────────────
//
// The URL is the cache key. A `Range:` header yields a `206`, which browsers cache
// inconsistently and most CDNs refuse to store; `?range=` makes every chunk an ordinary
// cacheable `GET` answered `200` with `Cache-Control: private, max-age=31536000,
// immutable`. Two spellings, both server-validated: `a-b` (inclusive) and `-n` (the
// suffix form — the last `n` bytes, which is how a shard index is located in ONE
// request with no `Content-Length` probe). A malformed range is a `400` and an
// out-of-bounds one a `416`; neither degrades to serving the whole blob.

import { ApiClient } from '@/api-client'

/**
 * An HTTP error from a workstore data-plane request.
 *
 * ── WHY `errorCode` IS HERE (ITEM-41) ──────────────────────────────────────────────
 *
 * The server refuses an unusable artifact with **409 + a machine-readable code**, and it
 * uses TWO codes on purpose because they carry OPPOSITE remedies:
 *
 * - `ARTIFACT_NOT_CONFORMING` — the bytes disagree with the declared `structure`. The
 *   DATA is wrong; the fix is to delete the artifact or re-run its producer.
 * - `ARTIFACT_UNRESOLVABLE` — the artifact's own declaration is intact and its SOURCES
 *   are gone or changed. Nothing about it is wrong; the fix is to restore the source,
 *   and deleting it would destroy work that is fine.
 *
 * `callAsync` already stamps `error_code` onto the error it throws (framework
 * `api-client/core.ts:744-756`, which says in as many words that it exists "so a caller's
 * `catch` can branch on either without parsing the message"). This module's
 * {@link asHttpError} used to drop it, so both refusals arrived here as one
 * indistinguishable `409` — which made "read the code, don't parse prose" impossible on
 * the one surface that has to tell a user which remedy applies. Preserving it is the
 * prerequisite for that, not a convenience.
 *
 * `errorCode` is `undefined` for a network-level failure and for any response whose body
 * carried no code. Absence means UNKNOWN — never treat it as either refusal.
 */
export class WorkstoreHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly errorCode?: string,
    /**
     * The SERVER's own sentence, unwrapped — without this module's `workstore <what> → `
     * prefix (ITEM-41 / INV-9).
     *
     * It exists because the server's refusal sentence is USER-FACING PROSE, not a stack
     * trace: for an unresolvable artifact it NAMES the missing source and states the remedy
     * ("restore or re-attach that source", "deleting it is not the fix"). A surface that
     * needs to show that name has exactly two options — this field, or a regex over
     * `message` to strip the prefix. The second is parsing prose to recover a fact, which is
     * the thing `errorCode` was plumbed through to stop, one layer down.
     *
     * `undefined` for a network failure, where there is no server sentence to carry.
     */
    public readonly serverMessage?: string,
  ) {
    super(message)
    this.name = 'WorkstoreHttpError'
  }
}

/** The server's code for an artifact whose BYTES were condemned by the conformance gate
 *  (`workstore/consume.rs::ERR_NOT_CONFORMING`). Remedy: delete or re-run the producer. */
export const ERR_NOT_CONFORMING = 'ARTIFACT_NOT_CONFORMING'

/** The server's code for a GATHERED artifact whose alignment can no longer be resolved
 *  (`workstore/consume.rs::ERR_UNRESOLVABLE`). The artifact is INTACT — remedy: restore
 *  the missing source. Never offer to delete on this one. */
export const ERR_UNRESOLVABLE = 'ARTIFACT_UNRESOLVABLE'

/** Is this the server refusing to serve an artifact that cannot currently be read?
 *
 *  True for exactly the two 409 refusals above. Deliberately NOT "any 409" and NOT "any
 *  error": a 404 chunk is an unwritten chunk (`fill_value`), and a 5xx is a transient the
 *  caller may retry. */
export function isUnreadableArtifactError(error: unknown): error is WorkstoreHttpError {
  return (
    error instanceof WorkstoreHttpError &&
    (error.errorCode === ERR_NOT_CONFORMING || error.errorCode === ERR_UNRESOLVABLE)
  )
}

/** A decoded sparse column: parallel row-index + value typed arrays (zero-copy). */
export interface SparseColumn {
  row: Uint32Array
  value: Float32Array
}

/** A byte range for `fetchArtifactRange` (inclusive `[start, end]`). */
export interface ByteRange {
  start: number
  end: number
}

/** The `?range=` value for an inclusive `[start, end]` window. */
export function byteRangeParam(range: ByteRange): string {
  return `${range.start}-${range.end}`
}

/** The `?range=` value for the LAST `length` bytes (the suffix form). */
export function suffixRangeParam(length: number): string {
  return `-${length}`
}

/** The transport's status code, when it carried one. `callAsync` stamps `status` onto
 *  the error it throws for every non-2xx response; a network-level failure has none. */
function statusOf(error: unknown): number {
  const status = (error as { status?: unknown } | null)?.status
  return typeof status === 'number' ? status : 0
}

/** The transport's machine-readable error code, when it carried one. `callAsync` stamps
 *  `error_code` from the response body; a network failure and a body without one both
 *  yield `undefined`, which means UNKNOWN rather than "no refusal". */
function errorCodeOf(error: unknown): string | undefined {
  const code = (error as { error_code?: unknown } | null)?.error_code
  return typeof code === 'string' && code.length > 0 ? code : undefined
}

function describe(id: string, memberPath?: string, range?: string): string {
  return `${id}${memberPath ? `/${memberPath}` : ''}${range ? `?range=${range}` : ''}`
}

/** Normalize any transport failure to this module's error type, PRESERVING the status AND
 *  the machine-readable `error_code` (ITEM-41).
 *
 *  The status must survive because the reader distinguishes 404 (an unwritten chunk ⇒
 *  `fill_value`) from everything else, and collapsing it would turn a missing chunk into a
 *  hard failure. The CODE must survive for the same class of reason one level up: the two
 *  409 refusals share a status and differ only in their code, so dropping it collapses
 *  "your data is wrong" and "the source this was built from is gone" into one message a
 *  surface can then only tell apart by regexing prose. */
function asHttpError(error: unknown, what: string): WorkstoreHttpError {
  if (error instanceof WorkstoreHttpError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new WorkstoreHttpError(statusOf(error), `workstore ${what} → ${message}`, errorCodeOf(error), message)
}

/**
 * Artifact bytes, through the generated `ApiClient` method.
 *
 * `memberPath` empty/absent ⇒ the whole single-file artifact; otherwise the member path
 * through the merkle manifest (INV-4) — a Zarr chunk key, a `zarr.json`, a `.bai`.
 * `range` is a `?range=` value (`byteRangeParam` / `suffixRangeParam`), absent ⇒ whole
 * member.
 */
export async function fetchArtifactBytes(
  id: string,
  memberPath?: string,
  range?: string,
): Promise<Uint8Array> {
  try {
    return memberPath
      ? await ApiClient.Workstore.getArtifactDataMember({ id, '*member': memberPath, range })
      : await ApiClient.Workstore.getArtifactData({ id, range })
  } catch (error) {
    throw asHttpError(error, describe(id, memberPath, range))
  }
}

/**
 * As {@link fetchArtifactBytes}, but the body is NOT buffered: it resolves at HEADERS to
 * the raw `ReadableStream`, so a decoder can work on a prefix while the rest arrives
 * (ITEM-17).
 *
 * Same transport, deliberately — the same generated method, hence the same auth, base
 * URL, silent 401-refresh, retry-once and `?range=` handling. This module still holds NO
 * transport of its own, which is the property `typedRead.test.ts:610` scans for; the
 * streaming read is a new OPTION on the one path, never a second path.
 *
 * `null` means the response carried no body, and is returned as such. Coercing it to an
 * empty stream would let a caller read zero bytes and conclude the member is empty —
 * the same absence-reads-as-data confusion `fetchArtifactBytesOrNull` exists to prevent
 * on the 404 path.
 */
export async function fetchArtifactStream(
  id: string,
  memberPath?: string,
  range?: string,
): Promise<ReadableStream<Uint8Array> | null> {
  try {
    return memberPath
      ? await ApiClient.Workstore.getArtifactDataMemberStream({ id, '*member': memberPath, range })
      : await ApiClient.Workstore.getArtifactDataStream({ id, range })
  } catch (error) {
    throw asHttpError(error, describe(id, memberPath, range))
  }
}

/**
 * As `fetchArtifactBytes`, but `404 ⇒ null`.
 *
 * Absence is a legitimate ANSWER on exactly one path: an unsharded array stores one file
 * per chunk and writes nothing for a chunk that is entirely `fill_value`, so "no such
 * member" means "that chunk is the fill", not "the read failed". Every other status still
 * throws — a 403 must never silently read as an empty array.
 */
export async function fetchArtifactBytesOrNull(
  id: string,
  memberPath?: string,
  range?: string,
): Promise<Uint8Array | null> {
  try {
    return await fetchArtifactBytes(id, memberPath, range)
  } catch (error) {
    if (error instanceof WorkstoreHttpError && error.status === 404) return null
    throw error
  }
}

/**
 * Range-read an artifact's bytes (or a named member inside a multi-file artifact) as a
 * raw `ArrayBuffer`, for a client-side decoder — the in-tree one is `zarrReader.ts`
 * (zero dependencies; ITEM-24 dropped `zarrita`), and an external viewer consumes the
 * same shape.
 *
 * The buffer is exact: a view that does not span its whole backing buffer is copied, so
 * a caller taking `new Float32Array(buf)` sees the requested bytes and nothing else.
 */
export async function fetchArtifactRange(
  id: string,
  memberPath?: string,
  range?: ByteRange,
): Promise<ArrayBuffer> {
  const bytes = await fetchArtifactBytes(id, memberPath, range && byteRangeParam(range))
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer
  }
  return bytes.slice().buffer as ArrayBuffer
}
