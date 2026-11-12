#!/usr/bin/env python3
# ruff: noqa
"""annotation_integrate — TxResBench supporting-file KIND-PROCESSOR (ITEM-13).

The SINGLE, generic, axis-AGNOSTIC integrator for the ``annotation_table`` supporting
kind (DEC-8/DEC-16/DEC-23). It folds a keyed CSV/TSV annotation table onto an existing
dataset's ENTITY AXIS (cells / genes / variants / samples — it never knows which) and
emits, per non-key table column, ONE axis-tagged ``metadata-column`` sidecar artifact.
The primary store is UNTOUCHED (DEC-1); these are additive, dataset-scoped columns.

Alignment is the shared ``align.align`` engine (DEC-2 left-join, warn-on-gaps, hard on
duplicate keys) with KEY NORMALIZATION (DEC-18: strip 10x barcode ``-1`` suffix, Ensembl
``.N`` version, trim). Each output's ``meta`` carries the compact ``colsummary`` viz
summary of the ALIGNED values PLUS the alignment ``coverage`` (ITEM-21/DEC-25), so viz
reads a legend/range without downloading the column body.

TWO inputs (the coordinator's Rust wires both into ``/inputs`` and records them in
``/inputs/inputs.json`` as slot→path — read exactly like ``h5ad_import.py``):

  * slot ``annotation_table`` — the uploaded supporting annotation file (csv/tsv). One
    column is the join key (auto-detected against the axis index, or ``params.key_column``).
  * slot ``axis_index``       — the target axis's entity-INDEX ``metadata-column``
    artifact the primary import emitted (DEC-7). Since artifact-model ITEM-26 that
    artifact is a **Zarr STORE DIRECTORY** (`txr_columns.write_metadata_column`), not a
    single-file JSON: the ordered axis keys live in the member the producer DECLARED via
    ``structure.key``, and the axis NAME in ``structure.axis``. Read through the
    reference reader (``txr_zarr_read``), never by re-deriving the container by hand.
    The artifact's own identity is its ``content_hash`` + ``structure.key_sequence_digest``
    (INV-3) — its label (``cells_index`` / ``genes_index``) is a name, not a contract, and
    nothing here keys off it.

Optional ``/inputs/params.json`` fields: ``axis`` (the axis NAME to tag outputs with —
the coordinator always sets it; absent, it falls back to the axis the INDEX ARTIFACT
declares in ``structure.axis``, never to a name-derived or hardcoded one),
``key_column`` (override the auto-detect), ``normalize`` (override the default pipeline).

The run contract mirrors ``h5ad_import.py``: read ``/inputs/<slot>`` + ``inputs.json`` +
``params.json``; write ``/outputs/<file>`` + ``/outputs/manifest.json``. ``TXR_INPUTS_DIR``
/ ``TXR_OUTPUTS_DIR`` override the roots for the off-sandbox harness.
"""
import txr_deps
import json
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd

# Shared SIBLING helpers — the axis-agnostic alignment engine + the compact column
# summary. REUSED, never reimplemented (the task contract). The sandbox runner stages
# `align.py` + `colsummary.py` alongside this entry; the off-sandbox harness/pytest puts
# the scripts dir on `sys.path` first. The self-dir insert covers the sandbox-staged case.
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)
import align  # noqa: E402
import txr_columns  # noqa: E402  (the shared `_lib` output-format adapter)
# The `_lib` reference READER for what `txr_zarr` writes. Its module header names this
# exact case as one of its two reasons to exist ("a processor that consumes another
# processor's output"), so the shard container is decoded once, in the library that owns
# the format, instead of a second time here. Globally staged into every Python entry's
# `/code` alongside `txr_columns` (`sandbox/processors/mod.rs::PY_HELPER_FILES`).
import txr_zarr_read  # noqa: E402
from colsummary import summarize_column  # noqa: E402

# The legacy combined key-normalization pipeline (DEC-18). Retained as a documented
# reference / explicit-override value, but it is NO LONGER the auto default: applying
# `barcode_suffix` to a GENES axis mangles dash-DIGIT gene symbols (NKX2-1, NKX2-5,
# HOXA-1 …) — two collide → hard AlignmentError; one → silent over-strip. The default
# is now AXIS-AWARE (see `default_normalize_for_axis`).
DEFAULT_NORMALIZE = ["barcode_suffix", "ensembl_version", "trim"]

# Axis vocabularies for the axis-aware default. Cells carry 10x barcodes (`-<lane int>`
# suffixes); genes/features carry Ensembl-versioned ids (`.<int>`). We deliberately do
# NOT apply `barcode_suffix` to a gene axis (it would strip a legitimate `-1`/`-5` off a
# real gene SYMBOL).
_CELL_AXIS_NAMES = frozenset({"cells", "cell", "barcode", "barcodes", "obs"})
_GENE_AXIS_NAMES = frozenset({"genes", "gene", "features", "feature", "var"})


def default_normalize_for_axis(axis_name):
    """The AXIS-AWARE default key-normalization pipeline (fixes barcode_suffix being
    wrongly applied to the genes axis):

      * cells / barcode axis   → ``["barcode_suffix", "trim"]``
      * genes / features axis  → ``["ensembl_version", "trim"]``
      * anything else          → ``["trim"]`` (no id-shape assumption we can't justify)

    An explicit per-axis ``normalize`` list (job params / inputs) always wins over this
    default — see ``integrate`` / ``main``."""
    a = str(axis_name or "").strip().lower()
    if a in _CELL_AXIS_NAMES:
        return ["barcode_suffix", "trim"]
    if a in _GENE_AXIS_NAMES:
        return ["ensembl_version", "trim"]
    return ["trim"]


# ─────────────────────────────── I/O idioms (inlined per-script, mirrors h5ad_import) ─

def io_dirs():
    inp = Path(os.environ.get("TXR_INPUTS_DIR", "/inputs"))
    out = Path(os.environ.get("TXR_OUTPUTS_DIR", "/outputs"))
    out.mkdir(parents=True, exist_ok=True)
    return inp, out


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except (FileNotFoundError, ValueError):
        return {} if default is None else default


def load_inputs_index(inputs_dir):
    """slot → host path, resolved from inputs.json (`sandbox_path` = /inputs/<sub>).
    Falls back to globbing when inputs.json is absent (mirrors h5ad_import)."""
    idx = read_json(inputs_dir / "inputs.json", {"inputs": []})
    slots = {}
    for e in idx.get("inputs", []):
        sp_path = e.get("sandbox_path", "") or ""
        if sp_path.startswith("/inputs/"):
            sub = sp_path[len("/inputs/"):]
        else:
            sub = Path(sp_path).name or e.get("slot", "")
        slots[e["slot"]] = inputs_dir / sub
    return slots


#: The two files the sandbox DERIVES into `/inputs` itself
#: (`sandbox/inputs.rs::DERIVED_INPUT_FILES`). They are never a declared input, so a glob
#: fallback that returned one of them would hand the reader the run's own wiring instead
#: of data — silently, since both parse as JSON.
_DERIVED_INPUT_FILES = frozenset({"inputs.json", "params.json"})


def resolve_slot(slots, inputs_dir, prefer, patterns):
    """Pick an input by SLOT-name preference, else glob (mirrors h5ad_import).

    `prefer` holds SLOT names — the keys of `/inputs/inputs.json`, which the coordinator
    authors (`dataset::process::build_integrate_inputs` binds slots `annotation` and
    `axis_index`). It is NOT the artifact's name/`output_id`, and nothing here keys an
    axis off a label: this is the run's own input wiring, the same contract
    `h5ad_import` reads, and it is the ONLY path taken on a real run (the sandbox binds
    `inputs.json` read-only at `/inputs/inputs.json`). The `patterns` below are the
    fallback for a harness that stages bare files with no `inputs.json`.
    """
    for name in prefer:
        if name in slots and Path(slots[name]).exists():
            return Path(slots[name])
    for pat in patterns:
        hits = sorted(p for p in inputs_dir.glob(pat) if p.name not in _DERIVED_INPUT_FILES)
        if hits:
            return hits[0]
    return None


def params(inputs_dir):
    return read_json(inputs_dir / "params.json", {})


_PROGRESS_FD = [-1]


def _fifo_write(line):
    fifo = os.environ.get("TXR_PROGRESS_FIFO")
    if not fifo:
        return
    if _PROGRESS_FD[0] < 0:
        try:
            _PROGRESS_FD[0] = os.open(fifo, os.O_WRONLY | os.O_NONBLOCK)
        except OSError:
            _PROGRESS_FD[0] = -1
    if _PROGRESS_FD[0] >= 0:
        try:
            os.write(_PROGRESS_FD[0], (line + "\n").encode())
        except OSError:
            try:
                os.close(_PROGRESS_FD[0])
            except OSError:
                pass
            _PROGRESS_FD[0] = -1


def progress(phase, pct=None, message=None):
    parts = [str(phase)]
    if pct is not None:
        parts.append(str(int(pct)))
    if message is not None:
        if pct is None:
            parts.append("")
        parts.append(str(message))
    line = "|".join(parts)
    _fifo_write(line)
    print("progress:", line, file=sys.stderr, flush=True)


# Declared, ordered biologist milestones (mirrors h5ad_import's MILESTONE_IDS pattern).
MILESTONE_IDS = ("read", "detect-key", "align", "emit")
_CURRENT_MILESTONE = [None]


def milestone(mid, status, detail=None):
    if status == "started":
        _CURRENT_MILESTONE[0] = mid
    parts = ["milestone", str(mid), str(status)]
    if detail is not None:
        parts.append(json.dumps(detail, default=_jsonable, separators=(",", ":")))
    line = "|".join(parts)
    _fifo_write(line)
    print("milestone:", line, file=sys.stderr, flush=True)
    if status in ("done", "failed"):
        _CURRENT_MILESTONE[0] = None


#: The `(datatype, layout)` this package emits its run-environment record as (#80).
#: Declared here because the package knows its own output type; the shared recorder
#: in `_lib` is app-core and may not name a contributed domain's vocabulary.
DT_RUN_ENVIRONMENT = ("report/qc", "opaque")


def write_manifest(outputs_dir, entries):
    # #80 — append this run's ENVIRONMENT RECORD (the resolved version of every library
    # this entry declares) before the manifest is written, and refuse the run if the
    # environment does not satisfy the declaration. Placed here, on the one path every
    # successful run takes, so recording is structural rather than remembered: a compute
    # cannot emit its outputs without also emitting what produced them.
    # The datatype is THIS package's, passed in: `txr_deps` is app-core and may not
    # name a contributed domain's vocabulary, so the caller supplies the pair.
    txr_deps.augment(outputs_dir, entries, DT_RUN_ENVIRONMENT)
    (outputs_dir / "manifest.json").write_text(json.dumps({"outputs": entries}, indent=2))


def output_entry(id, datatype, layout, path, role, label=None, meta=None, axis=None,
                 hidden=False, *, structure):
    """One `/outputs/manifest.json` entry (mirrors h5ad_import.output_entry; `axis`
    tags the entry with its datatype AXIS name — ITEM-7).

    `structure` (HOW to decode the bytes) is a producer declaration with NO default on
    either side of the wire — artifact-model ITEM-5 — so it is named at every call site.
    `meta` keeps its existing optional-but-emitted shape; it is written explicitly
    (as `null` when absent) because the wire has no default for it either (ITEM-6)."""
    entry = {"id": id, "datatype": datatype, "path": path, "layout": layout, "role": role,
             "structure": structure, "meta": meta}
    if label is not None:
        entry["label"] = label
    if axis is not None:
        entry["axis"] = axis
    if hidden:
        entry["hidden"] = True
    return entry


def _jsonable(v):
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating,)):
        return None if np.isnan(v) else float(v)
    if isinstance(v, (np.bool_,)):
        return bool(v)
    if isinstance(v, np.ndarray):
        return v.tolist()
    return v


def sanitize_col_name(name):
    keep = "".join(c if (c.isalnum() or c in "-_.") else "_" for c in str(name))
    return keep or "col"


# ─────────────────────────────── loaders ──────────────────────────────────────

def load_axis_index(path):
    """Read the target axis's entity-index ``metadata-column`` artifact →
    ``(ordered axis keys, declared axis name)``.

    Since artifact-model ITEM-26 that artifact is a **Zarr store DIRECTORY** written by
    `txr_columns.write_metadata_column(..., holds_axis_keys=True)`, so this reads it the
    way every other migrated consumer in the tree does — through the `_lib` reference
    reader — and takes BOTH facts from the producer's own declaration in the store's group
    attributes rather than from the artifact's name or its file extension:

      * ``structure.key`` names the member holding the axis's ordered keys. Which member
        that is "cannot be derived from bytes" (`txr_zarr.Table`), so it is read, not
        assumed; `"values"` is the fallback only for a column artifact that declares no
        key member at all.
      * ``structure.axis`` is the axis NAME. This replaces deriving it from the artifact's
        label by stripping an ``_index`` suffix — under INV-3 a name is a label and an
        axis's identity is its `content_hash`, so a name-derived axis was reading a
        contract into a string.

    The pre-ITEM-26 single-file JSON form (``{name, kind, values, …}``) and the
    newline-delimited text fallback are deliberately GONE, not kept as a compat path:
    no producer in the tree writes either any more (`h5ad_import` is the only emitter of
    an ``<axis>_index`` and it writes Zarr), and migration `202608040001_artifact_model`
    does `DELETE FROM public.artifacts`, so no stored JSON index can be staged either.
    Keeping them would be worse than dead: the old code fell through to
    ``text.splitlines()`` on any non-JSON body, which over a Zarr store's gzipped shard
    bytes yields plausible-looking garbage keys and a 0-match "successful" alignment.
    A shape this function cannot read is now an ERROR that names what it found.
    """
    root = Path(path)
    if not root.is_dir():
        raise ValueError(
            f"axis index {str(root)!r} is not a Zarr store directory — since ITEM-26 the "
            "`<axis>` entity-index metadata-column artifact is a Zarr store written by "
            "`txr_columns.write_metadata_column` (note the staged name may still carry a "
            "`.json` extension; the extension is not the format)"
        )
    try:
        structure = txr_zarr_read.structure(root)
    except (OSError, ValueError, KeyError) as exc:
        raise ValueError(
            f"axis index {str(root)!r} carries no readable `structure` declaration in its "
            f"group `zarr.json` ({type(exc).__name__}: {exc}) — it is not a `txr_zarr` store"
        ) from exc

    member = structure.get("key") or "values"
    values = txr_zarr_read.read_column(root, member)
    if hasattr(values, "tolist"):  # a numeric member decodes to a numpy array
        values = values.tolist()
    keys = [None if v is None else str(v) for v in values]
    axis_declared = structure.get("axis")
    return keys, (str(axis_declared) if axis_declared else None)


def load_annotation_table(path):
    """Read the supporting annotation CSV/TSV into a DataFrame. Delimiter by extension
    (`.tsv`/`.tab` → tab), else sniff via the python engine. Values keep their inferred
    dtype (so a numeric column summarizes as continuous)."""
    name = Path(path).name.lower()
    if name.endswith((".tsv", ".tab")):
        return pd.read_csv(path, sep="\t")
    try:
        return pd.read_csv(path, sep=None, engine="python")
    except Exception:
        return pd.read_csv(path)


def survey_key_columns(df, axis_keys, normalize):
    """Try EVERY table column as the join key and report what each one achieved.

    Returns ``[{column, matched, skipped}]`` in column order: ``matched`` is the number of
    axis entities that column aligned (``None`` when the column is structurally unusable
    as a key), ``skipped`` the ``AlignmentError`` text in that case (duplicate/ambiguous
    keys — a non-key column typically has repeats).

    Split out of ``detect_key_column`` so the FAILURE path can name what it tried without
    re-running the alignment: a refusal a user cannot act on is barely better than the
    silent success it replaced.
    """
    survey = []
    for col in df.columns:
        try:
            res = align.align(df, key_column=col, axis_index=axis_keys, normalize=normalize)
        except align.AlignmentError as exc:
            survey.append({"column": col, "matched": None, "skipped": str(exc)})
            continue
        survey.append({"column": col, "matched": res["coverage"]["matched"], "skipped": None})
    return survey


def best_key_column(survey):
    """The winning candidate out of a ``survey_key_columns`` report → ``(column, matched)``,
    or ``(None, 0)`` when NO column aligned to anything.

    The floor is the fix. This used to seed its running best at ``-1`` and accept any
    candidate scoring ``> best_matched``, which meant any column that merely did not RAISE
    — including ``matched == 0``. On a table sharing no keys with the axis, every column
    scored 0, so the FIRST one won and was returned as "the key": a join key chosen by
    column ORDER, over zero evidence. ``integrate()`` then joined on it, every emitted
    column came back all-NA, ``main()`` exited 0, and the file landed under a green
    "Integrated" tag (the derived per-file status reads the JOB's exit code, and the
    panel's `integration_summary` narrowing keeps only `{matched, missing, extra, error}`
    — the `degraded` flag written below has no reader anywhere in the server or the UI).

    A candidate must therefore match AT LEAST ONE axis entity to count as a detection.
    An empty intersection is not a weak key, it is the absence of one. Note the floor is
    exactly zero and not a quorum: a supporting table covering one cell in a thousand is
    sparse, not wrong, and still has a real key.
    """
    best, best_matched = None, 0
    for entry in survey:
        m = entry["matched"]
        if m is None or m <= 0:
            continue
        if m > best_matched:  # strict: ties keep the leftmost, as before
            best, best_matched = entry["column"], m
    return best, best_matched


def detect_key_column(df, axis_keys, normalize):
    """Auto-detect the join key (DEC-11): the column that, aligned to the axis index,
    yields the most matches. Returns ``(column, matched)``, or ``(None, 0)`` when no
    column aligns to a single axis entity — see ``best_key_column`` for why that is a
    refusal and not a pick."""
    return best_key_column(survey_key_columns(df, axis_keys, normalize))


def _sample_keys(values, limit=3, width=44):
    """A few printable example keys, for the "your ids look nothing like ours" diagnosis."""
    out = []
    for v in values:
        if v is None:
            continue
        s = str(v)
        out.append(s if len(s) <= width else s[:width] + "…")
        if len(out) >= limit:
            break
    return ", ".join(repr(s) for s in out) or "(none)"


def describe_key_detection_failure(df, axis_keys, axis_name, normalize, survey=None):
    """The actionable refusal message: what was tried, what it scored, and what the two
    sides' keys actually LOOK like.

    The overwhelmingly common cause is a format mismatch the user can see instantly once
    both shapes are put side by side (`'Cell_1'` against `'AAACCTGAGAAACCAT-1'`), so the
    message shows them rather than describing them."""
    if survey is None:
        survey = survey_key_columns(df, axis_keys, normalize)

    lines = [
        f"could not auto-detect a join key column in the annotation table: none of its "
        f"{len(list(df.columns))} column(s) aligned to any of the {len(axis_keys)} "
        f"entities on the {str(axis_name)!r} axis index.",
        f"columns tried (normalization applied to both sides: {list(normalize)}):",
    ]
    for e in survey:
        if e["skipped"] is not None:
            lines.append(f"  - {str(e['column'])!r}: unusable as a key — {e['skipped']}")
        else:
            lines.append(
                f"  - {str(e['column'])!r}: matched {e['matched']} of {len(axis_keys)}"
                f" — e.g. {_sample_keys(df[e['column']].tolist())}"
            )
    lines.append(f"the axis index holds e.g. {_sample_keys(axis_keys)}")
    lines.append(
        "no column shares a single key with this axis. Check that the table is keyed by "
        "this dataset's entity ids (and that it belongs to THIS dataset and THIS axis); "
        "if the ids are right but written differently, set `params.key_column` and/or an "
        "explicit `normalize` pipeline."
    )
    return "\n".join(lines)


# ─────────────────────────────── pure core (testable off-sandbox) ─────────────

def integrate(axis_keys, table_rows, axis_name, key_column=None, normalize=None):
    """Align a supporting annotation table onto an ordered entity axis and build the
    per-column aligned outputs + compact summaries — the PURE, I/O-free core (mirrors
    ``align.align``'s testable shape).

    Args:
      axis_keys:   the target axis's ordered entity ids (``list``).
      table_rows:  the annotation table — ``list[dict]`` or a ``pandas.DataFrame``.
      axis_name:   the axis NAME to tag every output with (``cells``/``genes``/…).
      key_column:  the join key; auto-detected against ``axis_keys`` when ``None``.
      normalize:   the key-normalization pipeline; the AXIS-AWARE default (from
                   ``default_normalize_for_axis(axis_name)``) when ``None``.

    Returns ``{key_column, axis, coverage, warnings, degraded,
    columns:[{name, values, summary}]}`` where each ``summary`` is
    ``colsummary.summarize_column`` of the aligned values with the alignment
    ``coverage`` folded in under ``summary["coverage"]`` and the ``degraded`` /
    ``status`` signal under ``summary`` (ITEM-21/DEC-25).

    ``degraded`` is True when the SUPPLIED ``key_column`` yields ZERO matches: every
    emitted column is all-NA, so this is a FAILED/degraded alignment, NOT a clean success
    — the caller must surface it rather than report success.

    That case is reachable only with an EXPLICIT ``key_column``. When the key is being
    INFERRED, a zero-match survey means no column aligned to anything, and this raises
    instead of joining on an arbitrary one (``best_key_column``). The asymmetry is
    deliberate: naming a column is the caller's stated choice and an honest all-NA answer
    to it is a real answer; inferring one over zero evidence is not inference.

    Raises ``align.AlignmentError`` (duplicate/ambiguous key, or — with no ``key_column``
    supplied — no column aligning to a single axis entity).
    """
    steps = default_normalize_for_axis(axis_name) if normalize is None else list(normalize)
    df = table_rows if isinstance(table_rows, pd.DataFrame) else pd.DataFrame.from_records(table_rows)

    if key_column is None:
        survey = survey_key_columns(df, axis_keys, steps)
        key_column, matched = best_key_column(survey)
        if key_column is None:
            raise align.AlignmentError(
                describe_key_detection_failure(df, axis_keys, axis_name, steps, survey=survey)
            )

    res = align.align(df, key_column=key_column, axis_index=axis_keys, normalize=steps)
    coverage = res["coverage"]
    warnings = list(res["warnings"])

    # DEGRADED alignment (fix): a best-candidate key with ZERO matches used to be
    # chosen and emitted as all-NA columns while the job exited 0 reporting success.
    # Flag it loudly instead of silently succeeding.
    degraded = coverage["matched"] == 0
    if degraded:
        warnings.append(
            f"DEGRADED alignment: key column {key_column!r} matched 0 of "
            f"{len(axis_keys)} axis entities — every emitted metadata-column is all-NA "
            f"(the annotation table shares no keys with this axis, or the "
            f"normalization pipeline is wrong for the axis)"
        )

    columns = []
    for name, values in res["columns"].items():
        summary = summarize_column(values, name)
        summary["coverage"] = coverage
        summary["degraded"] = degraded
        summary["status"] = "degraded" if degraded else "ok"
        columns.append({"name": name, "values": values, "summary": summary})

    return {
        "key_column": key_column,
        "axis": axis_name,
        "coverage": coverage,
        "warnings": warnings,
        "degraded": degraded,
        "columns": columns,
    }


# ─────────────────────────────── processor ────────────────────────────────────

def main():
    inputs_dir, outputs_dir = io_dirs()
    p = params(inputs_dir)
    slots = load_inputs_index(inputs_dir)

    table_path = resolve_slot(
        slots, inputs_dir,
        prefer=("annotation_table", "annotation", "table", "supporting", "input"),
        patterns=("*.csv", "*.tsv", "*.tab", "*.txt"),
    )
    # The axis index is resolved by SLOT (`axis_index`) on every real run. The glob
    # patterns are the no-`inputs.json` harness fallback and must match a Zarr store
    # DIRECTORY under either name it can be staged under.
    #
    # The coordinator's `sandbox_subpath` is now `format!("{axis}_index.zarr")`
    # (`dataset::process::build_integrate_inputs`), so a live run stages
    # `cells_index.zarr`. It read `…_index.json` until 2026-07-29 — a Zarr store DIRECTORY
    # wearing a single-file JSON name — and BOTH spellings stay listed here on purpose:
    # the `.json` ones are what let that rename land without a flag day, and dropping
    # them the moment production moved is precisely how the ITEM-26 break happened (a
    # writer moved, its reader pinned the old spelling). The extension was never the
    # format and is not the format now; `load_axis_index` decides by reading the store.
    # `resolve_slot` additionally drops the sandbox's own derived `inputs.json`/
    # `params.json`, which a bare `*.json` used to be able to return.
    axis_path = resolve_slot(
        slots, inputs_dir,
        prefer=("axis_index", "index", "axis"),
        patterns=("*_index.zarr", "*index*.zarr", "*_index.json", "*index*.json"),
    )
    if table_path is None or axis_path is None:
        print(
            "annotation_integrate: need both an `annotation_table` file and an "
            f"`axis_index` artifact under /inputs (got table={table_path}, axis={axis_path})",
            file=sys.stderr,
        )
        sys.exit(2)

    # ── read the axis index + the annotation table ──────────────────────────────
    milestone("read", "started")
    progress("reading", 10, f"read {Path(table_path).name} + {Path(axis_path).name}")
    axis_keys, axis_declared = load_axis_index(axis_path)
    df = load_annotation_table(table_path)
    # Axis NAME: the coordinator's explicit `params.axis` wins (it always sets it); else
    # the axis the ARTIFACT ITSELF declares in `structure.axis`. Both are declarations.
    # What used to be here instead — stripping `_index` off the artifact's label, then
    # falling back to a hardcoded `"cells"` — read a contract out of a name (INV-3: a name
    # is a label) and put a single-cell domain default into a processor whose whole point
    # is that it "never knows which" axis it is folding onto. Neither survives; an axis
    # nobody declared is an error, not an assumed one.
    axis_name = p.get("axis") or axis_declared
    if not axis_name:
        print("annotation_integrate: no target axis — neither `params.axis` nor the "
              "axis-index artifact's own `structure.axis` declares one",
              file=sys.stderr)
        sys.exit(2)
    milestone("read", "done", {"axis": axis_name, "axis_entities": len(axis_keys),
                               "table_rows": int(df.shape[0]), "table_columns": list(map(str, df.columns))})

    # ── detect the join key (unless the coordinator supplied one) ───────────────
    #   An explicit per-axis `normalize` list (params / manifest-forwarded) wins;
    #   otherwise the AXIS-AWARE default (never barcode_suffix on a genes axis).
    normalize = p.get("normalize") or default_normalize_for_axis(axis_name)
    key_column = p.get("key_column")
    milestone("detect-key", "started")
    if key_column is None:
        survey = survey_key_columns(df, axis_keys, normalize)
        key_column, matched = best_key_column(survey)
        if key_column is None:
            # NOT a degraded success. With no column aligning to a single axis entity
            # there is no join key, so there is nothing to join on — emitting one all-NA
            # `metadata-column` per table column and exiting 0 would hand the user a green
            # "Integrated" tag over columns that are permanently empty AND permanently
            # part of the dataset. Fail the job: a non-zero exit is the one signal the
            # completion hook, the derived per-file status and the panel all already
            # render loudly.
            detail = describe_key_detection_failure(
                df, axis_keys, axis_name, normalize, survey=survey)
            milestone("detect-key", "failed", {
                "axis": axis_name, "axis_entities": len(axis_keys),
                "normalize": list(normalize),
                "candidates": [{"column": str(e["column"]), "matched": e["matched"],
                                "skipped": e["skipped"]} for e in survey],
                "error": detail,
            })
            print(f"annotation_integrate: {detail}", file=sys.stderr)
            sys.exit(1)
        milestone("detect-key", "done", {"key_column": str(key_column), "matched": matched})
    else:
        milestone("detect-key", "done", {"key_column": str(key_column), "source": "params"})

    # ── align (shared engine; DEC-2 hard-fails on a duplicate key) ──────────────
    milestone("align", "started")
    progress("aligning", 55, f"key={key_column} → axis {axis_name}")
    result = integrate(axis_keys, df, axis_name, key_column=key_column, normalize=normalize)
    cov = result["coverage"]
    degraded = result.get("degraded", False)
    milestone("align", "done", {
        "key_column": str(result["key_column"]), "axis": axis_name,
        "matched": cov["matched"], "missing": cov["missing"], "extra": cov["extra"],
        "matched_before_normalize": cov["matched_before_normalize"],
        "columns": len(result["columns"]), "warnings": result["warnings"],
        "degraded": degraded, "status": "degraded" if degraded else "ok",
    })

    # ── emit one axis-tagged metadata-column per aligned annotation column ───────
    milestone("emit", "started")
    progress("emitting", 80, f"{len(result['columns'])} aligned columns")
    entries = []
    for col in result["columns"]:
        name = col["name"]
        rel = f"annotation/{sanitize_col_name(name)}.zarr"
        # ITEM-26: the aligned column is written as Zarr rather than a JSON `values`
        # array. `col["summary"]` (the colsummary descriptor the UI reads for a legend
        # / colormap range) stays the entry's `meta`, merged with what the writer
        # observed about how the bytes were actually stored.
        structure, stored = txr_columns.write_metadata_column(
            outputs_dir, rel, str(name), pd.Series(col["values"]), axis=axis_name)
        meta = dict(col["summary"])
        meta["stored"] = stored
        entries.append(
            output_entry(
                f"metadata-column:{sanitize_col_name(name)}", "metadata-column", "chunked-1d",
                rel, "artifact", label=str(name), axis=axis_name, meta=meta,
                structure=structure,
            )
        )

    # A dedicated HIDDEN `integration_summary` output the backend completion hook
    # (DatasetIntegrationSink) reads into `dataset_files.integration_summary` for the
    # Supporting-files panel's coverage transparency (ITEM-11/21). Hidden + role
    # `intermediate`: it is a per-file status blob, not a first-class artifact. Rides
    # the opaque `data` root (like h5ad_import's `dataset-metadata`) so ingest accepts
    # it on any host.
    integration_summary = {
        "matched": cov["matched"],
        "missing": cov["missing"],
        "extra": cov["extra"],
        "total": len(axis_keys),
        "matched_before_normalize": cov["matched_before_normalize"],
        "columns": len(result["columns"]),
        "axis": axis_name,
        "key_column": str(result["key_column"]),
        "degraded": degraded,
        "status": "degraded" if degraded else "integrated",
        "warnings": result["warnings"],
    }
    summ_rel = "integration_summary.json"
    (outputs_dir / summ_rel).write_text(json.dumps(integration_summary))
    entries.append(
        output_entry(
            # Concrete opaque leaf (`data/opaque`), NOT the abstract `data` root —
            # workstore ingest rejects an artifact declared directly of an abstract
            # datatype, which would fail the whole integrate job on an otherwise
            # successful alignment.
            "integration_summary", "data/opaque", "opaque", summ_rel, "intermediate",
            meta=integration_summary, hidden=True,
            structure=txr_columns.opaque("application/json"),
        )
    )

    write_manifest(outputs_dir, entries)
    milestone("emit", "done", {"outputs": len(entries),
                               "degraded": degraded, "status": "degraded" if degraded else "ok",
                               "coverage": {"matched": cov["matched"], "missing": cov["missing"],
                                            "extra": cov["extra"]}})
    status_note = " [DEGRADED: 0 matches, all-NA]" if degraded else ""
    progress("done", 100, f"{len(entries)} aligned metadata-columns "
                          f"(matched {cov['matched']}/{len(axis_keys)}){status_note}")
    print(
        f"annotation_integrate: axis={axis_name} key={result['key_column']} "
        f"→ {len(entries)} columns, coverage matched={cov['matched']} "
        f"missing={cov['missing']} extra={cov['extra']}"
        f"{' — DEGRADED (0 matches; every column all-NA — NOT a clean success)' if degraded else ''}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except BaseException as e:  # noqa: BLE001 — surface a clear job failure
        cur = _CURRENT_MILESTONE[0]
        if cur is not None:
            milestone(cur, "failed", {"error": str(e)})
        print(f"annotation_integrate: FAILED: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
        sys.exit(1)
