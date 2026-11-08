#!/usr/bin/env python3
"""dev publisher — ITEM-2 (node qa-hardening): build + push the artifacts the
app's stacked sandbox fetches, from tools on THIS host only.

WHAT IT DOES
------------
The app pulls two artifact kinds from an OCI registry (the dev registry of
`registry.py`, or ghcr in production):

  * a trimmed per-language BASE rootfs (`tinnlab/txresbench-env/base-<family>`),
    one squashfs whose filesystem is what the sandbox binds at `/usr` (plus the
    `/opt`, `/etc/R`, `/etc/ssl/certs` etc. paths `sandbox::build_bwrap_argv`
    binds);
  * a per-method LAYER image (`tinnlab/txr-method-env-layers/<env-id>`), one
    squashfs carrying `/code` (the method's own wrapper bytes), the layer
    schema marker, `/layer-manifest.json` and the `usr/` mount-readiness
    sentinel — the artifact shape of `docs/design/method-env-layer-artifacts.md`
    §5/§6, byte-identical to the pinned §6.1 manifest construction.

This script assembles both kinds **from the host** — no docker, no network:

  * the base rootfs dir is assembled from the host interpreter install (R or
    python3) plus the host package libraries, with the shared-library closure
    (`ldd` over every ELF the rootfs carries), so `bwrap` can run it;
  * the per-method layer is the method's `/code` bytes from the methods
    repository plus the schema marker + manifest + sentinel; the per-language
    package stack lives in the base (the dev publisher's deliberate delta
    model, see DRIFT-1 ITEM-2);
  * each rootfs dir is packed with `mksquashfs -comp zstd -b 1M -noappend
    -no-progress -all-root` (the shipped recipe's compressor; dev speed sets
    the default zstd level, not the recipe's 22);
  * the artifacts are pushed to `--registry` with the §6.2 blob-first shape
    (blobs, then the manifest bytes verbatim), and the matching environment
    manifest (schema v1, `src-app/server/data/method-env-images.schema.json`)
    is written to `--out` for the app.

Nothing built is ever written inside the git work tree: `--out` defaults to
`/data/pbya/txresbench-app-work/qa-build` (outside the repo), and every staged
rootfs is a subdir of `--out`.

HONESTY
-------
This is a dev/QA approximation, not the published-layer pipeline:

  * the base is the HOST R 4.1 / python3.10 and the HOST package libraries
    (the published base is R 4.4.2 / Python 3.11 with pinned versions), so the
    layer SDK is the host's, and method wrappers run against the host
    versions' API surface;
  * the layer carries `/code` only; the published generator computes a
    docker-delta over the benchmark base (needs docker + the base image, both
    outside the dev scope);
  * the dev manifest records `base_digest` as the payload sha256 of the
    app-side base squashfs (the app's `EnvRef.digest` is a payload-verify pin;
    the published manifest's `base_digest` is the benchmark image's manifest
    digest — provenance, see DRIFT-1 ITEM-2);
  * digest verification in the app stays ON — the dev publisher pins the dev
    digests; nothing is skipped.

USAGE
-----
    python3 scripts/dev-registry/registry.py --port 5055 &   # ITEM-1's server
    python3 scripts/dev-registry/publish.py --registry 127.0.0.1:5055 --out /data/pbya/txresbench-app-work/qa-build

Options: --registry HOST:PORT (default 127.0.0.1:5055), --out DIR (default
/data/pbya/txresbench-app-work/qa-build), --methods id,id,... (default the six
real methods), --fixture (also build + push the tiny fixture artifacts used by
the acceptance test), --no-push (build + stage only), --skip-real (fixture
only), --manifest PATH (default <out>/method-env-images.dev.json), --fixture
manifest <out>/method-env-images.fixture.json.
"""

import argparse
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile

# ─────────────────────────────── compiled constants ─────────────────────────

#: The OCI artifact type (design §6) — the manifest's artifactType AND the
#: single layer file's media type.
ARTIFACT_TYPE = "application/vnd.txr.method-env.layer.v1"

#: The OCI image manifest media type (§6.1).
OCI_MANIFEST_MEDIATYPE = "application/vnd.oci.image.manifest.v1+json"

#: The OCI empty config descriptor (§6.1): `{}`, its digest fixed by sha256.
EMPTY_CONFIG_BYTES = b"{}"
EMPTY_CONFIG_DIGEST = "sha256:" + hashlib.sha256(EMPTY_CONFIG_BYTES).hexdigest()
EMPTY_CONFIG_SIZE = len(EMPTY_CONFIG_BYTES)

#: Layer schema marker (§5, DEC-11) — the file content and the annotation.
LAYER_SCHEMA_VERSION = "1"

#: The registry namespace + repos the app's seam re-points only the HOST of
#: (method_env.rs: the compiled namespace/repo names are kept).
NAMESPACE = "tinnlab"
BASES_REPO = "txresbench-env"
LAYERS_REPO = "txr-method-env-layers"

#: The app-side base tag convention (immutable per contract-arch): the app's
#: base_env_ref derives it from the manifest entry's contract + arch.
def base_tag(contract, arch):
    return "%s-%s" % (contract, arch)


#: The published base repo component, language-mapped (base_env_ref's
#: `base-<family>` spelling).
BASE_FAMILY = {"R": "r", "Python": "py"}

#: The six real methods of the ITEM-2/3 publish (all three kinds:
#: response-call, static-risk and dynamic-risk/survival; all runnable and in
#: src-app/server/data/method-env-images.json). NOTE (ITEM-3):
#: `linear-response-score` is NOT in the default set — its method gate FAILS
#: (methods/gates/linear-response-score.json: pass false, spec_status
#: "blocked"), so it is absent from the app's shipped environment manifest
#: AND from the app catalogue (method-catalogue DEC-2: runnable-only); a dev
#: manifest entry for it is unreachable (createRun answers METHOD_NOT_FOUND,
#: "no method ... in the shipped catalogue"). The gate-passing
#: `ctdna-anytime-detectability` replaced it (the plan pins at least six real
#: methods), and `build_and_publish` now REFUSES any real `--methods` id
#: absent from the app's own env manifest, so the dev publish can never
#: diverge from it again.
REAL_METHODS = [
    "cfmedip-ctdna-clearance-three-group",  # R  — response-call, survival (km-ish)
    "cox-baseline-delta",                    # R  — static-risk (survival)
    "ctdna-anytime-detectability",           # Py — static-risk (rule, uses the __detected companion)
    "ctdna-clearance",                       # Py — response-call (rule)
    "ctdna-week4-rise-or-emergence",         # Py — response-call (rule)
    "landmark-cox-current",                  # R  — dynamic-risk (survival)
]

#: The app's own env-manifest path (the set the app can actually run — the
#: ITEM-3 membership guard of the real-methods publish).
APP_ENV_MANIFEST = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "..",
    "src-app", "server", "data", "method-env-images.json",
)


def check_methods_in_app_manifest(method_ids):
    """Refuse a publish whose methods are outside the app's own env manifest
    (ITEM-3): the app validates a run's method ids against the CATALOGUE and
    the env set against the manifest — a dev manifest entry for a method the
    app does not ship is unreachable (`METHOD_NOT_FOUND: no method ... in the
    shipped catalogue`), so a dev publish naming one would diverge from the
    app's own set. The gate-failed `linear-response-score` was exactly that
    case (absent from both the app manifest and the catalogue)."""
    if not os.path.exists(APP_ENV_MANIFEST):
        raise PublishError("app env manifest missing: %s (run from the repo root)" % APP_ENV_MANIFEST)
    with open(APP_ENV_MANIFEST) as mf:
        app_ids = {e.get("method_id") for e in json.load(mf).get("envs", [])}
    for method_id in method_ids:
        if method_id not in app_ids:
            raise PublishError(
                "method %s is not in the app's shipped environment manifest (%s entries) — "
                "a dev manifest entry for it would be unreachable (createRun answers "
                "METHOD_NOT_FOUND); the publish set must be the app's own set" % (method_id, len(app_ids))
            )

#: The fixture ids. The fixture base is published under the SAME app-side repo
#: the real base-py uses (`tinnlab/txresbench-env/base-py`, the language →
#: `base-<family>` mapping of base_env_ref) — the app acceptance fetches it
#: through the app's own ref builder, so the fixture must sit at the spelling
#: the app actually requests. The fixture flow never mixes with the real
#: publish in one registry data dir (acceptance.sh runs `--fixture
#: --skip-real`; the real publish is its own `--out`).
FIXTURE_METHOD_ID = "txr-dev-fixture"
FIXTURE_BASE_ID = "base-py"

#: Contract family of the dev build (the app's manifest validator wants
#: <major>.<minor> and the base tag derives from it).
CONTRACT = "2.0"
ARCH = "amd64"

#: The dev publisher's own generator version (the app never parses it; the
#: committed generator's is its own).
GENERATOR_VERSION = "0.1.0-dev"

#: The methods repository (read-only) + the package repository root (the R
#: TxrMethod + Python txrmethod helper packages the wrappers import).
DEFAULT_METHODS_DIR = "/data/share/pbya/sigtrans/methods"
DEFAULT_PACKAGE_DIR = "/data/share/pbya/sigtrans/package"

#: Host paths that are part of the base rootfs assembly.
PY_STDLIB = "/usr/lib/python3.10"
PY_USER_SITE = "/home/pbya/.local/lib/python3.10/site-packages"
R_SYSTEM_LIB = "/usr/lib/R"
R_PERSONAL_LIB = "/home/pbya/R/x86_64-pc-linux-gnu-library/4.1"

#: Python packages the six real methods import (numpy/pandas/scipy + pandas's
#: date handling) plus the txrmethod helper module.
PY_PACKAGES = ("numpy", "pandas", "scipy", "dateutil", "pytz", "tzdata")

#: Host tools the sandbox argv itself names (build_bwrap_argv: prlimit, bash,
#: /bin/true for the PID-ns probe).
CORE_TOOLS = ("/usr/bin/prlimit", "/usr/bin/bash", "/usr/bin/dash", "/usr/bin/true")

#: Coreutils the R startup scripts shell out to (`/usr/lib/R/bin/R` runs uname
#: + sed; R's `utils` namespace .onLoad runs `which` via sh).
R_UTILS = (
    "/usr/bin/uname", "/usr/bin/sed", "/usr/bin/cat", "/usr/bin/grep",
    "/usr/bin/awk", "/usr/bin/head", "/usr/bin/tail", "/usr/bin/wc",
    "/usr/bin/cut", "/usr/bin/tr", "/usr/bin/basename", "/usr/bin/dirname",
    "/usr/bin/readlink", "/usr/bin/sort", "/usr/bin/date", "/usr/bin/which",
    "/usr/bin/rm", "/usr/bin/ls", "/usr/bin/mkdir", "/usr/bin/cp",
    "/usr/bin/mv", "/usr/bin/touch", "/usr/bin/ln", "/usr/bin/chmod",
    "/usr/bin/env", "/usr/bin/printf", "/usr/bin/sleep",
)


class PublishError(Exception):
    """A refusal the plan/design makes a hard error; the message names paths."""


# ─────────────────────────────── low-level helpers ───────────────────────────

def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def run(cmd, check=True):
    out = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and out.returncode != 0:
        raise PublishError(
            "command failed (%d): %s\n%s" % (out.returncode, " ".join(cmd), out.stderr.decode(errors="replace"))
        )
    return out


def mksquashfs(srcdir, out_sqfs):
    """Pack with the shipped recipe's compressor flags; `-all-root` so the
    uid-1001 sandbox process reads every file; dev level (the recipe's 22 is a
    release choice, see the header)."""
    tmp = out_sqfs + ".tmp"
    run([
        "mksquashfs", srcdir, tmp,
        "-comp", "zstd", "-b", "1M", "-noappend", "-no-progress", "-all-root",
    ])
    os.replace(tmp, out_sqfs)


def normalize_modes(directory):
    """Files >= 0644, dirs >= 0755 (a 0600 wrapper or 0700 package dir would be
    unreadable to the sandbox's uid-1001 — the benchmark's recorded pitfall)."""
    for dirpath, dirnames, filenames in os.walk(directory):
        for name in dirnames:
            p = os.path.join(dirpath, name)
            st = os.lstat(p)
            if stat.S_ISLNK(st.st_mode):
                continue
            if st.st_mode & 0o022 == 0 or st.st_mode & 0o044 == 0:
                os.chmod(p, max(st.st_mode & 0o7777, 0o755))
        for name in filenames:
            p = os.path.join(dirpath, name)
            st = os.lstat(p)
            if stat.S_ISLNK(st.st_mode):
                continue
            if st.st_mode & 0o044 == 0:
                os.chmod(p, max(st.st_mode & 0o7777, 0o644))


def _root(host_path):
    """Map a host absolute path into the <rootfs-dir>/ path the sandbox sees
    (the sandbox binds <rootfs>/usr -> /usr and symlinks /bin,/lib,/lib64 into
    it, and binds <rootfs>/opt -> /opt, <rootfs>/etc/R -> /etc/R etc.)."""
    if host_path.startswith("/usr/"):
        return "usr/" + host_path[len("/usr/"):]
    if host_path.startswith("/usr"):
        return "usr" + host_path[len("/usr"):]
    for prefix, dst in (("/lib64/", "usr/lib64/"), ("/lib/", "usr/lib/"),
                        ("/bin/", "usr/bin/"), ("/sbin/", "usr/sbin/"),
                        ("/opt/", "opt/"), ("/etc/", "etc/")):
        if host_path.startswith(prefix):
            return dst + host_path[len(prefix):]
    raise PublishError("host path %s has no rootfs mapping" % host_path)


def ldd_closure(rootfs_dir, extra_bins):
    """The shared-library closure: `ldd` over every ELF already in the rootfs
    dir plus `extra_bins` (absolute host paths), copy each resolved lib into
    its mapped place. Deterministic order (sorted); a lib already present is
    skipped (the closure only ADDS)."""
    import collections

    probes = []
    bins = set()
    for dirpath, dirnames, filenames in os.walk(rootfs_dir):
        for name in filenames:
            p = os.path.join(dirpath, name)
            try:
                with open(p, "rb") as f:
                    head = f.read(4)
            except OSError:
                continue
            if head == b"\x7fELF" or name.endswith(".so") or ".so." in name:
                probes.append(p)
                bins.add(p)
    probes = sorted(set(probes) | set(extra_bins))

    libs = collections.OrderedDict()
    for probe in probes:
        try:
            out = subprocess.run(["ldd", probe], stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL, timeout=30)
        except (OSError, subprocess.TimeoutExpired):
            continue
        if out.returncode != 0:
            continue
        text = out.stdout.decode(errors="replace")
        for line in text.splitlines():
            if "=>" in line and "(" in line:
                lib = line.split("=>", 1)[1].split("(", 1)[0].strip()
            else:
                parts = line.split()
                lib = parts[0] if parts and parts[0].startswith("/") else None
            if not lib or not lib.startswith("/") or not os.path.isfile(lib):
                continue
            # ldd may echo the probed file itself (a .so named by absolute
            # path) — never treat a build-dir path as a host dependency.
            if lib.startswith(rootfs_dir.rstrip("/") + "/"):
                continue
            rel = _root(lib)
            if os.path.lexists(os.path.join(rootfs_dir, rel)):
                continue
            libs.setdefault(lib, rel)
            # A symlinked lib (e.g. the /lib64/ld-linux interpreter) must carry
            # its REAL file too — the sandbox resolves the absolute target
            # through its own /lib,/lib64 symlinks, never through the host.
            real = os.path.realpath(lib)
            if real != lib:
                libs.setdefault(real, _root(real))
    return libs


def copy_into(rootfs_dir, host_src, rel_dst=None):
    """Copy a host file/dir into the rootfs dir (symlinks preserved), return
    the rootfs-relative destination."""
    if rel_dst is None:
        rel_dst = _root(host_src) if host_src.startswith("/") else host_src
    dst = os.path.join(rootfs_dir, rel_dst)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if os.path.isdir(host_src) and not os.path.islink(host_src):
        shutil.copytree(host_src, dst, symlinks=True, dirs_exist_ok=True)
    elif os.path.islink(host_src):
        if os.path.lexists(dst):
            os.unlink(dst)
        os.symlink(os.readlink(host_src), dst)
    elif os.path.exists(host_src):
        shutil.copy2(host_src, dst)
    return rel_dst


def copy_tool_real(rootfs_dir, host_src):
    """Copy a bin/tool as its RESOLVED file at the named path — a host symlink
    whose target chains through /etc/alternatives (which → alternatives → a
    file) would break inside the sandbox, where /etc/alternatives is the
    HOST's bind and the chain's final name may not exist in the rootfs."""
    rel = _root(host_src)
    real = os.path.realpath(host_src)
    if real != host_src:
        return copy_into(rootfs_dir, real, rel)
    return copy_into(rootfs_dir, host_src, rel)


# ─────────────────────────────── rootfs assembly ─────────────────────────────

def build_base_py(rootfs_dir, fixture=False):
    """Assemble the Python base rootfs: host python3 + stdlib + the science
    stack (or, for the fixture, stdlib only) + the txrmethod helper; then the
    shared-library closure."""
    import pkgutil

    if os.path.exists("/usr/bin/python3.10"):
        copy_into(rootfs_dir, "/usr/bin/python3.10")
        copy_into(rootfs_dir, "/usr/bin/python3")
    copy_into(rootfs_dir, PY_STDLIB)
    for top in CORE_TOOLS:
        copy_tool_real(rootfs_dir, top)

    if not fixture:
        site = "usr/local/lib/python3.10/dist-packages"
        tgt = os.path.join(rootfs_dir, site)
        os.makedirs(tgt, exist_ok=True)
        for name in os.listdir(PY_USER_SITE):
            if any(name == pkg or name.startswith(pkg + "-") for pkg in PY_PACKAGES):
                copy_into(rootfs_dir, os.path.join(PY_USER_SITE, name), site + "/" + name)
            elif name.endswith(".libs"):
                # The bundled BLAS/LAPACK shared objects numpy/scipy ship in a
                # `<pkg>.libs` side dir (their rpath is $ORIGIN-relative) — a
                # closure whose loader never sees them via ldd.
                copy_into(rootfs_dir, os.path.join(PY_USER_SITE, name), site + "/" + name)
            elif name.startswith("lib") and (".so" in name or name.endswith(".a")):
                copy_into(rootfs_dir, os.path.join(PY_USER_SITE, name), site + "/" + name)
        # The system dist-packages contribution: pytz + six (the user site
        # does not shadow them; the user-site dateutil/tzdata cover the rest of
        # the pandas deps). Only those + their metadata — the rest of the
        # system dist-packages is apt-stack noise the science stack never
        # imports (a stale numexpr/bottleneck compiled for numpy 1.x would also
        # warn on every pandas import).
        for name in os.listdir("/usr/lib/python3/dist-packages"):
            if (name == "pytz" or name.startswith("pytz-")
                    or name in ("six.py",) or name.startswith("six-")):
                copy_into(rootfs_dir, os.path.join("/usr/lib/python3/dist-packages", name),
                          "usr/lib/python3/dist-packages/" + name)
        # pytz 2022.1 + R both read the Olson tz database at its system path.
        copy_into(rootfs_dir, "/usr/share/zoneinfo")
        # The txrmethod helper module (package/base-images/python/txrmethod) —
        # installed into the base's own site-packages so `import txrmethod`
        # resolves without PYTHONPATH (the base image's PYTHONPATH=/opt/txrmethod
        # is a docker-env, and the sandbox env is the hardening prefix's).
        txr = os.environ.get("TXR_DEV_TXRMETHOD", os.path.join(DEFAULT_PACKAGE_DIR, "base-images/python/txrmethod"))
        if not os.path.isdir(txr):
            raise PublishError("txrmethod not found at %s (set TXR_DEV_TXRMETHOD)" % txr)
        copy_into(rootfs_dir, txr, site + "/txrmethod")

    # closure of every copied ELF + the named bins; bins are absolute host
    # paths, so probe them directly.
    libs = ldd_closure(rootfs_dir, [t for t in CORE_TOOLS] +
                       ["/usr/bin/python3.10"] + ([] if fixture else []))
    for host, rel in libs.items():
        copy_into(rootfs_dir, host, rel)
    normalize_modes(rootfs_dir)
    return rootfs_dir


def build_base_r(rootfs_dir):
    """Assemble the R base rootfs: host R install + the whole personal R
    library (relocated into /usr/local/lib/R/site-library so .libPaths()
    resolves inside the sandbox) + the closure."""
    for p in ("/usr/bin/R", "/usr/bin/Rscript"):
        copy_into(rootfs_dir, p)
    copy_into(rootfs_dir, R_SYSTEM_LIB)
    for share in ("/usr/share/R", "/usr/share/zoneinfo"):
        if os.path.isdir(share):
            copy_into(rootfs_dir, share)
    copy_into(rootfs_dir, "/usr/local/lib/R", None)  # the empty dirs
    site = "usr/local/lib/R/site-library"
    tgt = os.path.join(rootfs_dir, site)
    os.makedirs(tgt, exist_ok=True)
    for name in os.listdir(R_PERSONAL_LIB):
        copy_into(rootfs_dir, os.path.join(R_PERSONAL_LIB, name), site + "/" + name)
    for top in CORE_TOOLS + R_UTILS:
        copy_tool_real(rootfs_dir, top)
    os.symlink("dash", os.path.join(rootfs_dir, "usr/bin/sh"))
    # config paths the hardening prefix binds (ro-bind-try) + the loader cache.
    copy_into(rootfs_dir, "/etc/R")
    for p in ("/etc/alternatives", "/etc/ld.so.cache", "/etc/ssl/certs"):
        if os.path.exists(p):
            copy_into(rootfs_dir, p)
    # The host's openblas alternatives chain ends at a missing
    # `libopenblas.so.0` name (the real file is `libopenblasp-r0.3.20.so`);
    # R's loader asks for the SONAME name, so the sandbox gets the link that
    # makes the chain resolve inside the assembled rootfs. Must run AFTER the
    # closure (the openblas dir arrives with it).
    libs = ldd_closure(rootfs_dir, ["/usr/bin/R", "/usr/bin/Rscript"])
    for host, rel in libs.items():
        copy_into(rootfs_dir, host, rel)
    ob_dir = os.path.join(rootfs_dir, "usr/lib/x86_64-linux-gnu/openblas-pthread")
    if not os.path.lexists(os.path.join(ob_dir, "libopenblas.so.0")) and os.path.lexists(
            os.path.join(ob_dir, "libopenblasp-r0.3.20.so")):
        os.symlink("libopenblasp-r0.3.20.so", os.path.join(ob_dir, "libopenblas.so.0"))
    normalize_modes(rootfs_dir)
    return rootfs_dir


# ─────────────────────────────── layer assembly ──────────────────────────────

def wrapper_file(method_dir):
    for candidate in ("run.py", "run.R", "run.sh"):
        if os.path.isfile(os.path.join(method_dir, candidate)):
            return candidate
    return None


def wrapper_code_sha256(method_dir):
    """Design §2.2: sha256(method.json bytes || wrapper bytes), in that order."""
    meta = os.path.join(method_dir, "method.json")
    wrap = os.path.join(method_dir, wrapper_file(method_dir) or "")
    if not os.path.isfile(meta) or not wrap or not os.path.isfile(wrap):
        raise PublishError("method dir %s lacks method.json + a run wrapper" % method_dir)
    with open(meta, "rb") as f:
        m = f.read()
    with open(wrap, "rb") as f:
        w = f.read()
    return sha256_bytes(m + w)


def build_layer(method_dir, out_dir, env_id=None):
    """Stage + pack a code-only method layer (the dev delta model: the base
    carries the language stack; the layer is `/code` + the schema markers)."""
    env_id = env_id or os.path.basename(method_dir.rstrip("/"))
    layer_root = os.path.join(out_dir, "layers", env_id)
    if os.path.exists(layer_root):
        shutil.rmtree(layer_root)
    code = os.path.join(layer_root, "code")
    os.makedirs(code, exist_ok=True)
    for name in os.listdir(method_dir):
        if name.startswith("."):
            continue
        copy_into(code, os.path.join(method_dir, name), name)
    with open(os.path.join(layer_root, ".txr-method-env-layer-schema"), "w") as f:
        f.write(LAYER_SCHEMA_VERSION)
    with open(os.path.join(layer_root, "layer-manifest.json"), "w") as f:
        json.dump(["/code"], f)
    os.makedirs(os.path.join(layer_root, "usr"), exist_ok=True)  # mount-readiness sentinel
    normalize_modes(layer_root)
    sqfs = os.path.join(out_dir, "layers", env_id + ".squashfs")
    mksquashfs(layer_root, sqfs)
    return sqfs, env_id


def build_fixture_layer(out_dir):
    """The tiny fake method of TEST-QA-2: stdlib-only run.py writing the
    contract prediction row per /input/test/patients.csv patient."""
    method_dir = os.path.join(out_dir, "fixture-method")
    if os.path.exists(method_dir):
        shutil.rmtree(method_dir)
    os.makedirs(method_dir)
    with open(os.path.join(method_dir, "method.json"), "w") as f:
        json.dump({"id": FIXTURE_METHOD_ID, "version": "1.0.0", "language": "Python",
                   "group": "response-call", "min_draws": 1, "markers": "single"}, f)
    with open(os.path.join(method_dir, "run.py"), "w") as f:
        f.write(
            "import csv, json, os\n"
            "params = json.load(open('/input/params.json'))\n"
            "ids = [r['patient_id'] for r in csv.DictReader(open('/input/test/patients.csv'))]\n"
            "os.makedirs('/output', exist_ok=True)\n"
            "with open('/output/predictions.csv', 'w', newline='') as f:\n"
            "    w = csv.writer(f)\n"
            "    w.writerow(['patient_id', 'risk', 'call', 'note'])\n"
            "    for i in ids:\n"
            "        w.writerow([i, 0.5, 0, ''])\n"
            "fifo = os.environ.get('CYTO_PROGRESS_FIFO')\n"
            "if fifo:\n"
            "    with open(fifo, 'w') as f:\n"
            "        f.write('milestone|fit|started\\n')\n"
            "        f.write('milestone|fit|done\\n')\n"
        )
    return build_layer(method_dir, out_dir, env_id=FIXTURE_METHOD_ID)


# ─────────────────────────────── OCI push ────────────────────────────────────

def oci_client(registry_host):
    import http.client
    host, _, port = registry_host.partition(":")
    return http.client.HTTPConnection(host, int(port or 80), timeout=60)


def upload_blob(conn, name, data, digest):
    """POST the body (session start, the registry stores it as the session's
    first chunk) then PUT ?digest= to the returned Location to finalize — the
    OCI distribution v2 upload flow both ghcr and `registry.py` serve."""
    conn.request("POST", "/v2/%s/blobs/uploads/" % name, body=data,
                 headers={"Content-Type": "application/octet-stream"})
    resp = conn.getresponse()
    body = resp.read()
    if resp.status == 201:
        return True  # a registry that auto-finalized the monolithic POST
    if resp.status != 202:
        raise PublishError("blob upload start %s failed: %d %s" % (digest, resp.status, body[:200]))
    location = resp.getheader("Location") or "/v2/%s/blobs/uploads/" % name
    sep = "&" if "?" in location else "?"
    conn.request("PUT", "%s%sdigest=%s" % (location, sep, digest),
                 body=b"", headers={"Content-Length": "0"})
    resp = conn.getresponse()
    body = resp.read()
    if resp.status == 201:
        return True
    raise PublishError("blob upload finalize %s failed: %d %s" % (digest, resp.status, body[:200]))


def push_artifact(conn, name, tag, sqfs_path, annotations):
    """§6.2 push shape: blobs first (layer + empty config), then the manifest
    bytes verbatim, tagged. Returns (manifest_bytes, manifest_digest,
    layer_sha256, size_bytes)."""
    with open(sqfs_path, "rb") as f:
        layer_bytes = f.read()
    layer_sha = sha256_bytes(layer_bytes)
    layer_digest = "sha256:" + layer_sha
    upload_blob(conn, name, layer_bytes, layer_digest)
    upload_blob(conn, name, EMPTY_CONFIG_BYTES, EMPTY_CONFIG_DIGEST)

    manifest = artifact_manifest_bytes(layer_sha, len(layer_bytes), annotations)
    digest = "sha256:" + sha256_bytes(manifest)
    conn.request("PUT", "/v2/%s/manifests/%s" % (name, tag), body=manifest,
                 headers={"Content-Type": OCI_MANIFEST_MEDIATYPE})
    resp = conn.getresponse()
    body = resp.read()
    if resp.status not in (200, 201, 202):
        raise PublishError("manifest push %s:%s failed: %d %s" % (name, tag, resp.status, body[:200]))
    return manifest, digest, layer_sha, len(layer_bytes)


def artifact_manifest_bytes(layer_sha256_hex, size_bytes, annotations):
    """The pinned §6.1 construction: key order = the OCI struct order, no
    whitespace, ASCII only, `com.txr.layer_schema` as the string "1"."""
    an = json.dumps(annotations, separators=(",", ":"), sort_keys=False)
    # json.dumps escapes non-ASCII; the source is ASCII here, but be explicit.
    an = an.encode("ascii").decode("ascii")
    body = (
        '{"schemaVersion":2,"mediaType":"%s","artifactType":"%s",'
        '"config":{"mediaType":"application/vnd.oci.empty.v1+json",'
        '"digest":"%s","size":%d},'
        '"layers":[{"mediaType":"%s","digest":"sha256:%s","size":%d,'
        '"annotations":{"org.opencontainers.image.title":"layer.squashfs"}}],'
        '"annotations":%s}'
        % (OCI_MANIFEST_MEDIATYPE, ARTIFACT_TYPE, EMPTY_CONFIG_DIGEST,
           EMPTY_CONFIG_SIZE, ARTIFACT_TYPE, layer_sha256_hex, size_bytes, an)
    )
    return body.encode("ascii")


def method_annotations(method_id, method_version, language, contract, base_ref, base_digest, layer_sha):
    """The design §6 annotation table, in table order."""
    return {
        "org.opencontainers.image.source": "https://github.com/tinnlab/txresbench-methods",
        "org.opencontainers.image.revision": SOURCE_REVISION,
        "com.txr.method_id": method_id,
        "com.txr.method_version": method_version,
        "com.txr.language": language,
        "com.txr.arch": ARCH,
        "com.txr.contract": contract,
        "com.txr.base_ref": base_ref,
        "com.txr.base_digest": base_digest,
        "com.txr.layer_sha256": layer_sha,
        "com.txr.layer_schema": LAYER_SCHEMA_VERSION,
    }


def base_annotations(family, contract, base_digest, layer_sha):
    """The base artifact annotations (the app-side base; the design's
    com.txr.trimmed-from-digest carries the benchmark pairing anchor — here the
    dev base's own payload sha256, since there is no benchmark base in the dev
    flow)."""
    return {
        "com.txr.base_family": family,
        "com.txr.contract": contract,
        "com.txr.layer_sha256": layer_sha,
        "com.txr.layer_schema": LAYER_SCHEMA_VERSION,
        "com.txr.trimmed-from-digest": base_digest,
    }


# ─────────────────────────────── manifest writer ─────────────────────────────

def write_app_manifest(path, entries):
    """Schema-v1 manifest (src-app/server/data/method-env-images.schema.json),
    sorted by env_id."""
    doc = {
        "schema_version": 1,
        "generator_version": GENERATOR_VERSION,
        "source_revision": SOURCE_REVISION,
        "base_contract": CONTRACT,
        "envs": sorted(entries, key=lambda e: e["env_id"]),
    }
    with open(path, "w") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")
    return path


def load_method(methods_dir, method_id):
    d = os.path.join(methods_dir, "methods", method_id)
    if not os.path.isdir(d):
        # the repo layout is methods/<id>/ at the root of the methods tree.
        d = os.path.join(methods_dir, method_id)
    with open(os.path.join(d, "method.json")) as f:
        spec = json.load(f)
    return d, spec


def source_revision():
    try:
        out = subprocess.run(["git", "-C", DEFAULT_METHODS_DIR, "rev-parse", "--short=12", "HEAD"],
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        return out.stdout.decode().strip()
    except OSError:
        return "dev"


SOURCE_REVISION = source_revision()


# ─────────────────────────────── the main flow ───────────────────────────────

def build_and_publish(args):
    out = os.path.abspath(args.out)
    os.makedirs(out, exist_ok=True)
    stage = os.path.join(out, "stage")
    os.makedirs(stage, exist_ok=True)
    conn = None if args.no_push else oci_client(args.registry)

    entries = []
    published = []

    # ── bases ────────────────────────────────────────────────────────────────
    bases = {}
    if not args.skip_real:
        for family, builder in (("py", build_base_py), ("r", build_base_r)):
            rootfs = os.path.join(stage, "base-" + family)
            if os.path.exists(rootfs):
                shutil.rmtree(rootfs)
            os.makedirs(rootfs)
            builder(rootfs)
            sqfs = os.path.join(stage, "base-%s.squashfs" % family)
            mksquashfs(rootfs, sqfs)
            payload_sha = sha256_file(sqfs)
            bases[family] = (sqfs, payload_sha)
            if conn is not None:
                repo = "%s/%s/base-%s" % (NAMESPACE, BASES_REPO, family)
                tag = base_tag(CONTRACT, ARCH)
                manifest, digest, layer_sha, size = push_artifact(
                    conn, repo, tag, sqfs,
                    base_annotations(family, CONTRACT, "sha256:" + payload_sha, payload_sha),
                )
                published.append((repo + ":" + tag, digest, size, layer_sha))
            print("base-%s: %s bytes, sha256 %s" % (family, os.path.getsize(sqfs), payload_sha[:16]))

        for method_id in args.methods:
            method_dir, spec = load_method(args.methods_dir, method_id)
            language = spec.get("language", "Python")
            family = BASE_FAMILY[language]
            if family not in bases:
                raise PublishError("method %s wants %s but that base was not built" % (method_id, language))
            check_methods_in_app_manifest(args.methods)
            sqfs, env_id = build_layer(method_dir, stage)
            payload_sha = sha256_file(sqfs)
            version = spec.get("version", "0.0.0")
            base_ref = "ghcr.io/tinnlab/txresbench-base-%s:%s" % (family, CONTRACT)
            base_digest = "sha256:" + bases[family][1]
            wrapper_sha = wrapper_code_sha256(method_dir)
            if conn is not None:
                repo = "%s/%s/%s" % (NAMESPACE, LAYERS_REPO, env_id)
                tag = "%s-%s" % (version, ARCH)
                manifest, digest, layer_sha, size = push_artifact(
                    conn, repo, tag, sqfs,
                    method_annotations(env_id, version, language, CONTRACT, base_ref, base_digest, payload_sha),
                )
                published.append((repo + ":" + tag, digest, size, layer_sha))
                manifest_digest = digest
                layer_sha_pin = payload_sha
            else:
                manifest_digest = "sha256:" + sha256_file(sqfs)  # placeholder, no push
                layer_sha_pin = payload_sha
            entries.append({
                "env_id": env_id,
                "method_id": env_id,
                "method_version": version,
                "language": language,
                "arch": ARCH,
                "oci_ref": "ghcr.io/tinnlab/%s/%s" % (LAYERS_REPO, env_id),
                "tag": "%s-%s" % (version, ARCH),
                "digest": manifest_digest,
                "layer_sha256": layer_sha_pin,
                "size_bytes": os.path.getsize(sqfs),
                "base_ref": base_ref,
                "base_digest": base_digest,
                "contract": CONTRACT,
                "licence": spec.get("licence", ""),
                "wrapper_code_sha256": wrapper_sha,
                "layer_schema": 1,
            })
            print("layer %s: %s bytes" % (env_id, os.path.getsize(sqfs)))

    # ── fixture (TEST-QA-2: tests + app acceptance share these artifacts) ────
    if args.fixture:
        rootfs = os.path.join(stage, "base-fixture")
        if os.path.exists(rootfs):
            shutil.rmtree(rootfs)
        os.makedirs(rootfs)
        build_base_py(rootfs, fixture=True)
        sqfs = os.path.join(stage, "base-fixture.squashfs")
        mksquashfs(rootfs, sqfs)
        fixture_digest = "sha256:" + sha256_file(sqfs)
        base_repo = "%s/%s/%s" % (NAMESPACE, BASES_REPO, FIXTURE_BASE_ID)
        if conn is not None:
            push_artifact(conn, base_repo, base_tag(CONTRACT, ARCH), sqfs,
                          base_annotations("py", CONTRACT, fixture_digest, sha256_file(sqfs)))
        layer_sqfs, env_id = build_fixture_layer(stage)
        wrapper_sha = wrapper_code_sha256(os.path.join(stage, "fixture-method"))
        layer_repo = "%s/%s/%s" % (NAMESPACE, LAYERS_REPO, env_id)
        if conn is not None:
            manifest, digest, layer_sha, size = push_artifact(
                conn, layer_repo, "1.0.0-" + ARCH, layer_sqfs,
                method_annotations(env_id, "1.0.0", "Python", CONTRACT,
                                   "ghcr.io/tinnlab/txresbench-base-py:" + CONTRACT,
                                   fixture_digest, sha256_file(layer_sqfs)))
        fixture_entries = [{
            "env_id": env_id,
            "method_id": env_id,
            "method_version": "1.0.0",
            "language": "Python",
            "arch": ARCH,
            "oci_ref": "ghcr.io/tinnlab/%s/%s" % (LAYERS_REPO, env_id),
            "tag": "1.0.0-" + ARCH,
            "digest": digest if conn is not None else "sha256:" + sha256_file(layer_sqfs),
            "layer_sha256": sha256_file(layer_sqfs),
            "size_bytes": os.path.getsize(layer_sqfs),
            "base_ref": "ghcr.io/tinnlab/txresbench-base-py:" + CONTRACT,
            "base_digest": fixture_digest,
            "contract": CONTRACT,
            "licence": "MIT (fixture)",
            "wrapper_code_sha256": wrapper_sha,
            "layer_schema": 1,
        }]
        write_app_manifest(args.manifest_fixture, fixture_entries)
        print("fixture: base-fixture + %s published, manifest %s" % (env_id, args.manifest_fixture))

    if entries:
        write_app_manifest(args.manifest, entries)
        print("manifest: %s (%d entries)" % (args.manifest, len(entries)))
    if published:
        print("published:")
        for ref, digest, size, layer_sha in published:
            print("  %s@%s (%d bytes)" % (ref, digest, size))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description="TxResBench dev publisher (host-only, no docker, no network)")
    parser.add_argument("--registry", default="127.0.0.1:5055")
    parser.add_argument("--out", default="/data/pbya/txresbench-app-work/qa-build")
    parser.add_argument("--methods", default=",".join(REAL_METHODS))
    parser.add_argument("--methods-dir", default=DEFAULT_METHODS_DIR)
    parser.add_argument("--manifest", default=None)
    parser.add_argument("--manifest-fixture", default=None)
    parser.add_argument("--fixture", action="store_true")
    parser.add_argument("--skip-real", action="store_true")
    parser.add_argument("--no-push", action="store_true")
    args = parser.parse_args(argv)
    args.methods = [m.strip() for m in args.methods.split(",") if m.strip()]
    args.out = os.path.abspath(args.out)
    args.manifest = args.manifest or os.path.join(args.out, "method-env-images.dev.json")
    args.manifest_fixture = args.manifest_fixture or os.path.join(args.out, "method-env-images.fixture.json")
    return build_and_publish(args)


if __name__ == "__main__":
    sys.exit(main())
