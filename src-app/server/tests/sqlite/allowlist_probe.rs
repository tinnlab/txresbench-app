//! TEST-34 (sqlite-store ITEM-27): the network stance of the shipped app —
//! the embedded-PostgreSQL downloader is gone from the app's own sources and
//! lockfile, and the guard that polices the remaining hosts exits green.
//!
//! Two halves, per TESTS.md:
//!
//! 1. **The guard itself, per its contract**: `scripts/check-network-allowlist.sh`
//!    exits 0 on the branch — no outbound host outside
//!    `scripts/network-allowlist.txt` in shipped non-test source, no
//!    telemetry/crash-reporting dependency in any repo lockfile. The
//!    allowlist DOES list `ghcr.io` (method environments) and the update
//!    check's `github.com` (the user-opened docs link, never dialed; the
//!    update feed is a later node's work) — the owner-approved network uses.
//!
//! 2. **The allowlist-invisible removal, pinned**: the audit item A3 the
//!    node exists to close (dev/docs/app-network-audit.md §A3) was the
//!    embedded-PG binary download — a first-run network fetch with NO host
//!    literal and NO telemetry name, invisible to the guard's two scans. So
//!    this probe asserts the things only the source can prove:
//!    - the app's repo `Cargo.lock` contains no `postgresql_embedded` /
//!      `postgresql_archive` package entry (the app's resolved graph does
//!      not even lock the downloader — provenance shape: the lock was
//!      PRUNED at ITEM-24 after the last `embedded-pg` activator left; TEST-1(a)
//!      keeps the `cargo tree` form as the build-graph assertion);
//!    - the app-OWNED shipped source contains no
//!      `postgresql_embedded`/`postgresql_archive` (crate names),
//!      `theseus-rs` (the download host) or `https://github.com/theseus-rs`
//!      literal, comments included — comments are executable truth here
//!      because a comment cannot dial a host; the sweep is deliberately raw
//!      so a future real reference cannot hide beside a doc mention.
//!
//! The SDK crates are scanned by nothing here: the fork stays dual-driver
//! (DEC-1/DEC-14, PROV-sqlx-1 — the schema-bound SDK crates keep their
//! postgres leg for txresbench, app #1), and `sdk/crates/txresbench-framework` itself
//! contains `use postgresql_embedded` behind the `embedded-pg` cargo flag. The
//! probe's "app source" = the repo's own shipped roots (the same roots the
//! guard scans minus the SDK).

use std::path::{Path, PathBuf};
use std::process::Command;

/// The crate/host literals that would mean the PG binary downloader is back.
const DOWNLOADER_LITERALS: &[&str] = &[
    "postgresql_embedded",
    "postgresql_archive",
    "theseus-rs",
    "github.com/theseus-rs",
];

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("CARGO_MANIFEST_DIR is <repo>/src-app/server")
        .to_path_buf()
}

/// THE guard, run on the branch — TEST-34's first half.
#[test]
fn the_network_allowlist_guard_passes_on_the_branch() {
    let guard = repo_root().join("scripts/check-network-allowlist.sh");
    assert!(guard.is_file(), "missing guard: {}", guard.display());
    let out = Command::new("bash")
        .arg(&guard)
        .current_dir(repo_root())
        .output()
        .expect("network-allowlist guard runnable");
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        out.status.success(),
        "the network-allowlist guard FAILED on the branch:\n{text}"
    );
}

/// The app's own lockfile and owned source carry no downloader reference —
/// TEST-34's second half (the item's "TEST_A1 lockfile assertion").
#[test]
fn the_app_lockfile_and_owned_source_carry_no_pg_downloader_reference() {
    // 1. The resolved app graph. The repo-root Cargo.lock is the app's
    //    workspace lock; the SDK's own `sdk/Cargo.lock` is out (dual-driver
    //    substrate, txresbench's leg keeps the downloader).
    let lock = repo_root().join("Cargo.lock");
    let lock_text = std::fs::read_to_string(&lock)
        .unwrap_or_else(|e| panic!("read {}: {e}", lock.display()));
    for name in ["postgresql_embedded", "postgresql_archive"] {
        let entry = format!("name = \"{name}\"");
        assert!(
            !lock_text.contains(&entry),
            "{}: the app's resolved graph must not lock the {name} downloader \
             (audit item A3; TEST-1 keeps the cargo-tree assertion as the \
             build-graph form)",
            lock.display()
        );
    }

    // 2. The app-owned shipped source: the server crate, the desktop crate
    //    and the frontend roots — the roots the network guard scans, minus
    //    the shared SDK (which legitimately names the downloader behind its
    //    postgres leg).
    let roots = [
        repo_root().join("src-app/server/src"),
        repo_root().join("src-app/server/build.rs"),
        repo_root().join("src-app/desktop/tauri/src"),
        repo_root().join("src-app/ui/src"),
        repo_root().join("src-app/libs/dock/src"),
        repo_root().join("src-app/libs/viz/src"),
    ];
    let mut scanned = 0usize;
    for root in &roots {
        assert!(
            root.exists(),
            "app source root missing: {}",
            root.display()
        );
        let mut files: Vec<PathBuf> = Vec::new();
        walk_source_files(root, &mut files);
        for file in files {
            let text = std::fs::read_to_string(&file)
                .unwrap_or_else(|e| panic!("read {}: {e}", file.display()));
            for (ln, line) in text.lines().enumerate() {
                for literal in DOWNLOADER_LITERALS {
                    assert!(
                        !line.contains(literal),
                        "{}:{}: the embedded-PG downloader reference `{literal}` \
                         is back in app-owned source",
                        file.display(),
                        ln + 1
                    );
                }
            }
            scanned += 1;
        }
    }
    assert!(scanned > 500, "implausibly small app source sweep: {scanned} files");
}

/// Recurse collecting source files (the extensions the guard's host scan
/// reads, plus the manifests' siblings).
fn walk_source_files(dir: &Path, out: &mut Vec<PathBuf>) {
    if dir.is_file() {
        if dir.extension().and_then(|s| s.to_str()).is_some_and(|e| {
            matches!(e, "rs" | "ts" | "tsx" | "js" | "mjs")
        }) {
            out.push(dir.to_path_buf());
        }
        return;
    }
    for entry in std::fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("read dir {}: {e}", dir.display()))
    {
        let entry = entry.expect("dir entry");
        let path = entry.path();
        let name = entry.file_name();
        // Skip generated/build trees (the guard's own skip set: tests,
        // fixtures, generated clients and the workstore/internal surfaces
        // are out of ITS scope too; this probe follows the same roots).
        let name = name.to_string_lossy();
        if name == "tests"
            || name == "__fixtures__"
            || name == "fixtures"
            || name == "gen"
            || name == "openapi"
            || name == "api-client"
            || name == "api-client-saas"
        {
            continue;
        }
        if path.is_dir() {
            walk_source_files(&path, out);
        } else if path.is_file() {
            walk_source_files(&path, out);
        }
    }
}
