#!/usr/bin/env python3
# ruff: noqa
"""Off-sandbox run harness for the `embedding` computes (ITEM-28).

Drives the REAL `compute/reduce.py` / `compute/visualize.py` as a SUBPROCESS through the
only seam that runs them outside bwrap (`CYTO_INPUTS_DIR` / `CYTO_OUTPUTS_DIR`), with
`_lib` on `PYTHONPATH` exactly as the sandbox stages `/code`. Every input is declared in
`/inputs/inputs.json` (the `render_inputs_json` wire shape) with a MEANINGLESS `in0`/`in1`
mount name, so a compute that resolves by filename suffix cannot pass (mirrors
`qc/tests/qc_fixtures.py`).

Helpers live HERE (not in `conftest.py`) so `from embedding_fixtures import …` never
collides with the rootdir `packages/conftest.py`.
"""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

np = pytest.importorskip("numpy")
sp = pytest.importorskip("scipy.sparse")

_HERE = Path(__file__).resolve().parent
_PKG = _HERE.parent
_PROCESSORS = _PKG.parent
_LIB_DIR = _PROCESSORS / "_lib"
_HELPERS_DIR = _PROCESSORS / "_helpers"
_COMPUTE = _PKG / "compute"

REDUCE = _COMPUTE / "reduce.py"
VISUALIZE = _COMPUTE / "visualize.py"


def import_own(name):
    """This package's `compute/<name>.py`, under a name no sibling package can collide with.

    Mirrors `differential-abundance/tests/da_modules.py::import_own` (#237) exactly: several
    packages ship a `compute/_shared.py` / `compute/_criteria.py`, and a bare `import _shared`
    in a shared pytest session resolves through the flat `sys.modules` namespace to whichever
    package's copy won the sys.path race. Loading under the namespaced key `embedding_own_<name>`
    makes the resolution unambiguous. Deliberately does NOT fall back to the flat `import
    <name>` on failure, because a silent fallback would restore exactly the cross-package
    ambiguity this helper exists to remove.
    """
    unique = f"embedding_own_{name}"
    if unique in sys.modules:
        return sys.modules[unique]
    path = _COMPUTE / f"{name}.py"
    if not path.is_file():
        raise ModuleNotFoundError(
            f"embedding ships no compute/{name}.py — this helper deliberately does "
            f"NOT fall back to the flat `import {name}`, because a silent fallback would restore "
            "exactly the cross-package ambiguity it exists to remove")
    spec = importlib.util.spec_from_file_location(unique, path)
    module = importlib.util.module_from_spec(spec)
    # Registered BEFORE exec so a self-referential import inside the module resolves to itself.
    sys.modules[unique] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(unique, None)
        raise
    return module


sys.path.insert(0, str(_LIB_DIR))
import cyto_columns  # noqa: E402
import cyto_csc  # noqa: E402
import cyto_zarr_read  # noqa: E402


# ── the env-rootfs SEAM (ITEM-20a / DEC-14) ─────────────────────────────────────────
# The off-sandbox harness runs the compute under the HOST interpreter — which carries the
# scientific stack but NOT `harmonypy` (that ships only in the republished rootfs). To run
# the REAL Harmony path (TEST-33), a run can execute INSIDE the env-rootfs squashfs via
# bwrap, exactly as the production sandbox does (mirrors `scripts/e2e-processors-preflight`
# check 7 + `modules/sandbox/sandbox.rs build_bwrap_argv`): /usr + /opt bound RO from the
# mounted image, a staged /code, --clearenv, the venv python on PATH. The image is provided
# by `CYTO_ENV_ROOTFS_SQUASHFS` (the documented air-gap seam).
SEAM_SQUASHFS = os.environ.get("CYTO_ENV_ROOTFS_SQUASHFS")


def seam_available() -> bool:
    """True when the harmonypy seam can actually run: the squashfs exists and bwrap +
    squashfuse are on PATH. TEST-33 gates on this — set `CYTO_ENV_ROOTFS_SQUASHFS` to a
    rebuilt single-cell rootfs (with harmonypy + scikit-misc) to run it for real."""
    if not SEAM_SQUASHFS or not Path(SEAM_SQUASHFS).is_file():
        return False
    if shutil.which("bwrap") is None:
        return False
    return shutil.which("squashfuse") is not None or shutil.which("squashfuse3") is not None


# ── staging helpers ────────────────────────────────────────────────────────────────
def write_csc_store(dest: Path, dense) -> dict:
    """A `single-cell/expression` artifact: the CSC Zarr store the importer emits."""
    mat = dense if sp.issparse(dense) else sp.csr_matrix(np.asarray(dense, dtype=np.float32))
    mat = mat.tocsr()
    mat.eliminate_zeros()
    return cyto_csc.write_csc_zarr(cyto_csc.ArraySource(mat), dest, axes=("cells", "genes"))


def write_column_store(dest: Path, name: str, values, *, axis: str, holds_axis_keys=False):
    import pandas as pd
    return cyto_columns.write_metadata_column(
        dest.parent, dest.name, name, pd.Series(list(values)), axis=axis,
        holds_axis_keys=holds_axis_keys)


def write_embedding_store(dest: Path, arr, *, name="X_pca", method="pca") -> dict:
    return cyto_columns.write_embedding(
        dest.parent, dest.name, np.asarray(arr, dtype=np.float32),
        axis="cells", name=name, kind="embedding", method=method)


class _Run:
    def __init__(self, base: Path, script: Path):
        self.base = base
        self.script = script
        self.inputs_dir = base / "inputs"
        self.outputs_dir = base / "outputs"
        self.inputs_dir.mkdir(parents=True, exist_ok=True)
        self.outputs_dir.mkdir(parents=True, exist_ok=True)
        self._entries: list[dict] = []
        self._n = 0

    def _mount(self, mount):
        if mount is not None:
            return mount
        name = f"in{self._n}"
        self._n += 1
        return name

    def _declare(self, slot, mount):
        self._entries.append({"slot": slot, "kind": "artifact-prefix",
                              "content_hash": f"sha256:{'0' * 64}",
                              "sandbox_path": f"/inputs/{mount}"})

    def add_matrix(self, dense, *, slot="matrices", mount=None) -> Path:
        mount = self._mount(mount)
        dest = self.inputs_dir / mount
        write_csc_store(dest, dense)
        self._declare(slot, mount)
        return dest

    def add_column(self, values, *, slot, axis="cells", name="values",
                   holds_axis_keys=False, mount=None) -> Path:
        mount = self._mount(mount)
        dest = self.inputs_dir / mount
        write_column_store(dest, name, values, axis=axis, holds_axis_keys=holds_axis_keys)
        self._declare(slot, mount)
        return dest

    def add_embedding(self, arr, *, slot="embedding", name="X_pca", method="pca",
                      mount=None) -> Path:
        mount = self._mount(mount)
        dest = self.inputs_dir / mount
        write_embedding_store(dest, arr, name=name, method=method)
        self._declare(slot, mount)
        return dest

    def add_existing_store(self, store_path, *, slot, mount=None) -> Path:
        """Mount an ALREADY-WRITTEN cyto_zarr store (e.g. a prior run's OUTPUT embedding) as an
        input, copying its whole group dir so its `attributes.cyto` (incl. the F2 correction
        stamp) rides along. Used to chain reduce→visualize for the provenance-hop test (TEST-30)
        and the producer→consumer e2e (TEST-32)."""
        mount = self._mount(mount)
        dest = self.inputs_dir / mount
        shutil.copytree(Path(store_path), dest)
        self._declare(slot, mount)
        return dest

    def _write_wire(self, params=None):
        (self.inputs_dir / "inputs.json").write_text(
            json.dumps({"inputs": self._entries}, indent=2))
        body = dict(params or {})
        body.setdefault("seed", 0)
        (self.inputs_dir / "params.json").write_text(json.dumps(body, indent=2))

    def run(self, params=None, *, env_extra=None, seam=False):
        """Run the REAL entry script. `seam=True` runs it INSIDE the env-rootfs squashfs
        via bwrap (the only way to reach `harmonypy`, ITEM-20a); default runs it off-sandbox
        under the host interpreter (the shipped harness path)."""
        self._write_wire(params)
        if seam:
            return self._run_in_seam(env_extra=env_extra)
        env = dict(os.environ)
        env["PYTHONPATH"] = os.pathsep.join(
            [str(_HELPERS_DIR), str(_LIB_DIR),
             *([env["PYTHONPATH"]] if env.get("PYTHONPATH") else [])])
        env["CYTO_INPUTS_DIR"] = str(self.inputs_dir)
        env["CYTO_OUTPUTS_DIR"] = str(self.outputs_dir)
        env.pop("CYTO_PROGRESS_FIFO", None)
        for k, v in (env_extra or {}).items():
            if v is None:
                env.pop(str(k), None)  # UNSET (absent), not empty-string
            else:
                env[str(k)] = str(v)
        return subprocess.run([sys.executable, str(self.script)], env=env,
                              capture_output=True, text=True)

    # ── seam (in-sandbox) execution ─────────────────────────────────────────────────
    def _stage_code(self, code_dir: Path):
        """Flatten the entry + shared substrate + `_lib`/`_helpers` into ONE /code dir,
        exactly as the sandbox runner stages a job (so `import _shared`/`import cyto_columns`
        resolve off `sys.path[0]`). Only non-test modules are staged."""
        code_dir.mkdir(parents=True, exist_ok=True)
        for src in (_COMPUTE.glob("*.py")):
            shutil.copy2(src, code_dir / src.name)
        for base in (_LIB_DIR, _HELPERS_DIR):
            for src in base.glob("*.py"):
                if src.name.startswith("test_") or src.name == "conftest.py":
                    continue
                shutil.copy2(src, code_dir / src.name)

    def _run_in_seam(self, *, env_extra=None):
        if not seam_available():
            raise RuntimeError(
                "seam run requested but CYTO_ENV_ROOTFS_SQUASHFS / bwrap / squashfuse are "
                "not available")
        squashfuse = shutil.which("squashfuse") or shutil.which("squashfuse3")
        fusermount = shutil.which("fusermount") or shutil.which("fusermount3")
        work = Path(tempfile.mkdtemp(prefix="emb-seam-", dir=str(self.base)))
        mnt = work / "root"
        code_dir = work / "code"
        mnt.mkdir(parents=True, exist_ok=True)
        self._stage_code(code_dir)
        pw = work / "passwd"
        gr = work / "group"
        pw.write_text("analyst:x:1001:1001::/home/analyst:/bin/sh\n")
        gr.write_text("analyst:x:1001:\n")
        mounted = False
        try:
            mp = subprocess.run([squashfuse, str(SEAM_SQUASHFS), str(mnt)],
                                capture_output=True, text=True)
            if mp.returncode != 0:
                raise RuntimeError(f"squashfuse mount failed: {mp.stderr}")
            mounted = True
            # bwrap argv mirrors sandbox.rs build_bwrap_argv + the preflight canary, plus
            # the /code, /inputs, /outputs binds this harness needs.
            argv = [
                "bwrap", "--clearenv", "--unshare-user", "--uid", "1001", "--gid", "1001",
                "--unshare-uts", "--unshare-ipc", "--unshare-net", "--new-session",
                "--die-with-parent",
                "--ro-bind", str(mnt / "usr"), "/usr",
                "--ro-bind-try", str(mnt / "opt"), "/opt",
                "--ro-bind", str(pw), "/etc/passwd",
                "--ro-bind", str(gr), "/etc/group",
                "--symlink", "usr/bin", "/bin", "--symlink", "usr/sbin", "/sbin",
                "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
                "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
                "--ro-bind", str(code_dir), "/code",
                "--bind", str(self.inputs_dir), "/inputs",
                "--bind", str(self.outputs_dir), "/outputs",
                "--bind", str(work), "/home/analyst", "--chdir", "/home/analyst",
                "--setenv", "HOME", "/home/analyst", "--setenv", "USER", "analyst",
                "--setenv", "PATH", "/opt/venv/bin:/usr/local/bin:/usr/bin:/bin",
                "--setenv", "LANG", "C.UTF-8",
                "--setenv", "PYTHONPATH", "/code",
                "--setenv", "CYTO_INPUTS_DIR", "/inputs",
                "--setenv", "CYTO_OUTPUTS_DIR", "/outputs",
            ]
            for k, v in (env_extra or {}).items():
                if v is None:
                    continue  # cannot be present after --clearenv anyway
                argv += ["--setenv", str(k), str(v)]
            argv += ["python", f"/code/{self.script.name}"]
            return subprocess.run(argv, capture_output=True, text=True)
        finally:
            if mounted and fusermount:
                subprocess.run([fusermount, "-u", str(mnt)],
                               capture_output=True, text=True)

    def run_ok(self, params=None, *, env_extra=None, seam=False):
        proc = self.run(params, env_extra=env_extra, seam=seam)
        assert proc.returncode == 0, (
            f"{self.script.name} exited {proc.returncode}\n"
            f"--- stdout ---\n{proc.stdout}\n--- stderr ---\n{proc.stderr}")
        return proc

    def diagnostics(self, proc) -> str:
        prefix = "embedding.reduce:" if self.script == REDUCE else "embedding.visualize:"
        return "\n".join(l for l in proc.stderr.splitlines() if l.startswith(prefix))

    # ── read-back ──────────────────────────────────────────────────────────────────
    def manifest(self) -> dict:
        return json.loads((self.outputs_dir / "manifest.json").read_text())

    def report(self) -> dict:
        return json.loads((self.outputs_dir / "embedding-report.json").read_text())

    def embedding_entry(self) -> dict:
        return next(e for e in self.manifest()["outputs"] if e["datatype"] == "embedding")

    def embedding_array(self) -> "np.ndarray":
        entry = self.embedding_entry()
        root = self.outputs_dir / entry["path"]
        member = entry["meta"]["name"]
        return np.asarray(cyto_zarr_read.read_array(root, member))

    def progress_phases(self, proc) -> list[str]:
        return [l.split(":", 1)[1].strip().split("|")[0]
                for l in proc.stderr.splitlines() if l.startswith("progress:")]


class ReduceRun(_Run):
    def __init__(self, base: Path):
        super().__init__(base, REDUCE)


class VisualizeRun(_Run):
    def __init__(self, base: Path):
        super().__init__(base, VISUALIZE)


# ── synthetic data ─────────────────────────────────────────────────────────────────
def counts_matrix(n_cells: int, n_genes: int, seed: int = 0):
    """A deterministic dense RAW-COUNT matrix (integer-valued), no all-zero cell."""
    rng = np.random.default_rng(seed)
    dense = rng.integers(0, 12, size=(n_cells, n_genes)).astype(np.float32)
    dense[:, 0] = rng.integers(1, 9, size=n_cells)
    return dense


def large_counts_matrix(n_cells: int, n_genes: int, seed: int = 0):
    """Large integer counts where a float32 sum-of-squares CANCELS (INV-10 fixture).

    Values sit at ~1e6 with only a small within-gene spread, so `E[x²]≈E[x]²≈1e12` and a
    float32 `Σx²` loses the small true variance to rounding while float64 keeps it. This
    exercises the ACCUMULATOR directly (it is NOT fed to seurat_v3's loess, which a
    near-constant column is singular for).
    """
    rng = np.random.default_rng(seed)
    return rng.integers(1_000_000, 1_000_040, size=(n_cells, n_genes)).astype(np.float64)
