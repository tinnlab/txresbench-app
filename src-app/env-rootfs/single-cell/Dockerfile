# The production single-cell env rootfs (uv/wheels, NO conda).
#
# PUBLISHING IS MANUAL RIGHT NOW. `.github/workflows/env-images.yml` builds, pushes and
# signs this on every recipe change to `main` — but it is currently `.disabled` (every
# workflow in the repository is: the organization's Actions billing is off). The runtime
# resolves a MOVING tag, so a change here is invisible to every deployment until someone
# republishes: `docs/runbooks/env-image-republish.md`, or `scripts/publish-env-rootfs.sh`.
# Editing this file without republishing is a no-op, and that is the single most likely
# way to waste a day on it.
#
# `OciEnvImageProvider` lazy-fetches + cosign-verifies + mounts it at runtime. The
# uv recipe + trim + mount/run are PROVEN (EVIDENCE-rootfs-uv.log): full spatial
# stack imports, ~316 MB trimmed squashfs, runs under bwrap, arm64 wheels available.
# Two-stage rootfs→packer shape: stage 1 builds the venv; the packer stage runs
# mksquashfs and exposes `/rootfs.squashfs` (docker-cp'd out by the workflow). uv
# auto-selects the arch from the build platform (no MAMBA_ARCH build-arg).
#
# SCHEMA v5 (analysis-rootfs): conda/micromamba env at /opt/conda REPLACED by a uv
# venv at /opt/venv (+ the sandbox PATH `/opt/conda/bin`→`/opt/venv/bin` one-liner);
# adds squidpy+spatialdata (DEC-A full spatial) + jq (so cellranger.sh parses
# params.json); DROPS r-base-core (no R processor exists — re-add if one lands).

# ---------------------------------------------------------------------------
# Stage 1 — the analysis rootfs contents (uv venv, wheels only, aggressively trimmed).
# ---------------------------------------------------------------------------
FROM python:3.11-slim AS rootfs
ENV DEBIAN_FRONTEND=noninteractive PIP_NO_CACHE_DIR=1

# bwrap binds <rootfs>/usr over /usr and runs `/bin/bash -lc`, so the base userland
# needs bash + coreutils; curl/bzip2/ca-certificates bootstrap cellranger; jq lets
# cellranger.sh parse params.json (was silently defaulted); binutils is build-only
# (strip), removed before the image is packed.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash coreutils ca-certificates curl bzip2 jq binutils \
    && rm -rf /var/lib/apt/lists/*

# uv = single static binary (fast resolver/installer). One venv at /opt/venv; the
# sandbox binds <rootfs>/opt read-only and prepends /opt/venv/bin to PATH.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
RUN uv venv /opt/venv --python 3.11
ENV VIRTUAL_ENV=/opt/venv PATH=/opt/venv/bin:$PATH

# The full single-cell + FULL-spatial stack — PyPI manylinux wheels only, no source
# builds, arch auto-selected from the build platform (x86_64 AND aarch64 all have
# wheels; verified).
#
# (History kept because it is the precedent the pin file's one-directional gate rests on:
# artifact-model ITEM-38 DROPPED the TileDB-SOMA wheel, and the ~200 MB of bundled native
# library with it, because no processor in the tree imported it any more — "installed,
# smoke-tested and shipped for nobody". That is the review standard an unconsumed pin is
# still held to.)
#
# #80 / DEC-2 — THE INSTALL LIST MOVED OUT OF THIS FILE, into `requirements.txt`, and
# every direct dependency is now EXACTLY pinned. Read that file for the position and the
# per-line rationale; read the runbook before changing a pin.
#
# Why a file and not a longer inline list: the pin set now has THREE machine consumers,
# not one. Besides this `RUN`, the server's build gate resolves every
# `run.dependencies[]` a package manifest declares against these pins (so a package
# declaring an absent or out-of-range library fails `cargo check`, not a user's sandbox
# job), and the smoke-line test asserts every pinned distribution is covered by the
# import assertion below. An inline token list is not addressable by either.
#
# The `harmonypy` reasoning that used to sit here as a one-package exception is now the
# GENERAL rule and lives in `requirements.txt`'s header: its defaults are version-unstable,
# so the consuming analysis passes every parameter explicitly AND pins AND records the
# resolved version — which must satisfy the declaration. That was never specific to
# harmonypy; every library whose DEFAULTS a published number depends on has the same
# property, and `scanpy` (unpinned until now, and the library the doublet method's scores
# come from) is the case that made it urgent.
#
# This remains a `/opt/venv` PACKAGE change, NOT a layout change: the interpreter prefix,
# the PATH the sandbox prepends and every mount point are untouched, so
# ROOTFS_SCHEMA_VERSION deliberately stays at 5 (see `server/src/modules/rootfs/version.rs`).
# It DOES require an image republish before it takes effect — the runtime lazy-fetches the
# moving `schema<N>-latest-<arch>` tag, and the workflow that used to do that automatically
# is disabled (Actions billing), so the republish is the runbook's manual path:
# `docs/runbooks/env-image-republish.md`.
COPY requirements.txt /tmp/requirements.txt
RUN uv pip install --no-cache -r /tmp/requirements.txt

# The FULL resolved transitive closure, frozen INTO the image (#80 / DEC-2 / ITEM-3).
#
# `requirements.txt` pins the 25 DIRECT distributions; this file records all 148
# resolved packages, including every transitive one nobody named. It is what makes the
# difference between "the declared stack is reproducible" and "the environment a result
# came out of is KNOWN": `_lib/cyto_deps.py` folds its digest into every run's recorded
# environment, so a transitive change is visible in the provenance record of the run it
# affected instead of being invisible.
#
# ORDERING IS LOAD-BEARING: this must run BEFORE the trim layer below, which uninstalls
# pip/setuptools/wheel. `uv pip freeze` reads the venv's installed-distribution metadata
# (not pip itself), but the trim also strips `*.dist-info` siblings in ways a future edit
# could extend — freezing first makes the record independent of what the trim does.
RUN /usr/local/bin/uv pip freeze > /opt/venv/.cyto-env-lock.txt \
    && test -s /opt/venv/.cyto-env-lock.txt \
    && printf 'env lock: %s packages\n' "$(wc -l < /opt/venv/.cyto-env-lock.txt)"

# Aggressive trim (426→316 MB proven). strip .so debug syms (the big win) + drop
# headers/static-libs/tests/docs/pyc + remove build tools. KEEP .pyi/.pyx/.pxd —
# skimage/scipy read them at runtime via lazy_loader (deleting them breaks imports).
RUN set -eux; \
    find /opt/venv -name '*.so' -o -name '*.so.*' | xargs -r strip --strip-unneeded 2>/dev/null || true; \
    find /opt/venv -type d -name 'include' -prune -exec rm -rf {} + 2>/dev/null || true; \
    find /opt/venv -name '*.a' -delete 2>/dev/null || true; \
    find /opt/venv -type d \( -name 'tests' -o -name 'test' -o -name '__pycache__' \) -prune -exec rm -rf {} + 2>/dev/null || true; \
    find /opt/venv -name '*.pyc' -delete 2>/dev/null || true; \
    find /opt/venv/lib -type d \( -name 'doc' -o -name 'docs' -o -name 'examples' \) -prune -exec rm -rf {} + 2>/dev/null || true; \
    /opt/venv/bin/python -m pip uninstall -y pip setuptools wheel 2>/dev/null || true; \
    rm -f /usr/local/bin/uv; \
    apt-get purge -y binutils >/dev/null 2>&1 || true; apt-get autoremove -y >/dev/null 2>&1 || true

# Build-time import smoke — a broken/over-trimmed env fails the IMAGE build, not a
# runtime job. (skimage is a squidpy transitive dep that uses lazy_loader.)
#
# EVERY distribution in `requirements.txt` must appear here, by its IMPORT name (the
# `import=` token on its line). That is not a convention to remember: the guard
# `sandbox::env_image::every_env_recipe_smoke_verifies_every_pinned_import` reads the pin
# file and fails if any pinned distribution is missing from this line — "an install the
# smoke line does not verify silently ships absent". Adding a pin without a smoke import
# is a RED TEST, for every future addition and not only the ones someone remembered.
#
# The marker below is what DECLARES this instruction as the verification, for EVERY recipe
# in any language: the guard covers recipes whose package manager and interpreter it knows
# nothing about, so it cannot infer which line loads rather than installs. It reads this.
# cyto:env-smoke
RUN /opt/venv/bin/python -c "import numpy,scipy,scipy.sparse,scipy.stats,pandas,sklearn,skimage,skmisc,zarr,h5py,anndata,scanpy,leidenalg,igraph,umap,numba,llvmlite,harmonypy,pydeseq2,decoupler,statsmodels,squidpy,spatialdata,celltypist,liana,tifffile,imagecodecs,PIL,packaging,pyarrow; print('scientific + spatial stack OK')"

# --- Cell Ranger CLI (x86_64 only; operator-supplied signed URL) — UNCHANGED from
# the existing rootfs; jq now present so cellranger.sh reads params.json. ---
ARG CELLRANGER_URL=""
ARG TARGETARCH=amd64
RUN set -eux; \
    if [ -n "$CELLRANGER_URL" ] && [ "$TARGETARCH" = "amd64" ]; then \
        mkdir -p /opt; curl -fLs "$CELLRANGER_URL" | tar -xz -C /opt; \
        cr_dir="$(find /opt -maxdepth 1 -type d -name 'cellranger*' | head -n1)"; \
        test -n "$cr_dir" && test -x "$cr_dir/cellranger"; \
        ln -sf "$cr_dir/cellranger" /usr/local/bin/cellranger; /usr/local/bin/cellranger --version; \
    else echo "cellranger: skipped (no CELLRANGER_URL, or non-amd64 $TARGETARCH)"; fi

# Schema marker read by the runtime mount probe (must equal ROOTFS_SCHEMA_VERSION).
ARG ROOTFS_SCHEMA_VERSION=5
RUN printf '%s\n' "$ROOTFS_SCHEMA_VERSION" > /.cytoanalyst-sandbox-rootfs-schema

# ---------------------------------------------------------------------------
# Stage 2 — pack into a squashfs inside the container (host lacks squashfs-tools).
# zstd -Xcompression-level 22 -b 1M = the trimmed 316 MB (fast squashfuse reads;
# xz is ~20 MB smaller but slower random reads — not worth it for a mounted fs).
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS packer
RUN apt-get update && apt-get install -y --no-install-recommends squashfs-tools && rm -rf /var/lib/apt/lists/*
COPY --from=rootfs / /rootfs
RUN mksquashfs /rootfs /rootfs.squashfs \
        -comp zstd -Xcompression-level 22 -b 1M -noappend -no-progress -all-root \
        -e rootfs.squashfs
