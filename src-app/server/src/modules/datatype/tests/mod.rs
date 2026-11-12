//! The Rust half of the Rust↔TS golden parity gate (ITEM-7/TEST-18). Mirrors
//! `txresbench-framework openapi/emit_ts.rs::generator_golden_fixture`: read the committed
//! shared fixture, rebuild the registry from the real seed, and assert every
//! `is_a`/`accepts`/`viewers_for` case matches. The FE e2e reads the SAME file — one
//! source of truth prevents host-gating ↔ UI-picker drift.
//!
//! ## The lattice SHAPE is DERIVED, not frozen (docs/design/derived-guards.md §4)
//!
//! The golden used to carry a `lattice` array of every type in the registry, asserted
//! with `assert_eq!(reg.len(), lattice.len())`. That made the fixture an ENUMERATION of
//! a set the package tree contributes to, so contributing a datatype — the thing the
//! package system exists to make free — forced an edit to a file under
//! `src-app/server/src/`. The zero-core invariant and that assertion were mutually
//! unsatisfiable for any new datatype, and the `differential-expression` guard had
//! already grown an allowlist entry for exactly this file to work around it.
//!
//! The `lattice` key is gone. What replaces it is a stronger claim, computed from the
//! two DECLARATIONS the registry itself is built from:
//!
//!   expected = ids(`DatatypeRegistry::build_from_slice()`)          // the Rust roots
//!            ∪ every `contributes.datatypes[].id` in every
//!              `src-app/packages/*/manifest.yaml`                   // the DATA
//!
//! and the merged registry must equal that set exactly, with `extends`/`is_abstract`
//! matching what each manifest DECLARES. The manifests are re-read here as untyped
//! YAML rather than through `ExtensionManifest`, so this cross-checks two independent
//! readings instead of asserting the registry equals itself.
//!
//! ## What the derivation does and does NOT catch (corrected after a mutation audit)
//!
//! An earlier version of this comment claimed the derivation was "strictly stronger" than
//! the count it replaced. **That was wrong, and it was wrong in the direction that matters
//! for a golden.** A blind audit deleted a shipped datatype's whole declaration, forced a
//! full recompile, and every test here stayed GREEN — because `declared_datatypes` re-reads
//! the same manifests the registry is built from, so on a DECLARATION-side change both
//! sides move together. The frozen `lattice` array did catch that (26 -> 25).
//!
//! So the two halves are complementary, not a replacement:
//!
//! * the DERIVATION (this function's set comparison) cross-checks declared-vs-LOADED. It
//!   catches a declared type that never loaded — a package silently skipped at load time,
//!   which is a live defect (tinnlab/txresbench#197) that a count cannot see at all — and
//!   a registry entry declared nowhere. It costs no edit when a package is contributed,
//!   which is what makes INV-3 satisfiable.
//! * the FROZEN halves — `MIN_*` floors below, and the `is_a` / `accepts` / `viewers_for` /
//!   `layout_kind` case tables — catch a declaration being REMOVED or REPOINTED. They cost
//!   an edit per COVERED type, and none when a new type is added.
//!
//! The floors are the companion `docs/design/derived-guards.md` §2 prescribes for any
//! derived set, and they were missing in the first cut of this file. They are SHRINK
//! detectors, not enumerations: adding a datatype never touches them; removing one fails.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use crate::modules::datatype::registry::DatatypeRegistry;
use crate::modules::datatype::types::TypeSelector;

/// What a package manifest DECLARES about one contributed datatype.
#[derive(Debug, PartialEq, Eq)]
struct DeclaredType {
    extends: Option<String>,
    is_abstract: bool,
    /// The package folder that declared it — named only in failure messages.
    package: String,
}

/// The in-tree package source directory (`$CARGO_MANIFEST_DIR/../packages`) — the same
/// tree `extensions::embedded.rs` embeds as the seed.
fn packages_root() -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../packages"))
}

/// Every datatype DECLARED by every package manifest under `root`.
///
/// Deliberately parses to an untyped `serde_json::Value` through the runtime's own YAML
/// parser: reading the manifests through `ExtensionManifest` would make the comparison
/// a restatement of the loader rather than a check on it.
///
/// Mirrors `ExtensionRegistry::scan_dir`'s discovery rules — hidden (`.`) and reserved
/// (`_`) folders are not contributing packages, and a folder with no `manifest.yaml` is
/// not a package at all. A reserved package that DOES declare a datatype is a hard
/// failure here rather than a silent under-count: the scan would drop it.
///
/// ## Stated divergence from `scan_dir` (round-1 audit)
///
/// Independent PARSING is the point of this function and is deliberate. Independent
/// DISCOVERY is not a feature — it is a second copy of the loader's folder rules that
/// nothing keeps in sync, and it ALREADY diverges: `scan_dir` has a fourth rule this does
/// not, the SEED-ONLY (M8) filter, which restricts the scan to baked-seed ids when
/// `TXR_PROCESSOR_SEED_ONLY` is set. That is safe here only because the env var is off by
/// default and both sides then read the same tree — with it SET, this function still sees
/// every folder while the registry sees fewer, so `lattice_golden_fixture` fails LOUDLY
/// (a false red, not a false green). A fifth rule added to `scan_dir` would diverge the
/// same way; the failure direction is what makes that tolerable rather than the mirroring.
fn declared_datatypes(root: &Path) -> BTreeMap<String, DeclaredType> {
    let mut out: BTreeMap<String, DeclaredType> = BTreeMap::new();
    let entries = std::fs::read_dir(root)
        .unwrap_or_else(|e| panic!("cannot scan packages dir `{}`: {e}", root.display()));
    let mut dirs: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();

    for dir in dirs {
        let name = dir
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
        if name.starts_with('.') {
            continue;
        }
        let manifest = dir.join("manifest.yaml");
        if !manifest.is_file() {
            continue;
        }
        let text = std::fs::read_to_string(&manifest)
            .unwrap_or_else(|e| panic!("read {}: {e}", manifest.display()));
        let doc: serde_json::Value = serde_norway::from_str(&text)
            .unwrap_or_else(|e| panic!("{} is not valid YAML: {e}", manifest.display()));
        let declared = doc
            .get("contributes")
            .and_then(|c| c.get("datatypes"))
            .and_then(|d| d.as_array())
            .cloned()
            .unwrap_or_default();

        if name.starts_with('_') {
            assert!(
                declared.is_empty(),
                "reserved package `{name}` declares {} datatype(s); `scan_dir` skips \
                 `_`-prefixed folders, so those contributions would be silently dropped",
                declared.len()
            );
            continue;
        }

        for dt in declared {
            let id = dt
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or_else(|| panic!("{} declares a datatype with no `id`", manifest.display()))
                .to_string();
            let entry = DeclaredType {
                extends: dt
                    .get("extends")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                is_abstract: dt
                    .get("is_abstract")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
                package: name.clone(),
            };
            if let Some(prev) = out.insert(id.clone(), entry) {
                panic!(
                    "datatype `{id}` is declared twice — by `{}` and by `{name}`",
                    prev.package
                );
            }
        }
    }
    out
}

/// The universal ROOT ids, read from the Rust declaration (`#[distributed_slice(DATATYPES)]`)
/// rather than from a copy of it.
fn root_datatype_ids() -> BTreeSet<String> {
    DatatypeRegistry::build_from_slice()
        .expect("the Rust root lattice builds")
        .all()
        .iter()
        .map(|d| d.id.clone())
        .collect()
}

/// TEST-8 — the lattice SHAPE is DERIVED (roots ∪ declared), never a frozen count.
/// The anti-vacuity floors for the DERIVED sets, measured on this tree (2026-09-02) and
/// set with margin so they detect a COLLAPSE rather than track the lattice.
///
/// They are the missing companion `docs/design/derived-guards.md` §2 prescribes: every
/// assertion below is over a walked/derived set, so a walk that silently collapses (a
/// moved `packages_root()`, a renamed `contributes.datatypes` key, a package tree that
/// failed to check out) turns the comparison green rather than red. Being a FLOOR rather
/// than an equality is what keeps them compatible with INV-3 — contributing a datatype
/// only ever moves the real number UP, so no edit is needed here; REMOVING one is what
/// they are here to refuse.
mod floors {
    /// Measured 20 contributed datatypes; floor with margin.
    pub const MIN_CONTRIBUTED_DATATYPES: usize = 18;
    /// Measured 3 packages contributing at least one datatype (`anndata-import`,
    /// `open-kinds`, `single-cell-types`).
    pub const MIN_CONTRIBUTING_PACKAGES: usize = 3;
    /// Measured 26 = 6 Rust roots + 20 contributed. This is the direct successor of the
    /// deleted `assert_eq!(reg.len(), lattice.len())`, weakened from an EQUALITY to a
    /// floor precisely so that adding a datatype costs no edit while losing one still
    /// fails.
    pub const MIN_TOTAL_DATATYPES: usize = 26;
    /// Measured case-table sizes: is_a 50, accepts 31, viewers_for 12, layout_kind 17.
    /// Floored at ~2/3, the calibration `domain_surface/mod.rs` uses, so a truncation is
    /// caught but a legitimate single-row deletion is not a tripwire.
    pub const MIN_IS_A: usize = 33;
    pub const MIN_ACCEPTS: usize = 20;
    pub const MIN_VIEWERS_FOR: usize = 8;
    pub const MIN_LAYOUT_KIND: usize = 11;
}

/// The DERIVED expectation: the Rust roots ∪ every datatype declared by any package
/// manifest under `root`. Shared by `lattice_golden_fixture` (over the real tree) and by
/// the INV-3 acceptance test (over a scratch tree holding a brand-new package), so the
/// acceptance test drives the REAL comparison rather than a hand-rolled restatement of it.
fn expected_and_actual(
    root: &Path,
    reg: &DatatypeRegistry,
) -> (BTreeSet<String>, BTreeSet<String>, BTreeMap<String, DeclaredType>) {
    let roots = root_datatype_ids();
    let declared = declared_datatypes(root);
    let mut expected: BTreeSet<String> = roots.clone();
    for id in declared.keys() {
        assert!(
            !roots.contains(id),
            "manifest-contributed datatype `{id}` collides with a Rust root id"
        );
        expected.insert(id.clone());
    }
    let actual: BTreeSet<String> = reg.all().iter().map(|d| d.id.clone()).collect();
    (expected, actual, declared)
}

/// Assert the derived expectation and the loaded registry agree, in BOTH directions, and
/// that every declared type's `extends` / `is_abstract` matches its declaration.
fn assert_derivation_holds(
    expected: &BTreeSet<String>,
    actual: &BTreeSet<String>,
    declared: &BTreeMap<String, DeclaredType>,
    reg: &DatatypeRegistry,
) {
    let missing: Vec<&String> = expected.difference(actual).collect();
    assert!(
        missing.is_empty(),
        "these datatypes are DECLARED but are NOT in the loaded registry: {missing:?}.          A declared type that does not load means its package was skipped at load time          (see `ExtensionRegistry::scan_dir`), which registers nothing and, before this          assertion existed, left every gate green (tinnlab/txresbench#197)."
    );
    let unexpected: Vec<&String> = actual.difference(expected).collect();
    assert!(
        unexpected.is_empty(),
        "these datatypes are in the loaded registry but are declared NOWHERE          (neither a Rust root nor a package manifest): {unexpected:?}"
    );
    for (id, want) in declared {
        let dt = reg
            .get(id)
            .unwrap_or_else(|| panic!("declared type `{id}` missing from the registry"));
        assert_eq!(
            dt.extends.as_deref(),
            want.extends.as_deref(),
            "`extends` mismatch for `{id}` (declared by `{}`)",
            want.package
        );
        assert_eq!(
            dt.is_abstract, want.is_abstract,
            "`is_abstract` mismatch for `{id}` (declared by `{}`)",
            want.package
        );
    }
}

/// TEST-8 (floor leg) — the DERIVED sets may not collapse.
///
/// Separate from `lattice_golden_fixture` so a collapse is reported as its own named
/// failure rather than as a confusing "everything matched" pass.
#[test]
fn the_derived_sets_have_not_collapsed() {
    let declared = declared_datatypes(&packages_root());
    assert!(
        declared.len() >= floors::MIN_CONTRIBUTED_DATATYPES,
        "only {} contributed datatype(s) were DERIVED from src-app/packages/*/manifest.yaml,          below the floor of {}. Either the walk collapsed (a moved root, a renamed          `contributes.datatypes` key) — in which case every derived assertion in this module          was about to pass having compared almost nothing — or a shipped datatype was          REMOVED, which is the change this floor exists to make visible.",
        declared.len(),
        floors::MIN_CONTRIBUTED_DATATYPES
    );
    let packages: BTreeSet<&str> = declared.values().map(|d| d.package.as_str()).collect();
    assert!(
        packages.len() >= floors::MIN_CONTRIBUTING_PACKAGES,
        "only {} package(s) contribute a datatype, below the floor of {}: {packages:?}",
        packages.len(),
        floors::MIN_CONTRIBUTING_PACKAGES
    );
    let reg = DatatypeRegistry::build_from_embedded().expect("merged lattice builds");
    assert!(
        reg.len() >= floors::MIN_TOTAL_DATATYPES,
        "the merged registry holds {} datatype(s), below the floor of {}. This is the          successor of the deleted exact-count assertion, weakened to a floor so that ADDING          a datatype costs no edit under src-app/server/src/ (INV-3) while LOSING one still          fails — the direction the derivation alone cannot see, because it re-reads the same          manifests the registry is built from.",
        reg.len(),
        floors::MIN_TOTAL_DATATYPES
    );
}

#[test]
fn lattice_golden_fixture() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/modules/datatype/tests/lattice_golden.json"
    );
    let raw = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    let golden: serde_json::Value = serde_json::from_str(&raw).expect("golden is valid JSON");
    // Build the MERGED registry exactly as boot does: the Rust roots ∪ the
    // manifest-contributed domain types.
    let reg = DatatypeRegistry::build_from_embedded().expect("merged lattice builds");

    // --- lattice: the registry equals roots ∪ declared, both directions, DERIVED ---
    let (expected, actual, declared) = expected_and_actual(&packages_root(), &reg);
    assert_derivation_holds(&expected, &actual, &declared, &reg);

    // --- the FROZEN half: the case tables may not be truncated ---
    // Floors, not equalities: a new datatype adds no row, so this costs no edit (INV-3),
    // while a table quietly emptied by a bad edit fails instead of passing vacuously.
    for (table, floor) in [
        ("is_a", floors::MIN_IS_A),
        ("accepts", floors::MIN_ACCEPTS),
        ("viewers_for", floors::MIN_VIEWERS_FOR),
        ("layout_kind", floors::MIN_LAYOUT_KIND),
    ] {
        let n = golden[table].as_array().map(|a| a.len()).unwrap_or(0);
        assert!(
            n >= floor,
            "the golden's `{table}` case table holds {n} row(s), below the floor of {floor}"
        );
    }

    // --- is_a ---
    for c in golden["is_a"].as_array().unwrap() {
        let got = reg.is_a(c["sub"].as_str().unwrap(), c["sup"].as_str().unwrap());
        assert_eq!(got, c["expect"].as_bool().unwrap(), "is_a case {c}");
    }

    // --- accepts (matches) ---
    for c in golden["accepts"].as_array().unwrap() {
        let sel: TypeSelector =
            serde_json::from_value(c["selector"].clone()).expect("selector deserializes");
        let got = reg.matches(c["datatype"].as_str().unwrap(), &sel);
        assert_eq!(got, c["expect"].as_bool().unwrap(), "accepts case {c}");
    }

    // --- viewers_for (up the lattice) — EXACT ordered list, so a divergent/extra/
    //     re-ordered viewer between Rust and TS fails the gate (not just containment).
    for c in golden["viewers_for"].as_array().unwrap() {
        let dt = c["datatype"].as_str().unwrap();
        let want: Vec<String> = c["expect"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        let ids: Vec<String> = reg
            .viewers_for(dt)
            .iter()
            .map(|v| v.view_kind_id.clone())
            .collect();
        assert_eq!(ids, want, "viewers_for(`{dt}`) exact list");
    }

    // --- layout.kind wire value — the serde tag the FE deserializes; guards the
    //     `chunked_1d` class of rename bug the golden previously did not cover.
    for c in golden["layout_kind"].as_array().unwrap() {
        let dt = c["datatype"].as_str().unwrap();
        let want = c["expect"].as_str().unwrap();
        let d = reg.get(dt).unwrap();
        // Serialize the datatype and read storage.layout.kind exactly as the wire ships it.
        let wire = serde_json::to_value(d).unwrap();
        assert_eq!(
            wire["storage"]["layout"]["kind"].as_str().unwrap(),
            want,
            "layout.kind wire tag for `{dt}`"
        );
    }
}

// TEST-21 [ITEM-4, INV-5] — the seed registry's `geneset/collection` `metadata` array declares
// the three provenance/consumer attrs (kind/origin/data_driven) beyond name/description/collection
// (GS-INV-12). The lattice golden captures only id/extends/is_abstract, not per-array attrs, so
// this asserts the declared-attr conformance the golden cannot (see .lifecycle IMPL_NOTES).
#[test]
fn geneset_collection_metadata_declares_provenance_attrs() {
    let reg = DatatypeRegistry::build_from_embedded().expect("merged lattice builds");
    let dt = reg
        .get("geneset/collection")
        .expect("geneset/collection is in the seed registry");
    let metadata = dt
        .arrays
        .iter()
        .find(|a| a.name == "metadata")
        .expect("geneset/collection declares a `metadata` array");
    let attrs: Vec<&str> = metadata.attrs.iter().map(|a| a.name.as_str()).collect();
    for want in ["name", "description", "collection", "kind", "origin", "data_driven"] {
        assert!(
            attrs.contains(&want),
            "metadata attr `{want}` missing (have {attrs:?})"
        );
    }
    // `data_driven` is the boolean flag (GS-INV-2/12) — declared as `bool`.
    let dd = metadata
        .attrs
        .iter()
        .find(|a| a.name == "data_driven")
        .unwrap();
    assert_eq!(dd.dtype, "bool", "data_driven is a bool attr");
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-7 [acceptance] [invariant: INV-3] — contributing a datatype costs ZERO edits
// under `src-app/server/src/`.
//
// The D2 form of the proof: it drives a datatype this tree has NEVER seen, through the
// real load path, rather than asserting that the datatypes which happen to be shipped
// work.
//
// It runs the SAME `expected_and_actual` / `assert_derivation_holds` pair that
// `lattice_golden_fixture` runs, over a scratch tree containing the new package — so the
// production comparison is exercised against a type it has never seen, instead of the
// test hand-rolling a narrower restatement of it. (A round-1 audit caught exactly that:
// the first cut checked `reg.get(ID)` and `declared.get(ID)` separately and never ran the
// set difference at all.)
//
// What this test does NOT prove, stated so the next reader does not over-trust it: it
// never reads `lattice_golden.json`, so re-freezing that fixture would not turn it red.
// `the_shared_golden_holds_case_tables_and_no_frozen_lattice` is the test that would.
// ─────────────────────────────────────────────────────────────────────────────────

/// A scratch directory that removes itself, so the acceptance test needs no new
/// dev-dependency. Mirrors the temp-dir discipline in `extensions::embedded.rs`
/// (unique-per-process suffix + explicit cleanup).
struct ScratchDir(PathBuf);

impl ScratchDir {
    fn new(tag: &str) -> Self {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let p = std::env::temp_dir().join(format!(
            "txr-{tag}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).expect("create scratch dir");
        Self(p)
    }
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn a_contributed_datatype_needs_no_server_src_edit() {
    // A package that does not exist in this tree, declaring a datatype that does not
    // exist in this tree. Nothing about it is known to any committed file.
    const PKG: &str = "acceptance-probe";
    const ID: &str = "acceptance-probe/kind";

    // ENV DEPENDENCY, stated: `build_from_dir` consults `seed_only_enabled()`
    // (`TXR_PROCESSOR_SEED_ONLY`). With it set, the scan ignores any folder whose id is
    // not a baked-seed package, so this probe would not register and the test fails. That
    // is a false RED, not a false green, and the variable is a deploy-level kill switch
    // that is off by default — but it is an ambient input to an otherwise hermetic test,
    // so it is named here rather than discovered by whoever hits it.
    let scratch = ScratchDir::new("zero-core-acceptance");
    let pkg_dir = scratch.path().join(PKG);
    std::fs::create_dir_all(&pkg_dir).expect("create probe package dir");
    std::fs::write(
        pkg_dir.join("manifest.yaml"),
        format!(
            "id: {PKG}\n\
             name: Zero-core acceptance probe\n\
             publisher: txr\n\
             version: 0.1.0\n\
             apiVersion: \"1.0\"\n\
             contributes:\n\
             \x20 datatypes:\n\
             \x20   - id: {ID}\n\
             \x20     extends: matrix\n\
             \x20     title: Zero-core acceptance probe kind\n\
             \x20     description: A datatype contributed purely as DATA.\n\
             \x20     is_abstract: false\n\
             \x20     schema:\n\
             \x20       type: object\n\
             \x20       properties: {{}}\n\
             \x20     storage:\n\
             \x20       layout:\n\
             \x20         kind: chunked_sparse\n\
             \x20         orientation: csc\n\
             \x20       format: zarr\n\
             \x20       file_layout: single\n"
        ),
    )
    .expect("write probe manifest");

    // 1. It LOADS through the real path — the same dir-scan + cross-package resolution
    //    boot runs, folded onto the Rust roots.
    let extra = crate::modules::extensions::contributed_datatypes_from_embedded_in(scratch.path())
        .expect("the probe package tree scans");
    let reg = DatatypeRegistry::build_merged(extra).expect("the merged lattice builds");
    let dt = reg.get(ID).unwrap_or_else(|| {
        panic!("`{ID}` was declared as DATA but did not register — a package that fails to \
                load registers NOTHING and every gate stays green")
    });
    assert_eq!(dt.extends.as_deref(), Some("matrix"));
    assert!(reg.is_a(ID, "matrix"), "the contributed type joins the lattice");

    // 2. The PRODUCTION derivation covers it with no edit. Not a restatement — the exact
    //    functions `lattice_golden_fixture` calls, run over a tree whose only package is
    //    one this repository has never contained.
    let (expected, actual, declared) = expected_and_actual(scratch.path(), &reg);
    assert!(
        expected.contains(ID) && actual.contains(ID),
        "the derivation did not cover `{ID}`: expected={expected:?} actual={actual:?}"
    );
    assert_derivation_holds(&expected, &actual, &declared, &reg);

    // 3. And no PRODUCTION file under `src-app/server/src/` knows about it — the
    //    zero-core claim, asserted rather than assumed.
    //
    //    TEST code is excluded STRUCTURALLY, by path segment, never by naming a file —
    //    the same rule `scripts/check-derived-vocabulary.sh` applies to itself and for
    //    the same reason: a grep-guard that must SPELL the vocabulary it searches for
    //    is otherwise its own first hit. (It is: this very module names `ID`, and the
    //    first run of this assertion reported itself.) A dispatch cannot be hidden in a
    //    test, because a test cannot be reached from production code.
    //
    //    KNOWN BREADTH (round-1 audit): the segment list is wider than "not production" —
    //    a production module living under a directory called `tests`, `testdata` or
    //    `fixtures` would be invisible here. No such module exists today, and the
    //    alternative (naming files) is the failure this exclusion avoids, so the breadth
    //    is accepted and recorded rather than narrowed by guesswork.
    let server_src = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/src"));
    let mut hits: Vec<String> = Vec::new();
    fn is_test_path(p: &Path) -> bool {
        p.components().any(|c| {
            matches!(
                c.as_os_str().to_str(),
                Some("tests") | Some("testdata") | Some("fixtures")
            )
        })
    }
    fn scan(dir: &Path, needle: &str, hits: &mut Vec<String>, scanned: &mut usize) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for e in entries.flatten() {
            let p = e.path();
            if is_test_path(&p) {
                continue;
            }
            if p.is_dir() {
                scan(&p, needle, hits, scanned);
            } else if let Ok(t) = std::fs::read_to_string(&p) {
                *scanned += 1;
                if t.contains(needle) {
                    hits.push(p.display().to_string());
                }
            }
        }
    }
    let mut scanned = 0usize;
    scan(&server_src, ID, &mut hits, &mut scanned);

    // ANTI-VACUITY FLOOR. This assertion is over a WALKED set, so a walk that silently
    // collapses (a moved root, a broken exclusion) turns it green rather than red.
    // Measured 2026-09-02: 298 files under `server/src` after removing any path with a
    // `tests` / `testdata` / `fixtures` component —
    //   find src -type f | grep -vE '(^|/)(tests|testdata|fixtures)(/|$)' | wc -l
    // so the method is re-runnable rather than remembered. (The first cut of this comment
    // said "~400", which was wrong on the day it was written — the same stale-prose failure
    // this module's header quotes as its cautionary example. Re-derive it, do not trust it.)
    const MIN_SCANNED: usize = 150;
    assert!(
        scanned >= MIN_SCANNED,
        "the zero-core scan walked only {scanned} production file(s) under \
         src-app/server/src/, below the floor of {MIN_SCANNED} — the walk collapsed, so \
         this assertion was about to pass having checked almost nothing"
    );

    // DETECTION CONTROL. The floor proves the walk REACHED enough files; it does not prove
    // the walk can SEE a string that is there. Without this, a `scan` whose `contains` arm
    // was broken would report "no hits" forever. `DatatypeRegistry` is defined under
    // `server/src` and cannot move out of it without this control failing loudly.
    let mut control: Vec<String> = Vec::new();
    let mut control_scanned = 0usize;
    scan(&server_src, "DatatypeRegistry", &mut control, &mut control_scanned);
    assert!(
        !control.is_empty(),
        "the zero-core scan found no occurrence of a token that is certainly present under \
         src-app/server/src/, so its matcher is broken and its absence assertion below is \
         vacuous"
    );

    // The claim, stated narrowly: NO PRODUCTION FILE under `src-app/server/src/` names this
    // datatype. It is deliberately a weak-but-true statement — the id is invented by this
    // test, so nothing could name it — and it is here as a REGRESSION tripwire for the day
    // someone "fixes" a contribution by adding a branch keyed on an id, not as proof on its
    // own. The load-bearing INV-3 proof is legs 1 and 2 above.
    assert!(
        hits.is_empty(),
        "`{ID}` is named under src-app/server/src/ — contributing a datatype must cost \
         zero core edits (INV-3): {hits:?}"
    );
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-9 — the shared fixture may not re-grow a frozen enumeration, and may not be
// silently emptied either.
// ─────────────────────────────────────────────────────────────────────────────────

#[test]
fn the_shared_golden_holds_case_tables_and_no_frozen_lattice() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/modules/datatype/tests/lattice_golden.json"
    );
    let raw = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    let golden: serde_json::Value = serde_json::from_str(&raw).expect("golden is valid JSON");

    // Assert the KEY SET, not the absence of one name. A round-1 audit pointed out that
    // `golden.get("lattice").is_none()` satisfies the letter while missing the intent: the
    // identical 26-entry array could return under `types`, `seed`, or `all_datatypes` and
    // pass. An exact key set refuses every spelling, and refuses a new frozen enumeration
    // under any future name — which is the property §4 actually asks for.
    const ALLOWED_KEYS: &[&str] = &["_comment", "is_a", "accepts", "viewers_for", "layout_kind"];
    let keys: BTreeSet<String> = golden
        .as_object()
        .expect("the golden is a JSON object")
        .keys()
        .cloned()
        .collect();
    let want: BTreeSet<String> = ALLOWED_KEYS.iter().map(|k| k.to_string()).collect();
    assert_eq!(
        keys, want,
        "the golden's top-level keys changed. An ADDED key is very likely a re-frozen \
         enumeration of the type set (the deleted `lattice` array, under a new name), which \
         makes contributing a datatype cost an edit under src-app/server/src/ — the defect \
         docs/design/derived-guards.md §4 exists to prevent. A REMOVED key means a case \
         table was dropped. Either way this is a deliberate decision, not a drive-by edit."
    );

    // The behavioural case tables are enumerated CASES over the lattice, not an
    // enumeration OF it — adding a datatype does not invalidate them, so they stay. A
    // fixture emptied by a bad edit must fail here rather than pass vacuously (the FE
    // e2e reads these same four tables).
    for table in ["is_a", "accepts", "viewers_for", "layout_kind"] {
        let arr = golden
            .get(table)
            .and_then(|v| v.as_array())
            .unwrap_or_else(|| panic!("the golden lost its `{table}` case table"));
        assert!(!arr.is_empty(), "the golden's `{table}` case table is empty");
    }
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-13 — the SILENT-SKIP reproduction, and the proof that the derivation DETECTS it.
//
// tinnlab/txresbench#197. A package whose datatype `extends:` a supertype owned by
// ANOTHER package is rejected at load time by the PER-package lint
// (`lint_processor_package` resolves `extends` against the roots ∪ that one package's
// own ids), so it is skipped and registers nothing — while `build.rs`'s CROSS-package
// lint passes it and every gate stays green. Measured on this tree: the same probe
// extending `single-cell/expression` (owned by `single-cell-types`) yields a 26-type
// registry and a GREEN suite; extending the root `matrix` yields 27.
//
// This test does NOT fix that — #197 tracks the boot-time silence. What it pins is the
// backstop: the derived expectation set (roots ∪ DECLARED) now notices that a declared
// datatype never loaded, where the old `reg.len() == lattice.len()` count could not.
//
// WHEN #197 IS FIXED this test goes RED at the `probe/child` assertion. That is the
// intended signal, not a regression: delete or invert it in the same commit.
// ─────────────────────────────────────────────────────────────────────────────────

#[test]
fn a_silently_skipped_package_is_caught_by_the_derivation() {
    let scratch = ScratchDir::new("zero-core-silent-skip");

    let write_pkg = |folder: &str, id: &str, extends: &str| {
        let dir = scratch.path().join(folder);
        std::fs::create_dir_all(&dir).expect("create package dir");
        std::fs::write(
            dir.join("manifest.yaml"),
            format!(
                "id: {folder}\n\
                 name: {folder}\n\
                 publisher: txr\n\
                 version: 0.1.0\n\
                 apiVersion: \"1.0\"\n\
                 contributes:\n\
                 \x20 datatypes:\n\
                 \x20   - id: {id}\n\
                 \x20     extends: {extends}\n\
                 \x20     title: {id}\n\
                 \x20     description: Probe.\n\
                 \x20     is_abstract: false\n\
                 \x20     schema:\n\
                 \x20       type: object\n\
                 \x20       properties: {{}}\n\
                 \x20     storage:\n\
                 \x20       layout:\n\
                 \x20         kind: chunked_sparse\n\
                 \x20         orientation: csc\n\
                 \x20       format: zarr\n\
                 \x20       file_layout: single\n"
            ),
        )
        .expect("write manifest");
    };

    // `probe/base` extends a Rust ROOT (fine). `probe/child` extends `probe/base`, which
    // is owned by the OTHER package — the cross-package case.
    write_pkg("probe-base", "probe/base", "matrix");
    write_pkg("probe-child", "probe/child", "probe/base");

    let extra = crate::modules::extensions::contributed_datatypes_from_embedded_in(scratch.path())
        .expect("the probe tree scans without aborting");
    let reg = DatatypeRegistry::build_merged(extra).expect("the merged lattice builds");

    assert!(
        reg.get("probe/base").is_some(),
        "the same-package/root case must load — otherwise this test proves nothing about \
         the CROSS-package case"
    );
    assert!(
        reg.get("probe/child").is_none(),
        "`probe/child` LOADED — tinnlab/txresbench#197 appears to be fixed. Good: delete \
         or invert this test in that commit."
    );

    // The point: the DECLARATION knows about it, so the derivation notices the gap. This
    // is the assertion `lattice_golden_fixture` makes against the real tree, and it is
    // what a frozen type count structurally could not do.
    let declared = declared_datatypes(scratch.path());
    assert!(declared.contains_key("probe/child"));
    let loaded: BTreeSet<String> = reg.all().iter().map(|d| d.id.clone()).collect();
    let declared_but_absent: Vec<&String> =
        declared.keys().filter(|id| !loaded.contains(*id)).collect();
    assert_eq!(
        declared_but_absent,
        vec![&"probe/child".to_string()],
        "the derivation must report exactly the declared-but-unloaded datatype"
    );
}

// ─────────────────────────────────────────────────────────────────────────────────
// Round-1 audit additions: the FLOOR and the PANICS in `declared_datatypes` had no
// coverage, so nothing proved they can fire. Each is driven over a `ScratchDir`, the
// same way TEST-7 and TEST-13 drive the loader.
// ─────────────────────────────────────────────────────────────────────────────────

/// TEST-8 (floor mutation leg) — the floor is not decorative: a collapsed declaration set
/// really does fail it.
///
/// This is the control for `the_derived_sets_have_not_collapsed`. Without it, "the floor
/// passed" would be indistinguishable from "the floor cannot fire", which is the exact
/// class of vacuity `docs/design/derived-guards.md` §1 is about.
#[test]
fn a_collapsed_declaration_set_fails_the_floor() {
    let scratch = ScratchDir::new("zero-core-floor-control");
    // An EMPTY packages tree — the shape a moved root or a failed checkout produces.
    let declared = declared_datatypes(scratch.path());
    assert!(
        declared.len() < floors::MIN_CONTRIBUTED_DATATYPES,
        "a tree with no packages must be below the floor, else the floor cannot detect a \
         collapse at all"
    );

    // …and one package short of the floor is still below it, so the floor is a real bound
    // rather than a `> 0` check wearing a constant.
    let pkg = scratch.path().join("one-package");
    std::fs::create_dir_all(&pkg).expect("create dir");
    std::fs::write(
        pkg.join("manifest.yaml"),
        "id: one-package\nname: One\npublisher: txr\nversion: 0.1.0\napiVersion: \"1.0\"\n\
         contributes:\n  datatypes:\n    - id: one/kind\n      extends: data\n\
         \x20     is_abstract: false\n",
    )
    .expect("write manifest");
    assert_eq!(declared_datatypes(scratch.path()).len(), 1);
    assert!(1 < floors::MIN_CONTRIBUTED_DATATYPES);
}

/// A reserved (`_`-prefixed) package that CONTRIBUTES must fail loudly, not be dropped.
///
/// `scan_dir` skips `_`-prefixed folders, so such a contribution would silently never
/// register — the same silent-skip class as tinnlab/txresbench#197. The panic existed
/// with no test proving it fires.
#[test]
#[should_panic(expected = "reserved package")]
fn a_reserved_package_that_contributes_a_datatype_fails_loudly() {
    let scratch = ScratchDir::new("zero-core-reserved");
    let pkg = scratch.path().join("_reserved");
    std::fs::create_dir_all(&pkg).expect("create dir");
    std::fs::write(
        pkg.join("manifest.yaml"),
        "id: _reserved\nname: Reserved\npublisher: txr\nversion: 0.1.0\napiVersion: \"1.0\"\n\
         contributes:\n  datatypes:\n    - id: reserved/kind\n      extends: data\n\
         \x20     is_abstract: false\n",
    )
    .expect("write manifest");
    let _ = declared_datatypes(scratch.path());
}

/// Two packages declaring the SAME datatype id must fail loudly rather than one silently
/// winning — `merge_entries` has the same rule, and this keeps the derivation honest about
/// which package owns what.
#[test]
#[should_panic(expected = "is declared twice")]
fn a_duplicate_datatype_id_across_packages_fails_loudly() {
    let scratch = ScratchDir::new("zero-core-dup");
    for folder in ["pkg-a", "pkg-b"] {
        let pkg = scratch.path().join(folder);
        std::fs::create_dir_all(&pkg).expect("create dir");
        std::fs::write(
            pkg.join("manifest.yaml"),
            format!(
                "id: {folder}\nname: {folder}\npublisher: txr\nversion: 0.1.0\n\
                 apiVersion: \"1.0\"\ncontributes:\n  datatypes:\n    - id: dup/kind\n\
                 \x20     extends: data\n      is_abstract: false\n"
            ),
        )
        .expect("write manifest");
    }
    let _ = declared_datatypes(scratch.path());
}
