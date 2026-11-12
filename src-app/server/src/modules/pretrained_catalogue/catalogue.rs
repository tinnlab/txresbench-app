//! The catalogue loader + refresher (PROV-PC-5 / PROV-PC-9's catalogue half):
//! the boot-validated embedded snapshot, the live → disk → embedded refresh
//! with the last-good cache, the two first-party generated files
//! (`catalogue.json` + `bundled-models.json`), and the host-policy validation
//! shared with the build-time checks (PROV-PC-1 / PROV-landing-site-2).
//!
//! ## The three layers (INV-8)
//!
//! 1. **Embedded** — the snapshot compiled into the binary with
//!    `include_bytes!` (a first-party generated file; a malformed or
//!    schema-drifted file FAILS BOOT, the extensions `_checked` posture,
//!    DEC-16). An ABSENT file is a compile-time failure of the build that
//!    claims to ship it — it cannot reach boot.
//! 2. **Disk** — the last good live copy under
//!    `<data_root>/txr-pretrained/catalogue.json`, validated by the same
//!    hygiene rules; a corrupted copy degrades to embedded, never to an empty
//!    catalogue.
//! 3. **Live** — `POST /api/txr/pretrained/refresh` / the boot refresh fetch
//!    [`CATALOGUE_URL`] (CONS-PC-6), validate, write the last-good copy, and
//!    serve. A failed refresh is SILENT (offline is a valid state) and never
//!    fails boot (PROV-PC-5).
//!
//! ## Host policy (PROV-landing-site-2, mirrored at build time)
//!
//! Every `asset.url` / manifest `url` host must be in
//! [`ALLOWED_ASSET_HOSTS`] — or loopback, which `scripts/check-network-
//! allowlist.sh` itself always permits (the test seams serve fixtures on
//! `127.0.0.1`). A live catalogue with a host outside the policy degrades to
//! disk/embedded; the embedded snapshot's violation is a boot refusal.
//!
//! ## Empty is valid (held from ITEM-2)
//!
//! The shipped snapshot carries `models: []` until the owner's publish pass
//! (no frozen assets exist yet), so an empty `models[]` is a VALID catalogue —
//! the D list renders the no-models state. Absent/malformed is the boot
//! failure; empty is not (DRIFT-1 ITEM-3).
//!
//! ## Seams
//!
//! [`PretrainedCatalogueSeams`] is the test seam (PROV-PC-9): constructor
//! args, never process-global `set_var` — the measured cross-test
//! contamination note in `sandbox/env_image.rs` applies here verbatim. The
//! seams' defaults resolve the release values: [`CATALOGUE_URL`] for the
//! fetch, `rootfs::data_root()` for the state dirs. `TXR_CATALOGUE_URL`
//! (documented) is honored ONLY as the default resolution of the `catalogue_url`
//! seam — it is what the spawned-server integration harness uses to point the
//! boot refresh at a closed loopback port instead of the production host
//! (`tests/common`), and what lets a blocked network still boot instantly.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock, RwLock};
use std::time::Duration;

use crate::modules::method_catalogue;
use crate::modules::pretrained_catalogue::types::{
    BundledAsset, BundledModels, PretrainedCatalogue, PretrainedDataSourceAccess, PretrainedKind,
    PretrainedModel, PretrainedOrigin, PretrainedRefreshResponse, PRETRAINED_SCHEMA_VERSION,
};
use crate::modules::rootfs;

/// The catalogue fetch URL (CONS-PC-6 — landing-site's CATALOGUE constant;
/// byte-equal to `scripts/build-landing-site.mjs --print-urls`' third line,
/// and asserted by the allowlist + hygiene guards).
pub const CATALOGUE_URL: &str =
    "https://tinnlab.github.io/txresbench-app/pretrained-catalogue.json";

/// The env seam that overrides the catalogue fetch URL (documented: the
/// integration harness + a blocked-network boot; the default is the constant
/// above).
pub const CATALOGUE_URL_ENV: &str = "TXR_CATALOGUE_URL";

/// The embedded snapshot's repo-root path (the boot error names the FILE —
/// TEST-PC-01).
pub const EMBEDDED_CATALOGUE_PATH: &str = "data/pretrained-catalogue/catalogue.json";

/// The embedded bundled-manifest path (its sibling — PROV-PC-12).
pub const EMBEDDED_BUNDLED_PATH: &str = "data/pretrained-catalogue/bundled-models.json";

/// The host policy (PROV-landing-site-2): the model-asset host and the Pages
/// host. Loopback is additionally always allowed (the allowlist guard's own
/// rule).
pub const ALLOWED_ASSET_HOSTS: [&str; 2] = ["github.com", "tinnlab.github.io"];

/// The embedded snapshot bytes (compile-time — the file is committed; an
/// absent file is a build failure, never a boot surprise). `$CARGO_MANIFEST_DIR`
/// is `src-app/server`, so `../../data/...` is the repo-root generated file.
const CATALOGUE_JSON: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../data/pretrained-catalogue/catalogue.json"
));

/// The embedded bundled-models manifest bytes (the installer-build extract,
/// PROV-PC-12 — one generated file, parsed by both sides).
const BUNDLED_JSON: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../data/pretrained-catalogue/bundled-models.json"
));

/// The process-wide embedded catalogue, installed by the module's `init`
/// (the boot check). Immutable for the process lifetime (method_catalogue's
/// [`OnceLock`] posture); the REFRESHABLE live/disk layer lives in
/// [`CatalogueRuntime`], not here.
static CATALOGUE: OnceLock<PretrainedCatalogue> = OnceLock::new();

/// The process-wide embedded bundled manifest (same posture).
static BUNDLED: OnceLock<BundledModels> = OnceLock::new();

/// A named catalogue load failure. Every variant carries a stable code — a
/// first-party file we shipped that we cannot interpret is a build/dep bug,
/// never something to degrade around (DEC-16; the LIVE path validates with
/// the same rules and DEGRADES instead).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CatalogueLoadError {
    /// The bytes are not the catalogue JSON (parse error; the message carries
    /// the parser's report).
    EmbedParse { file: &'static str, message: String },
    /// The `schema_version` differs from [`PRETRAINED_SCHEMA_VERSION`].
    SchemaVersion { found: u32 },
    /// The provenance block has an empty field (a generated file cannot).
    BadProvenance { field: &'static str },
    /// Two models share an id — the id is the identity key a consumer binds.
    DuplicateModelId { id: String },
    /// An id outside the catalogue slug grammar (the asset file name derives
    /// from it — a hostile value must never reach a path).
    IdInvalid { id: String },
    /// A version outside `major.minor.patch`.
    VersionInvalid { id: String, version: String },
    /// `asset.file` is not `<id>@<version>.txr` (the release-asset naming
    /// contract, INV-1).
    AssetFileMismatch { id: String },
    /// `asset.sha256` is not 64 lowercase hex.
    AssetSha256Format { id: String },
    /// `asset.size_bytes` is not > 0.
    AssetSizeInvalid { id: String },
    /// The asset URL has no parseable `http(s)://` host.
    AssetUrlMissing { id: String },
    /// The asset URL's host is outside the policy (PROV-landing-site-2).
    AssetUrlHost { id: String, host: Option<String> },
    /// The entry licence is empty after trimming (INV-3).
    LicenceEmpty { id: String },
    /// `data_sources[]` is empty (the card must record its sources — INV-3).
    DataSourcesEmpty { id: String },
    /// A source's access class is not `open` (INV-3).
    DataSourceAccess {
        id: String,
        dataset: String,
        access: String,
    },
    /// A source lacks a dataset name or a licence (INV-3).
    DataSourceFieldEmpty {
        id: String,
        dataset: String,
        field: &'static str,
    },
    /// The embedded cross-check against the sibling method catalogue failed
    /// (CONS-PC-2): unknown / not runnable / not frozen (published rules).
    MethodFacts {
        id: String,
        method_id: String,
        sub: &'static str,
    },
    /// The bundled manifest's schema_version differs.
    BundledSchemaVersion { found: u32 },
    /// Two bundled rows share an id.
    BundledDuplicateId { id: String },
    /// A bundled row has no matching catalogue entry with `bundled: true`.
    BundledOrphan { id: String },
    /// A catalogue entry with `bundled: true` is absent from the manifest, or
    /// the asset facts disagree between the two generated files.
    BundledMismatch { id: String, detail: &'static str },
}

impl CatalogueLoadError {
    /// The stable machine code of the failure.
    pub fn code(&self) -> &'static str {
        use CatalogueLoadError as E;
        match self {
            E::EmbedParse { .. } => "PRETRAINED_CATALOGUE_EMBED_INVALID",
            E::SchemaVersion { .. } => "PRETRAINED_CATALOGUE_SCHEMA_VERSION",
            E::BadProvenance { .. } => "PRETRAINED_CATALOGUE_PROVENANCE_INVALID",
            E::DuplicateModelId { .. } => "PRETRAINED_CATALOGUE_DUPLICATE_MODEL_ID",
            E::IdInvalid { .. } => "PRETRAINED_CATALOGUE_MODEL_ID_INVALID",
            E::VersionInvalid { .. } => "PRETRAINED_CATALOGUE_MODEL_VERSION_INVALID",
            E::AssetFileMismatch { .. } => "PRETRAINED_CATALOGUE_ASSET_FILE_MISMATCH",
            E::AssetSha256Format { .. } => "PRETRAINED_CATALOGUE_ASSET_SHA256_FORMAT",
            E::AssetSizeInvalid { .. } => "PRETRAINED_CATALOGUE_ASSET_SIZE_INVALID",
            E::AssetUrlMissing { .. } => "PRETRAINED_CATALOGUE_ASSET_URL_MISSING",
            E::AssetUrlHost { .. } => "PRETRAINED_CATALOGUE_ASSET_URL_HOST",
            E::LicenceEmpty { .. } => "PRETRAINED_CATALOGUE_LICENCE_EMPTY",
            E::DataSourcesEmpty { .. } => "PRETRAINED_CATALOGUE_DATA_SOURCES_EMPTY",
            E::DataSourceAccess { .. } => "PRETRAINED_CATALOGUE_DATA_SOURCE_ACCESS",
            E::DataSourceFieldEmpty { .. } => "PRETRAINED_CATALOGUE_DATA_SOURCE_FIELD",
            E::MethodFacts { .. } => "PRETRAINED_CATALOGUE_METHOD_FACTS",
            E::BundledSchemaVersion { .. } => "PRETRAINED_CATALOGUE_BUNDLED_SCHEMA_VERSION",
            E::BundledDuplicateId { .. } => "PRETRAINED_CATALOGUE_BUNDLED_DUPLICATE_ID",
            E::BundledOrphan { .. } => "PRETRAINED_CATALOGUE_BUNDLED_ORPHAN",
            E::BundledMismatch { .. } => "PRETRAINED_CATALOGUE_BUNDLED_MISMATCH",
        }
    }
}

impl std::fmt::Display for CatalogueLoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        use CatalogueLoadError as E;
        match self {
            E::EmbedParse { file, message } => write!(
                f,
                "PRETRAINED_CATALOGUE_EMBED_INVALID: {file} is not valid schema-{PRETRAINED_SCHEMA_VERSION} JSON: {message}"
            ),
            E::SchemaVersion { found } => write!(
                f,
                "PRETRAINED_CATALOGUE_SCHEMA_VERSION: the catalogue declares schema_version {found}, \
                 this build understands {PRETRAINED_SCHEMA_VERSION}"
            ),
            E::BadProvenance { field } => write!(
                f,
                "PRETRAINED_CATALOGUE_PROVENANCE_INVALID: generated_from.{field} is empty"
            ),
            E::DuplicateModelId { id } => write!(
                f,
                "PRETRAINED_CATALOGUE_DUPLICATE_MODEL_ID: model id `{id}` appears twice"
            ),
            E::IdInvalid { id } => write!(
                f,
                "PRETRAINED_CATALOGUE_MODEL_ID_INVALID: `{id}` is not a valid catalogue slug"
            ),
            E::VersionInvalid { id, version } => write!(
                f,
                "PRETRAINED_CATALOGUE_MODEL_VERSION_INVALID: model `{id}` version `{version}` \
                 is not semver"
            ),
            E::AssetFileMismatch { id } => write!(
                f,
                "PRETRAINED_CATALOGUE_ASSET_FILE_MISMATCH: model `{id}`'s asset.file is not \
                 <id>@<version>.txr"
            ),
            E::AssetSha256Format { id } => write!(
                f,
                "PRETRAINED_CATALOGUE_ASSET_SHA256_FORMAT: model `{id}`'s asset.sha256 is not \
                 64 lowercase hex"
            ),
            E::AssetSizeInvalid { id } => write!(
                f,
                "PRETRAINED_CATALOGUE_ASSET_SIZE_INVALID: model `{id}`'s asset.size_bytes must be > 0"
            ),
            E::AssetUrlMissing { id } => write!(
                f,
                "PRETRAINED_CATALOGUE_ASSET_URL_MISSING: model `{id}`'s asset.url has no \
                 http(s):// host"
            ),
            E::AssetUrlHost { id, host } => write!(
                f,
                "PRETRAINED_CATALOGUE_ASSET_URL_HOST: model `{id}`'s asset.url host {host:?} is \
                 outside {ALLOWED_ASSET_HOSTS:?}"
            ),
            E::LicenceEmpty { id } => write!(
                f,
                "PRETRAINED_CATALOGUE_LICENCE_EMPTY: model `{id}`'s licence is empty (INV-3)"
            ),
            E::DataSourcesEmpty { id } => write!(
                f,
                "PRETRAINED_CATALOGUE_DATA_SOURCES_EMPTY: model `{id}` records no data source (INV-3)"
            ),
            E::DataSourceAccess { id, dataset, access } => write!(
                f,
                "PRETRAINED_CATALOGUE_DATA_SOURCE_ACCESS: model `{id}` source `{dataset}` has \
                 access `{access}`, only `open` is permitted (INV-3)"
            ),
            E::DataSourceFieldEmpty { id, dataset, field } => write!(
                f,
                "PRETRAINED_CATALOGUE_DATA_SOURCE_FIELD: model `{id}` source `{dataset}` has an \
                 empty {field}"
            ),
            E::MethodFacts { id, method_id, sub } => write!(
                f,
                "PRETRAINED_CATALOGUE_METHOD_FACTS: model `{id}` method `{method_id}`: {sub} \
                 (CONS-PC-2)"
            ),
            E::BundledSchemaVersion { found } => write!(
                f,
                "PRETRAINED_CATALOGUE_BUNDLED_SCHEMA_VERSION: bundled-models.json declares \
                 schema_version {found}, this build understands {PRETRAINED_SCHEMA_VERSION}"
            ),
            E::BundledDuplicateId { id } => write!(
                f,
                "PRETRAINED_CATALOGUE_BUNDLED_DUPLICATE_ID: bundled model `{id}` appears twice"
            ),
            E::BundledOrphan { id } => write!(
                f,
                "PRETRAINED_CATALOGUE_BUNDLED_ORPHAN: bundled model `{id}` has no catalogue entry \
                 with bundled: true (PROV-PC-12 parity)"
            ),
            E::BundledMismatch { id, detail } => write!(
                f,
                "PRETRAINED_CATALOGUE_BUNDLED_MISMATCH: bundled model `{id}` {detail}"
            ),
        }
    }
}

impl std::error::Error for CatalogueLoadError {}

/// Whether `s` is a valid catalogue slug (the generator's `ID_SLUG` grammar —
/// the asset staging file name derives from it, so a hostile value must never
/// reach a path).
fn is_valid_slug(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit() => {}
        _ => return false,
    }
    s.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
}

/// Whether `s` is `major.minor.patch` (all decimal, non-empty).
fn is_semver(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

/// Whether `s` is 64 lowercase hex.
fn is_sha256(s: &str) -> bool {
    s.len() == 64
        && s.chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
}

/// The host of an `http(s)://` URL (the Python `host_of` port — no URL crate:
/// the parser the downloader + validator share, and the build-time check's
/// exact grammar).
pub fn host_of(url: &str) -> Option<&str> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let end = rest
        .find(|c| matches!(c, '/' | '?' | '#'))
        .unwrap_or(rest.len());
    let host = &rest[..end];
    if host.is_empty() {
        None
    } else {
        Some(host)
    }
}

/// Whether loopback (the network guard's own always-allowed set — the test
/// seams serve fixtures on 127.0.0.1). The shared `host_of` keeps the Python
/// grammar — the authority INCLUDING an optional port — so a loopback
/// fixture URL's host arrives as `127.0.0.1:<port>`; the port is part of the
/// authority, never of the hostname, and is ignored here (a fixture can only
/// answer on a non-privileged port, so a port-less match would make the
/// loopback allowance dead — TEST-PC-05/06's own fixture design).
fn is_loopback(host: &str) -> bool {
    let name = host
        .rsplit_once(':')
        .filter(|(_, port)| !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()))
        .map(|(hostname, _)| hostname)
        .unwrap_or(host);
    matches!(
        name,
        "127.0.0.1" | "localhost" | "::1" | "0.0.0.0" | "[::1]"
    )
}

/// The URL is within the app's outbound policy (the model-host rule, INV-5):
/// [`ALLOWED_ASSET_HOSTS`] or loopback.
pub fn host_allowed(url: &str) -> bool {
    match host_of(url) {
        Some(h) => ALLOWED_ASSET_HOSTS.contains(&h) || is_loopback(h),
        None => false,
    }
}

/// Parse + validate a catalogue document from arbitrary bytes (the shared
/// path of the embedded, disk and live loaders — a corrupted-byte test
/// exercises the REAL loader). `check_methods` adds CONS-PC-2's cross-check
/// against the sibling method catalogue — EMBEDDED BOOT VALIDATION ONLY: a
/// live catalogue may legitimately reference a method newer than this build
/// (the verdict then reports [`crate::modules::pretrained_catalogue::types::PretrainedReasonCode::NotRunnable`]),
/// and degrading the whole catalogue over it would be wrong (DEC-16's hygiene
/// list for live files does not include it).
pub fn parse_catalogue(
    bytes: &[u8],
    check_methods: bool,
) -> Result<PretrainedCatalogue, CatalogueLoadError> {
    let catalogue: PretrainedCatalogue =
        serde_json::from_slice(bytes).map_err(|e| CatalogueLoadError::EmbedParse {
            file: EMBEDDED_CATALOGUE_PATH,
            message: e.to_string(),
        })?;
    validate_catalogue(&catalogue, check_methods)?;
    Ok(catalogue)
}

/// The structural + hygiene boot checks over a parsed catalogue (PROV-PC-1's
/// acceptance facts, mirroring the generator's gate: licence, open access,
/// sha256 format, host policy, asset naming — the "same checks at both ends"
/// property of PROV-PC-5; a generated file and its reader cannot disagree).
fn validate_catalogue(
    c: &PretrainedCatalogue,
    check_methods: bool,
) -> Result<(), CatalogueLoadError> {
    if c.schema_version != PRETRAINED_SCHEMA_VERSION {
        return Err(CatalogueLoadError::SchemaVersion {
            found: c.schema_version,
        });
    }
    if c.generated_from.registry_name.is_empty() {
        return Err(CatalogueLoadError::BadProvenance {
            field: "registry_name",
        });
    }
    if c.generated_from.registry_commit.is_empty() {
        return Err(CatalogueLoadError::BadProvenance {
            field: "registry_commit",
        });
    }
    if c.generated_from.models_repo.is_empty() {
        return Err(CatalogueLoadError::BadProvenance {
            field: "models_repo",
        });
    }
    if c.generated_from.generated_at.is_empty() {
        return Err(CatalogueLoadError::BadProvenance {
            field: "generated_at",
        });
    }

    let mut ids: Vec<&str> = Vec::with_capacity(c.models.len());
    for m in &c.models {
        validate_model(m)?;
        if ids.contains(&m.id.as_str()) {
            return Err(CatalogueLoadError::DuplicateModelId { id: m.id.clone() });
        }
        ids.push(&m.id);
        if check_methods {
            validate_method_facts(m)?;
        }
    }
    Ok(())
}

/// One entry's own hygiene rules (the generator's per-entry gate, app-side).
fn validate_model(m: &PretrainedModel) -> Result<(), CatalogueLoadError> {
    if !is_valid_slug(&m.id) {
        return Err(CatalogueLoadError::IdInvalid { id: m.id.clone() });
    }
    if !is_semver(&m.version) {
        return Err(CatalogueLoadError::VersionInvalid {
            id: m.id.clone(),
            version: m.version.clone(),
        });
    }
    let expected_file = format!("{}@{}.txr", m.id, m.version);
    if m.asset.file != expected_file {
        return Err(CatalogueLoadError::AssetFileMismatch { id: m.id.clone() });
    }
    if !is_sha256(&m.asset.sha256) {
        return Err(CatalogueLoadError::AssetSha256Format { id: m.id.clone() });
    }
    if m.asset.size_bytes == 0 {
        return Err(CatalogueLoadError::AssetSizeInvalid { id: m.id.clone() });
    }
    match host_of(&m.asset.url) {
        Some(host) if ALLOWED_ASSET_HOSTS.contains(&host) || is_loopback(host) => {}
        Some(host) => {
            return Err(CatalogueLoadError::AssetUrlHost {
                id: m.id.clone(),
                host: Some(host.to_string()),
            })
        }
        None => return Err(CatalogueLoadError::AssetUrlMissing { id: m.id.clone() }),
    }
    if m.licence.trim().is_empty() {
        return Err(CatalogueLoadError::LicenceEmpty { id: m.id.clone() });
    }
    if m.data_sources.is_empty() {
        return Err(CatalogueLoadError::DataSourcesEmpty { id: m.id.clone() });
    }
    for source in &m.data_sources {
        if source.dataset.trim().is_empty() {
            return Err(CatalogueLoadError::DataSourceFieldEmpty {
                id: m.id.clone(),
                dataset: source.dataset.clone(),
                field: "dataset",
            });
        }
        if source.licence.trim().is_empty() {
            return Err(CatalogueLoadError::DataSourceFieldEmpty {
                id: m.id.clone(),
                dataset: source.dataset.clone(),
                field: "licence",
            });
        }
        if source.access != PretrainedDataSourceAccess::Open {
            return Err(CatalogueLoadError::DataSourceAccess {
                id: m.id.clone(),
                dataset: source.dataset.clone(),
                access: source.access.as_str().to_string(),
            });
        }
    }
    Ok(())
}

/// CONS-PC-2's embedded boot cross-check (the UNION of the acceptance
/// sentences): every entry's `method_id` exists in the method catalogue and
/// is runnable; a published-rule entry's method is additionally a frozen,
/// containerized, gate-passed method (DEC-1's selection — the generator
/// enforces the same at build time, this is the runtime half).
fn validate_method_facts(m: &PretrainedModel) -> Result<(), CatalogueLoadError> {
    let method_facts_err = |sub: &'static str| CatalogueLoadError::MethodFacts {
        id: m.id.clone(),
        method_id: m.method_id.clone(),
        sub,
    };
    let Some(method) = method_catalogue::catalogue::method(&m.method_id) else {
        return Err(method_facts_err(
            "the method is absent from the method catalogue",
        ));
    };
    if !method.runnable {
        return Err(method_facts_err(
            "the method is not runnable in the current catalogue",
        ));
    }
    if m.kind == PretrainedKind::PublishedRule {
        if !method.frozen_model {
            return Err(method_facts_err(
                "a published-rule entry's method is not frozen_model: true",
            ));
        }
        if !method.container {
            return Err(method_facts_err(
                "a published-rule entry's method is not containerized",
            ));
        }
        if !method.gate.pass {
            return Err(method_facts_err(
                "a published-rule entry's method did not pass the wrapper gate",
            ));
        }
    }
    Ok(())
}

/// Parse + validate the bundled manifest (PROV-PC-12's one-source manifest).
pub fn parse_bundled(bytes: &[u8]) -> Result<BundledModels, CatalogueLoadError> {
    let bundled: BundledModels =
        serde_json::from_slice(bytes).map_err(|e| CatalogueLoadError::EmbedParse {
            file: EMBEDDED_BUNDLED_PATH,
            message: e.to_string(),
        })?;
    if bundled.schema_version != PRETRAINED_SCHEMA_VERSION {
        return Err(CatalogueLoadError::BundledSchemaVersion {
            found: bundled.schema_version,
        });
    }
    let mut ids: Vec<&str> = Vec::with_capacity(bundled.models.len());
    for row in &bundled.models {
        if !is_valid_slug(&row.id) {
            return Err(CatalogueLoadError::IdInvalid { id: row.id.clone() });
        }
        if !is_semver(&row.version) {
            return Err(CatalogueLoadError::VersionInvalid {
                id: row.id.clone(),
                version: row.version.clone(),
            });
        }
        if row.file != format!("{}@{}.txr", row.id, row.version) {
            return Err(CatalogueLoadError::AssetFileMismatch { id: row.id.clone() });
        }
        if !is_sha256(&row.sha256) {
            return Err(CatalogueLoadError::AssetSha256Format { id: row.id.clone() });
        }
        if row.size_bytes == 0 {
            return Err(CatalogueLoadError::AssetSizeInvalid { id: row.id.clone() });
        }
        if !host_allowed(&row.url) {
            return Err(CatalogueLoadError::AssetUrlHost {
                id: row.id.clone(),
                host: host_of(&row.url).map(str::to_string),
            });
        }
        if ids.contains(&row.id.as_str()) {
            return Err(CatalogueLoadError::BundledDuplicateId { id: row.id.clone() });
        }
        ids.push(&row.id);
    }
    Ok(bundled)
}

/// Load (once) the embedded catalogue. The module `init` calls this and
/// returns the error to the boot path — a refusal means the server does not
/// serve (DEC-16).
pub fn ensure_loaded() -> Result<&'static PretrainedCatalogue, CatalogueLoadError> {
    if CATALOGUE.get().is_some() {
        return Ok(CATALOGUE.get().expect("checked above"));
    }
    // CONS-PC-2's method cross-check applies to the EMBEDDED file only (the
    // boot snapshot is generated against the same method catalogue this build
    // ships; the live layer may legitimately be newer — see `parse_catalogue`).
    let parsed = parse_catalogue(CATALOGUE_JSON, true)?;
    let _ = CATALOGUE.set(parsed);
    Ok(CATALOGUE
        .get()
        .expect("installed by this call or a concurrent one"))
}

/// Load (once) the embedded bundled manifest.
pub fn ensure_bundled_loaded() -> Result<&'static BundledModels, CatalogueLoadError> {
    if BUNDLED.get().is_some() {
        return Ok(BUNDLED.get().expect("checked above"));
    }
    let parsed = parse_bundled(BUNDLED_JSON)?;
    let _ = BUNDLED.set(parsed);
    Ok(BUNDLED
        .get()
        .expect("installed by this call or a concurrent one"))
}

/// The boot-time parity check of the two generated files (PROV-PC-1's
/// acceptance: `bundled-models.json` == the `asset` fields of the entries with
/// `bundled: true`). Both embeds are loaded before this runs (module init).
pub fn validate_bundled_parity() -> Result<(), CatalogueLoadError> {
    let catalogue = catalogue();
    let bundled = bundled_assets();
    let bundled_ids: Vec<&str> = bundled.iter().map(|b| b.id.as_str()).collect();
    for row in bundled {
        let Some(m) = model(&row.id) else {
            return Err(CatalogueLoadError::BundledOrphan { id: row.id.clone() });
        };
        if !m.asset.bundled {
            return Err(CatalogueLoadError::BundledOrphan { id: row.id.clone() });
        }
        if m.asset.file != row.file {
            return Err(CatalogueLoadError::BundledMismatch {
                id: row.id.clone(),
                detail: "carries a different file than the catalogue asset",
            });
        }
        if m.asset.url != row.url {
            return Err(CatalogueLoadError::BundledMismatch {
                id: row.id.clone(),
                detail: "carries a different url than the catalogue asset",
            });
        }
        if m.asset.sha256 != row.sha256 {
            return Err(CatalogueLoadError::BundledMismatch {
                id: row.id.clone(),
                detail: "carries a different sha256 than the catalogue asset",
            });
        }
        if m.asset.size_bytes != row.size_bytes {
            return Err(CatalogueLoadError::BundledMismatch {
                id: row.id.clone(),
                detail: "carries a different size_bytes than the catalogue asset",
            });
        }
    }
    for m in &catalogue.models {
        if m.asset.bundled && !bundled_ids.contains(&m.id.as_str()) {
            return Err(CatalogueLoadError::BundledMismatch {
                id: m.id.clone(),
                detail: "is marked bundled but absent from the bundled manifest",
            });
        }
    }
    Ok(())
}

/// The boot-validated embedded catalogue.
pub fn catalogue() -> &'static PretrainedCatalogue {
    ensure_loaded().expect(
        "pretrained_catalogue: the embedded catalogue failed its boot check — a malformed \
         first-party catalogue is a boot refusal, not a silently empty one",
    )
}

/// Look an entry up by its stable id (the PROV-PC-9 in-process seam; the
/// EMBEDDED snapshot — the live/disk layer is the runtime's active view, see
/// [`CatalogueRuntime`]).
pub fn model(id: &str) -> Option<&'static PretrainedModel> {
    catalogue().models.iter().find(|m| m.id == id)
}

/// The embedded bundled manifest (PROV-PC-9: the installer-build extract the
/// runtime's bundled state + per-file verification read; boot-validated).
pub fn bundled_assets() -> &'static [BundledAsset] {
    ensure_bundled_loaded()
        .expect("pretrained_catalogue: the embedded bundled manifest failed its boot check")
        .models
        .as_slice()
}

/// The max byte size of a fetched catalogue (a live body larger than this is
/// refused — the catalogue is bounded; 16 MiB is far beyond the real file and
/// far below a memory concern).
pub const MAX_CATALOGUE_BYTES: u64 = 16 * 1024 * 1024;

/// The refreshing side's failure kinds (all mapped to silent degradation).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RefreshError {
    /// The fetch itself failed (DNS, refused, timeout, HTTP status).
    Fetch { url: String, detail: String },
    /// The body was larger than [`MAX_CATALOGUE_BYTES`].
    TooLarge { bytes: u64 },
    /// The fetched document failed the schema/hygiene validation.
    Validation { code: &'static str, message: String },
    /// The last-good disk copy could not be written (read-only data dir).
    WriteLastGood { detail: String },
}

impl std::fmt::Display for RefreshError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RefreshError::Fetch { url, detail } => write!(f, "fetch {url}: {detail}"),
            RefreshError::TooLarge { bytes } => write!(
                f,
                "the fetched catalogue is {bytes} bytes (the cap is {MAX_CATALOGUE_BYTES})"
            ),
            RefreshError::Validation { code, message } => write!(f, "{code}: {message}"),
            RefreshError::WriteLastGood { detail } => write!(f, "last-good write: {detail}"),
        }
    }
}

impl std::error::Error for RefreshError {}

/// The test seams (PROV-PC-9 — constructor args; every field is None in
/// release default resolution except the documented env overrides).
#[derive(Clone, Debug, Default)]
pub struct PretrainedCatalogueSeams {
    /// The catalogue fetch URL (default: the `TXR_CATALOGUE_URL` env, or
    /// [`CATALOGUE_URL`]).
    pub catalogue_url: Option<String>,
    /// The HTTP client (default: a bounded-timeout reqwest client).
    pub http: Option<reqwest::Client>,
    /// The bundled-models dir (default:
    /// `TXR_BUNDLED_MODELS_DIR` or `<data_root>/pretrained-bundled`).
    pub bundled_dir: Option<PathBuf>,
    /// The app data root (default: `rootfs::data_root()`).
    pub data_root: Option<PathBuf>,
}

impl PretrainedCatalogueSeams {
    /// The resolved catalogue URL.
    pub fn catalogue_url(&self) -> String {
        if let Some(u) = self.catalogue_url.as_deref().filter(|u| !u.is_empty()) {
            return u.to_string();
        }
        std::env::var(CATALOGUE_URL_ENV)
            .ok()
            .filter(|u| !u.is_empty())
            .unwrap_or_else(|| CATALOGUE_URL.to_string())
    }

    /// The resolved HTTP client (short connect timeout — an offline machine
    /// must fail the boot refresh fast; the whole refresh is a background
    /// task, never a boot blocker).
    pub fn http_client(&self) -> reqwest::Client {
        if let Some(c) = &self.http {
            return c.clone();
        }
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(30))
            .build()
            .expect("the default reqwest client builds")
    }

    /// The resolved app data root.
    pub fn data_root(&self) -> PathBuf {
        self.data_root.clone().unwrap_or_else(rootfs::data_root)
    }

    /// The resolved bundled dir (PROV-PC-12's `TXR_BUNDLED_MODELS_DIR`).
    pub fn bundled_dir(&self) -> PathBuf {
        if let Some(d) = &self.bundled_dir {
            return d.clone();
        }
        std::env::var_os("TXR_BUNDLED_MODELS_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| self.data_root().join("pretrained-bundled"))
    }

    /// The last-good catalogue copy path (DEC-13's layout).
    pub fn last_good_path(&self) -> PathBuf {
        self.data_root()
            .join("txr-pretrained")
            .join("catalogue.json")
    }
}

/// The active catalogue layer (the runtime view the routes serve).
#[derive(Debug, Clone)]
pub struct ActiveCatalogue {
    pub origin: PretrainedOrigin,
    pub catalogue: Arc<PretrainedCatalogue>,
}

/// The catalogue runtime: the refreshable live → disk → embedded source
/// (PROV-PC-5). The embedded snapshot itself is a separate [`OnceLock`]
/// (PROV-PC-9); this runtime starts ON the embedded layer and swaps in the
/// disk/live layers on refresh.
pub struct CatalogueRuntime {
    seams: PretrainedCatalogueSeams,
    active: RwLock<ActiveCatalogue>,
}

impl CatalogueRuntime {
    /// A runtime starting on the embedded layer (the boot state; the boot
    /// refresh task then elevates it).
    pub fn new(seams: PretrainedCatalogueSeams) -> Self {
        let embedded = Arc::new(catalogue().clone());
        Self {
            seams,
            active: RwLock::new(ActiveCatalogue {
                origin: PretrainedOrigin::Embedded,
                catalogue: embedded,
            }),
        }
    }

    /// The seams the runtime was built with (ITEM-4's downloader + ITEM-5's
    /// routes read the same bundle layout from it).
    pub fn seams(&self) -> &PretrainedCatalogueSeams {
        &self.seams
    }

    /// The current active layer.
    pub fn active(&self) -> ActiveCatalogue {
        self.active
            .read()
            .expect("the catalogue runtime lock is not poisoned")
            .clone()
    }

    /// The current origin (no catalogue clone).
    pub fn origin(&self) -> PretrainedOrigin {
        self.active().origin
    }

    /// `cached_at` — the active catalogue's generation date.
    pub fn cached_at(&self) -> Option<String> {
        Some(self.active().catalogue.generated_from.generated_at.clone())
    }

    /// Refresh the active catalogue (PROV-PC-5): live (fetch + validate +
    /// write the last-good copy) → disk (read + validate the last good copy)
    /// → keep the current layer. A failure at any live step is silent and
    /// degrades — a bad remote file must never brick the app (DEC-16), and
    /// offline is a valid state (INV-8).
    pub async fn refresh(&self) -> PretrainedRefreshResponse {
        match self.try_live().await {
            Ok((bytes, catalogue)) => {
                // Write the last-good copy; a write failure is NON-fatal (the
                // live layer still serves — the next boot just re-fetches or
                // falls back to embedded).
                if let Err(e) = self.write_last_good(&bytes) {
                    tracing::warn!(
                        "pretrained catalogue: live refresh succeeded but the last-good copy \
                         could not be written: {e}"
                    );
                }
                self.swap(PretrainedOrigin::Live, catalogue)
            }
            Err(e) => {
                tracing::debug!("pretrained catalogue: live refresh unavailable ({e})");
                match self.try_disk() {
                    Some(catalogue) => self.swap(PretrainedOrigin::Disk, catalogue),
                    None => self.swap_current(),
                }
            }
        }
    }

    /// Fetch + validate the live catalogue. The request is a plain GET of the
    /// catalogue URL: no query string, no path parameter, no cookie, no
    /// custom header (INV-4 — pinned by TEST-PC-04's unit leg).
    async fn try_live(&self) -> Result<(Vec<u8>, PretrainedCatalogue), RefreshError> {
        let url = self.seams.catalogue_url();
        let client = self.seams.http_client();
        let response = client
            .get(&url)
            .send()
            .await
            .map_err(|e| RefreshError::Fetch {
                url: url.clone(),
                detail: e.to_string(),
            })?;
        if !response.status().is_success() {
            return Err(RefreshError::Fetch {
                url: url.clone(),
                detail: format!("HTTP {}", response.status()),
            });
        }
        if let Some(len) = response.content_length() {
            if len > MAX_CATALOGUE_BYTES {
                return Err(RefreshError::TooLarge { bytes: len });
            }
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|e| RefreshError::Fetch {
                url: url.clone(),
                detail: e.to_string(),
            })?
            .to_vec();
        if bytes.len() as u64 > MAX_CATALOGUE_BYTES {
            return Err(RefreshError::TooLarge {
                bytes: bytes.len() as u64,
            });
        }
        let catalogue = parse_catalogue(&bytes, false).map_err(|e| RefreshError::Validation {
            code: e.code(),
            message: e.to_string(),
        })?;
        Ok((bytes, catalogue))
    }

    /// Read + validate the last-good disk copy.
    fn try_disk(&self) -> Option<PretrainedCatalogue> {
        let path = self.seams.last_good_path();
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(_) => return None,
        };
        match parse_catalogue(&bytes, false) {
            Ok(c) => Some(c),
            Err(e) => {
                tracing::warn!(
                    "pretrained catalogue: last-good copy {} failed validation ({e}); \
                     degrading to the embedded snapshot",
                    path.display()
                );
                None
            }
        }
    }

    /// Atomically write the last-good copy (`tmp` + rename: a crash mid-write
    /// leaves the previous good copy, never a partial one).
    fn write_last_good(&self, bytes: &[u8]) -> std::io::Result<()> {
        let path = self.seams.last_good_path();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, bytes)?;
        std::fs::rename(&tmp, &path)?;
        Ok(())
    }

    fn swap(
        &self,
        origin: PretrainedOrigin,
        catalogue: PretrainedCatalogue,
    ) -> PretrainedRefreshResponse {
        {
            let mut active = self
                .active
                .write()
                .expect("the catalogue runtime lock is not poisoned");
            active.origin = origin;
            active.catalogue = Arc::new(catalogue);
        }
        let active = self.active();
        PretrainedRefreshResponse {
            origin: active.origin,
            models: active.catalogue.models.len() as u32,
            cached_at: Some(active.catalogue.generated_from.generated_at.clone()),
        }
    }

    fn swap_current(&self) -> PretrainedRefreshResponse {
        let active = self.active();
        PretrainedRefreshResponse {
            origin: active.origin,
            models: active.catalogue.models.len() as u32,
            cached_at: Some(active.catalogue.generated_from.generated_at.clone()),
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// The TEST-PC-03/04 (ITEM-3 unit half) + the loader suite: the embedded file
// parses + validates (empty `models[]` is valid — the shipped snapshot), a
// corrupted document is a NAMED boot refusal, the hygiene + CONS-PC-2 rules
// refuse exactly, the refresh's origin order (live → disk → embedded) and the
// loopback request's no-identifier shape are pinned against a REAL little
// HTTP server, and the bundled parity check holds.
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::pretrained_catalogue::types::{
        PretrainedAsset, PretrainedCatalogue, PretrainedEndpoint, PretrainedEnv,
        PretrainedGeneratedFrom, PretrainedKind, PretrainedMarkerFacts, PretrainedModel,
        PretrainedNeeds, PretrainedPaper, PretrainedTransfer, PretrainedTransferCohort,
        PretrainedTransferMetric,
    };

    /// The fixture loopback server: binds 127.0.0.1:0, answers every request
    /// with one fixed status + body, and RECORDS the request line + headers
    /// (the INV-4 assertions read the actual request stream). Serves plain
    /// HTTP/1.1 — no framework, no extra dependency, and every connection is
    /// served until the task is aborted.
    struct FixtureHttpServer {
        port: u16,
        requests: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
        headers: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
        task: tokio::task::JoinHandle<()>,
    }

    impl FixtureHttpServer {
        async fn spawn(body: Vec<u8>, status: &'static str) -> Self {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                .await
                .expect("loopback bind");
            let port = listener.local_addr().expect("addr").port();
            let requests: std::sync::Arc<std::sync::Mutex<Vec<String>>> =
                std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
            let headers: std::sync::Arc<std::sync::Mutex<Vec<String>>> =
                std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
            let reqs = requests.clone();
            let hdrs = headers.clone();
            let task = tokio::spawn(async move {
                loop {
                    let (mut stream, _) = match listener.accept().await {
                        Ok(v) => v,
                        Err(_) => return,
                    };
                    let mut buf = Vec::new();
                    let mut tmp = [0u8; 1024];
                    loop {
                        match stream.read(&mut tmp).await {
                            Ok(0) => break,
                            Ok(n) => {
                                buf.extend_from_slice(&tmp[..n]);
                                if buf.windows(4).any(|w| w == b"\r\n\r\n") || buf.len() > 64 * 1024
                                {
                                    break;
                                }
                            }
                            Err(_) => break,
                        }
                    }
                    let head = String::from_utf8_lossy(&buf);
                    let request_line = head.lines().next().unwrap_or("").to_string();
                    let mut header_text = String::new();
                    for line in head.lines().skip(1) {
                        if line.trim().is_empty() {
                            break;
                        }
                        header_text.push_str(line);
                        header_text.push('\n');
                    }
                    reqs.lock().expect("request log").push(request_line);
                    hdrs.lock().expect("header log").push(header_text);
                    let mut out = format!(
                        "HTTP/1.1 {status}\r\ncontent-length: {}\r\ncontent-type: \
                         application/json\r\nconnection: close\r\n\r\n",
                        body.len()
                    )
                    .into_bytes();
                    out.extend_from_slice(&body);
                    let _ = stream.write_all(&out).await;
                    let _ = stream.shutdown().await;
                }
            });
            Self {
                port,
                requests,
                headers,
                task,
            }
        }

        async fn stop(self) {
            self.task.abort();
            let _ = self.task.await;
        }
    }

    /// A valid one-entry catalogue document (synthetic facts; the same shape
    /// the generator emits).
    fn sample_entry(id: &str, url: &str) -> PretrainedModel {
        PretrainedModel {
            id: id.to_string(),
            version: "1.0.0".to_string(),
            kind: PretrainedKind::PublishedRule,
            name: "Sample rule".to_string(),
            description: "A synthetic card fact set.".to_string(),
            method_id: "landmark-cox-current".to_string(),
            method_version: "2.0.0".to_string(),
            group: "dynamic-risk".to_string(),
            group_label: "Dynamic risk".to_string(),
            paper: Some(PretrainedPaper {
                journal: "Synthetic Journal".to_string(),
                year: 2024,
                doi: "10.0000/sample".to_string(),
                citation: "Sample et al. 2024.".to_string(),
            }),
            needs: PretrainedNeeds {
                marker_facts: PretrainedMarkerFacts {
                    kind: crate::modules::method_catalogue::types::MarkerKind::Single,
                    count: 1,
                    min_draws: 1,
                    needs_baseline: true,
                    uses_history: crate::modules::method_catalogue::types::UsesHistory::Landmark,
                    needs_detection_call: false,
                    marker_groups_required: vec![],
                },
                required_markers: None,
                covariates: crate::modules::method_catalogue::types::CovariateMode::None,
                decision_day: 56.0,
                endpoint: PretrainedEndpoint::Pfs,
                horizon: 180.0,
                task: Some(crate::modules::pretrained_catalogue::types::PretrainedTask::Survival),
            },
            env: PretrainedEnv {
                base_digest: format!("sha256:{}", "aa".repeat(32)),
                layer_digest: format!("sha256:{}", "bb".repeat(32)),
            },
            contract: "2.0".to_string(),
            embeds_training_data: false,
            transfer: Some(PretrainedTransfer {
                metric: PretrainedTransferMetric::AucRule,
                median: 0.64,
                n_cohorts: 1,
                cohorts: vec![PretrainedTransferCohort {
                    dataset: "fx-dataset-1".to_string(),
                    value: 0.64,
                }],
            }),
            assay_warnings: vec![],
            research_notice: true,
            licence: "CC0 1.0".to_string(),
            data_sources: vec![crate::modules::pretrained_catalogue::types::PretrainedDataSource {
                dataset: "fx-dataset-1".to_string(),
                access: crate::modules::pretrained_catalogue::types::PretrainedDataSourceAccess::Open,
                licence: "CC0 1.0".to_string(),
            }],
            asset: PretrainedAsset {
                bundled: false,
                file: format!("{id}@1.0.0.txr"),
                url: url.to_string(),
                size_bytes: 1428,
                sha256: "ec32260606c50f2076bc959c6197d69b3414fb1b7ef9f5baeedd60625eada8fd".to_string(),
                signature: String::new(),
            },
        }
    }

    fn sample_catalogue(entries: Vec<PretrainedModel>) -> PretrainedCatalogue {
        PretrainedCatalogue {
            schema_version: PRETRAINED_SCHEMA_VERSION,
            generated_from: PretrainedGeneratedFrom {
                registry_name: "fixtures (synthetic)".to_string(),
                registry_commit: "fixture".to_string(),
                models_repo: "tinnlab/txresbench-models".to_string(),
                generated_at: "2026-01-01T00:00:00Z".to_string(),
            },
            models: entries,
        }
    }

    fn sample_bytes(entries: Vec<PretrainedModel>) -> Vec<u8> {
        serde_json::to_vec(&sample_catalogue(entries)).expect("sample catalogue serializes")
    }

    /// TEST-PC-01 (loader half): the committed embedded snapshot parses +
    /// validates, and an EMPTY `models[]` is VALID — the shipped snapshot
    /// carries zero entries until the owner's publish pass (DRIFT-1 ITEM-3's
    /// resolution; absent/malformed is the boot failure, empty is not).
    #[test]
    fn embedded_catalogue_loads_and_validates() {
        let c = catalogue();
        assert_eq!(c.schema_version, PRETRAINED_SCHEMA_VERSION);
        assert_eq!(c.generated_from.models_repo, "tinnlab/txresbench-models");
        assert!(
            c.models.is_empty(),
            "the shipped snapshot has no published assets yet"
        );
    }

    /// TEST-PC-01 (loader half): the malformed case is a NAMED boot refusal
    /// carrying the FILE name (the absent case cannot reach runtime —
    /// `include_bytes!` fails the build that claims to ship the file).
    #[test]
    fn malformed_catalogue_is_a_named_boot_refusal() {
        let err = parse_catalogue(b"{ not json", false).unwrap_err();
        assert_eq!(err.code(), "PRETRAINED_CATALOGUE_EMBED_INVALID");
        let s = format!("{err}");
        assert!(
            s.contains("data/pretrained-catalogue/catalogue.json"),
            "{s}"
        );
    }

    #[test]
    fn unknown_schema_version_fails_with_named_error() {
        let mut c = sample_catalogue(vec![]);
        c.schema_version = 2;
        let bytes = serde_json::to_vec(&c).expect("serialize");
        let err = parse_catalogue(&bytes, false).unwrap_err();
        assert_eq!(err.code(), "PRETRAINED_CATALOGUE_SCHEMA_VERSION");
    }

    #[test]
    fn duplicate_model_id_fails_with_named_error() {
        let bytes = sample_bytes(vec![
            sample_entry("dup", "https://github.com/tinnlab/txresbench-models/releases/download/x-v1.0.0/x@1.0.0.txr"),
            sample_entry("dup", "https://github.com/tinnlab/txresbench-models/releases/download/x-v1.0.0/x@1.0.0.txr"),
        ]);
        let err = parse_catalogue(&bytes, false).unwrap_err();
        assert_eq!(err.code(), "PRETRAINED_CATALOGUE_DUPLICATE_MODEL_ID");
    }

    /// The hygiene rules, one refusal per rule (the generator's gate, app-side
    /// — the runtime never serves what the build gate would refuse).
    #[test]
    fn hygiene_rules_refuse_exactly() {
        let good =
            "https://github.com/tinnlab/txresbench-models/releases/download/x-v1.0.0/x@1.0.0.txr";
        let bad_sha = {
            let mut m = sample_entry("x", good);
            m.asset.sha256 = "zz".repeat(32);
            m
        };
        let err = parse_catalogue(&sample_bytes(vec![bad_sha]), false).unwrap_err();
        assert_eq!(err.code(), "PRETRAINED_CATALOGUE_ASSET_SHA256_FORMAT");

        let bad_file = {
            let mut m = sample_entry("x", good);
            m.asset.file = "x@9.9.9.txr".to_string();
            m
        };
        let err = parse_catalogue(&sample_bytes(vec![bad_file]), false).unwrap_err();
        assert_eq!(err.code(), "PRETRAINED_CATALOGUE_ASSET_FILE_MISMATCH");

        let bad_host = sample_entry("x", "https://evil.example/x@1.0.0.txr");
        let err = parse_catalogue(&sample_bytes(vec![bad_host]), false).unwrap_err();
        assert_eq!(err.code(), "PRETRAINED_CATALOGUE_ASSET_URL_HOST");

        let empty_licence = {
            let mut m = sample_entry("x", good);
            m.licence = "   ".to_string();
            m
        };
        let err = parse_catalogue(&sample_bytes(vec![empty_licence]), false).unwrap_err();
        assert_eq!(err.code(), "PRETRAINED_CATALOGUE_LICENCE_EMPTY");

        let controlled = {
            let mut m = sample_entry("x", good);
            m.data_sources[0].access =
                crate::modules::pretrained_catalogue::types::PretrainedDataSourceAccess::Controlled;
            m
        };
        let err = parse_catalogue(&sample_bytes(vec![controlled]), false).unwrap_err();
        assert_eq!(err.code(), "PRETRAINED_CATALOGUE_DATA_SOURCE_ACCESS");

        let empty_sources = {
            let mut m = sample_entry("x", good);
            m.data_sources = vec![];
            m
        };
        let err = parse_catalogue(&sample_bytes(vec![empty_sources]), false).unwrap_err();
        assert_eq!(err.code(), "PRETRAINED_CATALOGUE_DATA_SOURCES_EMPTY");

        let bad_id = {
            let mut m = sample_entry("x", good);
            m.id = "../escape".to_string();
            m
        };
        let err = parse_catalogue(&sample_bytes(vec![bad_id]), false).unwrap_err();
        assert_eq!(err.code(), "PRETRAINED_CATALOGUE_MODEL_ID_INVALID");
    }

    /// TEST-PC-04/05 (the gate half): the host policy matches a
    /// port-bearing loopback authority (the shared `host_of` keeps the
    /// authority's optional port per the Python grammar — the loopback
    /// fixtures can only answer on a non-privileged port, and TEST-PC-05/06
    /// download from exactly such URLs), still refuses a non-allowlisted
    /// REAL host, and never confuses a suffix host with loopback.
    #[test]
    fn host_policy_accepts_port_bearing_loopback_only() {
        assert!(host_allowed("http://127.0.0.1:35957/assets/x@1.0.0.txr"));
        assert!(host_allowed("http://localhost:8080/assets/x.txr"));
        assert!(host_allowed("http://127.0.0.1/assets/x.txr"));
        assert!(host_allowed("http://[::1]:8080/assets/x.txr"));
        assert!(host_allowed(
            "https://github.com/tinnlab/txresbench-models/releases/download/x-v1.0.0/x@1.0.0.txr"
        ));
        assert!(!host_allowed(
            "http://127.0.0.1.evil.example:9/assets/x.txr"
        ));
        assert!(!host_allowed(
            "http://not-on-the-allowlist.example.invalid/assets/x.txr"
        ));
        assert!(!host_allowed("not a url"));
    }

    /// ITEM-6's bread (the kind/version shapes of PROV-PC-1): a
    /// `benchmark-trained` entry is NOT required to be a frozen rule — the
    /// DEC-1 selection sentence applies to `published-rule` only (a
    /// benchmark-trained entry of an ordinary runnable, non-frozen method is
    /// a VALID card even under the bootstrap cross-check), while the same
    /// method on a `published-rule` entry is the CONS-PC-2 refusal; a
    /// non-semver version is its own named refusal.
    #[test]
    fn kind_and_version_shapes_validate_as_declared() {
        let good =
            "https://github.com/tinnlab/txresbench-models/releases/download/x-v1.0.0/x@1.0.0.txr";
        // cox-cutpoint-risk: runnable + containerized + gate-passed but NOT
        // frozen (measured in the committed method catalogue).
        let mut trained = sample_entry("x", good);
        trained.kind = PretrainedKind::BenchmarkTrained;
        trained.method_id = "cox-cutpoint-risk".to_string();
        let parsed = parse_catalogue(&sample_bytes(vec![trained]), true)
            .expect("a benchmark-trained entry of an ordinary runnable method is valid");
        assert_eq!(
            parsed.models[0].kind,
            PretrainedKind::BenchmarkTrained,
            "the kind round-trips"
        );

        // The same method on a published-rule entry: frozen is required.
        let mut rule = sample_entry("x", good);
        rule.kind = PretrainedKind::PublishedRule;
        rule.method_id = "cox-cutpoint-risk".to_string();
        let err = parse_catalogue(&sample_bytes(vec![rule]), true).unwrap_err();
        assert_eq!(err.code(), "PRETRAINED_CATALOGUE_METHOD_FACTS");

        // A frozen + runnable + containerized + gate-passed method IS the
        // published-rule shape the generator emits (the positive arm).
        let mut frozen = sample_entry("x", good);
        frozen.method_id = "ctdna-anytime-detectability".to_string();
        let parsed = parse_catalogue(&sample_bytes(vec![frozen]), true)
            .expect("a frozen published-rule method passes the bootstrap cross-check");
        assert_eq!(parsed.models.len(), 1);

        // Version shapes: the semver grammar is `major.minor.patch`.
        let bad_version = {
            let mut m = sample_entry("x", good);
            m.version = "1.0".to_string();
            m
        };
        let err = parse_catalogue(&sample_bytes(vec![bad_version]), false).unwrap_err();
        assert_eq!(err.code(), "PRETRAINED_CATALOGUE_MODEL_VERSION_INVALID");
    }

    /// CONS-PC-2: the cross-check is bootstrap-only (a live catalogue may be
    /// newer than this build — the hygiene validation must not consult the
    /// method catalogue).
    #[test]
    fn method_facts_check_only_applies_when_requested() {
        let good =
            "https://github.com/tinnlab/txresbench-models/releases/download/x-v1.0.0/x@1.0.0.txr";
        let mut m = sample_entry("x", good);
        m.method_id = "no-such-method".to_string();
        let bytes = sample_bytes(vec![m]);

        // Bootstrap path: unknown method → named refusal.
        let err = parse_catalogue(&bytes, true).unwrap_err();
        assert_eq!(err.code(), "PRETRAINED_CATALOGUE_METHOD_FACTS");

        // Live/disk path: hygiene-only — the entry stays (the verdict later
        // reports NOT_RUNNABLE for it, never degrades the whole catalogue).
        let parsed = parse_catalogue(&bytes, false).expect("hygiene-only validation passes");
        assert_eq!(parsed.models.len(), 1);
    }

    /// TEST-PC-03 (ITEM-3 half): the origin order live → disk → embedded and
    /// the last-good write, against a REAL loopback HTTP server; and a
    /// malformed live payload degrades instead of failing.
    #[tokio::test]
    async fn refresh_falls_back_live_disk_embedded() {
        // The seams' data root + the loopback server are per-test: no global
        // state, no env mutation (the env_image.rs contamination note).
        let root = std::env::temp_dir().join(format!("pc-refresh-{}", uuid::Uuid::new_v4()));

        // 1) Live up: refresh → Live, last-good copy written byte-exact.
        let live_body = sample_bytes(vec![sample_entry(
            "relchange-threshold",
            "https://github.com/tinnlab/txresbench-models/releases/download/relchange-threshold-v1.0.0/relchange-threshold@1.0.0.txr",
        )]);
        let server = FixtureHttpServer::spawn(live_body.clone(), "200 OK").await;
        let seams = PretrainedCatalogueSeams {
            catalogue_url: Some(format!("http://127.0.0.1:{}/catalogue.json", server.port)),
            http: None,
            bundled_dir: None,
            data_root: Some(root.clone()),
        };
        let runtime = CatalogueRuntime::new(seams);
        let response = runtime.refresh().await;
        assert_eq!(response.origin, PretrainedOrigin::Live);
        assert_eq!(response.models, 1);
        assert_eq!(
            runtime.active().catalogue.models[0].id,
            "relchange-threshold"
        );
        let last_good = runtime.seams().last_good_path();
        assert!(last_good.exists(), "the last-good copy is written");
        assert_eq!(
            std::fs::read(&last_good).expect("read last-good"),
            live_body,
            "the last-good copy is byte-exact"
        );
        server.stop().await;

        // 2) Live down, last-good present: refresh → Disk.
        let seams = PretrainedCatalogueSeams {
            catalogue_url: Some("http://127.0.0.1:9/catalogue.json".to_string()),
            http: None,
            bundled_dir: None,
            data_root: Some(root.clone()),
        };
        let runtime = CatalogueRuntime::new(seams);
        let response = runtime.refresh().await;
        assert_eq!(response.origin, PretrainedOrigin::Disk);
        assert_eq!(runtime.active().catalogue.models.len(), 1);

        // 3) Live down, last-good DELETED: refresh → Embedded (the snapshot).
        let _ = std::fs::remove_dir_all(&root);
        let seams = PretrainedCatalogueSeams {
            catalogue_url: Some("http://127.0.0.1:9/catalogue.json".to_string()),
            http: None,
            bundled_dir: None,
            data_root: Some(root.clone()),
        };
        let runtime = CatalogueRuntime::new(seams);
        let response = runtime.refresh().await;
        assert_eq!(response.origin, PretrainedOrigin::Embedded);
        assert!(runtime.active().catalogue.models.is_empty());
    }

    /// A malformed live payload (bad JSON) degrades to disk/embedded and never
    /// fails boot — the refresh returns the degraded origin, no panic.
    #[tokio::test]
    async fn malformed_live_payload_degrades() {
        let root = std::env::temp_dir().join(format!("pc-degrade-{}", uuid::Uuid::new_v4()));
        let server = FixtureHttpServer::spawn(b"{ not json".to_vec(), "200 OK").await;
        let seams = PretrainedCatalogueSeams {
            catalogue_url: Some(format!("http://127.0.0.1:{}/catalogue.json", server.port)),
            http: None,
            bundled_dir: None,
            data_root: Some(root.clone()),
        };
        let runtime = CatalogueRuntime::new(seams);
        let response = runtime.refresh().await;
        assert_eq!(response.origin, PretrainedOrigin::Embedded);
        assert!(!runtime.seams().last_good_path().exists());
        server.stop().await;
    }

    /// A live payload with a host outside the policy degrades the same way.
    #[tokio::test]
    async fn out_of_policy_live_payload_degrades() {
        let root = std::env::temp_dir().join(format!("pc-host-{}", uuid::Uuid::new_v4()));
        let body = sample_bytes(vec![sample_entry("x", "https://evil.example/x@1.0.0.txr")]);
        let server = FixtureHttpServer::spawn(body, "200 OK").await;
        let seams = PretrainedCatalogueSeams {
            catalogue_url: Some(format!("http://127.0.0.1:{}/catalogue.json", server.port)),
            http: None,
            bundled_dir: None,
            data_root: Some(root.clone()),
        };
        let runtime = CatalogueRuntime::new(seams);
        let response = runtime.refresh().await;
        assert_eq!(response.origin, PretrainedOrigin::Embedded);
        server.stop().await;
    }

    /// TEST-PC-04 (ITEM-3 half): the refresh request is a PLAIN GET — the
    /// fixture server records the raw request line + headers: no query string,
    /// no cookie, no custom identifier-carrying header.
    #[tokio::test]
    async fn refresh_request_carries_no_identifiers() {
        let root = std::env::temp_dir().join(format!("pc-noid-{}", uuid::Uuid::new_v4()));
        let body = sample_bytes(vec![]);
        let server = FixtureHttpServer::spawn(body, "200 OK").await;
        let seams = PretrainedCatalogueSeams {
            catalogue_url: Some(format!("http://127.0.0.1:{}/catalogue.json", server.port)),
            http: None,
            bundled_dir: None,
            data_root: Some(root.clone()),
        };
        let runtime = CatalogueRuntime::new(seams);
        let _ = runtime.refresh().await;

        // Capture the request log BEFORE stopping the server (stop consumes
        // the handle).
        let requests = server.requests.clone();
        let headers = server.headers.clone();
        server.stop().await;

        let request_line = requests
            .lock()
            .expect("request log")
            .first()
            .cloned()
            .expect("the refresh made exactly one request");
        assert!(
            request_line.starts_with("GET /catalogue.json "),
            "{request_line}"
        );
        assert!(
            !request_line.contains('?'),
            "no query string (INV-4): {request_line}"
        );
        let header_text = headers
            .lock()
            .expect("header log")
            .first()
            .cloned()
            .expect("header log");
        assert!(
            !header_text.to_lowercase().contains("cookie:"),
            "no cookie (INV-4): {header_text}"
        );
        for line in header_text.lines() {
            let name = line.split(':').next().unwrap_or("").trim().to_lowercase();
            assert!(
                !name.starts_with("x-"),
                "no custom identifier header (INV-4): {line}"
            );
        }
    }
}
