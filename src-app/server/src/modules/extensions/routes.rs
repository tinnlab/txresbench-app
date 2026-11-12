//! `extensions` REST — the backend-owned extension-manifest control plane (ITEM-3).
//! One route this round: `GET /api/extensions` dumps the boot-built registry so the
//! FE `workbenchRegistry` becomes a PROJECTION of the backend source (not the
//! origin). Gated by the REUSED `projects::use` (DEC-13 — no new permission), and
//! MIRRORS `datatype/routes.rs::list_datatypes` exactly.

use aide::axum::routing::{get_with, post_with};
use aide::axum::ApiRouter;
use aide::transform::TransformOperation;
use axum::http::StatusCode;
use axum::Json;
use schemars::JsonSchema;
use serde::Serialize;

use txresbench_core::{ApiResult, AppError};

use crate::modules::permissions::{with_permission, RequirePermissions};
use crate::modules::project::ProjectsUse;
use crate::modules::sandbox::permissions::{SandboxSettingsManage, SandboxSettingsRead};

use super::loader::{registry, PackageLoadStatus};
use super::types::ExtensionManifest;

pub fn extension_routes() -> ApiRouter {
    ApiRouter::new().api_route("/extensions", get_with(list_extensions, list_extensions_docs))
}

/// The runtime processor control-plane routes (S7, ITEM-9/11): a per-package
/// load-status dump (`GET /api/processors`) + an admin-only reflect trigger
/// (`POST /api/processors/reload`). Kept as its own router (merged alongside
/// `extension_routes`) so the processor surface is grouped distinctly from the
/// manifest dump.
pub fn processor_routes() -> ApiRouter {
    ApiRouter::new()
        .api_route("/processors", get_with(list_processors, list_processors_docs))
        .api_route(
            "/processors/packages",
            get_with(list_processor_packages, list_processor_packages_docs),
        )
        .api_route(
            "/processors/reload",
            post_with(reload_processors, reload_processors_docs),
        )
}

/// The response of `POST /api/processors/reload`: the discovered set (per-package
/// load status, `ok | skipped-with-error`) after the reflect, plus the count of
/// registered (folded) extensions. This is exactly what the S8 admin page renders —
/// which packages loaded ok vs were skipped-with-error.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct ProcessorReloadResponse {
    /// Count of registered extensions (valid, folded packages) after the reflect.
    pub registered: usize,
    /// Per-package load status (each scanned package once: `ok`, or
    /// skipped-with-error), id-sorted — the discovered set.
    pub packages: Vec<PackageLoadStatus>,
}

/// One registered processor package's FE-facing SOURCE assets (H2): the raw
/// `manifest.yaml` text + every `ui/*.yaml` view-spec text, read FROM THE RUNTIME FOLDER
/// (`<data_root>/processors/<id>/`). This is what lets a runtime-dropped pure-DATA
/// processor's declarative UI render with ZERO FE rebuild — the FE no longer discovers
/// view-specs only via a build-time `import.meta.glob` over the in-tree source dir.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct ProcessorPackageAssets {
    /// The package id (folder name == registered extension id).
    pub id: String,
    /// The raw `manifest.yaml` text (the FE parses it into its `ProcessorManifestData`).
    pub manifest: String,
    /// The `ui/*.yaml` view specs, each with its PACKAGE-RELATIVE PATH.
    ///
    /// The path is load-bearing, not decoration: an analysis declares `ui: [ui/qc.yaml]`
    /// and the FE loader resolves exactly those files IN THAT ORDER (they stack into one
    /// pane). A bare list of texts carries no identity, so a file could not be attributed
    /// to the analysis that declared it, and "declaration order" would fall back to
    /// whatever the directory read returned.
    pub views: Vec<ProcessorViewAsset>,
}

/// One `ui/*.yaml` view spec plus the path an analysis' `ui:` entry names.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct ProcessorViewAsset {
    /// Package-relative, always `ui/<file>.yaml`.
    pub path: String,
    /// The raw YAML text (parsed + `registerDeclarativeView`'d by the FE).
    pub text: String,
}

/// The response of `GET /api/processors/packages`: the per-package FE source assets for
/// every REGISTERED (loaded-ok) package, so the workbench builds its declarative views at
/// runtime from the folder rather than only from the build-time glob.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct ProcessorPackagesResponse {
    pub packages: Vec<ProcessorPackageAssets>,
}

/// Serve every registered package's `manifest.yaml` + `ui/*.yaml` bytes from the runtime
/// folder (H2). Gated by `projects::use` — the workbench-user read perm the FE mirror
/// (`GET /api/extensions`) already uses (this is the same user-facing surface). The set is
/// tied to `registry().load_status()` (only `ok` packages), so it automatically respects
/// the SEED-ONLY kill-switch + the malformed-skip (a skipped package contributes no view).
/// Every file read is CONFINED under its package dir (canonicalized, symlink-escape
/// rejected — same H3 gate the compute resolver uses), so a symlinked `ui/*.yaml` can't
/// leak a host file.
async fn list_processor_packages(
    _auth: RequirePermissions<(ProjectsUse,)>,
) -> ApiResult<Json<ProcessorPackagesResponse>> {
    let dir = super::embedded::ensure_extracted().map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            AppError::internal_error(format!("processor folder not available: {e}")),
        )
    })?;
    // The `ok` package ids from the current registry snapshot (cheap, in-memory).
    let ids: Vec<String> = registry()
        .load_status()
        .iter()
        .filter(|s| s.ok)
        .map(|s| s.id.clone())
        .collect();
    // The per-package folder reads (canonicalize + read_dir + read_to_string) are
    // blocking `std::fs` — run them on a blocking pool, never on a tokio worker (§5;
    // mirrors the reload handler's `spawn_blocking`).
    let packages = tokio::task::spawn_blocking(move || read_package_assets(&dir, &ids))
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                AppError::internal_error(format!("processor packages task join failed: {e}")),
            )
        })?
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                AppError::internal_error(format!("processors root not resolvable: {e}")),
            )
        })?;
    Ok((StatusCode::OK, Json(ProcessorPackagesResponse { packages })))
}

/// Read each package's `manifest.yaml` + `ui/*.yaml` bytes from the folder (blocking
/// `std::fs`, called on a `spawn_blocking` pool). Confines every file under the TRUSTED
/// canonicalized processors ROOT `dir` (a registered package whose FOLDER is a directory
/// symlink can't launder an escape). A per-package read error is fail-isolated (skip); only
/// an unresolvable processors root is an `Err`.
fn read_package_assets(
    dir: &std::path::Path,
    ids: &[String],
) -> Result<Vec<ProcessorPackageAssets>, String> {
    let canon_root = std::fs::canonicalize(dir)
        .map_err(|e| format!("processors root `{}` not resolvable: {e}", dir.display()))?;
    let mut packages: Vec<ProcessorPackageAssets> = Vec::new();
    for id in ids {
        let pkg_dir = dir.join(id);
        let Some(manifest) = read_confined(&canon_root, &pkg_dir.join("manifest.yaml")) else {
            continue; // registered but manifest unreadable / escapes root — skip (fail-isolated)
        };
        let mut views: Vec<ProcessorViewAsset> = Vec::new();
        let ui_dir = pkg_dir.join("ui");
        if let Ok(entries) = std::fs::read_dir(&ui_dir) {
            let mut files: Vec<std::path::PathBuf> = entries
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("yaml"))
                .collect();
            files.sort();
            for f in files {
                if let Some(text) = read_confined(&canon_root, &f) {
                    // `ui/<file>.yaml` — the same spelling an analysis' `ui:` entry uses.
                    let Some(name) = f.file_name().and_then(|n| n.to_str()) else {
                        continue;
                    };
                    views.push(ProcessorViewAsset { path: format!("ui/{name}"), text: text.clone() });
                }
            }
        }
        packages.push(ProcessorPackageAssets { id: id.clone(), manifest, views });
    }
    Ok(packages)
}

/// Read a file CONFINED under the TRUSTED processors root `canon_root` (already
/// canonicalized): canonicalize the file (resolving every symlink) and require it to live
/// under the root. Confining against the ROOT — not the untrusted package dir — is what
/// blocks a package FOLDER that is itself a directory symlink (`packages/zzz` → `/home`)
/// from laundering an arbitrary host-file read. `None` on any escape / read error
/// (fail-isolated).
fn read_confined(canon_root: &std::path::Path, file: &std::path::Path) -> Option<String> {
    let canon_file = std::fs::canonicalize(file).ok()?;
    if !canon_file.starts_with(canon_root) {
        return None;
    }
    std::fs::read_to_string(&canon_file).ok()
}

fn list_processor_packages_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description("Serve every registered processor package's manifest.yaml + ui/*.yaml view-spec bytes FROM THE RUNTIME FOLDER, so the workbench renders a runtime-dropped pure-DATA processor's declarative UI with zero FE rebuild. Requires `projects::use`.")
        .id("Processor.packages")
        .tag("processors")
        .response::<200, Json<ProcessorPackagesResponse>>()
}

/// Dump the live extension-manifest registry (the FE mirror reads this).
async fn list_extensions(
    _auth: RequirePermissions<(ProjectsUse,)>,
) -> ApiResult<Json<Vec<ExtensionManifest>>> {
    let reg = registry();
    let manifests: Vec<ExtensionManifest> = reg.all().into_iter().cloned().collect();
    Ok((StatusCode::OK, Json(manifests)))
}

fn list_extensions_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description("Dump the backend-owned extension-manifest registry: the converters + views (+ reserved datatypes) each extension contributes.")
        .id("Extension.list")
        .tag("extensions")
        .response::<200, Json<Vec<ExtensionManifest>>>()
}

/// Dump the per-package processor load status (ITEM-11). Gated by
/// `sandbox::settings::read` — the EXACT perm the `/settings/processors` admin page (its
/// sole consumer) gates its slot/route/store on, so the client self-gate equals the
/// endpoint read-perm (M6 — no 403-on-a-gated-load; the FE never shows the page to a user
/// the endpoint would reject). Reads the current registry snapshot's `load_status()` (each
/// scanned package once: `ok`, or skipped-with-error), so a malformed dropped-in package
/// surfaces here as `ok:false` with its package-scoped error.
async fn list_processors(
    _auth: RequirePermissions<(SandboxSettingsRead,)>,
) -> ApiResult<Json<Vec<PackageLoadStatus>>> {
    let reg = registry();
    Ok((StatusCode::OK, Json(reg.load_status().to_vec())))
}

fn list_processors_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(SandboxSettingsRead,)>(op)
        .description("Dump the per-package processor load status (each scanned package once: `ok`, or skipped-with-error), id-sorted — the source the admin Processors page renders. Requires `sandbox::settings::read`.")
        .id("Processor.list")
        .tag("processors")
        .response::<200, Json<Vec<PackageLoadStatus>>>()
}

/// Runtime reload of the processor folder (ITEM-9). Re-runs the SHARED
/// `reflect_processors()` path (the exact same extract-no-clobber + folder scan +
/// atomic republish of BOTH registries the live filesystem watcher uses — no divergent
/// reload logic), then returns the discovered set + per-package load status from the
/// freshly-published snapshot. Gated by `sandbox::settings::manage` (M6 — reconciled from
/// the old root-only `RequireAdmin` so an Administrators-group member holding the perm via
/// the `*` wildcard can Reload without a live 403; the FE self-gates the Reload button on
/// the SAME perm). `reflect_processors` is synchronous + does blocking `std::fs`
/// (extract + folder scan), so it runs on a `spawn_blocking` pool, never on a tokio worker.
async fn reload_processors(
    _auth: RequirePermissions<(SandboxSettingsManage,)>,
) -> ApiResult<Json<ProcessorReloadResponse>> {
    let registered = tokio::task::spawn_blocking(super::reflect_processors)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                AppError::internal_error(format!("processor reload task join failed: {e}")),
            )
        })?
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                AppError::internal_error(format!("processor reload failed: {e}")),
            )
        })?;
    // Read the load status off the freshly-republished snapshot (reflect swapped it in).
    let packages = registry().load_status().to_vec();
    Ok((StatusCode::OK, Json(ProcessorReloadResponse { registered, packages })))
}

fn reload_processors_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(SandboxSettingsManage,)>(op)
        .description(
            "Re-run the processor folder extract(no-clobber)+scan and atomically republish both \
             registries (the SAME reflect path the live watcher uses), returning the \
             registered-extension count + per-package load status (each scanned package once: \
             `ok`, or skipped-with-error). Requires `sandbox::settings::manage` — 401 if \
             unauthenticated, 403 if authenticated but lacking the perm.",
        )
        .id("Processor.reload")
        .tag("processors")
        .response::<200, Json<ProcessorReloadResponse>>()
}
