#!/usr/bin/env python3
# ruff: noqa
"""TEST-17 / TEST-18 — `tissue_positions.parquet`: what is read, HOW it is read, and what is refused.

Visium HD is the first platform in this tree whose positions table is PARQUET rather than a
headered CSV — "Positions are **Parquet** (millions of squares)"
(`docs/research/data-processing/01-file-formats.md:629`) — and that one sentence is the
source of both claims this file proves.

* **TEST-17** — the six declared columns are read under their VENDOR names; an `in_tissue`
  written `int8` by one exporter and `bool` by another both read the same way (the
  dtype-variance reason `spatial-import-xenium/compute/boundaries.py` gives for going to
  `pyarrow.parquet` directly instead of through `pandas.read_parquet`); and the read is
  STREAMED by row group rather than materialising the whole table.

  The streaming leg is deliberately NOT "assert the constant exists". A module can declare
  `POSITIONS_BATCH_ROWS = 65_536`, never pass it to anything, call `pq.read_table` and pass
  such a test forever — which is the shape of guard `docs/design/derived-guards.md` §1 calls
  enumerating an instance instead of deriving the relation. So the proof here is
  BEHAVIOURAL: the constant is observed arriving at `iter_batches`, the whole-table readers
  are observed NOT being called, and moving the constant is observed to move the number of
  batches the reader consumes without moving its answer.

* **TEST-18** — four DISTINCT named refusals: a file that is not parquet at all, a parquet
  missing a declared column, a parquet whose `barcode` is binary and not valid UTF-8, and a
  parquet with a duplicated barcode. All four are given the SAME file name on purpose, so
  that "the four messages are distinguishable" is a claim about what each message SAYS and
  not an artefact of four different filenames; and that distinguishability is asserted
  rather than assumed, because a reader who gets the same sentence for four different
  damages learns nothing about which one they have.

  The fourth is raised by `run_import`, not by `read_positions` — the duplicate check lives
  in the barcode join (`import_visium_hd.py`, "THE BARCODE JOIN, ABOVE THE FIRST WRITER") —
  so it is driven end to end over a bundle rather than through the reader.

## The one helper this file owns, and why it is not in `make_fixture.py`

`make_fixture.write_positions_parquet` always writes `barcode` as `pa.string()`, and arrow
will not put invalid UTF-8 in a `string` array — the bytes have to be a `binary` column for
the reader's own decode step to be the thing under test. `_write_binary_barcode_positions`
below is that one variant. It is HERE rather than in the generator because the generator
builds bundles the importer is meant to ACCEPT, and this is a single hostile column.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hd_fixtures as HF  # noqa: E402
import make_fixture as MF  # noqa: E402

#: The committed fixture's positions table for the default bin — the bytes under version
#: control, not a fresh build that happens to agree with them.
FIXTURE_POSITIONS = (HF.FIXTURE / "binned_outputs" / "square_008um" / "spatial"
                     / "tissue_positions.parquet")

#: Every refusal below writes its damaged file under this ONE basename, so the four messages
#: cannot be told apart by their filename. See the module docstring.
POSITIONS_BASENAME = "tissue_positions.parquet"


def _damaged(tmp_path, name):
    """A private directory holding one damaged `tissue_positions.parquet`."""
    directory = Path(tmp_path) / name
    directory.mkdir(parents=True, exist_ok=True)
    return directory / POSITIONS_BASENAME


def _write_binary_barcode_positions(path, rows, bad_index, bad_bytes=b"s_\xff\xfe_008um-1"):
    """A positions table whose `barcode` is `pa.binary()` and holds one non-UTF-8 value.

    The other five columns are written exactly as `make_fixture.write_positions_parquet`
    writes them, including its small `row_group_size`, so the ONLY thing that differs from an
    acceptable table is the column whose decode is under test.
    """
    import pyarrow as pa
    import pyarrow.parquet as pq

    barcodes = [r[0].encode() for r in rows]
    barcodes[bad_index] = bad_bytes
    table = pa.table({
        "barcode": pa.array(barcodes, pa.binary()),
        "in_tissue": pa.array([int(r[1]) for r in rows], pa.int8()),
        "array_row": pa.array([r[2] for r in rows], pa.int32()),
        "array_col": pa.array([r[3] for r in rows], pa.int32()),
        "pxl_row_in_fullres": pa.array([float(r[4]) for r in rows], pa.float64()),
        "pxl_col_in_fullres": pa.array([float(r[5]) for r in rows], pa.float64()),
    })
    pq.write_table(table, path, row_group_size=64, compression="snappy", version="2.6",
                   store_schema=False)


# ── TEST-17: the six columns, both `in_tissue` spellings, and the streamed read ──────


def test_TEST_17_the_six_declared_columns_are_read_under_their_VENDOR_names():
    """TEST-17 — the reader returns exactly `POSITION_COLUMNS`, and each holds that column's
    own values.

    Two halves, and the second is the one that would catch a real defect. A reader that
    returned the right KEYS while pairing them with the wrong arrow field — `pxl_row` under
    `pxl_col`, the trap §7.3 rule 5 names — passes a keys-only check and draws the tissue
    transposed. So every column is compared, per row, against the same file read
    INDEPENDENTLY through `pyarrow` rather than through the reader under test.
    """
    import pyarrow.parquet as pq

    module = HF.load_compute()
    got = module.read_positions(FIXTURE_POSITIONS)
    expected = pq.read_table(FIXTURE_POSITIONS).to_pydict()

    assert set(got) == set(module.POSITION_COLUMNS), (
        "the reader's key set is not the declared column set — a caller indexing "
        f"`positions[...]` by a vendor name would get a KeyError; got {sorted(got)}"
    )
    for name in module.POSITION_COLUMNS:
        assert list(got[name]) == list(expected[name]), (
            f"column {name!r} does not hold the values the file holds under that name — the "
            "reader has paired a key with the wrong arrow field, which is how a transposed "
            "tissue map is produced without any error being raised"
        )


def test_TEST_17_an_int8_and_a_bool_in_tissue_read_IDENTICALLY(tmp_path):
    """TEST-17 — the dtype-variance claim, with the control that keeps it from being vacuous.

    `in_tissue` is written `int8` by one exporter and `bool` by another; both mean the same
    thing and both must reach the same emitted column. The CONTROL is the first assertion:
    the two files must genuinely carry different arrow types. Without it a fixture edit that
    made both bundles `int8` would leave this test green while proving nothing, which is the
    exact failure mode `test_coordinate_space.py`'s transpose control exists to prevent.

    Compared through the whole importer and not only through the reader, because the
    conversion that matters is the one that lands in `metadata/in_tissue.zarr`: a reader that
    handed `True`/`False` to a writer expecting `1`/`0` would be caught here and nowhere else.
    """
    import numpy as np
    import pyarrow.parquet as pq

    module = HF.load_compute()
    bin_um = module.DEFAULT_BIN_UM

    as_int8 = HF.staged_tree(tmp_path / "int8")
    as_bool = HF.staged_tree(tmp_path / "bool",
                             positions_kwargs={bin_um: {"in_tissue_dtype": "bool"}})
    relative = Path("binned_outputs") / f"square_{bin_um:03d}um" / "spatial" / POSITIONS_BASENAME

    int8_type = pq.ParquetFile(as_int8 / relative).schema_arrow.field("in_tissue").type
    bool_type = pq.ParquetFile(as_bool / relative).schema_arrow.field("in_tissue").type
    assert str(int8_type) == "int8" and str(bool_type) == "bool", (
        f"the two bundles carry `in_tissue` as {int8_type} and {bool_type}; this test can "
        "only prove dtype variance is handled if the two dtypes actually differ"
    )

    from_int8 = module.read_positions(as_int8 / relative)["in_tissue"]
    from_bool = module.read_positions(as_bool / relative)["in_tissue"]
    assert [int(v) for v in from_int8] == [int(v) for v in from_bool], (
        "the two spellings of `in_tissue` do not carry the same tissue call — one exporter's "
        "bundle would import with a different set of bins marked in-tissue than the other's"
    )

    HF.run_over(as_int8, tmp_path / "out-int8")
    HF.run_over(as_bool, tmp_path / "out-bool")
    landed_int8 = HF.read_values(tmp_path / "out-int8", "metadata/in_tissue.zarr")
    landed_bool = HF.read_values(tmp_path / "out-bool", "metadata/in_tissue.zarr")
    assert np.array_equal(np.asarray(landed_int8, dtype=bool),
                          np.asarray(landed_bool, dtype=bool)), (
        "the emitted `in_tissue` column differs between the `int8` bundle and the `bool` "
        "one, so the dtype a vendor happened to write changes what this importer publishes"
    )


def test_TEST_17_the_read_is_STREAMED_and_never_materialises_the_whole_table(monkeypatch):
    """TEST-17 — `POSITIONS_BATCH_ROWS` is USED, and the whole-table readers are not.

    An HD 2 um positions table is "millions of squares"; reading it as one arrow table
    materialises every column at once, which is the peak this constant exists to bound. So
    this asserts the mechanism rather than the constant:

    * `pq.ParquetFile.iter_batches` is called with `batch_size=POSITIONS_BATCH_ROWS` and with
      the six columns PROJECTED, so a vendor's thirteenth column costs nothing;
    * `pq.read_table` and `pq.ParquetFile.read` — the two whole-table doors — are replaced by
      spies that FAIL the test if reached, so a reader that streamed only in its docstring is
      red here.

    A test that merely asserted `module.POSITIONS_BATCH_ROWS == 65_536` would stay green
    through a rewrite that deleted every use of it.
    """
    import pyarrow.parquet as pq

    module = HF.load_compute()
    calls = []
    original = pq.ParquetFile.iter_batches

    def spy(self, *args, **kwargs):
        calls.append(kwargs)
        return original(self, *args, **kwargs)

    def refuse_whole_table(*args, **kwargs):
        raise AssertionError(
            "the positions reader called a WHOLE-TABLE parquet reader; on an HD 2 um bundle "
            "that materialises millions of rows x six columns at once, which is precisely "
            "what POSITIONS_BATCH_ROWS is declared to bound"
        )

    monkeypatch.setattr(pq.ParquetFile, "iter_batches", spy)
    monkeypatch.setattr(pq, "read_table", refuse_whole_table)
    monkeypatch.setattr(pq.ParquetFile, "read", refuse_whole_table)

    got = module.read_positions(FIXTURE_POSITIONS)

    assert len(calls) == 1, (
        f"expected exactly one batched read of the positions table, saw {len(calls)}"
    )
    assert calls[0].get("batch_size") == module.POSITIONS_BATCH_ROWS, (
        f"the reader batched at {calls[0].get('batch_size')!r} rather than at the declared "
        f"POSITIONS_BATCH_ROWS ({module.POSITIONS_BATCH_ROWS}) — the constant is documentation "
        "rather than a bound"
    )
    assert list(calls[0].get("columns") or []) == list(module.POSITION_COLUMNS), (
        "the reader did not PROJECT the six declared columns, so a bundle carrying extra "
        f"columns decodes them for nothing; it asked for {calls[0].get('columns')!r}"
    )
    assert len(got["barcode"]) == pq.ParquetFile(FIXTURE_POSITIONS).metadata.num_rows


def test_TEST_17_moving_the_batch_size_moves_the_BATCH_COUNT_and_not_the_ANSWER(monkeypatch):
    """TEST-17 — the mutation proof: the constant really governs how much is held at once.

    The committed fixture is written with a small `row_group_size`, so it has more than one
    row group — asserted below, because a single-row-group file would leave the streaming
    path unexercised no matter what batch size was passed.

    With `POSITIONS_BATCH_ROWS` monkeypatched to 16 the reader must consume MANY batches
    where it consumed one, and must still return exactly the same six columns. Both halves
    are needed: the batch count alone would pass for a reader that streamed and dropped rows,
    and the equality alone would pass for a reader that ignored the constant entirely.
    """
    import pyarrow.parquet as pq

    module = HF.load_compute()
    handle = pq.ParquetFile(FIXTURE_POSITIONS)
    n_rows = handle.metadata.num_rows
    assert handle.num_row_groups > 1, (
        f"the committed positions table has {handle.num_row_groups} row group(s); a "
        "single-row-group file cannot distinguish a streamed reader from one that reads the "
        "whole table, which makes this test vacuous (see `make_fixture.write_positions_"
        "parquet`'s `row_group_size`)"
    )

    whole = module.read_positions(FIXTURE_POSITIONS)

    seen = []
    original = pq.ParquetFile.iter_batches

    def counting(self, *args, **kwargs):
        for batch in original(self, *args, **kwargs):
            seen.append(batch.num_rows)
            yield batch

    monkeypatch.setattr(pq.ParquetFile, "iter_batches", counting)
    monkeypatch.setattr(module, "POSITIONS_BATCH_ROWS", 16)
    streamed = module.read_positions(FIXTURE_POSITIONS)

    assert len(seen) > 1, (
        "the reader consumed a single batch at a batch size of 16 over a "
        f"{n_rows}-row table — it is not batching at POSITIONS_BATCH_ROWS at all"
    )
    assert max(seen) <= 16, (
        f"a batch of {max(seen)} rows arrived under a declared bound of 16, so the peak this "
        "constant is supposed to cap is not capped"
    )
    assert sum(seen) == n_rows, (
        f"the streamed read covered {sum(seen)} of the file's {n_rows} rows — streaming lost "
        "or duplicated rows, which on a positions table means bins with no place on the slide"
    )
    for name in module.POSITION_COLUMNS:
        assert list(streamed[name]) == list(whole[name]), (
            f"column {name!r} differs between a 16-row-batch read and a "
            f"{module.POSITIONS_BATCH_ROWS}-row-batch read; the answer depends on the batch "
            "size, so the two bundles of one run would not agree with each other"
        )


# ── TEST-18: four damages, four distinct named refusals ─────────────────────────────


def test_TEST_18_a_file_that_is_not_parquet_at_all_is_refused_BY_NAME(tmp_path):
    """TEST-18 — a standard Visium `outs/` ships a CSV here, and that is the likely mistake.

    The refusal must name the FILE and must point the reader somewhere: HD writes parquet
    where standard Visium writes CSV, so the actionable sentence is "use the other importer".
    A bare `ArrowInvalid` traceback names neither.
    """
    module = HF.load_compute()
    path = _damaged(tmp_path, "not-parquet")
    path.write_bytes(b"barcode,in_tissue,array_row,array_col\nAAACAA-1,1,0,0\n")

    with pytest.raises(module.VisiumImportError) as exc:
        module.read_positions(path)
    message = str(exc.value)
    assert POSITIONS_BASENAME in message, "the refusal does not name the file it refused"
    assert "parquet" in message
    assert "Import Visium (Space Ranger)" in message, (
        "the refusal does not tell a user holding a standard Space Ranger `outs/` what to do "
        "instead, which is the single most likely way to reach this line"
    )


def test_TEST_18_a_missing_declared_column_is_refused_and_the_COLUMN_is_named(tmp_path):
    """TEST-18 — an incomplete positions table names WHICH column is gone and what IS there.

    Both halves. Naming only "a column is missing" leaves the reader to diff two schemas by
    hand; naming only the missing one leaves them unable to see that the file is, say, a
    Xenium table with an entirely different vocabulary.
    """
    module = HF.load_compute()
    path = _damaged(tmp_path, "missing-column")
    MF.write_positions_parquet(path, MF.positions_rows(8), drop_columns=("array_col",))

    with pytest.raises(module.VisiumImportError) as exc:
        module.read_positions(path)
    message = str(exc.value)
    assert POSITIONS_BASENAME in message, "the refusal does not name the file it refused"
    assert "array_col" in message, "the refusal does not name the column that is missing"
    for present in ("barcode", "in_tissue", "array_row"):
        assert present in message, (
            f"the refusal does not list {present!r} among the columns the file DOES carry, so "
            "a reader cannot see which vocabulary they actually have"
        )


def test_TEST_18_a_barcode_that_is_not_valid_UTF_8_is_refused_and_the_ROW_is_named(tmp_path):
    """TEST-18 — a barcode is an IDENTITY, so it is decoded strictly and refused by row.

    Arrow hands back `bytes` for a `binary` column, and a lenient decode there would pair one
    bin's position with another bin's counts — an import that is wrong everywhere and errors
    nowhere. The row number is what makes the refusal actionable on a table with millions of
    rows.
    """
    module = HF.load_compute()
    path = _damaged(tmp_path, "bad-utf8")
    rows = MF.positions_rows(8)
    _write_binary_barcode_positions(path, rows, bad_index=7)

    with pytest.raises(module.VisiumImportError) as exc:
        module.read_positions(path)
    message = str(exc.value)
    assert POSITIONS_BASENAME in message, "the refusal does not name the file it refused"
    assert "barcode" in message, "the refusal does not name the offending column"
    assert "row 7" in message, (
        f"the refusal does not name the offending ROW; it says: {message[:200]!r}"
    )


def test_TEST_18_the_refused_ROW_is_the_FILES_row_and_not_the_BATCHS_row(tmp_path):
    """TEST-18 — the row number a streamed reader reports must still be a row of the FILE.

    This is TEST-18's "says which row" clause meeting TEST-17's "streamed by row group"
    clause, and the two only agree if the reader carries a running offset across batches.
    The table below is deliberately LONGER than the SHIPPED `POSITIONS_BATCH_ROWS` — no
    monkeypatching, no reduced constant — because that is the configuration every real HD
    bundle runs in: "millions of squares" at a 65,536-row batch means the second batch starts
    at file row 65,536, and a barcode damaged anywhere past there is reported at its offset
    WITHIN its batch.

    A message that names row 7 for a barcode at file row 65,543 does not merely lose
    precision: it points a user at a row that exists, is intact, and has nothing wrong with
    it.
    """
    module = HF.load_compute()
    path = _damaged(tmp_path, "bad-utf8-late")
    batch = module.POSITIONS_BATCH_ROWS
    bad_row = batch + 7
    # A synthetic lattice wide enough to span more than one batch. The VALUES do not matter —
    # only the row count and the one damaged barcode do — so this is generated here rather
    # than by building a bundle with millions of real bins.
    rows = [(f"s_synthetic_{i:08d}-1", i % 2, i // 64, i % 64, float(i), float(i))
            for i in range(batch + 500)]
    _write_binary_barcode_positions(path, rows, bad_index=bad_row)

    with pytest.raises(module.VisiumImportError) as exc:
        module.read_positions(path)
    message = str(exc.value)
    assert POSITIONS_BASENAME in message
    assert f"row {bad_row}" in message, (
        f"the barcode at FILE row {bad_row} was reported at a different row — the row index "
        "is counted within the current batch rather than across the file, so on any bundle "
        f"larger than {batch} rows the refusal names an innocent row. Message: {message[:220]!r}"
    )


def test_TEST_18_a_DUPLICATED_barcode_is_refused_by_run_import_and_the_BARCODE_is_named(tmp_path):
    """TEST-18 — the fourth damage, which `read_positions` does not and should not catch.

    A duplicate is not a decode failure; it is a JOIN failure, and the join is where it is
    found — inside the `h5py` context and above the first writer, so the refusal leaves
    nothing on disk. Driving it through `run_import` rather than through the reader is what
    makes that placement part of the assertion instead of an implementation note.

    The duplicated barcode is copied ONTO an out-of-tissue row, so every barcode the filtered
    matrix carries still has a position: otherwise the "barcodes with no row in the positions
    table" refusal would fire first and this test would be green for the wrong reason.
    """
    module = HF.load_compute()
    bin_um = module.DEFAULT_BIN_UM
    bundle = HF.staged_tree(tmp_path)

    rows = MF.positions_rows(bin_um)
    in_tissue = next(i for i, r in enumerate(rows) if r[1] == 1)
    out_of_tissue = next(i for i, r in enumerate(rows) if r[1] == 0)
    duplicated = rows[in_tissue][0]
    rows[out_of_tissue] = (duplicated,) + tuple(rows[out_of_tissue][1:])
    MF.write_positions_parquet(
        bundle / "binned_outputs" / f"square_{bin_um:03d}um" / "spatial" / POSITIONS_BASENAME,
        rows,
    )

    outputs = tmp_path / "out"
    # `module.run_import` rather than `HF.run_over`: `run_over` calls `load_compute()` again,
    # which RE-EXECUTES the module and mints a second `VisiumImportError` class — and
    # `pytest.raises` would then miss the refusal it is here to catch.
    with pytest.raises(module.VisiumImportError) as exc:
        module.run_import(bundle, outputs)
    message = str(exc.value)
    assert POSITIONS_BASENAME in message, "the refusal does not name the file it refused"
    assert duplicated in message, (
        f"the refusal does not name the duplicated barcode {duplicated!r}, so a user cannot "
        "find the two rows in a table with millions of them"
    )
    assert HF.output_paths(outputs) == [], (
        "a refused import left paths behind; the duplicate check is documented as running "
        "above the first writer (INV-8), and a half-written store is exactly what that "
        f"placement exists to prevent: {HF.output_paths(outputs)}"
    )


def test_TEST_18_the_four_refusals_are_DISTINGUISHABLE_from_one_another(tmp_path):
    """TEST-18 — four damages must not produce one sentence.

    Every file below is written under the SAME basename, so the messages cannot be told apart
    by their filename; anything that distinguishes them is something the message SAYS. That
    is the property a user needs — four different repairs are indicated — and it is asserted
    here rather than assumed from four separately-passing tests, none of which can see the
    other three's wording.
    """
    module = HF.load_compute()
    bin_um = module.DEFAULT_BIN_UM
    messages = {}

    not_parquet = _damaged(tmp_path, "d1")
    not_parquet.write_bytes(b"barcode,in_tissue\nAAACAA-1,1\n")
    with pytest.raises(module.VisiumImportError) as exc:
        module.read_positions(not_parquet)
    messages["not-parquet"] = str(exc.value)

    missing = _damaged(tmp_path, "d2")
    MF.write_positions_parquet(missing, MF.positions_rows(bin_um),
                               drop_columns=("pxl_col_in_fullres",))
    with pytest.raises(module.VisiumImportError) as exc:
        module.read_positions(missing)
    messages["missing-column"] = str(exc.value)

    bad_utf8 = _damaged(tmp_path, "d3")
    _write_binary_barcode_positions(bad_utf8, MF.positions_rows(bin_um), bad_index=3)
    with pytest.raises(module.VisiumImportError) as exc:
        module.read_positions(bad_utf8)
    messages["bad-utf8"] = str(exc.value)

    bundle = HF.staged_tree(tmp_path / "dup-bundle")
    rows = MF.positions_rows(bin_um)
    keep = next(i for i, r in enumerate(rows) if r[1] == 1)
    clobber = next(i for i, r in enumerate(rows) if r[1] == 0)
    rows[clobber] = (rows[keep][0],) + tuple(rows[clobber][1:])
    MF.write_positions_parquet(
        bundle / "binned_outputs" / f"square_{bin_um:03d}um" / "spatial" / POSITIONS_BASENAME,
        rows,
    )
    with pytest.raises(module.VisiumImportError) as exc:
        module.run_import(bundle, tmp_path / "dup-out")
    messages["duplicate-barcode"] = str(exc.value)

    assert len(set(messages.values())) == len(messages), (
        "two of the four positions refusals produce the SAME message, so a user cannot tell "
        f"which damage they have: {json.dumps(messages, indent=2)}"
    )
    for name, message in messages.items():
        assert POSITIONS_BASENAME in message, (
            f"the {name!r} refusal does not name the file, and every one of these four is "
            "about a specific file in a bundle of twelve"
        )
    # …and each one is about ITS OWN subject, which is the half a set-inequality cannot see:
    # four distinct strings could still all be the wrong four.
    assert "not a readable parquet file" in messages["not-parquet"]
    assert "pxl_col_in_fullres" in messages["missing-column"]
    assert "not valid UTF-8" in messages["bad-utf8"] and "row 3" in messages["bad-utf8"]
    assert "more than once" in messages["duplicate-barcode"]


# ── TEST-40: the streaming claim is about MEMORY, and memory is a dtype question ────


def test_TEST_40_the_numeric_columns_come_back_as_NUMPY_not_as_python_lists(tmp_path):
    """TEST-40 — `read_positions`'s own docstring claim, made checkable.

    ## The claim, and how it was false

    The docstring says row-group streaming "keeps the peak proportional to
    `POSITIONS_BATCH_ROWS`". The first cut `.extend()`ed all six columns into Python lists,
    so the batches were streamed and then all of them were KEPT: the peak was proportional to
    the WHOLE TABLE, in Python objects. Measured on an 84 MB, 10,562,500-row positions table
    (a real 6.5 × 6.5 mm capture area at 2 µm — the bin this module documents as "millions of
    squares"): 2,706 MiB peak RSS against a 29 MiB baseline, ~270 bytes per row where the
    file holds ~8. The `normal` schedule class is 4 GiB.

    A `float64` numpy column is 8 bytes per row and ONE object. So the five numeric columns
    are the fix, and the dtype IS the assertion — a per-row measurement of RSS would be a
    flaky test of the same fact.

    ## What is NOT claimed

    `barcode` is still one Python `str` per row, and `run_import`'s `by_barcode` dict is
    another. That is the join, no dtype change reaches it, and it is tracked as #367. This
    test pins the part that IS fixed so a later edit cannot quietly put the lists back.
    """
    module = HF.load_compute()
    path = Path(tmp_path) / "tissue_positions.parquet"
    rows = MF.positions_rows(8)
    MF.write_positions_parquet(path, rows)

    out = module.read_positions(path)

    numeric = [c for c in module.POSITION_COLUMNS if c != "barcode"]
    assert numeric, "no numeric columns were enumerated, so this test measures nothing"
    for name in numeric:
        column = out[name]
        assert isinstance(column, np.ndarray), (
            f"`{name}` came back as {type(column).__name__}; a Python list of "
            f"{len(rows)} floats is ~28 bytes per value plus the pointer, which is the "
            f"defect this assertion exists to hold shut")
        assert column.dtype == np.float64, f"`{name}` has dtype {column.dtype}"
        assert len(column) == len(rows)

    # The barcode column is deliberately NOT an array — the join needs the strings, and
    # saying so here stops a future reader "fixing" it into a dtype it cannot have.
    assert isinstance(out["barcode"], list) and isinstance(out["barcode"][0], str)


def test_TEST_40_an_EMPTY_positions_table_still_yields_typed_empty_columns(tmp_path):
    """TEST-40 — the zero-batch path returns arrays, not `[]`.

    `np.concatenate([])` RAISES, so the no-row case needs its own branch, and a branch that
    returned a bare list would put the dtype guarantee back in the hands of the caller.
    Every downstream consumer indexes these with a numpy index array.
    """
    module = HF.load_compute()
    path = Path(tmp_path) / "empty.parquet"
    MF.write_positions_parquet(path, [])

    out = module.read_positions(path)
    for name in [c for c in module.POSITION_COLUMNS if c != "barcode"]:
        assert isinstance(out[name], np.ndarray) and out[name].dtype == np.float64, (
            f"the empty table's `{name}` is {type(out[name]).__name__} "
            f"{getattr(out[name], 'dtype', '')}")
        assert len(out[name]) == 0
    assert out["barcode"] == []


def test_TEST_18_a_DUPLICATED_column_is_refused_and_the_COLUMN_is_NAMED(tmp_path):
    """TEST-18 — the refusal that stands between a damaged file and a coherent WRONG answer.

    `pyarrow`'s `Schema.get_field_index` returns **-1** for a name that appears more than
    once, and `RecordBatch.column(-1)` resolves Python-style to the LAST projected column.
    Measured on this package's own fixture: append a second `pxl_row_in_fullres` and the
    import exits 0 with every bin on the diagonal (`all(x == y)`); duplicate `in_tissue`
    instead and every square reads in-tissue, which also switches the registration check off
    with no note anywhere.

    ## Why this test exists ALONGSIDE the refusal-table sweep

    Two guards stand on this path: the schema check that refuses a duplicated name, and the
    `index < 0` assertion inside the batch loop. A mutation test showed the table sweep
    (TEST-8/TEST-9) stays GREEN when the FIRST is removed — the second still refuses, so
    "some refusal happened" is still true. That makes the sweep unable to tell the two
    apart, and a reader would conclude the schema check is dead code.

    This asserts the MESSAGE: the refusal must name the duplicated column and say the file
    is damaged. Remove the schema check and the surviving refusal says something else, so
    this test reddens where the sweep does not.
    """
    module = HF.load_compute()
    import pyarrow as pa
    import pyarrow.parquet as pq

    rows = MF.positions_rows(8)
    fields, arrays = [], []
    for name, typ, take in (("barcode", pa.string(), lambda r: r[0]),
                            ("in_tissue", pa.int8(), lambda r: int(r[1])),
                            ("array_row", pa.int32(), lambda r: r[2]),
                            ("array_col", pa.int32(), lambda r: r[3]),
                            ("pxl_row_in_fullres", pa.float64(), lambda r: float(r[4])),
                            ("pxl_col_in_fullres", pa.float64(), lambda r: float(r[5])),
                            ("pxl_row_in_fullres", pa.float64(), lambda r: float(r[4]))):
        fields.append(pa.field(name, typ))
        arrays.append(pa.array([take(r) for r in rows], typ))
    path = Path(tmp_path) / "duplicated.parquet"
    pq.write_table(pa.Table.from_arrays(arrays, schema=pa.schema(fields)), path,
                   row_group_size=64)

    with pytest.raises(module.VisiumImportError) as caught:
        module.read_positions(path)
    message = str(caught.value)
    assert "pxl_row_in_fullres" in message, (
        f"the refusal does not name the duplicated column: {message!r}")
    assert "more than once" in message, (
        f"the refusal does not say WHAT is wrong with the file, so a reader cannot act on "
        f"it: {message!r}")
