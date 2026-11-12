//! Processor compute resolution — the COMPUTE-FROM-FOLDER path (D2 Slice 5, ITEM-7,
//! INV-7).
//!
//! A dataset pipeline's processor sends a logical `code_ref` (its manifest
//! `run.entry`, e.g. `"compute/import.py"`), NOT the script body. Up through S4 the
//! script was BAKED into the binary via `include_str!` and `resolve` was a compile-time
//! table lookup returning `&'static str`. That could never run a SEPARATE-REPO,
//! folder-discovered package's compute — its bytes live only on disk.
//!
//! As of this slice `resolve` reads the script FROM THE EXTRACTED FOLDER at run time:
//! `<data_root>/processors/<package>/<code_ref>` (the same folder the S3 seed extractor
//! stages + the S4 loader scans). So a contributor can drop `compute/foo.py` into their
//! package and it RUNS (and is recorded for provenance) with NO rebuild. The SAME
//! resolution feeds the runner (stage → exec) and the provenance recorder (hash the
//! executed code), so the bytes RUN are the bytes RECORDED (reproduce), and the bytes
//! RECORDED are the bytes ON DISK (a re-dropped script runs the new bytes — INV-7).
//!
//! The owning PACKAGE of a bare `code_ref` (e.g. `compute/qc-10x.py` does not name
//! its package) is resolved from, in order: the caller's package HINT (the enqueuing
//! converter/analysis knows its owner), the RESERVED app-owned packages (a `code_ref`
//! the app itself dispatches — never claimable by a contribution), the extension
//! REGISTRY (a manifest whose `run.entry` is this `code_ref`), and finally a
//! deterministic folder SCAN. Either way the bytes are read from
//! `<dir>/<package>/<code_ref>`.
//!
//! ## S6 — the server no longer names any domain package
//!
//! There used to be a `BUILTINS` table listing seven processor packages and their
//! script paths, carrying `{package, language, needs_reference}` per `code_ref`.
//! Three of those four columns were already derivable (the hint/registry give the
//! package, `run.runtime`/`Language::from_code_ref` give the language); the fourth,
//! `needs_reference`, had no manifest field — so the table survived to carry ONE
//! boolean, and with it seven domain package names baked into the app builtin.
//!
//! `RunSpec` now declares `host_resources` (S7) and `helpers`, so every column is
//! DATA and the table is gone. What remains is [`RESERVED_HELPER_PACKAGE`] — the
//! app's OWN `_helpers` package, which is not a domain processor: it ships the
//! synthetic demo analysis plus the shared runtime helper modules, and the
//! `_`-prefix scan exclusion (the stealth-load guard) means the app must name it
//! explicitly to reach its own assets.

use std::borrow::Cow;
use std::path::{Path, PathBuf};

use super::spec::Language;
use crate::modules::extensions::types::{DependencyRequirement, HostResourceRequirement};

/// The RESERVED, app-owned helper package. NOT a domain processor: it ships the
/// synthetic input-free demo analysis and the shared runtime helper modules the app
/// itself stages. The loader skips `_`-prefixed dirs (they contribute no
/// datatype/converter/view and never appear in `GET /api/extensions`) and
/// [`find_owning_package`] skips them too — that is the stealth-load guard — so the
/// app names its own package here to reach its own assets.
pub const RESERVED_HELPER_PACKAGE: &str = "_helpers";

/// The RESERVED, app-owned FORMAT library package (artifact-model ITEM-1). Same
/// `_`-prefix stealth-load exclusion as [`RESERVED_HELPER_PACKAGE`], so the app
/// must name it explicitly here to reach it. Separate from `_helpers` because it
/// carries the artifact byte-format contract shared with the frontend reader,
/// not app runtime glue.
pub const RESERVED_LIB_PACKAGE: &str = "_lib";

/// The `code_ref`s the app itself runs out of its OWN reserved packages, each with
/// the package that OWNS it. Not reachable via the open scan by design (it skips
/// `_`-prefixed dirs); not domain packages either.
///
/// The package is a column rather than a constant because the app now runs entries
/// out of BOTH reserved packages: `_helpers` ships the synthetic demo analysis,
/// `_lib` ships the verification processor that drives the conformance gate
/// (artifact-model ITEM-18 / DEC-12) — it belongs beside the gate it runs, not in
/// the runtime-glue bag.
const RESERVED_CODE_REFS: &[(&str, &str)] = &[
    ("compute/demo-analysis.py", RESERVED_HELPER_PACKAGE),
    (VERIFY_CONFORMANCE_CODE_REF, RESERVED_LIB_PACKAGE),
];

/// The verification processor's `code_ref` (artifact-model ITEM-18 / DEC-12): the
/// entry the server dispatches AFTER ingest to gate the artifacts that landed.
/// Named here, next to the tables that make it resolvable + importable, and
/// re-exported for the dispatcher that builds its spec.
pub const VERIFY_CONFORMANCE_CODE_REF: &str = "verify_conformance.py";

/// Modules staged into `/code` for ONE reserved entry ONLY — never globally.
///
/// `(code_ref, staged_name, package, rel_path_in_that_package)`.
///
/// This table exists because `conformance.py` must be reachable by the verification
/// processor and by nothing else. Adding it to [`PY_HELPER_FILES`] would put the
/// framework's gate into the `/code` dir of EVERY processor — i.e. inside the very
/// process it exists to judge, which is the arrangement DEC-8 rules out and which
/// `_lib/manifest.yaml` explicitly forbids ("deliberately NOT staged and must not be
/// added to that table"). Leaving it unstaged is not an option either: `/code` is
/// assembled from these tables ALONE, so an unstaged module is not a degraded import
/// — it is `ModuleNotFoundError` at process start, which reaches the server as an
/// opaque job failure with no hint of the cause. Entry-scoped staging is the third
/// answer: the gate resolves for the job that runs it, for nothing else.
const RESERVED_ENTRY_HELPERS: &[(&str, &str, &str, &str)] = &[(
    VERIFY_CONFORMANCE_CODE_REF,
    "conformance.py",
    RESERVED_LIB_PACKAGE,
    "conformance.py",
)];

/// Shared runtime helper modules staged into the sandbox code dir alongside EVERY
/// Python entry, read from [`RESERVED_HELPER_PACKAGE`].
///
/// `(staged_name, rel_path_in_the_reserved_package)`. These are the APP's own
/// cross-cutting helpers (a generic axis-alignment engine + a generic column
/// summarizer), so staging them globally names no domain package.
///
/// ## S6 — what moved out of here, and the behaviour change (stated, not smuggled)
///
/// This table also staged `multimodal.py` **from the `anndata-import` package** into
/// `/code` for every Python entry — globally and cross-package. That is the leak: a
/// specific domain package and its script path, baked into the app builtin, staged
/// into entries that never asked for it.
///
/// It is now declared as an intra-package sibling on that converter's
/// `run.helpers`, which means the BEHAVIOUR CHANGE is exactly: a Python entry other
/// than `anndata-import`'s no longer receives `multimodal.py` in its code dir.
/// Verified against the shipped tree — `compute/h5ad_import.py` is the only entry
/// that imports it (the other importers are that package's own pytest files, which
/// never run in a sandbox) — and pinned by
/// `every_shipped_helper_import_is_declared_or_globally_staged`, which fails if any
/// entry imports a module that is neither declared nor listed here.
pub const PY_HELPER_FILES: &[(&str, &str, &str)] = &[
    (
        "colsummary.py",
        RESERVED_HELPER_PACKAGE,
        "colsummary.py",
    ),
    ("align.py", RESERVED_HELPER_PACKAGE, "align.py"),
    // virtual-dataset-alignment stage 1: the MULTI-dataset counterpart of `align.py`.
    // `align.py` folds ONE supporting table onto ONE axis; this one measures join quality
    // across SEVERAL datasets and emits the alignment vectors a fused column is read
    // through. Same reserved package, same reason it is here rather than in a processor's
    // own `run.helpers`: `helpers` resolves against the entry's OWN package (see the
    // `read_bytes(dir, &package, rel)` call below), so a module living in `_helpers` is
    // unreachable that way — and an unstaged module is `ModuleNotFoundError` at process
    // start, not a degraded import.
    //
    // It imports `align` (it reuses that engine's duplicate-key refusal rather than
    // re-implementing it), which is staged immediately above — and `txr_columns`, from
    // the `_lib` package below.
    //
    // ── `_helpers` MAY IMPORT `_lib`. THIS IS A SUPPORTED DIRECTION. ────────────────
    //
    // Stated here because this table is what makes it true: staging is FLAT. Every entry
    // below lands side by side in one `/code` directory, so the source-tree split between
    // `_helpers` and `_lib` is a LIFECYCLE distinction (runtime glue vs the on-disk format
    // contract), not an import boundary. At runtime `import txr_columns` from
    // `alignment.py` resolves for exactly the same reason `import align` does.
    //
    // The concrete case (C4): `alignment.py` needs the missing-level label rule that
    // `txr_columns` already owns for every categorical in the tree. Copying it would give
    // two implementations of a COLLISION rule, and if they diverged a source's own `NA` and
    // the unified `NA` would resolve differently and shadow a real level. One definition,
    // imported, is the smaller cost.
    //
    // A TEST that runs a staged helper with only its own source package importable is
    // modelling a boundary the sandbox does not have, and will fail on any cross-package
    // import. Put the whole staged set on the path — that is what `/code` is.
    // `_helpers/tests/test_staged_imports.py` checks this table against the real import
    // graph, so a new cross-package import is a red test rather than a discovery.
    ("alignment.py", RESERVED_HELPER_PACKAGE, "alignment.py"),
    // artifact-model ITEM-1/26: the Zarr writer every migrated processor imports.
    //
    // It lives in its OWN reserved package rather than `_helpers` because the two
    // have different lifecycles: `_helpers` is app runtime glue, `_lib` is the
    // on-disk FORMAT contract shared with the frontend reader — the byte layout it
    // writes is the same one `ui/src/core/workstore/zarrReader.ts` parses. Keeping
    // it separately named makes that pairing visible; folding it into `_helpers`
    // would bury a wire contract inside a utilities bag.
    //
    // Staging is what makes these importable at all: the sandbox stages `/code`
    // from these tables ONLY, so an unstaged module is not a degraded import — it
    // is `ModuleNotFoundError` at process start, surfacing to the server as an
    // opaque job failure with no hint of the cause.
    ("txr_zarr.py", RESERVED_LIB_PACKAGE, "txr_zarr.py"),
    ("txr_columns.py", RESERVED_LIB_PACKAGE, "txr_columns.py"),
    (
        "txr_zarr_read.py",
        RESERVED_LIB_PACKAGE,
        "txr_zarr_read.py",
    ),
    // artifact-model ITEM-27: the out-of-core CSR→CSC transpose that replaced the
    // lossless multi-file store the import converter used to write purely as a transpose
    // BUFFER. It sits in `_lib` beside the writer it drives (`txr_zarr.ArrayWriter`) and
    // holds the same numpy+stdlib floor — h5py is imported lazily, inside the HDF5
    // sources only.
    ("txr_csc.py", RESERVED_LIB_PACKAGE, "txr_csc.py"),
    // #80: the RUN-TIME half of the declared dependency + version contract. It resolves
    // each library the entry DECLARES, refuses by name when the environment this job was
    // actually given does not satisfy that declaration, and returns the record the run
    // carries into provenance.
    //
    // Globally staged rather than per-entry for the same reason the format library is:
    // the contract applies to every python entry that declares one, an entry cannot reach
    // a module in a reserved package through `run.helpers` (those resolve against the
    // entry's OWN package), and an unstaged module is `ModuleNotFoundError` at process
    // start — not a degraded check, an opaque job failure. It sits in `_lib` beside the
    // other contract-shaped modules: like them it encodes an agreement with something
    // outside the process (there, the on-disk artifact format; here, the environment
    // recipe's pin set), rather than being app runtime glue.
    ("txr_deps.py", RESERVED_LIB_PACKAGE, "txr_deps.py"),
];

/// The staged filename of an entry's serialized dependency contract (#80).
///
/// Named here beside the staging tables because that is what makes it resolvable: the
/// python reader looks for this name next to itself in `/code`, and the two names must
/// agree or the reader silently sees "declares nothing". Kept in lockstep with
/// `_lib/txr_deps.py::CONTRACT_FILENAME` by
/// `dependency_contract_filename_matches_the_python_reader`.
pub const DEPENDENCY_CONTRACT_FILE: &str = "txr_dependencies.json";

/// The resolved processor: its language, the script bytes READ FROM THE FOLDER
/// (owned), the DECLARED host resources + sibling helpers, and the owning package.
pub struct ResolvedProcessor {
    pub language: Language,
    /// The script bytes read from `<dir>/<package>/<code_ref>` (owned — folder bytes).
    pub script: Cow<'static, str>,
    /// The named host resources this entry DECLARES it needs mounted (S7). Empty for
    /// an entry that declares none — which is every entry that needs no host data.
    pub host_resources: Vec<HostResourceRequirement>,
    /// `(staged_name, bytes)` for each sibling this entry DECLARES (S6), already read
    /// from the owning package's folder.
    pub helpers: Vec<(String, Vec<u8>)>,
    pub package: String,
}

/// The manifest `run` facts the resolver needs for one `code_ref` — the DATA that
/// replaced the `BUILTINS` table's columns (S6/S7).
#[derive(Debug, Clone, Default)]
pub struct DeclaredRun {
    pub package: Option<String>,
    pub language: Option<Language>,
    pub helpers: Vec<String>,
    pub host_resources: Vec<HostResourceRequirement>,
    /// The libraries this entry declares it imports, each with the version range it is
    /// supported against (#80). Read off the SAME `run` block the fields above come from,
    /// so there is one lookup and no second place a declaration could be missed.
    pub dependencies: Vec<DependencyRequirement>,
}

/// Look the `run` block for a `code_ref` up in the extension registry (S6/S7).
///
/// `package_hint`, when given, restricts the match to that package so two
/// separate-repo packages shipping the same `run.entry` cannot inherit each other's
/// declarations. Empty when the registry is not built (a direct-repo unit context);
/// the resolver then infers the language and declares nothing, which is the honest
/// answer rather than another package's facts.
pub fn declared_run(code_ref: &str, package_hint: Option<&str>) -> DeclaredRun {
    let Some(reg) = crate::modules::extensions::try_registry() else {
        return DeclaredRun::default();
    };
    declared_run_in(&reg, code_ref, package_hint)
}

/// The registry lookup core, over an EXPLICIT registry (the testable seam).
///
/// [`declared_run`] is a thin wrapper that supplies the process-wide singleton. The
/// split exists so a test can build a registry from a temp folder and observe the
/// EXACT `DeclaredRun` a dropped-in package produces — the input to [`resolve_in_with`]
/// that decides which package's bytes run — without swapping a process-wide global out
/// from under every other test in the binary.
pub fn declared_run_in(
    reg: &crate::modules::extensions::ExtensionRegistry,
    code_ref: &str,
    package_hint: Option<&str>,
) -> DeclaredRun {
    for m in reg.all() {
        if package_hint.is_some_and(|p| p != m.id) {
            continue;
        }
        // Both contribution kinds carry a `run` block: a CONVERTER (backend-typed)
        // and an ANALYSIS (FE-owned, read out of its verbatim rest — S6/S7).
        let runs = m
            .contributes
            .converters
            .iter()
            .map(|c| c.run.clone())
            .chain(m.contributes.analyses.iter().filter_map(|a| a.run()));
        for run in runs {
            if run.entry != code_ref {
                continue;
            }
            return DeclaredRun {
                package: Some(m.id.clone()),
                language: Language::from_runtime(&run.runtime),
                helpers: run.helpers.clone(),
                host_resources: run.host_resources.clone(),
                dependencies: run.dependencies.clone(),
            };
        }
    }
    DeclaredRun::default()
}

/// Resolve a `code_ref` to its language + folder-read script bytes + declared run
/// facts, using the process-wide extracted processors folder. Extracts the seed on
/// first use (`embedded::ensure_extracted`, OnceCell-guarded), then delegates to
/// [`resolve_in`]. An unknown `code_ref` (no owning package) is an `Err` (the runner
/// turns it into a clear job failure).
pub fn resolve(code_ref: &str) -> Result<ResolvedProcessor, String> {
    resolve_with_package(code_ref, None)
}

/// Resolve a `code_ref` with the owning PACKAGE threaded from the enqueuing converter /
/// analysis contribution (M3). A bare `code_ref` (e.g. `compute/foo.py`) does not name its
/// package, so two separate-repo packages both shipping `compute/foo.py` were previously
/// disambiguated by an id-sorted-first folder scan — running the WRONG package's compute.
/// The enqueuer knows the owner (the converter's `extension_id` / the analysis' package),
/// so it passes it here and the correct package's file is read.
pub fn resolve_with_package(
    code_ref: &str,
    package: Option<&str>,
) -> Result<ResolvedProcessor, String> {
    let dir = crate::modules::extensions::embedded::ensure_extracted()?;
    // SEED-ONLY (M8): a package HINT can't be used to reach an unmanaged drop-in either.
    if let Some(pkg) = package {
        if crate::modules::extensions::seed_only_enabled()
            && !crate::modules::extensions::embedded::seed_managed_ids().contains(pkg)
        {
            return Err(format!(
                "processor package {pkg:?} is not a seed-managed package (seed-only mode)"
            ));
        }
    }
    resolve_in_with(&dir, code_ref, package, &declared_run(code_ref, package))
}

/// Resolve a `code_ref` against an explicit extracted-processors `dir` (the testable core
/// — no dependency on the real data root, no package hint, no registry). Reads the script
/// bytes FROM THE FOLDER (`<dir>/<package>/<code_ref>`), so an on-disk edit is reflected on
/// the next call.
pub fn resolve_in(dir: &Path, code_ref: &str) -> Result<ResolvedProcessor, String> {
    resolve_in_with(dir, code_ref, None, &DeclaredRun::default())
}

/// The resolution core (M3/S6): `package_hint`, when present + valid, names the OWNING
/// package authoritatively (bypassing the ambiguous folder scan); `declared` carries the
/// manifest `run` facts, which are applied ONLY when they name the SAME package that
/// actually owns the resolved file — so a hint can never inherit another package's
/// runtime declarations.
pub fn resolve_in_with(
    dir: &Path,
    code_ref: &str,
    package_hint: Option<&str>,
    declared: &DeclaredRun,
) -> Result<ResolvedProcessor, String> {
    // Determine the owning package: an explicit (validated) hint wins; else the app's OWN
    // reserved package for a code_ref it owns; else the manifest declaration; else a
    // deterministic folder scan.
    //
    // RESERVED BEATS DECLARED, and the order is security-critical (artifact-model
    // ITEM-18). `declared.package` is a match on ANY registry manifest whose `run.entry`
    // equals this `code_ref`, and the registry scan skips `_`-prefixed dirs — so a
    // `declared.package` hit is ALWAYS a CONTRIBUTED package. With it ahead of the
    // reserved table, a package declaring `entry: verify_conformance.py` had its OWN file
    // resolved as the CONFORMANCE GATE, which the server dispatches by `code_ref` alone
    // (`build_verify_spec` sets no package). A stub emitting `{"violations": []}` then
    // passes every artifact ever ingested, and the framework suite ITEM-18 promises "the
    // processor author can neither write nor weaken" is the processor author's own bytes.
    // The manifest lint rejects such a declaration outright (`validate_parsed`), so the
    // in-repo path is closed too; this ordering is the runtime half, which a drop-in
    // needs no diff at all to reach.
    //
    // The HINT still outranks the reserved table, and that is not the same hole: a hint
    // is an explicit assertion by the CALLER (the enqueuing converter/analysis), it is
    // `guard_package_name`-checked so it can never name a `_`-prefixed reserved package,
    // and the gate's own dispatch passes none. A user naming their own package alongside
    // a reserved `code_ref` runs their own file as their own job — which naming any other
    // `code_ref` already does — and never substitutes the gate.
    let package: String = if let Some(pkg) = package_hint {
        guard_package_name(pkg)?;
        pkg.to_string()
    } else if let Some((_, pkg)) = RESERVED_CODE_REFS.iter().find(|(cr, _)| *cr == code_ref) {
        (*pkg).to_string()
    } else if let Some(p) = declared.package.clone() {
        p
    } else {
        find_owning_package(dir, code_ref)
            .ok_or_else(|| format!("no processor package provides code_ref {code_ref:?}"))?
    };

    // The manifest declarations apply only to THEIR package.
    let applies = declared.package.as_deref() == Some(package.as_str());
    let language = match declared.language.filter(|_| applies) {
        Some(l) => l,
        None => Language::from_code_ref(code_ref)
            .ok_or_else(|| format!("cannot infer a runtime for code_ref {code_ref:?}"))?,
    };
    let host_resources = if applies { declared.host_resources.clone() } else { Vec::new() };

    let script = read_script(dir, &package, code_ref)?;

    // Sibling helpers the entry DECLARES, read from ITS OWN package (S6).
    let mut helpers: Vec<(String, Vec<u8>)> = Vec::new();
    if applies {
        for rel in &declared.helpers {
            let name = Path::new(rel)
                .file_name()
                .and_then(|s| s.to_str())
                .ok_or_else(|| format!("declared helper {rel:?} has no file name"))?
                .to_string();
            helpers.push((name, read_bytes(dir, &package, rel)?));
        }
    }
    // The APP's own cross-cutting helpers. WHICH languages receive them is a STATED
    // contract ([`stages_app_helpers`]), not the shape of the condition that used to be
    // written inline here — see that function for what an R or bash entry gets and why.
    if stages_app_helpers(language) {
        for (name, pkg, rel) in PY_HELPER_FILES {
            helpers.push(((*name).to_string(), read_bytes(dir, pkg, rel)?));
        }
        // …plus anything staged for THIS reserved entry alone (the conformance gate
        // for the verification processor — never for a domain processor's `/code`).
        for (cr, name, pkg, rel) in RESERVED_ENTRY_HELPERS {
            if *cr == code_ref {
                helpers.push(((*name).to_string(), read_bytes(dir, pkg, rel)?));
            }
        }
        // …plus the entry's own DECLARED dependency contract (#80), serialized here and
        // staged like any other file in `/code`.
        //
        // WHY THIS VECTOR and not a new derived input. `helpers` is the one staged set
        // that BOTH the live runner and the reproduce capsule consume — the runner writes
        // every `(name, bytes)` verbatim into the code dir, and the capsule exporter
        // stages exactly `resolved.helpers`. Riding it means a replayed run gets a
        // byte-identical contract with no capsule change and no second code path that
        // could drift from this one. A derived `/inputs` file would have needed to be
        // REGENERATED by the capsule from stored state, which is precisely where a replay
        // stops being faithful.
        //
        // Written UNCONDITIONALLY, `[]` when nothing is declared, so the run-time reader
        // can tell "this entry declares nothing" from "the contract failed to stage" —
        // an absent file and an empty contract must not be the same observation.
        let declared_deps = if applies { declared.dependencies.as_slice() } else { &[] };
        let contract = serde_json::to_vec_pretty(declared_deps)
            .map_err(|e| format!("cannot serialize the declared dependency contract: {e}"))?;
        helpers.push((DEPENDENCY_CONTRACT_FILE.to_string(), contract));
    }

    Ok(ResolvedProcessor {
        language,
        script: Cow::Owned(script),
        host_resources,
        helpers,
        package,
    })
}

/// Does an entry in `language` receive the APP's own cross-cutting helpers — the
/// [`PY_HELPER_FILES`] table, the per-entry [`RESERVED_ENTRY_HELPERS`] rows, and the
/// serialized `run.dependencies` contract ([`DEPENDENCY_CONTRACT_FILE`])?
///
/// **This is a CONTRACT, and it is stated here because it used to be an accident**
/// (epic #169 / E6 / #194, DEC-2). The condition was written inline as
/// `if matches!(language, Language::Python)`, which reads as an implementation detail —
/// and read that way it says nothing about what the OTHER languages get. What they get
/// is: **their own package's declared `run.helpers`, and nothing else.** An R or bash
/// entry is therefore SELF-CONTAINED by contract, not by luck.
///
/// ## Why `false` for R, and what that costs
///
/// [`PY_HELPER_FILES`] is a table of PYTHON MODULES (`txr_zarr.py`, `txr_csc.py`,
/// `txr_columns.py`, …). There is no R substrate in this tree to stage in their place,
/// and writing one is a library-sized commitment — deliberately out of scope for the
/// walking skeleton that first made this question answerable (E6/INV-5). So the honest
/// answer is `false`, **recorded as a deliberate weakening rather than left to be
/// rediscovered** by whoever writes the second R analysis.
///
/// The weakening is BOUNDED, and the bound is the reason it is acceptable: the
/// framework-owned output conformance gate (`packages/_lib/conformance.py`) runs
/// OUTSIDE the processor's process, over the emitted `/outputs` directory, after the job
/// exits — it never imports processor code and it is not staged into `/code`. So it is
/// language-agnostic by construction and an R producer inherits it unchanged. What R
/// lacks is INPUT-side helpers, not output validation.
///
/// ## Why an exhaustive `match` and not `matches!`
///
/// A `matches!` is open at the bottom: a fourth `Language` variant would silently get
/// `false` and nobody would be asked. Here it does not compile until somebody decides —
/// which is the whole difference between a contract and a default.
pub(crate) fn stages_app_helpers(language: Language) -> bool {
    match language {
        Language::Python => true,
        // E6/DEC-2 — stated, not assumed. See the section above.
        Language::Rscript => false,
        // A bash entry is CLI ORCHESTRATION: it invokes a vendor tool and writes
        // `/outputs/manifest.json`. It has no interpreter that could import a python
        // module, so staging one would be dead bytes in `/code`.
        Language::Bash => false,
    }
}

/// Does the shipped-manifest IMPORT-conformance scan cover an entry in `language`?
///
/// The scan (in this module's `#[cfg(test)]` block) reads each shipped entry's SOURCE and
/// asserts every module it imports is either app-staged or declared in its own
/// `run.helpers` — so a processor cannot ship an import that would die with
/// `ModuleNotFoundError` on its first real run. Its module-name grammar is python's
/// (`import x` / `from x `).
///
/// **`false` for a non-python entry means "not yet implemented", NOT "R code needs no
/// import conformance"** (E6/DEC-2). Recording the difference here is the point: the
/// scan's `continue` on a non-python entry previously carried no statement at all, so an
/// R entry's imports being unchecked looked like a decision when it was an omission.
///
/// It is a SEPARATE question from [`stages_app_helpers`] even though both answer `true`
/// only for python today, and they are kept separate on purpose: one is about what the
/// runtime PUTS in `/code`, the other about what a build-time scan READS. Collapsing
/// them would make a future R substrate (which would flip the first) silently flip the
/// second as well, claiming a conformance scan nobody wrote.
#[cfg(test)]
pub(crate) fn import_conformance_scanned(language: Language) -> bool {
    match language {
        Language::Python => true,
        // Not yet implemented for R — see above. E7 (#195) is the item that would need it.
        Language::Rscript => false,
        // A bash entry has no import graph in this sense.
        Language::Bash => false,
    }
}

/// Reject an unsafe package-name HINT (M3/M7): a hint is untrusted (a `jobs::use` user can
/// set `spec.package`). It must be a single normal path component, never a `.`/`_`-prefixed
/// reserved/hidden dir, never a path-escape. `confine_under_package` is the second gate on
/// the resolved file, but rejecting the name lexically here keeps a hint from ever naming a
/// reserved package (`_helpers`) or escaping the processors root.
fn guard_package_name(pkg: &str) -> Result<(), String> {
    use std::path::Component;
    if pkg.trim().is_empty() {
        return Err("empty processor package name".to_string());
    }
    if pkg.starts_with('.') || pkg.starts_with('_') {
        return Err(format!("processor package {pkg:?} may not be a reserved/hidden dir"));
    }
    let p = Path::new(pkg);
    let mut comps = p.components();
    match (comps.next(), comps.next()) {
        (Some(Component::Normal(_)), None) => Ok(()),
        _ => Err(format!("processor package {pkg:?} must be a single, escape-free name")),
    }
}

/// Read `<dir>/<package>/<code_ref>` as UTF-8. `code_ref` must be a `..`/absolute-free
/// relative subpath (the path-injection guard the analysis spec already applies to
/// inputs/outputs — applied here so a hostile `code_ref` can never escape the package
/// dir). A missing/unreadable/non-UTF-8 file is a clear `Err`.
fn read_script(dir: &Path, package: &str, code_ref: &str) -> Result<String, String> {
    let path = confine_under_package(dir, package, code_ref)?;
    std::fs::read_to_string(&path)
        .map_err(|e| format!("read processor script `{}`: {e}", path.display()))
}

/// Read raw bytes for a package-relative file (helper staging). Same containment guard as
/// [`read_script`].
fn read_bytes(dir: &Path, package: &str, rel: &str) -> Result<Vec<u8>, String> {
    let path = confine_under_package(dir, package, rel)?;
    std::fs::read(&path).map_err(|e| format!("read processor file `{}`: {e}", path.display()))
}

/// Resolve `<dir>/<package>/<code_ref>` to a CANONICAL, symlink-free path CONFINED under
/// the TRUSTED processors ROOT `dir` — the security-critical containment gate (H3). The
/// lexical [`guard_relative`] alone is NOT sufficient: a dropped/edited on-disk package
/// whose compute file (or a helper it swaps) is a SYMLINK pointing OUT of the folder would
/// make the SERVER process (full host privilege, this read happens OUTSIDE bwrap) read an
/// arbitrary host file (config with DATABASE_URL/JWT, /etc/shadow, another user's data) and
/// stage its bytes into `/code`. A baked package can never carry such a symlink (the seed
/// extractor materializes real files), so a dropped package would otherwise be STRICTLY more
/// capable than a baked one.
///
/// We confine against the canonicalized PROCESSORS ROOT (`dir`) — NOT the package dir — so a
/// package FOLDER that is itself a DIRECTORY SYMLINK (`<dir>/zzz` → `/`) can't launder the
/// escape: canonicalizing that folder as its own confinement root would resolve to the
/// symlink target and vacuously "contain" any file under it. `dir` (`<data_root>/processors`)
/// is app-created + trusted; every real package file resolves under it, while a symlinked
/// package dir (or a symlinked file inside one) that escapes the root canonicalizes OUTSIDE
/// `canon_root` → REJECTED. `guard_relative(code_ref)` still blocks lexical `..`, so this
/// only broadens containment to "anywhere under the trusted processors root" (a symlink from
/// one package to a sibling processor file is harmless). A missing/unresolvable file errs.
fn confine_under_package(dir: &Path, package: &str, code_ref: &str) -> Result<PathBuf, String> {
    guard_relative(code_ref)?;
    let canon_root = std::fs::canonicalize(dir)
        .map_err(|e| format!("cannot resolve processors root `{}`: {e}", dir.display()))?;
    let target = dir.join(package).join(code_ref);
    let canon_target = std::fs::canonicalize(&target)
        .map_err(|e| format!("cannot resolve processor file `{}`: {e}", target.display()))?;
    if !canon_target.starts_with(&canon_root) {
        return Err(format!(
            "processor file `{}` escapes the processors root (symlink escape rejected)",
            target.display()
        ));
    }
    Ok(canon_target)
}

/// Reject an absolute / `..` / `.` / prefix `code_ref` (defense-in-depth: the resolved
/// path must stay inside the package dir).
fn guard_relative(sub: &str) -> Result<(), String> {
    use std::path::Component;
    let p = Path::new(sub);
    if sub.trim().is_empty() {
        return Err("empty code_ref".to_string());
    }
    if p.is_absolute() || p.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(format!("code_ref {sub:?} must be a relative, escape-free subpath"));
    }
    Ok(())
}

/// Find the package dir under `dir` that ships the file `code_ref` (`<dir>/<pkg>/<code_ref>`
/// exists). Scans in id-sorted order for a deterministic pick; skips `.`-prefixed staging
/// dirs AND `_`-prefixed reserved dirs (M7). A `_`-prefixed dir (e.g. the reserved
/// `_helpers`) is the loader's validation + admin-listing BYPASS (it contributes no
/// datatype/converter and never shows in `GET /api/extensions`), so it MUST NOT be
/// resolvable via an untrusted, arbitrary `code_ref` from a `jobs::use` user — else a
/// dropped `_evil/compute/x.py` would run while dodging the correctness validator and
/// being invisible to an admin auditing "what processors are loaded" (stealth-load). The
/// RESERVED helper compute the app itself runs (`_helpers`'s `demo-analysis.py`, and the
/// `align`/`colsummary`/`multimodal` staged helpers) is resolved through the FIXED
/// [`BUILTINS`] / [`PY_HELPER_FILES`] tables that name the `_helpers` package EXPLICITLY —
/// never through this open scan — so this exclusion does not break the intended helper use.
/// Returns the package id (folder name).
fn find_owning_package(dir: &Path, code_ref: &str) -> Option<String> {
    if guard_relative(code_ref).is_err() {
        return None;
    }
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();
    // SEED-ONLY (M8): in seed-only mode an unmanaged drop-in is never resolvable via an
    // arbitrary `code_ref` either — only baked-seed packages resolve.
    let seed_only: Option<std::collections::HashSet<String>> =
        if crate::modules::extensions::seed_only_enabled() {
            Some(crate::modules::extensions::embedded::seed_managed_ids())
        } else {
            None
        };
    for pkg_dir in dirs {
        let name = pkg_dir.file_name().and_then(|s| s.to_str()).unwrap_or_default();
        if name.starts_with('.') || name.starts_with('_') {
            continue;
        }
        if let Some(managed) = &seed_only {
            if !managed.contains(name) {
                continue;
            }
        }
        if pkg_dir.join(code_ref).is_file() {
            return Some(name.to_string());
        }
    }
    None
}

/// The APP's own cross-cutting Python helpers, read from the RESERVED package and
/// ready to stage into the sandbox code dir. Extracts the seed on first use.
///
/// A PACKAGE's own siblings are NOT here — they ride `ResolvedProcessor::helpers`,
/// read from the declaring package (S6).
pub fn staged_python_helpers() -> Result<Vec<(&'static str, Vec<u8>)>, String> {
    let dir = crate::modules::extensions::embedded::ensure_extracted()?;
    python_helpers_in(&dir)
}

/// The testable core of [`staged_python_helpers`]: read each [`PY_HELPER_FILES`]
/// entry from an explicit extracted-processors `dir`.
pub fn python_helpers_in(dir: &Path) -> Result<Vec<(&'static str, Vec<u8>)>, String> {
    PY_HELPER_FILES
        .iter()
        .map(|(name, pkg, rel)| Ok((*name, read_bytes(dir, pkg, rel)?)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::extensions::embedded;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(0);

    /// A throwaway data dir with the REAL embedded seed extracted into it (via
    /// `embedded::reconcile`), so resolution runs over the SAME folder layout production
    /// scans — WITHOUT mutating `TXR_APP_DATA_DIR` (parallel-safe).
    struct SeedDir(PathBuf);
    impl SeedDir {
        fn new(tag: &str) -> Self {
            let seq = SEQ.fetch_add(1, Ordering::Relaxed);
            let p = std::env::temp_dir()
                .join(format!("txr-proc-resolve-{tag}-{}-{seq}", std::process::id()));
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

    // INV-7 anchor: `resolve_in` reads the script FROM THE FOLDER — the resolved bytes
    // equal the on-disk file bytes (not a baked table) — and an on-disk EDIT is reflected
    // on the next resolve (a re-dropped script runs the new bytes).
    #[test]
    fn resolve_reads_bytes_from_the_folder_and_reflects_edits() {
        let seed = SeedDir::new("folder");
        let dir = seed.path();

        let on_disk = dir.join("qc").join("compute/qc-10x.py");
        let disk_bytes = std::fs::read_to_string(&on_disk).unwrap();

        let r = resolve_in(dir, "compute/qc-10x.py").expect("qc-10x resolves");
        assert_eq!(r.package, "qc");
        assert!(matches!(r.language, Language::Python));
        assert_eq!(r.script.as_ref(), disk_bytes, "resolved bytes == on-disk file bytes");

        // EDIT the on-disk file → resolve returns the NEW bytes (folder-read, not baked).
        let edited = format!("{disk_bytes}\n# EDIT-MARKER-{}\n", uuid::Uuid::new_v4());
        std::fs::write(&on_disk, &edited).unwrap();
        let r2 = resolve_in(dir, "compute/qc-10x.py").expect("qc-10x re-resolves");
        assert_eq!(r2.script.as_ref(), edited, "an on-disk edit is reflected on re-resolve");
        assert!(r2.script.contains("EDIT-MARKER-"));
    }

    // INV-7: a SEPARATE-REPO package (NOT in the metadata table) whose `compute/*.py`
    // lives in the extracted folder resolves + runs from the folder.
    #[test]
    fn separate_repo_package_compute_resolves_from_folder() {
        let seed = SeedDir::new("separate");
        let dir = seed.path();

        // A contributor drops a package with a compute script (no manifest needed for the
        // resolve path — `find_owning_package` scans for the file).
        let pkg = dir.join("my-external-pkg").join("compute");
        std::fs::create_dir_all(&pkg).unwrap();
        let body = "import json\nopen('/outputs/manifest.json','w').write('{}')\n";
        std::fs::write(pkg.join("foo.py"), body).unwrap();

        let r = resolve_in(dir, "compute/foo.py").expect("separate-repo compute resolves");
        assert_eq!(r.package, "my-external-pkg");
        assert!(matches!(r.language, Language::Python));
        assert_eq!(r.script.as_ref(), body, "runs the folder bytes");
        assert!(r.host_resources.is_empty(), "an undeclaring entry asks for no host resource");
    }

    // The APP's own cross-cutting helpers resolve from the RESERVED packages, and the
    // demo analysis resolves through `_helpers`. S6: `multimodal.py` is NO LONGER here
    // — it is the `anndata-import` package's own DECLARED sibling (see
    // `a_declared_sibling_helper_is_staged_from_its_own_package`).
    //
    // artifact-model ITEM-1: this now spans TWO reserved packages, so the assertion is
    // on the staged SET, not on a count. A bare `len()` check answers "how many" when
    // the question that matters is "which" — it passes for any five files, including
    // five copies of the wrong one, and it fails uninformatively the moment a helper is
    // legitimately added. Naming the set makes an accidental removal fail loudly and an
    // intentional addition a one-line, reviewable edit.
    #[test]
    fn app_helpers_resolve_from_the_reserved_packages() {
        let seed = SeedDir::new("helpers");
        let dir = seed.path();

        let helpers = python_helpers_in(dir).expect("helpers stage from the folder");
        let staged: std::collections::BTreeSet<&str> = helpers.iter().map(|(n, _)| *n).collect();
        assert_eq!(
            staged,
            [
                "align.py",
                // The multi-dataset join-quality engine. Its `PY_HELPER_FILES` row landed
                // without this expected set being updated, so the assertion has been red
                // since; corrected here rather than left as a permanently-failing gate
                // nobody reads.
                "alignment.py",
                // #80 — the run-time half of the declared dependency + version contract.
                "txr_deps.py",
                "colsummary.py",
                // From `_lib` — proving the second reserved package resolves. Without
                // these four staged, every processor importing them dies at
                // `ModuleNotFoundError` inside the sandbox, which reaches the server
                // only as an opaque job failure.
                "txr_columns.py",
                "txr_csc.py",
                "txr_zarr.py",
                "txr_zarr_read.py",
            ]
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>(),
            "the app's own helpers, from both reserved packages"
        );
        for (name, bytes) in &helpers {
            assert!(!bytes.is_empty(), "{name} is non-empty");
        }
        let align = &helpers.iter().find(|(n, _)| *n == "align.py").unwrap().1;
        assert_eq!(**align, std::fs::read(dir.join("_helpers/align.py")).unwrap());
        assert!(
            helpers.iter().all(|(n, _)| *n != "multimodal.py"),
            "a DOMAIN package's module is no longer staged globally (S6)"
        );

        // The demo analysis resolves through the RESERVED package from the folder.
        //
        // Asserted as BYTE EQUALITY with the file on disk, the same way `align.py` is
        // above, rather than against content sentinels. It used to look for two literals
        // from the script's output typing — which made this test a certificate for a
        // contributed datatype id sitting in a reserved FRAMEWORK package (INV-5), so
        // removing the leak broke the test that pinned it. Byte equality proves the
        // stronger property the sentinels were standing in for ("the bytes came from the
        // folder, not from the binary") and cannot be invalidated by an edit to the
        // script's contents.
        let demo = resolve_in(dir, "compute/demo-analysis.py").expect("demo resolves");
        assert_eq!(demo.package, RESERVED_HELPER_PACKAGE);
        assert_eq!(
            demo.script.as_ref(),
            std::fs::read_to_string(dir.join("_helpers/compute/demo-analysis.py")).unwrap()
        );
    }

    // artifact-model ITEM-18 / DEC-12: the VERIFICATION PROCESSOR resolves out of the
    // `_lib` reserved package and gets `conformance.py` staged into its `/code` —
    // and NO other entry does.
    //
    // Both halves are load-bearing and neither is provable from the tables by
    // inspection. Without the staging the job dies at `ModuleNotFoundError` before it
    // reads a byte, which reaches the server as an opaque job failure — a gate that
    // never runs while looking, from the outside, exactly like a gate that ran. With
    // GLOBAL staging (the one-line "fix" of adding it to `PY_HELPER_FILES`) the
    // framework's gate would sit inside the `/code` dir of every process it exists to
    // judge, which is what DEC-8 rules out and `_lib/manifest.yaml` forbids in prose.
    #[test]
    fn the_verification_processor_gets_the_gate_staged_and_nothing_else_does() {
        let seed = SeedDir::new("verify");
        let dir = seed.path();

        let verify = resolve_in(dir, VERIFY_CONFORMANCE_CODE_REF)
            .expect("the verification processor resolves from `_lib`");
        assert_eq!(verify.package, RESERVED_LIB_PACKAGE);
        assert!(matches!(verify.language, Language::Python));
        let staged: std::collections::BTreeSet<&str> =
            verify.helpers.iter().map(|(n, _)| n.as_str()).collect();
        assert!(
            staged.contains("conformance.py"),
            "the gate must reach /code or the job dies at ModuleNotFoundError: {staged:?}"
        );
        // …and it is the REAL gate, from `_lib`, not a stub.
        let gate = &verify
            .helpers
            .iter()
            .find(|(n, _)| n == "conformance.py")
            .unwrap()
            .1;
        assert_eq!(
            **gate,
            std::fs::read(dir.join("_lib/conformance.py")).unwrap()
        );
        // The gate imports the reader, so THAT has to be staged too (it is, globally).
        assert!(staged.contains("txr_zarr_read.py"), "{staged:?}");
        assert!(
            verify.script.contains("conform_manifest"),
            "the entry actually drives the gate"
        );

        // NEGATIVE CONTROL: a domain processor's `/code` does NOT receive the gate.
        for cr in [
            "compute/qc-10x.py",
            "compute/cell-filter.py",
            "compute/demo-analysis.py",
        ] {
            let r = resolve_in(dir, cr).unwrap_or_else(|e| panic!("{cr} resolves: {e}"));
            assert!(
                r.helpers.iter().all(|(n, _)| n != "conformance.py"),
                "`{cr}` received the framework gate in its own /code — that puts the \
                 gate inside the process it judges (DEC-8)"
            );
        }
    }

    // S6: a package's OWN sibling module is staged from ITS OWN package because the
    // manifest DECLARES it — replacing the fixed `PY_HELPER_FILES` entry that staged
    // one domain package's `multimodal.py` into EVERY python entry's code dir.
    #[test]
    fn a_declared_sibling_helper_is_staged_from_its_own_package() {
        let seed = SeedDir::new("declared");
        let dir = seed.path();

        let declared = DeclaredRun {
            package: Some("anndata-import".to_string()),
            language: Some(Language::Python),
            helpers: vec!["compute/multimodal.py".to_string()],
            host_resources: Vec::new(),
            dependencies: Vec::new(),
        };
        let r = resolve_in_with(dir, "compute/h5ad_import.py", Some("anndata-import"), &declared)
            .expect("resolves");
        let staged: Vec<&str> = r.helpers.iter().map(|(n, _)| n.as_str()).collect();
        assert!(staged.contains(&"multimodal.py"), "declared sibling staged: {staged:?}");
        // …read from the DECLARING package's own folder.
        let mm = &r.helpers.iter().find(|(n, _)| n == "multimodal.py").unwrap().1;
        assert_eq!(
            **mm,
            std::fs::read(dir.join("anndata-import/compute/multimodal.py")).unwrap()
        );
        // The app's cross-cutting helpers still ride along for a python entry.
        assert!(staged.contains(&"colsummary.py") && staged.contains(&"align.py"), "{staged:?}");

        // A DIFFERENT package resolving with the SAME declaration does NOT inherit it
        // (declarations apply only to their own package).
        let other = resolve_in_with(dir, "compute/qc-10x.py", Some("qc"), &declared).expect("resolves");
        assert!(
            other.helpers.iter().all(|(n, _)| n != "multimodal.py"),
            "a declaration never leaks across packages"
        );
    }

    /// The module names importable from EVERY python entry's `/code` dir (global staging).
    fn globally_staged_modules() -> std::collections::HashSet<&'static str> {
        PY_HELPER_FILES
            .iter()
            .map(|(n, _, _)| n.trim_end_matches(".py"))
            .collect()
    }

    /// The module names the import scan recognizes as LOCAL to this tree, so an `import X`
    /// of one of them is distinguishable from an `import numpy`.
    ///
    /// The ENTRY-SCOPED names are in here, and that is the half the set was missing. Built
    /// from `PY_HELPER_FILES` alone it could not contain `conformance` — so the one module in
    /// this tree that a processor must NEVER import was the one module the scan never looked
    /// for. It is not globally staged and no manifest can declare it (declared siblings are
    /// read from the entry's OWN package, and `..` is rejected), so the moment the name is in
    /// scope the scan's assertion rejects it. Derived from the table rather than named, so a
    /// second entry-scoped helper is covered on sight.
    fn scanned_local_modules() -> std::collections::HashSet<String> {
        let mut local: std::collections::HashSet<String> = std::collections::HashSet::new();
        for (_, _, rel) in PY_HELPER_FILES {
            local.insert(rel.trim_end_matches(".py").to_string());
        }
        local.insert("multimodal".to_string());
        for (_, staged, _, _) in RESERVED_ENTRY_HELPERS {
            local.insert(staged.trim_end_matches(".py").to_string());
        }
        local
    }

    // NEGATIVE CONTROL on the scan's own vocabulary — the part that was broken. A scan is
    // only as good as the names it looks for, and this pins the two facts that make the
    // scan below able to FAIL on a processor reaching the gate: the name is in the scanned
    // set, and it is NOT in the globally-staged set (so being found is a rejection, not an
    // allowance).
    #[test]
    fn the_import_scan_looks_for_the_gate_and_treats_it_as_unreachable() {
        let local = scanned_local_modules();
        let global = globally_staged_modules();
        for (_, staged, _, _) in RESERVED_ENTRY_HELPERS {
            let module = staged.trim_end_matches(".py");
            assert!(
                local.contains(module),
                "`{module}` is entry-scoped-staged but is not in the scanned set, so an entry \
                 importing it is never examined"
            );
            assert!(
                !global.contains(module),
                "`{module}` is in the GLOBAL staging set — it would then be reachable from \
                 every processor's own /code dir, which is what entry-scoping exists to avoid"
            );
        }
        // …and the predicate the scan uses sees the shapes an author would actually write.
        for script in ["import conformance\n", "from conformance import gate\n"] {
            let seen =
                script.contains("import conformance") || script.contains("from conformance ");
            assert!(seen, "the scan's predicate does not see `{script:?}`");
        }
    }

    // S6 — the SHIPPED tree is the gate on the behaviour change this made. Every
    // module a shipped ENTRY imports must be either the entry's own DECLARED sibling
    // or one of the app's globally-staged helpers; otherwise it would hit
    // `ModuleNotFoundError` in the sandbox.
    #[test]
    fn every_shipped_helper_import_is_declared_or_globally_staged() {
        use crate::modules::extensions::types::RunSpec;
        use crate::modules::extensions::ExtensionRegistry;
        let seed = SeedDir::new("imports");
        let dir = seed.path();
        let reg = ExtensionRegistry::build_from_dir(dir).expect("the shipped registry builds");

        let global = globally_staged_modules();
        let local_modules = scanned_local_modules();

        let mut checked = 0usize;
        // E6/#194 — what the scan SKIPS, recorded so the `continue` below is OBSERVED
        // rather than merely present. A predicate nothing consults is the same defect as a
        // guard nothing runs, and the only way to tell them apart is to watch the real
        // loop rather than a re-implementation of it.
        let mut skipped: Vec<(String, String, Language)> = Vec::new();
        for m in reg.all() {
            // BOTH contribution kinds, and the analyses arm is not cosmetic: this loop read
            // `converters` alone, so a package contributing an ANALYSIS could import an
            // unstaged module and the guard said nothing. A real one did — the
            // virtual-dataset-alignment producer imported `alignment`, which was in neither
            // staging table, and would have died at `ModuleNotFoundError` on its first real
            // run while the whole suite stayed green. The entry is what runs in the sandbox;
            // which CONTRIBUTION KIND declared it is irrelevant to whether its imports
            // resolve, so scanning one kind was the hole rather than the design.
            let entries: Vec<(String, RunSpec)> = m
                .contributes
                .converters
                .iter()
                .map(|c| (c.run.entry.clone(), c.run.clone()))
                .chain(
                    m.contributes
                        .analyses
                        .iter()
                        .filter_map(|a| a.run().map(|run| (run.entry.clone(), run))),
                )
                .collect();
            for (entry_ref, run) in &entries {
                // WHICH entries this scan covers is a STATED contract
                // ([`import_conformance_scanned`]): skipping a non-python entry means
                // "R import conformance is not implemented yet", NOT "an R entry needs
                // none" (E6/DEC-2). The bare `matches!` that used to sit here said
                // neither, which is how the omission read as a decision.
                let Some(lang) = Language::from_runtime(&run.runtime) else {
                    continue;
                };
                if !import_conformance_scanned(lang) {
                    skipped.push((m.id.clone(), entry_ref.clone(), lang));
                    continue;
                }
                let Ok(script) = read_script(dir, &m.id, entry_ref) else {
                    continue;
                };
                checked += 1;
                let declared: std::collections::HashSet<String> = run
                    .helpers
                    .iter()
                    .filter_map(|h| {
                        Path::new(h).file_stem().and_then(|s| s.to_str()).map(String::from)
                    })
                    .collect();
                for module in &local_modules {
                    let imported = script.contains(&format!("import {module}"))
                        || script.contains(&format!("from {module} "));
                    if !imported {
                        continue;
                    }
                    assert!(
                        global.contains(module.as_str()) || declared.contains(module),
                        "`{}/{}` imports `{module}`, which is neither an app-staged helper \
                         nor declared in its own `run.helpers` — it would die with \
                         ModuleNotFoundError in the sandbox",
                        m.id,
                        entry_ref
                    );
                }
            }
        }
        // RATCHETED past the pre-change value, and that is the point of the number.
        //
        // This floor was `>= 2` while the shipped tree had exactly 2 python CONVERTER
        // entries — so deleting the `analyses` arm added below (or `a.run()` quietly
        // returning `None` after a schema rename) left `checked == 2` and this test GREEN,
        // restoring the exact hole the arm was added to close. A non-vacuity floor set at
        // the value the old code already reached is not a floor.
        //
        // The tree ships 2 python converters and 6 python analyses, so 6 proves the
        // analyses arm ran. Raising this when the tree grows is correct; lowering it
        // because a change made it fail is the failure it exists to catch.
        assert!(
            checked >= 6,
            "the scan read only {checked} shipped python entries — it must cover ANALYSES \
             as well as converters, and a count at or below the converter total means the \
             analyses arm stopped contributing"
        );

        // ── E6/#194, DEC-2 — the non-python `continue` is a STATED contract, and this is
        // where its BEHAVIOUR is observed: the assertion reads what THIS loop actually
        // collected, not what a re-implementation of the selection would have collected.
        //
        // Be exact about what that does and does not catch. DELETING the branch turns this
        // red. Reverting it to a bare `matches!` with the same semantics does NOT — and
        // cannot, by any behavioural test, because a behaviourally identical refactor is
        // behaviourally identical. What the named predicate buys is legibility and
        // exhaustiveness (a fourth `Language` variant will not compile until somebody
        // decides), and those are properties of the SOURCE, which
        // `the_non_python_staging_and_scan_contracts_are_stated` pins instead. An earlier
        // version of this comment claimed the revert was caught; it is not, and claiming
        // coverage that does not exist is the failure this whole block exists to avoid.
        //
        // Skipping a non-python entry means "R import conformance is NOT IMPLEMENTED",
        // which is a different statement from "an R entry needs none" — see
        // `import_conformance_scanned`.
        let skipped_r: Vec<&(String, String, Language)> = skipped
            .iter()
            .filter(|(_, _, l)| matches!(l, Language::Rscript))
            .collect();
        assert!(
            !skipped_r.is_empty(),
            "the shipped tree declares an `rscript` entry (E6/#194), so the scan must have \
             SKIPPED one — if it skipped none, either the entry is gone or the predicate \
             is no longer consulted. Skipped: {skipped:?}"
        );
        for (pkg, entry, _) in &skipped_r {
            assert!(
                read_script(dir, pkg, entry).is_ok(),
                "`{pkg}/{entry}` was skipped by the import scan, and its source is not even \
                 readable — the skip would then be indistinguishable from a missing file \
                 rather than a stated language decision"
            );
        }
    }

    // ══════ TEST-6 [acceptance] [invariant: INV-4] — epic #169 / E6 / #194, DEC-2 ══════
    //
    // "An R entry stages NO app helpers" is a DECISION, so it is asserted against the
    // SHIPPED tree rather than against a fixture: the assertion is about what the first
    // real R analysis actually receives in `/code`.
    //
    // Both directions live in ONE test on purpose. "R stages nothing" is trivially
    // satisfiable by breaking python too, so the python set is asserted UNCHANGED in the
    // same body — a mutation that empties `PY_HELPER_FILES` fails here, not silently
    // somewhere else.

    /// The name of the R walking-skeleton's entry, DERIVED from the shipped registry
    /// rather than typed: this test is about "the first R analysis", not about a string.
    fn the_shipped_rscript_entry(
        dir: &Path,
    ) -> Option<(String, String, crate::modules::extensions::types::RunSpec)> {
        use crate::modules::extensions::ExtensionRegistry;
        let reg = ExtensionRegistry::build_from_dir(dir).ok()?;
        for m in reg.all() {
            for a in &m.contributes.analyses {
                if let Some(run) = a.run() {
                    if matches!(Language::from_runtime(&run.runtime), Some(Language::Rscript)) {
                        return Some((m.id.clone(), run.entry.clone(), run));
                    }
                }
            }
        }
        None
    }

    #[test]
    fn an_r_entry_stages_only_its_own_declared_helpers_and_python_is_unchanged() {
        let seed = SeedDir::new("rstage");
        let dir = seed.path();

        // ── the subject: the shipped R entry ────────────────────────────────────────
        let (pkg, entry, run) = the_shipped_rscript_entry(dir).expect(
            "the shipped tree declares an `rscript` entry. If this is None the whole test \
             is vacuous — E6/#194 ships `r-skeleton`, and no other assertion below would \
             notice its absence.",
        );
        let declared = DeclaredRun {
            package: Some(pkg.clone()),
            language: Language::from_runtime(&run.runtime),
            helpers: run.helpers.clone(),
            host_resources: Vec::new(),
            dependencies: run.dependencies.clone(),
        };
        let r = resolve_in_with(dir, &entry, Some(&pkg), &declared).expect("the R entry resolves");
        assert!(matches!(r.language, Language::Rscript), "`run.runtime` drives the language");

        let staged: Vec<&str> = r.helpers.iter().map(|(n, _)| n.as_str()).collect();
        let own: Vec<String> = run
            .helpers
            .iter()
            .filter_map(|h| Path::new(h).file_name().and_then(|s| s.to_str()).map(String::from))
            .collect();
        assert_eq!(
            staged,
            own.iter().map(String::as_str).collect::<Vec<_>>(),
            "DEC-2: an R entry receives EXACTLY its own package's declared `run.helpers` \
             and nothing else. Staged: {staged:?}"
        );
        // …stated as the three things it must NOT have, so a future change that adds one
        // of them fails naming which.
        for (name, _, _) in PY_HELPER_FILES {
            assert!(
                !staged.contains(name),
                "the app's python helper `{name}` was staged into an R entry's /code — \
                 `PY_HELPER_FILES` is a table of PYTHON MODULES and R cannot import one"
            );
        }
        assert!(
            !staged.contains(&DEPENDENCY_CONTRACT_FILE),
            "the serialized dependency contract was staged for an R entry. It is a python \
             convention (`txr_deps` reads it); DEC-2 says an R entry is self-contained"
        );

        // ── the control: the python path is UNCHANGED ──────────────────────────────
        //
        // Without this half, "R stages nothing" is satisfied by a mutation that stages
        // nothing for ANYBODY. `qc-10x.py` is a shipped python analysis entry.
        let py = resolve_in(dir, "compute/qc-10x.py").expect("a shipped python entry resolves");
        let py_staged: Vec<&str> = py.helpers.iter().map(|(n, _)| n.as_str()).collect();
        for (name, _, _) in PY_HELPER_FILES {
            assert!(
                py_staged.contains(name),
                "a python entry lost the app helper `{name}` — E6 must not change the \
                 python path at all (INV-1). Staged: {py_staged:?}"
            );
        }
        assert!(
            py_staged.contains(&DEPENDENCY_CONTRACT_FILE),
            "a python entry lost its dependency contract (#80). Staged: {py_staged:?}"
        );
        assert!(
            !PY_HELPER_FILES.is_empty(),
            "the control ranges over an EMPTY table, so it asserts nothing"
        );
    }

    /// TEST-6, second half — the predicates' answers, pinned.
    ///
    /// **What this is, and what it deliberately is NOT.** These six lines restate the
    /// match arms of two exhaustive predicates. On their own that is a tautology: they
    /// would still pass if the call sites stopped consulting the predicates entirely. So
    /// they are NOT the proof that the contract is wired — the proof lives where each
    /// predicate is actually consumed, and each one is named here so a reader does not
    /// mistake this for it:
    ///
    ///   * `stages_app_helpers` is proven by
    ///     `an_r_entry_stages_only_its_own_declared_helpers_and_python_is_unchanged`,
    ///     which resolves the REAL shipped entries through `resolve_in_with` and reads
    ///     what landed in `/code` — for R and for python, in the same body.
    ///   * `import_conformance_scanned` is proven inside
    ///     `every_shipped_helper_import_is_declared_or_globally_staged`, which records
    ///     what the REAL scan loop skipped and asserts the R entry is in it.
    ///
    /// What these lines DO buy: the arms are exhaustive `match`es, so a fourth `Language`
    /// variant will not compile until somebody decides — and this pins the answers that
    /// decision must not silently change.
    #[test]
    fn the_non_python_staging_and_scan_contracts_are_stated() {
        assert!(stages_app_helpers(Language::Python));
        assert!(!stages_app_helpers(Language::Rscript), "E6/DEC-2");
        assert!(!stages_app_helpers(Language::Bash));

        assert!(import_conformance_scanned(Language::Python));
        assert!(
            !import_conformance_scanned(Language::Rscript),
            "R import conformance is NOT IMPLEMENTED — which is a different statement \
             from `an R entry needs none`, and recording the difference is DEC-2's point"
        );
        assert!(!import_conformance_scanned(Language::Bash));
    }

    /// S6 + ROUND-18 (R18-02) — **the set of packages declaring `run.helpers` is the
    /// exact BOUND on a recorded provenance-export gap, so it may not grow silently.**
    ///
    /// The LIVE sandbox stages a declared sibling next to the entry
    /// (`ResolvedProcessor::helpers` → `jobs::runner`). The CAPSULE exporter does NOT:
    /// `provenance::export::bundle` stages [`PY_HELPER_FILES`] alone, through
    /// [`staged_python_helpers`], into ONE shared `scripts/helpers/` that `run.sh`
    /// copies into every Python step's `/code`. So an exported capsule of a run whose
    /// entry imports a DECLARED sibling dies at process start on `ModuleNotFoundError`
    /// — the same failure the helper staging exists to eliminate, one gap class over.
    ///
    /// It is RECORDED rather than fixed because the cheap fix is wrong: adding the
    /// module to the global table (or to the capsule's single shared helpers dir) puts
    /// a specific domain package's module into EVERY Python entry's `/code`, which is
    /// both the cross-package leak S6 removed and — by the rule
    /// `reproduce_script::step_stages_helpers` is written to
    /// (*"putting files in /code that the recorded run never had there is a different
    /// run, not a safer one"*) — a capsule that does not reproduce the recorded run.
    /// The faithful fix is PER-STEP helper staging in the capsule (resolve a step's
    /// `generator_id` → its analysis' `run.helpers`, emit `scripts/helpers/<nn>/`),
    /// which is a bundle-layout change.
    ///
    /// What makes recording it acceptable is that the bound is small and CHECKED. This
    /// test is the check: it fails when a package starts declaring a sibling, so the
    /// gap can never widen without the author being told which capsule it breaks.
    #[test]
    fn the_declared_sibling_set_is_the_recorded_capsule_export_gap_bound() {
        use crate::modules::extensions::ExtensionRegistry;
        let seed = SeedDir::new("declared-siblings");
        let reg =
            ExtensionRegistry::build_from_dir(seed.path()).expect("the shipped registry builds");

        // Both declaration sites: a converter's `run`, and an analysis' `run` (read out
        // of the losslessly-carried `rest`). `anndata-import` declares on BOTH, for the
        // same entry — a set, not a list, so that is one member, not two.
        let mut declared: std::collections::BTreeSet<(String, String)> = Default::default();
        let (mut via_converter, mut via_analysis) = (0usize, 0usize);
        for m in reg.all() {
            for c in &m.contributes.converters {
                for h in &c.run.helpers {
                    via_converter += 1;
                    declared.insert((m.id.clone(), h.clone()));
                }
            }
            for a in &m.contributes.analyses {
                for h in a.run().map(|r| r.helpers).unwrap_or_default() {
                    via_analysis += 1;
                    declared.insert((m.id.clone(), h));
                }
            }
        }
        // BOTH arms must actually see something. They collapse into one SET, so a parse
        // regression in either (an analysis' `run` block rides the losslessly-carried
        // `rest` and is re-typed on demand) would silently shrink the bound this guard
        // measures while the equality below still passed.
        assert!(
            via_converter >= 1 && via_analysis >= 1,
            "the scan is blind on one declaration site (converters: {via_converter}, \
             analyses: {via_analysis})"
        );

        let bound = ("anndata-import".to_string(), "compute/multimodal.py".to_string());
        let expected: std::collections::BTreeSet<(String, String)> =
            [bound].into_iter().collect();
        assert_eq!(
            declared, expected,
            "the set of package-declared sibling helpers changed. The capsule exporter \
             stages only PY_HELPER_FILES, so EVERY member of this set is a run whose \
             exported capsule cannot execute (ModuleNotFoundError at process start). \
             Either teach `provenance::export::bundle` per-step helper staging, or widen \
             this bound DELIBERATELY and record the new member in \
             `.lifecycle/artifact-model/TEST_RESULTS.md`'s left-open section."
        );
    }

    // The 6 seeded domain packages still resolve their compute from the folder (the
    // `_helpers` relocation did not break them), and each writes the outputs manifest.
    #[test]
    fn the_domain_packages_resolve_their_compute() {
        let seed = SeedDir::new("domain");
        let dir = seed.path();
        for cr in [
            "compute/import-h5ad.py",
            "compute/h5ad_import.py",
            "compute/qc-10x.py",
            "compute/cell-filter.py",
            "compute/cellranger.sh",
            "annotation_integrate.py",
        ] {
            let r = resolve_in(dir, cr).unwrap_or_else(|e| panic!("{cr} resolves: {e}"));
            assert!(!r.script.trim().is_empty(), "{cr} has a non-empty folder script");
            assert!(r.script.contains("manifest.json"), "{cr} writes the outputs manifest");
        }
        // An unknown code_ref is a clear Err (no owning package).
        assert!(resolve_in(dir, "compute/does-not-exist.py").is_err());
    }

    // S7: the host-resource requirement is DECLARED by the manifest, so it travels
    // with the resolution — and a resolution WITHOUT a declaration asks for nothing
    // (the server no longer carries a per-package `needs_reference` boolean).
    #[test]
    fn host_resources_come_from_the_declaration_not_from_the_server() {
        let seed = SeedDir::new("refmount");
        let dir = seed.path();

        // No declaration → no host resource (never an inherited/assumed mount).
        for cr in ["compute/qc-10x.py", "compute/cell-filter.py", "compute/demo-analysis.py"] {
            assert!(
                resolve_in(dir, cr).unwrap().host_resources.is_empty(),
                "{cr} declares no host resource"
            );
        }

        // A DECLARED requirement travels through, verbatim.
        let declared = DeclaredRun {
            package: Some("cellranger".to_string()),
            language: Some(Language::Bash),
            helpers: Vec::new(),
            host_resources: vec![HostResourceRequirement {
                name: "reference".to_string(),
                mount_path: "/refdata".to_string(),
            }],
            dependencies: Vec::new(),
        };
        let r = resolve_in_with(dir, "compute/cellranger.sh", Some("cellranger"), &declared)
            .expect("resolves");
        assert_eq!(r.host_resources.len(), 1);
        assert_eq!(r.host_resources[0].name, "reference");
        assert_eq!(r.host_resources[0].mount_path, "/refdata");
        assert!(matches!(r.language, Language::Bash), "run.runtime drives the language");

        // …and it never leaks to a DIFFERENT package resolved with the same declaration.
        let other = resolve_in_with(dir, "compute/qc-10x.py", Some("qc"), &declared).unwrap();
        assert!(other.host_resources.is_empty(), "a declaration is package-scoped");
    }

    // B1 regression backstop, S6-updated: the on-ingest converter imports its
    // `multimodal` + `colsummary` siblings at module scope, so BOTH must reach
    // `/code` or the LIVE converter dies with ModuleNotFoundError. What changed is
    // WHERE each comes from — `colsummary` is app-staged from the reserved package,
    // `multimodal` is the converter's own DECLARED sibling — so this now resolves
    // through the SHIPPED registry rather than a fixed table.
    #[test]
    fn h5ad_import_sibling_imports_are_all_staged() {
        use crate::modules::extensions::ExtensionRegistry;
        let seed = SeedDir::new("siblings");
        let dir = seed.path();
        let reg = ExtensionRegistry::build_from_dir(dir).expect("the shipped registry builds");
        let declared = {
            let m = reg.get("anndata-import").expect("the shipped anndata-import package");
            let run = m
                .contributes
                .converters
                .iter()
                .find(|c| c.run.entry == "compute/h5ad_import.py")
                .expect("its on-ingest converter")
                .run
                .clone();
            DeclaredRun {
                package: Some("anndata-import".to_string()),
                language: Language::from_runtime(&run.runtime),
                helpers: run.helpers.clone(),
                host_resources: run.host_resources.clone(),
                dependencies: run.dependencies.clone(),
            }
        };
        let r = resolve_in_with(dir, "compute/h5ad_import.py", Some("anndata-import"), &declared)
            .expect("resolves");
        let staged: std::collections::HashSet<&str> =
            r.helpers.iter().map(|(n, _)| n.trim_end_matches(".py")).collect();
        for module in ["multimodal", "colsummary"] {
            assert!(
                r.script.contains(&format!("import {module}"))
                    || r.script.contains(&format!("from {module} ")),
                "h5ad_import imports the {module} sibling (test premise)"
            );
            assert!(
                staged.contains(module),
                "{module}.py must reach /code (staged = {staged:?})"
            );
        }
        // The staged multimodal kernel is the real one (carries its INV markers) and
        // came from the DECLARING package's own folder.
        let mm = String::from_utf8(
            r.helpers.iter().find(|(n, _)| n == "multimodal.py").unwrap().1.clone(),
        )
        .unwrap();
        assert!(
            mm.contains("def split_by_feature_types") && mm.contains("def align_barcodes"),
            "the staged multimodal.py is the ingest-correctness kernel, not a stub"
        );
    }

    // A hostile `code_ref` can never escape the package dir.
    #[test]
    fn code_ref_escape_is_rejected() {
        let seed = SeedDir::new("escape");
        let dir = seed.path();
        assert!(resolve_in(dir, "../secret").is_err());
        assert!(resolve_in(dir, "/etc/passwd").is_err());
        assert!(resolve_in(dir, "compute/../../secret").is_err());
    }

    // H3: a SYMLINK inside a package pointing OUT of the package dir is REJECTED — a
    // lexically-clean `code_ref` (no `..`/absolute) that resolves through a symlink to a
    // host file must not be read into `/code`. A dropped package is thus never more
    // capable than a baked one (which can carry no symlink).
    #[cfg(unix)]
    #[test]
    fn symlink_escape_out_of_package_is_rejected() {
        use std::os::unix::fs::symlink;
        let seed = SeedDir::new("symlink");
        let dir = seed.path();

        // A secret host file OUTSIDE the processors folder entirely.
        let secret = seed.path().parent().unwrap().join(format!(
            "txr-secret-{}-{}.txt",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&secret, "DATABASE_URL=postgres://secret").unwrap();

        // A dropped package whose `compute/steal.py` is a SYMLINK to the secret.
        let pkg = dir.join("evil-pkg").join("compute");
        std::fs::create_dir_all(&pkg).unwrap();
        symlink(&secret, pkg.join("steal.py")).unwrap();

        // The lexical guard passes (no `..`/absolute), but the canonical-confine gate
        // rejects the escape → the secret bytes are NEVER read.
        let Err(err) = resolve_in(dir, "compute/steal.py") else {
            panic!("symlink escape must be rejected");
        };
        assert!(
            err.contains("escapes its package dir") || err.contains("symlink escape"),
            "escape is the reason: {err}"
        );

        // A symlink that stays WITHIN the processors root is fine (a legit intra-package alias).
        let real = dir.join("evil-pkg").join("compute").join("real.py");
        std::fs::write(&real, "print('ok')\n").unwrap();
        symlink(&real, dir.join("evil-pkg").join("compute").join("alias.py")).unwrap();
        let ok = resolve_in(dir, "compute/alias.py").expect("intra-package symlink resolves");
        assert_eq!(ok.script.as_ref(), "print('ok')\n");

        let _ = std::fs::remove_file(&secret);
    }

    // H3 (re-audit follow-up): a package FOLDER that is itself a DIRECTORY SYMLINK escaping
    // the processors root is REJECTED — confinement is against the TRUSTED root, so a
    // dropped `zzz -> /outside` dir can't launder an arbitrary host-file read (the earlier
    // per-package-root confine would have canonicalized the symlinked dir into its own
    // vacuous root).
    #[cfg(unix)]
    #[test]
    fn directory_symlink_package_escaping_the_root_is_rejected() {
        use std::os::unix::fs::symlink;
        let seed = SeedDir::new("dirsymlink");
        let dir = seed.path();

        // A host dir OUTSIDE the processors root, holding a file.
        let outside = seed.path().parent().unwrap().join(format!(
            "txr-outside-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(outside.join("compute")).unwrap();
        std::fs::write(outside.join("compute").join("x.py"), "print('escaped')\n").unwrap();

        // A package folder `sneaky` that is a DIRECTORY SYMLINK to the outside dir.
        symlink(&outside, dir.join("sneaky")).unwrap();

        // find_owning_package follows the symlink (is_dir), but the confine gate resolves
        // the target OUTSIDE the processors root → rejected (no host-file read).
        let res = resolve_in(dir, "compute/x.py");
        assert!(
            res.is_err(),
            "a directory-symlink package escaping the processors root must be rejected"
        );

        let _ = std::fs::remove_dir_all(&outside);
    }

    // M3: two separate-repo packages both ship `compute/foo.py`. WITHOUT a package hint
    // the resolver picks the id-sorted-first (ambiguous); WITH the hint the CORRECT
    // package's file is read (the enqueuer's binding wins).
    #[test]
    fn package_hint_disambiguates_shared_code_ref() {
        let seed = SeedDir::new("pkghint");
        let dir = seed.path();
        for (pkg, body) in [("aaa-pkg", "print('AAA')\n"), ("bbb-pkg", "print('BBB')\n")] {
            let d = dir.join(pkg).join("compute");
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("foo.py"), body).unwrap();
        }

        // No hint → id-sorted-first (`aaa-pkg`).
        let no_hint = resolve_in(dir, "compute/foo.py").expect("resolves without hint");
        assert_eq!(no_hint.package, "aaa-pkg");
        assert_eq!(no_hint.script.as_ref(), "print('AAA')\n");

        // Hint → the CORRECT (intended) package's bytes.
        let hinted = resolve_in_with(dir, "compute/foo.py", Some("bbb-pkg"), &DeclaredRun::default()).expect("resolves with hint");
        assert_eq!(hinted.package, "bbb-pkg");
        assert_eq!(hinted.script.as_ref(), "print('BBB')\n");

        // A hint naming a reserved/escaping package is rejected (untrusted-input guard).
        assert!(resolve_in_with(dir, "compute/foo.py", Some("_helpers"), &DeclaredRun::default()).is_err());
        assert!(resolve_in_with(dir, "compute/foo.py", Some("../etc"), &DeclaredRun::default()).is_err());
        assert!(resolve_in_with(dir, "compute/foo.py", Some("a/b"), &DeclaredRun::default()).is_err());
    }

    // M7: a dropped `_`-prefixed package's compute is NOT resolvable via an arbitrary
    // `code_ref` (the loader skips `_`-prefix packages from validation + admin listing, so
    // they must not be executable via the open scan either — closes the stealth-execute
    // path). The RESERVED `_helpers` compute still resolves (via the fixed BUILTINS table).
    #[test]
    fn underscore_prefixed_dropped_package_is_not_resolvable_via_scan() {
        let seed = SeedDir::new("underscore");
        let dir = seed.path();

        // Drop `_evil/compute/x.py` (a stealth package: `_`-prefix dodges the loader
        // validator + admin listing).
        let pkg = dir.join("_evil").join("compute");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(pkg.join("x.py"), "print('evil')\n").unwrap();

        // Not a RESERVED code_ref, and the scan skips `_`-prefix → unresolvable.
        assert!(!RESERVED_CODE_REFS.iter().any(|(cr, _)| *cr == "compute/x.py"));
        assert!(
            resolve_in(dir, "compute/x.py").is_err(),
            "a `_`-prefixed dropped package must not be resolvable via an arbitrary code_ref"
        );

        // The reserved `_helpers` demo still resolves (the RESERVED map, not the scan).
        assert!(resolve_in(dir, "compute/demo-analysis.py").is_ok());
    }

    /// Drop a CONTRIBUTED (scan-visible, non-`_`-prefixed) package into `dir` that
    /// declares `entry` as an analysis `run.entry` and ships a file at that path whose
    /// body is `body`. Returns nothing — the point is the on-disk state the registry
    /// scan and the resolver both see.
    fn drop_contributed_package(dir: &Path, id: &str, entry: &str, body: &str) {
        let pkg = dir.join(id);
        let target = pkg.join(entry);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, body).unwrap();
        std::fs::write(
            pkg.join("manifest.yaml"),
            format!(
                "id: {id}\n\
                 name: {id}\n\
                 publisher: someone-else\n\
                 version: 0.1.0\n\
                 apiVersion: \"1.0\"\n\
                 contributes:\n  \
                 analyses:\n    \
                 - id: {id}.claim\n      \
                 category: demo\n      \
                 title: Claim\n      \
                 appliesTo: []\n      \
                 produces: []\n      \
                 run: {{ kind: sandbox, runtime: python, entry: {entry} }}\n"
            ),
        )
        .unwrap();
    }

    // artifact-model ITEM-18 / DEC-12 — RESERVED-REF PRECEDENCE.
    //
    // The conformance gate's guarantee is that its suite is FRAMEWORK-owned: "the
    // processor author can neither write nor weaken it". The server dispatches it by
    // `code_ref` ALONE (`build_verify_spec` sets no package), so the only thing standing
    // between that dispatch and a contributed package's bytes is which branch of
    // `resolve_in_with` decides the owning package first.
    //
    // It used to be `declared.package` — a match on ANY registry manifest whose
    // `run.entry` equals the code_ref. The registry scan skips `_`-prefixed dirs, so a
    // `declared.package` hit is ALWAYS a contributed package: a drop-in declaring
    // `entry: verify_conformance.py` had ITS OWN file resolved as the verification
    // processor, and a stub emitting `{"violations": []}` passes every artifact ever
    // ingested while the outside is indistinguishable from a gate that ran.
    //
    // The fix has TWO halves and this pins the RESOLVER half on its own, deliberately.
    // The manifest lint (`reserved_run_entry_claim_is_rejected`) now stops such a manifest
    // from ever LOADING, which means a registry-driven reproduction of the hijack would
    // pass for the lint's reason and go on passing if the ordering were reverted. So the
    // hostile `DeclaredRun` is constructed HERE, exactly as the registry lookup would
    // return it, and fed to `resolve_in_with` directly — the arm stays red on an ordering
    // regression whatever the lint does. The lint half is then asserted separately, on the
    // same on-disk drop-in, so neither half can silently stand in for the other.
    //
    // It asserts the substitution on the RESOLVED PACKAGE + the RESOLVED BYTES, because
    // that is what runs: `the_verification_processor_gets_the_gate_staged_and_nothing_else_does`
    // cannot see the hijack (it resolves with no declaration in view), and neither can
    // `conformance.py` itself, which keys on the code_ref and is staged for it either way.
    #[test]
    fn a_contributed_declaration_cannot_claim_a_reserved_code_ref() {
        use crate::modules::extensions::ExtensionRegistry;
        let seed = SeedDir::new("hijack");
        let dir = seed.path();

        const STUB: &str = "# CONTRIBUTED_STUB\nimport json\n\
                            open('/outputs/report.json','w').write('{\"violations\": []}')\n";
        drop_contributed_package(dir, "zzcontrib", VERIFY_CONFORMANCE_CODE_REF, STUB);
        // The claimed file really is on disk, so a resolver that picked `zzcontrib` would
        // SUCCEED and return the stub — the assertion below fails on the substitution
        // itself, never on a missing-file error standing in for it.
        let claimed_file = dir.join("zzcontrib").join(VERIFY_CONFORMANCE_CODE_REF);
        assert!(claimed_file.is_file(), "{}", claimed_file.display());

        // The hostile input: the exact `DeclaredRun` the registry lookup produced for this
        // package before the lint began refusing it.
        let declared = DeclaredRun {
            package: Some("zzcontrib".to_string()),
            language: Some(Language::Python),
            helpers: Vec::new(),
            host_resources: Vec::new(),
            dependencies: Vec::new(),
        };

        // CONTROL: with no claim in view the gate resolves to the framework package.
        let control = resolve_in(dir, VERIFY_CONFORMANCE_CODE_REF).expect("control resolves");
        assert_eq!(control.package, RESERVED_LIB_PACKAGE);
        assert!(control.script.contains("conform_manifest"));

        // THE ASSERTION: the reserved ref wins over the contributed declaration.
        let resolved = resolve_in_with(dir, VERIFY_CONFORMANCE_CODE_REF, None, &declared)
            .expect("the gate still resolves when a package claims its entry");
        assert_eq!(
            resolved.package, RESERVED_LIB_PACKAGE,
            "a contributed package claimed the framework gate's entry and its bytes were \
             resolved as the verification processor"
        );
        assert!(
            !resolved.script.contains("CONTRIBUTED_STUB"),
            "the bytes that would RUN as the gate came from the contributed package"
        );
        assert_eq!(
            resolved.script.as_ref(),
            control.script.as_ref(),
            "the gate runs the framework bytes, claim or no claim"
        );
        // …and the claim's DECLARATIONS are refused with it (`applies` is false), so it
        // cannot stage its own siblings into the gate's `/code` either.
        let staged: Vec<&str> = resolved.helpers.iter().map(|(n, _)| n.as_str()).collect();
        // The generated dependency contract is APP-generated, not claim-supplied: for a
        // refused claim `applies` is false, so what is staged is the EMPTY contract. It
        // belongs on the framework side of this predicate for the same reason
        // `conformance.py` does — and the emptiness is asserted separately below, which is
        // the part that actually proves the claim did not get in.
        let framework_staged = |n: &str| {
            n == "conformance.py"
                || n == DEPENDENCY_CONTRACT_FILE
                || PY_HELPER_FILES.iter().any(|(g, _, _)| *g == n)
        };
        assert!(
            staged.iter().all(|n| framework_staged(n)),
            "the claim's declarations leaked into the gate's code dir: {staged:?}"
        );
        // …and the contract the gate receives is EMPTY — a refused claim cannot smuggle a
        // dependency declaration into the framework entry's `/code` either, which would
        // otherwise let it decide what the gate's own run refuses on.
        let contract = resolved
            .helpers
            .iter()
            .find(|(n, _)| n == DEPENDENCY_CONTRACT_FILE)
            .map(|(_, b)| b.clone())
            .expect("the gate is staged with a contract like any other python entry");
        let parsed: Vec<crate::modules::extensions::types::DependencyRequirement> =
            serde_json::from_slice(&contract).expect("the staged contract parses");
        assert!(
            parsed.is_empty(),
            "a REFUSED claim's dependency declarations reached the framework gate: {parsed:?}"
        );

        // The other reserved entry is covered by the same branch.
        let demo_declared = DeclaredRun {
            package: Some("zzcontrib".to_string()),
            language: Some(Language::Python),
            ..DeclaredRun::default()
        };
        let demo = resolve_in_with(dir, "compute/demo-analysis.py", None, &demo_declared)
            .expect("the demo analysis resolves");
        assert_eq!(demo.package, RESERVED_HELPER_PACKAGE);

        // ── the SECOND half, on the same on-disk drop-in ─────────────────────────────
        // The lint refuses the claim, so the runtime scan SKIPS the package outright and
        // the registry can no longer produce the `DeclaredRun` used above at all. Both
        // halves are asserted because either alone is incomplete: ordering leaves a
        // package able to CLAIM the entry (and to be believed by any future consumer of
        // `declared_run`), the lint leaves nothing between a `DeclaredRun` that arrives by
        // another route and the gate's own dispatch.
        let reg = ExtensionRegistry::build_from_dir(dir).expect("registry builds");
        assert!(
            reg.all().iter().all(|m| m.id != "zzcontrib"),
            "a package claiming a reserved entry must fail the lint and be SKIPPED"
        );
        assert_eq!(
            declared_run_in(&reg, VERIFY_CONFORMANCE_CODE_REF, None).package,
            None,
            "no declaration for a reserved entry can survive the load"
        );

        // ── NEGATIVE CONTROL ────────────────────────────────────────────────────────
        // Reserved-ref precedence must be exactly that, not a blanket demotion of
        // `declared.package`: a contributed package declaring its OWN, non-reserved entry
        // still resolves to itself AND still gets its declarations applied. Without this
        // arm the ordering fix would pass just as well if it broke every contributed
        // package's resolution — which is the entire S6/M3 mechanism.
        const OWN: &str = "# CONTRIBUTED_OWN\n";
        drop_contributed_package(dir, "zzown", "compute/own.py", OWN);
        let reg2 = ExtensionRegistry::build_from_dir(dir).expect("registry rebuilds");
        let own_declared = declared_run_in(&reg2, "compute/own.py", None);
        assert_eq!(own_declared.package.as_deref(), Some("zzown"));
        let own = resolve_in_with(dir, "compute/own.py", None, &own_declared)
            .expect("a contributed package resolves its own entry");
        assert_eq!(
            own.package, "zzown",
            "a non-reserved entry still resolves through the contributed declaration"
        );
        assert_eq!(own.script.as_ref(), OWN);
        assert!(
            !RESERVED_CODE_REFS
                .iter()
                .any(|(cr, _)| *cr == "compute/own.py"),
            "the negative control's entry must not itself be reserved"
        );
    }

    // The two halves of the ITEM-18 fix are enforced by tables in two DIFFERENT
    // compilation units — the resolver's `RESERVED_CODE_REFS` here, and the manifest
    // lint's `RESERVED_ENTRY_CODE_REFS` in `build_helper/processor_manifest.rs`, which
    // `build.rs` compiles before this crate exists and therefore cannot import.
    //
    // A divergence is silent and one-directional in the dangerous direction: adding a
    // reserved entry HERE without adding it there leaves that entry claimable by a
    // manifest again, with the lint reporting nothing. This is the only place both are
    // visible, so it is where the lockstep is pinned (same reason `ROOT_DATATYPE_IDS` is
    // kept in lockstep with `builtin.rs`).
    #[test]
    fn reserved_entry_lint_matches_the_resolver_table() {
        use crate::processor_manifest_lint::RESERVED_ENTRY_CODE_REFS;
        let resolver: std::collections::BTreeSet<&str> =
            RESERVED_CODE_REFS.iter().map(|(cr, _)| *cr).collect();
        let lint: std::collections::BTreeSet<&str> =
            RESERVED_ENTRY_CODE_REFS.iter().copied().collect();
        assert_eq!(
            resolver, lint,
            "the manifest lint's reserved-entry table has drifted from the resolver's — an \
             entry the resolver reserves but the lint does not is claimable by a manifest \
             again"
        );
    }

    // ───────────────── #80 — the declared dependency contract, staged ─────────────────

    /// TEST-10 [covers: ITEM-10, ITEM-11] — every python entry gets the recorder module
    /// AND a contract file, and the contract equals what the entry's manifest declares.
    ///
    /// The `[]`-not-absent clause is the load-bearing one. An entry that declares nothing
    /// must still receive a contract, because the reader has to be able to tell "this
    /// entry declares nothing" from "the contract failed to stage" — collapsing those two
    /// into one observation is how a contract silently stops being enforced.
    #[test]
    fn every_python_entry_is_staged_with_the_recorder_and_its_declared_contract() {
        use crate::modules::extensions::ExtensionRegistry;
        let seed = SeedDir::new("depcontract");
        let dir = seed.path();
        let reg = ExtensionRegistry::build_from_dir(dir).expect("the shipped registry builds");

        let mut checked = 0usize;
        let mut with_declarations = 0usize;
        for m in reg.all() {
            for a in &m.contributes.analyses {
                let Some(run) = a.run() else { continue };
                if run.runtime != "python" {
                    continue;
                }
                let declared = declared_run_in(&reg, &run.entry, Some(&m.id));
                let r = match resolve_in_with(dir, &run.entry, Some(&m.id), &declared) {
                    Ok(r) => r,
                    Err(_) => continue, // an entry this seed does not carry
                };
                checked += 1;

                let staged: std::collections::HashMap<&str, &Vec<u8>> =
                    r.helpers.iter().map(|(n, b)| (n.as_str(), b)).collect();
                assert!(
                    staged.contains_key("txr_deps.py"),
                    "{}: the recorder module is not staged — an unstaged module is not a \
                     degraded check, it is ModuleNotFoundError at process start",
                    run.entry
                );
                let contract_bytes = staged
                    .get(DEPENDENCY_CONTRACT_FILE)
                    .unwrap_or_else(|| panic!("{}: no contract staged", run.entry));
                let parsed: Vec<crate::modules::extensions::types::DependencyRequirement> =
                    serde_json::from_slice(contract_bytes)
                        .unwrap_or_else(|e| panic!("{}: contract is not readable: {e}", run.entry));
                assert_eq!(
                    parsed, run.dependencies,
                    "{}: the STAGED contract must equal what the manifest DECLARES — the \
                     run-time check and the build gate would otherwise be enforcing two \
                     different documents",
                    run.entry
                );
                if !parsed.is_empty() {
                    with_declarations += 1;
                }
            }
        }
        assert!(checked >= 6, "only {checked} python entr(ies) resolved — too few to prove this");
        assert!(
            with_declarations >= 5,
            "only {with_declarations} entr(ies) staged a NON-EMPTY contract; the equality \
             assertion above would be near-vacuous over empty ones"
        );
    }

    /// TEST-18 [covers: ITEM-11] — the contract rides the SAME staged-helpers vector the
    /// reproduce capsule copies.
    ///
    /// This is the property that makes a replayed run faithful for free. The capsule
    /// exporter stages exactly `resolved.helpers`; had the contract been delivered as a
    /// derived input instead, the capsule would have had to REGENERATE it from stored
    /// state, which is precisely where a replay stops matching the run it replays.
    #[test]
    fn the_staged_contract_rides_the_vector_the_capsule_copies() {
        let seed = SeedDir::new("capsuleparity");
        let dir = seed.path();
        let declared = DeclaredRun {
            package: Some("embedding".to_string()),
            language: Some(Language::Python),
            helpers: Vec::new(),
            host_resources: Vec::new(),
            dependencies: vec![crate::modules::extensions::types::DependencyRequirement {
                library: "alpha-tool".to_string(),
                version: ">=1.0".to_string(),
                optional: false,
            }],
        };
        let r = resolve_in_with(dir, "compute/reduce.py", Some("embedding"), &declared)
            .expect("resolves");
        let entry = r
            .helpers
            .iter()
            .find(|(n, _)| n == DEPENDENCY_CONTRACT_FILE)
            .expect("the contract is in `helpers`, which is what the capsule stages");
        let body = String::from_utf8(entry.1.clone()).unwrap();
        assert!(body.contains("alpha-tool"), "the DECLARED contract, verbatim: {body}");
    }

    /// TEST-13 [covers: ITEM-15, ITEM-16] — WIRED-AND-BEHAVING: every shipped entry that
    /// DECLARES a dependency contract actually reaches the code that enforces it.
    ///
    /// A declaration the build gate checks but nothing enforces at run time would satisfy
    /// every structural gate and still leave the run-time half of #80 unbuilt — "exists
    /// and is unit-tested" is not "is used". The reference is followed through the entry's
    /// own package: an entry may invoke the recorder directly, or through a sibling it
    /// declares as a helper (which is where most packages' outputs-manifest writer lives).
    #[test]
    fn every_dependency_declaring_entry_reaches_the_recorder() {
        use crate::modules::extensions::ExtensionRegistry;
        let seed = SeedDir::new("wired");
        let dir = seed.path();
        let reg = ExtensionRegistry::build_from_dir(dir).expect("the shipped registry builds");

        let mut declaring = 0usize;
        for m in reg.all() {
            for a in &m.contributes.analyses {
                let Some(run) = a.run() else { continue };
                if run.dependencies.is_empty() {
                    continue;
                }
                declaring += 1;
                // The ENTRY's own source is the subject, plus the helpers it declares —
                // but the assertion is on an actual CALL, not a mention.
                //
                // The first cut of this test matched the bare substring `txr_deps`
                // anywhere in the entry OR any declared helper. That was HOLLOW twice
                // over: an `import txr_deps` with no call satisfied it, and — the case
                // that actually shipped — an entry could inherit a green result from a
                // helper that calls the recorder in code the entry never reaches. One
                // analysis passed exactly that way while recording nothing at run time.
                // Matching a call expression is what closes both.
                const RECORDING_CALLS: &[&str] = &[
                    "txr_deps.augment(",
                    "txr_deps.record_for_run(",
                    "txr_deps.resolve_and_check(",
                ];
                let mut sources: Vec<(String, String)> = Vec::new();
                for rel in std::iter::once(run.entry.clone()).chain(run.helpers.iter().cloned()) {
                    if let Ok(bytes) = read_bytes(dir, &m.id, &rel) {
                        sources.push((rel, String::from_utf8_lossy(&bytes).into_owned()));
                    }
                }
                // A call must be REACHED, not merely present in the file. Extract the body
                // of a top-level `def`, so a call parked in a function nothing invokes
                // does not satisfy the check — that exact mutation (moving the call out of
                // `write_manifest` into an unused sibling function in the same file)
                // passed the first two versions of this test.
                fn body_of(src: &str, def_line: &str) -> Option<String> {
                    let start = src.find(def_line)?;
                    let rest = &src[start + def_line.len()..];
                    // A top-level def/class at column 0 ends the previous one.
                    let end = rest
                        .match_indices('\n')
                        .find(|(i, _)| {
                            let after = &rest[i + 1..];
                            after.starts_with("def ") || after.starts_with("class ")
                        })
                        .map(|(i, _)| i)
                        .unwrap_or(rest.len());
                    Some(rest[..end].to_string())
                }
                let calls_it = |src: &str| RECORDING_CALLS.iter().any(|c| src.contains(c));
                // In a MODULE body or in the entry's own `main`, a bare presence is enough
                // — those are reached by definition. Anywhere else it must be inside the
                // outputs-manifest writer, which is the function every run passes through.
                let reached = |src: &str| {
                    if let Some(w) = body_of(src, "def write_manifest(") {
                        if calls_it(&w) {
                            return true;
                        }
                    }
                    if let Some(m) = body_of(src, "def main(") {
                        if calls_it(&m) {
                            return true;
                        }
                    }
                    false
                };
                assert!(
                    sources.iter().any(|(_, src)| reached(src)),
                    "analysis `{}` ({}) declares a dependency contract, but nothing in its \
                     entry or its declared helpers CALLS the recorder — a declared contract \
                     nothing enforces at run time is an unfinished feature, not a done one. \
                     Sources searched: {:?}",
                    a.id,
                    run.entry,
                    sources.iter().map(|(r, _)| r.as_str()).collect::<Vec<_>>()
                );
                // …and the entry must REACH it: either it calls the recorder itself, or it
                // calls a shared outputs-manifest writer that does. An entry that merely
                // ships alongside a helper which happens to call it is not wired.
                let (entry_rel, entry_src) = sources
                    .iter()
                    .find(|(rel, _)| *rel == run.entry)
                    .expect("the entry's own source is readable");
                let writes_through_shared_writer = entry_src.contains("write_manifest(")
                    && sources.iter().any(|(rel, src)| {
                        rel != entry_rel
                            && body_of(src, "def write_manifest(")
                                .is_some_and(|w| calls_it(&w))
                    });
                assert!(
                    reached(entry_src) || writes_through_shared_writer,
                    "analysis `{}`: its entry `{}` neither calls the recorder nor commits \
                     its outputs through a declared helper's `write_manifest` that does — \
                     so the staged contract is dead bytes for this entry",
                    a.id,
                    run.entry
                );
            }
        }
        assert!(
            declaring >= 8,
            "only {declaring} declaring analys(es) found — the assertion above would be \
             near-vacuous; the shipped tree is expected to declare what its compute imports"
        );
    }

    /// The two names that must agree across the language boundary: the staged filename the
    /// server writes and the one the python reader looks for. A divergence here is silent
    /// — the reader would simply find no contract and conclude the entry declares nothing.
    #[test]
    fn dependency_contract_filename_matches_the_python_reader() {
        let seed = SeedDir::new("filename");
        let src = std::fs::read_to_string(seed.path().join("_lib/txr_deps.py"))
            .expect("the recorder module ships in the reserved package");
        assert!(
            src.contains(&format!("CONTRACT_FILENAME = \"{DEPENDENCY_CONTRACT_FILE}\"")),
            "the python reader's contract filename has drifted from the server's `{DEPENDENCY_CONTRACT_FILE}`"
        );
        // …and the reserved output id the recorder writes must be the one the provenance
        // recorder looks for, for the same reason.
        assert!(
            src.contains(&format!(
                "OUTPUT_ID = \"{}\"",
                crate::modules::provenance::recorder::RUN_ENVIRONMENT_OUTPUT_ID
            )),
            "the python recorder's output id has drifted from the one provenance reads"
        );
    }
}
