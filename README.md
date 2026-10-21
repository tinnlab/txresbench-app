# CytoAnalyst

A single-cell RNA-seq analysis application, built as **app #2 on the [ziee SDK](https://github.com/ziee-ai/sdk)**.

CytoAnalyst is **purely companion-driven**: it has no in-app agentic AI. It exposes its own
domain REST API and (via the SDK's `control_mcp`) lets the **ziee** companion agent drive it.
R/Python compute runs in the SDK sandbox; CytoAnalyst orchestrates — it does not reimplement
pipelines in Rust.

This repo is also a **dogfooding harness** for the SDK extraction: see [`SDK_GAPS.md`](./SDK_GAPS.md)
for every friction point discovered by actually consuming the SDK.

## Layout

```
cytoanalyst/
├─ sdk/                    # git submodule → ziee-ai/sdk (pinned)
├─ Cargo.toml              # workspace; path-deps into sdk/crates/*
├─ package.json            # npm workspaces: sdk/packages/* + src-app/ui
├─ src-app/
│  ├─ server/              # the cytoanalyst binary crate
│  └─ ui/                  # frontend on @ziee/framework + @ziee/kit
└─ config/                 # (per-app) — server config lives in src-app/server/config
```

## Quick start

```bash
# One-time: seed per-machine config (jwt.secret + db)
cp src-app/server/config/dev.example.yaml src-app/server/config/dev.yaml
# edit jwt.secret → `openssl rand -base64 48`

# Backend (embedded Postgres, zero-config)
cd src-app/server && CONFIG_FILE=config/dev.yaml cargo run

# Regenerate OpenAPI + TS client
cargo run -- --generate-openapi ../ui/openapi

# Frontend
cd src-app/ui && npm run dev
```

The SDK submodule is **pinned** (sdk/main moves as the extraction lands chunks). Bump it
deliberately with `git -C sdk fetch && git -C sdk checkout <sha> && git add sdk`.

## Landing procedure (run ALL of these before merging to `main`)

Run these **from your branch worktree**, in order. Each is a hard gate — a
non-zero exit means do not land.

| # | Gate | Command | Covers |
|---|---|---|---|
| 1 | repo check | `just check` | `cargo check --workspace --tests` + `npm run check` (tsc, action lints, unit) + prod bundle build |
| 2 | **frontend runtime** | `just preland-frontend <your-port>` | **browser runtime health of every gallery surface** — see below |
| 3 | backend merge | `scripts/verify-backend-merge.sh <branch>` | staged merge → sdk-submodule init → clean `cargo check` → openapi regen-parity |
| 4 | shared merge gate | `node .claude/lifecycle/merge-gate.mjs <branch>` | agent-kit's C1/C3/C5 + merge completeness |

### Gate 2 — `just preland-frontend` (frontend runtime health)

`scripts/preland-frontend-health.mjs`. **This gate exists because a console error
on every first-open workbench render landed on `main` and then survived five
subsequent landings** — nothing in the landing path had ever rendered the
frontend.

- **Trigger:** it runs only when the diff vs `origin/main` (merge-base..HEAD plus
  uncommitted work) touches `src-app/ui/`, `src-app/libs/`, or
  `src-app/packages/<p>/ui/`. A backend-only branch prints `SKIP` and exits 0,
  so the common case costs nothing.
- **Action:** boots (or reuses) the gallery Vite server on `PORT` and runs the
  `@ziee/gallery` runtime-health pass over every surface × state × theme,
  failing on any gating HIGH finding (console error, uncaught exception /
  ErrorBoundary crash, failed request, WCAG-AA contrast failure). Harness-noise
  findings (dev-server / mock-cassette artifacts) and findings baselined in the
  `runtimeBaselineModule` declared by `src-app/ui/gallery.config.json` do not gate.
  Pass **`--gate-ui`** to run the full four-criteria `npm run gate:ui`
  (tsc + lint + runtime + visual) instead; the default stays runtime-only because
  gate 1 (`just check`) already covers tsc/lint/unit.
- **Output:** a per-surface `PASS/FAIL` table — paste it into the landing report
  as real evidence. Full detail lands in
  `src-app/ui/src/dev/gallery/RUNTIME_FINDINGS.{md,jsonl}`.
- **You do not need to pass a port.** The gallery port is derived per worktree from
  the unified run key (`@ziee/gallery/scripts/lib/run-key`) and then bind-verified,
  and a server the gate did not start is reused ONLY when its `/__worktree`
  sentinel proves it is serving THIS worktree — otherwise the gate steps aside to a
  free port and boots its own, and if it cannot prove whose tree it is about to
  render it exits 2 instead of reporting.
  This replaced a fixed `1420` default plus the human instruction "always pass your
  own port". Forgetting that instruction once was not a small cost: on a clean
  `origin/main` worktree that passes 88/88 surfaces on a quiet port, a run that
  reused a sibling worktree's `:1420` reported **90 failing surfaces / 216 gating
  HIGH**, every one of them from the sibling's source, and a second run of the same
  code returned a *different* verdict (21,065 findings / 287 HIGH). A gate whose
  correctness depends on remembering a flag is not a gate.
  You can still pin one — the `just` arg is POSITIONAL: `just preland-frontend 1487`,
  not `PORT=1487` (that would be passed through verbatim; the script rejects it with
  exit 2). A pinned port is still never reused without the sentinel.
- **Leave the tree alone while it runs.** It drives a Vite *dev* server, so editing
  or `git checkout`-ing a source file mid-pass triggers an HMR invalidation that
  aborts in-flight module requests — each one lands as a `request-failed` HIGH.
  That is a self-inflicted false FAIL. Wait for the `RESULT` line.
- Needs `npm install` at the repo root (it runs on the branch worktree, which
  has `node_modules`) and `npx playwright install chromium` once.
- `--force` runs it on a backend-only diff; `--report-only` prints the table but
  always exits 0 (triage, not a gate); `--dry-run` prints just the RUN/SKIP
  trigger decision and renders nothing.

**Proof it catches the real thing.** Run against `04cf7fe0` (main immediately
before `fix/workbench-console-regressions` landed) it exits 1 with **30 gating
HIGH on 5 surfaces** — `workbench-{empty,results,collapsed,narrow,viewer}`, all
`[CanvasView] VizController.setOption failed … encode binds "rna:total_counts"
which is not a value column in the dataset`, the console error that landed and
then survived five more landings. Run against `a442d69f` (the fix) it exits 0
with **72/72 surfaces PASS, 0 gating HIGH**, 113 cells rendered.

**Why not just wire `npm run gate:ui` into agent-kit's `merge-gate.mjs`?** Three
blockers, of which two remain:

1. `merge-gate.mjs` lives in the shared `agent-kit` submodule, so changing it
   needs a push there plus a gitlink bump here.
2. **(still disqualifying)** the gate's staging worktree is tracked-files-only —
   no `node_modules`, no Playwright browsers — so a frontend pass there needs a
   full `npm install` + `npx playwright install` (~13 min) before it can render
   a single page.
3. **RESOLVED at `4a9a6503`.** `gate:ui` used to always exit non-zero on `main`
   because its `visual` step needs `playwright.visual.config.ts`, which was
   unlanded. `feat/declarative-rendering-hardening` landed it; `npm run gate:ui`
   was verified **exit 0** (tsc / lint / runtime / visual, 84/84 surfaces) on
   `4a9a6503`. That is why `--gate-ui` is now offered as an opt-in above.

`preland-frontend` sidesteps all three by running on the branch worktree, which
already has `node_modules`.

**Follow-up (not implemented).** The durable form is an optional
`MERGE_FRONTEND_GATE_CMD` + `MERGE_FRONTEND_GATE_DIR` pair in `.claude/app.config`,
consumed as a new `gateC6` in agent-kit's `merge-gate.mjs`. That fits its existing
"every key is OPTIONAL; an unset key SKIPS its gate" contract, so **ziee is
unaffected until it opts in**. Blocker 3 is gone; it still needs the staging-tree
`npm install` + browser provisioning solved first (blocker 2 above).

## Test tiers

Modelled on ziee's sandbox tiering. **A tier nobody can find is a tier nobody
runs**, so every tier below has a `just` recipe — none is an env var you are
expected to know about.

| Tier | What it proves | Needs | Time | Command |
|---|---|---|---|---|
| 1 — Rust unit | pure logic (parsers, argv builders, validators) | a compile DB | ~1 min | `just test-unit` |
| 2 — Rust integration | HTTP handlers, repositories, permissions, migrations | Postgres `:54321` | ~10 min | `just test` |
| 3 — static / bundle | `cargo check --workspace --tests`, `tsc`, lints, prod build | nothing | ~5 min | `just check` |
| 4 — frontend runtime health | every gallery surface × state × theme renders with no console error / crash / failed request / contrast failure | Playwright chromium | ~3 min | `just preland-frontend <port>` |
| 5 — backend e2e (default) | the app through a real browser against a real backend — **153 tests, no sandbox** | Postgres, chromium | ~25 min | `just e2e` |
| 6 — backend-free e2e | viz showcase, component gallery, Layer-A visual | chromium | ~15 min | `just e2e-all` |
| **7 — real-compute processor e2e** | **a processor executing in a REAL bwrap sandbox, driven through the REAL UI** — fixture uploaded → converter runs → picker populates → selector → Run → result asserted | bwrap + squashfuse + userns + the env image | ~10 min (+5 s one-time image pull) | `just env-rootfs` once, then `just e2e-processors` |
| **7b — real-compute backend** | the same sandbox, from the Rust side — the `sandbox_executes()`-gated integration tests | same as tier 7 | ~10 min | `just test-sandbox` |
| 7c — real-registry OCI | resolve → **cosign-verify** → pull → mount against the live GHCR image | + `cosign`, `oras login`, a release build | ~20 min | `just test-sandbox-oci` |
| 8 — acceptance | every `@acceptance`-tagged spec (a genuine `cell.filter` commit). The COUNT is not written here on purpose — it was `2` while five specs carried the tag; a default run now prints the derived number, and `node src-app/ui/scripts/tag-narrowing.mjs`'s `narrowedOut()` is the one source | same as tier 7 | ~3 min | `just verify-acceptance` |

Tier 7 is the analogue of ziee's tier 6 — *the only tier exercising the full
production path*: real HTTP → real handler → real bwrap → real python → real
artifact → real UI assertion. The lower tiers exercise individual layers; tier 7
is what proves the integration works. **Add new processor-journey specs here.**

### Tier 7 — how to run it

```bash
just env-rootfs            # ONCE: ~300 MB, ~5 s. Cached in .cyto-cache/env-rootfs/.
just e2e-processors        # every time (the three processor-journey directories)
just e2e-processors tests/e2e/14-declarative-qc/some.spec.ts   # or one spec
```

`just env-rootfs` pulls the published env image from
`ghcr.io/ziee-ai/cyto-env/<env-id>:schema<N>-latest-<arch>`. That image is an OCI
artifact whose single layer **is** the rootfs squashfs, so there is no docker
build and no `mksquashfs` step — it is one blob pull. The schema `<N>` is read
from `ROOTFS_SCHEMA_VERSION` in `src-app/server/src/modules/rootfs/version.rs`, so
a schema bump cannot silently keep using a stale image.

The `<env-id>` is **derived, never typed into the recipe**: it is read from
`contributes.converters[].env` in the processor manifests — the same slice the
binary reads (`sandbox::env_image::default_env_id`). With exactly one declared env
it is used (that choice is forced, so no domain knowledge is asserted); with two or
more the recipe **refuses and names them**, because which image to fetch is then a
real choice. Override with an argument (`just env-rootfs <env-id>`) or
`CYTO_SANDBOX_ENV_ID`. Adding a second analysis domain is therefore a
processor-package change with no edit to the `justfile` or to the script.

**It is not anonymously pullable** — without a credential the registry answers
`unauthorized: authentication required`. Supply a GitHub credential carrying
`read:packages` (`gh auth login`, or `GITHUB_TOKEN`);
the script tries an existing `oras` login, then `gh auth token`, then the env var,
and fails with that exact remediation if none works. Air-gapped boxes can
pre-stage the `.squashfs` and use `scripts/fetch-env-rootfs.sh --offline`.

The image is consumed through **seam 1**, `CYTO_ENV_ROOTFS_SQUASHFS` — the
preferred seam per `modules::sandbox::env_image`: it is content-hashed, its digest
is RECORDED on the run, and the run's export capsule therefore **executes**. The
legacy seam 2 (`CYTO_ENV_ROOTFS_DIR`) is deliberately not used by any recipe: a
bare mount dir carries no content identity, so runs under it are UNPINNED.

### Tier 7 — a skip is a FAILURE, not a pass

This tier exists because the previous arrangement was invisible. `CYTO_E2E_REAL_COMPUTE`
unset made the real-compute specs disappear two different ways — excluded outright
by the config's `grepInvert: /@acceptance/`, and ~17 more wrapped in
`test.skip(!REAL_COMPUTE, …)` — and **no recipe in the repo ever set the flag**. A
broken compute layer and a working one produced identical green output. So the tier
fails closed at three layers:

1. **Preflight hard-fails** (`just e2e-processors-preflight`) on any missing
   precondition — bwrap, squashfuse, fusermount, unprivileged userns + a fresh
   `/proc`, `user_allow_other`, the image itself — each with its remediation line.
2. **An execution canary** ends the preflight: it runs the scientific interpreter
   *inside a real bwrap sandbox against the real image*. Every static check can pass
   while execution still fails (a masked `/proc` in a container, userns blocked by an
   LSM), so the tier asserts the capability rather than the syntax of the capability.
3. **The JUnit report is parsed fail-closed** — `tests == 0`, any failure, any error,
   and **any skip** are each a hard FAIL, with the skipped test names printed. Under
   `CYTO_E2E_REAL_COMPUTE=1` a skip means a capability this host was supposed to have
   is missing.

`just e2e-inventory` remains the honest census of what each config actually collects,
including spec files that collect zero tests.

The backend half (tier 7b) has the identical contract. Its integration tests call
`record_skip` when no rootfs is reachable, and `CYTO_TEST_NO_SKIP=1` promotes each
of those skips to a hard failure — the justfile used to note that *nothing in the
repo set that variable, so it defends nothing on its own*. `just test-sandbox` is
that missing invoker: it exports seam 1 and `CYTO_TEST_NO_SKIP=1` together.

### Tier 7 — large fixtures

Most fixtures are committed (`tests/e2e/14-declarative-qc/fixtures/tiny_counts.h5ad`,
120 cells, 36 KB). One spec needs a *large real* dataset to prove scatter thinning
(`14-workbench/cell-filter-scatter-thins.spec.ts`, ~4.5 MB with real UMAP coords),
which is deliberately not committed. Stage it once:

```bash
mkdir -p .cyto-cache/fixtures
cp <somewhere>/pbmc68k_reduced.h5ad .cyto-cache/fixtures/
# or generate: python -c "import scanpy as sc; sc.datasets.pbmc68k_reduced().write_h5ad('.cyto-cache/fixtures/pbmc68k_reduced.h5ad')"
```

`.cyto-cache/fixtures/` **is** the spec's default location — it resolves the path
relative to this repo, so staging the file is all that is required and nothing
needs exporting. `just e2e-processors` additionally exports `CYTO_E2E_FIXTURES`
(the staging *directory*, so it can be relocated); an individual spec may still be
pointed at one specific file (`CELLFILTER_H5AD` for this one). Without a staged
fixture the spec skips — and because a skip FAILS this tier, the gate would go red
over a missing file rather than a real bug.

> Until 2026-08 the spec defaulted to an absolute path inside a *different*
> repository on one developer's machine, so it skipped everywhere else and the
> recipe's env-var wiring was the only thing keeping the tier green. Both the
> foreign path and the domain-named recipe→spec variable are gone: a fixture path
> must be discoverable inside this repo, or absent and honest.

### Tier 7 — writing a spec for it

Drop the spec in **any** of the scoped directories (`tests/e2e/14-declarative-qc`,
`tests/e2e/14-workbench`, `tests/e2e/provenance`) — scope is by directory, never a
file list, so it is picked up with no edit to the recipe. The tier guarantees your
spec these, already exported:

| provided | value |
|---|---|
| `CYTO_ENV_ROOTFS_SQUASHFS` | the cached env image (seam 1) — the backend mounts it by digest |
| `CYTO_E2E_REAL_COMPUTE` | `1` — satisfies `REAL_COMPUTE` in `14-workbench/_analysis.ts` and drops the config's `@acceptance` `grepInvert` |
| `CYTO_E2E_MULTIMODAL` | `1` |
| `CELLFILTER_H5AD` | auto-wired if `.cyto-cache/fixtures/pbmc68k_reduced.h5ad` is staged |
| a FRESH backend | `CI=1` by default, so the spawned backend actually sees the seam |

Committed fixtures live in `tests/e2e/14-declarative-qc/fixtures/`
(`tiny_counts.h5ad`, 120 cells × 10 genes). The existing helpers do the heavy
lifting: `seedRunnableExpression()` (`14-declarative-qc/_seed.ts`) performs a real
`POST /api/datasets/upload` and waits for the real on-ingest converter to finish in
the sandbox; `runToReview()` (`14-workbench/_analysis.ts`) drives a run through the
real UI and opens the artifact review. Gate the spec with
`test.skip(!REAL_COMPUTE, REAL_COMPUTE_SKIP)` — under this tier that guard is
satisfied, so the test must actually pass; and if it skips anyway, the tier fails.

### Writing a shared test helper — keep it token-free

**A shared helper may not contain a domain token; the spec that calls it passes the
token in.** This applies to every test tier, not just tier 7, and it is not a style
preference — it is what the domain ratchet
(`src-app/ui/scripts/lint-no-domain-in-builtin.mjs`) permits.

That guard scans the test trees too (`ui/tests/**`, `server/tests/**`, and every
`*.test.*` / `*.spec.*`), and its ledger `domain-baseline.json` is **shrink-only per
file**: a file with no entry has a budget of **zero**, so the *first* domain token in
a **new** helper is a new leak and the gate goes red. `--prune-baseline` cannot rescue
it — that flag only lowers or removes entries, never adds one, and a new entry has to
be argued for by hand. "I factored some code out" is not an argument for widening a
domain ledger.

So:

- **Pane- and DOM-addressing code stays in the specs**, which already carry that
  residue and whose counts therefore do not move. Test-id prefixes such as
  `viz-cell-*` contain `cell`, which is one of the guard's tokens.
- **The helper takes the attribute name / selector / prefix as a parameter** and stays
  generic. `src-app/ui/tests/viz-e2e/_helpers.ts` is the worked example: zero
  `viz-cell` occurrences in the helper, all of them in the specs that pass them in.
- **In-`src` tests are held to the same rule** (they are scanned as part of
  `ui/src/**`). `core/render/dataStatusGate.test.tsx` shows the discipline taken
  further: it names one widget id and *discovers* the package, view, slice keys and
  datatypes at runtime, so it spells no domain vocabulary at all.

**Why not just exempt test directories?** Because those trees were invisible to this
guard until the WS-R4 widening, and the invisibility was itself the finding (≈1258 +
≈449 hits nobody had ever looked at). An exemption re-creates it, and it lands on
exactly the code most likely to spread a spelling: a helper is imported by many specs,
so one token in it is a token in all of them. The cost is that some helpers take an
argument they would not otherwise need — which is the price of a residue that only
ever shrinks, and cheaper than a ledger that grows whenever code is rearranged.

### Tier 7 — host setup (one-time)

`bash scripts/dev-sandbox-bootstrap.sh` applies the host properties the server
cannot set itself (`user_allow_other` in `/etc/fuse.conf`, the unprivileged-userns
sysctls, unmasking `/proc`). Package deps:

```bash
sudo apt install bubblewrap squashfuse fuse3     # Debian / Ubuntu
```

plus `oras` (https://oras.land) for the image pull. `just e2e-processors-preflight`
tells you exactly which of these is missing.
