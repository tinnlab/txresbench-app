//! `extensions` — the backend-owned extension-manifest registry (ITEM-1/2/3/10).
//!
//! A processor/extension is ONE folder under `src-app/packages/<id>/` with a
//! `manifest.yaml` source of truth (+ its compute script + view components). The
//! tree is `include_dir!`-baked as the SEED in `embedded.rs`; at boot
//! `embedded::ensure_extracted()` stages it to `<data_root>/processors/` and
//! `ExtensionRegistry::build_from_dir` SCANS that extracted folder (INV-1: the
//! registry never reads the embedded bytes), parsing each `manifest.yaml` with
//! `serde_norway`, skipping any package that fails `lint_processor_package`, and
//! publishing the folded registry into a process-wide hot-swappable `ArcSwapOption`
//! (S2). It is served over `GET /api/extensions` — so the browser
//! `workbenchRegistry` becomes a projection of the backend-owned source, not the
//! origin. A manifest also CONTRIBUTES domain datatypes (merged into the datatype
//! registry) alongside declaring converters + views. Mirrors `modules::datatype`
//! (module registration, swappable registry, route+handler+docs).

use aide::axum::ApiRouter;
use linkme::distributed_slice;
use std::sync::Arc;

use ziee_framework::{AppModule, ModuleContext, ModuleEntry, MODULE_ENTRIES};

pub mod embedded;
pub mod loader;
pub mod routes;
pub mod types;
pub mod watch;

// The public API the routes call.
pub use loader::{registry, try_registry, ExtensionRegistry};

/// A resolved on-ingest converter (ITEM-6): the facts the dataset upload path needs
/// to enqueue the (zero-param) converter job for a freshly-created dataset. `entry`
/// is the manifest `run.entry` (the logical `code_ref` the sandbox runner resolves
/// to a baked processor); `runtime` is the manifest `run.runtime` (→ the spec's
/// `language`).
#[derive(Debug, Clone)]
pub struct OnIngestConverter {
    /// The declaring extension's id (for logging/provenance).
    pub extension_id: String,
    /// The converter id within the extension.
    pub converter_id: String,
    /// The entry script path (manifest `run.entry`) → the job spec's `code_ref`.
    pub entry: String,
    /// The runtime (manifest `run.runtime`) → the job spec's `language`.
    pub runtime: String,
    /// The declared env image (manifest `env`) → the job spec's `env` (#189).
    /// `None` ⇒ the deployment default.
    pub env: Option<String>,
}

/// Look up the first `on-ingest` converter in the boot-built registry whose
/// `accepts` includes `datatype` (ITEM-6). Returns `None` when the registry is not
/// built yet, or when no converter accepts that datatype — so a dataset whose
/// datatype has no matching converter creates no job (the no-converter path stays
/// job-free). Iterates the id-sorted manifest list for a deterministic pick.
pub fn find_on_ingest_converter(datatype: &str) -> Option<OnIngestConverter> {
    let reg = try_registry()?;
    for m in reg.all() {
        for c in &m.contributes.converters {
            // A datatype is a dataset INPUT only when a converter accepts it as a
            // PRIMARY input (ITEM-6/14): the same on-ingest converter also lists its
            // SUPPORTING accepts (e.g. annotation-table), which must NOT be treated as
            // directly-importable primaries — else the supporting-files endpoint would
            // reject the very supporting type it exists to add (`PRIMARY_ALREADY_SET`).
            if c.trigger == "on-ingest"
                && c.accepts
                    .iter()
                    .any(|a| a.type_id == datatype && a.role == "primary")
            {
                return Some(OnIngestConverter {
                    extension_id: m.id.clone(),
                    converter_id: c.id.clone(),
                    entry: c.run.entry.clone(),
                    runtime: c.run.runtime.clone(),
                    env: c.env.clone(),
                });
            }
        }
    }
    None
}

/// The **dataset-input support list**: every datatype id an `on-ingest` converter
/// accepts — i.e. the types a file can be UPLOADED as and then expanded by the
/// pipeline into a full linked-object dataset (today `single-cell/anndata`,
/// `single-cell/matrix-mtx`). This is the single source of truth for two gates:
/// the upload type-picker offers these, and only an artifact of one of these types
/// may be [promoted](crate::modules::dataset) to a dataset. A component-object
/// datatype (`embedding`/`expression`/`metadata-column`/`soma`/…) is NOT here — it
/// is a piece inside a dataset, not a standalone dataset input. Sorted + deduped;
/// empty when the registry is not built yet.
pub fn dataset_input_datatypes() -> Vec<String> {
    let Some(reg) = try_registry() else {
        return Vec::new();
    };
    let mut out: Vec<String> = reg
        .all()
        .iter()
        .flat_map(|m| m.contributes.converters.iter())
        .filter(|c| c.trigger == "on-ingest")
        .flat_map(|c| c.accepts.iter().map(|a| a.type_id.clone()))
        .collect();
    out.sort();
    out.dedup();
    out
}

/// A resolved on-INTEGRATE converter (ITEM-12): the facts the supporting-file path
/// needs to enqueue the (axis-agnostic) integrate converter that aligns an
/// annotation-table onto an existing dataset's axis. Mirrors [`OnIngestConverter`];
/// `on-integrate` = "align a supporting file onto an existing dataset axis" (generic),
/// distinct from `on-ingest` = "expand a primary into a dataset" (per-domain).
#[derive(Debug, Clone)]
pub struct OnIntegrateConverter {
    /// The declaring extension's id (for logging/provenance).
    pub extension_id: String,
    /// The converter id within the extension.
    pub converter_id: String,
    /// The entry script path (manifest `run.entry`) → the job spec's `code_ref`.
    pub entry: String,
    /// The runtime (manifest `run.runtime`) → the job spec's `language`.
    pub runtime: String,
    /// The declared env image (manifest `env`) → the job spec's `env` (#189).
    /// `None` ⇒ the deployment default.
    pub env: Option<String>,
}

/// Look up the first `on-integrate` converter whose `accepts` includes `datatype`
/// (ITEM-12) — the generic supporting-file integrate converter for a supporting datatype.
/// `None` when the registry is not built yet or no converter accepts that datatype.
/// Iterates the id-sorted manifest list for a deterministic pick (mirrors
/// [`find_on_ingest_converter`]).
pub fn find_on_integrate_converter(datatype: &str) -> Option<OnIntegrateConverter> {
    let reg = try_registry()?;
    for m in reg.all() {
        for c in &m.contributes.converters {
            if c.trigger == "on-integrate" && c.accepts.iter().any(|a| a.type_id == datatype) {
                return Some(OnIntegrateConverter {
                    extension_id: m.id.clone(),
                    converter_id: c.id.clone(),
                    entry: c.run.entry.clone(),
                    runtime: c.run.runtime.clone(),
                    env: c.env.clone(),
                });
            }
        }
    }
    None
}

/// Resolve the declarative [`Alignment`](crate::modules::datatype::types::Alignment)
/// an `on-integrate` converter declares for a supporting `datatype` aligned to a named
/// `axis` (the manifest `accepts[].alignment` of the matching supporting entry), parsed
/// into the typed descriptor. This is the MODULAR seam that lets a NEW supporting type
/// design its OWN key-normalization pipeline in its manifest (DEC-18) — the integrate
/// job threads the result into `params.normalize`, which the align engine honors.
/// `None` when no converter accepts that `(datatype, axis)` as supporting or it declares
/// no `alignment`; a MALFORMED descriptor is fail-soft (logged → `None`, so the align
/// engine's axis-aware default governs rather than blocking the integrate).
pub fn resolve_alignment(
    datatype: &str,
    axis: &str,
) -> Option<crate::modules::datatype::types::Alignment> {
    let reg = try_registry()?;
    for m in reg.all() {
        for c in &m.contributes.converters {
            if c.trigger != "on-integrate" {
                continue;
            }
            for a in &c.accepts {
                if a.type_id == datatype
                    && a.role == "supporting"
                    && a.axis.as_deref() == Some(axis)
                {
                    let val = a.alignment.clone()?;
                    return match serde_json::from_value::<crate::modules::datatype::types::Alignment>(
                        val,
                    ) {
                        Ok(alignment) => Some(alignment),
                        Err(err) => {
                            tracing::warn!(%datatype, %axis, %err,
                                "malformed manifest alignment descriptor; using align-engine axis-aware default");
                            None
                        }
                    };
                }
            }
        }
    }
    None
}

/// The DECLARED methods narration for an analysis id (S3), i.e. the `methods` block
/// of the `contributes.analyses[]` entry whose `id` is this run's `generator_id`.
/// `None` when the registry is not built, no package declares that analysis, or the
/// analysis declares no narration — the exporter then uses its generic sentence.
///
/// Iterates the id-sorted manifest list; the first declaration of an analysis id
/// wins, so the resolution is deterministic.
pub fn methods_narration_for(generator_id: &str) -> Option<types::MethodsNarration> {
    let reg = try_registry()?;
    reg.all()
        .iter()
        .flat_map(|m| m.contributes.analyses.iter())
        .find(|a| a.id == generator_id)
        .and_then(|a| a.methods.clone())
}

/// The `draftable` declaration for an opaque `kind` (draftable-entity ITEM-9): the
/// FIRST `contributes.analyses[]` entry whose `draftable().kind` equals `kind`, plus
/// the id of the declaring package (threaded as the freeze producer's `package` so a
/// bare `code_ref` resolves in the right package — mirrors the converter path).
/// `None` when the registry is not built or no package declares that `kind`. Core
/// never interprets `kind` — it only MATCHES it (INV-1). Deterministic (id-sorted).
pub fn find_draftable_by_kind(kind: &str) -> Option<(types::DraftableSpec, String)> {
    let reg = try_registry()?;
    for m in reg.all() {
        for a in &m.contributes.analyses {
            if let Some(spec) = a.draftable() {
                if spec.kind == kind {
                    return Some((spec, m.id.clone()));
                }
            }
        }
    }
    None
}

/// A resolved producer entry (draftable-entity ITEM-7): the facts the freeze
/// transition needs to enqueue a producer run for a given analysis id — the entry
/// script path (manifest `run.entry` → the spec's `code_ref`), its runtime, and the
/// owning package id (threaded as the spec's `package`).
#[derive(Debug, Clone)]
pub struct ResolvedAnalysisEntry {
    pub package_id: String,
    pub analysis_id: String,
    pub entry: String,
    pub runtime: String,
    /// The env image this analysis declares (#189), or `None` for the deployment
    /// default. Carried here because this struct is the single choke point where an
    /// analysis' declaration becomes a runnable spec — dropping it here is what made
    /// per-job env selection impossible before.
    pub env: Option<String>,
}

/// Resolve a producer analysis id to its runnable entry (draftable-entity ITEM-7).
/// Finds the `contributes.analyses[]` entry whose `id` equals `analysis_id` and reads
/// its `run:` block (`run.entry`/`run.runtime`). `None` when the registry is not
/// built, no package declares that analysis, or it declares no `run` block.
/// Deterministic (id-sorted; first declaration wins).
pub fn resolve_analysis_run(analysis_id: &str) -> Option<ResolvedAnalysisEntry> {
    let reg = try_registry()?;
    for m in reg.all() {
        for a in &m.contributes.analyses {
            if a.id == analysis_id {
                let run = a.run()?;
                return Some(ResolvedAnalysisEntry {
                    package_id: m.id.clone(),
                    analysis_id: analysis_id.to_string(),
                    entry: run.entry,
                    runtime: run.runtime,
                    env: a.env.clone(),
                });
            }
        }
    }
    None
}

/// The env image the registry DECLARES for `analysis_id` (#189 / DEC-4) — `None` when
/// the analysis declares none, or when no package declares that analysis at all.
///
/// This is the server-side derivation the enqueue path uses INSTEAD of trusting an `env`
/// that arrived in a request body (see `AnalysisSpec::with_declared_env`). It is
/// deliberately a separate, narrower lookup than [`resolve_analysis_run`]: the env is
/// declared on the analysis itself, so it must resolve even for an analysis that carries
/// no `run:` block (which `resolve_analysis_run` requires and returns `None` without) —
/// otherwise a runnable-by-another-path analysis would silently fall back to the
/// deployment default instead of its declared env.
///
/// Deterministic (registry order is id-sorted; first declaration wins), mirroring
/// [`resolve_analysis_run`].
pub fn declared_env_for_analysis(analysis_id: &str) -> Option<String> {
    let reg = try_registry()?;
    for m in reg.all() {
        for a in &m.contributes.analyses {
            if a.id == analysis_id {
                return a.env.clone().filter(|e| !e.trim().is_empty());
            }
        }
    }
    None
}

/// Resolve a SUPPORTING file's datatype from its `kind` (S10) — the pure core.
///
/// `declared` is every `(kind, type_id)` pair a manifest declares on a
/// `role: supporting` accepts entry, in registry order. The FIRST declaration of a
/// kind wins (registry order is id-sorted, so this is deterministic), and an
/// UNDECLARED kind is `None` — never a guess.
///
/// The pairing is already DATA: `anndata-import`'s manifest declares
/// `{type_id: annotation-table, role: supporting, kind: annotation_table, axis: …}`.
/// Nothing needed to be added to the schema; the server simply was not reading it.
pub fn supporting_datatype_from_declared(
    kind: &str,
    declared: &[(String, String)],
) -> Option<String> {
    let want = kind.trim();
    declared
        .iter()
        .find(|(k, _)| k == want)
        .map(|(_, type_id)| type_id.clone())
}

/// Every `(supporting kind, datatype id)` pair the registry currently declares
/// (S10), in id-sorted manifest order. Empty when the registry is not built.
pub fn declared_supporting_kinds() -> Vec<(String, String)> {
    let Some(reg) = try_registry() else {
        return Vec::new();
    };
    declared_supporting_kinds_from(&reg)
}

/// [`declared_supporting_kinds`] over an EXPLICIT registry — the projection a test
/// (or a single-scan reflect) can drive without the process-wide singleton.
pub fn declared_supporting_kinds_from(reg: &ExtensionRegistry) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for m in reg.all() {
        for c in &m.contributes.converters {
            for a in &c.accepts {
                if a.role != "supporting" {
                    continue;
                }
                let Some(kind) = a.kind.as_deref().map(str::trim).filter(|k| !k.is_empty()) else {
                    continue;
                };
                if !out.iter().any(|(k, _)| k == kind) {
                    out.push((kind.to_string(), a.type_id.clone()));
                }
            }
        }
    }
    out
}

/// The datatype a supporting file of `kind` carries (S10). `None` when NO installed
/// package declares that kind — the caller must refuse loudly rather than mistype
/// the file (a mistyped supporting file matches no `on-integrate` converter, and
/// that outcome is otherwise completely silent).
pub fn supporting_datatype_for_kind(kind: &str) -> Option<String> {
    supporting_datatype_from_declared(kind, &declared_supporting_kinds())
}

/// The SOLE declared supporting kind, when the deployment declares exactly one
/// (S10). This is the data-driven replacement for the `"annotation_table"` default
/// the upload handlers hardcoded: a stock deployment declares exactly one supporting
/// kind, so the resolved default is byte-identical to the literal it replaces, while
/// a deployment declaring several (or none) requires the client to say which —
/// rather than having one domain's kind assumed for it.
pub fn sole_supporting_kind() -> Option<String> {
    match declared_supporting_kinds().as_slice() {
        [(kind, _)] => Some(kind.clone()),
        _ => None,
    }
}

/// Every manifest-contributed interaction ACTION currently registered (S4), in
/// id-sorted manifest order so the folded action vocabulary is deterministic.
/// Empty when the registry is not built yet (the built-in vocabulary still stands).
pub fn contributed_actions() -> Vec<types::ActionContribution> {
    let Some(reg) = try_registry() else {
        return Vec::new();
    };
    reg.all()
        .iter()
        .flat_map(|m| m.contributes.actions.iter().cloned())
        .collect()
}

/// Is `datatype` a directly-importable DATASET INPUT (ITEM-6)? True when SOME
/// `on-ingest` converter accepts it — the upload path uses this to decide whether a
/// freshly-created dataset gets a primary-import job.
pub fn is_dataset_input(datatype: &str) -> bool {
    find_on_ingest_converter(datatype).is_some()
}

/// Scan the EXTRACTED processor folder (ITEM-6) and gather its contributed datatypes
/// as full `Datatype`s (ITEM-1). Routes through `ExtensionRegistry::build_from_embedded`
/// → `embedded::ensure_extracted()` (OnceCell-guarded) → `build_from_dir`, so the
/// order-17 datatype boot path and the order-18 extensions boot path read the SAME
/// extracted folder (INV-1: neither reads `include_dir!` bytes for the registry) and
/// share ONE extraction. Does NOT depend on the extension holder being published, so
/// the datatype-registry build site can call it regardless of module init order. A
/// malformed DROPPED-IN folder package is SKIPPED per-package (INV-4). Since #190/#197 it
/// routes through `build_from_embedded_checked`, so it ALSO applies the load posture: a
/// package this binary shipped, still carrying the embedded bytes, that fails to load makes
/// this return `Err` rather than silently yielding a lattice with that package's datatypes
/// missing. This is the order-17 DATATYPE boot path, and a silently-missing datatype is
/// exactly the shape of #197, which is why the posture is applied here and not only at the
/// order-18 extension boot.
pub fn contributed_datatypes_from_embedded(
) -> Result<Vec<crate::modules::datatype::types::Datatype>, String> {
    // `_checked` (#190/#197): this is the order-17 DATATYPE boot path, so a first-party
    // package refused here is a silently-missing DATATYPE — the exact shape of #197. It
    // gets the same refusal the order-18 extension boot gets, from the same function.
    let reg = ExtensionRegistry::build_from_embedded_checked()?;
    Ok(contributed_datatypes_from_registry(&reg))
}

/// Derive the contributed datatypes from an ALREADY-BUILT extension registry (M2): a pure
/// projection over the manifests the registry already folded, with NO second folder scan.
/// The single-scan reflect path uses this so the extension registry and the datatype
/// registry are built from ONE `read_dir` (never two reads a mid-reflect edit could make
/// disagree).
pub fn contributed_datatypes_from_registry(
    reg: &ExtensionRegistry,
) -> Vec<crate::modules::datatype::types::Datatype> {
    reg.all()
        .iter()
        .flat_map(|m| m.contributes.datatypes.iter().map(|d| d.to_datatype()))
        .collect()
}

/// Dir-scoped core of the SCAN half of [`contributed_datatypes_from_embedded`]: scan an
/// explicit extracted-processors `dir` (applying the SAME cross-package resolution) and
/// project its contributed datatypes. Lets a test prove the datatype boot path stays intact
/// over a folder holding bad drop-ins without touching the real data root.
///
/// Deliberately the UNCHECKED scan: it does NOT apply the load posture or the anti-vacuity
/// floor (#190/#197), because its callers are tests that build a folder on purpose and want
/// to observe what the scan made of it. It is therefore NOT a stand-in for the boot path —
/// a test written against this one cannot observe the refusal. Use
/// [`ExtensionRegistry::build_from_dir_checked`] for that.
pub fn contributed_datatypes_from_embedded_in(
    dir: &std::path::Path,
) -> Result<Vec<crate::modules::datatype::types::Datatype>, String> {
    let reg = ExtensionRegistry::build_from_dir(dir)?;
    Ok(contributed_datatypes_from_registry(&reg))
}

/// Deploy-level SEED-ONLY kill-switch (M8, CODING_GUIDELINES §16). When ON
/// (`CYTO_PROCESSOR_SEED_ONLY=1`), the app restricts itself to the trusted BAKED seed:
/// the folder scan IGNORES any unmanaged (user / attacker-dropped) package folder, the
/// live watcher is NOT spawned, and a reload re-reads only the seed-managed set — so an
/// operator can defend against a malicious drop-in by refusing to discover unmanaged
/// folders. OFF by default (runtime discovery is the D2 feature). Read the same
/// env-var way as the watcher kill-switch (`CYTO_PROCESSOR_WATCH_ENABLED`).
pub fn seed_only_enabled() -> bool {
    // One shared predicate with the other deploy-level switches (`loader::truthy_env`), so
    // the accepted vocabulary cannot drift between them.
    loader::truthy_env(std::env::var("CYTO_PROCESSOR_SEED_ONLY").ok().as_deref())
}

/// The SINGLE rescan+republish path shared by the live filesystem watcher (S6,
/// [`watch`]) and the S7 reload endpoint. Re-scans the extracted
/// `<data_root>/processors` folder and atomically REPUBLISHES BOTH process-wide
/// registries — the extension registry AND the datatype registry — into their
/// `ArcSwapOption`s, exactly mirroring the two boot inits (order-17 datatype +
/// order-18 extensions). So one reflect keeps both surfaces in lockstep with the
/// current folder contents (a dropped package's datatypes + converters both appear;
/// a removed package's both disappear).
///
/// `embedded::ensure_extracted()` (called inside `build_from_embedded`) is
/// OnceCell-cached + NO-CLOBBER, so a reflect NEVER re-writes the folder — a user
/// drop-in is picked up by `build_from_dir` reading the folder directly, and the
/// watcher can never feedback-loop off its own reflect. A malformed dropped package
/// is skipped per-package by `build_from_dir` (INV-4), so a bad drop degrades to
/// "that package absent", never an error that tears down the whole reflect.
///
/// #190/#197 — the ONE exception, scoped by ORIGIN. A malformed FIRST-PARTY (seed-managed)
/// package makes this reflect `Err` instead, without swapping either registry: the
/// last-good snapshot stays live and the caller (the reload endpoint / the watcher) reports
/// the named refusal. The drop-in guarantee above is untouched — that is the whole reason
/// the posture turns on origin rather than on "did anything fail". The process is never
/// killed after boot: the no-clobber reconcile above deliberately leaves a hand-edited
/// manifest alone, so a seed package CAN be broken on disk at runtime, and refusing the
/// reflect is the loud response that does not take a serving process down with it.
///
/// Returns the count of registered extensions on success. On a hard failure (an
/// unreadable folder / a datatype-lattice collision) it returns `Err` WITHOUT
/// swapping either registry — the previously-published snapshot stays live (no
/// half-applied reflect).
///
/// Concurrency (M1/M2): all reflects SERIALIZE on `REFLECT_LOCK` so two reflects (the
/// watcher + a manual reload) can never interleave or build registries from different
/// folder states. Within one reflect a SINGLE folder scan feeds BOTH registries (the
/// extension registry is scanned once, and the datatype registry is built from THAT same
/// in-memory manifest set via [`contributed_datatypes_from_registry`] — no second
/// `read_dir` a mid-reflect edit could make inconsistent). Both registries are built
/// BEFORE either is swapped, so a build error swaps neither. The two `store`s are adjacent
/// under the lock; a reader takes each registry via its own per-call `load_full()` and
/// never reads BOTH in a single lookup (`is_dataset_input` reads only the ext registry, a
/// type-`matches()` reads only the datatype registry), so no single lookup can observe a
/// mixed snapshot — the only residual window is a cross-registry read spanning the two
/// adjacent atomic stores (sub-microsecond, self-healing, and inherently racy across two
/// calls regardless), which is why a single combined holder is not warranted.
pub fn reflect_processors() -> Result<usize, String> {
    use std::sync::Mutex;
    static REFLECT_LOCK: Mutex<()> = Mutex::new(());
    let _serialize = REFLECT_LOCK.lock().unwrap_or_else(|p| p.into_inner());

    // ONE folder scan (M2): build the extension registry, then derive the contributed
    // datatypes from that SAME scan.
    // `_checked` (#190/#197): a FIRST-PARTY package that fails to load makes this reflect
    // return `Err` BEFORE either registry is swapped, so the last-good snapshot stays live
    // and the reload endpoint / watcher reports the named refusal (DEC-7). A DROPPED-IN
    // package that fails to load is reported loudly and the reflect continues — the
    // tolerance this function's own contract promises, preserved verbatim (INV-2).
    let ext_reg = ExtensionRegistry::build_from_embedded_checked()?;
    let n = ext_reg.len();
    let extra = contributed_datatypes_from_registry(&ext_reg);
    // Datatype registry — union the (already-scanned) manifest-contributed datatypes with
    // the Rust roots BEFORE swapping either, so a datatype build failure aborts the whole
    // reflect and leaves both prior snapshots live (never a half-applied reflect).
    let dt_reg = crate::modules::datatype::DatatypeRegistry::build_merged(extra)?;

    // Publish BOTH (adjacent under the lock — see the concurrency note above).
    loader::set_global_registry(Arc::new(ext_reg));
    crate::modules::datatype::registry::set_global_registry(Arc::new(dt_reg));
    Ok(n)
}

pub struct ExtensionsModule;

impl AppModule for ExtensionsModule {
    fn name(&self) -> &'static str {
        "extensions"
    }

    fn description(&self) -> &'static str {
        "Backend-owned extension-manifest registry (converters + views), baked from src-app/packages/ and served over GET /api/extensions (TxResBench)."
    }

    fn init(&mut self, _ctx: &ModuleContext) -> Result<(), Box<dyn std::error::Error>> {
        // Build the registry from the baked `extensions/*/manifest.yaml` tree and
        // publish it as the process-wide singleton. `init` runs (for ALL modules)
        // before any `register_routes`, so it is set before the list handler reads
        // it.
        //
        // #190/#197 — what "FAILS BOOT" now means, precisely. This comment used to claim
        // "a malformed manifest / empty `run.entry` FAILS BOOT with a clear error (never a
        // silent empty registry)", and that was FALSE for the case that mattered: a
        // per-package rejection was collected and skipped, so the registry built fine
        // WITHOUT that package and boot proceeded green with the analysis missing. Only a
        // whole-scan failure (an unreadable folder) ever reached this `map_err`.
        // `build_from_embedded_checked` is what makes the claim true, and only for a
        // FIRST-PARTY package: one this binary shipped, whose refusal means our build gate
        // and our runtime gate disagree. A DROPPED-IN package still degrades to "that
        // package absent" (INV-2) — refusing to boot over a file anyone can write under
        // `<data_root>/processors/` would be a denial of service, not a fix. The aggregated
        // report is carried in the error text, so it reaches stderr as the process exits.
        let reg = ExtensionRegistry::build_from_embedded_checked().map_err(|e| {
            Box::<dyn std::error::Error>::from(format!("extension registry build failed: {e}"))
        })?;
        tracing::info!(extensions = reg.len(), "extension registry built");
        loader::set_global_registry(Arc::new(reg));
        // Deploy-level SEED-ONLY kill-switch (M8, §16): when ON, the app trusts ONLY the
        // baked seed — the folder scan (in `build_from_dir`) already ignored every
        // unmanaged drop-in, and the live watcher is NOT spawned (there is nothing
        // unmanaged to reflect). The `enabled` guard therefore appears BOTH at the scan
        // (registry build) AND here at watcher registration. OFF by default → the D2
        // runtime discovery + watcher run as normal.
        if seed_only_enabled() {
            tracing::warn!(
                "extensions: SEED-ONLY mode (CYTO_PROCESSOR_SEED_ONLY) — ignoring unmanaged \
                 drop-in packages; live watcher NOT started"
            );
        } else {
            // Start the live filesystem watcher on `<data_root>/processors/` (ITEM-13,
            // INV-10) behind the default-ON watch kill-switch. `init` runs inside the
            // tokio runtime at boot, so `tokio::spawn` in `watch::start` has a runtime. A
            // dropped/edited/removed package now auto-reflects through `reflect_processors`
            // with no rebuild + no manual reload. Off cleanly when the kill-switch is off.
            watch::start();
        }
        Ok(())
    }

    fn register_routes(&self, router: ApiRouter) -> ApiRouter {
        router
            .merge(routes::extension_routes())
            .merge(routes::processor_routes())
    }
}

#[distributed_slice(MODULE_ENTRIES)]
static EXTENSIONS: ModuleEntry = ModuleEntry {
    name: "extensions",
    // After datatype(17): the extension registry references datatype ids, and 18 is
    // free (datatype/mod.rs notes 17/18/19 are open). No handler consults it before
    // request time, so exact order past datatype is not load-bearing.
    order: 18,
    description: "Backend-owned extension-manifest registry (TxResBench).",
    constructor: || Box::new(ExtensionsModule),
};
