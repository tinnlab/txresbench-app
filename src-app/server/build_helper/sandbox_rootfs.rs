//! Build-time staging of the CytoAnalyst analysis-rootfs embed slot.
//!
//! FETCH-NEWEST, NOTHING EMBEDDED (DEC-24 reversed / DEC-I): the analysis rootfs
//! is a CI-built, GHCR-published OCI artifact that `OciEnvImageProvider`
//! lazy-fetches + cosign-verifies + mounts at RUNTIME (see
//! `src/modules/sandbox/env_image.rs`). It is NOT built or embedded at cargo time.
//! The real recipe lives at `src-app/env-rootfs/<env>/Dockerfile` and is published
//! by `.github/workflows/env-images.yml` when that recipe changes on `main`.
//!
//! So this helper does NO docker build — it stages only a ZERO-BYTE stub into the
//! `include_bytes!` slot (kept so the runtime embed symbol still compiles; the
//! embedded path is never taken). This removes docker as a build dependency.
//! (The docker-build machinery below `setup()`'s stub return is retained,
//! `#[allow(unreachable_code)]`, only as reference for the CI recipe.)
//!
//! The schema/freshness primitives live in `src/modules/rootfs/version.rs` (the
//! single source of truth, unit-tested in the lib) and are `#[path]`-included by
//! `build.rs` as `rootfs_version` so this helper and the runtime never drift.

use std::fs;
use std::path::Path;
use std::process::Command;

// `build.rs` declares `mod rootfs_version;` (a `#[path]` include of the lib
// file) at crate root, so we reach it via `crate::rootfs_version`.
use crate::rootfs_version::{
    arch_variant, build_arg_freshness_tag, build_arg_url_vars, discover_env_recipes, format_version,
    is_fresh, is_shipped_in_v1, select_env_recipe_in, BuildArgUrlVar, RootfsArchVariant,
    ENV_DEFAULT_FILE, ENV_RECIPE_FILE, ENV_ROOTFS_ID_VAR, ROOTFS_SCHEMA_VERSION,
};

/// Staging path (manifest-relative, so it persists across `cargo clean` like
/// ziee's hub-seed — avoids re-running docker on every clean build).
const STAGE_REL: &str = "binaries/sandbox-rootfs/rootfs.squashfs";
const VERSION_REL: &str = "binaries/sandbox-rootfs/.version";

/// The env-recipe TREE, relative to the server crate's manifest dir. Every
/// subdirectory holding a `Dockerfile` is one selectable env (`env-rootfs/<env-id>/`).
///
/// W2: this helper used to hardcode ONE analysis domain's recipe path
/// (`../env-rootfs/<a-domain>/Dockerfile`) — the domain pinned into the BUILD SYSTEM,
/// i.e. baked into the binary before any data was loaded. It now names only the tree;
/// WHICH recipe is a build INPUT (see [`resolve_recipe`]) and the ids are read off
/// disk as DATA. Mirrors the runtime, where the env-id likewise comes from the
/// contributed manifests / `CYTO_SANDBOX_ENV_ID` and never from a source literal
/// (`modules::sandbox::env_image::default_env_id`).
const ENV_ROOTFS_REL: &str = "../env-rootfs";

/// The recipe this build targets: its env-id and its `Dockerfile` path.
struct SelectedRecipe {
    env_id: String,
    dockerfile: std::path::PathBuf,
}

/// Resolve which env recipe this build targets, from the tree on disk plus the
/// `CYTO_ENV_ROOTFS_ID` override. `None` when the tree is empty or an override
/// names an absent recipe (the caller then stages a stub, loudly).
fn resolve_recipe(env_root: &Path) -> Option<SelectedRecipe> {
    let override_id = std::env::var(ENV_ROOTFS_ID_VAR).ok();
    // #191: the default is the tree's DECLARED one (`env-rootfs/DEFAULT_ENV`), not the
    // first sorted id — with two recipes on disk, sort order is luck, and the thing it
    // would silently re-point is what gets published under the moving tag.
    let env_id = select_env_recipe_in(env_root, override_id.as_deref())?;
    let dockerfile = env_root.join(&env_id).join(ENV_RECIPE_FILE);
    Some(SelectedRecipe { env_id, dockerfile })
}

/// Resolve the target arch this binary is being built for. `CARGO_CFG_TARGET_ARCH`
/// is set by cargo for the build script (the arch we compile FOR, honoring a
/// `--target` cross-compile); fall back to the host arch if somehow unset.
fn build_target_arch() -> String {
    std::env::var("CARGO_CFG_TARGET_ARCH")
        .unwrap_or_else(|_| std::env::consts::ARCH.to_string())
}

/// Compute the freshness key: the schema/Dockerfile hash (shared) PLUS the arch PLUS
/// a hash of EVERY operator-supplied build-arg URL VALUE, so switching target arch —
/// or rotating one of those URLs to a DIFFERENT build — re-stages instead of serving
/// a stale cached squashfs. Tracking the URL VALUE (not merely set/unset) is the
/// blind-audit LOW fix: a set/unset flag served the stale build when the URL changed.
///
/// S8: the set of URLs is DECLARED BY THE RECIPE (`build_arg_url_vars` parses the
/// Dockerfile's own `ARG <NAME>_URL` lines), not a named tool here — this helper
/// folds whatever the recipe declares and understands none of them. The env-id is
/// folded in too, so switching recipes re-stages instead of serving another env's
/// cached squashfs.
fn want_version_for(env_id: &str, dockerfile_bytes: &[u8], arch: &str) -> String {
    let tags: Vec<String> = build_arg_url_vars(dockerfile_bytes)
        .iter()
        .map(|v| build_arg_freshness_tag(&v.key, std::env::var(&v.env).ok().as_deref()))
        .collect();
    format!(
        "{} env={env_id} arch={arch} {}",
        format_version(ROOTFS_SCHEMA_VERSION, dockerfile_bytes),
        tags.join(" ")
    )
}

/// Entry point called from `build.rs`. Never returns `Err` for a rootfs-build
/// failure — it stages a stub and returns Ok (fail-soft).
pub fn setup(manifest_dir: &Path) -> Result<(), Box<dyn std::error::Error>> {
    // The REAL rootfs recipes live at `src-app/env-rootfs/<env-id>/Dockerfile` (built
    // + published to GHCR by `.github/workflows/env-images.yml`, NOT at cargo time);
    // watch the TREE (catches add/remove/rename of a whole recipe) and EVERY recipe
    // file (cargo does not re-fire on a dir's own mtime for an in-place edit), so an
    // editor still gets a rebuild-check signal on any recipe change — not just the
    // one this build happens to select.
    let env_root = manifest_dir.join(ENV_ROOTFS_REL);
    println!("cargo:rerun-if-changed={}", env_root.display());
    let available = discover_env_recipes(&env_root);
    for id in &available {
        println!("cargo:rerun-if-changed={}", env_root.join(id).join(ENV_RECIPE_FILE).display());
    }
    // #191: the tree's DECLARED default is an input to which recipe a build targets, and
    // cargo does not re-fire on a directory's own mtime for an in-place edit — so watch
    // the declaration file by name, exactly as each recipe file is watched above.
    println!("cargo:rerun-if-changed={}", env_root.join(ENV_DEFAULT_FILE).display());
    println!("cargo:rerun-if-env-changed=CYTO_SKIP_SANDBOX_ROOTFS");
    // Re-run when the selected env recipe changes (W2 — the domain is an input).
    println!("cargo:rerun-if-env-changed={ENV_ROOTFS_ID_VAR}");
    // Re-run when the TARGET arch changes (per-arch rootfs — ITEM-27).
    println!("cargo:rerun-if-env-changed=CARGO_CFG_TARGET_ARCH");
    // …or an operator supplies/rotates a build-arg URL any recipe DECLARES (S8).
    // The union across recipes, so an override to another env still re-fires.
    let mut watched: Vec<String> = Vec::new();
    for id in &available {
        let Ok(bytes) = fs::read(env_root.join(id).join(ENV_RECIPE_FILE)) else { continue };
        for v in build_arg_url_vars(&bytes) {
            if !watched.contains(&v.env) {
                watched.push(v.env);
            }
        }
    }
    for env in &watched {
        println!("cargo:rerun-if-env-changed={env}");
    }

    let stage = manifest_dir.join(STAGE_REL);
    let version_file = manifest_dir.join(VERSION_REL);

    if let Some(parent) = stage.parent() {
        fs::create_dir_all(parent)?;
    }

    // ANALYSIS-ROOTFS (DEC-24 reversed): NOTHING is embedded anymore — the rootfs is
    // a CI-built, GHCR-published OCI artifact lazy-fetched at runtime by
    // `OciEnvImageProvider`. So the build embeds only a ZERO-BYTE STUB (keeps the
    // runtime `include_bytes!` compiling; the embedded path is never used) and does
    // NO docker build at cargo time — removing docker as a build dependency.
    return write_stub(&stage, &version_file);

    #[allow(unreachable_code)]
    if std::env::var("CYTO_SKIP_SANDBOX_ROOTFS").ok().as_deref() == Some("1") {
        println!("cargo:warning=sandbox rootfs: CYTO_SKIP_SANDBOX_ROOTFS=1 -> stub (sandbox self-disables at runtime)");
        return write_stub(&stage, &version_file);
    }

    // Only Linux gets a real rootfs (Linux-first, DEC-3). Other targets stub.
    if !cfg!(target_os = "linux") {
        return write_stub(&stage, &version_file);
    }

    // Per-arch (ITEM-27 / DEC-30): select the rootfs recipe for the TARGET arch.
    let arch = build_target_arch();
    let variant = match arch_variant(&arch) {
        Some(v) => v,
        None => {
            println!(
                "cargo:warning=sandbox rootfs: no rootfs recipe for target arch {arch:?} -> stub"
            );
            return write_stub(&stage, &version_file);
        }
    };
    // v1 builds + ships ONLY the x86_64 variant; the aarch64 path is WIRED
    // (the resolver + Dockerfile MAMBA_ARCH/platform are ready) but produces an
    // artifact only when an arm/CI runner builds+verifies it natively (DEC-30).
    if !is_shipped_in_v1(&arch) {
        println!(
            "cargo:warning=sandbox rootfs: target arch {arch:?} is wired (micromamba {sel}, \
             {plat}) but NOT produced in v1 (no arm build/verify host) -> stub; the sandbox \
             self-disables on this arch until a native builder is added",
            sel = variant.micromamba_selector,
            plat = variant.docker_platform
        );
        return write_stub(&stage, &version_file);
    }

    // W2: WHICH env recipe this build targets is an INPUT (`CYTO_ENV_ROOTFS_ID`),
    // defaulting to the tree's sole recipe — no domain path is hardcoded here.
    let Some(recipe) = resolve_recipe(&env_root) else {
        println!(
            "cargo:warning=sandbox rootfs: no env recipe selected (tree {root} has {n} recipe(s); \
             {var}={sel:?}) -> stub",
            root = env_root.display(),
            n = available.len(),
            var = ENV_ROOTFS_ID_VAR,
            sel = std::env::var(ENV_ROOTFS_ID_VAR).ok(),
        );
        return write_stub(&stage, &version_file);
    };
    if available.len() > 1 && std::env::var(ENV_ROOTFS_ID_VAR).is_err() {
        println!(
            "cargo:warning=sandbox rootfs: {n} env recipes available; defaulting to {id:?} — set \
             {var} to select another",
            n = available.len(),
            id = recipe.env_id,
            var = ENV_ROOTFS_ID_VAR,
        );
    }
    let dockerfile = recipe.dockerfile;

    let want_version = match fs::read(&dockerfile) {
        Ok(bytes) => want_version_for(&recipe.env_id, &bytes, &arch),
        Err(e) => {
            println!("cargo:warning=sandbox rootfs: cannot read Dockerfile ({e}); staging stub");
            return write_stub(&stage, &version_file);
        }
    };

    let staged_len = fs::metadata(&stage).map(|m| m.len()).unwrap_or(0);
    let recorded = fs::read_to_string(&version_file).ok();
    if is_fresh(staged_len, recorded.as_deref(), &want_version) {
        println!("sandbox rootfs: already staged (version matches) — skipping docker build");
        return Ok(());
    }

    match build_and_stage(manifest_dir, &recipe.env_id, &dockerfile, &stage, &variant) {
        Ok(()) => {
            let _ = fs::write(&version_file, &want_version);
            println!("sandbox rootfs: staged {} ({})", stage.display(), want_version);
            Ok(())
        }
        Err(e) => {
            println!(
                "cargo:warning=sandbox rootfs build failed ({e}); staging stub — the sandbox will self-disable at runtime"
            );
            write_stub(&stage, &version_file)
        }
    }
}

/// docker build -> create -> cp the squashfs out. Any step failing bubbles up.
/// Parameterized by the selected `env_id` (W2) and the target-arch `variant`
/// (ITEM-27): the micromamba selector + container platform + every build-arg URL
/// the RECIPE declares are forwarded as `--build-arg`s / `--platform` so the same
/// helper produces any env's rootfs for any arch.
fn build_and_stage(
    manifest_dir: &Path,
    env_id: &str,
    dockerfile: &Path,
    stage: &Path,
    variant: &RootfsArchVariant,
) -> Result<(), Box<dyn std::error::Error>> {
    ensure_docker()?;

    // Per-env AND per-arch tag, so building a second env cannot clobber the first.
    let tag = format!(
        "cytoanalyst-sandbox-rootfs:{ROOTFS_SCHEMA_VERSION}-{env_id}-{}",
        variant.cargo_arch
    );
    let context = manifest_dir.join("rootfs");

    // Operator-supplied tool tarballs (S8): each build-arg URL THE RECIPE DECLARES
    // (`ARG <NAME>_URL`) is forwarded verbatim from `CYTO_<NAME>_URL`. Empty => the
    // Dockerfile skips that layer (fail-soft); the runtime then reports the tool
    // absent and the declaring processor's arch/availability gate degrades. This
    // helper names no tool — the table is parsed out of the recipe.
    let declared: Vec<BuildArgUrlVar> = match fs::read(dockerfile) {
        Ok(bytes) => build_arg_url_vars(&bytes),
        Err(e) => return Err(format!("cannot read recipe {}: {e}", dockerfile.display()).into()),
    };
    let mut args: Vec<String> = vec![
        "build".into(),
        "--platform".into(),
        variant.docker_platform.into(),
        "--build-arg".into(),
        format!("ROOTFS_SCHEMA_VERSION={ROOTFS_SCHEMA_VERSION}"),
        "--build-arg".into(),
        format!("MAMBA_ARCH={}", variant.micromamba_selector),
    ];
    for v in &declared {
        args.push("--build-arg".into());
        args.push(format!("{}={}", v.build_arg, std::env::var(&v.env).unwrap_or_default()));
    }
    args.push("-t".into());
    args.push(tag.clone());
    args.push("-f".into());

    run(
        Command::new("docker").args(&args).arg(dockerfile).arg(&context),
        "docker build",
    )?;

    let cid = run_capture(Command::new("docker").args(["create", &tag]), "docker create")?;
    let cid = cid.trim().to_string();
    if cid.is_empty() {
        return Err("docker create returned no container id".into());
    }

    let cp_result = run(
        Command::new("docker")
            .arg("cp")
            .arg(format!("{cid}:/rootfs.squashfs"))
            .arg(stage),
        "docker cp",
    );
    let _ = run(Command::new("docker").args(["rm", "-f", &cid]), "docker rm");
    cp_result?;

    let len = fs::metadata(stage).map(|m| m.len()).unwrap_or(0);
    if len < 4096 {
        return Err(format!("staged squashfs is implausibly small ({len} bytes)").into());
    }
    Ok(())
}

fn ensure_docker() -> Result<(), Box<dyn std::error::Error>> {
    match Command::new("docker").arg("version").output() {
        Ok(o) if o.status.success() => Ok(()),
        Ok(o) => Err(format!(
            "`docker version` exited {}: {}",
            o.status,
            String::from_utf8_lossy(&o.stderr).trim()
        )
        .into()),
        Err(e) => Err(format!("docker not runnable: {e}").into()),
    }
}

fn run(cmd: &mut Command, what: &str) -> Result<(), Box<dyn std::error::Error>> {
    let status = cmd.status().map_err(|e| format!("{what}: spawn failed: {e}"))?;
    if !status.success() {
        return Err(format!("{what}: exited {status}").into());
    }
    Ok(())
}

fn run_capture(cmd: &mut Command, what: &str) -> Result<String, Box<dyn std::error::Error>> {
    let out = cmd.output().map_err(|e| format!("{what}: spawn failed: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "{what}: exited {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        )
        .into());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Write a zero-byte stub so `include_bytes!` compiles. The runtime treats an
/// empty payload as "rootfs unavailable" and self-disables.
fn write_stub(stage: &Path, version_file: &Path) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(parent) = stage.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::File::create(stage)?; // zero bytes
    let _ = fs::write(version_file, "stub");
    println!("sandbox rootfs: wrote zero-byte stub at {}", stage.display());
    Ok(())
}
