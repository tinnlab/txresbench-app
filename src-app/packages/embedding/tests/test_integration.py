#!/usr/bin/env python3
# ruff: noqa
"""TEST-33 [acceptance] [invariant: INV-22] [covers: ITEM-20a, ITEM-20c, ITEM-8].

With `harmonypy` available in the env-rootfs SEAM, a reduce with a batch column and
`integration: harmony` RUNS and emits a THIRD `embedding` (`method="harmony"`); the run
PINS the harmonypy version (recorded in the report, matched to the Dockerfile pin) AND
passes every Harmony parameter EXPLICITLY, `theta` FIRST — never harmonypy 0.0.10's
implicit `theta=1` (doc-09 §B.2.5: "Pin the version and pass parameters explicitly"). The
corrected representation is the one neighbours/UMAP run on downstream.

This runs INSIDE the seam via bwrap (harmonypy ships only in the rootfs, not on the host),
so it exercises the REAL harmonypy — never skipped when the seam is set (DEC-14).
"""
from pathlib import Path

from embedding_fixtures import counts_matrix

_DOCKERFILE = (Path(__file__).resolve().parents[3]
               / "env-rootfs" / "single-cell" / "Dockerfile")
# #80 — the pin set moved out of the recipe into its own file, which is now the single
# machine-readable statement of what is installed and at which version.
_PINS = _DOCKERFILE.parent / "requirements.txt"


def _dockerfile_harmonypy_pin() -> str:
    """The version the ENVIRONMENT RECIPE pins harmonypy to.

    #80 moved the install list out of the Dockerfile into `requirements.txt`, which is now
    the single machine-readable statement of what is installed and at which version — read
    by the recipe, by the server's build gate, and by the smoke-line test. This helper
    followed it. (It previously scanned the Dockerfile for a `harmonypy==` line; after the
    move there is none, so it raised unconditionally and took TEST-33 with it — the only
    end-to-end check of the pin invariant, silently, in the one environment where it runs.)
    """
    # TEST-P15 / #214-#215. This used to `splitlines()` the pin file and `startswith` its
    # way to the version — an eleventh grammar over one text file, narrow but real: its
    # comment rule (`split("#", 1)[0]`) and its line rule are its own, so it could read a
    # version the build gate does not agree it read. It now asks the gate.
    import env_pins

    # `require_version_of`, not `version_of`: a caller that EXPECTS a pin cannot tell "not
    # pinned" from "I spelled the name the way the file spells it and the artefact folds it
    # differently", and the refusal lists the names the recipe does pin. This is the site
    # whose shape motivated that function existing (INV-22).
    return env_pins.require_version_of(
        "harmonypy", _PINS.parent.name, env_root=_PINS.parent.parent
    )


def _batched(n_cells, groups=("A", "B", "C")):
    return [groups[i % len(groups)] for i in range(n_cells)]


# ── TEST-33 ─────────────────────────────────────────────────────────────────────────
def test_harmony_runs_pins_version_and_passes_theta_explicitly(reduce_run, require_seam):
    n_cells, n_genes = 300, 80
    run = reduce_run()
    run.add_matrix(counts_matrix(n_cells, n_genes, seed=0))
    run.add_column(_batched(n_cells), slot="batch", axis="cells", name="donor")

    proc = run.run_ok(
        {"n_hvg": 40, "n_pcs": 20, "seed": 0, "integration": "harmony",
         "batch_column": "donor", "harmony_name": "X_harmony"},
        seam=True)

    # a THIRD embedding: the harmony latent, method + correction = harmony (INV-1/DEC-5).
    embeddings = [e for e in run.manifest()["outputs"] if e["datatype"] == "embedding"]
    harmony = [e for e in embeddings if e["meta"].get("method") == "harmony"]
    assert len(harmony) == 1, f"expected one harmony embedding, got {embeddings}"
    hm = harmony[0]["meta"]
    assert hm["correction"] == "harmony"
    assert hm["derived_from"] == "expression"      # never an expression matrix (INV-1)
    assert harmony[0]["datatype"] == "embedding"
    assert hm["batch_factor"] == "donor"
    # the PCA (uncorrected) embedding is still emitted alongside it.
    assert any(e["meta"].get("method") == "pca" for e in embeddings)

    rep = run.report()
    hrep = rep["harmony"]
    assert hrep is not None

    # INV-22 (a) — the version is PINNED + recorded, and MATCHES the Dockerfile pin.
    resolved = hrep["harmonypy_version"]
    assert resolved, "the resolved harmonypy version must be recorded"
    assert resolved == _dockerfile_harmonypy_pin() == hrep["harmonypy_pin"]
    assert hm["harmonypy_version"] == resolved

    # INV-22 (b) — every parameter EXPLICIT, `theta` FIRST, NOT the implicit 0.0.10 default.
    params = hrep["parameters"]
    assert list(params.keys())[0] == "theta", "theta must be the FIRST explicit parameter"
    assert params["theta"] == 2.0 and hrep["theta"] == 2.0
    assert hm["harmony_theta"] == 2.0
    assert params["vars_use"] == ["_batch"]
    assert "random_state" in params and "max_iter_harmony" in params

    # neighbours/UMAP downstream run on the CORRECTED representation (recorded).
    assert rep["primary_embedding"] == "harmony"
    assert rep["correction"] == "harmony"

    # the corrected latent read back is (n_cells × n_pcs) — a real correction, same shape.
    root = run.outputs_dir / harmony[0]["path"]
    import cyto_zarr_read
    z = cyto_zarr_read.read_array(root, "X_harmony")
    assert z.shape == (n_cells, hm["n_pcs"])


def test_the_harmonypy_pin_comes_from_the_exported_parse(monkeypatch):
    """TEST-P15 (#214 / #215) — this reader has stopped parsing the pin file.

    It was narrow (one `startswith("harmonypy==")`) but real: its own line rule and its own
    comment rule over bytes the build gate reads differently. Replacing the exported parse
    with a sentinel proves which one it follows.
    """
    import env_pins

    monkeypatch.setattr(env_pins, "version_of", lambda *a, **k: "9.9.9-sentinel")
    assert _dockerfile_harmonypy_pin() == "9.9.9-sentinel"
    monkeypatch.undo()

    # CONTROL — unpatched it returns the recipe's real pin, so the sentinel proves a read
    # of the artefact rather than a function that ignores everything.
    real = _dockerfile_harmonypy_pin()
    assert real and real[0].isdigit(), f"harmonypy pin looks wrong: {real!r}"
