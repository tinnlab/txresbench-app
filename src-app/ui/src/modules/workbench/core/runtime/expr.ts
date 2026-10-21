// Safe `$`-binding expression evaluator (PLAN.md ITEM-2). References ONLY —
// `$state.x`, `$params.x`, `$data.x`, `$derived.x`, `$const.x`, `$job.x`,
// `$view.x`, `$dataStatus`, `for_each`-bound vars (`$item`, `$c`, …) — plus
// `.prop` / `[index]` accessors. NO arbitrary JS eval: a string that is neither
// a clean `$`-ref nor a plain (`$`-free) literal is REJECTED (research §10 —
// the trust boundary).
//
// `$dataStatus` is a SCALAR root, not a namespace: it resolves to the region's
// own `DataStatus` (`loading` / `ready` / `empty` / `unreadable` / `error`,
// `runtime/dataStatus.ts`) straight off the store, so a view can gate on "resolved
// AND empty" rather than on the ambiguous "nothing here yet". It is a scope ENTRY
// like every other root (`DeclarativeRegion` puts it there) rather than a keyword
// this evaluator knows about — the vocabulary stays closed because the STORE owns
// the values, and there is no second spelling of them anywhere.
//
// Pure / framework-free (no React) so it's directly unit-testable.

/** The evaluation scope: namespace objects (`state`/`params`/`data`/`derived`/
 *  `const`/`job`/`view`) plus any `for_each`-bound variables, keyed by name. */
export type Scope = Record<string, unknown>

/** Sentinel for a `[*]` wildcard index (maps over a container's values). */
const WILDCARD = Symbol('wildcard')

type Accessor =
  | { kind: 'root'; name: string }
  | { kind: 'prop'; name: string }
  | { kind: 'index'; expr: string }

const ROOT_RE = /^\$([A-Za-z_][A-Za-z0-9_]*)/
const PROP_RE = /^\.([A-Za-z_][A-Za-z0-9_]*)/

/**
 * Parse a string into a clean reference path, or `null` if it is not a
 * well-formed single `$`-reference (any trailing junk / operators → `null`,
 * which the caller treats as "arbitrary code, rejected").
 */
function parseRefPath(s: string): Accessor[] | null {
  const m = ROOT_RE.exec(s)
  if (!m) return null
  let i = m[0].length
  const acc: Accessor[] = [{ kind: 'root', name: m[1] }]
  while (i < s.length) {
    const rest = s.slice(i)
    if (rest[0] === '.') {
      const pm = PROP_RE.exec(rest)
      if (!pm) return null
      acc.push({ kind: 'prop', name: pm[1] })
      i += pm[0].length
    } else if (rest[0] === '[') {
      // Match the CLOSING bracket, honoring nested `[...]` (a nested `$ref`
      // index may itself carry brackets, e.g. `filters[$obs.ident[0]]`).
      let depth = 0
      let end = -1
      for (let j = 0; j < rest.length; j++) {
        if (rest[j] === '[') depth++
        else if (rest[j] === ']') {
          depth--
          if (depth === 0) {
            end = j
            break
          }
        }
      }
      if (end === -1) return null
      acc.push({ kind: 'index', expr: rest.slice(1, end).trim() })
      i += end + 1
    } else {
      return null // trailing junk — not a clean single ref
    }
  }
  return acc
}

/** Evaluate a bracket-index token to a concrete key (or `WILDCARD`). */
function evalIndex(inner: string, scope: Scope): unknown {
  if (inner === '*') return WILDCARD
  if (/^-?\d+$/.test(inner)) return Number(inner)
  if (/^'.*'$/.test(inner) || /^".*"$/.test(inner)) return inner.slice(1, -1)
  if (inner[0] === '$') return evalExpr(inner, scope)
  return inner // bare identifier → string key
}

/** Property names that must never be walked off a `$`-ref — reading them lets an expression climb
 *  the prototype chain (`constructor` → `Function`, etc.). The write path (`store.ts`) already
 *  guards these; this closes the READ path so the eval boundary is symmetric. */
const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

/** Read one accessor step off `cur` (member/index), tolerating missing data + refusing to walk the
 *  prototype chain. */
function step(cur: unknown, key: unknown): unknown {
  if (cur == null) return undefined
  if (typeof key === 'string' && BLOCKED_KEYS.has(key)) return undefined
  return (cur as Record<string | number, unknown>)[key as string | number]
}

function resolve(acc: Accessor[], scope: Scope): unknown {
  const root = acc[0] as { kind: 'root'; name: string }
  let cur: unknown = scope[root.name]
  for (let k = 1; k < acc.length; k++) {
    const a = acc[k]
    if (a.kind === 'prop') {
      cur = step(cur, a.name)
      continue
    }
    if (a.kind !== 'index') continue
    const key = evalIndex(a.expr, scope)
    if (key === WILDCARD) {
      // Map the REMAINING accessors over every value of `cur`.
      const values = cur == null ? [] : Object.values(cur as Record<string, unknown>)
      const remaining = acc.slice(k + 1)
      if (remaining.length === 0) return values
      // Carry the OUTER scope forward (not just `{ __w: v }`) so a `$`-ref index appearing AFTER the
      // wildcard (e.g. `$foo[*].vals[$c]`) still resolves against the surrounding bindings.
      return values.map(v => resolve([{ kind: 'root', name: '__w' }, ...remaining], { ...scope, __w: v }))
    }
    cur = step(cur, key)
  }
  return cur
}

/**
 * Evaluate a binding expression against `scope`.
 * - a non-string value is a JSON literal, returned as-is;
 * - a `$`-ref string is resolved (missing intermediate → `undefined`);
 * - a `$`-free string is a plain literal, returned as-is;
 * - anything else (a `$`-containing non-ref, i.e. arbitrary code) THROWS.
 */
export function evalExpr(expr: unknown, scope: Scope): unknown {
  if (typeof expr !== 'string') return expr
  const s = expr.trim()
  if (s.length === 0) return ''
  if (s[0] !== '$') {
    if (s.includes('$')) {
      throw new Error(`unsafe expression (no arbitrary code allowed): ${expr}`)
    }
    return expr // plain literal string
  }
  const acc = parseRefPath(s)
  if (!acc) {
    throw new Error(`invalid $-reference (no arbitrary code allowed): ${expr}`)
  }
  return resolve(acc, scope)
}

/** `true` iff `s` is a well-formed single `$`-reference. */
export function isRef(s: unknown): boolean {
  return typeof s === 'string' && s.trim()[0] === '$' && parseRefPath(s.trim()) !== null
}

/** A `$`-ref token embedded in prose: `$root` + `.prop` / `[index]` accessors (single-level
 *  bracket — enough for interpolated messages; a nested bracket ref belongs in a value, not prose). */
const REF_TOKEN_RE = /\$[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*|\[[^\]]*\])*/g

/**
 * The `$state.…` / `$scope.…` dotted paths a declared expression REFERENCES.
 *
 * It exists so a consumer can ask "which authored state does this binding read?" without
 * writing a second regex for the reference syntax. It reuses this file's own
 * {@link REF_TOKEN_RE} + `parseRefPath`, which is the whole point: a rule observable only
 * through one caller's private regex is a rule the next caller re-derives slightly
 * differently, and a reference syntax that drifts between the evaluator and its readers is
 * worse than no reader at all.
 *
 * It reads the AUTHORED reference, never a value — so it is not "inferring identity from a
 * name". `$state.matrices` is what the package declared this slot reads; the path is the
 * declaration, and it is the only thing here that is consulted.
 *
 * Only the two roots a CONTROL can write are returned. `$params`/`$derived`/`$data` name
 * things no picker writes (an argument bag, a computed value, a catalog fact), so a path
 * under them can carry no user-vs-system distinction and returning it would invite a caller
 * to look one up and get a confident `undefined`.
 *
 * Finds refs both as a bare expression (`"$state.matrices"`) and embedded in prose or a
 * `{…}` segment, so the three declaration forms this repo actually ships all resolve.
 * A non-string, or a string with no `$`, yields `[]`.
 */
export function stateRefPaths(expr: unknown): string[] {
  if (typeof expr !== 'string' || !expr.includes('$')) return []
  const out: string[] = []
  for (const tok of expr.match(REF_TOKEN_RE) ?? []) {
    const acc = parseRefPath(tok)
    if (!acc) continue
    const root = acc[0]
    if (root.kind !== 'root' || (root.name !== 'state' && root.name !== 'scope')) continue
    // Stop at the first non-`prop` accessor: an `[index]` may itself hold a reference whose
    // value is not known here, and half a path is not a path. `$state.criteria[0].column`
    // therefore reports `criteria` — the field whose origin was recorded — which is the
    // right granularity, because `ViewStore.set` records the origin at the path it wrote.
    const parts: string[] = []
    for (const a of acc.slice(1)) {
      if (a.kind !== 'prop') break
      parts.push(a.name)
    }
    if (parts.length === 0) continue
    const path = parts.join('.')
    if (!out.includes(path)) out.push(path)
  }
  return out
}

/**
 * Interpolate `$`-ref tokens INSIDE a prose string (e.g. a `toast` message `"Saved $state.n cells"`).
 * Unlike {@link evalExpr} — which rejects a mixed text+`$` string as arbitrary code — this replaces
 * each ref-shaped token with its resolved value (nullish → empty) and leaves the surrounding text
 * verbatim. A `$`-free string returns unchanged.
 */
export function interpolate(template: string, scope: Scope): string {
  if (!template.includes('$')) return template
  return template.replace(REF_TOKEN_RE, tok => {
    const v = evalExpr(tok, scope)
    return v == null ? '' : String(v)
  })
}

/**
 * Interpolate `{expr}` SEGMENTS in a template against `scope` — the app's second, explicitly
 * delimited interpolation form (`"column:{$c.column}"`, `"{entry} · {source.title}"`).
 *
 * It exists beside {@link interpolate} because the two answer different needs: that one finds
 * ref-SHAPED tokens inside prose a human wrote, this one substitutes segments an author
 * DELIMITED, so the surrounding text may contain anything (a `·`, a `$`, a bare word) without
 * being scanned for accidental refs. A segment may omit the leading `$` — `{entry}` and
 * `{$entry}` are the same reference — because the braces already say "this is a reference".
 *
 * Lives HERE rather than beside its first caller because it now has two (`inputs_from`'s slot
 * names and `axis_entry_values`' column names), and one interpolation rule reimplemented per
 * caller is how two authors come to write one syntax that means two things.
 */
export function interpolateBraces(template: string, scope: Scope): string {
  return template.replace(/\{([^}]+)\}/g, (_m, inner: string) => {
    const e = inner.trim()
    const v = evalExpr(e[0] === '$' ? e : `$${e}`, scope)
    return v == null ? '' : String(v)
  })
}

// ---------------------------------------------------------------------------
// for_each expansion
// ---------------------------------------------------------------------------

/** One expansion of a `for_each` spec: the augmented scope + the cloned spec
 *  (with `for_each` stripped) for that iteration. */
export interface ForEachEntry<T> {
  index: number
  item: unknown
  scope: Scope
  spec: T
}

// `$list as $item` — or, additively, `$list as $item, $idx` to also bind the 0-based INDEX
// (Slice 4: a `for_each` row/plot needs its position for a stable coordId / a remove-by-index).
// The index group is optional, so every existing `$list as $item` clause still matches unchanged.
const FOR_EACH_RE = /^\s*(\$[^\s]+)\s+as\s+\$([A-Za-z_][A-Za-z0-9_]*)(?:\s*,\s*\$([A-Za-z_][A-Za-z0-9_]*))?\s*$/

/** Upper bound on a `for_each` list length. `for_each` composes VIEWS (a series per dataset, a
 *  widget per group) — counts are tiny; a list in the thousands is a misuse (e.g. iterating a
 *  per-cell obs column), which would spread-clone the spec per element unboundedly. Exceeding this
 *  throws (caught by the widget error boundary) rather than silently truncating or hanging. */
export const FOR_EACH_MAX = 1000

/**
 * Expand a spec carrying `for_each: "$list as $item"` into one entry per list
 * element, each with `$item` bound in a child scope. A spec WITHOUT `for_each`
 * yields a single entry (the identity — the caller renders it once). Throws on
 * a malformed `for_each` clause (never evals arbitrary code).
 */
export function expandForEach<T extends { for_each?: string }>(
  spec: T,
  scope: Scope,
): Array<ForEachEntry<T>> {
  const clause = spec.for_each
  if (!clause) return [{ index: 0, item: undefined, scope, spec }]
  const m = FOR_EACH_RE.exec(clause)
  if (!m) throw new Error(`invalid for_each clause: ${clause}`)
  const [, listExpr, itemVar, idxVar] = m
  const list = evalExpr(listExpr, scope)
  if (!Array.isArray(list)) return []
  if (list.length > FOR_EACH_MAX) {
    throw new Error(
      `for_each list too large (${list.length} > ${FOR_EACH_MAX}); for_each composes views, not per-cell data`,
    )
  }
  const { for_each: _drop, ...rest } = spec
  return list.map((item, index) => ({
    index,
    item,
    scope: { ...scope, [itemVar]: item, ...(idxVar ? { [idxVar]: index } : {}) },
    spec: { ...(rest as object) } as T,
  }))
}

/**
 * MAP-keyed `for_each` expansion (DRIFT-1.3). Like `expandForEach`, but returns
 * an object keyed by evaluating `keyExpr` in each iteration's scope (typically
 * the loop var, e.g. `"$c"` → `{ nCount: …, mito: … }`) — so a binding like
 * `$derived.ranges[$c]` resolves the entry for the current loop var. The array
 * form (`expandForEach`) stays the default; a `derived` opts into this via its
 * `key`. Throws on a malformed `for_each` clause (never evals arbitrary code).
 */
export function expandForEachKeyed<T extends { for_each?: string }>(
  spec: T,
  scope: Scope,
  keyExpr: string,
): Array<{ key: string; entry: ForEachEntry<T> }> {
  return expandForEach(spec, scope).map(entry => ({
    key: String(evalExpr(keyExpr, entry.scope)),
    entry,
  }))
}

// ---------------------------------------------------------------------------
// when gate
// ---------------------------------------------------------------------------

/** Evaluate a boolean-literal operand (`null`, `absent`, `true`/`false`, a
 *  number, a `$`-ref, or a bare-word string). */
function evalOperand(token: string, scope: Scope): unknown {
  const t = token.trim()
  if (t[0] === '$') return evalExpr(t, scope)
  if (t === 'null') return null
  if (t === 'absent') return undefined
  if (t === 'true') return true
  if (t === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  if (/^'.*'$/.test(t) || /^".*"$/.test(t)) return t.slice(1, -1)
  return t // bare word → string
}

/** A bounded `has:<capability>` clause token (DEC-12): `has:` + a capability name
 *  (`has:embedding` / `has:spatial` / `has:single-cell/expression`). The FORM is bounded (one
 *  `has:` + one token of `[A-Za-z0-9/_.-]`); the capability-NAME set is OPEN (membership in the
 *  scope's `caps`), so it never hardcodes an analysis-specific vocabulary in the app (INV-6). */
const HAS_RE = /^has:([A-Za-z0-9/_.-]+)$/

/** A general capability test over the resolved dataset (DEC-12). The host provides the current
 *  dataset's capability set as `scope.caps` — an array / `Set` / record of capability strings
 *  (e.g. `['embedding','spatial']`, derived from the resolved dataset catalog). Absent `caps`
 *  ⇒ no capabilities ⇒ every `has:` is `false` (a widget gated on a capability the host hasn't
 *  wired simply doesn't render). */
export function hasCapability(cap: string, scope: Scope): boolean {
  const caps = (scope as { caps?: unknown }).caps
  if (caps == null) return false
  if (caps instanceof Set) return caps.has(cap)
  if (Array.isArray(caps)) return caps.includes(cap)
  if (typeof caps === 'object') return Boolean((caps as Record<string, unknown>)[cap])
  return false
}

/**
 * Evaluate a `when` boolean gate. Supports ONLY: an empty/undefined clause
 * (→ `true`); a bare `$`-ref (truthiness); a `has:<capability>` capability test;
 * `<lhs> == <rhs>` / `<lhs> != <rhs>`; and `<lhs> in [a, b, c]`. No arbitrary code.
 */
/**
 * Split `s` on a top-level operator, ignoring occurrences inside quotes. Returns `undefined`
 * when the operator does not appear at the top level.
 *
 * Quote-aware because a predicate legitimately compares against a literal, and a naive split
 * would tear `'a && b'` in half.
 */
function splitTopLevel(s: string, op: '&&' | '||'): string[] | undefined {
  const parts: string[] = []
  let depth = 0
  let quote: string | null = null
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '[' || c === '(') depth++
    else if (c === ']' || c === ')') depth--
    else if (depth === 0 && s.startsWith(op, i)) {
      parts.push(s.slice(start, i))
      i += 1
      start = i + 1
    }
  }
  if (parts.length === 0) return undefined
  parts.push(s.slice(start))
  return parts.map(p => p.trim()).filter(p => p.length > 0)
}

/**
 * Strip parentheses that enclose the WHOLE expression, repeatedly.
 *
 * `splitTopLevel` tracks depth, so a fully parenthesized predicate keeps its operator at depth 1
 * and matches nothing — `($a || $b)` then fell through every branch to the bare-word arm and came
 * back TRUTHY, both operands false. That is the same silent-wrong-answer shape as the `&&` bug
 * this grammar was extended to fix: the author writes a predicate that reads correctly, and it
 * quietly means something else.
 *
 * Only a genuinely enclosing pair is stripped. `($a) || ($b)` must survive intact — its first `(`
 * does not close at the end — so the scan verifies depth stays above zero until the final char,
 * and quotes are honoured so a paren inside a string literal cannot unbalance it.
 */
function stripOuterParens(s: string): string {
  let out = s
  for (;;) {
    if (out.length < 2 || out[0] !== '(' || out[out.length - 1] !== ')') return out
    let depth = 0
    let quote: string | null = null
    let encloses = true
    for (let i = 0; i < out.length; i++) {
      const c = out[i]
      if (quote) {
        if (c === quote) quote = null
        continue
      }
      if (c === '"' || c === "'") quote = c
      else if (c === '(') depth++
      else if (c === ')') {
        depth--
        // Closed before the end ⇒ the leading `(` was not the enclosing one.
        if (depth === 0 && i < out.length - 1) {
          encloses = false
          break
        }
      }
    }
    // Unbalanced (`depth !== 0`) is malformed; leave it alone rather than mangle it further.
    if (!encloses || depth !== 0) return out
    out = out.slice(1, -1).trim()
  }
}

export function evalWhen(when: unknown, scope: Scope): boolean {
  if (when == null || when === '') return true
  if (typeof when === 'boolean') return when
  if (typeof when !== 'string') return Boolean(when)
  const s = stripOuterParens(when.trim())

  // ── COMPOUND predicates (`||` then `&&`, lowest precedence first) ──────────────────
  //
  // These were unsupported, and the failure was SILENT rather than loud: the `==` branch below
  // matched the first comparison and swallowed everything after it as a bare-word right-hand
  // side, so `a == 1 && b == 2` evaluated as `a == "1 && b == 2"` — a gate that reads correctly
  // and never fires. Three shipped views had written one, because `&&` looks like it should
  // work, and nothing told them otherwise.
  //
  // Short-circuiting, so an expression may guard its own later clauses.
  const ors = splitTopLevel(s, '||')
  if (ors) return ors.some(part => evalWhen(part, scope))
  const ands = splitTopLevel(s, '&&')
  if (ands) return ands.every(part => evalWhen(part, scope))

  // ── RELATIONAL comparison. Same story: `a.length < b.length` fell through to the bare-word
  // fallback and evaluated the whole string as one operand. Checked BEFORE `==`/`!=` on the
  // longest operator so `<=` is not read as `<`.
  const relM = /^(.+?)\s*(<=|>=|<|>)\s*(.+)$/.exec(s)
  if (relM) {
    const lhs = Number(evalOperand(relM[1], scope))
    const rhs = Number(evalOperand(relM[3], scope))
    // A non-numeric side makes the comparison meaningless; `false` is the safe answer for a
    // gate (it does not silently DISABLE a control on an unreadable predicate).
    if (Number.isNaN(lhs) || Number.isNaN(rhs)) return false
    switch (relM[2]) {
      case '<':
        return lhs < rhs
      case '>':
        return lhs > rhs
      case '<=':
        return lhs <= rhs
      default:
        return lhs >= rhs
    }
  }

  // `has:<capability>` — intercepted BEFORE the `in`/`==`/bare-word branches (else the trailing
  // bare-word fallback would treat `has:embedding` as a truthy literal string).
  const hasM = HAS_RE.exec(s)
  if (hasM) return hasCapability(hasM[1], scope)

  const inM = /^(.+?)\s+in\s+\[(.*)\]$/.exec(s)
  if (inM) {
    const lhs = evalOperand(inM[1], scope)
    const list = inM[2]
      .split(',')
      .map(x => x.trim())
      .filter(x => x.length > 0)
      .map(x => evalOperand(x, scope))
    return list.some(v => v === lhs)
  }

  const eqM = /^(.+?)\s*(==|!=)\s*(.+)$/.exec(s)
  if (eqM) {
    const lhs = evalOperand(eqM[1], scope)
    const rhs = evalOperand(eqM[3], scope)
    return eqM[2] === '==' ? lhs === rhs : lhs !== rhs
  }

  return Boolean(evalOperand(s, scope))
}
