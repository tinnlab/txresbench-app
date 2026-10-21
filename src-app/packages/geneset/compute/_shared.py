#!/usr/bin/env python3
# ruff: noqa
"""_shared — the generic compute substrate for the geneset producers (mirrors the DE / clustering
`_shared`, trimmed to the io + manifest + determinism helpers a membership writer needs).

The determinism environment is pinned at the very TOP of this module, BEFORE the first
`import numpy`, so a consumer that imports `_shared` first has the numeric stack single-threaded
and machine-identity-fixed — the property INV-1 (identical draft data -> identical bytes ->
stable content-hash) rests on.
"""
import os

# ── pin the determinism environment before numpy loads ─────────────────────────────
THREAD_ENV_VARS = (
    "OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
    "NUMEXPR_NUM_THREADS", "VECLIB_MAXIMUM_THREADS", "NUMBA_NUM_THREADS",
)
for _v in THREAD_ENV_VARS:
    os.environ.setdefault(_v, "1")
os.environ.setdefault("NUMBA_CPU_NAME", "generic")

import cyto_deps
import json
import sys
from pathlib import Path

_PREFIX = ["geneset"]


def set_prefix(prefix):
    """Set the diagnostic prefix so a caller and the test harness can tell OUR named refusal
    from a library traceback."""
    _PREFIX[0] = str(prefix)


def fail(message, code=2):
    print(f"{_PREFIX[0]}: {message}", file=sys.stderr, flush=True)
    sys.exit(code)


def io_dirs():
    inp = Path(os.environ.get("CYTO_INPUTS_DIR", "/inputs"))
    out = Path(os.environ.get("CYTO_OUTPUTS_DIR", "/outputs"))
    out.mkdir(parents=True, exist_ok=True)
    return inp, out


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except (FileNotFoundError, ValueError):
        return {} if default is None else default


def params(inputs_dir):
    return read_json(inputs_dir / "params.json", {})


_PROGRESS_FD = [-1]


def progress(phase, pct=None, message=None):
    parts = [str(phase)]
    if pct is not None:
        parts.append(str(int(pct)))
    if message is not None:
        if pct is None:
            parts.append("")
        parts.append(str(message))
    line = "|".join(parts)
    fifo = os.environ.get("CYTO_PROGRESS_FIFO")
    if fifo:
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
    print("progress:", line, file=sys.stderr, flush=True)


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
    # The datatype is THIS package's, passed in: `cyto_deps` is app-core and may not
    # name a contributed domain's vocabulary, so the caller supplies the pair.
    cyto_deps.augment(outputs_dir, entries, DT_RUN_ENVIRONMENT)
    (outputs_dir / "manifest.json").write_text(json.dumps({"outputs": entries}, indent=2))


def output_entry(id, datatype_layout, path, role, *, structure, meta=None):
    dt, layout = datatype_layout
    return {"id": id, "datatype": dt, "path": path, "layout": layout, "role": role,
            "structure": structure, "meta": meta}
