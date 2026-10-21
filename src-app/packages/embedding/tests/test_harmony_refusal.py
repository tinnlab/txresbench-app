#!/usr/bin/env python3
# ruff: noqa
"""TEST-34 [covers: ITEM-20b] — the harmonypy-absent NAMED refusal.

With `harmonypy` ABSENT (the rootfs not yet republished with the pinned package), a run
with `integration: harmony` must fail with the package's OWN named, prefixed refusal —
naming harmonypy + the republish requirement — never a raw `ImportError` traceback
(ITEM-20b). Absence is forced deterministically via `EMBEDDING_FORCE_HARMONYPY_ABSENT=1`
(and is genuinely true on the host interpreter, which never ships harmonypy), so the
refusal path executes regardless of what the host happens to have installed.

Also pins the sibling precondition (ITEM-20a): `integration: harmony` with no batch column
bound is refused by name too — Harmony has nothing to correct against.
"""
from embedding_fixtures import counts_matrix


def _batched(n_cells, groups=("A", "B")):
    return [groups[i % len(groups)] for i in range(n_cells)]


# ── TEST-34 — harmonypy absent → NAMED refusal, not ImportError ────────────────────
def test_harmonypy_absent_is_a_named_refusal_never_a_raw_importerror(reduce_run):
    n_cells = 60
    run = reduce_run()
    run.add_matrix(counts_matrix(n_cells, 40, seed=0))
    run.add_column(_batched(n_cells), slot="batch", axis="cells", name="donor")

    proc = run.run(
        {"n_hvg": 20, "n_pcs": 10, "integration": "harmony", "batch_column": "donor"},
        env_extra={"EMBEDDING_FORCE_HARMONYPY_ABSENT": "1"})

    assert proc.returncode != 0
    diag = run.diagnostics(proc)          # only OUR `embedding.reduce:`-prefixed lines
    assert diag, "the refusal must be OUR named, prefixed line, not a bare crash"
    low = diag.lower()
    assert "harmonypy" in low                       # names the package
    assert "republish" in low or "rootfs" in low    # names the republish requirement
    # it is refused BY NAME — no Python traceback leaked as the failure.
    assert "Traceback (most recent call last)" not in proc.stderr
    # refused BEFORE the matrix was read (fail-fast precondition).
    assert "read" not in run.progress_phases(proc)
    assert not (run.outputs_dir / "manifest.json").exists()


# ── ITEM-20a precondition — harmony with no batch column is a named refusal ─────────
def test_harmony_without_a_batch_column_is_refused_by_name(reduce_run):
    run = reduce_run()
    run.add_matrix(counts_matrix(50, 30, seed=1))   # NO batch column bound
    proc = run.run({"n_hvg": 12, "n_pcs": 6, "integration": "harmony"})
    assert proc.returncode != 0
    diag = run.diagnostics(proc).lower()
    assert "harmony" in diag and "batch" in diag
    assert "Traceback (most recent call last)" not in proc.stderr


def test_unknown_integration_mode_is_refused_by_name(reduce_run):
    run = reduce_run()
    run.add_matrix(counts_matrix(50, 30, seed=2))
    proc = run.run({"n_hvg": 12, "n_pcs": 6, "integration": "combat"})
    assert proc.returncode != 0
    assert "unknown integration mode" in run.diagnostics(proc).lower()
