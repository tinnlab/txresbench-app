//! The wire analysis-spec an `analysis` job carries in `Job.params` (JSONB), its
//! parse/validate codec, and the path-injection guard (ITEM-13 / DEC-H, DEC-I).
//!
//! Pure + unit-testable — no filesystem/DB access. The runner
//! (`jobs::runner::SandboxJobRunner`) turns a validated `AnalysisSpec` +
//! materialized inputs into the path-agnostic `backend::ComputeSpec`.

use serde::{Deserialize, Serialize};
use txresbench_core::AppError;

use super::backend::{PriorityClass, ResourceClass};
use super::types::ExtraMountDecl;

/// The analysis script's language (determines the entry filename + interpreter).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Language {
    Python,
    Rscript,
    /// A shell entry (`bash /code/entry.sh`) for CLI-orchestration processors
    /// (Cell Ranger, bcl-convert). A bash entry still writes `/outputs/manifest.json`
    /// like any other language (ITEM-5b / DEC-10).
    Bash,
}

impl Language {
    /// The fixed in-sandbox entry filename (`/code/entry.<ext>`).
    pub fn entry_filename(self) -> &'static str {
        match self {
            Language::Python => "entry.py",
            Language::Rscript => "entry.R",
            Language::Bash => "entry.sh",
        }
    }

    /// The interpreter invocation for the mounted entry script.
    pub fn command_for(self, sandbox_path: &str) -> String {
        match self {
            Language::Python => format!("python3 {sandbox_path}"),
            Language::Rscript => format!("Rscript {sandbox_path}"),
            Language::Bash => format!("bash {sandbox_path}"),
        }
    }

    /// The provenance code-blob language tag (`code_blobs.language`).
    pub fn as_str(self) -> &'static str {
        match self {
            Language::Python => "python",
            Language::Rscript => "r",
            Language::Bash => "bash",
        }
    }

    /// The language a manifest `run.runtime` names (`python` / `r` / `rscript` /
    /// `bash` / `sh`), case-insensitively. `None` for a runtime this build cannot
    /// execute — the resolver then falls back to the file extension rather than
    /// guessing an interpreter.
    pub fn from_runtime(runtime: &str) -> Option<Self> {
        match runtime.trim().to_ascii_lowercase().as_str() {
            "python" | "python3" | "py" => Some(Language::Python),
            "r" | "rscript" => Some(Language::Rscript),
            "bash" | "sh" => Some(Language::Bash),
            _ => None,
        }
    }

    /// Infer the language of a folder-discovered `code_ref` from its file extension
    /// (`.py`→Python, `.R`/`.r`→Rscript, `.sh`→Bash). The fallback when the manifest
    /// declares no usable `run.runtime` (or no manifest was found — a raw dropped
    /// script). `None` for an unrecognized extension.
    pub fn from_code_ref(code_ref: &str) -> Option<Self> {
        match std::path::Path::new(code_ref)
            .extension()
            .and_then(|e| e.to_str())
        {
            Some("py") => Some(Language::Python),
            Some("R") | Some("r") => Some(Language::Rscript),
            Some("sh") => Some(Language::Bash),
            _ => None,
        }
    }
}

/// The resolved entry to execute: the language + the script BODY + the DECLARED
/// host resources + the DECLARED sibling helpers. An inline `script` resolves to
/// itself (with the spec's declared `language`); a `code_ref` resolves to a
/// folder-discovered processor (`sandbox::processors`) whose bytes are READ FROM
/// THE EXTRACTED FOLDER (`<data_root>/processors/<package>/<code_ref>`) and whose
/// language is authoritative. Produced by [`AnalysisSpec::resolve_entry`] and
/// consumed by BOTH the runner (stage + exec) and the provenance recorder (hash the
/// executed code), so the bytes RUN are exactly the bytes RECORDED (reproduce).
///
/// `script` is a `Cow<'static, str>` (not `&str`): a folder-read script is owned
/// `String` bytes, while an as-yet-unused all-`&'static` path stays borrow-free —
/// `Cow` covers both without forcing a lifetime through every call site.
pub struct ResolvedEntry {
    pub language: Language,
    pub script: std::borrow::Cow<'static, str>,
    /// The named host resources the entry's manifest DECLARES (S7). Empty for an
    /// inline script (no manifest declares it) and for an entry that needs none.
    pub host_resources: Vec<crate::modules::extensions::types::HostResourceRequirement>,
    /// `(staged_name, bytes)` for the helper modules staged into the code dir
    /// alongside the entry — the entry's DECLARED package siblings (S6) plus the
    /// app's own cross-cutting helpers.
    pub helpers: Vec<(String, Vec<u8>)>,
}

/// A reference to a dataset's per-axis entity-INDEX `metadata-column` artifact
/// (ITEM-12 / DEC-7) — resolved at RUN time (in [`super::inputs::materialize_inputs`])
/// to the `metadata-column` artifact scoped to `dataset_id` that DECLARES itself the
/// axis index: `meta @> '{"is_axis_index": true}'` AND `structure->>'axis'`. It is the
/// small per-axis index the supporting-file integrate converter aligns an
/// annotation-table against, rather than the primary store — so a run reads one index
/// instead of materializing the whole matrix.
///
/// Three claims here were stale until 2026-07-29 and are corrected above: it is not
/// keyed on `output_id == "<axis>_index"` (that spelling is incidental and nothing
/// queries it — INV-3 makes an axis's identity its key artifact's `content_hash`, never
/// a name); it is not "single-file" (ITEM-26 made an axis index a Zarr STORE, i.e. a
/// staged directory); and it named a specific third-party store format as the thing it
/// avoids materializing, which ITEM-27/28 removed from the tree entirely — the primary
/// store is whatever the artifact's own `structure` declares.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DatasetAxisIndexRef {
    /// The dataset whose axis index to resolve.
    pub dataset_id: uuid::Uuid,
    /// The entity axis name (an `AxisSpec.name`, e.g. `cells`/`genes`).
    pub axis: String,
}

/// How a binding was CHOSEN (ITEM-17 / INV-1) — `user` (a person picked this value)
/// or `auto` (the system bound it, e.g. because exactly one candidate existed and the
/// package declared `auto_bind_sole_candidate`).
///
/// Deliberately fieldless and closed: there are exactly TWO values (DEC-3). A view
/// spec's declared `default:` is NOT a third — it is authored by the package and
/// visible in the form before anyone touches it, which is consent; sole candidacy is
/// not.
///
/// **An unknown string is a PARSE ERROR, not a default.** serde's default enum
/// handling is what gives us that for free, and it is load-bearing: silently mapping
/// an unrecognised origin onto `user` would fabricate a review that never happened,
/// and onto `auto` would fabricate an accusation. Either way the record would assert
/// something nobody observed, which is the exact failure this field exists to prevent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BindingOrigin {
    /// A person wrote this binding (INV-5: a user write resolves the origin to `user`,
    /// whatever it was before — re-picking an auto-bound input IS the review).
    User,
    /// The system bound it; nobody reviewed the choice.
    Auto,
}

impl BindingOrigin {
    /// The wire spelling, for carriers that store the origin as a plain string
    /// (`UsedEdgeDto.bound_by` → `provenance_run_repro.inputs_json` → the exported
    /// bundle). One conversion, so the two sides cannot come to disagree about the
    /// vocabulary.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Auto => "auto",
        }
    }
}

/// One declared input the host materializes read-only into the sandbox.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InputDecl {
    /// A logical slot name (e.g. `expression`).
    pub slot: String,
    /// A P1 catalog artifact id to resolve → a content-addressed blob. A
    /// SINGLE-file artifact stages one file; a MULTI-file artifact (Zarr dir /
    /// BAM+bai) stages its whole prefix as a directory (ITEM-5).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_ref: Option<uuid::Uuid>,
    /// A txresbench-file `files.id` — one file of a Dataset. A dataset's one-or-many
    /// files are declared as one `dataset_file_ref` input each (with distinct
    /// `sandbox_subpath`s). Its `inputs.json` kind is `dataset-file` (ITEM-5 /
    /// DEC-13).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dataset_file_ref: Option<uuid::Uuid>,
    /// A dataset's per-axis entity-INDEX artifact (ITEM-12 / DEC-7) — resolved at
    /// run time to the `metadata-column` artifact scoped to the dataset for this
    /// axis, then staged single-file. The supporting-file integrate converter binds
    /// it at slot `axis_index`. `inputs.json` kind is `artifact` (it resolves to a
    /// catalog artifact).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dataset_axis_index: Option<DatasetAxisIndexRef>,
    /// A host path (the transition/test form — a trusted server-side path only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_path: Option<String>,
    /// A `drafts.id` — a draftable entity consumed as an input (draftable-entity
    /// ITEM-8 / INV-4). An `open` draft is NEVER staged unpinned: the run-input
    /// resolver FREEZES it first (running its `draftable.freeze` producer to
    /// completion) and substitutes the minted `frozen_artifact_id` into `artifact_ref`
    /// BEFORE materialization, so by the time this reaches the sandbox it has already
    /// become a content-addressed `artifact_ref`. This is the mechanical guard against
    /// doc-17's "figure that lies" — there is no content hash to depend on until freeze.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub draft_ref: Option<uuid::Uuid>,
    /// The `/inputs`-relative subpath to bind at (e.g. `donor_meta.csv`).
    ///
    /// **Only honoured for an input the runner cannot name from an ARTIFACT** —
    /// `dataset_file_ref` and `host_path`. Those are USER FILES: the importer is the
    /// one step whose input genuinely is a file of unknown format, and it detects that
    /// format from the uploaded filename, so the basename must survive into `/inputs`.
    ///
    /// For an ARTIFACT-backed input (`artifact_ref` / `dataset_axis_index`) this field
    /// is **ignored**: ITEM-23 / DEC-9 make the mount name a FIXED derivation from the
    /// artifact ([`derive_artifact_mount_name`]), with no operator or manifest knob.
    /// It was a manifest string (`run: { inputs: { matrix: matrix.<ext> } }`) whose only
    /// job was to let a compute sniff its input's format off the suffix — a property of
    /// the ARTIFACT, which already states it (`is_multifile` + `structure.encoding`).
    /// The shipped declaration was in fact WRONG: the artifact it named is a MULTI-FILE
    /// Zarr store, so `matrix.<ext>` named a DIRECTORY as a single-file blob.
    ///
    /// `#[serde(default)]` (empty ⇒ "not declared") rather than `Option<String>`, so a
    /// caller that omits it parses while every existing construction site keeps
    /// compiling. An empty value falls back to the slot.
    #[serde(default)]
    pub sandbox_subpath: String,
    /// **ITEM-17 / INV-1** — how this binding was CHOSEN, carried from the client that
    /// declared it (`AnalysisSpec.inputs[].bound_by`) into the run's provenance record.
    ///
    /// `None` means UNSTATED, and unstated is a third state that is neither value: a
    /// caller that predates this field, or one that has no origin to report (an
    /// `inputs_from` binding resolves out of catalog data no picker writes). It is
    /// NEVER defaulted to `user` — that would assert a review nobody performed — and
    /// never to `auto` (DEC-7: no backfill, absent stays absent).
    ///
    /// `#[serde(default, skip_serializing_if = "Option::is_none")]` so every spec
    /// recorded before this field parses unchanged, and every existing serialization
    /// is byte-identical (a re-run spec stashed in `rerun_spec_json` must not shift
    /// bytes just because the struct grew a field).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bound_by: Option<BindingOrigin>,
}

impl InputDecl {
    /// Whether this input resolves to a catalog ARTIFACT — the case whose mount name
    /// the runner DERIVES (ITEM-23). The two non-artifact kinds are user files whose
    /// declared basename is load-bearing (see [`InputDecl::sandbox_subpath`]).
    pub fn is_artifact_backed(&self) -> bool {
        self.artifact_ref.is_some() || self.dataset_axis_index.is_some()
    }

    /// The mount name for a NON-artifact input: its declared subpath, else the slot.
    /// (The declared value is already path-injection-validated at parse time; the slot
    /// fallback is sanitized, since a slot is free-form caller input.)
    pub fn declared_mount_name(&self) -> String {
        let declared = self.sandbox_subpath.trim();
        if declared.is_empty() {
            sanitize_path_component(&self.slot)
        } else {
            declared.to_string()
        }
    }
}

/// The `/inputs`-relative mount NAME an ARTIFACT-backed input is staged under
/// (ITEM-23 / DEC-9) — **derived from the artifact, never from a declared string**.
///
/// ```text
/// <sanitized slot><store suffix>
/// ```
///
/// * the **stem** is the input's SLOT — the logical name the run already resolves by
///   (`/inputs/inputs.json`'s `slot` key, which every compute reads through
///   `load_inputs_index`). Sanitized, because a slot is free-form caller input and
///   now decides a path; the result is always a single `/inputs`-relative component.
/// * the **suffix** names the store form the artifact DECLARES, read off
///   `structure.encoding`. Today's one entry is `zarr_v3` ⇒ `.zarr`. Anything else
///   gets no suffix — an opaque blob makes no format claim, so neither does its name.
///
/// **The suffix reads the DECLARATION, not `is_multifile`**, although DEC-9 names
/// both. `is_multifile` decides the staged FORM — a multi-file artifact's whole prefix
/// becomes a directory, a single blob becomes a file
/// (`inputs::stage_resolved_artifact`) — and that is the half of DEC-9 it owns. Letting
/// it also gate the NAME would split the derivation into two disagreeing halves: the
/// post-ingest conformance gate stages every artifact it is about to check under a
/// name it computes from the DECLARATION alone (`jobs::conformance::GateTarget`), and
/// a name that additionally consulted the row's `is_multifile` would send the checker
/// looking for `/inputs/<id>` while the runner staged `/inputs/<id>.zarr`, condemning
/// every conforming Zarr artifact in the system. A single-file artifact declaring
/// `zarr_v3` therefore still mounts as `<slot>.zarr` — a file wearing a store name,
/// which is precisely the disagreement the gate exists to catch and condemn, surfaced
/// rather than papered over.
///
/// **`datatype` is deliberately NOT consulted**, though DEC-9 lists it. A datatype id
/// belongs to a CONTRIBUTED package (`<pkg>/<type>`), and mapping one to a file extension
/// would put that package's vocabulary back inside the core — the exact domain-in-the-
/// loader defect this change removes (INV-5), and the reason the sandbox suite's own
/// fixtures refuse to name a domain type. `structure.encoding` is a
/// core-owned, gate-verified fact and is sufficient.
///
/// Pure — the unit tests below drive it directly.
pub fn derive_artifact_mount_name(slot: &str, structure: &serde_json::Value) -> String {
    let stem = sanitize_path_component(slot);
    let suffix = match structure.get("encoding").and_then(|e| e.as_str()) {
        Some("zarr_v3") => ".zarr",
        _ => "",
    };
    format!("{stem}{suffix}")
}

/// Reduce a free-form string to ONE safe `/inputs`-relative path component: keep
/// `[A-Za-z0-9._-]`, map everything else to `_`, drop leading dots (no hidden files,
/// no `.`/`..`), cap the length. Never empty — an unusable input yields `input`.
///
/// This is what makes a caller-supplied SLOT safe to build a path from now that it
/// does. `validate_subpath` still guards the result (belt and braces) at the one call
/// site that turns a name into a host path.
pub fn sanitize_path_component(raw: &str) -> String {
    let mut out: String = raw
        .trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    while out.starts_with('.') {
        out.remove(0);
    }
    out.truncate(100);
    if out.is_empty() || out.chars().all(|c| c == '.') {
        return "input".to_string();
    }
    out
}

/// The requested scheduling class + resources (all optional; the server clamps).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScheduleDecl {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub class: Option<String>,
    /// Requested CPU cores (clamped DOWN to the admin ceiling).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu: Option<i64>,
    /// Requested memory bytes (clamped DOWN to the admin ceiling).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mem_bytes: Option<i64>,
}

/// One output a spec DECLARES it may produce — a capability claim, not an artifact.
///
/// It deliberately does NOT carry `structure`/`meta`, and that is the difference
/// between this type and [`super::outputs::OutputEntry`], which it used to share.
/// `structure` says HOW TO DECODE THE BYTES; at declaration time there are no bytes,
/// so requiring it here would force every spec to invent a decode contract for output
/// it has not produced — a fiction, and exactly the "declare something you do not know"
/// that INV-2 exists to prevent. The RUN's `/outputs/manifest.json` is authoritative
/// (A1), and THAT is where the declarations are required and enforced.
///
/// Sharing one struct for both meanings is why making `structure` required on the
/// emitted-artifact type silently broke every spec: serde cannot tell a claim from a
/// result when they are the same type.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OutputDecl {
    pub id: String,
    pub datatype: String,
    /// Validated to stay under `/outputs` — the only field any consumer reads today.
    pub path: String,
    pub layout: String,
    /// A spec-time tier CLAIM. It keeps a serde default where
    /// [`super::outputs::OutputEntry::role`] deliberately does not, for the same
    /// reason `structure`/`meta` are absent here: nothing acts on this value. The
    /// promote gate reads `artifacts.role`, which is written from the RUN's
    /// `/outputs/manifest.json` (A1, authoritative) — so an omitted role here cannot
    /// resolve to a privileged tier, because it never reaches a decision. Requiring
    /// it would only force every spec to restate, at declaration time, something the
    /// manifest must state again anyway.
    #[serde(default)]
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub axis: Option<String>,
    #[serde(default)]
    pub hidden: bool,
}

/// The full analysis spec parsed from `Job.params`.
// No `Eq` — `params` is a `serde_json::Value` (not `Eq`); `PartialEq` still
// backs the `assert_eq!` unit tests.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AnalysisSpec {
    pub language: Language,
    /// The entry script body (DEC-H transition form — staged at `/code/entry.*`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub script: Option<String>,
    /// A content-addressed code-blob ref (P4 store — future; mutually exclusive
    /// with `script`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code_ref: Option<String>,
    /// The owning PACKAGE id (M3) — threaded from the enqueuing converter/analysis
    /// contribution so a bare `code_ref` (e.g. `compute/foo.py`) resolves in the CORRECT
    /// package even when two separate-repo packages ship the same path. Optional: a
    /// seeded `code_ref` is unambiguous via the `BUILTINS` table, and `None` falls back to
    /// the deterministic folder scan. Ignored for an inline `script`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package: Option<String>,
    #[serde(default)]
    pub inputs: Vec<InputDecl>,
    /// Declared outputs (the canonical `OutputEntry` shape — informational at
    /// submit; the RUN's `/outputs/manifest.json` is authoritative — A1).
    #[serde(default)]
    pub produces: Vec<OutputDecl>,
    #[serde(default)]
    pub schedule: ScheduleDecl,
    /// Read-only reference mounts (ITEM-5c / DEC-11): admin-allowlisted host paths
    /// bound RO (e.g. a large read-only reference bundle), NOT copied+hashed as
    /// inputs. Empty for a normal run.
    #[serde(default)]
    pub extra_mounts: Vec<ExtraMountDecl>,
    /// CPU-arch compatibility (ITEM-26 / DEC-29) — e.g. `["x86_64"]` or
    /// `["x86_64","aarch64"]`. **Empty ⇒ all arches** (existing processors are
    /// unaffected). This field only CARRIES the declared arches; the scheduler
    /// arch-refuse gate is a later, separate change.
    #[serde(default)]
    pub arch: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_secs: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed: Option<i64>,
    /// The processor's params (e.g. `thresholds` / `min_genes`) — an opaque JSON
    /// object the runner writes to `/inputs/params.json` for the entry script to
    /// read (with `seed` merged in). Defaults to `{}`. WITHOUT this the FE's
    /// `spec.params` was silently dropped at parse and the script ran with
    /// defaults only (ITEM-18 last mile).
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub params: serde_json::Value,
    /// The producing analysis id (e.g. `demo.dependent`) — the FE registry id of the analysis
    /// that launched this run. Recorded as the provenance run node's `generator_id` so the
    /// review's "Re-run" affordance (ITEM-63) can resolve the analysis back out of the node.
    /// Optional for back-compat (an absent value records the legacy `"analysis"` placeholder).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub analysis_id: Option<String>,
    /// The env image THIS job runs inside (#189).
    ///
    /// **How it gets here differs by path, and the difference matters:**
    /// * A SERVER-BUILT spec (the on-ingest / on-integrate converter paths, the draft
    ///   freeze producer) sets it directly from the contribution it just resolved, so a
    ///   converter's declared env reaches its run.
    /// * A CLIENT-SUPPLIED spec has it re-derived from the registry for the named
    ///   `analysis_id` (`with_declared_env`), and dropped when there is no `analysis_id`
    ///   to derive from — which is the case for a client-submitted converter-shaped spec.
    ///   Such a spec carries no declaration to honour (it names no contribution), so it
    ///   falls back to the deployment default rather than to whatever the caller sent.
    ///
    /// **Server-derived, never caller-chosen (DEC-4).** `POST /jobs` and
    /// `POST /datasets/{id}/process` accept a client-supplied spec, and the env registry
    /// is deliberately OPEN — any well-formed id resolves to its own image repo, with no
    /// allowlist. A trusted `env` from a request body would therefore let a caller point
    /// their run at any image the registry serves. The enqueue path overwrites this with
    /// the value the registry declares for the named `analysis_id`; see
    /// `enforce_declared_env`.
    ///
    /// `None` ⇒ the deployment default, i.e. byte-identical to pre-#189 behaviour (INV-1).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<String>,
}

fn invalid(msg: impl Into<String>) -> AppError {
    AppError::bad_request("ANALYSIS_SPEC_INVALID", msg.into())
}

impl AnalysisSpec {
    /// Parse + validate an analysis spec from a `Job.params` value. Rejects a
    /// spec with neither/both `script` and `code_ref`, and any input whose
    /// `sandbox_subpath` escapes `/inputs` (path-injection guard).
    pub fn parse(params: &serde_json::Value) -> Result<Self, AppError> {
        let spec: AnalysisSpec = serde_json::from_value(params.clone())
            .map_err(|e| invalid(format!("malformed analysis spec: {e}")))?;
        spec.validate()?;
        Ok(spec)
    }

    fn validate(&self) -> Result<(), AppError> {
        match (self.script.as_ref(), self.code_ref.as_ref()) {
            (Some(s), None) if !s.trim().is_empty() => {}
            (None, Some(r)) if !r.trim().is_empty() => {}
            (Some(_), Some(_)) => {
                return Err(invalid(
                    "exactly one of `script` or `code_ref` may be set, not both",
                ))
            }
            _ => {
                return Err(invalid(
                    "an analysis spec needs a non-empty `script` or `code_ref`",
                ))
            }
        }
        for input in &self.inputs {
            // Exactly one source per input: an artifact ref (single or multi-file),
            // a dataset (txresbench-file) file ref, a dataset axis-index ref, or a trusted
            // host path.
            let n_sources = [
                input.artifact_ref.is_some(),
                input.dataset_file_ref.is_some(),
                input.dataset_axis_index.is_some(),
                input.host_path.is_some(),
                input.draft_ref.is_some(),
            ]
            .iter()
            .filter(|present| **present)
            .count();
            if n_sources == 0 {
                return Err(invalid(format!(
                    "input slot {:?} declares no source (need one of artifact_ref, dataset_file_ref, dataset_axis_index, host_path, draft_ref)",
                    input.slot
                )));
            }
            if n_sources > 1 {
                return Err(invalid(format!(
                    "input slot {:?} declares multiple sources (exactly one of artifact_ref, dataset_file_ref, dataset_axis_index, host_path, draft_ref)",
                    input.slot
                )));
            }
            // A DECLARED subpath is still path-injection-guarded. An empty one is now
            // legal (ITEM-23: an artifact-backed input names its own mount, and a
            // non-artifact input falls back to its slot), so the guard is applied only
            // to a value the caller actually supplied — never relaxed for one that is.
            if !input.sandbox_subpath.trim().is_empty() {
                validate_subpath(&input.sandbox_subpath, "input sandbox_subpath")?;
            }
        }
        // Declared outputs' paths must also be /outputs-relative + escape-free.
        for out in &self.produces {
            validate_subpath(&out.path, "produces path")?;
        }
        // Reference mounts: structural validation (host_path absolute + `..`-free;
        // sandbox_path absolute + not shadowing a managed root). The ALLOWLIST gate
        // is `validate_extra_mounts_allowed` (run time — the allowlist is admin config).
        for m in &self.extra_mounts {
            validate_reference_mount(m)?;
        }
        // #189 — a malformed env-id fails at ENQUEUE, not at dispatch. The predicate is
        // the shared grammar (`sandbox::env_id`), so this cannot drift from what the
        // manifest lint and the provider accept. Rejecting here means the caller gets a
        // 400 naming the value, instead of a job that queues, runs, and dies inside the
        // backend with the failure attributed to the sandbox.
        if let Some(env) = self.env.as_deref() {
            if !crate::modules::sandbox::env_id::is_valid_env_id(env) {
                return Err(invalid(format!(
                    "`env` must be a lowercase OCI repository path component \
                     (a-z, 0-9, `.`, `_`, `-`; non-empty) — got {env:?}"
                )));
            }
        }
        Ok(())
    }

    /// Overwrite any caller-supplied `env` with the one the REGISTRY declares for this
    /// spec's `analysis_id` (DEC-4). Returns the spec.
    ///
    /// **This is a security boundary, and it is a boundary because the registry is
    /// open.** `env_image::resolve` maps ANY well-formed env-id to its own image repo —
    /// there is deliberately no allowlist (asserted by `tests/sandbox/env_image_test.rs`),
    /// because that openness is what lets a new env ship as one `env-rootfs/<env>/`
    /// directory with zero core edits. The cost of that openness is that a *trusted*
    /// caller-supplied env-id is a request to mount an arbitrary image, so the enqueue
    /// path must DERIVE the value rather than believe it.
    ///
    /// A spec with no `analysis_id` (a converter run, an ad-hoc spec) resolves nothing
    /// and is left with `None` — the deployment default — rather than keeping whatever
    /// the caller sent.
    pub fn with_declared_env(self) -> Self {
        self.with_declared_env_from(crate::modules::extensions::declared_env_for_analysis)
    }

    /// [`with_declared_env`](Self::with_declared_env) against an explicit resolver.
    ///
    /// The registry is a process-wide global, so the injectable form is what lets this
    /// security boundary be tested deterministically instead of by installing a global
    /// and hoping no sibling test in the binary races it. The overwrite rule — not the
    /// lookup — is the part worth pinning.
    pub fn with_declared_env_from(
        mut self,
        lookup: impl Fn(&str) -> Option<String>,
    ) -> Self {
        self.env = self.analysis_id.as_deref().and_then(lookup);
        self
    }

    /// Reject any reference mount whose host path is not under an admin-allowlisted
    /// root (ITEM-5c / DEC-11), a LEXICAL component-prefix pre-check. Called at run
    /// time by the runner with the deployment allowlist; a non-allowlisted path → a
    /// typed `EXTRA_MOUNT_NOT_ALLOWLISTED`. The lexical check is safe because
    /// `validate` already rejects a `..`/relative host path — but a lexical prefix
    /// is NOT sufficient on its own: a *symlink* under an allowlisted root would
    /// still bind an arbitrary host path. The authoritative gate is the
    /// symlink-resolving [`canonicalize_under_allowlist`], which the runner applies
    /// per mount before binding.
    pub fn validate_extra_mounts_allowed(
        &self,
        allowlist: &[std::path::PathBuf],
    ) -> Result<(), AppError> {
        for m in &self.extra_mounts {
            let host = std::path::Path::new(&m.host_path);
            let allowed = allowlist.iter().any(|root| host.starts_with(root));
            if !allowed {
                return Err(AppError::bad_request(
                    "EXTRA_MOUNT_NOT_ALLOWLISTED",
                    format!(
                        "reference mount host path {:?} is not under an allowlisted root",
                        m.host_path
                    ),
                ));
            }
        }
        Ok(())
    }

    /// The resolved priority class: an explicit `schedule.class` clamped, else the
    /// caller-provided default (from the create handler's trigger inference).
    pub fn priority(&self, default: PriorityClass) -> PriorityClass {
        self.schedule
            .class
            .as_deref()
            .map(PriorityClass::clamped)
            .unwrap_or(default)
    }

    /// The fixed in-sandbox path the entry script binds at, from the spec's declared
    /// language. NOTE: the runner builds the exec path/command from the RESOLVED entry
    /// language (`resolve_entry`, authoritative for a `code_ref`), so these two helpers
    /// are the spec-shape reference used by the unit tests, not the runtime dispatch.
    pub fn entry_sandbox_path(&self) -> String {
        format!("/code/{}", self.language.entry_filename())
    }

    /// The command for the spec's declared language (see `entry_sandbox_path`'s note —
    /// the runner uses the resolved language). Retained as the tested spec-shape.
    pub fn command(&self) -> String {
        self.language.command_for(&self.entry_sandbox_path())
    }

    /// Resolve the entry to execute (ITEM-18 "last mile" / D2 COMPUTE-FROM-FOLDER):
    /// an inline `script` (with the spec's declared `language`), or a folder-discovered
    /// processor resolved from `code_ref` via [`super::processors::resolve`] — which
    /// READS THE SCRIPT FROM THE EXTRACTED FOLDER (`<data_root>/processors/<package>/
    /// <code_ref>`), so a separate-repo package's compute runs with no rebuild (INV-7).
    /// An unknown `code_ref` (no owning package / unreadable file) is a clear error (the
    /// runner fails the job with a reason). Called by the runner AND the recorder so the
    /// executed bytes == the recorded bytes == the on-disk bytes (reproduce).
    pub fn resolve_entry(&self) -> Result<ResolvedEntry, AppError> {
        if let Some(s) = self.script.as_deref() {
            return Ok(ResolvedEntry {
                language: self.language,
                script: std::borrow::Cow::Owned(s.to_string()),
                host_resources: Vec::new(),
                helpers: Vec::new(),
            });
        }
        if let Some(code_ref) = self.code_ref.as_deref() {
            let p = super::processors::resolve_with_package(code_ref, self.package.as_deref())
                .map_err(|e| {
                    invalid(format!(
                        "cannot resolve processor code_ref {code_ref:?}: {e}"
                    ))
                })?;
            return Ok(ResolvedEntry {
                language: p.language,
                script: p.script,
                host_resources: p.host_resources,
                helpers: p.helpers,
            });
        }
        Err(invalid("an analysis spec needs a `script` or a `code_ref`"))
    }
}

/// A sandbox-relative subpath (bound under `/inputs` or `/outputs`) must be
/// non-empty, relative, and free of `..`/`.`/absolute/prefix components. This is
/// the path-injection guard — a spec can NEVER name `/etc/...` or `../secret`.
pub fn validate_subpath(sub: &str, what: &str) -> Result<(), AppError> {
    if sub.trim().is_empty() {
        return Err(invalid(format!("{what} is empty")));
    }
    let p = std::path::Path::new(sub);
    if p.is_absolute() {
        return Err(invalid(format!(
            "{what} {sub:?} must be relative (not absolute)"
        )));
    }
    // A CONTROL character is not a path problem — every one of them is a legal byte in a
    // POSIX filename, and `Component::Normal` accepts them — it is a CONSUMER problem. A
    // mount name reaches computes through `/inputs/inputs.json`, and a shell compute that
    // iterates mounts with `while IFS= read -r` splits on an embedded newline, turning one
    // mount into two nonexistent ones. `derive_artifact_mount_name` already sanitizes to
    // `[A-Za-z0-9._-]`, so an artifact-backed input cannot carry one; a `dataset_file_ref`
    // keeps its DECLARED basename, and the importer's basename is the uploaded filename.
    //
    // Rejected here rather than escaped in each consumer: this is the one chokepoint every
    // staged subpath passes through, and no legitimate path component contains a control
    // character — so there is nothing to trade off.
    if let Some(c) = sub.chars().find(|c| c.is_control()) {
        return Err(invalid(format!(
            "{what} {sub:?} may not contain a control character (U+{:04X})",
            c as u32
        )));
    }
    use std::path::Component;
    for comp in p.components() {
        if !matches!(comp, Component::Normal(_)) {
            return Err(invalid(format!(
                "{what} {sub:?} may not contain '.', '..', or an absolute/prefix component"
            )));
        }
    }
    Ok(())
}

/// Structurally validate a reference `ExtraMountDecl` (ITEM-5c): the host path
/// must be absolute + `..`-free (so the allowlist prefix-check can't be escaped);
/// the sandbox path must be absolute and NOT shadow a harness-managed root
/// (`/inputs`/`/outputs`/`/code`/`/home`) or `/`. A genome mounts at e.g. `/refs`.
fn validate_reference_mount(m: &ExtraMountDecl) -> Result<(), AppError> {
    use std::path::{Component, Path};
    if m.host_path.trim().is_empty() {
        return Err(invalid("extra_mount host_path is empty"));
    }
    let host = Path::new(&m.host_path);
    if !host.is_absolute() {
        return Err(invalid(format!(
            "extra_mount host_path {:?} must be absolute",
            m.host_path
        )));
    }
    if host
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err(invalid(format!(
            "extra_mount host_path {:?} may not contain '.' or '..'",
            m.host_path
        )));
    }
    let sandbox = Path::new(&m.sandbox_path);
    if !sandbox.is_absolute() {
        return Err(invalid(format!(
            "extra_mount sandbox_path {:?} must be absolute",
            m.sandbox_path
        )));
    }
    if m.sandbox_path == "/" {
        return Err(invalid("extra_mount sandbox_path may not be '/'"));
    }
    for managed in ["/inputs", "/outputs", "/code", "/home"] {
        if sandbox.starts_with(managed) {
            return Err(invalid(format!(
                "extra_mount sandbox_path {:?} shadows the harness-managed root {managed:?}",
                m.sandbox_path
            )));
        }
    }
    Ok(())
}

/// Symlink-resolving allowlist gate (security-critical): the authoritative
/// containment check the lexical [`AnalysisSpec::validate_extra_mounts_allowed`]
/// prefix-check can NOT provide. It CANONICALIZES both the host path and each
/// allowlist root (resolving every symlink), then requires the resolved host path
/// to live under a resolved root — so a symlink planted under an allowlisted root
/// can no longer redirect the bind at an arbitrary host path. Returns the CANONICAL
/// host path so the caller binds the resolved target (a symlink swapped in after
/// the check can't redirect a bind of the already-resolved path). A host path that
/// can't be resolved (missing / unreadable) is REFUSED — you can't read-only-bind a
/// path that doesn't resolve. Also used to gate a trusted `host_path` *input*
/// through the SAME allowlist (host paths belong in the allowlist, never as free
/// user inputs). Not pure (touches the filesystem) — tested with real temp dirs.
pub fn canonicalize_under_allowlist(
    host_path: &str,
    allowlist: &[std::path::PathBuf],
) -> Result<std::path::PathBuf, AppError> {
    let canon_host = std::fs::canonicalize(host_path).map_err(|e| {
        AppError::bad_request(
            "EXTRA_MOUNT_NOT_ALLOWLISTED",
            format!("host path {host_path:?} could not be resolved: {e}"),
        )
    })?;
    // Compare canonical-vs-canonical: both sides are absolute + symlink-free, so a
    // component `starts_with` can no longer be escaped by an intermediate symlink.
    let under = allowlist.iter().any(|root| {
        std::fs::canonicalize(root)
            .map(|croot| canon_host.starts_with(croot))
            .unwrap_or(false)
    });
    if under {
        Ok(canon_host)
    } else {
        Err(AppError::bad_request(
            "EXTRA_MOUNT_NOT_ALLOWLISTED",
            format!("host path {host_path:?} resolves outside every allowlisted root"),
        ))
    }
}

/// Clamp a requested resource-class string (unused this round beyond cpu-sandbox,
/// but present so the create surface validates it) to a known class.
pub fn resolve_resource_class(requested: Option<&str>) -> ResourceClass {
    requested
        .map(ResourceClass::clamped)
        .unwrap_or(ResourceClass::CpuSandbox)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn valid_params() -> serde_json::Value {
        json!({
            "language": "python",
            "script": "import scanpy\nprint('ok')",
            "inputs": [
                { "slot": "expression", "host_path": "/srv/data/x.h5ad", "sandbox_subpath": "expression.h5ad" }
            ],
            "produces": [
                { "id": "embedding", "datatype": "embedding", "path": "umap.zarr", "layout": "zarr", "role": "primary" }
            ],
            "schedule": { "class": "interactive", "cpu": 2, "mem_bytes": 4294967296_i64 },
            "timeout_secs": 300,
            "seed": 42
        })
    }

    // TEST-22 [ITEM-17] — `bound_by` round-trips both origins, is OPTIONAL (every
    // spec recorded before this field still parses, and absent stays absent rather
    // than becoming `user`), and an UNKNOWN origin is a parse ERROR.
    //
    // The unknown-value arm is the one that matters. A silent default there would
    // make a typo'd or future origin read as "a person picked this", i.e. the record
    // would claim a review that never happened — the precise fabrication this whole
    // field exists to prevent. It is asserted rather than assumed because "serde
    // rejects it" is a property of the derive we depend on, not a property we wrote.
    #[test]
    fn binding_origin_round_trips_is_optional_and_rejects_unknown() {
        let with_origin = |o: &str| {
            let mut p = valid_params();
            p["inputs"][0]["bound_by"] = json!(o);
            p
        };

        for (wire, want) in [("user", BindingOrigin::User), ("auto", BindingOrigin::Auto)] {
            let spec = AnalysisSpec::parse(&with_origin(wire)).expect("a declared origin parses");
            assert_eq!(spec.inputs[0].bound_by, Some(want), "{wire} round-trips in");
            let back = serde_json::to_value(&spec.inputs[0]).expect("serialize");
            assert_eq!(back["bound_by"], json!(wire), "…and back out on the wire");
        }

        // ABSENT stays absent — never defaulted to `user` (a fabricated review) and
        // never to `auto` (a fabricated accusation). DEC-7 / INV-4.
        let spec = AnalysisSpec::parse(&valid_params()).expect("a spec without the key parses");
        assert_eq!(spec.inputs[0].bound_by, None, "no key ⇒ UNSTATED");
        let back = serde_json::to_value(&spec.inputs[0]).expect("serialize");
        assert!(
            back.get("bound_by").is_none(),
            "an unstated origin is OMITTED, so existing serializations are byte-identical: {back}"
        );

        // An unknown origin is refused, not coerced.
        let err = AnalysisSpec::parse(&with_origin("inferred"))
            .expect_err("an unknown origin must NOT silently default");
        assert!(
            format!("{err:?}").contains("malformed analysis spec"),
            "it fails as a malformed spec: {err:?}"
        );
    }

    // TEST-4: parse a valid spec; reject path-injection + missing script/code_ref.
    #[test]
    fn parses_valid_and_rejects_injection() {
        let spec = AnalysisSpec::parse(&valid_params()).expect("valid spec parses");
        assert_eq!(spec.language, Language::Python);
        assert_eq!(spec.inputs.len(), 1);
        assert_eq!(
            spec.priority(PriorityClass::Normal),
            PriorityClass::Interactive
        );

        // Absolute sandbox_subpath → reject.
        let mut p = valid_params();
        p["inputs"][0]["sandbox_subpath"] = json!("/etc/passwd");
        assert_eq!(
            AnalysisSpec::parse(&p).unwrap_err().error_code(),
            "ANALYSIS_SPEC_INVALID"
        );
        // `..` escape → reject.
        let mut p2 = valid_params();
        p2["inputs"][0]["sandbox_subpath"] = json!("../secret");
        assert!(AnalysisSpec::parse(&p2).is_err());
        // Neither script nor code_ref → reject.
        let mut p3 = valid_params();
        p3["script"] = json!(null);
        assert!(AnalysisSpec::parse(&p3).is_err());
        // Both script AND code_ref → reject.
        let mut p4 = valid_params();
        p4["code_ref"] = json!("sha256:deadbeef");
        assert!(AnalysisSpec::parse(&p4).is_err());
        // Input with neither ref → reject.
        let mut p5 = valid_params();
        p5["inputs"][0] = json!({ "slot": "x", "sandbox_subpath": "x" });
        assert!(AnalysisSpec::parse(&p5).is_err());
    }

    // TEST-9: entry-filename + command mapping per language, fixed /code path.
    #[test]
    fn entry_filename_and_command_per_language() {
        assert_eq!(Language::Python.entry_filename(), "entry.py");
        assert_eq!(Language::Rscript.entry_filename(), "entry.R");

        let py = AnalysisSpec {
            language: Language::Python,
            script: Some("x".into()),
            code_ref: None,
            package: None,
            // #189: no per-job env ⇒ the deployment default (INV-1).
            env: None,
            inputs: vec![],
            produces: vec![],
            schedule: ScheduleDecl::default(),
            extra_mounts: vec![],
            arch: vec![],
            timeout_secs: None,
            seed: None,
            params: serde_json::Value::Null,
            analysis_id: None,
        };
        assert_eq!(py.entry_sandbox_path(), "/code/entry.py");
        assert_eq!(py.command(), "python3 /code/entry.py");

        let r = AnalysisSpec {
            language: Language::Rscript,
            ..py.clone()
        };
        assert_eq!(r.entry_sandbox_path(), "/code/entry.R");
        assert_eq!(r.command(), "Rscript /code/entry.R");
    }

    // TEST-8: Language::Bash → entry.sh + `bash /code/entry.sh`; and the language
    // TAG a captured code blob is stored under maps Bash → "bash" (the exhaustive
    // Language matches all compile + map). ITEM-5b / DEC-10.
    // (`recorder::language_str` was a duplicate of `Language::as_str` kept alive
    // only by the trust-view params' `language` key; DEC-1's promotion dropped that
    // key, so the recorder now tags a code blob with `as_str` directly.)
    #[test]
    fn bash_language_entry_command_and_recorder_tag() {
        assert_eq!(Language::Bash.entry_filename(), "entry.sh");
        assert_eq!(
            Language::Bash.command_for("/code/entry.sh"),
            "bash /code/entry.sh"
        );

        let mut p = valid_params();
        p["language"] = json!("bash");
        p["script"] = json!("echo ok > /outputs/manifest.json");
        let spec = AnalysisSpec::parse(&p).expect("bash spec parses");
        assert_eq!(spec.language, Language::Bash);
        assert_eq!(spec.entry_sandbox_path(), "/code/entry.sh");
        assert_eq!(spec.command(), "bash /code/entry.sh");

        // The code-blob language tag for a Bash entry (all exhaustive matches map).
        assert_eq!(
            spec.resolve_entry()
                .expect("inline bash entry resolves")
                .language
                .as_str(),
            "bash",
            "a bash run's code blob is tagged \"bash\""
        );
    }

    // TEST-10: `AnalysisSpec.extra_mounts` parses; a non-allowlisted host path is
    // rejected while an allowlisted one is accepted; a structurally-bad mount
    // (relative host path / managed-root sandbox path) is rejected at parse. The
    // assemble_mounts RO-bind leg is proven in `backend::local_bwrap`. ITEM-5c.
    #[test]
    fn extra_mounts_parse_and_allowlist_gate() {
        let mut p = valid_params();
        p["extra_mounts"] = json!([
            { "host_path": "/srv/refs/GRCh38", "sandbox_path": "/refs/GRCh38" }
        ]);
        let spec = AnalysisSpec::parse(&p).expect("extra_mounts parses");
        assert_eq!(spec.extra_mounts.len(), 1);
        assert_eq!(spec.extra_mounts[0].sandbox_path, "/refs/GRCh38");

        // Allowlisted → OK; a disjoint allowlist → EXTRA_MOUNT_NOT_ALLOWLISTED.
        spec.validate_extra_mounts_allowed(&[std::path::PathBuf::from("/srv/refs")])
            .expect("host under an allowlisted root is accepted");
        let err = spec
            .validate_extra_mounts_allowed(&[std::path::PathBuf::from("/opt/other")])
            .unwrap_err();
        assert_eq!(err.error_code(), "EXTRA_MOUNT_NOT_ALLOWLISTED");
        // Empty allowlist rejects everything.
        assert!(spec.validate_extra_mounts_allowed(&[]).is_err());

        // Structural rejects at parse: relative host path.
        let mut bad = valid_params();
        bad["extra_mounts"] =
            json!([{ "host_path": "refs/GRCh38", "sandbox_path": "/refs/GRCh38" }]);
        assert_eq!(
            AnalysisSpec::parse(&bad).unwrap_err().error_code(),
            "ANALYSIS_SPEC_INVALID"
        );
        // `..` in host path.
        let mut bad2 = valid_params();
        bad2["extra_mounts"] = json!([{ "host_path": "/srv/../etc", "sandbox_path": "/refs/x" }]);
        assert!(AnalysisSpec::parse(&bad2).is_err());
        // Sandbox path shadowing a managed root.
        let mut bad3 = valid_params();
        bad3["extra_mounts"] = json!([{ "host_path": "/srv/refs", "sandbox_path": "/inputs/x" }]);
        assert!(AnalysisSpec::parse(&bad3).is_err());
    }

    // ITEM-26: the additive `arch` field defaults empty ("all arches") and parses
    // a declared list. No scheduler logic here — only the carried field.
    #[test]
    fn arch_field_defaults_empty_and_parses() {
        let spec = AnalysisSpec::parse(&valid_params()).unwrap();
        assert!(spec.arch.is_empty(), "absent arch ⇒ empty ⇒ all arches");
        let mut p = valid_params();
        p["arch"] = json!(["x86_64"]);
        assert_eq!(
            AnalysisSpec::parse(&p).unwrap().arch,
            vec!["x86_64".to_string()]
        );
    }

    // ITEM-5: the input-source rule — exactly one of artifact_ref / dataset_file_ref
    // / host_path. A `dataset_file_ref` input parses; declaring two sources rejects.
    #[test]
    fn input_source_exactly_one() {
        // A dataset-file input (txresbench-file) is a valid single source.
        let mut p = valid_params();
        p["inputs"][0] = json!({
            "slot": "expression",
            "dataset_file_ref": "00000000-0000-0000-0000-0000000000aa",
            "sandbox_subpath": "expression.h5ad"
        });
        let spec = AnalysisSpec::parse(&p).expect("dataset_file_ref input parses");
        assert!(spec.inputs[0].dataset_file_ref.is_some());

        // Two sources on one input → reject.
        let mut p2 = valid_params();
        p2["inputs"][0] = json!({
            "slot": "expression",
            "artifact_ref": "00000000-0000-0000-0000-0000000000bb",
            "dataset_file_ref": "00000000-0000-0000-0000-0000000000cc",
            "sandbox_subpath": "expression.h5ad"
        });
        assert_eq!(
            AnalysisSpec::parse(&p2).unwrap_err().error_code(),
            "ANALYSIS_SPEC_INVALID"
        );
    }

    // ITEM-12: a `dataset_axis_index` input is a valid single source (parses,
    // round-trips {dataset_id, axis}); pairing it with another source rejects.
    #[test]
    fn dataset_axis_index_is_a_valid_single_source() {
        let mut p = valid_params();
        p["inputs"][0] = json!({
            "slot": "axis_index",
            "dataset_axis_index": {
                "dataset_id": "00000000-0000-0000-0000-0000000000dd",
                "axis": "cells"
            },
            "sandbox_subpath": "axis_index"
        });
        let spec = AnalysisSpec::parse(&p).expect("dataset_axis_index input parses");
        let axis_ref = spec.inputs[0]
            .dataset_axis_index
            .as_ref()
            .expect("axis ref present");
        assert_eq!(axis_ref.axis, "cells");

        // Combined with a second source on the same input → reject.
        let mut p2 = valid_params();
        p2["inputs"][0] = json!({
            "slot": "axis_index",
            "dataset_axis_index": { "dataset_id": "00000000-0000-0000-0000-0000000000dd", "axis": "cells" },
            "dataset_file_ref": "00000000-0000-0000-0000-0000000000ee",
            "sandbox_subpath": "axis_index"
        });
        assert_eq!(
            AnalysisSpec::parse(&p2).unwrap_err().error_code(),
            "ANALYSIS_SPEC_INVALID"
        );
    }

    // FIX-3 (symlink escape): the lexical prefix-check passes a symlink under an
    // allowlisted root, but `canonicalize_under_allowlist` resolves the symlink and
    // REFUSES a path that escapes the (canonicalized) allowlist — while accepting a
    // real path under it and returning its canonical form. Real temp dirs + a
    // symlink (not pure).
    #[test]
    #[cfg(unix)]
    fn canonicalize_under_allowlist_blocks_symlink_escape() {
        use std::path::PathBuf;
        let base = std::env::temp_dir().join(format!("txr-canon-{}", uuid::Uuid::new_v4()));
        let allowed = base.join("refs"); // the allowlisted root
        let secret = base.join("secret"); // OUTSIDE the allowlist
        std::fs::create_dir_all(allowed.join("GRCh38")).unwrap();
        std::fs::create_dir_all(&secret).unwrap();
        std::fs::write(secret.join("passwd"), b"top secret").unwrap();

        let allowlist = [allowed.clone()];

        // A real dir under the allowlisted root → accepted, canonical path returned.
        let ok = canonicalize_under_allowlist(allowed.join("GRCh38").to_str().unwrap(), &allowlist)
            .expect("a real path under the allowlist is accepted");
        assert!(ok.ends_with("GRCh38"));
        assert!(ok.starts_with(std::fs::canonicalize(&allowed).unwrap()));

        // A SYMLINK under the allowlisted root pointing OUTSIDE it — the lexical
        // prefix-check would pass, but the canonical check resolves it to `secret`
        // and REFUSES (this is the escape the fix closes).
        let evil = allowed.join("evil");
        std::os::unix::fs::symlink(&secret, &evil).unwrap();
        let err = canonicalize_under_allowlist(evil.to_str().unwrap(), &allowlist)
            .expect_err("a symlink escaping the allowlist is refused");
        assert_eq!(err.error_code(), "EXTRA_MOUNT_NOT_ALLOWLISTED");

        // A path that does not resolve at all is refused (can't RO-bind it).
        assert!(
            canonicalize_under_allowlist(base.join("nope").to_str().unwrap(), &allowlist).is_err()
        );

        // An empty allowlist refuses everything (safe-by-default).
        assert!(canonicalize_under_allowlist(
            allowed.join("GRCh38").to_str().unwrap(),
            &[] as &[PathBuf]
        )
        .is_err());

        let _ = std::fs::remove_dir_all(&base);
    }

    // ITEM-23 / DEC-9 — the mount name of an artifact-backed input is a FIXED
    // derivation from the artifact's own two store facts (`is_multifile` +
    // `structure.encoding`), not from any declared string.
    #[test]
    fn artifact_mount_name_is_derived_from_the_artifact() {
        let zarr =
            json!({ "encoding": "zarr_v3", "kind": "sparse_csc", "axes": ["cells", "genes"] });
        let opaque = json!({ "encoding": "opaque", "media_type": "application/octet-stream" });

        // A Zarr store names itself a store.
        assert_eq!(derive_artifact_mount_name("matrix", &zarr), "matrix.zarr");
        // An opaque blob makes no format claim, so neither does its name.
        assert_eq!(derive_artifact_mount_name("labels", &opaque), "labels");

        // DISCRIMINATION (the negative control the derivation must survive): the SAME
        // slot over artifacts that differ only in their declared store form yields
        // DIFFERENT names — so "the declared string does not decide" is not satisfied
        // by a derivation that returns a constant.
        assert_ne!(
            derive_artifact_mount_name("matrix", &zarr),
            derive_artifact_mount_name("matrix", &opaque)
        );

        // The suffix reads the DECLARATION only; `is_multifile` owns the staged FORM
        // (dir vs file), never the name — see the fn doc for why splitting the two
        // would desynchronize the runner from the conformance gate.
        assert_eq!(derive_artifact_mount_name("x", &json!({})), "x");
        assert_eq!(
            derive_artifact_mount_name("x", &json!({ "encoding": "parquet" })),
            "x"
        );

        // The derived name is ALWAYS a legal `/inputs`-relative component, including
        // for a hostile slot — the slot is free-form caller input and now decides a
        // path (`dataset_slot` on `POST /datasets/{id}/process` is user-supplied).
        for slot in ["../../etc/passwd", "/abs", ".hidden", "", "..", "a b/c"] {
            let name = derive_artifact_mount_name(slot, &zarr);
            validate_subpath(&name, "derived mount name")
                .unwrap_or_else(|e| panic!("derived {name:?} from slot {slot:?} is unsafe: {e}"));
            assert!(
                !name.contains('/'),
                "derived {name:?} must be one component"
            );
        }
    }

    /// A CONTROL character in a staged subpath is refused.
    ///
    /// It is not a traversal problem — every control byte is legal in a POSIX filename and
    /// `Component::Normal` accepts it. It is a CONSUMER problem: mount names reach computes
    /// through `/inputs/inputs.json`, and a shell compute iterating them with
    /// `while IFS= read -r` splits an embedded newline into two nonexistent mounts.
    ///
    /// Reachability, which is why this is guarded at the chokepoint rather than in one
    /// script: an ARTIFACT-backed input cannot carry one (`derive_artifact_mount_name`
    /// sanitizes to `[A-Za-z0-9._-]` — asserted below so the two rules are pinned
    /// together), but a `dataset_file_ref` keeps its DECLARED basename, and the importer's
    /// declared basename is the uploaded filename.
    #[test]
    fn a_control_character_in_a_subpath_is_refused() {
        for bad in ["fastqs\nlanes", "a\tb", "x\u{0}y", "lead\r"] {
            let err = validate_subpath(bad, "input sandbox_subpath")
                .expect_err(&format!("{bad:?} must be refused"));
            let msg = format!("{err:?}");
            assert!(
                msg.contains("control character"),
                "{bad:?} was refused for the WRONG reason: {msg}"
            );
        }
        // Non-vacuity + the negative control: an ordinary name still passes, so the rule
        // rejects control characters rather than rejecting everything.
        validate_subpath("fastqs_1.zarr", "input sandbox_subpath").expect("a plain name passes");

        // The other half of the reachability argument: a hostile slot carrying a newline
        // cannot reach this rule at all, because the derivation strips it first.
        let zarr = serde_json::json!({ "encoding": "zarr_v3" });
        let derived = derive_artifact_mount_name("fastqs\nlanes", &zarr);
        assert!(
            !derived.chars().any(|c| c.is_control()),
            "derived {derived:?} still carries a control character"
        );
        validate_subpath(&derived, "derived mount name").expect("derived names stay legal");
    }

    // The declared subpath is now OPTIONAL on the wire, and honoured only where the
    // runner cannot name the mount from an artifact.
    #[test]
    fn declared_subpath_is_optional_and_scoped_to_non_artifact_inputs() {
        // Absent `sandbox_subpath` parses (it used to be required).
        let mut p = valid_params();
        p["inputs"][0] = json!({ "slot": "expression", "host_path": "/srv/data/x.h5ad" });
        let spec = AnalysisSpec::parse(&p).expect("an input with no declared subpath parses");
        assert_eq!(spec.inputs[0].sandbox_subpath, "");
        // …and falls back to the slot for a non-artifact input.
        assert_eq!(spec.inputs[0].declared_mount_name(), "expression");
        assert!(!spec.inputs[0].is_artifact_backed());

        // A DECLARED value is still honoured for a user file (the importer detects
        // format from the uploaded filename).
        let mut p2 = valid_params();
        p2["inputs"][0] = json!({
            "slot": "dataset",
            "dataset_file_ref": "00000000-0000-0000-0000-0000000000aa",
            "sandbox_subpath": "PBMC_donor1.h5ad"
        });
        let spec2 = AnalysisSpec::parse(&p2).expect("declared subpath parses");
        assert_eq!(spec2.inputs[0].declared_mount_name(), "PBMC_donor1.h5ad");

        // …and is STILL path-injection-guarded when supplied.
        let mut bad = valid_params();
        bad["inputs"][0]["sandbox_subpath"] = json!("../escape");
        assert_eq!(
            AnalysisSpec::parse(&bad).unwrap_err().error_code(),
            "ANALYSIS_SPEC_INVALID"
        );

        // An artifact-backed input is flagged as such regardless of what it declares.
        let mut p3 = valid_params();
        p3["inputs"][0] = json!({
            "slot": "matrix",
            "artifact_ref": "00000000-0000-0000-0000-0000000000bb",
            "sandbox_subpath": "matrix.h5ad"
        });
        assert!(AnalysisSpec::parse(&p3).unwrap().inputs[0].is_artifact_backed());
    }

    #[test]
    fn priority_defaults_when_no_class() {
        let mut p = valid_params();
        p["schedule"] = json!({});
        let spec = AnalysisSpec::parse(&p).unwrap();
        assert_eq!(
            spec.priority(PriorityClass::Batch),
            PriorityClass::Batch,
            "no class → default"
        );
        // An unknown class clamps to normal.
        let mut p2 = valid_params();
        p2["schedule"]["class"] = json!("bogus");
        assert_eq!(
            AnalysisSpec::parse(&p2)
                .unwrap()
                .priority(PriorityClass::Interactive),
            PriorityClass::Normal
        );
    }

    // ─────────────── #189 — the `env` field, its validation, and DEC-4 ───────────────

    fn spec_json(v: serde_json::Value) -> serde_json::Value {
        v
    }

    /// **TEST-E1-11** [covers: ITEM-4] [security: DEC-4] — a CLIENT-SUPPLIED `env` is
    /// overwritten by the value the registry declares for the named `analysis_id`.
    ///
    /// This is a security boundary and it exists because the env registry is OPEN: any
    /// well-formed env-id resolves to its own image repo, with no allowlist (that
    /// openness is what lets a new env ship as one directory with zero core edits). A
    /// TRUSTED request-body `env` would therefore be a request to mount an arbitrary
    /// image, so the enqueue path must DERIVE the value rather than believe it.
    ///
    /// All four cases matter, and three of them are the ones a naive "only fill it in if
    /// absent" implementation would get wrong.
    /// Lifecycle id: **TEST-20** (see `.lifecycle/analysis-env-selection/TESTS.md`).
    #[test]
    fn a_client_supplied_env_is_overwritten_by_the_registry_declaration() {
        const DECLARED: &str = "fixture-declared-env";
        const ATTACKER: &str = "fixture-attacker-env";
        let registry = |id: &str| {
            (id == "pkg.declared").then(|| DECLARED.to_string())
        };

        // (a) A caller-supplied env for an analysis that declares one is REPLACED.
        let s = AnalysisSpec::parse(&spec_json(serde_json::json!({
            "language": "python", "code_ref": "compute/e.py",
            "analysis_id": "pkg.declared", "env": ATTACKER
        })))
        .unwrap()
        .with_declared_env_from(registry);
        assert_eq!(
            s.env.as_deref(),
            Some(DECLARED),
            "the caller's env must be discarded in favour of the declared one"
        );

        // (b) A caller-supplied env for an analysis that declares NONE is DROPPED, not
        //     kept. Keeping it would leave the whole boundary bypassable by naming an
        //     analysis that happens to declare no env.
        let s = AnalysisSpec::parse(&spec_json(serde_json::json!({
            "language": "python", "code_ref": "compute/e.py",
            "analysis_id": "pkg.undeclared", "env": ATTACKER
        })))
        .unwrap()
        .with_declared_env_from(registry);
        assert_eq!(s.env, None, "an undeclared analysis falls back to the deployment default");

        // (c) A spec with NO `analysis_id` at all (an ad-hoc spec) resolves nothing and
        //     keeps nothing — the same bypass by a different route.
        let s = AnalysisSpec::parse(&spec_json(serde_json::json!({
            "language": "python", "code_ref": "compute/e.py", "env": ATTACKER
        })))
        .unwrap()
        .with_declared_env_from(registry);
        assert_eq!(s.env, None, "no analysis_id ⇒ nothing to derive ⇒ nothing trusted");

        // (d) The declared env is applied even when the caller sent none — the field is
        //     DERIVED, not merely sanitized.
        let s = AnalysisSpec::parse(&spec_json(serde_json::json!({
            "language": "python", "code_ref": "compute/e.py", "analysis_id": "pkg.declared"
        })))
        .unwrap()
        .with_declared_env_from(registry);
        assert_eq!(s.env.as_deref(), Some(DECLARED));
    }

    /// A malformed `env` fails at ENQUEUE (parse/validate), not at dispatch.
    ///
    /// Rejecting here means the caller gets a 400 naming the value. Left to dispatch, the
    /// same spec would queue, run, and die inside the backend with the failure attributed
    /// to the sandbox rather than to the spec that caused it.
    /// Lifecycle id: **TEST-21** (see `.lifecycle/analysis-env-selection/TESTS.md`).
    #[test]
    fn a_malformed_env_is_rejected_at_enqueue_naming_the_value() {
        for bad in ["", "UPPER", "a/b", "x:tag", "y@sha256:0", "has space"] {
            let err = AnalysisSpec::parse(&serde_json::json!({
                "language": "python", "code_ref": "compute/e.py", "env": bad
            }))
            .expect_err("a malformed env-id must be refused at parse");
            let msg = format!("{err}");
            assert!(msg.contains("env"), "names the field for {bad:?}: {msg}");
        }
        // …and a well-formed one passes, so the loop above is not vacuously rejecting
        // every spec it is handed.
        AnalysisSpec::parse(&serde_json::json!({
            "language": "python", "code_ref": "compute/e.py", "env": "fixture-env-a"
        }))
        .expect("a well-formed env-id parses");
    }

    /// **INV-1 / INV-5** — a spec that declares NO env round-trips byte-identically to
    /// one from before the field existed.
    ///
    /// `skip_serializing_if` is what makes this true, and it is the mechanical guarantee
    /// behind "omitting a declared env is byte-identical to today": the serialized form
    /// gains no key, so nothing downstream that reads `Job.params` sees any change.
    /// Lifecycle id: **TEST-22** (see `.lifecycle/analysis-env-selection/TESTS.md`).
    #[test]
    fn an_env_less_spec_serializes_without_the_key() {
        let params = serde_json::json!({ "language": "python", "code_ref": "compute/e.py" });
        let spec = AnalysisSpec::parse(&params).unwrap();
        assert_eq!(spec.env, None);
        let out = serde_json::to_value(&spec).unwrap();
        assert!(
            out.get("env").is_none(),
            "an env-less spec must not gain an `env` key on the wire: {out}"
        );

        // …and the WHOLE object, not just that one key. The narrower assertion above is
        // what the doc used to claim as "byte-identical", and it is exactly the claim a
        // lossy re-encode elsewhere could break while this test stayed green: capture the
        // full serialized shape so any future field that forgets `skip_serializing_if`,
        // or any re-encode that materializes defaults, fails HERE.
        let round_tripped = serde_json::to_value(&AnalysisSpec::parse(&out).unwrap()).unwrap();
        assert_eq!(
            out, round_tripped,
            "an env-less spec must round-trip to itself, byte for byte"
        );
        for key in ["env"] {
            assert!(!out.to_string().contains(&format!("\"{key}\"")), "no `{key}` anywhere");
        }
    }

    /// The `POST /jobs` params rewrite must set ONE key, never re-encode the whole spec.
    ///
    /// Re-encoding is what the first cut of the DEC-4 boundary did, and it silently
    /// dropped every client key `AnalysisSpec` does not model while materializing
    /// `inputs`/`produces`/`schedule`/`extra_mounts`/`arch` defaults into the persisted
    /// row — for EVERY analysis job, env or not. This pins the shape of the rewrite so
    /// that regression cannot come back unnoticed.
    /// Lifecycle id: **TEST-36** (see `.lifecycle/analysis-env-selection/TESTS.md`).
    #[test]
    fn setting_the_env_key_preserves_every_other_param_key() {
        // A params bag carrying a key `AnalysisSpec` does NOT model.
        let mut params = serde_json::json!({
            "language": "python",
            "code_ref": "compute/e.py",
            "analysis_id": "pkg.declared",
            "client_only_key": { "kept": true },
        });
        // The production rewrite: derive, then set/remove the single key.
        let derived = AnalysisSpec::parse(&params)
            .unwrap()
            .with_declared_env_from(|id| (id == "pkg.declared").then(|| "fixture-env".to_string()))
            .env;
        let obj = params.as_object_mut().unwrap();
        match derived {
            Some(env) => obj.insert("env".into(), serde_json::Value::String(env)),
            None => obj.remove("env"),
        };

        assert_eq!(params["env"], serde_json::json!("fixture-env"), "the env is set");
        assert_eq!(
            params["client_only_key"],
            serde_json::json!({ "kept": true }),
            "a key the spec does not model must SURVIVE the rewrite"
        );
        for materialized in ["inputs", "produces", "schedule", "extra_mounts", "arch"] {
            assert!(
                params.get(materialized).is_none(),
                "the rewrite must not materialize `{materialized}` into the stored params"
            );
        }
    }
}
