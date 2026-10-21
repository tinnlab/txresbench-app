#!/usr/bin/env python3
# ruff: noqa
"""TEST-7 [acceptance] [invariant: INV-DA-3] [covers: ITEM-8]

The regime is classified on the CONDITION, never on the population.

This is the sharpest difference between differential abundance and `de.compare`. There, ONE column
is both the thing that defines the groups and the thing being tested, so a single `classify` call
covers everything. Here they SEPARATE: the POPULATION defines the count matrix's rows, the
CONDITION defines the tested coefficient.

Getting it wrong does not produce a wrong number — it produces NO numbers. DA populations are
matrix-derived BY CONSTRUCTION (there is no such thing as differential abundance over populations
that were not derived from the matrix), so classifying on the population would return R2 for every
run that could ever exist and the feature would never write a p-value. It is also not the
double-dipping `de.compare`'s INV-2 guards against, because the population boundaries were drawn
CONDITION-BLIND: the clustering never saw the condition label, so the null distribution of the
abundance statistic is not distorted by the selection.

The test is deliberately built so the two possible answers DISAGREE — a matrix-derived population
with an external condition — and asserts the answer follows the CONDITION. A test where both
columns carried the same provenance would pass either way and prove nothing.
"""
import pytest

from da_fixtures import population_dataset, EXTERNAL, MATRIX_DERIVED


def _bind(run, *, population_provenance, condition_provenance, samples_per_side=3):
    pops, conds, samps = population_dataset(n_per_sample=150, samples_per_side=samples_per_side)
    run.add_column(pops, slot="population", name="leiden", provenance=population_provenance)
    run.add_column(conds, slot="condition", name="condition", provenance=condition_provenance)
    run.add_column(samps, slot="sample", name="sample")
    return pops, conds, samps


def test_a_matrix_derived_population_with_an_external_condition_is_still_R1(clusters_run):
    """The case that would kill the feature if the classifier were pointed at the population: a
    cluster label IS matrix-derived, and it is the normal input. The regime must follow the
    CONDITION, which is external and replicated, so p-values ARE written."""
    run = clusters_run()
    _bind(run, population_provenance=MATRIX_DERIVED, condition_provenance=EXTERNAL)
    run.run_ok({"method": "nb_glm", "group1": "treat", "group2": "ctrl"})
    report = run.report()
    assert report["regime"] == "R1", (
        "a matrix-derived population column with an external, replicated condition must be R1. "
        "R2 here means the classifier was pointed at the population, which would make every "
        "differential-abundance run descriptive forever.")
    assert report["pvalues_written"] is True
    assert report["regime_classified_on"] == "condition"
    entry = run.da_entries()[0]
    members = run.da_members(entry)
    assert {"neglog10p", "padj"} <= members


def test_an_external_population_with_a_no_provenance_condition_is_R2(clusters_run):
    """The mirror image: swap which column carries the evidence and the answer flips. Together
    with the test above this pins the DIRECTION of the dependency, which a single case cannot."""
    run = clusters_run()
    _bind(run, population_provenance=EXTERNAL, condition_provenance=None)
    run.run_ok({"method": "nb_glm", "group1": "treat", "group2": "ctrl"})
    report = run.report()
    assert report["regime"] == "R2", (
        "a condition with no positive external provenance defaults conservatively to R2 "
        "regardless of what the population column declares")
    assert report["pvalues_written"] is False
    entry = run.da_entries()[0]
    members = run.da_members(entry)
    assert "neglog10p" not in members and "padj" not in members


def test_one_sample_per_side_is_R3_even_with_an_external_condition(clusters_run):
    """Replication is the other half. An external condition with a single sample per side is
    unreplicated: the difference generalises to nothing, so no p is written."""
    run = clusters_run()
    _bind(run, population_provenance=MATRIX_DERIVED, condition_provenance=EXTERNAL,
          samples_per_side=1)
    run.run_ok({"method": "nb_glm", "group1": "treat", "group2": "ctrl"})
    report = run.report()
    assert report["regime"] == "R3"
    assert report["pvalues_written"] is False
    assert report["samples_per_side"] == 1


def test_the_population_provenance_is_recorded_but_never_classified_on(clusters_run):
    """Recorded, so a reader can see what the populations were; not classified on, so the feature
    works. The report must carry BOTH provenances and say which one decided."""
    run = clusters_run()
    _bind(run, population_provenance=MATRIX_DERIVED, condition_provenance=EXTERNAL)
    run.run_ok({"method": "nb_glm", "group1": "treat", "group2": "ctrl"})
    report = run.report()
    assert report["population_provenance"].get("clustering"), (
        "the population's provenance must be recorded even though it is not classified on")
    assert report["condition_provenance"].get("external") is True
    assert report["regime_classified_on"] == "condition"


def test_the_resolution_sensitivity_disclosure_is_mandatory_on_cluster_results(clusters_run):
    """INV-DA-3's second half. Classifying on the condition is only defensible BECAUSE the
    interpretation risk is disclosed instead: a cluster is an arbitrary partition, so the result
    is sensitive to the resolution it was drawn at."""
    run = clusters_run()
    _bind(run, population_provenance=MATRIX_DERIVED, condition_provenance=EXTERNAL)
    run.run_ok({"method": "nb_glm", "group1": "treat", "group2": "ctrl"})
    report = run.report()
    disclosure = report["resolution_sensitivity"]
    assert "RESOLUTION" in disclosure.upper()
    assert "da.neighbourhoods" in disclosure, (
        "the disclosure must point at the resolution-free complement, or it is a warning with no "
        "action attached")
    entry = run.da_entries()[0]
    assert run.da_cyto(entry)["da"]["resolution_sensitivity"] == disclosure, (
        "the disclosure must ride the ARTIFACT too — a reader who opens the table without the "
        "report still has to see it")
    assert "RELATIVE" in report["relative_abundance_caveat"].upper()
