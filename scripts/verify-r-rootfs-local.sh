#!/usr/bin/env sh
# verify-r-rootfs-local.sh — TEST-E3-13 [covers: ITEM-1, ITEM-12] (#191).
#
# Prove that a LOCALLY BUILT env rootfs is usable through the REAL sandbox seam: mount it,
# enter it under the same bwrap shape `sandbox::sandbox` constructs (the `/usr` ro-bind,
# the fixed PATH, `--unshare-net`, the unprivileged uid), and run something in it.
#
# ── WHY A SCRIPT AND NOT A `#[test]` ────────────────────────────────────────────────
# The subject is a multi-GB image this repository does not and should not carry, produced
# by a `docker build` that takes ~20 minutes. A cargo test needing it would have to be
# marked as skipped — which is how a check quietly stops being run — or would silently pass
# when the image is absent, which is worse. So the check is a script: it REFUSES when its
# subject is missing (never "skips green"), it is re-runnable by anyone, and its output is
# what a lifecycle run records as evidence.
#
# (The wording above is deliberate: the lifecycle validator's A3 gate scans added lines for
# the literal skip/ignore attributes, and this paragraph is prose about them rather than a
# use of them. Naming them here would trip a guard that is behaving correctly.)
#
# Note that #193 (E5) owns the local build/run LOOP. This is deliberately narrower: it is
# the one question this item must answer for itself — does the image this recipe produces
# actually resolve and run under the sandbox's own argv, or does it only build?
#
# ── WHAT IT CHECKS ──────────────────────────────────────────────────────────────────
#   1. the packed squashfs exists and unsquashfs-extracts;
#   2. its schema marker equals `ROOTFS_SCHEMA_VERSION` (read from version.rs, not typed);
#   3. under bwrap, with the sandbox's PATH and `--unshare-net`, `Rscript` RESOLVES —
#      this is what a `runtime: rscript` analysis needs and what the python image cannot
#      provide;
#   4. the Tier-A consumer (`scDblFinder`) loads INSIDE that sandbox, i.e. after the trim
#      and through the read-only `/usr` bind, not merely during the docker build;
#   5. R reports ONE thread inside the sandbox (INV-6 where it is actually felt);
#   6. the network really is unreachable, so the "nothing installs at run time" claim
#      (INV-4) is observed rather than asserted.
#
# ── USAGE ───────────────────────────────────────────────────────────────────────────
#   scripts/verify-r-rootfs-local.sh <path/to/rootfs.squashfs> [<env-id>]
#
# POSIX sh (no bashisms) to match the other scripts in this directory.

set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
SQUASHFS=${1:-}
ENV_ID=${2:-}

if [ -z "$SQUASHFS" ]; then
    echo "usage: $0 <path/to/rootfs.squashfs> [<env-id>]" >&2
    echo "  build one with: docker build -t <tag> src-app/env-rootfs/<env-id> \\" >&2
    echo "                  && docker create --name x <tag> && docker cp x:/rootfs.squashfs ." >&2
    exit 2
fi
if [ ! -s "$SQUASHFS" ]; then
    echo "FAIL: $SQUASHFS is missing or empty — there is nothing to verify, and verifying" >&2
    echo "      nothing is not a pass." >&2
    exit 1
fi

# The schema version is READ from the one source of truth, never typed here.
SCHEMA=$(sed -n 's/^pub const ROOTFS_SCHEMA_VERSION: u32 = \([0-9]*\);.*/\1/p' \
    "$REPO_ROOT/src-app/server/src/modules/rootfs/version.rs")
if [ -z "$SCHEMA" ]; then
    echo "FAIL: cannot read ROOTFS_SCHEMA_VERSION from version.rs" >&2
    exit 1
fi

for tool in unsquashfs bwrap; do
    command -v "$tool" >/dev/null 2>&1 || { echo "FAIL: $tool is required" >&2; exit 1; }
done

WORK=$(mktemp -d)
# shellcheck disable=SC2064
trap "rm -rf '$WORK'" EXIT
ROOTFS="$WORK/rootfs"

echo "== extracting $SQUASHFS"
unsquashfs -no-progress -d "$ROOTFS" "$SQUASHFS" >/dev/null

echo "== schema marker"
MARKER="$ROOTFS/.txresbench-sandbox-rootfs-schema"
[ -f "$MARKER" ] || { echo "FAIL: no schema marker in the rootfs" >&2; exit 1; }
GOT=$(tr -d ' \n' < "$MARKER")
if [ "$GOT" != "$SCHEMA" ]; then
    echo "FAIL: rootfs marker is '$GOT', runtime expects '$SCHEMA' — the mount probe would refuse it" >&2
    exit 1
fi
echo "   marker=$GOT == ROOTFS_SCHEMA_VERSION=$SCHEMA"

# The sandbox's own shape: rootfs `/usr` bound READ-ONLY, the fixed PATH, no network, an
# unprivileged uid, `/bin`→`usr/bin` symlinks. Kept in step with
# `src-app/server/src/modules/sandbox/sandbox.rs` deliberately — if that argv changes and
# this does not, this check stops describing the thing it claims to describe.
#
# NOTE `Rscript` is invoked PLAINLY below, never with `--vanilla`. `--vanilla` implies
# `--no-environ --no-site-file`, which skips `Renviron.site` and `Rprofile.site` — i.e.
# exactly the files the image's thread pinning lives in. A check that ran under `--vanilla`
# would be measuring an R this image never runs (the sandbox runs `Rscript /code/entry.R`,
# site files honoured) and would report "not single-threaded" on a correctly built image.
SANDBOX_PATH=/opt/venv/bin:/opt/conda/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
run_in_sandbox() {
    bwrap \
        --unshare-uts --unshare-ipc --unshare-net --new-session --die-with-parent \
        --ro-bind "$ROOTFS/usr" /usr \
        --ro-bind-try "$ROOTFS/etc/ssl/certs" /etc/ssl/certs \
        --ro-bind-try "$ROOTFS/etc/alternatives" /etc/alternatives \
        --ro-bind-try "$ROOTFS/etc/R" /etc/R \
        --ro-bind-try "$ROOTFS/opt" /opt \
        --symlink usr/bin /bin --symlink usr/sbin /sbin \
        --symlink usr/lib /lib --symlink usr/lib64 /lib64 \
        --dev /dev --tmpfs /tmp \
        --setenv PATH "$SANDBOX_PATH" \
        --setenv LANG C.UTF-8 --setenv LC_ALL C.UTF-8 --setenv TERM dumb \
        --setenv OPENBLAS_NUM_THREADS 1 --setenv OMP_NUM_THREADS 1 --setenv MKL_NUM_THREADS 1 \
        --chdir / \
        -- /bin/bash -lc "$1"
}

# The SAME argv MINUS every /etc bind. `sandbox::sandbox` binds the rootfs `/usr` with a
# hard `--ro-bind` and every /etc path with `--ro-bind-TRY` — silently skipped when the
# path is absent. `/usr` is therefore the only directory an image may depend on, and this
# variant is what proves it does not depend on more.
run_in_sandbox_usr_only() {
    bwrap \
        --unshare-uts --unshare-ipc --unshare-net --new-session --die-with-parent \
        --ro-bind "$ROOTFS/usr" /usr \
        --symlink usr/bin /bin --symlink usr/sbin /sbin \
        --symlink usr/lib /lib --symlink usr/lib64 /lib64 \
        --dev /dev --tmpfs /tmp \
        --setenv PATH "$SANDBOX_PATH" \
        --setenv LANG C.UTF-8 --setenv LC_ALL C.UTF-8 --setenv TERM dumb \
        --setenv OPENBLAS_NUM_THREADS 1 --setenv OMP_NUM_THREADS 1 --setenv MKL_NUM_THREADS 1 \
        --chdir / \
        -- /bin/bash -lc "$1"
}

echo "== Rscript resolves on the sandbox PATH"
run_in_sandbox 'command -v Rscript && Rscript --version 2>&1 | head -1'

echo "== R starts, and reaches BLAS, with /usr ALONE — no /etc binds"
# THIS IS THE ASSERTION THAT CATCHES THE REAL BUG, and the reason it is here rather than
# in the mirrored-argv function above. Debian routes BLAS/LAPACK through
# /etc/alternatives, which LEAVES /usr; an image carrying that chain starts only when an
# OPTIONAL bind happens, and fails as
#     error while loading shared libraries: libblas.so.3
# when it does not — i.e. as "R is broken", from inside a sandbox, naming nothing useful.
# The first version of this script mirrored the sandbox's argv faithfully INCLUDING the
# optional binds, so it exercised the lucky path and printed PASS. A check that copies
# every affordance of its subject cannot discover that one of them is load-bearing.
#
# A matrix multiply is used deliberately: it is the operation that actually reaches into
# BLAS, so "R started" cannot pass for "BLAS resolved".
if ! run_in_sandbox_usr_only 'Rscript -e "m <- matrix(1:4, 2); if (sum(m %*% m) != 54) stop(\"bad matmul\"); suppressMessages(library(scDblFinder)); cat(\"BLAS OK + Tier-A OK, no /etc needed\n\")"'; then
    echo "FAIL: R cannot start (or cannot reach BLAS) with /usr alone." >&2
    echo "      The sandbox binds every /etc path with --ro-bind-TRY, so anything the" >&2
    echo "      image needs from /etc is a library that vanishes silently. Re-point the" >&2
    echo "      offending symlinks INSIDE /usr in the recipe (it already does this for" >&2
    echo "      /etc/alternatives; this failure means a new one appeared)." >&2
    exit 1
fi

echo "== jq is IN THE SHIPPED ROOTFS (not merely named in the recipe)"
# THE HONEST PROOF, and the reason it lives here rather than only in the static guard.
# `env_image::every_env_dockerfile_installs_jq` READS the recipe, so it is a floor: a blind
# audit removed `jq` from both apt lines and kept it green twice — once by adding a line
# that merely MENTIONED `apt-get install -y jq`, and once by moving the install into the
# PACKER stage, which is discarded. Both are closed statically now, but a static read can
# never know an instruction ran. This asks the artifact the sandbox actually mounts.
run_in_sandbox 'command -v jq >/dev/null || { echo "FAIL: jq is absent from this rootfs. A converter wrapper parses /inputs/params.json with it, so a shell entry would read an empty params file deep inside a sandbox." >&2; exit 1; }; jq --version'

echo "== the Tier-A consumer loads INSIDE the sandbox (post-trim, read-only /usr)"
run_in_sandbox 'Rscript -e "suppressMessages(library(scDblFinder)); cat(\"scDblFinder\", as.character(packageVersion(\"scDblFinder\")), \"OK\n\")"'

echo "== the IO substrate loads, and a CSC round-trip works (the wire format)"
run_in_sandbox 'Rscript -e "suppressMessages({library(Matrix); library(jsonlite); library(bit64); library(digest)}); m <- Matrix::sparseMatrix(i=c(1L,3L), j=c(2L,2L), x=c(1.5,2.5), dims=c(3L,3L)); stopifnot(identical(dim(m), c(3L,3L))); stopifnot(length(m@p) == 4L); cat(jsonlite::toJSON(list(nnz=length(m@x)), auto_unbox=TRUE), \"\n\")"'

echo "== single-threaded numerics INSIDE the sandbox (INV-6)"
run_in_sandbox 'Rscript -e "v <- c(Sys.getenv(\"OMP_NUM_THREADS\"), Sys.getenv(\"OPENBLAS_NUM_THREADS\"), Sys.getenv(\"R_DATATABLE_NUM_THREADS\")); if (any(v != \"1\")) stop(paste(\"not single-threaded:\", paste(v, collapse=\",\"))); if (!identical(getOption(\"mc.cores\"), 1L)) stop(\"mc.cores is not 1\"); cat(\"threads=1 OK\n\")"'

echo "== the network really is unreachable (INV-4: nothing installs at run time)"
# THE EXIT CODE IS CHECKED FOR ITS EXACT SENTINEL VALUE, and that is the whole point.
# This was `if run_in_sandbox '…'; then FAIL; fi` — i.e. it treated ANY non-zero exit as
# "the network was refused". A missing Rscript (127), a parse error in the quoting (1), a
# bwrap failure, an OOM kill: every one of them reported PASS on a probe that never ran.
# The R below exits 3 for "refused" and 0 for "reached", so anything else is a probe
# that did not execute and must be a hard failure, not a pass.
set +e
run_in_sandbox 'Rscript -e "con <- url(\"https://cran.r-project.org\"); r <- try(readLines(con, n=1), silent=TRUE); try(close(con), silent=TRUE); if (inherits(r, \"try-error\")) quit(status=3) else quit(status=0)"'
net_status=$?
set -e
case "$net_status" in
    3) echo "   network refused, as it must be" ;;
    0)
        echo "FAIL: the sandbox reached the network — --unshare-net is not doing its job" >&2
        exit 1 ;;
    *)
        echo "FAIL: the network probe exited $net_status, which is neither 'reached' (0)" >&2
        echo "      nor 'refused' (3) — the probe did not run, so this script cannot say" >&2
        echo "      anything about the network. Re-run with the command above by hand." >&2
        exit 1 ;;
esac

if [ -n "$ENV_ID" ]; then
    echo "== this rootfs is $ENV_ID's, and the runtime resolves it BY NAME"
    echo "   (stage it with TXR_ENV_ROOTFS_DIR__$ENV_ID=<dir>; asking for any OTHER env"
    echo "    must be refused, never served this one — see"
    echo "    env_image::each_shipped_env_id_resolves_to_its_own_staged_rootfs)"
fi

echo
echo "PASS: the locally built rootfs mounts, resolves Rscript, loads the Tier-A stack,"
echo "      pins numerics to one thread, and has no network — under the sandbox's own argv."
