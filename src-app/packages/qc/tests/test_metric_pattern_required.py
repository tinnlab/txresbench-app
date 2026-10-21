#!/usr/bin/env python3
# ruff: noqa
"""A PATTERN metric with NO pattern is REFUSED — it is not a metric.

The defect this pins is a SILENT WRONG ANSWER, not a crash. `parse_qc_metrics`
compiled an absent pattern through `m.get("pattern", "")`, and `re.compile("")`
matches EVERY gene:

    {"name": "tss_enrichment", "source": "fragments"}   # no `pattern` key
      -> {"name": "tss_enrichment", "pattern": ""}
      -> rx.match(g) is not None  for every g
      -> pct_tss_enrichment == 100.0 on every cell

100 % is plausible-looking, carries no warning, lands in `obs.json` as a real
column, and is plotted by the canvas beside the metrics that ARE real. Nobody
downstream can tell it apart from a computed number.

The `""` DEFAULT is the defect, independent of which row triggered it. The one
shipped row that reached it (`qc.addTss`, retired with this change) was an ATAC
TSS-enrichment preset — a metric computed from FRAGMENT POSITIONS relative to a
TSS annotation, which is not a gene-name regex at all and has no input slot on
this analysis. But `qc.addMetric` appends `{id: "", name: "", pattern: ""}`, so
ANY user who adds a custom metric and presses Run without typing a regex hits the
same path. Removing one row would have left the trap.

The severity split mirrors the one `require_paired_gene_names` already argues:

  * a metric the caller SELECTED and cannot be answered -> FATAL. "the warning is
    inside the artifact, not on the path to the screen, so the visible result is
    still a metric the caller selected and did not get. The only answer that
    cannot be misread is refusing."
  * a metric whose pattern EXISTS but is rejected for SAFETY (oversized / invalid
    / ReDoS-shaped, DEC-13) -> skipped with a recorded warning, never fatal. That
    entry is well-formed; the compute declines the VALUE and can name why.

An absent pattern is the first kind: the entry is not a well-formed metric at all,
so there is no question to decline.
"""
import importlib.util
import os

import pytest

_QC_SCRIPT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), os.pardir, "compute", "qc-10x.py")
)


def _load_qc():
    spec = importlib.util.spec_from_file_location("qc10x_pattern_required", _QC_SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


qc = _load_qc()


# ─────────────── the defect itself: an absent / empty pattern is REFUSED ──────────────

@pytest.mark.parametrize(
    "entry",
    [
        # the exact row the retired `qc.addTss` action appended — `source` is a key
        # `parse_qc_metrics` has never read, so the row arrived pattern-less.
        {"id": "", "name": "tss_enrichment", "source": "fragments", "aggregation": "percentage"},
        # the `pattern` key present but empty — what `qc.addMetric`'s blank row is
        # until the user types a regex.
        {"id": "", "name": "custom", "pattern": "", "aggregation": "percentage"},
        # a wholly blank row: `sanitize("" or "metric")` names it `metric`.
        {"id": "", "name": "", "pattern": "", "aggregation": "percentage"},
        # explicit null.
        {"name": "nulled", "pattern": None, "aggregation": "sum"},
    ],
)
def test_pattern_less_metric_is_refused(entry):
    """No pattern ⇒ `MissingGenePattern`, NOT a metric carrying `pattern: ""`."""
    with pytest.raises(qc.MissingGenePattern):
        qc.parse_qc_metrics({"qc_metrics": [entry]}, [])


def test_refusal_is_fatal_not_a_recorded_warning():
    """It RAISES rather than recording a warning and dropping the row.

    A dropped row is the failure mode `require_paired_gene_names` already refuses:
    the caller selected a metric, the run reported success, and nothing on the path
    to the screen said the column is missing."""
    warnings = []
    with pytest.raises(qc.MissingGenePattern):
        qc.parse_qc_metrics(
            {"qc_metrics": [{"name": "tss_enrichment", "aggregation": "percentage"}]}, warnings)


def test_missing_pattern_is_a_valueerror_subclass():
    """`MissingGenePattern` extends `ValueError`, so any existing
    `except ValueError` around the metric helpers still catches it."""
    assert issubclass(qc.MissingGenePattern, ValueError)


def test_compile_gene_pattern_refuses_the_empty_pattern_directly():
    """The helper itself refuses — the trap is closed for EVERY caller, not just
    `parse_qc_metrics`. It is a public helper (the off-sandbox suites import it by
    path), so a future second caller inherits the refusal."""
    for empty in ("", None):
        with pytest.raises(qc.MissingGenePattern):
            qc.compile_gene_pattern(empty, "anything")


def test_the_empty_pattern_would_have_matched_every_gene():
    """WHY it is refused, stated as an executable fact rather than a claim: the
    empty regex flags 100 % of any gene list, so the emitted `pct_` column is
    ~100 on every cell. This is the number the refusal prevents."""
    import re

    genes = ["MT-CO1", "ACTB", "RPS12", "GAPDH", "XIST"]
    rx = re.compile("")  # what `m.get("pattern", "")` used to produce
    assert all(rx.match(g) is not None for g in genes)


# ───────────────────────── negative controls: what must STILL work ────────────────────

def test_a_whole_gene_set_row_is_a_PATTERN_and_is_accepted():
    """The critical negative control, restated for the vocabulary that replaced the
    builtins. `total_counts` / `n_genes` used to be pattern-LESS builtin selections, and
    the refusal had to be careful not to catch them. They are `.*` rows now, so they carry
    a real pattern and pass the refusal by being well-formed rather than by exemption —
    which is the whole point of deleting the special case."""
    metrics = qc.parse_qc_metrics(
        {"qc_metrics": [
            {"name": "total_counts", "pattern": ".*", "aggregation": "sum"},
            {"name": "n_genes", "pattern": ".*", "aggregation": "count"},
            {"name": "pct_mito", "pattern": r"^MT-|^mt-", "aggregation": "percentage"},
        ]},
        [],
    )
    assert [m["name"] for m in metrics] == ["total_counts", "n_genes", "pct_mito"]
    for m in metrics:
        assert m["pattern"], m


def test_the_shipped_default_set_still_parses():
    """`DEFAULT_QC_METRICS` is the value used when `params.json` omits `qc_metrics` — it
    must survive BOTH refusals (a pattern on every row, an aggregation on every row)."""
    assert qc.parse_qc_metrics({}, []) == [
        {"name": "total_counts", "pattern": r".*", "aggregation": "sum"},
        {"name": "n_genes", "pattern": r".*", "aggregation": "count"},
        {"name": "pct_mito", "pattern": r"^MT-|^mt-", "aggregation": "percentage"},
        {"name": "pct_ribo", "pattern": r"^(RP[SL]|Rp[sl])", "aggregation": "percentage"},
    ]


def test_a_rejected_but_PRESENT_pattern_is_still_a_warning_not_a_refusal():
    """The other half of the severity split (DEC-13 preserved): an oversized /
    invalid / ReDoS-shaped pattern EXISTS, so it is declined with a recorded
    warning and the rest of the run proceeds."""
    warnings = []
    metrics = qc.parse_qc_metrics(
        {"qc_metrics": [
            {"name": "bad", "pattern": "(", "aggregation": "sum"},          # invalid regex
            {"name": "redos", "pattern": "(a+)+", "aggregation": "sum"},    # nested unbounded quantifier
            {"name": "huge", "pattern": "a" * (qc.MAX_PATTERN_LEN + 1), "aggregation": "sum"},
            {"name": "pct_mito", "pattern": r"^MT-", "aggregation": "percentage"},
        ]},
        warnings,
    )
    assert metrics == [{"name": "pct_mito", "pattern": r"^MT-", "aggregation": "percentage"}]
    assert len(warnings) == 3


def test_no_parsed_metric_can_ever_carry_an_empty_pattern():
    """The invariant, asserted over the whole accepted output rather than one row:
    whatever `parse_qc_metrics` RETURNS is safe to `re.compile` and match, because
    nothing in it matches every gene."""
    metrics = qc.parse_qc_metrics(
        {"qc_metrics": [
            {"name": "pct_mito", "pattern": r"^MT-|^mt-", "aggregation": "percentage"},
            {"name": "pct_ribo", "pattern": r"^(RP[SL]|Rp[sl])", "aggregation": "percentage"},
            {"name": "pct_hb", "pattern": r"^HB[^(P)]", "aggregation": "percentage"},
            {"name": "pct_isotype", "pattern": r"^IgG|_control", "aggregation": "percentage"},
        ]},
        [],
    )
    assert len(metrics) == 4
    for m in metrics:
        assert m["pattern"], f"metric {m['name']!r} came back with an empty pattern"


# ───────── the same property through the REAL script (the run that emitted 100 %) ────
#
# The unit tests above pin the helper. This one pins `main`'s wiring — that the raise
# becomes a `fail` with a diagnostic the runner surfaces, and (the part that actually
# matters) that no `pct_` column is written. A helper that raises into a `main` which
# swallowed it would leave the silent 100 % column exactly where it was.

from qc_fixtures import counts_matrix  # noqa: E402


def test_the_real_run_refuses_a_pattern_less_metric_and_emits_no_column(qc_run):
    r = qc_run()
    dense = counts_matrix(6, 5, seed=3)
    r.add_matrix(dense)
    r.add_column(["MT-CO1", "ACTB", "RPS12", "GAPDH", "XIST"], slot="gene_names")

    proc = r.run({"qc_metrics": [
        {"name": "total_counts", "pattern": ".*", "aggregation": "sum"},
        # exactly the row the retired `qc.addTss` appended, with a valid aggregation added
        # so the refusal under test is the PATTERN one and not DEC-4's.
        {"id": "", "name": "tss_enrichment", "source": "fragments", "aggregation": "percentage"},
    ]})

    assert proc.returncode != 0, (
        "the run SUCCEEDED with a pattern-less metric — that is the silent wrong answer:\n"
        f"--- stdout ---\n{proc.stdout}\n--- stderr ---\n{proc.stderr}"
    )
    diag = r.diagnostics(proc)
    assert "tss_enrichment" in diag, f"the diagnostic does not name the offending metric: {diag!r}"
    assert "no gene pattern" in diag, f"the diagnostic does not say WHY: {diag!r}"
    # …and nothing was written. Before the fix this run exited 0 and `obs.json` carried
    # `pct_tss_enrichment` at 100.0 for every cell.
    assert not (r.outputs_dir / "obs.json").exists(), (
        "a refused run still wrote obs.json — check whether it carries pct_tss_enrichment"
    )


def test_the_real_run_still_computes_a_metric_that_HAS_a_pattern(qc_run):
    """Negative control for the test above: the same shape, with the pattern supplied,
    runs and produces a value that is NOT 100 % (i.e. the regex was really applied)."""
    r = qc_run()
    dense = counts_matrix(6, 5, seed=3)
    r.add_matrix(dense)
    r.add_column(["MT-CO1", "ACTB", "RPS12", "GAPDH", "XIST"], slot="gene_names")

    r.run_ok({"qc_metrics": [
        {"name": "pct_mito", "pattern": "^MT-", "aggregation": "percentage"}]})
    cols = r.emitted_columns()
    mito = [c for c in cols if c.endswith("pct_mito")]
    assert mito, f"expected a pct_mito column, got {cols}"
    values = r.column_values(mito[0])
    assert values and all(0.0 < v < 100.0 for v in values), (
        f"pct_mito should be a real fraction of one matching gene out of five, got {values}"
    )


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__]))
