//! Driver-selected migration-source composition (ITEM-6, DEC-2/DEC-9).
//!
//! `migrations-merged/` feeds TWO consumers from ONE composition: the
//! build-DB provisioner (which migrates the sqlx verification DB before the
//! `query!` macros verify) and the runtime `sqlx::migrate!` (which embeds the
//! same dir). The driver is therefore selected at BUILD time by the
//! `DATABASE_URL` scheme — the SAME dispatch rule the SDK's build-DB
//! provisioner uses (`ziee_build_support::build_db`'s `BuildDbLeg` table), so
//! compose and provision can never select different drivers.
//!
//! * **postgres** (the operator-override / unset leg) — the module-owned
//!   chains: `src/modules/<m>/migrations/` (globbed by the composer) plus the
//!   three schema-bound SDK crates' `migrations/` dirs, passed explicitly.
//! * **sqlite** (the committed-sentinel leg since the ITEM-12 flip) — the
//!   ported chain, staged OUTSIDE the module dirs while the two chains coexist
//!   (DEC-9): `src-app/server/migrations-sqlite/<module>/` plus
//!   `sdk/crates/<c>/migrations-sqlite/`. The staging dirs are passed
//!   EXPLICITLY (enumerated — a port item adds its module dir with no
//!   `build.rs` edit; the composer silently skips a dir that does not exist).
//!
//! The two chains are NEVER composed together: they carry the SAME file names
//! (DEC-2 keeps the numbering), so the composer's basename-collision guard
//! would panic on the first duplicate, and a merged dir holding both would
//! double-apply at boot. The merged dir holds exactly one chain; switching
//! drivers switches its content in one build. ITEM-26 collapses the selection
//! by renaming the staged files into the module dirs and deleting this
//! branch.

use std::path::{Path, PathBuf};

/// SDK crates whose migrations the app composes (schema-bound path-deps) —
/// the same three in the postgres leg and their `migrations-sqlite` twins.
const SDK_MIGRATION_CRATES: &[&str] = &["ziee-auth", "ziee-file", "ziee-notification"];

/// Which driver's migration chain the merged dir is composed from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MigrationChain {
    Postgres,
    Sqlite,
}

/// The dispatch rule — the app-side twin of the SDK's `BuildDbLeg` table: the
/// committed `sqlite:` `DATABASE_URL` sentinel (or an operator `sqlite:`
/// override) selects the ported chain; unset or postgres selects the
/// module-owned chains (the legacy/operator-override state). Anything else
/// falls to Postgres, mirroring the SDK leg's `_ => Postgres` arm.
pub fn for_build_db_url(database_url: Option<&str>) -> MigrationChain {
    match database_url {
        Some(url) if ziee_build_support::worktree_db::is_sqlite_url(url) => MigrationChain::Sqlite,
        _ => MigrationChain::Postgres,
    }
}

impl MigrationChain {
    /// The chain the current `build.rs` invocation must compose, read from the
    /// `DATABASE_URL` cargo gives every build-script subprocess (`.cargo/
    /// config.toml [env]` or an operator override).
    pub fn from_env() -> MigrationChain {
        match std::env::var("DATABASE_URL") {
            Ok(url) => for_build_db_url(Some(&url)),
            Err(_) => for_build_db_url(None),
        }
    }

    /// The composer's two source lists for this driver:
    /// `(app_module_roots, explicit_dirs)`.
    ///
    /// `app_module_roots` are GLOBBED by the composer for `*/migrations`; the
    /// sqlite chain never uses them — the staged files are a flat name mirror
    /// OUTSIDE `src/modules/` (a glob would find nothing, and reading the
    /// module dirs again would re-enter the merge-gate C2 scan root while the
    /// two chains coexist, DEC-9). `explicit_dirs` are passed verbatim.
    pub fn compose_args(&self, manifest: &Path) -> (Vec<PathBuf>, Vec<PathBuf>) {
        match self {
            MigrationChain::Postgres => (
                vec![manifest.join("src/modules")],
                SDK_MIGRATION_CRATES
                    .iter()
                    .map(|c| sdk_crate_migrations(manifest, c, "migrations"))
                    .collect(),
            ),
            MigrationChain::Sqlite => {
                let mut explicit = sqlite_module_dirs(manifest);
                explicit.extend(
                    SDK_MIGRATION_CRATES
                        .iter()
                        .map(|c| sdk_crate_migrations(manifest, c, "migrations-sqlite")),
                );
                (Vec::new(), explicit)
            }
        }
    }

    /// Paths the build script must watch IN ADDITION to what the composer
    /// emits itself (each source dir it actually used + the merged dir):
    /// merge sources that do not exist yet, or whose existence is not a
    /// source dir handed to the composer.
    ///
    /// - the sqlite staging ROOT (`migrations-sqlite/`): a port item ADDS a
    ///   module subdir, and cargo watches only paths we name — a new subdir
    ///   changes the root's own directory mtime, so the root must be watched
    ///   for the compose to re-fire;
    /// - each per-SDK-crate staging dir: absent until the port lands, and
    ///   cargo re-runs a build script when a watched missing path appears.
    ///
    /// The postgres leg keeps its historical equivalent (the three SDK
    /// `migrations` dirs were watched explicitly before this helper existed),
    /// so a compose that loses a source is still caught.
    pub fn watch_paths(&self, manifest: &Path) -> Vec<PathBuf> {
        match self {
            MigrationChain::Postgres => SDK_MIGRATION_CRATES
                .iter()
                .map(|c| sdk_crate_migrations(manifest, c, "migrations"))
                .collect(),
            MigrationChain::Sqlite => {
                let mut paths = vec![manifest.join("migrations-sqlite")];
                paths.extend(
                    SDK_MIGRATION_CRATES
                        .iter()
                        .map(|c| sdk_crate_migrations(manifest, c, "migrations-sqlite")),
                );
                paths
            }
        }
    }

    /// Human-readable name for build logs.
    pub fn label(&self) -> &'static str {
        match self {
            MigrationChain::Postgres => "module-owned postgres",
            MigrationChain::Sqlite => "staged migrations-sqlite",
        }
    }
}

/// `<manifest>/../../sdk/crates/<crate>/<chain>` (the manifest is
/// `src-app/server`, so `../..` is the repo root) — the SDK migration dir of a
/// schema-bound crate for one of the two chains. The composer treats an
/// existing dir as a source and silently skips a missing one; the build
/// script's own `watch_paths` covers the missing-dir re-fire.
fn sdk_crate_migrations(manifest: &Path, crate_name: &str, chain: &str) -> PathBuf {
    manifest
        .join("../../sdk")
        .join("crates")
        .join(crate_name)
        .join(chain)
}

/// Every `<manifest>/migrations-sqlite/<module>/` dir present on disk — one
/// per ported module chain (ITEM-7…ITEM-11), resolved so a port item adds its
/// dir with no `build.rs` edit. Deterministic order (the composer sorts its
/// sources anyway; stable enumeration keeps the intent readable).
fn sqlite_module_dirs(manifest: &Path) -> Vec<PathBuf> {
    let staging = manifest.join("migrations-sqlite");
    let mut dirs = Vec::new();
    let Ok(entries) = std::fs::read_dir(&staging) else {
        return dirs; // nothing staged yet — an empty compose is the state
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            dirs.push(path);
        }
    }
    dirs.sort();
    dirs
}
