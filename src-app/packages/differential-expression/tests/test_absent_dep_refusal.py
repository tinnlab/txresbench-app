#!/usr/bin/env python3
# ruff: noqa
"""TEST-15 [covers: ITEM-7] — with a compare dep forced absent, de.compare emits the package's
NAMED refusal (pointing at the rootfs pin), never a raw ImportError; the seam can only DISABLE
(mirrors embedding `import_harmonypy`)."""
from de_fixtures import two_group_expression, group_labels, sample_labels, EXTERNAL

import _methods as METH


def _fail(msg):
    raise RuntimeError(msg)


def test_pydeseq2_absent_yields_a_named_refusal(compare_run):
    # C5 — the R1 refusal is gated on the chosen METHOD's dep (pydeseq2), NOT on decoupler; the
    # refusal is named + points at the rootfs pin, never a raw ImportError.
    run = compare_run()
    run.add_expression(two_group_expression())
    run.add_column(group_labels(), slot="grouping", name="condition", provenance=EXTERNAL)
    run.add_column(sample_labels(per_side=2), slot="sample", name="donor")  # R1 path
    proc = run.run({"group1": "g0", "group2": "g1", "method": "pydeseq2"},
                   env_extra={"DE_FORCE_PYDESEQ2_ABSENT": "1"})
    assert proc.returncode != 0
    msg = run.diagnostics(proc)
    assert "de.compare:" in msg
    assert "pydeseq2" in msg and "rootfs" in msg  # named, and points at the pin
    assert "Traceback" not in proc.stderr.split("de.compare:")[0][-200:]  # not a raw ImportError


def test_decoupler_absent_does_not_block_r1_aggregation_is_local(compare_run):
    # C5 (mutation killer) — decoupler is NOT the aggregator (a local banded sum is), so forcing
    # it ABSENT must NOT refuse. `nb_glm` runs on statsmodels (in the rootfs), so R1 still writes
    # p and records the honest `local-banded-sum` aggregation. Re-adding a decoupler hard-gate to
    # the R1 path makes this run refuse → the test goes red.
    import pytest
    pytest.importorskip("statsmodels")
    run = compare_run()
    run.add_expression(two_group_expression())
    run.add_column(group_labels(), slot="grouping", name="condition", provenance=EXTERNAL)
    run.add_column(sample_labels(per_side=2), slot="sample", name="donor")
    proc = run.run({"group1": "g0", "group2": "g1", "method": "nb_glm"},
                   env_extra={"DE_FORCE_DECOUPLER_ABSENT": "1"})
    assert proc.returncode == 0, proc.stderr[-2000:]
    assert run.report()["regime"] == "R1"
    assert run.report()["pvalues_written"] is True
    assert run.report()["pseudobulk"]["api"] == "local-banded-sum"  # honest aggregation record
    assert "neglog10p" in run.de_members(run.de_entries()[0])


def test_pydeseq2_force_absent_is_a_named_refusal_not_import_error():
    import pytest
    with pytest.raises(RuntimeError) as e:
        METH._run_pydeseq2(None, None, ("g0", "g1"), fail=_fail, force_absent=True)
    assert "pydeseq2" in str(e.value) and "rootfs" in str(e.value)


def test_statsmodels_force_absent_is_a_named_refusal():
    import pytest
    with pytest.raises(RuntimeError) as e:
        METH._run_nb_glm(None, None, ("g0", "g1"), fail=_fail, force_absent=True)
    assert "statsmodels" in str(e.value)
