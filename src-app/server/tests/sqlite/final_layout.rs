//! TEST-33 (sqlite-store ITEM-26): the FINAL migration layout — one chain,
//! one dialect, in the canonical dirs.
//!
//! What ITEM-26 left behind, pinned here as the contract a downstream
//! migration (engine / model-store / history-store) writes against:
//!
//!   1. **No staging tree.** `migrations-sqlite/` no longer exists anywhere
//!      in the app (`src-app/server/`) or in the three schema-bound SDK
//!      crates — DEC-9's two-chain staging window is closed.
//!   2. **One chain per app module.** Every module that owns migrations
//!      ships exactly `src/modules/<m>/migrations/` (the SQLite dialect);
//!      no module carries a second chain dir (`migrations-pg`, the SDK-only
//!      retained-postgres name).
//!   3. **The merged composition is exactly the module set.** The REAL
//!      composer with build.rs's source lists (module glob root + the three
//!      SDK crates' `migrations/` dirs) produces exactly the union of the
//!      module files — 57 — and byte-identical copies.
//!   4. **No PG-dialect construct survives in the executable SQL.** The
//!      port rules (DEC-12, PROV-sqlite-store-4) are checked on the
//!      comment-stripped, string-literal-stripped SQL: no `::` casts, no
//!      `jsonb`, no PG JSON operators (`->`/`->>`/`@>`/`#>`/`#>>`/`#-`/
//!      `?|`/`?&`), no ILIKE/LATERAL/DISTINCT ON/FILTER (WHERE…),
//!      `gen_random_uuid()`/`now()` calls, `pg_*()` functions or `public.`
//!      schema prefixes. The port notes in COMMENTS keep naming the PG
//!      constructs they map — the grep deliberately skips comments and
//!      string literals (permission ids such as `'jobs::use'` contain `::`
//!      and are not casts).

use std::path::{Path, PathBuf};

/// The app modules that own migrations (ITEM-8/9/10/11 groups, final layout).
const MIGRATION_MODULES: &[&str] = &[
    "account",
    "dataset",
    "drafts",
    "features",
    "file",
    "jobs",
    "mcp",
    "project",
    "provenance",
    "sandbox",
    "workstore",
];

/// The schema-bound SDK crates whose migrations the app composes.
const SDK_MIGRATION_CRATES: &[&str] = &["ziee-auth", "ziee-file", "ziee-notification"];

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn dir_has_dir(root: &Path, name: &str) -> bool {
    match std::fs::read_dir(root) {
        Ok(entries) => entries
            .flatten()
            .any(|e| e.file_name().to_string_lossy() == name),
        Err(_) => false,
    }
}

fn app_module_migrations(module: &str) -> PathBuf {
    manifest_dir()
        .join("src/modules")
        .join(module)
        .join("migrations")
}

fn sdk_crate_migrations(crate_name: &str) -> PathBuf {
    manifest_dir()
        .join("../../sdk/crates")
        .join(crate_name)
        .join("migrations")
}

fn sql_files(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("missing migration dir {}: {e}", dir.display()))
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("sql"))
        .collect();
    files.sort();
    files
}

/// Cut `--` comments (outside single-quoted strings, `''` escaping held) and
/// blank the string literal contents — the port notes in comments deliberately
/// name PG constructs, and permission ids such as `'jobs::use'` contain `::`.
fn executable_sql(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut in_string = false;
    let mut chars = line.char_indices().peekable();
    while let Some((_, c)) = chars.next() {
        if in_string {
            if c == '\'' {
                if chars.peek().is_some_and(|(_, n)| *n == '\'') {
                    chars.next();
                    continue;
                }
                in_string = false;
            }
            continue;
        }
        match c {
            '\'' => in_string = true,
            '-' if chars.peek().is_some_and(|(_, n)| *n == '-') => break,
            _ => out.push(c),
        }
    }
    out
}

/// The PG-only constructs the port rules replaced (DEC-12 / PROV-4). Each is
/// a REGULAR expression over the comment/string-stripped line; a hit is a
/// dialect leak in executable SQL, not a port-note mention or a permission id.
fn pg_construct_hit(stripped: &str) -> Option<&'static str> {
    let patterns: &[(&str, &str)] = &[
        (r"[A-Za-z0-9_)\]]+::[A-Za-z_]+", "postgres `::` cast"),
        (r"\bjsonb(_|\b)", "postgres `jsonb`"),
        (r"->>|->\b|@>|#>|#>>|#-|\?\||\?&", "postgres JSON operator"),
        (r"\bILIKE\b|\bLATERAL\b|DISTINCT\s+ON|FILTER\s*\(WHERE", "postgres-only keyword"),
        (
            r"gen_random_uuid\s*\(|\bnow\s*\(|\bpg_\w+\s*\(|\bpublic\.",
            "postgres-only call/prefix",
        ),
    ];
    for (re, name) in patterns {
        if regex::Regex::new(re)
            .expect("static pattern")
            .is_match(stripped)
        {
            return Some(name);
        }
    }
    None
}

/// TEST-33 (ITEM-26): the final layout — staging gone, one chain per module,
/// composition == module set, no PG-dialect SQL.
#[test]
fn final_layout_has_one_sqlite_chain_and_no_pg_dialect() {
    // 1. The staging tree is gone everywhere it existed.
    for root in [manifest_dir(), sdk_crates_root(&manifest_dir())] {
        if root.exists() {
            assert!(
                !dir_has_dir(&root, "migrations-sqlite"),
                "{}: the DEC-9 staging tree must be gone after ITEM-26",
                root.display()
            );
        }
    }
    for crate_name in SDK_MIGRATION_CRATES {
        let dir = sdk_crates_root(&manifest_dir()).join(crate_name);
        assert!(
            !dir_has_dir(&dir, "migrations-sqlite"),
            "sdk/{crate_name}: the staging tree must be gone after ITEM-26"
        );
    }

    // 2. Each app module ships exactly ONE chain dir (`migrations/`), and no
    //    module carries the SDK-only retained-postgres name.
    for module in MIGRATION_MODULES {
        let dir = app_module_migrations(module);
        assert!(
            dir.is_dir(),
            "src/modules/{module}: the module-owned migrations dir must exist"
        );
        assert!(
            !dir_has_dir(&dir.parent().expect("module dir"), "migrations-sqlite"),
            "src/modules/{module}: no second chain dir (staging)"
        );
        assert!(
            !dir_has_dir(&dir.parent().expect("module dir"), "migrations-pg"),
            "src/modules/{module}: the retained-postgres name is SDK-only (ITEM-26)"
        );
    }

    // 3. The REAL composer with build.rs's source lists produces exactly the
    //    module union, byte-identical per file.
    let scratch = std::env::temp_dir().join(format!(
        "cyto-final-layout-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&scratch).expect("scratch");
    let merged = scratch.join("merged");
    let module_roots = vec![manifest_dir().join("src/modules")];
    let sdk_dirs: Vec<PathBuf> = SDK_MIGRATION_CRATES
        .iter()
        .map(|c| sdk_crate_migrations(c))
        .collect();
    ziee_build_support::compose_merged_migrations_from(&merged, &module_roots, &sdk_dirs);

    let mut expected_files: Vec<PathBuf> = Vec::new();
    for module in MIGRATION_MODULES {
        expected_files.extend(sql_files(&app_module_migrations(module)));
    }
    for crate_name in SDK_MIGRATION_CRATES {
        expected_files.extend(sql_files(&sdk_crate_migrations(crate_name)));
    }
    expected_files.sort();
    assert_eq!(expected_files.len(), 57, "the complete SQLite chain is 57 files");

    let mut merged_files: Vec<PathBuf> = std::fs::read_dir(&merged)
        .expect("merged dir")
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("sql"))
        .collect();
    merged_files.sort();
    assert_eq!(
        merged_files.len(),
        expected_files.len(),
        "merged composition count must equal the module file count"
    );
    // Match per BASENAME (the composer version-sorts by file name; the source
    // enumeration above sorted by PATH, so the two lists are not positionally
    // aligned) and require a byte-identical copy per file.
    let sources_by_name: std::collections::BTreeMap<&str, &PathBuf> = expected_files
        .iter()
        .map(|p| (p.file_name().expect("file name").to_str().expect("utf8"), p))
        .collect();
    for merged_file in &merged_files {
        let name = merged_file.file_name().expect("file name").to_str().expect("utf8");
        let source = sources_by_name.get(name).unwrap_or_else(|| {
            panic!(
                "merged {} has no module source",
                merged_file.display()
            )
        });
        assert!(
            std::fs::read(merged_file).expect("read merged").as_slice()
                == std::fs::read(source).expect("read source").as_slice(),
            "merged {name} must be a byte-identical copy of {}",
            source.display()
        );
    }
    let _ = std::fs::remove_dir_all(&scratch);

    // 4. No PG-dialect construct in the executable SQL of the module chains.
    for module in MIGRATION_MODULES {
        for file in sql_files(&app_module_migrations(module)) {
            for (ln, line) in std::fs::read_to_string(&file)
                .unwrap_or_else(|e| panic!("read {}: {e}", file.display()))
                .lines()
                .enumerate()
            {
                let stripped = executable_sql(line);
                if stripped.trim().is_empty() {
                    continue;
                }
                if let Some(name) = pg_construct_hit(&stripped) {
                    panic!(
                        "{}:{}: {} in executable SQL: {:?}",
                        file.display(),
                        ln + 1,
                        name,
                        stripped.trim_end()
                    );
                }
            }
        }
    }
}

/// The vendored SDK root (`<repo>/sdk`), exposed for the staging-tree sweep.
fn sdk_crates_root(manifest: &Path) -> PathBuf {
    manifest.join("../../sdk/crates")
}
