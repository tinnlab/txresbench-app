#!/usr/bin/env sh
# env-lock-of.sh — print the frozen dependency-closure lock an env image carries (#192).
#
# ── WHAT QUESTION THIS ANSWERS ─────────────────────────────────────────────────────
# "Which library versions did THIS run actually use?"
#
# For the python lane that is answered inline: `_lib/cyto_deps.py` is staged into the
# sandbox and writes the resolved versions into the run's `run-environment` record, which
# the server lifts into `provenance_run_repro.lockfile_json`. Helper staging is
# Python-gated (`sandbox/processors/mod.rs`), so an R run cannot answer it that way yet —
# that is #194's (E6's) to close.
#
# Until it does, the answer is BY REFERENCE, and it is a total function rather than a
# gap: a run records the content digest of the image it mounted
# (`provenance_run_repro.env_rootfs_sha256`, made run-scoped by #189), and the image
# carries the full resolved closure frozen in at build time, one line per package with
# its version and its source. This script is the second half of that resolution — the
# step from "an image" to "the versions it contains". It is what makes the by-reference
# answer something a person can actually run instead of something a decision record
# claims is possible.
#
# ── IT REFUSES; IT NEVER SKIPS GREEN ───────────────────────────────────────────────
# Every failure path here exits non-zero and says what was missing. Following
# `verify-r-rootfs-local.sh`: verifying nothing is not a pass, and a check that returns 0
# when its subject is absent is how a check quietly stops being run.
#
# ── USAGE ──────────────────────────────────────────────────────────────────────────
#   scripts/env-lock-of.sh <path>            # a .squashfs rootfs, or an extracted root
#   scripts/env-lock-of.sh <path> --path     # print the lock's path inside the image only
#
# Getting <path> from a recorded run:
#   1. read `env_rootfs_sha256` off the run's `provenance_run_repro` row;
#   2. pull the artifact BY THAT DIGEST — `oras pull <repo>@sha256:<env_rootfs_sha256>`.
#      Not by tag: `schema<N>-<sha>-<arch>`'s `<sha>` is a GIT commit
#      (`publish-env-rootfs.sh` derives it from `git rev-parse HEAD`), and no annotation
#      maps a content digest to it, so there is no route from the recorded value to a tag.
#      The recorded value IS the OCI content digest the run mounted
#      (`sandbox/env_image.rs` — the resolved digest is what `provide()` returns), which is
#      what makes the by-digest pull exact and a tag lookup unnecessary.
#      The artifact IS the squashfs; there is no container to `docker cp` out of.
#   3. run this against it.
#
# POSIX sh (no bashisms) to match the other scripts in this directory.

set -eu

# The lock paths every shipped recipe writes, in the order they are searched. Two
# entries, because the two ecosystems put their environment in different places and
# neither is negotiable: python's venv lives at /opt/venv, R's library under
# /usr/local/lib/R. Adding a recipe adds a line here; there is nothing to derive it from
# on the OUTSIDE of an image, which is exactly why it is written down rather than
# guessed.
LOCK_PATHS='/opt/venv/.cyto-env-lock.txt /usr/local/lib/R/.cyto-env-lock.txt'

SUBJECT=${1:-}
MODE=${2:-}

if [ -z "$SUBJECT" ]; then
    echo "usage: $0 <rootfs.squashfs|extracted-root> [--path]" >&2
    echo "  prints the frozen dependency-closure lock the env image carries." >&2
    echo "  searched, in order: $LOCK_PATHS" >&2
    exit 2
fi

if [ "$MODE" = "--path" ]; then
    printf '%s\n' $LOCK_PATHS
    exit 0
fi

if [ ! -e "$SUBJECT" ]; then
    echo "FAIL: $SUBJECT does not exist. There is nothing to read a lock out of, and" >&2
    echo "      reading nothing is not an answer." >&2
    exit 1
fi

emit_from_dir() {
    root=$1
    for p in $LOCK_PATHS; do
        # SYMLINKS ARE REFUSED, and this is the whole reason the extracted-root path is
        # not a plain `cat`. The documented way to get here is `oras pull` of a REMOTE
        # artifact, so the subject is by construction a blob this machine did not build.
        # An archive whose lock path is an absolute symlink made this script read and print
        # an arbitrary HOST file — labelled as the image's provenance record, which is the
        # most convincing possible frame for it. A blind audit demonstrated it end to end.
        # `-h` is POSIX; the check comes BEFORE `-s`, because `-s` follows the link.
        # THE WHOLE PATH, not the leaf. `[ -h "$root$p" ]` is FALSE when the lock is a
        # regular file reached through a symlinked ANCESTOR directory, and `unsquashfs`
        # reproduces a directory symlink from the image verbatim. An audit built an archive
        # whose only link was `usr/local/lib/R -> ../../../../outside` — no file symlink
        # anywhere — and this reader printed a file from OUTSIDE the extracted root under
        # the header `# env lock: …`, which is the exact disclosure the leaf check was
        # added to stop. The escape depth is the attacker's to choose, so enumerating
        # components is the only check that closes it.
        esc=""
        probe="$root"
        rest=$p
        while [ -n "$rest" ]; do
            seg=${rest%%/*}
            rest=${rest#"$seg"}
            rest=${rest#/}
            [ -n "$seg" ] || continue
            probe="$probe/$seg"
            if [ -h "$probe" ]; then esc=$probe; break; fi
        done
        if [ -n "$esc" ]; then
            echo "FAIL: $esc is a SYMLINK. Refused: the lock path must be a real file" >&2
            echo "      reached through real directories. Following a link — at ANY" >&2
            echo "      component, not just the last — would read whatever it points at," >&2
            echo "      plausibly a path on THIS host, and print it labelled as the" >&2
            echo "      image's dependency lock. An image whose lock is reached by a link" >&2
            echo "      is not an image whose lock can be trusted." >&2
            return 1
        fi
        if [ -h "$root$p" ]; then
            echo "FAIL: $p inside the image is a SYMLINK, not a file. Refused: following it" >&2
            echo "      would read whatever it points at — plausibly a path on THIS host —" >&2
            echo "      and print it labelled as the image's dependency lock. An image whose" >&2
            echo "      lock is a link is not an image whose lock can be trusted." >&2
            return 1
        fi
        [ -s "$root$p" ] || continue
        # A NON-EMPTY FILE IS NOT A LOCK. The freeze step writes a header before any
        # package line, so a lock that recorded ZERO packages is a four-line file that
        # passes every emptiness test and answers "which versions did this run use?" with
        # nothing at all. That is the exact artefact this script's header claims to
        # foreclose, so it is checked rather than assumed: at least one line that is not a
        # comment and looks like `<name>==<version>`.
        n=$(grep -c '^[^#][^=]*==' "$root$p" 2>/dev/null || true)
        if [ "${n:-0}" -lt 1 ]; then
            echo "FAIL: $p exists but contains ZERO package lines — only headers and/or" >&2
            echo "      comments. A lock that records no versions cannot answer 'which" >&2
            echo "      versions did this run use', and printing its header as if it could" >&2
            echo "      is worse than refusing. Rebuild the recipe: the freeze step is what" >&2
            echo "      writes the package lines, and one that ran after a trim writes none." >&2
            return 1
        fi
        echo "# env lock: $p ($n package line(s))" >&2
        cat "$root$p"
        return 0
    done
    echo "FAIL: no dependency-closure lock found under $root." >&2
    echo "      Looked for: $LOCK_PATHS" >&2
    echo "      An image with no lock cannot answer 'which versions did this run use',"  >&2
    echo "      and this script will not pretend otherwise. Rebuild the recipe — the" >&2
    echo "      freeze step is what writes it." >&2
    return 1
}

if [ -d "$SUBJECT" ]; then
    emit_from_dir "${SUBJECT%/}"
    exit $?
fi

# A file: treat it as a squashfs.
if ! command -v unsquashfs >/dev/null 2>&1; then
    echo "FAIL: $SUBJECT is a file, so it is treated as a squashfs, but unsquashfs is not" >&2
    echo "      on PATH. Install squashfs-tools, or pass an already-extracted root." >&2
    exit 1
fi
# READ FROM INSIDE THE ARCHIVE; DO NOT EXTRACT IT.
#
# `unsquashfs -cat <path>` streams one entry to stdout without writing anything to disk and
# without resolving a link out of the archive. Extracting first was two problems: a hostile
# archive got to write into a temp tree (squashfs-tools before 4.5.1 has directory-traversal
# bugs on extract, CVE-2021-41072 / CVE-2021-40153, and 4.5 is what this box ships), and a
# ~700 MB unpack with no size cap ran before anything was read. The subject arrives from a
# registry pull; treating it as trusted because it is addressed by digest confuses "I know
# WHICH bytes these are" with "I know what they contain".
for p in $LOCK_PATHS; do
    # SYMLINKS ARE REFUSED HERE TOO. `unsquashfs -cat` blocks an absolute or root-escaping
    # link, but follows an in-archive RELATIVE one and streams the target's bytes — so the
    # same image got OPPOSITE verdicts from this tool's two documented modes: archive mode
    # printed an unrelated in-image file as the dependency lock, directory mode refused it.
    # A provenance answer that depends on which invocation the operator typed is not an
    # answer. `-lls` prints a long listing whose first character is the file type.
    # `unsquashfs -lls` prints the entry as `squashfs-root<path>`, and for a link appends
    # ` -> <target>`. Match that field wherever it sits on the line and read the type from
    # the first character of the mode string.
    ftype=$(unsquashfs -lls "$SUBJECT" "$p" 2>/dev/null \
            | awk -v want="squashfs-root$p" '{ for (i=1;i<=NF;i++) if ($i == want) { print substr($1,1,1); exit } }')
    if [ "${ftype:-}" = "l" ]; then
        echo "FAIL: $p inside the archive is a SYMLINK, not a file. Refused, for the same" >&2
        echo "      reason the extracted-root path refuses one: the target is chosen by" >&2
        echo "      whoever built the image, and its bytes would be printed labelled as" >&2
        echo "      that image's dependency lock." >&2
        exit 1
    fi
    # `-cat` writes nothing and exits non-zero when the path is absent, so the loop simply
    # tries each. `-no-exit-code` is deliberately NOT used: the exit code is the probe.
    if out=$(unsquashfs -cat "$SUBJECT" "$p" 2>/dev/null) && [ -n "$out" ]; then
        n=$(printf '%s\n' "$out" | grep -c '^[^#][^=]*==' || true)
        if [ "${n:-0}" -lt 1 ]; then
            echo "FAIL: $p exists in the archive but contains ZERO package lines — only" >&2
            echo "      headers and/or comments. A lock that records no versions cannot" >&2
            echo "      answer 'which versions did this run use'." >&2
            exit 1
        fi
        echo "# env lock: $p ($n package line(s), read from inside the archive)" >&2
        printf '%s\n' "$out"
        exit 0
    fi
done
echo "FAIL: no dependency-closure lock found inside $SUBJECT." >&2
echo "      Looked for: $LOCK_PATHS" >&2
echo "      An image with no lock cannot answer 'which versions did this run use', and" >&2
echo "      this script will not pretend otherwise. (If the archive is not a squashfs," >&2
echo "      unsquashfs reports that too — a non-squashfs subject reaches this same" >&2
echo "      refusal rather than being silently accepted.)" >&2
exit 1
