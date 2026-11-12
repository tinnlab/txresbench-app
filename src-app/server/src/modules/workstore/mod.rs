//! `workstore` — the platform's critical-path data substrate (P1). A
//! content-addressed local-FS object store + the host-owned `artifacts` catalog +
//! `/outputs` ingest + a JSON control plane + an opaque
//! byte data plane (authed project-scoped Range/206 serving — the ONLY read surface,
//! ITEM-12) + project-lifecycle cascade + `SyncEntity::Artifact` + a standing
//! blob-GC. Server-embedded foundational kernel — rides desktop the same (no
//! `CORE_MODULE_BLOCKLIST` entry).

use std::sync::{Arc, OnceLock, RwLock};

use aide::axum::ApiRouter;
use linkme::distributed_slice;
use once_cell::sync::OnceCell;

use txresbench_core::AppError;
use txresbench_framework::{AppModule, ModuleContext, ModuleEntry, MODULE_ENTRIES};

/// The server's reading of the `dataset-alignment` artifact the producer WRITES — members
/// addressed by ROLE, per-source digests out of `meta.sources[]`. See its module doc for the
/// two wrong shapes this replaced and for D5 (declaration vs artifact) which is still open.
pub mod alignment;
pub mod gather_decode;
/// **ITEM-31** — the ONE gather: resolution + assembly, shared by the byte route and by
/// stage-time materialisation for a sandboxed processor.
pub mod gather_exec;
pub mod gathered;
/// **The ONE place the server decodes an artifact byte (INV-1 as amended, DEC-23).**
/// Scoped mechanically by `scripts/check-no-format-crates.sh`'s decode-scope check: a
/// decompressor in any other server source file fails the build.
/// **ITEM-45/ITEM-50** — the artifact→dataset backfill and its dry-run, as ONE code path
/// (`write: bool`), plus the dependent-count that can say it cannot answer.
pub mod ownership_backfill;

/// **The process-wide resolved-gather cache (ITEM-25).**
///
/// One per process, bounded by BYTES. Reached ONLY from `serve_gathered_member` (via
/// `gather_exec::resolve_shared`), which runs after the authorization and status gates and
/// after the metadata walk — see `gathered::ResolutionCache`'s two ordering invariants.
///
/// 256 MiB is ~26 columns of 500k rows resident at once, chosen against the MEASURED 10.0 MB
/// footprint of one such resolution (`tests/workstore/gather_scale_test.rs` prints it) rather
/// than picked. It may be raised; it may not be removed. Stage-time materialisation deliberately
/// does NOT go through this — it resolves once for the whole column, so it has nothing to
/// reuse and would only evict the serve path's working set.
pub fn gathered_resolution_cache() -> &'static gathered::ResolutionCache<gather_exec::ResolvedGather>
{
    static CACHE: std::sync::OnceLock<gathered::ResolutionCache<gather_exec::ResolvedGather>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| gathered::ResolutionCache::new(256 * 1024 * 1024))
}

/// **The process-wide mask-`rank` cache (ITEM-4 / INV-23 / INV-E7).**
///
/// The mask's exclusive prefix-sum (`rank`) and its per-row keep vector are computed ONCE per
/// `(dataset, mask)` and reused across every COLUMN of that virtual dataset — a masked VD with
/// 50 columns reads and ranks its mask once, not fifty times. Keyed on the mask artifact's
/// `id | content_hash` (a mask is an immutable, content-addressed artifact), so two VDs with
/// different masks never share a rank and one whose mask bytes change (a re-mint under a new
/// id) is not served from a warm entry.
///
/// A separate cache from the resolved-gather one because its lifetime is different: a
/// resolution is per `(column, mask)` and the rank is per `(mask)`, so folding the rank into
/// the resolution would recompute it for every column. Bounded by BYTES like its sibling; a
/// mask is ~one byte per source row plus a `u32` rank, so 64 MiB holds many.
pub fn masked_rank_cache() -> &'static gathered::ResolutionCache<gather_exec::MaskPlan> {
    static CACHE: std::sync::OnceLock<gathered::ResolutionCache<gather_exec::MaskPlan>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| gathered::ResolutionCache::new(64 * 1024 * 1024))
}
pub mod artifact;
pub mod authz;
pub mod catalog;
pub mod config;
/// Compute↔storage COUPLING matrix (#61 §1) — the pure, unit-tested source of truth for
/// which (compute, object-store) backend pairs are valid. Enforced (422) at both admin PUTs.
pub mod backend_compat;
/// The data-migration ENGINE (#61 §2) — pure copy + content-hash verify + retire-gate over
/// two `ObjectStore` handles. Shared by the manual "Migrate data" action + the auto-move
/// orchestrator. Profile-agnostic (works with local-fs in both builds; the cloud end needs
/// `saas` for `S3Store`).
pub mod migration_engine;
/// The LIVE hot-cutover engine (#64): the activation guard (only ever swap to a `verified`
/// store), the atomic swap to `DualRead(new, old)`, the post-cutover catch-up re-sweep that
/// closes the write-during-migration window, and the atomic rollback to the fully-intact OLD
/// store. Pure over `Arc<dyn ObjectStore>` for its data-integrity core (unit-testable on
/// local-fs); the DB/orchestration glue lives in `migration_api` (saas).
pub mod cutover;
/// Persistence for an object-store data migration (the `object_store_migration` table) —
/// survives a restart / resumable / drives the admin progress + verify + confirm-retire UI.
pub mod migration_repo;
/// The READ half of the conformance gate (ITEM-18 / DEC-12): the type every path that
/// serves, stages or promotes an artifact's bytes must hold, and which a `failed` row
/// cannot be turned into.
pub mod consume;
pub mod data_api;
pub mod detach_guard;
pub mod gc;
pub mod ingest;
/// The virtual-dataset MASK: its `role='mask'` tier, the source-recording meta the finalize
/// sink links a VD through, and the identity rule (an all-ones mask is never materialised).
pub mod mask;
pub mod object_store;
/// Blob-store partitioning by CATALOG identity — the guard that stops one server
/// instance's GC from freeing another instance's live blobs (see its module doc).
pub mod partition;
/// The READ-ONLY answer to "are this artifact's bytes still in the store?" — `status =
/// 'ready'` records that INGEST succeeded, not that the blobs are still on disk (see its
/// module doc for the incident, and for why this reports rather than condemns).
pub mod presence;
pub mod range;
pub mod routes;
/// Workstore module permissions (`workstore::settings::{read,manage}`) — issue #54.
pub mod permissions;
/// The workstore admin settings singleton (GC policy + ingest size caps) — issue #54.
pub mod settings;
/// In-process read-at-use cache of the workstore settings singleton.
pub mod settings_cache;
// NOTE (artifact-model ITEM-12): `serve_core` — the Selection→Arrow serve core behind
// `GET /artifacts/{id}/read` — was DELETED along with its route, the Selection grammar
// and the tier routing. INV-1: the server never opens a byte for meaning (amended
// DEC-23 for the gather alone — see `gather_decode`), and a
// Selection→Arrow endpoint is a server that parses the payload. `/data[/{*member}]` is
// now the ONLY read surface; the browser decodes (see `ui/src/core/workstore/zarrReader.ts`).
// NOTE (artifact-model ITEM-8): `axes` — the `workstore_axis_entry` repository +
// its dense per-project entry-index primitives (`RowSet`, `prefix_sum_offsets`,
// `na_fill`) — was DELETED with the table it wrapped. INV-3: an axis IS its key
// artifact, its identity is that artifact's `content_hash`, and the axis NAME is a
// label — but that table's PRIMARY KEY and all three of its indexes were keyed on
// `axis_name`, so it asserted precisely the opposite. Axis cardinality is now
// DERIVED from the key artifact's own `structure` declaration
// (`data_api::derive_axes`), which reads a declaration, never a byte.
pub mod project_extension;
pub mod sync;
/// The CREATOR — the one place in the server that WRITES a gathered artifact.
pub mod virtual_dataset;

/// The INV-1 / no-legacy-wire static grep-guard (S6, TEST-2/6/24). `#[cfg(test)]`-only —
/// no production code, just the guard `#[test]`s (the Rust twin of
/// `scripts/check-no-legacy-wire.sh`).
#[cfg(test)]
mod no_legacy_wire;

use config::{WorkstoreConfig, WorkstoreLimits};
use object_store::{LocalFsStore, ObjectStore};
use partition::StoreClaim;

/// Process-wide content-addressed store handle — **swappable at runtime** (#64).
///
/// Set at boot by [`init_working_store`]; a LIVE config cutover then atomically REPLACES it via
/// [`swap_object_store`] with no restart (mirrors `txresbench_file::init_file_storage` /
/// `get_file_storage` for the boot half, and the swappable-singleton shape of
/// `settings_cache.rs` for the swap half — an `OnceLock` lazy slot holding a swappable Arc).
///
/// Backed by `RwLock<Arc<dyn ObjectStore>>` — the EXACT proven pattern of `settings_cache.rs`
/// (arc_swap can't hold an unsized `Arc<dyn Trait>`: its `RefCnt` bound requires `Sized`). A read
/// takes the read lock only long enough to CLONE the Arc — [`get_object_store`] returns that
/// SNAPSHOT — so each of the ~20 call sites gets whatever store is current at call time and holds
/// it alive (via the Arc refcount) for the whole operation, even if a swap lands mid-op. Many
/// readers proceed concurrently (shared read lock); a swap takes the write lock for a single
/// pointer assignment. That is the INV-1 atomicity guarantee: a concurrent read racing a swap
/// always resolves to a fully-valid store (the old one or the new one), never a torn/empty read,
/// never a panic, never a spurious not-found. Data-plane handlers pull it via [`get_object_store`].
type StoreSlot = RwLock<Arc<dyn ObjectStore>>;
static OBJECT_STORE: OnceLock<StoreSlot> = OnceLock::new();

/// Process-wide operational tunables (DE-page cap, slice byte cap, GC cadence),
/// set once at boot. Handlers read caps via [`get_limits`].
static LIMITS: OnceCell<WorkstoreLimits> = OnceCell::new();

/// The ownership claim over [`OBJECT_STORE`]'s root — which catalog is entitled
/// to RECLAIM from it. Set beside the store at boot, because every code path that
/// unlinks needs both and neither is meaningful alone.
static STORE_CLAIM: OnceCell<StoreClaim> = OnceCell::new();

/// The boot-installed store ownership claim, if boot ran. Any path that frees
/// blobs must hold one; without it the free is skipped (the standing sweep, which
/// does hold one, is the backstop).
pub fn try_get_store_claim() -> Option<StoreClaim> {
    STORE_CLAIM.get().cloned()
}

/// The resolved workstore limits (falls back to defaults if boot never ran, e.g.
/// a direct-repo test that doesn't hit a data-plane handler).
pub fn get_limits() -> WorkstoreLimits {
    LIMITS.get().cloned().unwrap_or_default()
}

/// Initialize the content-addressed store under the resolved root (honors
/// `TXR_APP_DATA_DIR` for per-worktree test isolation). Called once at boot from
/// `lib.rs::build_app`. Returns the store so the caller can spawn the GC loop.
pub fn init_working_store(cfg: &WorkstoreConfig) -> Result<Arc<dyn ObjectStore>, AppError> {
    let store = build_store(cfg)?;
    // Idempotent: a second call in the same process keeps the FIRST store (the slot is only
    // installed once; a later runtime cutover goes through `swap_object_store`, not here).
    OBJECT_STORE.get_or_init(|| RwLock::new(store.clone()));
    let _ = LIMITS.set(cfg.limits.clone());
    let _ = STORE_CLAIM.set(cfg.claim.clone());
    tracing::info!(
        root = %cfg.root().display(),
        backend = cfg.backend.as_str(),
        catalog = cfg.claim.key(),
        "workstore: content-addressed store initialized"
    );
    Ok(OBJECT_STORE
        .get()
        .map(store_snapshot)
        .unwrap_or(store))
}

/// Clone the current Arc out of the slot under the read lock (poison-tolerant, like
/// `settings_cache::snapshot`). The lock is held only for the clone, never across an `.await`.
fn store_snapshot(slot: &StoreSlot) -> Arc<dyn ObjectStore> {
    slot.read().unwrap_or_else(|p| p.into_inner()).clone()
}

/// Construct the object store for `cfg.backend` WITHOUT touching process globals — the
/// pure construction seam (PROV-T2-3), so backend selection is unit-testable
/// (`config.rs` TEST-5) without setting the boot `OnceCell`s.
///
/// `Local` builds `LocalFsStore` (the desktop/default path, DE-INV-1). `S3` builds the
/// cloud `S3Store` from the resolved connection config — but ONLY in a `saas` build; a
/// non-`saas` (desktop) build refuses the `s3` selection with a clear error rather than
/// silently falling back, so a misconfigured desktop deployment fails loud instead of
/// writing blobs to the wrong place.
pub(crate) fn build_store(cfg: &WorkstoreConfig) -> Result<Arc<dyn ObjectStore>, AppError> {
    match cfg.backend {
        crate::modules::workstore::config::ObjectStoreKind::Local => {
            Ok(Arc::new(LocalFsStore::new(cfg.root())))
        }
        crate::modules::workstore::config::ObjectStoreKind::S3 => {
            let _ = cfg;
            Err(AppError::internal_error(
                "workstore: TXR_WORKSTORE_BACKEND=s3 requires a build with the `saas` \
                 cargo feature; the desktop/default build ships only the local-fs backend",
            ))
        }
    }
}

/// The process-wide object store. Panics if boot never called
/// [`init_working_store`] — a programming error (the data-plane routes are only
/// reachable on a booted app).
pub fn get_object_store() -> Arc<dyn ObjectStore> {
    OBJECT_STORE
        .get()
        .map(store_snapshot)
        .expect("workstore object store not initialized (init_working_store must run at boot)")
}

/// The object store if boot initialized it, else `None` — used by the
/// post-commit GC path so a delete on a not-yet-inited store degrades to a no-op
/// (the standing reaper self-heals) instead of panicking.
pub fn try_get_object_store() -> Option<Arc<dyn ObjectStore>> {
    OBJECT_STORE.get().map(store_snapshot)
}

/// **Atomically replace** the process-wide object store with `store` (#64 — the live cutover
/// primitive). Takes the write lock for a single guarded assignment; a concurrent
/// [`get_object_store`] (which holds the READ lock only long enough to clone the Arc) therefore
/// observes either the OLD Arc or the NEW Arc — both fully valid, never a torn or empty handle
/// (INV-1). A caller that snapshotted the old Arc before the swap keeps operating on it safely
/// until it drops it (Arc liveness), so an operation in flight across the swap never faults or
/// spuriously 404s. The write lock is held only for the assignment, never across an `.await`.
///
/// This is the ONLY runtime mutator of the handle; the activation guard (only ever swap to a
/// `verified` store, or roll back to the fully-intact OLD store) lives in [`cutover`], never
/// here — this function is the mechanical atomic replace and makes no policy decision.
pub fn swap_object_store(store: Arc<dyn ObjectStore>) {
    match OBJECT_STORE.get() {
        Some(slot) => *slot.write().unwrap_or_else(|p| p.into_inner()) = store,
        // Pre-boot (no slot yet): install it. Keeps `swap` usable in a direct-repo test that
        // never ran `init_working_store`.
        None => {
            let _ = OBJECT_STORE.set(RwLock::new(store));
        }
    }
}

/// Called after a workstore settings PUT. A log-only seam today (mirrors sandbox's
/// `emit_settings_changed`, DEC-6): the writing node's cache is invalidated inline;
/// cross-node realtime sync (a `SyncEntity` variant) is a follow-up.
pub fn emit_settings_changed() {
    tracing::info!("workstore: settings changed (cache invalidated; sync seam is a no-op today)");
}

pub struct WorkstoreModule;

impl AppModule for WorkstoreModule {
    fn name(&self) -> &'static str {
        "workstore"
    }

    fn description(&self) -> &'static str {
        "Content-addressed working store + artifacts catalog + typed-binary data plane (TxResBench P1)."
    }

    fn init(&mut self, ctx: &ModuleContext) -> Result<(), Box<dyn std::error::Error>> {
        // Install the virtual-dataset CREATOR into the jobs seam (pool baked in), exactly
        // as `DatasetModule` installs its `IntegrationSink` — so the jobs module never
        // imports the workstore's creator. The runner calls it beside `record_run`, the one
        // point where the outputs are already cataloged and the workspace still exists.
        let pool = (*ctx.db_pool).clone();
        crate::modules::jobs::seams::install_virtual_dataset_sink(std::sync::Arc::new(
            virtual_dataset::WorkstoreVirtualDatasetSink::new(pool),
        ));
        Ok(())
    }

    fn register_routes(&self, router: ApiRouter) -> ApiRouter {
        router.merge(routes::workstore_routes())
    }
}

// `order: 24` — deliberately DISTINCT from `project` (25), and deliberately
// BEFORE it. Two reasons:
//
//  1. Determinism (the bug this value fixes). `txresbench_framework::create_modules`
//     sorts `MODULE_ENTRIES` with a *stable* `sort_by_key(|e| e.order)`, so two
//     modules sharing an `order` resolve to whatever sequence linkme's distributed
//     slice happens to emit — i.e. link order, which shifts with unrelated code
//     changes. Module order is route-registration order, which is `openapi.json`
//     path-emission order, so the tie made the generated spec nondeterministic and
//     intermittently red-lit merge-gate C3 (regen-parity) with a ~30-path
//     pure-relocation diff. Distinct orders make the sort a TOTAL order, so link
//     order provably cannot influence the emitted spec.
//     `modules::tests::module_order_is_unique` is the guard that keeps it that way.
//
//  2. Direction. workstore is the foundational data substrate (P1) and a
//     *provider* into `project`: it contributes a `PROJECT_EXTENSIONS` entry that
//     `project::init` consumes when it builds the project-extension registry.
//     `dataset` (20), the other project-extension provider, likewise sits before
//     project. Nothing *requires* this at runtime — the contribution is a link-time
//     distributed slice, `WorkstoreModule::init` is a no-op, and the
//     `OBJECT_STORE`/`LIMITS` cells are set by `init_working_store` from
//     `build_app` before module init runs — so provider-before-consumer is the
//     honest semantic direction rather than a load-bearing constraint.
#[distributed_slice(MODULE_ENTRIES)]
static WORKSTORE: ModuleEntry = ModuleEntry {
    name: "workstore",
    order: 24,
    description: "Content-addressed working store + artifacts catalog (TxResBench P1).",
    constructor: || Box::new(WorkstoreModule),
};
