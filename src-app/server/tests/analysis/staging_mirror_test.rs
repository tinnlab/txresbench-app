//! The processor spawn used by every test in this module must resolve EXACTLY what the
//! sandbox stages, and nothing more. These are the guards on that claim.
//!
//! ## Why a guard is needed here at all
//!
//! The framework-owned gate (`_lib/conformance.py`) is staged for the verification entry
//! ONLY — `RESERVED_ENTRY_HELPERS`, never `PY_HELPER_FILES` — precisely so a processor
//! cannot call the thing that judges it (DEC-8). That is a structural claim about an import
//! path, and the two guards that existed asserted narrower properties:
//!
//! * the Python placement guard (`_lib/test_conformance.py`) scans the modules parsed out of
//!   `PY_HELPER_FILES` — staged helpers, never an entry, and never a spawn ENVIRONMENT;
//! * the Rust guard `every_shipped_helper_import_is_declared_or_globally_staged` built its
//!   `local_modules` set from `PY_HELPER_FILES` alone, so the name `conformance` was never
//!   among the modules it looked for.
//!
//! Both are SOURCE scans. The hole that actually opened was neither an import nor a shipped
//! file: a test helper put the whole `_lib` directory on `PYTHONPATH`, which handed the gate
//! to every processor under test while every source scan stayed green. So the guard below
//! asserts the RESOLUTION STATE of a real spawn — what a file sitting where the entry sits
//! can actually import — which is the only formulation that fails on that route.

use super::{processors_root, run_staged, stage_code_dir, tmp_dir};
use txresbench::modules::extensions::ExtensionRegistry;
use txresbench::modules::sandbox::processors::{PY_HELPER_FILES, VERIFY_CONFORMANCE_CODE_REF};
use txresbench::modules::sandbox::spec::Language;

/// Every shipped Python ENTRY as `(owning package, code_ref, declared siblings)`, with the
/// sibling helpers its own manifest
/// DECLARES (staged names = basenames, S6). Read from the manifests rather than typed here —
/// a hand-listed pair of entries is exactly the kind of list that falls behind the tree and
/// reports green over the entry nobody remembered to add.
fn shipped_python_entries() -> Vec<(String, String, Vec<String>)> {
    let reg = ExtensionRegistry::build_from_dir(&processors_root())
        .expect("the shipped registry folds from the working tree");
    let mut out: Vec<(String, String, Vec<String>)> = Vec::new();
    for m in reg.all() {
        for c in &m.contributes.converters {
            if !matches!(
                Language::from_runtime(&c.run.runtime),
                Some(Language::Python)
            ) {
                continue;
            }
            if out.iter().any(|(_, e, _)| e == &c.run.entry) {
                continue;
            }
            let siblings = c
                .run
                .helpers
                .iter()
                .filter_map(|h| {
                    std::path::Path::new(h)
                        .file_name()
                        .and_then(|s| s.to_str())
                        .map(String::from)
                })
                .collect();
            out.push((m.id.clone(), c.run.entry.clone(), siblings));
        }
    }
    assert!(
        out.len() >= 2,
        "the manifest scan found {} python entries — a scan that finds nothing passes \
         everything below vacuously",
        out.len()
    );
    assert!(
        out.iter().any(|(_, _, siblings)| !siblings.is_empty()),
        "no shipped entry DECLARES a sibling helper, so the declared-sibling assertion below \
         would hold vacuously: {out:?}"
    );
    out
}

/// The probe: a file placed WHERE THE ENTRY SITS, reporting what it can reach. Written into
/// the staged dir (not run with `-c`, which would put the working directory on `sys.path`
/// instead and answer a different question) and spawned through the SAME helper a processor
/// goes through, so it inherits the identical environment policy.
///
/// It reports three things: whether each named module imports, and whether any `sys.path`
/// entry points into the repository's processor tree. The last one is what makes this immune
/// to an ambient `PYTHONPATH` — it asserts the STATE of the resolution path rather than
/// trusting that nothing set the variable.
fn probe_source(root: &std::path::Path) -> String {
    let root = root.display();
    format!(
        r#"
import json, os, sys

REPO_PROCESSORS = os.path.abspath({root:?})
report = {{"modules": {{}}, "repo_path_entries": []}}
for name in sys.argv[1:]:
    try:
        __import__(name)
        report["modules"][name] = "importable"
    except ModuleNotFoundError:
        report["modules"][name] = "missing"
for p in sys.path:
    if p and os.path.abspath(p).startswith(REPO_PROCESSORS):
        report["repo_path_entries"].append(p)
print(json.dumps(report))
"#
    )
}

/// Stage `code_ref`, drop the probe beside its entry, and return the parsed report.
///
/// The spawn goes through `run_staged` — the same helper a processor goes through — so what
/// is under test is the policy processors actually get, not a second copy of it written here.
fn probe_staged(package: Option<&str>, code_ref: &str, modules: &[&str]) -> serde_json::Value {
    let (code, _entry) = stage_code_dir(code_ref, package);
    std::fs::write(code.join("probe.py"), probe_source(&processors_root()))
        .expect("write the import probe beside the staged entry");
    let io = tmp_dir("txr-probe-io");
    let out = run_staged(&code, "probe.py", modules, &io, &io);
    assert!(
        out.status.success(),
        "probe for {code_ref} exited {:?}\nstderr:\n{}",
        out.status.code(),
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).unwrap_or_else(|e| {
        panic!(
            "probe output for {code_ref} is not JSON ({e}):\n{}",
            String::from_utf8_lossy(&out.stdout)
        )
    })
}

/// The resolution PATH itself, not just what happens to be on it: no `sys.path` entry points
/// into the repository's processor tree, so the resolvable set is the STAGED set and nothing
/// else. This is the assertion the `PYTHONPATH` route fails on — including the case where the
/// variable comes from the BOX rather than from this code.
#[test]
fn the_spawn_helper_leaves_no_repository_directory_on_the_import_path() {
    let entries = shipped_python_entries();
    let (package, code_ref, _) = entries.first().expect("at least one python entry");
    let report = probe_staged(Some(package), code_ref, &[]);
    assert_eq!(
        report["repo_path_entries"].as_array().map(Vec::len),
        Some(0),
        "the spawn put a repository directory on `sys.path`, so the resolvable set is no \
         longer the STAGED set: {report}"
    );
}

/// The staged file set for a domain processor: every globally-staged helper present (derived
/// from the table, so a helper added there is checked on the next run), every sibling the
/// entry's OWN manifest declares present (derived from the manifests), and the gate ABSENT.
#[test]
fn a_processors_staged_code_dir_holds_what_production_stages_and_not_the_gate() {
    for (package, code_ref, siblings) in shipped_python_entries() {
        let (code, entry) = stage_code_dir(&code_ref, Some(&package));
        assert!(
            code.join(entry).is_file(),
            "{code_ref}: the entry is staged as {entry}"
        );
        for (name, _, _) in PY_HELPER_FILES {
            assert!(
                code.join(name).is_file(),
                "{code_ref}: `{name}` is staged for every python entry in production but is \
                 missing from the mirror — a processor importing it dies at ModuleNotFoundError \
                 here and nowhere else"
            );
        }
        for name in &siblings {
            // The DECLARED half (S6). It only resolves because the mirror publishes the
            // extension registry the way boot does; without that, `resolve_in` reads no
            // manifest and this entry silently loses a module it imports.
            assert!(
                code.join(name).is_file(),
                "{code_ref} declares the sibling `{name}` in its own manifest and production \
                 stages it, but the mirror did not"
            );
        }
        assert!(
            !code.join("conformance.py").exists(),
            "{code_ref}: the framework gate reached a processor's own code dir (DEC-8)"
        );
    }
}

/// …and the same claim as a RESOLUTION fact rather than a directory listing: from where the
/// entry sits, the shared format library imports and the gate does not.
#[test]
fn a_processor_cannot_import_the_gate_from_where_its_entry_runs() {
    for (package, code_ref, _) in shipped_python_entries() {
        let report = probe_staged(
            Some(&package),
            &code_ref,
            &["txr_columns", "txr_zarr", "align", "conformance"],
        );
        let modules = &report["modules"];
        for reachable in ["txr_columns", "txr_zarr", "align"] {
            assert_eq!(
                modules[reachable], "importable",
                "{code_ref}: production stages `{reachable}` for every python entry, so the \
                 mirror must resolve it: {report}"
            );
        }
        assert_eq!(
            modules["conformance"], "missing",
            "{code_ref}: a processor can import the gate that judges it (DEC-8): {report}"
        );
    }
}

/// The positive control, and the reason the assertion above is an EXCLUSION rather than a
/// broken mirror: for the ONE entry production stages the gate for, the mirror stages it too
/// and it imports.
#[test]
fn the_verification_entry_does_reach_the_gate() {
    let (code, entry) = stage_code_dir(VERIFY_CONFORMANCE_CODE_REF, None);
    assert!(code.join(entry).is_file());
    assert!(
        code.join("conformance.py").is_file(),
        "the entry-scoped staging did not reach the mirror; without it the verification job \
         dies at ModuleNotFoundError before it reads a byte, which looks from outside exactly \
         like a gate that ran"
    );
    // No package hint: the verification entry is an app-owned RESERVED code_ref, and a
    // `_`-prefixed package name is (correctly) refused as a hint — production resolves it
    // through `RESERVED_CODE_REFS`, and so does this.
    let report = probe_staged(None, VERIFY_CONFORMANCE_CODE_REF, &["conformance"]);
    assert_eq!(
        report["modules"]["conformance"], "importable",
        "the gate is staged for this entry but does not import from where it runs: {report}"
    );
}
