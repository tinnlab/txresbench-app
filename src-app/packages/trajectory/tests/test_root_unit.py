#!/usr/bin/env python3
# ruff: noqa
"""TEST-32 — `_root` driven DIRECTLY, for the paths a subprocess fixture cannot reach.

Every other test of this module goes through the real compute as a subprocess, which is the
right way to test the pipeline and the wrong way to test a pure function's edges: a fixture
cannot hand the resolver a degenerate diffusion basis, a magnitude tie, or a mismatched key
list, because the compute refuses those inputs long before the resolver sees them.

So three refusals added or hoisted during the audit rounds had NO test at all — they were
code written in response to a finding, with nothing holding them shut. Grepping the suite for
their message strings returned nothing. This file is that hold.

It also closes two assertions that were passing without meaning anything: `tie_count` was
only ever asserted `>= 1`, which `_extremal` returns unconditionally, and the "honours the
component" test varied only the direction.

Mutation: return a constant `1` from `_extremal`'s tie count -> the duplicate-extremum test
fails. Drop the sign canonicalisation -> the negated-input test fails. Drop the finite mask
from `_extremal` -> the all-NaN test raises IndexError instead of refusing.
"""
import importlib.util
import sys
from pathlib import Path

import pytest

np = pytest.importorskip("numpy")

_COMPUTE = Path(__file__).resolve().parents[1] / "compute"


class Refused(Exception):
    """What the compute's `fail` does, in a form a unit test can catch."""


def _fail(message, code=2):
    raise Refused(message)


@pytest.fixture(scope="module")
def R():
    sys.path.insert(0, str(_COMPUTE))
    spec = importlib.util.spec_from_file_location("trajectory_root_unit", _COMPUTE / "_root.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _basis(column, n_comps=11):
    """A diffusion basis whose component 1 is `column` and whose rest is zeros."""
    out = np.zeros((len(column), n_comps), dtype=np.float64)
    out[:, 1] = column
    return out


# ── canonicalize_sign ─────────────────────────────────────────────────────────────────
def test_the_sign_is_pinned_to_the_largest_magnitude_entry(R):
    values, flipped, tied = R.canonicalize_sign([0.1, -0.9, 0.2])
    assert flipped is True and tied == 0
    assert values[1] == pytest.approx(0.9)


def test_a_component_and_its_negation_canonicalise_to_the_SAME_thing(R):
    """The property the whole fix exists for, at the unit level: the solver may hand back
    either sign, and both must resolve identically."""
    a, _f, _t = R.canonicalize_sign([0.1, -0.9, 0.2])
    b, _f2, _t2 = R.canonicalize_sign([-0.1, 0.9, -0.2])
    assert np.allclose(a, b)


def test_an_exact_opposite_sign_magnitude_tie_is_REFUSED_not_broken_silently(R):
    """Unreachable through the compute (no fixture can produce it), and the one case the
    rule genuinely cannot decide — so it refuses rather than picking an end by array order."""
    with pytest.raises(Refused) as exc:
        R.resolve("diffusion_extreme", diffmap=_basis([0.5, -0.5, 0.1]), fail=_fail)
    assert "cannot be canonicalised" in str(exc.value)
    assert "arbitrary" in str(exc.value)


def test_a_non_finite_entry_does_not_fake_a_sign_tie(R):
    """`np.sign(nan)` is `nan`, so a NaN alongside a zero used to read as "a positive and a
    negative entry" and refuse with a stated cause that was simply false."""
    _values, _flipped, tied = R.canonicalize_sign([0.0, 0.0, float("nan")])
    assert tied == 0, "a NaN was counted as an opposite-signed extremum"


# ── _extremal ─────────────────────────────────────────────────────────────────────────
def test_the_tie_count_is_a_real_count_not_a_constant(R):
    """`tie_count` was only ever asserted `>= 1`, which is unconditionally true — replacing
    it with the constant 1 passed the entire suite. A tie is a real event and the provenance
    has to show it, so it is counted here against a deliberately duplicated extremum."""
    index, tied = R._extremal([5.0, 1.0, 1.0, 7.0], "min")
    assert index == 1 and tied == 2
    index, tied = R._extremal([5.0, 1.0, 2.0], "min")
    assert index == 1 and tied == 1


def test_an_all_non_finite_column_refuses_instead_of_raising_IndexError(R):
    """A degenerate eigendecomposition puts NaNs in a component; comparing against a NaN
    extremum matches nothing, and the pre-fix code indexed an empty array."""
    nan = float("nan")
    with pytest.raises(Refused) as exc:
        R.resolve("diffusion_extreme", diffmap=_basis([nan, nan, nan]), fail=_fail)
    assert "no finite values" in str(exc.value)
    assert "degenerate" in str(exc.value)


# ── the hoisted key-length check ──────────────────────────────────────────────────────
@pytest.mark.parametrize("mode", ["root_cluster", "diffusion_extreme", "barcode"])
def test_a_short_key_list_refuses_in_EVERY_mode(R, mode):
    """The check used to live inside the barcode branch only, so the other two modes raised a
    bare IndexError on the same input — from a module whose premise is that every refusal is
    by name."""
    with pytest.raises(Refused) as exc:
        R.resolve(mode, diffmap=_basis([0.3, -0.9, 0.2]), labels=["a", "a", "b"], level="a",
                  barcode="k0", axis_keys=["k0", "k1"], fail=_fail)
    assert "keys but the embedding has" in str(exc.value)


# ── the component is genuinely honoured ───────────────────────────────────────────────
def test_the_named_COMPONENT_actually_selects_the_cell(R):
    """Every run in the rest of the suite uses component 1, so a compute that validated the
    component and then used 1 regardless would pass all of it. Two components with different
    extrema, and the answer must follow the one that was named."""
    basis = np.zeros((4, 4), dtype=np.float64)
    basis[:, 1] = [0.9, 0.1, 0.2, 0.3]   # max at row 0
    basis[:, 2] = [0.1, 0.2, 0.3, 0.9]   # max at row 3
    one = R.resolve("diffusion_extreme", diffmap=basis, component=1, direction="max",
                    fail=_fail)
    two = R.resolve("diffusion_extreme", diffmap=basis, component=2, direction="max",
                    fail=_fail)
    assert one["index"] == 0 and one["component"] == 1
    assert two["index"] == 3 and two["component"] == 2


# ── the tip rule, at the unit level ───────────────────────────────────────────────────
def test_the_tip_rule_picks_the_member_furthest_from_everything_else(R):
    """A population strung out along one axis: its tip is the end AWAY from the rest, and
    that must not depend on which way the component happens to point."""
    basis = np.zeros((6, 11), dtype=np.float64)
    #        level cells .......   others .......
    basis[:, 1] = [0.0, 1.0, 2.0,  8.0, 9.0, 10.0]
    labels = ["L", "L", "L", "O", "O", "O"]
    picked = R.resolve("root_cluster", diffmap=basis, n_dcs=10, labels=labels, level="L",
                       fail=_fail)
    assert picked["index"] == 0, "the tip is the end furthest from the other cells"

    # …and the SAME answer when the component is negated, which is the whole point of using
    # a distance rather than a signed extremum.
    negated = basis.copy()
    negated[:, 1] *= -1
    assert R.resolve("root_cluster", diffmap=negated, n_dcs=10, labels=labels, level="L",
                     fail=_fail)["index"] == 0


def test_a_single_level_column_measures_the_tip_against_itself(R):
    """Nothing lies outside the level, so the only available reference is its own centre —
    the same statement, made with what there is, rather than a crash."""
    basis = np.zeros((4, 11), dtype=np.float64)
    basis[:, 1] = [0.0, 0.1, 0.2, 5.0]
    picked = R.resolve("root_cluster", diffmap=basis, n_dcs=10,
                       labels=["L"] * 4, level="L", fail=_fail)
    assert picked["measured_against"] == "the level itself"
    assert picked["index"] == 3


def test_root_cluster_never_reads_the_single_component_controls(R):
    """It resolves over the whole basis, so a component setting that would be REFUSED in the
    other mode must not refuse here — validating a setting a mode does not consult would
    reject a run over something it never used."""
    basis = np.zeros((6, 11), dtype=np.float64)
    basis[:, 1] = [0.0, 1.0, 2.0, 8.0, 9.0, 10.0]
    labels = ["L", "L", "L", "O", "O", "O"]
    picked = R.resolve("root_cluster", diffmap=basis, n_dcs=10, labels=labels, level="L",
                       component=999, direction="sideways", fail=_fail)
    assert picked["index"] == 0
    assert "component" not in picked and "direction" not in picked
