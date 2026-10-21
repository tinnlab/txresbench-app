# CytoAnalyst — agent developer docs

**This file is re-sent on EVERY turn and loaded whole into EVERY subagent**, so its size is a
`size × turns × (1 + subagents)` multiplier. It holds only what is needed on almost every turn.
Anything conditional belongs in a skill (loaded on its trigger) or a doc read when relevant — see
**Skills index**. Target: stay under ~8K tokens. Method:
`agent-kit/skills/claude-md-organization/SKILL.md`.

Every claim below cites `file:line`. A code comment is a hypothesis about the code, not evidence of
it — this repo's comments are rich and several have been found wrong.

---

## Quick start

One-time: `cp src-app/server/config/dev.example.yaml src-app/server/config/dev.yaml` and set
`jwt.secret` (`README.md:27-30`). **That file is gitignored (`.gitignore:11`), so every fresh clone
or `git worktree add` lacks it** — see Bring-up traps.

- Backend: `cd src-app/server && CONFIG_FILE=config/dev.yaml cargo run` (embedded Postgres)
- Frontend: `cd src-app/ui && npm run dev`
- OpenAPI regen: `cargo run -- --generate-openapi ../ui/openapi`

## Repo map

| path | what |
|---|---|
| `src-app/packages/` | ~27 processor packages (pytest). An analysis is DATA: `manifest.yaml` + `compute/*.py` + `ui/*.yaml` |
| `src-app/server/` | Rust binary crate — `config/`, `migrations/`, `tests/` |
| `src-app/ui/` | Vite/React/TS frontend (its own `npm run check` chain) |
| `src-app/libs/` | workspace npm libs, incl. `viz` |
| `src-app/env-rootfs/` | container recipes: `single-cell`, `single-cell-r`, `dock`, `viz`, `DEFAULT_ENV` |
| `scripts/` | the guard suite (see Guards) |
| `docs/` | design + research, read on demand |
| `agent-kit/` | submodule — ships `skills/` and `lifecycle/` |
| `sdk/` | submodule |

## Test entry points

**`just check` is the aggregate gate** (`justfile:59-70`). Run it, never a subset. It runs 10 legs
via `scripts/check-aggregate.sh --min-legs 10`, which **collects results rather than
short-circuiting** — one red leg does not abort the others, so read every exit code:

`check-aggregate-controls` (self-test) · `cargo check --workspace --tests` · `ui npm run check` ·
`ui npm run build` · `check-py` · `check-packages` · `check-coercion` · `check-processor-versions` ·
`check-invariants` · `check-r-regime` (`justfile:63-71`).

It is a **deep tree, not 10 flat commands**: `check-invariants` fans out to 9 sub-legs
(`justfile:508-518`) and `check-guards` to 7 more (`justfile:599-610`); `ui npm run check` is itself
a 14-step chain (`ui/package.json:12`).

- Backend integration: `just test THREADS="4"` (`justfile:14`) · unit: `just test-unit`
  (`justfile:17`)
- Package tests: `cd src-app/packages && python3 -m pytest <package>/tests`

**Some legs run for tens of minutes and look hung — they are not.** Measured by agents in this repo,
not documented in it: `check-packages` ≈55 min (a ~47-min magnitudes phase spawning ~71 Python
producers, issue #493) and `libs/viz npm test` ≈68 min (`Duration 4058.63s`, 251 files / 3,581
tests). Multiple gate runs have been killed as "hangs" before this was understood. Budget hours.

**Baseline before blaming your branch.** Re-run the same leg on a clean checkout of your base and
compare failing sets **by name** (`comm`), not by count.

## Hard invariants

**Packages own their own diff surface.** Each package that ships
`tests/test_zero_src_app_diff.py` declares its **OWN** `SANCTIONED_*` set — there is **no single
global allowlist**, deliberately: *"each package keeps its own `SANCTIONED` set… a union across
packages would grant every package every other package's exemptions"*
(`src-app/packages/_lib/zero_core_guard.py:60-63`). The sets genuinely differ — compare
`embedding/tests/test_zero_src_app_diff.py:43-46` (2 paths) with
`spatial-types/…:67-74` (5) and `r-skeleton/…:59-88` (which sanctions a server-src file and the
`justfile`). **Read your own package's set; never assume another's.**
The guard is a **branch-diff property, not a tree scan**: it runs only on the branch that introduces
the package (detected by `manifest.yaml` in `git diff --diff-filter=A`) and otherwise skips with a
stated reason (`_lib/zero_core_guard.py:24-32,52-58`).

*Distinct guard, easily confused:* `scripts/check-kinds-zero-core.sh:1-31` (INV-2) bans 3 hardcoded
zero-core kind ids from app-core. That is about kind ids, not about which files a package may touch.

- **A package ships no `.tsx`/`.jsx`** — enforced as a tree scan over the package directory
  (`differential-expression/tests/test_zero_src_app_diff.py:69-95`,
  `test_package_declares_no_render_source`; same invariant documented at
  `clustering/tests/test_manifest_shape.py:7,109`).
- **`packages/pytest.ini` `testpaths` is an enumeration, not a glob.** A `tests/` dir missing from it
  fails `check-py` with *"PACKAGE SUITE COLLECTED BY NOTHING"*. Register a new test dir **in the same
  commit** that creates it.
- **A change under an existing package bumps its `manifest.yaml` version** — two guards, neither
  substituting for the other (`justfile:437-442`): `check-processor-seed-versions.sh`
  (branch vs merge-base) and `check-manifest-version-claims.sh` (branch vs `origin/main` **and all
  unmerged refs**, so a collision with a sibling branch is detected).
- **The analysis sandbox has no network.** `--unshare-net` at
  `src-app/server/src/modules/sandbox/sandbox.rs:117`, asserted at `:772`
  (*"network must be blocked"*), and carried into the emitted reproduction script
  (`reproduce_script.rs:623`). Nothing is fetched at run time — ever. Fetch at build time instead.
- **Never weaken, skip, delete or baseline-away a test or guard to go green**, including writing a
  false allowlist/ledger entry to silence a lint. A guard you believe is wrong is a finding to
  report, not an entry to add.

## Guards (`scripts/`)

`check-guard-integrity.sh` pins every guard's bytes in `guard-hashes.txt` — a guard cannot be
quietly edited. Others: `check-kinds-zero-core.sh`, `check-processor-seed-versions.sh`,
`check-manifest-version-claims.sh`, `check-derived-vocabulary.sh`, `check-no-legacy-wire.sh`,
`check-no-format-crates.sh`, `check-pub-orphans.mjs`, `check-design-citations.mjs`,
`check-recipe-pins.mjs`, `check-test-scope-lists.mjs`, `check-package-suites.mjs`,
`coercion-parity.mjs`, `check-env-loop.sh`. The domain lint lives in the frontend and is invoked by
`just check-domain` (`justfile:691-698`): `ui/scripts/lint-no-domain-in-builtin.mjs`.

⚠️ **The domain lint's admission surface is under `src-app/ui/`.** Admitting a new contributed id
there makes `lifecycle-check` classify the branch as *frontend work* and demand an e2e test. Prefer
a **fixture-derived id** (resolve it from the merged registry at runtime) over raising a ceiling.
Root cause filed as issue #479.

## Working files — never `/tmp` (owner rule)

**Do not put anything in `/tmp`.** If this box crashes, everything there is gone. Worktrees, logs,
scratch scripts, fixtures, baselines and evidence all go under **`/data/pbya/cytoanalyst/`**, e.g.
`/data/pbya/cytoanalyst/tmp/<task>/` (outside the repo, so it is not git noise). For test and gate
runs, export `TMPDIR` to a directory there as well, so tool-created temp dirs follow.
`/` and `/tmp` share one 879G overlay; `/data/pbya` is a separate ZFS pool with ~44T free. Freeing
space under `/data/pbya` does nothing for `/`.

## Bring-up traps

A fresh clone or worktree fails in ways that read like code defects:

- **`src-app/server/config/dev.yaml` is gitignored** (`.gitignore:11`) and absent from `git ls-files`.
  Anything reading it fails with a message resembling a generation defect. Fix per `README.md:27-30`;
  when scripting the copy, **assert the `jwt.secret` substitution matched** so a silent no-op cannot
  produce a placeholder secret.
- `node_modules` and submodule init are not automatic in a new worktree.

## Skills index — load on trigger, not by default

In `.claude/skills/` (and `agent-kit/skills/`):

| skill | load when |
|---|---|
| `feature-lifecycle` | implementing ONE feature end to end (phases 1–9) |
| `epic-lifecycle` | planning a multi-item epic: DAG, blind per-item plans, contract reconciliation |
| `feature-orchestration` | driving a fleet: dispatch, merge protocol, the durable STATUS ledger |
| `claude-md-organization` | this file grows past ~8–10K tokens or ~150 lines |
| `ai-controllable-actions` | wiring an action the assistant can invoke |
| `frontend-ui-engineering` · `design-taste-frontend` · `design-variant-tournament` | frontend build / visual work |
| `shadcn-component-discovery` · `shadcn-component-review` | adding or reviewing a shadcn component |
| `live-ui-audit` · `live-ui-explore` (agent-kit only) | auditing or exploring the running UI |

Implementation is delegated to the **`bridge-coordinator`** agent (`model: sonnet`; it spends Opus
only on its Phase-5 adversarial verify). **Workers never merge or push** — they hand the branch back
and the orchestrator runs the gate and merges.

## Open / unverified — do not assert these as fact

- **"A contribution declares exactly one `env`"** — strong circumstantial evidence
  (`provenance/export/methods.rs:2453,2474`; `sandbox/env_image.rs:26,483`) but no schema-level
  assertion has been read. Verify before relying on it.
- **`sdk` submodule drift**: `.gitmodules:1-4` pins branch `cyto`, but the checkout is on
  `heads/cyto-fix`. A pin should track `cyto`, not a fix branch — check containment before branching.
