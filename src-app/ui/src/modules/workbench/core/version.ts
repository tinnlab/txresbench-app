// The versioned public-API contract (ITEM-2). An extension declares an
// `apiVersion` semver RANGE; the host refuses to load it when the host version
// is excluded (§6 "API compatibility"). Kept dependency-free (no `semver` pkg):
// the workbench-api version space is small and the supported range grammar is a
// deliberately-bounded subset — caret (`^1.2`), `x`-ranges (`1.x`, `1.2.x`),
// simple comparators (`>=1.0 <2.0.0`), and an exact version. Anything outside
// the grammar is treated as INCOMPATIBLE (fail-closed), never silently accepted.

/** The current host API version. Bumping this is a code change, by definition —
 *  it is a contract artifact, NOT an admin-configurable tunable (DEC-9). */
export const WORKBENCH_API_VERSION = '1.0.0'

interface SemVer {
  major: number
  minor: number
  patch: number
}

/** Parse `X`, `X.Y`, or `X.Y.Z` (+ ignored pre-release/build) → a SemVer, or null. */
function parseVersion(v: string): SemVer | null {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/.exec(v.trim())
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2] ?? 0), patch: Number(m[3] ?? 0) }
}

function cmp(a: SemVer, b: SemVer): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

/** `1.x` / `1.2.x` / `1` / `1.2` → an inclusive [min, exclusiveMax) window. */
function xRange(token: string): { min: SemVer; max: SemVer } | null {
  const parts = token.trim().split('.')
  const isX = (p: string | undefined) => p === undefined || p === 'x' || p === 'X' || p === '*'
  const major = parts[0]
  if (isX(major)) return { min: { major: 0, minor: 0, patch: 0 }, max: { major: Infinity, minor: 0, patch: 0 } }
  const maj = Number(major)
  if (!Number.isFinite(maj)) return null
  if (isX(parts[1])) return { min: { major: maj, minor: 0, patch: 0 }, max: { major: maj + 1, minor: 0, patch: 0 } }
  const min = Number(parts[1])
  if (isX(parts[2])) return { min: { major: maj, minor: min, patch: 0 }, max: { major: maj, minor: min + 1, patch: 0 } }
  const pat = Number(parts[2])
  const exact = { major: maj, minor: min, patch: pat }
  return { min: exact, max: { major: maj, minor: min, patch: pat + 1 } }
}

/** Caret `^1.2.3`: compatible within the left-most non-zero component. */
function caretRange(token: string): { min: SemVer; max: SemVer } | null {
  const v = parseVersion(token.slice(1))
  if (!v) return null
  let max: SemVer
  if (v.major > 0) max = { major: v.major + 1, minor: 0, patch: 0 }
  else if (v.minor > 0) max = { major: 0, minor: v.minor + 1, patch: 0 }
  else max = { major: 0, minor: 0, patch: v.patch + 1 }
  return { min: v, max }
}

function satisfiesComparator(host: SemVer, token: string): boolean {
  const m = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(token.trim())
  if (!m) return false
  const op = m[1] ?? '='
  const v = parseVersion(m[2])
  if (!v) return false
  const c = cmp(host, v)
  switch (op) {
    case '>':
      return c > 0
    case '>=':
      return c >= 0
    case '<':
      return c < 0
    case '<=':
      return c <= 0
    default:
      return c === 0
  }
}

function inWindow(host: SemVer, w: { min: SemVer; max: SemVer }): boolean {
  return cmp(host, w.min) >= 0 && (w.max.major === Infinity || cmp(host, w.max) < 0)
}

/**
 * Is `range` (an extension's declared `apiVersion`) compatible with `hostVersion`
 * (defaults to `WORKBENCH_API_VERSION`)? Fail-closed: an unparseable range → false.
 * A space-separated range is an AND of its comparators (`>=1.0 <2.0.0`).
 */
export function isApiVersionCompatible(range: string, hostVersion: string = WORKBENCH_API_VERSION): boolean {
  const host = parseVersion(hostVersion)
  if (!host || !range) return false
  // Normalize `>= 1.0.0` → `>=1.0.0` so a valid npm comparator with a space after
  // the operator isn't fail-closed by the whitespace tokenizer (audit CORR-1).
  const trimmed = range.trim().replace(/([<>]=?|=)\s+/g, '$1')

  // AND-joined comparator set (e.g. ">=1.0 <2.0.0").
  if (/\s/.test(trimmed) && /[<>=]/.test(trimmed)) {
    return trimmed
      .split(/\s+/)
      .filter(Boolean)
      .every(tok => satisfiesComparator(host, tok))
  }
  if (trimmed.startsWith('^')) {
    const w = caretRange(trimmed)
    return w ? inWindow(host, w) : false
  }
  if (/^[<>=]/.test(trimmed)) {
    return satisfiesComparator(host, trimmed)
  }
  // Bare version or x-range.
  if (trimmed.includes('x') || trimmed.includes('X') || trimmed.includes('*') || /^\d+(\.\d+)?$/.test(trimmed)) {
    const w = xRange(trimmed)
    return w ? inWindow(host, w) : false
  }
  const exact = parseVersion(trimmed)
  return exact ? cmp(host, exact) === 0 : false
}
