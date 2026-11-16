//! Which environment image a planned method runs in.
//!
//! A train run takes the image the method list names for this computer
//! ([`PlanEnv::from_list`]). A reuse run takes the image the saved model was
//! trained in ([`resolve_recorded`]): the model's record names the two files
//! (the layer squashfs and the base squashfs, each by its sha256), and those
//! two files are what the run binds. The list only adds facts it has for the
//! same files (tag, size, method version); it never replaces a recorded file.
//! A recorded file the list does not name is fetched by its own sha256 (a
//! file address, `<package>@sha256:<pin>`: the download manager's
//! `oras blob fetch`), so a model saved before the list moved on, or before
//! this record carried tags, still gets its image.
//!
//! A record for the other chip type is refused before any download, with a
//! plain message (the user's decision: a model made on an Intel/AMD computer
//! does not run on an Apple-chip Mac, and the reverse). A record that cannot
//! be read (not a file hash, e.g. a demo row's `recorded`) is refused too.
//!
//! The functions here are pure over the list they are given; the run passes
//! the boot-validated list (a later change passes the run's own snapshot).

use super::envmanifest::{base_pin, BaseArtifact, EnvArch, EnvLanguage, EnvManifest, ManifestEntry};
use super::orchestrator::{base_env_id, base_env_ref, layer_env_ref};
use super::types::{EngineReasonCode, TxrMethodEnv, TxrModelAsset, TxrRunReason};
use crate::modules::sandbox::stack::{
    is_sha256_hex, EnvRef, TXR_BASE_REGISTRY_PREFIX, TXR_LAYER_REGISTRY_PREFIX,
};

/// The environment a planned method runs in: the two refs the download
/// manager is asked for, and the image facts the method row records.
#[derive(Debug, Clone, PartialEq)]
pub struct PlanEnv {
    /// The list's tag ref, or the file address `<pkg>@sha256:<pin>`.
    pub layer: EnvRef,
    pub base: EnvRef,
    /// `base-py` | `base-r` (the env id the base is kept under).
    pub base_id: String,
    /// The layer's byte size; `None` for a file the list does not name.
    pub layer_size: Option<u64>,
    /// What the method row records: the two file hashes, and the version,
    /// arch and tags when known.
    pub image: TxrMethodEnv,
    pub source: PlanEnvSource,
}

/// Where a [`PlanEnv`] came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanEnvSource {
    /// The method list's entry for this computer (a train run).
    List,
    /// A saved model's own record (a reuse run), even when the list supplied
    /// the tag and size of the same files.
    SavedModel { model_id: String },
}

impl PlanEnv {
    /// A train run's environment: the list entry's layer and its base.
    pub fn from_list(entry: &ManifestEntry, base: Option<&BaseArtifact>) -> PlanEnv {
        let layer = layer_env_ref(entry);
        let base_ref = base_env_ref(entry, base);
        PlanEnv {
            image: TxrMethodEnv {
                base_digest: base_ref.digest.clone(),
                layer_digest: layer.digest.clone(),
                method_version: Some(entry.method_version.clone()),
                arch: Some(entry.arch.as_str().to_string()),
                layer_tag: layer.tag.clone(),
                base_tag: base_ref.tag.clone(),
            },
            base_id: base_env_id(entry),
            layer_size: Some(entry.size_bytes),
            layer,
            base: base_ref,
            source: PlanEnvSource::List,
        }
    }

    /// The words a log line or a failure detail uses for this image: the
    /// environment's version when known, else its layer tag, else the start
    /// of the layer's file hash.
    pub fn describe(&self) -> String {
        if let Some(v) = &self.image.method_version {
            return v.clone();
        }
        if let Some(t) = &self.image.layer_tag {
            return t.clone();
        }
        format!("file {}", &self.layer.digest[..12.min(self.layer.digest.len())])
    }
}

/// Why a saved model's recorded image cannot be planned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecordRefusal {
    /// The record names no file this app can fetch (not a 64-hex file hash,
    /// an unknown arch, a method language the app has no base for).
    Unreadable(String),
    /// The record is for the other chip type (refused before any download).
    OtherArch { recorded: EnvArch, host: EnvArch },
    /// This computer's chip type has no published environments at all.
    UnsupportedHost,
}

impl RecordRefusal {
    /// The method row's reason (`cannot_run` + `ENV_UNKNOWN`), naming the
    /// saved model.
    pub fn reason(&self, asset: &TxrModelAsset) -> TxrRunReason {
        let detail = match self {
            RecordRefusal::OtherArch { recorded, host } => other_arch_message(*recorded, *host),
            RecordRefusal::Unreadable(why) => format!(
                "This saved model ({} {}) records an environment this app cannot read: {why}",
                asset.method_id, asset.method_version
            ),
            RecordRefusal::UnsupportedHost => format!(
                "This saved model ({} {}) cannot run on this computer: no method environments \
                 are published for its chip type",
                asset.method_id, asset.method_version
            ),
        };
        TxrRunReason::from_engine(EngineReasonCode::EnvUnknown, detail)
    }
}

/// The plain message for a model made on the other chip type, e.g. "This
/// saved model was made on an Intel/AMD computer; it cannot run on this Mac
/// (Apple chip)".
pub fn other_arch_message(recorded: EnvArch, host: EnvArch) -> String {
    let made_on = match recorded {
        EnvArch::Amd64 => "an Intel/AMD computer",
        EnvArch::Arm64 => "an Apple-chip (ARM) computer",
    };
    let this = match host {
        EnvArch::Amd64 => "this Intel/AMD computer",
        EnvArch::Arm64 if cfg!(target_os = "macos") => "this Mac (Apple chip)",
        EnvArch::Arm64 => "this ARM computer",
    };
    format!("This saved model was made on {made_on}; it cannot run on {this}")
}

/// A reuse run's environment: the image the saved model `asset` was trained
/// in, for a method of `language`, on a computer of chip type `host`, with
/// `list` supplying what it knows about the same files.
///
/// - Layer: a host-arch entry of the method with the recorded `layer_sha256`
///   gives its tag ref, size and version; otherwise the recorded file is
///   fetched by its sha256 from the layer package.
/// - Base: a host-arch entry of the same language whose base pin is the
///   recorded value, else a host-arch base record with that file hash, else
///   (a `sha256:`-prefixed Docker image digest, as pretrained records carry)
///   a base built from that image; otherwise the recorded file is fetched by
///   its sha256 from the base package.
/// - Arch: a record of the other chip type is [`RecordRefusal::OtherArch`].
///   A record without an arch (saved before the arch was kept) is refused
///   the same way when its layer is the list's file for the other chip type;
///   when the list does not know the file, it is planned for this computer.
pub fn resolve_recorded(
    list: &EnvManifest,
    host: Option<EnvArch>,
    asset: &TxrModelAsset,
    language: Option<EnvLanguage>,
) -> Result<PlanEnv, RecordRefusal> {
    let host = host.ok_or(RecordRefusal::UnsupportedHost)?;
    let rec = &asset.env;
    let layer_pin = rec.layer_digest.as_str();
    if !is_sha256_hex(layer_pin) {
        return Err(RecordRefusal::Unreadable(format!(
            "its layer {layer_pin:?} is not a file hash"
        )));
    }
    match rec.arch.as_deref() {
        Some(a) => {
            let recorded = EnvArch::parse(a).ok_or_else(|| {
                RecordRefusal::Unreadable(format!("its chip type {a:?} is not amd64 or arm64"))
            })?;
            if recorded != host {
                return Err(RecordRefusal::OtherArch { recorded, host });
            }
        }
        None => {
            if let Some(other) = list.envs.iter().find(|e| {
                e.arch != host && e.method_id == asset.method_id && e.layer_sha256 == layer_pin
            }) {
                return Err(RecordRefusal::OtherArch {
                    recorded: other.arch,
                    host,
                });
            }
        }
    }
    let language = language.ok_or_else(|| {
        RecordRefusal::Unreadable(format!("method {:?} has no known language", asset.method_id))
    })?;

    // ── layer ────────────────────────────────────────────────────────────
    let listed = list.envs.iter().find(|e| {
        e.arch == host && e.method_id == asset.method_id && e.layer_sha256 == layer_pin
    });
    let (layer, layer_size, method_version, layer_tag) = match listed {
        Some(e) => (
            layer_env_ref(e),
            Some(e.size_bytes),
            Some(e.method_version.clone()),
            Some(e.tag.clone()),
        ),
        None => (
            EnvRef {
                env_id: asset.method_id.clone(),
                oci_ref: format!("{TXR_LAYER_REGISTRY_PREFIX}@sha256:{layer_pin}"),
                digest: layer_pin.to_string(),
                tag: None,
            },
            None,
            rec.method_version.clone(),
            rec.layer_tag.clone(),
        ),
    };

    // ── base ─────────────────────────────────────────────────────────────
    let base_id = language.base_id();
    let base_rec = rec.base_digest.as_str();
    let same_base = |e: &&ManifestEntry| e.arch == host && e.language == language;
    let from_entry = list
        .envs
        .iter()
        .filter(same_base)
        .find(|e| base_pin(e, list.base_for_entry(e)) == base_rec)
        .map(|e| base_env_ref(e, list.base_for_entry(e)));
    // A pretrained record names the Docker image the base was packed from
    // (`sha256:`-prefixed): an entry paired with that image gives its base.
    let from_image = || {
        list.envs
            .iter()
            .filter(same_base)
            .find(|e| e.base_digest == base_rec)
            .map(|e| base_env_ref(e, list.base_for_entry(e)))
    };
    let base_records = || {
        list.bases
            .iter()
            .flatten()
            .filter(move |b| b.arch == host && b.base_id == base_id)
    };
    let record_ref = |b: &BaseArtifact| EnvRef {
        env_id: base_id.to_string(),
        oci_ref: b.oci_ref.clone(),
        digest: b.squashfs_sha256.clone(),
        tag: Some(b.tag.clone()),
    };
    let base = if let Some(r) = from_entry {
        r
    } else if let Some(b) = base_records().find(|b| b.squashfs_sha256 == base_rec) {
        record_ref(b)
    } else if let Some(r) = from_image() {
        r
    } else if let Some(b) = base_records().find(|b| b.source_digest == base_rec) {
        // The same Docker image, through a base record when no entry of the
        // language is listed for this computer.
        record_ref(b)
    } else if is_sha256_hex(base_rec) {
        EnvRef {
            env_id: base_id.to_string(),
            oci_ref: format!("{TXR_BASE_REGISTRY_PREFIX}@sha256:{base_rec}"),
            digest: base_rec.to_string(),
            tag: None,
        }
    } else {
        return Err(RecordRefusal::Unreadable(format!(
            "its base {base_rec:?} is neither a file hash nor a base this app knows"
        )));
    };
    let base_tag = base.tag.clone().or_else(|| rec.base_tag.clone());

    Ok(PlanEnv {
        image: TxrMethodEnv {
            base_digest: base.digest.clone(),
            layer_digest: layer.digest.clone(),
            method_version,
            arch: Some(host.as_str().to_string()),
            layer_tag,
            base_tag,
        },
        base_id: base_id.to_string(),
        layer_size,
        layer,
        base,
        source: PlanEnvSource::SavedModel {
            model_id: asset.model_id.clone(),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::execution_engine::envmanifest::parse_manifest;

    const DOCKER_PY: &str =
        "sha256:4c7af1b2d7bf29f0712f950315dc8368211374832204583a37a92c0c77dfae65";
    const PY_FILE: &str = "e10454500239e35a7558c3346c8237dbf6b7e1198cbb25c31bce90a81c38e8df";
    const PY_FILE_OLD: &str = "0b1c3a1b2d7bf29f0712f950315dc8368211374832204583a37a92c0c77d0000";
    const LAYER_V1: &str = "1111111111116307d7e2d5991f432d0006805b2df9fb5f40f401905db8d0fc1a";
    const LAYER_V2: &str = "2222222222226307d7e2d5991f432d0006805b2df9fb5f40f401905db8d0fc1a";
    const LAYER_ARM: &str = "3333333333336307d7e2d5991f432d0006805b2df9fb5f40f401905db8d0fc1a";

    /// One list entry of a Python method (base-py), well formed.
    fn entry(id: &str, arch: &str, version: &str, layer: &str, size: u64) -> String {
        format!(
            r#"{{
                "env_id": "{id}", "method_id": "{id}", "method_version": "{version}",
                "language": "Python", "arch": "{arch}",
                "oci_ref": "ghcr.io/tinnlab/txr-method-env-layers",
                "tag": "{id}-{version}-{arch}-{short}",
                "digest": "sha256:7153c0b1b85cf5089bb9fe80a2f9ac708e11b3e79d5cb74bd06ba5752a9d12cf",
                "layer_sha256": "{layer}",
                "size_bytes": {size},
                "base_ref": "ghcr.io/tinnlab/txresbench-base-py:2.0",
                "base_digest": "{DOCKER_PY}",
                "contract": "2.0",
                "licence": "MIT",
                "wrapper_code_sha256": "bfe338c7cc0353db8ac93b0fffb7ea3e0aead14e181d33397bd4066c9aa92eaf",
                "layer_schema": 1,
                "source_revision": "5db3b60f727d",
                "source_tree": "13d6890bbaa6ab7a2032a2a5b93ee12851057859",
                "generator_version": "0.5.0"
            }}"#,
            short = &layer[..12],
        )
    }

    fn base(arch: &str, file: &str) -> String {
        format!(
            r#"{{
                "base_id": "base-py", "arch": "{arch}",
                "oci_ref": "ghcr.io/tinnlab/txresbench-env",
                "tag": "base-py-2.0-{arch}-{short}",
                "digest": "sha256:7153c0b1b85cf5089bb9fe80a2f9ac708e11b3e79d5cb74bd06ba5752a9d12cf",
                "squashfs_sha256": "{file}",
                "size_bytes": 115597312,
                "source_ref": "ghcr.io/tinnlab/txresbench-base-py:2.0",
                "source_digest": "{DOCKER_PY}",
                "contract": "2.0"
            }}"#,
            short = &file[..12],
        )
    }

    /// A list from entries (sorted by the caller) and an optional bases list.
    fn list(bases: Option<&[String]>, envs: &[String]) -> EnvManifest {
        let bases = match bases {
            Some(b) => format!(r#""bases": [{}],"#, b.join(",")),
            None => String::new(),
        };
        let text = format!(
            r#"{{ "schema_version": 2, "generator_version": "0.5.0", "base_contract": "2.0",
                 {bases} "envs": [{}] }}"#,
            envs.join(",")
        );
        parse_manifest(text.as_bytes()).expect("the fixture list is valid")
    }

    /// Today's list: cox-model at 2.0.0 (LAYER_V2) for amd64 and arm64, on
    /// the base-py file PY_FILE.
    fn moved_on_list() -> EnvManifest {
        list(
            Some(&[base("amd64", PY_FILE), base("arm64", PY_FILE)]),
            &[
                entry("cox-model", "amd64", "2.0.0", LAYER_V2, 9_000_000),
                entry("cox-model", "arm64", "2.0.0", LAYER_ARM, 8_000_000),
            ],
        )
    }

    fn asset(method: &str, env: TxrMethodEnv) -> TxrModelAsset {
        TxrModelAsset {
            model_id: "model-1".to_string(),
            host_dir: "/models/trees/x".to_string(),
            tree_sha256: "ab".repeat(32),
            method_id: method.to_string(),
            method_version: "1.0.0".to_string(),
            env,
            contract: "2.0".to_string(),
            conversions: Default::default(),
        }
    }

    fn recorded(base: &str, layer: &str, version: Option<&str>, arch: Option<&str>) -> TxrMethodEnv {
        TxrMethodEnv {
            base_digest: base.to_string(),
            layer_digest: layer.to_string(),
            method_version: version.map(str::to_string),
            arch: arch.map(str::to_string),
            layer_tag: version.map(|v| format!("cox-model-{v}-amd64-{}", &layer[..12])),
            base_tag: Some(format!("base-py-2.0-amd64-{}", &base[..12])),
        }
    }

    const HOST: Option<EnvArch> = Some(EnvArch::Amd64);
    const PY: Option<EnvLanguage> = Some(EnvLanguage::Python);

    #[test]
    fn recorded_layer_is_bound_when_the_list_moved_on() {
        let l = moved_on_list();
        let a = asset("cox-model", recorded(PY_FILE, LAYER_V1, Some("1.0.0"), Some("amd64")));
        let env = resolve_recorded(&l, HOST, &a, PY).expect("planned");
        assert_eq!(env.layer.digest, LAYER_V1, "the model's own layer, not the list's 2.0.0");
        assert_eq!(
            env.layer.oci_ref,
            format!("ghcr.io/tinnlab/txr-method-env-layers@sha256:{LAYER_V1}"),
            "fetched by its file hash"
        );
        assert_eq!(env.layer.tag, None);
        assert_eq!(env.layer.env_id, "cox-model");
        assert_eq!(env.layer_size, None, "the list does not know the old file's size");
        // The base file is still the list's: its tag ref.
        assert_eq!(env.base.digest, PY_FILE);
        assert_eq!(env.base.tag.as_deref(), Some(format!("base-py-2.0-amd64-{}", &PY_FILE[..12]).as_str()));
        assert_eq!(env.base_id, "base-py");
        // The record keeps what the saved model knew.
        assert_eq!(env.image.layer_digest, LAYER_V1);
        assert_eq!(env.image.method_version.as_deref(), Some("1.0.0"));
        assert_eq!(env.image.layer_tag.as_deref(), Some(format!("cox-model-1.0.0-amd64-{}", &LAYER_V1[..12]).as_str()));
        assert_eq!(env.image.arch.as_deref(), Some("amd64"));
        assert_eq!(env.source, PlanEnvSource::SavedModel { model_id: "model-1".to_string() });
        assert_eq!(env.describe(), "1.0.0");
    }

    #[test]
    fn matching_record_uses_the_list_entry() {
        let l = moved_on_list();
        let a = asset("cox-model", recorded(PY_FILE, LAYER_V2, None, None));
        let env = resolve_recorded(&l, HOST, &a, PY).expect("planned");
        let tag = format!("cox-model-2.0.0-amd64-{}", &LAYER_V2[..12]);
        assert_eq!(env.layer.oci_ref, "ghcr.io/tinnlab/txr-method-env-layers");
        assert_eq!(env.layer.tag.as_deref(), Some(tag.as_str()), "the list's tag ref");
        assert_eq!(env.layer.digest, LAYER_V2);
        assert_eq!(env.layer_size, Some(9_000_000));
        assert_eq!(env.image.method_version.as_deref(), Some("2.0.0"), "the entry's version");
        assert_eq!(env.image.layer_tag.as_deref(), Some(tag.as_str()));
        assert!(
            matches!(env.source, PlanEnvSource::SavedModel { .. }),
            "a reuse is always the saved model's, even when the list supplied the tag"
        );
    }

    #[test]
    fn method_missing_from_the_list_still_resolves() {
        let l = moved_on_list();
        let a = asset("retired-model", recorded(PY_FILE, LAYER_V1, Some("1.0.0"), Some("amd64")));
        let env = resolve_recorded(&l, HOST, &a, PY).expect("planned without a list entry");
        assert_eq!(env.layer.env_id, "retired-model");
        assert_eq!(
            env.layer.oci_ref,
            format!("ghcr.io/tinnlab/txr-method-env-layers@sha256:{LAYER_V1}")
        );
        assert_eq!(env.base.digest, PY_FILE, "the base record of its language");
        assert!(env.base.tag.is_some());
    }

    #[test]
    fn pre_pr_record_resolves_without_tag() {
        // A model saved before the image facts were kept: two digests only,
        // neither named by today's list.
        let l = moved_on_list();
        let a = asset("cox-model", TxrMethodEnv::digests(PY_FILE_OLD, LAYER_V1));
        let env = resolve_recorded(&l, HOST, &a, PY).expect("planned");
        assert_eq!(env.layer.tag, None);
        assert_eq!(env.layer.digest, LAYER_V1);
        assert_eq!(env.base.tag, None);
        assert_eq!(
            env.base.oci_ref,
            format!("ghcr.io/tinnlab/txresbench-env@sha256:{PY_FILE_OLD}"),
            "the old base file, fetched by its sha256"
        );
        assert_eq!(env.base.env_id, "base-py");
        assert_eq!(env.image.method_version, None);
        assert_eq!(env.image.layer_tag, None);
        assert_eq!(env.image.base_tag, None);
        assert_eq!(env.image.arch.as_deref(), Some("amd64"), "it runs on this computer");
        assert!(env.describe().starts_with("file 111111111111"));
    }

    #[test]
    fn unreadable_record_is_cannot_run() {
        let l = moved_on_list();
        // The demo's saved models record the word "recorded".
        let a = asset("cox-model", TxrMethodEnv::digests("recorded", "recorded"));
        let err = resolve_recorded(&l, HOST, &a, PY).expect_err("not a file hash");
        assert!(matches!(err, RecordRefusal::Unreadable(_)), "{err:?}");
        let reason = err.reason(&a);
        assert_eq!(reason.code, "ENV_UNKNOWN");
        assert!(reason.detail.contains("cox-model 1.0.0"), "names the model: {}", reason.detail);

        let bad_base = asset("cox-model", TxrMethodEnv::digests("recorded", LAYER_V1));
        assert!(matches!(
            resolve_recorded(&l, HOST, &bad_base, PY),
            Err(RecordRefusal::Unreadable(_))
        ));
        let bad_arch = asset("cox-model", recorded(PY_FILE, LAYER_V1, None, Some("riscv64")));
        assert!(matches!(
            resolve_recorded(&l, HOST, &bad_arch, PY),
            Err(RecordRefusal::Unreadable(_))
        ));
    }

    #[test]
    fn other_arch_record_is_refused_with_message() {
        let l = moved_on_list();
        // A model made on an Intel/AMD computer, opened on an Apple-chip Mac.
        let a = asset("cox-model", recorded(PY_FILE, LAYER_V2, Some("2.0.0"), Some("amd64")));
        let err = resolve_recorded(&l, Some(EnvArch::Arm64), &a, PY)
            .expect_err("never planned for the other chip type");
        assert_eq!(
            err,
            RecordRefusal::OtherArch {
                recorded: EnvArch::Amd64,
                host: EnvArch::Arm64
            }
        );
        let reason = err.reason(&a);
        assert_eq!(reason.code, "ENV_UNKNOWN");
        if cfg!(target_os = "macos") {
            assert_eq!(
                reason.detail,
                "This saved model was made on an Intel/AMD computer; it cannot run on this Mac (Apple chip)"
            );
        }
        // The reverse.
        assert_eq!(
            other_arch_message(EnvArch::Arm64, EnvArch::Amd64),
            "This saved model was made on an Apple-chip (ARM) computer; it cannot run on this Intel/AMD computer"
        );
        // A record from before the arch was kept: its layer is the list's
        // file for the other chip type, so it is refused the same way.
        let pre = asset("cox-model", TxrMethodEnv::digests(PY_FILE, LAYER_ARM));
        assert_eq!(
            resolve_recorded(&l, HOST, &pre, PY),
            Err(RecordRefusal::OtherArch {
                recorded: EnvArch::Arm64,
                host: EnvArch::Amd64
            })
        );
        // No supported chip type at all.
        assert_eq!(
            resolve_recorded(&l, None, &pre, PY),
            Err(RecordRefusal::UnsupportedHost)
        );
    }

    #[test]
    fn pretrained_source_digest_finds_its_base() {
        // A pretrained record names the Docker image of the base (with its
        // `sha256:` prefix), not the base file.
        let l = moved_on_list();
        let a = asset("cox-model", recorded(DOCKER_PY, LAYER_V2, None, Some("amd64")));
        let env = resolve_recorded(&l, HOST, &a, PY).expect("planned");
        assert_eq!(env.base.digest, PY_FILE, "the base file built from that image");
        assert_eq!(env.base.oci_ref, "ghcr.io/tinnlab/txresbench-env");
        assert_eq!(env.image.base_digest, PY_FILE, "the run records the file it verified");

        // A list without bases (today's committed list): the entry's own base
        // reading matches the Docker digest.
        let old_list = list(None, &[entry("cox-model", "amd64", "2.0.0", LAYER_V2, 9_000_000)]);
        let env = resolve_recorded(&old_list, HOST, &a, PY).expect("planned");
        assert_eq!(env.base.digest, DOCKER_PY.strip_prefix("sha256:").unwrap());
        assert_eq!(env.base.tag.as_deref(), Some("base-py-2.0-amd64"));
    }

    #[test]
    fn train_records_the_entry_version_not_the_catalogue_version() {
        // The list entry is built at 2.0.1 while the catalogue says 2.0.0
        // (AUDIT P5): the run records the entry's version.
        let l = list(
            Some(&[base("amd64", PY_FILE)]),
            &[entry("cox-model", "amd64", "2.0.1", LAYER_V2, 9_000_000)],
        );
        let e = l.find("cox-model", EnvArch::Amd64).expect("entry");
        let env = PlanEnv::from_list(e, l.base_for_entry(e));
        assert_eq!(env.image.method_version.as_deref(), Some("2.0.1"));
        assert_eq!(env.image.arch.as_deref(), Some("amd64"));
        assert_eq!(env.image.layer_digest, LAYER_V2);
        assert_eq!(env.image.base_digest, PY_FILE);
        assert_eq!(env.image.layer_tag, env.layer.tag);
        assert_eq!(env.image.base_tag, env.base.tag);
        assert_eq!(env.layer_size, Some(9_000_000));
        assert_eq!(env.source, PlanEnvSource::List);
        assert_eq!(env.describe(), "2.0.1");
    }
}
