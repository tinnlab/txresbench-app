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


# RETIRED (processor-ui-language ITEM-40, slice A). This recipe ran a per-package
# `npm test` because `npm run check` roots vitest at `ui/`, so that package's in-src
# suites were collected by NOTHING (R3-99: 277 tests under no runner — "a guard nobody
# invokes is not a guard"). ITEM-1 collapses the package into
# `ui/src/modules/workbench/core`, which removes the reason the separate recipe existed:
# the suites are now inside `ui`, and `ui`'s own `test:unit:node` glob was widened to
# cover `src/modules/workbench/core/` to keep running them under the SAME `node --test`
# idiom they were written for (they use `node:test`, which vitest does not execute). The
# core/extensions layering later split `core/` into a framework-free half
# (api/columns/contributions/criteria/datatypes/form/loader/manifest/mcp — node:test) and
# a React/vitest half (spec/runtime/render/shell/gallery), so the glob now NAMES the
# node-runnable subtrees instead of using `core/**`, which would have swept vitest files
# into the plain-node runner.
# Verified at the move: `npm run test:unit:node` reports 326 tests = 277 (this package)
# + 49 (ui's pre-existing node suites), zero lost. See DEC-K. The workbench half left
# with the single-cell platform (strip node ITEM-4); this recipe stays RETIRED.


# The committed architectural-invariant guards. All three shipped as executable scripts
# and were invoked by NO justfile recipe and NO workflow (`.github/workflows/` holds only
# `env-images.yml`) — the same "guard nobody runs" shape as R3-99 and as the processor
# pytest suites before `check-py`. They are cheap (git-grep over tracked files), so they
# belong in the default gate rather than in a reader's good intentions.
#
# NOT WIRED: `scripts/check-no-study-domain-literals.sh`. It is RED TODAY, and the
# redness is PRE-EXISTING, not branch-introduced: its `stud(y|ies)` regex is
# case-insensitive, so it matches three legitimate uses — the "in this study"
# prose quoted from published papers in `src-app/server/data` (the method-env
# catalogue's licence fields), the OFL licence texts shipped under
# `src-app/ui/src/assets/fonts/`, and the app's own `txr-study-*` CSS classes at
# `src-app/ui/src/index.css` (the board spec calls screen B "Your study"; the
# guard's txr-module exclusion covers `src/modules/txr*`, not the root stylesheet).
# Wiring it would gate every future change on that pre-existing failure. The fix
# belongs to that guard's owner: allowlist the three measured classes (they are not
# `study`-domain residuals, and the two legit families are as real now as when this
# was written). Tracked, not silently dropped.
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
# The strip node (ITEM-2) REMOVED the single-cell legs of this aggregate together
# with their subjects (the processor kind + workstore wire guards and the
# design-citations guard whose subject docs mostly went; the strip node's drift
# ledger records the removals). The remaining six legs are the tree-property and
# enforcement guards of the kept surface.
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
# integration suite asserts the design-named families are still on the denylist.
#
# The strip node (ITEM-2) removed the single-cell guards from this aggregate
# together with their subjects (env-rootfs pin recipes + the processor-vocabulary
# guard, and the analysis-rootfs local env loop). The remaining four legs are the
# kept enforcement guards.
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
#   e2e-gallery       tests/gallery-e2e    component gallery, per-worktree port (backend-free)
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
# backend-free gallery suite (`just e2e-gallery`). Nor does it include the
# `@acceptance` tests or the `TXR_E2E_REAL_COMPUTE`-gated specs, which register
# zero tests without a sandbox-executable host.
#
# BACKEND e2e (tests/e2e) — cargo backend + vite preview. NOT gallery.
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

# EVERY e2e suite, in one invocation. Runs all to completion (a failing suite does
# not mask the ones after it) and reports a per-suite exit table, failing if any failed.
# This is the recipe that makes "the default run covers everything" true; `just e2e`
# alone deliberately does not.
#
# STRIP (single-cell): the viz / pane / visual tiers left with the single-cell
# platform (the sourcing viz lib, the workbench/jobs pane specs and the visual
# harness) — the remaining tiers are backend + gallery.
#
# ALL e2e suites in one run, with a per-suite exit table.
e2e-all:
    #!/usr/bin/env bash
    set -uo pipefail
    declare -a names=(backend gallery)
    declare -a cmds=(
      "cd {{ui_dir}} && npm run test:e2e"
      "cd {{ui_dir}} && npm run test:e2e:gallery"
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
    # STRIP (single-cell): the @acceptance + TXR_E2E_REAL_COMPUTE tiers left with
    # their single-cell subjects, so e2e-all now covers the whole kept suite — there
    # is nothing excluded to disclose.
    exit $rc

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
# src-app/ui/. When it does, it
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
