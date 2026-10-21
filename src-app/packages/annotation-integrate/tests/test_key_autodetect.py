#!/usr/bin/env python3
# ruff: noqa
"""TEST-35 (ITEM-24) — a REGRESSION GUARD on the one input path that legitimately INFERS.

ITEM-24 removes filename-suffix input resolution from the computes: an input is resolved
by SLOT out of `/inputs/inputs.json`, and its format comes from the artifact's own
declaration. `annotation_integrate.py` resolves by slot too — but it additionally
auto-detects its JOIN KEY by trying each annotation-table column against the axis index
and keeping the one with the most matches.

**That inference is legitimate and must NOT be disturbed.** It is not a name lookup: it
never reads a column's NAME, only how well its VALUES align to the axis keys. A supporting
CSV a user uploads can call its barcode column anything at all — `barcode`, `cell`,
`Sample_ID`, or nothing recognisable — and a hardcoded list of accepted spellings is
exactly the closed-set failure this feature is removing everywhere else.

So this suite pins the property rather than the implementation:

  * a key column whose NAME suggests nothing is detected from its values;
  * a column NAMED like a key whose values do not align is NOT chosen;
  * the detector prefers the column with the most matches, not the leftmost;
  * a table that aligns to NOTHING is refused outright, because inference with zero
    evidence is not inference — it is the silent success this feature removes;
  * an explicit `params.key_column` still overrides (and, being a stated choice rather
    than an inference, still DEGRADES rather than refusing on a zero-match);
  * and the whole thing still works end to end through the real `main()` over a genuine
    slot-declared `/inputs` tree.

`annotation_integrate.py`'s inference is deliberately untouched by ITEM-24 — this file is
the proof. What it is NOT licence for is inferring a key when nothing aligns: the
exemption covers "read the values instead of the name", not "pick something regardless".
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

import pytest

_HERE = Path(__file__).resolve().parent
_PROCESSORS = _HERE.parent.parent
for _p in (_PROCESSORS / "_lib", _PROCESSORS / "_helpers", _HERE.parent):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

pd = pytest.importorskip("pandas")

import align  # noqa: E402
import cyto_columns  # noqa: E402
import cyto_zarr_read  # noqa: E402
import annotation_integrate as ai  # noqa: E402

BARCODES = ["AAACCTGAGAAACCAT-1", "AAACCTGAGAAAGTGG-1", "AAACCTGAGAACAATC-1"]


def _normalize_for(axis: str = "cells"):
    return ai.default_normalize_for_axis(axis)


# ─────────────────────────── the detector itself ──────────────────────────────

def test_the_join_key_is_detected_from_VALUES_under_an_unrecognisable_name():
    """The key column is called `zzz_9` — a name no allow-list would carry — and holds
    the axis's own barcodes. It must still be chosen."""
    df = pd.DataFrame(
        {
            "cell_type": ["T", "B", "NK"],
            "zzz_9": list(BARCODES),
            "score": [1.5, 2.5, 3.5],
        }
    )
    col, matched = ai.detect_key_column(df, BARCODES, _normalize_for())
    assert col == "zzz_9", f"detected {col!r} instead of the value-aligned column"
    assert matched == len(BARCODES)


def test_a_column_NAMED_like_a_key_but_not_aligned_is_not_chosen():
    """`barcode` / `cell_id` are the spellings a name-based detector would jump at; here
    they hold values that align to nothing, and the real key sits under `col_b`."""
    df = pd.DataFrame(
        {
            "barcode": ["nope-1", "nope-2", "nope-3"],
            "cell_id": ["x", "y", "z"],
            "col_b": list(BARCODES),
        }
    )
    col, matched = ai.detect_key_column(df, BARCODES, _normalize_for())
    assert col == "col_b", f"a NAME won over the values: detected {col!r}"
    assert matched == len(BARCODES)


def test_the_detector_prefers_the_column_with_the_most_matches_not_the_leftmost():
    """Two candidate columns both align; the fuller one wins. (Column order in the frame
    puts the WEAKER candidate first, so "first that works" would fail.)"""
    partial = [BARCODES[0], "unrelated-a", "unrelated-b"]
    df = pd.DataFrame({"first_guess": partial, "second_guess": list(BARCODES)})
    col, matched = ai.detect_key_column(df, BARCODES, _normalize_for())
    assert col == "second_guess", f"detected {col!r} (matched={matched})"
    assert matched == len(BARCODES)


def test_normalization_is_part_of_the_value_comparison():
    """DEC-18: the `-1` lane suffix is normalized away, so a BARE-barcode column still
    aligns. This is value-level inference, not a name lookup."""
    bare = [b.split("-")[0] for b in BARCODES]
    df = pd.DataFrame({"whatever": bare, "note": ["a", "b", "c"]})
    col, matched = ai.detect_key_column(df, BARCODES, _normalize_for())
    assert col == "whatever"
    assert matched == len(BARCODES)


# ───────────── nothing aligns ⇒ there is no key (the silent-success case) ─────
#
# These four replace a single test that was GREEN while asserting the opposite of what
# production did. It read:
#
#     col, matched = ai.detect_key_column(df, BARCODES, _normalize_for())
#     assert col is None or matched == 0, (col, matched)
#     if col is None:
#         with pytest.raises(Exception) ...
#
# `detect_key_column` returned `('a', 0)`, so the `or matched == 0` arm carried the
# assertion and the `if col is None:` body — the entire point of the test — never ran.
# The name ("yields_no_detection") and the docstring ("`(None, -1)` … a NAMED error
# rather than picking an arbitrary column") both described behaviour the code did not
# have: it picked column `a` and joined on it.

def test_a_table_that_aligns_to_nothing_is_REFUSED_not_joined_on_an_arbitrary_column():
    """No column aligns ⇒ there is NO join key, and the detector must say so.

    The detector seeded its running best at `-1` and accepted any candidate that merely
    did not RAISE, so `matched == 0` counted as a detection: a table sharing zero keys
    with the axis handed back its FIRST column as the "key" — chosen by column ORDER, not
    by evidence. A join that matched nothing is not a degraded join; there is no key.
    """
    df = pd.DataFrame({"a": ["p", "q", "r"], "b": [1, 2, 3]})
    col, matched = ai.detect_key_column(df, BARCODES, _normalize_for())
    assert col is None, (
        f"detected {col!r} with matched={matched} — a column picked with zero evidence"
    )
    assert matched == 0


def test_the_choice_of_an_unaligned_column_was_ARBITRARY_reordering_the_frame_moved_it():
    """The proof that the old pick carried no information: the same two columns, same
    values, only the frame's column ORDER swapped — and the old detector named a
    different "key" each time (`a` then `b`). Neither is a key. Both must refuse."""
    a_first = pd.DataFrame({"a": ["p", "q", "r"], "b": ["s", "t", "u"]})
    b_first = pd.DataFrame({"b": ["s", "t", "u"], "a": ["p", "q", "r"]})
    assert ai.detect_key_column(a_first, BARCODES, _normalize_for())[0] is None
    assert ai.detect_key_column(b_first, BARCODES, _normalize_for())[0] is None


def test_the_refusal_NAMES_every_column_it_tried_how_many_matched_and_both_key_shapes():
    """A bare raise would only move the silence. The message has to let a user fix the
    upload without reading the source: which columns were surveyed, how many axis
    entities each matched, how big the axis is, which normalization ran, and a SAMPLE
    from each side — the format mismatch (`p` vs `AAACCTGAGAAACCAT-1`) is the actual
    diagnosis in the overwhelmingly common case."""
    df = pd.DataFrame({"a": ["p", "q", "r"], "b": [1, 2, 3]})
    with pytest.raises(align.AlignmentError) as exc:
        ai.integrate(BARCODES, df, "cells")
    msg = str(exc.value)

    for col in ("a", "b"):
        assert f"'{col}'" in msg or f'"{col}"' in msg, f"column {col!r} not named: {msg}"
    assert "0" in msg, msg                       # the match count per candidate
    assert str(len(BARCODES)) in msg, msg        # the axis size
    assert "barcode_suffix" in msg, msg          # the pipeline that was applied
    assert BARCODES[0] in msg, msg               # a real axis key
    assert "p" in msg, msg                       # a real table key
    # …and it still says what it failed to do, in the words the old test looked for.
    assert "auto-detect" in msg, msg


def test_ONE_matching_row_is_still_a_real_key_the_floor_is_zero_not_a_quorum():
    """The negative control for the fix. Refusing at `matched == 0` must not become
    refusing at "not enough matches": a supporting table covering a single cell of 3 is a
    legitimate, if sparse, join and still has a real key. Only the EMPTY intersection is
    a non-join."""
    df = pd.DataFrame({"k": [BARCODES[0], "unrelated-a", "unrelated-b"], "note": ["x", "y", "z"]})
    col, matched = ai.detect_key_column(df, BARCODES, _normalize_for())
    assert col == "k"
    assert matched == 1
    res = ai.integrate(BARCODES, df, "cells")
    assert res["key_column"] == "k"
    assert res["coverage"]["matched"] == 1
    assert res["degraded"] is False


def test_an_EXPLICIT_key_column_that_matches_nothing_still_DEGRADES_rather_than_refusing():
    """The deliberate asymmetry. Refusal is about INFERENCE: with no key named, a
    zero-match survey means the detector has nothing to go on and must not invent one.
    When the caller NAMES the column, the choice is theirs and reporting it back as a
    degraded, all-NA alignment is an honest answer to the question asked — so the
    `degraded` machinery stays reachable and keeps its meaning."""
    df = pd.DataFrame({"named": ["p", "q", "r"], "payload": [1, 2, 3]})
    res = ai.integrate(BARCODES, df, "cells", key_column="named")
    assert res["key_column"] == "named"
    assert res["degraded"] is True
    assert res["coverage"]["matched"] == 0
    assert any("DEGRADED" in w for w in res["warnings"])


def test_an_explicit_key_column_overrides_the_detector():
    """`params.key_column` still wins — the inference is a default, never a policy."""
    df = pd.DataFrame({"chosen": list(BARCODES), "other": list(BARCODES)})
    res = ai.integrate(BARCODES, df, "cells", key_column="other")
    assert res["key_column"] == "other"
    assert res["coverage"]["matched"] == len(BARCODES)


# ─────────────────────── the same property, end to end ────────────────────────

def _run_dir(root: Path, *, table_rows, axis_keys=BARCODES, params=None,
             table_name="table.csv", axis_subpath="cells_index.zarr"):
    """A genuine slot-declared run dir (mirrors `build_integrate_inputs`)."""
    inputs, outputs = root / "inputs", root / "outputs"
    inputs.mkdir(parents=True, exist_ok=True)
    outputs.mkdir(parents=True, exist_ok=True)

    header = list(table_rows[0].keys())
    body = "\n".join(
        [",".join(header)] + [",".join(str(r[h]) for h in header) for r in table_rows]
    )
    (inputs / table_name).write_text(body + "\n")

    cyto_columns.write_metadata_column(
        inputs, axis_subpath, "cells_index", pd.Series(list(axis_keys)),
        axis="cells", holds_axis_keys=True,
    )
    (inputs / "inputs.json").write_text(json.dumps({"inputs": [
        {"slot": "annotation", "kind": "dataset-file",
         "sandbox_path": f"/inputs/{table_name}"},
        {"slot": "axis_index", "kind": "artifact",
         "sandbox_path": f"/inputs/{axis_subpath}"},
    ]}))
    bag = {"axis": "cells", "seed": 0}
    bag.update(params or {})
    (inputs / "params.json").write_text(json.dumps(bag))
    return inputs, outputs


def _run_main(inputs: Path, outputs: Path):
    saved = {k: os.environ.get(k) for k in ("CYTO_INPUTS_DIR", "CYTO_OUTPUTS_DIR")}
    os.environ["CYTO_INPUTS_DIR"] = str(inputs)
    os.environ["CYTO_OUTPUTS_DIR"] = str(outputs)
    try:
        ai.main()
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
    return json.loads((outputs / "manifest.json").read_text())["outputs"]


def test_a_real_run_still_auto_detects_the_key_by_value_overlap():
    """End to end over a slot-declared `/inputs`: the table's key column is named
    `zzz_9`, and the run resolves it, aligns, and emits the annotation column with the
    right values in axis order."""
    rows = [
        {"cell_type": t, "zzz_9": b}
        for b, t in zip(BARCODES, ["T", "B", "NK"])
    ]
    with tempfile.TemporaryDirectory() as td:
        inputs, outputs = _run_dir(Path(td), table_rows=rows)
        entries = _run_main(inputs, outputs)

        report = json.loads((outputs / "integration_summary.json").read_text())
        assert report["key_column"] == "zzz_9", report
        assert report["matched"] == len(BARCODES), report

        cols = {e["label"]: e for e in entries if e.get("datatype") == "metadata-column"}
        assert "cell_type" in cols, sorted(cols)
        values = cyto_zarr_read.read_column(outputs / cols["cell_type"]["path"])
        assert [str(v) for v in values] == ["T", "B", "NK"]


def test_a_real_run_that_aligns_to_nothing_FAILS_THE_JOB_and_emits_no_manifest():
    """The end-to-end shape of the bug, through the real `main()` over a genuine
    slot-declared `/inputs` tree.

    Before: exit 0, a full `/outputs/manifest.json`, one all-NA `metadata-column` per
    table column, and an `integration_summary` carrying `degraded: true` — a flag that
    (verified by grep across `src-app/server/src` and `src-app/ui/src`) NOTHING reads.
    The server's completion hook copies the summary into `dataset_files` verbatim, the
    per-file status is derived from the JOB's exit code, and the panel's own narrowing
    helper (`ui/src/modules/datasets/lib/supporting.ts::coverage`) keeps only
    `{matched, missing, extra, error}` — dropping `degraded` and `status` on the floor.
    So the user's end state was a green "Integrated" tag over a set of entirely empty
    columns, which is verbatim "returns 0 and reports green while having done nothing".

    A non-zero exit is what the whole chain already knows how to render loudly.
    """
    rows = [{"other_id": f"X{i}", "label": t} for i, t in enumerate(["a", "b", "c"])]
    with tempfile.TemporaryDirectory() as td:
        inputs, outputs = _run_dir(Path(td), table_rows=rows)
        with pytest.raises(SystemExit) as exc:
            _run_main(inputs, outputs)
        assert exc.value.code == 1, f"exited {exc.value.code!r}, not a job failure"
        # Nothing was emitted: no manifest to ingest, so no all-NA columns land in the
        # dataset as real, selectable, permanently-grey artifacts.
        assert not (outputs / "manifest.json").exists(), sorted(p.name for p in outputs.iterdir())
        assert not (outputs / "integration_summary.json").exists()


def test_a_real_run_is_not_fooled_by_a_key_shaped_column_name():
    """The same run with a decoy `barcode` column that aligns to nothing: the detector
    still picks the value-aligned one."""
    rows = [
        {"barcode": f"decoy-{i}", "payload": b, "cell_type": t}
        for i, (b, t) in enumerate(zip(BARCODES, ["T", "B", "NK"]))
    ]
    with tempfile.TemporaryDirectory() as td:
        inputs, outputs = _run_dir(Path(td), table_rows=rows)
        _run_main(inputs, outputs)
        report = json.loads((outputs / "integration_summary.json").read_text())
        assert report["key_column"] == "payload", report
        assert report["matched"] == len(BARCODES), report
