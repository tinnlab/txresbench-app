# TxResBench — agent developer docs

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
`jwt.secret`. **That file is gitignored (`.gitignore:16-17`), so every fresh clone
or `git worktree add` lacks it** — see Bring-up traps.

- Backend: `cd src-app/server && CONFIG_FILE=config/dev.yaml cargo run` (embedded SQLite: one file, no database cluster)
- Frontend: `cd src-app/ui && npm run dev`
- OpenAPI regen: `cargo run -- --generate-openapi ../ui/openapi`

## Repo map

| path | what |
|---|---|
| `src-app/server/` | Rust binary crate — `config/`, `migrations/`, `tests/`; module tree under `src/modules/` (the txr run/history/model/pretrained/method-catalogue/file-validator modules + the framework spine: account, jobs, sandbox, rootfs, mcp, features, sync, permissions). `sandbox/` has three method runners: bwrap on Linux (`service.rs`, `stack.rs`), a per-run microVM on macOS (`mac_vm_run.rs`) and the app's WSL 2 distro on Windows (`wsl_run.rs`), the two VM runners sharing `vm_exchange.rs` |
| `src-app/ui/` | Vite/React/TS frontend; the app is the `txr*` module family + shell/help/settings (its own `npm run check` chain) |
| `src-app/desktop/` | Tauri desktop shell (`tauri/`) + the desktop dev harness |
| `sdk/` | tracked in-tree (no submodule) — the txresbench SDK: `crates/` (framework, core, auth, file, health, identity, notification, build-support, control-mcp, test-harness, sandbox-seccomp, plus the VM runner's three: sandbox-vm-protocol, sandbox-guest-agent, sandbox-vm-launcher), `packages/` (kit, shell, framework, config, gallery, notification-ui, test-e2e), `desktop/harness` |
| `data/` | first-party embedded data: `method-catalogue/`, `file-validator/`, `pretrained-catalogue/` |
| `scripts/` | generators + the guard suite (see Guards); `scripts/lib/` is shared verify logic |
| `docs/` | design + research, read on demand (the single-cell platform's docs were removed with it) |
| `agent-kit/` | vendored dev tooling (no submodule pointer) — `skills/` and `lifecycle/` |
| `site/` | the GitHub-Pages landing site + the updater/pretrained feeds |

## Test entry points

**`just check` is the aggregate gate** (the `check` recipe). Run it, never a subset. It runs 5 legs
via `scripts/check-aggregate.sh --min-legs 5`, which **collects results rather than
short-circuiting** — one red leg does not abort the others, so read every exit code:

`check-aggregate-controls` (self-test) · `cargo check --workspace --tests` · `ui npm run check` ·
`ui npm run build` · `check-invariants`.

It is a **deep tree, not 5 flat commands**: `check-invariants` fans out to 9 sub-legs
(test-scope-lists, dead-refs, naming, network-allowlist + controls, pub-orphans + controls, check-guards, check-domain) and
`check-guards` to 6 more (guard-integrity controls + method-env-images + method-list + no-format-crates);
`ui npm run check` is itself a 14-step chain (`src-app/ui/package.json:11`).

- Backend integration: `just test 4` (positional `THREADS`, default 4) · unit: `just test-unit`

**Baseline before blaming your branch.** Re-run the same leg on a clean checkout of your base and
compare failing sets **by name** (`comm`), not by count.

## Hard invariants

- **The analysis sandbox has no network.** `--unshare-net` at
  `src-app/server/src/modules/sandbox/sandbox.rs:96`, asserted at `:637`
  (*"network must be blocked"*). Nothing is fetched at run time — ever. Fetch at build time
  instead; the app's only runtime network uses are the method-environment downloads (by digest
  from the method list, before a run), the signed method list check (boot, run start, the
  Settings button, never on a timer), the pretrained-catalogue boot/on-demand refresh + model
  asset downloads, and the update check — all pinned by
  `scripts/check-network-allowlist.sh`; GHCR needs `ghcr.io` and `pkg-containers.githubusercontent.com`.
- **The app is bare-metal single-user by design.** No login screen, no queue, no provenance or
  workspace screens: the route surface is the app's own `/api/health`, `/api/session/local`,
  `/api/app/mode`, `/api/methods*`, `/api/markers`, `/api/file-validation/*` and `/api/txr/*`
  families, and the desktop shell calls the engine in-process. The framework routes that remain
  (mcp, admin/features, sync) are platform furniture kept whole for the desktop shell — they are
  not app screens.
- **No dead references to removed units.** The platform's trees (processor packages, env recipes,
  the dock/viz libs, the platform docs) are gone, and `scripts/check-dead-refs.sh` fails if a
  tracked file mentions a removed path or crate again. `scripts/check-naming.sh` pins the same
  property for the predecessor-app names. Never re-add a removed unit's path to prose, configs or
  guards without deleting the guard token alongside it.
- **Never weaken, skip, delete or baseline-away a test or guard to go green**, including writing a
  false allowlist/ledger entry to silence a lint. A guard you believe is wrong is a finding to
  report, not an entry to add.

## Guards (`scripts/`)

`check-guard-integrity.sh` pins every guard's bytes in `guard-hashes.txt` — a guard cannot be
quietly edited (grow `MIN_GUARDS` in the same commit that adds one). Others:
`check-aggregate.sh` (+ its test), `check-naming.sh`, `check-dead-refs.sh`, `check-network-allowlist.sh`,
`check-no-format-crates.sh`, `check-no-study-domain-literals.sh` (kept, and currently RED on
measured prose — see its comment in the justfile), `check-pub-orphans.mjs`,
`check-test-scope-lists.mjs`, `check-method-env-images.sh` (+ test), `check-method-list.sh` (+ test), and the frontend-suite guards
under `src-app/ui/scripts/` (`check-e2e-routing.mjs`, `check-rename-mechanical.mjs`,
`lint-no-domain-in-builtin.mjs`, `guard-floors.test.mjs`, `lint-native-controls.mjs`,
`lint-secret-input-caps.mjs`, `collect-actions.mjs`, `action-refs-lint.mjs`,
`action-coverage.mjs`, `lint-text-source-bytes.mjs`). The domain lint is invoked by
`just check-domain`.

## Working files — never `/tmp` (owner rule)

**Do not put anything in `/tmp`.** If this box crashes, everything there is gone. Worktrees, logs,
scratch scripts, fixtures, baselines and evidence go in a work directory outside the repo
that the developer chooses (see their own workspace rules), so it is not git noise. For test
and gate runs, export `TMPDIR` to a directory there as well, so tool-created temp dirs follow.

## Bring-up traps

A fresh clone or worktree fails in ways that read like code defects:

- **`src-app/server/config/dev.yaml` is gitignored** (`.gitignore:16-17`) and absent from `git ls-files`.
  Anything reading it fails with a message resembling a generation defect. When scripting the copy, **assert the `jwt.secret` substitution matched** so a silent no-op cannot
  produce a placeholder secret.
- `node_modules` and submodule init are not automatic in a new worktree (the SDK is tracked
  in-tree, not a submodule; `sdk/packages/*` + `src-app/ui` are the root npm workspaces; the
  lockfile is text-edited, never re-resolved — DEC-5).
- The test-harness writes its per-worktree app-data under `.txresbench-cache/` (gitignored).

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

- **The method-env base is verified only at the method-env-images node.** The app trusts the
  method catalogue's digest pins (`sandbox/method_env.rs`) and the `check-method-env-images.sh`
  verify script; the base images (`ghcr.io/tinnlab/txresbench-env`, tags `base-{py,r}-…`) and their contents
  are not re-verified in this repository.
