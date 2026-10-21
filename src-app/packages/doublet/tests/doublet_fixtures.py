#!/usr/bin/env python3
# ruff: noqa
"""Off-sandbox run harness for the `doublet` compute.

Drives the REAL `compute/doublet.py` as a SUBPROCESS through the only seam that runs it
outside bwrap (`CYTO_INPUTS_DIR` / `CYTO_OUTPUTS_DIR`), with `_lib` + `_helpers` on
`PYTHONPATH` exactly as the sandbox stages `/code`. Every input is declared in
`/inputs/inputs.json` (the `render_inputs_json` wire shape) with a MEANINGLESS `in0`/`in1`
mount name, so a compute that resolves by filename suffix cannot pass. Mirrors
`embedding/tests/embedding_fixtures.py` and `qc/tests/qc_fixtures.py`.

Helpers live HERE (not in `conftest.py`) so `from doublet_fixtures import ...` never
collides with the rootdir `packages/conftest.py`.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

np = pytest.importorskip("numpy")
sp = pytest.importorskip("scipy.sparse")

_HERE = Path(__file__).resolve().parent
_PKG = _HERE.parent
_PROCESSORS = _PKG.parent
_SRC_APP = _PROCESSORS.parent
_LIB_DIR = _PROCESSORS / "_lib"
_HELPERS_DIR = _PROCESSORS / "_helpers"
_COMPUTE = _PKG / "compute"

DETECT = _COMPUTE / "doublet.py"

sys.path.insert(0, str(_LIB_DIR))
import cyto_columns  # noqa: E402
import cyto_csc  # noqa: E402
import cyto_zarr_read  # noqa: E402


# ── the staged raw fixture (see `stage_fixtures.py`) ───────────────────────────────
#: `.cyto-cache/fixtures/` is the repo's documented, gitignored fixture-staging convention.
#: `pbmc68k_reduced.h5ad`, the fixture already in the tree, is normalized AND scaled and is
#: therefore INVALID for a raw-count method — this package needs raw UMIs.
FIXTURE_NAME = "pbmc3k_raw.h5ad"
STAGE_CMD = "python3 src-app/packages/doublet/tests/stage_fixtures.py"


def repo_root() -> Path:
    return _SRC_APP.parent


def fixture_path() -> Path:
    override = os.environ.get("CYTO_E2E_FIXTURES")
    base = Path(override) if override else (repo_root() / ".cyto-cache" / "fixtures")
    return base / FIXTURE_NAME


def require_fixture() -> Path:
    """The staged raw fixture, or a NAMED stop.

    Absent + `CYTO_REQUIRE_FIXTURES=1` -> a hard FAILURE (the science tier's own setting:
    a skip there is not a pass). Absent otherwise -> a skip whose message is the exact
    command that fixes it, never a bare "skipped" that reads as green.
    """
    path = fixture_path()
    if path.is_file():
        return path
    msg = (
        f"the raw-count fixture {path} is not staged. Run:\n    {STAGE_CMD}\n"
        "(it downloads `sc.datasets.pbmc3k()` + `pbmc3k_processed()` once and writes the "
        "raw counts with their published cell-type labels). Note pbmc68k_reduced.h5ad, the "
        "fixture already in the tree, is normalized+scaled and is NOT valid for a raw-count "
        "method."
    )
    if os.environ.get("CYTO_REQUIRE_FIXTURES") == "1":
        pytest.fail(msg)
    pytest.skip(msg)


def skimage_available() -> bool:
    try:
        import skimage.filters  # noqa: F401
        return True
    except Exception:
        return False


def require_skimage():
    """Scrublet's AUTOMATIC threshold is `skimage.filters.threshold_minimum`. The env rootfs
    ships skimage (its build-time smoke-import line names it) but a bare host may not; a run
    with an explicit `threshold` needs no backend at all."""
    if not skimage_available():
        pytest.skip(
            "the automatic doublet threshold needs `scikit-image` "
            "(`skimage.filters.threshold_minimum`), which the single-cell env rootfs ships "
            "but this host does not. Install it (`python3 -m pip install --user "
            "scikit-image`) to run the automatic-threshold tests, or drive the compute with "
            "an explicit `threshold` parameter."
        )


# ── staging helpers ────────────────────────────────────────────────────────────────
def write_csc_store(dest: Path, dense) -> dict:
    """A `single-cell/expression` artifact: the CSC Zarr store the importer emits."""
    mat = dense if sp.issparse(dense) else sp.csr_matrix(np.asarray(dense, dtype=np.float32))
    mat = mat.tocsr()
    mat.eliminate_zeros()
    return cyto_csc.write_csc_zarr(cyto_csc.ArraySource(mat), dest, axes=("cells", "genes"))


def write_column_store(dest: Path, name: str, values, *, axis: str, holds_axis_keys=False):
    """Stage one `metadata-column` artifact.

    A pandas `Categorical` (or an already-built Series) is passed THROUGH rather than
    flattened with `list(...)`, because the writer dispatches on dtype and the two branches
    behave differently in exactly the way this package cares about: the string branch writes
    a missing value as `""`, while the CATEGORICAL branch invents a declared level and stamps
    its name. `list(pd.Categorical([...]))` silently drops to object dtype, so a test meaning
    to drive the categorical encoding would quietly drive the string one — which is how a
    guard that missed every real categorical case still looked covered.
    """
    import pandas as pd

    if isinstance(values, pd.Series):
        series = values
    elif isinstance(values, pd.Categorical):
        series = pd.Series(values)
    else:
        series = pd.Series(list(values))
    return cyto_columns.write_metadata_column(
        dest.parent, dest.name, name, series, axis=axis, holds_axis_keys=holds_axis_keys)


class DetectRun:
    """One `doublet.detect` run: stage inputs, run the REAL entry, read the outputs back."""

    def __init__(self, base: Path):
        self.base = base
        self.script = DETECT
        self.inputs_dir = base / "inputs"
        self.outputs_dir = base / "outputs"
        self.inputs_dir.mkdir(parents=True, exist_ok=True)
        self.outputs_dir.mkdir(parents=True, exist_ok=True)
        self._entries: list[dict] = []
        self._n = 0

    # ── inputs ─────────────────────────────────────────────────────────────────────
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

    def add_matrix(self, dense, *, slot="matrix", mount=None) -> Path:
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

    def add_cells_index(self, keys, **kw) -> Path:
        return self.add_column([str(k) for k in keys], slot="cells_index",
                               name="cell_id", holds_axis_keys=True, **kw)

    # ── run ────────────────────────────────────────────────────────────────────────
    def _write_wire(self, params=None):
        (self.inputs_dir / "inputs.json").write_text(
            json.dumps({"inputs": self._entries}, indent=2))
        body = dict(params or {})
        body.setdefault("seed", 0)
        (self.inputs_dir / "params.json").write_text(json.dumps(body, indent=2))

    def run(self, params=None, *, env_extra=None):
        self._write_wire(params)
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

    def run_ok(self, params=None, *, env_extra=None):
        proc = self.run(params, env_extra=env_extra)
        assert proc.returncode == 0, (
            f"{self.script.name} exited {proc.returncode}\n"
            f"--- stdout ---\n{proc.stdout}\n--- stderr ---\n{proc.stderr}")
        return proc

    def diagnostics(self, proc) -> str:
        return "\n".join(l for l in proc.stderr.splitlines()
                         if l.startswith("doublet.detect:"))

    def progress_phases(self, proc) -> list[str]:
        return [l.split(":", 1)[1].strip().split("|")[0]
                for l in proc.stderr.splitlines() if l.startswith("progress:")]

    # ── read-back ──────────────────────────────────────────────────────────────────
    def manifest(self) -> dict:
        return json.loads((self.outputs_dir / "manifest.json").read_text())

    def report(self) -> dict:
        return json.loads((self.outputs_dir / "doublet-report.json").read_text())

    def entries(self) -> list[dict]:
        return self.manifest()["outputs"]

    def entry(self, suffix: str):
        """The manifest entry whose id ends with `suffix`, or None (an ABSENT artifact is a
        real state this package produces deliberately)."""
        for e in self.entries():
            if e["id"].endswith(suffix):
                return e
        return None

    def column(self, suffix: str):
        entry = self.entry(suffix)
        assert entry is not None, f"no output entry ending {suffix!r} in {[e['id'] for e in self.entries()]}"
        root = self.outputs_dir / entry["path"]
        return cyto_zarr_read.read_column(root, "values")

    def scores(self, label="doublet"):
        return np.asarray(self.column(f"{label}_score"), dtype=np.float64)

    def calls(self, label="doublet"):
        vals = self.column(f"{label}_call")
        return [str(v) for v in (vals.tolist() if hasattr(vals, "tolist") else list(vals))]


# ── synthetic data ─────────────────────────────────────────────────────────────────
def counts_matrix(n_cells: int, n_genes: int, seed: int = 0):
    """A deterministic dense RAW-COUNT matrix (integer-valued), no all-zero cell."""
    rng = np.random.default_rng(seed)
    dense = rng.integers(0, 12, size=(n_cells, n_genes)).astype(np.float32)
    dense[:, 0] = rng.integers(1, 9, size=n_cells)
    return dense


def structured_counts(n_per_group: int, n_genes: int, n_groups: int = 3, seed: int = 0):
    """Raw counts with `n_groups` genuinely distinct populations, so Scrublet's simulated
    doublets sit BETWEEN the modes and the automatic threshold is findable. A uniform-noise
    matrix has a unimodal simulated-score histogram by construction, which is the DEGENERATE
    input the absence-is-absence test wants, not the ordinary one."""
    rng = np.random.default_rng(seed)
    block = n_genes // n_groups
    rows = []
    for g in range(n_groups):
        base = rng.integers(0, 2, size=(n_per_group, n_genes)).astype(np.float32)
        lo, hi = g * block, (g + 1) * block if g + 1 < n_groups else n_genes
        base[:, lo:hi] += rng.integers(8, 40, size=(n_per_group, hi - lo))
        rows.append(base)
    return np.vstack(rows)


def counts_with_doublets(n_per_group: int = 40, n_genes: int = 90, n_groups: int = 3,
                         n_doublets: int = 12, seed: int = 0):
    """`(counts, n_real)` — a structured matrix with genuine HETEROTYPIC doublets appended.

    `structured_counts` alone is clean enough that a run over it often calls NOTHING, which
    makes any test about the CALL column vacuous (a keep-singlets filter over an all-singlet
    column keeps everything, which is indistinguishable from the branch-inference defect it
    is supposed to catch). Appending real cross-group sums guarantees the call column has
    both levels in it, so those tests are exercising something.

    Deterministic: one seeded generator, pairs drawn from DIFFERENT groups.
    """
    base = structured_counts(n_per_group, n_genes, n_groups=n_groups, seed=seed)
    n_real = base.shape[0]
    rng = np.random.default_rng(seed + 977)
    rows = []
    while len(rows) < n_doublets:
        i, j = rng.integers(0, n_real, 2)
        if i // n_per_group == j // n_per_group:
            continue        # same group => homotypic, and near-undetectable by construction
        rows.append(base[i] + base[j])
    return np.vstack([base, np.asarray(rows, dtype=base.dtype)]), n_real


def degenerate_counts(n_per_profile: int = 20, n_genes: int = 40, seed: int = 0):
    """Raw counts whose SIMULATED-doublet score histogram is NOT bimodal, so Scrublet's
    automatic threshold detection fails and there is no honest cut point.

    Two distinct profiles, each repeated exactly: every simulated doublet is one of a handful
    of identical sums, so the simulated score distribution collapses and
    `skimage.filters.threshold_minimum` cannot find two maxima. This is the input the
    absence-is-absence invariant exists for — scanpy's own wrapper responds to it by writing
    `predicted_doublet = False` for every cell, which is a confident answer to a question the
    method could not answer.

    Deliberately NOT uniform noise: measured, a uniform-random count matrix DOES yield a
    findable threshold, so it would exercise the ordinary path while looking degenerate.
    """
    rng = np.random.default_rng(seed)
    p1 = rng.integers(1, 9, size=(1, n_genes)).astype(np.float32)
    p2 = rng.integers(1, 9, size=(1, n_genes)).astype(np.float32)
    return np.vstack([np.tile(p1, (n_per_profile, 1)), np.tile(p2, (n_per_profile, 1))])


def unscoreable_counts(n_cells: int = 40, n_genes: int = 40):
    """Raw counts Scrublet cannot score AT ALL: every cell identical, so its own
    `filter_genes(min_cells=3)` + variance step leaves no feature to embed. The compute must
    turn the library's `ValueError` into a NAMED refusal."""
    row = np.full((1, n_genes), 5.0, dtype=np.float32)
    return np.tile(row, (n_cells, 1))


def read_raw_fixture(subset_cells: int | None = None, subset_genes: int | None = None):
    """The staged raw pbmc3k fixture as `(csr counts, barcodes, gene names, cell types)`.

    Sub-setting is by the FIRST n rows/columns, deterministically, so a test can trade
    fidelity for speed without introducing a random draw.
    """
    import anndata as ad

    adata = ad.read_h5ad(require_fixture())
    if subset_cells is not None:
        adata = adata[:subset_cells]
    if subset_genes is not None:
        adata = adata[:, :subset_genes]
    adata = adata.copy()
    X = sp.csr_matrix(adata.X)
    types = ([str(t) for t in adata.obs["cell_type"]]
             if "cell_type" in adata.obs else ["unassigned"] * adata.n_obs)
    return X, [str(b) for b in adata.obs_names], [str(g) for g in adata.var_names], types


# ── loading the compute module under test ──────────────────────────────────────────
#
# `import doublet` DOES NOT WORK from a test, and did not fail loudly when it stopped
# working. `src-app/packages/pytest.ini` runs the tree with `--import-mode=importlib`
# (#198), under which pytest derives each test module's name from its full path — so
# `doublet/tests/test_doublet.py` is imported as `doublet.tests.test_doublet`, and
# importing it CREATES the parent `doublet` in `sys.modules` as a NAMESPACE PACKAGE
# bound to the package DIRECTORY. A later `sys.path.insert(0, compute); import doublet`
# then returns that cached namespace package instead of `compute/doublet.py`, because a
# name already in `sys.modules` is never re-resolved against `sys.path`.
#
# This package is the ONLY one exposed to it: the collision needs a package directory
# whose name is BOTH a valid Python identifier AND the name of a module inside it.
# `cell-filter` and `import-h5ad` also ship `compute/<dirname>.py` but their hyphens
# cannot form an identifier, so no namespace package is ever created for them; every
# other package names its compute module something other than its directory (trajectory
# ships `dpt.py`/`paga.py`).
#
# The failure mode is what makes it worth a helper rather than four local fixes: the
# namespace package imports FINE and is only missing attributes, so it surfaces as
# `AttributeError: module 'doublet' has no attribute <X>` at the point of USE. Fifteen
# tests failed that way. A test that merely probed for the ABSENCE of an attribute would
# instead have gone quietly, permanently green.
#
# So the module is loaded from its FILE, never by name, and registered under a name that
# cannot collide with the package directory.
_COMPUTE_MODULE_NAME = "doublet_compute"


#: The compute's sibling helpers, imported by it under BARE names (`import _shared as S`,
#: `import _criteria as CR`). Seven packages ship a `_shared.py` and three a `_criteria.py`,
#: all under those same flat names with no `__init__.py` anywhere in this tree — so
#: `sys.modules["_shared"]` binds to whichever package's suite imported it FIRST (#237).
#: Measured: with `clustering/compute` on `sys.path` first, loading this compute in-process
#: binds CLUSTERING's `_shared`, and doublet's has 26 names clustering's does not — the whole
#: peak-memory model (`_peak_bytes`, `_PEAK_BYTES_PER_CELL_PER_SIM`) and
#: `MISSING_VALUE_SENTINELS` among them. That is why a per-package run and a full-tree
#: `just check-py` measure different module graphs.
#:
#: The compute itself is immune in production: every real run is a fresh SUBPROCESS with
#: `/code` as `sys.path[0]`. Only the in-process load below is exposed, and it was exposed
#: identically before this helper existed (the bare `import doublet` pulled the same
#: `import _shared`). This is pre-existing #237, not something introduced here.
_SIBLING_HELPERS = ("_shared", "_criteria")
_UNSET = object()


def _load_sibling(name):
    """Load `compute/<name>.py` by file location, under a private module name."""
    import importlib.util

    path = _COMPUTE / f"{name}.py"
    spec = importlib.util.spec_from_file_location(f"doublet_compute_{name}", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        # Same pop-on-failure `load_compute` gives the compute module: a half-executed
        # module left in `sys.modules` is worse than no module, because the next import
        # silently gets it instead of retrying.
        sys.modules.pop(spec.name, None)
        raise
    return module


def load_shared():
    """THIS package's `compute/_shared.py`, loaded by file location.

    `import _shared as S` from a test is the same #237 trap `load_compute` documents, one
    level down, and it is NOT latent — it is what a full-tree `just check-py` actually hits.
    Six doublet tests failed in-tree with `AttributeError: module '_shared' has no attribute
    'MISSING_VALUE_SENTINELS'` / `'HistogramRefused'` while passing standalone, because some
    earlier package's suite had already bound the flat name and doublet's `_shared` carries
    26 names the others do not.

    A blind audit reported this as latent on the strength of a grep showing every other
    package's `import _shared` is function-level and therefore runs after collection. The
    grep was right and the conclusion was wrong: those function-level imports still run
    BEFORE doublet's tests do, because doublet is last in `pytest.ini`'s `testpaths`. Only
    running the whole tree showed it. This is why the gate is the full runner and not the
    per-package suite.
    """
    return _load_sibling_cached("_shared")


def load_criteria():
    """THIS package's VENDORED `compute/_criteria.py`, loaded by file location — same trap,
    and three packages ship that basename."""
    return _load_sibling_cached("_criteria")


def _load_sibling_cached(name):
    cached = sys.modules.get(f"doublet_compute_{name}")
    if cached is not None:
        return cached
    for p in (str(_LIB_DIR), str(_COMPUTE)):
        if p not in sys.path:
            sys.path.insert(0, p)
    return _load_sibling(name)


def load_compute():
    """The REAL `compute/doublet.py`, loaded by file location. Idempotent."""
    import importlib.util

    cached = sys.modules.get(_COMPUTE_MODULE_NAME)
    if cached is not None:
        return cached
    for p in (str(_LIB_DIR), str(_COMPUTE)):
        if p not in sys.path:
            sys.path.insert(0, p)

    # Bind THIS package's siblings under the flat names for the duration of the exec, then
    # put back exactly what was there. Substituted ONLY when the incumbent is not already
    # ours: reloading a module that was already correct would create a SECOND instance, and
    # tests that do `import _shared as S` at module scope compare against the first one, so
    # a needless reload would break object identity to fix nothing.
    #
    # The substitution loop is INSIDE the `try`. It used to sit above it, with only the
    # compute's `exec_module` protected — so if `_load_sibling("_criteria")` raised AFTER
    # `_shared` had already been swapped, the `finally` never ran and this package's
    # `_shared` was left installed globally under the flat name, for every suite that ran
    # afterwards. That is the exact leak TEST-28's `global_shared_after == intruder` leg
    # forbids on the success path, reachable on the failure path. Demonstrated by a blind
    # audit that patched `_load_sibling` to raise and observed the leak.
    saved = {}
    module = None
    try:
        for name in _SIBLING_HELPERS:
            incumbent = sys.modules.get(name, _UNSET)
            theirs = (incumbent is not _UNSET
                      and Path(getattr(incumbent, "__file__", "") or "").resolve().parent
                      != _COMPUTE.resolve())
            if incumbent is _UNSET or theirs:
                saved[name] = incumbent
                # CACHED, not a fresh load. Loading a second copy here would give the
                # compute a different `HistogramRefused` class object from the one
                # `load_shared()` hands a test, so `pytest.raises(S.HistogramRefused)`
                # would not catch the compute's raise — two objects for one source file,
                # which is the whole failure mode this module exists to prevent.
                sys.modules[name] = _load_sibling_cached(name)

        spec = importlib.util.spec_from_file_location(_COMPUTE_MODULE_NAME, DETECT)
        module = importlib.util.module_from_spec(spec)
        # Registered BEFORE exec so a self-referential import resolves to this module.
        sys.modules[_COMPUTE_MODULE_NAME] = module
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(_COMPUTE_MODULE_NAME, None)
        raise
    finally:
        for name, incumbent in saved.items():
            if incumbent is _UNSET:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = incumbent
    return module


# ══════════════════════════════════════════════════════════════════════════════════════
# THE R LANE (#195 / E7) — `doublet.scdblfinder`
# ══════════════════════════════════════════════════════════════════════════════════════
#
# `DetectRun` above drives the python entry as a HOST subprocess, which works because the
# host has python. The R entry has no such luxury: R, `scDblFinder` and the whole
# Bioconductor stack exist ONLY inside the `single-cell-r` image, so the only honest way
# to run it is to run it THERE. `ScdblfinderRun` therefore stages inputs and reads outputs
# on the host, exactly as `DetectRun` does and through the SAME writers and the SAME
# reader, and executes the entry inside the mounted R rootfs under `bwrap`.
#
# ── WHY THE SAME STAGERS AND THE SAME READER MATTER MORE THAN THEY LOOK ───────────────
# The R entry reads the CSC store with `compute/_wire.R` and writes its columns with it
# too. Nothing else in this repository reads or writes that format from R. If this harness
# had its own R-side staging and its own R-side read-back, a wire-format disagreement
# between the python writer and the R reader would cancel out and the numbers would be
# quietly wrong. Going in through `write_csc_store` and out through
# `cyto_zarr_read.read_column` is what makes a disagreement a TEST FAILURE.
#
# ── THE SANDBOX ARGV IS BORROWED, NOT INVENTED ────────────────────────────────────────
# It mirrors `scripts/verify-r-rootfs-local.sh`, which mirrors
# `server/src/modules/sandbox/sandbox.rs`: the rootfs `/usr` bound read-only, the fixed
# PATH, `--unshare-net`, and the thread-pinning environment. Kept in step deliberately —
# if that argv changes and this does not, this harness stops describing the thing it
# claims to describe.
#
# It does NOT pass `--unshare-user`. That is not a shortcut and it is worth being exact
# about, because it is a real difference from the server's own argv: `probes.rs::
# probe_pid_ns` combines `--unshare-user` with `--proc /proc`, and on a host whose `bwrap`
# is setuid root and whose kernel refuses a procfs mount from an unprivileged user
# namespace, that combination FAILS while the same argv without it succeeds. Measured both
# ways. So on such a host the server self-disables its sandbox and every sandbox-executing
# test self-skips — which is a finding about the platform's probe, reported as one, and
# not something this harness may paper over. What this harness runs is still a real
# `bwrap` sandbox with a real PID namespace, a read-only `/usr` from the real image and no
# network; what it is not is the server's job path.

#: A pre-extracted `single-cell-r` rootfs directory. Extraction of a ~700 MB squashfs costs
#: real time, so a caller that already has one (a lifecycle run, a dev loop) points at it
#: and every test in the session reuses it.
R_ROOTFS_DIR_ENV = "CYTO_R_ROOTFS_DIR"
#: The per-env air-gap seam the platform itself uses (`env_image.rs` SEAM_KEYS[0] +
#: the env-id suffix). Read rather than re-derived, so this harness and `just test-sandbox`
#: are pointed at the same artifact by the same variable.
R_SEAM_ENV = "CYTO_ENV_ROOTFS_SQUASHFS__single-cell-r"
R_ENV_ID = "single-cell-r"

#: The sandbox's own PATH (`sandbox.rs`), spelled here once.
_SANDBOX_PATH = ("/opt/venv/bin:/opt/conda/bin:/usr/local/sbin:/usr/local/bin:"
                 "/usr/sbin:/usr/bin:/sbin:/bin")

SCDBLFINDER = _COMPUTE / "scdblfinder.R"
WIRE_R = _COMPUTE / "_wire.R"

_STAGE_R_CMD = ("sh scripts/build-env-rootfs-local.sh --env single-cell-r  "
                "# then export the `env '...'` line it prints")


def r_rootfs_dir():
    """An extracted `single-cell-r` rootfs, or `None`.

    Prefers an already-extracted directory; otherwise extracts the staged squashfs ONCE
    into `.cyto-cache/env-rootfs/single-cell-r.rootfs/` and reuses it. The extraction is
    guarded by a marker file rather than by directory existence, so an extraction killed
    half-way is redone instead of being mistaken for a good one.
    """
    override = os.environ.get(R_ROOTFS_DIR_ENV)
    if override and (Path(override) / "usr").is_dir():
        return Path(override)
    squash = os.environ.get(R_SEAM_ENV)
    if not squash or not Path(squash).is_file():
        return None
    dest = repo_root() / ".cyto-cache" / "env-rootfs" / f"{R_ENV_ID}.rootfs"
    marker = dest / ".extracted-ok"
    if marker.is_file():
        return dest
    if shutil.which("unsquashfs") is None:
        return None
    if dest.exists():
        shutil.rmtree(dest)
    proc = subprocess.run(["unsquashfs", "-no-progress", "-d", str(dest), str(squash)],
                          capture_output=True, text=True)
    if proc.returncode != 0 or not (dest / "usr").is_dir():
        return None
    marker.write_text(str(squash))
    return dest


def require_r_env():
    """The extracted R rootfs, or a NAMED stop.

    Absent + `CYTO_REQUIRE_FIXTURES=1` -> a hard FAILURE. The science tier's own setting:
    a skip there is not a pass, and this is the tier that decides whether a second doublet
    method works at all.
    """
    root = r_rootfs_dir()
    if root is not None:
        return root
    msg = (
        f"the `{R_ENV_ID}` analysis image is not available. Build and stage it, then point "
        f"this harness at it:\n    {_STAGE_R_CMD}\n"
        f"The image is NOT published (#80/#217), so the local build loop is the only route. "
        f"Set {R_ROOTFS_DIR_ENV} to reuse an already-extracted rootfs."
    )
    if os.environ.get("CYTO_REQUIRE_FIXTURES") == "1":
        pytest.fail(msg)
    pytest.skip(msg)


def run_in_r_sandbox(command, binds=(), timeout=3600):
    """Run `command` under `bash -lc` inside the R rootfs, through `bwrap`."""
    root = require_r_env()
    argv = [
        "bwrap",
        "--unshare-uts", "--unshare-ipc", "--unshare-net", "--new-session",
        "--die-with-parent",
        "--ro-bind", str(root / "usr"), "/usr",
        "--ro-bind-try", str(root / "etc" / "ssl" / "certs"), "/etc/ssl/certs",
        "--ro-bind-try", str(root / "etc" / "alternatives"), "/etc/alternatives",
        "--ro-bind-try", str(root / "etc" / "R"), "/etc/R",
        "--ro-bind-try", str(root / "opt"), "/opt",
        "--symlink", "usr/bin", "/bin", "--symlink", "usr/sbin", "/sbin",
        "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
        "--dev", "/dev", "--tmpfs", "/tmp",
    ]
    for b in binds:
        argv += ["--bind", str(b), str(b)]
    argv += [
        "--setenv", "PATH", _SANDBOX_PATH,
        "--setenv", "LANG", "C.UTF-8", "--setenv", "LC_ALL", "C.UTF-8",
        "--setenv", "TERM", "dumb",
        "--setenv", "OPENBLAS_NUM_THREADS", "1", "--setenv", "OMP_NUM_THREADS", "1",
        "--setenv", "MKL_NUM_THREADS", "1",
        "--chdir", "/", "--", "/bin/bash", "-lc", command,
    ]
    return subprocess.run(argv, capture_output=True, text=True, timeout=timeout)


class ScdblfinderRun(DetectRun):
    """One `doublet.scdblfinder` run.

    Inherits every STAGING and READ-BACK method from `DetectRun` unchanged — that is the
    point: the two methods are driven through identical inputs and read through identical
    readers, which is what makes any number measured on both of them a comparison rather
    than two unrelated numbers (E7/DEC-9).

    Only `run()` differs, because only the execution does.
    """

    def __init__(self, base: Path):
        super().__init__(base)
        self.script = SCDBLFINDER

    def run(self, params=None, *, env_extra=None):
        self._write_wire(params)
        # `run.helpers` are staged by BASENAME into `/code` beside the entry. The real
        # platform copies them; here the compute directory IS `/code`, and it is bound
        # read-only in effect because the sandbox has no reason to write there.
        binds = [self.inputs_dir, self.outputs_dir, _COMPUTE]
        extra = " ".join(
            f"{k}={v}" for k, v in (env_extra or {}).items() if v is not None)
        cmd = (f"CYTO_INPUTS_DIR={self.inputs_dir} CYTO_OUTPUTS_DIR={self.outputs_dir} "
               f"{extra} Rscript {SCDBLFINDER}")
        return run_in_r_sandbox(cmd, binds=binds)

    def report(self) -> dict:
        return json.loads((self.outputs_dir / "scdblfinder-report.json").read_text())

    def diagnostics(self, proc) -> str:
        return "\n".join(l for l in proc.stderr.splitlines()
                         if l.startswith("doublet.scdblfinder:"))
