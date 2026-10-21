#!/usr/bin/env python3
# ruff: noqa
"""trajectory.dpt — an embedding + a root → per-cell diffusion pseudotime (ITEM-7).

Reads ONE `embedding`, resolves a ROOT CELL by a stated rule, and produces a CONTINUOUS
`metadata-column` (float32) plus a `report/qc`. The column colours the existing layout for
free through the shipped colour-by section's Values group — no viz code, no `src-app` diff.

## The fixed pipeline

    resolve inputs -> CEILING GATE (before any read) -> read the embedding
    -> sc.pp.neighbors -> sc.tl.diffmap (EXPLICIT n_comps + random_state)
    -> resolve the root (recording the rule) -> sc.tl.dpt(n_branchings=0)
    -> ASSERT THE COLUMN EXISTS -> handle unreachable cells -> write the column -> report

## scanpy's strictness here is ASYMMETRIC, and the soft cases are the dangerous ones

| prerequisite        | scanpy's behaviour when missing                                 |
|---------------------|-----------------------------------------------------------------|
| `sc.pp.neighbors`   | hard `ValueError` — fine, it stops                               |
| `sc.tl.diffmap`     | SOFT — warns, then silently runs with ITS OWN defaults           |
| `uns['iroot']`      | SOFT — warns, and then simply NEVER WRITES THE COLUMN. No error. |
| `iroot >= n_obs`    | SOFT — warns, sets iroot to None, writes nothing                 |

Both `iroot` rows were reproduced live. They are the single most dangerous silent failure in
this analysis: a pipeline that mis-resolves the root produces a VALID-LOOKING RUN WITH A
MISSING OUTPUT AND NO ERROR. So this file resolves the root itself, calls `diffmap`
explicitly with a recorded `n_comps`, and ASSERTS the column is present after the call,
refusing by name when it is not.

## Unreachable cells

`Neighbors._get_dpt_row` sets `+inf` for cells in a different connected component from the
root, and the normalization then divides ONLY by the finite maximum — so a disconnected
graph yields a finite range of exactly [0, 1] plus a pile of infinities. Two things follow:

  1. A finite-looking `[0,1]` range is NOT evidence the run was fine.
  2. `+inf` must never reach the writer. `cyto_columns` counts missing values with
     `np.isnan`, and `np.isnan(inf)` is **False**, so an infinity handed straight over is
     stored as a NOT-missing value that a colour scale renders as "the end of the
     trajectory". Infinities are converted to NaN here, before the write.

The default is to REFUSE a disconnected graph by name (naming the levers that reach it),
because a pseudotime covering part of the data is the failure most likely to reach a real
user. `on_disconnected="mark_missing"` is the explicit opt-in.

## Branch detection is NOT performed

`n_branchings=0`, on scanpy's own documented advice: use its pseudotime tool for pseudotime
and read branching from the abstracted graph. Its splitting criterion additionally needs a
stabilization hack for small branches, which is an admission of instability in the API
surface itself. No branch column is emitted.

Roots overridable via `CYTO_INPUTS_DIR` / `CYTO_OUTPUTS_DIR`. Progress → `$CYTO_PROGRESS_FIFO`.
"""
import _shared as S  # FIRST — pins the determinism env before numpy/scanpy load

import json
import os

import numpy as np

import cyto_columns
import _root as R


#: Branch detection is DESCOPED. Not a default we happen to use — a decision, so it is a
#: module constant the suite asserts on rather than an argument someone can quietly raise.
N_BRANCHINGS = 0

# ── INPUT SLOTS (resolved out of `/inputs/inputs.json`, never a filename suffix) ────────
EMBEDDING_SLOT = "embedding"
ROOT_COLUMN_SLOT = "root_column"
CELL_KEYS_SLOT = "cell_keys"
GRAPH_SLOT = "graph"


def _resolve_int(params, key, default, *, lo=1):
    try:
        v = int(params.get(key, default))
    except (TypeError, ValueError):
        v = default
    return max(lo, v)


def main():
    S.set_prefix("trajectory.dpt")
    inputs_dir, outputs_dir = S.io_dirs()
    p = S.params(inputs_dir)
    slots = S.load_inputs_index(inputs_dir)
    progress = S.progress

    seed = S.resolve_seed(p.get("seed", 0))
    n_neighbors = _resolve_int(p, "n_neighbors", 15)
    metric = S.resolve_metric(p.get("metric"))
    # `n_comps` (the diffusion basis) and `n_dcs` (how many of it the distance uses) DIFFER
    # by default upstream — 15 vs 10 — and scanpy's own docstring flags the mismatch. Both
    # are passed explicitly and both are recorded, because relying on the fallback means the
    # run's basis is decided by a library default nobody wrote down.
    n_comps = _resolve_int(p, "n_comps", 15, lo=2)
    n_dcs = _resolve_int(p, "n_dcs", 10, lo=2)
    col_name = S.resolve_output_name(p.get("name"), default="dpt_pseudotime")
    root_mode = str(p.get("root_mode") or "root_cluster")
    root_level = p.get("root_level")
    root_barcode = p.get("root_barcode")
    root_component = S.resolve_strict_int(
        p.get("root_component", R.FIRST_NONTRIVIAL_COMPONENT), "root_component")
    root_direction = str(p.get("root_direction") or "min")
    on_disconnected = str(p.get("on_disconnected") or "refuse")

    if on_disconnected not in ("refuse", "mark_missing"):
        S.fail(
            f"`on_disconnected` must be `refuse` or `mark_missing`, got "
            f"{on_disconnected!r}."
        )
    if n_dcs > n_comps:
        S.fail(
            f"`n_dcs` ({n_dcs}) exceeds `n_comps` ({n_comps}) — the distance cannot use more "
            "diffusion components than were computed. Raise `n_comps` or lower `n_dcs`."
        )

    # ── resolve inputs ───────────────────────────────────────────────────────────────
    progress("resolve", 2, "resolving inputs")
    emb_entries = S.slot_entries(slots, EMBEDDING_SLOT)
    if not emb_entries:
        S.fail("no `embedding` input bound — trajectory.dpt needs one `embedding` artifact "
               "(a PCA / latent representation) to order cells along")
    if len(emb_entries) > 1:
        S.fail(f"{len(emb_entries)} embeddings bound to `embedding`; bind exactly one.")
    emb_entry = emb_entries[0]

    root_col_entry = S.slot_entry(slots, ROOT_COLUMN_SLOT)
    keys_entry = S.slot_entry(slots, CELL_KEYS_SLOT)
    graph_entry = S.slot_entry(slots, GRAPH_SLOT)

    # ── CEILING GATE — before a byte of the embedding is read ────────────────────────
    progress("preflight", 5, "checking the resource envelope")
    structure, member, n_cells, n_dims = S.read_embedding_structure(
        emb_entry["path"], EMBEDDING_SLOT)
    ceiling = S.ceiling_refuse_if_over(n_cells, n_dims, n_neighbors, n_comps=n_comps)

    if n_cells < S.VIABLE_CELL_THRESHOLD:
        S.fail(
            f"only {n_cells} cell(s) to order, below the viable floor of "
            f"{S.VIABLE_CELL_THRESHOLD}. Refusing rather than ordering too few; no cell is "
            "ever synthesized to reach the floor."
        )

    # ── read ─────────────────────────────────────────────────────────────────────────
    progress("read", 14, "reading the embedding")
    coords = S.read_embedding_matrix(emb_entry["path"], member)
    if coords.shape[0] != n_cells:
        S.fail(f"the embedding declares {n_cells} cells but holds {coords.shape[0]} rows")

    # Equal length is NOT alignment: two artifacts over equally many cells can be over
    # different cells entirely, and the result would be a plausible ordering built on
    # scrambled labels with every declaration well-formed.
    embedding_row_space = S.declared_row_space(emb_entry["path"])
    for entry, slot, what in ((keys_entry, CELL_KEYS_SLOT, "key column"),
                              (root_col_entry, ROOT_COLUMN_SLOT, "root column")):
        if entry is not None:
            S.refuse_misaligned(embedding_row_space, S.declared_row_space(entry["path"]),
                                slot=slot, what=what)

    axis_keys = S.read_axis_keys(keys_entry["path"], CELL_KEYS_SLOT) if keys_entry else None
    if axis_keys is not None and len(axis_keys) != n_cells:
        S.fail(
            f"the bound key column holds {len(axis_keys)} keys but the embedding declares "
            f"{n_cells} cells — they must be aligned over the same axis."
        )

    root_labels = None
    if root_col_entry is not None:
        root_labels, _levels = S.read_categorical_column(
            root_col_entry["path"], ROOT_COLUMN_SLOT)
        if len(root_labels) != n_cells:
            S.fail(
                f"the root column holds {len(root_labels)} values but the embedding declares "
                f"{n_cells} cells — they must be aligned over the same axis."
            )

    neighbour_path = S.neighbour_path(n_cells, metric)

    import anndata as ad
    import scanpy as sc
    from scipy.sparse.csgraph import connected_components

    adata = ad.AnnData(X=np.zeros((n_cells, 1), dtype=np.float32))
    adata.obsm["X_embedding"] = coords

    progress("neighbors", 34, f"kNN graph (k={n_neighbors}, {neighbour_path})")
    sc.pp.neighbors(adata, n_neighbors=n_neighbors, use_rep="X_embedding",
                    metric=metric, random_state=seed)
    n_neighbors, n_neighbors_requested = S.honoured_n_neighbors(adata, n_neighbors)
    neighbour_path = S.neighbour_path(n_cells, metric)

    # From `connectivities`, NOT `distances`. The library masks unreachable cells using the
    # component labelling of its CONNECTIVITIES graph (the fuzzy neighbour graph, with zeros
    # eliminated), and that structure can differ from the raw distances graph's. Gating the
    # refusal on the wrong graph is how a run whose user chose to refuse could emit a partial
    # ordering anyway — while the report claimed every cell was reachable.
    n_components, component_of = connected_components(
        adata.obsp["connectivities"], directed=False)

    # ── the diffusion basis — called EXPLICITLY, never left to the fallback ──────────
    progress("diffmap", 50, f"diffusion map (n_comps={n_comps})")
    sc.tl.diffmap(adata, n_comps=n_comps, random_state=seed)
    diffmap = np.asarray(adata.obsm["X_diffmap"])

    # The ACHIEVED spectrum, which a small dataset caps below the request: asking for 5000
    # components of a 180-cell dataset returns 179 and the run would otherwise report 5000 —
    # a false declaration of the basis the whole result rests on. And `n_dcs` above what was
    # achieved reaches the ordering call and dies there with a bare library ValueError, so it
    # is gated here against the real width rather than against the other request.
    n_comps_achieved = int(diffmap.shape[1])
    n_comps_requested = None if n_comps_achieved == n_comps else n_comps
    n_comps = n_comps_achieved
    if n_dcs > n_comps_achieved:
        S.fail(
            f"the distance was asked to use {n_dcs} diffusion components but only "
            f"{n_comps_achieved} could be computed for this dataset"
            + (f" (you asked for {n_comps_requested})" if n_comps_requested else "")
            + ". A dataset supports at most about as many components as it has cells. Lower "
            "`n_dcs`, or bind a larger dataset."
        )

    # ── resolve the root, recording the rule ─────────────────────────────────────────
    progress("root", 62, f"resolving the root ({root_mode})")
    root = R.resolve(
        root_mode, diffmap=diffmap, n_dcs=n_dcs, labels=root_labels, level=root_level,
        component=root_component, direction=root_direction, barcode=root_barcode,
        axis_keys=axis_keys, fail=S.fail)
    adata.uns["iroot"] = int(root["index"])

    # ── the disconnected-graph decision, made BEFORE the ordering is computed ────────
    root_component_id = int(component_of[root["index"]])
    n_unreachable = int((component_of != root_component_id).sum())
    if n_unreachable and on_disconnected == "refuse":
        S.fail(
            f"the neighbour graph is disconnected: {n_unreachable:,} of {n_cells:,} cell(s) "
            f"are not reachable from the root, across {n_components} component(s). A "
            "pseudotime is a distance FROM the root along the graph, so those cells have no "
            "value — and the normalization rescales by the finite maximum only, so the "
            "result would look like a clean [0,1] gradient covering the whole dataset while "
            "silently describing one component of it. The levers that reach this: raise "
            "`n_neighbors` so the graph connects, integrate the samples first, or subset to "
            "one connected component. To proceed anyway with those cells recorded as "
            "MISSING rather than ordered, set `on_disconnected` to `mark_missing`."
        )

    # ── the ordering. n_branchings=0 — branch detection is DESCOPED ─────────────────
    progress("dpt", 76, f"diffusion pseudotime (n_dcs={n_dcs})")

    # TEST SEAM — the ONE place this compute can be made to take the branch below.
    #
    # The guard that follows exists for a real upstream behaviour: when the root does not
    # take, the library WARNS and writes no column, and raises nothing. But this compute
    # resolves and validates the root itself, so `iroot` is always an in-range index by the
    # time the call happens — which means the guard is unreachable through our own parameter
    # surface, and a test driving the parameters can only ever prove that the root validation
    # works, never that the guard does. Deleting the guard would leave such a suite green.
    #
    # So the seam injects EXACTLY the upstream-triggering condition (an out-of-range root)
    # and nothing else. The library's silent failure is then genuine, and so is the refusal:
    # nothing is mocked, and the guard is exercised rather than reasoned about. It only ever
    # makes the run REFUSE — it cannot make a run succeed, or change a result — which is the
    # same shape as the budget seams above.
    if os.environ.get("TRAJECTORY_SIMULATE_UNRESOLVED_ROOT") == "1":
        adata.uns["iroot"] = int(n_cells) + 10_000

    sc.tl.dpt(adata, n_dcs=n_dcs, n_branchings=N_BRANCHINGS)

    # THE assertion this analysis exists to make. scanpy writes NO column and raises NOTHING
    # when the root did not take, so without this the run would emit a valid-looking artifact
    # with a missing column and exit 0.
    if "dpt_pseudotime" not in adata.obs.columns:
        S.fail(
            "scanpy computed no pseudotime column for this run. It does this SILENTLY when "
            f"the root did not take (resolved index {root['index']} of {n_cells} cells), "
            "warning rather than raising — so the run is refused here instead of emitting an "
            "artifact whose column is simply absent."
        )

    values = np.asarray(adata.obs["dpt_pseudotime"].values, dtype=np.float64)

    # ── unreachable cells: +inf must NEVER reach the writer ─────────────────────────
    n_inf = int(np.isinf(values).sum())

    # The refusal above gated on a PREDICTION (components of the neighbour graph, computed
    # before the ordering); this is the OBSERVATION (the infinities the ordering actually
    # produced). They are derived from different objects — the component labelling is over
    # the raw neighbour graph, the mask is over the diffusion operator — so they are checked
    # against each other rather than assumed equal. Without this, a run whose user chose
    # `refuse` could still emit declared-missing cells whenever the two disagreed, honouring
    # the letter of the guarantee and not the arm the user picked.
    if n_inf and on_disconnected == "refuse":
        S.fail(
            f"the ordering left {n_inf:,} of {n_cells:,} cell(s) with no pseudotime, although "
            f"the neighbour graph's component structure predicted {n_unreachable:,}. Cells "
            "unreachable from the root have no distance from it, and the normalization "
            "rescales by the reachable maximum only, so the result would present part of the "
            "data as the whole of it. The levers: raise `n_neighbors`, integrate the samples "
            "first, or subset to one connected component — or set `on_disconnected` to "
            "`mark_missing` to proceed with those cells recorded as missing."
        )
    values = np.where(np.isinf(values), np.nan, values)
    finite = values[np.isfinite(values)]
    if finite.size == 0:
        S.fail("every cell's pseudotime is unreachable or undefined — no ordering was "
               "produced. Check that the root is inside the component you meant to order.")

    progress("write", 88, "writing the pseudotime column")
    import pandas as pd

    series = pd.Series(np.asarray(values, dtype=np.float32), dtype="float32")
    rel = "columns/pseudotime.zarr"
    # The emitted column inherits the EMBEDDING's row-space identity, which is honest here
    # because the ordering is computed over exactly those rows and every other bound column
    # was checked against it above. It stays absent when the embedding declares none, rather
    # than being invented.
    col_structure, col_meta = cyto_columns.write_metadata_column(
        outputs_dir, rel, col_name, series, axis="cells",
        aligned_to=embedding_row_space)

    versions = S.library_versions()
    provenance = {
        "producer": "trajectory.dpt",
        "method": "dpt",
        "n_branchings": N_BRANCHINGS,
        "n_comps": n_comps,
        "n_dcs": n_dcs,
        "n_neighbors": n_neighbors,
        "metric": metric,
        "neighbour_path": neighbour_path,
        "seed": seed,
        "root": root,
        "n_unreachable": n_unreachable,
        "library_versions": versions,
    }
    col_structure["trajectory"] = provenance
    _stamp(outputs_dir / rel, provenance)
    col_meta.update({"trajectory": provenance})

    entries = [S.output_entry(f"metadata-column:{col_name}", S.DT_METADATA_COLUMN, rel,
                              "artifact", structure=col_structure, meta=col_meta)]

    # ── the provenance report ────────────────────────────────────────────────────────
    progress("report", 94, "provenance report")
    report = {
        "kind": "trajectory-dpt-report",
        "analysis": "trajectory.dpt",
        "n_cells": int(n_cells),
        "algorithm": "dpt",
        "n_branchings": N_BRANCHINGS,
        "n_branchings_is": (
            "ZERO, deliberately. Branch detection is not performed; scanpy's own guidance is "
            "to use this tool only for pseudotime and to read branching from the abstracted "
            "graph. No branch label is emitted."
        ),
        "root": root,
        "root_is": (
            "the origin AND direction of the entire ordering. A different root is a "
            "different result, not a different view of the same result."
        ),
        "root_barcode_recorded": root.get("barcode") is not None,
        "root_barcode_absent_because": (
            None if root.get("barcode") is not None else
            "no cells-axis key column was bound, so the root is recorded as a row index "
            "rather than a barcode. The row index is exact; a barcode was not invented."
        ),
        "parameters": {
            "n_comps": n_comps,
            "n_comps_requested": n_comps_requested,
            "n_comps_is": (
                "the number of diffusion components ACTUALLY computed. When "
                "`n_comps_requested` is non-null the dataset could not support the request "
                "and this is what the basis really holds — recording the request would "
                "misdescribe the space the ordering was measured in."
            ),
            "n_dcs": n_dcs,
            "n_comps_vs_n_dcs_is": (
                "different by default upstream (15 vs 10) and flagged as such by scanpy's "
                "own docstring; both are passed explicitly here and both are recorded"
            ),
            "n_neighbors": n_neighbors,
            "n_neighbors_requested": n_neighbors_requested,
            "n_neighbors_is": (
                "the neighbour count the graph was ACTUALLY built with; when "
                "`n_neighbors_requested` is non-null the library clamped the request to fit "
                "the dataset"
            ),
            "metric": metric,
            "metric_is": "recorded, not recommended",
            "seed": seed,
            "random_state": seed,
            "neighbour_path": neighbour_path,
            "neighbour_path_switch_cells": S.neighbour_exact_switch_cells(metric),
            "root_mode": root_mode,
            "root_component": root_component,
            "root_direction": root_direction,
            "on_disconnected": on_disconnected,
            "name": col_name,
        },
        "connectivity": {
            "n_components": int(n_components),
            "components_measured_on": (
                "the connectivities graph — the same one the library derives its unreachable "
                "mask from, rather than the raw distances graph, whose component structure "
                "can differ"
            ),
            "graph_connected": bool(n_components == 1),
            "n_unreachable": n_unreachable,
            "n_unreachable_written_as": (
                "missing (NaN)" if n_unreachable else "n/a — every cell is reachable"
            ),
            "unreachable_policy": on_disconnected,
            "raw_infinities_from_scanpy": n_inf,
            "prediction_matched_observation": bool(n_inf == n_unreachable),
            "prediction_matched_observation_is": (
                "whether the component structure of the neighbour graph (computed BEFORE the "
                "ordering) predicted the same number of valueless cells the ordering actually "
                "produced. They come from different objects, so they are compared rather than "
                "assumed equal; a mismatch is recorded rather than smoothed over."
            ),
            "note": (
                "scanpy marks cells outside the root's component with +inf and then "
                "normalizes by the FINITE maximum only, so a disconnected run still reports "
                "a tidy [0,1] range. Those cells are converted to declared-missing here "
                "before the write, because the column writer counts missing values with a "
                "NaN test and an infinity is not NaN — it would otherwise be stored as a "
                "real value and rendered as the end of the trajectory."
            ),
        },
        "pseudotime": {
            "min": float(finite.min()),
            "max": float(finite.max()),
            "n_valued": int(finite.size),
            "n_missing": int(np.isnan(values).sum()),
            "dtype": "float32",
        },
        "embedding": {
            "n_dims": int(n_dims),
            "content_hash": emb_entry.get("content_hash"),
            "method": structure.get("method", "unattested"),
        },
        "abstracted_graph": (
            None if graph_entry is None
            else {"content_hash": graph_entry.get("content_hash")}
        ),
        "abstracted_graph_bound": graph_entry is not None,
        "abstracted_graph_is": (
            "an OPTIONAL reference binding: the graph does not enter this computation, it is "
            "recorded so a reader can see which abstracted graph the root cluster was read "
            "against."
        ),
        "library_versions": versions,
        "determinism_env": S.resolved_determinism_env(),
        "ceiling": ceiling,
        "disclosures": {
            k: S.DISCLOSURES[k] for k in (
                "pseudotime_is_not_time",
                "the_root_determines_everything",
                "no_method_tests_that_a_trajectory_EXISTS",
                "branch_detection_not_performed",
                "the_capability_gap_of_this_method",
                "a_numerical_change_is_scheduled_upstream",
                "no_method_is_best_at_this",
            )
        },
        "warnings": [],
    }
    (outputs_dir / "trajectory-dpt-report.json").write_text(json.dumps(report, indent=2))
    entries.append(S.opaque_report_entry(
        "trajectory-dpt-report", "trajectory-dpt-report.json",
        {"kind": "trajectory-dpt-report", "n_cells": int(n_cells),
         "n_unreachable": n_unreachable}))

    S.write_manifest(outputs_dir, entries)
    progress("done", 100, f"{n_cells} cells ordered from row {root['index']}")
    print(f"trajectory.dpt: {n_cells} cells ordered from row {root['index']} "
          f"(mode={root['mode']}, {n_unreachable} unreachable)",
          file=__import__("sys").stderr)


def _stamp(store_path, provenance):
    """Merge the trajectory provenance into the produced column store's group
    `attributes.cyto`, ALONGSIDE the decode structure the writer put there.

    The store stamp is what a consumer reading the store URL sees; the manifest entry's
    `structure` is what rides the artifact row. Both carry the same dict, because two copies
    written from two places is exactly the drift the conformance gate fails on. This is a
    package-local post-write merge — the same declaration channel the sibling packages use —
    so no framework library is edited.
    """
    from pathlib import Path

    p = Path(store_path) / "zarr.json"
    doc = json.loads(p.read_text())
    attrs = doc.setdefault("attributes", {})
    cyto = attrs.setdefault("cyto", {})
    cyto["trajectory"] = provenance
    p.write_text(json.dumps(doc, indent=2))
    return provenance


if __name__ == "__main__":
    main()
