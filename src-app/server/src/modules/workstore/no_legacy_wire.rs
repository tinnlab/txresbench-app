//! The INV-1 / no-legacy-wire STATIC GREP-GUARD — the Rust twin of
//! `scripts/check-no-legacy-wire.sh` (universal-tiledb-serving S6; TEST-2/6/24).
//!
//! Mirrors the kinds-zero-core guard (`tests/workstore/open_kinds_serve_test.rs`
//! `kinds_zero_core_scope` + `scripts/check-kinds-zero-core.sh`). Two invariants:
//!
//! - **INV-1 / TEST-2 + TEST-6** — the serve path names NO domain / datatype / kind
//!   literal. A `single-cell/…` datatype id or a `geneset/collection` /
//!   `graph/attributed` / `de/result` kind name on the surface that decides what to
//!   serve means the serve path learned a domain — a regression.
//! - **TEST-24 / no-legacy-wire** — every RETIRED read wire is gone from PRODUCTION
//!   code: the typed-binary `de_page` / `slice_artifact` handlers, the
//!   `x-workstore-dtype` / `x-workstore-shape` headers, the `SparseColumn` selector,
//!   the `encode_sparse_column` / `encode_dense_f32` encoders — and, since
//!   artifact-model ITEM-12, **the Selection→Arrow `GET /read` surface itself**.
//!
//! **What ITEM-12 changed here (this is a repair, not a relaxation).** The guard used
//! to scan `serve_core.rs` — the Selection→Arrow serve core — because that was the one
//! place a domain literal could leak into a *decision about how to decode*. ITEM-12
//! DELETED that file: `/data[/{*member}]` is now the only read surface, it serves
//! opaque byte ranges, and there is no decode decision left to leak a domain into.
//! So the guard's two scan sets move to the surviving serve surface and its
//! retired-token list GROWS by the `/read` vocabulary (`serve_artifact_read`,
//! `ReadSelection`, `DimSelection`, `AccessTier`, `arrow`, …). Net: strictly more
//! tokens denied over a surface that is structurally smaller. The one thing NOT done
//! is dropping a scan set to make a deletion compile — an empty scan set is a vacuous
//! guard, which `assert_all_present` exists to prevent.
//!
//! The guard is un-gameable: it strips comments AND `#[cfg(test)]` blocks, so a token
//! can only pass by genuinely NOT being in production code. Reintroduce a retired wire
//! → this FAILS.
//!
//! `#[cfg(test)]`-only (declared `#[cfg(test)] mod no_legacy_wire;` in the parent) so it
//! runs under `cargo test --lib -- workstore::` and ships no production code.

use std::path::{Path, PathBuf};

/// Return each production (non-comment, non-`#[cfg(test)]`) line of `src` as
/// `(1-based line number, code-only text)`. Inline `//` comments are cut; whole
/// `#[cfg(test)]` `{…}` blocks are skipped (brace-tracked). This is what makes the
/// guard reflect PRODUCTION code only — a token in a comment or a test block is not a
/// regression (mirrors the kinds guard excluding test dirs, at line granularity).
fn production_lines(src: &str) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    let mut pending_cfg_test = false; // saw `#[cfg(test)]`, awaiting the block's `{`
    let mut test_depth: i32 = 0; // brace depth inside an active cfg(test) block
    let mut in_test = false;

    for (i, raw) in src.lines().enumerate() {
        // Strip an inline / full-line `//` comment (doc `///`/`//!` included).
        let code = match raw.find("//") {
            Some(idx) => &raw[..idx],
            None => raw,
        };
        let trimmed = code.trim();

        if in_test {
            for ch in code.chars() {
                match ch {
                    '{' => test_depth += 1,
                    '}' => {
                        test_depth -= 1;
                        if test_depth <= 0 {
                            in_test = false;
                        }
                    }
                    _ => {}
                }
            }
            continue; // never scan a line inside a cfg(test) block
        }

        if pending_cfg_test {
            // Consume up to the block-opening `{` (attribute may sit on its own line).
            let opens = code.matches('{').count() as i32;
            let closes = code.matches('}').count() as i32;
            if opens > 0 {
                pending_cfg_test = false;
                test_depth = opens - closes;
                if test_depth > 0 {
                    in_test = true;
                }
                // a same-line `#[cfg(test)] fn x() {}` with balanced braces → not in_test
            }
            continue;
        }

        if trimmed.contains("#[cfg(test)]") || trimmed.contains("#[cfg(all(test") {
            pending_cfg_test = true;
            continue;
        }

        if trimmed.is_empty() {
            continue;
        }
        out.push((i + 1, code.to_string()));
    }
    out
}

fn scan(files: &[PathBuf], needles: &[&str]) -> Vec<String> {
    let mut hits = Vec::new();
    for f in files {
        let src = std::fs::read_to_string(f)
            .unwrap_or_else(|e| panic!("read guarded file {}: {e}", f.display()));
        for (n, line) in production_lines(&src) {
            for needle in needles {
                if line.contains(needle) {
                    hits.push(format!(
                        "{}:{}: [{}] {}",
                        f.display(),
                        n,
                        needle,
                        line.trim()
                    ));
                }
            }
        }
    }
    hits
}

fn server_root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
}

/// Every scanned path must EXIST. This is the anti-vacuity backstop: the scan sets
/// below are hard-coded, so a rename/deletion would otherwise leave the guard reading
/// zero files and still reporting green. It replaces a bare `files.len() >= N` floor,
/// which counted files without checking that any of them were the intended ones — and
/// which rotted the moment a scanned surface was legitimately deleted (ITEM-13).
fn assert_all_present(files: &[PathBuf]) {
    let missing: Vec<String> = files
        .iter()
        .filter(|f| !f.is_file())
        .map(|f| f.display().to_string())
        .collect();
    assert!(
        missing.is_empty(),
        "a guarded path no longer exists, so this guard was about to scan less than it \
         claims — re-point it, or drop it from the scan set deliberately (as ITEM-13 did \
         when it deleted the native array reader):\n{}",
        missing.join("\n")
    );
}

/// The serve DECISION path — the surface that must stay domain-free (INV-1).
///
/// Post-ITEM-12 that is the ROUTE TABLE plus the byte-Range parser: `routes.rs` decides
/// which URL reaches the byte plane, `range.rs` decides which bytes come back. Between
/// them they are the whole "what do we serve" decision, and a `single-cell/…` datatype
/// id or a kind name in either would mean the byte plane learned a domain.
///
/// Two surfaces this used to name are gone rather than excused:
/// - `tiledb_serve`'s generic reader — deleted by ITEM-13.
/// - `serve_core.rs` — deleted by ITEM-12. It was the ONE place a decode DECISION lived
///   (`route(artifact) -> ServeBackend`, the Selection grammar, the tier fallback), which
///   is exactly why it was the scan target. With it gone the decision it made does not
///   exist to be domain-tainted; the class of regression the guard names now lands in
///   these two files instead, so this is a re-point, not a shrink.
///
/// `data_api.rs` remains DELIBERATELY excluded — unchanged reason: it carries the
/// `#[cfg(debug_assertions)]` e2e-seed layer, which legitimately names datatypes to build
/// fixtures. A seed is not a serve decision. (It is still scanned by
/// [`wire_surface_files`] for retired-wire tokens, which carry no such exemption.)
fn serve_domain_files() -> Vec<PathBuf> {
    let root = server_root();
    vec![
        root.join("src/modules/workstore/routes.rs"),
        root.join("src/modules/workstore/range.rs"),
    ]
}

/// The broader PRODUCTION wire surface a retired-wire token must not reappear in.
/// `serve_core.rs` + `artifact/coo.rs` left this list because ITEM-12 DELETED them; every
/// other file stays, and `range.rs` joins as the surviving byte-serve implementation.
fn wire_surface_files() -> Vec<PathBuf> {
    let root = server_root();
    vec![
        root.join("src/modules/workstore/data_api.rs"),
        root.join("src/modules/workstore/routes.rs"),
        root.join("src/modules/workstore/range.rs"),
        root.join("src/modules/workstore/config.rs"),
        root.join("src/modules/workstore/ingest.rs"),
        root.join("src/modules/workstore/artifact/mod.rs"),
        root.join("src/modules/datatype/convert.rs"),
    ]
}

// ── TEST-2 + TEST-6 — the serve path is domain/kind-free (INV-1) ──────────────────
#[test]
fn serve_path_is_domain_free() {
    // Domain datatype-id + zero-core kind-name literals. The slash-compounds match as raw
    // substrings with zero false positives. `embedding`/`trajectory`/`expression` are bare
    // DOMAIN nouns INV-1's prose also forbids in the serve core — they are long enough not
    // to over-match (unlike a bare `de`/`matrix`, which appear as substrings of `index`/
    // `decode`/`format`), and are verified absent from serve-core CODE today, so adding
    // them CATCHES a future bare-domain leak the slash-compound-only list would miss (L2).
    let domain_literals = [
        "single-cell/",
        "geneset/collection",
        "graph/attributed",
        "de/result",
        "embedding",
        "trajectory",
        "expression",
    ];
    let files = serve_domain_files();
    assert_all_present(&files);
    let leaks = scan(&files, &domain_literals);
    assert!(
        leaks.is_empty(),
        "INV-1 violated: a domain/datatype/kind literal leaked into the serve path — it \
         resolves a member PATH and a byte RANGE, and nothing else:\n{}",
        leaks.join("\n")
    );
}

// ── TEST-24 — the retired bespoke wire is gone from PRODUCTION code ────────────────
#[test]
fn no_legacy_wire_in_production() {
    // The retired-wire tokens, in two generations.
    //
    // (1) The typed-binary generation, retired in S5b. `encode_sparse_column`/
    //     `csc_column_slice` no longer exist at all (ITEM-12 deleted `legacy_oracle`
    //     with the serve arm it was an oracle for), so these are now pure tripwires.
    // (2) The Selection→Arrow generation, retired by artifact-model ITEM-12. `/read`
    //     was the surface the S5b comment called "the sole Tier-2 wire"; it is now
    //     itself a retired wire, and its whole vocabulary is denied so it cannot come
    //     back one helper at a time. `arrow::`/`arrow_ipc` are spelled WITH their path
    //     separator on purpose — a bare `arrow` is a substring of `narrow`, and a guard
    //     that fires on an English word gets disabled by the next person who trips it.
    //
    // The mechanical twin of the arrow tokens is `scripts/check-no-format-crates.sh`,
    // which denies the crate at the dependency-graph level; these catch a re-import in
    // the specific files that would matter first.
    let legacy_tokens = [
        // (1) typed-binary
        "encode_sparse_column",
        "encode_dense_f32",
        "csc_column_slice",
        "de_page",
        "slice_artifact",
        "SparseColumn",
        "x-workstore-dtype",
        "x-workstore-shape",
        "typed_binary",
        // (2) Selection→Arrow (ITEM-12)
        "serve_artifact_read",
        "serve_selection",
        "ReadSelection",
        "DimSelection",
        "ipc_stream_chunks",
        "RecordBatch",
        "arrow::",
        "arrow_ipc",
        "Tier2LayoutSlice",
    ];
    let files = wire_surface_files();
    assert_all_present(&files);
    let leaks = scan(&files, &legacy_tokens);
    assert!(
        leaks.is_empty(),
        "TEST-24 violated: a retired read wire reappeared in PRODUCTION code. \
         `GET /artifacts/{{id}}/data[/{{*member}}]` is the ONLY read surface (INV-1): it \
         serves opaque byte ranges and the client decodes. The bespoke /de + /slice + \
         typed-binary wires AND the Selection→Arrow /read wire are all retired:\n{}",
        leaks.join("\n")
    );
}

// ── meta: the guard actually catches a reintroduction (proves it isn't vacuous) ───
#[test]
fn guard_flags_a_reintroduced_token() {
    // A synthetic production file with a legacy token in LIVE code is flagged…
    let live = "fn handler() {\n    let h = \"x-workstore-dtype\";\n}\n";
    let tmp = std::env::temp_dir().join(format!("no_legacy_wire_probe_{}.rs", std::process::id()));
    std::fs::write(&tmp, live).unwrap();
    let hits = scan(&[tmp.clone()], &["x-workstore-dtype"]);
    assert_eq!(hits.len(), 1, "a live legacy token MUST be flagged");

    // …but the SAME token in a comment or a #[cfg(test)] block is NOT (sanctioned).
    let excused = "// x-workstore-dtype in a comment\n#[cfg(test)]\nmod t {\n    let h = \"x-workstore-dtype\";\n}\n";
    std::fs::write(&tmp, excused).unwrap();
    let none = scan(&[tmp.clone()], &["x-workstore-dtype"]);
    assert!(
        none.is_empty(),
        "a comment / cfg(test) token must NOT be flagged: {none:?}"
    );
    let _ = std::fs::remove_file(&tmp);
}
