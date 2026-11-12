#!/usr/bin/env python3
# ruff: noqa
"""The per-matrix modality PREFIX reaches the compute — through the channel the compute
actually has.

## The gap this pins

`qc-10x.py::modality_keys` documents two channels for one fact, in precedence order:

  1. the artifact's OWN declaration, `structure.modality`, "if a producer stamps one — a
     thing that states a fact about itself always beats a relay of it";
  2. `params.matrix_modalities`, a positional relay the launcher forwards.

The importer stamped the modality into `meta` ONLY. `meta` is a CATALOG column: the
sandbox's `/inputs/inputs.json` carries `{slot, kind, content_hash, sandbox_path}` and
nothing else, so `meta` never crosses into the job. The compute's PREFERRED channel was
therefore unpopulated by construction, and every multi-matrix run depended entirely on the
positional relay — which a caller can omit, mis-order, or truncate with no way for the
compute to notice, because the artifacts themselves said nothing.

`structure` DOES cross: it is stamped into the store's own `zarr.json` as
`attributes.txr`, which is exactly what `qc-10x.py::artifact_structure` reads off the
STAGED bytes. So stamping the modality there costs one key and closes the gap with no
view change, no new param, and no new plumbing.

## What is asserted, and why it is asserted THIS way

The claim is not "a dict has a key". It is "the compute can now answer the question from
the artifacts alone". So the last test drives the REAL `modality_keys` over the REAL
emitted stores with an EMPTY params dict — the exact situation that used to be fatal — and
requires it to return the right keys. Every earlier test is a component of that, pinned
separately so a failure says WHICH link broke:

  · the two copies of the declaration (the manifest row and the group stamp) AGREE — the
    conformance gate refuses a disagreement, and a test that only read one copy would pass
    while the artifact was unshippable;
  · the stamp equals `meta.modality` — the two channels must name ONE fact, or a consumer
    reading one and a consumer reading the other prefix the same columns differently;
  · the SINGLE-modality path stamps NOTHING (negative control). With one matrix an absent
    key legitimately means "no prefix" — the pre-multimodal behaviour, byte-identical — so
    a stamp appearing there would silently rename every column of every ordinary import.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

sp = pytest.importorskip("scipy.sparse")
ad = pytest.importorskip("anndata")
pd = pytest.importorskip("pandas")

_HERE = Path(__file__).resolve().parent
_SCRIPTS_DIR = _HERE.parents[1] / "_helpers"
_LIB_DIR = _HERE.parents[1] / "_lib"
_COMPUTE = _HERE.parent / "compute"
SCRIPT = _COMPUTE / "h5ad_import.py"

if str(_COMPUTE) not in sys.path:
    sys.path.insert(0, str(_COMPUTE))
import multimodal as mm  # noqa: E402


# ─────────────────────────────── the real converter ───────────────────────────────

def _invoke_converter(inputs_dir: Path, outputs_dir: Path):
    """Run the REAL converter over a populated inputs dir (mirrors
    `test_convert._invoke_converter`), asserting a clean exit."""
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join(
        [str(_SCRIPTS_DIR), str(_LIB_DIR), *([env["PYTHONPATH"]] if env.get("PYTHONPATH") else [])]
    )
    env["TXR_INPUTS_DIR"] = str(inputs_dir)
    env["TXR_OUTPUTS_DIR"] = str(outputs_dir)
    env.pop("TXR_PROGRESS_FIFO", None)

    proc = subprocess.run([sys.executable, str(SCRIPT)], env=env, capture_output=True, text=True)
    assert proc.returncode == 0, (
        f"converter exited {proc.returncode}\n--- stdout ---\n{proc.stdout}\n"
        f"--- stderr ---\n{proc.stderr}"
    )
    return json.loads((outputs_dir / "manifest.json").read_text()), outputs_dir


@pytest.fixture
def run_converter(tmp_path):
    counter = {"n": 0}

    def run(adata):
        counter["n"] += 1
        base = tmp_path / f"run{counter['n']}"
        inputs_dir, outputs_dir = base / "inputs", base / "outputs"
        inputs_dir.mkdir(parents=True, exist_ok=True)
        outputs_dir.mkdir(parents=True, exist_ok=True)
        adata.write_h5ad(inputs_dir / "data.h5ad")
        return _invoke_converter(inputs_dir, outputs_dir)

    return run


def _combined(var_rows, n_cells=6):
    """A 10x combined feature-barcode AnnData — one matrix, a `feature_types` var column."""
    rng = np.random.default_rng(0)
    X = sp.csr_matrix(rng.integers(1, 10, size=(n_cells, len(var_rows))).astype(np.float32))
    return ad.AnnData(
        X=X,
        obs=pd.DataFrame(index=[f"AAAC{i}-1" for i in range(n_cells)]),
        var=pd.DataFrame(
            {"feature_types": [r[1] for r in var_rows]}, index=[r[0] for r in var_rows]
        ),
    )


CITESEQ = [("TP53", "Gene Expression"), ("MYC", "Gene Expression"),
           ("CD3", "Antibody Capture"), ("CD19", "Antibody Capture")]
RNA_ONLY = [("TP53", "Gene Expression"), ("MYC", "Gene Expression")]


def _expression_outputs(manifest):
    """The per-modality expression rows, keyed by output id."""
    return {e["id"]: e for e in manifest["outputs"] if str(e["id"]).startswith("expression:")}


def _stamped_structure(outputs_dir: Path, rel: str):
    """The store's OWN declaration, read EXACTLY as `qc-10x.py::artifact_structure` reads it
    off the staged bytes — `<store>/zarr.json` → `attributes.txr`. Deliberately not the
    manifest row: the row is the copy the sandbox does NOT get."""
    doc = json.loads((outputs_dir / rel / "zarr.json").read_text())
    txr = (doc.get("attributes") or {}).get("txr")
    return txr if isinstance(txr, dict) else None


# ───────────────────────────────────── tests ─────────────────────────────────────

def test_the_fixture_really_is_multimodal(run_converter):
    """Non-vacuity. Every clause below is about the multi-modality branch; if the fixture
    fell to the single-matrix path they would all pass over nothing."""
    manifest, _ = run_converter(_combined(CITESEQ))
    outs = _expression_outputs(manifest)
    assert len(outs) == 2, f"expected a per-modality split, got {sorted(outs)}"
    assert {e["meta"]["modality"] for e in outs.values()} == {"rna", "prot"}


def test_each_matrix_declares_its_own_modality_in_the_channel_the_sandbox_gets(run_converter):
    """THE GAP. The staged store must state its own modality, because `meta` does not
    travel and the positional relay is a caller's promise rather than the artifact's."""
    manifest, outputs_dir = run_converter(_combined(CITESEQ))
    outs = _expression_outputs(manifest)
    for out_id, entry in outs.items():
        stamped = _stamped_structure(outputs_dir, entry["path"])
        assert stamped is not None, f"{out_id}: no `attributes.txr` in the store's zarr.json"
        assert stamped.get("modality") == entry["meta"]["modality"], (
            f"{out_id}: the staged store declares modality {stamped.get('modality')!r} but the "
            f"catalog row says {entry['meta']['modality']!r} — a compute reading the bytes and "
            "a consumer reading the row would prefix the same columns differently"
        )


def test_the_row_and_the_group_stamp_carry_the_SAME_declaration(run_converter):
    """The conformance gate (`_lib/conformance._conform_group_attributes`) requires the
    returned `structure` and the group's stamped `attributes.txr` to be EQUAL. A stamp
    bolted on after the writer returned would satisfy the test above and still make every
    artifact unshippable, so the equality is pinned here rather than assumed."""
    manifest, outputs_dir = run_converter(_combined(CITESEQ))
    for out_id, entry in _expression_outputs(manifest).items():
        assert entry["structure"] == _stamped_structure(outputs_dir, entry["path"]), (
            f"{out_id}: the manifest row's `structure` and the group's stamp differ — the "
            "conformance gate refuses exactly this"
        )


def test_a_single_modality_import_stamps_NO_modality(run_converter):
    """NEGATIVE CONTROL. One matrix means no prefix (the pre-multimodal behaviour). A
    stamp here would rename every column of every ordinary single-modality import."""
    manifest, outputs_dir = run_converter(_combined(RNA_ONLY))
    rows = [e for e in manifest["outputs"] if e["id"] == "expression"]
    assert len(rows) == 1, "a single feature type must emit ONE expression artifact"
    assert "modality" not in (rows[0].get("structure") or {})
    assert "modality" not in (_stamped_structure(outputs_dir, rows[0]["path"]) or {})


def test_qcs_own_resolver_answers_from_the_ARTIFACTS_with_no_params(run_converter):
    """THE END-TO-END CLAIM, through the real function.

    `modality_keys({}, paths, [])` is the situation that used to be FATAL for a
    multi-matrix run: with `params.matrix_modalities` absent and the artifacts silent, it
    calls `fail()` (SystemExit). It now answers off the stores alone.
    """
    modality_keys = _load_modality_keys()
    manifest, outputs_dir = run_converter(_combined(CITESEQ))
    outs = _expression_outputs(manifest)
    # SLOT ORDER is the contract, so the paths are ordered deterministically and the
    # expectation is derived from the same ordering rather than restated.
    ordered = [outs[k] for k in sorted(outs)]
    paths = [str(outputs_dir / e["path"]) for e in ordered]
    expected = [e["meta"]["modality"] for e in ordered]

    keys = modality_keys({}, paths, [])
    assert keys == expected, (
        f"the compute resolved {keys!r} from the artifacts alone; expected {expected!r}"
    )
    # …and the relay is genuinely unnecessary now, not merely present-and-agreeing.
    assert all(k is not None for k in keys)


def test_the_artifacts_OUTRANK_a_wrong_positional_relay(run_converter):
    """Precedence, stated by `modality_keys` and worth pinning now that both channels can
    be populated: a mis-ordered relay (the failure mode a positional list invites) must not
    be able to re-label a matrix that declares its own identity."""
    modality_keys = _load_modality_keys()
    manifest, outputs_dir = run_converter(_combined(CITESEQ))
    outs = _expression_outputs(manifest)
    ordered = [outs[k] for k in sorted(outs)]
    paths = [str(outputs_dir / e["path"]) for e in ordered]
    expected = [e["meta"]["modality"] for e in ordered]

    reversed_relay = {"matrix_modalities": list(reversed(expected))}
    assert modality_keys(reversed_relay, paths, []) == expected


def _load_modality_keys():
    """Import `qc-10x.py` by path — the filename is hyphenated, so it is not importable."""
    import importlib.util

    script = _HERE.parents[1] / "qc" / "compute" / "qc-10x.py"
    for extra in (str(_LIB_DIR), str(_SCRIPTS_DIR)):
        if extra not in sys.path:
            sys.path.insert(0, extra)
    spec = importlib.util.spec_from_file_location("qc_10x_under_test", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.modality_keys
