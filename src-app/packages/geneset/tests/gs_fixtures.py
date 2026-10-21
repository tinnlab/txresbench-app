# ruff: noqa
"""Subprocess harness for the geneset.collection.freeze producer — drives the REAL compute
script exactly as the sandbox runner would (CYTO_INPUTS_DIR/CYTO_OUTPUTS_DIR seam, `_lib` +
the package's compute dir on PYTHONPATH), so spawn -> read params -> write /outputs runs for real.
"""
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

_PROCESSORS = Path(__file__).resolve().parents[2]  # src-app/packages
_LIB = _PROCESSORS / "_lib"
_COMPUTE = _PROCESSORS / "geneset" / "compute"
_SCRIPT = _COMPUTE / "freeze.py"


def run_freeze(tmp_path, data):
    """Write `data` as /inputs/params.json (the opaque draft body) and run the freeze producer.
    Returns (outputs_dir, manifest_dict). Asserts a clean exit."""
    inp = Path(tmp_path) / "inputs"
    out = Path(tmp_path) / "outputs"
    inp.mkdir(parents=True, exist_ok=True)
    out.mkdir(parents=True, exist_ok=True)
    (inp / "params.json").write_text(json.dumps(data))
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join(
        [str(_COMPUTE), str(_LIB), *([env["PYTHONPATH"]] if env.get("PYTHONPATH") else [])]
    )
    env["CYTO_INPUTS_DIR"] = str(inp)
    env["CYTO_OUTPUTS_DIR"] = str(out)
    env.pop("CYTO_PROGRESS_FIFO", None)
    proc = subprocess.run([sys.executable, str(_SCRIPT)], env=env, capture_output=True, text=True)
    assert proc.returncode == 0, f"freeze producer failed ({proc.returncode}): {proc.stderr}"
    manifest = json.loads((out / "manifest.json").read_text())
    return out, manifest


def collection_entry(manifest):
    """The single geneset/collection manifest entry.

    #80: every run ALSO emits a hidden `run-environment` record — the resolved version of
    each library this package declares, which the server lifts into the run's provenance
    row. It is a provenance carrier, not a produced artifact, so it is excluded here; the
    "exactly one PRODUCED artifact" claim is unchanged and still asserted.
    """
    outs = [o for o in manifest["outputs"] if o["id"] != "run-environment"]
    assert len(outs) == 1, f"increment-1 emits ONE artifact, got {len(outs)}"
    return outs[0]


def structure_of(outputs_dir, entry):
    """The producer-declared `structure` (attributes.cyto) stamped on the membership store."""
    zj = json.loads((Path(outputs_dir) / entry["path"] / "zarr.json").read_text())
    return zj["attributes"]["cyto"]


def dir_digest(root):
    """A stable digest over every file's (relpath, bytes) under `root` — the byte-identity oracle
    for determinism (INV-1)."""
    root = Path(root)
    h = hashlib.sha256()
    for p in sorted(root.rglob("*")):
        if p.is_file():
            h.update(str(p.relative_to(root)).encode())
            h.update(b"\0")
            h.update(p.read_bytes())
            h.update(b"\0")
    return h.hexdigest()
