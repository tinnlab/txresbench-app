# TxResBench task runner. Mirrors the recipe NAMES the txresbench lifecycle gates
# shell out to (`just openapi-regen`, `just check`, `just test`) so the shared
# lifecycle scripts work once they're app-parameterized (SDK_GAPS C-1).

server_dir := justfile_directory() / "src-app/server"
ui_dir := justfile_directory() / "src-app/ui"

# Default: list recipes.
default:
    @just --list

# Backend integration tests. The harness gives each test its own SQLite file
# (create + migrate + delete; txresbench-test-harness) — no database cluster, no
# Postgres needed. Per-test file isolation makes parallel safe; keep
# --test-threads modest on a shared host.
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
# #287's ten legs became FIVE in the strip node (ITEM-2): `check-py`, `check-packages`,
# `check-coercion`, `check-processor-versions` and `check-r-regime` verified the
# single-cell processor packages / env-rootfs recipes / coercion corpus, and those trees
# are deleted with the gates. The removal is a plan decision, not a repair, and it is
# recorded in the same diff as the recipe edit (the `--min-legs` floor moved with it, as
# the runner requires).
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
    "{{justfile_directory()}}/scripts/check-aggregate.sh" --label 'just check' --min-legs 5 --controls-leg check-aggregate-controls <<'LEGS'
    check-aggregate-controls node --test "{{justfile_directory()}}/scripts/check-aggregate.test.mjs"
    cargo-check-workspace cd {{server_dir}} && CONFIG_FILE=config/dev.yaml cargo check --workspace --tests
    ui-npm-check cd {{ui_dir}} && npm run check
    ui-npm-build cd {{ui_dir}} && npm run build
    check-invariants just check-invariants
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
# The strip node (ITEM-2) REMOVED the single-cell legs of this aggregate:
# `check-kinds-zero-core.sh` + `check-no-legacy-wire.sh` (processor kind and workstore
# wire guards — their subjects are deleted with the processor packages and the
# workstore module, ITEM-2/3) and `check-design-citations` + its controls (their
# subject `docs/design` mostly went; the guard's allowlist split was the only
# alternative, and ITEM-5 owns the survivor-doc citations). The remaining six legs
# are the tree-property and enforcement guards of the kept surface.
check-invariants:
    #!/usr/bin/env bash
    set -uo pipefail
    "{{justfile_directory()}}/scripts/check-aggregate.sh" --label 'just check-invariants' --min-legs 5 --controls-leg check-pub-orphans-controls <<'LEGS'
    check-test-scope-lists node "{{justfile_directory()}}/scripts/check-test-scope-lists.mjs"
    check-pub-orphans-controls node --test "{{justfile_directory()}}/scripts/check-pub-orphans.test.mjs"
    check-pub-orphans node "{{justfile_directory()}}/scripts/check-pub-orphans.mjs"
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
# The strip node (ITEM-2) removed the single-cell guards from this aggregate:
# `check-recipe-pins*` and `check-derived-vocabulary*` (env-rootfs pin recipes +
# processor-vocabulary guard — both subjects deleted in ITEM-2) and
# `check-env-loop.sh --fast` (the analysis-rootfs local env loop). The remaining
# four legs are the kept enforcement guards.
check-guards:
    #!/usr/bin/env bash
    set -uo pipefail
    "{{justfile_directory()}}/scripts/check-aggregate.sh" --label 'just check-guards' --min-legs 4 --controls-leg check-guard-integrity <<'LEGS'
    check-guard-integrity "{{justfile_directory()}}/scripts/check-guard-integrity.sh"
    check-method-env-images-controls node --test "{{justfile_directory()}}/scripts/check-method-env-images.test.mjs"
    check-method-env-images bash "{{justfile_directory()}}/scripts/check-method-env-images.sh"
    check-no-format-crates "{{justfile_directory()}}/scripts/check-no-format-crates.sh"
    LEGS


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

# Full build (backend binary + frontend bundle).
build:
    cd {{server_dir}} && CONFIG_FILE=config/dev.yaml cargo build --bin txresbench
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
#   e2e-viz           tests/viz-e2e        @txresbench/viz showcase, per-worktree port (backend-free)
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
# `TXR_E2E_REAL_COMPUTE`-gated specs, which register zero tests without a
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

# The viz module's e2e (`tests/viz-e2e/`). BACKEND-FREE: boots only the @txresbench/viz
# showcase and drives it under software-WebGL (swiftshader). This suite is 95 tests —
# before the routing fix it had NO invocation anywhere in the repo.
#
# PORT: per-worktree, derived from the run key and bind-verified, with a `/__worktree`
# sentinel so a server is only ever reused when it PROVES it is this worktree's (was the
# fixed :1421/:1422, which two worktrees silently shared — see the PORT block in
# `playwright.viz.config.ts`). `VIZ_E2E_PORT` / `VIZ_BENCH_PORT` pin them.
#
# VIZ e2e (tests/viz-e2e) — backend-free; @txresbench/viz showcase, per-worktree port.
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

# The @txresbench/viz PACKAGE's own e2e — 20 `tests/e2e/*.e2e.mjs` browser specs that drive
# the showcase directly with `playwright.chromium`, NOT under a playwright.config. Its
# `run-all.mjs` already globs the DIRECTORY on purpose ("the gate must be the DIRECTORY,
# not a list") and refuses to report success on an empty set — but `npm --workspace
# @txresbench/viz run test:e2e` was invoked by no recipe and no other script, so all 20 were in
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
        console.log("  plus the TXR_E2E_REAL_COMPUTE-gated specs — see `just e2e-inventory`.")
      })
    ' || echo "  NOT included: @acceptance + TXR_E2E_REAL_COMPUTE specs (count unavailable)"
    exit $rc

# WHAT ACTUALLY RUNS — the honest inventory. Per config: the specs on disk, the
# tests Playwright COLLECTS, and (the part that hides) the spec files that collect
# ZERO tests because they are wrapped in a host-capability `if`. `--list` boots no
# server, so this is cheap and safe to run anywhere.
#
# What each runner ACTUALLY collects, incl. spec files that collect ZERO tests.
e2e-inventory:
    cd {{ui_dir}} && node scripts/e2e-inventory.mjs

# THE ACCEPTANCE GATE — the invocation `playwright.config.ts` and
# `tests/e2e/provenance/filter-save-records-recipe.spec.ts` both point the reader at.
# It did not exist (R4C-04); both references were dangling.
#
# It runs exactly ONE thing: the `@acceptance`-tagged spec(s), positively selected.
#
#  1. `TXR_E2E_REAL_COMPUTE=1` — drops `playwright.config.ts`'s `grepInvert: /@acceptance/`,
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
#     not read as green. A non-zero `skipped` also FAILS — under TXR_E2E_REAL_COMPUTE a
#     skip means a capability this host was supposed to have is missing.
#
# R6-D1 — REMOVED from this recipe: `TXR_TEST_NO_SKIP=1`, `TXR_TEST_SKIP_LEDGER`, and the
# "skip ledger is 0 lines" assertion, which the header used to advertise as two of three
# defences. Both env vars are read ONLY by `server/tests/dataset/hardening_common.rs` — the
# RUST integration-test binary — which `npx playwright test` never spawns. The ledger was
# therefore empty BY CONSTRUCTION and "0 lines" was a tautology, not a measurement. The
# mechanism itself is still load-bearing for `cargo test` invocations of the Rust tier and
# is untouched; only this recipe's false claim to be exercising it is gone. (See the
# round-6 correction in `.lifecycle/filter-provenance/FIX_ROUND-4.md` §6.2. NOTE the
# consequence: `TXR_TEST_NO_SKIP=1` once again has NO invoker anywhere in the repo —
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
    TXR_E2E_REAL_COMPUTE=1 PLAYWRIGHT_JUNIT="$junit" \
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
      if(skip>0){console.error(`[verify-acceptance] FAIL: ${skip} playwright skip(s) under TXR_E2E_REAL_COMPUTE=1 — a skip is not a pass`);process.exit(1)}
    ' "$junit"
    exit $pw_exit

# Gallery A7 boot canary — render-every-surface runtime-health (backend-free).
# Boot the gallery server first: `just gallery` (bg), then run this. Needs
# `npx playwright install chromium` once.
#
# NO FIXED PORT. Both recipes derive the SAME per-worktree port from the unified
# run key (`@txresbench/gallery/scripts/lib/run-key`), so `just gallery` in worktree A
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
# src-app/ui/ or src-app/libs/. When it does, it
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
