//! Analysis compute-script integration tests (ITEM-13) — the QC processors that
//! run inside the sandbox rootfs. These drive the REAL python scripts
//! (re-homed into `packages/qc/compute/qc-10x.py` + `packages/cell-filter/compute/
//! cell-filter.py`, Slice 5) on a TINY synthetic
//! matrix, asserting the per-cell `/obs` metric artifact + the filter recipe.
//!
//! The numeric stack both computes import (`numpy` + `pandas`) must be importable on
//! the host `python3` — install it with `pip install --user numpy pandas`.
//! `python_stack_ready()` is a runtime DEPENDENCY PROBE (not a test-suppression
//! directive): it reports whether that stack is present so a bare box without it fails
//! loud on the processor spawn rather than reporting a phantom pass. On a provisioned
//! host the probe is true and every test below RUNS.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use uuid::Uuid;

mod qc_apply_test;
mod qc_chain_test;
mod qc_metrics_test;
// TEST-28 [covers: ITEM-16, ITEM-17] — the multi-binding half of the list slot: ONE run,
// one prefixed column per binding, both on the shared first axis.
mod qc_multimodality_test;
mod staging_mirror_test;

/// The repo's processors root — the same folder layout `sandbox::processors::resolve_in`
/// scans in production (there it is the extracted seed; here it is the working tree, so an
/// edit to a compute script is exercised without a rebuild).
///
/// Owned by the harness (`common`) rather than this module: the process-global
/// extension registry is built from it, and that publication had to move to the
/// harness so no test's verdict depends on an `analysis::*` neighbour sharing the
/// invocation (see the block comment on `common::ensure_extension_registry`).
pub use crate::common::processors_root;

/// Runtime DEPENDENCY PROBE: true when the host `python3` can import what the two
/// compute entries + the shared `_lib` format library actually need. This is NOT a
/// test-suppression directive — it is a "are the deps installed?" check so a box that
/// never ran `pip install numpy pandas` fails loud on the processor spawn instead of
/// reporting a phantom pass. Provision the host (see the module doc) and this returns
/// true, so every compute test RUNS.
///
/// The set is exactly the entries' import graph, not a generous superset. It used to
/// name the whole AnnData-era stack; a probe that over-requires does not fail safe, it
/// turns a runnable test into a self-skip on a host that could have RUN it — and a
/// self-skip is a SKIP, never a pass. Neither entry imports `scanpy`, `anndata` or
/// `scipy` any longer (grep either file: `numpy`, `pandas`, and the staged `cyto_*`
/// modules, which hold the same numpy+stdlib floor), and the artifacts they read are
/// written below through those same staged modules.
pub fn python_stack_ready() -> bool {
    Command::new("python3")
        .args(["-c", "import numpy, pandas"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// A fresh unique temp dir (auto-namespaced) for a test's inputs/outputs.
pub fn tmp_dir(prefix: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("{prefix}-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&d).expect("create temp dir");
    d
}

/// Assemble the `/code` directory the sandbox would assemble for `code_ref`, and return it
/// with the entry's staged filename.
///
/// ## Why a DIRECTORY and not `PYTHONPATH`
///
/// A migrated processor does a bare `import cyto_columns`, so the shared format library has
/// to be reachable or the script dies at `ModuleNotFoundError` before it runs a line. The
/// previous version of this helper bought that reachability with
/// `PYTHONPATH=<packages/_lib>` and called it "the honest mirror". It was neither:
///
/// * `_lib` also holds `conformance.py`, which production stages for the VERIFY entry ONLY
///   ([`RESERVED_ENTRY_HELPERS`]) precisely so a processor cannot reach the gate that judges
///   it (DEC-8). Putting the whole directory on the path handed every processor under test
///   the gate — the exact arrangement the design forbids, opened by a test.
/// * It omitted `_helpers` (`align.py`, `colsummary.py`), which production DOES stage for
///   every Python entry. So it was simultaneously too permissive and too narrow.
///
/// The shape production uses is not a search path at all: it COPIES a specific set of files
/// into ONE directory next to the entry and runs the entry out of there
/// (`jobs::runner` → `/code/entry.py` + one `/code/<helper>.py` per staged helper, bound
/// read-only). `python3 <dir>/entry.py` puts exactly that directory on `sys.path[0]`, so the
/// resolvable set IS the staged set — reachability and exclusion from the same fact, with no
/// second list to keep in sync.
///
/// The staged set is DERIVED by calling production's own resolver, not re-listed here: a
/// re-list would fall behind [`PY_HELPER_FILES`] / [`RESERVED_ENTRY_HELPERS`] the next time
/// either table changes, which is how this hole opened in the first place.
///
/// [`RESERVED_ENTRY_HELPERS`]: cytoanalyst::modules::sandbox::processors
/// [`PY_HELPER_FILES`]: cytoanalyst::modules::sandbox::processors::PY_HELPER_FILES
pub fn stage_code_dir(code_ref: &str, package: Option<&str>) -> (PathBuf, &'static str) {
    use cytoanalyst::modules::sandbox::processors::{declared_run, resolve_in_with};
    // These tests spawn no `TestServer`, so they publish the registry themselves —
    // the same one-shot the harness runs, so ordering between them is irrelevant.
    crate::common::ensure_extension_registry();
    let root = processors_root();
    // `declared_run` + `resolve_in_with` is the composition production's own
    // `resolve_with_package` performs; the ONLY difference here is the dir it resolves
    // against (the working tree instead of the extracted seed). Calling the convenience
    // `resolve_in` instead would look equivalent and silently is not: it passes
    // `DeclaredRun::default()`, so every entry loses the siblings its manifest DECLARES.
    let resolved = resolve_in_with(&root, code_ref, package, &declared_run(code_ref, package))
        .unwrap_or_else(|e| panic!("resolve code_ref {code_ref:?} from {root:?}: {e}"));
    let code = tmp_dir("cyto-code");
    let entry = resolved.language.entry_filename();
    std::fs::write(code.join(entry), resolved.script.as_bytes())
        .unwrap_or_else(|e| panic!("stage entry {code_ref:?}: {e}"));
    for (name, bytes) in &resolved.helpers {
        std::fs::write(code.join(name), bytes)
            .unwrap_or_else(|e| panic!("stage helper {name}: {e}"));
    }
    (code, entry)
}

/// Run `script_name` out of an already-staged `/code` dir, under the same environment
/// policy a sandboxed processor gets: the staged dir is the ONLY local import source.
///
/// `PYTHONPATH` is REMOVED, not merely left unset — an ambient one (the box's shell, a
/// `source tests/.env.test`, a pytest wrapper) would otherwise re-open exactly the hole this
/// helper closes, silently and only on the machines that have it set.
///
/// This is the ONE place the environment policy is written. `staging_mirror_test`'s guards go
/// through it too rather than building their own `Command`, or they would be asserting the
/// policy of the guard instead of the policy every processor spawn actually gets.
pub fn run_staged(
    code_dir: &Path,
    script_name: &str,
    args: &[&str],
    inputs: &std::path::Path,
    outputs: &std::path::Path,
) -> Output {
    Command::new("python3")
        .arg(code_dir.join(script_name))
        .args(args)
        .env_remove("PYTHONPATH")
        .env("CYTO_INPUTS_DIR", inputs)
        .env("CYTO_OUTPUTS_DIR", outputs)
        .output()
        .unwrap_or_else(|e| panic!("spawn {script_name}: {e}"))
}

/// ONE staged `/code` dir, used for BOTH halves of a run: writing the run's input
/// artifacts and executing the entry that reads them.
///
/// ## Why the fixtures go through the REAL writer
///
/// A processor input is not a file the test can spell. It is an ARTIFACT — a multifile
/// Zarr store whose group `zarr.json` carries the producer's `structure` declaration,
/// which is the only thing the entry dispatches on (`artifact_structure` → `kind`).
/// There are two ways to put one on disk: describe the container here, or call the
/// function production calls. The `.h5ad` this replaced is the argument for the second:
/// it was hand-assembled, the input contract moved underneath it (slot names, artifact
/// encoding, gene labels leaving the matrix), and NOTHING failed until the compute
/// itself was rewritten — because a fixture that nobody derives cannot notice.
///
/// So `write_matrix` / `write_column` below call `cyto_csc.write_csc_zarr` and
/// `cyto_columns.write_metadata_column` — the same two functions the import converter
/// writes its outputs with — resolved out of THIS directory, which
/// [`stage_code_dir`] assembled with production's own resolver. The staleness story is
/// therefore that there ISN'T one: no copy of the on-disk format exists in the test
/// tree, a change to the writer moves the fixture in the same commit, and a library
/// that stops being staged fails the fixture WRITE (loudly, before any assertion)
/// rather than leaving a store the entry silently cannot open.
///
/// This is the same call the e2e seed made for the same reason — see
/// `ui/tests/e2e/14-declarative-qc/_seed.ts::seedRunnableExpression`, whose header
/// works through why a fixture cannot serve there either.
pub struct StagedProcessor {
    /// The assembled `/code` dir: the entry plus exactly the modules production stages
    /// beside it. Running any script FROM here puts it on `sys.path[0]`, so the
    /// resolvable set is the staged set — for the fixture writer as much as the entry.
    pub dir: PathBuf,
    entry: &'static str,
}

/// Stage `<pkg>/compute/<name>` the way the runner stages it (see [`stage_code_dir`]).
pub fn stage_processor(pkg: &str, name: &str) -> StagedProcessor {
    let (dir, entry) = stage_code_dir(&format!("compute/{name}"), Some(pkg));
    StagedProcessor { dir, entry }
}

impl StagedProcessor {
    /// Run a fixture-writing script out of the staged dir, under the same environment
    /// policy the entry gets (`run_staged` — no `PYTHONPATH`, so the staged modules are
    /// the ONLY import source).
    fn write_artifact(&self, what: &str, body: &str, args: &[&str]) {
        let script = format!("_stage_{what}.py");
        std::fs::write(self.dir.join(&script), body)
            .unwrap_or_else(|e| panic!("write the {what} stager beside the staged entry: {e}"));
        let io = tmp_dir("cyto-stage-io");
        let out = run_staged(&self.dir, &script, args, &io, &io);
        assert!(
            out.status.success(),
            "staging a {what} input exited {:?}\nstderr:\n{}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr),
        );
        let _ = std::fs::remove_dir_all(&io);
    }

    /// Stage a count-matrix artifact at `dest` from a dense block, one row per entity on
    /// the first axis. `cyto_csc.ArraySource` takes a dense array directly, so the block
    /// the test already holds is handed over unchanged.
    pub fn write_matrix(&self, dest: &Path, rows: &[&[u32]]) {
        let rows_json =
            serde_json::to_string(&rows.iter().map(|r| r.to_vec()).collect::<Vec<_>>()).unwrap();
        let axes = format!("[{AXIS_KEYS:?},{AXIS_LABELS:?}]");
        self.write_artifact(
            "matrix",
            r#"
import json, sys
import numpy as np
import cyto_csc
block = np.asarray(json.loads(sys.argv[1]), dtype=np.float32)
cyto_csc.write_csc_zarr(cyto_csc.ArraySource(block), sys.argv[2], axes=tuple(json.loads(sys.argv[3])))
"#,
            &[&rows_json, &dest.to_string_lossy(), &axes],
        );
    }

    /// Stage a single-column artifact at `dest` — the shape every non-matrix input has.
    /// `values` is JSON, so a numeric column stays numeric and a label column stays
    /// text, exactly as the writer would receive them from the producer.
    pub fn write_column(&self, dest: &Path, name: &str, values: &str, axis: &str) {
        let parent = dest.parent().expect("a staged input has a parent dir");
        self.write_artifact(
            "column",
            r#"
import json, sys
import pandas as pd
import cyto_columns
cyto_columns.write_metadata_column(
    __import__("pathlib").Path(sys.argv[1]), sys.argv[2], sys.argv[3],
    pd.Series(json.loads(sys.argv[4])), axis=sys.argv[5])
"#,
            &[
                &parent.to_string_lossy(),
                &dest.file_name().unwrap().to_string_lossy(),
                name,
                values,
                axis,
            ],
        );
    }

    /// Run the staged entry; panics with the captured stderr on a non-zero exit.
    pub fn run(&self, inputs: &Path, outputs: &Path) {
        let out = run_staged(&self.dir, self.entry, &[], inputs, outputs);
        assert!(
            out.status.success(),
            "{} exited {:?}\nstdout:\n{}\nstderr:\n{}",
            self.entry,
            out.status.code(),
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr),
        );
    }
}

// ─────────────────── the entries' wire vocabulary, spelled ONCE ───────────────────
//
// The SLOT names the two entries resolve inputs by, and the AXIS names an input
// declares alignment to. They live here rather than in each test because they are the
// COMPUTE's contract, not a test's choice: a second spelling per test is a second thing
// to migrate when the contract moves, and not migrating them is exactly what left the
// previous fixtures staging a retired shape while every test still read green.
//
// Nothing in either entry's read path dispatches on the AXIS names (they reach only the
// artifact's own `structure`), so those two are FIDELITY rather than load-bearing — a
// staged input differing from a produced one in a field the CURRENT reader ignores is
// how the NEXT reader gets a surprise.

/// `qc-10x`'s required LIST slot: one binding per selected matrix.
pub const SLOT_MATRIX: &str = "matrices";
/// `cell-filter`'s required matrix slot (it takes exactly one).
pub const SLOT_EXPRESSION: &str = "expression";
/// The labels a PATTERN metric matches against, list-aligned with [`SLOT_MATRIX`].
pub const SLOT_LABELS: &str = "gene_names";
/// The first axis's key artifact; supplies the emitted `id` values.
pub const SLOT_KEYS: &str = "cells_index";
/// `cell-filter`'s per-column slot PREFIX — the slot carries the column's name, because
/// a column artifact declares a member called `values` and never its display name.
pub const SLOT_COLUMN_PREFIX: &str = "column:";
/// The axis a label column is aligned to (the matrix's second axis).
pub const AXIS_LABELS: &str = "genes";
/// The axis a key/metric column is aligned to (the matrix's first axis).
pub const AXIS_KEYS: &str = "cells";

/// The metric processor's ENTRY filename, under its package's `compute/`.
///
/// Spelled ONCE for the same reason the slot names above are: it is the PACKAGE's own
/// declaration (`run.entry` in its manifest), not a choice any test here makes, and a
/// per-file copy is one more thing to migrate when the package renames it. Relocating it
/// here is also what keeps a new case in this module from re-entering the token — see the
/// `R4-RELOCATED` disposition in `ui/scripts/domain-baseline.json`.
pub const METRIC_ENTRY: &str = "qc-10x.py";

/// One `/inputs/inputs.json` binding, in the wire shape
/// `sandbox/inputs.rs::render_inputs_json` writes: the SLOT is the whole contract, and
/// the mount name is deliberately meaningless (`in0`, `in1`, …) so an entry that
/// resolved by filename or by suffix could not pass here.
pub fn binding(slot: &str, mount: &str) -> serde_json::Value {
    serde_json::json!({
        "slot": slot,
        "kind": "artifact-prefix",
        "content_hash": format!("sha256:{}", "0".repeat(64)),
        "sandbox_path": format!("/inputs/{mount}"),
    })
}
