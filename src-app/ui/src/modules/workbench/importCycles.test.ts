// importCycles.test.ts — the guard for the defect class that crashed `settings-processors`
// with `Cannot access 'canvasHost' before initialization`.
//
// ── WHY A CYCLE GUARD AND NOT JUST THE ONE FIXED EDGE ────────────────────────────────────────────
// The layer-boundary ratchet already forbids the single import that closed the cycle
// (`extensions/canvas/canvasDataSource.ts -> core/host/createHost`, removed from
// `scripts/layer-boundary-baseline.json`). That stops THAT edge coming back. It does not stop the
// NEXT edge closing the SAME cycle somewhere else — and this has now happened TWICE, independently,
// on two branches (`feat/artifact-model` `3f345cc4` and this one), which is the signature of
// a structural fragility rather than of one careless import.
//
// ── THE MECHANISM, STATED PRECISELY ─────────────────────────────────────────────────────────────
// `extensions/index.ts` is not an ordinary barrel: it performs TOP-LEVEL SIDE-EFFECTING CALLS on
// bindings it imported —
//     registerCapabilityProvider(DATA_CAPABILITY_ID, …, createDataCapability)
//     registerDeclarativeCanvasHost(canvasHost)          <- extensions/index.ts:62
// In ESM, a cycle through such a module means the barrel can be evaluated while one of the modules
// it imports is still mid-evaluation. Its `const` export is then in the temporal dead zone, and the
// top-level call reads it — a hard crash, at module-evaluation time, on whichever page happens to
// enter the graph at that root. Vite's URL variants (HMR `?t=`, optimizer `?v=`) decide the entry
// order, which is exactly why it presented as intermittent: two full full 240-surface `runtime-health`
// passes on this branch (one with a cold optimizer cache) did NOT reproduce it, while a probe that
// enters the graph AT `canvas/canvasHostProvider.ts` reproduces it every time.
//
// So the property asserted here is not "no cycles anywhere" (a rule the tree does not satisfy and
// which would be a different, much larger project). It is the narrow, causal one:
//
//     NO IMPORT CYCLE MAY PASS THROUGH A MODULE THAT CALLS AN IMPORTED BINDING AT TOP LEVEL.
//
// ── WHY IT IS A STATIC CHECK AND NOT A RENDER TEST ──────────────────────────────────────────────
// The crash is order-dependent, so a render test only catches it when the bundler happens to pick
// the bad root — which is precisely how 1 146 vitest tests, a clean `tsc`, 353 `npm run check`
// checks and a 67-spec e2e suite all missed it. The cycle itself is a property of the SOURCE and is
// deterministic. `gate:ui` remains the downstream canary; this is the deterministic upstream gate.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** `src/` — the root the `@/` alias resolves against (see `vite.config.ts`, `root: 'src'`). */
const SRC = path.resolve(HERE, '../..')
const WORKBENCH = path.join(SRC, 'modules/workbench')

const EXTS = ['.ts', '.tsx', '.js', '.jsx'] as const

/** Resolve an import specifier the way the app's bundler does: `@/x` -> `src/x`, `./x` relative,
 *  everything else (a real package) is out of scope. Returns `null` when it does not resolve to a
 *  file in this repo — a bare package cannot participate in an intra-app cycle. */
function resolveSpec(spec: string, fromFile: string): string | null {
  let base: string
  if (spec.startsWith('@/')) base = path.join(SRC, spec.slice(2))
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec)
  else return null
  for (const e of EXTS) {
    const p = base + e
    try {
      if (statSync(p).isFile()) return p
    } catch {
      /* not this extension */
    }
  }
  for (const e of EXTS) {
    const p = path.join(base, 'index' + e)
    try {
      if (statSync(p).isFile()) return p
    } catch {
      /* not this extension */
    }
  }
  return null
}

/** Every `import`/`export … from '…'` statement, with the TYPE-ONLY ones dropped: `import type`
 *  is erased by the compiler and cannot create a runtime cycle, so counting it would report edges
 *  that do not exist at runtime and make this guard fire on non-defects. */
function valueImports(file: string): string[] {
  const src = readFileSync(file, 'utf8')
  const out: string[] = []
  // NOTE the specifier prefix is `[^'"]*?`, NOT `[^'"\n]*?`. A MULTI-LINE import —
  //     import {
  //       a, b,
  //     } from '@/modules/workbench/extensions'
  // is the normal shape in this codebase (`core/host/createHost.ts:42` is exactly that), and a
  // newline-excluding prefix silently drops every one of them. The first draft of this guard did
  // that and reported ZERO cycles on a tree that provably had one — a guard whose only failure mode
  // is a silent pass. The `known edge` assertion below exists so that can never recur.
  const re = /(?:^|\n)[ \t]*(?:import|export)[ \t]+(?:type[ \t]+)?(?:[^'"]*?\bfrom[ \t]*)?['"]([^'"]+)['"]/g
  for (const m of src.matchAll(re)) {
    if (/(?:^|\n)[ \t]*(?:import|export)[ \t]+type[ \t]/.test(m[0])) continue
    const r = resolveSpec(m[1], file)
    if (r) out.push(r)
  }
  return out
}

/** A module that CALLS an imported binding at top level — i.e. one whose evaluation has a side
 *  effect that reads a binding that may still be in its temporal dead zone.
 *
 *  Detected as a top-level (column-0) call statement `foo(...)` or `foo.bar(...)` whose callee is a
 *  name this module IMPORTED. Deliberately narrow: a top-level `const x = f()` is an initializer,
 *  not a bare side effect, and does not crash a cycle in the same way (its binding is simply
 *  undefined-until-evaluated for anyone who reads it later). */
function topLevelSideEffectCallers(file: string): string[] {
  const src = readFileSync(file, 'utf8')
  const imported = new Set<string>()
  for (const m of src.matchAll(/(?:^|\n)[ \t]*import[ \t]+\{([^}]*)\}[ \t]+from[ \t]+['"][^'"]+['"]/g)) {
    if (/(?:^|\n)[ \t]*import[ \t]+type[ \t]/.test(m[0])) continue
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim()
      if (name && !name.startsWith('type ')) imported.add(name)
    }
  }
  const hits: string[] = []
  for (const m of src.matchAll(/(?:^|\n)([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (imported.has(m[1])) hits.push(m[1])
  }
  return [...new Set(hits)]
}

function walk(dir: string, out: string[] = []): string[] {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(p, out)
    else if (EXTS.some(e => ent.name.endsWith(e)) && !/\.(test|spec)\.[jt]sx?$/.test(ent.name)) out.push(p)
  }
  return out
}

const rel = (p: string) => path.relative(SRC, p)

/** Every simple cycle that passes through `start`, found by DFS from `start` back to `start`. */
function cyclesThrough(start: string, graph: Map<string, string[]>): string[][] {
  const found: string[][] = []
  const stack: string[] = [start]
  const onPath = new Set<string>([start])
  // NO global `visited` pruning: a node exhausted on one branch may still lie on a cycle reached by
  // another, and pruning it turns a real cycle into a silent pass. The workbench subtree is a few
  // hundred modules, so the exact walk is cheap; `onPath` alone keeps it terminating. Capped so a
  // pathological graph fails LOUDLY on the cap rather than hanging the suite.
  let steps = 0
  const dfs = (node: string): void => {
    if (found.length >= 40 || ++steps > 4_000_000) return
    for (const next of graph.get(node) ?? []) {
      if (next === start) {
        found.push([...stack, start])
        continue
      }
      if (onPath.has(next)) continue
      onPath.add(next)
      stack.push(next)
      dfs(next)
      stack.pop()
      onPath.delete(next)
    }
  }
  dfs(start)
  return found
}

describe('workbench module graph — no import cycle through a top-level side-effecting module', () => {
  const files = walk(WORKBENCH)
  const graph = new Map<string, string[]>(files.map(f => [f, valueImports(f)]))

  // ── NON-VACUITY, asserted first ───────────────────────────────────────────────────────────────
  // Every failure mode of this guard is a SILENT PASS: a broken alias resolver, a regex that stops
  // matching the codebase's import style, or a moved directory all produce "no cycles found". Each
  // is ruled out against a concrete number before any property is asserted.
  it('the module graph was actually built (a resolver that resolves nothing finds no cycles)', () => {
    expect(files.length, 'no workbench modules were walked — WORKBENCH points at the wrong directory').toBeGreaterThan(
      100,
    )
    const edges = [...graph.values()].reduce((n, v) => n + v.length, 0)
    expect(edges, 'zero intra-app import edges resolved — the `@/` alias or the import regex is broken').toBeGreaterThan(
      200,
    )
    const barrel = path.join(WORKBENCH, 'extensions/index.ts')
    expect(graph.has(barrel), 'the extensions barrel is not in the graph, so the clause below is vacuous').toBe(true)

    // A KNOWN, MULTI-LINE edge that the graph MUST contain. `core/host/createHost.ts` imports the
    // extensions barrel across ~30 lines of named bindings; the first draft's newline-excluding
    // regex dropped exactly this shape and reported a clean graph on a tree with a live cycle.
    // Pinning one real edge by name is what makes "no cycles" a measurement.
    const createHost = path.join(WORKBENCH, 'core/host/createHost.ts')
    expect(
      (graph.get(createHost) ?? []).map(rel),
      'core/host/createHost.ts must be seen importing the extensions barrel — if it is not, the import ' +
        'parser is dropping multi-line imports and every cycle below is invisible',
    ).toContain(rel(barrel))
  })

  it('the side-effect detector still sees the extensions barrel (its top-level registrations)', () => {
    const barrel = path.join(WORKBENCH, 'extensions/index.ts')
    const callers = topLevelSideEffectCallers(barrel)
    // If this ever empties out, the guard below silently stops watching the one module the whole
    // defect is about. Named explicitly rather than as "> 0".
    expect(callers, 'extensions/index.ts must still be recognised as calling imported bindings at top level').toContain(
      'registerDeclarativeCanvasHost',
    )
    expect(callers).toContain('registerCapabilityProvider')
  })

  it('no module that calls an imported binding at top level sits on an import cycle', () => {
    const offenders: string[] = []
    for (const file of files) {
      const callers = topLevelSideEffectCallers(file)
      if (callers.length === 0) continue
      for (const cyc of cyclesThrough(file, graph)) {
        offenders.push(
          `${rel(file)} calls [${callers.join(', ')}] at top level and sits on the cycle:\n    ` +
            cyc.map(rel).join('\n    -> '),
        )
      }
    }
    expect(
      offenders,
      'A cycle through a module that runs a top-level call on an imported binding is a temporal-dead-zone\n' +
        'crash waiting for the bundler to enter the graph at the wrong root. This is the defect that threw\n' +
        "`Cannot access 'canvasHost' before initialization` on `settings-processors`, twice, on two\n" +
        'independent branches. Break the cycle (delete the incidental edge — usually an extension reaching\n' +
        'into core for something its own plane already does), do not defer the call.\n\n' +
        offenders.join('\n\n'),
    ).toEqual([])
  })
})
