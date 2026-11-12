#!/usr/bin/env python3
# ruff: noqa
"""_regime — the R1/R2/R3 classifier (ITEM-9 / INV-2 / DEC-4).

The refusal contract is keyed on the PROVENANCE of the grouping column, NOT on the analysis
the user asked for (INV-2). Two independent invalidity problems (INV-1): SELECTION (the groups
were defined from the matrix you then test) and REPLICATION (cells are not replicates).
Pseudobulk fixes replication and does NOTHING for selection — so a matrix-derived grouping is
R2 (descriptive, no p) no matter how many samples exist.

Truth table (TEST-17):
  · matrix-derived provenance (clustering / annotation / cell-type prediction) ⇒ R2
  · external metadata + a sample column + ≥2 samples per side               ⇒ R1
  · external metadata + one sample per side (unreplicated)                  ⇒ R3
  · NO provenance bit at all                                                ⇒ R2 (DEC-4)

A no-provenance grouping defaults CONSERVATIVELY to R2 (never R1): a wrong default manufactures
a false p-value, and the annotation feature that would stamp a genuine external-provenance bit
is unbuilt. R1 is granted ONLY on POSITIVE evidence.
"""

# The regime vocabulary (also the `de/result` `regime` enum, DEC-8). R1_prime (count-splitting)
# is DECLARED but NOT produced in v1 (ITEM-12 descoped).
R1 = "R1"          # inferential — a genuine test (p-values + FDR written)
R2 = "R2"          # descriptive — ranked effect only (p ABSENT, not 1)
R3 = "R3"          # unreplicated — ranked effect only (p ABSENT)
R1_PRIME = "R1_prime"  # declared-only in v1 (count-splitting, ITEM-12 descoped)

REGIMES = (R1, R2, R3, R1_PRIME)

#: The `attributes.txr` sub-keys that mark a grouping as MATRIX-DERIVED (defined from the same
#: matrix, so testing it is circular — double dipping). A column carrying any of these is R2.
MATRIX_DERIVED_KEYS = ("clustering", "annotation", "prediction", "cell_type_prediction",
                       "leiden", "louvain", "embedding_cluster")


def is_matrix_derived(provenance):
    """Does the grouping column's `attributes.txr` mark it as derived from the matrix? Any
    MATRIX_DERIVED_KEYS sub-key, or an explicit `{"derived_from_matrix": true}` / a
    `provenance` == 'matrix-derived' tag."""
    if not isinstance(provenance, dict):
        return False
    if provenance.get("derived_from_matrix") is True:
        return True
    if str(provenance.get("provenance") or "") in ("matrix-derived", "derived"):
        return True
    return any(k in provenance for k in MATRIX_DERIVED_KEYS)


def is_external(provenance):
    """POSITIVE external-provenance evidence: the column explicitly declares it came from
    OUTSIDE the matrix (imported metadata / a supporting file). Absent evidence is NOT external
    — DEC-4 defaults conservatively to R2, so this returns True only on a positive tag."""
    if not isinstance(provenance, dict):
        return False
    if provenance.get("external") is True:
        return True
    src = str(provenance.get("provenance") or provenance.get("source") or "")
    return src in ("external", "imported", "metadata", "supporting-file")


def classify(provenance, *, samples_per_side=None):
    """Classify the regime from the grouping column's provenance (INV-2).

    `provenance` — the grouping column's `attributes.txr` dict (may be `{}`).
    `samples_per_side` — for `de.compare`, the min count of DISTINCT samples across the two
    sides of the contrast (an int); `None` for `de.markers` (no sample column).

    Returns one of R1 / R2 / R3. A matrix-derived OR no-evidence grouping is R2 (DEC-4). R1 is
    granted ONLY when the grouping is POSITIVELY external AND ≥2 samples per side; a positively
    external but 1-sample/side grouping is R3.
    """
    if is_matrix_derived(provenance):
        return R2
    if not is_external(provenance):
        # DEC-4 — no positive external-provenance evidence ⇒ conservative R2, never R1.
        return R2
    # Positively external. Replication decides R1 vs R3.
    if samples_per_side is None:
        # No sample column supplied to an external grouping ⇒ unreplicated ⇒ R3.
        return R3
    return R1 if int(samples_per_side) >= 2 else R3


def classify_contrast(provenances, *, samples_per_side=None):
    """Classify the regime for an ADVANCED (criteria-built) contrast, CONSERVATIVELY over the
    COMBINED provenance of EVERY criterion column of BOTH groups (INV-A4 / DEC-A3).

    `provenances` — the list of `attributes.txr` dicts, one per criterion column across
    `group1` AND `group2` (order irrelevant). `samples_per_side` — the min distinct samples
    across the two mask-defined sides (an int), or `None` when no sample column is bound.

    The double-dipping back-door guard: the flexible builder must not become a way to define a
    contrast from the same matrix you then test. So:

      · if ANY criterion column of EITHER group is matrix-derived (clustering / annotation /
        prediction) ⇒ R2 — no p, no matter how many samples exist (pseudobulk fixes REPLICATION
        and does NOTHING for the circular SELECTION, INV-1);
      · else if EVERY criterion column is POSITIVELY external AND a sample column gives
        ≥2 samples/side ⇒ R1 (a genuine inferential test);
      · else ⇒ R3/R2 per the v1 rules — an all-external but unreplicated contrast is R3
        (ranked effect only), and any column lacking positive external evidence defaults
        CONSERVATIVELY to R2 (DEC-4: R1 is granted only on positive evidence for ALL columns).

    An empty `provenances` (a group with no constraining criterion) carries NO positive external
    evidence, so it defaults to R2 — never R1.
    """
    provs = [p if isinstance(p, dict) else {} for p in (provenances or [])]
    # ANY matrix-derived column of EITHER group ⇒ R2 (the back-door guard). Walk them ALL —
    # a miss on group2's provenance re-opens exactly the double-dipping this feature closes.
    if any(is_matrix_derived(p) for p in provs):
        return R2
    # R1 requires POSITIVE external evidence on EVERY criterion column (not merely "no derived
    # bit"): a column with no provenance is not external (DEC-4), so a single such column drops
    # the whole contrast to the conservative default.
    if provs and all(is_external(p) for p in provs):
        if samples_per_side is None:
            return R3  # external but no sample column ⇒ unreplicated
        return R1 if int(samples_per_side) >= 2 else R3
    # No positive external evidence on some (or every) column ⇒ conservative R2 (DEC-4).
    return R2


def regime_note(regime):
    """The one-line human explanation recorded in the report + result (why p is / isn't written)."""
    return {
        R1: ("Inferential — the grouping is external to the matrix and a sample column gives "
             "at least two samples per side, so a replicate-aware pseudobulk test is valid. "
             "p-values and FDR are written."),
        R2: ("Descriptive — the grouping was derived from this matrix (or carries no external "
             "provenance), so between-group p-values would be circular (double dipping). Only "
             "ranked effect size + detection rates are written; the p-value and FDR are ABSENT, "
             "not 1."),
        R3: ("Unreplicated — the grouping is external but there is only one sample per side, so "
             "a within-sample difference generalises to nothing. Only ranked effect size is "
             "written; the p-value and FDR are ABSENT."),
        R1_PRIME: ("Recovered (count-splitting) — declared but not produced in this version."),
    }.get(regime, "")
