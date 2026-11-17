//! `method_list` — the signed method list (`method-list.json` + `method-list.json.minisig`).
//!
//! One file carries both halves of the method facts the app runs on: the catalogue and the
//! environment images list, nested as they are, under a small header with a `sequence`. A
//! maintainer assembles it in the methods repository, signs it with their minisign key and
//! publishes it to `ghcr.io/tinnlab/txresbench-method-list`
//! (`scripts/publish-method-list.sh`); an app release imports it as its built-in copy
//! (`scripts/import-method-list.sh`).
//!
//! The app runs on the list: it embeds only the list's built-in copy
//! (`data/method-list/method-list.json`), and every request and run asks one snapshot of the
//! current list for its methods, markers and images.
//!
//! - [`keys`] — the trusted public keys, compiled in from `data/method-list/trusted-keys.json`;
//! - [`verify`] — the minisign check on the raw bytes, before any parse; it is the only
//!   maker of a [`verify::VerifiedList`];
//! - [`format`] — the header, the two nested documents through their own loaders, the
//!   rules that tie them together, and the lookups a snapshot answers;
//! - [`runtime`] — the built-in list and the current one ([`current`]), moved to a newer
//!   verified list between runs;
//! - [`fetch`] — the published list through the bundled oras (resolve, then pull by digest,
//!   capped); [`store`] — the last good list on disk; [`routes`] — `GET /api/methods/updates`
//!   and `POST /api/methods/updates/check`.
//!
//! The `txresbench check-method-list` command is the arbiter the publisher and the import
//! run: it verifies and parses a list exactly as the app does.

pub mod fetch;
pub mod format;
pub mod keys;
pub mod routes;
pub mod runtime;
pub mod store;
#[cfg(test)]
mod test_sign;
pub mod verify;

use std::io::Read;
use std::path::Path;

use aide::axum::ApiRouter;
use linkme::distributed_slice;

use txresbench_framework::{AppModule, ModuleContext, ModuleEntry, MODULE_ENTRIES};

pub use format::MethodList;
pub use runtime::{builtin, current};

use keys::TrustedKeys;
use verify::{VerifiedList, MAX_LIST_BYTES, MAX_SIGNATURE_BYTES};

/// The module instance: the built-in list is checked at boot, then the runtime starts on
/// the newest valid list and checks the registry once in the background.
pub struct MethodListModule {
    boot_check_spawned: bool,
}

impl AppModule for MethodListModule {
    fn name(&self) -> &'static str {
        "method_list"
    }

    fn description(&self) -> &'static str {
        "The signed method list (catalogue + environment images): the built-in copy and the current list (TxResBench)."
    }

    fn init(&mut self, _ctx: &ModuleContext) -> Result<(), Box<dyn std::error::Error>> {
        // The boot check: verify + parse the built-in list ONCE here. A refusal aborts
        // the boot: a first-party list the app cannot read is never an empty one.
        let list = runtime::ensure_builtin().map_err(|e| {
            Box::<dyn std::error::Error>::from(format!("method list load failed: {e}"))
        })?;
        tracing::info!(
            sequence = list.sequence,
            methods = list.catalogue.methods.len(),
            image_entries = list.images.envs.len(),
            signed = list.signer.is_some(),
            dev_manifest = runtime::dev_manifest_active(),
            "method list: the built-in copy loaded"
        );
        let seams = runtime::production_seams(crate::modules::rootfs::data_root());
        if let Some(why) = &seams.off_reason {
            tracing::info!(reason = %why, "method list: updates are off");
        }
        let rt = runtime::install(runtime::ListRuntime::new(list.clone(), seams));
        let active = rt.active();
        tracing::info!(
            sequence = active.list.sequence,
            origin = ?active.origin,
            "method list: in use"
        );
        // ONE detached check per boot: never blocks the boot (offline is a valid state),
        // the result is the status.
        if rt.updates_enabled() && !self.boot_check_spawned {
            self.boot_check_spawned = true;
            let rt = rt.clone();
            tokio::spawn(async move {
                let status = rt.check(runtime::CheckBudget::BACKGROUND).await;
                tracing::info!(
                    sequence = status.sequence,
                    result = ?status.last_check,
                    "method list: boot check finished"
                );
            });
        }
        Ok(())
    }

    fn register_routes(&self, router: ApiRouter) -> ApiRouter {
        router.merge(routes::method_list_routes())
    }
}

/// Module registration. Distinct order (45), before every reader of the list
/// (`method_catalogue` 47, `file_validator` 48, `execution_engine` 49) — see
/// `modules/mod.rs::module_order_is_unique` (46 is taken).
#[distributed_slice(MODULE_ENTRIES)]
static METHOD_LIST: ModuleEntry = ModuleEntry {
    name: "method_list",
    order: 45,
    description: "The signed method list: built-in copy + current list (TxResBench).",
    constructor: || {
        Box::new(MethodListModule {
            boot_check_spawned: false,
        })
    },
};

/// Read at most `cap` bytes of `path`; a longer file is refused without reading the rest.
fn read_capped(path: &Path, cap: usize, what: &str) -> Result<Vec<u8>, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("read the {what} {}: {e}", path.display()))?;
    let mut bytes = Vec::new();
    file.take(cap as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("read the {what} {}: {e}", path.display()))?;
    if bytes.len() > cap {
        return Err(format!(
            "METHOD_LIST_TOO_LARGE: the {what} {} is over the {cap}-byte cap",
            path.display()
        ));
    }
    Ok(bytes)
}

/// `txresbench check-method-list --list <f> [--signature <f>] [--keys <f>]`: verify and
/// parse a list exactly as the app does, and describe it. Without `--signature` only the
/// unsigned `sequence: 0` bootstrap copy passes. `--keys` replaces the compiled-in trusted
/// keys (fixtures and rehearsals); the report says so.
pub fn check_method_list_cli(
    list: &Path,
    signature: Option<&Path>,
    keys_file: Option<&Path>,
) -> Result<String, String> {
    let bytes = read_capped(list, MAX_LIST_BYTES, "list")?;
    let verified = match signature {
        Some(sig_path) => {
            let sig = read_capped(sig_path, MAX_SIGNATURE_BYTES, "signature")?;
            let owned;
            let keys = match keys_file {
                Some(p) => {
                    let raw = read_capped(p, 1024 * 1024, "trusted-keys file")?;
                    owned = TrustedKeys::from_json(&raw).map_err(|e| e.to_string())?;
                    &owned
                }
                None => TrustedKeys::builtin().map_err(|e| e.to_string())?,
            };
            verify::verify_with(&bytes, &sig, keys).map_err(|e| e.to_string())?
        }
        None => VerifiedList::unsigned_bootstrap(bytes).map_err(|e| e.to_string())?,
    };
    let parsed = format::parse(verified).map_err(|e| e.to_string())?;

    let runnable = parsed.catalogue.methods.iter().filter(|m| m.runnable).count();
    let mut arches: std::collections::BTreeMap<&str, usize> = std::collections::BTreeMap::new();
    for e in &parsed.images.envs {
        *arches.entry(e.arch.as_str()).or_default() += 1;
    }
    let arch_text = arches
        .iter()
        .map(|(a, n)| format!("{a} {n}"))
        .collect::<Vec<_>>()
        .join(", ");
    let signer = match (&parsed.signer, keys_file) {
        (Some(s), Some(p)) => format!(
            "{} (key {}; from --keys {}, NOT the app's trusted keys)",
            s.label,
            s.key_id,
            p.display()
        ),
        (Some(s), None) => format!("{} (key {})", s.label, s.key_id),
        (None, _) => "none (the unsigned sequence 0 bootstrap copy)".to_string(),
    };
    Ok(format!(
        "method list OK\n\
         format: {} {}\n\
         sequence: {}\n\
         assembled_at: {}\n\
         methods: {} ({} runnable)\n\
         markers: {}\n\
         image entries: {} ({})\n\
         bases: {}\n\
         signer: {}\n",
        format::LIST_FORMAT,
        parsed.format_version,
        parsed.sequence,
        parsed.assembled_at,
        parsed.catalogue.methods.len(),
        runnable,
        parsed.catalogue.markers.len(),
        parsed.images.envs.len(),
        if arch_text.is_empty() { "none".to_string() } else { arch_text },
        parsed.images.bases.as_ref().map_or(0, Vec::len),
        signer,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn method_list_registers_once_at_unique_order_45() {
        let me: Vec<_> = MODULE_ENTRIES.iter().filter(|e| e.name == "method_list").collect();
        assert_eq!(me.len(), 1, "{me:?}");
        assert_eq!(me[0].order, 45);
        let at_45: Vec<_> = MODULE_ENTRIES.iter().filter(|e| e.order == 45).map(|e| e.name).collect();
        assert_eq!(at_45, vec!["method_list"]);
        assert_eq!((me[0].constructor)().name(), "method_list");
    }

    fn fixture(rel: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../scripts/method-list/fixtures")
            .join(rel)
    }

    #[test]
    fn cli_check_describes_a_verified_list() {
        let out = check_method_list_cli(
            &fixture("list-dir/method-list.json"),
            Some(&fixture("list-dir/method-list.json.minisig")),
            Some(&fixture("fixture-keys.json")),
        )
        .expect("the fixture list checks");
        assert!(out.contains("sequence: 1\n"), "{out}");
        assert!(out.contains("methods: 3 (3 runnable)\n"), "{out}");
        assert!(out.contains("image entries: 2 (amd64 2)\n"), "{out}");
        assert!(out.contains("bases: 2\n"), "{out}");
        assert!(out.contains("NOT the app's trusted keys"), "{out}");
    }

    #[test]
    fn cli_check_refuses_with_the_code() {
        // The built-in keys do not trust the fixture key.
        let err = check_method_list_cli(
            &fixture("list-dir/method-list.json"),
            Some(&fixture("list-dir/method-list.json.minisig")),
            None,
        )
        .unwrap_err();
        assert!(err.starts_with("METHOD_LIST_UNKNOWN_KEY"), "{err}");
        // No signature: only a sequence 0 list passes.
        let err = check_method_list_cli(&fixture("list-dir/method-list.json"), None, None).unwrap_err();
        assert!(err.starts_with("METHOD_LIST_UNSIGNED"), "{err}");
    }
}
