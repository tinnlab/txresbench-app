#!/usr/bin/env python3
# ruff: noqa
"""#163 — the allocation ceiling. TEST-13 [covers: ITEM-10].

DEC-9 / DEC-18. Two things the first cut got wrong, both found blind:

  * it was sized at 4,000,000 from the two small bundles that happened to be on the build
    machine, while design §8.2's own sizing table lists `Xenium cell boundaries (~10^6 cells
    x ~20 vertices) | ~1 GB | fine` — so a bundle the DESIGN declares supported was refused;
  * its "measured basis" leg was `assert "13 vertices/cell" in source` — a substring grep of
    a comment, which passes for any value of the constant and could not see that the
    arithmetic in that very comment understated real peak memory by ~5x.

Both are fixed by making the memory model EXECUTABLE (`estimated_peak_bytes`) and asserting
the ceiling against the DESIGN's envelope rather than against the fixtures.
"""
import sys
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import xenium_fixtures as XF  # noqa: E402


def _parquet(path, rows):
    pq.write_table(pa.table({
        "cell_id": pa.array([b"a"] * rows, type=pa.binary()),
        "vertex_x": pa.array([1.0] * rows),
        "vertex_y": pa.array([2.0] * rows)}), path)


def test_a_vertex_table_above_the_ceiling_refuses_by_name(tmp_path, monkeypatch):
    monkeypatch.setenv("XENIUM_MAX_BOUNDARY_VERTICES", "10")
    BD = XF.load_boundaries_module()
    path = tmp_path / "big.parquet"
    _parquet(path, 11)
    with pytest.raises(BD.BoundariesError) as exc:
        BD.read_boundaries(path, ["a"])
    message = str(exc.value)
    assert "ceiling" in message and "XENIUM_MAX_BOUNDARY_VERTICES" in message, message


def test_a_vertex_table_at_the_ceiling_proceeds(tmp_path, monkeypatch):
    """The positive control. Without it "it refused" is satisfied by refusing everything."""
    monkeypatch.setenv("XENIUM_MAX_BOUNDARY_VERTICES", "10")
    BD = XF.load_boundaries_module()
    path = tmp_path / "ok.parquet"
    _parquet(path, 10)
    enc = BD.read_boundaries(path, ["a"])
    assert int(enc["entity"].shape[0]) == 10


def test_the_default_ceiling_covers_the_DESIGNS_OWN_envelope():
    """Sized from the design, not from whichever bundles were on the build machine."""
    BD = XF.load_boundaries_module()
    assert BD.DESIGN_VERTEX_ENVELOPE >= 20_000_000, (
        "the quoted design envelope moved — §8.2 sizes Xenium cell boundaries at ~10^6 "
        "cells x ~20 vertices"
    )
    assert BD.MAX_BOUNDARY_VERTICES > BD.DESIGN_VERTEX_ENVELOPE, (
        f"the ceiling ({BD.MAX_BOUNDARY_VERTICES:,}) leaves no headroom over the design's "
        f"APPROXIMATE envelope ({BD.DESIGN_VERTEX_ENVELOPE:,}, written as '~10^6 cells x ~20 "
        "vertices'). Pinning the hard refusal to the round number loses the boundaries of a "
        "1.6M-cell run at the vendor's measured 13 vertices/cell, which is inside the class "
        "the design calls supported."
    )
    assert BD.MAX_BOUNDARY_VERTICES >= 1_600_000 * 13, (
        "the ceiling refuses the largest real-shaped Xenium run the design's envelope covers"
    )


def test_the_memory_model_is_an_UPPER_BOUND_on_the_real_reader(tmp_path, monkeypatch):
    """TEST-24 [covers: ITEM-10]. The model must not UNDER-estimate — the first executable version did.

    It had no `n_entities` term while `encode` holds the axis index and the two ring-endpoint
    dicts, all of which scale with the entity count; a blind angle measured 180.0 MB against
    a 134.8 MB model at 100k cells. A model that is wrong in the optimistic direction is the
    same defect as the comment it replaced, so this drives the REAL reader under
    `tracemalloc` at an entity-heavy shape and refuses a peak above the model.
    """
    import tracemalloc

    # ENTITY-HEAVY, not vertex-heavy. At 13 vertices per cell the per-entity term is ~13%
    # of the model and a third blind angle measured the shipped constant still 1.58x UNDER at
    # 1,000,000 entities x 1 vertex — the shape that isolates it. This drives that shape.
    n_cells, per_cell = 150_000, 1
    rows = n_cells * per_cell
    keys = [f"cell-{i}" for i in range(n_cells)]
    path = tmp_path / "entity-heavy.parquet"
    pq.write_table(pa.table({
        "cell_id": pa.array([f"cell-{i // per_cell}".encode() for i in range(rows)],
                            type=pa.binary()),
        "vertex_x": pa.array([float(i) for i in range(rows)]),
        "vertex_y": pa.array([float(i) for i in range(rows)])}), path)

    BD = XF.load_boundaries_module()
    # BATCH_ROWS PATCHED BELOW THE ROW COUNT, for the reason the sibling test gives: at the
    # shipped value the fixed `BATCH_ROWS * BATCH_BYTES_PER_ROW` term is ~90% of the budget
    # and neither the per-row nor the per-entity slope is exercised. A blind angle set
    # `PER_ENTITY_BYTES = 1` — an 80x under-estimate of the term this test exists to add —
    # and the whole file stayed green.
    monkeypatch.setattr(BD, "BATCH_ROWS", 20_000)
    tracemalloc.start()
    BD.read_boundaries(path, keys)
    _cur, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()

    model = BD.estimated_peak_bytes(rows, n_cells)
    fixed = BD.BATCH_ROWS * BD.BATCH_BYTES_PER_ROW
    assert fixed < 0.5 * model, (
        f"the fixed per-batch term is {fixed / model:.0%} of the budget, so the per-row and "
        "per-entity slopes this test exists to bound are not what it is measuring"
    )
    assert peak <= model, (
        f"the real reader peaked at {peak / 1024 ** 2:.1f} MB against a model of "
        f"{model / 1024 ** 2:.1f} MB at {rows:,} vertices over {n_cells:,} entities — the "
        "model UNDER-estimates, which is the direction that makes the ceiling meaningless"
    )
    # ...and the entity term is real, not decoration.
    assert BD.estimated_peak_bytes(rows, n_cells) > BD.estimated_peak_bytes(rows, 0)


def test_the_memory_model_is_EXECUTABLE_and_bounds_the_ceiling():
    """The basis is a function, not a comment — so a test can refuse it.

    The design calls ~1 GB `fine` at its envelope. The ceiling must therefore stay inside a
    budget of that order; a constant whose own model says it admits several gigabytes is not
    an allocation guard.
    """
    BD = XF.load_boundaries_module()
    # The envelope is ~10^6 cells x ~20 vertices (§8.2), so the entity term is part of it.
    at_envelope = BD.estimated_peak_bytes(BD.DESIGN_VERTEX_ENVELOPE,
                                          BD.DESIGN_VERTEX_ENVELOPE // 20)
    # AGAINST §8.1's SANDBOX MEMORY LIMIT, not against §8.2's artifact SIZE. The first cut
    # compared this to §8.2's "~1 GB | fine" and called the design's estimate exceeded; a
    # blind angle showed that row is `artifact | size | staging verdict` — a disk size and an
    # ingest-cap verdict, not a memory budget. The design does not estimate producer memory
    # anywhere, so the honest bar is the sandbox's own limit with room to spare.
    assert at_envelope < 2 * 1024 ** 3, (
        f"the design's own envelope models at {at_envelope / 1024 ** 3:.2f} GiB, a quarter "
        "of §8.1's 8 GiB sandbox memory limit — past this the encoding, not the ceiling, is "
        "what would need to change"
    )
    at_ceiling = BD.estimated_peak_bytes(BD.MAX_BOUNDARY_VERTICES,
                                        BD.MAX_BOUNDARY_VERTICES // 20)
    assert at_ceiling < 2 * 1024 ** 3, (
        f"the ceiling admits {at_ceiling / 1024 ** 3:.2f} GiB of resident allocation"
    )
    # And the model is a real function of its argument, not a constant.
    assert BD.estimated_peak_bytes(2_000_000) > BD.estimated_peak_bytes(1_000_000)


def test_the_streaming_read_does_not_materialise_the_whole_id_column(tmp_path, monkeypatch):
    """The measured half — and the first cut of THIS test could not fail.

    It used 400,000 rows against `BATCH_ROWS = 1 << 20`, so the file came back in exactly ONE
    batch and the streamed path and a whole-file read were the same code. A blind angle
    re-implemented the whole-file `to_pylist()` regression this test names and it stayed
    green, 57.1 MB against a 98.8 MB budget — 83% of which was the fixed `BATCH_ROWS * 79`
    term, so almost none of the budget responded to the rows at all.

    `BATCH_ROWS` is now patched BELOW the row count, so the read really is multi-batch and
    the budget is dominated by the per-row term it exists to bound.
    """
    import tracemalloc

    rows = 400_000
    monkeypatch.setattr(XF.load_boundaries_module(), "BATCH_ROWS", 50_000)
    path = tmp_path / "wide.parquet"
    pq.write_table(pa.table({
        "cell_id": pa.array([f"cell-{i % 1000}".encode() for i in range(rows)],
                            type=pa.binary()),
        "vertex_x": pa.array([1.0] * rows),
        "vertex_y": pa.array([2.0] * rows)}), path)
    keys = [f"cell-{i}" for i in range(1000)]

    BD = XF.load_boundaries_module()
    monkeypatch.setattr(BD, "BATCH_ROWS", 50_000)
    tracemalloc.start()
    BD.read_boundaries(path, keys)
    _cur, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()

    budget = BD.estimated_peak_bytes(rows, len(keys))
    assert peak < budget, (
        f"peak {peak / 1024 ** 2:.1f} MB exceeds the module's own model "
        f"{budget / 1024 ** 2:.1f} MB at {rows:,} rows — the read is materialising more per "
        "row than the ceiling is sized for"
    )


def test_the_per_batch_ceiling_recheck_fires_when_the_FOOTER_LIES(tmp_path, monkeypatch):
    """TEST-25 [covers: ITEM-10]. The per-batch re-check, armed — the first cut of this test never reached it.

    It wrote an HONEST footer (40 rows against a ceiling of 5), so the footer check raised
    before `iter_batches` was ever entered and its `BATCH_ROWS` monkeypatch was dead code. A
    blind angle DELETED the whole `if seen > ceiling` block and the test stayed green.

    The only shape that reaches that block is a footer that UNDER-DECLARES, which pyarrow
    never writes — so one is constructed here, by wrapping `ParquetFile` so its metadata
    reports fewer rows than the file holds. The subject is this module's own reaction to a
    lying footer; pyarrow is not under test.
    """
    import pyarrow.parquet as real_pq

    BD = XF.load_boundaries_module()
    path = tmp_path / "liar.parquet"
    _parquet(path, 40)
    monkeypatch.setenv("XENIUM_MAX_BOUNDARY_VERTICES", "12")
    monkeypatch.setattr(BD, "BATCH_ROWS", 4)

    class _LyingMetadata:
        def __init__(self, inner):
            self._inner = inner

        num_rows = 3                      # the lie: 3 declared, 40 on disk

        def __getattr__(self, name):
            return getattr(self._inner, name)

    class _LyingParquetFile(real_pq.ParquetFile):
        @property
        def metadata(self):
            return _LyingMetadata(super().metadata)

    monkeypatch.setattr(real_pq, "ParquetFile", _LyingParquetFile)

    with pytest.raises(BD.BoundariesError) as exc:
        BD.read_boundaries(path, ["a"])
    message = str(exc.value)
    # NO `or "reached"`. That alternative is the wording of the in-memory refusal in
    # `encode`, which fires on the same input — so a blind angle deleted the whole
    # `if seen > ceiling` block from `_batches` and this test stayed green. The message this
    # test exists for is the footer one, and only that one.
    assert "under-reports its size" in message, message


def test_the_in_memory_entry_points_are_also_ceilinged(monkeypatch):
    """TEST-25 [covers: ITEM-10]. `encode`/`assemble` are public and had NO allocation guard at all.

    The ceiling was checked only against the parquet footer inside the file reader, while
    DEC-9/DEC-18 frame it as the module's guard and most callers drive the in-memory path.
    """
    monkeypatch.setenv("XENIUM_MAX_BOUNDARY_VERTICES", "3")
    BD = XF.load_boundaries_module()
    import numpy as np
    with pytest.raises(BD.BoundariesError) as exc:
        BD.assemble(["a"] * 4, np.zeros(4), np.zeros(4), ["a"])
    assert "ceiling" in str(exc.value)


@pytest.mark.parametrize("bad", ["not-a-number", "0", "-1"])
def test_a_bad_ceiling_environment_value_refuses_by_name_rather_than_at_import(
        bad, tmp_path, monkeypatch):
    """A malformed tunable must not be a traceback during `import boundaries`.

    The first cut evaluated `int(os.environ.get(...))` at module scope: a bad value raised
    `ValueError` before `run_import` existed, outside any handler, and a zero or negative one
    was accepted and silently made every boundaries file refuse.
    """
    monkeypatch.setenv("XENIUM_MAX_BOUNDARY_VERTICES", bad)
    BD = XF.load_boundaries_module()          # must NOT raise
    path = tmp_path / "small.parquet"
    _parquet(path, 2)
    with pytest.raises(BD.BoundariesError) as exc:
        BD.read_boundaries(path, ["a"])
    assert "XENIUM_MAX_BOUNDARY_VERTICES" in str(exc.value)
