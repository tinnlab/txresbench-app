#!/usr/bin/env python3
# ruff: noqa
"""_root — resolving a ROOT CELL, deterministically, and recording the rule (ITEM-6).

The pseudotime tool needs one integer row index. **Asking a user for a row index is not an
interface**, and the two idioms the ecosystem actually uses are both worse than they look:

  * the canonical tutorial does `np.flatnonzero(obs[col] == level)[0]` — i.e. it takes
    whichever cell of the chosen group happens to be FIRST IN FILE ORDER. That is not a
    rule, it is an accident, and it is **not permutation-invariant**: reorder the rows and
    you get a different root and different numbers out of an unchanged dataset.
  * the best-practices book does `obsm["X_diffmap"][:, 3].argmin()` — where BOTH the
    component index AND the argmin/argmax direction are unpinned free parameters. An
    eigenvector's sign is not determined, so that choice is a coin-flip dressed as a default.

So this module offers three modes, resolves each by a STATED rule, and records the rule
alongside the resolved cell. Every mode is permutation-invariant up to exact ties in a float
component, and the tie count is REPORTED rather than silently broken — a tie is a real
(measure-zero) event, and a silent tie-break is how a "deterministic" rule stops being one.

The root is not a tuning knob: it fixes the origin AND the direction of the whole ordering.
That is why it is recorded in the report and in the params, and why a root chosen by cluster
is described in the report, in those words, as a biological assertion by the user.
"""
import numpy as np


#: Diffusion component 0 is the trivial steady state, so a usable component starts at 1.
FIRST_NONTRIVIAL_COMPONENT = 1

MODES = ("root_cluster", "diffusion_extreme", "barcode")


def canonicalize_sign(values):
    """Fix the arbitrary SIGN of a diffusion component. Returns `(values, flipped, tied)`.

    **This is the correctness fix the whole module turns on.** An eigenvector's sign is not
    determined — the docstring above says so — and the solver does not canonicalise it, so
    the SAME data in a different row order can come back with the component negated. Taking
    an extremum of an unpinned sign then picks the OPPOSITE END of the trajectory, and every
    number downstream is a confidently backwards ordering that looks perfectly self-
    consistent.

    Measured on this package's own gating fixture: of five row permutations, two came back
    with the component exactly negated (correlation -1.000 against the unpermuted run), and
    the resolved root moved from row 3 to row 144 — the far end of the same population.

    The rule: the entry of LARGEST MAGNITUDE is made positive. That is permutation-invariant
    because it is a property of the VALUE SET rather than of any row's position, and it is
    stable because the largest-magnitude entry is the one furthest from the numerical noise
    floor. An exact magnitude tie between a positive and a negative entry is the one case the
    rule cannot decide; it is reported rather than broken silently.
    """
    values = np.asarray(values, dtype=np.float64)
    # The tie is read off the FINITE entries only. `np.sign(nan)` is `nan`, so a component
    # holding a NaN beside a zero used to present two distinct "signs" and refuse with a
    # stated cause that was false — there was no negative entry. A non-finite value is a
    # degenerate decomposition, which `_extremal` reports honestly; it is not a tie.
    finite_mask = np.isfinite(values)
    if not finite_mask.any():
        return values, False, 0
    finite_values = values[finite_mask]
    magnitude = np.abs(finite_values)
    peak = magnitude.max()
    at_peak = finite_values[magnitude == peak]
    tied = int(np.unique(np.sign(at_peak)).size > 1)
    flipped = bool(at_peak[0] < 0)
    return (-values if flipped else values), flipped, tied


def _extremal(values, direction):
    """The index of the extremal value, plus how many tied for it.

    Ties are counted, never silently broken: the caller records the count so a tie is
    visible in the provenance rather than resolved by whichever row happened to be first.

    NaN-safe: a degenerate eigendecomposition can put a NaN in a component, and comparing
    against a NaN extremum matches nothing — which used to end in an IndexError, i.e. a bare
    traceback out of a module whose whole premise is that every refusal is by name.
    """
    values = np.asarray(values, dtype=np.float64)
    finite = np.isfinite(values)
    if not finite.any():
        return None, 0
    candidates = np.where(finite, values, np.inf if direction == "min" else -np.inf)
    target = candidates.min() if direction == "min" else candidates.max()
    tied = np.flatnonzero(candidates == target)
    return int(tied[0]), int(tied.size)


def resolve(mode, *, diffmap, n_dcs=10, labels=None, level=None,
            component=FIRST_NONTRIVIAL_COMPONENT, direction="min", barcode=None,
            axis_keys=None, fail=None):
    """Resolve a root cell. Returns a record — the index AND the rule that produced it.

    `diffmap` is the `(n_cells x n_comps)` diffusion basis. `labels` / `level` drive
    `root_cluster`; `component` / `direction` drive `diffusion_extreme` (and the tie-break
    inside `root_cluster`); `barcode` / `axis_keys` drive `barcode`.

    Every refusal is BY NAME, because the alternative — a root resolved to something
    arbitrary — produces a valid-looking run whose every number is determined by a choice
    nobody made.
    """
    diffmap = np.asarray(diffmap)
    n_cells, n_comps = diffmap.shape

    if mode not in MODES:
        fail(f"unknown root mode {mode!r} — expected one of {', '.join(MODES)}")

    # Hoisted above the mode dispatch: a short key list is a misalignment whichever mode is
    # running, and indexing it later would raise a bare IndexError instead of a named refusal.
    if axis_keys is not None and len(axis_keys) != n_cells:
        fail(
            f"the bound key column holds {len(axis_keys)} keys but the embedding has "
            f"{n_cells} cells — they must be aligned over the same axis."
        )

    if mode == "barcode":
        if not barcode:
            fail("root mode `barcode` needs a `root_barcode`, and none was given.")
        if not axis_keys:
            fail(
                f"root mode `barcode` was asked for {barcode!r}, but no cells-axis key "
                "column is bound, so a barcode cannot be resolved to a row. Bind the key "
                "column on the `cell_keys` slot, or use the `root_cluster` / "
                "`diffusion_extreme` mode. The run refuses rather than guessing a row."
            )
        matches = [i for i, k in enumerate(axis_keys) if k == barcode]
        if not matches:
            fail(
                f"the root barcode {barcode!r} is not on this dataset's cells axis. Check "
                "the spelling, or pick the root by cluster instead."
            )
        if len(matches) > 1:
            fail(
                f"the root barcode {barcode!r} matches {len(matches)} rows — the key column "
                "does not uniquely identify a cell, so it cannot resolve a root."
            )
        return {
            "mode": "barcode",
            "index": int(matches[0]),
            "barcode": barcode,
            "rule": "the row whose axis key equals the barcode the user supplied",
            "tie_count": 1,
            "is_a_biological_assertion": True,
        }

    if mode == "root_cluster":
        # Dispatched BEFORE the single-component checks below: this mode uses a distance over
        # the whole basis and never reads `component`/`direction`, so validating them here
        # would refuse a run over settings it does not consult.
        return _resolve_root_cluster(
            diffmap=diffmap, n_cells=n_cells, n_dcs=n_dcs, labels=labels, level=level,
            axis_keys=axis_keys, fail=fail)

    if int(component) < FIRST_NONTRIVIAL_COMPONENT:
        fail(
            f"diffusion component {int(component)} was requested, but component 0 is the "
            f"trivial steady state and carries no ordering; use {FIRST_NONTRIVIAL_COMPONENT} "
            "or above."
        )
    if int(component) >= n_comps:
        fail(
            f"diffusion component {int(component)} was requested but only {n_comps} were "
            f"computed (0..{n_comps - 1}). Raise `n_comps`, or pick a lower component."
        )
    if direction not in ("min", "max"):
        fail(f"root direction {direction!r} must be `min` or `max` — the sign of an "
             "eigenvector is not determined, so the direction is an explicit choice.")

    # The component's sign is arbitrary and is CANONICALISED before any extremum is taken.
    # Without this the same data in a different row order can yield the opposite end of the
    # trajectory — see `canonicalize_sign`.
    column, sign_flipped, sign_tied = canonicalize_sign(diffmap[:, int(component)])
    if sign_tied:
        fail(
            f"diffusion component {int(component)} has its largest magnitude at both a "
            "positive and a negative entry, so its sign cannot be canonicalised and the "
            "direction of the ordering would be arbitrary. Pick a different component."
        )

    _SIGN_RULE = (
        "the component's arbitrary sign is canonicalised first (its largest-magnitude entry "
        "is made positive), so the same data in a different row order resolves the same cell"
    )

    if mode == "diffusion_extreme":
        index, tied = _extremal(column, direction)
        if index is None:
            fail(
                f"diffusion component {int(component)} holds no finite values, so no "
                "extremal cell exists. The eigendecomposition is degenerate; try a different "
                "component or a larger `n_comps`."
            )
        return {
            "mode": "diffusion_extreme",
            "index": index,
            "barcode": axis_keys[index] if axis_keys else None,
            "rule": (
                f"the cell with the {direction}imum value of diffusion component "
                f"{int(component)}; ties broken by the lowest row index. " + _SIGN_RULE
            ),
            "component": int(component),
            "direction": direction,
            "component_sign_flipped": sign_flipped,
            "tie_count": tied,
            # No biology is asserted here — the data alone determines the cell. The DIRECTION
            # is the user's choice, and it is recorded as one.
            "is_a_biological_assertion": False,
        }

    # unreachable: `root_cluster` returns from `_resolve_root_cluster` above, and the two
    # modes below have both returned. Kept as a loud failure rather than a silent fallthrough.
    fail(f"root mode {mode!r} reached no resolver")


def _resolve_root_cluster(*, diffmap, n_cells, n_dcs, labels, level, axis_keys, fail):
    """Mode 1 — THE TIP OF THE NAMED POPULATION.

    The user named a population, not an axis, so the root is the cell of that population
    FURTHEST from everything else — which is where a trajectory out of a starting population
    begins.

    **The rule is a DISTANCE, and that is the whole point.** A distance is invariant to the
    sign of every component it is computed from, so this mode is immune to the arbitrary
    eigenvector sign rather than being repaired against it. The earlier rule — an extremum
    along one named component — was not: once the sign was canonicalised it began selecting
    the end of the population NEAREST the rest of the data, putting the origin at the branch
    point, and pseudotime then radiated outward in both directions. Measured on the gating
    fixture: signed rho collapsed to **+0.0335**, against **+0.9964** for the tip.

    It also removes a question the user cannot answer. Which END of a population is its
    beginning is not something a diffusion component's orientation can settle, and offering a
    `direction` control here made an unanswerable question look routine.
    """
    if labels is None or level in (None, ""):
        fail(
            "root mode `root_cluster` needs a categorical column AND one of its levels — "
            "the group the trajectory is asserted to START from."
        )
    labels = [str(v) for v in labels]
    if len(labels) != n_cells:
        fail(
            f"the root-cluster column holds {len(labels)} values but the embedding has "
            f"{n_cells} cells — they must be aligned over the same axis."
        )
    member = np.flatnonzero(np.asarray(labels) == str(level))
    if member.size == 0:
        present = sorted(set(labels))
        fail(
            f"the root level {str(level)!r} does not appear in the bound column. Present "
            f"levels: {', '.join(present[:20])}"
            + (" …" if len(present) > 20 else "")
        )
    basis = np.asarray(diffmap)[:, FIRST_NONTRIVIAL_COMPONENT:
                                FIRST_NONTRIVIAL_COMPONENT + int(n_dcs)]
    basis = np.where(np.isfinite(basis), basis, 0.0)
    outside = np.setdiff1d(np.arange(n_cells), member)
    # A column with ONE level has nothing outside it, so the tip is measured from the
    # population's own centre — the same statement, made with the only reference available.
    reference = basis[outside].mean(axis=0) if outside.size else basis[member].mean(axis=0)
    local, tied = _extremal(np.linalg.norm(basis[member] - reference, axis=1), "max")
    if local is None:
        fail(
            f"no finite diffusion coordinate exists for any cell labelled {str(level)!r}, so "
            "no root can be resolved within it. The eigendecomposition is degenerate; try a "
            "larger `n_comps`."
        )
    index = int(member[local])
    return {
        "mode": "root_cluster",
        "index": index,
        "barcode": axis_keys[index] if axis_keys else None,
        "level": str(level),
        "n_cells_in_level": int(member.size),
        "n_dcs_used": int(n_dcs),
        "measured_against": "cells outside the level" if outside.size else "the level itself",
        "tie_count": tied,
        "rule": (
            f"the TIP of the named population: of the {int(member.size)} cell(s) labelled "
            f"{str(level)!r}, the one furthest in diffusion space (the first {int(n_dcs)} "
            "non-trivial components) from the centroid of every cell outside it; ties broken "
            "by the lowest row index. It is a DISTANCE, so it is invariant to the arbitrary "
            "sign of every component and returns the same cell for the same data in any row "
            "order — unlike the common idiom of taking whichever cell of the group comes "
            "first in the file, and unlike an extremum along one signed component, which "
            "picks an END of the population that the component's orientation rather than the "
            "biology decides."
        ),
        # The USER asserted that this group is where the process starts. Nothing in the data
        # says so, and the report says which assertion was made.
        "is_a_biological_assertion": True,
    }
