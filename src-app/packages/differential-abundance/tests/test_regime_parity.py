#!/usr/bin/env python3
# ruff: noqa
"""TEST-6 [covers: ITEM-3] — the VENDORED regime classifier.

`run.helpers` are CONFINED to a package's own tree (`processors/mod.rs::confine_under_package`
rejects `..`), so this package cannot import `differential-expression/compute/_regime.py`. The
tree's established answer is to VENDOR the file verbatim and pin the copy with a source-parity
test — exactly how `cell-filter`'s `criteria_keep_mask` reaches both `embedding` and
`differential-expression`, pinned by `differential-expression/tests/test_criteria_parity.py`.

Two machine-enforced claims, each a silent-at-exit-0 defect if it breaks:

  1. every public function's SOURCE is byte-identical to the file it was copied from, so a
     hand-edit of the vendored span is caught directly;
  2. the whole FILE is byte-identical, so a change smuggled into a docstring, a constant or a
     private helper is caught too.

`de.compare` is deliberately UNCHANGED by this feature: `classify(provenance,
samples_per_side=…)` already had exactly the signature differential abundance needs, which is why
vendoring rather than editing was possible at all.
"""
import inspect
import importlib.util
from pathlib import Path

from da_modules import import_own

# NOT `import _regime as DA`. `differential-expression` ships a `compute/_regime.py` too — it is
# the file this one is VENDORED FROM — so the flat name is ambiguous in a whole-tree run, and the
# ambiguity is far more dangerous here than where it merely raises. If `_regime` resolved to
# differential-expression's copy, this test would compare DE against DE and PASS VACUOUSLY: a
# byte-parity guard reporting perfect parity precisely when it has lost its subject. Loading this
# package's own copy by path is what makes the comparison real.
DA = import_own("_regime")

_PACKAGES = Path(__file__).resolve().parents[2]
_SOURCE = _PACKAGES / "differential-expression" / "compute" / "_regime.py"
_VENDORED = _PACKAGES / "differential-abundance" / "compute" / "_regime.py"


def _load_source_copy():
    spec = importlib.util.spec_from_file_location("de_regime_reference", str(_SOURCE))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


DE = _load_source_copy()

FUNCTIONS = ("is_matrix_derived", "is_external", "classify", "classify_contrast", "regime_note")


def test_every_vendored_function_source_is_byte_identical():
    for fn in FUNCTIONS:
        assert inspect.getsource(getattr(DA, fn)) == inspect.getsource(getattr(DE, fn)), (
            f"the vendored `{fn}` has drifted from differential-expression's copy. Vendoring "
            "means VERBATIM — a forked classifier would let the two analyses disagree about when "
            "a p-value may be written.")


def test_the_vendored_constants_are_identical():
    assert DA.REGIMES == DE.REGIMES
    assert (DA.R1, DA.R2, DA.R3, DA.R1_PRIME) == (DE.R1, DE.R2, DE.R3, DE.R1_PRIME)
    assert DA.MATRIX_DERIVED_KEYS == DE.MATRIX_DERIVED_KEYS


def test_the_whole_file_is_byte_identical():
    assert _VENDORED.read_bytes() == _SOURCE.read_bytes(), (
        "the vendored `_regime.py` is not byte-identical to the file it was copied from")


def test_the_classifier_still_behaves_as_the_truth_table_says():
    """Not a tautology against the copy — the TRUTH TABLE, restated here, so a change made to
    BOTH files at once (which the byte-parity checks above would happily accept) still has to
    face what the classifier is for."""
    assert DA.classify({"clustering": {}}, samples_per_side=5) == DA.R2       # matrix-derived
    assert DA.classify({}, samples_per_side=5) == DA.R2                        # no evidence
    assert DA.classify({"external": True}, samples_per_side=5) == DA.R1        # external + reps
    assert DA.classify({"external": True}, samples_per_side=1) == DA.R3        # unreplicated
    assert DA.classify({"external": True}, samples_per_side=None) == DA.R3     # no sample column
