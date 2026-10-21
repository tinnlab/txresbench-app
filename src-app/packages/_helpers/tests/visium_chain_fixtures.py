#!/usr/bin/env python3
# ruff: noqa
"""Cross-package run harness for the #157 backwards-compatibility suite.

## What this is for

#151's central bet is that a spatially-imported expression matrix is **just a matrix** —
that it runs QC, filtering, embedding, clustering and differential expression with no
spatial special-casing anywhere in the chain. That claim is what `spatial-storage-layout.md`
§9 asserts and what nothing in this tree had ever run. This module is the machinery that
runs it.

## Why it lives in `_helpers/tests/`

Two reasons, in order of weight.

1. **It is a CROSS-PACKAGE suite and this is where the tree already keeps one.**
   `_helpers/tests/test_qc_cellfilter_fixes.py` loads `qc` and `cell-filter`'s compute
   entries by path from this directory; this module does the same for six packages. Putting
   a chain suite inside any ONE of the packages it chains would make that package's tests
   fail when a sibling package changed, which is exactly backwards.
2. **`spatial-import-visium/tests/` was a trap.** `feat/spatial-image-space` (#155) is in
   flight on that package and is already moving its `manifest.yaml` `version` 0.1.0 → 0.2.0.
   Adding any file there would oblige `check-processor-seed-versions.sh` to see a bump on
   the same line, and two branches independently writing `version: 0.2.0` produce **no
   textual conflict** — a clean merge in which one version covers two disjoint content sets.
   See `.lifecycle/visium-chain-compat/DECISIONS.md` DEC-2.

`_helpers/tests` is already enumerated in `packages/pytest.ini`'s `testpaths`, so this suite
joins collection with no edit to that file at all.

## Why the module is named after its subject

Non-`test_*.py` files in a `tests/` dir are imported by BARE NAME. `--import-mode=importlib`
(in `packages/pytest.ini`'s `addopts`, #198) gives path-unique names to `test_*.py` modules
ONLY, so a `fixtures.py` or a `_shared.py` here would collide with every other package's copy
of the same name. `embedding_fixtures.py` / `clustering_fixtures.py` / `visium_fixtures.py`
all solved it the same way; this follows them.

## How a step is driven

Through the ONLY seam that runs a shipped compute outside bwrap: `CYTO_INPUTS_DIR` /
`CYTO_OUTPUTS_DIR`, with `_helpers` and `_lib` on `PYTHONPATH` exactly as the sandbox stages
`/code`. Every input is declared in `/inputs/inputs.json` in the real `render_inputs_json`
wire shape (`{slot, kind, content_hash, sandbox_path}`) with a **MEANINGLESS `in0`/`in1`
mount name**, so a compute that resolved its inputs by filename suffix instead of by slot
would FAIL this suite rather than pass it. That property is asserted, not assumed —
`test_visium_chain_compat.py::test_the_harness_binds_by_slot_under_meaningless_mounts`.

`sandbox_path` is written in the `/inputs/<mount>` form rather than as a host path. That is
not cosmetic: `anndata-import`'s index builder takes `Path(sp).name` when the path does not
start with `/inputs/`, which for a file nested under a mount resolves to the wrong place. The
in-sandbox form is what production writes and it is what every consumer here agrees on.

The scripts are driven AT THEIR SHIPPED PATHS. Nothing here copies, patches or
re-implements a compute — a chain test that ran a copy would prove only that the copy runs.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np

# NOT `pytest.importorskip`. A `Skipped` raised while IMPORTING a non-test helper silently
# vanishes every module that imports it, and under `pytest.ini`'s `-q` plus a caller's own
# `-q` the run then prints no dots and no summary at all — a green, empty, exit-0 run of a
# suite that executed nothing. That is this repo's own named failure family (a `playwright`
# run exited 0 while printing `No tests found`), so numpy is imported HARD here: on a host
# without it this is a collection ERROR, which is loud, rather than a silent whole-file skip.

_HERE = Path(__file__).resolve().parent
PACKAGES = _HERE.parents[1]
_LIB = PACKAGES / "_lib"
_HELPERS = PACKAGES / "_helpers"

sys.path.insert(0, str(_LIB))
import cyto_zarr_read  # noqa: E402

#: The committed REAL vendor bundle, owned by `spatial-import-visium` and only READ here.
#: A 10x `Visium_Mouse_Olfactory_Bulb` Space Ranger 2.0.0 `outs/` bundle, subset to 120
#: spots x 150 genes. Every byte is the vendor's own format. This branch adds nothing
#: beside it and modifies nothing in it (DEC-2, DEC-5).
VISIUM_BUNDLE = PACKAGES / "spatial-import-visium" / "tests" / "fixtures" / "visium-outs"
VISIUM_MATRIX_H5 = VISIUM_BUNDLE / "filtered_feature_bc_matrix.h5"

#: analysis id -> the SHIPPED entry, at the path its own `manifest.yaml` names.
#: Resolved from the manifests rather than hardcoded would be nicer; it is hardcoded here
#: and CHECKED against the manifests by `test_visium_chain_selectors.py`, so a drifting
#: entry path fails a test instead of silently running the wrong file.
ENTRIES = {
    "spatial.import-visium": PACKAGES / "spatial-import-visium" / "compute" / "import_visium.py",
    "anndata.import": PACKAGES / "anndata-import" / "compute" / "h5ad_import.py",
    "qc.10x": PACKAGES / "qc" / "compute" / "qc-10x.py",
    "cell.filter": PACKAGES / "cell-filter" / "compute" / "cell-filter.py",
    "embedding.reduce": PACKAGES / "embedding" / "compute" / "reduce.py",
    "clustering.cluster": PACKAGES / "clustering" / "compute" / "cluster.py",
    "de.markers": PACKAGES / "differential-expression" / "compute" / "markers.py",
    "de.compare": PACKAGES / "differential-expression" / "compute" / "compare.py",
}

#: A placeholder content hash. `clustering.cluster` reads `content_hash` off the
#: inputs.json ENTRY (not off the artifact) to record the embedding's identity, so the
#: field must be present and well-formed; its VALUE is not asserted anywhere.
_NULL_HASH = "sha256:" + "0" * 64


class ChainStep:
    """One analysis run: stage inputs by slot, drive the shipped entry, read outputs back."""

    def __init__(self, base: Path, analysis: str):
        if analysis not in ENTRIES:
            raise KeyError(f"unknown analysis {analysis!r}; known: {sorted(ENTRIES)}")
        self.analysis = analysis
        self.script = ENTRIES[analysis]
        self.base = Path(base)
        self.inputs_dir = self.base / "inputs"
        self.outputs_dir = self.base / "outputs"
        self.inputs_dir.mkdir(parents=True, exist_ok=True)
        self.outputs_dir.mkdir(parents=True, exist_ok=True)
        self._entries: list[dict] = []
        self._n = 0
        self.proc: subprocess.CompletedProcess | None = None

    # ── staging ────────────────────────────────────────────────────────────────────
    def bind(self, slot: str, src: Path) -> str:
        """Stage `src` under a MEANINGLESS mount name and declare it on `slot`.

        The mount is always `in<N>` — it carries no hint of the slot, the datatype or the
        producer, which is what makes "resolved BY SLOT" a property this suite can observe
        rather than one it takes on trust.

        A directory is copied whole (an artifact prefix); a FILE is copied to the mount path
        ITSELF — so the staged path is `/inputs/in0` either way, with no filename anywhere.

        Two corrections landed here, in order. The first version staged a file as
        `in0/filtered_feature_bc_matrix.h5`, leaving the vendor filename fully intact — and
        `anndata-import` genuinely dispatches its reader on `Path(src).name.lower()` with a
        filename-glob fallback, so the "resolved by slot, never by filename" claim was
        untested on the one arm that could have tested it. The second version copied the file
        to an opaque leaf `in0/blob`, which fixed that but produced a wire shape production
        cannot emit: `sandbox/inputs.rs` stages a single-blob artifact as ONE FILE AT `dest`,
        so a `kind: "artifact"` entry's `sandbox_path` is the mount, never a nested leaf.

        Staging the file AT the mount satisfies both: no filename hint, and `kind` and path
        agree with what `render_inputs_json` would really write. (The importer still
        resolves, because `params.fileType` drives it — which is the real contract.)
        """
        src = Path(src)
        mount = f"in{self._n}"
        self._n += 1
        dest = self.inputs_dir / mount
        if src.is_dir():
            shutil.copytree(src, dest)
        else:
            shutil.copy(src, dest)
        sandbox_path = f"/inputs/{mount}"
        self._entries.append({
            "slot": slot,
            # Production distinguishes these: `sandbox/inputs.rs` returns `artifact-prefix`
            # for a MULTI-FILE artifact and `artifact` for a single blob. Hardcoding the
            # former told the control arm's single-file input the wrong thing — on exactly
            # the arm this suite went to trouble to make load-bearing.
            "kind": "artifact-prefix" if src.is_dir() else "artifact",
            "content_hash": _NULL_HASH,
            "sandbox_path": sandbox_path,
        })
        return sandbox_path

    def declared_inputs(self) -> list[dict]:
        """The `inputs.json` body as it will be written — what TEST-8 reads back."""
        return [dict(e) for e in self._entries]

    # ── running ────────────────────────────────────────────────────────────────────
    def run(self, params: dict | None = None) -> subprocess.CompletedProcess:
        (self.inputs_dir / "inputs.json").write_text(
            json.dumps({"inputs": self._entries}, indent=2))
        body = dict(params or {})
        body.setdefault("seed", 0)
        (self.inputs_dir / "params.json").write_text(json.dumps(body, indent=2))

        env = dict(os.environ)
        env["PYTHONPATH"] = os.pathsep.join(
            [str(_HELPERS), str(_LIB),
             *([env["PYTHONPATH"]] if env.get("PYTHONPATH") else [])])
        env["CYTO_INPUTS_DIR"] = str(self.inputs_dir)
        env["CYTO_OUTPUTS_DIR"] = str(self.outputs_dir)
        # UNSET rather than blanked: an empty FIFO path is a different code path from none.
        env.pop("CYTO_PROGRESS_FIFO", None)
        # SINGLE-THREADED BLAS, for the same reason `qc/compute/qc-10x.py:88-92` pins the
        # same four variables for itself and says so: "Also makes the compute deterministic."
        # This suite compares two arms' `float32` ARPACK PCA output with `array_equal` — zero
        # tolerance — and neither `embedding/compute/reduce.py` nor `clustering/compute/
        # cluster.py` pins a thread count of its own. A reduction order that varies with the
        # host's OpenBLAS default is not bitwise reproducible, so without this the exact
        # comparison would flake on another box AND the flake would read as this epic's
        # worst possible finding ("the chain produced a different answer for the spatial
        # arm"). Pinned here so the exactness is earned rather than lucky.
        for var in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
                    "NUMEXPR_NUM_THREADS"):
            env[var] = "1"
        self.proc = subprocess.run(
            [sys.executable, str(self.script)], env=env, capture_output=True, text=True)
        return self.proc

    def run_ok(self, params: dict | None = None) -> subprocess.CompletedProcess:
        proc = self.run(params)
        assert proc.returncode == 0, (
            f"{self.analysis} ({self.script.name}) exited {proc.returncode}\n"
            f"--- stdout ---\n{proc.stdout}\n--- stderr ---\n{proc.stderr}")
        return proc

    # ── read-back ──────────────────────────────────────────────────────────────────
    def manifest(self) -> list[dict]:
        return json.loads((self.outputs_dir / "manifest.json").read_text())["outputs"]

    def store(self, entry: dict) -> Path:
        return self.outputs_dir / entry["path"]

    def entries(self, *, datatype: str | None = None) -> list[dict]:
        return [e for e in self.manifest()
                if datatype is None or e.get("datatype") == datatype]

    def entry(self, output_id: str) -> dict:
        hits = [e for e in self.manifest() if e.get("id") == output_id]
        assert len(hits) == 1, f"expected exactly one {output_id!r}, got {len(hits)}"
        return hits[0]

    def report(self, filename: str) -> dict:
        return json.loads((self.outputs_dir / filename).read_text())

    def diagnostics(self) -> str:
        """Non-progress stderr — where every compute in this tree writes its refusal."""
        assert self.proc is not None
        return "\n".join(l for l in self.proc.stderr.splitlines()
                         if not l.startswith("progress:"))


# ── read-back helpers (through `_lib`'s OWN reader, never a third-party zarr) ────────
def read_column(store: Path, member: str = "values"):
    """A 1-D column as what it MEANS — categorical codes resolved, strings decoded.

    `read_column` is the platform's own dispatch over the four encodings; a raw array read
    fails on a split-string column, which is what a TEXT metadata-column is stored as.
    """
    return list(cyto_zarr_read.read_column(str(store), member))


def read_array(store: Path, member: str):
    """One numeric member as a numpy array — used for the 2-D coordinates and the PCA."""
    return np.asarray(cyto_zarr_read.read_array(str(store), member))


def csc_members(store: Path) -> dict:
    """The three CSC members of an expression store, as numpy arrays.

    This is what the two importer arms are compared on: if the spatial importer and the
    ordinary one wrote the same matrix, these are equal element for element.
    """
    return {k: read_array(store, k) for k in ("data", "indices", "indptr")}


def column_label(entry: dict) -> str:
    """The producer-declared NAME of a metadata-column output.

    `meta.name` first because that is the name a consumer joins on (it is what
    `component_columns` addresses and what a `column:<name>` slot must be spelled with);
    `label`, then the output id, only as fallbacks.
    """
    meta = entry.get("meta") or {}
    return str(meta.get("name") or entry.get("label") or entry["id"])


def structure_of(entry: dict) -> dict:
    return entry.get("structure") or {}


def store_cyto_attributes(store: Path) -> dict:
    """A written store's group `attributes.cyto` — the declaration that travels WITH the
    bytes, and therefore the only one a sandboxed consumer can see (#211)."""
    doc = json.loads((Path(store) / "zarr.json").read_text())
    return (doc.get("attributes") or {}).get("cyto") or {}


# ── the two importer arms ───────────────────────────────────────────────────────────
def import_visium(base: Path, bundle: Path = VISIUM_BUNDLE) -> ChainStep:
    """The SPATIAL arm: a real `spatial.import-visium` run over a real Space Ranger bundle.

    Driven as a subprocess through the production entry, which additionally gets the
    vendored `spatial_declarations` resolution right for free: `sys.path[0]` is the
    script's own `compute/` dir, which holds exactly one file of that name — the vendored
    copy — reproducing `/code` without any `sys.modules` surgery.
    """
    step = ChainStep(base, "spatial.import-visium")
    step.bind("bundle", bundle)
    step.run_ok({})
    return step


def import_ordinary(base: Path, matrix_h5: Path = VISIUM_MATRIX_H5) -> ChainStep:
    """The CONTROL arm: the SAME `.h5` through the ordinary, spatial-unaware importer.

    `anndata.import` dispatches a 10x `filtered_feature_bc_matrix.h5` to
    `sc.read_10x_h5(..., gex_only=False)` and emits `single-cell/expression` as a
    `sparse_csc` cyto_zarr store. It knows nothing about tissue positions, scale factors
    or coordinate spaces — which is the entire point. It differs from the spatial arm in
    exactly one variable: the importer.

    `cellranger` is NOT this control despite the name: it is the alignment pipeline
    (`runtime: bash`, `appliesTo: sequence/fastq`) and does not read this file at all.
    """
    step = ChainStep(base, "anndata.import")
    step.bind("input", matrix_h5)
    step.run_ok({"fileType": "10x_h5"})
    return step


#: Which output of each importer arm carries the GENE SYMBOLS.
#:
#: Not guessed and not sniffed — the two importers spell the same column differently and
#: the pairing is stated here once, then ASSERTED equal by
#: `test_visium_chain_compat.py::test_the_two_arms_are_given_the_same_gene_symbols`. It is
#: load-bearing for the control: `qc.10x`'s default `pct_mito` / `pct_ribo` patterns match
#: gene SYMBOLS (`^MT-|^mt-`, `^(RP[SL]|Rp[sl])`), so binding the control's Ensembl-id
#: column instead would make it report 0.0 % mito against the spatial arm's real value and
#: manufacture a cross-arm "difference" that is entirely an artefact of the harness. That
#: happened on the first run of this suite; this constant is the fix and the assertion is
#: what keeps it fixed.
_GENE_SYMBOL_OUTPUT = {
    # the visium importer emits the vendor's `features/name` as an explicit symbol column
    "spatial.import-visium": "metadata-column:gene_symbol",
    # `sc.read_10x_h5` puts the symbols in `var_names`, which `anndata.import` emits as the
    # genes axis index; its `var:gene_ids` column holds the Ensembl ids instead
    "anndata.import": "genes_index",
}


def gene_symbol_store(step: ChainStep) -> Path:
    """The store holding this arm's gene SYMBOL column."""
    return step.store(step.entry(_GENE_SYMBOL_OUTPUT[step.analysis]))


#: The spatial declarations the SPATIAL-MARKED arm stamps into the store's own
#: `attributes.cyto` — the ONE channel that actually reaches a sandboxed compute.
#:
#: Lifted from what a real `spatial.import-visium` run puts on its coordinates artifact's
#: manifest-entry `meta`. Today (#211) those live ONLY on the catalog entry and never cross
#: into the sandbox; `attributes.cyto` does cross, because it is literally bytes inside the
#: hardlinked zarr store. So stamping them there is a forward-looking experiment: it asks
#: what would happen to the chain if #211 were FIXED and every declaration became visible.
SPATIAL_MARKERS = {
    "platform": "visium",
    "measured_entity": {"kind": "spot", "platform": "visium", "resolution_um": 55.0},
    "measured_entity_label": "55 \u00b5m spot \u00b7 visium",
    "coordinate_space": "visium:Visium_Mouse_Olfactory_Bulb",
    "microns_per_pixel": 0.7471371402823337,
    "positioning": {"partial": False},
    "section": {"sample_id": "Visium_Mouse_Olfactory_Bulb", "index": 0},
}


def stamp_spatial_markers(store: Path) -> dict:
    """Merge `SPATIAL_MARKERS` into a written store's group `attributes.cyto`, in place.

    Writes to the store's `zarr.json`. For the matrix this is called on, that file is
    written by `_lib/cyto_csc.py::write_csc_zarr`, which ends in
    `cyto_zarr.write_group(out_dir, attrs)` with `attrs["cyto"]` set to the structure —
    NOT by `cyto_zarr.Table.close()`, which is the table/column writer. It travels WITH the
    bytes — `sandbox/inputs.rs` hardlinks a stored
    artifact's members, so whatever is in this file is what a sandboxed analysis reads back.
    The structural keys the consumers narrow on (`kind`, `axes`, `nnz`, …) are left exactly
    as the producer wrote them; only additional keys are added, so the matrix stays the same
    matrix by every declaration anything currently reads.
    """
    doc_path = Path(store) / "zarr.json"
    doc = json.loads(doc_path.read_text())
    attributes = doc.setdefault("attributes", {})
    cyto = attributes.setdefault("cyto", {})
    # BEFORE the write, and on the property that can actually be violated. The previous
    # version asserted `before <= set(cyto)` AFTER writing — a tautology, since `dict.update`
    # cannot remove a key, and too late to prevent a bad store reaching disk. What can go
    # wrong is a marker COLLIDING with a structural key and silently overwriting it.
    collisions = set(SPATIAL_MARKERS) & set(cyto)
    assert not collisions, (
        f"the spatial markers {sorted(collisions)} collide with keys the producer already "
        f"wrote. Stamping must ADD to the declaration, never redefine part of it — a "
        f"marked arm whose `kind` or `nnz` differed would diverge because of the BYTES, "
        f"not because of the markers")
    cyto.update(SPATIAL_MARKERS)
    doc_path.write_text(json.dumps(doc, indent=2))
    return cyto


def import_visium_marked(base: Path, bundle: Path = VISIUM_BUNDLE) -> ChainStep:
    """The SPATIAL-MARKED arm: a real import, then the declarations stamped where a
    sandboxed compute would actually be able to read them.

    ## Why this arm exists

    The two-importer comparison alone cannot falsify INV-2. Measured: the visium importer
    and the ordinary one emit BYTE-IDENTICAL matrices whose in-store `attributes.cyto` are
    also identical, and `inputs.json` carries only `{slot, kind, content_hash,
    sandbox_path}`. So no compute in the chain has any channel through which it could learn
    the matrix is spatial, and "the two arms agree" is ENTAILED rather than measured — a
    blind audit demonstrated exactly that by corrupting a real `qc.10x` metric and watching
    the cross-arm comparison stay green.

    This arm supplies the missing variable. It gives the chain a matrix that DOES announce
    itself as spatial, through the one channel that reaches a sandbox, and requires the
    chain to produce the same answer anyway. A consumer that dispatched on
    `attributes.cyto.platform` or `.measured_entity` — the special-casing §9 forbids —
    would diverge HERE and nowhere else.
    """
    step = import_visium(base, bundle)
    stamp_spatial_markers(step.store(expression_entry(step)))
    return step


def expression_entry(step: ChainStep) -> dict:
    """The one `sparse_csc` output of an importer arm, whatever datatype it is spelled as.

    The spatial arm emits `single-cell/counts` and the control emits
    `single-cell/expression`. Selecting on the STRUCTURE rather than on the datatype name
    is deliberate: it is the same narrowing every shipped consumer applies
    (`structure.kind != "sparse_csc"` ⇒ refuse), so this helper resolves the matrix the way
    the platform does. That the two datatype SPELLINGS are both resolved by the shipped
    `subtypes_of: single-cell/expression` selectors is INV-2, and is asserted separately in
    `test_visium_chain_selectors.py` — never inferred from this helper.
    """
    hits = [e for e in step.manifest()
            if structure_of(e).get("kind") == "sparse_csc"]
    assert len(hits) == 1, (
        f"{step.analysis} emitted {len(hits)} sparse_csc artifacts, expected exactly one: "
        f"{[e['id'] for e in hits]}")
    return hits[0]


# ── the chain itself ────────────────────────────────────────────────────────────────
#: The `cell.filter` keep-band, as a QUANTILE of the matrix's own `total_counts`.
#:
#: A quantile rather than a literal count so the band cannot rot if the fixture changes,
#: and so it is guaranteed to produce the STRICT, non-empty subset the suite asserts on —
#: a hardcoded threshold can silently become "keep everything" or "keep nothing", either
#: of which turns the filter leg into a no-op that still passes an exit-code test.
FILTER_KEEP_QUANTILE = 0.10


class ChainRun:
    """The FULL shipped chain, driven over one importer arm's matrix.

    ONE code path, used by BOTH arms. That is what makes the control a control: if the
    spatial arm and the ordinary arm were driven by two different bodies of test code, a
    difference between them would be unattributable — the very thing this suite exists to
    measure would be confounded by the measurement.

    Nothing here is spatial-aware. It binds the expression matrix, the gene symbols and
    the QC columns, and it never looks at `spatial/coordinates`, `measured_entity` or the
    coordinate space — because the claim under test is that it does not have to.
    """

    def __init__(self, base: Path, importer: ChainStep):
        self.base = Path(base)
        self.importer = importer
        self.expression_entry = expression_entry(importer)
        self.expression = importer.store(self.expression_entry)
        self.gene_symbols = gene_symbol_store(importer)
        self.n_cells = int(self.expression_entry["structure"]["shape"][0])
        self.n_genes = int(self.expression_entry["structure"]["shape"][1])

    def _step(self, tag: str, analysis: str) -> ChainStep:
        return ChainStep(self.base / tag, analysis)

    def run(self) -> "ChainRun":
        """Run every leg, in order, and keep each step for read-back."""
        self.qc = self._step("1-qc", "qc.10x")
        self.qc.bind("matrices", self.expression)
        self.qc.bind("gene_names", self.gene_symbols)
        self.qc.run_ok({})
        self.qc_columns = self.qc.entries(datatype="metadata-column")

        counts = np.asarray(self.qc_values("total_counts"), dtype=float)
        band = [float(np.quantile(counts, FILTER_KEEP_QUANTILE)), float(counts.max())]
        self.filter_band = band
        self.filter = self._step("2-filter", "cell.filter")
        self.filter.bind("expression", self.expression)
        for entry in self.qc_columns:
            self.filter.bind(f"column:{column_label(entry)}", self.qc.store(entry))
        self.filter.run_ok({"label": "chain-compat",
                            "thresholds": {"nCount": {"__all__": band}}})

        self.reduce = self._step("3-embed", "embedding.reduce")
        self.reduce.bind("matrices", self.expression)
        self.reduce.run_ok({})

        self.cluster = self._step("4-cluster", "clustering.cluster")
        self.cluster.bind("embedding", self.embedding_store())
        self.cluster.bind("expression", self.expression)
        self.cluster.run_ok({})

        self.markers = self._step("5-markers", "de.markers")
        self.markers.bind("expression", self.expression)
        self.markers.bind("grouping", self.cluster.store(self.label_entry()))
        self.markers.run_ok({})

        pair = self.cluster_levels()[:2]
        self.compare = self._step("6-compare", "de.compare")
        self.compare.bind("expression", self.expression)
        self.compare.bind("grouping", self.cluster.store(self.label_entry()))
        self.compare.run_ok({"group1": pair[0], "group2": pair[1]})
        self.compare_pair = pair
        return self

    # ── read-back, per leg ─────────────────────────────────────────────────────────
    def qc_entry(self, name: str) -> dict:
        hits = [e for e in self.qc_columns if column_label(e) == name]
        assert len(hits) == 1, f"expected one qc column {name!r}, got {[column_label(e) for e in self.qc_columns]}"
        return hits[0]

    def qc_values(self, name: str) -> list:
        return read_column(self.qc.store(self.qc_entry(name)))

    def mask_entry(self) -> dict:
        hits = self.filter.entries(datatype="metadata-column")
        assert len(hits) == 1, f"expected exactly one mask column, got {[e['id'] for e in hits]}"
        return hits[0]

    def mask(self) -> list[bool]:
        """The keep-mask as booleans.

        Stored as a PLAIN `bool` array, not a categorical: `_lib/cyto_columns.py:236-241`
        is explicit that "a bool is written as a plain bool array, so there is no
        [categorical]", with the display levels riding on `meta`. `read_column` therefore
        yields numpy booleans here; the `str(...) in (...)` widening below is defensive
        against a future encoding change, not a description of today's.

        Stated precisely because the Rust half of this item
        (`server/tests/workstore/spatial_filter_vd_test.rs`) builds its keep-mask fixture
        to match, and a docstring that described a categorical would send whoever
        re-derives that fixture after a #203 fix to build the wrong shape.
        `test_cell_filter_emits_a_mask_and_no_filtered_matrix` pins the real dtype so the
        two halves cannot drift apart silently.
        """
        return [str(v) in ("True", "true", "1") for v in
                read_column(self.filter.store(self.mask_entry()))]

    def embedding_entry(self) -> dict:
        hits = self.reduce.entries(datatype="embedding")
        assert len(hits) == 1, f"expected one embedding, got {[e['id'] for e in hits]}"
        return hits[0]

    def embedding_store(self) -> Path:
        return self.reduce.store(self.embedding_entry())

    def embedding(self):
        entry = self.embedding_entry()
        return read_array(self.embedding_store(), entry["structure"]["arrays"][0]["path"])

    def label_entry(self) -> dict:
        hits = self.cluster.entries(datatype="metadata-column")
        assert len(hits) == 1, f"expected one label column, got {[e['id'] for e in hits]}"
        return hits[0]

    def labels(self) -> list[str]:
        return [str(v) for v in read_column(self.cluster.store(self.label_entry()))]

    def cluster_levels(self) -> list[str]:
        """The distinct cluster labels, in a stable order (by size, then by name).

        Ordered rather than set-valued so `de.compare`'s chosen pair is the same on both
        arms without the arms having to agree on Python's set iteration order.
        """
        counts: dict[str, int] = {}
        for lab in self.labels():
            counts[lab] = counts.get(lab, 0) + 1
        return sorted(counts, key=lambda k: (-counts[k], k))

    def de_entries(self, step: ChainStep) -> list[dict]:
        return step.entries(datatype="de/result")

    def de_column(self, step: ChainStep, entry: dict, member: str) -> list:
        return read_column(step.store(entry), member)


    # ── the chain CONTINUED on the filtered population ──────────────────────────────
    def run_filtered(self) -> "ChainRun":
        """Re-run `embedding.reduce` and `clustering.cluster` over only the rows the filter
        kept.

        Two DIFFERENT routes, not one. `embedding.reduce` carries an inline `criteria`
        filter and is given the band directly. `clustering.cluster` carries no such filter —
        it declares only `embedding` and `expression` slots — and reaches the filtered
        population by consuming the already-filtered EMBEDDING. Stated because an earlier
        version of this docstring said "each analysis's OWN inline criteria filter", which is
        true of only one of the two.

        ## Why this, and not "bind cell.filter's output"

        Because binding `cell.filter`'s output is not a thing the product can do. Measured
        in `server/tests/workstore/spatial_filter_vd_test.rs`:

        * `cell.filter`'s compute emits a keep-mask and a report. No matrix.
        * The filtered matrix exists only as a GATHERED row in a filter virtual dataset,
          and a gathered artifact bound to an analysis **fails at input staging** —
          `gather_exec::resolve` asks the store for a member named `values`, which a
          `sparse_csc` store does not have.
        * The mechanism that WOULD have handed a compute the mask plus the unfiltered
          sources (`resolve_vd_compute_inputs`) has no production caller, and no shipped
          analysis declares a slot for a mask to be bound to.

        So the shipped way to run the rest of the chain on a filtered population is the
        inline filter each analysis carries: bind the column on a `column:<name>` slot and
        pass `criteria`.

        ## The two bands are NOT the same code path, and the claim is bounded accordingly

        An earlier version of this docstring said they "agree by construction" because
        `embedding/compute/_criteria.py` is `cell-filter`'s own `criteria_keep_mask`
        vendored verbatim. That is true of the kernel and FALSE of what runs here:
        `ChainRun.run` drives `cell.filter` with `thresholds`, not `criteria`, and
        `cell-filter.py` routes thresholds through a DIFFERENT branch that explicitly skips
        criteria-sourced entries.

        What is actually true, and enough: both resolve to the SAME column (`nCount` is an
        alias of `total_counts` in `cell-filter`'s metric table) and both apply a CLOSED
        interval on both sides. So they should select the same rows — and the test asserts
        the kept row SET, not merely its size, which turns that from a claim into a
        measurement.
        """
        band = self.filter_band
        criteria = [{"column": "total_counts", "min": band[0], "max": band[1]}]

        self.reduce_filtered = self._step("7-embed-filtered", "embedding.reduce")
        self.reduce_filtered.bind("matrices", self.expression)
        self.reduce_filtered.bind("column:total_counts",
                                  self.qc.store(self.qc_entry("total_counts")))
        self.reduce_filtered.run_ok({"criteria": criteria})

        hits = self.reduce_filtered.entries(datatype="embedding")
        assert len(hits) == 1, (
            f"expected one embedding from the filtered reduce, got {[e['id'] for e in hits]}")
        entry = hits[0]
        self.embedding_filtered_entry = entry
        self.embedding_filtered_store = self.reduce_filtered.store(entry)

        # NOTE the missing `expression` binding, and that it is not an oversight. The
        # pre-filter leg binds it, which turns on `clustering.cluster`'s descriptive
        # per-cluster markers pass. Here it CANNOT be bound: that pass requires the matrix's
        # row count to equal the label count, and the only matrix available is the
        # unfiltered one (a filtered matrix artifact is measured unstageable). Binding it
        # would hit the same alignment wall the DE legs hit. So the post-filter clustering
        # leg runs labels-only — the chain after the filter is NOT identical to the chain
        # before it, and that is a finding rather than a detail.
        self.cluster_filtered = self._step("8-cluster-filtered", "clustering.cluster")
        self.cluster_filtered.bind("embedding", self.embedding_filtered_store)
        self.cluster_filtered.run_ok({})

        # The DE legs are ATTEMPTED, not skipped — and they refuse. See
        # `attempt_de_on_the_filtered_population` and TEST-15; the attempt is the finding.
        return self

    def compare_on_the_filtered_population(self) -> "ChainStep":
        """Run `de.compare` over the filtered population through its ADVANCED contrast.

        This is the route an earlier version of this suite wrongly reported as absent.
        `de.compare` stages the vendored `_criteria.py` kernel and resolves `column:<name>`
        slots, so each side of the contrast is a criteria list evaluated over the FULL
        matrix — which means the band can be ANDed into both sides. The contrast is then
        "partition level A within the band" vs "level B within the band" — differential
        expression restricted TO the band. Not "over exactly the population the filter kept":
        it is two of the partition's levels within that population, a strict subset of it.

        The grouping used is the FULL-length partition, not the filtered one, and that is
        the point — a criteria side is a mask over the whole matrix, so every column it
        names must be full length.
        """
        lo, hi = self.filter_band
        levels = self.cluster_levels()[:2]
        step = self._step("11-compare-advanced", "de.compare")
        step.bind("expression", self.expression)
        step.bind("column:total_counts", self.qc.store(self.qc_entry("total_counts")))
        step.bind(f"column:{column_label(self.label_entry())}",
                  self.cluster.store(self.label_entry()))
        name = column_label(self.label_entry())
        step.run_ok({
            "contrast_mode": "advanced",
            "group1_criteria": [{"column": name, "keep": [levels[0]]},
                                {"column": "total_counts", "min": lo, "max": hi}],
            "group2_criteria": [{"column": name, "keep": [levels[1]]},
                                {"column": "total_counts", "min": lo, "max": hi}],
        })
        return step

    def compare_on_the_whole_population(self) -> "ChainStep":
        """The SAME advanced contrast with the band criterion REMOVED — the A/B control.

        The per-side cell counts ARE readable — `compare.py` records `n_group1`/`n_group2`
        in the advanced-mode provenance, which the report emits as `grouping_provenance`,
        and the caller asserts them exactly. (An earlier version of this docstring said the
        opposite and was the reason the caller used an indirect proxy.)

        This run is kept as the CONTROL that the count assertion needs: a band that happened
        to keep everybody would satisfy the counts while restricting nothing, so the same
        contrast without the band must select MORE cells and produce different effect sizes.
        """
        levels = self.cluster_levels()[:2]
        name = column_label(self.label_entry())
        step = self._step("12-compare-whole", "de.compare")
        step.bind("expression", self.expression)
        step.bind("column:total_counts", self.qc.store(self.qc_entry("total_counts")))
        step.bind(f"column:{name}", self.cluster.store(self.label_entry()))
        step.run_ok({
            "contrast_mode": "advanced",
            "group1_criteria": [{"column": name, "keep": [levels[0]]}],
            "group2_criteria": [{"column": name, "keep": [levels[1]]}],
        })
        return step

    def attempt_compare_with_the_filtered_partition(self) -> "ChainStep":
        """Try to feed `de.compare` the FILTERED partition — #157's literal arrow.

        `compare_on_the_filtered_population` reaches a band-restricted population, but it
        does so with the FULL-LENGTH partition, because a criteria side is a mask over the
        whole matrix and every column it names must be full length. The issue's arrow is
        `clustering.* -> de.compare`, i.e. the FILTERED clustering leg's own output feeding
        the next leg — and that is a different binding, which this attempts.

        Expected to refuse, on the same alignment wall `de.markers` hits. Attempting it is
        what makes the closure a measurement instead of a sentence.
        """
        levels = sorted(set(self.labels_filtered()))[:2]
        name = column_label(self.label_filtered_entry())
        step = self._step("13-compare-filtered-partition", "de.compare")
        step.bind("expression", self.expression)
        step.bind(f"column:{name}",
                  self.cluster_filtered.store(self.label_filtered_entry()))
        step.run({
            "contrast_mode": "advanced",
            "group1_criteria": [{"column": name, "keep": [levels[0]]}],
            "group2_criteria": [{"column": name, "keep": [levels[1]]}],
        })
        return step

    def attempt_markers_on_the_filtered_population(self) -> "ChainStep":
        """Try to run `de.markers` over the population the filter kept, and return the run.

        Expected to FAIL, and the failure is the measurement. `de.markers` declares no
        criteria parameter of any spelling and no `column:<name>` slot — unlike `de.compare`,
        which declares `group1_criteria`/`group2_criteria` and resolves `column:<name>`
        slots. So the two routes past the filter that the other legs have are both closed
        to it:

          * a genuinely filtered MATRIX artifact — which is what a filter virtual dataset
            holds, and which `server/tests/workstore/spatial_filter_vd_test.rs` measures
            cannot be staged for a compute at all; or
          * the unfiltered matrix plus a filtered grouping column — which is what this does,
            and which the length guard refuses by name.

        The caller asserts on the refusal.
        """
        step = self._step("9-markers-filtered", "de.markers")
        step.bind("expression", self.expression)
        step.bind("grouping", self.cluster_filtered.store(self.label_filtered_entry()))
        step.run({})
        return step

    def label_filtered_entry(self) -> dict:
        hits = self.cluster_filtered.entries(datatype="metadata-column")
        assert len(hits) == 1, (
            f"expected one label column from the filtered clustering, got "
            f"{[e['id'] for e in hits]}")
        return hits[0]

    def embedding_filtered(self):
        entry = self.embedding_filtered_entry
        return read_array(self.embedding_filtered_store,
                          entry["structure"]["arrays"][0]["path"])

    def labels_filtered(self) -> list[str]:
        return [str(v) for v in
                read_column(self.cluster_filtered.store(self.label_filtered_entry()))]

    def kept_row_indices(self) -> list[int]:
        """The row indices `cell.filter`'s mask kept — the SET, not just the count."""
        return [i for i, keep in enumerate(self.mask()) if keep]

    def band_row_indices(self) -> list[int]:
        """The row indices the recorded band selects, RECOMPUTED here from the QC column.

        Deliberately independent of both implementations: it does not call
        `cell-filter`'s thresholds branch and it does not call `embedding.reduce`'s vendored
        `criteria` kernel. So comparing it against `kept_row_indices()` tests ONE of them —
        `cell.filter`'s — against a closed-interval reading of the same numbers. It does NOT
        compare the two production predicates against each other; the inline path's own kept
        set is observable here only through the filtered embedding's ROW COUNT, which is
        asserted separately. Stated because an earlier version's failure message claimed
        more than this comparison can see.
        """
        lo, hi = self.filter_band
        values = np.asarray(self.qc_values("total_counts"), dtype=float)
        return [i for i, v in enumerate(values) if lo <= v <= hi]
