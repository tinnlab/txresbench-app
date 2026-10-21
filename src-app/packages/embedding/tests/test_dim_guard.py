#!/usr/bin/env python3
# ruff: noqa
"""TEST-35 [covers: ITEM-0e] — the <3-dim compute-side guard.

`embedding.visualize` refuses a 2-D input embedding from the DECLARED structure, before any
read — a 2-D input IS already a layout, so there is nothing to lay out. The view-side
`checks:` clause is `[DESCOPED — DEC-15]` (no shipped `data:` source exposes an artifact's
declared dimension count as a scalar, so a form predicate would need a new src-app/ui data
source, breaking ITEM-29/INV-16); the ≥3-dim guard is enforced COMPUTE-side — the belt every
entry path reaches. Mutation this kills: drop the `declared_dims < 3` refusal → the run reads
a 2-D input and either crashes deep in the neighbours code or produces a degenerate layout,
never the named refusal.
"""
import numpy as np


def test_visualize_refuses_a_2d_input_from_declared_structure_before_read(visualize_run):
    rng = np.random.default_rng(0)
    viz = visualize_run()
    viz.add_embedding(rng.standard_normal((70, 2)).astype(np.float32),
                      name="X_flat", method="pca")

    proc = viz.run({"method": "umap", "seed": 0})
    assert proc.returncode != 0
    diag = viz.diagnostics(proc)
    # named refusal, from the declared structure, before any read.
    assert "at least 3" in diag.lower()
    assert "before reading" in diag.lower()
    # refused BEFORE the read phase — no read, nothing written.
    assert "read" not in viz.progress_phases(proc)
    assert not (viz.outputs_dir / "manifest.json").exists()


def test_visualize_accepts_a_3d_input(visualize_run):
    # the positive control: exactly-3 dims is the boundary that MUST pass.
    rng = np.random.default_rng(1)
    viz = visualize_run()
    viz.add_embedding(rng.standard_normal((70, 3)).astype(np.float32), name="X_pca")
    viz.run_ok({"method": "umap", "seed": 0})
    assert viz.embedding_array().shape == (70, 2)
