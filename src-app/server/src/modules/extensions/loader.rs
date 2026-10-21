//! The extension-manifest loader + registry (ITEM-5/6). As of the folder-scan
//! cutover (INV-1) the registry is built by SCANNING the EXTRACTED processor folder
//! `<data_root>/processors/` — NOT from `include_dir!` bytes. The single embed now
//! lives in `embedded.rs` (the SEED); `embedded::ensure_extracted()` stages that seed
//! to disk once (OnceCell-guarded) and reconciles it, and this loader reads each
//! `<id>/manifest.yaml` off the extracted folder with `serde_norway`.
//!
//! Per package, [`build_from_dir`](ExtensionRegistry::build_from_dir) runs the S1
//! single-source validator [`lint_processor_package`](crate::processor_manifest_lint::lint_processor_package)
//! FIRST — the SAME `deny_unknown_fields`/dangling-`extends`/`schema` gate `build.rs`
//! runs — and a package that fails is `tracing::error!`-logged, its package-scoped
//! error collected into the per-package load-status, and SKIPPED; the scan does NOT
//! abort, so every VALID sibling still registers (INV-4). The folded registry is
//! published into a process-wide hot-swappable `ArcSwapOption` holder (mirrors
//! `datatype::registry`); the `ArcSwapOption` (vs a boot-once `OnceCell`) lets a
//! rescan (S6 watcher / S7 reload) atomically re-publish a freshly-scanned registry
//! without a restart (INV-2). A contributor can drop a folder package next to the
//! seeded ones and a rescan discovers it with no rebuild.
//!
//! `serde_norway` is present-but-unused elsewhere in this crate (config delegates
//! to `ziee_core`).

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use arc_swap::ArcSwapOption;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::embedded;
use super::types::ExtensionManifest;

// The lint's own stable check ids (#190/#197) — re-used verbatim so a rejection raised by
// the per-package lint and the same violation class raised by the CROSS-package pass below
// report the SAME code, and a test can assert one token for both.
use crate::processor_manifest_lint::{
    CHECK_DANGLING_EXTENDS, CHECK_DUPLICATE_DATATYPE_ID, CHECK_EXTENDS_CYCLE,
    CHECK_ROOT_ID_COLLISION, CHECK_UNREADABLE,
};

/// The registry's own `ExtensionManifest` parse failed although the lint's parse
/// succeeded — a divergence between the two manifest types, not a package defect.
/// Loader-owned (the lint has no such stage).
const CHECK_REGISTRY_PARSE: &str = "PKG_REGISTRY_PARSE";
/// Two packages declare the same extension id. Only decidable across packages, so this
/// code has no lint-side twin.
const CHECK_DUPLICATE_EXTENSION_ID: &str = "PKG_DUPLICATE_EXTENSION_ID";
/// A contributed datatype declares no `extends`, i.e. a SECOND lattice root. Only
/// decidable against the core lattice, so this code has no lint-side twin either.
const CHECK_SECOND_ROOT: &str = "PKG_SECOND_ROOT";
/// The manifest parses but declares a blank `id`. Loader-owned because the consequence is
/// loader-owned: [`ExtensionRegistry::from_manifests`] refuses an empty id for the WHOLE
/// set, so before this code existed one drop-in carrying `id: ""` aborted the entire scan —
/// failing boot and every reflect, permanently, from a single attacker-writable file.
const CHECK_EMPTY_EXTENSION_ID: &str = "PKG_EMPTY_EXTENSION_ID";
/// This binary SHIPPED the package, and the scan did not find it on disk at all. The one
/// rejection raised for a folder the walk never reached, which is precisely why it is
/// needed: every other check fires from inside a folder, so a deleted one raised nothing.
const CHECK_SEED_PACKAGE_ABSENT: &str = "PKG_SEED_PACKAGE_ABSENT";

/// Is this folder a RESERVED helpers-only package (`_helpers`, `_lib`; D2 S5)?
///
/// A `_`-prefixed folder ships shared compute assets to disk but contributes no
/// datatype/converter/view, so it is never a registry member. Exposed as a named predicate
/// because more than one place needs the rule and a second hand-written `starts_with('_')`
/// is the enumeration idiom this repo refuses — the scan and the
/// every-embedded-package-loads assertion must apply the SAME rule or they drift.
pub(crate) fn is_reserved_package(folder_name: &str) -> bool {
    folder_name.starts_with('_')
}

/// The operator escape hatch (DEC-1): downgrade the FIRST-PARTY refusal to the drop-in
/// tolerant posture, so a deployment can limp while a fix ships.
///
/// Deliberately an env var read at the publish site rather than a settings row: it has to
/// work when the thing that is broken is the boot itself, before any database read.
pub const ALLOW_BROKEN_FIRST_PARTY_ENV: &str = "CYTO_PROCESSOR_ALLOW_BROKEN_FIRST_PARTY";

/// Is the first-party refusal downgraded to the tolerant posture? Read the same way as the
/// other deploy-level kill-switches (`CYTO_PROCESSOR_SEED_ONLY`, `CYTO_PROCESSOR_WATCH_ENABLED`).
pub fn allow_broken_first_party() -> bool {
    #[cfg(test)]
    if let Some(forced) = override_seam::forced() {
        return forced;
    }
    truthy_env(std::env::var(ALLOW_BROKEN_FIRST_PARTY_ENV).ok().as_deref())
}

/// The TEST-ONLY seam that lets the escape hatch be exercised END TO END.
///
/// The hatch is DEC-1's single documented recovery from a first-party boot refusal, and an
/// operator discovers whether it works while the deployment is already down — so "it is
/// wired" has to be a test, not a reading of the code. It could not be one: `set_var` is
/// process-wide and leaks into every other test in this binary (this crate already carries
/// one flake from exactly that), and asserting against the ambient environment is vacuous
/// when the variable is unset — a blind audit confirmed that hardwiring the production read
/// to `false` left every test green.
///
/// So the read is overridable per THREAD, under `#[cfg(test)]` only. A test turns it on,
/// drives the REAL `build_from_dir_checked` over a package that genuinely classifies
/// first-party, and observes the downgrade on the real path. The env-var half — the name,
/// and the shared `truthy_env` vocabulary — is pinned separately, so between the two nothing
/// about the hatch rests on inspection.
#[cfg(test)]
pub(crate) mod override_seam {
    use std::cell::Cell;

    thread_local! {
        static FORCED: Cell<Option<bool>> = const { Cell::new(None) };
    }

    /// Force the hatch on/off for THIS thread. Returns a guard that restores the previous
    /// value, so the override cannot outlive the test even on a panic.
    #[must_use]
    pub(crate) fn force(on: bool) -> Guard {
        let prev = FORCED.with(|f| f.replace(Some(on)));
        Guard(prev)
    }

    pub(crate) struct Guard(Option<bool>);
    impl Drop for Guard {
        fn drop(&mut self) {
            FORCED.with(|f| f.set(self.0));
        }
    }

    pub(super) fn forced() -> Option<bool> {
        FORCED.with(|f| f.get())
    }
}

/// The kill-switch truthiness rule, as a PURE predicate over the raw value.
///
/// Split out so the posture's tests never `set_var`: process-wide env mutation from a test
/// leaks into every other test in the binary (this crate already carries one flaky test for
/// exactly that reason), and the interesting behaviour is the posture, not the string
/// match. Same vocabulary as `seed_only_enabled`.
pub(crate) fn truthy_env(raw: Option<&str>) -> bool {
    matches!(raw, Some("1") | Some("true") | Some("TRUE") | Some("yes"))
}

/// Where a scanned package CAME FROM — the axis the load-failure posture turns on
/// (#190/#197).
///
/// A package the compile-time seed manages shipped from `src-app/packages/`: it was linted
/// by `build.rs` (with `lint_processor_tree`, the WHOLE-tree validator) before it was
/// embedded, so a runtime rejection of it means our build gate and our runtime gate
/// DISAGREE about our own artifact. That is a refusal, not a degradation. A package that
/// arrived by DROP-IN is untrusted input, and refusing to boot over one would let anyone
/// who can write a file under `<data_root>/processors/` brick the server — so it keeps the
/// tolerant skip (`mod.rs`'s reflect contract, INV-2).
///
/// **Derived, never enumerated.** The candidate set is
/// [`embedded::seed_managed_id_set`], built from the embedded seed itself — there is no
/// list for a new package to be forgotten from.
///
/// ## The name is NOT sufficient, and the difference is a denial of service
///
/// A first draft classified purely on the folder NAME. That is wrong, and the way it is
/// wrong inverts the whole argument above: `<data_root>/processors/` is writable at
/// runtime — D2 runtime drop-in discovery requires exactly that — and the seed reconcile
/// no-clobber for CONTENT (`embedded.rs`'s `plan_repair` compares embedded-vs-recorded
/// digests and "never reads disk content"). So an attacker who can write one file can
/// overwrite a SEED package's `manifest.yaml` with garbage, keep the seed-managed name,
/// and — under a name-only rule — earn a permanent, restart-surviving boot refusal. The
/// exact denial of service the tolerant drop-in posture exists to avoid, reached through
/// the trusted branch.
///
/// So [`Self::of_bytes`] additionally requires the on-disk `manifest.yaml` to be
/// BYTE-IDENTICAL to the one this binary embedded, and every other case (edited, replaced,
/// symlinked elsewhere, legitimately newer than the embed) falls to the TOLERANT posture.
/// The classification is deliberately fail-safe in that direction: any doubt about
/// provenance degrades to "that package absent", never to a refusal.
///
/// ## What it verifies, stated exactly
///
/// The MANIFEST, and only the manifest — not `compute/*`, not `ui/*`. That is the right
/// scope for the one thing this verdict decides: whether the whole-tree validator
/// `build.rs` ran over this manifest and the per-package validator the runtime ran over the
/// same bytes DISAGREE. Both validators read the manifest and nothing else, so the manifest
/// is exactly the evidence the disagreement is about. It is NOT an integrity claim over the
/// package's executable payload: the seed reconcile never reads disk content, so an
/// overwritten `compute/*.py` survives every restart while the manifest still matches. Do
/// not grow a privilege off this verdict without widening what it checks — the seed
/// manifest already records a per-file digest set, which is where that would start.
///
/// It is also the WRONG predicate for deciding which of two colliding packages to protect,
/// because an attacker can break byte-equality on OUR package with one appended newline.
/// `resolve_cross_package` keys protection on the seed-managed NAME for that reason; see
/// its `is_shipped`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PackageOrigin {
    /// Shipped in the binary's embedded seed AND still carrying the embedded bytes.
    FirstParty,
    /// Everything else: a runtime drop-in, or a seed-named folder whose manifest no longer
    /// matches what was embedded.
    DroppedIn,
}

impl PackageOrigin {
    /// Classify a package from the manifest bytes THE CALLER ALREADY READ. This is the
    /// classification the scan uses, and the only one that is race-free.
    ///
    /// The scan needs one manifest for three things — this classification, the lint, and
    /// the registry parse — and `<data_root>/processors/` is writable at runtime. Three
    /// independent reads let anyone rewriting the file in a loop have THIS read see the
    /// shipped bytes (⇒ `first-party`) while the LINT's read sees garbage (⇒ a rejection),
    /// manufacturing a first-party refusal and so a boot failure. Taking the bytes as an
    /// argument is what makes "these are the bytes we linted" and "these are the bytes we
    /// shipped" statements about the SAME bytes.
    pub fn of_bytes(folder_name: &str, manifest_bytes: &[u8]) -> Self {
        match super::embedded::embedded_manifest_bytes(folder_name) {
            // The bytes we shipped, unmodified: our artifact, our disagreement to answer for.
            Some(embedded) if embedded == manifest_bytes => Self::FirstParty,
            // Not a seed-managed id at all, or present but different (edited by hand,
            // replaced, or a legitimately newer local version the reconcile kept). Not
            // provably ours ⇒ tolerant.
            _ => Self::DroppedIn,
        }
    }

    /// Classify a scanned package DIRECTORY, reading the manifest itself.
    ///
    /// Kept for callers that hold only a path (and for tests that assert the
    /// classification over real directories). The SCAN does not use it — see
    /// [`Self::of_bytes`] for why reading twice is a race, not a convenience.
    pub fn of_dir(folder_name: &str, pkg_dir: &Path) -> Self {
        match std::fs::read(pkg_dir.join("manifest.yaml")) {
            Ok(disk) => Self::of_bytes(folder_name, &disk),
            // Unreadable / absent ⇒ nothing to vouch for.
            Err(_) => Self::DroppedIn,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::FirstParty => "first-party",
            Self::DroppedIn => "dropped-in",
        }
    }
}

/// Per-package outcome of a folder scan — surfaced by S7's `GET /api/processors` +
/// the S8 admin UI. `ok=true` for a package that passed lint + folded into the
/// registry; `ok=false` for a package SKIPPED because `lint_processor_package`
/// rejected it (its package-scoped `error` is carried). Serializable so the REST
/// surface can dump it verbatim.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct PackageLoadStatus {
    /// Package id — the manifest `id` for a loaded package, else the folder name.
    pub id: String,
    /// Declared manifest `version`, when the package parsed.
    pub version: Option<String>,
    /// True when the package passed lint + registered; false when skipped.
    pub ok: bool,
    /// The package-scoped error when skipped (`None` when `ok`).
    pub error: Option<String>,
    /// The STABLE machine-readable id of the check that refused this package
    /// (`PKG_DANGLING_EXTENDS`, `PKG_ENV_ID_INVALID`, …), `None` when `ok` (#190/#197).
    /// Assert this in a test, not the prose in `error`: a message assertion reddens on a
    /// wording change and passes on a semantic one.
    #[serde(default)]
    pub check: Option<String>,
    /// Where the package came from — the axis the load-failure posture turns on.
    /// `None` only for a registry built from in-memory manifests
    /// ([`ExtensionRegistry::from_manifests`]), which has no folder to classify.
    #[serde(default)]
    pub origin: Option<PackageOrigin>,
    /// The manifest's path RELATIVE to the scanned processors folder
    /// (`<folder>/manifest.yaml`), so an operator can go straight to the file. Relative
    /// rather than absolute because this field is dumped on every `GET /api/processors`,
    /// including the healthy case, and the data root is not that response's business. The
    /// ABSOLUTE path appears in the server-side log record and in the refusal text a failed
    /// reflect returns — both admin-gated (`sandbox::settings::{read,manage}`), and both
    /// places where an operator is actively diagnosing and needs the real path.
    #[serde(default)]
    pub manifest_path: Option<String>,
}

/// The folded, validated extension registry.
pub struct ExtensionRegistry {
    manifests: Vec<ExtensionManifest>,
    by_id: HashMap<String, usize>,
    /// Per-package load status (ok + skipped-with-error), id-sorted. Populated by
    /// [`build_from_dir`]; `from_manifests` records all-ok for its in-memory input.
    load_status: Vec<PackageLoadStatus>,
    /// How many CANDIDATE package folders (a sub-dir carrying a `manifest.yaml`) the scan
    /// discovered, whether or not they then loaded. The input to the anti-vacuity floor,
    /// which is applied on the boot/reflect path rather than inside the scan. `0` for a
    /// registry built from in-memory manifests, which did not scan anything.
    candidates_seen: usize,
    /// How many RAW sub-directories the scan walked, before the candidate/reserved/
    /// SEED-ONLY filters. Carried alongside `candidates_seen` because the two together are
    /// what make the floor's diagnosis actionable: "15 sub-dirs, none a package" points at
    /// a failed extraction or a wrong data root, while "0 sub-dirs" points at an empty or
    /// missing folder. Reporting only the candidate count would leave an operator unable
    /// to tell those apart. `0` for a registry built from in-memory manifests.
    dirs_seen: usize,
}

impl ExtensionRegistry {
    /// Build the registry the way boot does: extract the embedded SEED to
    /// `<data_root>/processors` once ([`embedded::ensure_extracted`], OnceCell-guarded
    /// so the two boot callers — order-17 datatype + order-18 extensions — share ONE
    /// extraction) and then SCAN that folder (INV-1: no reader consults `include_dir!`
    /// bytes for the registry). A thin wrapper so existing callers keep their name.
    pub fn build_from_embedded() -> Result<Self, String> {
        let dir = embedded::ensure_extracted()?;
        Self::build_from_dir(&dir)
    }

    /// [`build_from_embedded`](Self::build_from_embedded) plus the LOAD POSTURE
    /// (#190/#197) — the entry point BOOT and every reflect use.
    ///
    /// See [`build_from_dir_checked`](Self::build_from_dir_checked) for what "checked"
    /// means and why it is not folded into the scan itself.
    pub fn build_from_embedded_checked() -> Result<Self, String> {
        let dir = embedded::ensure_extracted()?;
        Self::build_from_dir_checked(&dir)
    }

    /// SCAN a processor folder, report every refusal LOUDLY, and apply the load posture
    /// (#190/#197). This is the dir-scoped core both publish sites route through —
    /// `ExtensionsModule::init` (boot) and `reflect_processors` (the S6 watcher + the S7
    /// reload endpoint) — so a test drives the same function production does.
    ///
    /// ## The defect this closes
    ///
    /// A package the registry refuses registers NOTHING, and before this the only traces
    /// were a per-package `tracing::error!` that scrolls past at boot and an `ok:false`
    /// row on an admin-only REST route. `cargo check`, the build, and every gate stayed
    /// green, so a silently-unregistered analysis was indistinguishable from a working one
    /// until a user noticed a missing result.
    ///
    /// ## What it does instead
    ///
    /// 1. Assembles ONE aggregated record over the whole scan — count, and per package the
    ///    id, origin, check id, manifest path and reason — rather than one line per
    ///    package that a reader has to reassemble.
    /// 2. Emits it at `error!` when anything was refused (`debug!` on the clean path, so a
    ///    healthy boot stays quiet).
    /// 3. Applies the posture BY ORIGIN (DEC-1): a FIRST-PARTY refusal returns `Err`
    ///    carrying the rendered report, and a DROPPED-IN refusal does not. The caller
    ///    decides what `Err` means — boot fails, a running server refuses the swap and
    ///    keeps its last-good registry (DEC-7). Neither ever kills a serving process.
    ///
    /// ## Why the posture is here and not inside `scan_dir`
    ///
    /// `scan_dir` stays PURE and always-tolerant: it is what `resolve_cross_package`, the
    /// datatype-registry projection, and several tests build on, and a scan that can
    /// refuse would make "what does this folder contain" depend on a deploy-level env var.
    /// Keeping the two apart is also what keeps INV-2 checkable — the tolerant path is
    /// still the only path the scan itself knows.
    pub fn build_from_dir_checked(root: &Path) -> Result<Self, String> {
        let reg = Self::build_from_dir(root)?;
        reg.check_anti_vacuity_floor(root)?;
        Self::apply_load_posture(&reg, root)?;
        Ok(reg)
    }

    /// ITEM-6 / DEC-8 — the ANTI-VACUITY floor.
    ///
    /// A reporter that can silently see NOTHING is the failure mode this whole change
    /// exists to prevent: with zero candidate packages every downstream assertion ("no
    /// package was rejected", "every declared type loaded") is vacuously TRUE, and the
    /// registry publishes empty while every gate stays green. So a scan that discovered no
    /// candidate is an ERROR carrying a DIAGNOSIS of what probably moved — the
    /// `check-derived-vocabulary.sh` idiom — never a clean empty result.
    ///
    /// Deliberately zero-vs-nonzero rather than a "≥ N packages" floor: a typed-in number
    /// decays (it must be edited whenever packages are added, and it is vacuously true for
    /// everything beneath it), while "did the walk see anything at all" is derivable and
    /// needs no maintenance.
    ///
    /// It lives HERE, on the boot/reflect path, and not inside `scan_dir`: `scan_dir` is
    /// documented as pure and always-tolerant, `build_from_dir` is a pre-existing `pub`
    /// contract whose callers include tests that legitimately scan a folder they built, and
    /// a floor that fires inside the scan would have been an unannounced behaviour change
    /// for all of them. Note it is deliberately ORIGIN-BLIND — "the folder is empty" has no
    /// owning package to attribute it to — and it is a REFLECT refusal, not a process kill:
    /// under DEC-7 the last-good registry keeps serving.
    fn check_anti_vacuity_floor(&self, root: &Path) -> Result<(), String> {
        if self.candidates_seen > 0 {
            return Ok(());
        }
        // The OPERATOR OVERRIDE covers this refusal too (DEC-1, amended). It did not, and
        // the gap had teeth: the floor is ORIGIN-BLIND and fires before the posture, so
        // emptying the processors folder — or renaming every package to a `_`-prefixed
        // reserved name — refused every reflect for the life of the process, and no
        // documented lever got an operator past it. The single escape hatch now downgrades
        // every load refusal this module can raise, which is the only reading under which
        // "a deployment can limp while a fix ships" is true. A deployment that genuinely
        // runs with no packages sets it deliberately, and the fact that it is set is itself
        // reported by every rejection report.
        if allow_broken_first_party() {
            tracing::error!(
                root = %root.display(),
                override_env = ALLOW_BROKEN_FIRST_PARTY_ENV,
                "processor scan discovered ZERO candidate packages, and the operator \
                 override is downgrading that to a warning — the registry will publish \
                 EMPTY and every analysis is gone. This is a limp-along mode, not a fix."
            );
            return Ok(());
        }
        Err(format!(
            "processor scan discovered ZERO candidate packages under `{}` ({} \
             sub-director{} walked, none carrying a `manifest.yaml` this scan would \
             load). This is a scan COLLAPSE, not an empty result: refusing to publish an \
             empty registry, because an empty registry makes every downstream check \
             vacuously green while the product silently loses every analysis. Likely \
             causes — the embedded seed failed to extract; the app data root moved or \
             points somewhere else; the folder was emptied or its manifests deleted by \
             hand; or CYTO_PROCESSOR_SEED_ONLY is set{} (a `_`-prefixed reserved package \
             is not a candidate, so a folder holding only those counts as zero here). To \
             limp along with an empty registry while you fix it, set \
             {ALLOW_BROKEN_FIRST_PARTY_ENV}=1.",
            root.display(),
            self.dirs_seen,
            if self.dirs_seen == 1 { "y" } else { "ies" },
            if super::seed_only_enabled() {
                " — it IS set, and no seed-managed folder was found"
            } else {
                " — it is not set"
            },
        ))
    }

    /// Assemble the rejection report, emit it, and apply the origin-scoped posture.
    ///
    /// Named separately from [`build_from_dir_checked`] only so the two things it does —
    /// EMIT the aggregated record, and decide the posture — read as one step at the call
    /// site. It is NOT a test seam: reaching around `build_from_dir_checked` to call this
    /// directly proves the posture function and leaves unasserted the edge that actually
    /// matters, which is that boot and every reflect go through it. Tests stage a
    /// first-party failure at the classification instead (`pretend_we_shipped`) and assert
    /// on `build_from_dir_checked` itself.
    pub fn apply_load_posture(reg: &Self, root: &Path) -> Result<(), String> {
        let report = PackageRejectionReport::of(reg, root);
        report.emit();
        report.into_posture_result()
    }

    /// Build the registry by SCANNING an extracted processor folder (ITEM-5). Each
    /// `<id>/` sub-dir carrying a `manifest.yaml` is one package; a dir without a
    /// `manifest.yaml` (or a hidden `.`-prefixed staging dir) is skipped silently as a
    /// non-package. For every candidate package the S1 single-source validator
    /// [`lint_processor_package`](crate::processor_manifest_lint::lint_processor_package)
    /// runs FIRST — on `Err` its package-scoped message is `tracing::error!`-logged,
    /// collected into the per-package load-status, and the package is SKIPPED (the scan
    /// does NOT abort, so every valid sibling still registers — INV-4). The valid
    /// packages are parsed into `ExtensionManifest`s and folded through
    /// [`from_manifests`](Self::from_manifests).
    pub fn build_from_dir(root: &Path) -> Result<Self, String> {
        // Deploy-level SEED-ONLY kill-switch (M8, §16): when ON, the scan trusts ONLY the
        // baked seed — any unmanaged (user / attacker-dropped) folder is IGNORED (not
        // scanned, not loaded), so a malicious drop-in can never be discovered/loaded.
        // `None` (the default) = discover everything (D2 runtime discovery on).
        // The CACHED id set (not the cloning `seed_managed_ids()` wrapper): this runs on
        // every scan, and the watcher can fire repeatedly.
        let seed_only: Option<&'static std::collections::HashSet<String>> =
            if super::seed_only_enabled() {
                Some(super::embedded::seed_managed_id_set())
            } else {
                None
            };
        Self::scan_dir(root, seed_only)
    }

    /// The scan core with the SEED-ONLY filter injected (so it is testable without the env
    /// var — a `Some(managed)` restricts the scan to seed-managed ids). `None` scans every
    /// non-hidden, non-reserved package folder (the default D2 discovery).
    pub fn scan_dir(
        root: &Path,
        seed_only: Option<&std::collections::HashSet<String>>,
    ) -> Result<Self, String> {
        // `(folder_name, manifest)` — the folder name identifies a skipped package in the
        // load-status even when its manifest `id` collides with another package's (a
        // duplicate-extension-id drop-in).
        let mut valid: Vec<(String, ExtensionManifest)> = Vec::new();
        let mut skipped: Vec<PackageLoadStatus> = Vec::new();

        // Deterministic (id-sorted) scan order so the registry + load-status are stable.
        let mut dirs: Vec<std::path::PathBuf> = std::fs::read_dir(root)
            .map_err(|e| format!("cannot scan processors dir `{}`: {e}", root.display()))?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();
        dirs.sort();
        let dirs_seen = dirs.len();

        // Every candidate id the walk actually reached. The set the SHIPPED-BUT-ABSENT
        // check below is derived from: seed ids MINUS what we saw. Never a list.
        let mut seen_candidates: std::collections::HashSet<String> =
            std::collections::HashSet::new();

        // The number of dirs that actually LOOK like a package. The anti-vacuity floor
        // below is stated over this rather than over `dirs`, so "the folder is full of
        // non-package dirs" and "the folder is empty" fail the same way.
        let mut candidates = 0usize;

        // A skip carries the SAME shape wherever it is raised: id, coded check, derived
        // origin, and the manifest path relative to the scanned root.
        // Each candidate's ORIGIN, computed ONCE per scan (it reads the manifest off disk
        // to compare against the embedded bytes, so it must not be recomputed per use) and
        // shared with `resolve_cross_package`, which needs it to pick its victims.
        let mut origins: HashMap<String, PackageOrigin> = HashMap::new();

        fn reject(
            origins: &HashMap<String, PackageOrigin>,
            folder: &str,
            check: &str,
            error: String,
        ) -> PackageLoadStatus {
            PackageLoadStatus {
                // SANITIZED + CLIPPED at CAPTURE, not at render. Both strings are
                // attacker-chosen — the id is a folder name and the reason is parser output
                // over a dropped-in manifest — and from here they reach three sinks: a
                // line-oriented log, the boot refusal text, and `GET /api/processors`.
                // Clipping only inside the report left the per-package `tracing::error!`
                // and the stored `PackageLoadStatus.error` unbounded, and the log-forgery
                // note claimed an escaping the installed formatter does not perform.
                id: sanitize_for_report(folder),
                version: None,
                ok: false,
                error: Some(sanitize_for_report(&error)),
                check: Some(check.to_string()),
                // Every skip path routes through here, so a rejection can never reach the
                // report without an origin (the report's fallback would silently downgrade
                // it to the tolerant posture — see `PackageRejectionReport::of`).
                origin: Some(origins.get(folder).copied().unwrap_or(PackageOrigin::DroppedIn)),
                manifest_path: Some(sanitize_for_report(&format!("{folder}/manifest.yaml"))),
            }
        }

        for pkg_dir in dirs {
            // LOSSY, never `unwrap_or_default()`: a non-UTF-8 directory name used to
            // collapse to the EMPTY string, which is neither `.`- nor `_`-prefixed, so such
            // a folder was scanned and then reported with `id: ""` and
            // `manifest_path: "/manifest.yaml"` — an operator could not tell which
            // directory was at fault, and N of them produced N indistinguishable rows that
            // silently aliased in the origin map. A lossy name is still findable.
            let name = pkg_dir.file_name().unwrap_or_default().to_string_lossy().to_string();
            // A hidden dir (`.seed-manifest.json` sibling temp dirs like `.qc.tmp-*`)
            // is never a package.
            if name.starts_with('.') {
                continue;
            }
            // A `_`-prefixed dir is a RESERVED helpers-only package (`_helpers`, D2 S5):
            // it ships shared compute assets to disk (staged by the runner from the
            // folder) but contributes NO datatype/converter/view — so it is SKIPPED from
            // the registry (never shows in `GET /api/extensions`, contributes no
            // datatype). Its files stay extractable + resolvable via the seed extractor +
            // `sandbox::processors::resolve`. A real contributing package must not use a
            // leading underscore.
            if is_reserved_package(&name) {
                continue;
            }
            // SEED-ONLY (M8): ignore any folder whose id is not a baked-seed package.
            if let Some(managed) = seed_only {
                if !managed.contains(&name) {
                    continue;
                }
            }
            // A dir with no `manifest.yaml` is a non-package dir, not an error.
            if !pkg_dir.join("manifest.yaml").is_file() {
                continue;
            }
            candidates += 1;
            seen_candidates.insert(name.clone());

            // ── ONE read of the manifest, shared by all three consumers. ──
            // The classification, the lint and the registry parse each used to read the
            // file themselves. `<data_root>/processors/` is writable at runtime, so three
            // reads are a race an attacker can drive: rewrite the file in a loop and the
            // classification sees the shipped bytes (⇒ first-party) while the lint sees
            // garbage (⇒ a rejection) — a first-party refusal, i.e. a boot failure,
            // manufactured from a file anyone could write. Reading once makes "the bytes we
            // shipped" and "the bytes we linted" statements about the same bytes.
            let manifest_path = pkg_dir.join("manifest.yaml");
            let bytes = match std::fs::read(&manifest_path) {
                Ok(b) => b,
                Err(e) => {
                    // Nothing was read, so nothing can vouch for this folder: the tolerant
                    // default is already what `reject` applies for an unclassified id.
                    // RELATIVE, like `manifest_path`: this string is served verbatim on
                    // `GET /api/processors`, and the absolute data-root path is not that
                    // response's business — rendering it here would defeat the sibling
                    // field's whole stated reason for being relative.
                    let msg = format!("cannot read `{name}/manifest.yaml`: {e}");
                    tracing::error!(package = %name, check = CHECK_UNREADABLE, error = %msg, "processor package skipped");
                    skipped.push(reject(&origins, &name, CHECK_UNREADABLE, msg));
                    continue;
                }
            };
            origins.insert(name.clone(), PackageOrigin::of_bytes(&name, &bytes));
            let text = match String::from_utf8(bytes) {
                Ok(t) => t,
                Err(e) => {
                    let msg = format!("`{name}/manifest.yaml` is not valid UTF-8: {e}");
                    tracing::error!(package = %name, check = CHECK_UNREADABLE, error = %msg, "processor package skipped");
                    skipped.push(reject(&origins, &name, CHECK_UNREADABLE, msg));
                    continue;
                }
            };

            // The STRONG per-package gate (replaces the old `loader::validate`): run
            // the SAME validator `build.rs` runs, over the bytes just read.
            // `_detailed` (vs the `String` wrapper) so the rejection carries its stable
            // check id into the report (#190/#197).
            if let Err(e) = crate::processor_manifest_lint::lint_processor_manifest_text(&name, &text)
            {
                tracing::error!(package = %name, check = %e.check, error = %e.message, "processor package skipped (failed lint)");
                skipped.push(reject(&origins, &name, e.check, e.message));
                continue;
            }
            // Lint passed → parse into the registry manifest type. A parse error here
            // (should not happen given lint passed) is likewise a per-package skip.
            match serde_norway::from_str::<ExtensionManifest>(&text) {
                Ok(m) if m.id.trim().is_empty() => {
                    // `from_manifests` REFUSES an empty id for the WHOLE set, and the
                    // per-package lint does not check it — so before this guard a drop-in
                    // carrying `id: ""` aborted the entire scan, failing boot and every
                    // reflect, permanently (a drop-in folder is invisible to the seed
                    // reconcile, so it survives restarts). One attacker-writable file was a
                    // permanent brick. Caught HERE, at the folder boundary, it is an
                    // ordinary per-package skip like every other malformation.
                    let msg = "manifest declares an empty `id`".to_string();
                    tracing::error!(package = %name, check = CHECK_EMPTY_EXTENSION_ID, error = %msg, "processor package skipped");
                    skipped.push(reject(&origins, &name, CHECK_EMPTY_EXTENSION_ID, msg));
                }
                Ok(m) => valid.push((name, m)),
                Err(e) => {
                    let msg = format!("failed to parse manifest: {e}");
                    tracing::error!(package = %name, check = CHECK_REGISTRY_PARSE, error = %msg, "processor package skipped");
                    skipped.push(reject(&origins, &name, CHECK_REGISTRY_PARSE, msg));
                }
            }
        }

        // ── The SEED packages this binary shipped that the scan never even saw. ──
        //
        // Every rejection above is raised from a folder the walk reached. A folder that is
        // GONE — or whose `manifest.yaml` was deleted — raises nothing at all: the loop
        // `continue`s before `candidates += 1`, no load-status row exists, and the registry
        // publishes without that package while every row it does hold reads `ok`. That is
        // #190/#197 verbatim for a package we shipped, and it is reachable after boot:
        // `ensure_extracted` is `OnceCell`-guarded, so the repair that would restore the
        // file runs once per process and never again — while the S6 watcher happily
        // reflects the deletion.
        //
        // The expectation is DERIVED, never listed: the embedded seed's own id set, minus
        // the reserved (`_`-prefixed) packages that deliberately register nothing, minus
        // whatever the walk actually saw. A package landing on main tomorrow is covered
        // with no edit here.
        //
        // Posture: LOUD, not fatal. A missing file cannot prove the package was ever ours
        // on this disk, and deleting one is exactly as attacker-reachable as overwriting
        // one — so refusing boot over it would reintroduce the denial of service the
        // origin-by-bytes rule exists to prevent (DEC-11). It is also self-healing on the
        // next restart, which the diagnostic says.
        if seed_only.is_none() {
            let mut absent: Vec<String> = super::embedded::seed_managed_id_set()
                .iter()
                .filter(|id| !is_reserved_package(id))
                .filter(|id| !seen_candidates.contains(id.as_str()))
                .cloned()
                .collect();
            absent.sort();
            for id in absent {
                let msg = format!(
                    "this binary SHIPPED `{id}`, but the scan found no `{id}/manifest.yaml` \
                     under the processors folder — so it contributes nothing and its \
                     analyses are simply gone. The seed extraction repairs missing files \
                     once per process, so this does not self-heal until the next restart; \
                     restore the folder or restart the server."
                );
                tracing::error!(package = %id, check = CHECK_SEED_PACKAGE_ABSENT, error = %msg, "shipped processor package is MISSING from the processors folder");
                skipped.push(reject(&origins, &id, CHECK_SEED_PACKAGE_ABSENT, msg));
            }
        }

        // The candidate count is carried out of the scan rather than judged here: the
        // ANTI-VACUITY floor (ITEM-6 / DEC-8) belongs on the BOOT + REFLECT path
        // (`build_from_dir_checked`), not inside a function documented as pure and
        // always-tolerant, and not on `build_from_dir`'s pre-existing contract, whose
        // callers include several tests that legitimately scan whatever folder they built.
        let candidate_count = candidates;

        // CROSS-PACKAGE resolution (INV-4, H1). A per-package lint cannot catch a
        // violation that only exists BETWEEN drop-ins — a duplicate extension id, a
        // duplicate contributed datatype id, a datatype colliding with a core (Rust)
        // datatype, a SECOND lattice root (`extends: none`), a dangling / cross-package
        // `extends`, or a contributed-datatype cycle. Previously any of these ABORTED the
        // whole registry build (`from_manifests`/`merge_entries`/`validate` returned
        // `Err`), so a single persisted bad drop-in failed BOOT / made every reflect Err —
        // the valid seed became un-loadable until an operator removed the offender. That
        // violates INV-4 ("a malformed sibling must be skipped, the scan must not abort").
        // Here we SKIP the offending package(s) with a package-scoped error (collected
        // into load-status), iterated to a fixpoint so a cascade (a package extends a
        // datatype contributed by a package skipped this round) resolves, and every VALID
        // package still loads.
        resolve_cross_package(&mut valid, &mut skipped, &origins);

        // The surviving packages' FOLDER names, keyed by the manifest id `from_manifests`
        // will record them under. A loaded package's load-status has to carry its origin
        // too (the report shows first-party and dropped-in packages side by side), and the
        // origin is a property of the FOLDER, which `from_manifests` never sees.
        let folder_of: HashMap<String, String> = valid
            .iter()
            .map(|(folder, m)| (m.id.clone(), folder.clone()))
            .collect();

        // Fold the valid packages (this records their ok load-status), then append the
        // skipped ones + re-sort so the whole set is id-ordered. `from_manifests` can no
        // longer hit a duplicate extension id (resolved above), so it never aborts here.
        let mut reg = Self::from_manifests(valid.into_iter().map(|(_, m)| m).collect())?;
        for st in &mut reg.load_status {
            if let Some(folder) = folder_of.get(&st.id) {
                st.origin = origins.get(folder).copied();
                st.manifest_path = Some(format!("{folder}/manifest.yaml"));
            }
        }
        reg.load_status.extend(skipped);
        reg.load_status.sort_by(|a, b| a.id.cmp(&b.id));
        reg.candidates_seen = candidate_count;
        reg.dirs_seen = dirs_seen;
        Ok(reg)
    }

    /// Every package the scan REFUSED, id-sorted (#190/#197). The report's row set.
    pub fn rejections(&self) -> Vec<&PackageLoadStatus> {
        self.load_status.iter().filter(|s| !s.ok).collect()
    }

    /// Build from an explicit set of manifests (the testable core). Rejects an empty
    /// id and records an all-`ok` per-package load status. A duplicate extension id is
    /// resolved UPSTREAM by [`resolve_cross_package`] at the folder boundary (skip the
    /// later, keep the seed) so the whole scan never aborts; a residual duplicate here
    /// (only reachable via a direct programmatic call, e.g. a test) is still rejected. The
    /// per-package SCHEMA validation is `lint_processor_package`'s job at the folder
    /// boundary ([`build_from_dir`]); this in-memory core keeps only the cheap
    /// structural id checks.
    pub fn from_manifests(manifests: Vec<ExtensionManifest>) -> Result<Self, String> {
        let mut by_id: HashMap<String, usize> = HashMap::new();
        let mut load_status: Vec<PackageLoadStatus> = Vec::new();
        for (i, m) in manifests.iter().enumerate() {
            if m.id.trim().is_empty() {
                return Err("extension manifest has an empty `id`".to_string());
            }
            if by_id.insert(m.id.clone(), i).is_some() {
                return Err(format!("duplicate extension id `{}`", m.id));
            }
            load_status.push(PackageLoadStatus {
                id: m.id.clone(),
                version: Some(m.version.clone()),
                ok: true,
                error: None,
                check: None,
                // An in-memory build has no folder to classify; `scan_dir` fills this in
                // for the packages it folded through here.
                origin: None,
                manifest_path: None,
            });
        }
        load_status.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(Self {
            manifests,
            by_id,
            load_status,
            candidates_seen: 0,
            dirs_seen: 0,
        })
    }

    /// The per-package load status (ok + skipped-with-error), id-sorted — the source
    /// S7's `GET /api/processors` + the S8 admin UI dump. Every scanned package
    /// (registered OR skipped) appears exactly once.
    pub fn load_status(&self) -> &[PackageLoadStatus] {
        &self.load_status
    }

    /// All manifests, ordered by id for a stable dump.
    pub fn all(&self) -> Vec<&ExtensionManifest> {
        let mut v: Vec<&ExtensionManifest> = self.manifests.iter().collect();
        v.sort_by(|a, b| a.id.cmp(&b.id));
        v
    }

    /// One extension by id.
    pub fn get(&self, id: &str) -> Option<&ExtensionManifest> {
        self.by_id.get(id).map(|&i| &self.manifests[i])
    }

    pub fn len(&self) -> usize {
        self.manifests.len()
    }

    pub fn is_empty(&self) -> bool {
        self.manifests.is_empty()
    }
}

/// Resolve CROSS-PACKAGE violations by SKIPPING the offending package(s) instead of
/// aborting the whole build (INV-4, H1). Mutates `valid` in place (removing offenders)
/// and pushes a package-scoped [`PackageLoadStatus`] per skipped package. Iterated to a
/// FIXPOINT so a cascade resolves: removing a package that contributed a datatype can turn
/// a sibling's previously-valid `extends` into a dangling one, which is caught on the next
/// round. Determinism: `valid` arrives id-sorted, and each round removes the FIRST offender
/// in id order, so the surviving set + skip reasons are stable across runs (and identical
/// for the two boot scans + every reflect). The checks mirror exactly what the datatype
/// registry's `merge_entries` + `validate` would otherwise abort on — a duplicate extension
/// id, a datatype colliding with a core id, a duplicate contributed datatype id, a SECOND
/// root, a dangling/self `extends`, and a contributed-datatype cycle — so after this pass
/// the downstream `from_manifests` + `build_merged` + `validate` build cleanly.
///
/// ## Victim selection is ORIGIN-AWARE (#190/#197 security fix)
///
/// Every check here has a CHOICE of who to blame, and the original rule was positional —
/// "keep the first in id order", "blame the later", "blame the id-sorted-last member of the
/// cycle". Positional blame is exploitable the moment a refusal has consequences: a
/// dropped-in folder sorting before a shipped one, declaring the SAME extension id (or a
/// colliding contributed datatype id, or an `extends` edge that closes a cycle through a
/// seed type), made the SEED package the offender. Under the load posture that turned one
/// attacker-writable file into a permanent, restart-surviving boot refusal — the exact
/// denial of service the tolerant drop-in posture exists to prevent, reached through the
/// trusted branch.
///
/// So wherever a choice exists, the package this binary did NOT ship is the victim, and a
/// shipped one is chosen only when no unshipped candidate is implicated. Two properties
/// follow, and both are asserted: a drop-in can never displace a shipped package, and a
/// first-party refusal therefore always means our own artifact is genuinely at fault.
///
/// Note the predicate is SHIPPED-BY-NAME, not `PackageOrigin::FirstParty` — see the
/// `is_shipped` comment below for why keying protection on the bytes was itself a hole.
fn resolve_cross_package(
    valid: &mut Vec<(String, ExtensionManifest)>,
    skipped: &mut Vec<PackageLoadStatus>,
    origins: &HashMap<String, PackageOrigin>,
) {
    use std::collections::HashSet;

    // ── The two questions this function must NOT confuse (DEC-10, amended). ──
    //
    // "Is this OUR artifact, so its failure is our disagreement to answer for?" is decided
    // by the embedded BYTES (`PackageOrigin::FirstParty`), because that verdict can REFUSE
    // THE LOAD, and a verdict with that power must not be reachable by anyone who can write
    // a file.
    //
    // "Which package do we PROTECT when two of them collide?" is a different question, and
    // keying it on the bytes was a hole. Appending one newline to a shipped manifest leaves
    // it valid, still loading, and no longer byte-identical — the reconcile compares
    // recorded-vs-embedded digests and never reads disk content, so the edit survives every
    // restart. That demoted the SHIPPED package to `DroppedIn`, which collapsed victim
    // selection back to plain id order, and a folder named `aaa-…` declaring the shipped
    // package's extension id then EVICTED it and took over its id. Protection therefore
    // keys on the seed-managed NAME: an attacker cannot remove a name from the binary's own
    // embedded id set, and the asymmetry is safe in the way the byte check is not — being
    // protected as a keeper can only ever cost the ATTACKER's package its registration,
    // never grant anything to a package that is not ours.
    let is_shipped = |folder: &str| super::embedded::seed_managed_id_set().contains(folder);

    let skip = |folder: &str, m: &ExtensionManifest, check: &str, reason: String| {
        PackageLoadStatus {
            // Identify by the FOLDER name — a duplicate-extension-id drop-in shares its
            // manifest `id` with the kept package, so the manifest id would collide.
            id: folder.to_string(),
            version: Some(m.version.clone()),
            ok: false,
            error: Some(format!("package `{folder}` skipped: {reason}")),
            // These checks are CROSS-package: the same violation classes the per-package
            // lint reports, decided here over the whole surviving set instead.
            check: Some(check.to_string()),
            // The scan classified every candidate; a folder missing from the map never got
            // that far, and the tolerant default is the safe direction.
            origin: Some(origins.get(folder).copied().unwrap_or(PackageOrigin::DroppedIn)),
            manifest_path: Some(format!("{folder}/manifest.yaml")),
        }
    };

    // 1. Duplicate EXTENSION id — keep ONE, skip the rest. Done once up front (an
    //    extension id can't become a dup later — the set only shrinks).
    //
    //    Which one is kept is a SECURITY decision, not a tie-break: the SHIPPED package
    //    wins, and only among equals does id order decide. Keeping "the first in id order"
    //    let a drop-in named `aaa` that declares a shipped package's id evict that shipped
    //    package — and, with the load posture, brick the boot.
    {
        let mut order: Vec<usize> = (0..valid.len()).collect();
        order.sort_by_key(|&i| {
            let (folder, _) = &valid[i];
            // false < true, so a shipped package sorts first and is the keeper.
            (!is_shipped(folder), i)
        });
        let mut seen_ext: HashSet<String> = HashSet::new();
        let mut keep: Vec<bool> = vec![false; valid.len()];
        for i in order {
            if seen_ext.insert(valid[i].1.id.clone()) {
                keep[i] = true;
            }
        }
        let mut kept: Vec<(String, ExtensionManifest)> = Vec::with_capacity(valid.len());
        for (i, (folder, m)) in std::mem::take(valid).into_iter().enumerate() {
            if keep[i] {
                kept.push((folder, m));
                continue;
            }
            skipped.push(skip(
                &folder,
                &m,
                CHECK_DUPLICATE_EXTENSION_ID,
                format!(
                    "duplicate extension id `{}` (another package already declares it)",
                    m.id
                ),
            ));
        }
        *valid = kept;
    }

    // The CORE (Rust `#[distributed_slice(DATATYPES)]`) datatype ids — the fixed lattice a
    // manifest may EXTEND but never shadow / re-root. Collected once.
    let core_ids: HashSet<&'static str> = crate::modules::datatype::registry::DATATYPES
        .iter()
        .map(|e| e.id)
        .collect();

    // 2/3/4. Contributed-datatype cross-package checks, iterated to a fixpoint.
    loop {
        // The datatype ids available to resolve an `extends` against = core ∪ every
        // contributed id from the CURRENTLY-surviving packages.
        let available: HashSet<&str> = core_ids
            .iter()
            .copied()
            .chain(
                valid
                    .iter()
                    .flat_map(|(_, m)| m.contributes.datatypes.iter().map(|d| d.id.as_str())),
            )
            .collect();

        // Find ONE offending package. Precedence between CHECKS is unchanged:
        // core-collision / second-root / self-extends (intrinsic to the package) →
        // duplicate contributed id → dangling extends (needs the available set) → cycle.
        //
        // Precedence between CANDIDATES within a check is origin-aware (see the fn doc):
        // each pass runs over a candidate order that puts DROPPED-IN packages first, so a
        // drop-in is always the victim when one is implicated. `scan_order` is that order.
        let scan_order: Vec<usize> = {
            let mut ix: Vec<usize> = (0..valid.len()).collect();
            ix.sort_by_key(|&i| (is_shipped(&valid[i].0), i));
            ix
        };
        let mut offender: Option<(usize, &'static str, String)> = None;

        // (a) core-collision / second-root / self-extends.
        'a: for &i in &scan_order {
            let (_, m) = &valid[i];
            for d in &m.contributes.datatypes {
                if core_ids.contains(d.id.as_str()) {
                    offender = Some((
                        i,
                        CHECK_ROOT_ID_COLLISION,
                        format!(
                            "contributed datatype `{}` collides with a core datatype id",
                            d.id
                        ),
                    ));
                    break 'a;
                }
                match d.extends.as_deref() {
                    None => {
                        offender = Some((
                            i,
                            CHECK_SECOND_ROOT,
                            format!(
                                "contributed datatype `{}` is a SECOND lattice root (extends: none); the lattice already has the core root",
                                d.id
                            ),
                        ));
                        break 'a;
                    }
                    Some(p) if p == d.id.as_str() => {
                        offender = Some((
                            i,
                            CHECK_EXTENDS_CYCLE,
                            format!("contributed datatype `{}` extends itself", d.id),
                        ));
                        break 'a;
                    }
                    _ => {}
                }
            }
        }

        // (b) duplicate contributed datatype id across packages — the LATER package (id
        //     order) is the offender.
        if offender.is_none() {
            // Ownership is claimed SHIPPED-FIRST, so the shipped contributor is the owner
            // and the drop-in is the duplicate — never the other way round.
            let mut owner: HashMap<&str, usize> = HashMap::new();
            let mut claim_order: Vec<usize> = (0..valid.len()).collect();
            claim_order.sort_by_key(|&i| (!is_shipped(&valid[i].0), i));
            'b: for &i in &claim_order {
                let (_, m) = &valid[i];
                for d in &m.contributes.datatypes {
                    if owner.contains_key(d.id.as_str()) {
                        offender = Some((
                            i,
                            CHECK_DUPLICATE_DATATYPE_ID,
                            format!(
                                "duplicate contributed datatype id `{}` (already contributed by another package)",
                                d.id
                            ),
                        ));
                        break 'b;
                    }
                    owner.insert(d.id.as_str(), i);
                }
            }
        }

        // (c) dangling / cross-package `extends` — a parent that resolves to neither a core
        //     id nor a surviving-contributed id.
        if offender.is_none() {
            'c: for &i in &scan_order {
                let (_, m) = &valid[i];
                for d in &m.contributes.datatypes {
                    if let Some(parent) = d.extends.as_deref() {
                        if !available.contains(parent) {
                            offender = Some((
                                i,
                                CHECK_DANGLING_EXTENDS,
                                format!(
                                    "contributed datatype `{}` extends unknown supertype `{}`",
                                    d.id, parent
                                ),
                            ));
                            break 'c;
                        }
                    }
                }
            }
        }

        // (d) contributed-datatype CYCLE — walk `extends` from every contributed node; a
        //     revisit means a cycle. Blame the id-sorted-last contributed package whose
        //     datatype sits ON the cycle (removing a real participant breaks it).
        if offender.is_none() {
            // parent map over the FULL merged lattice (core + contributed).
            let mut parent_of: HashMap<&str, &str> = HashMap::new();
            for e in crate::modules::datatype::registry::DATATYPES.iter() {
                if let Some(p) = e.extends {
                    parent_of.insert(e.id, p);
                }
            }
            // contributed id -> owning package index.
            let mut owner: HashMap<&str, usize> = HashMap::new();
            for (i, (_, m)) in valid.iter().enumerate() {
                for d in &m.contributes.datatypes {
                    parent_of.insert(d.id.as_str(), d.extends.as_deref().unwrap_or(""));
                    owner.insert(d.id.as_str(), i);
                }
            }
            'd: for start in owner.keys().copied() {
                let mut seen: HashSet<&str> = HashSet::new();
                let mut cur = start;
                while let Some(&p) = parent_of.get(cur) {
                    if p.is_empty() {
                        break; // reached a root
                    }
                    if !seen.insert(cur) {
                        // `cur` is on a cycle — pick the id-sorted-last contributed member
                        // reachable from here as the offender (deterministic).
                        // Re-walk to collect the cycle members.
                        let mut members: Vec<&str> = Vec::new();
                        let mut w = cur;
                        loop {
                            members.push(w);
                            w = parent_of.get(w).copied().unwrap_or("");
                            if w == cur || w.is_empty() {
                                break;
                            }
                        }
                        // Blame an UNSHIPPED participant when the cycle has one: a drop-in
                        // can close a cycle through a shipped type, and blaming the
                        // id-sorted-last member would then evict the shipped package.
                        let mut on_cycle: Vec<&str> = members
                            .into_iter()
                            .filter(|id| owner.contains_key(id))
                            .collect();
                        on_cycle.sort();
                        let blame = on_cycle
                            .iter()
                            .copied()
                            .find(|id| !is_shipped(&valid[owner[id]].0))
                            .or_else(|| on_cycle.last().copied())
                            .unwrap_or(start);
                        let idx = owner[blame];
                        offender = Some((
                            idx,
                            CHECK_EXTENDS_CYCLE,
                            format!(
                                "contributed datatype `{blame}` participates in an `extends` cycle"
                            ),
                        ));
                        break 'd;
                    }
                    cur = p;
                }
            }
        }

        match offender {
            Some((i, check, reason)) => {
                let (folder, m) = valid.remove(i);
                tracing::error!(package = %folder, check = %check, error = %reason, "processor package skipped (cross-package)");
                skipped.push(skip(&folder, &m, check, reason));
            }
            None => break,
        }
    }
}

// ----------------------------- the boot rejection report -----------------------------

/// The cap on a single rejection's reason text.
///
/// The reason is parser output over an attacker-supplied manifest, so its length is
/// attacker-chosen: a drop-in carrying a multi-megabyte unknown key would otherwise put a
/// multi-megabyte record in the log on EVERY scan, and the S6 watcher re-scans on every
/// write to that folder. Generous enough that no genuine diagnostic is clipped.
const MAX_REASON_CHARS: usize = 2000;

/// The cap on how many refused packages the RENDERED report lists.
///
/// Clipping each reason bounds one row; nothing bounded the number of ROWS. Twenty thousand
/// folders each holding a broken manifest is `mkdir` in a loop, and every one of them then
/// re-renders on every debounced watcher scan — a report of tens of megabytes, built and
/// logged twice at boot and once per rescan, for about two writes a second of attacker
/// effort. The count is always stated in full; only the enumeration is capped, because past
/// the first few dozen the list has stopped being a diagnostic.
const MAX_REPORTED_ROWS: usize = 50;

/// Bound and de-fang one attacker-influenced string on its way into a rejection row.
///
/// TWO problems, and they are both about where the string ENDS UP rather than what it says.
///
/// 1. **Length.** See [`MAX_REASON_CHARS`]. Clipped on a char boundary, and the clip is
///    announced so a reader knows the text is truncated rather than the file being odd.
/// 2. **Control characters.** The row's `id` is a folder name and its `reason` is parser
///    output over a manifest, so both can carry `\n`, `\r` and `ESC`. They are written to a
///    line-oriented log by the default `tracing_subscriber::fmt` formatter, which records a
///    `%`-Display field by printing it RAW — so an earlier note claiming "a field is escaped
///    by the formatters" was simply wrong, and a folder named with an embedded newline plus
///    a plausible timestamp could forge what looks like its own log record. ESC additionally
///    lets it drive a terminal. Both classes are replaced with a visible escape so the text
///    stays diagnosable while occupying exactly one line.
fn sanitize_for_report(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len().min(MAX_REASON_CHARS * 2));
    let mut chars = 0usize;
    let mut clipped = false;
    for c in raw.chars() {
        if chars >= MAX_REASON_CHARS {
            clipped = true;
            break;
        }
        chars += 1;
        match c {
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            // C0 controls, DEL, and the C1 range — ESC (`\u{1b}`) among them.
            c if c.is_control() => out.push_str(&format!("\\u{{{:x}}}", c as u32)),
            c => out.push(c),
        }
    }
    if clipped {
        out.push_str(&format!("… [clipped, {} chars total]", raw.chars().count()));
    }
    out
}

/// One refused package, flattened for the report (#190/#197 ITEM-1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RejectedPackage {
    pub id: String,
    pub origin: PackageOrigin,
    /// The stable check id (`PKG_*`). `"PKG_UNKNOWN"` only if a rejection somehow reached
    /// the report without one — which is itself worth seeing rather than hiding.
    pub check: String,
    /// Absolute path to the offending manifest, for the operator-facing log.
    pub manifest_path: String,
    pub reason: String,
}

/// Everything ONE scan refused, assembled once (#190/#197 ITEM-1/2).
///
/// The whole point is that this is a single aggregated record. A per-package `error!` is
/// already emitted at the moment of refusal and is exactly what scrolls past unread at
/// boot; this is the summary an operator (or a boot failure's stderr) actually reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackageRejectionReport {
    /// Every refusal, id-sorted (inherited from the id-sorted load-status).
    pub rejected: Vec<RejectedPackage>,
    /// How many packages DID load. Carried so the report can never be read as "everything
    /// failed" when one drop-in was refused — and so a reader can see at a glance that the
    /// scan itself did not collapse.
    pub loaded: usize,
    /// True when the operator override (DEC-1) is downgrading the first-party refusal.
    pub override_active: bool,
    /// The scanned folder, for the diagnosis line.
    pub root: String,
}

impl PackageRejectionReport {
    /// Assemble the report from a scanned registry.
    pub fn of(reg: &ExtensionRegistry, root: &Path) -> Self {
        let rejected = reg
            .rejections()
            .into_iter()
            .map(|s| RejectedPackage {
                id: s.id.clone(),
                // A rejection always carries an origin — every skip path in `scan_dir` and
                // `resolve_cross_package` sets one, and
                // `every_rejection_carries_an_origin_and_a_check` fails if a future one
                // does not. This fallback is therefore unreachable; classifying an unknown
                // provenance as dropped-in is the FAIL-SAFE direction (it degrades to the
                // tolerant posture rather than refusing boot on a row we cannot vouch for),
                // but relying on it silently would reintroduce the very defect this exists
                // to fix, which is why the test exists rather than only this comment.
                origin: s.origin.unwrap_or(PackageOrigin::DroppedIn),
                check: s.check.clone().unwrap_or_else(|| "PKG_UNKNOWN".to_string()),
                manifest_path: s
                    .manifest_path
                    .as_ref()
                    .map(|rel| root.join(rel).display().to_string())
                    .unwrap_or_else(|| root.display().to_string()),
                // Already sanitized + clipped at capture (`scan_dir`'s `reject` /
                // `resolve_cross_package`'s `skip`); re-applied here so a row that reached
                // the registry by some other route cannot smuggle an unbounded or
                // control-bearing string into the render. Idempotent on an already-clean
                // string.
                reason: sanitize_for_report(s.error.as_deref().unwrap_or_default()),
            })
            .collect::<Vec<_>>();
        Self {
            rejected,
            loaded: reg.len(),
            override_active: allow_broken_first_party(),
            root: root.display().to_string(),
        }
    }

    /// The refusals that are our OWN artifact's fault (DEC-1).
    pub fn first_party(&self) -> Vec<&RejectedPackage> {
        self.rejected
            .iter()
            .filter(|r| r.origin == PackageOrigin::FirstParty)
            .collect()
    }

    pub fn is_empty(&self) -> bool {
        self.rejected.is_empty()
    }

    /// The human-readable block — one header line plus one indented line per package,
    /// each naming the package, its origin, its check id, its manifest path and the
    /// reason. This is the text an operator sees in the log AND in the boot error.
    pub fn render(&self) -> String {
        let mut out = format!(
            "{} processor package(s) REFUSED at load ({} loaded) under `{}`",
            self.rejected.len(),
            self.loaded,
            self.root,
        );
        // The COUNT is always exact (the header above); only the ENUMERATION is capped.
        // Twenty thousand broken folders is a `mkdir` loop, and the whole block re-renders
        // on every debounced watcher scan — past the first few dozen the list has stopped
        // being a diagnostic and become an amplifier.
        for r in self.rejected.iter().take(MAX_REPORTED_ROWS) {
            out.push_str(&format!(
                "\n  - `{}` [{}] {} — {}\n      manifest: {}",
                r.id,
                r.origin.as_str(),
                r.check,
                r.reason,
                r.manifest_path,
            ));
        }
        if self.rejected.len() > MAX_REPORTED_ROWS {
            out.push_str(&format!(
                "\n  … and {} more refused package(s) not listed (the count above is exact; \
                 the list is capped at {MAX_REPORTED_ROWS} so a folder-spray cannot turn \
                 every rescan into a multi-megabyte log record). Every row is on \
                 `GET /api/processors`.",
                self.rejected.len() - MAX_REPORTED_ROWS,
            ));
        }
        if !self.first_party().is_empty() {
            out.push_str(
                "\n  A FIRST-PARTY package is one this binary shipped: `build.rs` linted it \
                 with the whole-tree validator before it was baked in, so a runtime refusal \
                 means the build gate and the runtime gate disagree about our own artifact. \
                 Fix the manifest (or restore the file if it was edited on disk under \
                 <data_root>/processors/).",
            );
            if self.override_active {
                out.push_str(&format!(
                    "\n  {ALLOW_BROKEN_FIRST_PARTY_ENV} is SET — the refusal is DOWNGRADED to \
                     the drop-in posture and these packages are simply absent. This is an \
                     operator override, not a fix.",
                ));
            }
        }
        out
    }

    /// Emit the aggregated record. `error!` whenever anything was refused — including a
    /// dropped-in-only refusal, which is not fatal but is still something an operator must
    /// be able to see without going to an admin REST route.
    pub fn emit(&self) {
        if self.is_empty() {
            tracing::debug!(
                loaded = self.loaded,
                "processor packages: all loaded, none refused"
            );
            return;
        }
        // The rendered block goes in a STRUCTURED FIELD, not the message position. It
        // embeds `reason`, which for a parse failure is the raw parser error containing the
        // offending key — attacker-influenced text from a dropped-in manifest. YAML permits
        // newlines inside keys, so putting that in the message position of a line-oriented
        // sink lets a drop-in forge additional-looking log records. A field is escaped by
        // the formatters; the message stays a constant.
        tracing::error!(
            refused = self.rejected.len(),
            first_party_refused = self.first_party().len(),
            loaded = self.loaded,
            override_active = self.override_active,
            report = %self.render(),
            "processor packages REFUSED at load"
        );
    }

    /// The posture (DEC-1/DEC-7): a first-party refusal is an `Err` carrying the rendered
    /// report; anything else is `Ok`. The caller decides what `Err` means.
    pub fn into_posture_result(&self) -> Result<(), String> {
        if self.first_party().is_empty() || self.override_active {
            return Ok(());
        }
        Err(self.render())
    }
}

// ------------------------- process-wide swappable singleton -------------------------

/// Hot-swappable registry holder (INV-2 enabler, S2). An `ArcSwapOption` instead of a
/// boot-once `OnceCell` so a rescan (reload endpoint S7 / watcher S6) can atomically
/// re-publish a freshly-folded registry via `set_global_registry` WITHOUT a process
/// restart. `None` before boot; every reader `load_full()`s per use, so it always sees
/// the latest whole snapshot (never a torn read during a swap).
static EXTENSION_REGISTRY: ArcSwapOption<ExtensionRegistry> = ArcSwapOption::const_empty();

/// Publish (or re-publish) the folded registry. Called at boot from
/// `ExtensionsModule::init`, and again on every rescan (S6/S7). Unconditional atomic
/// store — a later call replaces the prior snapshot (no set-once panic).
pub fn set_global_registry(reg: Arc<ExtensionRegistry>) {
    EXTENSION_REGISTRY.store(Some(reg));
}

/// The process-wide registry, if boot built it. `None` before `init`.
pub fn try_registry() -> Option<Arc<ExtensionRegistry>> {
    EXTENSION_REGISTRY.load_full()
}

/// The process-wide registry. Panics if boot never built it — a programming error
/// on any request path (the module always builds it at `init`).
pub fn registry() -> Arc<ExtensionRegistry> {
    EXTENSION_REGISTRY
        .load_full()
        .expect("extension registry not built (ExtensionsModule::init must run at boot)")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::extensions::types::{
        AcceptsEntry, Cardinality, Contributes, ConverterContribution, DatatypeContribution,
        ProducesEntry, RunSpec,
    };

    fn mk_manifest(id: &str, entry: &str) -> ExtensionManifest {
        ExtensionManifest {
            id: id.to_string(),
            name: id.to_string(),
            publisher: "cyto".to_string(),
            version: "0.1.0".to_string(),
            api_version: "1.0".to_string(),
            contributes: Contributes {
                converters: vec![ConverterContribution {
                    id: "conv".to_string(),
                    title: "Conv".to_string(),
                    trigger: "on-ingest".to_string(),
                    params: Some("none".to_string()),
                    env: Some("single-cell".to_string()),
                    accepts: vec![AcceptsEntry {
                        type_id: "single-cell/anndata".to_string(),
                        role: "primary".to_string(),
                        slot: None,
                        axis: None,
                        kind: None,
                        alignment: None,
                    }],
                    produces: vec![ProducesEntry {
                        datatype: "single-cell/expression".to_string(),
                        cardinality: Cardinality::One,
                    }],
                    run: RunSpec {
                        kind: "sandbox".to_string(),
                        runtime: "python".to_string(),
                        entry: entry.to_string(),
                        helpers: vec![],
                        host_resources: vec![],
                        dependencies: vec![],
                    },
                }],
                views: vec![],
                datatypes: vec![],
                analyses: vec![],
                actions: vec![],
                sections: vec![],
            },
        }
    }

    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_SEQ: AtomicU64 = AtomicU64::new(0);

    /// A throwaway data dir under the system temp dir with the REAL embedded seed
    /// extracted into it (via `embedded::reconcile`), so the scan tests exercise
    /// `build_from_dir` over the same folder layout production scans — WITHOUT
    /// mutating `CYTO_APP_DATA_DIR` (parallel-safe; never pollutes the real data dir).
    struct SeedDir(PathBuf);
    impl SeedDir {
        fn new(tag: &str) -> Self {
            let seq = TEST_SEQ.fetch_add(1, Ordering::Relaxed);
            let p = std::env::temp_dir().join(format!(
                "cyto-loader-scan-{tag}-{}-{seq}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&p);
            std::fs::create_dir_all(&p).unwrap();
            embedded::reconcile(&p, &embedded::embedded_seed()).expect("extract seed");
            SeedDir(p)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for SeedDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    // The real seed, extracted to a folder + SCANNED, parses + is non-empty (INV-1:
    // built from the folder, not `include_dir!` bytes).
    #[test]
    fn embedded_tree_builds() {
        let seed = SeedDir::new("build");
        let reg = ExtensionRegistry::build_from_dir(seed.path()).expect("scanned manifests parse");
        assert!(
            !reg.is_empty(),
            "at least the anndata-import extension is scanned"
        );
        let m = reg.get("anndata-import").expect("anndata-import present");
        assert_eq!(m.contributes.converters.len(), 1);
        let conv = &m.contributes.converters[0];
        assert_eq!(conv.run.entry, "compute/h5ad_import.py");
        // ITEM-23: the converter declares its analysis-domain env image.
        assert_eq!(
            conv.env.as_deref(),
            Some("single-cell"),
            "declares the single-cell env image"
        );
        // artifact-model ITEM-27: was 5. The lossless multi-file store was the transpose
        // BUFFER the CSC matrix was streamed back out of, not a fifth product, so replacing
        // the transpose retired that output from the manifest's `produces`. This is
        // the in-source half of the pair R4-CARD-03/R4-CARD-08 pin; the REST-surface half
        // (`tests/extensions/api_test.rs`) moved 5 -> 4 with the manifest and this one did
        // NOT, so the two enforcers of one behaviour were asserting opposite things and
        // this test was FAILING. Kept as an exact cardinality (re-anchored in both
        // certification ledgers) rather than loosened to `>=`: loosening would retire the
        // pin, which is a decision for whoever derives it from the manifest, not a way to
        // go green.
        assert_eq!(conv.produces.len(), 4);
        // `many`/`one` cardinalities parsed.
        assert!(conv
            .produces
            .iter()
            .any(|p| p.cardinality == Cardinality::Many));
        assert!(conv
            .produces
            .iter()
            .any(|p| p.cardinality == Cardinality::One));
        // ITEM-1 (DEC-19/DEC-20-amended): `datatypes` is ACTIVE now — any datatype the
        // baked manifest declares parses into a `DatatypeContribution` (no longer
        // asserted empty). Every contribution converts to a full `Datatype`.
        for d in &m.contributes.datatypes {
            let dt = d.to_datatype();
            assert_eq!(dt.id, d.id, "contribution converts to a full Datatype");
        }
    }

    // A YAML manifest round-trips through serde_norway.
    #[test]
    fn parse_yaml_manifest() {
        let yaml = r#"
id: demo
name: Demo
publisher: cyto
version: 0.0.1
apiVersion: "1.0"
contributes:
  converters:
    - id: c
      title: C
      trigger: on-ingest
      params: none
      accepts:
        - type_id: single-cell/anndata
      produces:
        - datatype: embedding
          cardinality: many
      run:
        kind: sandbox
        runtime: python
        entry: compute/x.py
  views: []
  datatypes: []
"#;
        let m: ExtensionManifest = serde_norway::from_str(yaml).expect("parses");
        assert_eq!(m.id, "demo");
        assert_eq!(m.api_version, "1.0");
        assert_eq!(
            m.contributes.converters[0].produces[0].cardinality,
            Cardinality::Many
        );
    }

    // ITEM-6 back-compat: a BARE `{type_id}` accepts-entry still parses, defaulting
    // role=primary + the supporting facets to None (a legacy manifest is unbroken).
    #[test]
    fn bare_accepts_entry_parses_as_primary() {
        let e: AcceptsEntry =
            serde_norway::from_str("type_id: single-cell/anndata").expect("bare entry parses");
        assert_eq!(e.type_id, "single-cell/anndata");
        assert_eq!(e.role, "primary", "an omitted role defaults to primary");
        assert!(e.slot.is_none() && e.axis.is_none() && e.kind.is_none() && e.alignment.is_none());

        // A SUPPORTING accepts-entry carries the full facet set (role/slot/axis/kind/
        // alignment) and round-trips.
        let yaml = r#"
type_id: annotation-table
role: supporting
slot: cell-annotations
axis: cells
kind: annotation_table
alignment:
  strategy: key_join
  axis: cells
  normalize: [strip_10x_suffix, trim]
"#;
        let s: AcceptsEntry = serde_norway::from_str(yaml).expect("supporting entry parses");
        assert_eq!(s.role, "supporting");
        assert_eq!(s.axis.as_deref(), Some("cells"));
        assert_eq!(s.kind.as_deref(), Some("annotation_table"));
        // The alignment is carried as open JSON; it parses into the typed descriptor.
        let al: crate::modules::datatype::types::Alignment =
            serde_json::from_value(s.alignment.clone().unwrap()).expect("alignment parses typed");
        assert!(matches!(
            al,
            crate::modules::datatype::types::Alignment::KeyJoin { .. }
        ));
    }

    // ITEM-1/2: a manifest `datatypes:` entry parses into a `DatatypeContribution` and
    // converts to a full `Datatype` (host-only fields defaulted, axes carried).
    #[test]
    fn datatype_contribution_parses_and_converts() {
        let yaml = r#"
id: annotation-table
title: Annotation table
description: A keyed table of attribute columns.
storage:
  layout: { kind: columnar_table }
  format: parquet
ingest:
  extensions: [csv, tsv]
  magic: []
capabilities: [tabular]
axes:
  - name: cells
    key_label: barcode
extends: tabular
"#;
        let c: DatatypeContribution = serde_norway::from_str(yaml).expect("contribution parses");
        assert_eq!(c.id, "annotation-table");
        assert_eq!(c.extends.as_deref(), Some("tabular"));
        // to_datatype defaults the host-only fields + Tier-1, carries axes + ingest.
        let dt = c.to_datatype();
        assert_eq!(dt.id, "annotation-table");
        assert_eq!(dt.axes.len(), 1);
        assert_eq!(dt.axes[0].name, "cells");
        assert_eq!(dt.axes[0].key_label, "barcode");
        // INV-5: `to_datatype` carries axis IDENTITY and nothing else — the per-axis column
        // forecast this assertion used to carry (`axes[].annotations`, typed by
        // `AnnotationType`) is deleted, so there is no field left for it to travel through.
        assert_eq!(
            serde_json::to_value(&dt.axes[0]).unwrap(),
            serde_json::json!({ "name": "cells", "key_label": "barcode" }),
        );
        assert_eq!(
            dt.storage.file_layout,
            crate::modules::datatype::types::FileLayout::Single
        );
        assert_eq!(dt.ingest.as_ref().unwrap().extensions, vec!["csv", "tsv"]);
        assert!(!dt.is_abstract);
    }

    // INV-7: a manifest datatype's `arrays[]` (open-axis DATA) parses + travels through
    // `to_datatype()` onto `Datatype.arrays` — a composite kind over a NON-obs/var axis.
    #[test]
    fn datatype_contribution_carries_open_axis_arrays() {
        use crate::modules::datatype::types::{ArrayDim, LayoutKind, SparseOrientation};
        let yaml = r#"
id: graph/attributed
extends: data
title: Attributed graph
storage:
  layout: { kind: chunked_sparse, orientation: csc }
  format: zarr
axes:
  - { name: node, key_label: node_id }
arrays:
  - name: adjacency
    kind: graph
    dims: [{ axis: node }, { axis: node }]
    attrs: [{ name: weight, dtype: f32 }]
    layout: { kind: chunked_sparse, orientation: csc }
"#;
        let c: DatatypeContribution = serde_norway::from_str(yaml).expect("contribution parses");
        let dt = c.to_datatype();
        assert_eq!(dt.arrays.len(), 1, "arrays[] travels onto the Datatype");
        let adj = &dt.arrays[0];
        assert_eq!(adj.name, "adjacency");
        // Both dims bind the SAME non-obs/var axis — the shape SOMA cannot hold.
        assert_eq!(
            adj.dims,
            vec![
                ArrayDim::Axis {
                    axis: "node".into()
                },
                ArrayDim::Axis {
                    axis: "node".into()
                },
            ]
        );
        assert!(matches!(
            adj.layout,
            LayoutKind::ChunkedSparse {
                orientation: SparseOrientation::Csc
            }
        ));
        assert_eq!(adj.attrs[0].name, "weight");
        // A typo'd array field is DENIED at parse (deny_unknown_fields on ArrayDecl).
        let bad = yaml.replace("name: adjacency", "name: adjacency\n    bogus: true");
        assert!(
            serde_norway::from_str::<DatatypeContribution>(&bad).is_err(),
            "typo'd array field denied"
        );
    }

    // INV-5: a converter's output contract is `produces` (WHICH datatype) and nothing more.
    // This replaces `produces_annotations_parses_additive`, which asserted the opposite —
    // that a converter could declare each output COLUMN and its type before any run existed.
    // The forecast is deleted here and hard-failed at the BUILD gate (`processor_manifest.rs`
    // `Converter` is `deny_unknown_fields`, so a manifest still carrying the key names the
    // file + key and fails `cargo build`). This test holds the runtime half of the removal:
    // even reaching this type, the key has no field to become data in.
    #[test]
    fn converter_declares_no_output_column_forecast() {
        let legacy = r#"
id: conv
title: Conv
trigger: on-ingest
accepts: []
produces:
  - { datatype: metadata-column, cardinality: many }
produces_annotations:
  - { name: pct_flagged, type: continuous, axis: rows }
run: { kind: sandbox, runtime: python, entry: compute/x.py }
"#;
        let c: ConverterContribution =
            serde_norway::from_str(legacy).expect("a legacy converter still parses");
        let wire = serde_json::to_value(&c).expect("converter serializes");
        assert!(
            wire.get("produces").is_some(),
            "the converter lost `produces` — the absence check below would be vacuous"
        );
        assert!(
            wire.get("produces_annotations").is_none(),
            "`produces_annotations` came back to the converter contract — a column forecast \
             re-entering through the type (INV-5)"
        );
    }

    // `from_manifests` keeps only the cheap structural id checks (empty id + dup id);
    // the SCHEMA/entry validation moved to `lint_processor_package` at the folder
    // boundary (`build_from_dir`).
    #[test]
    fn from_manifests_rejects_empty_and_duplicate_ids() {
        assert!(
            ExtensionRegistry::from_manifests(vec![{
                let mut m = mk_manifest("x", "compute/h5ad_import.py");
                m.id = "  ".to_string();
                m
            }])
            .is_err(),
            "an empty id is rejected"
        );
        assert!(ExtensionRegistry::from_manifests(vec![
            mk_manifest("dup", "compute/h5ad_import.py"),
            mk_manifest("dup", "compute/import-h5ad.py"),
        ])
        .is_err());
        // Two distinct-id manifests build; `all()` is id-sorted; load-status is all-ok.
        let reg = ExtensionRegistry::from_manifests(vec![
            mk_manifest("b", "compute/import-h5ad.py"),
            mk_manifest("a", "compute/h5ad_import.py"),
        ])
        .unwrap();
        assert_eq!(reg.len(), 2);
        let ids: Vec<&str> = reg.all().iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["a", "b"]);
        assert!(reg.load_status().iter().all(|s| s.ok));
        assert_eq!(reg.load_status().len(), 2);
    }

    // INV-1 / INV-2: build by SCANNING the extracted folder → the extension + datatype
    // set matches the in-tree seed; then ADD a package dir on disk + rescan → present;
    // REMOVE a package dir + rescan → absent. No binary rebuild.
    #[test]
    fn scan_add_and_remove_reflect_without_rebuild() {
        let seed = SeedDir::new("addremove");
        let dir = seed.path();

        // Baseline: the scanned set == the in-tree seed packages (INV-1).
        let reg = ExtensionRegistry::build_from_dir(dir).expect("baseline scan");
        let baseline: std::collections::BTreeSet<String> =
            reg.all().iter().map(|m| m.id.clone()).collect();
        assert!(baseline.contains("anndata-import") && baseline.contains("qc"));
        // The seed contributes its domain datatypes through the scanned manifests.
        let dt_count = reg
            .all()
            .iter()
            .flat_map(|m| m.contributes.datatypes.iter())
            .count();
        assert!(
            dt_count > 0,
            "the seed contributes domain datatypes via the scan"
        );
        assert!(
            reg.get("newly-dropped").is_none(),
            "not present before it's added"
        );

        // ADD a package dir on disk + rescan → PRESENT (INV-2 add-at-scan-time).
        let pkg = dir.join("newly-dropped");
        std::fs::create_dir_all(pkg.join("compute")).unwrap();
        std::fs::write(
            pkg.join("manifest.yaml"),
            "id: newly-dropped\nname: Newly Dropped\npublisher: cyto\nversion: 0.1.0\napiVersion: \"1.0\"\ncontributes: {}\n",
        )
        .unwrap();
        let reg2 = ExtensionRegistry::build_from_dir(dir).expect("rescan after add");
        assert!(
            reg2.get("newly-dropped").is_some(),
            "an added package is present after a rescan"
        );
        assert_eq!(reg2.len(), reg.len() + 1);

        // REMOVE the package dir + rescan → ABSENT (INV-2 remove-at-scan-time).
        std::fs::remove_dir_all(&pkg).unwrap();
        let reg3 = ExtensionRegistry::build_from_dir(dir).expect("rescan after remove");
        assert!(
            reg3.get("newly-dropped").is_none(),
            "a removed package is absent after a rescan"
        );
        assert_eq!(reg3.len(), reg.len());
    }

    // INV-4: a MALFORMED folder package is logged + collected as skipped-with-error and
    // SKIPPED; the scan does NOT abort, so every VALID sibling still registers.
    #[test]
    fn malformed_package_is_skipped_siblings_still_register() {
        let seed = SeedDir::new("malformed");
        let dir = seed.path();
        let ok_before = ExtensionRegistry::build_from_dir(dir)
            .expect("baseline")
            .len();

        // Drop a malformed package — an unknown outer key trips the S1 validator's
        // `deny_unknown_fields`.
        let bad = dir.join("broken-pkg");
        std::fs::create_dir_all(&bad).unwrap();
        std::fs::write(
            bad.join("manifest.yaml"),
            "id: broken-pkg\nname: Broken\npublisher: cyto\nversion: 0.1.0\napiVersion: \"1.0\"\nbogus_unknown_key: true\ncontributes: {}\n",
        )
        .unwrap();

        let reg = ExtensionRegistry::build_from_dir(dir)
            .expect("scan does not abort on a malformed sibling");
        // The malformed package is NOT registered ...
        assert!(
            reg.get("broken-pkg").is_none(),
            "the malformed package is skipped"
        );
        // ... every valid sibling still is (count unchanged) ...
        assert_eq!(reg.len(), ok_before, "valid siblings still register");
        // ... and its per-package error is collected (surfaced to S7/S8).
        let skipped: Vec<&PackageLoadStatus> = reg.load_status().iter().filter(|s| !s.ok).collect();
        assert_eq!(
            skipped.len(),
            1,
            "exactly the one malformed package is skipped"
        );
        assert_eq!(skipped[0].id, "broken-pkg");
        let err = skipped[0].error.as_deref().unwrap_or_default();
        assert!(
            err.contains("broken-pkg"),
            "the error is package-scoped: {err}"
        );
        // A valid seed sibling is present + ok in the load-status.
        assert!(
            reg.get("qc").is_some(),
            "a valid sibling (qc) still registers"
        );
        assert!(reg.load_status().iter().any(|s| s.id == "qc" && s.ok));
    }

    // H1 / INV-4: a CROSS-PACKAGE violation in a drop-in (duplicate extension id,
    // duplicate contributed datatype id, a SECOND lattice root) must SKIP the offending
    // package with a package-scoped error — NEVER abort the whole build (which would fail
    // boot / Err every reflect and take the valid seed down with it). The seed keeps
    // working.
    #[test]
    fn cross_package_violation_skips_offender_seed_survives() {
        let seed = SeedDir::new("crosspkg");
        let dir = seed.path();
        let baseline = ExtensionRegistry::build_from_dir(dir)
            .expect("baseline")
            .len();

        // Helper: write a folder package.
        let write = |name: &str, body: &str| {
            let p = dir.join(name);
            std::fs::create_dir_all(&p).unwrap();
            std::fs::write(p.join("manifest.yaml"), body).unwrap();
        };

        // (1) DUPLICATE EXTENSION ID — a drop-in whose manifest `id` collides with the
        //     seed `qc` extension. Id-sorted scan keeps the seed `qc` (dir "qc" < "zz-dup"),
        //     skips the drop-in — the build does NOT abort.
        write(
            "zz-dup-ext",
            "id: qc\nname: Rogue QC\npublisher: evil\nversion: 9.9.9\napiVersion: \"1.0\"\ncontributes: {}\n",
        );
        // A contributed-datatype manifest body (YAML), parameterized by pkg id + dt id +
        // an optional `extends` (omitted → a second lattice root).
        let dt_manifest = |pkg: &str, dt_id: &str, extends: Option<&str>| {
            let mut m = String::new();
            m.push_str(&format!("id: {pkg}\n"));
            m.push_str(&format!("name: {pkg}\n"));
            m.push_str("publisher: cyto\n");
            m.push_str("version: 0.1.0\n");
            m.push_str("apiVersion: \"1.0\"\n");
            m.push_str("contributes:\n");
            m.push_str("  datatypes:\n");
            m.push_str(&format!("    - id: {dt_id}\n"));
            if let Some(e) = extends {
                m.push_str(&format!("      extends: {e}\n"));
            }
            m.push_str("      title: Rogue\n");
            m.push_str("      storage:\n");
            m.push_str("        layout: { kind: columnar_table }\n");
            m.push_str("        format: parquet\n");
            m
        };
        // (2) SECOND LATTICE ROOT — a contributed datatype with no `extends` (a second root
        //     alongside the core `data` root) — passes per-package lint, aborts `validate()`.
        write(
            "zz-second-root",
            &dt_manifest("zz-second-root", "rogue/root", None),
        );
        // (3) DUPLICATE CONTRIBUTED DATATYPE ID — two drop-ins contributing the SAME new
        //     datatype id (each individually lint-clean); the later is skipped.
        write(
            "aa-dup-dt",
            &dt_manifest("aa-dup-dt", "shared/dup-dt", Some("tabular")),
        );
        write(
            "bb-dup-dt",
            &dt_manifest("bb-dup-dt", "shared/dup-dt", Some("tabular")),
        );

        // The build SUCCEEDS (never aborts) despite the persisted bad drop-ins.
        let reg =
            ExtensionRegistry::build_from_dir(dir).expect("build must not abort on bad drop-ins");

        // The seed `qc` still loads + is ok.
        assert!(
            reg.get("qc").is_some(),
            "the valid seed `qc` still registers"
        );
        assert!(reg.load_status().iter().any(|s| s.id == "qc" && s.ok));
        // Every seed package still registered (count unchanged aside from the ONE valid
        // drop-in that survives the dup-datatype pair — `aa-dup-dt`).
        assert_eq!(
            reg.len(),
            baseline + 1,
            "seed intact + exactly one valid dup-dt drop-in survives"
        );
        // The dup-datatype WINNER (`aa`, id-sorted-first) survives; the loser (`bb`) is skipped.
        assert!(reg.get("aa-dup-dt").is_some());
        assert!(reg.get("bb-dup-dt").is_none());

        // The offenders are each surfaced as skipped-with-error (package-scoped).
        let skipped: std::collections::HashMap<&str, &str> = reg
            .load_status()
            .iter()
            .filter(|s| !s.ok)
            .map(|s| (s.id.as_str(), s.error.as_deref().unwrap_or("")))
            .collect();
        assert!(
            skipped.get("qc").is_none(),
            "the SEED qc is kept, not skipped"
        );
        assert!(skipped["zz-dup-ext"].contains("duplicate extension id"));
        assert!(skipped["zz-second-root"].contains("SECOND lattice root"));
        assert!(skipped["bb-dup-dt"].contains("duplicate contributed datatype id"));

        // And the whole datatype registry still builds from the SAME (cross-resolved) folder
        // — no abort — proving the seed lattice is intact for the datatype boot path too.
        let extra = crate::modules::extensions::contributed_datatypes_from_embedded_in(dir)
            .expect("datatype extras resolve from the cross-resolved folder");
        assert!(
            extra.iter().any(|d| d.id == "shared/dup-dt"),
            "the surviving dup-dt datatype is present"
        );
        assert!(
            !extra.iter().any(|d| d.id == "rogue/root"),
            "the second-root datatype is absent"
        );
    }

    // M8 / §16: the SEED-ONLY kill-switch restricts the scan to baked-seed packages —
    // an unmanaged drop-in is IGNORED (not discovered, not loaded), so an operator can
    // defend against a malicious drop-in. (Tested via the injected filter — no env race.)
    #[test]
    fn seed_only_ignores_unmanaged_dropins() {
        let seed = SeedDir::new("seedonly");
        let dir = seed.path();
        let managed = embedded::seed_managed_ids();

        // Drop an UNMANAGED package (a fresh separate-repo id, not in the seed).
        let pkg = dir.join("dropped-external");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(
            pkg.join("manifest.yaml"),
            "id: dropped-external\nname: Dropped\npublisher: x\nversion: 0.1.0\napiVersion: \"1.0\"\ncontributes: {}\n",
        )
        .unwrap();

        // Default (discover-all): the drop-in IS present.
        let all = ExtensionRegistry::scan_dir(dir, None).expect("scan all");
        assert!(
            all.get("dropped-external").is_some(),
            "discover-all sees the drop-in"
        );

        // SEED-ONLY: the drop-in is ABSENT; every seed package still loads.
        let seeded = ExtensionRegistry::scan_dir(dir, Some(&managed)).expect("scan seed-only");
        assert!(
            seeded.get("dropped-external").is_none(),
            "seed-only ignores the unmanaged drop-in"
        );
        assert!(
            seeded.get("qc").is_some(),
            "a baked-seed package still loads in seed-only"
        );
        assert!(
            seeded.load_status().iter().all(|s| managed.contains(&s.id)),
            "seed-only load-status lists only managed packages"
        );
    }

    // S2 / INV-2: the process-wide holder is HOT-SWAPPABLE. Publishing registry A then
    // re-publishing registry B (a rescan) atomically replaces the snapshot WITHOUT a
    // restart — `registry()` returns B's content after the second `set_global_registry`.
    // This is the mechanism a reload endpoint (S7) / watcher (S6) rests on. No other
    // unit test touches this global, so exercising it here is isolation-safe.
    #[test]
    fn set_global_registry_republishes_without_restart() {
        // Registry A — one extension.
        let reg_a = Arc::new(
            ExtensionRegistry::from_manifests(vec![mk_manifest("a", "compute/h5ad_import.py")])
                .expect("A builds"),
        );
        set_global_registry(reg_a);
        let loaded_a = registry();
        assert_eq!(loaded_a.len(), 1);
        assert!(loaded_a.get("a").is_some());
        assert!(loaded_a.get("b").is_none());

        // Registry B — two extensions. A rescan re-publishes it.
        let reg_b = Arc::new(
            ExtensionRegistry::from_manifests(vec![
                mk_manifest("a", "compute/h5ad_import.py"),
                mk_manifest("b", "compute/import-h5ad.py"),
            ])
            .expect("B builds"),
        );
        set_global_registry(reg_b);

        // A fresh `registry()` load now sees B's content — republish took effect
        // in-process, no restart.
        let loaded_b = registry();
        assert_eq!(loaded_b.len(), 2, "republish swapped in the new snapshot");
        assert!(loaded_b.get("a").is_some() && loaded_b.get("b").is_some());
        assert!(try_registry().is_some());
    }

    // ══════════════ #190 / #197 — a package that cannot load fails LOUDLY ══════════════
    //
    // The defect these pin, measured on this tree before the fix: a probe package
    // contributing `probe/thing extends <a type another package owns>` registered NOTHING
    // — 14 packages, 20 contributed datatypes, 26 with the roots — while the same package
    // extending a core root gave 15 / 21 / 27. `cargo check` and every gate stayed green
    // either way. The rejection existed, but only as a `tracing::error!` that scrolls past
    // and an `ok:false` row behind an admin route.
    //
    // Every test below carries a POSITIVE CONTROL. "The bad package is absent" and "the
    // report has a row" are both satisfied by a scan that loaded NOTHING, so each test also
    // asserts that the known-good packages in the SAME scan loaded and registered.

    /// A minimal, otherwise-VALID manifest contributing exactly one datatype.
    ///
    /// Built as text rather than through `ExtensionManifest` on purpose: the path under
    /// test starts at the bytes on disk, and serializing the runtime type would skip the
    /// lint that reads them.
    fn datatype_pkg_yaml(pkg: &str, dt: &str, extends: &str) -> String {
        format!(
            "id: {pkg}\nname: Probe\npublisher: cyto\nversion: 0.1.0\napiVersion: \"1.0\"\n\
             contributes:\n  datatypes:\n    - id: {dt}\n      title: Probe Thing\n      \
             extends: {extends}\n      is_abstract: false\n      axes:\n        - name: cells\n          \
             key_label: barcode\n      entity_axis: cells\n      storage:\n        layout:\n          \
             kind: chunked_dense\n        format: zarr\n        file_layout: single\n"
        )
    }

    /// A minimal, otherwise-VALID manifest contributing one analysis that declares `env`.
    fn env_pkg_yaml(pkg: &str, env: &str) -> String {
        format!(
            "id: {pkg}\nname: Env Probe\npublisher: cyto\nversion: 0.1.0\napiVersion: \"1.0\"\n\
             contributes:\n  analyses:\n    - id: {pkg}.run\n      category: demo\n      \
             title: Probe analysis\n      env: {env}\n      appliesTo: []\n      produces: [tabular]\n      \
             run: {{ kind: sandbox, runtime: python, entry: compute/demo.py }}\n"
        )
    }

    /// A manifest that is valid YAML and names the right package, but carries an outer key
    /// the `deny_unknown_fields` schema refuses — the shape a bad hand-edit actually takes.
    fn broken_manifest(id: &str) -> String {
        format!(
            "id: {id}\nname: Broken\npublisher: cyto\nversion: 0.1.0\napiVersion: \"1.0\"\n\
             bogus_unknown_key: true\ncontributes: {{}}\n"
        )
    }

    /// Write a package folder into a scanned root.
    fn write_pkg(root: &Path, folder: &str, yaml: &str) {
        let d = root.join(folder);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("manifest.yaml"), yaml).unwrap();
    }

    /// Stage the ONE state a healthy tree cannot reach: a package this binary SHIPPED,
    /// still carrying the bytes it shipped, that fails the RUNTIME lint.
    ///
    /// That state IS #190/#197 — the whole-tree validator `build.rs` runs and the
    /// per-package validator the runtime runs disagreeing about our own artifact — so it
    /// cannot be produced by editing a file: editing is exactly what makes the bytes no
    /// longer ours (TEST-8), and the runtime lint reads nothing but the manifest, so no
    /// other on-disk change can trip it while the manifest stays ours.
    ///
    /// So the simulation is placed on the one input the state depends on: what the binary
    /// believes it embedded. `bad` is written to the folder AND declared as the embedded
    /// bytes, so the package classifies first-party through the REAL
    /// `PackageOrigin::of_bytes`, on the REAL scan, and the refusal travels the real
    /// `build_from_dir_checked` path. Nothing is forced after the fact.
    ///
    /// Returns a guard that clears the thread-local override, so the simulation cannot
    /// outlive the test even on a panic.
    #[must_use]
    fn pretend_we_shipped(dir: &Path, folder: &str, bad: &str) -> ShippedOverride {
        write_pkg(dir, folder, bad);
        embedded::test_seam::force_embedded_manifest(folder, bad.as_bytes());
        ShippedOverride
    }

    struct ShippedOverride;
    impl Drop for ShippedOverride {
        fn drop(&mut self) {
            embedded::test_seam::clear_forced_embedded_manifests();
        }
    }

    /// Find one package's row in the load-status.
    fn row<'a>(reg: &'a ExtensionRegistry, id: &str) -> &'a PackageLoadStatus {
        reg.load_status()
            .iter()
            .find(|s| s.id == id)
            .unwrap_or_else(|| {
                panic!(
                    "no load-status row for `{id}`; rows: {:?}",
                    reg.load_status().iter().map(|s| &s.id).collect::<Vec<_>>()
                )
            })
    }

    /// A SEED package that is safe to break: id-sorted-first among those contributing NO
    /// datatype, so breaking it cannot cascade into a sibling's `extends`.
    ///
    /// DERIVED from the scan, never typed in. A written-down package id decays the moment
    /// the package tree changes (it did, mid-branch), and the app may carry ZERO domain
    /// vocabulary.
    fn a_breakable_seed_pkg(reg: &ExtensionRegistry) -> String {
        let mut ids: Vec<&str> = reg
            .all()
            .iter()
            .filter(|m| m.contributes.datatypes.is_empty())
            .map(|m| m.id.as_str())
            .filter(|id| embedded::seed_managed_id_set().contains(*id))
            .collect();
        ids.sort();
        ids.first()
            .unwrap_or_else(|| panic!("the seed has no leaf package to break"))
            .to_string()
    }

    /// A datatype contributed by a package OTHER than `not_this` — the parent a probe must
    /// name to reproduce the CROSS-package `extends` case.
    fn a_cross_package_supertype(reg: &ExtensionRegistry, not_this: &str) -> String {
        let mut candidates: Vec<&str> = reg
            .all()
            .iter()
            .filter(|m| m.id != not_this)
            .flat_map(|m| m.contributes.datatypes.iter().map(|d| d.id.as_str()))
            .collect();
        candidates.sort();
        candidates
            .first()
            .unwrap_or_else(|| panic!("the seed contributes no datatype to extend"))
            .to_string()
    }

    /// A core ROOT datatype id — read from the Rust lattice, not typed in.
    fn a_root_datatype() -> String {
        let mut ids: Vec<&str> = crate::modules::datatype::registry::DATATYPES
            .iter()
            .map(|e| e.id)
            .collect();
        ids.sort();
        ids.first().expect("the core lattice has roots").to_string()
    }

    /// POSITIVE CONTROL: every OTHER package in this scan that is still classified
    /// first-party must have loaded — discovered from the scan, never listed.
    ///
    /// Asserting the WHOLE set rather than one hand-picked id is what makes this an
    /// anti-vacuity floor: "the bad package was refused" is equally true of a scan that
    /// dropped everything, and a package landing on main tomorrow is covered with no edit
    /// (which is how the package that landed on main mid-branch became a live control the
    /// day it merged — see `the_real_shipped_seed_loads_with_zero_rejections`, whose
    /// embedded-vs-loaded set difference names any such package BY ID).
    fn assert_control_loaded(reg: &ExtensionRegistry, excluding: &str) {
        let others: Vec<&PackageLoadStatus> = reg
            .load_status()
            .iter()
            .filter(|s| s.id != excluding && s.origin == Some(PackageOrigin::FirstParty))
            .collect();
        assert!(
            !others.is_empty(),
            "POSITIVE CONTROL: no OTHER first-party package was even scanned — this test \
             would otherwise pass on a scan that saw nothing. rows: {:?}",
            reg.load_status()
        );
        let broken: Vec<(&str, Option<&str>)> = others
            .iter()
            .filter(|s| !s.ok)
            .map(|s| (s.id.as_str(), s.check.as_deref()))
            .collect();
        assert!(
            broken.is_empty(),
            "POSITIVE CONTROL: every OTHER first-party package must still load; these did \
             not: {broken:?}"
        );
        for s in &others {
            assert!(
                reg.get(&s.id).is_some(),
                "POSITIVE CONTROL: `{}` reports ok, so it must be IN the registry — an ok \
                 row for a package the registry does not hold is the silent-skip bug \
                 wearing a green badge",
                s.id
            );
        }
    }

    // ─────────────────── the ORIGIN classification (the posture's axis) ───────────────────

    /// **TEST-8** [covers: ITEM-3, ITEM-5] — origin is decided by the BYTES, not the name.
    ///
    /// This is the anti-DoS property, and it is the one an earlier draft got wrong. The
    /// processors folder is writable at runtime (D2 runtime drop-in discovery requires it)
    /// reconcile is deliberately no-clobber for CONTENT, so a seed-NAMED folder can hold
    /// anyone's bytes and survive every restart. Classifying that as "our own artifact"
    /// would let a single file write earn a permanent boot refusal.
    #[test]
    fn origin_is_derived_from_the_embedded_bytes_not_the_folder_name() {
        let seed = SeedDir::new("origin");
        let dir = seed.path();
        let victim =
            a_breakable_seed_pkg(&ExtensionRegistry::build_from_dir(dir).expect("baseline"));

        // (1) a pristine seed package: the bytes we shipped ⇒ FIRST-PARTY.
        assert_eq!(
            PackageOrigin::of_dir(&victim, &dir.join(&victim)),
            PackageOrigin::FirstParty,
            "an unmodified seed package is first-party — otherwise the refusal branch is \
             dead code and every test below is vacuous"
        );

        // (2) the SAME folder after ONE byte changes ⇒ DROPPED-IN. A hand-edit, a partial
        //     write, or an attacker's overwrite all land here, and all get the tolerant
        //     posture rather than bricking the server.
        let manifest = dir.join(&victim).join("manifest.yaml");
        let original = std::fs::read(&manifest).unwrap();
        let mut tampered = original.clone();
        tampered.extend_from_slice(b"\n# one appended byte\n");
        std::fs::write(&manifest, &tampered).unwrap();
        assert_eq!(
            PackageOrigin::of_dir(&victim, &dir.join(&victim)),
            PackageOrigin::DroppedIn,
            "a seed-NAMED folder whose manifest is no longer the embedded bytes must NOT \
             be trusted as ours: one write under <data_root>/processors/ would otherwise \
             be a permanent, restart-surviving boot refusal"
        );
        std::fs::write(&manifest, &original).unwrap();
        assert_eq!(
            PackageOrigin::of_dir(&victim, &dir.join(&victim)),
            PackageOrigin::FirstParty,
            "restoring the bytes restores the classification (the check reads disk, not a \
             remembered verdict)"
        );

        // (3) an ordinary drop-in ⇒ DROPPED-IN.
        write_pkg(dir, "zzz-probe", &datatype_pkg_yaml("zzz-probe", "probe/t", &a_root_datatype()));
        assert_eq!(
            PackageOrigin::of_dir("zzz-probe", &dir.join("zzz-probe")),
            PackageOrigin::DroppedIn
        );

        // (4) a seed NAME whose folder is a symlink to an attacker-controlled tree ⇒
        //     DROPPED-IN, because the bytes behind the link are not the embedded ones.
        #[cfg(unix)]
        {
            let elsewhere = dir.join("zzz-elsewhere");
            std::fs::create_dir_all(&elsewhere).unwrap();
            std::fs::write(elsewhere.join("manifest.yaml"), broken_manifest(&victim)).unwrap();
            let link = dir.join("zzz-linked");
            let _ = std::fs::remove_file(&link);
            std::os::unix::fs::symlink(&elsewhere, &link).unwrap();
            // Classified under the SEED's name but resolving to foreign bytes.
            assert_eq!(
                PackageOrigin::of_dir(&victim, &link),
                PackageOrigin::DroppedIn,
                "a seed name pointing at foreign bytes is not first-party"
            );
        }

        // (5) a name that is not a single plain path component can never reach into the
        //     embedded tree, however it is spelled. Asserted against
        //     `embedded_manifest_bytes` DIRECTLY, because asserting it through `of_dir` over
        //     a directory that holds no `manifest.yaml` is a tautology: the read fails for
        //     every input, so `DroppedIn` comes back whether or not the sanitizer exists.
        //     The first draft did exactly that and covered nothing.
        for spoof in ["../etc", "zzz-probe/..", ".hidden", "", "a/b", "a\\b", ".."] {
            assert!(
                embedded::embedded_manifest_bytes(spoof).is_none(),
                "{spoof:?} must never resolve inside the embedded tree"
            );
            assert_eq!(
                PackageOrigin::of_bytes(spoof, b"anything"),
                PackageOrigin::DroppedIn,
                "{spoof:?} must not classify as first-party"
            );
        }
        // …and the sanitizer is not simply rejecting everything: the real victim's id, which
        // IS a plain component, still resolves. Without this the loop above passes against a
        // function hardwired to `None`.
        assert!(
            embedded::embedded_manifest_bytes(&victim).is_some(),
            "NON-VACUITY: a legitimate seed id must still resolve"
        );
    }

    /// **TEST-9** [covers: ITEM-3] — the wire spelling of `origin` has ONE source.
    ///
    /// `as_str()` feeds the operator log and the refusal text; serde feeds the JSON rows and
    /// the OpenAPI enum. Two hand-written spellings of one value silently desync.
    #[test]
    fn the_origin_wire_spelling_agrees_with_its_serialization() {
        let variants = [PackageOrigin::FirstParty, PackageOrigin::DroppedIn];
        for o in variants {
            let json = serde_json::to_value(o).expect("origin serializes");
            assert_eq!(
                json.as_str(),
                Some(o.as_str()),
                "`as_str()` and the serde spelling must agree for {o:?}"
            );
        }
        // …and the list above is COMPLETE. A third variant would reach the OpenAPI enum and
        // the operator log while silently skipping the agreement check — the exact desync
        // this test exists to prevent, for the one value nobody remembered to add. The
        // expectation comes out of the schema the enum itself generates, so adding a variant
        // fails HERE rather than shipping an unchecked spelling.
        let schema = serde_json::to_value(schemars::schema_for!(PackageOrigin))
            .expect("origin schema serializes");
        let declared = schema
            .get("oneOf")
            .and_then(|v| v.as_array())
            .map(|a| a.len())
            .unwrap_or_else(|| panic!("PackageOrigin's schema is a oneOf: {schema}"));
        assert_eq!(
            declared,
            variants.len(),
            "the schema declares {declared} origin variant(s) but this test checks {} — a \
             variant added to `PackageOrigin` must be added here too, or its `as_str()` \
             spelling never meets its serde spelling",
            variants.len()
        );
    }

    // ─────────────────────────── the report and the posture ───────────────────────────

    /// **TEST-1** [acceptance] [invariant: INV-1] [covers: ITEM-1, ITEM-2, ITEM-3] —
    /// a package that cannot load produces a NAMED, CODED, path-bearing report row and one
    /// aggregated record; and a FIRST-PARTY rejection REFUSES THE LOAD, through the very
    /// function boot and every reflect call.
    ///
    /// The first-party half is SIMULATED, not injected after the fact, and the difference is
    /// the whole point. An earlier draft mutated a built registry's classification and then
    /// called `apply_load_posture` directly — which proves the posture function and leaves
    /// the edge that matters unasserted: a blind audit confirmed that disconnecting the
    /// posture from `build_from_dir_checked` left the entire suite green, which is
    /// structurally the same "the mechanism exists but nothing calls it" defect this branch
    /// exists to fix. Here the simulation is on the binary's belief about what it embedded
    /// (`pretend_we_shipped`), so the package classifies first-party through the real
    /// `PackageOrigin::of_bytes` on the real scan, and the `Err` comes out of the real
    /// checked entry point.
    #[test]
    fn a_package_that_cannot_load_is_named_coded_and_refuses_when_it_is_ours() {
        let seed = SeedDir::new("fp-refusal");
        let dir = seed.path();
        let victim =
            a_breakable_seed_pkg(&ExtensionRegistry::build_from_dir(dir).expect("baseline scan"));

        // ── (A) the EDITED seed manifest: loud, coded, path-bearing — and TOLERATED. ──
        write_pkg(dir, &victim, &broken_manifest(&victim));
        let reg = ExtensionRegistry::build_from_dir(dir).expect("the scan itself stays tolerant");
        assert_control_loaded(&reg, &victim);

        let st = row(&reg, &victim);
        assert!(!st.ok, "the broken package is refused");
        assert_eq!(
            st.check.as_deref(),
            Some("PKG_MALFORMED_MANIFEST"),
            "the refusal carries its STABLE check id, not only prose: {:?}",
            st.error
        );
        assert_eq!(
            st.manifest_path.as_deref(),
            Some(format!("{victim}/manifest.yaml").as_str()),
            "the row names the manifest, relative to the scanned root"
        );
        assert_eq!(
            st.origin,
            Some(PackageOrigin::DroppedIn),
            "an EDITED seed manifest is no longer our bytes, so it takes the tolerant \
             posture (TEST-8)"
        );
        ExtensionRegistry::build_from_dir_checked(dir)
            .expect("a DROPPED-IN refusal must not refuse the load (INV-2)");

        // ── (B) the same breakage in a package we SHIPPED: the load is REFUSED. ──
        let _shipped = pretend_we_shipped(dir, &victim, &broken_manifest(&victim));
        let reg = ExtensionRegistry::build_from_dir(dir).expect("the scan itself stays tolerant");
        assert_control_loaded(&reg, &victim);
        assert_eq!(
            row(&reg, &victim).origin,
            Some(PackageOrigin::FirstParty),
            "the simulation must actually classify first-party through the REAL scan — if \
             it does not, everything below is asserting a property of a drop-in"
        );

        // THE EDGE THAT MATTERS: the refusal comes out of the entry point boot and every
        // reflect call, not out of a posture function a test reached around it for.
        let err = ExtensionRegistry::build_from_dir_checked(dir).err().unwrap_or_else(|| {
            panic!(
                "`{victim}` is a FIRST-PARTY package that CANNOT LOAD, and \
                 `build_from_dir_checked` — the ONE function `ExtensionsModule::init`, the \
                 order-17 datatype boot and every `reflect_processors` call go through — \
                 returned Ok anyway. That is the #190/#197 defect verbatim: the package \
                 registers nothing, every gate stays green, and the missing analysis is \
                 discovered by a user weeks later"
            )
        });
        assert!(
            err.contains(&format!("`{victim}`"))
                && err.contains("PKG_MALFORMED_MANIFEST")
                && err.contains("first-party"),
            "the refusal error carries the whole report so it reaches stderr at boot: {err}"
        );
        // …and the UNCHECKED scan stays tolerant, so the posture lives at the publish site
        // rather than in the scan (INV-2's mechanism, and what keeps `build_from_dir`'s
        // pre-existing contract intact).
        ExtensionRegistry::build_from_dir(dir).expect("the raw scan never refuses");

        let report = PackageRejectionReport::of(&reg, dir);
        assert_eq!(report.rejected.len(), 1, "exactly the one package is refused");
        assert!(
            report.loaded >= 10,
            "the report records how many DID load ({}) — a report that cannot tell 'one \
             package failed' from 'the scan collapsed' is the bug, not the fix",
            report.loaded
        );
        let r = &report.rejected[0];
        assert_eq!(r.id, victim);
        assert_eq!(r.origin, PackageOrigin::FirstParty);
        assert_eq!(r.check, "PKG_MALFORMED_MANIFEST");
        let abs = dir.join(format!("{victim}/manifest.yaml")).display().to_string();
        assert_eq!(r.manifest_path, abs);

        // ONE aggregated record naming everything, not one line per package to reassemble.
        let rendered = report.render();
        for needle in [
            "REFUSED at load",
            &format!("`{victim}`"),
            "[first-party]",
            "PKG_MALFORMED_MANIFEST",
            "bogus_unknown_key",
        ] {
            assert!(rendered.contains(needle), "report must name {needle}: {rendered}");
        }
        assert!(
            rendered.contains(&abs),
            "the operator-facing render carries the ABSOLUTE manifest path: {rendered}"
        );

    }

    /// **TEST-14** [acceptance] [invariant: INV-1] [covers: ITEM-1, ITEM-5] — a package this
    /// binary SHIPPED that the scan never sees at all is still NAMED.
    ///
    /// Every other rejection is raised from inside a folder the walk reached. A folder that
    /// is GONE — or whose `manifest.yaml` was deleted — raised nothing: the loop `continue`d
    /// before the candidate count, no load-status row existed, `candidates_seen` stayed
    /// non-zero so the anti-vacuity floor did not fire, the posture saw zero rejections, and
    /// BOTH registries were swapped with that package's analyses simply gone while every row
    /// on `GET /api/processors` read `ok`. That is #190/#197 verbatim, for a package we
    /// shipped, on the branch that claims to fix it.
    ///
    /// It is reachable after boot, not hypothetical: `ensure_extracted` is `OnceCell`-guarded,
    /// so the repair that would restore the file runs once per process and never again, while
    /// the S6 watcher happily reflects the deletion.
    #[test]
    fn a_shipped_package_that_is_missing_from_disk_is_named_not_silently_gone() {
        let seed = SeedDir::new("absent");
        let dir = seed.path();
        let base = ExtensionRegistry::build_from_dir(dir).expect("baseline");
        let victim = a_breakable_seed_pkg(&base);
        assert!(
            base.get(&victim).is_some(),
            "PRECONDITION: `{victim}` loads before it is deleted, else this test is vacuous"
        );

        // The reachable production sequence: the manifest is deleted after boot.
        std::fs::remove_file(dir.join(&victim).join("manifest.yaml")).expect("delete manifest");

        let reg = ExtensionRegistry::build_from_dir(dir).expect("the scan stays tolerant");
        assert!(reg.get(&victim).is_none(), "PRECONDITION: it really is gone");
        assert_control_loaded(&reg, &victim);

        let st = row(&reg, &victim);
        assert!(!st.ok, "a SHIPPED package that is absent is a rejection, not a non-event");
        assert_eq!(
            st.check.as_deref(),
            Some("PKG_SEED_PACKAGE_ABSENT"),
            "…with its own stable check id, distinct from every in-folder failure: {:?}",
            st.error
        );
        assert_eq!(
            st.manifest_path.as_deref(),
            Some(format!("{victim}/manifest.yaml").as_str()),
            "…naming the file an operator has to restore"
        );
        let err = st.error.as_deref().unwrap_or_default();
        assert!(
            err.contains(&victim) && err.contains("restart"),
            "…and saying it does not self-heal until the next restart (the extraction \
             repair is OnceCell-guarded): {err}"
        );

        // LOUD, not fatal (DEC-11). Deleting a folder is exactly as attacker-reachable as
        // overwriting one, so refusing boot over it would reintroduce the denial of service
        // the origin-by-bytes rule exists to prevent.
        let checked = ExtensionRegistry::build_from_dir_checked(dir)
            .expect("a MISSING shipped package must not refuse the load — deleting a file \
                     under <data_root>/processors/ would otherwise brick the server");
        let rendered = PackageRejectionReport::of(&checked, dir).render();
        assert!(
            rendered.contains(&victim) && rendered.contains("PKG_SEED_PACKAGE_ABSENT"),
            "…and it is in the aggregated report, so it cannot be silent: {rendered}"
        );

        // The expectation is DERIVED: renaming the folder to a RESERVED (`_`-prefixed) name
        // — which the scan skips before counting candidates — is the same disappearance and
        // is named the same way, with no second rule to keep in sync.
        let seed2 = SeedDir::new("absent-renamed");
        let dir2 = seed2.path();
        std::fs::rename(dir2.join(&victim), dir2.join(format!("_{victim}"))).expect("rename");
        let reg2 = ExtensionRegistry::build_from_dir(dir2).expect("scan");
        assert_eq!(
            row(&reg2, &victim).check.as_deref(),
            Some("PKG_SEED_PACKAGE_ABSENT"),
            "a shipped package hidden behind the reserved-name rule is reported by the SAME \
             derived check: {:?}",
            reg2.rejections()
        );
    }

    /// **TEST-15** [acceptance] [invariant: INV-2] [covers: ITEM-5] — a drop-in declaring a
    /// BLANK `id` is a per-package skip, not a permanent brick.
    ///
    /// `from_manifests` refuses an empty id for the WHOLE set and the per-package lint never
    /// checked it, so one folder carrying `id: ""` made `scan_dir` return `Err` — failing
    /// boot AND every reflect, for good: a drop-in folder is invisible to the seed reconcile,
    /// so it survives every restart. One attacker-writable file was a permanent denial of
    /// service through a door DEC-10's four cross-package sites did not cover.
    #[test]
    fn a_blank_extension_id_in_a_drop_in_cannot_brick_the_whole_scan() {
        let seed = SeedDir::new("blankid");
        let dir = seed.path();
        for (folder, id) in [("zzz-blank", "\"\""), ("zzz-spaces", "\"   \"")] {
            write_pkg(
                dir,
                folder,
                &format!(
                    "id: {id}\nname: Blank\npublisher: evil\nversion: 0.1.0\n\
                     apiVersion: \"1.0\"\ncontributes: {{}}\n"
                ),
            );
        }

        let reg = ExtensionRegistry::build_from_dir(dir).unwrap_or_else(|e| {
            panic!(
                "one drop-in with a blank `id` must NOT abort the whole scan — that is a \
                 permanent, restart-surviving boot failure from a single file anyone can \
                 write under <data_root>/processors/. Got: {e}"
            )
        });
        assert_control_loaded(&reg, "");
        for folder in ["zzz-blank", "zzz-spaces"] {
            let st = row(&reg, folder);
            assert!(!st.ok, "`{folder}` is refused");
            assert_eq!(
                st.check.as_deref(),
                Some("PKG_EMPTY_EXTENSION_ID"),
                "…by its own coded check, at the FOLDER boundary: {:?}",
                st.error
            );
            assert_eq!(st.origin, Some(PackageOrigin::DroppedIn));
        }
        ExtensionRegistry::build_from_dir_checked(dir)
            .expect("…and the load still succeeds (INV-2)");
    }

    /// **TEST-16** [acceptance] [invariant: INV-2] [covers: ITEM-5] — protection from an id
    /// squat survives a ONE-BYTE edit to the shipped package.
    ///
    /// DEC-10 keyed victim selection on `PackageOrigin::FirstParty`, i.e. on byte-identity —
    /// and byte-identity is something the ATTACKER can break on OUR package. Appending a
    /// newline to a shipped manifest leaves it valid YAML, still loading, and no longer
    /// byte-identical; the reconcile compares recorded-vs-embedded digests and never reads
    /// disk content, so the edit survives every restart. That demoted the shipped package to
    /// `dropped-in`, collapsing victim selection back to plain id order — and a folder named
    /// `aaa-…` declaring its extension id then evicted it and took over its id, persistently.
    ///
    /// Protection therefore keys on the seed-managed NAME, which no file write can change.
    #[test]
    fn a_one_byte_edit_cannot_strip_a_shipped_package_of_its_squat_protection() {
        let seed = SeedDir::new("bytestrip");
        let dir = seed.path();
        let base = ExtensionRegistry::build_from_dir(dir).expect("baseline");
        let target = a_breakable_seed_pkg(&base);

        // Step 1 of the attack: one appended byte. Still valid, still loads, no longer ours.
        let manifest = dir.join(&target).join("manifest.yaml");
        let mut bytes = std::fs::read(&manifest).expect("read shipped manifest");
        bytes.extend_from_slice(b"\n# stripped\n");
        std::fs::write(&manifest, &bytes).expect("append one byte");
        let stripped = ExtensionRegistry::build_from_dir(dir).expect("scan");
        assert_eq!(
            row(&stripped, &target).origin,
            Some(PackageOrigin::DroppedIn),
            "PRECONDITION: the edit really does strip the byte-identity — without that this \
             test proves nothing about the attack it is named for"
        );
        assert!(row(&stripped, &target).ok, "…and the package still LOADS after the edit");

        // Step 2: a folder sorting before every seed package, claiming its extension id.
        write_pkg(
            dir,
            "aaa-squatter",
            &format!(
                "id: {target}\nname: Squatter\npublisher: evil\nversion: 9.9.9\n\
                 apiVersion: \"1.0\"\ncontributes: {{}}\n"
            ),
        );

        let reg = ExtensionRegistry::build_from_dir(dir).expect("scan");
        let kept = row(&reg, &target);
        assert!(
            kept.ok && kept.version.as_deref() != Some("9.9.9"),
            "the SHIPPED package `{target}` must keep its id even after its bytes were \
             edited: protection has to key on the seed-managed NAME, which no file write \
             can change, not on a byte-equality the attacker can break at will. It now \
             reads {kept:?}"
        );
        let evicted = row(&reg, "aaa-squatter");
        assert!(!evicted.ok, "the SQUATTER is the one skipped: {evicted:?}");
        assert_eq!(evicted.check.as_deref(), Some("PKG_DUPLICATE_EXTENSION_ID"));
        ExtensionRegistry::build_from_dir_checked(dir)
            .expect("and no refusal was manufactured by the drop-in");
    }

    /// **TEST-17** [covers: ITEM-1, ITEM-2] — an attacker-chosen string cannot forge a log
    /// record, drive a terminal, or grow without bound.
    ///
    /// The row's `id` is a folder NAME and its `reason` is parser output over a manifest, and
    /// both reach a line-oriented log, the boot refusal text and `GET /api/processors`. The
    /// default `tracing_subscriber::fmt` formatter prints a `%`-Display field RAW, so an
    /// earlier note claiming "a field is escaped by the formatters" was simply false.
    #[test]
    fn an_attacker_chosen_string_is_bounded_and_de_fanged_before_it_is_reported() {
        // Control characters become visible escapes; the text stays diagnosable.
        let forged = "x\n2026-09-03T00:00:00Z  INFO cytoanalyst: all loaded, none refused";
        let clean = sanitize_for_report(forged);
        assert!(
            !clean.contains('\n') && clean.contains("\\n"),
            "a newline must not survive into a line-oriented sink, or a folder name can \
             forge what looks like its own log record: {clean:?}"
        );
        assert!(
            clean.contains("INFO cytoanalyst"),
            "…while the text itself is preserved, so it stays diagnosable: {clean:?}"
        );
        for c in ['\u{1b}', '\r', '\u{7}', '\u{0}'] {
            let out = sanitize_for_report(&format!("a{c}b"));
            assert!(
                !out.chars().any(char::is_control),
                "{c:?} must not survive: {out:?}"
            );
        }

        // Length is attacker-chosen and the watcher re-scans on every write.
        let huge = "k".repeat(MAX_REASON_CHARS * 4);
        let clipped = sanitize_for_report(&huge);
        assert!(
            clipped.chars().count() < MAX_REASON_CHARS + 64,
            "an oversized reason is clipped, not carried: {} chars",
            clipped.chars().count()
        );
        assert!(
            clipped.contains("clipped") && clipped.contains(&huge.chars().count().to_string()),
            "…and says so, with the true length, rather than silently truncating: {}",
            &clipped[clipped.len().saturating_sub(60)..]
        );
        // Multi-byte input must not panic on a char boundary.
        let wide = "é".repeat(MAX_REASON_CHARS * 2);
        assert!(sanitize_for_report(&wide).chars().count() < MAX_REASON_CHARS + 64);

        // And it is applied at CAPTURE, so the stored row — not only the render — is safe.
        let seed = SeedDir::new("sanitize");
        let dir = seed.path();
        let nasty = "zzz-\u{1b}[31mred";
        write_pkg(dir, nasty, &broken_manifest(nasty));
        let reg = ExtensionRegistry::build_from_dir(dir).expect("scan");
        let rejected = reg.rejections();
        let st = rejected
            .iter()
            .find(|s| s.id.contains("zzz-"))
            .unwrap_or_else(|| panic!("the nasty folder is rejected: {rejected:?}"));
        assert!(
            !st.id.chars().any(char::is_control),
            "the stored row's id is already de-fanged: {:?}",
            st.id
        );
        assert!(
            !st.error.as_deref().unwrap_or_default().chars().any(char::is_control),
            "…and so is its reason: {:?}",
            st.error
        );
    }

    /// **TEST-18** [covers: ITEM-1] — the RENDERED report caps its rows while stating the
    /// exact count.
    ///
    /// Clipping each reason bounds one row; nothing bounded the number of ROWS. Thousands of
    /// broken folders is a `mkdir` loop, and the whole block re-renders on every debounced
    /// watcher scan.
    #[test]
    fn the_rendered_report_caps_its_rows_but_never_its_count() {
        let seed = SeedDir::new("rowcap");
        let dir = seed.path();
        let n = MAX_REPORTED_ROWS + 7;
        for i in 0..n {
            let folder = format!("zzz-spray-{i:04}");
            write_pkg(dir, &folder, &broken_manifest(&folder));
        }
        let reg = ExtensionRegistry::build_from_dir(dir).expect("scan");
        let report = PackageRejectionReport::of(&reg, dir);
        assert!(
            report.rejected.len() >= n,
            "PRECONDITION: the spray really did produce {n} rejections, got {}",
            report.rejected.len()
        );
        let rendered = report.render();
        assert!(
            rendered.contains(&format!("{} processor package(s) REFUSED", report.rejected.len())),
            "the COUNT is exact — capping it would hide the scale of the problem: {}",
            &rendered[..rendered.len().min(200)]
        );
        assert_eq!(
            rendered.matches("      manifest: ").count(),
            MAX_REPORTED_ROWS,
            "…while the ENUMERATION is capped at {MAX_REPORTED_ROWS}"
        );
        assert!(
            rendered.contains("more refused package(s) not listed"),
            "…and the render says it is capped rather than looking complete: {}",
            &rendered[rendered.len().saturating_sub(300)..]
        );
        // Every row is still on the admin surface, so nothing is LOST — only the log block
        // is bounded.
        assert_eq!(reg.rejections().len(), report.rejected.len());
    }

    /// **TEST-19** [covers: ITEM-3] — the two lint entry points agree, so reading the
    /// manifest ONCE did not change what the scan enforces.
    ///
    /// The scan reads the manifest once and hands the SAME bytes to the classification, the
    /// lint and the registry parse — three independent reads of an attacker-writable file
    /// were a race in which the classification saw the shipped bytes (⇒ first-party) and the
    /// lint saw garbage (⇒ a rejection), manufacturing a boot-failing refusal. The
    /// text-taking entry point is what made one read possible; this pins it to the
    /// dir-taking one `build.rs` still uses.
    #[test]
    fn the_text_and_dir_lint_entry_points_return_the_same_verdict() {
        let seed = SeedDir::new("oneread");
        let dir = seed.path();
        let root = a_root_datatype();
        let cases = [
            ("zzz-ok", datatype_pkg_yaml("zzz-ok", "probe/ok", &root)),
            ("zzz-badkey", broken_manifest("zzz-badkey")),
            ("zzz-badenv", env_pkg_yaml("zzz-badenv", "Repo/Name")),
            ("zzz-selfx", datatype_pkg_yaml("zzz-selfx", "probe/s", "probe/s")),
        ];
        let mut verdicts = 0usize;
        for (folder, yaml) in &cases {
            write_pkg(dir, folder, yaml);
            let from_dir =
                crate::processor_manifest_lint::lint_processor_package_detailed(&dir.join(folder));
            let from_text = crate::processor_manifest_lint::lint_processor_manifest_text(folder, yaml);
            assert_eq!(
                from_dir.as_ref().err().map(|e| (e.check, &e.message)),
                from_text.as_ref().err().map(|e| (e.check, &e.message)),
                "`{folder}`: the text-taking entry point must be the SAME validator, byte \
                 for byte and code for code — otherwise reading once quietly changed what \
                 the runtime enforces"
            );
            if from_dir.is_err() {
                verdicts += 1;
            }
        }
        assert!(
            verdicts >= 3,
            "NON-VACUITY: the fixtures must actually produce rejections, else this asserts \
             that two functions agree on `Ok` ({verdicts} of {} rejected)",
            cases.len()
        );
    }

    /// **TEST-20** [covers: ITEM-3] — every stable check id is unique, DERIVED from the
    /// source rather than listed.
    ///
    /// The `PKG_*` ids are the machine-readable half of the report: a test keys on them and
    /// an operator searches for them. A typo'd or duplicated one silently merges two distinct
    /// failures into one token, and only five of the fourteen are asserted by any behavioural
    /// test — so a written-down list here would be the `check-kinds-zero-core.sh` shape this
    /// repo keeps getting burned by. The ids are instead read out of the two files that
    /// declare them, which is the only form that covers one added tomorrow.
    #[test]
    fn every_stable_check_id_is_unique_and_well_formed() {
        const LOADER_SRC: &str = include_str!("loader.rs");
        const LINT_SRC: &str = include_str!("../../../build_helper/processor_manifest.rs");
        let mut ids: Vec<&str> = Vec::new();
        for src in [LOADER_SRC, LINT_SRC] {
            for line in src.lines() {
                // `[pub ]const CHECK_X: &str = "PKG_Y";` — the declaration form, so a mere
                // mention in a doc comment or an assertion is not counted.
                let t = line.trim();
                let Some(rest) = t
                    .strip_prefix("const CHECK_")
                    .or_else(|| t.strip_prefix("pub const CHECK_"))
                    .or_else(|| t.strip_prefix("pub(crate) const CHECK_"))
                else {
                    continue;
                };
                let Some(open) = rest.find('"') else { continue };
                let Some(close) = rest[open + 1..].find('"') else { continue };
                ids.push(&rest[open + 1..open + 1 + close]);
            }
        }
        assert!(
            ids.len() >= 12,
            "NON-VACUITY FLOOR: only {} check id declaration(s) found — the parse above has \
             probably drifted from the declaration form, and this test would then be \
             asserting uniqueness over an empty set: {ids:?}",
            ids.len()
        );
        for id in &ids {
            assert!(
                id.starts_with("PKG_")
                    && id.len() > 4
                    && id.chars().all(|c| c.is_ascii_uppercase() || c == '_'),
                "`{id}` is not a well-formed stable check id (PKG_UPPER_SNAKE)"
            );
        }
        let mut sorted = ids.clone();
        sorted.sort();
        let before = sorted.len();
        sorted.dedup();
        assert_eq!(
            sorted.len(),
            before,
            "two check ids collide, so two distinct failures report the same token and a \
             test keying on it cannot tell them apart: {ids:?}"
        );
    }

    /// **TEST-10** [covers: ITEM-1, ITEM-3] — every rejection carries an origin AND a check.
    ///
    /// `PackageRejectionReport::of` falls back to `DroppedIn` for a row with no origin. That
    /// fallback is fail-safe, but a skip path that forgot to set one would silently
    /// downgrade a first-party refusal back to a tolerated skip — reintroducing the exact
    /// defect this change exists to fix, invisibly. This asserts the fallback stays
    /// unreachable across EVERY rejection the scan can produce.
    #[test]
    fn every_rejection_carries_an_origin_and_a_check() {
        let seed = SeedDir::new("rowshape");
        let dir = seed.path();
        let base = ExtensionRegistry::build_from_dir(dir).expect("baseline");
        let root = a_root_datatype();
        let parent = a_cross_package_supertype(&base, "");

        // One fixture per distinct skip path the scan owns.
        write_pkg(dir, "zzz-bad-key", &broken_manifest("zzz-bad-key"));
        write_pkg(dir, "zzz-bad-env", &env_pkg_yaml("zzz-bad-env", "Repo/Name"));
        write_pkg(dir, "zzz-xpkg", &datatype_pkg_yaml("zzz-xpkg", "probe/x", &parent));
        write_pkg(dir, "zzz-selfext", &datatype_pkg_yaml("zzz-selfext", "probe/s", "probe/s"));
        write_pkg(dir, "zzz-dup-a", &datatype_pkg_yaml("zzz-dup-a", "probe/dup", &root));
        write_pkg(dir, "zzz-dup-b", &datatype_pkg_yaml("zzz-dup-b", "probe/dup", &root));

        let reg = ExtensionRegistry::build_from_dir(dir).expect("scan");

        // Each fixture is PINNED to the check it exists to trip. Asserting only "there are
        // >= 4 rejections with >= 3 distinct codes" let two fixtures silently collapse onto
        // a third's code (a drift between the runtime lattice roots and the build lint's
        // would do exactly that) while the test kept claiming coverage of every skip path.
        for (folder, expected) in [
            ("zzz-bad-key", "PKG_MALFORMED_MANIFEST"),
            ("zzz-bad-env", "PKG_ENV_ID_INVALID"),
            ("zzz-xpkg", "PKG_DANGLING_EXTENDS"),
            ("zzz-selfext", "PKG_EXTENDS_CYCLE"),
            ("zzz-dup-b", "PKG_DUPLICATE_DATATYPE_ID"),
        ] {
            assert_eq!(
                row(&reg, folder).check.as_deref(),
                Some(expected),
                "`{folder}` must trip {expected} — a fixture that stops tripping its own \
                 check silently narrows what this test covers: {:?}",
                row(&reg, folder).error
            );
        }
        assert!(
            row(&reg, "zzz-dup-a").ok,
            "…and the FIRST claimant of the duplicated datatype id keeps it"
        );

        let rejections = reg.rejections();
        assert!(
            rejections.len() >= 5,
            "the fixtures must actually trip distinct checks — otherwise this test asserts \
             a property of an empty set: {rejections:?}"
        );
        let mut checks: Vec<&str> = rejections
            .iter()
            .map(|s| {
                assert!(
                    s.origin.is_some(),
                    "rejection `{}` has NO origin — `PackageRejectionReport::of` would \
                     silently classify it dropped-in and a first-party refusal would \
                     vanish",
                    s.id
                );
                assert!(
                    s.manifest_path.is_some(),
                    "rejection `{}` has no manifest path for the operator to open",
                    s.id
                );
                s.check
                    .as_deref()
                    .unwrap_or_else(|| panic!("rejection `{}` has NO check id", s.id))
            })
            .collect();
        checks.sort();
        checks.dedup();
        assert!(
            checks.len() >= 5,
            "the fixtures should exercise several DISTINCT check ids, else 'every rejection \
             is coded' is one code repeated: {checks:?}"
        );
        assert_control_loaded(&reg, "");
    }

    /// **TEST-11** [covers: ITEM-5] — a DROPPED-IN package can never displace a SHIPPED one.
    ///
    /// The cross-package passes all had to pick a victim, and the rule was positional
    /// ("keep the first in id order", "blame the later"). Positional blame becomes
    /// exploitable the moment a refusal has consequences: a drop-in sorting BEFORE a
    /// shipped package and declaring its extension id made the SHIPPED package the
    /// offender — one attacker-writable file turning into a permanent boot refusal through
    /// the trusted branch. Victim selection is now origin-aware.
    #[test]
    fn a_dropped_in_package_cannot_displace_a_shipped_one() {
        let seed = SeedDir::new("displace");
        let dir = seed.path();
        let base = ExtensionRegistry::build_from_dir(dir).expect("baseline");
        let target = a_breakable_seed_pkg(&base);
        let root = a_root_datatype();

        // `aaa-…` sorts BEFORE every seed package, and claims a shipped package's id.
        let squatter = "aaa-squatter";
        write_pkg(
            dir,
            squatter,
            &format!(
                "id: {target}\nname: Squatter\npublisher: evil\nversion: 9.9.9\n\
                 apiVersion: \"1.0\"\ncontributes: {{}}\n"
            ),
        );

        let reg = ExtensionRegistry::build_from_dir(dir).expect("scan");
        assert!(
            reg.get(&target).is_some(),
            "the SHIPPED package must survive an id squat: {:?}",
            reg.rejections()
        );
        let kept = row(&reg, &target);
        assert!(
            kept.ok && kept.origin == Some(PackageOrigin::FirstParty),
            "the SHIPPED package `{target}` must keep BOTH its registration and its \
             first-party classification after a drop-in squats its id; it now reads \
             {kept:?}"
        );
        let evicted = row(&reg, squatter);
        assert!(!evicted.ok, "the SQUATTER is the one skipped");
        assert_eq!(evicted.check.as_deref(), Some("PKG_DUPLICATE_EXTENSION_ID"));
        assert_eq!(evicted.origin, Some(PackageOrigin::DroppedIn));

        // …and therefore no first-party refusal was manufactured by the drop-in.
        ExtensionRegistry::build_from_dir_checked(dir)
            .expect("a drop-in must not be able to make the load refuse");

        // The same, for a colliding CONTRIBUTED datatype id: the shipped contributor keeps
        // ownership and the drop-in is the duplicate.
        let mut contributors: Vec<(&str, &str)> = base
            .all()
            .iter()
            .flat_map(|m| {
                m.contributes
                    .datatypes
                    .iter()
                    .map(move |d| (m.id.as_str(), d.id.as_str()))
            })
            .collect();
        contributors.sort();
        let (owner_pkg, owned_dt) = contributors[0];
        write_pkg(
            dir,
            "aaa-dtsquatter",
            &datatype_pkg_yaml("aaa-dtsquatter", owned_dt, &root),
        );
        let reg2 = ExtensionRegistry::build_from_dir(dir).expect("scan");
        assert!(
            reg2.get(owner_pkg).is_some(),
            "the SHIPPED contributor of `{owned_dt}` keeps its registration: {:?}",
            reg2.rejections()
        );
        let dup = row(&reg2, "aaa-dtsquatter");
        assert!(!dup.ok);
        assert_eq!(dup.check.as_deref(), Some("PKG_DUPLICATE_DATATYPE_ID"));
        ExtensionRegistry::build_from_dir_checked(dir)
            .expect("a datatype-id squat must not be able to make the load refuse either");
    }

    /// **TEST-2** [acceptance] [invariant: INV-1] [covers: ITEM-1, ITEM-3] —
    /// the #190/#197 case itself: a CROSS-PACKAGE `extends` is reported BY NAME with its
    /// check id, instead of the package merely being absent.
    ///
    /// The positive control is the same probe extending a ROOT, in the SAME scan: that is
    /// the exact A/B whose 26-vs-27 divergence measured the defect, so a scan that loaded
    /// nothing cannot satisfy this test.
    #[test]
    fn a_cross_package_extends_is_reported_by_name_not_silently_absent() {
        let seed = SeedDir::new("xpkg-named");
        let dir = seed.path();
        let base = ExtensionRegistry::build_from_dir(dir).expect("baseline scan");

        // A supertype contributed by ANOTHER package — precisely what the per-package lint
        // cannot resolve, because it only ever has one package in view. Discovered from the
        // scan so this test follows the package tree instead of pinning a domain id.
        let parent = a_cross_package_supertype(&base, "zzz-xpkg-probe");
        write_pkg(
            dir,
            "zzz-xpkg-probe",
            &datatype_pkg_yaml("zzz-xpkg-probe", "probe/xthing", &parent),
        );
        let root = a_root_datatype();
        write_pkg(
            dir,
            "zzz-root-probe",
            &datatype_pkg_yaml("zzz-root-probe", "probe/rthing", &root),
        );

        let reg = ExtensionRegistry::build_from_dir(dir).expect("scan");
        assert_control_loaded(&reg, "");

        // POSITIVE CONTROL — the root-extending twin DOES register. Without this, "the
        // cross-package probe is absent" would be satisfied by a scan that dropped both.
        assert!(
            reg.get("zzz-root-probe").is_some(),
            "POSITIVE CONTROL: the ROOT-extending probe registers, so the cross-package \
             probe's absence is about its `extends`, not about the fixture"
        );
        assert!(row(&reg, "zzz-root-probe").ok);

        let st = row(&reg, "zzz-xpkg-probe");
        assert!(!st.ok, "the cross-package probe does not register (the known limitation)");
        assert_eq!(
            st.check.as_deref(),
            Some("PKG_DANGLING_EXTENDS"),
            "…but it is REPORTED, with the stable check id: {:?}",
            st.error
        );
        let err = st.error.as_deref().unwrap_or_default();
        assert!(
            err.contains("probe/xthing") && err.contains(&parent),
            "the reason names BOTH the contributed datatype and the supertype it could not \
             resolve — an operator must be able to see WHICH edge failed: {err}"
        );
        assert_eq!(st.origin, Some(PackageOrigin::DroppedIn));

        // A drop-in refusal is loud but NOT fatal (INV-2): the load still succeeds…
        let checked = ExtensionRegistry::build_from_dir_checked(dir)
            .expect("a DROPPED-IN refusal must not refuse the load (INV-2)");
        assert!(checked.get("zzz-root-probe").is_some());

        // …and it is still NAMED in the aggregated report, so it cannot be silent.
        let report = PackageRejectionReport::of(&checked, dir);
        assert!(
            report.render().contains("zzz-xpkg-probe")
                && report.render().contains("PKG_DANGLING_EXTENDS"),
            "a tolerated drop-in refusal is still NAMED in the aggregated report: {}",
            report.render()
        );
    }

    /// **TEST-3** [acceptance] [invariant: INV-3] [covers: ITEM-4] —
    /// a declared env that cannot be satisfied is a NAMED failure, split where the runtime
    /// can actually decide (DEC-2): malformed GRAMMAR is refused at load, naming the key and
    /// the value; well-formed-but-unpublished LOADS and is E1's run-time problem.
    #[test]
    fn a_malformed_declared_env_is_a_named_coded_refusal() {
        let seed = SeedDir::new("env-named");
        let dir = seed.path();

        for (i, bad) in ["Repo/Name", "UPPER", "x:tag"].iter().enumerate() {
            write_pkg(
                dir,
                &format!("zzz-env-bad-{i}"),
                &env_pkg_yaml(&format!("zzz-env-bad-{i}"), bad),
            );
        }
        // A WELL-FORMED but (as far as boot can know) unpublished env id.
        write_pkg(
            dir,
            "zzz-env-ok",
            &env_pkg_yaml("zzz-env-ok", "an-env-that-is-not-published-yet"),
        );

        let reg = ExtensionRegistry::build_from_dir(dir).expect("scan");
        assert_control_loaded(&reg, "");

        // POSITIVE CONTROL + DEC-2's split: a well-formed id LOADS. Boot cannot decide
        // publication (the registry is deliberately open), so refusing here would break
        // every air-gapped deployment; E1 owns the run-time half.
        assert!(
            reg.get("zzz-env-ok").is_some(),
            "POSITIVE CONTROL: a WELL-FORMED env id loads — publication is a run-time fact"
        );

        for (i, bad) in ["Repo/Name", "UPPER", "x:tag"].iter().enumerate() {
            let st = row(&reg, &format!("zzz-env-bad-{i}"));
            assert!(!st.ok, "a malformed env id `{bad}` is refused");
            assert_eq!(
                st.check.as_deref(),
                Some("PKG_ENV_ID_INVALID"),
                "…with its OWN check id, not a generic parse error — the whole point is \
                 that the author is told WHICH key is wrong: {:?}",
                st.error
            );
            let err = st.error.as_deref().unwrap_or_default();
            assert!(err.contains("`env`"), "names the KEY: {err}");
            assert!(err.contains(bad), "names the offending VALUE `{bad}`: {err}");
            assert!(err.contains(&format!("zzz-env-bad-{i}")), "names the PACKAGE: {err}");
        }
    }

    /// **TEST-12** [covers: ITEM-4] — the env grammar check is PATH-SCOPED.
    ///
    /// The first version searched the whole untyped document for any key named `env`,
    /// justified by "`deny_unknown_fields` at every enumerable level". That premise is
    /// false: a contribution's `params`/`accepts`/`produces` and a datatype's
    /// `schema`/`axes` are free-form values whose vocabulary is owned elsewhere. A manifest
    /// legitimately carrying `env` inside one of those was rejected outright.
    #[test]
    fn the_env_grammar_check_does_not_reach_into_free_form_regions() {
        let seed = SeedDir::new("env-scope");
        let dir = seed.path();

        // `env` deep inside a datatype's free-form `schema` — a normal JSON-Schema idiom,
        // and NOT an env-id.
        let yaml = format!(
            "id: zzz-freeform\nname: Free\npublisher: cyto\nversion: 0.1.0\napiVersion: \"1.0\"\n\
             contributes:\n  datatypes:\n    - id: probe/free\n      title: Free\n      \
             extends: {}\n      is_abstract: false\n      axes:\n        - name: cells\n          \
             key_label: barcode\n      entity_axis: cells\n      storage:\n        layout:\n          \
             kind: chunked_dense\n        format: zarr\n        file_layout: single\n      \
             schema:\n        type: object\n        properties:\n          cfg:\n            \
             type: object\n        examples:\n          - env: \"Prod/2024\"\n",
            a_root_datatype()
        );
        write_pkg(dir, "zzz-freeform", &yaml);

        let reg = ExtensionRegistry::build_from_dir(dir).expect("scan");
        assert!(
            reg.get("zzz-freeform").is_some(),
            "an `env` key inside a free-form region is not an env-id and must not refuse \
             the package: {:?}",
            reg.rejections()
        );
        assert_control_loaded(&reg, "");
    }

    /// **TEST-5** [covers: ITEM-6] — the ANTI-VACUITY floor, on the boot/reflect path.
    ///
    /// A reporter that can silently see NOTHING is the failure mode this whole change
    /// exists to prevent: with zero packages every downstream assertion is vacuously true
    /// and the registry publishes empty while every gate stays green.
    #[test]
    fn a_scan_that_discovers_zero_packages_fails_with_a_diagnosis() {
        let empty = std::env::temp_dir().join(format!(
            "cyto-loader-empty-{}-{}",
            std::process::id(),
            TEST_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&empty);
        // Not merely empty: full of dirs that are not candidate packages, so the floor is
        // stated over CANDIDATES rather than over `read_dir` entries.
        let non_package_dirs = ["not-a-package", ".hidden-staging", "_reserved"];
        std::fs::create_dir_all(empty.join("not-a-package/compute")).unwrap();
        std::fs::create_dir_all(empty.join(".hidden-staging")).unwrap();
        std::fs::create_dir_all(empty.join("_reserved")).unwrap();
        std::fs::write(empty.join("_reserved/manifest.yaml"), broken_manifest("_reserved")).unwrap();

        // The pure SCAN is unchanged — it still reports what it found, tolerantly. That
        // separation is what keeps `build_from_dir`'s pre-existing contract intact.
        let scanned = ExtensionRegistry::build_from_dir(&empty)
            .expect("the scan itself does not judge emptiness");
        assert!(scanned.is_empty());

        // The BOOT/REFLECT path is where the floor lives.
        let err = ExtensionRegistry::build_from_dir_checked(&empty)
            .err()
            .expect("a zero-candidate scan is a COLLAPSE, not a clean empty registry");
        assert!(err.contains("ZERO candidate packages"), "says what happened: {err}");
        assert!(
            err.contains(&empty.display().to_string()),
            "names the scanned root: {err}"
        );
        // The RAW sub-dir count, not just the candidate count. "3 sub-dirs, none a
        // package" and "0 sub-dirs" are different faults (a broken extraction vs a wrong
        // or emptied data root) and an operator has to be able to tell them apart; a
        // message stating only "zero candidates" collapses both into one.
        assert!(
            err.contains(&format!("{} sub-directories", non_package_dirs.len())),
            "names the RAW sub-directory count it walked ({} here: {non_package_dirs:?}) — \
             derived from the fixture, so adding one costs no edit: {err}",
            non_package_dirs.len()
        );
        for cause in ["seed \nfailed to extract", "data root", "CYTO_PROCESSOR_SEED_ONLY"] {
            let cause = cause.replace(" \n", " ");
            assert!(
                err.replace('\n', " ").contains(&cause),
                "diagnoses what probably moved (missing `{cause}`): {err}"
            );
        }
        let _ = std::fs::remove_dir_all(&empty);

        // POSITIVE CONTROL — the identical call over a real seed succeeds and is non-empty,
        // so the floor refuses the collapse and not simply everything.
        let seed = SeedDir::new("floor-control");
        let ok = ExtensionRegistry::build_from_dir_checked(seed.path())
            .expect("a real seed scans and passes the floor");
        assert!(!ok.is_empty(), "POSITIVE CONTROL: a real seed scan is non-empty");
    }

    /// **TEST-6** [covers: ITEM-5] — the operator escape hatch (DEC-1) downgrades the
    /// FIRST-PARTY refusal to the drop-in posture, and its use is itself reported.
    #[test]
    fn the_operator_override_downgrades_the_first_party_refusal_and_says_so() {
        let seed = SeedDir::new("override");
        let dir = seed.path();
        let victim =
            a_breakable_seed_pkg(&ExtensionRegistry::build_from_dir(dir).expect("baseline scan"));
        let _shipped = pretend_we_shipped(dir, &victim, &broken_manifest(&victim));
        let reg = ExtensionRegistry::build_from_dir(dir).expect("scan");
        assert_control_loaded(&reg, &victim);

        let mut report = PackageRejectionReport::of(&reg, dir);
        assert_eq!(report.first_party().len(), 1, "the fixture IS a first-party refusal");
        assert!(
            report.into_posture_result().is_err(),
            "without the override, the first-party refusal of `{victim}` must refuse the \
             load — otherwise the override below downgrades nothing and this test is \
             asserting a property of a posture that was never applied"
        );

        report.override_active = true;
        assert!(
            report.into_posture_result().is_ok(),
            "with the override, it degrades to the drop-in posture so a deployment can limp"
        );
        let rendered = report.render();
        assert!(
            rendered.contains(ALLOW_BROKEN_FIRST_PARTY_ENV) && rendered.contains("DOWNGRADED"),
            "the override can never be SILENT — using it is itself reported: {rendered}"
        );
        assert!(
            rendered.contains(&format!("`{victim}`")),
            "and the package is still named while the override is on: {rendered}"
        );
    }

    /// **TEST-6** (env-read leg) — the kill-switch vocabulary, as a pure predicate, and the
    /// binding that stops the two deploy switches drifting apart.
    ///
    /// Driven through the predicate rather than `set_var`: env mutation from a test is
    /// process-wide and leaks into every other test in the binary (this crate already
    /// carries one flaky test for exactly that reason).
    #[test]
    fn the_override_flag_matches_the_kill_switch_vocabulary() {
        for on in ["1", "true", "TRUE", "yes"] {
            assert!(truthy_env(Some(on)), "`{on}` enables the switch");
        }
        for off in [None, Some(""), Some("0"), Some("false"), Some("no"), Some("YES")] {
            assert!(!truthy_env(off), "{off:?} does NOT enable the switch");
        }
        // `X || truthy_env(Some("1"))` was the first spelling here, and it is a NO-OP:
        // the right operand is unconditionally true, so the assertion held in every
        // universe, including one where `allow_broken_first_party` read a different env var
        // or returned a constant. A blind audit caught it. The real binding is an EQUALITY
        // against the production read, evaluated on whatever the ambient environment
        // happens to be — which needs no `set_var` (process-wide env mutation leaks into
        // every other test in this binary; this crate already carries one flake from it).
        assert_eq!(
            allow_broken_first_party(),
            truthy_env(std::env::var(ALLOW_BROKEN_FIRST_PARTY_ENV).ok().as_deref()),
            "the override predicate must BE the shared `truthy_env` read of \
             `{ALLOW_BROKEN_FIRST_PARTY_ENV}` — a different env var, an inverted sense or a \
             constant would all pass a weaker assertion"
        );
        assert_eq!(
            ALLOW_BROKEN_FIRST_PARTY_ENV, "CYTO_PROCESSOR_ALLOW_BROKEN_FIRST_PARTY",
            "the env var an operator is told to set is part of the contract, so a rename \
             must be a deliberate edit here rather than a silently dead escape hatch"
        );
        // And the PRODUCTION read is the one the report carries — the only place the env
        // reaches the posture. Asserting equality against the AMBIENT environment is
        // vacuous when the variable is unset (both sides are `false`), which is why the
        // predicate is forced ON here: hardwiring `override_active: false` in
        // `PackageRejectionReport::of` used to leave every test green.
        let empty = ExtensionRegistry::from_manifests(Vec::new()).expect("empty registry");
        for on in [true, false] {
            let _g = override_seam::force(on);
            assert_eq!(
                PackageRejectionReport::of(&empty, Path::new("/nowhere")).override_active,
                on,
                "the report's `override_active` must BE the live predicate, not a constant"
            );
        }
    }

    /// **TEST-21** [covers: ITEM-5] — the operator escape hatch works ON THE REAL PATH.
    ///
    /// TEST-6 proves the report's posture arithmetic; this proves the lever an operator
    /// actually pulls. It is DEC-1's single documented recovery from a first-party boot
    /// refusal, and an operator finds out whether it works while the deployment is already
    /// down — so it has to be exercised end to end, over the same
    /// `build_from_dir_checked` that boot and every reflect call, against a package that
    /// genuinely classifies first-party.
    #[test]
    fn the_escape_hatch_downgrades_a_real_first_party_refusal_on_the_real_path() {
        let seed = SeedDir::new("hatch");
        let dir = seed.path();
        let victim =
            a_breakable_seed_pkg(&ExtensionRegistry::build_from_dir(dir).expect("baseline"));
        let _shipped = pretend_we_shipped(dir, &victim, &broken_manifest(&victim));

        // PRECONDITION: without the hatch this really is a refusal — otherwise "the hatch
        // let it through" is true of a load that was never going to fail.
        let err = ExtensionRegistry::build_from_dir_checked(dir)
            .err()
            .unwrap_or_else(|| panic!("`{victim}` must refuse the load with the hatch OFF"));
        assert!(err.contains(&victim) && err.contains("first-party"));

        // With the hatch ON, the SAME tree loads, the package is still reported, and the
        // report says the override is what let it through.
        let reg = {
            let _g = override_seam::force(true);
            let reg = ExtensionRegistry::build_from_dir_checked(dir).unwrap_or_else(|e| {
                panic!(
                    "with {ALLOW_BROKEN_FIRST_PARTY_ENV} set, a first-party refusal must \
                     DOWNGRADE to the tolerant posture — this is the only documented way \
                     to bring a deployment up while a fix ships, and an operator finds out \
                     it does not work while already down. Got: {e}"
                )
            });
            let rendered = PackageRejectionReport::of(&reg, dir).render();
            assert!(
                rendered.contains(&format!("`{victim}`"))
                    && rendered.contains("DOWNGRADED")
                    && rendered.contains(ALLOW_BROKEN_FIRST_PARTY_ENV),
                "…and using it is never silent: {rendered}"
            );
            reg
        };
        assert_control_loaded(&reg, &victim);
        assert!(!row(&reg, &victim).ok, "the package is still REFUSED, just not fatally");

        // The guard restored the predicate, so the refusal is back — the override cannot
        // leak into the next test on this thread.
        assert!(
            ExtensionRegistry::build_from_dir_checked(dir).is_err(),
            "the override must not outlive its guard"
        );
    }

    /// **TEST-7** [acceptance] [invariant: INV-4] [covers: ITEM-1..6] —
    /// the REAL shipped seed loads CLEAN under the checked (posture-applying) path.
    ///
    /// This is the INV-4 proof and the compatibility floor in one. If the change had obliged
    /// any package to declare a new key or a new datatype, every shipped package would now be
    /// refused and this would go red; if the posture were mis-scoped, a currently-shipping
    /// package would be refused and this would go red.
    #[test]
    fn the_real_shipped_seed_loads_with_zero_rejections() {
        let seed = SeedDir::new("shipped-clean");
        let dir = seed.path();

        let reg = ExtensionRegistry::build_from_dir_checked(dir)
            .expect("the SHIPPED seed must load under the checked (posture-applying) path");
        assert_control_loaded(&reg, "");

        let report = PackageRejectionReport::of(&reg, dir);
        assert!(
            report.is_empty(),
            "no shipped package may be refused by this change: {}",
            report.render()
        );

        // The strongest form of the control, and the runtime twin of the datatype suite's
        // declared-vs-loaded derivation: EVERY package the binary embedded must be in the
        // registry. Both sides are derived — the expectation from the embedded seed, the
        // actual from the scan — so a package landing on main tomorrow is covered with no
        // edit here, and a package that is embedded but silently never registered (the whole
        // defect) fails BY NAME. `is_reserved_package` is `scan_dir`'s OWN predicate, not a
        // second copy of the rule.
        let embedded_ids: std::collections::HashSet<String> = embedded::seed_managed_id_set()
            .iter()
            .filter(|id| !is_reserved_package(id))
            .cloned()
            .collect();
        let loaded: std::collections::HashSet<String> =
            reg.all().iter().map(|m| m.id.clone()).collect();
        let missing: Vec<&String> = {
            let mut v: Vec<&String> = embedded_ids.difference(&loaded).collect();
            v.sort();
            v
        };
        assert!(
            missing.is_empty(),
            "these packages are EMBEDDED but are NOT in the loaded registry: {missing:?}. A \
             shipped package that does not load registers nothing — which is exactly \
             ziee-ai/cytoanalyst#190 / #197."
        );
        assert!(
            embedded_ids.len() >= 12,
            "POSITIVE CONTROL: the embedded id set is populated ({}), so the comparison \
             above is not vacuous",
            embedded_ids.len()
        );

        // The DATATYPE side of the same comparison, and it is an EQUALITY over two derived
        // sets — not a floor. A typed-in floor (`>= 18`) decays: it is vacuously true for
        // everything beneath it, so losing two contributed datatypes stayed green, which is
        // exactly the shape DEC-8 refuses one screen away in this same file. The expectation
        // is instead read out of the EMBEDDED manifests themselves, so a datatype landing
        // tomorrow costs no edit and a datatype silently lost fails BY ID.
        let embedded_datatypes: std::collections::BTreeSet<String> = embedded_ids
            .iter()
            .filter_map(|id| embedded::embedded_manifest_bytes(id))
            .filter_map(|b| serde_norway::from_slice::<ExtensionManifest>(b).ok())
            .flat_map(|m| {
                m.contributes
                    .datatypes
                    .into_iter()
                    .map(|d| d.id)
                    .collect::<Vec<_>>()
            })
            .collect();
        let loaded_datatypes: std::collections::BTreeSet<String> = reg
            .all()
            .iter()
            .flat_map(|m| m.contributes.datatypes.iter().map(|d| d.id.clone()))
            .collect();
        assert!(
            !embedded_datatypes.is_empty(),
            "NON-VACUITY: the embedded manifests must yield contributed datatypes, else the \
             equality below is between two empty sets"
        );
        assert_eq!(
            embedded_datatypes, loaded_datatypes,
            "every datatype the EMBEDDED manifests contribute must reach the registry, and \
             nothing else may. Both sides are derived, so this needs no edit when a package \
             lands — and a datatype that silently stops loading (the whole defect) is named"
        );
        assert_eq!(
            reg.len(),
            embedded_ids.len(),
            "…and the package sets agree exactly, which makes the difference check above an \
             equality rather than a one-way containment"
        );
        assert!(
            reg.load_status().iter().all(|s| s.ok),
            "every row is ok on a clean seed"
        );
        assert!(
            reg.load_status()
                .iter()
                .all(|s| s.origin == Some(PackageOrigin::FirstParty)),
            "every SHIPPED package classifies as first-party — if this fails, the byte \
             comparison is rejecting our own seed and the refusal branch is unreachable"
        );
    }
}
