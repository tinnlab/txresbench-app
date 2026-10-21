# CytoAnalyst task runner. Mirrors the recipe NAMES the ziee lifecycle gates
# shell out to (`just openapi-regen`, `just check`, `just test`) so the shared
# lifecycle scripts work once they're app-parameterized (SDK_GAPS C-1).

server_dir := justfile_directory() / "src-app/server"
ui_dir := justfile_directory() / "src-app/ui"

# Default: list recipes.
default:
    @just --list

# Backend integration tests. Needs a reachable Postgres (DATABASE_URL or the
# shared cluster default 127.0.0.1:54321). Per-test DB isolation makes parallel
# safe; keep --test-threads modest on a shared host.
test THREADS="4":
    cd {{server_dir}} && CONFIG_FILE=config/dev.yaml cargo test --test integration_tests -- --test-threads={{THREADS}}

# Backend unit tests (no external deps beyond a compile DB).
test-unit:
    cd {{server_dir}} && cargo test --lib

# The pre-push gate: backend compiles (workspace, incl. tests), the frontend
# type-checks clean (`tsc --noEmit`), the production bundle builds, and every other
# committed gate in this file runs.
#
# ── WHY THIS IS A RUNNER AND NOT NINE RECIPE LINES (#287) ───────────────────────────
# It WAS nine recipe lines. `just`, like `make`, runs each line as a separate command and
# ABORTS ON THE FIRST NON-ZERO EXIT — so with line 2 (`npm run check`) red on main, SEVEN
# of the nine legs were unreachable and had been for an unknown length of time. The one
# command a person runs to ask "is the tree healthy?" was answering about TWO of its nine
# legs while presenting itself as answering about nine. Two of the hidden legs had caught
# real defects that same week: `check-processor-versions` blocked a behaviour change at an
# unbumped version, and `check-invariants` was itself red in a way this recipe could never
# have revealed.
#
# So every leg now RUNS, its failure is CONTAINED, and the aggregate's verdict is derived
# at the end from the collected exit codes — non-zero if ANY leg failed, with a summary
# naming which failed and which passed. `docs/design/aggregate-gate-reporting.md` §2.
#
# THE LEGS ARE NOT REORDERED. The branch that first noticed this defect (#276) declined to
# put its own gate first, calling it "special-pleading for one gate over six", and that
# reasoning stands: reordering makes one leg verifiable and leaves the rest exactly as
# hidden. The nine legs below are in their original order with their original command text;
# `check-aggregate-controls` in front of them is not a tenth gate but this runner's OWN
# negative controls, in the load-bearing position `check-packages` and `check-guards`
# already document ("a gate edited without its controls still passing is a gate whose PASS
# is worth nothing"). It is aggregated like everything else rather than aborting, and the
# summary says loudly when it is the leg that failed.
#
# EXPECT THIS TO BE RED, and read the redness correctly: making every leg run surfaces every
# previously-hidden failure at once. Those failures are PRE-EXISTING and now VISIBLE, each
# with its own issue and owner — that is the entire value of the change, not a regression in
# it. Do NOT allowlist a leg, mute one, or lower `--min-legs` to get a green;
# `docs/design/derived-guards.md` §5 lists exactly those as what is not the repair.
#
# `--min-legs` is the floor: a leg silently dropped from the heredoc below — or a heredoc
# that stops expanding — must redden rather than shrink the gate to a green over a smaller
# set. Adding a leg needs no edit to it; removing one does.
check:
    #!/usr/bin/env bash
    set -uo pipefail
    "{{justfile_directory()}}/scripts/check-aggregate.sh" --label 'just check' --min-legs 10 --controls-leg check-aggregate-controls <<'LEGS'
    check-aggregate-controls node --test "{{justfile_directory()}}/scripts/check-aggregate.test.mjs"
    cargo-check-workspace cd {{server_dir}} && CONFIG_FILE=config/dev.yaml cargo check --workspace --tests
    ui-npm-check cd {{ui_dir}} && npm run check
    ui-npm-build cd {{ui_dir}} && npm run build
    check-py just check-py
    check-packages just check-packages
    check-coercion just check-coercion
    check-processor-versions just check-processor-versions
    check-invariants just check-invariants
    check-r-regime just check-r-regime
    LEGS

# The R half of the dependency + pinning regime (#192), RUN rather than asserted about.
#
# ── WHY THIS IS ITS OWN RECIPE AND WHY IT IS IN `check` ─────────────────────────────
# The regime's load-bearing R logic — the pin parser, the resolution-coordinate reader and
# the closure-lock writer — lives inside `env-rootfs/single-cell-r/Dockerfile`, because the
# recipe is deliberately two files (the rootfs freshness key hashes the Dockerfile and
# `watched_env_pin_files` watches exactly those two, so a third would change without
# re-triggering either). The script extracts that block by its delimiter and EXECUTES it.
#
# It was WIRED TO NOTHING when first written — referenced only by prose and by process
# artifacts — which a blind audit correctly called the stronger form of the failure the
# script's own header argues against: a pytest that silently skips is at least invoked.
# So it runs here.
#
# It REFUSES when `Rscript` is absent rather than skipping green. That is a real cost on a
# machine without R, and it is the intended one: the alternative is a check that reports
# success on a box that cannot perform it, which is how a gate stops being a gate.
check-r-regime:
    #!/usr/bin/env sh
    set -eu
    # DERIVED, not named. `check-derived-vocabulary.sh` refuses an env id spelled in the
    # build tier — "the build tier must be reusable by a domain that ships neither these
    # datatypes nor this env" — and it caught the first cut of this recipe, which invoked
    # the suite by its full path. The recipe tree decides which suites exist; this runs
    # every one it finds and says how many, so a domain with no R recipe runs nothing and
    # SAYS SO rather than reporting a silent green.
    #
    # The anti-deletion half lives where naming a recipe is allowed: a pytest in the
    # package tree asserts the R recipe HAS this suite and that `check` includes this
    # recipe. A glob alone would go quietly vacuous if the script were deleted.
    #
    # #287: the loop COLLECTS rather than aborting. With `set -e` the first failing suite
    # ended the recipe, so a second env recipe's regime suite was unreachable behind the
    # first one's red — the same defect one level below `just check`. Every discovered
    # suite runs; the recipe still exits non-zero if any of them failed.
    n=0
    failed=0
    for t in src-app/env-rootfs/*/tests/run-r-tests.sh; do
        [ -f "$t" ] || continue
        set +e
        sh "$t"
        suite_rc=$?
        set -e
        [ "$suite_rc" -eq 0 ] || { failed=$((failed + 1)); echo "check-r-regime: FAIL($suite_rc) $t" >&2; }
        n=$((n + 1))
    done
    echo "check-r-regime: ran $n env-recipe regime suite(s), $failed failed"
    # A FLOOR, for the same reason `check-aggregate.sh` hard-fails on an empty leg list
    # (#287 / `docs/design/derived-guards.md` §2): this loop ranges over a DERIVED set, and
    # a derived set that collapses to nothing reports success having checked nothing. The
    # glob expanding to zero suites is exactly that, and the recipe's own header claims it
    # "SAYS SO rather than reporting a silent green" — it said so on stdout and then exited
    # 0, which IS a silent green. Deleting the one existing suite file was enough.
    if [ "$n" -lt {{R_REGIME_SUITE_FLOOR}} ]; then
        echo "check-r-regime: SUITE FLOOR BREACHED — found $n, floor is {{R_REGIME_SUITE_FLOOR}}." >&2
        echo "  This loop ranges over a DERIVED set, so it needs the frozen companion" >&2
        echo "  derived-guards.md §2/§4 prescribes: adding an env recipe's suite never edits" >&2
        echo "  this number, removing one must. A bare 'is it zero?' check would let a tree" >&2
        echo "  with two suites silently drop to one." >&2
        echo "  matched nothing, so this gate checked NOTHING and would have reported success." >&2
        echo "  A regime suite has been deleted or moved. Do not 'fix' this by removing the check." >&2
        exit 1
    fi
    [ "$failed" -eq 0 ] || exit 1

PY_TEST_FLOOR := "1900"

# The frozen companion to `check-r-regime`'s DERIVED suite glob (#287 R5).
R_REGIME_SUITE_FLOOR := "1"

# The processors' PURE-function pytest suites. They were executed by NO repo-wired
# runner (not the justfile, not `npm run check`, not CI), so a processor kernel could
# regress with every gate green — the compute scripts are where the COMMITTED mask is
# decided, so that is the worst place to have an ungated suite.
#
# Three preflight checks stand in front of the run (#198). In `derived-guards.md`'s terms the
# first two are the DERIVATION (§2) and the third is its FLOOR companion (§2/§4) — in that
# order, because a floor that stands IN FOR a derivation is what §2 rules out by name.
#
#   1. DERIVED, both directions. `testpaths` is an ENUMERATION — this suite's own `pytest.ini`
#      header says so — and nothing checked it. Every `<package>/tests` dir ON DISK must
#      appear in `testpaths` (else that package ships collected by NOTHING, and no count can
#      see it, because the count is measured from `testpaths` itself); and every declared
#      testpath must EXIST on disk (else a deleted or renamed suite silently stops running).
#      The set is read from the filesystem, never hand-listed here, so a new package joins
#      this check with no edit — which is the whole point of §2.
#      [TEST-14 drives the forward direction (a tests/ dir on disk absent from `testpaths`);
#      TEST-15 the reverse (a `testpaths` entry naming a directory that does not exist).]
#
#   2. COLLECTION SUCCEEDED — gated on the EXIT CODE, not on the parsed count. This is the
#      check #198 itself needs and the one an earlier cut of this recipe got wrong: the abort
#      still prints a large, perfectly parseable count. Verified on the real defect —
#      "2044 tests collected, 11 errors" alongside "Interrupted: 11 errors during collection",
#      exit 2. A count-only guard reads 2044, sails past any sane floor, and reports nothing;
#      the exit code is the only signal that separates "collected 2044" from "collected 2044
#      AND gave up". Never replace this with a count comparison. [TEST-5 fires this branch on
#      the REAL #198 abort, forced by restoring the pre-fix import mode.]
#
#   3. FLOOR — the companion, and deliberately the WEAKEST of the three. Measured 2026-09-02
#      on `origin/main` @8212894b: 2325 collected (2092, plus the 233 that arrived with
#      `trajectory`). Be honest about its reach: with checks 1
#      and 2 in place it exists only to catch a gross collapse that leaves the directory
#      structure intact — e.g. a conftest change that silently empties several suites. It
#      canNOT see a single small suite disappearing (`geneset` is 7 tests), and it is not
#      asked to; check 1 covers the structural cases exactly and needs no slack. It is
#      deliberately NOT ratcheted to hug the current count each time a package lands —
#      that would re-create, in a number, exactly the per-package maintenance burden check 1
#      exists to remove. Raise it only alongside a real, explained increase. Lowering it to
#      fit a red run is the "lowering a floor to fit" anti-repair §5 refuses by name.
#      [TEST-4 drives this branch RED and confirms it names the collected count.]
#
# `env -u PYTEST_ADDOPTS` on both pytest calls is a GUARD property, not a style choice. An
# ambient `PYTEST_ADDOPTS` is prepended to every invocation, so it can silently change what
# this gate measures: `PYTEST_ADDOPTS="-q"` nets the collect call to -qq, at which pytest
# prints no total line, and the count parse below would then report COLLECTION FAILED on a
# perfectly healthy tree (a FALSE RED); `PYTEST_ADDOPTS="-k something"` would shrink the run
# itself (a FALSE GREEN, the worse direction). A gate that an env var can redirect is
# weakenable from outside the diff, which is the property `scripts/check-guard-integrity.sh`
# exists to deny. Developers who want ad-hoc pytest flags should run pytest directly.
#
# The final run drops the recipe's own `-q` (#198). `addopts` already supplies one, so
# `pytest -q` here made verbosity -2, and at -2 pytest prints NO "<N> passed" summary line at
# all — a green `just check-py` showed a progress bar and nothing else, so "2092 passed" and
# "7 passed because testpaths lost ten packages" looked identical. That is this issue's own
# failure in miniature. One `-q` (from `addopts`) keeps the output short AND keeps the count.
#
# What the whole recipe is held to (#198, hardening rule A11): TEST-13 — it RUNS TO COMPLETION
# and every failure it surfaces is enumerated with a pre-existing/new attribution in
# `.lifecycle/check-py-collection/HIDDEN_FAILURES.md`; TEST-7 — the branch that restored it adds
# and removes ZERO lines under any `src-app/packages/*/tests/` path, so no assertion was
# weakened, skipped or deleted to make collection succeed; TEST-12 — after the mutation cycle
# and every `__pycache__` sweep, `git status --porcelain` is EMPTY.
check-py:
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{justfile_directory()}}/src-app/packages"

    declared=$(sed -n 's/^testpaths *= *//p' pytest.ini)
    if [ -z "$declared" ]; then
        echo "check-py: could not read 'testpaths' from src-app/packages/pytest.ini." >&2
        exit 1
    fi
    unlisted=''
    for d in */tests; do
        [ -d "$d" ] || continue
        case " $declared " in (*" $d "*) ;; (*) unlisted="$unlisted $d" ;; esac
    done
    if [ -n "$unlisted" ]; then
        echo "check-py: PACKAGE SUITE COLLECTED BY NOTHING —$unlisted" >&2
        echo "  'testpaths' in src-app/packages/pytest.ini is an ENUMERATION: a tests/ dir" >&2
        echo "  missing from it is run by no gate at all, and no test COUNT can detect that," >&2
        echo "  because the count is measured from testpaths too. Add each path above." >&2
        exit 1
    fi
    for p in $declared; do
        if [ ! -d "$p" ]; then
            echo "check-py: STALE TESTPATH — 'testpaths' declares '$p', which does not exist." >&2
            echo "  A renamed or deleted suite stops running silently. Fix the entry in" >&2
            echo "  src-app/packages/pytest.ini, or drop it if the suite is genuinely gone." >&2
            exit 1
        fi
    done

    set +e
    collect_out=$(env -u PYTEST_ADDOPTS python3 -m pytest --collect-only 2>&1)
    collect_rc=$?
    set -e
    if [ "$collect_rc" -ne 0 ]; then
        echo "check-py: COLLECTION FAILED — 'pytest --collect-only' exited $collect_rc." >&2
        echo "  The suite cannot be assembled, so this gate would report NOTHING about the" >&2
        echo "  code it exists to check. Re-run for the cause:" >&2
        echo "    (from the repo root) cd src-app/packages && python3 -m pytest --collect-only" >&2
        echo "  Clear stale bytecode first — it can mask or fake the result:" >&2
        echo "    (from the repo root) find src-app/packages -name __pycache__ -type d -exec rm -rf {} +" >&2
        printf '%s\n' "$collect_out" | tail -20 >&2
        exit 1
    fi
    collected=$(printf '%s\n' "$collect_out" | grep -oE '[0-9]+ tests? collected' | head -1 | grep -oE '^[0-9]+' || true)
    if [ -z "${collected:-}" ]; then
        echo "check-py: could not parse a collected-test count from a SUCCEEDING collection." >&2
        echo "  pytest's summary format has probably changed; fix this recipe rather than" >&2
        echo "  dropping the check." >&2
        exit 1
    fi
    if [ "$collected" -lt {{PY_TEST_FLOOR}} ]; then
        echo "check-py: FLOOR BREACHED — collected $collected tests, floor is {{PY_TEST_FLOOR}}." >&2
        echo "  The directory structure is intact (checked above), so several suites have" >&2
        echo "  collapsed to near-zero — most likely a conftest or fixture error swallowing" >&2
        echo "  them. Do NOT lower the floor to go green." >&2
        exit 1
    fi
    env -u PYTEST_ADDOPTS python3 -m pytest

# The WORKSPACE PACKAGES' own vitest suites. Exactly the `check-py` shape, one directory
# over: `npm run check` roots vitest at `src-app/ui`, so the sibling packages' suites were
# executed by NO repo-wired runner — not this justfile, not `npm run check`, not CI.
# Measured when this recipe was added: `@ziee/viz` 207 files / 2555 tests and `@ziee/dock`
# 4 files / 84 tests, 2639 tests under nothing.
#
# NOT hypothetical, and not a near miss: a merge changed `libs/viz/src/adapter/
# VizController.ts` (+230/-5) and broke `VizController.events.test.ts`; the merge-gate,
# the pre-push hook and `just check` all passed it through to `main`, because nothing ran
# that suite. It was found by a human reading the tree. (Since fixed on main.)
#
# The package set is DERIVED from the root package.json's `workspaces` globs, so a new
# directory under `src-app/libs/` joins this gate with no edit here — a hand-list is
# the failure this repo keeps re-hitting (R3-99, the e2e routing hole), not the fix. Two
# exclusions, each printed with its reason on every run: `sdk/**` (a submodule pin —
# another repo's suite, read from `.gitmodules`) and `src-app/ui` (already run by
# `npm run check` above, and the script FAILS if that stops being true). A package with
# test files but no `test` script is a HARD FAILURE; one with neither is skipped by NAME.
# See the header of the script for the full rule set (P1-P5) and the floor.
#
# NO `*ARGS` passthrough, deliberately — R5-A above removed exactly that from
# `check-coercion` after finding `just check-coercion --report` exits 0 over a real
# divergence. This script has a `--list` flag that enumerates and runs NOTHING; forwarding
# caller flags would make `just check-packages --list` a green gate that executed zero
# tests. For the enumeration-only view, call the script directly:
#   node scripts/check-package-suites.mjs --list   (or --json)
#
# The `sdk/**` exclusion above is now CONDITIONAL, and that is the second hole this
# recipe closed. `@ziee/kit` — the component kit every cytoanalyst surface renders
# through — ships 44 tests that ran under NO cytoanalyst gate, because "it's another
# repo's suite" was applied unconditionally. Two mutations made in cytoanalyst work
# survived the whole app suite and died only in the kit suite, and three user-facing
# kit defects shipped through the hole in one day (MultiSelect unopenable with a value
# bound; Input remounting on the first keystroke; Tabs `fill` clipping content). The
# justification — "not this repo's change to make" — evaporates the moment a branch
# touches the submodule, so a submodule that is DIRTY or whose pointer MOVED vs the
# base is IN PLAY and its runnable suites are gated here (44 tests, ~3 s). An absent
# or uninitialised submodule is now a hard failure instead of an invisible shrink of
# the gate's coverage: its globs used to expand to nothing and the gate passed.
# `PACKAGE_SUITES_BASE=<ref>` moves the base (default `origin/main`).
#
# ── AND THE SAME HOLE ONE PROPERTY OVER: `typecheck` (#276, rule P6) ────────────────
# `src-app/libs/viz` declares `"typecheck": "tsc --noEmit"` and NOTHING invoked it. On clean
# `main` it exited 2 with FIVE errors, four of them inside `*.test.ts(x)` files — including
# `omeTiffFallback.test.tsx` importing two names `../grid/gridModel` does not export. The
# suites were green the whole time because vitest transpiles without typechecking, and `ui`'s
# `npm run check` runs `tsc` over the UI project, which reaches `@ziee/viz` only through the
# modules `ui` imports — a subset of its `src/` and NONE of its tests. A type-level API break
# was invisible to every gate in the repo, for an unknown length of time.
#
# So the script now RUNS each in-scope package's own `typecheck` script over the SAME derived
# set, and a first-party package that declares a TypeScript project (`tsconfig.json`) with no
# `typecheck` script is a HARD FAILURE — the P3 rule, one property over. Fixing those five
# errors without this would only have reset the clock.
#
# The alternative repair — adding viz's typecheck to `ui`'s `npm run check` chain — was
# refused as the ENUMERATING one: it fixes viz and leaves `@ziee/dock`'s typecheck (which
# also existed, and was also run by nothing) plus every future package to be hand-added
# again. `docs/design/derived-guards.md` §2/§5.
#
# ORDER IS LOAD-BEARING, exactly as in `check-guards` below: the gate's OWN guard
# (`check-package-suites.test.mjs` — the negative controls proving the gate goes red on a
# real error, and that its one exemption is re-derived) runs FIRST. A gate that has been
# edited without its controls still passing is a gate whose PASS is worth nothing.
#
# #287 CHANGED HOW THAT IS ENFORCED, and the difference is worth stating precisely. The
# controls still run first, but they no longer ABORT the run — aborting is the defect that
# issue removed. So the second leg now RUNS and REPORTS even when the controls are red.
# What preserves the property is that the controls leg is declared to the runner as
# `--controls-leg`: the recipe still exits non-zero, and the summary carries an explicit
# "every other result above is unverified" banner, so a PASS printed under a red control is
# marked as uninterpretable rather than presented as a result. The old wording — "before
# anything is allowed to REPORT anything" — is no longer literally true, and is corrected
# here rather than left to read as a property the code below no longer has.
#
# WORKSPACE-PACKAGE suites + typechecks (@ziee/viz, @ziee/dock, …) — derived from the globs.
check-packages:
    #!/usr/bin/env bash
    set -uo pipefail
    "{{justfile_directory()}}/scripts/check-aggregate.sh" --label 'just check-packages' --min-legs 2 --controls-leg package-suites-controls <<'LEGS'
    package-suites-controls node --test "{{justfile_directory()}}/scripts/check-package-suites.test.mjs"
    package-suites node "{{justfile_directory()}}/scripts/check-package-suites.mjs"
    LEGS

# RETIRED (processor-ui-language ITEM-40, slice A). This recipe ran
# `npm --prefix src-app/libs/workbench-api test` because `npm run check` roots vitest at
# `ui/`, so that package's in-src suites were collected by NOTHING (R3-99: 277 tests under no
# runner — "a guard nobody invokes is not a guard"). ITEM-1 collapses the package into
# `ui/src/modules/workbench/core`, which removes the reason the separate recipe existed: the
# suites are now inside `ui`, and `ui`'s own `test:unit:node` glob was widened to cover
# `src/modules/workbench/core/` to keep running them under the SAME `node --test` idiom they
# were written for (they use `node:test`, which vitest does not execute). The core/extensions
# layering later split `core/` into a framework-free half (api/columns/contributions/criteria/
# datatypes/form/loader/manifest/mcp — node:test) and a React/vitest half (spec/runtime/render/
# shell/gallery), so the glob now NAMES the node-runnable subtrees instead of using `core/**`,
# which would have swept vitest files into the plain-node runner.
# Verified at the move: `npm run test:unit:node` reports 326 tests = 277 (this package) + 49
# (ui's pre-existing node suites), zero lost. See DEC-K.

# The criteria-coercion PARITY gate: ONE corpus, THREE readers, in three languages.
#
# A criteria filter is coerced by the emitted replay script (Rust→python), the committed
# kernel (python) and the live preview (TS). The feature's promise is that they agree
# cell-for-cell; round 3 measured 12 disagreements out of 80 by hand and committed
# neither the corpus nor a runner. This executes all three over
# `src-app/testdata/criteria-coercion-corpus.json` and fails on any disagreement.
# See `src-app/testdata/README-coercion-corpus.md`.
#
# ITEM-4: there was a FOURTH reader — the TS DSL builder, i.e. the same filter lifted
# into a predicate. That was a SECOND ENCODING of what this corpus pins, and it is
# deleted; `criteria` is the single encoding. The gate keeps its subject (three
# independent implementations of the ONE coercion) and loses no cell-coercion coverage,
# because reader 4 shared reader 3's `parseCell`. See the README for the full note.
#
# R5-A (LOW): this recipe used to be `check-coercion *ARGS` and forwarded caller flags
# verbatim, so `just check-coercion --report` exits 0 over a REAL divergence (verified with
# the gte/lte inversion in place) — a gate that can be degraded through its own recipe. The
# wired `just check` above passes no args, so the default gate was never degradable; the
# passthrough was pure footgun and nothing in the repo used it. Removed rather than guarded.
# For the fast local loop (readers 2-3 only, no cargo build) or triage mode, call the script
# directly — it documents `--skip-rust` / `--report` in its own header:
#   node scripts/coercion-parity.mjs --skip-rust
check-coercion:
    node {{justfile_directory()}}/scripts/coercion-parity.mjs

# The two guards over `manifest.yaml`'s `version:` field. They ask DIFFERENT questions
# about the same line, and both are load-bearing.
#
# `check-processor-seed-versions.sh` (R3-34) asks "did THIS branch move the version
# relative to ITS OWN merge base?". `extensions/embedded.rs` skips re-extraction when the
# recorded version matches, so a `compute/` or `ui/` change with no bump is invisible to
# an already-provisioned deployment — it keeps running the OLD kernel while the new
# frontend ships the new view_spec.
#
# `check-manifest-version-claims.sh` (#300) asks "is the version this branch claims still
# FREE?" — against `origin/main` AS IT IS NOW and against every unmerged ref, never against
# the merge base. The first guard structurally cannot answer that: two branches bumping the
# same package both answer its question truthfully while claiming the same number, which is
# exactly what happened on four consecutive branches. Adding the second does not weaken the
# first by one byte; it is not a replacement and the first stays in front of it.
#
# ── WHY THIS IS AN AGGREGATE AND NOT TWO RECIPE LINES ────────────────────────────────
# `just`, like `make`, runs each recipe line as its own command and ABORTS ON THE FIRST
# NON-ZERO EXIT. Two lines here would mean that on any branch the seed-version guard
# reddens, the claims guard would never run at all — and the two guards' failure
# populations are NOT the same branch. The sibling's failures are overlapping, neither contained in the other:
# it reddens on a missing bump, a downgrade, or a missing top-level `version:`, while
# the claims guard DEFERS only on the no-bump case (its "skip ... that is
# check-processor-seed-versions.sh's failure" line, asserted by TEST-4e) and reddens on
# a collision or a stale base instead. A downgrade or a missing `version:` reddens BOTH
# guards on the same package — the overlap is real, and it is exactly why a second line
# would be unreachable: the sibling can redden on X while the claims guard should redden
# on Y, on the same branch. The legs are aggregated, every leg RUNS, and the verdict is
# derived at the end, with `--min-legs 3` as the floor.
#
# `manifest-version-claims-controls` sits immediately in front of the guard it belongs to
# and is DECLARED as `--controls-leg`, the load-bearing position this file documents three
# times: a gate edited without its controls still passing is a gate whose PASS is worth
# nothing. Those controls reconstruct all four of #300's historical collisions as real git
# histories and drive the REAL guard over them, so a claims guard that had quietly stopped
# looking prints its "every other result above is unverified" banner rather than a PASS.
#
# `--min-legs 3` is the floor: a leg silently dropped must redden rather than shrink this
# gate to a green over a smaller set.
#
# ── A STALE-BASE RED IS A POLICY OUTCOME, NOT A BUG ──────────────────────────────────
# The claims guard's STALE BASE verdict reddens a branch whose number is free and
# uncontested, purely because main moved the package while the branch was out. That is
# DELIBERATE: it is what caught #243's false changelog sentence. It is stricter than
# "detect collisions" and WILL redden branches that did nothing wrong. If you hit it, do
# not report it as a false positive — merge or rebase onto current main (the verdict is
# self-clearing by exactly that action) and re-read the changelog prose against the new
# base before you push.
check-processor-versions BASE='origin/main':
    #!/usr/bin/env bash
    set -uo pipefail
    "{{justfile_directory()}}/scripts/check-aggregate.sh" --label 'just check-processor-versions' --min-legs 3 --controls-leg manifest-version-claims-controls <<'LEGS'
    processor-seed-versions "{{justfile_directory()}}/scripts/check-processor-seed-versions.sh" {{BASE}}
    manifest-version-claims-controls node --test "{{justfile_directory()}}/scripts/check-manifest-version-claims.test.mjs"
    manifest-version-claims "{{justfile_directory()}}/scripts/check-manifest-version-claims.sh" {{BASE}}
    LEGS

# The committed architectural-invariant guards. All three shipped as executable scripts
# and were invoked by NO justfile recipe and NO workflow (`.github/workflows/` holds only
# `env-images.yml`) — the same "guard nobody runs" shape as R3-99 and as the processor
# pytest suites before `check-py`. They are cheap (git-grep over tracked files), so they
# belong in the default gate rather than in a reader's good intentions.
#
# NOT WIRED: `scripts/check-no-study-domain-literals.sh`. It FAILS TODAY, and the failure
# is PRE-EXISTING ON MAIN, not branch-introduced: its `stud(y|ies)` regex is
# case-insensitive, so it matches the `EXTENSIBILITY_STUDY` design-doc citations
# throughout `src-app/libs/viz/src/viz-core/**` — an acronym in a comment, not the
# retired `study` domain. Verified: `git show 06d99c65:…/option/types.ts | grep -c
# EXTENSIBILITY_STUDY` = 2 at the merge-base, and this branch touches ZERO files under
# `libs/viz`. Wiring it would gate every future change on an unrelated pre-existing
# failure. The fix belongs to that guard's owner: either exclude the `EXTENSIBILITY_STUDY`
# token or make the domain regex case-sensitive/word-bounded. Tracked, not silently dropped.
# #295 ADDED `check-pub-orphans-controls`, the orphan guard's OWN negative controls, in the
# load-bearing position `check-packages` and `check-guards` already document: a gate edited
# without its controls still passing is a gate whose PASS is worth nothing. #295 cleared this
# guard's first real red (two unconsumed `pub` items on main plus a stale pin), and every way
# of clearing a red guard except the honest one ends with it passing because it stopped
# LOOKING. The controls drive the guard as a subprocess over synthetic trees and assert it
# still goes RED on a new orphan and on a stale pin. `--min-legs` went 6 -> 7 with it: the
# floor is the leg count, so a leg silently dropped reddens instead of shrinking the gate.
#
# It is DECLARED to the runner as `--controls-leg`, not merely placed first. Since #287 a
# controls leg no longer aborts, so the flag is the ONLY thing that still carries the
# property: a run in which the controls fail prints "every other result above is unverified"
# over the other verdicts. Without it, `PASS check-pub-orphans` would print two lines under
# a red control with nothing saying that PASS is worth nothing. The controls themselves scan
# no real tree (only synthetic ones), so they can never redden for an ordinary new orphan and
# misattribute a TREE problem to the GUARD.
#
# #355 ADDS `check-design-citations` and its controls leg. A `docs/design/` or
# `docs/research/` path cited in this tree is a pointer a reader is invited to follow, and
# #315 is what happens when nothing checks that they resolve:
# `docs/design/spatial-storage-layout.md` was cited by seventeen sites, and by ~30 distinct
# section numbers, at a path that was not in `origin/main` — found by a person following a
# citation while planning #301, months after the first one shipped. It belongs HERE rather
# than in `check-guards` because it is a property OF THE TREE (like `check-pub-orphans` and
# `check-test-scope-lists` beside it), not a property of the guard files.
#
# Its controls leg sits immediately in front of it, in the load-bearing position this file
# already documents three times: a gate edited without its controls still passing is a gate
# whose PASS is worth nothing. The controls drive the REAL guard as a subprocess over
# synthetic git repositories and assert it still names the file, the LINE and the missing
# path — and, in the other direction, that a fenced example, a documentation URL and
# `docs/design/*.md` in an ordinary English sentence do NOT fail the build. They scan no
# real tree, so they cannot redden for an ordinary new dangling citation and misattribute a
# TREE problem to the GUARD.
#
# `--min-legs` 7 -> 9 with them, for the reason the paragraph above states: the floor is the
# leg count, so a leg silently dropped reddens instead of shrinking the gate.
#
# ORDER IS NOT DECLARATION here either. `check-aggregate.sh` holds ONE `--controls-leg` and
# it is `check-pub-orphans-controls`, so `check-design-citations-controls` is ORDERED in
# front of the guard it controls but does not raise the "every other result above is
# unverified" banner if it fails. That is the same gap `check-guards` records, filed there
# rather than restated as closed here.
check-invariants:
    #!/usr/bin/env bash
    set -uo pipefail
    "{{justfile_directory()}}/scripts/check-aggregate.sh" --label 'just check-invariants' --min-legs 9 --controls-leg check-pub-orphans-controls <<'LEGS'
    check-kinds-zero-core "{{justfile_directory()}}/scripts/check-kinds-zero-core.sh"
    check-no-legacy-wire "{{justfile_directory()}}/scripts/check-no-legacy-wire.sh"
    check-test-scope-lists node "{{justfile_directory()}}/scripts/check-test-scope-lists.mjs"
    check-pub-orphans-controls node --test "{{justfile_directory()}}/scripts/check-pub-orphans.test.mjs"
    check-pub-orphans node "{{justfile_directory()}}/scripts/check-pub-orphans.mjs"
    check-design-citations-controls node --test "{{justfile_directory()}}/scripts/check-design-citations.test.mjs"
    check-design-citations node "{{justfile_directory()}}/scripts/check-design-citations.mjs"
    check-guards just check-guards
    check-domain just check-domain
    LEGS

# The artifact-model ENFORCEMENT guards (00_CONSOLIDATED_DESIGN §0.3 "Enforcement",
# ITEM-20/21/22). All three are cheap — git+awk, one `cargo metadata` — so they run in
# the default gate rather than in a reader's good intentions.
#
# ORDER IS LOAD-BEARING. `check-guard-integrity.sh` runs FIRST: if a guard has been
# edited without being re-pinned, its own PASS is worthless.
#
# #287 CHANGED HOW THAT IS ENFORCED. The pins are still verified first, but a red
# integrity check no longer ABORTS the rest — aborting is exactly the defect #287 removed,
# and it was hiding `check-env-loop.sh --fast` behind whichever guard failed first. The
# integrity check is declared to the runner as `--controls-leg`, so a run in which it fails
# still exits non-zero AND prints an explicit "every other result above is unverified"
# banner over the other guards' verdicts. The property that mattered — nobody reads a
# guard's PASS as meaningful while its bytes are unverified — is carried by that banner
# instead of by the abort. Stated exactly, because the previous wording ("before anything
# is allowed to report anything") would now describe a property this recipe does not have.
#
# `check-derived-vocabulary-controls` sits immediately in front of the guard it belongs to,
# in the load-bearing position this file already documents twice: a gate edited without its
# controls still passing is a gate whose PASS is worth nothing. It is the committed proof
# that the guard goes RED — on #277s original leak re-introduced into a pinned
# `scripts/*.mjs`, on a domain id one line outside a declared `cyto:guard-vocabulary` block,
# on a block a file tried to grant itself, and on a collapsed scan surface (#304). It drives
# the REAL guard over a synthetic repo and never scans this tree, so it cannot redden for a
# leak that belongs to the `check-derived-vocabulary` leg beside it.
#
# `check-derived-vocabulary.sh` is the DERIVED successor to `check-kinds-zero-core.sh`
# (which is still wired above, and stays: it pins its three ids on a surface this one
# defines differently). The new one reads its forbidden set from
# `src-app/packages/*/manifest.yaml`, so a processor contributed tomorrow is guarded
# tomorrow, with no edit here or there.
#
# `check-no-format-crates.sh` is GREEN and must stay that way. It was RED while ITEM-12
# (delete `serve_core` + the Arrow serve wire) and ITEM-13 (delete `tiledb_serve`) were
# outstanding, because `arrow`/`arrow-ipc` were then direct dependencies of the server;
# both items have landed, both deps are gone (see the NOTE where they used to be declared
# in `src-app/server/Cargo.toml`), and the guard now reports PASS over the resolved graph.
#
# That sentence is corrected rather than deleted because the stale version pre-authorized
# a red AT THE INVOCATION SITE: a reader hitting a failure here was told, by the runner
# itself, that the failure was expected and belonged to someone else's unfinished item.
# A guard whose caller says "this one is supposed to fail" is not wired, it is muted.
# A failure here is now exactly what it says it is — a format-parsing crate became
# linkable into the server, i.e. INV-1 is violated.
# Do NOT weaken it to go green — `check-guard-integrity.sh` will notice, and the
# integration test `workstore::dependency_guard_test` asserts the design-named families
# are still on the denylist.
#
# `check-recipe-pins` is the SAME PROPERTY AS `check-guard-integrity`, ONE LEVEL UP, and it is
# here for a measured reason (#316). `check-guard-integrity` pins the BYTES OF THE GUARD FILES;
# TEST-20/TEST-21 in `scripts/check-aggregate.test.mjs` pin the BYTES OF THE RECIPES that decide
# which guards run at all. Until #316 the second was verified only as a leg of `just check`, so
# a `justfile` recipe edit gated with `just check-guards` — a gate — passed over a stale pin.
# Twice: `check-invariants` at 051c09a1/0bc9063e, `check-guards` at cce0282e. Running a gate is
# not the same as running the test that pins the gate, and the two lived one recipe apart.
#
# Its controls leg sits immediately in front of it, in the load-bearing position this file
# already documents twice. `scripts/check-recipe-pins.mjs` declares no recipe name, no hash and
# no floor of its own — it re-invokes the pinned file's justfile assertions BY NAME and requires
# them to have RUN, not merely to have not-failed. That distinction is the whole guard: `node
# --test --test-name-pattern` exits 0 when its pattern matches nothing, and a `# SKIP`ped test
# exits 0 too.
#
# WHAT IT DOES NOT DO, because three blind rounds established the limit: the RE-PIN LEDGER beside
# the pins records a CLAIM about why a pin moved and guarantees the claim is in the diff; it does
# not verify that the claim is true. Every attempt to machine-verify that was laundered. Judging
# whether a re-pin is EARNED is the reviewer's job, which is what #316 asked for.
#
# STATED EXACTLY, because ORDER IS NOT DECLARATION. `check-aggregate.sh` holds ONE
# `--controls-leg`, and it is `check-guard-integrity`. So `check-recipe-pins-controls` and
# `check-derived-vocabulary-controls` are ORDERED in front of the guards they control — which is
# what makes a reader see the control's verdict first — but neither triggers the "every other
# result above is unverified" banner if it fails. Closing that needs a repeatable
# `--controls-leg` in the shared runner, which is a change to infrastructure several recipes
# depend on and is filed rather than smuggled in here. A comment claiming the banner exists
# would be worse than the gap.
check-guards:
    #!/usr/bin/env bash
    set -uo pipefail
    "{{justfile_directory()}}/scripts/check-aggregate.sh" --label 'just check-guards' --min-legs 7 --controls-leg check-guard-integrity <<'LEGS'
    check-guard-integrity "{{justfile_directory()}}/scripts/check-guard-integrity.sh"
    check-recipe-pins-controls node --test "{{justfile_directory()}}/scripts/check-recipe-pins.test.mjs"
    check-recipe-pins node "{{justfile_directory()}}/scripts/check-recipe-pins.mjs"
    check-derived-vocabulary-controls node --test "{{justfile_directory()}}/scripts/check-derived-vocabulary.test.mjs"
    check-derived-vocabulary "{{justfile_directory()}}/scripts/check-derived-vocabulary.sh"
    check-no-format-crates "{{justfile_directory()}}/scripts/check-no-format-crates.sh"
    check-env-loop-fast bash "{{justfile_directory()}}/scripts/check-env-loop.sh" --fast
    LEGS

# The LOCAL ENV LOOP's own behavioural tier, in full (E5 / #193).
#
# `check-guards` runs its `--fast` half, which needs no container runtime; this runs
# everything, including a real `docker build`, a mount, and an in-sandbox execution. It
# needs docker + bwrap + squashfuse and the staged artifacts (`just env-rootfs-local --all`).
# It REFUSES on a missing tool rather than skipping — a self-test that no-ops on an
# under-tooled box is a green signal certifying nothing.
#
# Behavioural tier for the local env loop (docker + bwrap; hard-fails, never skips).
check-env-loop:
    bash {{justfile_directory()}}/scripts/check-env-loop.sh

# STAGE both envs locally, then prove the whole loop — the one command that establishes
# its own precondition (E5 / #193).
#
# This exists because the INV-2 acceptance test
# (`sandbox::env_image_oci_test::each_locally_built_env_resolves_to_its_own_artifact`)
# needs BOTH envs' artifacts on disk, and the second env has never been published, so no
# fetch can supply it. Without this recipe the test's precondition was reachable only by
# a human remembering to run the loop first — and `just test-sandbox` sets
# `CYTO_TEST_NO_SKIP=1`, which turns that missing precondition into a RED sandbox tier
# rather than a skip. This is the setup step that recipe's comment now points at.
#
# It is deliberately NOT folded into `check-guards`: it runs real docker builds.
#
# Stage every env locally, then run the loop's full behavioural + acceptance tier.
env-loop-verify:
    #!/usr/bin/env bash
    set -euo pipefail
    root="{{justfile_directory()}}"
    # PIN THE CACHE. The staging step honours an ambient CYTO_ENV_ROOTFS_CACHE (it is a
    # documented operator override, and this feature's own tests use it), while the Rust
    # acceptance test resolves artifacts unconditionally from <repo>/.cyto-cache/env-rootfs.
    # With that variable exported the two halves disagree: the recipe stages elsewhere,
    # check-env-loop passes, and then the test PANICS under CYTO_TEST_NO_SKIP=1 saying
    # "build them first" — immediately after this recipe ran exactly that. A recipe whose
    # whole claim is "it establishes its own precondition" must not be able to establish
    # it somewhere the consumer does not look.
    export CYTO_ENV_ROOTFS_CACHE="$root/.cyto-cache/env-rootfs"
    sh "$root/scripts/build-env-rootfs-local.sh" --all
    bash "$root/scripts/check-env-loop.sh"
    # ASSERT A TEST WAS SELECTED. libtest exits 0 when a filter matches ZERO tests, so a
    # rename or a module move would turn this leg into a green no-op that proves nothing
    # about INV-2 — the same zero-tests-collected hazard `run_probe` guards against on its
    # child and `check-env-loop.sh` guards with a derived pass-count floor. An exit code
    # is not evidence that a test ran.
    cd "$root/src-app/server"
    out="$(CONFIG_FILE=config/dev.yaml CYTO_TEST_NO_SKIP=1 \
      cargo test -p cytoanalyst --test integration_tests -- --exact \
      sandbox::env_image_oci_test::each_locally_built_env_resolves_to_its_own_artifact \
      --nocapture --test-threads=1 2>&1)" || { printf '%s\n' "$out"; exit 1; }
    printf '%s\n' "$out"
    grep -qE '^test result: ok\. 1 passed' <<<"$out" || {
      echo "[env-loop-verify] FAIL: the acceptance test did not report exactly 1 passing" >&2
      echo "  test. libtest exits 0 on a filter that matches nothing, so this leg would" >&2
      echo "  otherwise be a green no-op. Has the test been renamed or moved?" >&2
      exit 1
    }

# The DOMAIN-PURITY guards, both halves, in one recipe (WS-B).
#
# `npm run check` already runs the JS guard, but only as one link in a long `&&` chain
# whose first link is `tsc`, and NOTHING ran the Rust twin except a full
# `cargo test --test integration_tests` — which is why a 3-module/3-word server scan
# could sit green for a whole round. This recipe is the short, nameable command that
# runs BOTH over the whole tree:
#   - node scripts/lint-no-domain-in-builtin.mjs  — FE + the whole Rust module tree,
#     nouns in code AND prose, ratcheted against ui/scripts/domain-baseline.json
#   - the WHOLE `domain_surface` module — not a hand-listed subset of it
#
# This recipe used to name three test functions here. `domain_surface` has 28, so 25 of
# them were run by CI and by nothing local, and any test ADDED to the module joined that
# silent majority. `.github/workflows/domain-guard.yml` had already refused the hand-list
# for exactly this reason ("a test ADDED to the twin runs here without anyone remembering
# to list it") — the local gate now runs what CI runs. `scripts/check-test-scope-lists.mjs`
# fails the build if a per-test filter comes back.
#
# Both halves read the SAME baseline, so they cannot drift into disagreeing about what
# is permitted. `exit $RC` at the end: the log is the evidence, never the wrapper's exit.
check-domain:
    #!/usr/bin/env bash
    set -uo pipefail
    RC=0
    cd {{ui_dir}} && node scripts/lint-no-domain-in-builtin.mjs || RC=$?
    cd {{server_dir}} && CONFIG_FILE=config/dev.yaml cargo test --test integration_tests -- \
        --test-threads=1 domain_surface || RC=$?
    exit $RC

# Re-green the domain baseline after FIXING a leak. Shrink-only: it lowers or removes
# entries the tree no longer carries and NEVER adds one, so a new leak still has to be
# argued for by hand with its DOMAIN_AUDIT finding id.
prune-domain-baseline:
    cd {{ui_dir}} && node scripts/lint-no-domain-in-builtin.mjs --prune-baseline

# Regenerate the typed api-client from the live backend types.
# The output dir is server-CWD-relative, so `../ui/openapi` targets the real UI
# workspace (`src-app/ui/openapi`) — NOT a stray `src-app/server/ui/`.
openapi-regen:
    cd {{server_dir}} && CONFIG_FILE=config/dev.yaml cargo run -- --generate-openapi ../ui/openapi

# Regenerate the build gate's EXPORTED PARSE of every env recipe's pin file (#214).
#
# `src-app/env-rootfs/env-pins.generated.json` is the one place the pin files are parsed
# for anything other than installing them. Every other consumer — the smoke-correspondence
# guard, the four python package guards, the two other-package suites, the SOMA
# integration control — reads that artefact instead of writing an eleventh grammar over the
# same text. `docs/design/pin-file-single-parse.md` is why.
#
# The artefact is COMMITTED, and `build.rs` re-derives it and byte-compares on every
# `cargo check`, so it cannot go stale unnoticed. Run this after ANY edit to a recipe's
# `requirements.txt` and commit the result in the same commit as the pin change — the two
# belong together and reviewing them together is half the reason the artefact is committed.
#
# There is no bootstrap deadlock: the env var switches build.rs from comparing to WRITING,
# so a stale artefact never blocks the build that refreshes it.
env-pins-regen:
    cd {{server_dir}} && CONFIG_FILE=config/dev.yaml CYTO_REGEN_ENV_PINS=1 cargo check -p cytoanalyst
    @echo "env-pins-regen: wrote src-app/env-rootfs/env-pins.generated.json — commit it with the pin change"

# Full build (backend binary + frontend bundle).
build:
    cd {{server_dir}} && CONFIG_FILE=config/dev.yaml cargo build --bin cytoanalyst
    cd {{ui_dir}} && npm run build

# ─── THE E2E RUNNERS ─────────────────────────────────────────────────────────
#
# FOUR Playwright configs, FOUR disjoint testDirs, FOUR recipes. One runner per
# directory; `just e2e-all` runs the lot. The partition is enforced, not
# remembered — `npm run check:e2e-routing` (inside `just check`) fails if any spec
# is owned by zero or two configs, if any testDir nests inside another, or if any
# config lacks an npm script + a recipe. See `scripts/check-e2e-routing.mjs`.
#
#   recipe            testDir              server(s) it drives
#   ---------------   ------------------   -------------------------------------
#   e2e               tests/e2e            cargo backend + vite preview, per-worktree ports
#   e2e-viz           tests/viz-e2e        @ziee/viz showcase, per-worktree port (backend-free)
#   e2e-gallery       tests/gallery-e2e    component gallery, per-worktree port (backend-free)
#   e2e-visual        tests/visual         component gallery, per-worktree port (backend-free)
#
# WHY the split is a directory move and not a `testIgnore`: until now the viz specs
# lived at `tests/e2e/visualization/`, INSIDE `playwright.config.ts`'s
# `testDir: './tests/e2e'`, which carried no exclusion. `just e2e` therefore collected
# 95 viz tests — 44% of its 217 — and drove them at the preview port, where the
# `viz-showcase.html` they load does not exist; and NOTHING invoked the viz, gallery
# or visual configs at all. An exclusion list would have re-created the same hazard one
# edit later: it puts the routing in a pattern 60 lines from the spec, so the next
# directory added under `tests/e2e/` is silently swept in again. A directory IS the
# routing, and `playwright.gallery.config.ts` had already written that convention down
# (`tests/gallery-e2e` "so the full-backend config never sweeps these in") — the viz
# suite was the one place that broke it. All 63 files moved as pure `git mv` renames;
# they import nothing outside their own directory, so not one line of spec changed.

# Frontend E2E (Playwright): boots the real backend (embedded Postgres, no
# docker) + the built SPA and drives the full path. In a bare shell run
# `just e2e`; inside a process-killing harness, pre-start the two servers and
# run `npx playwright test` (reuseExistingServer) to avoid the persistent-proc
# killer. Needs `npx playwright install chromium` once.
#
# SCOPE — this is the BACKEND suite only (`tests/e2e/`). It does NOT include the
# backend-free viz / gallery / visual suites; run `just e2e-all` for everything.
# Nor does it include the `@acceptance` tests (`just verify-acceptance`) or the
# `CYTO_E2E_REAL_COMPUTE`-gated specs, which register zero tests without a
# sandbox-executable host — `just e2e-inventory` prints exactly what is missing.
#
# BACKEND e2e (tests/e2e) — cargo backend + vite preview. NOT viz/gallery/visual.
#
# PORTS + DATABASE: per-worktree AND per-run. Both legs walk the shared bind-verified,
# sentinel-proved resolver (`ui/scripts/resolve-harness-port.mjs`), and the DATABASE +
# app-data dir are keyed on the RESOLVED backend port — so two runs in ONE tree no
# longer DROP each other's database. The backend proves itself at `GET /__worktree`
# (`server/src/harness_sentinel.rs`, debug builds only); the preview does it through
# `gallerySentinelPlugin()`. `E2E_BACKEND_PORT` / `E2E_APP_PORT` pin a leg; a pin
# overrides the SEARCH, never the PROOF. These were the fixed literals :3155/:4173.
e2e:
    cd {{ui_dir}} && npm run test:e2e

# The viz module's e2e (`tests/viz-e2e/`). BACKEND-FREE: boots only the @ziee/viz
# showcase and drives it under software-WebGL (swiftshader). This suite is 95 tests —
# before the routing fix it had NO invocation anywhere in the repo.
#
# PORT: per-worktree, derived from the run key and bind-verified, with a `/__worktree`
# sentinel so a server is only ever reused when it PROVES it is this worktree's (was the
# fixed :1421/:1422, which two worktrees silently shared — see the PORT block in
# `playwright.viz.config.ts`). `VIZ_E2E_PORT` / `VIZ_BENCH_PORT` pin them.
#
# VIZ e2e (tests/viz-e2e) — backend-free; @ziee/viz showcase, per-worktree port.
e2e-viz:
    cd {{ui_dir}} && npm run test:e2e:viz

# The component-gallery e2e (`tests/gallery-e2e/`). BACKEND-FREE: gallery vite on a
# PER-WORKTREE port derived from the run key (was the fixed :1487, which two worktrees
# still collided on); GALLERY_E2E_PORT=<n> pins it.
#
# This dir also holds `native-controls.spec.ts` — the RENDERED-DOM half of the
# raw-control guard. `ui/scripts/lint-native-controls.mjs` (wired into `npm run check`)
# reads JSX source, which cannot see a control produced by `createElement`, by a
# dependency, or by anything not written as a literal tag; this spec walks all 94
# gallery surfaces and asserts every control in the LIVE DOM carries a kit `data-slot`.
# It carries its own positive control, so its clean result is a measurement, not a
# vacuous pass. ~5.5 min.
#
# GALLERY e2e (tests/gallery-e2e) — backend-free; component gallery, per-worktree port.
e2e-gallery:
    cd {{ui_dir}} && npm run test:e2e:gallery

# The Layer-A VISUAL suite (`tests/visual/`), the same config `npm run gate:ui`
# drives. BACKEND-FREE: gallery vite on the per-worktree derived port
# (GALLERY_PORT=<n> to pin it).
#
# VISUAL Layer-A e2e (tests/visual) — backend-free; component gallery, per-worktree port.
e2e-visual:
    cd {{ui_dir}} && npm run test:e2e:visual

# The @ziee/viz PACKAGE's own e2e — 20 `tests/e2e/*.e2e.mjs` browser specs that drive
# the showcase directly with `playwright.chromium`, NOT under a playwright.config. Its
# `run-all.mjs` already globs the DIRECTORY on purpose ("the gate must be the DIRECTORY,
# not a list") and refuses to report success on an empty set — but `npm --workspace
# @ziee/viz run test:e2e` was invoked by no recipe and no other script, so all 20 were in
# the same un-runnable state as the viz playwright suite. Same class, different runner.
#
# Unlike the playwright suites this has no `webServer`, so the recipe boots the showcase
# itself and tears it down on every exit path.
#
# PORT: defaults to this worktree's DERIVED showcase port, not a literal. It used to
# default to the fixed :1421 — the same port `playwright.viz.config.ts` pinned — so this
# recipe collided both with a sibling worktree AND with the viz playwright suite in its
# own tree. Pass `PORT=<n>` to pin one.
#
# VIZ-PACKAGE e2e (libs/viz/tests/e2e) — 20 *.e2e.mjs against a booted showcase.
e2e-viz-package PORT="":
    #!/usr/bin/env bash
    set -uo pipefail
    PORT="{{PORT}}"
    if [ -z "$PORT" ]; then
      PORT="$(cd {{ui_dir}} && node scripts/resolve-viz-port.mjs dev)"
    fi
    cd {{justfile_directory()}}/src-app/libs/viz
    npx vite --port "$PORT" --strictPort &
    vite_pid=$!
    trap 'kill "$vite_pid" 2>/dev/null || true' EXIT
    ready=0
    for _ in $(seq 1 90); do
      if curl -sf "http://localhost:$PORT/viz-showcase.html" >/dev/null 2>&1; then ready=1; break; fi
      sleep 1
    done
    if [ "$ready" -ne 1 ]; then
      echo "e2e-viz-package: showcase never came up on :$PORT — refusing to run against nothing"
      exit 1
    fi
    node tests/e2e/run-all.mjs "http://localhost:$PORT"

# EVERY e2e suite, in one invocation. Runs all five to completion (a failing suite does
# not mask the ones after it) and reports a per-suite exit table, failing if any failed.
# This is the recipe that makes "the default run covers everything" true; `just e2e`
# alone deliberately does not.
#
# ALL FIVE e2e suites in one run, with a per-suite exit table.
e2e-all:
    #!/usr/bin/env bash
    set -uo pipefail
    declare -a names=(backend viz gallery visual viz-package)
    declare -a cmds=(
      "cd {{ui_dir}} && npm run test:e2e"
      "cd {{ui_dir}} && npm run test:e2e:viz"
      "cd {{ui_dir}} && npm run test:e2e:gallery"
      "cd {{ui_dir}} && npm run test:e2e:visual"
      "just --justfile {{justfile()}} e2e-viz-package"
    )
    declare -a codes=()
    for i in "${!names[@]}"; do
      echo "══════ e2e-all: ${names[$i]} — ${cmds[$i]} ══════"
      bash -c "${cmds[$i]}"
      codes+=($?)
    done
    rc=0
    echo "══════ e2e-all summary ══════"
    for i in "${!names[@]}"; do
      echo "  ${names[$i]}: exit ${codes[$i]}"
      [ "${codes[$i]}" -ne 0 ] && rc=1
    done
    # `just e2e-all` is still not the whole universe: acceptance + REAL_COMPUTE
    # specs need a sandbox-executable host. Say so rather than let the reader infer
    # that a green here means everything ran.
    #
    # The COUNT is derived from the specs on disk, not typed here. The prose version of
    # this line ("NOT included: @acceptance") was true and useless: it named a category
    # without a size, so a reader comparing "all green" against it had no way to tell
    # whether one test sat out or fifty. The number is the part that makes the omission
    # feel like an omission.
    node -e '
      import("./src-app/ui/scripts/tag-narrowing.mjs").then(m => {
        const n = m.narrowedOut({ testDir: "tests/e2e" })
        console.log(`  NOT included: ${n.tests.length} ${n.tag} test(s) in ${n.files.length} spec ` +
          `file(s) — \`just verify-acceptance\`,`)
        console.log("  plus the CYTO_E2E_REAL_COMPUTE-gated specs — see `just e2e-inventory`.")
      })
    ' || echo "  NOT included: @acceptance + CYTO_E2E_REAL_COMPUTE specs (count unavailable)"
    exit $rc

# WHAT ACTUALLY RUNS — the honest inventory. Per config: the specs on disk, the
# tests Playwright COLLECTS, and (the part that hides) the spec files that collect
# ZERO tests because they are wrapped in a host-capability `if`. `--list` boots no
# server, so this is cheap and safe to run anywhere.
#
# What each runner ACTUALLY collects, incl. spec files that collect ZERO tests.
e2e-inventory:
    cd {{ui_dir}} && node scripts/e2e-inventory.mjs

# ─── REAL-COMPUTE PROCESSOR TIER (tier 4) ────────────────────────────────────
# The tier that runs a PROCESSOR end-to-end: real fixture uploaded → real
# on-ingest converter in a real bwrap sandbox → real UI (picker, selectors,
# Run button) → real job → asserted result. Modelled on ziee's `check-sandbox`
# (its tier 6: "real HTTP → real handler → real bwrap → real command → real
# response").
#
# WHY IT NEEDED TO EXIST
# `just e2e` collects 153 tests; this tier's flag collects 155 — and the 2-test
# delta is only the `@acceptance` tag. The bigger hole is ~17 specs wrapped in
# `test.skip(!REAL_COMPUTE, …)` which are COLLECTED but skipped, and which NO
# recipe in this repo ever ran (`14-workbench/_analysis.ts` documents this
# verbatim). `just verify-acceptance` greps `@acceptance` and so reaches only 2
# of them. This recipe is the invocation for the rest.

# The BACKEND half of the same tier: the Rust integration tests that are gated on a
# sandbox-executable host (`sandbox_executes()` in tests/sandbox/mod.rs, plus the
# rootfs gates in tests/{dataset,workstore,provenance}). Same disease as the e2e
# side — they `record_skip` and print `ok` when no rootfs is reachable.
#
# `CYTO_TEST_NO_SKIP=1` turns each of those skips into a HARD FAILURE. The justfile
# used to note that "nothing in the repo sets that variable, so it defends nothing on
# its own" — this recipe is that missing invoker.
#
# The default FILTER names EVERY module that holds a `record_skip(` test, not just
# `sandbox::`. The comment above already said the gates live in `tests/{dataset,workstore,
# provenance}` too — the filter simply never matched that sentence, so four of the five
# modules' skips stayed permanent under the one recipe built to abolish them (`analysis`
# was not even in the sentence). `scripts/check-test-scope-lists.mjs` re-derives the set
# (from `record_skip` and every `hardening_common` helper that calls it, aliases and all)
# and fails if this list falls behind it again.
#
# Rust integration tests that need a REAL sandbox (skips become failures).
test-sandbox FILTER="analysis:: dataset:: provenance:: sandbox:: workstore::":
    #!/usr/bin/env bash
    set -uo pipefail
    root="{{justfile_directory()}}"
    # PREREQUISITE (E5 / #193): this tier sets CYTO_TEST_NO_SKIP=1, under which a
    # recorded skip PANICS. `sandbox::env_image_oci_test::each_locally_built_env_…`
    # needs BOTH envs' artifacts staged, and the second env has never been published, so
    # no fetch can supply it. Run `just env-loop-verify` (or `just env-rootfs-local
    # --all`) once on this box first, or that test will turn this tier red for a missing
    # SETUP step rather than a real defect.
    #
    # CAPTURE THE STATUS, then read the last line. `cmd | tail -1` exits with TAIL's
    # status, so a FAILED preflight yielded an empty `sq` here and the tier continued on
    # whatever ambient seam the shell carried. It was safe only by accident — the
    # preflight happens to write nothing to stdout on its failure paths, so the `[ -s ]`
    # test below caught it — and nothing asserted that property, so the first diagnostic
    # ever printed to stdout on a failure path would have re-opened it. (E5 / #193.)
    pf_out="$(bash "$root/scripts/e2e-processors-preflight.sh")" || {
      echo "[preflight] FAILED — refusing to run the tier against an unverified env." >&2
      exit 1
    }
    sq="$(printf '%s\n' "$pf_out" | tail -1)"
    if [ -z "$sq" ] || [ ! -s "$sq" ]; then
      echo "[test-sandbox] FAIL: preflight did not yield a usable env image." >&2
      exit 1
    fi
    echo "[test-sandbox] seam 1: CYTO_ENV_ROOTFS_SQUASHFS=$sq"
    echo "[test-sandbox] CYTO_TEST_NO_SKIP=1 — a rootfs-gated skip is a FAILURE here"
    # `env_image_oci_test` reads its OWN var (not the seam) for the real-stack test.
    # Same file, different name — feeding it here is what stops that test from being
    # a permanent skip. Found by CYTO_TEST_NO_SKIP=1 turning it into a named failure.
    echo "[test-sandbox] CYTO_REAL_ROOTFS_SQUASHFS=$sq (real scientific-stack OCI test)"
    # The signed-GHCR verification test additionally wants a RELEASE build + an
    # `oras login ghcr.io`, so it stays opt-in: `CYTO_REAL_GHCR_VERIFY=1 just test-sandbox`.
    # Leaving it unset makes it a hard FAILURE under no-skip, which is honest — run
    # `just test-sandbox-oci` for the full real-registry pass.
    # E6 (#194) — ALSO hand this tier the PER-ENV seams for every locally staged env.
    #
    # `sq` above is the BARE seam, and a bare seam serves exactly ONE env: the deployment
    # default (`env_image.rs::seam_serves`). That is all this tier needed while every
    # analysis ran in one image. It is no longer: an analysis that DECLARES a second env
    # (the R walking skeleton) is served only by `CYTO_ENV_ROOTFS_SQUASHFS__<env-id>`, so
    # without these lines its tests would self-skip — and under `CYTO_TEST_NO_SKIP=1` a
    # self-skip PANICS, turning this tier red for a missing SETUP step rather than a
    # defect. Exactly the failure mode the PREREQUISITE note above already describes for
    # E5's own test.
    #
    # DERIVED, never enumerated: `--print-seam` emits one `env(1)` assignment per env that
    # is actually staged, each re-verified against the sha256 the build loop recorded
    # beside it. This recipe names no env.
    #
    # It is NOT a no-op when nothing is staged — an earlier version of this comment said
    # it was. The script `die`s (exit 1) in that case as in every other refusal, and this
    # recipe REFUSES on it, because the tier's own PREREQUISITE above already requires a
    # local build and continuing would exit 0 on a green suite with the reason scrolled
    # past.
    #
    # `env(1)` and not `export`: an env id contains `-`, so the variable name is not a
    # legal shell identifier and no assignment form can set it.
    #
    # …and for the same reason `env` must invoke `cargo` DIRECTLY, with no shell in
    # between. A POSIX shell is entitled to DROP inherited environment variables whose
    # names are not valid identifiers, and `dash` does: `env 'A__b-c=1' sh -c env` prints
    # nothing, while `env 'A__b-c=1' env` prints it. Measured, not assumed. Wrapping this
    # line in an extra `sh -c` would silently un-set every per-env seam and send the tier
    # straight back to self-skipping.
    # CAPTURE THE STATUS — and this recipe of all places knows why: the block above
    # headed `CAPTURE THE STATUS, then read the last line` records the last time one was
    # read through a pipe here. `--print-seam` does not only report; it RE-VERIFIES each staged artifact
    # against the sha256 the build loop recorded beside it, and it `die`s on the FIRST
    # failure, which suppresses every seam including the good ones. Discarding its stderr
    # and its status would turn "one artifact's bytes do not match what built them" — a
    # substitution alarm — into the message "nothing is staged, run --all", i.e. a false
    # remedy for a real integrity failure. So its stderr is captured and REPRINTED VERBATIM.
    #
    # BE EXACT ABOUT WHAT THE STATUS DOES, because two earlier versions of this comment
    # were not. The refusal below branches on the SEAM COUNT; the status is interpolated
    # into the diagnostic and nothing else. `--print-seam` exits non-zero for SEVERAL
    # distinct reasons and this recipe classifies none of them — which is why its words
    # are reprinted rather than summarized.
    seam_err="$(mktemp)"
    seam_lines="$(sh "$root/scripts/build-env-rootfs-local.sh" --print-seam 2>"$seam_err")"
    seam_status=$?
    seams=()
    while IFS= read -r line; do
      case "$line" in
        "env '"*) kv="${line#env \'}"; seams+=("${kv%\'}") ;;
      esac
    done <<< "$seam_lines"
    #
    # TWO BRANCHES, not three. `--print-seam` always prints at least one `env '...'` line
    # before exiting 0, so "zero seams with status 0" is unreachable and a third branch
    # for it was dead code. Which refusal produced the zero is the SCRIPT'S to say, not
    # this recipe's: its words are reprinted verbatim below.
    if [ "${#seams[@]}" -gt 0 ]; then
      echo "[test-sandbox] per-env seams: ${#seams[@]} (declared envs served by name)"
    else
      echo "[test-sandbox] REFUSING: the per-env seam listing produced nothing (exit $seam_status)." >&2
      echo "[test-sandbox] The listing does not continue past its first failure, and one of the things it refuses on is a staged artifact no longer matching the sha256 the build loop recorded beside it — a substitution alarm, not a missing build. Read its own words below before assuming which of its refusals this is:" >&2
      cat "$seam_err" >&2
      echo "[test-sandbox] This tier already REQUIRES a local build (see the PREREQUISITE note above) — an analysis declaring a NON-DEFAULT env would otherwise self-skip and PANIC under CYTO_TEST_NO_SKIP=1. Continuing would burn several minutes of cargo and then exit 0 on a green suite with that message scrolled past, which is the silence this replaced. If the words above say nothing is staged: sh scripts/build-env-rootfs-local.sh --all" >&2
      rm -f "$seam_err"
      exit 1
    fi
    rm -f "$seam_err"
    cd "$root/src-app/server"
    env ${seams[@]+"${seams[@]}"} \
    CONFIG_FILE=config/dev.yaml \
    CYTO_ENV_ROOTFS_SQUASHFS="$sq" CYTO_REAL_ROOTFS_SQUASHFS="$sq" \
    CYTO_REAL_GHCR_VERIFY="${CYTO_REAL_GHCR_VERIFY:-}" CYTO_TEST_NO_SKIP=1 \
      cargo test --test integration_tests -- --test-threads=1 {{FILTER}}

# The one test `just test-sandbox` cannot satisfy by itself: the REAL signed-GHCR
# verification (resolve → cosign-verify → pull → mount against the live registry).
# It needs a RELEASE build, an `oras login ghcr.io`, and host cosign — so it is a
# separate, slower, opt-in recipe rather than a permanent hard failure in the
# default one.
#
# Real signed-GHCR verify (release build + oras login + cosign; slow).
test-sandbox-oci:
    #!/usr/bin/env bash
    set -uo pipefail
    root="{{justfile_directory()}}"
    command -v cosign >/dev/null 2>&1 || { echo "[test-sandbox-oci] FAIL: cosign not on PATH — https://docs.sigstore.dev/cosign/installation/" >&2; exit 1; }
    # PREREQUISITE (E5 / #193): this tier sets CYTO_TEST_NO_SKIP=1, under which a
    # recorded skip PANICS. `sandbox::env_image_oci_test::each_locally_built_env_…`
    # needs BOTH envs' artifacts staged, and the second env has never been published, so
    # no fetch can supply it. Run `just env-loop-verify` (or `just env-rootfs-local
    # --all`) once on this box first, or that test will turn this tier red for a missing
    # SETUP step rather than a real defect.
    #
    # CAPTURE THE STATUS, then read the last line. `cmd | tail -1` exits with TAIL's
    # status, so a FAILED preflight yielded an empty `sq` here and the tier continued on
    # whatever ambient seam the shell carried. It was safe only by accident — the
    # preflight happens to write nothing to stdout on its failure paths, so the `[ -s ]`
    # test below caught it — and nothing asserted that property, so the first diagnostic
    # ever printed to stdout on a failure path would have re-opened it. (E5 / #193.)
    pf_out="$(bash "$root/scripts/e2e-processors-preflight.sh")" || {
      echo "[preflight] FAILED — refusing to run the tier against an unverified env." >&2
      exit 1
    }
    sq="$(printf '%s\n' "$pf_out" | tail -1)"
    [ -s "$sq" ] || { echo "[test-sandbox-oci] FAIL: preflight yielded no env image." >&2; exit 1; }
    cd "$root/src-app/server"
    CONFIG_FILE=config/dev.yaml \
    CYTO_ENV_ROOTFS_SQUASHFS="$sq" CYTO_REAL_ROOTFS_SQUASHFS="$sq" \
    CYTO_REAL_GHCR_VERIFY=1 CYTO_TEST_NO_SKIP=1 \
      cargo test --release --test integration_tests -- --test-threads=1 \
        sandbox::env_image_oci_test::

# One-time (~5 s, ~300 MB): fetch + cache the analysis env image squashfs.
# Cached at .cyto-cache/env-rootfs/; re-running is a no-op on a digest match.
# Needs a GitHub credential with read:packages (`gh auth login` or $GITHUB_TOKEN)
# — ghcr.io/ziee-ai/cyto-env/* is NOT anonymously pullable.
#
# NO DEFAULT ENV-ID IS TYPED HERE. This parameter used to default to a literal
# analysis-domain id, which made adding a second domain a BUILD-RECIPE edit — the one
# thing the processor-package model exists to prevent. The env set is DATA
# (`contributes.converters[].env` in the manifests), so the script derives it: sole
# declared env ⇒ used, several ⇒ it asks. See the header of `fetch-env-rootfs.sh`.
#
# Variadic, so flags reach the script too: `just env-rootfs --offline`,
# `just env-rootfs --print-path`, `just env-rootfs <env-id>`.
#
# Fetch + cache the analysis env-image squashfs (one-time, ~5 s).
env-rootfs *ARGS:
    bash {{justfile_directory()}}/scripts/fetch-env-rootfs.sh {{ARGS}}

# BUILD an env image locally and stage it — no GHCR, no token, no CI workflow.
# E5 / #193. This is the counterpart of `env-rootfs`: that one PULLS a published
# image, this one BUILDS the recipe on your box and stages the result at the same
# cache path, so the two are interchangeable at the air-gap seam. It is the only
# way to run an env that has never been published — which, while #80 stands and
# the publish workflow is `.disabled`, is every env but the one already in GHCR.
#
# NO DEFAULT ENV-ID IS TYPED HERE, for the same reason `env-rootfs` types none:
# the env set is DATA, derived from the recipe tree. With more than one recipe the
# script refuses and names them; `--all` covers every one.
#
#   just env-rootfs-local --env <id>     # build + stage one
#   just env-rootfs-local --all          # build + stage every recipe
#   just env-rootfs-local --print-seam   # the `env '...'` prefix for what is staged
#
# It does NOT publish, and does not make publishing possible (#80 is untouched).
# A locally built image carries no CI signature — see the runbook's
# "The local build + run loop" section for the verification difference.
#
# Build + stage an env-image squashfs LOCALLY (no GHCR).
env-rootfs-local *ARGS:
    sh {{justfile_directory()}}/scripts/build-env-rootfs-local.sh {{ARGS}}

# Is this host able to run the real-compute tier? Hard-FAILS with remediation
# for each missing precondition, and ends with an EXECUTION CANARY that actually
# runs the interpreter inside bwrap against the image (static checks alone can
# all pass while execution still fails).
#
# `--seams` additionally proves EVERY locally staged env executes under bwrap and
# prints the multi-env `env '...' '...'` command prefix as its last line (E5).
#
# Can this host run the real-compute tier? (hard-fails, never skips)
e2e-processors-preflight *ARGS:
    bash {{justfile_directory()}}/scripts/e2e-processors-preflight.sh {{ARGS}}

# THE TIER. Runs the processor-journey e2e directories against a REAL sandbox.
#
#   just env-rootfs          # once
#   just e2e-processors      # every time
#
# LOUD SKIP CONTRACT — the whole point of this recipe. Three fail-closed layers:
#   1. preflight FAILS (never skips) if bwrap/squashfuse/userns/fuse/the image is
#      missing, naming the exact remediation.
#   2. `CYTO_ENV_ROOTFS_SQUASHFS` (SEAM 1 — content-hashed, digest recorded,
#      capsule EXECUTES) is exported into the run, so the specs' host-capability
#      guards are satisfied rather than dodged. Seam 2 (`CYTO_ENV_ROOTFS_DIR`) is
#      deliberately NOT used: it records no digest and leaves the run UNPINNED.
#   3. the JUnit report is parsed fail-closed — `tests == 0`, any failure/error,
#      and ANY skip are each a hard FAIL. Under CYTO_E2E_REAL_COMPUTE a skip means
#      a capability this host was supposed to have is missing, so a skip is NOT a
#      pass. This is the mechanism that stops a broken compute layer from looking
#      identical to a working one.
#
# SCOPE is by DIRECTORY, never a hand-written file list — a list silently drops
# the spec somebody adds tomorrow. A new processor-journey spec dropped into any
# of these directories is picked up with no edit here.
#
# FRESH BACKEND: this used to warn that `reuseExistingServer` is TRUE off-CI, so a
# backend already listening would be REUSED and would never see the rootfs seam. That
# is no longer the default — reuse is OPT-IN (`E2E_REUSE=1`, or the repo-wide
# `HARNESS_REUSE_SERVER=1`), and off by default, so every invocation boots its own
# backend with the seam exported and resets its own database. CI=1 is no longer an
# input to the decision. Set E2E_REUSE=1 for fast iteration, but only when your
# existing backend was booted WITH the seam exported — and note it can only ever adopt
# a server that PROVES it was compiled from this worktree.
#
# Ports/DB are derived per worktree and per run; `E2E_BACKEND_PORT` / `E2E_APP_PORT`
# pin them for a one-off (same knobs as `just verify-acceptance`).
#
# REAL-COMPUTE processor e2e — a processor run in a real sandbox, driven via the UI.
e2e-processors *DIRS:
    #!/usr/bin/env bash
    set -uo pipefail
    root="{{justfile_directory()}}"
    # (1) preflight — hard fail, never a skip. Also resolves the seam-1 path.
    # CAPTURE THE STATUS, then read the last line. `cmd | tail -1` exits with TAIL's
    # status, so a FAILED preflight yielded an empty `sq` here and the tier continued on
    # whatever ambient seam the shell carried. It was safe only by accident — the
    # preflight happens to write nothing to stdout on its failure paths, so the `[ -s ]`
    # test below caught it — and nothing asserted that property, so the first diagnostic
    # ever printed to stdout on a failure path would have re-opened it. (E5 / #193.)
    pf_out="$(bash "$root/scripts/e2e-processors-preflight.sh")" || {
      echo "[preflight] FAILED — refusing to run the tier against an unverified env." >&2
      exit 1
    }
    sq="$(printf '%s\n' "$pf_out" | tail -1)"
    if [ -z "$sq" ] || [ ! -s "$sq" ]; then
      echo "[e2e-processors] FAIL: preflight did not yield a usable env image." >&2
      exit 1
    fi
    dirs="{{DIRS}}"
    if [ -z "$dirs" ]; then
      # EVERY dir holding a REAL_COMPUTE-gated spec. `workbench` was missing, so its
      # gated specs skipped in the one tier whose whole premise is that a skip is a
      # failure. Re-derived + enforced by scripts/check-test-scope-lists.mjs.
      dirs="tests/e2e/14-declarative-qc tests/e2e/14-workbench tests/e2e/provenance tests/e2e/workbench tests/e2e/15-visualize tests/e2e/virtual-dataset"
    fi
    junit="$root/target/e2e-processors-junit.xml"
    mkdir -p "$(dirname "$junit")"; rm -f "$junit"
    # Large real fixtures are not committed (one is a 4.5 MB matrix with real embedding
    # coordinates). Convention: stage them in .cyto-cache/fixtures/ and the tier points the
    # specs at that DIRECTORY. The recipe names no dataset FILE and no per-spec env var — it
    # used to export a domain-named variable holding a domain-named filename, which made the
    # recipe a place a new domain would have to edit. Each spec resolves its own fixture
    # inside the staging dir (and may still override just its own, per-spec).
    # Without a staged fixture the spec needing it skips — and a skip FAILS this tier by
    # design, so the gate would be red for a missing file rather than a bug.
    fixtures="$root/.cyto-cache/fixtures"
    if [ -z "${CYTO_E2E_FIXTURES:-}" ] && [ -d "$fixtures" ]; then
      export CYTO_E2E_FIXTURES="$fixtures"
      echo "[e2e-processors] fixtures: CYTO_E2E_FIXTURES=$CYTO_E2E_FIXTURES"
    fi
    echo "[e2e-processors] seam 1: CYTO_ENV_ROOTFS_SQUASHFS=$sq"
    echo "[e2e-processors] dirs:   $dirs"
    cd "$root/src-app/ui"
    set +e
    CYTO_ENV_ROOTFS_SQUASHFS="$sq" \
    CYTO_E2E_REAL_COMPUTE=1 CYTO_E2E_MULTIMODAL=1 \
    CI="${CI:-1}" PLAYWRIGHT_JUNIT="$junit" \
      npx playwright test $dirs --workers=1
    pw_exit=$?
    set -e
    echo "[e2e-processors] playwright exit: $pw_exit"
    # (3) fail-closed JUnit accounting — the same shape `verify-acceptance` uses.
    if [ ! -f "$junit" ]; then echo "[e2e-processors] FAIL: no junit report at $junit"; exit 1; fi
    node -e '
      const fs=require("fs");const p=process.argv[1];let x;
      try{x=fs.readFileSync(p,"utf8")}catch(e){console.error(`[e2e-processors] FAIL: junit report unreadable (${p}): ${e.message}`);process.exit(1)}
      const m=/<testsuites[^>]*>/.exec(x);
      if(!m){console.error("[e2e-processors] FAIL: no <testsuites> element — refusing to infer a result from an unrecognised report.");process.exit(1)}
      const g=n=>{const r=new RegExp(n+"=\"(\\d+)\"").exec(m[0]);return r?+r[1]:null};
      const tests=g("tests");
      if(tests===null){console.error("[e2e-processors] FAIL: <testsuites> carries no tests attribute — nothing here proves a test executed.");process.exit(1)}
      const fail=g("failures")??0,err=g("errors")??0,skip=g("skipped")??0;
      console.log(`[e2e-processors] collected=${tests} failed=${fail} errors=${err} skipped=${skip} passed=${tests-fail-err-skip}`);
      if(tests<1){console.error("[e2e-processors] FAIL: 0 tests executed — an empty selection is not a pass.");process.exit(1)}
      // Do not lean on the playwright exit code alone: this gate must be fail-closed
      // even if the runner ever exits 0 with failures recorded in the report.
      if(fail>0||err>0){console.error(`[e2e-processors] FAIL: ${fail} failure(s) + ${err} error(s) in the report.`);process.exit(1)}
      if(skip>0){
        // non-greedy + \s-anchored: a greedy [^>]*name=" backtracks into classname="
        const names=[...x.matchAll(/<testcase\s[^>]*?name="([^"]*)"[^>]*>\s*<skipped/g)].map(r=>r[1]);
        console.error(`[e2e-processors] FAIL: ${skip} skip(s) under CYTO_E2E_REAL_COMPUTE=1 — a skip is not a pass.`);
        for(const n of names) console.error(`    skipped: ${n}`);
        console.error("  Each of these needs a host capability this tier was supposed to provide.");
        process.exit(1);
      }
    ' "$junit"
    exit $pw_exit

# THE ACCEPTANCE GATE — the invocation `playwright.config.ts` and
# `tests/e2e/provenance/filter-save-records-recipe.spec.ts` both point the reader at.
# It did not exist (R4C-04); both references were dangling.
#
# It runs exactly ONE thing: the `@acceptance`-tagged spec(s), positively selected.
#
#  1. `CYTO_E2E_REAL_COMPUTE=1` — drops `playwright.config.ts`'s `grepInvert: /@acceptance/`,
#     so the tagged specs are COLLECTED here. They commit a GENUINE `cell.filter` sandbox
#     run, so a default run on a sandbox-less host excludes them BY TAG — an exclusion that
#     lives in the config + this invocation, in one greppable place, rather than inside the
#     spec. On THIS host the spec cannot opt out: it must actually pass.
#     Requires a sandbox-executable host (bwrap + a staged analysis rootfs).
#  2. `--grep @acceptance` — POSITIVE selection, so what ran is recorded in the invocation
#     itself instead of left to an undisclosed caller filter. (R6-D3: round 4b reported
#     `passed=10` as this recipe's result; that cannot have been the unfiltered suite, and
#     the filter that produced it was never written down.)
#  3. A JUnit XML report (`PLAYWRIGHT_JUNIT`), parsed FAIL-CLOSED. `tests == 0`, a
#     `<testsuites>` with no attributes, a `<testsuite>`-only document and an unreadable
#     report are each a hard FAIL. Before R6-D2 all four printed `collected=0 … passed=0`
#     and exited 0 — the gate could pass having executed NOTHING. That is exactly the
#     hazard (1) and (2) now depend on it to close: a `--grep` that selects nothing must
#     not read as green. A non-zero `skipped` also FAILS — under CYTO_E2E_REAL_COMPUTE a
#     skip means a capability this host was supposed to have is missing.
#
# R6-D1 — REMOVED from this recipe: `CYTO_TEST_NO_SKIP=1`, `CYTO_TEST_SKIP_LEDGER`, and the
# "skip ledger is 0 lines" assertion, which the header used to advertise as two of three
# defences. Both env vars are read ONLY by `server/tests/dataset/hardening_common.rs` — the
# RUST integration-test binary — which `npx playwright test` never spawns. The ledger was
# therefore empty BY CONSTRUCTION and "0 lines" was a tautology, not a measurement. The
# mechanism itself is still load-bearing for `cargo test` invocations of the Rust tier and
# is untouched; only this recipe's false claim to be exercising it is gone. (See the
# round-6 correction in `.lifecycle/filter-provenance/FIX_ROUND-4.md` §6.2. NOTE the
# consequence: `CYTO_TEST_NO_SKIP=1` once again has NO invoker anywhere in the repo —
# R3-94/R3-116's original finding — because this recipe never really was one.)
#
# Ports/DB are ISOLATED PER WORKTREE AND PER RUN with no flags at all — the resolver
# picks a bind-verified port for each leg and the database name is keyed on it. Pin a
# leg only for a one-off (`E2E_BACKEND` is DERIVED from the resolved port; setting it
# to a disagreeing value is a hard startup failure rather than a silent split):
#   E2E_BACKEND_PORT=3660 E2E_APP_PORT=3661 just verify-acceptance
verify-acceptance:
    #!/usr/bin/env bash
    set -euo pipefail
    junit="{{justfile_directory()}}/target/acceptance-junit.xml"
    mkdir -p "$(dirname "$junit")"
    rm -f "$junit"
    cd {{ui_dir}}
    set +e
    CYTO_E2E_REAL_COMPUTE=1 PLAYWRIGHT_JUNIT="$junit" \
      npx playwright test --grep '@acceptance' --workers=1
    pw_exit=$?
    set -e
    echo "[verify-acceptance] playwright exit: $pw_exit"
    # (3) machine-readable counts from the junit report — FAIL CLOSED.
    if [ ! -f "$junit" ]; then echo "[verify-acceptance] FAIL: no junit report at $junit"; exit 1; fi
    node -e '
      const fs=require("fs");const p=process.argv[1];let x;
      try{x=fs.readFileSync(p,"utf8")}catch(e){console.error(`[verify-acceptance] FAIL: junit report unreadable (${p}): ${e.message}`);process.exit(1)}
      const m=/<testsuites[^>]*>/.exec(x);
      if(!m){console.error(`[verify-acceptance] FAIL: no <testsuites> element in ${p} — this gate counts only that shape and refuses to infer a result from an unrecognised report.`);process.exit(1)}
      const g=n=>{const r=new RegExp(n+"=\"(\\d+)\"").exec(m[0]);return r?+r[1]:null};
      const tests=g("tests");
      if(tests===null){console.error("[verify-acceptance] FAIL: <testsuites> carries no tests attribute — nothing in this report proves a test executed.");process.exit(1)}
      const fail=g("failures")??0,err=g("errors")??0,skip=g("skipped")??0;
      console.log(`[verify-acceptance] collected=${tests} failed=${fail} errors=${err} skipped=${skip} passed=${tests-fail-err-skip}`);
      if(tests<1){console.error("[verify-acceptance] FAIL: 0 tests executed — an empty selection is not a pass (did --grep @acceptance match nothing?)");process.exit(1)}
      if(skip>0){console.error(`[verify-acceptance] FAIL: ${skip} playwright skip(s) under CYTO_E2E_REAL_COMPUTE=1 — a skip is not a pass`);process.exit(1)}
    ' "$junit"
    exit $pw_exit

# Gallery A7 boot canary — render-every-surface runtime-health (backend-free).
# Boot the gallery server first: `just gallery` (bg), then run this. Needs
# `npx playwright install chromium` once.
#
# NO FIXED PORT. Both recipes derive the SAME per-worktree port from the unified
# run key (`@ziee/gallery/scripts/lib/run-key`), so `just gallery` in worktree A
# and `just gallery-runtime` in worktree B cannot meet. The previous
# `GALLERY_PORT=1420` here pinned every worktree on this box to ONE port, which is
# how the frontend gate spent a session auditing sibling worktrees' code. Pin one
# yourself with `GALLERY_PORT=<n> just gallery-runtime` if you really need to.
gallery:
    cd {{ui_dir}} && npm run gallery
gallery-runtime:
    cd {{ui_dir}} && npm run gallery:runtime -- --report-only

# PRE-LAND FRONTEND GATE (run this on the branch worktree before landing).
# Diff-triggered: does nothing unless the diff vs `origin/main` touches
# src-app/ui/, src-app/libs/, or src-app/packages/*/ui/. When it does, it
# boots the gallery and runs the runtime-health pass, failing on any gating HIGH
# finding (console error / pageerror / failed request / crash / WCAG-AA contrast).
# Unlike `gallery-runtime` above this is NOT --report-only: it gates.
#
# You NO LONGER need to pass your own port on a multi-worktree box: the port is
# derived per worktree from the run key, and a server the gate did not start is
# reused ONLY when its `/__worktree` sentinel proves it is serving THIS worktree
# (otherwise the gate steps aside to a free port and boots its own). The old
# advice — "ALWAYS pass your own port" — was a human workaround for a default that
# was a shared mutable resource; forgetting it once made the gate report 90 failing
# surfaces for a SIBLING worktree's code on a clean tree.
#
# Args are POSITIONAL (just does not take NAME=value for recipe params):
#   just preland-frontend                 # derived port, base origin/main
#   just preland-frontend 1487            # pin a port anyway
#   just preland-frontend "" some/base    # derived port, other base
# For the FULL four-criteria pass (tsc + lint + runtime + visual) call the script
# directly with --gate-ui: node scripts/preland-frontend-health.mjs --gate-ui
preland-frontend PORT="" BASE="origin/main":
    node {{justfile_directory()}}/scripts/preland-frontend-health.mjs {{ if PORT != "" { "--port " + PORT } else { "" } }} --base {{BASE}}
