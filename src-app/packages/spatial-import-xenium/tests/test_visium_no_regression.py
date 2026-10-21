#!/usr/bin/env python3
# ruff: noqa
"""TEST-20 — the SIBLING IMPORTER still works, against the moved-and-modified writer.

This branch does two things to already-shipped code: it MOVES `ome_writer.py` out of
`spatial-import-visium` into `spatial-types` (both importers now vendor a byte-identical
copy), and it CHANGES one function in it — `_reconcile_scale` resolves the space's scale
through `SD.require_micron_scale` instead of reading `microns_per_pixel` directly.

That change is behaviour-preserving for every PIXEL space by construction, and
`test_reconcile_micrometre.py` proves it directly, including that the original refusal text
is unchanged. But "by construction" is an argument, and the sibling has 3,296 lines of image
tests — including a MUTATION BATTERY built specifically to prove those guards go red — which
is the evidence. So they are run.

## Why this lives in the Xenium package rather than as a citation in the Visium suite

A11 requires a `TEST-N` to be EARNED by an added line of this branch's diff. The honest way
to earn it is to add a test that really makes the claim, and the claim here is about ANOTHER
package's suite — so citing the id inside that suite would mean editing a shipped test file
to satisfy a bookkeeping rule, which is exactly the shape A11 exists to discourage. Running
it is the assertion.

Measured cost: ~17 seconds for all four modules. Cheap enough that the regression proof runs
every time rather than being a thing somebody remembers to do.
"""
import subprocess
import sys
from pathlib import Path

import pytest

PACKAGES = Path(__file__).resolve().parents[2]

#: The four shipped Visium image suites, in the order their coverage builds up.
#: `test_downsample_mutations.py` is the important one: it is a battery that MUTATES the
#: writer and asserts the guards go red, so it is the module that would notice a
#: generalisation that had quietly become a hole.
VISIUM_IMAGE_SUITES = (
    "spatial-import-visium/tests/test_spatial_image.py",
    "spatial-import-visium/tests/test_image_downsample.py",
    "spatial-import-visium/tests/test_image_robustness.py",
    "spatial-import-visium/tests/test_downsample_mutations.py",
)


@pytest.fixture(scope="module")
def visium_image_suite_run(tmp_path_factory):
    """Run the sibling's image suites in a SUBPROCESS, once, with a MACHINE-READABLE result.

    A subprocess and not an in-process invocation, for the reason
    `xenium_fixtures.load_compute` documents: both packages ship modules named
    `spatial_declarations` and `ome_writer`, and whichever suite runs first wins
    `sys.modules` for the session. Running the sibling in its own interpreter is the only
    way this test measures the sibling's code rather than whatever this process already
    imported.

    JUnit XML rather than scraped stdout, because scraping is exactly the failure mode this
    file exists to avoid: `pytest -q` prints NO summary line at all when every test passes
    and nothing warns, so a regex over its output reads "no tests ran" from a perfect run.
    The XML always carries `tests=` and `failures=`, whatever the terminal chose to print.
    """
    report = tmp_path_factory.mktemp("visium-junit") / "report.xml"
    result = subprocess.run(
        [sys.executable, "-m", "pytest", *VISIUM_IMAGE_SUITES,
         "--no-header", f"--junit-xml={report}"],
        cwd=str(PACKAGES), capture_output=True, text=True, timeout=1800,
    )
    counts = {}
    if report.exists():
        import xml.etree.ElementTree as ET
        node = ET.parse(report).getroot()
        suite = node if node.tag == "testsuite" else node.find("testsuite")
        counts = {k: int(suite.get(k, 0))
                  for k in ("tests", "failures", "errors", "skipped")}
    return result, counts


def test_the_visium_image_suites_pass_against_the_moved_and_modified_writer(
    visium_image_suite_run,
):
    """TEST-20 — no regression, read from the SUBPROCESS'S OWN EXIT CODE.

    Not from a parsed summary line and not through a pipe: `subprocess.run` gives the real
    status, so this cannot be the "recorded PASS beside output reading FAILED" shape that a
    `cmd | tail` produces.
    """
    result, counts = visium_image_suite_run
    assert result.returncode == 0, (
        "the sibling importer's image suites FAILED against the moved `ome_writer.py`. "
        "That is a regression in shipped behaviour, not a Xenium problem — the promotion "
        "and the `require_micron_scale` generalisation must leave every pixel-space path "
        f"bit-identical.\n\nstdout:\n{result.stdout[-6000:]}\n\nstderr:\n{result.stderr[-2000:]}"
    )


def test_that_run_actually_collected_the_sibling_suites(visium_image_suite_run):
    """TEST-20 — THE CONTROL. An exit code of 0 on zero collected tests is not a pass.

    `pytest` exits 0 while printing `no tests ran` if a path stops matching, and a suite
    silently renamed out from under this file would then certify itself green. So the
    number of tests that ran is asserted against a floor derived from what those modules
    hold today.
    """
    result, counts = visium_image_suite_run
    assert counts, (
        "the sibling run produced no JUnit report at all, so nothing here knows whether it "
        f"ran. stdout:\n{result.stdout[-3000:]}"
    )
    assert counts["failures"] == 0 and counts["errors"] == 0
    assert counts["tests"] >= 60, (
        f"only {counts['tests']} sibling tests were collected; those four modules hold 68 "
        "today, so a number well below that means a module stopped being collected and "
        "this regression proof quietly shrank to nothing"
    )
    assert counts["skipped"] == 0, (
        f"{counts['skipped']} sibling test(s) SKIPPED. A skip is not a pass, and a suite "
        "that starts skipping is a regression proof that stopped proving"
    )


def test_the_four_named_suites_all_exist():
    """TEST-20 — the paths above are real, so a rename cannot make this file inert.

    Checked separately from the run because a missing path makes pytest exit non-zero for a
    reason that has nothing to do with a regression, and the two failures need different
    fixes.
    """
    for suite in VISIUM_IMAGE_SUITES:
        assert (PACKAGES / suite).exists(), (
            f"{suite} no longer exists. If the sibling's suites moved, update this list — "
            "an unreachable path turns the regression proof into a no-op."
        )
