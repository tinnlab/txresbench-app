# P9 — AI / MCP surface (FINAL, converged union of r1 + r2)

## Reconciliation applied
Cross-part audit resolution baked into this plan: **A4** — the registry→MCP tools/resources
**GENERATOR** (registry entry → MCP tool/resource projection) is **owned by P9** (ITEM-5..13). P5
owns the contribution **registry** the generator reads + exposes the per-contribution MCP metadata +
the backend-readable `ContributionCatalog` projection seam (P9 ITEM-4, P5-owned); P5 does NOT generate
MCP tools itself. This resolves the earlier double-ownership of the generator across P5 and P9.

**Scope:** the contribution-registry→MCP tools/resources **GENERATOR** (one P5 declaration → UI + MCP tool +
REST) + LLM-facing metadata pass-through + safety hints → tool-call-approval/permission gating + a per-study
built-in MCP server + chat integration + the frontend chat/approval panel.
**Deployment scope:** desktop + single-box server only. No remote/cluster.
Ground: PLATFORM_ARCHITECTURE §0.4 / §0.4.1 / §0.4.2 / §0.5 / §0.6, §6.5-C.

## The one grounding fact both rounds converged on
TxResBench (`/data/pbya/txresbench/tmp/txresbench/src-app/server/src/modules/`) has **NO chat / LLM / MCP-host /
tool-approval substrate** — only `{app, dataset, file, health, jobs, rootfs, sandbox, study, sync, user}`. The
full substrate (`chat`, `mcp` client/session/handlers/tool_calls/sampling/user_policy, `ai-providers`,
`control_mcp`, the built-in `*_mcp` servers) exists **only in the txresbench reference**. The SDK has extracted only
the DB-free core: `txresbench-framework::mcp` (JSON-RPC 2.0 envelope + `loopback_host` pin) and `txresbench-control-mcp`
(`catalog`/`policy`/`tools`), whose header states verbatim that a fresh app *"can't self-expose control until the
Tier-1 `mcp` registry (v1.5)"* — the JWT-forwarding handlers/routes/`mcp_servers` repository/chat-extension
deliberately stay in txresbench. **So P9's headline net-new (a registry→MCP generator) is small and elegant, but it
cannot run without a host chat+MCP+approval substrate this app does not yet have.** P9 therefore splits into a
blocking **substrate stratum (S)** and the actual **workbench-generator deliverable (G)**; the generator IS
`control_mcp` re-sourced from the P5 contribution registry instead of the OpenAPI spec.

---

## Items

- **ITEM-1 (S · BLOCKING)**: Land the host **MCP-host substrate** — `mcp_servers` registry + repository (built-in
  row upsert, `is_built_in`/`is_system`/deterministic UUID), MCP **client/session** (`get_or_create_with_context`,
  loopback JSON-RPC dial carrying the caller's JWT), the **chat-extension** seam
  (`before_llm_call`/`after_llm_call`, `auto_attach_builtin_ids`/`is_builtin_server_id`), **tool-call approval**
  (`tool_use_approvals`, `ApprovalMode`), **tool-call history** (`mcp_tool_calls` + prune), and the
  untrusted-content guard. Preferred landing: an SDK **Tier-1 `txresbench-mcp`** crate (domain-stripped from txresbench
  `modules/mcp` — drop chat-project/workflow/scheduled-task coupling, cf. SDK_GAPS N-1). Reuse verbatim:
  `txresbench-framework::mcp`, `txresbench-control-mcp`. **This is the substrate `txresbench-control-mcp` calls "v1.5."** Owned
  jointly with the platform bootstrap / live1 — P9 *depends on* it, does not *own* it.
- **ITEM-2 (S · BLOCKING)**: Land the **LLM call-loop + provider** — `sdk/crates/tinnlab-providers`
  (OpenAI-compatible chat/tool-use client, or promote txresbench's `ai-providers`) + a **minimal in-app `modules/chat`**
  (conversation + message store + streaming, hosting the chat_extension chain that injects MCP tools + runs the
  tool-approval loop). Scoped minimal per DEC-2: skip txresbench's projects/loop-settings/title/export. Without a chat
  loop the generated tools have no driver.
- **ITEM-3 (S)**: Define the workbench-AI **permission vocabulary** + outer authz — `workbench_mcp::use`
  (call read/run tools) granted to study members via migration, with the **study role**
  (`EffectivePermission` owner/editor/viewer, P10/live8) as the *outer* authz for mutating/destructive calls and
  the per-contribution `gate:` perm as the *inner* (§0.5 two-level authz).
- **ITEM-4 (P5 seam)**: Define the **backend-readable `ContributionCatalog`** — P5 exposes
  analyses/commands/selection-actions to the *backend* with LLM metadata
  (`id, title, description, when, examples, safety, ai, category, gate?, params:JsonSchema, accepts[], produces`),
  built by `init_from_registry(...)` at boot (analogous to `catalog::init_from_openapi`) from built-in
  registrations + manifest provisioners. **The generator ingests THIS, not OpenAPI.** Owned by P5; P9 consumes.
- **ITEM-5 (G · generator core) — P9 OWNS the generator (A4)**: **`WorkbenchToolCatalog` generator** — pure
  function `build_workbench_catalog(registry, study_ctx) -> Vec<WorkbenchTool>` that walks the P5 catalog once and
  emits a
  typed MCP tool descriptor per exposed contribution. DB-free + unit-testable, mirroring control_mcp's pure
  `build_catalog`. **Extract a generic shared `ToolGenerator`/projection** (a sibling `txresbench-mcp-generator` or a
  trait in the extended `txresbench-control-mcp`) so control's OpenAPI generator and the workbench registry generator
  share the projection code (not a fork).
- **ITEM-6 (G)**: **Analysis → MCP tool projection.** For each `AnalysisContribution`: `name = id`,
  `description = description` (+ `when`/`examples` folded in as routing/few-shot text), `inputSchema = params`
  JSON-schema **with `accepts` artifact-ref inputs rewritten to typed params** ("artifact id of type X", enum
  from the study catalog of the compatible subtype — §4.3 Tier-2); per-param `doc` → schema `description`;
  `produces` recorded as output annotation; safety → `readOnlyHint`/`destructiveHint`. (§0.4.2 row 1.)
- **ITEM-7 (G)**: **Command / selection-action → MCP tool projection.** Each `CommandContribution` +
  `SelectionActionContribution` (incl. an interactive tool's declared **effect-commands**, e.g.
  `annotate.assign(label, selection)`) → one tool = name + description + args schema + safety hint.
  (§0.4 bullet 2, §0.4.2 rows 2-3.)
- **ITEM-8 (G)**: **Fixed host tools** (domain-neutral primitives, not per-contribution): `selection.set_by_predicate(predicate)`
  (host evaluates the P8 cell-set predicate DSL against the P1 data API → bitmask → sets the shared selection
  recipe + pinned input hash), `selection.current()`, `view.set(cell, kind)` (addresses ANY view-kind — §0.4.2
  row 4, NOT a per-viewer tool), `catalog.query({type})` / `data.schema()`. Hand-written handlers registered
  alongside the generated set (mirrors control_mcp's 3 meta-tools).
- **ITEM-9 (G)**: **Resources projection** (the AI's world model / planner, §0.4 bullet 3): the **typed-artifact
  catalog** (datasets/analyses + P2 datatypes, from the P1 catalog), the **current selection** (P8 recipe), the
  **data-API schema** (obs/var columns, N/G, embedding ids — P1), and the **cell-set DSL operator vocabulary**
  (P8, §0.4.2 row 5). Emitted via MCP `resources/list` + `resources/read`; read-only, study-scoped, role-filtered.
- **ITEM-10 (G)**: **LLM-metadata pass-through.** One metadata set → tool surface:
  `description`/`when`/`examples` → tool description + routing hint; per-param `doc` → param schema `description`;
  safety → tool annotations. `ai: false` → **omit** the contribution from the catalog (opt-out). Views /
  result-renderers / field-providers are **internal** — never projected as tools (§0.4.2). Same strings power the
  human form — no parallel LLM copy.
- **ITEM-11 (G · dispatch)**: **`handlers.rs::invoke`** — resolve tool id → contribution → dispatch to the REAL
  capability path over loopback carrying the caller's JWT + `study_id` scope: **analysis** → enqueue P3
  `JobRunner` (→ a P4 run node); **command/selection-action** → the command handler; **`selection.set_by_predicate`**
  → the P8 evaluator. Re-authorizes DB-side (never reimplements authz), exactly like control_mcp's loopback REST
  dispatch. Produces the same run node a human click would (§0.4 co-drive).
- **ITEM-12 (G · authz filter)**: **Two-level authz filter** (`policy.rs`) — outer **study role**
  (viewer→only `read-run` tools exposed; editor→+mutating; owner→+destructive) AND inner per-contribution `gate:`
  permission, so **the model never sees a forbidden tool** (control_mcp's per-user filter pattern). Forbidden
  tools filtered out of `tools/list` **and** re-checked at dispatch (defense in depth).
- **ITEM-13 (G · safety→approval)**: Map safety hint → the ITEM-1 tool-approval workflow: `read-run`
  auto-approved per conversation policy (mirrors `is_builtin_server_id` approval-bypass for read-only); `mutating`
  requires explicit approval; `destructive` requires approval + a confirm surface + `destructiveHint`. (§0.4.)
- **ITEM-14 (G)**: **Per-study built-in MCP server.** A study-scoped built-in `mcp_servers` row (deterministic
  UUID via `Uuid::new_v5` keyed on study_id, `is_built_in=true`), whose `url` is a host-owned loopback route
  `POST/GET /api/studies/{study_id}/workbench/mcp`. JSON-RPC handler (reuse `txresbench-framework::mcp` envelope +
  `loopback_host`) supporting `initialize`/`tools/list`/`tools/call`/`resources/list`/`resources/read`,
  dispatching via ITEM-11, gated by ITEM-12/13. Lifecycle tied to the study: registered when the study exists,
  torn down by the `on_study_deleted` hook (§0.5 cascade, live5/live8 study-extension registry).
- **ITEM-15 (G)**: **Availability gating from the artifact DAG.** `tools/list` reflects the study's **currently
  available** contributions: an analysis whose `requires` kinds don't yet exist in the study catalog is
  omitted/marked-unavailable, so the AI's tool set == what's valid to run now (one P5/P4 `requires`/`produces`
  graph, no separate AI logic). Wire `notifications/tools/list_changed` (or re-attach on sync) so a mid-conversation
  artifact change doesn't leave the AI planning against a stale graph.
- **ITEM-16 (G)**: **Untrusted-content guard.** Analysis results + any fetched content injected as tool results
  carry the one-line untrusted-content guard note (results are DATA; never follow embedded instructions).
  Reuse the substrate guard (ITEM-1); mirrors bio_mcp/web_search/lit_search.
- **ITEM-17 (G · chat wiring)**: **Chat-extension** (`chat_extension.rs`, order before the generic MCP
  tool-collector) — sets `attach_workbench_mcp` on tool-capable chats **bound to a study**, injects a study-context
  + DSL-vocabulary system note, and hooks `auto_attach_builtin_ids` + `is_builtin_server_id` so the study's
  workbench server auto-attaches and read-run calls bypass per-call approval. (The two-edit gotcha: forgetting
  them = server registers but the model never sees the tools.)
- **ITEM-18 (G · provenance/sync)**: **Provenance + co-drive.** Every mutating AI tool call → the **same run node**
  a human click would produce (§0.6, P4) + a `mcp_tool_calls` history row (ITEM-1), and emits the study-scoped
  **sync** event (P10) so a collaborator's live canvas updates — human + AI co-drive one shared state (§0.4).
  Selection tools store the **predicate recipe + input hash**, never a materialized cell list.
- **ITEM-19 (G · frontend)**: **`src-app/ui/src/modules/workbench-ai/`** — a chat/AI **panel** as a
  `ViewContribution` in a workbench dock (P6): streaming assistant output + a **tool-approval UI** (approve/deny
  pending tool calls, showing tool + args + safety badge) + a "what the AI did" provenance link. Reuse txresbench's
  chat UI kit if the chat substrate ports its FE; else minimal.
- **ITEM-20 (G · registration/kill-switch)**: `mod.rs` module registration (ordered after the mcp substrate so the
  table/client exist), deterministic `workbench.txr.internal` server id, deploy-level `workbench_mcp.enabled`
  kill-switch gating init + routes + row upsert (control_mcp §16 pattern), loopback-pinned URL.
- **ITEM-21 (G · acceptance)**: **Worked-example end-to-end** — "cells with gene ABC > its median → label XYZ"
  (§0.4.1): the AI emits `selection.set_by_predicate(gt(gene ABC, median(gene ABC)))` → host evaluator computes
  in-process → sets selection → `annotate.assign(label=XYZ, selection=current)`. Two declared tools, one
  auto-approved (read-run select) + one gated (mutating assign) → provenance run node → sync to a live viewer.
  **The convergence gate** that proves generator + DSL + approval + provenance compose.
- **ITEM-22 (tests)**: Unit (contribution→tool incl. artifact-ref rewrite; safety→annotation; `ai:false` hidden;
  role/perm filter). Integration (per-study tool list filtered by viewer/editor/owner; `invoke` dispatches +
  re-authorizes + 403s a viewer's mutating call; tool_calls recorded; provenance run node created). Real-LLM
  (a chat drives cluster→select-by-predicate→annotate end-to-end, gated on API key). E2E (chat panel + approval UI).

---

## Files / modules

**SDK (coordinated with live1):**
- `sdk/crates/txresbench-mcp/` (new) — `mcp_servers` table + repository + client/session + chat_extension + tool-approval
  + tool_calls + untrusted guard + built-in seam (ITEM-1).
- `sdk/crates/tinnlab-providers/` (new, or promote txresbench's `ai-providers`) — OpenAI-compatible tool-use client (ITEM-2).
- `sdk/crates/txresbench-control-mcp/` (extend) or `txresbench-mcp-generator/` (new) — factor a generic `ToolGenerator`
  projection shared by control's OpenAPI catalog + the workbench registry catalog (ITEM-5).

**TxResBench app (backend):**
- `src-app/server/src/modules/chat/` (new) — minimal chat: conversation/message store, streaming, chat_extension
  chain host (ITEM-2/17).
- `src-app/server/src/modules/workbench_mcp/mod.rs` — module def + per-study built-in row registration + kill-switch (ITEM-14/20).
- `.../workbench_mcp/generator.rs` (a.k.a. `catalog.rs`) — `build_workbench_catalog`, analysis/command/selection
  projection, `ai:false` filter, availability gating (ITEM-5/6/7/10/15). Analog of `txresbench-control-mcp/src/catalog.rs`.
- `.../workbench_mcp/tools.rs` — fixed host-tool descriptors + handlers (ITEM-8). Analog of `txresbench-control-mcp/src/tools.rs`.
- `.../workbench_mcp/resources.rs` — catalog/selection/data-schema/DSL-vocab providers (ITEM-9).
- `.../workbench_mcp/policy.rs` — safety→annotation + approval class + role/`gate:` filter (ITEM-12/13). Analog of `txresbench-control-mcp/src/policy.rs` (reuse its `is_mutating`/deny primitives).
- `.../workbench_mcp/handlers.rs` — JSON-RPC route + `invoke` dispatch (reuse `txresbench_framework::mcp`) (ITEM-11/14).
- `.../workbench_mcp/routes.rs` — the `/api/studies/{id}/workbench/mcp` mount + OpenAPI.
- `.../workbench_mcp/chat_extension.rs` — attach flag + untrusted-content guard + system note (ITEM-16/17).
- `.../workbench_mcp/provenance.rs` — thin wiring to P4 run nodes + P10 sync (ITEM-18).
- `.../workbench_mcp/permissions.rs` + `.../workbench_mcp/repository.rs` (per-study row) (ITEM-3/14).
- `src-app/server/src/modules/contributions/backend_catalog.rs` (P5-owned; new) — `ContributionCatalog` +
  `init_from_registry` (ITEM-4).
- Migration `…_workbench_mcp.sql` — per-study workbench server rows + (from substrate) `mcp_servers` /
  `tool_use_approvals` / `mcp_tool_calls` tables; `workbench_mcp::use` grant.

**TxResBench app (frontend):**
- `src-app/ui/src/modules/workbench-ai/` (new) — chat panel `ViewContribution` + streaming + tool-approval UI +
  provenance link (ITEM-19).

**Modify:**
- `study/lifecycle.rs` + `study/core/extension/registry.rs` — register/teardown the per-study workbench server via
  the study-extension lifecycle hooks (ITEM-14, `on_study_deleted`).
- the ITEM-1 substrate's `auto_attach_builtin_ids` + `is_builtin_server_id` (ITEM-17).
- P5 contribution-registry type — carry the LLM-metadata fields (`ai?`, `safety`, `when`, `examples`, per-param
  `doc`) as first-class contribution fields (§0.4.2), consumed by both the human form and this generator.

## Reuse
- **`txresbench-framework::mcp`** — JSON-RPC 2.0 envelope (`JsonRpcRequest/Response/Error`, `from_app_error`) +
  `loopback_host` security pin. Use verbatim for ITEM-14.
- **`txresbench-control-mcp`** — the shape to copy AND share: `catalog` (registry→descriptor ingest), `policy`
  (`is_mutating`/deny classification + per-user filter), `tools` (static descriptors + list/describe/invoke
  meta-tool idea). The workbench generator IS control_mcp's pattern re-sourced from the contribution registry;
  ITEM-5 extracts the shared `ToolGenerator`.
- **txresbench reference `modules/mcp` + `modules/chat` + `ai-providers`** (`/data/pbya/txresbench/txresbench/...`) — the port
  source for ITEM-1/2: `client/session.rs` (`McpCallContext` record chokepoint), `chat_extension` auto-attach
  pattern (bio_mcp/web_search/lit_search/knowledge_base all follow it), `tool_calls/` (history+record+prune),
  `user_policy` (approval bypass for built-ins), sampling. The built-in `*_mcp` servers are the concrete template
  for a study-scoped loopback JSON-RPC built-in server.
- **live8 `feat/study-management`** — `EffectivePermission` (role gate, ITEM-12) + sync (ITEM-18); already in
  TxResBench `modules/study` + `modules/sync`.
- **P5 registry** (contribution source), **P8 predicate DSL + evaluator** (selection tools + DSL vocab resource),
  **P1 data API + catalog** (resources + artifact-ref enums), **P2 datatypes**, **P3 JobRunner** (analysis
  dispatch → sandboxed compute), **P4 provenance** (run nodes), **P6 dock/view slot** (chat panel),
  **P10 study substrate** (roles + sync + lifecycle cascade).
- TxResBench already uses **aide/OpenAPI** + `linkme` MODULE_ENTRIES + `txresbench-framework::serve` — the
  registration/route seam is present.

## Dependencies
- **ITEM-1/2 (host MCP+chat+ai-providers substrate) — HARD, BLOCKING;** nothing in P9 runs without a chat loop +
  MCP host + approval flow. Owned jointly with the platform bootstrap / live1. **The single critical dependency;
  surface to the human (DEC-1).**
- **ITEM-4 (P5 backend catalog seam) — HARD;** the generator sources from the backend contribution catalog. P5
  must expose it backend-readable.
- Generator (ITEM-5/6/7/10/15) depends on **P5**.
- Fixed tools (ITEM-8) + resources (ITEM-9) depend on **P8** (DSL + evaluator) and **P1** (data API/catalog/schema).
- Authz/safety gating (ITEM-12/13) depends on **P10** (`EffectivePermission`) + ITEM-1's approval flow.
- Per-study server lifecycle (ITEM-14) depends on **P10** study lifecycle + `on_study_deleted`.
- Dispatch (ITEM-11) depends on **P3** JobRunner + **P8** evaluator + the command handler.
- Provenance/sync (ITEM-18) depends on **P4** + **P10 sync**.
- Frontend panel (ITEM-19) depends on **P6** dock/view slot + ITEM-2's chat FE (or minimal).

## Sequencing
1. **ITEM-1 + ITEM-2 + ITEM-3** (substrate + perm) — external prerequisite; coordinate with live1; everything else
   stubs against it.
2. **ITEM-4** (P5 backend catalog seam) — in parallel with P5.
3. **ITEM-5** generator scaffold + **ITEM-10** metadata/opt-out (pure, testable against a fixture registry, no host
   needed — start here, it's DB-free like control_mcp's `build_catalog`).
4. **ITEM-6 + ITEM-7** projection arms (analyses, commands/selection-actions).
5. **ITEM-8** fixed host tools (needs P8/P1) + **ITEM-9** resources.
6. **ITEM-11** dispatch + **ITEM-12/13** authz/safety gating + **ITEM-15** availability gating.
7. **ITEM-14** per-study server + JSON-RPC handler + lifecycle registration + **ITEM-16** guard + **ITEM-20** registration/kill-switch.
8. **ITEM-17** chat-extension auto-attach + **ITEM-18** provenance/sync.
9. **ITEM-19** frontend chat + approval panel.
10. **ITEM-21** end-to-end acceptance (the §0.4.1 worked example) — the convergence gate. **ITEM-22** tests
    throughout; real-LLM/E2E last.

## Decisions
- **DEC-1 (blocking, human):** host substrate = **promote to SDK Tier-1 (`txresbench-mcp` + `tinnlab-providers` +
  minimal chat)** — the SDK's stated roadmap ("Tier-1 `mcp` registry v1.5"), TxResBench is app #2 dogfooding the
  SDK, and other apps will need it. **Fallback:** targeted port of txresbench `modules/{mcp,chat}` + `ai-providers` into
  TxResBench app modules (domain-stripped) if live1 can't land it in time — file the extraction as an SDK gap.
- **DEC-2:** the workbench MCP server is **backend loopback JSON-RPC** (like every other built-in), not a
  client-side tool host — even though `selection.set_by_predicate` evaluates "in-process," the *backend* evaluates
  against the P1 data plane and pushes the resulting selection to the live client via **sync** (§0.4 co-drive).
- **DEC-3 (tenancy — the delta both rounds differed on):** **one MCP server row PER study** (deterministic UUID
  keyed on study_id), NOT one global row with the study passed as tool context. **r1 chose per-study rows; r2
  chose one row + study-as-context.** We pick **per-study rows as the safer default** because: (a) it makes the
  tool set, availability gating (ITEM-15), and role gating (ITEM-12) naturally study-scoped, shrinking the
  study-scope-leak surface (R5) — study_id is structural, never a model-supplied arg; (b) lifecycle teardown is
  simply the study cascade (`on_study_deleted`), mirroring the per-study `STUDY_EXTENSIONS` tenancy model. The r2
  "one row + context" simplification is revisitable only if a single conversation must bind multiple studies; the
  isolation win outweighs the extra registration row.
- **DEC-4:** the generator is **SHARED code with control_mcp** (a generic `ToolGenerator` projection), not a fork —
  control = OpenAPI-sourced, workbench = contribution-registry-sourced; both emit MCP tool descriptors + the same
  JWT-forward invoke discipline (ITEM-5).
- **DEC-5:** chat is a **minimal in-app module**, not a full txresbench `chat` port — conversation + message + streaming
  + the chat_extension tool loop only; skip projects/loop-settings/title/export (add later if needed).
- **DEC-6:** view-kinds are addressed by a **single `view.set(cell, kind)` tool**, NOT one tool per viewer
  (§0.4.2). Field-providers / result-renderers are internal, never tools.
- **DEC-7:** `ai: false` **omits** a contribution from `tools/list` (not merely marks it); mutating/destructive
  tools are **filtered out of `tools/list` for viewers** in addition to invoke-time re-auth (defense in depth).
- **DEC-8:** dispatch **reuses the capability path, never a shadow executor** — an AI analysis call enqueues the
  SAME `JobRunner` a human click does → identical run node/provenance/sync (ITEM-11/18).
- **DEC-9:** the LLM-metadata fields (`description`/`when`/`examples`/`doc`/`safety`/`ai`) are **P5 registry
  fields**, authored once, consumed by both the human form and this generator — no parallel metadata store.
  `when`/`examples` fold into the tool **description** (no separate MCP routing field); safety → MCP tool
  **annotations** (`readOnlyHint`/`destructiveHint`).

## Risks
- **R1 (highest):** the entire AI surface rests on a host chat+MCP substrate this app doesn't have — P9 is ~50%
  "build the AI substrate" before any generator work. If DEC-1 lands as a full port it's weeks; if the SDK Tier-1
  `mcp` registry slips, P9 has nothing to sit on. **P9 is cheap only if the substrate is provided.** Mitigate:
  land ITEM-1/2 early as SDK crates, coordinate with live1, stub the generator against a fixture catalog meanwhile.
- **R2:** P5 backend-readability — the contribution registry is TS/frontend-first; the backend generator needs a
  backend-readable manifest catalog. If P5 keeps contributions frontend-only, the generator has nothing to ingest.
  Mitigate: ITEM-4 must be a firm P5 seam (manifest → backend catalog at boot).
- **R3:** artifact-ref → tool-param projection (ITEM-6) needs the catalog query to enumerate compatible-subtype
  artifacts at `tools/list` time; enum lists can be large (many embeddings). May need "pass an artifact id of type
  X, list via `catalog.query`" indirection instead of a materialized enum for big studies.
- **R4:** selection-as-recipe evaluated backend-side must reference the **same** canonical `system_cell_id` axis
  the client's live selection uses, or AI-set and human-set selections diverge (§0.4.1). Depends on P8/P1 axis
  contract being shared, not per-surface.
- **R5:** study-scope leak — a generated tool must not reach another study's artifacts. Mitigate: study_id is
  server-derived (per-study server row, DEC-3) never a model arg, + owner/role filter at both list and dispatch
  (control's per-user filter + TxResBench's `get_by_id_and_user` 404-on-foreign discipline).
- **R6:** availability gating (ITEM-15) at `tools/list` time can produce a **stale** tool set if artifacts change
  mid-conversation — wire `notifications/tools/list_changed` or re-attach on sync, or the AI plans against a stale
  graph.
- **R7:** approval UX for a **chained** AI plan (predicate-select auto-approved, then assign gated) — the human
  must approve the mutating step without re-approving the read step; a per-call approval storm harms UX. Confirm
  the ported approval flow supports per-tool-call granularity (txresbench's does, via `tool_use_approvals`); add a
  batch/"approve this plan" affordance, destructive always explicit.
- **R8:** async analysis dispatch is a sandboxed job (possibly minutes) — the MCP `tools/call` must return a **job
  handle + stream progress**, not block. Reuse txresbench's async-tool + `structuredContent` + `get_tool_result`
  (tool_result_mcp) pattern so long analyses don't hang the LLM loop.
- **R9:** provenance completeness — an AI call that bypasses the JobRunner path (an in-host builtin) must still
  record a run node; enforce via DEC-8 (single capability path).
- **R10:** desktop single-user exercises the "viewer" role only via study sharing; a solo owner is always editor+,
  so viewer-gating is tested only in the shared/server case — test needs a second user.
- **R11:** sqlx compile-time vs a runtime contribution store — if contributions live in runtime rows (Phase-5
  provisioners), the generator reads runtime rows (fine) but the migration-merge glob leaks (SDK_GAPS N-1/N-2);
  hand-scope which SDK crate migrations merge.

## Effort
- **Substrate (ITEM-1/2), NOT owned by P9:** L–XL — a multi-crate SDK extraction (`txresbench-mcp` +
  `tinnlab-providers`) + a minimal chat module. Port ~2-4 weeks; SDK Tier-1 promotion comparable, shared with live1.
- **Perm/P5 seam (ITEM-3/4):** S–M, co-owned by P5.
- **Generator core (ITEM-5/6/7/10):** M, ~3-4 d — control_mcp's pattern re-sourced, mostly pure + unit-tested.
- **Fixed tools + resources (ITEM-8/9):** M, ~3 d — mostly wiring to P8/P1.
- **Dispatch + authz/safety + availability (ITEM-11/12/13/15):** M, ~2-3 d.
- **Per-study server + handler + lifecycle + registration/guard (ITEM-14/16/20):** M, ~2-3 d.
- **Chat-extension + provenance/sync (ITEM-17/18):** M, ~2 d.
- **Frontend chat + approval panel (ITEM-19):** M.
- **Acceptance + tests (ITEM-21/22):** ~1-2 d for the §0.4.1 worked example, tests throughout.
- **Total:** XL, **dominated by the substrate (R1).** Generator-and-gating proper is **~2-2.5 weeks of P9-net-new**
  once the substrate exists. Convergence gate = ITEM-21 green (two-tool worked example: read-run auto-approved →
  mutating gated → provenance run node → sync to a live viewer).
