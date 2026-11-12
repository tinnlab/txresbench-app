//! Rootfs schema version + build-embed freshness logic — the ONE source of
//! truth shared by the runtime (`rootfs` module) AND the build helper
//! (`build_helper/sandbox_rootfs.rs`, which `#[path]`-includes this file so the
//! two can never drift). Kept dependency-light (only `sha2`) so the build
//! script can include it without pulling the rest of the crate.

use sha2::{Digest, Sha256};

/// The rootfs schema version baked into the image marker
/// (`/.txresbench-sandbox-rootfs-schema`) by the docker build, and compared by
/// the runtime mount probe. Bump on any breaking rootfs layout change; the
/// runtime refuses to mount a rootfs whose marker disagrees.
///
/// v2 (P3 ITEM-12): the scientific Python stack (scanpy/anndata/leidenalg/
/// harmonypy/zarr). NOTE the location moved: this stack was ORIGINALLY installed
/// via micromamba at `/opt/conda`, but the current recipe installs it (harmonypy
/// included) via `uv` into the venv at `/opt/venv` — see the v5 note below, which
/// replaced the conda env wholesale.
/// v3 (datasets-management ITEM-12, DEC-12): adds the **Cell Ranger** CLI on
/// `PATH` (x86_64 only — DEC-30) for the `cellranger` processor. The bump forces
/// a re-embed + refuses a stale v2 cached rootfs.
/// v4 (anndata-h5ad ITEM-23, DEC-13/22): adds **tiledbsoma** (the canonical
/// TileDB-SOMA writer) to the conda env so the `single-cell` env image can emit
/// a lossless SOMA store from the h5ad/10x converter. The bump forces a re-embed
/// + refuses a stale v3 cached rootfs.
/// v5 (analysis-rootfs, `2d48e45b`): the interpreter environment MOVED — the
/// micromamba/conda env at `/opt/conda` is replaced by a wheels-only `uv` venv at
/// `/opt/venv`, so the sandbox PATH prepends `/opt/venv/bin` (it still keeps
/// `/opt/conda/bin` behind it for a legacy image). A moved interpreter prefix is
/// exactly the breaking LAYOUT change this constant exists to fence: a v4 image
/// mounted under a v5 server resolves no interpreter at all. Shipped together with
/// the switch away from baking the image into the binary at build time — it is now
/// PULLED as a signed OCI env image tagged by this schema + arch, so the bump also
/// re-points the tag the runtime fetches.
///
/// NOT BUMPED for artifact-model ITEM-38 (a recipe package removal), and the reasoning
/// is recorded here because "should this have bumped?" is the question this constant
/// exists to make answerable:
///  * WHAT THIS FENCES is a breaking LAYOUT change — a moved interpreter prefix, a
///    renamed mount point, a changed marker path. v5's own note is the template: a v4
///    image under a v5 server "resolves no interpreter at all". ITEM-38 removes ONE
///    wheel from the venv; `/opt/venv`, the sandbox PATH, every bind and the marker file
///    are byte-identical. An old image still runs correctly under a new server and a new
///    image runs correctly under an old one, so there is nothing to fence.
///  * BUMPING WOULD BE ACTIVELY HARMFUL. The runtime resolves the MOVING tag
///    `schema<N>-latest-<arch>` (`sandbox::env_image::moving_tag`). Bumping N re-points
///    every deploy at a tag that does not exist until CI has published it, so the whole
///    fleet fails to fetch a rootfs in the window between merge and publish — a real
///    outage traded for a property nothing needed.
///  * THE CHANGE STILL PROPAGATES WITHOUT A BUMP. `format_version` folds a hash of the
///    recipe bytes, so the local build re-stages; and `env-images.yml`'s `gate` job
///    rebuilds on any `env-rootfs/**` change, re-pointing the moving tag at the new
///    digest. The runtime is fetch-newest, so the next pull picks it up.
///  * NOTHING ELSE KEYED ON THE PACKAGE. The two in-sandbox import smoke-tests
///    (`tests/sandbox/env_image_oci_test.rs`) named it and were updated in the same
///    change; no processor imports it (`tests/dataset/mod.rs` asserts that statically).
pub const ROOTFS_SCHEMA_VERSION: u32 = 5;

/// The marker filename at the rootfs root (read after squashfuse-mount).
/// (Unused in the build-script inclusion of this file — only the runtime mount
/// module reads it — so silence dead_code there.)
#[allow(dead_code)]
pub const ROOTFS_SCHEMA_MARKER: &str = ".txresbench-sandbox-rootfs-schema";

/// Format the `.version` sidecar string from a schema number + the Dockerfile
/// bytes: `schema=<n> dockerfile=<sha8>`. A Dockerfile edit or a schema bump
/// changes the string, which re-triggers the docker build (skip-if-fresh).
pub fn format_version(schema: u32, dockerfile_bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(dockerfile_bytes);
    let sha = hex_lower(&h.finalize());
    format!("schema={schema} dockerfile={}", &sha[..8])
}

/// Decide whether a staged asset is fresh: the file exists, is NON-empty (a
/// zero-byte stub is never fresh), and its recorded `.version` equals `want`.
pub fn is_fresh(staged_len: u64, recorded_version: Option<&str>, want: &str) -> bool {
    staged_len > 0 && recorded_version.map(|v| v.trim() == want).unwrap_or(false)
}

/// Freshness tag for an OPERATOR-SUPPLIED build-arg URL, folded into the rootfs
/// `.version` key.
///
/// A rootfs recipe may need a tool whose tarball sits behind a time-limited SIGNED
/// URL the operator supplies at build time. We fold a HASH of the URL VALUE — not
/// merely whether it is set — so rotating the URL to a DIFFERENT build re-stages the
/// rootfs; a set/unset flag alone served the stale cached squashfs when the URL
/// changed to a new build (blind-audit LOW). An unset/blank URL ⇒ `no<key>` (the
/// Dockerfile skips the layer). Hashing the FULL URL is the safe-over-stale choice:
/// merely re-signing the SAME build's URL also re-stages (a harmless rebuild), but a
/// new build can never serve a stale rootfs.
///
/// ## S8 — this used to BE one named tool's policy
///
/// The function was a per-tool `*_freshness_tag(url)` reading a fixed per-tool env
/// var, and the `V1_SHIPPED_ARCH` doc justified itself with that one vendor's build
/// targets — one tool's shipping decision as permanent SERVER policy, in a file the
/// runtime mount probe shares with the build helper. The tool is now DECLARED BY THE
/// RECIPE and discovered by [`build_arg_url_vars`]; the key names the build arg, and
/// the arch-shipping decision is about what this project can BUILD AND VERIFY, not
/// about any tool.
pub fn build_arg_freshness_tag(key: &str, url: Option<&str>) -> String {
    match url {
        Some(u) if !u.trim().is_empty() => {
            let mut h = Sha256::new();
            h.update(u.trim().as_bytes());
            let sha = hex_lower(&h.finalize());
            format!("{key}={}", &sha[..8])
        }
        _ => format!("no{key}"),
    }
}

// ───────────── operator-supplied build-arg URLs — DECLARED BY THE RECIPE ────
//
// W2/S8: this used to be a `const BUILD_ARG_URL_VARS` table in server source
// naming one specific third-party tool's env var + build arg. A build-arg
// table is part of the RECIPE's interface, not the app's: the recipe declares
// which operator-supplied tarball URLs it accepts, and the build helper is a
// generic pass-through that understands none of them. So the table is now PARSED
// OUT OF THE RECIPE — the Dockerfile's own `ARG <NAME>_URL` declarations ARE the
// manifest. Adding a tool is a recipe edit with ZERO server-source change.

/// One operator-supplied build-arg URL a rootfs recipe declares.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildArgUrlVar {
    /// Short, stable freshness key folded into the `.version` cache key
    /// (the lowercased arg name minus its `_URL` suffix).
    pub key: String,
    /// The app-namespaced env var an operator sets to supply the URL
    /// (`TXR_<ARGNAME>`).
    pub env: String,
    /// The docker `--build-arg` name — verbatim what the recipe declared.
    pub build_arg: String,
}

/// The env-var prefix under which an operator supplies a recipe-declared URL.
/// App-namespaced so a recipe's `ARG FOO_URL` can never read an arbitrary
/// ambient env var of the same name.
const BUILD_ARG_ENV_PREFIX: &str = "TXR_";

/// Parse a rootfs recipe (Dockerfile bytes) for the operator-supplied build-arg
/// URLs it DECLARES: every top-level `ARG <NAME>_URL[=default]` line.
///
/// This helper understands none of the names — a recipe that declares
/// `ARG ALIGNER_URL` gets `TXR_ALIGNER_URL` folded into the freshness key and
/// forwarded as `--build-arg ALIGNER_URL=…`, with no server-source edit. Entries
/// are de-duplicated (a multi-stage Dockerfile re-declares an `ARG` per stage)
/// and returned in first-declaration order.
pub fn build_arg_url_vars(dockerfile_bytes: &[u8]) -> Vec<BuildArgUrlVar> {
    let text = String::from_utf8_lossy(dockerfile_bytes);
    let mut out: Vec<BuildArgUrlVar> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        // `ARG` is case-insensitive in the Dockerfile grammar, and must be
        // followed by whitespace (so `ARGUMENT=…` is not an ARG instruction).
        let Some(tail) = line.get(..3).filter(|k| k.eq_ignore_ascii_case("ARG")).map(|_| &line[3..])
        else {
            continue;
        };
        if !tail.starts_with([' ', '\t']) {
            continue;
        }
        let rest = tail.trim_start();
        // `ARG NAME`, `ARG NAME=default`, `ARG NAME="a b"` → the name token.
        let name = rest.split(['=', ' ', '\t']).next().unwrap_or("").trim();
        let Some(stem) = name.strip_suffix("_URL") else { continue };
        if stem.is_empty() {
            continue;
        }
        let key = stem.to_ascii_lowercase();
        if out.iter().any(|v| v.key == key) {
            continue;
        }
        out.push(BuildArgUrlVar {
            key,
            env: format!("{BUILD_ARG_ENV_PREFIX}{name}"),
            build_arg: name.to_string(),
        });
    }
    out
}

// ─────────────────── which env recipe THIS build targets (W2) ───────────────
//
// W2: the build helper used to hardcode ONE domain's recipe path
// (`../env-rootfs/<a-domain>/Dockerfile`) — an analysis domain baked into the build
// system, i.e. pinned into the binary before any data was loaded. The recipe tree
// `env-rootfs/<env-id>/`
// IS the data: each subdirectory holding a [`ENV_RECIPE_FILE`] is one selectable
// env. Selection is an INPUT (`TXR_ENV_ROOTFS_ID`), defaulting to the tree's
// sole recipe — so a one-recipe tree resolves exactly as the hardcoded path did.

/// The recipe filename inside `env-rootfs/<env-id>/`.
pub const ENV_RECIPE_FILE: &str = "Dockerfile";

/// The build-time env var selecting which env recipe to build. Mirrors the
/// runtime's `TXR_SANDBOX_ENV_ID` (which selects which env image to FETCH).
pub const ENV_ROOTFS_ID_VAR: &str = "TXR_ENV_ROOTFS_ID";

/// Discover every env recipe in `env_root` — each subdirectory containing a
/// [`ENV_RECIPE_FILE`] — as sorted env-ids. Empty when the tree is missing.
/// The ids are DATA read off disk; no name is known to this code.
pub fn discover_env_recipes(env_root: &std::path::Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(env_root) else { return Vec::new() };
    let mut ids: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().join(ENV_RECIPE_FILE).is_file())
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    ids.sort();
    ids
}

/// The file BESIDE the recipe directories that DECLARES which env-id is this tree's
/// default — `env-rootfs/DEFAULT_ENV`, one line, the env-id and nothing else.
///
/// It is a file in the recipe tree and not a constant here for the same reason the
/// recipe ids are: the set of environments is deployment DATA declared next to the
/// recipes, never a name the app core carries (INV-4 / R3-F2). A `const DEFAULT: &str
/// = "<some-env>"` in this file would put an analysis-domain literal into the build
/// surface — exactly what `check-derived-vocabulary.sh` exists to retire.
///
/// It is deliberately NOT a directory (so `discover_env_recipes` and
/// `read_env_recipes`, which both require a subdirectory holding a
/// [`ENV_RECIPE_FILE`], ignore it by construction) and NOT inside a recipe (a
/// recipe cannot elect itself; the tree elects one of them).
pub const ENV_DEFAULT_FILE: &str = "DEFAULT_ENV";

/// The env-id this recipe tree DECLARES as its default, or `None` when the tree
/// declares none. Blank/whitespace and a missing file are both `None`; the first
/// non-blank, non-`#` line is the declaration, so the file can carry a comment
/// explaining the choice.
pub fn declared_default_recipe(env_root: &std::path::Path) -> Option<String> {
    let text = std::fs::read_to_string(env_root.join(ENV_DEFAULT_FILE)).ok()?;
    // STRIP A UTF-8 BOM FIRST — at position 0 only, which is where a BOM is by definition
    // and the only place an editor writes one. A U+FEFF elsewhere in the file still glues
    // to the id, no recipe matches, and selection REFUSES — noisy and fail-closed, which is
    // the right end to fail from; it is the leading one that was silently destructive.
    //
    // `char::is_whitespace` is the Unicode White_Space property
    // and U+FEFF is NOT in it, so `trim()` leaves a BOM attached to the first character:
    // the leading comment line becomes "\u{feff}# The env-id…", which does not
    // `starts_with('#')`, so the WHOLE COMMENT is read as the declared env-id. Nothing
    // matches it, `select_env_recipe` returns None, and the build stages a STUB rootfs —
    // silently, from an editor setting. One `strip_prefix` closes it.
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    text.lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with('#'))
        .map(str::to_string)
}

/// Which recipe this build/publish targets, given the discovered ids, an optional
/// operator override, and the tree's DECLARED default ([`declared_default_recipe`]).
///
/// - override set + present ⇒ that one (an override naming an absent recipe is
///   `None`, so the build stubs loudly rather than silently building another env);
/// - no override + a DECLARED default that exists ⇒ that one;
/// - no override + a DECLARED default naming an ABSENT recipe ⇒ `None`. A stale
///   declaration is an error, never a fall-through — falling through would build a
///   different environment than the tree says it builds, under a moving tag every
///   deployment resolves, which is not a recoverable mistake;
/// - no override + no declaration + exactly one recipe ⇒ that one (the
///   no-behavior-change default: a one-recipe tree resolves exactly as the old
///   hardcoded path did, and needs no declaration to say the obvious);
/// - no override + no declaration + SEVERAL recipes ⇒ `None`.
///
/// That last arm is the change #191 makes, and it is the whole point of the
/// declaration. It used to return `available.first()` — the first SORTED id — so
/// with two recipes the default build target was alphabetical luck. In the tree as it
/// stands the incumbent env happens to sort first, so the existing default would have
/// survived by COINCIDENCE — which is the most dangerous form of correct, because the
/// next recipe inherits the coincidence and can silently become the default instead,
/// re-pointing which rootfs the build stages into a binary that then expects to find it.
/// An ambiguous tree with no declaration therefore refuses, exactly as
/// `scripts/publish-env-rootfs.sh` already refuses and names its candidates rather than
/// guessing.
///
/// **That script does NOT consult the declaration, and that is not an oversight.** A
/// build chooses what to stage locally; a publish re-points the moving
/// `schema<N>-latest-<arch>` tag every running deployment resolves. The second is
/// unrecoverable, so it takes an explicit `--env` and never a default. See
/// `env-rootfs/DEFAULT_ENV`'s own header.
pub fn select_env_recipe(
    available: &[String],
    override_id: Option<&str>,
    declared_default: Option<&str>,
) -> Option<String> {
    if let Some(want) = override_id.map(str::trim).filter(|s| !s.is_empty()) {
        return available.iter().find(|id| *id == want).cloned();
    }
    if let Some(want) = declared_default.map(str::trim).filter(|s| !s.is_empty()) {
        return available.iter().find(|id| *id == want).cloned();
    }
    match available {
        [sole] => Some(sole.clone()),
        _ => None,
    }
}

/// [`select_env_recipe`] over a recipe TREE: discovers the ids and reads the tree's
/// own declaration, so a caller cannot accidentally resolve a default without it.
pub fn select_env_recipe_in(
    env_root: &std::path::Path,
    override_id: Option<&str>,
) -> Option<String> {
    let available = discover_env_recipes(env_root);
    let declared = declared_default_recipe(env_root);
    select_env_recipe(&available, override_id, declared.as_deref())
}

// ─────────────────────────── per-arch rootfs (ITEM-27) ──────────────────────
//
// The rootfs build is parameterized by the binary's TARGET CPU arch
// (`CARGO_CFG_TARGET_ARCH`, set by cargo for the build script), mirroring the
// per-triple pgvector/biomcp helpers: micromamba's per-arch selector +
// container platform differ, and each binary embeds the SINGLE variant matching
// its own arch (no size doubling — DEC-30). This resolver is the ONE source of
// truth shared by the build helper (`build_helper/sandbox_rootfs.rs`) and the
// runtime; kept dependency-free so `build.rs` can `#[path]`-include it. Pure +
// lib-tested (TEST-72) — build-script `#[cfg(test)]` modules never run under
// `cargo test`, so the assertions live here where they execute.

/// The one CPU arch v1 actually BUILDS + SHIPS a rootfs for. The aarch64 path is
/// wired below but produces an artifact only once an arm/CI runner exists to
/// build+verify it natively (DEC-30: no arm host here).
///
/// S8: this doc used to justify itself with one named third-party tool's build
/// targets ("… has no arm64 build regardless"). Whether a given tool ships an arm
/// build is that TOOL's business, declared per analysis in a manifest `arch:` list —
/// it is not this project's rootfs policy. The reason this const exists is the
/// build+verify host, and only that.
pub const V1_SHIPPED_ARCH: &str = "x86_64";

/// Everything the docker build needs to produce the rootfs for a given target
/// arch. Selected from `CARGO_CFG_TARGET_ARCH` at build time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RootfsArchVariant {
    /// The `CARGO_CFG_TARGET_ARCH` value this variant serves (`x86_64`/`aarch64`).
    pub cargo_arch: &'static str,
    /// micromamba's per-arch download path segment
    /// (`https://micro.mamba.pm/api/micromamba/<selector>/latest`).
    pub micromamba_selector: &'static str,
    /// The container build platform (`docker build --platform <…>`).
    pub docker_platform: &'static str,
    /// The Rust target triple this arch compiles to (distinct per arch — the
    /// embedded variant is keyed to the binary's triple).
    pub target_triple: &'static str,
}

/// Resolve the rootfs build parameters for a `CARGO_CFG_TARGET_ARCH` value.
/// `None` for an arch with no rootfs recipe (the build then stages a stub).
pub fn arch_variant(cargo_arch: &str) -> Option<RootfsArchVariant> {
    match cargo_arch {
        "x86_64" => Some(RootfsArchVariant {
            cargo_arch: "x86_64",
            micromamba_selector: "linux-64",
            docker_platform: "linux/amd64",
            target_triple: "x86_64-unknown-linux-gnu",
        }),
        "aarch64" => Some(RootfsArchVariant {
            cargo_arch: "aarch64",
            micromamba_selector: "linux-aarch64",
            docker_platform: "linux/arm64",
            target_triple: "aarch64-unknown-linux-gnu",
        }),
        _ => None,
    }
}

/// Whether v1 actually builds + ships a rootfs artifact for this arch. Only
/// `x86_64` today; other (recipe-having) arches are WIRED but stubbed until an
/// arm/CI runner produces + verifies them (DEC-30).
pub fn is_shipped_in_v1(cargo_arch: &str) -> bool {
    cargo_arch == V1_SHIPPED_ARCH
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-1: build-embed freshness + stub logic (pure half).
    #[test]
    fn version_is_schema_plus_dockerfile_hash() {
        let v1 = format_version(1, b"FROM debian");
        let v2 = format_version(1, b"FROM debian:bookworm");
        let v1_again = format_version(1, b"FROM debian");
        assert!(v1.starts_with("schema=1 dockerfile="));
        assert_eq!(v1, v1_again, "same inputs -> same version");
        assert_ne!(v1, v2, "a Dockerfile change must change the version");
        assert_ne!(
            format_version(1, b"x"),
            format_version(2, b"x"),
            "a schema bump must change the version"
        );
    }

    // TEST-21: the schema is at v5 (no-conda uv rootfs, OCI fetch-newest) + the
    // lockstep guard — a schema bump changes the version string. The v4→v5 bump
    // is the conda→uv rebuild delivered via the OCI registry (embedding removed).
    #[test]
    fn schema_is_v5_and_bump_changes_version() {
        assert_eq!(
            ROOTFS_SCHEMA_VERSION, 5,
            "no-conda uv scientific rootfs (OCI fetch-newest) is schema v5"
        );
        let same_df = b"FROM debian";
        assert_ne!(
            format_version(3, same_df),
            format_version(4, same_df),
            "a schema bump must change the version even with the same Dockerfile"
        );
        // The current schema's version string is well-formed.
        assert!(format_version(ROOTFS_SCHEMA_VERSION, same_df).starts_with("schema=5 "));
    }

    /// TEST-15 [acceptance] [invariant: INV-6] [covers: ITEM-2] — a PACKAGE change does
    /// not bump the schema version, and the recipe agrees with the constant.
    ///
    /// #80 added libraries to the environment and moved every version to an exact pin.
    /// Neither is a LAYOUT change: the interpreter prefix, the sandbox PATH, every bind
    /// and this marker are byte-identical, so there is nothing for a fence to fence. The
    /// argument in this file's header against bumping is STRONGER while the publish
    /// workflow is disabled, not weaker — a bump re-points every deployment at a tag that
    /// does not exist until someone publishes under it, and with no automated publish that
    /// window lasts until a human notices.
    ///
    /// The second half is what makes this more than restating a constant: the recipe
    /// carries its own default for the same value, and a silent divergence there would
    /// publish an image whose in-image marker disagrees with what the runtime probes for.
    #[test]
    fn a_package_change_does_not_bump_the_schema_and_the_recipe_agrees() {
        assert_eq!(
            ROOTFS_SCHEMA_VERSION, 5,
            "adding libraries and pinning versions is a PACKAGE change inside the venv, \
             not a layout change — see this module's header on why bumping would be \
             actively harmful"
        );
        // The env id is DATA: discovered off the recipe tree with the SAME function the
        // build and the runtime use, never spelled here. Checking EVERY recipe also means
        // a second environment cannot be added with a stale marker nobody noticed.
        let env_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../env-rootfs");
        let recipes = discover_env_recipes(&env_root);
        assert!(!recipes.is_empty(), "no env recipe discovered under {}", env_root.display());
        for id in &recipes {
            let recipe = env_root.join(id).join(ENV_RECIPE_FILE);
            let text = std::fs::read_to_string(&recipe)
                .unwrap_or_else(|e| panic!("cannot read {}: {e}", recipe.display()));
            assert!(
                text.contains(&format!("ARG ROOTFS_SCHEMA_VERSION={ROOTFS_SCHEMA_VERSION}")),
                "recipe `{id}`'s default schema arg must equal ROOTFS_SCHEMA_VERSION ({}), \
                 or a published image's marker disagrees with what the runtime mount probe \
                 expects",
                ROOTFS_SCHEMA_VERSION
            );
        }
    }

    /// **TEST-E3-1** [acceptance] [invariant: INV-1] [covers: ITEM-1] (#191) — adding a
    /// SECOND env recipe does not move the schema version.
    ///
    /// The sibling assertion above (`a_package_change_does_not_bump_…`) already walks
    /// every discovered recipe, and that derived walk is exactly why the new recipe is
    /// covered with no edit to it. What it CANNOT do is notice that its own subject
    /// collapsed: its floor is `!recipes.is_empty()`, which stayed true while the tree
    /// held one recipe and would stay true if the walk silently found only the first of
    /// two. So this test carries the floor the tree now supports — at least TWO recipes —
    /// and re-asserts the marker property over all of them.
    ///
    /// A second IMAGE is not a layout change to the first. `/opt`, `/usr`, the sandbox
    /// PATH, every bind and the marker path are what this constant fences, and none of
    /// them moves. Bumping would re-point every deployment at a tag that does not exist
    /// until someone publishes under it, and the publish workflow is disabled — so the
    /// window lasts until a human notices.
    #[test]
    fn a_second_env_recipe_does_not_move_the_schema_version() {
        assert_eq!(
            ROOTFS_SCHEMA_VERSION, 5,
            "adding a SECOND env image is not a layout change to the first — see this \
             module's header on why bumping would be actively harmful"
        );
        let env_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../env-rootfs");
        let recipes = discover_env_recipes(&env_root);
        assert!(
            recipes.len() >= 2,
            "expected at least two recipes under {}, found {recipes:?} — if one was \
             deliberately removed, lower this floor in the same commit and say why; a \
             floor that silently outlives its subject is how a derived guard goes vacuous",
            env_root.display()
        );
        for id in &recipes {
            let recipe = env_root.join(id).join(ENV_RECIPE_FILE);
            let text = std::fs::read_to_string(&recipe)
                .unwrap_or_else(|e| panic!("cannot read {}: {e}", recipe.display()));
            assert!(
                text.contains(&format!("ARG ROOTFS_SCHEMA_VERSION={ROOTFS_SCHEMA_VERSION}")),
                "recipe `{id}`'s default schema arg must equal ROOTFS_SCHEMA_VERSION ({}), \
                 or the published image's marker disagrees with what the runtime mount \
                 probe expects and the mount is refused",
                ROOTFS_SCHEMA_VERSION
            );
            // …and NO recipe may carry a DIFFERENT schema arg alongside the right one,
            // which a copy-paste from a future bump would produce and the `contains`
            // check above would happily ignore.
            for line in text.lines().filter(|l| l.trim_start().starts_with("ARG ROOTFS_SCHEMA_VERSION")) {
                assert!(
                    line.contains(&format!("={ROOTFS_SCHEMA_VERSION}")),
                    "recipe `{id}` declares a second, disagreeing schema arg: {line}"
                );
            }
        }
    }

    // TEST-72: the rootfs build parameterizes over the target arch — x86_64 maps
    // to micromamba `linux-64`, aarch64 to `linux-aarch64`, each with a DISTINCT
    // target triple; the resolver keys the embedded variant to
    // `CARGO_CFG_TARGET_ARCH`; and v1 ships only the x86_64 variant.
    #[test]
    fn arch_variant_parameterizes_x86_and_aarch64() {
        let x = arch_variant("x86_64").expect("x86_64 has a rootfs recipe");
        assert_eq!(x.micromamba_selector, "linux-64", "x86_64 → micromamba linux-64");
        assert_eq!(x.docker_platform, "linux/amd64");
        assert_eq!(x.target_triple, "x86_64-unknown-linux-gnu");

        let a = arch_variant("aarch64").expect("aarch64 path is wired");
        assert_eq!(a.micromamba_selector, "linux-aarch64", "aarch64 → micromamba linux-aarch64");
        assert_eq!(a.docker_platform, "linux/arm64");
        assert_eq!(a.target_triple, "aarch64-unknown-linux-gnu");

        // Distinct triples (single-arch-per-binary embed).
        assert_ne!(x.target_triple, a.target_triple, "each arch has its own triple");
        assert_ne!(x.micromamba_selector, a.micromamba_selector);

        // An unknown arch has no recipe → the build stages a stub.
        assert!(arch_variant("riscv64").is_none(), "unknown arch → no recipe");

        // v1 builds + ships only x86_64; aarch64 is wired-but-not-produced.
        assert!(is_shipped_in_v1("x86_64"), "x86_64 is the v1 shipped variant");
        assert!(!is_shipped_in_v1("aarch64"), "aarch64 wired but not produced in v1");
        assert_eq!(V1_SHIPPED_ARCH, "x86_64");
    }

    // TEST (blind-audit LOW, S8-generalized): an operator-supplied build-arg URL's
    // freshness tag tracks the URL VALUE, not merely set/unset — rotating it to a
    // DIFFERENT build changes the tag (forces a re-stage), while an unset/blank URL
    // is `no<key>` and a stable URL yields a stable tag. Nothing here knows what the
    // tool IS; `key` is the caller's.
    #[test]
    fn build_arg_tag_tracks_url_value_not_just_presence() {
        assert_eq!(build_arg_freshness_tag("aligner", None), "noaligner");
        assert_eq!(build_arg_freshness_tag("aligner", Some("")), "noaligner");
        assert_eq!(build_arg_freshness_tag("aligner", Some("   ")), "noaligner", "blank ⇒ no<key>");

        let a =
            build_arg_freshness_tag("aligner", Some("https://x.example/tool-8.0.0.tar.gz?sig=aaa"));
        let b =
            build_arg_freshness_tag("aligner", Some("https://x.example/tool-9.0.0.tar.gz?sig=bbb"));
        assert!(a.starts_with("aligner="), "a set URL yields a <key>=<hash> tag");
        assert_ne!(a, "noaligner", "a set URL is distinct from unset");
        assert_ne!(a, b, "a different build (URL) must change the freshness tag");
        // Stable for the same URL (deterministic — no needless rebuild).
        assert_eq!(
            a,
            build_arg_freshness_tag("aligner", Some("https://x.example/tool-8.0.0.tar.gz?sig=aaa")),
            "same URL ⇒ same tag"
        );
        // Leading/trailing whitespace is normalized (env values often carry it).
        assert_eq!(
            a,
            build_arg_freshness_tag(
                "aligner",
                Some("  https://x.example/tool-8.0.0.tar.gz?sig=aaa  ")
            )
        );
        // A DIFFERENT key is a different namespace — two operator-supplied tools can
        // coexist without one's rotation masking the other's.
        let same_url = Some("https://x.example/tool-8.0.0.tar.gz?sig=aaa");
        assert_ne!(a, build_arg_freshness_tag("packer", same_url));
        assert_eq!(build_arg_freshness_tag("packer", None), "nopacker");
    }

    // W2/S8: the operator-supplied build-arg table is DECLARED BY THE RECIPE and
    // parsed out of it — the app names no tool. Every `ARG <NAME>_URL` becomes a
    // `(key, TXR_<NAME>, <NAME>)` pass-through entry; nothing else does.
    #[test]
    fn build_arg_url_vars_are_parsed_from_the_recipe() {
        let recipe = br#"
FROM debian:bookworm-slim AS base
ARG ROOTFS_SCHEMA_VERSION=5
ARG TARGETARCH=amd64
ARG ALIGNER_URL=""
  ARG  BASECALLER_URL
ARGUMENT_URL=nope
ARG PLAIN_FLAG=x
RUN echo "$ALIGNER_URL"
FROM base AS packer
ARG ALIGNER_URL=""
"#;
        let vars = build_arg_url_vars(recipe);
        let names: Vec<&str> = vars.iter().map(|v| v.build_arg.as_str()).collect();
        assert_eq!(
            names,
            vec!["ALIGNER_URL", "BASECALLER_URL"],
            "only `ARG <NAME>_URL` declarations, de-duplicated across stages, in \
             declaration order — `ARGUMENT_URL=` is not an ARG instruction"
        );
        assert_eq!(vars[0].key, "aligner", "the freshness key is the lowercased stem");
        assert_eq!(vars[0].env, "TXR_ALIGNER_URL", "the env var is app-namespaced");
        assert_eq!(vars[1].key, "basecaller");

        // A recipe declaring no URL args yields an empty table (no implicit tool).
        assert!(build_arg_url_vars(b"FROM scratch\nARG TARGETARCH=amd64\n").is_empty());

        // Adding a tool is a RECIPE edit with zero server-source change.
        let widened = build_arg_url_vars(b"FROM scratch\nARG ALIGNER_URL=\"\"\nARG NEWTOOL_URL\n");
        assert_eq!(widened.len(), 2, "a new recipe ARG appears with no code edit");
        assert_eq!(widened[1].env, "TXR_NEWTOOL_URL");

        // No duplicate keys (a collision would make one tool's rotation invisible
        // in the cache key).
        let mut keys: Vec<&str> = widened.iter().map(|v| v.key.as_str()).collect();
        let n = keys.len();
        keys.sort_unstable();
        keys.dedup();
        assert_eq!(keys.len(), n, "duplicate freshness key");
    }

    // W2: which env recipe the build targets is an INPUT, not a hardcoded path.
    #[test]
    fn env_recipe_selection_is_an_input_with_a_sole_recipe_default() {
        let one = vec!["alpha".to_string()];
        let many = vec!["alpha".to_string(), "beta".to_string()];

        // Default with ONE recipe ⇒ that recipe (the no-behavior-change case: a
        // one-recipe tree resolves exactly as the old hardcoded path did, and needs
        // no declaration to state the obvious).
        assert_eq!(select_env_recipe(&one, None, None), Some("alpha".to_string()));
        // Blank/whitespace override is treated as unset.
        assert_eq!(select_env_recipe(&one, Some(""), None), Some("alpha".to_string()));
        assert_eq!(select_env_recipe(&one, Some("  "), None), Some("alpha".to_string()));

        // An override selects a DIFFERENT recipe.
        assert_eq!(select_env_recipe(&many, Some("beta"), None), Some("beta".to_string()));

        // An override naming an absent recipe resolves to nothing — the build
        // stubs loudly instead of silently building some other env.
        assert_eq!(select_env_recipe(&many, Some("gamma"), None), None);
        // An empty tree has nothing to select.
        assert_eq!(select_env_recipe(&[], None, None), None);
        assert_eq!(select_env_recipe(&[], Some("alpha"), None), None);
    }

    /// TEST-E3-4 [covers: ITEM-9] — with several recipes the default is DECLARED, and
    /// a recipe that sorts FIRST does not become the default by winning an alphabet.
    ///
    /// This assertion used to read the other way: `select_env_recipe(&many, None)` was
    /// `Some("alpha")`, the first SORTED id, and the caller merely warned. That was
    /// defensible while the tree held one recipe and indefensible the moment it held
    /// two — what the sort order silently selects is what
    /// `scripts/publish-env-rootfs.sh` pushes under the moving `schema<N>-latest-<arch>`
    /// tag that every running deployment resolves. `single-cell` sorting before
    /// `single-cell-r` would have kept the old default correct BY COINCIDENCE, which is
    /// the most dangerous form of correct: a later recipe named `bioc-*` inherits the
    /// coincidence and re-points the fleet. So the ambiguous case refuses, exactly as
    /// the publish script already refuses and names its candidates.
    #[test]
    fn a_several_recipe_tree_takes_its_declared_default_not_the_first_sorted_id() {
        let many = vec!["alpha".to_string(), "beta".to_string()];

        // AMBIGUOUS + no declaration ⇒ refuse. Not `alpha`.
        assert_eq!(
            select_env_recipe(&many, None, None),
            None,
            "several recipes with no declared default must refuse, not pick a winner \
             out of the alphabet"
        );
        // The DECLARED default wins — including when it is NOT the first sorted id,
        // which is the case the sort-order rule could never express.
        assert_eq!(
            select_env_recipe(&many, None, Some("beta")),
            Some("beta".to_string()),
            "the declared default is selected even though `alpha` sorts first"
        );
        assert_eq!(select_env_recipe(&many, None, Some("alpha")), Some("alpha".to_string()));
        // A recipe added LATER that sorts FIRST does not displace the declaration.
        let with_earlier = vec!["aaa".to_string(), "alpha".to_string(), "beta".to_string()];
        assert_eq!(
            select_env_recipe(&with_earlier, None, Some("beta")),
            Some("beta".to_string()),
            "adding a recipe that sorts first must not re-point the declared default"
        );
        // A declaration naming an ABSENT recipe is an error, never a fall-through to
        // some other env: building/publishing a different environment than the tree
        // says it builds is not a recoverable mistake.
        assert_eq!(
            select_env_recipe(&many, None, Some("gamma")),
            None,
            "a stale declaration must refuse, not fall through to the first sorted id"
        );
        // The operator override still outranks the declaration.
        assert_eq!(
            select_env_recipe(&many, Some("alpha"), Some("beta")),
            Some("alpha".to_string()),
            "TXR_ENV_ROOTFS_ID is the operator's escape hatch and outranks the tree"
        );
        // Blank declaration is treated as unset (and then the tree is ambiguous).
        assert_eq!(select_env_recipe(&many, None, Some("   ")), None);
    }

    /// **TEST-E3-14** [covers: ITEM-9] — the declaration is READ OFF THE TREE, and the whole
    /// resolution (`select_env_recipe_in`) is proven on a real filesystem: a comment-only
    /// file declares nothing, the first non-comment line is the declaration, and a tree
    /// with two recipes and no declaration refuses.
    #[test]
    fn declared_default_is_read_off_the_tree_and_drives_selection() {
        let tmp = std::env::temp_dir().join(format!(
            "txr-envdefault-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        for id in ["alpha", "beta"] {
            std::fs::create_dir_all(tmp.join(id)).unwrap();
            std::fs::write(tmp.join(id).join(ENV_RECIPE_FILE), b"FROM scratch\n").unwrap();
        }

        // No declaration file at all.
        assert_eq!(declared_default_recipe(&tmp), None);
        assert_eq!(
            select_env_recipe_in(&tmp, None),
            None,
            "two recipes, nothing declared ⇒ refuse"
        );

        // A comment-only declaration declares nothing.
        std::fs::write(tmp.join(ENV_DEFAULT_FILE), b"# why we chose it\n\n").unwrap();
        assert_eq!(declared_default_recipe(&tmp), None);
        assert_eq!(select_env_recipe_in(&tmp, None), None);

        // The first non-blank, non-comment line IS the declaration.
        std::fs::write(tmp.join(ENV_DEFAULT_FILE), b"# rationale\n\n  beta  \nalpha\n").unwrap();
        assert_eq!(declared_default_recipe(&tmp), Some("beta".to_string()));
        assert_eq!(select_env_recipe_in(&tmp, None), Some("beta".to_string()));
        // …and the override still wins over it.
        assert_eq!(select_env_recipe_in(&tmp, Some("alpha")), Some("alpha".to_string()));

        // A UTF-8 BOM MUST NOT CHANGE THE READING. `trim()` is Unicode White_Space and
        // U+FEFF is not in it, so before the explicit strip the BOM stayed glued to the
        // first character: the leading COMMENT line stopped matching `starts_with('#')`
        // and the whole comment was returned as the declared env-id, which matches no
        // recipe — so `select_env_recipe_in` refused and the build staged a STUB rootfs,
        // silently, because of an editor setting. A Windows editor writes this by default,
        // which is exactly why it is a test and not a comment.
        std::fs::write(
            tmp.join(ENV_DEFAULT_FILE),
            "\u{feff}# rationale\n\n  beta  \nalpha\n".as_bytes(),
        )
        .unwrap();
        assert_eq!(
            declared_default_recipe(&tmp),
            Some("beta".to_string()),
            "a UTF-8 BOM must not turn the leading comment into the declaration"
        );
        assert_eq!(select_env_recipe_in(&tmp, None), Some("beta".to_string()));
        // …including when the BOM sits directly on the declaration itself (no comment).
        std::fs::write(tmp.join(ENV_DEFAULT_FILE), "\u{feff}beta\n".as_bytes()).unwrap();
        assert_eq!(declared_default_recipe(&tmp), Some("beta".to_string()));

        std::fs::write(tmp.join(ENV_DEFAULT_FILE), b"# rationale\n\n  beta  \nalpha\n").unwrap();

        // The declaration file is NOT a recipe (it has no Dockerfile), so discovery
        // ignores it by construction.
        assert_eq!(
            discover_env_recipes(&tmp),
            vec!["alpha".to_string(), "beta".to_string()],
            "the declaration file must not be mistaken for a recipe"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// **TEST-E3-14** [covers: ITEM-9] — the SHIPPED tree declares a default, that default is
    /// a real recipe in it, and resolution over the real tree yields it.
    ///
    /// Asserted WITHOUT naming any env-id: the expected value is read from the tree's own
    /// declaration, so this survives renaming or adding a domain — and it FAILS if the
    /// declaration is deleted or goes stale, which is the regression it exists to catch
    /// now that the tree holds more than one recipe.
    #[test]
    fn the_shipped_tree_declares_its_default_and_it_resolves() {
        let env_root =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("env-rootfs");
        let ids = discover_env_recipes(&env_root);
        assert!(
            ids.len() >= 2,
            "this assertion is only meaningful once the tree is ambiguous; found {ids:?}"
        );
        let declared = declared_default_recipe(&env_root).unwrap_or_else(|| {
            panic!(
                "the shipped tree holds {} recipes and must DECLARE its default in {}/{}",
                ids.len(),
                env_root.display(),
                ENV_DEFAULT_FILE
            )
        });
        assert!(
            ids.contains(&declared),
            "the declared default {declared:?} is not one of the discovered recipes {ids:?}"
        );
        assert_eq!(select_env_recipe_in(&env_root, None), Some(declared.clone()));
        // Every other recipe is reachable by override.
        for id in ids.iter().filter(|i| **i != declared) {
            assert_eq!(select_env_recipe_in(&env_root, Some(id)), Some(id.clone()));
        }
        // THE DISCRIMINATING LEG, and the reason the loop above lost its `assert_ne!`.
        //
        // On today's tree the declared default HAPPENS to be the first sorted id, so
        // "no other recipe is picked by default" is true under the old `available.first()`
        // rule as well — a blind mutation reverted the whole declared-default mechanism
        // and this test stayed green. That is precisely the coincidence `DEFAULT_ENV`'s
        // own header warns about, reappearing in the test written to retire it.
        //
        // What IS falsifiable on the real tree: without a declaration, a tree holding more
        // than one recipe must REFUSE rather than hand back a winner. That fails the
        // moment the ambiguous arm goes back to `first()`, whatever the ids sort to.
        assert_eq!(
            select_env_recipe(&ids, None, None),
            None,
            "the shipped tree holds {} recipes; with no declaration it must refuse rather \
             than pick one out of the alphabet — otherwise the declaration is decorative \
             and deleting it silently restores sort-order luck",
            ids.len()
        );
    }

    // W2: the SHIPPED recipe tree is discoverable as data, and the default
    // selection resolves to a real recipe in it — asserted WITHOUT naming any
    // env-id, so the assertion survives adding/renaming a domain.
    #[test]
    fn shipped_recipe_tree_is_discovered_and_defaults_to_a_real_recipe() {
        let env_root =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("env-rootfs");
        let ids = discover_env_recipes(&env_root);
        assert!(!ids.is_empty(), "the shipped tree has ≥1 env recipe at {}", env_root.display());
        let selected =
            select_env_recipe_in(&env_root, None).expect("a non-empty tree selects a recipe");
        assert!(ids.contains(&selected));
        assert!(
            env_root.join(&selected).join(ENV_RECIPE_FILE).is_file(),
            "the selected recipe's {ENV_RECIPE_FILE} exists"
        );
        // Its declared build-args parse (may legitimately be empty).
        let bytes = std::fs::read(env_root.join(&selected).join(ENV_RECIPE_FILE)).unwrap();
        for v in build_arg_url_vars(&bytes) {
            assert!(v.env.starts_with("TXR_"), "app-namespaced: {}", v.env);
            assert!(v.build_arg.ends_with("_URL"));
        }
        // Discovery is sorted ⇒ deterministic default.
        let mut sorted = ids.clone();
        sorted.sort();
        assert_eq!(ids, sorted);
    }

    // W2: fs-level proof of the indirection on a REAL tree — discovery finds only
    // dirs that actually hold a recipe, the default resolves to the sole one, and
    // adding a second recipe + an override selects the OTHER one. This is the whole
    // body of the build helper's `resolve_recipe` minus its env-var read.
    #[test]
    fn discovery_plus_override_selects_a_different_recipe_on_a_real_tree() {
        let tmp = std::env::temp_dir()
            .join(format!("txr-envrootfs-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("alpha")).unwrap();
        std::fs::write(tmp.join("alpha").join(ENV_RECIPE_FILE), b"FROM scratch\n").unwrap();
        // A stray dir with no recipe file, and a stray FILE, are both ignored.
        std::fs::create_dir_all(tmp.join("notarecipe")).unwrap();
        std::fs::write(tmp.join("README.md"), b"x").unwrap();

        let ids = discover_env_recipes(&tmp);
        assert_eq!(ids, vec!["alpha".to_string()], "only dirs holding a {ENV_RECIPE_FILE} count");
        assert_eq!(
            select_env_recipe_in(&tmp, None),
            Some("alpha".to_string()),
            "a sole-recipe tree resolves to it with no override — the default is unchanged"
        );

        // Add a SECOND env. The tree is now AMBIGUOUS: with no declaration it refuses
        // (#191 — it used to hand back the first sorted id), a declaration selects, and
        // the override still switches.
        std::fs::create_dir_all(tmp.join("beta")).unwrap();
        std::fs::write(tmp.join("beta").join(ENV_RECIPE_FILE), b"FROM scratch\n").unwrap();
        let ids = discover_env_recipes(&tmp);
        assert_eq!(ids, vec!["alpha".to_string(), "beta".to_string()]);
        assert_eq!(select_env_recipe_in(&tmp, None), None, "ambiguous + undeclared ⇒ refuse");
        std::fs::write(tmp.join(ENV_DEFAULT_FILE), b"alpha\n").unwrap();
        assert_eq!(select_env_recipe_in(&tmp, None), Some("alpha".to_string()));
        assert_eq!(
            select_env_recipe_in(&tmp, Some("beta")),
            Some("beta".to_string()),
            "{ENV_ROOTFS_ID_VAR} selects a DIFFERENT recipe"
        );
        assert_eq!(select_env_recipe_in(&tmp, Some("gamma")), None, "an absent override stubs");

        // A missing tree discovers nothing (build stubs rather than panicking).
        let _ = std::fs::remove_dir_all(&tmp);
        assert!(discover_env_recipes(&tmp).is_empty());
    }

    #[test]
    fn is_fresh_requires_nonempty_and_matching_version() {
        let want = "schema=1 dockerfile=abc1234";
        // Missing/empty file -> not fresh (even with a matching version).
        assert!(!is_fresh(0, Some(want), want));
        // Non-empty but version mismatch -> not fresh (re-stage on Dockerfile bump).
        assert!(!is_fresh(1_000_000, Some("schema=2 dockerfile=zzz"), want));
        // Non-empty but no recorded version (stub sentinel) -> not fresh.
        assert!(!is_fresh(1_000_000, Some("stub"), want));
        assert!(!is_fresh(1_000_000, None, want));
        // Non-empty + matching version -> fresh (skip docker build).
        assert!(is_fresh(1_000_000, Some(want), want));
        // Trailing newline in the recorded version is tolerated.
        assert!(is_fresh(1_000_000, Some(&format!("{want}\n")), want));
    }
}
