#!/usr/bin/env node
/**
 * serve-bench.mjs — the PROD bench server behind the render-perf MS leg (ITEM-19 / ITEM-20).
 *
 * `vite build --config vite.bench.config.ts` then `vite preview` on the requested port, with a
 * CONTENT-HASH cache in front so a repeated run costs a hash walk (~200 ms) instead of a full
 * production build (~40 s).
 *
 * ── The staleness bug this exists to prevent ────────────────────────────────────────────────
 * `playwright.viz.config.ts` already warns, about its own :1421 dev server, that a stale reused
 * server "would silently validate the WRONG @ziee/viz build and blind the merge gate". A prod
 * bundle is far worse: a dev server at least re-transforms on request, whereas `dist-bench/` is a
 * frozen artifact that will happily serve last week's code forever. A perf gate reading a stale
 * bundle does not fail — it REPORTS THE OLD NUMBERS, which is indistinguishable from "the fix
 * worked" and is the single most dangerous false green available to this feature.
 *
 * So the hash is written to `dist-bench/.buildinfo` and the spec (TEST-23) recomputes it from the
 * working tree and refuses to measure on a mismatch. The cache is an optimization; the buildinfo
 * is a CONTRACT.
 *
 * Usage:
 *   node scripts/serve-bench.mjs --port 1422      # build-if-stale, then preview (blocks)
 *   node scripts/serve-bench.mjs --build-only     # build-if-stale and exit (CI warm-up)
 *   node scripts/serve-bench.mjs --print-hash     # print the expected hash and exit
 *   node scripts/serve-bench.mjs --force          # rebuild even if the hash matches
 */
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.resolve(HERE, '..')
const OUT = path.join(PKG, 'dist-bench')
const BUILDINFO = path.join(OUT, '.buildinfo')

/** Everything whose change must invalidate the bundle. `src/**` is the code; the HTML entry and
 *  BOTH vite configs are build inputs whose change alters the output without touching src.
 *
 *  `package.json` is here because its `sideEffects` field is a ROLLUP TREE-SHAKING DIRECTIVE, not
 *  metadata: it decides whether module-load side effects (`installBuiltins()` in GridWorkspace, the
 *  81 self-registering `showcase/stories/*.story.tsx`, immer's `enablePatches()`) survive the prod
 *  build. With the field mis-set the bundle built CLEAN and SERVED 200 — it just contained no
 *  stories and no deck.gl, so the showcase rendered "No stories registered." with zero console
 *  errors. Omitting the file from the hash meant flipping that one field did not invalidate the
 *  cache, i.e. the freshness CONTRACT had a hole exactly where the bundle's contents are decided. */
const INPUTS = ['src', 'viz-showcase.html', 'vite.config.ts', 'vite.bench.config.ts', 'package.json']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-bench', '.vite'])

/** Content hash over the build inputs — content, not mtimes, so a `git checkout` that restores
 *  identical bytes does NOT force a rebuild and a same-mtime edit does NOT get missed. */
export function computeBuildHash(root = PKG) {
  const h = createHash('sha256')
  const walk = abs => {
    const st = statSync(abs)
    if (st.isDirectory()) {
      for (const name of readdirSync(abs).sort()) {
        if (SKIP_DIRS.has(name) || name.startsWith('.')) continue
        walk(path.join(abs, name))
      }
    } else {
      h.update(path.relative(root, abs))
      h.update('\0')
      h.update(readFileSync(abs))
      h.update('\0')
    }
  }
  for (const rel of INPUTS) {
    const abs = path.join(root, rel)
    if (existsSync(abs)) walk(abs)
  }
  return h.digest('hex').slice(0, 16)
}

function readBuildInfo() {
  if (!existsSync(BUILDINFO)) return null
  try {
    return JSON.parse(readFileSync(BUILDINFO, 'utf8'))
  } catch {
    return null
  }
}

function buildIfStale({ force = false } = {}) {
  const want = computeBuildHash()
  const have = readBuildInfo()
  const indexPresent = existsSync(path.join(OUT, 'viz-showcase.html'))
  if (!force && have?.buildHash === want && indexPresent) {
    console.log(`[serve-bench] cache HIT (${want}) — no rebuild`)
    return { hash: want, rebuilt: false }
  }
  console.log(
    `[serve-bench] cache MISS (have=${have?.buildHash ?? 'none'} want=${want}${indexPresent ? '' : ', no index'}) — building…`,
  )
  const r = spawnSync('npx', ['vite', 'build', '--config', 'vite.bench.config.ts'], {
    cwd: PKG,
    stdio: 'inherit',
  })
  if (r.status !== 0) {
    console.error('[serve-bench] prod bench build FAILED — refusing to serve a stale bundle')
    process.exit(r.status ?? 1)
  }
  mkdirSync(OUT, { recursive: true })
  // Recompute AFTER the build: if a build step rewrote an input (it should not), the recorded hash
  // must describe the tree the bundle was actually produced from, not the one we started with.
  const actual = computeBuildHash()
  writeFileSync(BUILDINFO, JSON.stringify({ buildHash: actual, builtAt: new Date().toISOString() }, null, 2))
  return { hash: actual, rebuilt: true }
}

/**
 * Tear a spawned preview down BY PROCESS GROUP, and wait for it (FIX_ROUND-2 / B5).
 *
 * The shipped handler was `child.kill(sig); process.exit(0)` in the same tick, and `child` is the
 * `npx` WRAPPER, not `vite`. Two holes, both leaving exactly the orphan the comment says it closes:
 *   * signalling `npx` does not signal the `vite preview` GRANDCHILD, which keeps :1422 bound;
 *   * `process.exit(0)` in the same tick abandons the tree before any of it has died.
 * And a leaked preview IS reachable — `reuseExistingServer: !process.env.CI` means the next local
 * run adopts it, which is the frozen-artifact false green (`REPORTS THE OLD NUMBERS`) this whole
 * file exists to prevent.
 *
 * TWO changes, and the SECOND ONE IS THE INTERESTING ONE:
 *   1. `vite` is spawned DIRECTLY (the local `node_modules/.bin/vite`), not through `npx`. There is
 *      then no wrapper between this process and the server, so `child.kill(sig)` reaches the thing
 *      holding the port. That is the whole of the original defect, removed rather than worked around.
 *   2. The parent WAITS for the child to exit before exiting itself, with a SIGKILL escalation so a
 *      wedged preview cannot hold the run open forever.
 *
 * WHAT WAS TRIED FIRST AND IS WRONG — recorded because it is a trap, and because it BIT: spawning
 * `detached: true` and signalling the process GROUP (`process.kill(-pid, sig)`). It reaps the
 * grandchild in isolation, and it made things WORSE under the real runner. Playwright starts a
 * `webServer` detached and tears it down by killing ITS process group; a `detached` grandchild is in
 * a NEW group, so Playwright's own group kill no longer reaches it. Measured: an ms-leg run left
 * `npm exec vite preview` orphaned on :1422 with `ppid=1` while Playwright hung waiting for it. The
 * safety net that had been masking the original bug was removed by the fix for it. So: same group,
 * no wrapper.
 *
 * `killGroup` is the fallback for a child that ignores a direct signal.
 *
 * NO INJECTION SEAMS (DEC-45). `exit`, `killGroup` and `graceMs` were `opts` overrides that existed
 * for exactly one consumer — the deleted `serveBench.test.ts` process-group guard — and for nothing
 * in production. They are plain internals again. The property they were there to approximate is now
 * asserted end-to-end, on the real server, by TEST-F6 in `render-perf-ms.spec.ts`.
 */
function installChildReaper(child) {
  const exit = code => process.exit(code)
  const killGroup = (pid, sig) => {
    try {
      child.kill(sig)
    } catch {
      /* already dead */
    }
    // Belt and braces for a child that spawned its own tree and ignores a direct signal. Only
    // meaningful when the child leads its own group; a no-op (EPERM/ESRCH) otherwise, and never a
    // reason to fail the teardown.
    try {
      process.kill(-pid, sig)
    } catch {
      /* not a group leader, or already gone */
    }
  }
  const graceMs = 5_000
  let tearingDown = false
  const bye = sig => () => {
    if (tearingDown) return
    tearingDown = true
    killGroup(child.pid, sig)
    // Escalate rather than exiting immediately: exiting here is what abandoned the tree.
    const hard = setTimeout(() => {
      killGroup(child.pid, 'SIGKILL')
      exit(0)
    }, graceMs)
    hard.unref?.()
    child.once('exit', () => {
      clearTimeout(hard)
      exit(0)
    })
  }
  process.on('SIGINT', bye('SIGINT'))
  process.on('SIGTERM', bye('SIGTERM'))
  child.on('exit', code => {
    if (!tearingDown) exit(code ?? 0)
  })
  return bye
}

/** Where the local `vite` binary lives, if the install is complete. */
const VITE_BIN = path.resolve(PKG, '../../../node_modules/.bin/vite')

/**
 * The preview invocation — program + argv — as a PURE value (FIX_ROUND-4 / R4-3).
 *
 * Split out from the spawn so the argv contract is testable without starting anything, and so the
 * "no wrapper" property can be asserted UNCONDITIONALLY. `npx vite …` inserts a wrapper process
 * between this one and the server, and signalling the wrapper is what orphaned the preview; the
 * local binary is therefore the intended path and the `npx` form is a degraded fallback for an
 * incomplete install, not an equal alternative.
 */
function previewArgv(port) {
  const useNpx = !existsSync(VITE_BIN)
  return {
    program: useNpx ? 'npx' : VITE_BIN,
    args: [
      ...(useNpx ? ['vite'] : []),
      'preview',
      '--config',
      'vite.bench.config.ts',
      '--port',
      String(port),
      '--strictPort',
    ],
    useNpx,
  }
}

/**
 * Spawn the `vite preview` that serves `dist-bench`, and — the property this function exists to make
 * TESTABLE (FIX_ROUND-3 / R3-2) — leave it in THIS process's process group.
 *
 * The B5 fix went through two forms, and the discarded one is a live regression risk precisely
 * because it PASSES the B5 test. That test's stand-in child is itself `detached: true`, and
 * `killGroup` signals the child directly AND its group, so a shipped `detached: true` reaps the
 * stand-in's grandchild just as well — the test cannot tell the two configurations apart. What the
 * detached form broke is something a stand-in cannot see: Playwright starts a `webServer` detached
 * and tears it down by killing ITS process group, so a `detached` preview lands in a NEW group that
 * Playwright's own kill no longer reaches. Measured at the time: `npm exec vite preview` left on
 * :1422 with `ppid=1` while Playwright hung waiting for it.
 *
 * ── NO INJECTION SEAM AT ALL (DEC-45 / FIX_ROUND-6) ─────────────────────────────────────────────
 * This function used to take an `opts` bag so a unit test could substitute part of the spawn. Three
 * consecutive fix-loop rounds then found three DIFFERENT spellings of the same defect — the guard's
 * subject was the INJECTED call, never the production one. `opts.spawn` first (a one-line edit
 * re-armed the regression with every clause green), then `opts.args`, then `opts.program` with the
 * cwd unobserved. Round 4 literally re-introduced the B5 root cause it was fixing.
 *
 * The lesson, and the reason there is no seam here now: "the process serving :1422 is reachable by
 * Playwright's own group kill" is an END-TO-END property. A unit stand-in cannot see the runner's
 * teardown contract, so every unit approximation of it is a shape predicate over a semantic
 * property — unbounded evasion space, 0 findings unreachable by construction. It is asserted where
 * it actually lives instead: TEST-F6 in `src-app/ui/tests/viz-e2e/render-perf-ms.spec.ts` reads the
 * REAL listener on :1422 and checks its process group against the harness's, on the real run that
 * the real Playwright teardown will act on. That is also how the defect was caught, twice, in
 * practice: an ms-leg run leaving `vite preview` at `ppid=1`.
 *
 * So: exactly ONE `spawn`, production's argv, production's options object, nothing substitutable.
 */
function spawnPreview(port) {
  const { program, args } = previewArgv(port)
  return spawn(program, args, { cwd: PKG, stdio: 'inherit' })
}

/** True when this module is being RUN, not imported. Without it, importing `computeBuildHash` (which
 *  this file exports, and which had no importer at all — the adjacent half of C21) would kick off a
 *  production build as a side effect of the import. */
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  const argv = process.argv.slice(2)
  const flag = name => argv.includes(`--${name}`)
  const value = (name, dflt) => {
    const i = argv.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`))
    if (i === -1) return dflt
    const a = argv[i]
    return a.includes('=') ? a.split('=').slice(1).join('=') : (argv[i + 1] ?? dflt)
  }

  if (flag('print-hash')) {
    console.log(computeBuildHash())
    process.exit(0)
  }

  buildIfStale({ force: flag('force') })

  if (!flag('build-only')) {
    const port = String(value('port', '1422'))
    console.log(`[serve-bench] previewing dist-bench on :${port}`)
    installChildReaper(spawnPreview(port))
  } else {
    process.exit(0)
  }
}
