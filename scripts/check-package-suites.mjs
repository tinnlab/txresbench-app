#!/usr/bin/env node
/**
 * PACKAGE-SUITE GATE — every workspace package's own test suite has a runner,
 * BY CONSTRUCTION.
 *
 * ── The bug this exists to stop ────────────────────────────────────────────────
 * `just check` runs `cd src-app/ui && npm run check`, whose vitest is ROOTED AT
 * `src-app/ui`. The sibling workspace packages each ship their own `vitest run`, and
 * NO repo-wired runner invoked any of them — not the justfile, not `npm run check`,
 * not CI. Measured at the time this gate was written: `@ziee/viz` = 207 files / 2555
 * tests, `@ziee/dock` = 4 files / 84 tests. 2639 tests under no runner.
 *
 * That is not hypothetical. A merge changed `libs/viz/src/adapter/VizController.ts`
 * (+230/-5) and broke `VizController.events.test.ts`; the merge-gate, the pre-push hook
 * and `just check` all passed it through to `main`, because nothing ran that suite. It
 * was found only by a human reading the tree.
 *
 * Same class as `check-py` (the processors' pytest suites, justfile:33-38), as R3-99
 * (`workbench-api`'s 277 uninvoked tests), and as the e2e routing hole
 * (`src-app/ui/scripts/check-e2e-routing.mjs`) — "a guard nobody invokes is not a
 * guard". This one closes it for the workspace packages, and closes it by DERIVING the
 * package set instead of naming it: a hand-list is the failure mode, not the fix.
 *
 * ── What is checked (all fail-closed, all with positive counts) ────────────────
 *  P1 DERIVED   the package set is expanded from the ROOT `package.json`'s
 *               `workspaces` globs — the same declaration npm itself resolves — never
 *               hand-listed. A new directory under `src-app/libs/` therefore joins
 *               the gate with no edit here. A workspace pattern this expander does not
 *               understand is a HARD FAILURE, not a silent drop.
 *  P2 SCOPED    every resolved workspace is either IN SCOPE or excluded by ONE named,
 *               printed rule (see SCOPE RULES). There is no third, quiet outcome.
 *  P3 COVERED   an in-scope package that has test FILES on disk but no `test` script
 *               is a HARD FAILURE, naming the files. This is the literal bug class:
 *               tests that exist and nothing runs. A package with neither is skipped
 *               LOUDLY (named in the table) — see "the no-test-script decision".
 *  P4 FLOOR     `MIN_GATED_PACKAGES` is a committed constant. If the derived set
 *               collapses below it (a rename, a moved directory, a broken glob) the
 *               gate FAILS instead of congratulating itself on an empty run — the
 *               ITEM-37 fail-closed property, cf. `ui/scripts/guard-floors.test.mjs`.
 *  P5 RUN ALL   every gated package is executed to completion — a failing package does
 *               NOT mask the ones after it — and a per-package exit table is printed.
 *               Any non-zero exit fails the gate, naming the package. (Same shape as
 *               `just e2e-all`.)
 *  P6 TYPED     the same thing, one property over: every in-scope package's own
 *               `typecheck` script is RUN, and an in-scope FIRST-PARTY package that
 *               declares a TypeScript project (`tsconfig.json` on disk) with NO
 *               `typecheck` script is a HARD FAILURE naming it. See "the typecheck half"
 *               below — it is the literal bug this rule was added for (#276).
 *
 * ── SCOPE RULES (the only two exclusions; both are derived, not typed out) ──────
 *  - SUBMODULE **NOT IN PLAY**: workspaces under a path declared in `.gitmodules`
 *    (today: `sdk/**`), while this branch leaves that submodule alone. A submodule is
 *    a PIN to another repository — CytoAnalyst cannot fix a failure there, and gating
 *    this repo's `just check` on another repo's suite makes every unrelated change
 *    here hostage to it. Read from `.gitmodules`, so adding a submodule needs no edit
 *    here.
 *    >> BUT THE EXCLUSION IS CONDITIONAL NOW (S2, below). <<
 *  - ALREADY_GATED: `src-app/ui`, because `just check` already runs
 *    `cd src-app/ui && npm run check`, whose chain BEGINS in `tsc --noEmit` and ENDS in
 *    `npm run test:unit`. That exclusion is not taken on trust:
 *    `assertAlreadyGatedIsReallyGated()` below reads the justfile and ui/package.json and
 *    FAILS if any of those three links disappears. An exclusion that stops being true
 *    stops being honored — and since P6 now leans on the `tsc` half of that chain, the
 *    proof had to grow with the claim rather than after it.
 *
 * ── S1/S2/S3: the submodule exclusion, and the hole it left ───────────────────
 * The blanket `sdk/**` exclusion had a measured cost. `@ziee/kit` — the component
 * kit EVERY cytoanalyst surface renders through — ships 6 files / 44 tests that ran
 * under NO cytoanalyst gate. Two mutations introduced in cytoanalyst work survived
 * the entire app suite and were caught only by running the kit suite by hand, and
 * three user-facing kit defects shipped through the hole in a single day
 * (MultiSelect unopenable when a value was bound; Input remounting on the first
 * keystroke; Tabs `fill` clipping its content). The exclusion's justification is
 * "not this repo's change to make" — which stops being true the moment this branch
 * touches the submodule.
 *
 *  S1 PRESENT     every path in `.gitmodules` that the root `workspaces` globs point
 *                 INSIDE must exist AND be initialised — i.e. be its OWN git
 *                 repository. An uninitialised submodule makes its workspace globs
 *                 expand to NOTHING, so the gate passed while silently covering less —
 *                 the fail-closed rule this file already applies everywhere else (P4).
 *                 Now it says so and FAILS.
 *                 The test is `rev-parse --show-toplevel == dir`, NOT `rev-parse HEAD`:
 *                 git walks UP out of an empty directory and answers with the PARENT
 *                 repository, so the old check inspected a repository it was not asked
 *                 about and reported green. See `isOwnRepo()`.
 *                 A submodule NO workspace glob reaches (`agent-kit` — docs + skills,
 *                 no npm packages) is reported but NOT fatal: an uninitialised one
 *                 costs this gate nothing, and failing on it would only teach people
 *                 to work around the gate.
 *  S2 IN PLAY     a submodule is IN PLAY when this branch is changing it: its working
 *                 tree is DIRTY, or its recorded pointer MOVED vs the base
 *                 (`merge-base(BASE, HEAD)..HEAD`, plus an uncommitted gitlink
 *                 change). While in play, its packages that HAVE a `test` script are
 *                 GATED like any other workspace — a submodule edit is this branch's
 *                 change and this branch's responsibility. `PACKAGE_SUITES_BASE`
 *                 overrides the base (default `origin/main`); an unresolvable base
 *                 counts as IN PLAY rather than silently skipping.
 *  S3 UPSTREAM GAP  an in-play submodule package with test FILES but no `test` script
 *                 is reported LOUDLY on every run but is NOT the P3 hard failure it
 *                 would be for a first-party package: the remedy (adding a runner)
 *                 lives in the other repository, and failing here would only teach
 *                 people to bypass the gate. Naming it every run is the honest
 *                 middle: measured today, `@ziee/framework` (8 test files) and
 *                 `@ziee/gallery` (7) have suites with no runner in the SDK repo.
 *
 * ── P6 — the TYPECHECK half (#276), and why it is here and not in `ui`'s check chain ──
 * `src-app/libs/viz` declares `"typecheck": "tsc --noEmit"` and NOTHING invoked it. On
 * `origin/main` it exited 2 with FIVE errors, four of them in `*.test.ts(x)` files, and
 * it had been red for an unknown length of time. The reason is the same one that made
 * this file necessary: `src-app/ui`'s `npm run check` runs `tsc` over the UI project, so
 * it reaches `@ziee/viz` only through the modules `ui` imports — a subset of viz's `src/`
 * and NONE of its test files. vitest transpiles without typechecking, so the suites were
 * green while `omeTiffFallback.test.tsx` imported two names `../grid/gridModel` does not
 * export. A type-level API break was invisible to every gate in the repo.
 *
 * That is this file's own failure class ("a guard nobody invokes is not a guard"), so the
 * repair is this file's own shape rather than a second mechanism: P6 rides the package set
 * P1 already DERIVES from the root `workspaces` globs. Adding viz's `typecheck` to `ui`'s
 * `check` chain — the other obvious repair — would have been the ENUMERATING one: it fixes
 * viz and leaves `@ziee/dock`'s `typecheck` (which also exists, and was also run by
 * nothing) plus every future package to be hand-added again. `docs/design/derived-guards.md`
 * §2/§5 is explicit that a hand-list is the failure mode and not the fix.
 *
 * WHERE THE FLOOR IS. P4's constant floor guards the DERIVATION this rule rides on, so a
 * rename/move that collapses the package set still fails there. A second constant here
 * would be a statement about THIS tree only, and this script is deliberately runnable
 * against a synthetic one — that is how its own negative controls work — so the committed
 * typecheck floor lives beside them in `scripts/check-package-suites.test.mjs`, asserted
 * against the real tree where the number is true. P6's hard failure is what fails closed
 * everywhere else: a TS project cannot quietly stop being typechecked.
 *
 * DUPLICATE WORK, ACCEPTED. `@ziee/framework`, `@ziee/gallery` and `@ziee/kit` already
 * chain `npm run typecheck` inside their own `test` script, so when `sdk` is IN PLAY their
 * typecheck runs twice (a few seconds). Deduping would mean PARSING another package's
 * `test` script and inferring the typecheck is "already covered" — an unverifiable
 * exemption that goes silently wrong the moment that script is reworded, which is exactly
 * what `assertAlreadyGatedIsReallyGated()` exists to refuse. Pay the seconds.
 *
 * ── The no-test-script decision (stated, because silence is how this hole opened) ──
 * A package with NO `test` script and NO test files on disk is SKIPPED and NAMED in
 * the output table as `(no tests on disk)`. It is not a hard failure, because a
 * genuinely test-free package (types-only, a re-export barrel) would otherwise be
 * pushed toward `"test": "exit 0"` — an INVISIBLE skip, strictly worse than a printed
 * one. The ratchet that makes the loud skip safe is P3: the moment such a package
 * grows a test file, the gate fails until it grows a runner. So "no tests" can never
 * quietly become "tests nobody runs", which is the only failure that matters here.
 *
 * ── What is NOT checked (stated so it is not mistaken for covered) ────────────
 * That a package's `typecheck` script HONESTLY typechecks: `"typecheck": "echo ok"`
 * satisfies P6 and reproduces exactly the invisible skip the rule exists to close. This is
 * the same accepted limit `"test": "exit 0"` has against P3, and it is accepted for the same
 * reason — the gate's subject is "the package has a runner", and a gate that tried to judge
 * whether a runner is honest would be guessing. What P6 removes is "TypeScript that NOTHING
 * even claims to check"; a lying script is a reviewable line in a package.json diff.
 *
 * That a package's `test` script COLLECTS every test file in that package. A file
 * excluded by the package's own vitest `include`/`exclude` is invisible here — this
 * gate closes "the package has no runner", not "the runner's globs are complete". The
 * per-package analogue of that is `ui/scripts/node-test-files.mjs` (one criterion,
 * shared by the includer and the excluder), and it belongs inside each package.
 * Likewise `@ziee/viz`'s 20 `tests/e2e/*.e2e.mjs` browser specs are NOT run here —
 * they need a booted showcase and have their own recipe, `just e2e-viz-package`.
 *
 * Usage:
 *   node scripts/check-package-suites.mjs            # gate: enumerate + RUN (typecheck + test), non-zero on any failure
 *   node scripts/check-package-suites.mjs --list     # enumerate + report only, run nothing
 *   node scripts/check-package-suites.mjs --json     # machine-readable plan (implies --list)
 */
import { readFileSync, readdirSync, existsSync, statSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')

/**
 * P4 — the committed floor. Today: `@ziee/viz` + `@ziee/dock`. Lowering it is an
 * explicit, reviewable edit; a rename that drops a package below it is a FAILURE.
 */
const MIN_GATED_PACKAGES = 2

/** Workspaces already executed by another wired gate. See SCOPE RULES; verified below. */
const ALREADY_GATED = new Set(['src-app/ui'])

/** Directories npm itself never treats as a workspace. */
const NEVER_A_WORKSPACE = new Set(['node_modules'])

/** Build output / vendored trees that must not be walked for test files. */
const SKIP_WALK = new Set(['node_modules', 'dist', 'build', 'coverage', '.vite', '.turbo', '.git'])

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/

/** A TypeScript SOURCE file — the on-disk evidence half of P6's subject. */
const TS_SOURCE = /\.[cm]?tsx?$/

/**
 * Is there anything here to typecheck? (P6's subject)
 *
 * TWO kinds of evidence, and it needs both. `tsconfig.json` is the DECLARATION `tsc` itself
 * resolves — the derived-guards §2 answer, read from what the product already treats as the
 * source of truth. But a declaration can be DELETED, and that is the difference between this
 * rule and P3: P3's subject is test FILES on disk, which cannot be deleted without actually
 * removing the tests, whereas a package could drop its `tsconfig.json` AND its `typecheck`
 * script and go silently `skipped` with its TypeScript source still shipping. So the source
 * itself counts as evidence too, exactly as it does for P3 — you cannot dodge the rule
 * without deleting the thing the rule protects.
 *
 * Returns the EVIDENCE, so the failure can say which one it found rather than asserting a
 * category at the reader.
 */
function typescriptEvidence(dir) {
  if (existsSync(path.join(dir, 'tsconfig.json'))) return 'a TypeScript project (`tsconfig.json`)'
  const hit = firstMatch(dir, TS_SOURCE)
  return hit ? `TypeScript source on disk (e.g. \`${rel(hit)}\`)` : null
}

const failures = []
const fail = (id, msg) => failures.push(`${id}: ${msg}`)

const rel = p => path.relative(REPO, p).split(path.sep).join('/')

// ── P1: expand the ROOT package.json workspace globs ─────────────────────────
const rootPkgPath = path.join(REPO, 'package.json')
if (!existsSync(rootPkgPath)) {
  console.error(`check-packages FAIL — no root package.json at ${rootPkgPath}`)
  process.exit(1)
}
const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'))
const patterns = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : rootPkg.workspaces?.packages
if (!Array.isArray(patterns) || patterns.length === 0) {
  console.error('check-packages FAIL — the root package.json declares no `workspaces`; this gate would be vacuous.')
  process.exit(1)
}

/**
 * Deliberately MINIMAL glob support: a literal path, or exactly one trailing `/*`.
 * Anything richer is refused rather than half-handled — a pattern this cannot expand
 * would silently drop every package under it, which is the bug being fixed.
 */
function expand(pattern) {
  if (!pattern.includes('*')) return [path.join(REPO, pattern)]
  if (!/^[^*]+\/\*$/.test(pattern)) {
    fail(
      'P1',
      `workspace pattern \`${pattern}\` is not one this gate understands (literal path, or a ` +
        `single trailing \`/*\`). Teach \`expand()\` rather than let every package under it ` +
        `drop out of the gate unnoticed.`,
    )
    return []
  }
  const parent = path.join(REPO, pattern.slice(0, -2))
  if (!existsSync(parent)) return []
  return readdirSync(parent, { withFileTypes: true })
    .filter(e => e.isDirectory() && !NEVER_A_WORKSPACE.has(e.name))
    .map(e => path.join(parent, e.name))
    .sort()
}

// ── submodule paths, read from .gitmodules (derived, not typed out) ──────────
const gitmodulesPath = path.join(REPO, '.gitmodules')
const submodulePaths = existsSync(gitmodulesPath)
  ? [...readFileSync(gitmodulesPath, 'utf8').matchAll(/^\s*path\s*=\s*(.+)$/gm)].map(m => m[1].trim())
  : []
const underSubmodule = r => submodulePaths.find(s => r === s || r.startsWith(s + '/'))

// ── S1/S2: is each submodule present, and is THIS BRANCH changing it? ────────
const git = (args, cwd = REPO) =>
  spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const BASE = process.env.PACKAGE_SUITES_BASE || 'origin/main'

/**
 * True when some root workspace glob resolves INSIDE this submodule.
 *
 * Compared by PATH SEGMENT, never by substring: `packages` is a substring of
 * `src-app/libs/*` while resolving nowhere near it, and a substring test would
 * make an uninitialised submodule at that path a hard failure for a glob that has
 * nothing to do with it.
 */
const declaresWorkspaces = sub => patterns.some(p => p === sub || p.startsWith(sub + '/'))

/**
 * Is `dir` its OWN git repository, rather than a directory inside the parent's?
 *
 * `git -C <dir> rev-parse HEAD` is NOT this test, and using it was a bug: git walks
 * UP from `dir` until it finds a repository, so inside an EMPTY (uninitialised)
 * submodule directory it happily returns the PARENT's HEAD and exit 0. The presence
 * check then passed for a submodule that is not there, and — worse — the very next
 * call, `git status --porcelain` in that same directory, reported the PARENT's dirty
 * files, so every uninitialised submodule was judged "working tree dirty" and
 * therefore IN PLAY whenever the parent tree had any uncommitted change at all.
 *
 * Comparing the resolved toplevel to `dir` is the actual question: an initialised
 * submodule is a repository boundary and answers itself; an empty directory answers
 * with its parent. Both sides go through `realpathSync` so a symlinked checkout
 * (`/tmp` → `/private/tmp`) is not mistaken for a different tree.
 */
function isOwnRepo(dir) {
  const top = git(['rev-parse', '--show-toplevel'], dir)
  // An EMPTY answer must never reach `realpathSync`. `realpathSync('')` does not
  // throw — it resolves to the process CWD, which is a DIFFERENT directory that
  // happens to exist. Silently answering a question nobody asked is the exact bug
  // this function was written to remove; do not reintroduce it one line lower.
  const toplevel = top.status === 0 ? top.stdout.trim() : ''
  if (!toplevel) return false
  try {
    return realpathSync(toplevel) === realpathSync(dir)
  } catch {
    return false
  }
}

/**
 * @returns {{present:boolean, dirty:boolean, pointerMoved:boolean, inPlay:boolean, why:string}}
 */
function submoduleState(sub) {
  const dir = path.join(REPO, sub)
  // S1 — present + initialised. An uninitialised submodule is an EMPTY directory:
  // its workspace globs expand to nothing and the old gate passed while covering
  // strictly less than it claimed. Refuse that silence.
  if (!existsSync(dir) || !statSync(dir).isDirectory() || !isOwnRepo(dir)) {
    // Only FATAL when this submodule is where some workspace glob points: that is the
    // case where an uninitialised tree makes the globs expand to nothing and the gate
    // silently covers less than it reports. `agent-kit` (docs + skills) declares no
    // npm workspaces, so its being uninitialised costs this gate exactly nothing —
    // failing on it would just force every contributor to check out a tree this gate
    // has no opinion about, and a gate people work around is not a gate.
    if (declaresWorkspaces(sub))
      fail(
        'S1',
        `submodule \`${sub}\` is absent or uninitialised, and the root \`workspaces\` globs point ` +
          `INSIDE it, so its packages expand to nothing and this gate would silently cover less ` +
          `than it reports. Run \`git submodule update --init ${sub}\`.`,
      )
    return {
      present: false,
      dirty: false,
      pointerMoved: false,
      inPlay: false,
      why: declaresWorkspaces(sub)
        ? 'absent/uninitialised'
        : 'absent/uninitialised — declares no npm workspaces, so nothing here to gate',
    }
  }

  // S2a — dirty working tree inside the submodule (uncommitted submodule edits).
  const st = git(['status', '--porcelain'], dir)
  const dirty = st.status === 0 && st.stdout.trim().length > 0

  // S2b — the recorded pointer moved. Committed: merge-base(BASE, HEAD)..HEAD.
  // Uncommitted: a staged/unstaged gitlink change, with `--ignore-submodules=dirty`
  // so a merely-dirty submodule is not double-counted as a pointer move.
  let pointerMoved = false
  let baseNote = ''
  const mb = git(['merge-base', BASE, 'HEAD'])
  if (mb.status === 0 && mb.stdout.trim()) {
    const d = git(['diff', '--name-only', mb.stdout.trim(), 'HEAD', '--', sub])
    pointerMoved = d.status === 0 && d.stdout.trim().length > 0
  } else {
    // Fail toward RUNNING: an unresolvable base must not become a quiet skip.
    baseNote = ` (base \`${BASE}\` unresolvable — treating as in play)`
    pointerMoved = true
  }
  const wt = git(['diff', '--ignore-submodules=dirty', '--name-only', 'HEAD', '--', sub])
  if (wt.status === 0 && wt.stdout.trim()) pointerMoved = true

  const inPlay = dirty || pointerMoved
  const why = inPlay
    ? [dirty && 'working tree dirty', pointerMoved && `pointer moved vs ${BASE}`]
        .filter(Boolean)
        .join(' + ') + baseNote
    : `untouched by this branch (clean, pointer == ${BASE})`
  return { present: true, dirty, pointerMoved, inPlay, why }
}

/** @type {Map<string, ReturnType<typeof submoduleState>>} */
const subState = new Map(submodulePaths.map(s => [s, submoduleState(s)]))

/** In-play submodule packages that have tests but no runner — reported, never silent (S3). */
const upstreamGaps = []

/** The same, one property over: an in-play submodule package with a `tsconfig.json` and no
 *  `typecheck` script. Kept as its OWN list rather than folded into `upstreamGaps`, whose
 *  every reader prints "N test file(s)" — a typecheck gap has no test-file count, and
 *  reporting one as `0 test file(s)` would be a false statement in the gate's own output. */
const typecheckUpstreamGaps = []

/** The first file under `dir` matching `re`, or null. Short-circuits; same skip list as
 *  `testFiles` so build output and vendored trees are never evidence of anything. */
function firstMatch(dir, re, depth = 0) {
  if (depth > 12) return null
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_WALK.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      const hit = firstMatch(p, re, depth + 1)
      if (hit) return hit
    } else if (re.test(e.name)) return p
  }
  return null
}

// ── walk a package for test files ────────────────────────────────────────────
function testFiles(dir, acc = [], depth = 0) {
  if (depth > 12) return acc
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_WALK.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) testFiles(p, acc, depth + 1)
    else if (TEST_FILE.test(e.name)) acc.push(p)
  }
  return acc
}

// ── classify every resolved workspace ────────────────────────────────────────
/** @type {{dir:string, rel:string, name:string|null, status:string, reason:string, testScript:string|null, testFiles:number}[]} */
const rows = []
/** rel → the parsed package.json, so P6 does not re-read what P1/P2 already parsed. */
const manifests = new Map()
const seen = new Set()
for (const pattern of patterns) {
  for (const dir of expand(pattern)) {
    const r = rel(dir)
    if (seen.has(r)) continue
    seen.add(r)
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue
    const pkgPath = path.join(dir, 'package.json')
    if (!existsSync(pkgPath)) continue // npm ignores a dir with no manifest; so do we
    let pkg
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    } catch (e) {
      fail('P2', `\`${r}/package.json\` is unparseable, so its suite cannot be classified: ${e.message}`)
      continue
    }
    // Cached for P6 below. A row only EXISTS if its manifest parsed here, so P6 must not
    // re-read and re-parse it behind a `try` for a state that cannot occur — a catch block
    // guarding an impossible case reads like a handled risk and is really just noise.
    manifests.set(r, pkg)
    const name = pkg.name ?? null
    const testScript = pkg.scripts?.test ?? null

    const sub = underSubmodule(r)
    if (sub) {
      const state = subState.get(sub)
      if (!state?.inPlay) {
        rows.push({
          dir,
          rel: r,
          name,
          status: 'excluded',
          reason: `submodule \`${sub}\` — ${state?.why ?? 'gated in its own repo'}`,
          testScript,
          testFiles: 0,
        })
        continue
      }
      // IN PLAY (S2): this branch is changing the submodule, so its suites are this
      // branch's responsibility — the "another repo's change" justification for the
      // exclusion does not apply to a change we are making.
      const subFiles = testFiles(dir)
      if (!testScript) {
        if (subFiles.length > 0) {
          // S3 — an UPSTREAM gap. Named on every run, but not fatal: the fix (a `test`
          // script) has to be made in the other repository, and failing here would just
          // train people to skip the gate.
          upstreamGaps.push({ rel: r, name, files: subFiles.length })
          rows.push({
            dir,
            rel: r,
            name,
            status: 'UPSTREAM-GAP',
            reason: `${subFiles.length} test file(s), no \`test\` script — fix belongs in the \`${sub}\` repo`,
            testScript,
            testFiles: subFiles.length,
          })
        } else {
          rows.push({ dir, rel: r, name, status: 'skipped', reason: `submodule \`${sub}\` in play, but no tests on disk`, testScript, testFiles: 0 })
        }
        continue
      }
      if (!name) {
        fail('P2', `\`${r}\` has a \`test\` script but no package \`name\`, so it cannot be invoked by workspace.`)
        continue
      }
      rows.push({
        dir,
        rel: r,
        name,
        status: 'gated',
        reason: `${testScript}  [submodule \`${sub}\` IN PLAY: ${state.why}]`,
        testScript,
        testFiles: subFiles.length,
      })
      continue
    }
    if (ALREADY_GATED.has(r)) {
      rows.push({ dir, rel: r, name, status: 'excluded', reason: 'already run by `npm run check` in `just check`', testScript, testFiles: 0 })
      continue
    }

    const files = testFiles(dir)
    if (!testScript) {
      if (files.length > 0) {
        // P3 — the literal bug class.
        fail(
          'P3',
          `\`${r}\` (${name ?? 'unnamed'}) has ${files.length} test file(s) on disk but NO \`test\` ` +
            `script, so nothing can run them: e.g. ${files.slice(0, 3).map(f => rel(f)).join(', ')}` +
            `${files.length > 3 ? ', …' : ''}. Add a \`test\` script to ${r}/package.json.`,
        )
        rows.push({ dir, rel: r, name, status: 'UNRUNNABLE', reason: `${files.length} test file(s), no \`test\` script`, testScript, testFiles: files.length })
      } else {
        rows.push({ dir, rel: r, name, status: 'skipped', reason: 'no tests on disk, no `test` script', testScript, testFiles: 0 })
      }
      continue
    }
    if (!name) {
      fail('P2', `\`${r}\` has a \`test\` script but no package \`name\`, so it cannot be invoked by workspace.`)
      continue
    }
    rows.push({ dir, rel: r, name, status: 'gated', reason: testScript, testScript, testFiles: files.length })
  }
}

const gated = rows.filter(r => r.status === 'gated')

// ── P6: classify the TYPECHECK half over the SAME derived, already-scoped rows ─────────
//
// Deliberately a SECOND field rather than a second `status` value: `status` answers "will
// your suite run?", and a package can perfectly well be typechecked while having no tests
// (or the reverse). Folding both into one enum would have forced a cross-product nobody
// can read, and would have silently changed the meaning of a field other tooling asserts on.
for (const r of rows) {
  const typecheckScript = manifests.get(r.rel)?.scripts?.typecheck ?? null
  r.typecheckScript = typecheckScript
  r.tsEvidence = typecheckScript ? null : typescriptEvidence(r.dir)

  // The scope rules are the SAME ones the test half uses — read off the row that already
  // applied them, so the two halves can never drift into disagreeing about who is in scope.
  if (r.status === 'excluded') {
    r.typecheck = 'excluded'
    r.typecheckReason = r.reason
    continue
  }
  const sub = underSubmodule(r.rel)
  if (typecheckScript) {
    if (!r.name) {
      // Reachable ONLY for a package with a `typecheck` script and NO `test` script: one
      // WITH a test script was already failed by P2 in the first loop and never became a
      // row. Both paths hard-fail — this note exists so the two rule ids are not read as a
      // disagreement about the same case.
      fail('P6', `\`${r.rel}\` has a \`typecheck\` script but no package \`name\`, so it cannot be invoked by workspace.`)
      r.typecheck = 'skipped'
      r.typecheckReason = 'no package name'
      continue
    }
    r.typecheck = 'typechecked'
    r.typecheckReason = typecheckScript + (sub ? `  [submodule \`${sub}\` IN PLAY]` : '')
    continue
  }
  if (r.tsEvidence) {
    if (sub) {
      // S3, one property over: the remedy (a `typecheck` script) lives in the other
      // repository. Named on EVERY run, never fatal — failing here would only train
      // people to bypass the gate.
      typecheckUpstreamGaps.push({ rel: r.rel, name: r.name, evidence: r.tsEvidence })
      r.typecheck = 'UPSTREAM-GAP'
      r.typecheckReason = `${r.tsEvidence}, no \`typecheck\` script — fix belongs in the \`${sub}\` repo`
      continue
    }
    // P6 — the literal bug class, one property over: TypeScript that nothing typechecks.
    // THIS is what let `@ziee/viz` sit red for an unknown length of time.
    fail(
      'P6',
      `\`${r.rel}\` (${r.name ?? 'unnamed'}) has ${r.tsEvidence} but NO \`typecheck\` script, so nothing ` +
        `can typecheck it — vitest transpiles without typechecking, so its suites go green over code ` +
        `that does not compile. Add \`"typecheck": "tsc --noEmit"\` to ${r.rel}/package.json.`,
    )
    r.typecheck = 'UNTYPECHECKED'
    r.typecheckReason = `${r.tsEvidence}, no \`typecheck\` script`
    continue
  }
  r.typecheck = 'skipped'
  r.typecheckReason = 'no TypeScript on disk, no `typecheck` script'
}

const typechecked = rows.filter(r => r.typecheck === 'typechecked')

// ── S2 ratchet: an in-play submodule must actually contribute a runnable suite ─
// Without this, a submodule whose packages all lost their `test` scripts would go
// from "excluded, and we said so" to "in play, and we ran nothing" — a silent
// downgrade, which is the exact shape of the hole S2 exists to close.
const noWorkspaceSubmodules = []
for (const [sub, state] of subState) {
  if (!state.inPlay) continue
  const fromSub = rows.filter(r => r.rel === sub || r.rel.startsWith(sub + '/'))
  if (fromSub.length === 0) {
    // A submodule the root `workspaces` globs do not reach at all (today: `agent-kit`,
    // which ships docs + scripts, not npm packages). There is nothing here to run and
    // never was — say so, but do NOT fail: that would make a routine agent-kit bump
    // red for a reason this gate has no opinion about.
    noWorkspaceSubmodules.push(sub)
    continue
  }
  if (!fromSub.some(r => r.status === 'gated'))
    fail(
      'S2',
      `submodule \`${sub}\` is IN PLAY (${state.why}) and resolves ${fromSub.length} workspace(s), ` +
        `but contributed ZERO runnable suites. A branch that changes a submodule must run ` +
        `something from it, or the change lands ungated.`,
    )
}

// ── P4: the floor ────────────────────────────────────────────────────────────
if (gated.length < MIN_GATED_PACKAGES)
  fail(
    'P4',
    `only ${gated.length} workspace package(s) resolved to a runnable suite, below the floor of ` +
      `${MIN_GATED_PACKAGES}. Either the workspace globs no longer match (a rename/move), or a ` +
      `package lost its \`test\` script. A gate that runs (almost) nothing must not pass.`,
  )

// ── the ALREADY_GATED exclusion must still be TRUE ───────────────────────────
function assertAlreadyGatedIsReallyGated() {
  if (!ALREADY_GATED.has('src-app/ui')) return
  const justfile = readFileSync(path.join(REPO, 'justfile'), 'utf8')
  const justCode = justfile.split('\n').filter(l => !/^\s*#/.test(l)).join('\n')
  if (!/npm run check/.test(justCode))
    fail(
      'P2',
      '`src-app/ui` is excluded here on the grounds that `just check` runs `npm run check` for it — ' +
        'but no justfile recipe runs `npm run check` any more, so its suites are now ungated by BOTH.',
    )
  const uiPkgPath = path.join(REPO, 'src-app/ui/package.json')
  if (!existsSync(uiPkgPath)) return
  const chain = JSON.parse(readFileSync(uiPkgPath, 'utf8')).scripts?.check ?? ''
  if (!/test:unit/.test(chain))
    fail(
      'P2',
      "`src-app/ui` is excluded here because `npm run check` ends in its unit suites, but ui's " +
        '`check` chain no longer runs `test:unit` — the exclusion has become a hole.',
    )
  // The TYPECHECK half of the same exclusion (P6). `src-app/ui` is the one in-scope
  // workspace P6 does not typecheck, on the grounds that ui's own `check` chain CONTAINS
  // `tsc --noEmit`. That claim has to be re-derived like the other one: widening a gate
  // while leaving its exemption unproven is how the exemption becomes the hole. Verified
  // against the chain rather than against a memory of it.
  //
  // "Contains", not "begins with" — the chain is `&&`-joined, so position carries no
  // meaning and claiming it would be describing more than this test checks. Read from
  // `scripts.check` SPECIFICALLY, never the whole manifest: `tsc --noEmit` appearing in
  // some other script would satisfy a whole-file search while ui's `check` no longer ran
  // it at all.
  if (!/tsc\s+--noEmit/.test(chain))
    fail(
      'P6',
      "`src-app/ui` is excluded from the TYPECHECK half (P6) because its `check` chain contains " +
        "`tsc --noEmit`, but ui's `check` chain no longer does — ui is now typechecked by " +
        'NOTHING, which is the exact hole P6 exists to close for every other workspace.',
    )
}
assertAlreadyGatedIsReallyGated()

// ── report the plan ──────────────────────────────────────────────────────────
const asJson = process.argv.includes('--json')
const listOnly = process.argv.includes('--list') || asJson
if (asJson) {
  console.log(
    JSON.stringify(
      {
        patterns,
        submodulePaths,
        base: BASE,
        submodules: Object.fromEntries(subState),
        floor: MIN_GATED_PACKAGES,
        packages: rows,
        upstreamGaps,
        typecheckUpstreamGaps,
        failures,
      },
      null,
      2,
    ),
  )
} else {
  const w = (s, n) => String(s).padEnd(n)
  console.log(`\ncheck-packages — ${rows.length} workspace(s) from ${patterns.length} glob(s): ${patterns.join(', ')}`)
  for (const [sub, s] of subState) {
    const verdict = !s.inPlay
      ? 'not in play — excluded'
      : noWorkspaceSubmodules.includes(sub)
        ? 'IN PLAY, but it declares no workspace packages — nothing here to run'
        : 'IN PLAY — its suites are GATED here'
    console.log(`  submodule ${sub}: ${verdict} (${s.why})`)
  }
  console.log(`  ${w('workspace', 30)}${w('package', 24)}${w('status', 14)}why`)
  for (const r of rows) console.log(`  ${w(r.rel, 30)}${w(r.name ?? '-', 24)}${w(r.status, 14)}${r.reason}`)
  console.log(`\n  TYPECHECK (P6)`)
  console.log(`  ${w('workspace', 30)}${w('package', 24)}${w('typecheck', 14)}why`)
  for (const r of rows)
    console.log(`  ${w(r.rel, 30)}${w(r.name ?? '-', 24)}${w(r.typecheck, 14)}${r.typecheckReason}`)
  if (upstreamGaps.length)
    console.log(
      `\n  ! UPSTREAM GAP (S3) — in-play submodule package(s) with test files and no runner, ` +
        `so this gate CANNOT run them; the fix is a \`test\` script in the submodule's own repo:\n` +
        upstreamGaps.map(g => `      ${g.name ?? g.rel}  (${g.files} test file(s))`).join('\n'),
    )
  if (typecheckUpstreamGaps.length)
    console.log(
      `\n  ! UPSTREAM GAP (S3/P6) — in-play submodule package(s) declaring a TypeScript project ` +
        `with no \`typecheck\` script, so this gate CANNOT typecheck them; the fix is a ` +
        `\`typecheck\` script in the submodule's own repo:\n` +
        typecheckUpstreamGaps.map(g => `      ${g.name ?? g.rel}`).join('\n'),
    )
}

if (failures.length) {
  console.error(`\n✗ check-packages — ${failures.length} wiring failure(s):`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}

if (listOnly) {
  // `--json` keeps stdout PURE JSON so a caller can parse it without stripping a banner.
  if (!asJson)
    console.log(
      `\n✓ check-packages (--list): ${gated.length} package suite(s) would run: ${gated.map(g => g.name).join(', ')}` +
        `\n  and ${typechecked.length} package typecheck(s) would run: ${typechecked.map(t => t.name).join(', ') || '(none)'}`,
    )
  process.exit(0)
}

// ── P6 then P5: run them ALL, then report ────────────────────────────────────
//
// Typechecks first, and every one of them, BEFORE any suite: a typecheck failure is the
// cheapest and most explanatory signal there is (a broken import shows up here as one line,
// and downstream as a puzzling runtime failure in some suite). Neither loop short-circuits
// — a red package must not mask the packages after it, which is P5's rule and applies to
// P6 identically.
const typecheckResults = []
for (const t of typechecked) {
  console.log(`\n══════ check-packages: ${t.name} (${t.rel}) — npm run typecheck --workspace ${t.name} ══════`)
  const r = spawnSync('npm', ['run', 'typecheck', '--workspace', t.name], { cwd: REPO, stdio: 'inherit' })
  typecheckResults.push({ ...t, code: r.status === null ? 1 : r.status, signal: r.signal ?? null })
}

const results = []
for (const g of gated) {
  console.log(`\n══════ check-packages: ${g.name} (${g.rel}) — npm run test --workspace ${g.name} ══════`)
  const r = spawnSync('npm', ['run', 'test', '--workspace', g.name], { cwd: REPO, stdio: 'inherit' })
  results.push({ ...g, code: r.status === null ? 1 : r.status, signal: r.signal ?? null })
}

console.log('\n══════ check-packages summary ══════')
console.log('  TYPECHECK (P6)')
for (const r of typecheckResults)
  console.log(`  ${r.name.padEnd(24)} exit ${r.code}${r.signal ? ` (signal ${r.signal})` : ''}`)
// Filtered on the REASON as well as the status: `skipped` is also assigned to the
// `no package name` case, and a label that names only one of its cases will eventually
// describe the wrong one.
const notTypechecked = rows.filter(r => r.typecheck === 'skipped' && /no TypeScript on disk/.test(r.typecheckReason))
if (notTypechecked.length)
  console.log(`  NOT typechecked (no TypeScript on disk): ${notTypechecked.map(s => s.name ?? s.rel).join(', ')}`)
console.log('  TEST SUITES (P5)')
for (const r of results)
  console.log(`  ${r.name.padEnd(24)} exit ${r.code}${r.signal ? ` (signal ${r.signal})` : ''}`)
const skipped = rows.filter(r => r.status === 'skipped')
if (skipped.length) console.log(`  NOT run (no tests on disk): ${skipped.map(s => s.name ?? s.rel).join(', ')}`)
const excluded = rows.filter(r => r.status === 'excluded')
if (excluded.length) console.log(`  EXCLUDED by scope rule: ${excluded.map(s => `${s.name ?? s.rel} (${s.reason})`).join('; ')}`)
if (upstreamGaps.length)
  console.log(
    `  UPSTREAM GAP (S3, not run, not fatal): ${upstreamGaps.map(g => `${g.name ?? g.rel} (${g.files} test file(s), no runner)`).join('; ')}`,
  )
if (typecheckUpstreamGaps.length)
  console.log(
    `  UPSTREAM GAP (S3/P6, not run, not fatal): ${typecheckUpstreamGaps.map(g => `${g.name ?? g.rel} (TS project, no \`typecheck\` script)`).join('; ')}`,
  )

const badTypecheck = typecheckResults.filter(r => r.code !== 0)
const bad = results.filter(r => r.code !== 0)
if (badTypecheck.length)
  console.error(
    `\n✗ check-packages — ${badTypecheck.length} package typecheck(s) FAILED (P6): ${badTypecheck.map(b => b.name).join(', ')}`,
  )
if (bad.length)
  console.error(`\n✗ check-packages — ${bad.length} package suite(s) FAILED: ${bad.map(b => b.name).join(', ')}`)
// Both loops are reported before either can exit: a run that is red on BOTH halves must say
// so once, not tell you about the typechecks and leave you to discover the suites next time.
if (badTypecheck.length || bad.length) process.exit(1)
console.log(
  `\n✓ check-packages: ${typecheckResults.length} package typecheck(s) and ${results.length} package suite(s) passed.`,
)
