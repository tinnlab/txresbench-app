//! TEST-19 (artifact-model ITEM-13) [acceptance] [invariant: INV-1] — the native
//! TileDB array reader is GONE, and there is no way to switch it back on.
//!
//! ── WHAT THIS SUITE USED TO BE ──────────────────────────────────────────────────
//! Native SOMA read/serve parity tests behind a `#[cfg(…)]` gate on a cargo flag,
//! driving `TileDbArraySource` against a `tiledbsoma`-produced oracle store. ITEM-13
//! deleted the module (`ffi.rs` / `store.rs` / `array_source/`), the `tiledb_serve` cargo
//! flag, and `CYTO_TILEDB_LIB`; the suite is INVERTED in place to assert the removal.
//!
//! ── WHY INVERT RATHER THAN DELETE ───────────────────────────────────────────────
//! INV-1 — "the server stores and serves; it never opens a byte for meaning" — is
//! violated by *re-adding* a reader just as surely as it was by the original one, and a
//! deleted test asserts nothing about that. `libtiledb` was reached through hand-written
//! FFI (`#[link]` + a `build.rs` `rustc-link-lib`), NOT through a crates.io dependency,
//! so `scripts/check-no-format-crates.sh` (TEST-2, which reads the RESOLVED DEPENDENCY
//! GRAPH) would never have seen it. This suite is what closes that specific hole: the
//! link path was source-level, so the proof has to be source-level too.
//!
//! ── UNGATED ON PURPOSE ──────────────────────────────────────────────────────────
//! `integration_tests.rs` declares `mod tiledb_serve;` with NO `#[cfg(…)]` gate on it.
//! A removal proof hidden behind the very build flag whose removal it proves — which is
//! what the suite it replaces was — could never run.
//!
//! ── NOT VACUOUS ─────────────────────────────────────────────────────────────────
//! Every scan strips comments before matching, so the deliberate TOMBSTONE comments left
//! at each removal site (`modules/mod.rs`, `Cargo.toml`, `build.rs`) — which name
//! `tiledb_serve` and `CYTO_TILEDB_LIB` precisely so a future agent does not reintroduce
//! them — do not trip the scan, while any LIVE reintroduction does.
//! `scanner_flags_live_code_but_not_comments` is the negative control proving the
//! matcher actually fires, in both the Rust and the TOML dialect.
//!
//! ── THE SCANNED SURFACE IS EVERY COMPILED SOURCE FILE, NOT A LIST ───────────────
//! See `scanned_surface`. It walks the WHOLE crate root (minus the crate-level `tests/`,
//! which this file is in), because the earlier `src/` + `build.rs` list missed
//! `build_helper/` — the `#[path]`-included modules where the build script's real logic,
//! and therefore any `rustc-link-lib`, actually lives.

use std::path::{Path, PathBuf};

fn server_root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
}

/// Code-only lines of `src`, as `(1-based line number, text)`. Strips line comments —
/// `//` for Rust, `#` for TOML — so a tombstone comment naming a removed symbol is not a
/// hit while a live reintroduction is. Mirrors the `production_lines` helper in
/// `modules/workstore/no_legacy_wire.rs`.
fn code_lines(src: &str, comment: &str) -> Vec<(usize, String)> {
    src.lines()
        .enumerate()
        .filter_map(|(i, raw)| {
            let code = match raw.find(comment) {
                Some(idx) => &raw[..idx],
                None => raw,
            };
            if code.trim().is_empty() {
                None
            } else {
                Some((i + 1, code.to_string()))
            }
        })
        .collect()
}

fn comment_marker(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("toml") => "#",
        _ => "//",
    }
}

/// Every `.rs` under `dir`, recursively, except under any path in `skip`.
///
/// `skip` holds ABSOLUTE paths, not directory NAMES. That distinction is load-bearing:
/// the crate has a nested `src/modules/datatype/tests/mod.rs`, which the original `src/`
/// walk scanned and which a name-based skip would silently have dropped — narrowing the
/// guard while appearing to widen it.
fn rust_files_excluding(dir: &Path, skip: &[PathBuf]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let entries =
        std::fs::read_dir(dir).unwrap_or_else(|e| panic!("read source dir {}: {e}", dir.display()));
    for entry in entries {
        let p = entry.expect("read dir entry").path();
        if skip.iter().any(|s| *s == p) {
            continue;
        }
        if p.is_dir() {
            out.extend(rust_files_excluding(&p, skip));
        } else if p.extension().and_then(|e| e.to_str()) == Some("rs") {
            out.push(p);
        }
    }
    out
}

/// Every `#[path = "…"]` target named by `build.rs`, as crate-root-relative paths.
///
/// DERIVED, never typed here. The build script's real logic does not live in `build.rs`
/// — it lives in the modules `build.rs` pulls in by `#[path]` (`build_helper/mod.rs`
/// today). A scan set that listed only `build.rs` would therefore have inspected the
/// script's ENTRY POINT and none of its BODY, which is exactly where a
/// `rustc-link-lib=tiledb` would sit. Reading the attributes out of `build.rs` means a
/// `#[path]` added tomorrow is scanned on arrival with zero edits to this file — the
/// same derive-don't-hardcode discipline `scripts/check-derived-vocabulary.sh` applies
/// to its forbidden vocabulary.
fn build_script_path_modules(build_rs: &str) -> Vec<String> {
    let mut out = Vec::new();
    for (_, line) in code_lines(build_rs, "//") {
        let Some(rest) = line.split_once("#[path").map(|(_, r)| r) else {
            continue;
        };
        let Some(open) = rest.find('"') else { continue };
        let Some(close) = rest[open + 1..].find('"') else {
            continue;
        };
        out.push(rest[open + 1..open + 1 + close].to_string());
    }
    out
}

/// `file:line: [needle] text` for every code-line hit of any needle.
fn scan(files: &[PathBuf], needles: &[&str]) -> Vec<String> {
    let mut hits = Vec::new();
    for f in files {
        let src = std::fs::read_to_string(f)
            .unwrap_or_else(|e| panic!("read scanned file {}: {e}", f.display()));
        for (n, line) in code_lines(&src, comment_marker(f)) {
            for needle in needles {
                if line.contains(needle) {
                    hits.push(format!("{}:{}: [{}] {}", f.display(), n, needle, line.trim()));
                }
            }
        }
    }
    hits
}

/// The scanned surface: EVERY `.rs` under the crate root — library source, the build
/// script, and the build script's `#[path]`-included modules (`build_helper/`) alike —
/// plus the manifest.
///
/// ── WHY A WHOLE-ROOT WALK RATHER THAN A LIST OF DIRECTORIES ─────────────────────
/// This used to be `src/` + `build.rs` + `Cargo.toml`, and that list had a hole exactly
/// the shape of the thing being forbidden: `build.rs` is a 90-line entry point that
/// `#[path]`-includes `build_helper/mod.rs`, and the build's REAL logic lives there. A
/// live `CYTO_TILEDB_LIB` read plus `cargo:rustc-link-lib=tiledb` /
/// `cargo:rustc-link-search` planted in `build_helper/` left all five tests below GREEN.
/// A default-deny walk of the whole root closes that by construction: a new compiled
/// source directory is scanned on arrival, with no list for anyone to forget to update.
/// (`scripts/check-derived-vocabulary.sh`, written for the same invariant family, already
/// lists `build_helper` among its SURFACE_ROOTS — this was a plain omission, not a
/// difference of opinion.)
///
/// Deliberately EXCLUDES the CRATE-LEVEL `tests/` — this file names the removed symbols
/// by design — and a crate-level `target/`, which is build output rather than source. The
/// exclusion is by absolute path, so the crate's nested `src/modules/datatype/tests/`
/// stays IN the scan.
fn scanned_surface() -> Vec<PathBuf> {
    let root = server_root();
    let mut files = rust_files_excluding(root, &[root.join("tests"), root.join("target")]);
    files.push(root.join("Cargo.toml"));
    for f in &files {
        assert!(f.is_file(), "scanned path missing: {}", f.display());
    }
    // ── the walk actually REACHED the build script's body ────────────────────────
    // DERIVED from `build.rs`'s own `#[path]` attributes, so this holds for whatever the
    // build script includes tomorrow without an edit here. Without it, a walk that
    // silently stopped descending would still clear the size floor on `src/` alone —
    // which is precisely how the original hole passed as clean.
    let build_rs = root.join("build.rs");
    assert!(
        files.contains(&build_rs),
        "the walk did not reach build.rs — the scan set is not what it claims to be"
    );
    let build_src = std::fs::read_to_string(&build_rs).expect("read build.rs");
    let path_modules = build_script_path_modules(&build_src);
    assert!(
        !path_modules.is_empty(),
        "no `#[path = …]` found in build.rs — either the build script stopped including \
         its modules (then delete this assertion) or the attribute reader broke (then the \
         build helper's source is silently out of the scan set again)"
    );
    for rel in &path_modules {
        let included = root.join(rel);
        assert!(
            files.contains(&included),
            "build.rs `#[path]`-includes `{rel}`, but it is NOT in the scanned surface. \
             The build script's real logic lives in the modules it pulls in; a scan that \
             misses them cannot see a native link directive at all."
        );
    }
    // A crate this size is never 50 files: a smaller read means the walk broke and the
    // scans below were about to pass having inspected almost nothing.
    assert!(
        files.len() >= 50,
        "the scan set resolved to {} file(s) — that is a broken read, not a clean crate",
        files.len()
    );
    files
}

// ── 1 — the module is gone ──────────────────────────────────────────────────────
#[test]
fn tiledb_serve_module_is_absent() {
    let module = server_root().join("src/modules/tiledb_serve");
    assert!(
        !module.exists(),
        "ITEM-13 violated: `{}` exists again. INV-1 — the server confines, caps, hashes, \
         stores, records and SERVES bytes; it never opens one for meaning. Artifact bytes \
         go out as bytes (`GET /artifacts/{{id}}/data[/{{*member}}]`) and are decoded in \
         the browser, never by an in-process array reader.",
        module.display()
    );
}

// ── 2 — nothing in the library references it ────────────────────────────────────
#[test]
fn no_source_reference_to_the_deleted_module() {
    let leaks = scan(
        &scanned_surface(),
        &["mod tiledb_serve", "modules::tiledb_serve", "TileDbArraySource", "TileDbStore"],
    );
    assert!(
        leaks.is_empty(),
        "ITEM-13 violated: live code references the deleted `tiledb_serve` module:\n{}",
        leaks.join("\n")
    );
}

// ── 3 — the cargo flag is gone, so it cannot be switched back on ───────────────
#[test]
fn tiledb_serve_cargo_flag_is_absent() {
    let leaks = scan(&scanned_surface(), &["tiledb_serve"]);
    assert!(
        leaks.is_empty(),
        "ITEM-13 violated: `tiledb_serve` appears in live manifest/source text — the cargo \
         flag and every `#[cfg(…)]` gate naming it were deleted, so there is deliberately \
         no switch left to turn a format reader back on:\n{}",
        leaks.join("\n")
    );
}

// ── 4 — the env var and the native link path are gone ───────────────────────────
#[test]
fn no_tiledb_link_path_in_the_build() {
    // `CYTO_TILEDB_LIB` pointed `build.rs` at a prebuilt core `libtiledb` lib dir;
    // `rustc-link-lib`/`rustc-link-search` + `#[link(name = "tiledb")]` were how it got
    // linked. The crate must emit no link directive for a format-parsing library at all —
    // a dependency-graph read cannot see a hand-written FFI link, so this is the
    // assertion that covers it.
    let leaks = scan(
        &scanned_surface(),
        &["CYTO_TILEDB_LIB", "rustc-link-lib", "rustc-link-search", "link(name = \"tiledb\")"],
    );
    assert!(
        leaks.is_empty(),
        "ITEM-13 violated: a native link path reappeared. The server links NO \
         format-parsing library (INV-1); reintroducing one is an invariant change that \
         belongs in a reviewed design amendment, not in a build script:\n{}",
        leaks.join("\n")
    );
}

// ── 5 — negative control: the scanner actually fires ────────────────────────────
#[test]
fn scanner_flags_live_code_but_not_comments() {
    let tmp = std::env::temp_dir().join(format!("tiledb_removed_probe_{}.rs", std::process::id()));

    // Live code IS flagged…
    std::fs::write(&tmp, "fn f() {\n    let d = std::env::var(\"CYTO_TILEDB_LIB\");\n}\n").unwrap();
    let hits = scan(&[tmp.clone()], &["CYTO_TILEDB_LIB"]);
    assert_eq!(hits.len(), 1, "a live reintroduction MUST be flagged, got {hits:?}");

    // …but a tombstone comment is NOT — which is why the tombstones are allowed to stay.
    std::fs::write(&tmp, "// CYTO_TILEDB_LIB was deleted by ITEM-13\nfn f() {}\n").unwrap();
    let none = scan(&[tmp.clone()], &["CYTO_TILEDB_LIB"]);
    assert!(none.is_empty(), "a comment must NOT be flagged: {none:?}");

    // The TOML dialect is exercised too — the manifest is in the scan set.
    let toml = tmp.with_extension("toml");
    std::fs::write(&toml, "# tiledb_serve = []\nsandbox_seccomp = []\n").unwrap();
    assert!(
        scan(&[toml.clone()], &["tiledb_serve"]).is_empty(),
        "a TOML comment must NOT be flagged"
    );
    std::fs::write(&toml, "tiledb_serve = []\n").unwrap();
    assert_eq!(
        scan(&[toml.clone()], &["tiledb_serve"]).len(),
        1,
        "a live TOML flag key MUST be flagged"
    );

    let _ = std::fs::remove_file(&tmp);
    let _ = std::fs::remove_file(&toml);
}
