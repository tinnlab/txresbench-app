# P10 — Study Substrate (FINAL)

## Reconciliation applied

- **A5 — one `SyncEntity` name.** P10 emits the study-scoped `SyncEntity::Artifact` (the same entity P1
  OWNS/DEFINES for its `artifacts`/`analysis_results` catalog row); the earlier `SyncEntity::AnalysisResult`
  is retired to avoid a duplicate variant for one catalog row. P1 defines the variant + OpenAPI regen; P10
  only EMITS it to the study (owner ∪ accepted-share) audience. FE subscribes to `sync:artifact`.

---

Tenancy · access (owner/editor/viewer) · sharing · transfer · lifecycle-cascade · sync — the platform
scoping boundary wrapping the working store (P1), catalog (P2), compute/jobs (P3), provenance (P4),
Layer-C collections (P5), workbench shell (P6), selection/recipe (P8), and the per-study MCP server (P9).

**Role.** P10 does NOT invent tenancy/authz/sharing/sync — live8 already built that
(`feat/study-management` + `feat/study-admin` + `feat/study-extensions`). **BASE NOTE (2026-07-16): the true
build base is LOCAL `main` (`63520fb`), which is AHEAD of `origin/main` (`29b9b29`, not yet pushed) and already
has all three study branches merged** (49 study files, `EffectivePermission`, `STUDY_EXTENSIONS`, migrations
through `202607160007`). The r3 "already ancestors of main" claim was correct — against local main. So ITEM-1
is genuinely verify-consolidation-complete (NOT a fresh merge) for the study stack; only `feat/provenance` and
`feat/visualization` remain unmerged (they land as their own foundation steps). Build every feature worktree off
local `main` (`63520fb`), never `origin/main`. P10 (a) lands/consolidates that substrate on main
and pins a baseline, and (b) EXTENDS it with the small set of reusable seams the new platform data layers
consume so every artifact/catalog row, job, provenance node, Layer-C collection, and per-study MCP server
inherits study tenancy, owner/editor/viewer access, collaborator sync, and delete/duplicate/transfer
lifecycle **for free** — plus the one gap the substrate's transactional hook cannot close: object-store
**blob GC**. `feat/provenance` is the only P10-relevant branch NOT yet merged (design-done, paused).

**Deployment scope:** desktop (single implicit owner) + single-box server (multi-user + sharing). Sharing/
transfer are live on 1-box; gated off on desktop.

The generic `EntityExtensionRegistry` (SDK G8) generalization is a flagged NOTE, not a build item.

---

## Items

- **ITEM-1**: **Land + consolidate live8's three study branches on main** and pin a `SUBSTRATE_BASELINE`
  note. `feat/study-management` (base: studies/shares/transfers/settings/datasets/grants migrations
  `202607160001..07`) → `feat/study-admin` (cross-user `study::admin::*` twin) → `feat/study-extensions`
  (`STUDY_EXTENSIONS` registry + `DatasetStudyExtension`). r3's grounding confirms all three are already
  ancestors of main, so this item is **verify-consolidation-complete + reconcile any residual layering**,
  NOT a fresh merge; the invariant to preserve is that the admin-delete path routes through the shared
  `delete_study_with_extensions` chokepoint. Write a short baseline note pinning the merged commit + the
  exact seams (`EffectivePermission`, `effective_permission()`, `STUDY_EXTENSIONS`, `delete_study_with_
  extensions`, the 3 sync entities + `StudySettings`) the new layers plug into. **P10 depends on this
  consolidation being on main before anything else wires.**

- **ITEM-2**: **Reusable `StudyScope` axum extractor / access seam** (`study/scope.rs`, new). Wraps the
  already-built `StudyRepository::effective_permission(study_id, user_id) -> Option<EffectivePermission>`
  (`repository.rs:70`, owner short-circuit + `study_shares status='accepted'` level). Resolves the acting
  user's role **once** into `StudyScope { study_id, user_id, perm }`; exposes `require_role(min)` /
  `require_can_edit(&scope)` → **403** on insufficient, **404** on `None` (foreign study invisible,
  matching the owner-scoped 404 idiom). This is the SINGLE study-authz chokepoint every platform endpoint
  (P1 data-API, P3 jobs, P4 provenance, P9 MCP) calls instead of re-implementing `effective_permission +
  .can_edit()/.is_owner()`. Refactor the ~7 inline re-fetch sites in the existing study handlers onto it
  (behavior-preserving). Include an **admin override**: root-admin / `study::admin::*` holders resolve to
  Owner-equivalent so the admin twin flows through the same guard (strictly gated — must NOT widen a normal
  user's access).

- **ITEM-3**: **Data-API read/write scoping from `EffectivePermission`.** Wire ITEM-2 into P1's data-API:
  **reads** (`catalog()`, `embedding()`, `obs()`, `geneColumn()`, `clustering()`, `deTable()`, typed-binary
  /Zarr byte-range serve) require any resolved role (Viewer+); **writes** (`writeResult`, `writeAnnotation`,
  catalog inserts, Layer-C mutations) require `can_edit()` (Owner/Editor). Viewer → **403** on any mutation.
  This 403 is the server-authoritative boundary; the FE gate (ITEM-6) is UX-only.

- **ITEM-4**: **Two-level authz composition (study role × capability gate) with explicit precedence.** Every
  extension endpoint enforces BOTH layers: **outer** = app RBAC capability gate (`RequirePermissions<(P,)>`,
  the contribution's declared `gate:`, e.g. `pathways::use`) — "is this user allowed the feature at all";
  **inner** = ITEM-2 study role — "and do they reach this study, at what level." Provide a combined
  capability-then-role guard helper + document/test the precedence: **capability 403 fires BEFORE study
  404**. NOTE the study module itself uses a SINGLE `studies::use` verb for all study CRUD (the per-study
  ACL is the edit/delete boundary — no per-analysis RBAC verb explosion); the inner capability layer is for
  an extension's OWN declared gate, never for study edit/delete.

- **ITEM-5**: **`study_id` FK + gate contract for all platform data layers (owned + test-enforced).** Every
  platform table holding extension data — P1 `analysis_results`/artifacts/working-store index, P3 `jobs`,
  P4 provenance run-nodes/edges/`code_blobs`, P5 Layer-C collections, P8 selection/recipe rows, P9 per-study
  MCP registration — carries `study_id UUID NOT NULL REFERENCES studies(id)` and is reached **only** through
  `StudyScope`. **Data layers are study-scoped, never owner-scoped** — so ownership transfer is a single
  `owner_id` update with no data cascade, and access derives purely from `EffectivePermission`. P10 OWNS the
  contract + a doc/test asserting the FK exists on every platform table; the owning parts (P1/P3/P4/P5/P8/P9)
  add the column (cross-part dependency).

- **ITEM-6**: **Central workbench `canEdit` context (FE).** Replace the ad-hoc per-component role derivation
  (today re-derived at ≥4 sites: `StudyCard.tsx:19-20`, `StudyDetailPage.tsx:34-35`, `StudyFormDrawer.tsx:22`
  `readOnly`, `dataset/study-extension/components/DatasetsPanel.tsx:21-22`) with ONE
  `StudyScopeProvider` / `useStudyRole()` / `useCanEdit()` exposing `{role, canEdit, isOwner, isViewer}`
  derived once from `StudyDto.effective_permission`. The P6 shell + EVERY extension contribution (Run/write/
  assign/delete affordances) reads `canEdit` from it → a Viewer gets a fully-rendered but read-only
  workbench. Refactor the existing study components onto the context. `canEdit` is derived, never persisted.

- **ITEM-7**: **Workstore/catalog StudyExtension impl (Layer A artifacts + Layer B `analysis_results`
  catalog) — the delete/duplicate cascade.** Register a `#[distributed_slice(STUDY_EXTENSIONS)]` entry
  (NOT a study-core edit; mirrors `dataset/study_extension/`) at a distinct `order` (e.g. `50`, vs dataset's
  `40`). `on_study_deleted(study_id, &mut tx)` deletes the study's catalog rows in-tx AND **collects/marks
  the study's artifact blob refs into the delete transaction's GC manifest** (see ITEM-9 — it does NOT unlink
  blobs in-tx). `on_study_duplicated(src, dst, &mut tx)` deep-copies catalog rows and **re-references** the
  same immutable content-addressed blobs by hash (copy the index rows, not the bytes — cheap + correct).
  `collect_summary` contributes an `"N results / M GB"` study tag. Fires atomically via the existing
  `delete_study_with_extensions`.

- **ITEM-8**: **Collections StudyExtension impl (Layer C) — cascade over extension-owned relational data.**
  A second `#[distributed_slice(STUDY_EXTENSIONS)]` entry at a distinct `order` (e.g. `60`) for P5's generic
  `scope:study` collections store (pathway-sets / annotation-history / saved-gates): `on_study_deleted` drops
  all the study's collection rows across ALL extensions (one generic host-owned impl); `on_study_duplicated`
  copies them into `dst`. Covers Layer-C without each extension writing a hook.

- **ITEM-9**: **Blob-GC seam — collect-then-post-commit-sweep, refcounted (the headline).** The
  `on_study_deleted(study_id, &mut tx)` hook is transaction-scoped, so it can only touch DB rows — it CANNOT
  (and must not) delete object-store blobs inside the tx (a file delete can't roll back; a blob may be shared
  with another study/dataset). **BAKED-IN BOUNDARY (agreed P1+P10 r3):**
  - **P10 side (in the delete transaction):** `on_study_deleted` + `delete_study_with_extensions` COLLECT/
    MARK the study's artifact blob refs into a `GcManifest` returned from the chokepoint. Atomicity preserved
    — the DB rolls back on any hook error and no blob is touched.
  - **P1 side (post-commit, standing sweep):** the **content-address REFCOUNT SWEEP that actually frees
    blobs is P1's**, run AFTER commit succeeds. It cannot close transactionally across the shared
    content-addressed store, so it is a post-commit standing sweep: P1's blob-store delete primitive frees a
    blob only when its hash has **no surviving storage-ref** (dataset rows, catalog `analysis_results`
    storage-refs, provenance code-blobs, Layer-C collections). P10 hands P1 the manifest; P1 owns the
    refcount query/view + the delete primitive + the periodic background orphan-reaper (mirrors txresbench's mcp
    tool-call prune loop) that self-heals a crashed sweep by re-deriving orphans from the refcount query.

  Clean seam split (DEC): P10 decides WHAT to GC (collect in-tx); P1 decides HOW/WHEN to free (post-commit
  refcounted). Rejected: synchronous in-tx blob delete (non-atomic, corrupts on rollback) and fire-and-forget
  delete (dedup-unsafe).

- **ITEM-10**: **Retrofit the shipped dataset-extension orphan.** The current
  `dataset/study_extension/repository.rs::delete_datasets_for_study` (and detach) does `DELETE FROM datasets`
  only, **orphaning the uploaded matrix blobs** in the P1 file store — a live storage leak on every study
  delete. Once the ITEM-9 seam exists, retrofit it to enqueue its blob refs into the `GcManifest`.

- **ITEM-11**: **`duplicate_study_with_extensions` chokepoint hardening.** live8 fires
  `fire_on_study_duplicated` **inline in the `duplicate_study` handler** (`handlers.rs:216`), NOT via a
  shared lifecycle chokepoint like delete has. Add the symmetric `duplicate_study_with_extensions`
  (`study/lifecycle.rs`) so duplicate fires over one tx the same way delete does; move the handler onto it.

- **ITEM-12**: **Reusable study-collaborator sync audience helper.** `study_audience(pool, study_id) ->
  (owner_id, Vec<recipient_id>)` = owner ∪ the already-built `accepted_recipient_ids(study_id)`
  (`repository.rs:~430`), reusing `publish_study_to_all` fan-out. ONE helper the platform result-write path
  calls, replacing per-emit-site manual owner+recipients fans.

- **ITEM-13**: **Extension result-write → study-scoped sync.** When an extension produces a result (a catalog
  row via `writeResult`, a provenance node), the host publishes a study-scoped notify-and-refetch event to
  the ITEM-12 audience so a shared workbench updates live when a collaborator (or the AI) produces a
  clustering/DE. Reuse the ONE `SyncEntity::Artifact` (the same entity P1 owns/defines for its
  `artifacts`/`analysis_results` catalog row — NOT a separate `AnalysisResult` variant); P10 EMITS it to the
  study audience (owner ∪ accepted shares; notify-and-refetch the study catalog, not per-datatype). P1 owns
  the variant + OpenAPI regen in BOTH binaries. Add the FE store subscription (`sync:artifact`) that
  **self-gates** on `studies::use` (the no-403-reconnect rule) and refetches.

- **ITEM-14**: **Study-role → per-study MCP capability gate (P9 boundary).** The per-study MCP server (P9)
  derives its allowed tool set from the caller's `EffectivePermission` (via `StudyScope`) × each
  contribution's declared **safety hint** (§0.4.2): Viewer → `read-run` only; Editor → + `mutating`; Owner →
  + `destructive`. P10 owns the `role → max-allowed-safety-tier` map + filter fn + the check; P9 wires it
  into tool generation + the approval flow. The per-study MCP registration row is a data layer under the
  ITEM-5 contract (cascades on delete via ITEM-7's manifest).

- **ITEM-15**: **Viewer read-only hand-off (the PI/reviewer JTBD — an acceptance path, not a new feature).**
  Sharing a study as `viewer` yields the interactive read-only workbench: all result renderers render,
  selection/brush/pick work for exploration, but every mutation affordance is disabled (ITEM-6), every write
  endpoint 403s (ITEM-3), and no mutating MCP tool is exposed (ITEM-14). Provide a small
  `GET /studies/{id}/access` (or fold `{role, can_edit}` into the catalog bootstrap) that P6 consumes — this
  is P10's single hard dependency edge INTO P6 (WORKBENCH_IA does not yet reference the role). Wire the "open
  shared study → its workbench section" nav (reuse `StudyDetailPage` `/studies/:id/:section` + STUDY_SLOTS).

- **ITEM-16**: **Ownership-transfer re-scoping (verification).** On `StudyTransfer` accept, data layers do
  NOT move — only `study.owner_id` flips (all data is study-scoped per ITEM-5, not owner-scoped).
  `accept_transfer` (`repository.rs:575-621`) already, in one tx, flips `owner_id`, deletes the new owner's
  residual self-share, and re-points remaining `study_shares.owner_id`. Verify no denormalized `owner_id`
  exists on any data layer, and that the re-emitted `SyncEntity::Study` (fanned to old+new owner) makes both
  workbenches re-derive `canEdit` from the fresh `effective_permission`. No `on_study_transferred` hook.

- **ITEM-17**: **Provenance-substrate reconciliation (`feat/provenance`, the ONE unmerged branch).** Its
  execution model (run nodes + input/output edges + content-addressed code blobs, §0.6/§B3) is Phase-0c and
  must land ON the merged substrate: provenance tables carry `study_id` (ITEM-5), register their own
  `#[distributed_slice(STUDY_EXTENSIONS)]` entry (`on_study_deleted` → rows in-tx + code-blob refs into the
  GcManifest per ITEM-9; `on_study_duplicated` → deep-copy graph nodes/edges, re-reference code-blobs), and
  emit study-scoped sync (ITEM-13). Reconcile onto the merged `STUDY_EXTENSIONS` seam using a real
  merge-base diff (not tip-vs-main), since the branch was authored before the merged substrate shape.

- **ITEM-18**: **Admin cross-user twin — extend, don't rebuild.** The admin twin (`admin_handlers.rs`:
  change-owner / share-on-behalf / reassign / delete / bulk / list / user-search / detail, gated
  `study::admin::{read,manage}`) is already merged and admin-delete already routes through
  `delete_study_with_extensions`. P10 EXTENDS the surface (no new CRUD verbs): (a) `admin_get_detail`
  surfaces per-study **storage/artifact/catalog footprint** (result count + blob GB, from ITEM-7's
  `collect_summary`) so an admin sees a footprint before delete; (b) confirm admin-delete's GcManifest
  post-commit sweep fires (ITEM-9) so an admin delete reclaims blobs, not just rows; (c) an admin
  **orphan-blob / storage read view** backed by P1's refcount query for a manual reap. FE: a
  `StudyAdminDetailDrawer` footprint panel.

- **ITEM-19**: **Selection/recipe writes are study-scoped, provenance-linked.** Confirm the
  selection-as-recipe rows (P8, predicate + input hash) carry `study_id` and emit via ITEM-12/13, so a shared
  collaborator sees a co-worker's selection/clustering/DE appear live. Contract assertion + a cross-device
  e2e.

- **ITEM-20**: **P3 jobs as a first-class cascaded data layer.** `jobs` FKs `study_id` (ITEM-5), gate through
  `StudyScope` (ITEM-2), register a `STUDY_EXTENSIONS` entry whose `on_study_deleted` deletes the study's job
  rows + any job-owned working-store artifacts (blob refs → GcManifest). P3 provides the impl; P10 owns the
  pattern + the cascade-coverage assertion.

- **ITEM-21**: **Desktop single-user degeneracy.** On the embedded desktop server (`isDesktop` =
  `window.__TAURI__`), the acting user is always Owner; share/transfer routes + UI are gated off BOTH sides
  (config flag + `CORE_MODULE_BLOCKLIST`, per the desktop-embeds-server rule) — the study scoping code path
  is identical, just single-tenant. Verify the platform INHERITS live8's gating (no re-implementation), that
  the lifecycle cascade (ITEM-7/8/17/20) + result-writes (ITEM-13) run with an empty recipient list
  (fan-to-self) without empty-audience panic, and extend the existing `study/desktop-gating.spec.ts` to the
  new data layers.

- **ITEM-22**: **Tests (spanning the part).** Unit: `EffectivePermission` gate matrix; `StudyScope` resolves
  owner/editor/viewer/none(→404)/admin-override; two-level precedence (capability-403-before-study-404);
  `study_audience` membership; `role → max-safety-tier` map. Integration: delete cascades all registered
  platform layers (catalog + provenance + jobs rows gone; GcManifest emitted; post-commit sweep frees blobs);
  **shared-blob survival** (two studies share a hash, delete one, assert the blob survives — the
  dedup-corruption guard); duplicate deep-copies (blob re-reference, not byte copy); transfer moves `owner_id`
  with data intact (no owner-scoped orphan); viewer write→403 / editor write→200; cross-user study→404;
  cascade-coverage test enumerating registered extensions vs the known data-layer set; per-study MCP
  viewer-vs-editor tool gate. E2E: share-as-viewer→read-only workbench; transfer accept→ownership moves +
  collaborator sync; desktop share/transfer hidden.

---

## Files/modules

**Backend — new P10 seams:**
- `server/src/modules/study/scope.rs` — NEW. `StudyScope` extractor, `require_role`, `require_can_edit`,
  admin override, `study_audience` (ITEM-2/4/12).
- `server/src/modules/study/lifecycle.rs` — MODIFY. `delete_study_with_extensions` returns a `GcManifest` +
  post-commit sweep call site; add `duplicate_study_with_extensions` chokepoint (ITEM-9/11).
- `server/src/modules/study/core/extension/registry.rs` — MODIFY. Extend `StudyExtension` trait:
  `on_study_deleted` gains a `&mut GcManifest` collector (or returns `Vec<BlobRef>`); keep default no-op
  (ITEM-9).
- `server/src/modules/analysis_catalog/study_extension/{extension,repository}.rs` — NEW. Layer A+B catalog/
  working-store StudyExtension (mirrors `dataset/study_extension/`) (ITEM-7).
- `server/src/modules/extensions/collections/study_extension.rs` — NEW. Layer C cascade (ITEM-8).
- `server/src/modules/dataset/study_extension/repository.rs` — MODIFY. Retrofit `delete_datasets_for_study` /
  detach to enqueue blob refs into the GcManifest (ITEM-10).
- `server/src/modules/file/` (P1 blob store) — the blob-delete primitive + content-address refcount query +
  background orphan-reaper the sweep calls. **Owned by P1, driven by P10's manifest** (ITEM-9).
- `server/src/modules/study/admin_handlers.rs` + `repository.rs` (`admin_get_detail`) — usage footprint +
  orphan-storage view (ITEM-18).
- `server/src/modules/sync/event.rs` — the `SyncEntity::Artifact` variant is DEFINED by P1 (owner of the
  `artifacts` catalog); P10 EMITS it to the study audience via `study_audience` (ITEM-13). No new P10 variant.
- provenance module (`feat/provenance`) — register as a StudyExtension; study-scope its tables (ITEM-17).
- P1/P3/P4/P5/P8/P9 migrations add `study_id` FK; their handlers switch to `StudyScope`; their writes publish
  via `study_audience` (ITEM-5, cross-part).
- P9 per-study MCP server — P10 supplies `role_max_safety(role)` filter; P9 wires it (ITEM-14).

**Frontend:**
- `ui/src/modules/study/context/StudyScopeProvider.tsx` + `hooks/useStudyRole.ts`/`useCanEdit.ts` — NEW.
  `{role, canEdit, isOwner, isViewer}` from `StudyDto.effective_permission` (ITEM-6).
- `ui/src/modules/study/components/{StudyCard,StudyDetailPage,StudyFormDrawer}.tsx` +
  `dataset/study-extension/components/DatasetsPanel.tsx` — MODIFY. Consume the context (ITEM-6).
- `ui/src/core/workbench/*` shell (P6) — MODIFY. Gate mutation affordances on `canEdit`; viewer read-only
  layout; consume `GET /studies/{id}/access` (ITEM-6/15).
- extension result stores — MODIFY. `sync:artifact` subscription, self-gated (ITEM-13).
- `ui/src/modules/study/` `StudyAdminDetailDrawer` — footprint panel (ITEM-18).

**Reuse (no change):** `study/repository.rs` (`effective_permission`, `accepted_recipient_ids`,
`duplicate_in_tx`, `accept_transfer`), `study/lifecycle.rs` chokepoint, `study/core/extension/registry.rs`,
`study/handlers.rs` (`publish_study_to_all`, transfer/share/admin handlers), `study/models.rs`
(`EffectivePermission`), `dataset/study_extension/` (reference impl), STUDY_SLOTS + `StudyDetailPage` shell +
`RecentStudiesWidget` + `isDesktop` gating.

---

## Reuse (live8's substrate — ALREADY built, all three branches already ancestors of main)

- **Access model** — `EffectivePermission { Owner, Editor, Viewer }` (`models.rs:18`): `.can_edit()`
  (Owner|Editor), `.is_owner()`, `.from_share_level()`, `.as_str()`. Resolver `effective_permission(study_id,
  user_id) -> Option<EffectivePermission>` (`repository.rs:70`; owner short-circuit + accepted-share lookup;
  `None` = invisible). `StudyDto.effective_permission: String` already on the wire.
- **Sharing** — `StudyShare {study_id, owner_id, recipient_id, permission_level, status}`, create/accept/
  decline/list/revoke routes, recipient notifications (SDK), `accepted_recipient_ids(study_id)` collaborator
  set.
- **Transfer** — `StudyTransfer {from_user_id, to_user_id, status}`, accept/decline + owner-cancel, admin
  change-owner (`keep_old_as_editor`), `StudySettings.transfer_enabled`; `accept_transfer` one-tx owner_id
  flip.
- **Lifecycle-hook seam** — `trait StudyExtension` (`on_study_deleted`, `on_study_duplicated`,
  `register_routes`, `collect_summary`, `initialize`; default no-op), `#[distributed_slice] STUDY_EXTENSIONS`
  (linkme), `auto_register_study_extensions` (sorts by `order`), process-wide `OnceCell`,
  `fire_on_study_deleted`/`fire_on_study_duplicated`.
- **Delete chokepoint** — `delete_study_with_extensions(pool, study_id)` fires hooks in the SAME tx as the
  row delete (atomic rollback). Duplicate currently fires inline in the handler (`handlers.rs:216`) — ITEM-11
  hardens this.
- **Sync fan-out** — `SyncEntity::{Study, StudyShare, StudyTransfer, StudySettings}`, `publish(...)`,
  `publish_study_to_all(action, study_id, owner_id, &recipients, origin)`. Notify-and-refetch wire.
- **Admin twin** (`feat/study-admin`) — `study::admin::{read,manage}`, `/settings/studies`, change-owner/
  share/revoke/delete/reassign + bulk; admin-delete already routes the shared chokepoint.
- **First-consumer reference** — `dataset/study_extension/` (order 40): deletes datasets on delete,
  deep-copies on duplicate, owns a `/dataset-summary` route, contributes a summary tag. The exact shape
  ITEM-7/8/17/20 mirror. `txresbench project/core/extension` is the upstream precedent.
- **txresbench-file CAS blob store** (adopted on main, 8045d78) — the P1 content-addressed store the GC sweep
  deletes from. **txresbench mcp tool-call prune loop** — the pattern for the background orphan-blob reaper.
- **FE** — STUDY_SLOTS + `<StudyExtensionSlot>`, `StudyDetailPage` `/studies/:id/:section`,
  `RecentStudiesWidget`, `isDesktop` share/transfer gating.

---

## Dependencies

- **ITEM-1 consolidation on main** — HARD prerequisite; nothing wires until live8's three study branches are
  consolidated on main (verified already ancestors; reconcile any residual). The critical dependency.
- **P1 (data foundation)** — MUST expose the blob-store delete primitive + content-address refcount query +
  background reaper for the GC sweep (ITEM-9); owns the working store + catalog `writeResult` that ITEM-3/7/13
  hook. Hardest coupling. BLOCKS 3/7/9/13.
- **P2 (catalog/datatypes)** — `analysis_results` schema carries `study_id` + a blob storage-ref (ITEM-5/7).
- **P3 (jobs)** — job access + cascade impl (ITEM-20).
- **P4 (provenance / `feat/provenance`)** — the one unmerged branch; must land as a StudyExtension on the
  substrate (ITEM-17).
- **P5 (contribution-api)** — the generic Layer-C collections store ITEM-8 cascades over.
- **P6 (workbench-shell)** — where `canEdit` gating + viewer read-only render; consumes
  `GET /studies/{id}/access` (ITEM-6/15). P10's one edge OUT.
- **P8 (selection/recipe)** — recipe rows study-scoped (ITEM-19).
- **P9 (ai-mcp)** — consumes ITEM-14's `role → max-safety-tier` map.
- `modules/sync` — new `SyncEntity` variant (ITEM-13) → OpenAPI regen BOTH binaries.
- **Blocked-by:** the Phase-0 foundation existing at all (working store + catalog + JobRunner→sandbox). P10
  is a scoping wrapper — nothing to scope until Phase-0 lands.

## Sequencing

1. **ITEM-1** consolidate + baseline note (verify three branches on main; reconcile residual). Unblocks all.
2. **ITEM-2, ITEM-12** reusable seams (StudyScope guard + admin override; study_audience) + refactor existing
   study handlers onto them — self-contained.
3. **ITEM-4, ITEM-5** two-level-authz precedence helper + publish the `study_id` FK/gate contract
   (P1/P3/P4/P5/P8/P9 consume as they build).
4. **ITEM-9 + P1 refcount primitive** blob-GC seam (trait `GcManifest` change + post-commit sweep + P1
   refcount query + background reaper). Land WITH Phase-0 P1/P2.
5. **ITEM-11** `duplicate_study_with_extensions` hardening (independent).
6. **ITEM-3, ITEM-7, ITEM-8** data-API scoping + catalog/Layer-C StudyExtension registrations (need P2 schema
   + P5 collections).
7. **ITEM-10** retrofit the shipped dataset orphan (once the seam exists).
8. **ITEM-13, ITEM-19** result-write + recipe study-scoped sync (after ITEM-12 + `writeResult`).
9. **ITEM-6, ITEM-15** FE context + workbench scoping contract (unblocks P6); parallel to backend track.
10. **ITEM-14** per-study MCP role gate — hand off to P9.
11. **ITEM-17** provenance merge onto substrate (after Phase-0c; merge-gate + lifecycle-check `--all`).
12. **ITEM-20** P3 jobs cascade — lands with P3.
13. **ITEM-18** admin footprint/orphan view (after ITEM-7 collect_summary data exists).
14. **ITEM-16, ITEM-21** transfer re-scope + desktop degeneracy — verification/acceptance.
15. **ITEM-22** tests throughout (unit early; integration/e2e as layers register).

## Decisions

- **DEC-1 — Adopt, don't rebuild.** live8's substrate is the answer; P10 wraps, never re-implements authz/
  sharing/transfer/sync. `effective_permission` is the SINGLE authz resolver.
- **DEC-2 — One `StudyScope` chokepoint** for all platform endpoints; replaces the ~7 inline
  `effective_permission` re-fetches. Admin override strictly behind `study::admin::*` / root-admin.
- **DEC-3 — Data layers are study-scoped, never owner-scoped.** Every catalog/artifact/job/provenance/
  collection/recipe/MCP row FKs `study_id`, not `owner_id` ⇒ transfer = single `owner_id` update, no
  `on_study_transferred` hook; access derives purely from `EffectivePermission`.
- **DEC-4 — Two-level authz with explicit precedence.** Outer = app RBAC capability `gate:` (feature-level
  allow, 403 first); inner = study role via `StudyScope` (resource-level, 404). `studies::use` is the study
  RBAC verb; per-study ACL is the edit/delete boundary (no per-analysis verb explosion). Viewer = full
  read-only workbench.
- **DEC-5 — Blob GC is collect-then-post-commit, refcounted, with a P10/P1 seam split (BAKED-IN, agreed
  P1+P10 r3).** The transactional hook CANNOT delete content-addressed blobs. **P10's `on_study_deleted`
  cascade COLLECTS/MARKS the study's artifacts within the delete transaction** (into a `GcManifest` returned
  from `delete_study_with_extensions`). **The content-address REFCOUNT SWEEP that actually frees blobs is
  P1's** — a post-commit standing sweep, because it cannot close transactionally across the shared
  content-addressed store; it frees a blob only when its hash has no surviving storage-ref, with a background
  reaper as the crash backstop. P10 decides WHAT to GC; P1 decides HOW/WHEN to free. Rejected: in-tx blob
  unlink (non-atomic, corrupts on rollback) + fire-and-forget delete (dedup-unsafe).
- **DEC-6 — Content-addressed duplicate = re-reference, not byte-copy.** `on_study_duplicated` copies catalog
  rows / provenance edges pointing at the SAME immutable blobs by hash (bumps refcount); only DB rows cloned.
- **DEC-7 — Two workstore + collections StudyExtension registrations at distinct `order` values** (workstore
  `50`, collections `60`; vs dataset `40`) for deterministic cascade firing.
- **DEC-8 — Study audience = owner ∪ accepted shares**, one `study_audience` helper; all extension
  result-writes publish through it. Reuse P1's ONE `SyncEntity::Artifact` (notify-and-refetch the study
  catalog) over per-datatype entities — NO separate `AnalysisResult` variant (A5).
- **DEC-9 — `canEdit` derived, never persisted** — single source = the server's `StudyDto.
  effective_permission`; the FE gate is UX, the authoritative gate is ITEM-3's 403.
- **DEC-10 — MCP role→safety map:** Viewer=`read-run`, Editor=+`mutating`, Owner=+`destructive` (reuses the
  §0.4.2 safety-hint vocabulary).
- **DEC-11 — P10 code ships INSIDE the layers it wraps** — the catalog StudyExtension + GC seam land with
  P1/P2, not as a standalone study PR; only `feat/provenance` is a discrete branch merge.
- **DEC-12 — Generic `EntityExtensionRegistry` (SDK G8) deferred** — keep `STUDY_EXTENSIONS` study-specific;
  the entity-parameterized registry is a flagged SDK gap, not built here.

## Risks

- **R1 — Dedup-delete corruption (HIGH).** A naive per-study blob delete corrupts another study/dataset
  sharing the hash. Mitigation: P1's ITEM-9 refcount is a hard gate; integration test shares a blob across
  two studies, deletes one, asserts survival (mirrors study-admin's cascade-survival test).
- **R2 — Orphan leak (MEDIUM).** A post-commit sweep that crashes leaks blobs. Mitigation: the background
  reaper re-derives orphans from the refcount query — a missed sweep self-heals.
- **R3 — Shipped dataset orphan (LOW, but LIVE).** `delete_datasets_for_study` already orphans blobs on every
  study delete today. Mitigation: ITEM-10 retrofit closes it; a known storage leak until then.
- **R4 — Provenance-merge drift (MEDIUM).** `feat/provenance` predates the merged substrate; its tables may
  assume the old shape. Mitigation: reconcile onto the merged `STUDY_EXTENSIONS` seam via a real merge-base
  diff (not tip-vs-main) during ITEM-17.
- **R5 — Owner-scoped leak (DEC-3).** Any part adding an `owner_id` column instead of `study_id` orphans data
  on transfer / breaks viewer/editor access. Mitigation: ITEM-5 contract test asserts the FK is `study_id` on
  every platform table.
- **R6 — Cascade completeness.** A data layer that forgets to register a `STUDY_EXTENSIONS` entry leaks
  rows/blobs (the DB cascade drops DB rows but not physical blobs). Mitigation: coverage test enumerating
  registered extensions vs the known data-layer set; the working-store cleanup is a platform extension, not
  optional.
- **R7 — Two-level authz double-403/404 confusion.** Needs the explicit precedence (DEC-4) + tests for each
  combination (no-capability / capability+no-study / capability+viewer-writes).
- **R8 — `StudyScope` admin-override over-reach.** The bypass must NOT widen a normal user's access; keep it
  strictly behind `study::admin::*` / root-admin; unit-test the matrix.
- **R9 — Workbench role-contract lag (LOW).** WORKBENCH_IA doesn't yet reference the study role; ITEM-15 must
  be agreed with P6 or the workbench ships without viewer read-only enforcement.
- **R10 — Duplicate over large studies.** Re-referencing is cheap, but provenance-edge copy can be large;
  keep it in the single tx (atomic) but watch tx size — acceptable at 1-box scale.
- **R11 — Desktop empty-audience.** Single-user runs sync fan-out with an empty recipient list
  (`accepted_recipient_ids → []`); ensure no empty-audience panic (ITEM-21).
- **R12 — New `SyncEntity` variant** requires OpenAPI regen in BOTH binaries (the known regen-both gotcha).

## Effort

**~M–L. Mostly integration/wiring** — the hard cross-cutting concerns (authz, sharing, transfer, sync, delete
cascade, admin twin) are already solved by live8 and on main. Net-new:
- ITEM-9/10 blob-GC seam + P1 refcount + reaper + dataset retrofit: **L** (cross-module with P1, the hardest
  part — the seam the transactional hook cannot close).
- ITEM-2/3/4/7/8 StudyScope guard + data-API scoping + two StudyExtension registrations: **M** (mirrors the
  dataset extension).
- ITEM-11/12/13 duplicate chokepoint + audience + result sync + regen: **S–M**.
- ITEM-6/15 FE context + 4-component refactor + workbench contract: **S–M**.
- ITEM-17 provenance merge onto substrate: **M** (branch reconcile + study-scoping its tables).
- ITEM-14/16/18/19/20/21 MCP gate + transfer/desktop verification + admin footprint + jobs/recipe cascade:
  **S–M**.
- ITEM-1/22 consolidation-baseline + tests: **S–M**.

Rough backend ~2–3 d access seam + scoping; ~2–3 d cascade impls (GC design carries the risk); ~2 d audience/
sync/regen; frontend ~1–2 d context + ~1 d read-only handoff; ~0.5–1 d MCP map + verification items.
**Total ~10–14 dev-days**, gated on P1/P2/P5/P6 existing and on ITEM-1 (live8 branches consolidated on main).

**NOTE (SDK G8, not a build item):** the study-specific seam (`STUDY_EXTENSIONS` + `EffectivePermission` +
study sync audience) generalizes to a generic `EntityExtensionRegistry` parameterized over the tenancy
entity — the "one platform, many hostable entities" path, out of scope here.

## Saturation

r3 did add one SUBSTANTIVELY new thing beyond r1∪r2: it converts r1's blob-GC risk (DEC-5/R2/R3 — "the
biggest unknown," stated as a design need) into a concrete, owned mechanism with a clean seam split — the
`collect-then-post-commit-refcounted-sweep` with a returned `GcManifest`, a P10-collects/P1-frees boundary, a
refcount query/view, a background orphan-reaper backstop, AND the proof that the *shipped* dataset extension
already orphans blobs today (`delete_datasets_for_study` = `DELETE FROM datasets` only) plus its retrofit.
That, and the empirical grounding that all three live8 branches are already ancestors of main (reframing
ITEM-1 from "merge" to "verify/reconcile") while `feat/provenance` is the sole unmerged branch, are genuine
additions — but they are refinements/resolutions of gaps r1 and r2 had already flagged (the GC design, the
provenance/jobs data layers), not a new problem area. All three rounds converge on the same spine (StudyScope
guard, two-level authz, viewer read-only, cascade-via-STUDY_EXTENSIONS, study_audience sync, transfer =
owner_id-flip, desktop gating). The blob-GC boundary that r3 sharpened is now baked into DEC-5, closing the
one open design question. No new area remains unexplored. SATURATION: REACHED
