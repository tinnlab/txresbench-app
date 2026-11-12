//! Blob-store PARTITIONING by catalog identity — the guard that keeps one
//! server instance's GC from freeing another instance's live blobs.
//!
//! ## The defect this exists to make impossible
//!
//! [`super::gc::GcSweeper`] builds its keep-set from ITS OWN database
//! (`all_blob_refs`) and then unlinks every blob in the store that the keep-set
//! does not cover. That is correct exactly as long as the store and the catalog
//! are a matched pair. They were not: the store root is
//! `rootfs::data_root().join("workstore")`, and `data_root()` falls back to the
//! SDK's single `~/.app` whenever `TXR_APP_DATA_DIR` is unset — which is the
//! case for every dev server. Each git worktree, meanwhile, ran its own
//! embedded Postgres cluster, so N worktrees shared ONE blob store while
//! holding N different catalogs, and booting worktree B unlinked every blob
//! referenced only by worktree A. Content-addressing is what makes this silent:
//! the two catalogs legitimately name blobs by the same hashes, so nothing
//! about a foreign blob looks foreign.
//!
//! The SQLite store (ITEM-26) has the same shape with the FILE as the engine's
//! physical identity: worktrees that resolve distinct DB files (`database.path`
//! per worktree, or a per-worktree app-data dir) are distinct catalogs over one
//! shared data root — the identity below is the resolved DB file's absolute
//! path, so the guard keeps doing the PG version's job.
//!
//! ## The rule
//!
//! A blob store belongs to exactly ONE catalog, and only that catalog may sweep
//! it. The binding is a CLAIM FILE (`.catalog-owner`) in the store root holding
//! the owning catalog's key:
//!
//! * claim absent            → claim it, use this root (fresh install, AND the
//!                             in-place adoption of a pre-existing unpartitioned
//!                             store — see "single-root deployments" below);
//! * claim == my key         → use this root (the steady state);
//! * claim == another key    → do not touch it; use `workstore-<mykey>` instead.
//!
//! Nothing is ever moved, renamed or deleted by this module. The worst outcome
//! it can produce is an unswept directory (a space leak); it cannot produce a
//! lost blob. That bias is deliberate for a fix to a data-loss bug.
//!
//! ## Single-root deployments are byte-identical
//!
//! One server, one database, one data root — production and the e2e harness
//! alike — finds an unclaimed default root, claims it, and keeps using
//! `<data_root>/workstore` forever. The path does not change, no data is
//! stranded, and no operator action is required on upgrade. `TXR_APP_DATA_DIR`
//! is honoured exactly as before, because this module only ever partitions
//! BELOW whatever [`crate::modules::rootfs::data_root`] returns.
//!
//! ## Why the key is derived from the CATALOG and not from the worktree path
//!
//! The worktree is a proxy; the catalog is the cause. A cwd-derived key (the
//! shape `build_support::worktree_db` uses for build databases) would give a
//! production server a store keyed on whatever working directory its service
//! manager happened to set — change `WorkingDirectory=` and every artifact
//! silently 404s. It would also split two servers that genuinely share one
//! external database into two stores, dangling half the catalog. Keying on the
//! catalog is stable under both.

use std::path::{Component, Path, PathBuf};

use txresbench_core::{AppError, ServerConfig};

/// The claim file written into a blob-store root, naming the catalog that owns
/// it. One line, no trailing newline: the catalog key.
pub const CLAIM_FILE: &str = ".catalog-owner";

/// The unpartitioned/default store directory name — the path every existing
/// single-root deployment already uses, and the one a fresh catalog adopts.
pub const DEFAULT_DIR: &str = "workstore";

/// A stable, printable identity for the catalog a config binds the server to.
///
/// The engine is SQLite (ITEM-26 — the postgres chain is gone), so the
/// catalog's physical identity is the DB FILE: the resolved `database:`
/// target (`TXR_DATABASE_URL` > `database.url` > `database.path` >
/// `<app-data-dir>/txresbench.db`), canonicalized exactly the way the runtime
/// opens it. The property the blob-store guard needs is the one the old
/// PGDATA identity had: two worktrees both copy `dev.example.yaml`, so the
/// CONFIG does not discriminate them — but their DB files do when the config
/// or the per-worktree app-data dir does, which is what makes two catalogs
/// distinct; two configs resolving the SAME file genuinely share one catalog
/// and SHOULD share one store (the single-root deployment, unchanged).
pub fn catalog_identity(config: &ServerConfig) -> String {
    let target =
        crate::config::resolve_database_target(config, &crate::modules::rootfs::data_root());
    let file = if target.starts_with("sqlite:") {
        // Resolve the URL form through the framework's own parser so the
        // identity can never disagree with the file the runtime actually opens
        // (it is the caller's already-validated target — a parse failure here
        // is the boot failure, just earlier).
        txresbench_framework::embedded_db::connect_options(
            &target,
            &txresbench_core::config::DatabasePoolConfig::default(),
        )
        .expect("resolved database target must be a valid sqlite URL")
        .get_filename()
        .to_path_buf()
    } else {
        PathBuf::from(&target)
    };
    format!("sqlite:{}", lexical_absolute(&file).display())
}

/// The catalog's 8-hex partition key.
pub fn catalog_key(config: &ServerConfig) -> String {
    stable_key(&catalog_identity(config))
}

/// Hash an identity with the SDK's ONE stable FNV-1a derivation
/// (`build_support::worktree_db`), rather than growing a second one.
///
/// That helper is spelled for worktree ROOTS: it first strips everything from a
/// literal `/src-app` (or `\src-app`) onward, so any two identities that differ
/// only *below* such a component would collide — and a collision here is the
/// very bug this module exists to prevent, not a cosmetic issue. The identity is
/// therefore separator-encoded before hashing, which makes that prefix
/// unrepresentable and `worktree_root` the identity function on the input. The
/// FNV itself — the part worth sharing — is reused unchanged.
fn stable_key(identity: &str) -> String {
    txresbench_framework::build_support::worktree_db::worktree_key(&encode_identity(identity))
}

/// Replace every path separator so the encoded form can contain no `/src-app`
/// or `\src-app` component. Injective over identities (`|` and `\` are
/// themselves escaped), so distinct identities stay distinct.
fn encode_identity(identity: &str) -> String {
    let mut out = String::with_capacity(identity.len() + 8);
    for c in identity.chars() {
        match c {
            '~' => out.push_str("~~"),
            '/' => out.push_str("~s"),
            '\\' => out.push_str("~b"),
            other => out.push(other),
        }
    }
    out
}

/// Absolutize + normalize `.`/`..` LEXICALLY (never `canonicalize`, which
/// requires the path to exist — on a first boot the DB file does not yet).
/// A relative path is joined onto the process cwd, which is exactly how
/// `embedded_db` will resolve it, so the key names the file the server will
/// actually open.
fn lexical_absolute(input: &Path) -> PathBuf {
    let raw = input.to_path_buf();
    let joined = if raw.is_absolute() {
        raw
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(raw)
    };
    let mut out = PathBuf::new();
    for c in joined.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                // Only pop a real name; `/..` stays at the root.
                if out
                    .components()
                    .next_back()
                    .is_some_and(|c| matches!(c, Component::Normal(_)))
                {
                    out.pop();
                } else {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// A blob-store root together with the catalog key that owns it. Holding one is
/// the evidence a sweep needs before it may unlink anything.
///
/// The fields are PRIVATE and there is no public constructor: the only ways to
/// obtain one are [`resolve_owned_root`] (which establishes the claim on disk)
/// and [`StoreClaim::adopt_existing`] (which reads one that is already there).
/// A caller therefore cannot assert ownership it does not have — which is the
/// difference between a type-level invariant and a comment asking nicely.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreClaim {
    root: PathBuf,
    key: String,
}

impl StoreClaim {
    /// Adopt the claim ALREADY on disk at `root`, for a co-operating process that
    /// shares the owning catalog but does not build the server's config — an
    /// in-process integration test driving a spawned server's store, or a
    /// maintenance tool pointed at a deployment's data dir.
    ///
    /// It cannot manufacture ownership: an unclaimed root is an error, so this is
    /// a way to JOIN an owner, never to invent one. A SERVER must go through
    /// [`resolve_owned_root`] — its key has to come from its own catalog, which
    /// is the entire point of the guard.
    pub fn adopt_existing(root: impl Into<PathBuf>) -> Result<Self, AppError> {
        let root = root.into();
        let path = root.join(CLAIM_FILE);
        let key = std::fs::read_to_string(&path).map_err(|e| {
            AppError::internal_error(format!(
                "workstore: {} carries no readable {CLAIM_FILE} claim ({e}); there is no \
                 catalog to adopt, and ownership cannot be assumed",
                root.display()
            ))
        })?;
        Ok(Self {
            root,
            key: key.trim().to_string(),
        })
    }

    /// The blob-store root this claim covers.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The owning catalog's key.
    pub fn key(&self) -> &str {
        &self.key
    }

    /// Re-read the on-disk claim and confirm this catalog still owns the root.
    ///
    /// Defence in depth: partitioning already gives each catalog its own root,
    /// so this should never fire. It fires if it ever does — a store whose
    /// ownership cannot be confirmed is a store whose contents cannot be
    /// attributed, and a sweep that cannot explain what it is about to delete
    /// abandons rather than guesses (the same stance `gc::keep_set` takes when a
    /// manifest cannot be enumerated).
    pub async fn verify(&self) -> Result<(), AppError> {
        self.verify_covers(None).await
    }

    /// [`Self::verify`], additionally requiring that `swept` — the local root the
    /// caller is actually about to walk — is the root this claim attributed.
    /// A claim over one directory is no licence to unlink another.
    pub async fn verify_covers(&self, swept: Option<&Path>) -> Result<(), AppError> {
        if let Some(swept) = swept {
            if swept != self.root {
                return Err(AppError::internal_error(format!(
                    "workstore.gc: refusing to sweep {} — this server's ownership claim covers \
                     {}, a different directory. Nothing in the swept root has been \
                     attributed to catalog {}.",
                    swept.display(),
                    self.root.display(),
                    self.key
                )));
            }
        }
        let path = self.root.join(CLAIM_FILE);
        match tokio::fs::read_to_string(&path).await {
            Ok(found) if found.trim() == self.key => Ok(()),
            Ok(found) => Err(AppError::internal_error(format!(
                "workstore.gc: refusing to sweep {} — it is claimed by catalog {} but this \
                 server's catalog is {}. Blobs there cannot be attributed to this catalog, and \
                 unlinking what it cannot attribute is how live data is lost.",
                self.root.display(),
                found.trim(),
                self.key
            ))),
            Err(e) => Err(AppError::internal_error(format!(
                "workstore.gc: refusing to sweep {} — its {CLAIM_FILE} claim could not be read \
                 ({e}), so the blobs there cannot be attributed to this server's catalog ({}).",
                self.root.display(),
                self.key
            ))),
        }
    }
}

/// Resolve the blob-store root this catalog owns under `data_root`, claiming
/// the default (unpartitioned) directory when it is unowned.
///
/// Never moves, renames or deletes anything. On any I/O trouble it falls back to
/// the catalog's OWN partition, which is always safe: a private directory can
/// hold no other catalog's blobs.
pub fn resolve_owned_root(data_root: &Path, key: &str) -> StoreClaim {
    let default = data_root.join(DEFAULT_DIR);
    let private = data_root.join(format!("{DEFAULT_DIR}-{key}"));

    let root = match claim(&default, key) {
        // We own the default root (claimed it now, or on an earlier boot).
        Ok(true) => default,
        // Somebody else owns it — take our own partition instead.
        Ok(false) => {
            tracing::warn!(
                default_root = %default.display(),
                partition = %private.display(),
                catalog = key,
                "workstore: {} is claimed by ANOTHER catalog (another worktree's or \
                 deployment's database is using it), so this server takes its own blob-store \
                 partition. Sweeping a store this catalog does not own would unlink the other \
                 catalog's live blobs.",
                default.display()
            );
            ensure_claimed(&private, key);
            private
        }
        Err(e) => {
            tracing::warn!(
                root = %default.display(),
                error = %e,
                "workstore: could not establish ownership of the default blob-store root; \
                 using this catalog's private partition instead"
            );
            ensure_claimed(&private, key);
            private
        }
    };
    StoreClaim {
        root,
        key: key.to_string(),
    }
}

/// `Ok(true)` when `key` owns `dir` after this call. Creates the claim if the
/// directory has none (an atomic `create_new`, so of two racing boots exactly
/// one wins and the loser re-reads and steps aside).
fn claim(dir: &Path, key: &str) -> std::io::Result<bool> {
    let path = dir.join(CLAIM_FILE);
    match std::fs::read_to_string(&path) {
        Ok(found) => return Ok(found.trim() == key),
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
        Err(_) => {}
    }
    std::fs::create_dir_all(dir)?;
    match write_new(&path, key) {
        Ok(()) => Ok(true),
        // Lost the race (or a claim appeared between the read and the write) —
        // whoever wrote it decides.
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            Ok(std::fs::read_to_string(&path)?.trim() == key)
        }
        Err(e) => Err(e),
    }
}

/// Best-effort claim of a directory whose NAME already encodes `key`, so no
/// other catalog can legitimately be resolved to it.
fn ensure_claimed(dir: &Path, key: &str) {
    if let Err(e) =
        std::fs::create_dir_all(dir).and_then(|()| match write_new(&dir.join(CLAIM_FILE), key) {
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
            other => other,
        })
    {
        tracing::warn!(
            root = %dir.display(),
            error = %e,
            "workstore: could not write the blob-store ownership claim; the GC sweep will \
             refuse to run until it can be read"
        );
    }
}

fn write_new(path: &Path, key: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    f.write_all(key.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::workstore::catalog::repository::BlobRefRow;
    use crate::modules::workstore::gc::sweep_refs;
    use crate::modules::workstore::object_store::{LocalFsStore, ObjectStore};

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("txr-part-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn cfg_yaml(db_path: &str) -> String {
        format!(
            r#"
database:
  path: "{db_path}"
server:
  host: "127.0.0.1"
  port: 3100
  api_prefix: "/api"
jwt:
  secret: "test-secret-key-for-jwt-tokens-min-32-chars-long"
  issuer: "txresbench"
  audience: "txresbench-api"
  access_token_expiry_hours: 24
  refresh_token_expiry_days: 30
"#
        )
    }

    fn config_with_db_file(db_path: &str) -> ServerConfig {
        serde_norway::from_str(&cfg_yaml(db_path)).expect("test config parses")
    }

    // ── THE DEFECT ──────────────────────────────────────────────────────────

    /// THE data-loss guard, on the real path: two catalogs resolving a blob
    /// store under ONE shared data root, a real [`LocalFsStore`] on each, and
    /// the real [`sweep_refs`]. Catalog B's sweep must not free catalog A's
    /// live blob.
    ///
    /// This is the bug as it actually happened. Two git worktrees both fall
    /// back to `~/.app` (neither sets `TXR_APP_DATA_DIR`) while each runs its
    /// own database — the pre-SQLite shape ran its own embedded cluster, the
    /// SQLite shape resolves its own DB file (`database.path` per worktree) —
    /// so B's boot-time sweep saw A's blobs as orphans — they are, to B's
    /// catalog — and unlinked them.
    #[tokio::test]
    async fn a_second_catalog_sweep_never_frees_the_first_catalogs_live_blobs() {
        let data_root = tmp();
        let a = config_with_db_file(&data_root.join("worktree-a/txresbench.db").display().to_string());
        let b = config_with_db_file(&data_root.join("worktree-b/txresbench.db").display().to_string());

        // Catalog A: one live artifact.
        let claim_a = resolve_owned_root(&data_root, &catalog_key(&a));
        let store_a = LocalFsStore::new(&claim_a.root);
        let live = store_a.put(b"catalog A's only artifact").await.unwrap();

        // Catalog B boots against the SAME data root with an EMPTY catalog and
        // runs its standing sweep. min_age 0 — no grace window to hide behind.
        let claim_b = resolve_owned_root(&data_root, &catalog_key(&b));
        let store_b = LocalFsStore::new(&claim_b.root);
        let refs: Vec<BlobRefRow> = vec![];
        claim_b.verify().await.expect("B owns the root it sweeps");
        sweep_refs(&store_b, &refs, 0)
            .await
            .expect("B's sweep runs");

        assert!(
            store_a.exists(&live).await.unwrap(),
            "catalog B's sweep unlinked a blob that only catalog A references — that is \
             live data, permanently gone (blob {live}, A at {}, B at {})",
            claim_a.root.display(),
            claim_b.root.display()
        );
        let _ = std::fs::remove_dir_all(&data_root);
    }

    /// The path-derivation layer on its own: two distinct catalogs under one
    /// data root must never resolve to the same blob-store root.
    #[test]
    fn distinct_catalogs_never_share_a_blob_store_root() {
        let data_root = tmp();
        let a = config_with_db_file("/srv/a/txresbench.db");
        let b = config_with_db_file("/srv/b/txresbench.db");
        let ra = resolve_owned_root(&data_root, &catalog_key(&a)).root;
        let rb = resolve_owned_root(&data_root, &catalog_key(&b)).root;
        assert_ne!(
            ra, rb,
            "two catalogs resolved to ONE store; whichever sweeps second frees the other's \
             live blobs"
        );
        let _ = std::fs::remove_dir_all(&data_root);
    }

    /// The identity really is the DB FILE, not the config: the dev config is
    /// copied verbatim into every worktree, so both carry the SAME `database:`
    /// block (or none) — what differs per worktree is the resolved target (the
    /// per-worktree app-data dir in the dev case). A key built from the config
    /// alone would collide and reproduce the bug.
    #[test]
    fn worktrees_sharing_a_config_but_not_a_db_file_get_distinct_keys() {
        let dir_a = tmp();
        let dir_b = tmp();
        // Two "worktrees": identical config (no database block — the copied
        // dev shape), per-worktree app-data dirs.
        let cfg: ServerConfig = serde_norway::from_str(
            "server:\n  host: \"127.0.0.1\"\n  port: 3100\n  api_prefix: \"/api\"\njwt:\n  secret: \"test-secret-key-for-jwt-tokens-min-32-chars-long\"\n  issuer: \"txresbench\"\n  audience: \"txresbench-api\"\n  access_token_expiry_hours: 24\n  refresh_token_expiry_days: 30\n",
        )
        .expect("identical mixed config parses");
        let key_a = {
            let _guard = crate::modules::rootfs::scoped_data_root(&dir_a);
            catalog_key(&cfg)
        };
        let key_b = {
            let _guard = crate::modules::rootfs::scoped_data_root(&dir_b);
            catalog_key(&cfg)
        };
        assert_ne!(
            key_a, key_b,
            "identical configs in different app-data dirs must be distinct catalogs"
        );
        let _ = std::fs::remove_dir_all(&dir_a);
        let _ = std::fs::remove_dir_all(&dir_b);
    }

    /// Two configs resolving THE SAME DB file (the `database.url` URL spelling
    /// and the `database.path` path spelling of one file — the bootstrap
    /// accepts both) are ONE catalog: they must get the same key, or the store
    /// would silently move between boots that point at one file.
    #[test]
    fn one_file_two_spellings_yields_one_key() {
        let url_cfg: ServerConfig = serde_norway::from_str(&format!(
            "database:\n  url: \"sqlite:///srv/txr/app.db\"\nserver:\n  host: \"127.0.0.1\"\n  port: 3100\n  api_prefix: \"/api\"\njwt:\n  secret: \"test-secret-key-for-jwt-tokens-min-32-chars-long\"\n  issuer: \"txresbench\"\n  audience: \"txresbench-api\"\n  access_token_expiry_hours: 24\n  refresh_token_expiry_days: 30\n"
        ))
        .expect("url config parses");
        let path_cfg = config_with_db_file("/srv/txr/app.db");
        assert_eq!(
            catalog_key(&url_cfg),
            catalog_key(&path_cfg),
            "the identity must be the FILE the runtime opens, not its spelling"
        );
    }

    // ── DEFENCE IN DEPTH ────────────────────────────────────────────────────

    /// A sweep whose store root carries a FOREIGN claim abandons instead of
    /// guessing — and a missing claim is treated the same way.
    #[tokio::test]
    async fn a_foreign_or_missing_claim_abandons_the_sweep() {
        let root = tmp();
        std::fs::write(root.join(CLAIM_FILE), "deadbeef").unwrap();
        let mine = StoreClaim {
            root: root.clone(),
            key: "cafef00d".to_string(),
        };
        let err = mine
            .verify()
            .await
            .expect_err("a foreign claim must abandon the sweep");
        assert!(
            err.to_string().contains("deadbeef") && err.to_string().contains("cafef00d"),
            "the operator is told both catalogs: {err}"
        );

        std::fs::remove_file(root.join(CLAIM_FILE)).unwrap();
        mine.verify()
            .await
            .expect_err("an unreadable claim must abandon the sweep too");
        let _ = std::fs::remove_dir_all(&root);
    }

    // ── THE CONTRACTS THAT MUST NOT MOVE ────────────────────────────────────

    /// A single-root deployment keeps `<data_root>/workstore`, on a fresh
    /// install and on the upgrade of an existing store alike. This is the
    /// production + `TXR_APP_DATA_DIR` (e2e) contract: whatever
    /// `rootfs::data_root()` returns, the store sits at `<that>/workstore` and
    /// nothing is relocated.
    #[test]
    fn a_single_catalog_keeps_the_default_root_and_adopts_existing_blobs() {
        let data_root = tmp();
        let cfg = config_with_db_file("/srv/only/txresbench.db");
        let key = catalog_key(&cfg);

        // An existing, pre-partitioning store (the upgrade case).
        let legacy = data_root.join(DEFAULT_DIR);
        std::fs::create_dir_all(legacy.join("blobs/aa/bb")).unwrap();
        std::fs::write(legacy.join("blobs/aa/bb/aabbcc"), b"pre-existing").unwrap();

        let first = resolve_owned_root(&data_root, &key);
        assert_eq!(first.root, legacy, "the default root is adopted in place");
        assert!(
            legacy.join("blobs/aa/bb/aabbcc").exists(),
            "adoption must not move or delete a single byte"
        );

        // Every later boot resolves to the same place.
        let second = resolve_owned_root(&data_root, &key);
        assert_eq!(second, first, "ownership is stable across boots");
        let _ = std::fs::remove_dir_all(&data_root);
    }

    /// The key is stable across processes and boots — an unstable key would
    /// silently move the store and 404 every artifact.
    #[test]
    fn the_key_is_stable_and_eight_hex() {
        let cfg = config_with_db_file("/srv/a/txresbench.db");
        let k = catalog_key(&cfg);
        assert_eq!(k, catalog_key(&cfg));
        assert_eq!(k.len(), 8);
        assert!(k.bytes().all(|c| c.is_ascii_hexdigit()));
    }

    /// A relative DB target (what `config/dev.yaml` ships for `database.path`)
    /// is resolved against the cwd, so it names the file the server will
    /// actually open — and two worktrees running the same relative path get
    /// different keys.
    #[test]
    fn a_relative_db_path_is_absolutized() {
        let _guard = crate::modules::rootfs::scoped_data_root(&tmp());
        let id = catalog_identity(&config_with_db_file("../../txresbench-data/dev/app.db"));
        let cwd = std::env::current_dir().unwrap();
        assert!(
            id.starts_with("sqlite:/"),
            "a relative DB path must absolutize: {id}"
        );
        assert!(!id.contains(".."), "and normalize: {id}");
        assert!(
            id.contains(
                cwd.components()
                    .next_back()
                    .unwrap()
                    .as_os_str()
                    .to_str()
                    .unwrap()
            ) || id.contains("txresbench-data"),
            "and stay anchored to the cwd: {id}"
        );
    }

    /// Two identities that differ ONLY below a `src-app` component must not
    /// collide. The shared FNV helper strips from `/src-app` onward, so hashing
    /// a raw path through it would map both to the same key — a store shared by
    /// two catalogs, which is the whole bug.
    #[test]
    fn identities_differing_below_a_src_app_component_do_not_collide() {
        let a = stable_key("sqlite:/repo/src-app/a/txresbench.db");
        let b = stable_key("sqlite:/repo/src-app/b/txresbench.db");
        assert_ne!(
            a, b,
            "the separator encoding must defeat the /src-app strip"
        );
    }

    /// An existing claim is NEVER replaced by a later writer.
    ///
    /// This is the deterministic half of the boot race below: the race only has
    /// one winner because the claim write is exclusive, and whether two real
    /// threads actually interleave inside the read-then-write window is up to the
    /// scheduler. So the property is asserted directly on the primitive that
    /// decides it — two competing writes, and the FIRST one is what survives.
    /// (Without this, "the write is exclusive" was a mutation nothing killed.)
    #[test]
    fn a_claim_is_never_replaced_by_a_later_writer() {
        let dir = tmp();
        let path = dir.join(CLAIM_FILE);
        write_new(&path, "aaaa1111").expect("the first writer claims it");

        let err = write_new(&path, "bbbb2222")
            .expect_err("a second catalog must not be able to take the claim");
        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "aaaa1111",
            "the original owner's claim must survive a competing write verbatim"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Exactly ONE catalog may end up owning the default root, even when several
    /// boot at the same instant. The claim write is `create_new`, so the race is
    /// decided by the kernel and the losers re-read and step aside; a plain
    /// `create` would let each boot overwrite the last and leave several servers
    /// each believing it owns — and therefore may reclaim from — the same store.
    #[test]
    fn a_concurrent_boot_race_yields_exactly_one_owner_of_the_default_root() {
        let data_root = tmp();
        let default = data_root.join(DEFAULT_DIR);
        let keys: Vec<String> = (0..8u32).map(|i| format!("cafe{i:04x}")).collect();

        // A barrier so every thread enters `resolve_owned_root` together — without
        // it they tend to serialize on spawn overhead and never actually contend
        // for the read-then-write window. Declared OUTSIDE the scope so it
        // outlives the borrows the threads take on it.
        let start = std::sync::Barrier::new(keys.len());
        let winners: usize = std::thread::scope(|scope| {
            let start = &start;
            let handles: Vec<_> = keys
                .iter()
                .map(|k| {
                    let data_root = data_root.clone();
                    let default = default.clone();
                    scope.spawn(move || {
                        start.wait();
                        usize::from(resolve_owned_root(&data_root, k).root == default)
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).sum()
        });

        assert_eq!(
            winners,
            1,
            "{winners} of {} catalogs claimed the SAME default root; each would sweep it \
             against its own keep-set and free the others' live blobs",
            keys.len()
        );
        // And the file records that one winner, unmangled by the losers.
        let recorded = std::fs::read_to_string(default.join(CLAIM_FILE)).unwrap();
        assert!(
            keys.iter().any(|k| k == recorded.trim()),
            "recorded: {recorded:?}"
        );
        let _ = std::fs::remove_dir_all(&data_root);
    }

    /// Servers that genuinely share one catalog share one store — otherwise
    /// each would sweep half a catalog and dangle the other half.
    #[test]
    fn one_catalog_two_servers_share_one_store() {
        let data_root = tmp();
        let a = config_with_db_file("/srv/shared/txresbench.db");
        let b = config_with_db_file("/srv/shared/txresbench.db");
        assert_eq!(
            resolve_owned_root(&data_root, &catalog_key(&a)).root,
            resolve_owned_root(&data_root, &catalog_key(&b)).root
        );
        let _ = std::fs::remove_dir_all(&data_root);
    }
}
