//! The engine's embedded runtime data: the per-method environment layer
//! manifest + the catalogue-facts shim (PLAN ITEM-2).
//!
//! Two first-party data files reach the engine at run time, both compiled into
//! the binary and both boot-validated (INV-4: the app ships its own copy of
//! the data it needs; nothing is read from the benchmark tree at run time):
//!
//! 1. the env manifest `src-app/server/data/method-env-images.json`
//!    (PROV-method-env-images-1, published by the `method-env-images` node,
//!    schema v2, `layer_schema: 1`) — the layer artifact facts the engine
//!    binds to when it drives the `sandbox` module's env manager
//!    (CONS-EE-8/8c/8b): `env_for(method_id)` returns the host-arch entry
//!    (oci ref, tag, layer pin + size, base pairing anchor, contract);
//!    `base_for(env_id)` returns the base pairing facts verbatim. The
//!    manifest's `base_ref` is NOT a runtime fetch target — the layer design
//!    (design §7) makes the pairing the DIGEST anchor, and the sandbox module
//!    owns the app's base namespace; the entry's language field is what the
//!    engine maps to the app's own base image at run start (ITEM-8).
//!    The optional top-level `bases` list holds the app-side base artifacts
//!    (one per base and arch): their tag, the sha256 of the base squashfs
//!    file the download is verified against, and the Docker base image they
//!    were built from. A manifest with `bases` must give every entry its
//!    base, and the entry's `base_ref`/`base_digest` must equal that base's
//!    `source_ref`/`source_digest` (design §7's pairing, checked at load). A
//!    manifest without `bases` predates the base publisher; its base pin is
//!    the old `base_digest` reading ([`base_pin`]), kept until the committed
//!    manifest is regenerated with bases.
//! 2. the committed method catalogue (PROV-MC-1, `method_catalogue`) — the
//!    group/tasks/draws/fitted facts the run rows + per-method classification
//!    read (CONS-EE-9/9c). [`facts_for`] is the ONE shim: later items never
//!    reach into the provider's module directly; a rename in the provider
//!    breaks this node's compile before a consumer binds a drifted shape.
//!
//! ### First-party posture (the `method_catalogue::catalogue` discipline)
//!
//! A manifest this binary cannot interpret is a BOOT REFUSAL, never a
//! degraded state: module `init` calls [`ensure_loaded`], and a named
//! [`ManifestLoadError`] aborts the boot (TEST-EE-05's mangled-manifest
//! half; the hardened checks are unit-pinned here). A RUNNABLE method whose
//! entry is missing stays a runtime per-method decision — `env_for` → `None`
//! → `cannot_run` + `ENV_UNKNOWN` at run start (TEST-EE-06): the manifest
//! may grow a method's entry later than the catalogue does, and that is a
//! method the app reports honestly, not a boot the catalogue and manifest
//! disagree about (their coverage relation is checked at run start per
//! method, never globally).
//!
//! The manifest's OCI refs pass through as DATA (INV-5): no registry host
//! literal is spelled here — the layer ref check reuses the `sandbox` module's
//! compiled namespace constant, and the base ref check validates the ref's
//! path/tag/family grammar host-agnostically (the HOST is the publisher's,
//! enforced by `method-env-images`'s own byte-parity guard + schema).

use std::fmt;
use std::sync::OnceLock;

use serde::Deserialize;

use crate::modules::method_catalogue::types::Method;

/// The manifest schema version this module understands (PROV-method-env-images-1
/// `schema_version`; the JSON Schema at
/// `src-app/server/data/method-env-images.schema.json` pins the same value).
/// 2: the methods commit, the method folder's git tree and the building
/// generator are per entry (one list holds entries built at different
/// commits); no top-level `source_revision`.
pub const MANIFEST_SCHEMA_VERSION: u32 = 2;

/// The published layer-schema marker the engine's manifests carry
/// (`layer_schema == 1` per PROV-method-env-images-1; the mount path compares
/// the squashfs marker against this).
pub const LAYER_SCHEMA_VERSION: u32 = 1;

// ─────────────────────────────────────────────────────────────────────────────
// Closed vocabularies of the manifest data model
// ─────────────────────────────────────────────────────────────────────────────

/// The published architecture of one manifest entry (the schema's closed
/// `amd64 | arm64` set). `Ord` follows the generator's `(env_id, arch)` sort
/// key, so the order check below and the generator's are one comparison.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EnvArch {
    Amd64,
    Arm64,
}

impl EnvArch {
    /// The OCI arch string of this variant (`amd64`/`arm64`).
    pub fn as_str(self) -> &'static str {
        match self {
            EnvArch::Amd64 => "amd64",
            EnvArch::Arm64 => "arm64",
        }
    }

    /// The variant of an arch string (`amd64` | `arm64`), `None` otherwise.
    pub fn parse(s: &str) -> Option<EnvArch> {
        match s {
            "amd64" => Some(EnvArch::Amd64),
            "arm64" => Some(EnvArch::Arm64),
            _ => None,
        }
    }

    /// The architecture this BUILT runtime runs on (the lookup the engine
    /// performs at run start: a layer for another machine is a layer the app
    /// cannot mount, and `env_for` returning it would be a silent wrong
    /// artifact). `None` on a host outside the published set — every
    /// `env_for` call then reports the method as `ENV_UNKNOWN` (per-method
    /// `cannot_run`), which is the honest answer on an unsupported host.
    pub fn host() -> Option<EnvArch> {
        match std::env::consts::ARCH {
            "x86_64" => Some(EnvArch::Amd64),
            "aarch64" => Some(EnvArch::Arm64),
            _ => None,
        }
    }
}

/// The method language (the schema's closed `R | Python`). The entry's base
/// pairing anchor is per language family; the run start maps it to the app's
/// own base image.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum EnvLanguage {
    R,
    Python,
}

impl EnvLanguage {
    /// The benchmark base family of this language (`txresbench-base-<family>`).
    pub fn base_family(self) -> &'static str {
        match self {
            EnvLanguage::R => "r",
            EnvLanguage::Python => "py",
        }
    }

    /// The language of a catalogue row (`R` | `Python`), `None` otherwise.
    pub fn from_catalogue(language: &str) -> Option<EnvLanguage> {
        match language {
            "R" => Some(EnvLanguage::R),
            "Python" => Some(EnvLanguage::Python),
            _ => None,
        }
    }

    /// The app-side base id of this language (`base-<family>`): the base
    /// repository's last path component and the env id the env manager keys
    /// the base under.
    pub fn base_id(self) -> &'static str {
        match self {
            EnvLanguage::R => "base-r",
            EnvLanguage::Python => "base-py",
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// The manifest data model (schema v2; serde-only — never a wire type)
// ─────────────────────────────────────────────────────────────────────────────

/// The root of `src-app/server/data/method-env-images.json` (schema v2).
///
/// `deny_unknown_fields` mirrors the JSON Schema's `additionalProperties:
/// false` and the catalogue's own stance: a field the generator emits that
/// this code does not model is a schema disagreement, and a disagreement is a
/// boot failure, never a silent drop.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnvManifest {
    pub schema_version: u32,
    /// The generator that assembled the list (each entry names the one that
    /// built its layer).
    pub generator_version: String,
    pub base_contract: String,
    /// The app-side base artifacts. `None` = a manifest from before the base
    /// publisher (no base record; the old pin reading applies). `Some` must
    /// cover every entry (checked at load), so `Some([])` with entries is a
    /// refusal, never a half state.
    #[serde(default)]
    pub bases: Option<Vec<BaseArtifact>>,
    pub envs: Vec<ManifestEntry>,
}

impl EnvManifest {
    /// The base record `entry` stacks on: `(base-<family>, arch)`. `None` for
    /// a manifest without `bases` (validated manifests with `bases` always
    /// have one).
    pub fn base_for_entry(&self, entry: &ManifestEntry) -> Option<&BaseArtifact> {
        let id = entry.language.base_id();
        self.bases
            .as_ref()?
            .iter()
            .find(|b| b.base_id == id && b.arch == entry.arch)
    }

    /// The entry for `method_id` at `arch` — the identity key is
    /// `(method_id, arch)` (CONS-EE-8c: `env_id == method_id`, and one entry
    /// per published arch), validated unique at load.
    pub fn find(&self, method_id: &str, arch: EnvArch) -> Option<&ManifestEntry> {
        self.envs
            .iter()
            .find(|e| e.env_id == method_id && e.arch == arch)
    }
}

/// One runnable method's layer artifact facts (PROV-method-env-images-1's
/// `envs[]` entry, fields verbatim).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManifestEntry {
    /// Equals `method_id` (DEC-1 of the provider; checked at load).
    pub env_id: String,
    pub method_id: String,
    pub method_version: String,
    pub language: EnvLanguage,
    pub arch: EnvArch,
    /// The layer package (scheme-less; every layer shares it), the
    /// `EnvRef.oci_ref` the engine passes to the sandbox env manager: exactly
    /// `TXR_LAYER_REGISTRY_PREFIX` (checked at load).
    pub oci_ref: String,
    /// The immutable publish tag
    /// `<env_id>-<method_version>-<arch>-<first 12 hex of layer_sha256>`
    /// (checked at load): the env's own tag in the one layer package; each
    /// distinct layer file gets its own tag.
    pub tag: String,
    /// The OCI content digest of the artifact manifest (`sha256:<64hex>`);
    /// the publish-side pin of the `oci_ref@digest` fetch.
    pub digest: String,
    /// sha256 of the published `layer.squashfs` bytes — the byte-verification
    /// pin (`EnvRef.digest`, 64-hex; PROV-SS-1's "digest = 64-hex sha256 of
    /// the squashfs layer").
    pub layer_sha256: String,
    /// The layer byte length — the F screen's "downloading N of M MB" total
    /// (`bytes_total`, PROV-EE-3).
    pub size_bytes: u64,
    /// The benchmark base the delta was computed against. DESIGN §7: this is
    /// the pairing-anchor NAME, never a runtime fetch target (the app's base
    /// namespace is the `sandbox` module's); the pairing identity is
    /// [`ManifestEntry::base`]'s digest.
    pub base_ref: String,
    /// The digest of the Docker base image the delta was computed against
    /// (`sha256:<64hex>`): provenance and the pairing anchor, never the hash
    /// of a downloaded file. A base record pairs with this entry when its
    /// `source_digest` equals it (the base artifact carries it as
    /// `com.txr.trimmed-from-digest`).
    pub base_digest: String,
    /// The container-contract version the method runs under (recorded on run
    /// rows + produced models for provenance).
    pub contract: String,
    /// The method's licence string, verbatim (provenance).
    pub licence: String,
    /// sha256 of `/code/method.json` + the wrapper file (provenance, the
    /// wrapper-identity pin).
    pub wrapper_code_sha256: String,
    /// The layer-filesystem schema marker (must equal
    /// [`LAYER_SCHEMA_VERSION`]).
    pub layer_schema: u32,
    /// The methods-repository commit (12 lowercase hex) the layer was built
    /// from; every method fact of the entry is that commit's (provenance).
    pub source_revision: String,
    /// The git tree (40 lowercase hex) of `methods/<method_id>` at
    /// `source_revision`: the method folder the layer was built from.
    pub source_tree: String,
    /// The generator that built this layer (`X.Y.Z`, an optional `-suffix`).
    pub generator_version: String,
}

impl ManifestEntry {
    /// The base pairing anchor (design §7: the digest is the identity; the
    /// ref name is documentation + language-family hint).
    pub fn base(&self) -> BaseRefFacts<'_> {
        BaseRefFacts {
            name: &self.base_ref,
            digest: &self.base_digest,
        }
    }
}

/// The base pairing facts of one entry, as the manifest spells them
/// (`base_ref` + `base_digest` verbatim — TEST-EE-04's round-trip values).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BaseRefFacts<'a> {
    pub name: &'a str,
    pub digest: &'a str,
}

/// One app-side base artifact (a `bases[]` record): the per-language base
/// squashfs the stacked run mounts under every layer of that language and
/// arch. Published at `<oci_ref>:<tag>` by
/// `scripts/publish-method-env-images.sh --base`, staged by the generator.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BaseArtifact {
    /// `base-r` | `base-py` — the env id the env manager keys the base under
    /// and the start of its tag.
    pub base_id: String,
    pub arch: EnvArch,
    /// The one base package, `TXR_BASE_REGISTRY_PREFIX` itself (checked at
    /// load).
    pub oci_ref: String,
    /// The immutable tag
    /// `<base_id>-<contract>-<arch>-<first 12 hex of squashfs_sha256>` (checked
    /// at load): each distinct base file gets its own tag.
    pub tag: String,
    /// The OCI content digest of the base's artifact manifest bytes
    /// (`sha256:<64hex>`; the publisher's resolve check).
    pub digest: String,
    /// sha256 of the published base squashfs — the pin the downloaded,
    /// staged or cached base file is verified against (`EnvRef.digest`).
    pub squashfs_sha256: String,
    /// The base squashfs byte length.
    pub size_bytes: u64,
    /// The Docker base image the squashfs was packed from (equals the
    /// paired entries' `base_ref`).
    pub source_ref: String,
    /// That image's digest (equals the paired entries' `base_digest`).
    pub source_digest: String,
    /// The container-contract version (equals the manifest's
    /// `base_contract`).
    pub contract: String,
}

// ─────────────────────────────────────────────────────────────────────────────
// Load errors (named, testable refusals — the `CatalogueLoadError` shape)
// ─────────────────────────────────────────────────────────────────────────────

/// A named manifest load failure. Every variant carries a stable code so a
/// boot refusal is a typed report — the first-party-data posture: a file we
/// shipped that we cannot interpret is a build/dep bug, never something to
/// degrade around.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManifestLoadError {
    /// The bytes are not a schema-v2 manifest (parser message carries the
    /// line/column report; an unknown field or closed-enum value is a parse
    /// refusal here too).
    EmbedParse { message: String },
    /// The `schema_version` differs from [`MANIFEST_SCHEMA_VERSION`].
    SchemaVersion { found: u32 },
    /// The `envs` set is empty — a manifest without entries cannot satisfy
    /// the engine's per-runnable-method env contract (every method would
    /// degrade to `cannot_run ENV_UNKNOWN`, a silent hole in the product).
    EmptyEnvs,
    /// The entries are not sorted by `(env_id, arch)` — the schema's
    /// determinism contract (one source revision, one byte-identical file).
    Unsorted { env_id: String, arch: EnvArch },
    /// Two entries share `(env_id, arch)` — the lookup key would be
    /// ambiguous.
    DuplicateEntry { env_id: String, arch: EnvArch },
    /// `env_id != method_id` — CONS-EE-8c keys everything on the method id.
    EnvIdMismatch { env_id: String, method_id: String },
    /// `env_id`/`method_id` fail the sandbox module's env-id grammar — such a
    /// value can never be ensured or polled by the env manager.
    EnvIdInvalid { env_id: String },
    /// `layer_schema != [`LAYER_SCHEMA_VERSION`]` — the mount path's marker
    /// contract (a layer this build cannot mount must not be claimed ready).
    LayerSchema { env_id: String, found: u32 },
    /// The tag is not `<env_id>-<method_version>-<arch>-<first 12 hex of
    /// layer_sha256>` (the schema's immutable publish-tag construction).
    TagMismatch { env_id: String, tag: String, expected: String },
    /// The tag is not a valid OCI tag (`[A-Za-z0-9_][A-Za-z0-9._-]{0,127}`):
    /// the env id is in the tag now, so a long id or a `+` in the version
    /// would give a tag no registry can hold.
    TagInvalid { env_id: String, tag: String },
    /// Two entries spell one tag. Every layer is a tag of the one package, and
    /// an env id and a version may both hold `-`, so two different entries
    /// can construct the same tag; each tag must name one artifact.
    DuplicateTag { env_id: String, tag: String, other: String },
    /// A digest/pin field is malformed: `layer_sha256` /
    /// `wrapper_code_sha256` must be bare 64-hex, `digest` / `base_digest`
    /// must be `sha256:<64-hex>` — these are the values the engine verifies
    /// bytes against and records on runs.
    BadPin { env_id: String, field: String },
    /// `oci_ref` is not the one layer package (`TXR_LAYER_REGISTRY_PREFIX`
    /// itself): another host or package, or the old one-package-per-env form
    /// `<package>/<env_id>`.
    BadLayerRef { env_id: String, oci_ref: String },
    /// `base_ref` is not a `txresbench-base-(r|py):<contract>` ref, or its
    /// language family disagrees with the entry's `language`.
    BadBaseRef { env_id: String, base_ref: String },
    /// `size_bytes` is 0 — the schema's minimum is 1 (a zero-size layer is a
    /// nonsense download row).
    SizeZero { env_id: String },
    /// `contract` is not a `<major>.<minor>` version string.
    ContractInvalid { env_id: String, contract: String },
    /// A per-entry provenance field is malformed (`field` names it):
    /// `source_revision` must be 12 lowercase hex, `source_tree` 40 lowercase
    /// hex, `generator_version` `X.Y.Z` with an optional `-suffix`.
    Provenance { env_id: String, field: String },
    /// A `bases[]` record breaks its own construction (`base` =
    /// `<base_id>-<arch>`; `why` names the rule): an unknown base id, an
    /// `oci_ref` outside the base namespace, a malformed pin, a tag that is
    /// not `<contract>-<arch>-<sha12>`, a contract other than the manifest's,
    /// a zero size, a duplicate, an unsorted list, or a base no entry uses.
    BaseInvalid { base: String, why: String },
    /// The manifest has `bases`, but none for this entry's
    /// `(base-<family>, arch)` — the entry's base cannot be downloaded.
    BaseMissing { env_id: String, arch: EnvArch, base_id: String },
    /// The entry and its base record disagree on the Docker base image
    /// (`field` is `base_ref` or `base_digest`): the layer was computed
    /// against another base than the one the app would stack it on.
    BasePairing {
        env_id: String,
        arch: EnvArch,
        field: String,
        entry_value: String,
        base_value: String,
    },
}

impl ManifestLoadError {
    /// The stable machine code of the failure (the boot report's code).
    pub fn code(&self) -> &'static str {
        match self {
            ManifestLoadError::EmbedParse { .. } => "MANIFEST_EMBED_INVALID",
            ManifestLoadError::SchemaVersion { .. } => "MANIFEST_SCHEMA_VERSION",
            ManifestLoadError::EmptyEnvs => "MANIFEST_EMPTY",
            ManifestLoadError::Unsorted { .. } => "MANIFEST_UNSORTED",
            ManifestLoadError::DuplicateEntry { .. } => "MANIFEST_DUPLICATE_ENTRY",
            ManifestLoadError::EnvIdMismatch { .. } => "MANIFEST_ENV_ID_MISMATCH",
            ManifestLoadError::EnvIdInvalid { .. } => "MANIFEST_ENV_ID_INVALID",
            ManifestLoadError::LayerSchema { .. } => "MANIFEST_LAYER_SCHEMA",
            ManifestLoadError::TagMismatch { .. } => "MANIFEST_TAG_MISMATCH",
            ManifestLoadError::TagInvalid { .. } => "MANIFEST_TAG_INVALID",
            ManifestLoadError::DuplicateTag { .. } => "MANIFEST_DUPLICATE_TAG",
            ManifestLoadError::BadPin { .. } => "MANIFEST_BAD_PIN",
            ManifestLoadError::BadLayerRef { .. } => "MANIFEST_LAYER_REF",
            ManifestLoadError::BadBaseRef { .. } => "MANIFEST_BASE_REF",
            ManifestLoadError::SizeZero { .. } => "MANIFEST_SIZE_ZERO",
            ManifestLoadError::ContractInvalid { .. } => "MANIFEST_CONTRACT",
            ManifestLoadError::Provenance { .. } => "MANIFEST_PROVENANCE",
            ManifestLoadError::BaseInvalid { .. } => "MANIFEST_BASE_INVALID",
            ManifestLoadError::BaseMissing { .. } => "MANIFEST_BASE_MISSING",
            ManifestLoadError::BasePairing { .. } => "MANIFEST_BASE_PAIRING",
        }
    }
}

impl fmt::Display for ManifestLoadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ManifestLoadError::EmbedParse { message } => write!(
                f,
                "MANIFEST_EMBED_INVALID: the embedded env manifest is not valid schema-2 JSON: {message}"
            ),
            ManifestLoadError::SchemaVersion { found } => write!(
                f,
                "MANIFEST_SCHEMA_VERSION: the embedded env manifest declares schema_version {found}, \
                 this build understands {MANIFEST_SCHEMA_VERSION}"
            ),
            ManifestLoadError::EmptyEnvs => write!(
                f,
                "MANIFEST_EMPTY: the embedded env manifest carries zero env entries"
            ),
            ManifestLoadError::Unsorted { env_id, arch } => write!(
                f,
                "MANIFEST_UNSORTED: env entries are not sorted by (env_id, arch); \
                 first offender `{env_id}` ({})",
                arch.as_str()
            ),
            ManifestLoadError::DuplicateEntry { env_id, arch } => write!(
                f,
                "MANIFEST_DUPLICATE_ENTRY: env `{env_id}` for {} appears twice",
                arch.as_str()
            ),
            ManifestLoadError::EnvIdMismatch { env_id, method_id } => write!(
                f,
                "MANIFEST_ENV_ID_MISMATCH: env_id `{env_id}` carries method_id `{method_id}`"
            ),
            ManifestLoadError::EnvIdInvalid { env_id } => write!(
                f,
                "MANIFEST_ENV_ID_INVALID: env_id `{env_id}` fails the env-id grammar"
            ),
            ManifestLoadError::LayerSchema { env_id, found } => write!(
                f,
                "MANIFEST_LAYER_SCHEMA: env `{env_id}` declares layer_schema {found}, \
                 this build mounts {LAYER_SCHEMA_VERSION}"
            ),
            ManifestLoadError::TagMismatch {
                env_id,
                tag,
                expected,
            } => write!(
                f,
                "MANIFEST_TAG_MISMATCH: env `{env_id}` tag {tag:?} is not the immutable \
                 tag {expected:?}"
            ),
            ManifestLoadError::TagInvalid { env_id, tag } => write!(
                f,
                "MANIFEST_TAG_INVALID: env `{env_id}` tag {tag:?} is not a valid OCI tag \
                 (at most 128 characters of [A-Za-z0-9_.-], not starting with . or -)"
            ),
            ManifestLoadError::DuplicateTag { env_id, tag, other } => write!(
                f,
                "MANIFEST_DUPLICATE_TAG: env `{env_id}` tag {tag:?} is also env `{other}`'s; \
                 every layer is a tag of one package, so a tag names one entry"
            ),
            ManifestLoadError::BadPin { env_id, field } => write!(
                f,
                "MANIFEST_BAD_PIN: env `{env_id}` carries a malformed {field}"
            ),
            ManifestLoadError::BadLayerRef { env_id, oci_ref } => write!(
                f,
                "MANIFEST_LAYER_REF: env `{env_id}` layer ref {oci_ref:?} is not the layer \
                 package (every layer is a tag of the one package)"
            ),
            ManifestLoadError::BadBaseRef { env_id, base_ref } => write!(
                f,
                "MANIFEST_BASE_REF: env `{env_id}` base ref {base_ref:?} is not a \
                 language-matched txresbench-base-(r|py):<contract> ref"
            ),
            ManifestLoadError::SizeZero { env_id } => write!(
                f,
                "MANIFEST_SIZE_ZERO: env `{env_id}` declares size_bytes 0"
            ),
            ManifestLoadError::ContractInvalid { env_id, contract } => write!(
                f,
                "MANIFEST_CONTRACT: env `{env_id}` contract {contract:?} is not <major>.<minor>"
            ),
            ManifestLoadError::Provenance { env_id, field } => write!(
                f,
                "MANIFEST_PROVENANCE: env `{env_id}` {field} is malformed (source_revision: 12 \
                 lowercase hex; source_tree: 40 lowercase hex; generator_version: X.Y.Z)"
            ),
            ManifestLoadError::BaseInvalid { base, why } => write!(
                f,
                "MANIFEST_BASE_INVALID: base `{base}`: {why}"
            ),
            ManifestLoadError::BaseMissing {
                env_id,
                arch,
                base_id,
            } => write!(
                f,
                "MANIFEST_BASE_MISSING: env `{env_id}` ({}) has no `{base_id}` base record",
                arch.as_str()
            ),
            ManifestLoadError::BasePairing {
                env_id,
                arch,
                field,
                entry_value,
                base_value,
            } => write!(
                f,
                "MANIFEST_BASE_PAIRING: env `{env_id}` ({}) {field} {entry_value:?} != its base \
                 record's {base_value:?}",
                arch.as_str()
            ),
        }
    }
}

impl std::error::Error for ManifestLoadError {}

// ─────────────────────────────────────────────────────────────────────────────
// Embed + load (the `method_catalogue::catalogue` OnceLock shape)
// ─────────────────────────────────────────────────────────────────────────────

/// The embedded manifest bytes. `$CARGO_MANIFEST_DIR` is `src-app/server`, so
/// `data/method-env-images.json` is the module's own data dir (the publisher's
/// commit location, PROV-method-env-images-1).
const MANIFEST_JSON: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/data/method-env-images.json"
));

/// ITEM-2 (qa-hardening): a DEBUG build may point the engine at a dev
/// manifest (`TXR_ENV_MANIFEST=<path>`) — the dev publisher's schema-v2
/// file whose pins are its own built digests. The bytes go through the SAME
/// [`parse_manifest`] validator, so every `MANIFEST_*` check applies to the
/// dev data too (nothing is skipped, nothing unverified). A RELEASE build
/// never reads the variable — the `#[cfg]` halves make it the embedded bytes
/// unconditionally, so a dev manifest can never reach a shipped binary.
fn manifest_bytes() -> Result<Vec<u8>, ManifestLoadError> {
    if let Some(path) = manifest_override_path(&|k| std::env::var(k).ok()) {
        return std::fs::read(&path).map_err(|e| ManifestLoadError::EmbedParse {
            message: format!("read the TXR_ENV_MANIFEST override {}: {e}", path),
        });
    }
    #[cfg(not(debug_assertions))]
    {}
    Ok(MANIFEST_JSON.to_vec())
}

/// The pure env → path core of the override (injected read): a debug build
/// honors `TXR_ENV_MANIFEST`; a release build never sees it.
fn manifest_override_path(read: &impl Fn(&str) -> Option<String>) -> Option<String> {
    #[cfg(debug_assertions)]
    {
        return read("TXR_ENV_MANIFEST")
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = read;
        None
    }
}

/// The process-wide manifest, installed by the module's `init` (the boot
/// check). `OnceLock`: the manifest is immutable for the process lifetime.
static MANIFEST: OnceLock<EnvManifest> = OnceLock::new();

/// Parse + validate a manifest from arbitrary bytes (the unit-test seam and
/// the boot path share it — a corrupted-byte test exercises the REAL loader).
pub fn parse_manifest(bytes: &[u8]) -> Result<EnvManifest, ManifestLoadError> {
    // The shape version first: a list of another schema (an older one has a
    // top-level `source_revision` and no per-entry provenance) is refused by
    // its version, not by whichever field the strict parse trips on first.
    #[derive(Deserialize)]
    struct VersionProbe {
        schema_version: u32,
    }
    if let Ok(probe) = serde_json::from_slice::<VersionProbe>(bytes) {
        if probe.schema_version != MANIFEST_SCHEMA_VERSION {
            return Err(ManifestLoadError::SchemaVersion {
                found: probe.schema_version,
            });
        }
    }
    let manifest: EnvManifest =
        serde_json::from_slice(bytes).map_err(|e| ManifestLoadError::EmbedParse {
            message: e.to_string(),
        })?;
    validate_manifest(&manifest)?;
    Ok(manifest)
}

/// The structural boot checks over a parsed manifest. These are the checks
/// whose failure would make an engine LOOKUP ambiguous or a run row carry a
/// wrong artifact fact — duplicate `(env_id, arch)` keys, an unsorted/empty
/// set, a mismatched env id, a layer schema the mounter does not understand,
/// a tag/pin/ref the sandbox boundary could not consume.
fn validate_manifest(m: &EnvManifest) -> Result<(), ManifestLoadError> {
    if m.schema_version != MANIFEST_SCHEMA_VERSION {
        return Err(ManifestLoadError::SchemaVersion {
            found: m.schema_version,
        });
    }
    if m.envs.is_empty() {
        return Err(ManifestLoadError::EmptyEnvs);
    }

    let mut prev: Option<(&str, EnvArch)> = None;
    let mut seen: Vec<(&str, EnvArch)> = Vec::with_capacity(m.envs.len());
    let mut seen_tags: std::collections::HashMap<&str, &str> =
        std::collections::HashMap::with_capacity(m.envs.len());
    for e in &m.envs {
        if let Some((p_env, p_arch)) = prev {
            if (e.env_id.as_str(), e.arch) < (p_env, p_arch) {
                return Err(ManifestLoadError::Unsorted {
                    env_id: e.env_id.clone(),
                    arch: e.arch,
                });
            }
        }
        prev = Some((e.env_id.as_str(), e.arch));

        if seen.contains(&(e.env_id.as_str(), e.arch)) {
            return Err(ManifestLoadError::DuplicateEntry {
                env_id: e.env_id.clone(),
                arch: e.arch,
            });
        }
        seen.push((e.env_id.as_str(), e.arch));

        if !crate::modules::sandbox::env_id::is_valid_env_id(&e.env_id)
            || !crate::modules::sandbox::env_id::is_valid_env_id(&e.method_id)
        {
            return Err(ManifestLoadError::EnvIdInvalid {
                env_id: e.env_id.clone(),
            });
        }
        if e.env_id != e.method_id {
            return Err(ManifestLoadError::EnvIdMismatch {
                env_id: e.env_id.clone(),
                method_id: e.method_id.clone(),
            });
        }
        if e.layer_schema != LAYER_SCHEMA_VERSION {
            return Err(ManifestLoadError::LayerSchema {
                env_id: e.env_id.clone(),
                found: e.layer_schema,
            });
        }

        for (field, value) in [("layer_sha256", &e.layer_sha256), ("wrapper_code_sha256", &e.wrapper_code_sha256)] {
            if !crate::modules::sandbox::stack::is_sha256_hex(value) {
                return Err(ManifestLoadError::BadPin {
                    env_id: e.env_id.clone(),
                    field: field.to_string(),
                });
            }
        }
        for (field, value) in [("digest", &e.digest), ("base_digest", &e.base_digest)] {
            if !value.starts_with("sha256:")
                || !crate::modules::sandbox::stack::is_sha256_hex(&value["sha256:".len()..])
            {
                return Err(ManifestLoadError::BadPin {
                    env_id: e.env_id.clone(),
                    field: field.to_string(),
                });
            }
        }

        // The tag names the env, its version, its arch and its FILE (after the
        // pin checks: the first 12 hex of the validated layer_sha256), so a
        // rebuild of one version gets its own tag and a tag never names two
        // different files.
        let expected_tag = format!(
            "{}-{}-{}-{}",
            e.env_id,
            e.method_version,
            e.arch.as_str(),
            &e.layer_sha256[..12]
        );
        if e.tag != expected_tag {
            return Err(ManifestLoadError::TagMismatch {
                env_id: e.env_id.clone(),
                tag: e.tag.clone(),
                expected: expected_tag,
            });
        }
        if !crate::modules::sandbox::stack::is_valid_oci_tag(&e.tag) {
            return Err(ManifestLoadError::TagInvalid {
                env_id: e.env_id.clone(),
                tag: e.tag.clone(),
            });
        }
        if let Some(other) = seen_tags.insert(e.tag.as_str(), e.env_id.as_str()) {
            return Err(ManifestLoadError::DuplicateTag {
                env_id: e.env_id.clone(),
                tag: e.tag.clone(),
                other: other.to_string(),
            });
        }

        if e.oci_ref != crate::modules::sandbox::stack::TXR_LAYER_REGISTRY_PREFIX {
            return Err(ManifestLoadError::BadLayerRef {
                env_id: e.env_id.clone(),
                oci_ref: e.oci_ref.clone(),
            });
        }

        // The base ref grammar, host-agnostic (the publisher's host is the
        // provider's own byte-parity guard's fact; INV-5 keeps engines free of
        // registry-host literals). The path component must be the
        // language-matched benchmark base, the tag a <major>.<minor> version.
        let base_repo = e.base_ref.rsplit('/').next().unwrap_or("");
        let base_ok = match base_repo.strip_prefix("txresbench-base-") {
            Some(rest) => {
                let (family, tag) = rest
                    .split_once(':')
                    .map(|(f, t)| (f, t))
                    .unwrap_or(("", ""));
                let family_ok = family == e.language.base_family();
                family_ok && is_major_minor(tag)
            }
            None => false,
        };
        if !base_ok {
            return Err(ManifestLoadError::BadBaseRef {
                env_id: e.env_id.clone(),
                base_ref: e.base_ref.clone(),
            });
        }

        if e.size_bytes == 0 {
            return Err(ManifestLoadError::SizeZero {
                env_id: e.env_id.clone(),
            });
        }
        if !is_major_minor(&e.contract) {
            return Err(ManifestLoadError::ContractInvalid {
                env_id: e.env_id.clone(),
                contract: e.contract.clone(),
            });
        }
        for (field, ok) in [
            ("source_revision", is_lower_hex(&e.source_revision, 12)),
            ("source_tree", is_lower_hex(&e.source_tree, 40)),
            ("generator_version", is_generator_version(&e.generator_version)),
        ] {
            if !ok {
                return Err(ManifestLoadError::Provenance {
                    env_id: e.env_id.clone(),
                    field: field.to_string(),
                });
            }
        }
    }
    validate_bases(m)
}

/// The `bases` checks (a manifest without `bases` has none to run). Each
/// record must follow its construction; every entry must have its base, and
/// the entry's Docker base image facts must equal the record's (design §7's
/// pairing); no record may go unused. The host is never spelled here: the
/// namespace check reuses the sandbox module's compiled base prefix.
fn validate_bases(m: &EnvManifest) -> Result<(), ManifestLoadError> {
    let Some(bases) = &m.bases else {
        return Ok(());
    };
    let is_digest = |v: &str| {
        v.strip_prefix("sha256:")
            .is_some_and(crate::modules::sandbox::stack::is_sha256_hex)
    };
    let mut prev: Option<(&str, EnvArch)> = None;
    for b in bases {
        let invalid = |why: String| ManifestLoadError::BaseInvalid {
            base: format!("{}-{}", b.base_id, b.arch.as_str()),
            why,
        };
        let key = (b.base_id.as_str(), b.arch);
        if let Some(p) = prev {
            if key == p {
                return Err(invalid("appears twice".to_string()));
            }
            if key < p {
                return Err(invalid("bases are not sorted by (base_id, arch)".to_string()));
            }
        }
        prev = Some(key);

        let family = match b.base_id.as_str() {
            "base-r" => "r",
            "base-py" => "py",
            other => return Err(invalid(format!("base_id {other:?} is not base-r or base-py"))),
        };
        let expected_ref = crate::modules::sandbox::stack::TXR_BASE_REGISTRY_PREFIX;
        if b.oci_ref != expected_ref {
            return Err(invalid(format!(
                "oci_ref {:?} is not {expected_ref:?}",
                b.oci_ref
            )));
        }
        if !crate::modules::sandbox::stack::is_sha256_hex(&b.squashfs_sha256) {
            return Err(invalid("squashfs_sha256 is not 64 lowercase hex".to_string()));
        }
        for (field, value) in [("digest", &b.digest), ("source_digest", &b.source_digest)] {
            if !is_digest(value) {
                return Err(invalid(format!("{field} is not sha256:<64 hex>")));
            }
        }
        if b.size_bytes == 0 {
            return Err(invalid("size_bytes is 0".to_string()));
        }
        if !is_major_minor(&b.contract) || b.contract != m.base_contract {
            return Err(invalid(format!(
                "contract {:?} is not the manifest's base_contract {:?}",
                b.contract, m.base_contract
            )));
        }
        let expected_tag = format!(
            "{}-{}-{}-{}",
            b.base_id,
            b.contract,
            b.arch.as_str(),
            &b.squashfs_sha256[..12]
        );
        if b.tag != expected_tag {
            return Err(invalid(format!(
                "tag {:?} is not {expected_tag:?} (<base_id>-<contract>-<arch>-<first 12 hex \
                 of squashfs_sha256>)",
                b.tag
            )));
        }
        let source_repo = b.source_ref.rsplit('/').next().unwrap_or("");
        if source_repo != format!("txresbench-base-{family}:{}", b.contract) {
            return Err(invalid(format!(
                "source_ref {:?} is not the txresbench-base-{family}:{} image",
                b.source_ref, b.contract
            )));
        }
    }

    for e in &m.envs {
        let Some(b) = m.base_for_entry(e) else {
            return Err(ManifestLoadError::BaseMissing {
                env_id: e.env_id.clone(),
                arch: e.arch,
                base_id: e.language.base_id().to_string(),
            });
        };
        for (field, entry_value, base_value) in [
            ("base_ref", &e.base_ref, &b.source_ref),
            ("base_digest", &e.base_digest, &b.source_digest),
        ] {
            if entry_value != base_value {
                return Err(ManifestLoadError::BasePairing {
                    env_id: e.env_id.clone(),
                    arch: e.arch,
                    field: field.to_string(),
                    entry_value: entry_value.clone(),
                    base_value: base_value.clone(),
                });
            }
        }
    }

    for b in bases {
        let used = m
            .envs
            .iter()
            .any(|e| e.arch == b.arch && e.language.base_id() == b.base_id);
        if !used {
            return Err(ManifestLoadError::BaseInvalid {
                base: format!("{}-{}", b.base_id, b.arch.as_str()),
                why: "no env entry uses this base".to_string(),
            });
        }
    }
    Ok(())
}

/// Whether `s` is exactly `len` lowercase hex digits.
fn is_lower_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Whether `s` is a generator version: `X.Y.Z` (digits), optionally followed
/// by `-<suffix>` of `[0-9A-Za-z.-]` (the schema's
/// `^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$`).
fn is_generator_version(s: &str) -> bool {
    let (core, suffix) = match s.split_once('-') {
        Some((c, rest)) => (c, Some(rest)),
        None => (s, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    let core_ok = parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()));
    let suffix_ok = match suffix {
        None => true,
        Some(x) => {
            !x.is_empty() && x.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        }
    };
    core_ok && suffix_ok
}

/// Whether `s` is a `<major>.<minor>` version string (the schema's contract
/// shape `^[0-9]+\.[0-9]+$`).
fn is_major_minor(s: &str) -> bool {
    let mut parts = s.split('.');
    let major = parts.next().unwrap_or("");
    let minor = parts.next().unwrap_or("");
    if major.is_empty() || minor.is_empty() || parts.next().is_some() {
        return false;
    }
    major.bytes().all(|b| b.is_ascii_digit()) && minor.bytes().all(|b| b.is_ascii_digit())
}

/// Load (once) the embedded manifest, or fail with the named error. The module
/// `init` calls this and returns the error to the boot path — a refusal means
/// the server does not serve (the first-party-data posture of
/// `method_catalogue::catalogue::ensure_loaded`).
pub fn ensure_loaded() -> Result<&'static EnvManifest, ManifestLoadError> {
    if let Some(m) = MANIFEST.get() {
        return Ok(m);
    }
    let parsed = parse_manifest(&manifest_bytes()?)?;
    let _ = MANIFEST.set(parsed);
    Ok(MANIFEST
        .get()
        .expect("the manifest is installed by this call or a concurrent one"))
}

/// The boot-validated manifest. Panics only when called before `init` in a
/// build whose boot has not run — the window `init` closes.
pub fn manifest() -> &'static EnvManifest {
    ensure_loaded().expect(
        "execution_engine: the embedded env manifest failed its boot check — a malformed \
         first-party manifest is a boot refusal, not a silently empty one",
    )
}

/// Every entry (the boot-validated set, in manifest order).
pub fn envs() -> &'static [ManifestEntry] {
    &manifest().envs
}

/// The host-arch entry for `method_id` (the artifact this machine can mount),
/// or `None` when the manifest carries no entry for this method on this arch —
/// the per-method `cannot_run` + `ENV_UNKNOWN` case of TEST-EE-06.
pub fn env_for(method_id: &str) -> Option<&'static ManifestEntry> {
    let arch = EnvArch::host()?;
    env_for_arch(method_id, arch)
}

/// The `(method_id, arch)` lookup (the test seam + the host-arch driver).
pub fn env_for_arch(method_id: &str, arch: EnvArch) -> Option<&'static ManifestEntry> {
    manifest().find(method_id, arch)
}

/// The base pairing facts of `env_id`'s host-arch entry, verbatim (the design
/// §7 digest anchor; TEST-EE-04 round-trips `base_digest`).
pub fn base_for(env_id: &str) -> Option<BaseRefFacts<'static>> {
    env_for(env_id).map(|e| e.base())
}

/// The base record of a boot-validated manifest entry, or `None` when the
/// manifest carries no `bases` (the boot check guarantees one otherwise).
pub fn base_artifact_for(entry: &ManifestEntry) -> Option<&'static BaseArtifact> {
    manifest().base_for_entry(entry)
}

/// The 64-hex pin a base file is verified against, for `entry` and its base
/// record. With a record it is the record's `squashfs_sha256`. Without one
/// (a manifest from before the base publisher) it is the old reading, the
/// entry's `base_digest` without its `sha256:` prefix: a Docker image digest
/// never equals a file hash, so a real download fails `ENV_VERIFY_FAILED`
/// exactly as before (fails closed). The run's base ref
/// ([`super::orchestrator::base_env_ref`]) and the saved-model digest check
/// both read the pin here, so they cannot drift apart.
pub fn base_pin<'a>(entry: &'a ManifestEntry, base: Option<&'a BaseArtifact>) -> &'a str {
    match base {
        Some(b) => &b.squashfs_sha256,
        None => entry
            .base_digest
            .strip_prefix("sha256:")
            .unwrap_or(&entry.base_digest),
    }
}

/// The layer byte size for the F screen's download rows
/// (`bytes_total` from the manifest's `size_bytes`, PROV-EE-3), host-arch.
pub fn size_bytes(method_id: &str) -> Option<u64> {
    env_for(method_id).map(|e| e.size_bytes)
}

/// The catalogue-facts accessor shim (CONS-EE-9/9c): the ONE seam to the
/// provider's in-process `method(id)` — the group/tasks/min_draws/fitted/
/// saves_model/frozen_model/uses_history/markers facts the run rows and the
/// per-method classification read. Later items never re-parse the catalogue
/// file and never reach into the provider's module under an unseamed path.
pub fn facts_for(method_id: &str) -> Option<&'static Method> {
    crate::modules::method_catalogue::catalogue::method(method_id)
}

/// Why a saved model's run-shaping facts cannot be had.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReuseFactsRefusal {
    /// The catalogue has no row for the method at all.
    UnknownMethod { method_id: String },
    /// The model kept no facts (saved before they were kept) and the
    /// catalogue row is another version, whose facts may differ.
    OtherVersion {
        method_id: String,
        recorded: String,
        current: String,
    },
}

impl ReuseFactsRefusal {
    /// The plain sentence a run row and the model's detail show.
    pub fn detail(&self) -> String {
        match self {
            ReuseFactsRefusal::UnknownMethod { method_id } => {
                format!("This saved model's method {method_id} is not in this app")
            }
            ReuseFactsRefusal::OtherVersion {
                method_id,
                recorded,
                current,
            } => format!(
                "This saved model was trained with {method_id} {recorded}, whose settings this \
                 app no longer has (it has {current}); it was saved before models kept their \
                 settings"
            ),
        }
    }
}

/// The method facts a saved model runs with (one rule for the run and for
/// the model eligibility, so the screen and the run agree): the facts the
/// model kept from its training run, laid over the current catalogue row
/// (which still gives everything that does not shape the run); a model that
/// kept none uses the current row only when the row is the model's recorded
/// `method_version` ("same version, same facts"), and is refused otherwise.
pub fn reuse_facts_for(
    method_id: &str,
    method_version: &str,
    saved: Option<&super::types::TxrMethodFacts>,
) -> Result<std::borrow::Cow<'static, Method>, ReuseFactsRefusal> {
    let row = facts_for(method_id).ok_or_else(|| ReuseFactsRefusal::UnknownMethod {
        method_id: method_id.to_string(),
    })?;
    match saved {
        Some(facts) => Ok(std::borrow::Cow::Owned(facts.apply_to(row))),
        None if row.version == method_version => Ok(std::borrow::Cow::Borrowed(row)),
        None => Err(ReuseFactsRefusal::OtherVersion {
            method_id: method_id.to_string(),
            recorded: method_version.to_string(),
            current: row.version.clone(),
        }),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST-EE-04 + TEST-EE-06 (unit halves): the embedded manifest parses against
// schema v2 (fields per PROV-method-env-images-1), entries sorted by env_id,
// `env_id == method_id` everywhere, `layer_schema == 1`, the synthetic
// fixture round-trips `env_for`/`base_for` verbatim, and a runnable method
// without a manifest entry resolves to the typed `ENV_UNKNOWN` refusal.
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::execution_engine::types::EngineReasonCode;

    /// A minimal two-entry manifest fixture: one amd64 R entry and one arm64
    /// Python entry (different bases, real-shaped digests) — the fixture the
    /// round-trip + validation tests parse. Values are pinned so the
    /// verbatim-round-trip assertions compare exact bytes.
    fn fixture_env_json(id: &str, arch: &str, language: &str, version: &str) -> String {
        let layer_sha = "5ce304e213ac6307d7e2d5991f432d0006805b2df9fb5f40f401905db8d0fc1a";
        let wrapper_sha = "bfe338c7cc0353db8ac93b0fffb7ea3e0aead14e181d33397bd4066c9aa92eaf";
        let base_family = if language == "R" { "r" } else { "py" };
        let short = &layer_sha[..12];
        format!(
            r#"{{
                "env_id": "{id}", "method_id": "{id}", "method_version": "{version}",
                "language": "{language}", "arch": "{arch}",
                "oci_ref": "ghcr.io/tinnlab/txr-method-env-layers",
                "tag": "{id}-{version}-{arch}-{short}",
                "digest": "sha256:7153c0b1b85cf5089bb9fe80a2f9ac708e11b3e79d5cb74bd06ba5752a9d12cf",
                "layer_sha256": "{layer_sha}",
                "size_bytes": 4141056,
                "base_ref": "ghcr.io/tinnlab/txresbench-base-{base_family}:2.0",
                "base_digest": "sha256:4c7af1b2d7bf29f0712f950315dc8368211374832204583a37a92c0c77dfae65",
                "contract": "2.0",
                "licence": "MIT",
                "wrapper_code_sha256": "{wrapper_sha}",
                "layer_schema": 1,
                "source_revision": "5db3b60f727d",
                "source_tree": "13d6890bbaa6ab7a2032a2a5b93ee12851057859",
                "generator_version": "0.5.0"
            }}"#
        )
    }

    fn fixture_manifest_bytes() -> Vec<u8> {
        format!(
            r#"{{
                "schema_version": 2,
                "generator_version": "0.2.0",
                "base_contract": "2.0",
                "envs": [
                    {a},
                    {b}
                ]
            }}"#,
            a = fixture_env_json("alpha-rule", "amd64", "R", "2.0.0"),
            b = fixture_env_json("beta-model", "arm64", "Python", "1.2.3"),
        )
        .into_bytes()
    }

    /// TEST-EE-04 (embedded half): the COMMITTED manifest parses against
    /// schema v2 — fields per PROV-method-env-images-1, entries sorted by
    /// env_id, `env_id == method_id` for every entry, `layer_schema == 1`,
    /// and the real runnable `landmark-cox-current` entry resolves with a
    /// well-formed pin + size (the F screen's `bytes_total` source).
    #[test]
    fn embedded_manifest_loads_with_schema_v2_shape() {
        let m = ensure_loaded().expect("the committed manifest must parse + validate");
        assert_eq!(m.schema_version, MANIFEST_SCHEMA_VERSION);
        assert_eq!(m.base_contract, "2.0");
        assert!(!m.envs.is_empty(), "the shipped manifest carries layers");

        // Deterministic order (the schema's "sorted by env_id"; the generator
        // sorts by (env_id, arch)).
        let keys: Vec<(&str, EnvArch)> = m.envs.iter().map(|e| (e.env_id.as_str(), e.arch)).collect();
        let mut sorted = keys.clone();
        sorted.sort();
        assert_eq!(keys, sorted, "entries sorted by (env_id, arch)");

        for e in &m.envs {
            // CONS-EE-8c: one key — env_id == method_id.
            assert_eq!(e.env_id, e.method_id, "env_id must equal method_id");
            assert_eq!(e.layer_schema, LAYER_SCHEMA_VERSION, "layer schema 1");
            assert_eq!(
                e.tag,
                format!(
                    "{}-{}-{}-{}",
                    e.env_id,
                    e.method_version,
                    e.arch.as_str(),
                    &e.layer_sha256[..12]
                )
            );
            assert_eq!(
                e.oci_ref,
                crate::modules::sandbox::stack::TXR_LAYER_REGISTRY_PREFIX,
                "every layer is a tag of the one layer package"
            );
            // Schema 2: every entry names the methods commit and folder tree it
            // was built from, and the generator that built it.
            assert!(is_lower_hex(&e.source_revision, 12), "{}: source_revision", e.env_id);
            assert!(is_lower_hex(&e.source_tree, 40), "{}: source_tree", e.env_id);
            assert!(is_generator_version(&e.generator_version), "{}: generator_version", e.env_id);
            // The data facts the manifest exists to serve:
            assert!(e.size_bytes >= 1);
            assert!(crate::modules::sandbox::stack::is_sha256_hex(&e.layer_sha256));
            assert!(e.digest.starts_with("sha256:"));
            assert!(e.base_ref.contains("txresbench-base-"));
        }

        // A real entry of the EXAMPLE-EE-1 method set resolves with its facts.
        let entry = env_for("landmark-cox-current").expect("the example method's layer entry");
        assert_eq!(entry.arch, EnvArch::host().expect("host arch supported in tests"));
        assert_eq!(entry.language, EnvLanguage::R);
        assert_eq!(entry.contract, "2.0");
        assert_eq!(
            entry.tag,
            format!(
                "landmark-cox-current-{}-{}-{}",
                entry.method_version,
                entry.arch.as_str(),
                &entry.layer_sha256[..12]
            ),
            "the immutable publish tag construction"
        );
        assert_eq!(entry.oci_ref, "ghcr.io/tinnlab/txr-method-env-layers");
        assert_eq!(entry.base_ref, "ghcr.io/tinnlab/txresbench-base-r:2.0");
        // The size-bytes table the F screen's rows read (the manifest's
        // `size_bytes`; byte-exact value is regeneration data, asserted
        // verbatim on the synthetic fixture below, never pinned here).
        assert_eq!(size_bytes("landmark-cox-current"), Some(entry.size_bytes));
    }

    /// TEST-EE-04 (round-trip half): a synthetic fixture manifest round-trips
    /// `env_for(method_id)` / `base_for(env_id)` with the `layer_sha256` /
    /// `size_bytes` / `base_digest` values verbatim (an engine reading these
    /// fields never transforms them into a derived value at lookup).
    #[test]
    fn synthetic_manifest_round_trips_env_and_base_facts() {
        let m = parse_manifest(&fixture_manifest_bytes()).expect("the fixture parses");

        let alpha = m.find("alpha-rule", EnvArch::Amd64).expect("amd64 entry resolves");
        assert_eq!(alpha.layer_sha256, "5ce304e213ac6307d7e2d5991f432d0006805b2df9fb5f40f401905db8d0fc1a");
        assert_eq!(alpha.size_bytes, 4_141_056);
        assert_eq!(alpha.base().digest, "sha256:4c7af1b2d7bf29f0712f950315dc8368211374832204583a37a92c0c77dfae65");
        assert_eq!(alpha.base().name, "ghcr.io/tinnlab/txresbench-base-r:2.0");
        assert_eq!(alpha.oci_ref, "ghcr.io/tinnlab/txr-method-env-layers");
        assert_eq!(alpha.tag, "alpha-rule-2.0.0-amd64-5ce304e213ac");
        assert_eq!(alpha.source_revision, "5db3b60f727d");
        assert_eq!(alpha.source_tree, "13d6890bbaa6ab7a2032a2a5b93ee12851057859");
        assert_eq!(alpha.generator_version, "0.5.0");
        assert_eq!(m.generator_version, "0.2.0");

        // The arm64 entry lives beside the amd64 one (one env, per-arch
        // records), and its base family is the Python base.
        let beta = m.find("beta-model", EnvArch::Arm64).expect("arm64 entry resolves");
        assert_eq!(beta.language, EnvLanguage::Python);
        assert_eq!(beta.base().name, "ghcr.io/tinnlab/txresbench-base-py:2.0");
        assert_eq!(beta.method_version, "1.2.3");
    }

    /// TEST-EE-06 (unit half): a method id with no manifest entry is `None`
    /// (the typed `ENV_UNKNOWN` refusal the orchestrator records at run start
    /// — never a silent skip that lets a run reach "finished" with a hole).
    /// The REAL data proves the case is real, not hypothetical: the catalogue
    /// carries runnable methods the manifest has no layer for yet.
    #[test]
    fn missing_env_entry_is_a_typed_env_unknown() {
        assert_eq!(
            EngineReasonCode::EnvUnknown.as_str(),
            "ENV_UNKNOWN",
            "the code the run-start classification records"
        );
        assert!(env_for_arch("no-such-method", EnvArch::Amd64).is_none());
        assert_eq!(base_for("no-such-method"), None);
        assert_eq!(size_bytes("no-such-method"), None);

        // A REAL catalogue method without a manifest entry (the catalogue's
        // method set is larger than the published layer set) resolves to the
        // same None — the cannot_run + ENV_UNKNOWN row is data-driven.
        let catalogue_only = facts_for("bayes-pt-cure-joint").expect("catalogue method exists");
        assert_eq!(catalogue_only.id, "bayes-pt-cure-joint");
        assert!(env_for_arch("bayes-pt-cure-joint", EnvArch::Amd64).is_none());
    }

    // ── the boot-validation refusals (the named MANIFEST_* set) ────────────

    #[test]
    fn garbage_bytes_are_a_named_parse_refusal() {
        let err = parse_manifest(b"{ not json").unwrap_err();
        assert_eq!(err.code(), "MANIFEST_EMBED_INVALID");
    }

    #[test]
    fn unknown_schema_version_is_refused() {
        let text = String::from_utf8(fixture_manifest_bytes()).unwrap();
        let re = "\"schema_version\": 2";
        let pos = text.find(re).expect("fixture declares schema_version 2");
        let mut bytes = text.into_bytes();
        bytes[pos + re.len() - 1] = b'3';
        let err = parse_manifest(&bytes).unwrap_err();
        assert_eq!(err.code(), "MANIFEST_SCHEMA_VERSION");
        assert!(matches!(err, ManifestLoadError::SchemaVersion { found: 3 }));
    }

    /// A schema-1 list (the shape before per-entry provenance: one top-level
    /// `source_revision`, entries without it) is refused by its version.
    #[test]
    fn a_schema_1_list_is_refused_by_its_version() {
        let entry = fixture_env_json("alpha-rule", "amd64", "R", "2.0.0")
            .replace(",\n                \"source_revision\": \"5db3b60f727d\",\n                \"source_tree\": \"13d6890bbaa6ab7a2032a2a5b93ee12851057859\",\n                \"generator_version\": \"0.5.0\"", "");
        assert!(!entry.contains("source_tree"), "the v1 entry shape: {entry}");
        let json = format!(
            r#"{{
                "schema_version": 1, "generator_version": "0.2.0",
                "source_revision": "5db3b60f727d", "base_contract": "2.0",
                "envs": [ {entry} ]
            }}"#
        );
        let err = parse_manifest(json.as_bytes()).unwrap_err();
        assert_eq!(err.code(), "MANIFEST_SCHEMA_VERSION");
        assert!(matches!(err, ManifestLoadError::SchemaVersion { found: 1 }));
    }

    /// Schema 2 has no top-level `source_revision`: the strict parse refuses
    /// it (deny_unknown_fields), like any field the loader does not model.
    #[test]
    fn a_top_level_source_revision_is_a_parse_refusal() {
        let json = format!(
            r#"{{
                "schema_version": 2, "generator_version": "0.5.0",
                "source_revision": "5db3b60f727d", "base_contract": "2.0",
                "envs": [ {a} ]
            }}"#,
            a = fixture_env_json("alpha-rule", "amd64", "R", "2.0.0"),
        );
        let err = parse_manifest(json.as_bytes()).unwrap_err();
        assert_eq!(err.code(), "MANIFEST_EMBED_INVALID");
    }

    /// Every entry carries its own provenance: a missing field is a parse
    /// refusal; a malformed one is MANIFEST_PROVENANCE naming the field.
    #[test]
    fn per_entry_provenance_is_required_and_well_formed() {
        let one = |entry: String| {
            format!(
                r#"{{
                    "schema_version": 2, "generator_version": "0.5.0",
                    "base_contract": "2.0", "envs": [ {entry} ]
                }}"#
            )
        };
        let good = fixture_env_json("alpha-rule", "amd64", "R", "2.0.0");
        assert!(parse_manifest(one(good.clone()).as_bytes()).is_ok());
        for field in ["source_revision", "source_tree", "generator_version"] {
            let without: String = good
                .lines()
                .filter(|l| !l.contains(&format!("\"{field}\"")))
                .collect::<Vec<_>>()
                .join("\n")
                .replace("\"layer_schema\": 1,\n", "\"layer_schema\": 1\n")
                .replace(",\n            }", "\n            }");
            let err = parse_manifest(one(without.clone()).as_bytes())
                .expect_err(&format!("a missing {field} refuses: {without}"));
            assert_eq!(err.code(), "MANIFEST_EMBED_INVALID", "{field}: {err}");
        }
        for (field, from, to) in [
            ("source_revision", "\"5db3b60f727d\"", "\"5DB3B60F727D\""),
            ("source_revision", "\"5db3b60f727d\"", "\"5db3b60f727d00\""),
            ("source_revision", "\"5db3b60f727d\"", "\"\""),
            ("source_tree", "\"13d6890bbaa6ab7a2032a2a5b93ee12851057859\"", "\"13d6890b\""),
            ("source_tree", "\"13d6890bbaa6ab7a2032a2a5b93ee12851057859\"",
             "\"13d6890bbaa6ab7a2032a2a5b93ee1285105785g\""),
            ("generator_version", "\"0.5.0\"", "\"0.5\""),
            ("generator_version", "\"0.5.0\"", "\"v0.5.0\""),
            ("generator_version", "\"0.5.0\"", "\"0.5.0-\""),
            ("generator_version", "\"0.5.0\"", "\"0.5.0+dev\""),
        ] {
            let bad = good.replacen(from, to, 1);
            assert_ne!(bad, good, "{field}: the mutation applies");
            let err = parse_manifest(one(bad).as_bytes()).expect_err(field);
            assert_eq!(err.code(), "MANIFEST_PROVENANCE", "{field} {to}: {err}");
            assert_eq!(
                err,
                ManifestLoadError::Provenance {
                    env_id: "alpha-rule".to_string(),
                    field: field.to_string()
                }
            );
            assert!(err.to_string().contains(field), "{err}");
        }
        // A dev publisher's pre-release generator version is well formed.
        let dev = good.replacen("\"0.5.0\"", "\"0.1.0-dev\"", 1);
        assert!(parse_manifest(one(dev).as_bytes()).is_ok());
    }

    #[test]
    fn empty_envs_are_refused() {
        let json = r#"{
            "schema_version": 2, "generator_version": "0.2.0",
            "base_contract": "2.0",
            "envs": []
        }"#;
        let err = parse_manifest(json.as_bytes()).unwrap_err();
        assert_eq!(err.code(), "MANIFEST_EMPTY");
    }

    #[test]
    fn unsorted_entries_are_refused() {
        // Rebuild the fixture with the entries reversed (beta before alpha) —
        // the fixture's two entries are sorted, so the reversal breaks the
        // deterministic-order contract of the schema.
        let reversed = format!(
            r#"{{
                "schema_version": 2,
                "generator_version": "0.2.0",
                "base_contract": "2.0",
                "envs": [ {b}, {a} ]
            }}"#,
            a = fixture_env_json("alpha-rule", "amd64", "R", "2.0.0"),
            b = fixture_env_json("beta-model", "arm64", "Python", "1.2.3"),
        );
        let err = parse_manifest(reversed.as_bytes()).unwrap_err();
        assert_eq!(err.code(), "MANIFEST_UNSORTED");
        assert!(
            matches!(err, ManifestLoadError::Unsorted { env_id, .. } if env_id == "alpha-rule"),
            "the first offender is the entry that breaks the order"
        );
    }

    #[test]
    fn duplicate_entry_is_refused() {
        let json = format!(
            r#"{{
                "schema_version": 2, "generator_version": "0.2.0",
                "base_contract": "2.0",
                "envs": [ {a}, {a} ]
            }}"#,
            a = fixture_env_json("alpha-rule", "amd64", "R", "2.0.0"),
        );
        let err = parse_manifest(json.as_bytes()).unwrap_err();
        assert_eq!(err.code(), "MANIFEST_DUPLICATE_ENTRY");
    }

    #[test]
    fn env_id_method_id_mismatch_is_refused() {
        // Both ids stay grammar-valid; only the identity promise breaks.
        let json = format!(
            r#"{{
                "schema_version": 2, "generator_version": "0.2.0",
                "base_contract": "2.0",
                "envs": [ {a} ]
            }}"#,
            a = fixture_env_json("alpha-rule", "amd64", "R", "2.0.0").replace(
                "\"method_id\": \"alpha-rule\"",
                "\"method_id\": \"other-rule\""
            ),
        );
        let err = parse_manifest(json.as_bytes()).unwrap_err();
        assert_eq!(err.code(), "MANIFEST_ENV_ID_MISMATCH");
    }

    #[test]
    fn layer_schema_mismatch_is_refused() {
        let json = fixture_manifest_bytes();
        let text = String::from_utf8(json).unwrap();
        let pos = text.find("\"layer_schema\": 1").unwrap();
        let mut bytes = text.into_bytes();
        bytes[pos + "\"layer_schema\": ".len()] = b'2';
        let err = parse_manifest(&bytes).unwrap_err();
        assert_eq!(err.code(), "MANIFEST_LAYER_SCHEMA");
        assert!(matches!(err, ManifestLoadError::LayerSchema { found: 2, .. }));
    }

    #[test]
    fn tag_mismatch_is_refused() {
        // Another arch, the old `<version>-<arch>` form without the env id,
        // another env's tag, the tag without the file hash, and another file's
        // hash: each is refused.
        for bad in [
            "alpha-rule-2.0.0-arm64-5ce304e213ac",
            "2.0.0-amd64",
            "beta-model-2.0.0-amd64-5ce304e213ac",
            "alpha-rule-2.0.0-amd64",
            "alpha-rule-2.0.0-amd64-000000000000",
        ] {
            let json = fixture_env_json("alpha-rule", "amd64", "R", "2.0.0").replace(
                "\"tag\": \"alpha-rule-2.0.0-amd64-5ce304e213ac\"",
                &format!("\"tag\": \"{bad}\""),
            );
            let full = format!(
                r#"{{
                    "schema_version": 2, "generator_version": "0.2.0",
                    "base_contract": "2.0",
                    "envs": [ {a} ]
                }}"#,
                a = json
            );
            let err = parse_manifest(full.as_bytes()).unwrap_err();
            assert_eq!(err.code(), "MANIFEST_TAG_MISMATCH", "{bad}");
        }
    }

    /// A tag no registry can hold (here a `+` in the version, which the
    /// version grammar allows but an OCI tag does not) is refused at load.
    #[test]
    fn an_invalid_oci_tag_is_refused() {
        let json = fixture_env_json("alpha-rule", "amd64", "R", "2.0.0+build1");
        let full = format!(
            r#"{{
                "schema_version": 2, "generator_version": "0.2.0",
                "base_contract": "2.0",
                "envs": [ {a} ]
            }}"#,
            a = json
        );
        let err = parse_manifest(full.as_bytes()).unwrap_err();
        assert_eq!(err.code(), "MANIFEST_TAG_INVALID");

        // The length limit: the env id is in the tag, so a long id can break it.
        let long_id = "x".repeat(130);
        let json = fixture_env_json(&long_id, "amd64", "R", "2.0.0");
        let full = format!(
            r#"{{
                "schema_version": 2, "generator_version": "0.2.0",
                "base_contract": "2.0",
                "envs": [ {a} ]
            }}"#,
            a = json
        );
        let err = parse_manifest(full.as_bytes()).unwrap_err();
        assert_eq!(err.code(), "MANIFEST_TAG_INVALID");
    }

    /// Two different entries that construct one tag (an env id and a version
    /// may both hold `-`) are refused: in one package a tag names one entry.
    #[test]
    fn two_entries_spelling_one_tag_are_refused() {
        let a = fixture_env_json("fx", "amd64", "R", "1.0.0-2.0.0");
        let b = fixture_env_json("fx-1.0.0", "amd64", "R", "2.0.0");
        let full = format!(
            r#"{{
                "schema_version": 2, "generator_version": "0.2.0",
                "base_contract": "2.0",
                "envs": [ {a}, {b} ]
            }}"#
        );
        let err = parse_manifest(full.as_bytes()).unwrap_err();
        assert_eq!(err.code(), "MANIFEST_DUPLICATE_TAG", "{err}");
        // Either entry alone loads.
        for one in [&a, &b] {
            let full = format!(
                r#"{{
                    "schema_version": 2, "generator_version": "0.2.0",
                    "base_contract": "2.0",
                    "envs": [ {one} ]
                }}"#
            );
            parse_manifest(full.as_bytes()).expect("one entry alone is fine");
        }
    }

    #[test]
    fn bad_pins_are_refused() {
        let json = fixture_env_json("alpha-rule", "amd64", "R", "2.0.0")
            .replace("\"layer_sha256\": \"5ce304e213ac6307d7e2d5991f432d0006805b2df9fb5f40f401905db8d0fc1a\"", "\"layer_sha256\": \"not-hex\"");
        let full = format!(
            r#"{{
                "schema_version": 2, "generator_version": "0.2.0",
                "base_contract": "2.0",
                "envs": [ {a} ]
            }}"#,
            a = json
        );
        let err = parse_manifest(full.as_bytes()).unwrap_err();
        assert_eq!(err.code(), "MANIFEST_BAD_PIN");

        let json = fixture_env_json("alpha-rule", "amd64", "R", "2.0.0")
            .replace("\"digest\": \"sha256:7153c0b1b85cf5089bb9fe80a2f9ac708e11b3e79d5cb74bd06ba5752a9d12cf\"", "\"digest\": \"nope\"");
        let full = format!(
            r#"{{
                "schema_version": 2, "generator_version": "0.2.0",
                "base_contract": "2.0",
                "envs": [ {a} ]
            }}"#,
            a = json
        );
        let err = parse_manifest(full.as_bytes()).unwrap_err();
        assert_eq!(err.code(), "MANIFEST_BAD_PIN");
    }

    #[test]
    fn bad_layer_ref_is_refused() {
        // The old one-package-per-env form, another package, a longer name
        // that only starts with the package, and the base package.
        for bad in [
            "ghcr.io/tinnlab/txr-method-env-layers/alpha-rule",
            "ghcr.io/tinnlab/other-layers",
            "ghcr.io/tinnlab/txr-method-env-layers-x",
            "ghcr.io/tinnlab/txresbench-env",
        ] {
            let json = fixture_env_json("alpha-rule", "amd64", "R", "2.0.0").replace(
                "\"oci_ref\": \"ghcr.io/tinnlab/txr-method-env-layers\"",
                &format!("\"oci_ref\": \"{bad}\""),
            );
            let full = format!(
                r#"{{
                    "schema_version": 2, "generator_version": "0.2.0",
                    "base_contract": "2.0",
                    "envs": [ {a} ]
                }}"#,
                a = json
            );
            let err = parse_manifest(full.as_bytes()).unwrap_err();
            assert_eq!(err.code(), "MANIFEST_LAYER_REF", "{bad}");
        }
    }

    #[test]
    fn bad_base_ref_is_refused() {
        // Wrong language family: an R method anchored on the Python base.
        let json = fixture_env_json("alpha-rule", "amd64", "R", "2.0.0")
            .replace("txresbench-base-r", "txresbench-base-py");
        let full = format!(
            r#"{{
                "schema_version": 2, "generator_version": "0.2.0",
                "base_contract": "2.0",
                "envs": [ {a} ]
            }}"#,
            a = json
        );
        let err = parse_manifest(full.as_bytes()).unwrap_err();
        assert_eq!(err.code(), "MANIFEST_BASE_REF");
    }

    #[test]
    fn unknown_field_is_a_parse_refusal() {
        let json = format!(
            r#"{{
                "schema_version": 2, "generator_version": "0.2.0",
                "base_contract": "2.0",
                "envs": [ {a} ], "future_field": 1
            }}"#,
            a = fixture_env_json("alpha-rule", "amd64", "R", "2.0.0"),
        );
        let err = parse_manifest(json.as_bytes()).unwrap_err();
        assert_eq!(err.code(), "MANIFEST_EMBED_INVALID");
    }

    /// ITEM-2 (qa-hardening): the dev-manifest override is pure env → path,
    /// with a blank value meaning "the embedded manifest" (a debug build with
    /// nothing configured is byte-identical to release).
    #[test]
    #[cfg(debug_assertions)]
    fn dev_manifest_override_maps_env_to_path() {
        let set = |v: &str| {
            let held = format!("/data/pbya/txresbench-app-work/qa-build/method-env-images.dev.json");
            let mut m = std::collections::HashMap::new();
            m.insert("TXR_ENV_MANIFEST".to_string(), held);
            m.get(v).cloned()
        };
        assert_eq!(
            manifest_override_path(&set).as_deref(),
            Some("/data/pbya/txresbench-app-work/qa-build/method-env-images.dev.json")
        );
        assert_eq!(manifest_override_path(&|_| None), None);
        assert_eq!(manifest_override_path(&|_| Some("   ".to_string())), None);
    }

    /// TEST-EE-06 (companion): a runnable catalogue method WITH a manifest
    /// entry resolves through the same seam both ways (the row the F screen
    /// renders is data from the one manifest).
    #[test]
    fn present_entry_and_catalogue_facts_agree() {
        let facts = facts_for("landmark-cox-current").expect("catalogue method");
        let entry = env_for("landmark-cox-current").expect("manifest entry");
        assert_eq!(facts.id, entry.method_id);
        assert_eq!(facts.version, entry.method_version);
    }

    // ── the optional `bases` list (the app-side base artifacts) ────────────

    /// The fixture entries' shared Docker base image digest
    /// (`fixture_env_json`'s `base_digest`).
    const FIXTURE_BASE_IMAGE: &str =
        "sha256:4c7af1b2d7bf29f0712f950315dc8368211374832204583a37a92c0c77dfae65";
    /// The base-py file hash of the fixture (base-r uses [`R_FILE`]).
    const PY_FILE: &str = "e10454500239e35a7558c3346c8237dbf6b7e1198cbb25c31bce90a81c38e8df";
    const R_FILE: &str = "ac281482df61024bdf3fc7e0cbb89bed5f8b97a12535ba3242e26eab7474fdd1";

    /// One `bases[]` record, well formed for its (base_id, arch, file hash).
    fn base_json(base_id: &str, arch: &str, file_sha: &str) -> String {
        let family = base_id.strip_prefix("base-").unwrap_or("x");
        format!(
            r#"{{
                "base_id": "{base_id}", "arch": "{arch}",
                "oci_ref": "ghcr.io/tinnlab/txresbench-env",
                "tag": "{base_id}-2.0-{arch}-{short}",
                "digest": "sha256:7153c0b1b85cf5089bb9fe80a2f9ac708e11b3e79d5cb74bd06ba5752a9d12cf",
                "squashfs_sha256": "{file_sha}",
                "size_bytes": 115597312,
                "source_ref": "ghcr.io/tinnlab/txresbench-base-{family}:2.0",
                "source_digest": "{FIXTURE_BASE_IMAGE}",
                "contract": "2.0"
            }}"#,
            short = &file_sha[..12],
        )
    }

    /// The two-entry fixture (alpha-rule R amd64, beta-model Python arm64)
    /// with the given `bases` list text.
    fn manifest_with_bases(bases: &str) -> Vec<u8> {
        format!(
            r#"{{
                "schema_version": 2,
                "generator_version": "0.3.0",
                "base_contract": "2.0",
                "bases": [ {bases} ],
                "envs": [ {a}, {b} ]
            }}"#,
            a = fixture_env_json("alpha-rule", "amd64", "R", "2.0.0"),
            b = fixture_env_json("beta-model", "arm64", "Python", "1.2.3"),
        )
        .into_bytes()
    }

    /// The valid `bases` text for the fixture (sorted: base-py < base-r).
    fn valid_bases() -> String {
        format!(
            "{}, {}",
            base_json("base-py", "arm64", PY_FILE),
            base_json("base-r", "amd64", R_FILE)
        )
    }

    fn bases_err(bases: &str) -> ManifestLoadError {
        parse_manifest(&manifest_with_bases(bases)).expect_err("the bases must be refused")
    }

    #[test]
    fn bases_round_trip_and_give_each_entry_its_file_pin() {
        let m = parse_manifest(&manifest_with_bases(&valid_bases())).expect("valid bases parse");
        let alpha = m.find("alpha-rule", EnvArch::Amd64).expect("alpha");
        let beta = m.find("beta-model", EnvArch::Arm64).expect("beta");
        let ab = m.base_for_entry(alpha).expect("alpha's base");
        assert_eq!((ab.base_id.as_str(), ab.arch), ("base-r", EnvArch::Amd64));
        assert_eq!(ab.tag, format!("base-r-2.0-amd64-{}", &R_FILE[..12]));
        assert_eq!(ab.oci_ref, "ghcr.io/tinnlab/txresbench-env", "the one base package");
        assert_eq!(ab.size_bytes, 115_597_312);
        assert_eq!(base_pin(alpha, Some(ab)), R_FILE, "the file hash, not the image digest");
        let bb = m.base_for_entry(beta).expect("beta's base");
        assert_eq!((bb.base_id.as_str(), bb.arch), ("base-py", EnvArch::Arm64));
        assert_eq!(base_pin(beta, Some(bb)), PY_FILE);
        // The entries' provenance fields are untouched.
        assert_eq!(alpha.base_digest, FIXTURE_BASE_IMAGE);
    }

    #[test]
    fn a_manifest_without_bases_keeps_the_old_pin_reading() {
        let m = parse_manifest(&fixture_manifest_bytes()).expect("no bases parses");
        assert_eq!(m.bases, None);
        let alpha = m.find("alpha-rule", EnvArch::Amd64).expect("alpha");
        assert_eq!(m.base_for_entry(alpha), None);
        assert_eq!(
            base_pin(alpha, None),
            FIXTURE_BASE_IMAGE.strip_prefix("sha256:").unwrap(),
            "the old reading: base_digest without its prefix (fails closed on a real download)"
        );
    }

    #[test]
    fn an_entry_without_its_base_is_refused() {
        let err = bases_err(&base_json("base-py", "arm64", PY_FILE));
        assert_eq!(err.code(), "MANIFEST_BASE_MISSING");
        assert!(
            matches!(&err, ManifestLoadError::BaseMissing { env_id, base_id, .. }
                if env_id == "alpha-rule" && base_id == "base-r"),
            "{err}"
        );
        // An empty list is not "no bases": it covers nothing.
        assert_eq!(bases_err("").code(), "MANIFEST_BASE_MISSING");
    }

    #[test]
    fn a_base_built_from_another_image_is_refused_naming_both() {
        let other = "sha256:8c0d9b07d361aa641cf89e32714899dd0b8af4df3247490345310e6a2d22a963";
        let bases = valid_bases().replacen(FIXTURE_BASE_IMAGE, other, 1);
        let err = bases_err(&bases);
        assert_eq!(err.code(), "MANIFEST_BASE_PAIRING");
        let text = err.to_string();
        assert!(text.contains(FIXTURE_BASE_IMAGE) && text.contains(other), "{text}");
        assert!(text.contains("base_digest"), "{text}");

        let bases = valid_bases().replacen(
            "ghcr.io/tinnlab/txresbench-base-r:2.0",
            "ghcr.io/other/txresbench-base-r:2.0",
            1,
        );
        let err = bases_err(&bases);
        assert_eq!(err.code(), "MANIFEST_BASE_PAIRING");
        assert!(err.to_string().contains("base_ref"), "{err}");
    }

    #[test]
    fn a_malformed_base_record_is_refused() {
        let py = base_json("base-py", "arm64", PY_FILE);
        let r = base_json("base-r", "amd64", R_FILE);
        let short_py = &PY_FILE[..12];
        let cases: Vec<(&str, String)> = vec![
            ("bad file hash", format!("{}, {r}", py.replace(PY_FILE, &"Z".repeat(64)))),
            ("bad digest", format!(
                "{}, {r}",
                py.replace("sha256:7153c0b1b85cf5089bb9fe80a2f9ac708e11b3e79d5cb74bd06ba5752a9d12cf", "nope")
            )),
            ("bad source_digest", format!(
                "{py}, {}",
                r.replace(FIXTURE_BASE_IMAGE, "sha256:abc")
            )),
            ("tag without the file hash", format!(
                "{}, {r}",
                py.replace(&format!("base-py-2.0-arm64-{short_py}"), "base-py-2.0-arm64")
            )),
            ("tag with another hash", format!(
                "{}, {r}",
                py.replace(&format!("base-py-2.0-arm64-{short_py}"), "base-py-2.0-arm64-000000000000")
            )),
            ("tag without the base id (the old form)", format!(
                "{}, {r}",
                py.replace(&format!("base-py-2.0-arm64-{short_py}"), &format!("2.0-arm64-{short_py}"))
            )),
            ("tag of the other base", format!(
                "{}, {r}",
                py.replace(&format!("base-py-2.0-arm64-{short_py}"), &format!("base-r-2.0-arm64-{short_py}"))
            )),
            ("oci_ref outside the base package", format!(
                "{}, {r}",
                py.replace("\"oci_ref\": \"ghcr.io/tinnlab/txresbench-env\"", "\"oci_ref\": \"ghcr.io/tinnlab/txr-method-env-layers\"")
            )),
            ("oci_ref in the old per-base package form", format!(
                "{}, {r}",
                py.replace("\"oci_ref\": \"ghcr.io/tinnlab/txresbench-env\"", "\"oci_ref\": \"ghcr.io/tinnlab/txresbench-env/base-py\"")
            )),
            ("unknown base id", format!("{}, {r}", py.replace("\"base_id\": \"base-py\"", "\"base_id\": \"base-x\""))),
            ("contract other than base_contract", format!(
                "{}, {r}",
                py.replace("\"contract\": \"2.0\"", "\"contract\": \"2.1\"")
            )),
            ("zero size", format!("{}, {r}", py.replace("115597312", "0"))),
            ("source_ref of the other family", format!(
                "{}, {r}",
                py.replace("txresbench-base-py:2.0", "txresbench-base-r:2.0")
            )),
            ("duplicate", format!("{py}, {py}, {r}")),
            ("unsorted", format!("{r}, {py}")),
            ("unused base", format!("{py}, {r}, {}", base_json("base-r", "arm64", R_FILE))),
        ];
        for (what, bases) in cases {
            let err = bases_err(&bases);
            assert_eq!(err.code(), "MANIFEST_BASE_INVALID", "{what}: {err}");
        }
    }

    #[test]
    fn an_unknown_field_in_a_base_record_is_a_parse_refusal() {
        let bases = valid_bases().replacen("\"contract\": \"2.0\"", "\"contract\": \"2.0\", \"extra\": 1", 1);
        assert_eq!(bases_err(&bases).code(), "MANIFEST_EMBED_INVALID");
    }
}
