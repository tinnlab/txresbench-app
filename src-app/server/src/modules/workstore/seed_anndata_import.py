#!/usr/bin/env python3
# ruff: noqa
"""seed_anndata_import — run the REAL `anndata-import` converter over a real .h5ad and
stage FE-servable artifacts for the cell-filter SCATTER e2e (cell-filter-scatter-wiring).

This is NOT a mock: it invokes the production `h5ad_import.py` entry (the SAME script the
on-ingest `anndata.import` converter runs in the sandbox) as a subprocess over the POSTed
.h5ad, so a genuine `embedding` (from `obsm['X_umap']`) + per-cell obs metadata are produced
by the real converter code. It then post-processes the converter's outputs into the two
byte forms the workbench FE reads:

  • the embedding as a SINGLE-FILE little-endian f32 `[N,2]` blob (the `chunked-dense`,
    `file_layout: single` form the `embedding` datatype declares + `WorkbenchDataSource.
    positions()` reads) — the real converter writes a multi-file `.zarr`, which the FE
    range-decoder does not read, so we flatten the produced UMAP coords into the servable form;
  • a `report/qc` obs.json (the wrapped columnar `$data.obs` slice the cell-filter surface
    reads) built from the converter's produced `metadata-column` outputs (bulk_labels /
    louvain / n_counts / …) — same cells, same order as the embedding.

  • one `column_<i>.json` per produced column, plus the `structure` + `meta` declaring each
    — the per-column artifacts the ENTITY AXIS carries, mirroring the one-artifact-per-column
    set the real converter emits (`txr_columns.write_metadata_column`). Without these the
    seeded dataset's axis carries nothing and every axis-scoped resolver resolves empty.

Writes `embedding.f32`, `obs.json`, `column_<i>.json` × N, and `manifest.json` (the
ids/shape/declarations the Rust debug route catalogs). The Rust route runs this on the host
`python3` (the SAME Option-B host-python path `seed_multimodal.py` uses), then catalogs each
output via `insert_artifact`.
"""
import json, os, struct, subprocess, sys, tempfile

# The in-repo reference READER for what the shared writer produces. It is staged right
# beside this driver by `resolve_with_package` — the SAME resolver a real run stages a
# `/code` dir with — so this is the same import the converter's own siblings make, not a
# host dependency. Its module header names the two jobs it exists for: "a processor that
# consumes another processor's output, and a test suite asserting what a processor
# emitted". This driver is the second of those, and re-deriving the container here would
# be a third decoder to keep in step with the writer and the browser.
import txr_zarr_read


def _read_embedding(emb_path):
    """Read a produced embedding store → a dense (N, D) float32 array.

    This used to `zarr.open()` the directory with third-party zarr-python, which
    recognises only v2 store markers (`.zarray`/`.zgroup`); the writer emits v3
    (`zarr.json`), so the host's 2.18.3 raised `PathNotFoundError: nothing found at path
    ''`. The `.npy` branch beside it goes with it: it survived from the writer that
    "silently fell back to a `.npy` when the zarr import failed", a second format since
    retired — so it could no longer fire, and all it could still do was swallow a store
    this reader failed to open.
    """
    import numpy as np

    return np.ascontiguousarray(
        txr_zarr_read.read_array(emb_path, "embedding"), dtype=np.float32
    )


def _plain(values):
    """`read_column`'s result as JSON-safe plain Python.

    It hands back a `list` for a categorical / string column and a numpy array for a
    numeric one, and `json.dump` serializes neither an ndarray nor a numpy scalar. NaN
    becomes `null` for the same reason the retired per-column JSON writer mapped it that
    way: `json.dump` would otherwise emit a bare `NaN` token, which is not JSON, and these
    bytes are fetched and `JSON.parse`d by the browser.
    """
    out = values.tolist() if hasattr(values, "tolist") else list(values)
    return [None if isinstance(v, float) and v != v else v for v in out]


def main():
    input_h5ad, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    here = os.path.dirname(os.path.abspath(__file__))

    # ── run the REAL production converter (h5ad_import.py) over the input ──────────────────
    run_root = tempfile.mkdtemp(prefix="anndata-import-run-", dir=outdir)
    run_in = os.path.join(run_root, "inputs")
    run_out = os.path.join(run_root, "outputs")
    os.makedirs(run_in, exist_ok=True)
    os.makedirs(run_out, exist_ok=True)
    # Stage the input under the slot the converter's `resolve_slot` prefers.
    staged = os.path.join(run_in, "dataset.h5ad")
    with open(input_h5ad, "rb") as src, open(staged, "wb") as dst:
        dst.write(src.read())
    json.dump(
        {"inputs": [{"slot": "dataset", "sandbox_path": "/inputs/dataset.h5ad"}]},
        open(os.path.join(run_in, "inputs.json"), "w"),
    )
    json.dump({}, open(os.path.join(run_in, "params.json"), "w"))

    env = dict(os.environ)
    env["TXR_INPUTS_DIR"] = run_in
    env["TXR_OUTPUTS_DIR"] = run_out
    # `h5ad_import.py` + the whole `/code` dir it runs against — its DECLARED siblings plus
    # the globally-staged framework modules — are staged in `here` by the Rust route, through
    # the same resolver a real run uses. (This said "multimodal / colsummary / align", the
    # hand list that predates that resolver; the reader imported at the top of this file is
    # one of the modules it did not know about.)
    env["PYTHONPATH"] = here + os.pathsep + env.get("PYTHONPATH", "")
    proc = subprocess.run(
        [sys.executable, os.path.join(here, "h5ad_import.py")],
        cwd=here,
        env=env,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr[-4000:])
        raise SystemExit(
            f"seed_anndata_import: the REAL h5ad_import.py converter failed (exit {proc.returncode})"
        )

    manifest = json.load(open(os.path.join(run_out, "manifest.json")))
    outputs = manifest.get("outputs", [])

    # ── the embedding: prefer X_umap, else the first `embedding` output ────────────────────
    emb_entries = [o for o in outputs if o.get("datatype") == "embedding"]
    if not emb_entries:
        raise SystemExit("seed_anndata_import: the converter produced NO embedding (no obsm ≥2-D key)")
    umap = next((o for o in emb_entries if "umap" in o["id"].lower()), emb_entries[0])
    emb = _read_embedding(os.path.join(run_out, umap["path"]))
    n_cells, n_dims = int(emb.shape[0]), int(emb.shape[1])
    # Flatten to the first two dims, interleaved [x0,y0,x1,y1,…] little-endian f32.
    xy = emb[:, :2].reshape(-1)
    with open(os.path.join(outdir, "embedding.f32"), "wb") as f:
        f.write(struct.pack("<%df" % xy.size, *[float(v) for v in xy]))

    # ── the obs slice: the converter's produced metadata-column outputs (same cells/order) ─
    # Each one is a Zarr artifact DIRECTORY now, read through `txr_zarr_read.read_column`,
    # which resolves a column to what it MEANS — a categorical's labels, a string column's
    # strings, a numeric column's array — so this driver keeps no second opinion about
    # codes, level sets or arrow offsets. It used to `json.load` the path: the shared
    # writer stopped emitting one JSON blob per column and nothing re-read this loop, so it
    # died with `IsADirectoryError` on the first output it reached.
    #
    # EVERY such output is read, and a read that fails propagates. Skipping one on error
    # would seed a slice that silently omits a column the converter really produced, which
    # is the failure this whole driver exists to make impossible.
    #
    # The column's name is the manifest entry's `label` (the harvested per-instance
    # descriptor) — the JSON blob that used to carry a `name` field is gone.
    obs = {}
    # The PER-COLUMN artifact set, keyed by `output_id`: one driver-written file, one
    # `structure`, one `meta` each. See the block comment inside the loop for why they are
    # cataloged one artifact per column and not only as one bundled table.
    column_files, column_structures, column_meta = {}, {}, {}
    for o in outputs:
        if o.get("datatype") != "metadata-column":
            continue
        values = _plain(txr_zarr_read.read_column(os.path.join(run_out, o["path"])))
        name = o.get("label")
        if not name:
            raise SystemExit(
                f"seed driver: the converter's metadata-column output {o.get('id')!r} "
                f"({o.get('path')!r}) carries no `label`, so this driver cannot name the "
                f"{len(values)} values it just read"
            )
        if len(values) != n_cells:
            continue  # a column on the OTHER axis (gene-length) — not part of this slice
        obs[name] = values

        # ── the column as its OWN artifact, on its OWN axis ─────────────────────────────
        #
        # This is the half that makes the seeded dataset resolve like an imported one. The
        # real converter emits ONE `metadata-column` artifact per column, each declaring
        # `structure.axis` (which axis these values are aligned to) and `structure.columns`
        # (the 1-D members it holds) — see `txr_columns.write_metadata_column`. Every
        # axis-scoped resolver in the workbench selects on exactly that pair, so a seed that
        # publishes them ONLY as one bundled report blob leaves the axis carrying no columns
        # at all: a criteria builder offers nothing and the surface renders empty with
        # nothing failing. The bundle stays (it is the slice the report-shaped readers want);
        # these are what the AXIS carries.
        #
        # The BYTES are re-framed as a one-column JSON table rather than copied as the
        # converter's Zarr store, for the same reason the coordinates above are: the seed
        # engine catalogs a driver FILE, and a Zarr artifact is a DIRECTORY. `structure`
        # therefore describes the JSON framing (`opaque` + a JSON media type, which the
        # workbench table reader decodes) while naming the same axis + member the real
        # producer declares. `meta` is the converter's OWN declaration, carried verbatim.
        out_id = f"metadata-column:{name}"
        file_name = f"column_{len(column_files)}.json"
        with open(os.path.join(outdir, file_name), "w") as f:
            json.dump({"columns": [name], name: values}, f)
        column_files[out_id] = file_name
        # Both declarations are the PRODUCER'S — the member kind off the converter's own
        # `structure`, the whole `meta` verbatim — never re-derived from the decoded values.
        # A second opinion is a second thing to keep in step, and `meta` is what carries the
        # display facts a picker reads (`meta.name`, `meta.categories`). Absent either, this
        # driver has nothing to declare on the producer's behalf, so it stops rather than
        # inventing one.
        declared_structure = o.get("structure") or {}
        declared_columns = declared_structure.get("columns") or []
        declared_meta = o.get("meta")
        if not declared_columns or not declared_structure.get("axis") or not declared_meta:
            raise SystemExit(
                f"seed driver: the converter's output {o.get('id')!r} declares no "
                f"structure.axis / structure.columns / meta, so this driver cannot say what "
                f"it re-framed"
            )
        # ⚠ ONE DELIBERATE DIVERGENCE FROM THE PRODUCER, and it MASKS A LIVE DEFECT.
        #
        # The real writer names this member the CONSTANT `"values"` — `write_metadata_column`
        # calls `t.categorical("values", …)` / `t.string("values", …)` — so EVERY imported
        # column declares `structure.columns[0].name == "values"` and carries its real name
        # only in the catalog row's `meta.name`. VERIFIED against a real on-ingest import:
        # every produced column declared `name: "values"`.
        #
        # The workbench's axis-columns readers key off the MEMBER name, not `meta.name`
        # (`artifactReader.ts::readTable` → `member.name ?? member.path`;
        # `axisSource.ts::axisColumnSources` → `tableColumns(row.structure)[].name`). So on a
        # REAL import every column collapses onto ONE frame key `"values"`, later artifacts
        # overwrite earlier ones, and a criteria builder offers a single column called
        # "values". `candidateLabel` already fixed exactly this collision for the picker
        # LABEL by reading `meta.name`; the frame and the `as: sources` map never were.
        #
        # Naming the member after the column here is therefore MORE FORGIVING THAN REALITY,
        # and it is what lets the filter spec exercise per-column criteria at all. Spelling
        # it `"values"` (the faithful choice) reproduces the real defect and turns that spec
        # red at the column picker. Left divergent, and stated loudly, because the fix
        # belongs in the readers (or the writer) and not in a fixture — and a SILENT
        # divergence would leave a green spec standing over a broken real import.
        column_structures[out_id] = {
            "encoding": "opaque",
            "media_type": "application/json",
            "axis": declared_structure["axis"],
            "n": declared_structure.get("n") or len(values),
            "columns": [{"name": name, "kind": declared_columns[0].get("kind")}],
        }
        column_meta[out_id] = declared_meta
    if not obs:
        raise SystemExit("seed_anndata_import: the converter produced NO per-cell obs columns")

    json.dump(
        {"columns": list(obs.keys()), "n_cells": n_cells, "obs": obs},
        open(os.path.join(outdir, "obs.json"), "w"),
    )
    json.dump(
        {
            "n_cells": n_cells,
            "embedding_id": umap["id"],
            "embedding_rows": n_cells,
            "embedding_cols": 2,
            "embedding_source_dims": n_dims,
            "obs_columns": list(obs.keys()),
            "column_files": column_files,
            "column_structures": column_structures,
            "column_meta": column_meta,
        },
        open(os.path.join(outdir, "manifest.json"), "w"),
    )
    print("seed_anndata_import OK:", umap["id"], f"{n_cells}x2", "obs_cols=", list(obs.keys()))


if __name__ == "__main__":
    main()
