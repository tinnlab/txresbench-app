#!/usr/bin/env python3
# ruff: noqa
"""TEST-30 — the entry really runs in the FLAT `/code` dir a real sandbox stages.

Every other suite in this directory imports the compute through `hd_fixtures.load_compute`,
which binds each helper BY PATH out of the source tree. That is the right model for testing
the module's logic and it is the wrong model for testing whether the module can START: a
`sys.path` that contains whole DIRECTORIES resolves modules the platform does not stage, so a
compute that imported one would pass every suite here and die with `ModuleNotFoundError` at
process start in production — reaching the server as an opaque job failure with no hint of the
cause.

## What production actually does, read from the shipped tree rather than restated

* `sandbox.rs` launches under `--clearenv`. `PYTHONPATH` is not merely unset; the whole
  environment is wiped and then a handful of `--setenv` keys are put back.
* `runner.rs::stage_and_launch` writes a **FLAT `/code` directory** — the entry script under
  its canonical filename, plus every module in `resolved.helpers`, all side by side — and runs
  `python3 /code/<entry>`. `sys.path[0]` is that directory. No package structure, no
  `compute/` subdirectory, no `_lib` on the path: the `_lib` modules are COPIES sitting flat
  beside the entry.

The `/code` dir is assembled here by the VENDORED `tests/sandbox_code_dir.py` (byte-identical
to `spatial-import-visium`'s — TEST-20 holds that shut), which parses the module list out of
two sources that the platform, not this test, owns: the `PY_HELPER_FILES` Rust const in
`server/src/modules/sandbox/processors/mod.rs`, and this package's own `run.helpers`. Both
parsers RAISE rather than returning an empty list, because a `/code` dir holding only the entry
would make this measurement about something else entirely.

## The two legs, and why neither alone is enough

1. **Production, exactly**: `python3 /code/import_visium_hd.py` over the `TXR_*` seam, with a
   `--clearenv`-shaped environment. Zero deviation from what a real job runs.
2. **The consumer**: a probe staged into the same dir that `import import_visium_hd` BY ITS
   STAGED BARE NAME and calls `run_import` on a real bundle. Leg 1 proves the process starts;
   leg 2 proves the entry is IMPORTABLE as a module from `/code` and that its public entry
   point is callable there — the shape any in-sandbox consumer of this package would use.

And a NEGATIVE control, because both legs would pass just as green if the subprocess were
quietly resolving modules off the source tree: one declared helper is deleted from a copy of
the staged dir, and the entry must then die with `ModuleNotFoundError` naming it.

## The one deviation from production, named rather than smuggled

`stage_and_launch` writes ONE entry file. Leg 2's dir holds TWO — the real entry under its
canonical filename plus `entry.py`, the probe that imports it. That extra file is this
harness's, and it is the only thing in either `/code` dir that a real job would not have.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hd_fixtures as HF  # noqa: E402
import sandbox_code_dir as CODE  # noqa: E402

#: The entry's canonical filename in `/code`. `runner.rs` stages the entry under the basename
#: the manifest's `run.entry` declares, which is what makes `import import_visium_hd` the
#: spelling an in-sandbox consumer uses.
ENTRY_NAME = HF.COMPUTE.name

#: The intra-package siblings the manifest declares, plus the modules the compute imports from
#: `_lib`. Named here so a `/code` dir that is missing one fails with a message that says WHICH
#: — rather than with a `ModuleNotFoundError` from inside a subprocess.
_MUST_BE_STAGED = (
    "spatial_declarations.py", "ome_writer.py", "registration_qc.py",
    "txr_columns.py", "txr_csc.py", "txr_deps.py",
)

#: The probe. Its whole world is `/code` and the inputs dir it is handed. It imports the entry
#: BY ITS STAGED BARE NAME — the only spelling a flat `/code` allows — and then calls something
#: REAL: `run_import` over a staged bundle, which is the operation a job performs. It reports
#: what it resolved and where from, so the assertions can be made about the CHILD's world
#: rather than about this test's dict literal.
_CONSUMER = '''
import json, os, sys

import import_visium_hd as M

entries = M.run_import(sys.argv[1], sys.argv[2])
print(json.dumps({
    "sys_path0": sys.path[0],
    "pythonpath": os.environ.get("PYTHONPATH"),
    "entry_file": M.__file__,
    "declarations_file": M.SD.__file__,
    "ome_writer_file": M.ome_writer.__file__,
    "registration_qc_file": M.registration_qc.__file__,
    "ids": sorted(e["id"] for e in entries),
    "default_bin_um": M.DEFAULT_BIN_UM,
}))
'''


def _sandbox_env(**extra):
    """The environment a real job gets AFTER `--clearenv`, and nothing else.

    `PATH`, `HOME`, and `LANG`/`LC_ALL=C.UTF-8` — the keys `sandbox.rs` puts back with
    `--setenv`. **No `PYTHONPATH`**: that is the key whose absence is the whole point, and it
    is asserted from INSIDE the subprocess, where it can actually fail. Asserting it about this
    dict would prove only that this function does what it says.

    `HOME` is the REAL home and that is deliberate, not a leak. In production the analysis
    image ships numpy/h5py/pandas/pyarrow in the interpreter's system `site-packages`; on a
    developer box they are typically in the USER site dir, which Python locates through `HOME`.
    A stricter `HOME` would model an environment with no scientific stack at all, and the child
    would die of `ModuleNotFoundError: numpy` — measuring this box's package layout rather than
    the staging.

    `LC_ALL=C.UTF-8` matches production too, and matters: a two-key env is not "stricter than
    production", it models an ASCII-locale process that production is specifically configured
    NOT to be. (That this module ALSO survives an ASCII locale is TEST-31's claim, measured
    separately, and it is a different claim from this one.)
    """
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": os.environ.get("HOME", "/tmp"),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
    }
    env.update(extra)
    return env


def _stage(dest):
    """The flat `/code` dir, with the REAL entry under its canonical filename."""
    code = CODE.stage_code_dir(dest, HF.PKG, HF.COMPUTE.read_text(encoding="utf-8"),
                               entry_name=ENTRY_NAME)
    return Path(code)


def test_TEST_30_the_staged_code_dir_holds_every_module_the_entry_imports(tmp_path):
    """TEST-30 — what `/code` contains, asserted before anything is run in it.

    If a helper is missing, the two legs below fail with a `ModuleNotFoundError` out of a
    subprocess — which is the production symptom, and a poor test failure. This states the
    contents first, so a missing module names itself.

    The list is a FLOOR, not an enumeration: `PY_HELPER_FILES` is the platform's table and it
    grows. What must be true is that the modules this compute actually imports by bare name are
    there, and that `/code` is FLAT — no subdirectories, which is the property that makes
    `import spatial_declarations` (rather than `from compute import ...`) the correct spelling.
    """
    code = _stage(tmp_path / "code")

    staged = {p.name for p in code.iterdir() if p.is_file()}
    assert ENTRY_NAME in staged, f"the entry itself is not in the staged /code dir: {sorted(staged)}"
    missing = [name for name in _MUST_BE_STAGED if name not in staged]
    assert not missing, (
        f"the modelled `/code` dir is missing {missing}. Production stages `run.helpers` plus "
        f"`PY_HELPER_FILES`; this compute imports all of these by bare name, so a real job "
        f"would die with ModuleNotFoundError at process start. Staged: {sorted(staged)}"
    )
    assert not [p for p in code.iterdir() if p.is_dir()], (
        "the modelled `/code` dir has subdirectories; `stage_and_launch` writes a FLAT "
        "directory and a nested one would let a bare-name import resolve differently here "
        "than in a real job"
    )
    # The vendored helper-table parser must not be matching nothing — its own docstring says a
    # silently empty `/code` is the failure it exists to prevent, and this is the one place in
    # this package where that is exercised rather than assumed.
    assert len(CODE.py_helper_files()) >= 4, CODE.py_helper_files()
    assert sorted(CODE.declared_helpers(HF.PKG)) == [
        "compute/ome_writer.py", "compute/registration_qc.py", "compute/spatial_declarations.py",
    ], CODE.declared_helpers(HF.PKG)


def test_TEST_30_the_SHIPPED_ENTRY_runs_to_completion_in_the_flat_code_dir(tmp_path):
    """TEST-30 [e2e] — leg 1: exactly what `stage_and_launch` runs, with nothing added.

    `python3 /code/import_visium_hd.py`, a `--clearenv`-shaped environment carrying only the
    `TXR_*` seam plus PATH/HOME/LANG/LC_ALL, `cwd` outside the source tree so nothing resolves
    by accident, and the FLAT staged bundle `dataset/process.rs::build_dataset_inputs` actually
    writes.

    What this would catch: a compute that grew an `import` of a module the platform does not
    stage — a `_helpers` module not in `PY_HELPER_FILES`, a sibling not declared in
    `run.helpers`, a `from compute import ...` that only works out of the source tree. Every
    one of those is green in every other suite here and is an opaque job failure in production.
    """
    code = _stage(tmp_path / "code")
    inputs, _ordinals = HF.staged_flat(tmp_path)
    outputs = tmp_path / "outputs"

    result = subprocess.run(
        [sys.executable, str(code / ENTRY_NAME)],
        capture_output=True, text=True, cwd=str(inputs),
        env=_sandbox_env(TXR_INPUTS_DIR=str(inputs), TXR_OUTPUTS_DIR=str(outputs)),
    )
    assert result.returncode == 0, (
        f"the entry did not run in the modelled `/code` dir (rc={result.returncode}). This is "
        f"the production launch, so this failure is a real job failure.\n{result.stderr[-3000:]}"
    )

    manifest = json.loads((outputs / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["outputs"], "the entry started but produced no outputs"
    ids = {entry["id"] for entry in manifest["outputs"]}
    assert {"expression", "spatial-coordinates"} <= ids, sorted(ids)


def test_TEST_30_a_consumer_in_the_flat_code_dir_IMPORTS_the_entry_and_drives_it(tmp_path):
    """TEST-30 [e2e] — leg 2: the entry is a MODULE in `/code`, importable by its bare name.

    Leg 1 proves the process starts. This proves the shape any in-sandbox caller would use:
    `import import_visium_hd`, then `run_import(bundle, outputs)` — the module's real entry
    point, over a real staged bundle, producing real artifacts.

    The probe reports its own `sys.path[0]`, its `PYTHONPATH`, and the FILE each vendored helper
    resolved to, and those are asserted about the CHILD rather than about this test's env dict:
    `answer["pythonpath"] is None` can fail; asserting the dict literal could not.

    What this would catch: a module-scope side effect that only works when the source tree is
    importable, a helper resolving to `spatial-types`' original rather than to the staged copy
    (which for `registration_qc` would silently substitute the Visium 100 um slide-pitch
    referent for this module's bin-pitch one), or a `run_import` that depends on `sys.path`
    carrying `compute/`.
    """
    code = _stage(tmp_path / "code")
    # THE ONE DEVIATION, stated in the module docstring: a real `/code` holds one entry file.
    (code / "entry.py").write_text(_CONSUMER, encoding="utf-8")

    inputs, _ordinals = HF.staged_flat(tmp_path)
    outputs = tmp_path / "outputs"

    result = subprocess.run(
        [sys.executable, str(code / "entry.py"), str(inputs), str(outputs)],
        capture_output=True, text=True, cwd=str(inputs), env=_sandbox_env(),
    )
    assert result.returncode == 0, (
        f"the consumer could not import and drive the entry from the staged `/code` dir "
        f"(rc={result.returncode}).\n{result.stderr[-3000:]}"
    )
    answer = json.loads(result.stdout)

    assert answer["pythonpath"] is None, (
        "the subprocess had a PYTHONPATH, so this is not a sandbox model — a directory on the "
        "path resolves modules the platform does not stage"
    )
    assert answer["sys_path0"] == str(code), (answer["sys_path0"], str(code))
    for key in ("entry_file", "declarations_file", "ome_writer_file", "registration_qc_file"):
        assert Path(answer[key]).parent == code, (
            f"{key} resolved to {answer[key]}, which is OUTSIDE the staged `/code` dir — the "
            "measurement is about the source tree, not about what a sandbox stages"
        )
    assert {"expression", "spatial-coordinates", "spatial-image-hires"} <= set(answer["ids"]), \
        answer["ids"]
    assert answer["default_bin_um"] == HF.load_compute().DEFAULT_BIN_UM


def test_TEST_30_removing_ONE_staged_helper_makes_the_entry_die_at_process_start(tmp_path):
    """TEST-30 — the negative control. Without it, both legs pass on a leaky subprocess.

    If the child were quietly resolving modules off the source tree — an inherited
    `PYTHONPATH`, a `.pth` file, a `sys.path` entry from `cwd` — everything above would be just
    as green while measuring nothing about staging. So one DECLARED helper is deleted from a
    copy of the staged dir and the entry is run again: it must die, non-zero, with
    `ModuleNotFoundError` naming that module.

    This is also the production symptom spelled out: an unstaged module is not a degraded
    import, it is a process that never starts, and the server sees only an opaque job failure.
    """
    code = _stage(tmp_path / "code")
    victim = code / "registration_qc.py"
    assert victim.exists()
    victim.unlink()

    inputs, _ordinals = HF.staged_flat(tmp_path)
    result = subprocess.run(
        [sys.executable, str(code / ENTRY_NAME)],
        capture_output=True, text=True, cwd=str(inputs),
        env=_sandbox_env(TXR_INPUTS_DIR=str(inputs), TXR_OUTPUTS_DIR=str(tmp_path / "outputs")),
    )
    assert result.returncode != 0, (
        "the entry ran with a declared helper missing from `/code`, so it is NOT resolving its "
        "imports from the staged directory and this whole measurement is about something else"
    )
    assert "ModuleNotFoundError" in result.stderr, result.stderr[-1500:]
    assert "registration_qc" in result.stderr, result.stderr[-1500:]
