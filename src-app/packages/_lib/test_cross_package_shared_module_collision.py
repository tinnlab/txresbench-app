#!/usr/bin/env python3
# ruff: noqa
"""TEST-5 [acceptance] [invariant: INV-1] [covers: ITEM-2, ITEM-5, ITEM-7] — the decisive
multi-package pytest invocation from issue #567.

SLOW: this spawns TWO real pytest suites as subprocesses, one of which
(`differential-expression/tests embedding/tests`) takes several minutes. That is expected and
correct, not a hang. Do not casually add more pairings to it.

A package-scoped test cannot see the #567 defect by construction (INV-1): the collision only
exists when two packages' compute modules share one pytest process, so it only shows up in a
multi-package run. This test runs the real invocations as subprocesses from `src-app/packages`
(the canonical rootdir) and asserts both exit 0, and that the originally-failing tests actually
appear as PASSED in the multi-package run's `-rA` summary (a positive check, not merely "absent
from FAILED" — so a collection regression that silently stops running them, still exit 0, is
caught too). `PYTHONDONTWRITEBYTECODE=1` is set on the subprocesses so no `.pyc` is ever written
by these inner runs — pytest bytecode caching keyed on (mtime_sec, size) can mask a real change.
"""
import os
import subprocess
import sys
from pathlib import Path

_PACKAGES = Path(__file__).resolve().parent.parent


def _run_pytest(args, *, report_all=False):
    env = dict(os.environ)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    cmd = [sys.executable, "-m", "pytest", *args, "-q"]
    if report_all:
        cmd.append("-rA")
    return subprocess.run(cmd, cwd=str(_PACKAGES), env=env, capture_output=True, text=True)


def test_embedding_suite_alone_exits_zero():
    proc = _run_pytest(["embedding/tests"])
    assert proc.returncode == 0, (
        f"embedding/tests alone exited {proc.returncode}\n"
        f"--- stdout ---\n{proc.stdout}\n--- stderr ---\n{proc.stderr}")


def test_multi_package_run_exits_zero_and_names_no_collision_failures():
    proc = _run_pytest(["differential-expression/tests", "embedding/tests"], report_all=True)
    assert proc.returncode == 0, (
        f"differential-expression/tests embedding/tests exited {proc.returncode}\n"
        f"--- stdout ---\n{proc.stdout}\n--- stderr ---\n{proc.stderr}")
    # POSITIVE check (not merely "absent from FAILED"): the originally-failing tests must
    # actually appear as PASSED in the `-rA` summary — so a collection regression that
    # silently stops running them (still exit 0) is caught too. pytest writes the summary
    # to stdout; check stdout + stderr so the assertion holds whichever stream the config
    # routes them to.
    output = proc.stdout + proc.stderr
    passed = [line for line in output.splitlines() if line.startswith("PASSED ")]
    for name in (
        "test_embedding_output_declares_the_datatype_layout_and_all_provenance",
        "test_criteria_parity",
        "test_advanced_pseudobulk_contamination",
    ):
        assert any(name in line for line in passed), (
            f"{name} did not appear as PASSED in the multi-package run — the cross-package "
            f"bare-module-name collision is back (or the test was not collected)")
