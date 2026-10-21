# Processor Registry — Design Research

**Goal.** Move analysis **processors** out of the compiled app into a separately‑versioned,
community‑extensible, **hot‑updateable** registry. A processor bundle = compute
script(s) **+** manifest (datatypes / converters) **+** optional **UI** (inspector
views and workbench analyses). Published from a **separate repo**, signed,
lazy‑fetched + verified + cached + hot‑swapped by the running app — so:

- a **buggy script can be fixed by pushing a patch**, and users get it with **no app update**;
- the **community can contribute** processors *and* analyses (compute + UI).

This doc synthesizes (a) how dispatch/distribution work today in the codebase and
(b) external prior art, into a phased target design. It is forward‑looking research,
not an approved plan.

---

## 1. A processor spans THREE distribution layers (the difficulty ladder)

The user's "it can also contain UI and analysis in the workbench" is the crux — a
bundle is not one artifact:

| Layer | Contents | Difficulty | Why |
|---|---|---|---|
| **Compute** | Python/shell scripts run in the sandbox | **Easy** | Just files; the app *already* lazy‑fetches signed files at runtime (env‑images, hub bundles). Hot‑update = re‑fetch a file. |
| **Manifest + datatypes** | declarative converters / datatypes / `accepts` / `produces` / `run.env` | **Medium** | Already parsed + validated — but at **boot** via `include_dir!`; must become runtime‑loadable + dynamic datatype‑registry merge (currently boot‑only, fail‑loud on collision). |
| **UI / workbench analysis** | React/TS views (`AnnDataInspector.tsx`, `workbench/builtins/*`) | **Hard** | Normally compiled into the Vite bundle. Runtime UI from a separate repo needs a genuinely new mechanism. |

---

## 2. The codebase already has almost everything (huge head start)

### 2a. The env‑image subsystem IS the runtime‑fetch template — copy it
`sandbox/env_image.rs` + `OciEnvImageProvider` already do, for the *execution image*,
exactly what we need for *scripts*:

- manifest declares `run.env` (e.g. `single-cell`) → `env_image::resolve` → an OCI ref
  with a **moving, schema‑scoped tag** (`schema<N>-latest-<arch>`), **nothing embedded**;
- on cache‑miss: `oras resolve` digest → **`cosign verify` (keyless, OIDC identity
  pinned to the signing workflow `…/.github/workflows/env-images.yml@refs/heads/main`)**
  → `oras pull` the `.squashfs` → atomic rename into a **content‑digest cache** → squashfuse mount;
- the resolved **digest is recorded in provenance** (provenance‑by‑reference: a reproduce
  pulls the exact image);
- operator escape hatches: `CYTO_ENV_ROOTFS_DIR` (air‑gap pre‑mount), registry/identity overrides.

**This is a complete lazy‑fetch + cryptographic‑verify + content‑addressed‑cache +
provenance‑by‑reference + air‑gap‑override pattern.** `rootfs::cache`,
`ensure_ready_by_digest`, and the `run("oras"/"cosign", …)` clearenv helper are directly reusable.

### 2b. The hub gives the Pages distribution + bundle mechanism
> ⚠️ CLAUDE.md's "Hub Seed" section is **stale** — the hub migrated **off** GitHub
> Releases+cosign to a **GitHub Pages static site + HTTPS + per‑bundle SHA‑256** (no
> cosign anymore). Simpler, and directly reusable.

- `bundle.rs` (`fetch_and_extract` / `extract_from_seed_bytes`): download (compressed cap)
  → **SHA‑256 must equal `manifest.bundle.sha256`** → **bomb‑guarded, symlink‑safe extract**
  (size/file/path caps, reject `..`/absolute/devices, exec bits preserved for a top‑level
  `scripts/` dir) → atomic staging→target rename. **This is the hot‑update‑a‑script core; copy verbatim.**
- `hub_manager.rs`: atomic **index swap** refresh (`index.json.tmp` → rename), **lazy
  per‑manifest fetch‑and‑cache**, a **baked seed** (`include_dir!`) as the air‑gap/first‑boot
  fallback, **seed‑vs‑Pages provenance** (never auto‑replace an operator's catalog), and —
  critically — **per‑entry `version` is the update signal** (one processor updates without
  touching others).
- **Publisher namespace = `io.github.<contributor>/<slug>`** (reverse‑DNS), with
  `is_safe_name` / `is_safe_manifest_path` path‑traversal guards. This is the
  community‑namespacing model.
- Build‑time **source‑form packing** (`pack_source_bundles`): a contributor commits an
  *editable script* loose in git; the build **reproducibly tars + hashes** it (fixed
  mtime/uid/gid, sorted, deterministic gz). Ideal for a community repo where reviewable
  diffs matter — CI and the app agree byte‑for‑byte.

### 2c. The sandbox IS the security boundary for untrusted code
`sandbox/sandbox.rs`: `--clearenv` (wipes DB URL / JWT / every `*_API_KEY`),
`--unshare-net` (**no egress**), `--unshare-user/pid/uts/ipc/cgroup`, `--die-with-parent`,
`/code` + inputs **read‑only**, `/outputs` the only writable mount, seccomp + cgroup caps +
prlimits + wall‑clock kill; reference mounts admin‑allowlisted + symlink‑canonicalized.
**→ Running untrusted community *scripts* is already safe. Signing is about *provenance*
(who), not *containment* (the sandbox handles that).**

### 2d. Processors are already self‑contained bundles
The recent consolidation made each processor `packages/<id>/{manifest.yaml, compute/<script>, ui/<view>}`
(co‑located, matching `run.entry`). The bundle shape a registry needs already exists.

---

## 3. The refactor is TWO narrow seams (+ one prerequisite)

Dispatch today is fully compile‑time‑baked, but the seams are clean:

1. **`sandbox::processors::resolve(code_ref)`** — today a linear scan returning a
   `&'static BuiltinProcessor` whose `.script` is `include_str!`‑baked. Flip to a fallible
   **lazy‑fetch → verify → digest‑cache → owned bytes** (`Result<ResolvedProcessor, _>`),
   with **bundle‑scoped** helpers (today `PY_HELPERS` is a global static). The two consumers
   (runner staging → `/code/entry.py`, provenance recorder) already only care about *bytes*,
   not origin. Downstream (RO `/code` bind, fixed `python3 /code/entry.py`) is unchanged.
2. **`extensions::loader::build_from_embedded()`** — today `include_dir!("../packages")`
   parsed at boot with fail‑loud validation. Flip to a **runtime fetch** of the manifest set;
   keep the identical parse + validation + collision checks, but surface them as **admin‑visible
   runtime errors** instead of **boot failures** (a bad community processor must not brick boot).

**Prerequisite bug to fix first:** the run path (`service.rs`) currently hardcodes
`.provide(DEFAULT_ENV_ID)` — a processor's per‑job `run.env` is validated at boot but **not
threaded into the actual run**. Different community processors selecting different verified
envs depends on closing this.

**Compile‑time → runtime move list:** scripts (`include_str!`), `PY_HELPERS`, the manifest
tree (`include_dir!`), the manifest→datatype merge, and the `env-id → OCI` table + cosign
identity. Everything else (inputs, env images) is already runtime.

---

## 4. Trust model (the community crux)

- **Execution** — already contained by the sandbox (§2c). Untrusted scripts run safely.
- **Provenance** — **re‑add signing.** The hub dropped cosign; the env‑image subsystem still
  has the exact pattern (**cosign keyless, OIDC identity pinned to the publisher's signing
  workflow**). Verify the signer identity **against the claimed `io.github.<user>` namespace**
  so a bundle can't spoof another publisher. Signing proves *who*; the sandbox proves *can't‑hurt*.
- **Manifest metadata is a TRUSTED control plane, not sandboxed.** `run.env` selects which
  (verified) image mounts; `datatypes` merge into the global lattice; `accepts`/sniff hints
  affect type detection; `produces` are advisory (the run's `/outputs/manifest.json` is
  authoritative). Community risks: datatype‑id **squatting/shadowing**, sniff‑order hijack,
  naming an arbitrary env. Mitigations: **publisher‑namespaced datatype ids**, **env‑id
  validated against a signed allowlist** (reject arbitrary OCI refs), collision surfaced to
  admin (not boot‑fail), produces treated as advisory.
- **Tiering.** *Verified/curated* publishers may contribute new datatypes + envs;
  *community* publishers get namespaced datatypes, **sandboxed UI**, and **no arbitrary env**
  (curated env allowlist only, at least initially — a new env is a heavy signed OCI image).

---

## 5. The UI layer — three tiers (the hard part)

React/TS UI is normally compiled into the Vite bundle. Runtime UI needs one of:

| Tier | Mechanism | Trust | Use |
|---|---|---|---|
| **1. Declarative view** | JSON/schema the app renders with its **own** kit components (table / chart / form) | Safe (no code) | **Default for community**; covers most inspectors + a workbench "analysis" = params‑form + which processor + which views |
| **2. Runtime ESM** | pre‑built ESM component loaded at runtime (module federation / **import‑maps**) | Runs in app origin → needs trust | **First‑party / curated** rich UI |
| **3. Sandboxed iframe** | separate‑origin iframe + message‑passing (**VS Code webview model**) | Isolated by origin | **Untrusted community** rich UI |

Prior art: **Grafana** ships community **panels (UI) + datasources (backend)** as **signed**,
**catalog**‑distributed, **runtime‑loaded** (SystemJS) plugins, installable/updatable
**without an app restart** — the closest analogue to our ask. **VS Code** runs untrusted
extension UI in **sandboxed iframes served from a separate origin**.

**Recommendation:** start **declarative** for community + keep first‑party UI in‑bundle;
add **import‑maps ESM** for curated rich UI; add the **iframe‑webview** for untrusted rich UI
last. The existing `GET /api/extensions` → FE `workbenchRegistry` projection is already the
seam where a runtime‑loaded view list would plug in.

---

## 6. Community contribution model — curated first, decentralized later

- **Curated central repo** (nf‑core / Galaxy Tool Shed / Grafana catalog model): PRs to a
  `ziee-ai/processors` repo; **CI validates schema + reproducibly re‑tars + signs + publishes**
  to the Pages catalog. Single trusted signer, quality‑gated. **Start here.**
- **Decentralized publisher namespaces** (Snakemake Workflow Catalog / hub `io.github.X`):
  anyone publishes from **their own** GitHub repo/release under their namespace; **keyless
  OIDC** ties provenance to their GitHub identity; the app adds a processor by URL/namespace.
  **Later unlock** — design the manifest + namespace so it drops in without a schema break.

---

## 7. Hot‑update flow (the core ask)

Script has a bug → publisher pushes a patch (bumps that processor's **per‑entry `version`**)
→ app **refresh** (manual admin action now; optional background poller w/ `ETag`/`If‑None‑Match`
later) → download → **sha256 + signature verify** → content‑addressed cache → **next run stages
the fixed script from cache** into `/code`. **No app rebuild, no reinstall** — because the
runner already materializes the script per‑job from wherever `resolve()` hands it, and we've
moved `resolve()` from the baked binary to the runtime cache.

---

## 8. Phased migration

- **Phase 0 — done.** Processors are self‑contained bundles (`packages/<id>/{manifest, compute/, ui/}`).
- **Phase 1 — runtime script cache (highest value / lowest risk).** Flip `processors::resolve`
  to read a **runtime cache** seeded from the current baked set (bake the built‑ins as the
  seed, hub‑style). Enables **hot‑updating scripts** with zero app change and no distribution
  work yet — the fastest path to "push a fix without an app update."
- **Phase 2 — distribution.** Publish the `processors` repo (Pages `index.json` + bundle
  `.tar.gz`); runtime **lazy‑fetch + verify + cache + refresh** (copy `bundle.rs` +
  `hub_manager.refresh`); **re‑add cosign** signing (env‑image identity‑pin pattern); an admin
  **catalog UI** mirroring the existing rootfs/env‑image admin pages (browse / install / update / pin).
- **Phase 3 — dynamic manifest/datatypes.** Flip `build_from_embedded` to runtime; **merge
  contributed datatypes at install** (publisher‑namespaced, collisions surfaced to admin, not
  boot‑fail); **thread per‑job `run.env`** into `service.rs`.
- **Phase 4 — UI distribution.** Declarative views first; then import‑maps ESM (first‑party) +
  sandboxed iframe (untrusted community).
- **Phase 5 — community.** CI‑signed central repo; then decentralized `io.github.<user>` publishing.

---

## 9. Gaps / risks (net‑new work beyond copying templates)

1. **Provenance signing** — re‑introduce cosign‑keyless per‑bundle, identity‑matched to the
   `io.github.<user>` namespace (recoverable from git history where the hub deleted it).
2. **Dynamic datatype registration + namespace isolation** — today boot‑time, disjoint‑by‑id,
   fail‑loud; needs runtime add, per‑publisher namespacing, admin‑surfaced conflicts.
3. **Per‑job `run.env` threading** — prerequisite; currently hardcoded to `DEFAULT_ENV_ID`.
4. **Runtime UI loading** — a genuinely new FE mechanism (declarative renderer → import‑maps → iframe).
5. **Community‑contributed *envs*** — heavy signed OCI images; the env‑image system fetches them,
   but community envs are a bigger trust/size ask — keep **envs curated‑only** initially.
6. **`apiVersion` / `min_ziee_version` compat gates** — a processor built for a newer schema must
   be refused with a clear message (the hub's `ensure_installable` already models this).

---

## 10. Declarative UI + actions are ONE unit (design decision — 2026-07-22)

Supersedes the §5 "UI tiers" sketch for the community case. The §5 table framed UI
as *view-only* declarative JSON the app renders with its own components. That is
**wrong for real analyses** — an analysis UI is not a static view, it is a set of
**interactive controls that DRIVE the app**, and the app already has a first-class
primitive for "a driveable action": `defineAction` (the AI-controllable-actions
system, `ui/src/core/actions/`). The corrected model:

**A processor ships a declarative UI, and that UI DECLARES ITS OWN ACTIONS.** UI and
actions are one unit. A new UI brings new actions *with it* — it does not merely
reach for a fixed app-side action menu, and the app does NOT generate the controls
*from* action param-schemas. The relationship is the inverse: the **control is the
noun** (declared), the **action is the verb** (also declared, in the same spec) that
mutates that control's / the view's state. (This is the live ScatterPlot pattern in
`docs/ai-controllable-actions/ARCHITECTURE.md` Layer 4: the legend checkbox is
declared UI; `scatter.setGroupVisibility` is the `defineAction` that mutates the same
per-instance state — one state, two drivers: human click AND AI.)

### The hard constraint that shapes the whole design
`defineAction.run` is a **JS function — code**. A declarative UI loaded from a
separate repo **cannot ship a JS closure** (that is exactly the "arbitrary shipped
code" we are trying to avoid — the injection/trust hole Layer 9 forbids). Therefore
the declarative format must express an action's *behavior* as **DATA** — a
declarative body the app **interprets** — and register it into the live
`defineAction` engine at load time. So a distributed processor's UI unit is:

| Part | Contents |
|---|---|
| **UI section** | declared controls/widgets (input, slider, select, plot, table), each bound to a field of a per-instance store (`view_id → store`, the instance directory that already exists). |
| **Actions section** | each control's action declared *in the same spec*: `{ id, title, permission, params, body }`, where **`body` is a declarative effect graph** (set-field, call a registered app primitive, run a processor, `waitFor` a job, emit progress) — **not JavaScript**. |
| **Interpreter** | at manifest load, each declared action is registered into the REAL `defineAction` registry with a `run` that *interprets* its declared `body` via `ctx`. To the engine a declared action is indistinguishable from a hand-written one. |

### What this buys (for free, because it rides the existing engine)
A declared action is **co-drivable** (human click + AI agent through the same
`runAction`), **permission-gated** (mandatory `permission`, backend-authoritative),
and **state-token-guarded** (`mutating + stateful` → read-before-write) — identical
to a hand-authored action, but as pure data. Every declared control is therefore
also AI-driveable the moment it exists. No parallel renderer, no second orchestration
path.

### The app's reusable "library" = a PRIMITIVE-EFFECT vocabulary (not finished actions)
This resolves the "build a library of all possible UI actions so it can reuse those"
requirement precisely: the app provides a bounded vocabulary of **primitive effects**
the declared `body` composes — `setState(field,val)`, `callAction(id,params)` (invoke
an existing registered app action), `callApi(route,params)`, `runProcessor(id,params)`,
`waitFor(store,pred)`, `emitProgress(msg)`, … . A new UI **declares its own actions**
by composing these primitives; **only a genuinely new PRIMITIVE is an app update.**
So the community can hot-ship new UIs + new (composed) actions in the separate repo,
bounded — principled, not accidental — by the primitive vocabulary the app exposes.

### Implementation reality (verified 2026-07-22, `feat/processor-registry`)
LIVE today: the `defineAction` registry + `run(params,ctx)` engine, the compile-time
collector (`ui/scripts/collect-actions.mjs` → `server/src/modules/mcp/frontend-actions.json`),
the completeness gate (`npm run check` runs `collect-actions --check` +
`action-refs-lint` + `action-coverage`), and the duplex agent channel
(`server/src/modules/mcp/agent_channel.rs`). NOT built yet: the **declarative
interpreter + primitive-effect vocabulary + the declarative view/control schema**
(Layer-9's `OverlayStore`/presentation vocabulary is also absent — grep finds
nothing). That trio is the genuinely net-new mechanism this initiative must build for
the community-UI tier; the distribution/hot-load plumbing (§3, §7) is merely how the
spec travels.

### Open (under study — do NOT plan yet)
Real single-cell analysis UIs (embedding explorer, clustering, DE) are **richly
interactive**: live filter, brush/lasso select with cross-panel linking (select cells
in the embedding → filter the DE table), gene-search → live FeaturePlot recolor,
threshold sliders re-filtering a volcano, legend toggles, and **side-by-side /
multi-panel resizable layout**. Whether the declarative-action model above can
express these (esp. cross-panel shared-selection state and client-side live filtering
without a server round-trip) — and how layout is declared/composed — is being
pressure-tested against the old `sc-website` reference before any plan is written.

---

## 11. Pressure-test: the old `sc-website` QC/filtering page → an exact `view_spec` (2026-07-22)

Pressure-tested §10 against the **richest real data-processing UI** in the old CytoAnalyst
reference (`/data/pbya/ziee/tmp/cytoanalyst-ref/sc-website`), the **DataUpload QC/filtering**
page: `imports/ui/pages/DataUpload/{index,FilteringBoard,PlotAndFilter,FilteringSlider,
SaveButtonAndModal}.tsx`.

**Load-bearing finding — the old app IS the declarative pattern, hand-written.** Its whole
analysis workspace is *thin controls that only mutate one normalized settings store*
(`imports/stores/ui/visualizationSettings.ts`) + *a single subscriber that recompiles that
store into an ECharts option and diff-applies it* (`CentralVisualization/subscriber.ts` →
`echartsOptions.ts`). The chart is a pure function of store state. That is structurally the
§10 model (per-instance store = view state; controls = declared; subscriber = renderer). We
are **formalizing a pattern this app already proved at scale**, not inventing one.

### Interaction-class → declarative-support mapping (how real-time works)
| Class | Old-app example | Declarative support |
|---|---|---|
| **1. pure setState** | color-by, chart-type, blend-mode, legend show/hide | control → action, body = `set(field,val)`. **Free.** |
| **2. server recompute** | create embedding/clustering/DE; gene-search→fetch-expr→recolor | body = `run_processor`/`api` → `wait_for(job)` → `set`. Reuses `ctx.waitFor`. **Free.** |
| **3. client compute** | brush→point-in-polygon; QC range-filter; set-combine (union/intersect/`react-querybuilder`) | **bounded app-owned PRIMITIVES** (`filter_mask`, `select_brush`, `combine`) the body calls. Net-new but bounded. |
| **4. cross-panel link** | brush cells → populate DE group; DE-row hover → highlight every volcano | declared **`links`** (source instance field → target action); engine `ctx.instances` is the mechanism. **The one genuinely new construct.** |
| **layout** | side-by-side, resizable, pop-out, small-multiples grid | orthogonal (old app splits `layoutAnalysis.ts` from content). Rides the workbench shell; small-multiples = a plot-widget param. |

**Boundary this reveals:** a declarative processor UI is a **wiring/configuration layer over
rich app-provided widgets + primitives** — it never ships a plot compiler or a JS closure. The
old app's widget set (scatter.gl / heatmap / violin / dotplot / volcano) + primitive set is the
shopping list of what the app must expose.

### The exact `view_spec` for the QC/filtering page
Faithful translation (fields kept verbatim: `nCount`/`nFeature`/`mitoPercentage`/
`riboPercentage`/`ident`, `data-process` job, `Sample.save`, the ≥10-cell save guard):

```yaml
view:
  id: single-cell/qc-filtering
  title: Data Upload — Quality Control & Filtering
  inspects: single-cell/raw-samples
  permission: studies::use
  source_job: { template: data-process, of: $study }        # FilteringBoard: last data-process job

  status:                                                    # FilteringBoard.tsx:55-104
    loading: { when: "$job == null",                     show: { spinner: "" } }
    empty:   { when: "$job == absent",                   show: { empty: "No data processing job found. Upload data to start." } }
    running: { when: "$job.status in [pending,running]", show: { spinner: "Data processing job is running" } }
    failed:  { when: "$job.status == failed",            show: { empty: "Data processing job failed. Check the logs." } }
    ready:   { when: "$job.status == completed",         show: body }

  state:                                                     # PlotAndFilter useState
    filteringParams:   { type: "map<ident, map<criterion,[number,number]>>", default: {} }
    selectedEmbedding: { type: string, default: "$data.vis2D.keys[0]" }

  data:                                                      # useJobResult slices
    obs:     { source: job.result, args: { path: /obs } }    # nCount,nFeature,mitoPercentage,riboPercentage,ident
    vis2D:   { source: job.result, args: { path: /vis2D } }
    nImages: { source: job.result, args: { path: /spatial/nImages } }

  const: { criteria: [nCount, nFeature, mitoPercentage, riboPercentage] }

  derived:                                                   # CLIENT-SIDE filtering math (reactive)
    idents:       { unique: "$data.obs.ident" }
    ranges:       { for_each: "$const.criteria as $c", value: { extent: "$data.obs[$c]" } }   # d3.extent
    hiddenByCrit: { for_each: "$const.criteria as $c",
                    value: { filter_mask: { values: "$data.obs[$c]", group_of: "$data.obs.ident",
                                            ranges: "$state.filteringParams[*][$c]" } } }
    hidden:       { or_masks: "$derived.hiddenByCrit" }      # mergedHiddenPoints
    nCells:       { count_by: { group: "$data.obs.ident", hidden: "$derived.hidden" } }  # {before,after}/ident

  widgets:
    - { id: vizPicker, kind: select, label: Visualization,
        options: "$data.vis2D.keys", value: "$state.selectedEmbedding", onChange: qc.setEmbedding }
    - { id: scatterBefore, kind: scatter.gl, title: "Cells before filtering",
        points: "$data.vis2D[$state.selectedEmbedding]", groups: "$data.obs.ident" }
    - { id: scatterAfter,  kind: scatter.gl, title: "Cells after filtering",
        points: "$data.vis2D[$state.selectedEmbedding]", groups: "$data.obs.ident", hidden: "$derived.hidden" }
    - id: qcSections                                         # REPEATS over the 4 QC criteria
      for_each: "$const.criteria as $c"
      kind: group   label: "$annot[$c]"
      children:
        - { kind: violin, title: before, groups: "$data.obs.ident", points: "$data.obs[$c]" }
        - { kind: violin, title: after,  groups: "$data.obs.ident", points: "$data.obs[$c]", hidden: "$derived.hidden" }
        - kind: group   label: "Filtering parameters"
          for_each: "$derived.idents as $ident"             # per-sample range slider
          children:
            - { kind: range_slider, label: "$ident", range: "$derived.ranges[$c]",   # FilteringSlider bounds = extent
                value: "$state.filteringParams[$ident][$c]", onCommit: qc.setFilter }
    - { id: saveBtn, kind: button, label: "Save data", variant: primary, onClick: qc.openSave }

  actions:
    - id: qc.setEmbedding
      permission: studies::use   mutating: true
      params: { value: string }
      body: [ { set: { selectedEmbedding: "$params.value" } } ]
    - id: qc.setFilter                                       # slider -> filteringParams (derived recomputes -> live)
      permission: studies::use   mutating: true   stateful: true
      params: { ident: string, criterion: string, range: [number, number] }
      body: [ { set: { "filteringParams.$params.ident.$params.criterion": "$params.range" } } ]
    - id: qc.openSave
      permission: studies::use   mutating: false
      params: {}
      body:
        - open_view: { view: qc-save-modal,
                       with: { samples: "$derived.idents", nCells: "$derived.nCells",
                               criteria: "$const.criteria", filteringParams: "$state.filteringParams",
                               embeddings: "$job.metadata.embeddings" } }

  layout:                                                    # index.tsx
    kind: column
    children:
      - kind: split   direction: row   wrap: true            # side-by-side, resizable
        panes:
          - { view: upload-form, size: 0.3, min: 320 }       # UploadForm card
          - kind: tabs   size: 0.7                            # FilteringBoard tabs
            tabs:
              - { key: filtering,  label: Filtering,  content: [vizPicker, scatterBefore, scatterAfter, qcSections, saveBtn] }
              - { key: metadata,   label: Metadata,   content: metadata-table }
              - { key: parameters, label: Parameters, content: job-parameters }
      - { view: sample-table }                               # SampleTable full-width below

---
# the Save modal is its OWN declared sub-view (SaveButtonAndModal.tsx)
view:
  id: qc-save-modal
  title: Save filtered samples
  kind: modal   width: 800
  params: { samples, nCells, criteria, filteringParams, embeddings }
  state:
    toSaveSamples: { type: "array<ident>", default: { filter: "$params.samples where $nCells[it].after >= 10" } }  # ≥10-cell guard
    newIdents:     { type: "map<ident,string>", default: { identity: "$params.samples" } }
    keepEmbeddings:{ type: "array<int>", default: [] }
  widgets:
    - kind: table                                            # per-sample: editable name, before/after, per-criterion min/max
      rows: "$params.samples"
      selection: { value: "$state.toSaveSamples", onChange: save.toggleSample, guard: "$nCells[row].after >= 10" }
      columns:
        - { key: ident, title: Sample, cell: { editable_text: { value: "$row", onChange: save.rename } } }
        - { key: before, title: "Cells before", value: "$nCells[$row].before" }
        - { key: after,  title: "Cells after",  value: "$nCells[$row].after" }
        - for_each: "$params.criteria as $c"
          column: { title: "$annot[$c]", value: "$params.filteringParams[$row][$c]" }
    - { kind: alert, tone: warning, when: "any $state.newIdents in $existingSampleNames",
        text: "Some new sample names already exist in the study." }
    - { kind: button, label: "Save data", variant: primary, onClick: save.commit }
  actions:
    - id: save.commit                                        # -> Sample.save (server job) — the round-trip
      permission: studies::use   mutating: true
      params: {}
      body:
        - progress: "Saving data"
        - api: { call: Sample.save,
                 args: { jobId: "$params.jobId",
                         sampleParams: { map: "$params.samples as $s",
                           to: { save: "$s in $state.toSaveSamples", originalName: "$s", newName: "$state.newIdents[$s]",
                                 nCells: "$params.nCells[$s].after",
                                 filter: { map: "$params.filteringParams[$s] as ($crit,$r)",
                                           to: { criteria: "$crit", min: "$r[0]", max: "$r[1]" } } } },
                         embeddingParams: "$state.keepEmbeddings" },
                 into: saveJob }
        - wait_for: { job: "$saveJob", until: completed }
        - toast: { success: "Data saved successfully" }
        - close_view: {}
```

### The 5 constructs a REAL page forced into the format (beyond §10's strawman)
1. **Repeaters (`for_each`)** — 4 criteria × N samples of sliders, per-criterion table columns.
   Data-driven widget repetition is mandatory.
2. **`derived` reactive fields + compute primitives** (`extent`, `filter_mask`, `or_masks`,
   `count_by`) — this IS the live client-side filtering. "After" plots bind `$derived.hidden`;
   a slider mutates `filteringParams` → derived recomputes → every plot re-renders. The concrete
   mechanism for class-3 real-time filter. The app owns this primitive set.
3. **`status` gate** bound to a source job (loading/empty/running/failed/ready) — real pages are
   job-state-driven, not always "ready."
4. **Nested sub-views / modals** (`open_view` / `close_view`) — the Save modal is its own declared
   view with its own state + table + action.
5. **The strain point (honest):** building the `Sample.save` payload needs light data-*shaping*
   (`map … to …`), which is where "declarative" starts wanting real logic. Deliberate decision
   needed: a bounded transform mini-language (shown) vs. pushing the shaping server-side. This is
   the sharpest edge of the whole approach.

---

## Sources

Codebase: `sandbox/env_image.rs`, `sandbox/processors/mod.rs`, `sandbox/sandbox.rs`,
`jobs/runner.rs`, `extensions/{loader,types}.rs`, `datatype/registry.rs`,
`hub/{hub_manager,bundle,handlers}.rs`, `build_helper/hub_seed.rs`.

External: [Grafana plugin system](https://deepwiki.com/grafana/grafana/11-plugin-system) ·
[Grafana plugin signatures](https://grafana.com/docs/grafana/latest/administration/plugin-management/plugin-sign/) ·
[VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview) ·
[Module Federation runtime](https://module-federation.io/guide/runtime/) ·
[Import‑maps microfrontends](https://www.mercedes-benz.io/2023/01/05/you-might-not-need-module-federation-orchestrate-your-microfrontends-at-runtime-with-import-maps/) ·
[nf‑core (Genome Biology 2025)](https://genomebiology.biomedcentral.com/articles/10.1186/s13059-025-03673-9) ·
[Snakemake Workflow Catalog](https://mir.cs.illinois.edu/marinov/publications/GraysonETAL23SnakemakeNextflow.pdf)
