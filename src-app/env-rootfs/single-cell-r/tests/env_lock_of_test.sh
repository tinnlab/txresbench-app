#!/usr/bin/env sh
# env_lock_of_test.sh — TEST-7 for #192: RUN `scripts/env-lock-of.sh`, do not read it.
#
# The subject is the executable half of the by-reference provenance answer (DEC-8): given
# an env image, produce the frozen closure lock a run's recorded `env_rootfs_sha256`
# identifies. The three properties that matter are that it FINDS the lock, that it
# REFUSES when there is none, and that it never returns 0 for a subject it could not read
# — the last one being the whole reason it is a script and not a silent helper.
#
# The fixture is an extracted-root directory, which is what `unsquashfs` produces and
# what this box can build without docker.

set -eu

REPO_ROOT=${1:-}
[ -n "$REPO_ROOT" ] || { echo "usage: $0 <repo-root>" >&2; exit 2; }
SCRIPT="$REPO_ROOT/scripts/env-lock-of.sh"
[ -f "$SCRIPT" ] || { echo "FAIL: no $SCRIPT" >&2; exit 1; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM
# The declared search order, asserted rather than assumed by the case below.
LOCK_PATHS_EXPECTED_FIRST=/opt/venv/.txresbench-env-lock.txt
fails=0
ok()  { echo "  ok   $1"; }
bad() { fails=$((fails + 1)); echo "  FAIL $1"; echo "         $2"; }

# ── a root that carries an R lock ─────────────────────────────────────────────────
mkdir -p "$WORK/withlock/usr/local/lib/R"
cat > "$WORK/withlock/usr/local/lib/R/.txresbench-env-lock.txt" <<'EOF'
# R 4.6.1
# bioconductor 3.23
Matrix==1.7-6  # source=CRAN
scDblFinder==1.26.7  # source=Bioconductor 3.23/bioc
EOF

out=$(sh "$SCRIPT" "$WORK/withlock" 2>/dev/null) && rc=0 || rc=$?
if [ "${rc:-0}" -ne 0 ]; then
    bad "a root carrying a lock is read" "exit $rc"
elif ! printf '%s' "$out" | grep -q 'scDblFinder==1.26.7  # source=Bioconductor 3.23/bioc'; then
    bad "a root carrying a lock is read" "the lock's own lines were not printed: $out"
else
    # HONEST LABEL: the reader does not transform the file, so "package/version/source
    # intact" was a claim about `cat`. What this proves is that the right FILE is selected
    # and emitted verbatim — which is the property that matters for a reader, and the one
    # that breaks if LOCK_PATHS or the selection order ever changes.
    ok "the R lock path is selected and emitted verbatim"
fi

# ── LOCK_PATHS ORDER, and the `--path` mode ──────────────────────────────────────
# The first case above claims to prove "the right FILE is selected ... the one that breaks
# if LOCK_PATHS or the selection order ever changes". No fixture carried BOTH lock paths,
# so only MEMBERSHIP was exercised and reversing the order left every case green. A root
# carrying both is the only fixture that can see the order.
mkdir -p "$WORK/bothlocks/usr/local/lib/R" "$WORK/bothlocks/opt/venv"
printf '# R\nRonly==1.0  # source=CRAN\n' > "$WORK/bothlocks/usr/local/lib/R/.txresbench-env-lock.txt"
printf 'PyOnly==2.0\n' > "$WORK/bothlocks/opt/venv/.txresbench-env-lock.txt"
out=$(sh "$SCRIPT" "$WORK/bothlocks" 2>/dev/null) || out=""
first=$(printf '%s' "$LOCK_PATHS_EXPECTED_FIRST")
case "$out" in
    *PyOnly==2.0*) got=python ;;
    *Ronly==1.0*)  got=r ;;
    *)             got=none ;;
esac
if [ "$got" = "python" ]; then
    ok "a root carrying BOTH locks resolves in LOCK_PATHS order (python first, as declared)"
else
    bad "a root carrying BOTH locks resolves in LOCK_PATHS order" \
        "expected the python path to win, got '$got'; output: $out"
fi

# The second documented mode had no case at all: its body could be replaced with `true`
# and every assertion here stayed green.
if paths=$(sh "$SCRIPT" "$WORK/bothlocks" --path 2>/dev/null); then
    case "$paths" in
        *"/opt/venv/.txresbench-env-lock.txt"*"/usr/local/lib/R/.txresbench-env-lock.txt"*)
            ok "--path prints the searched paths, in the order they are searched" ;;
        *) bad "--path prints the searched paths" "got: $paths" ;;
    esac
else
    bad "--path prints the searched paths" "it exited non-zero"
fi

# ── the SQUASHFS path, which is the one the runbook actually tells operators to use ──
# It was untested: every other case here passes a directory, and the archive branch is
# where the untrusted input arrives. Skipped only if the tool is genuinely absent, and
# then LOUDLY — the case is not silently dropped.
if command -v mksquashfs >/dev/null 2>&1 && command -v unsquashfs >/dev/null 2>&1; then
    mkdir -p "$WORK/sqsrc/usr/local/lib/R"
    printf '# R 4.6.1\nMatrix==1.7-6  # source=CRAN\n' \
        > "$WORK/sqsrc/usr/local/lib/R/.txresbench-env-lock.txt"
    if mksquashfs "$WORK/sqsrc" "$WORK/t.squashfs" -quiet -no-progress >/dev/null 2>&1; then
        if sh "$SCRIPT" "$WORK/t.squashfs" 2>/dev/null | grep -q 'Matrix==1.7-6  # source=CRAN'; then
            ok "a .squashfs subject is read from INSIDE the archive"
        else
            bad "a .squashfs subject is read from INSIDE the archive" "the lock line was not printed"
        fi
        # A HEADER-ONLY archive: the archive branch has its own zero-package refusal, and
        # an audit deleted it outright with this suite green -- every discriminating
        # fixture here was a DIRECTORY, and the two branches are separate code with
        # separate guards.
        mkdir -p "$WORK/sqhdr/usr/local/lib/R"
        printf '# R 4.6.1\n# bioconductor 3.23\n' \
            > "$WORK/sqhdr/usr/local/lib/R/.txresbench-env-lock.txt"
        if mksquashfs "$WORK/sqhdr" "$WORK/h.squashfs" -quiet -no-progress >/dev/null 2>&1; then
            if err=$(sh "$SCRIPT" "$WORK/h.squashfs" 2>&1 >/dev/null); then
                bad "a header-only .squashfs is refused" "it exited 0"
            else
                case "$err" in
                    *"ZERO package lines"*) ok "a header-only .squashfs is refused by the archive branch too" ;;
                    *) bad "a header-only .squashfs is refused" "wrong refusal: $err" ;;
                esac
            fi
        fi

        # A SYMLINKED lock inside the archive. `unsquashfs -cat` blocks an absolute or
        # root-escaping link but follows an in-archive relative one, so before this the two
        # documented modes gave OPPOSITE verdicts on the same image.
        mkdir -p "$WORK/sqlink/usr/local/lib/R" "$WORK/sqlink/decoy"
        printf 'GHOST==9.9.9  # source=CRAN\n' > "$WORK/sqlink/decoy/other.txt"
        ln -s ../../../../decoy/other.txt "$WORK/sqlink/usr/local/lib/R/.txresbench-env-lock.txt"
        if mksquashfs "$WORK/sqlink" "$WORK/l.squashfs" -quiet -no-progress >/dev/null 2>&1; then
            out=$(sh "$SCRIPT" "$WORK/l.squashfs" 2>&1) && rc=0 || rc=$?
            if [ "$rc" -eq 0 ] || printf '%s' "$out" | grep -q 'GHOST'; then
                bad "a SYMLINKED lock inside the archive is refused" \
                    "archive mode followed it where directory mode refuses: $out"
            else
                ok "a symlinked lock inside the archive is refused, like the directory case"
            fi
        fi

        # And an archive with no lock still refuses rather than exiting 0 on nothing.
        mkdir -p "$WORK/sqempty/usr"
        printf 'x\n' > "$WORK/sqempty/usr/placeholder"
        if mksquashfs "$WORK/sqempty" "$WORK/e.squashfs" -quiet -no-progress >/dev/null 2>&1; then
            if sh "$SCRIPT" "$WORK/e.squashfs" >/dev/null 2>&1; then
                bad "a .squashfs with no lock is refused" "it exited 0"
            else
                ok "a .squashfs with no lock is refused"
            fi
        fi
    else
        bad "a .squashfs subject is read from INSIDE the archive" "mksquashfs failed to build the fixture"
    fi
else
    bad "a .squashfs subject is read from INSIDE the archive" \
        "squashfs-tools is absent, so the branch the runbook tells operators to use is UNVERIFIED here — install squashfs-tools; this is reported rather than skipped"
fi

# ── a root that carries none: MUST refuse, and say what it looked for ─────────────
mkdir -p "$WORK/nolock/usr/local/lib/R"
if err=$(sh "$SCRIPT" "$WORK/nolock" 2>&1 >/dev/null); then
    bad "a root with no lock is REFUSED" "it exited 0 — verifying nothing is not a pass"
else
    case "$err" in
        *"no dependency-closure lock found"*"/usr/local/lib/R/.txresbench-env-lock.txt"*)
            ok "a root with no lock is refused, naming the paths it looked for" ;;
        *) bad "a root with no lock is REFUSED" "the refusal did not name the paths: $err" ;;
    esac
fi

# ── an EMPTY lock is not a lock ───────────────────────────────────────────────────
# The failure it forecloses is the python recipe's documented one: a freeze that ran
# after a trim produces a zero-byte file that looks exactly like a lock.
#
# The REFUSAL IS CHECKED BY SUBSTRING, like every other case here. Without it this case
# asserted only "exit non-zero", which the generic not-found branch satisfies — an audit
# removed the `-s` guard AND the package-line count independently and this case stayed
# green through both.
mkdir -p "$WORK/emptylock/opt/venv"
: > "$WORK/emptylock/opt/venv/.txresbench-env-lock.txt"
if err=$(sh "$SCRIPT" "$WORK/emptylock" 2>&1 >/dev/null); then
    bad "an EMPTY lock is refused" "it exited 0 for a zero-byte lock"
else
    case "$err" in
        *"no dependency-closure lock found"*|*"ZERO package lines"*)
            ok "an empty lock is refused, not printed as an answer" ;;
        *) bad "an EMPTY lock is refused" "the refusal was not about the lock: $err" ;;
    esac
fi

# ── a SYMLINKED lock is refused, not followed ────────────────────────────────────
# The documented entry point is `oras pull` of a remote artifact, so the subject is a blob
# this machine did not build. An absolute symlink at the lock path made the reader print
# an arbitrary HOST file labelled as the image's provenance record.
printf 'SECRET_TOKEN==hunter2\n' > "$WORK/host_only_file"
mkdir -p "$WORK/symlink/usr/local/lib/R"
ln -s "$WORK/host_only_file" "$WORK/symlink/usr/local/lib/R/.txresbench-env-lock.txt"
out=$(sh "$SCRIPT" "$WORK/symlink" 2>&1) && rc=0 || rc=$?
if [ "$rc" -eq 0 ]; then
    bad "a SYMLINKED lock is refused" "it exited 0 — it followed the link"
elif printf '%s' "$out" | grep -q 'SECRET_TOKEN'; then
    bad "a SYMLINKED lock is refused" "it printed the link target's contents"
else
    case "$out" in
        *"is a SYMLINK"*) ok "a symlinked lock is refused, and its target is not printed" ;;
        *) bad "a SYMLINKED lock is refused" "the refusal did not say why: $out" ;;
    esac
fi

# ── a HEADER-ONLY lock is not a lock ─────────────────────────────────────────────
# The freeze step writes a header before any package line, so a zero-package lock is a
# non-empty FILE. Every emptiness test passes and the reader prints four comments as if
# they were an answer. This is the case the byte-length check could not see.
mkdir -p "$WORK/headeronly/usr/local/lib/R"
cat > "$WORK/headeronly/usr/local/lib/R/.txresbench-env-lock.txt" <<'EOF'
# R 4.6.1
# bioconductor 3.23
# cran-snapshot https://example/2026-09-01
# direct-pins 18
EOF
if err=$(sh "$SCRIPT" "$WORK/headeronly" 2>&1 >/dev/null); then
    bad "a HEADER-ONLY lock is refused" "it exited 0 and printed a header as if it were an answer"
else
    case "$err" in
        *"ZERO package lines"*) ok "a header-only lock is refused, naming what is missing" ;;
        *) bad "a HEADER-ONLY lock is refused" "the refusal did not say why: $err" ;;
    esac
fi

# -- the package-line GRAMMAR, which nothing constrained -------------------------
# An audit replaced the reader's `^[^#][^=]*==` pattern with a bare `==` and every case
# in this file stayed green: no fixture contained a `# shadowed <pkg>==<ver>` line, and
# the header-only fixture has no `==` at all, so nothing could tell a strict pattern from
# no pattern. The `^[^#]` anchor is the whole reason a provenance COMMENT is not counted
# as an installed package -- and the writer emits exactly such comments for shadowed
# copies. A lock whose only `==` is inside a comment records ZERO packages.
mkdir -p "$WORK/onlyshadow/usr/local/lib/R"
cat > "$WORK/onlyshadow/usr/local/lib/R/.txresbench-env-lock.txt" <<'EOF'
# R 4.6.1
# shadowed Matrix==1.7-5 in /usr/local/lib/R/library (not the copy R loads)
EOF
if err=$(sh "$SCRIPT" "$WORK/onlyshadow" 2>&1 >/dev/null); then
    bad "a lock whose only == is in a COMMENT records zero packages" \
        "it exited 0 -- the reader counted a shadowed-copy comment as an installed package"
else
    case "$err" in
        *"ZERO package lines"*) ok "a shadowed-copy COMMENT is not counted as a package" ;;
        *) bad "a lock whose only == is in a COMMENT records zero packages" "wrong refusal: $err" ;;
    esac
fi

# ...and the converse: a real package line ALONGSIDE a shadowed comment counts ONE.
mkdir -p "$WORK/oneandshadow/usr/local/lib/R"
cat > "$WORK/oneandshadow/usr/local/lib/R/.txresbench-env-lock.txt" <<'EOF'
# R 4.6.1
Matrix==1.7-6  # source=CRAN
# shadowed Matrix==1.7-5 in /usr/local/lib/R/library (not the copy R loads)
EOF
hdr=$(sh "$SCRIPT" "$WORK/oneandshadow" 2>&1 >/dev/null)
case "$hdr" in
    *"(1 package line(s)"*) ok "a real package beside a shadowed comment counts exactly one" ;;
    *) bad "a real package beside a shadowed comment counts exactly one" "got: $hdr" ;;
esac

# -- a symlinked ANCESTOR is refused, not just a symlinked leaf ------------------
# `[ -h "$root$p" ]` is false when the lock is a regular file reached through a symlinked
# DIRECTORY, and unsquashfs reproduces a directory symlink from the image verbatim. An
# audit escaped the extracted root that way with no file symlink anywhere.
mkdir -p "$WORK/ancestor/usr/local/lib" "$WORK/ancestor_outside"
printf 'HOSTFILE==1.0  # source=NOT-FROM-THE-IMAGE\n' \
    > "$WORK/ancestor_outside/.txresbench-env-lock.txt"
ln -s ../../../ancestor_outside "$WORK/ancestor/usr/local/lib/R"
out=$(sh "$SCRIPT" "$WORK/ancestor" 2>&1) && rc=0 || rc=$?
if [ "$rc" -eq 0 ] || printf '%s' "$out" | grep -q 'HOSTFILE'; then
    bad "a symlinked ANCESTOR directory is refused" \
        "it read a file from outside the extracted root: $out"
else
    case "$out" in
        *"is a SYMLINK"*) ok "a symlinked ancestor directory is refused, not just a symlinked leaf" ;;
        *) bad "a symlinked ANCESTOR directory is refused" "wrong refusal: $out" ;;
    esac
fi

# ── a subject that does not exist ────────────────────────────────────────────────
if sh "$SCRIPT" "$WORK/nope" >/dev/null 2>&1; then
    bad "a missing subject is refused" "it exited 0"
else
    ok "a missing subject is refused"
fi

# ── no argument at all ───────────────────────────────────────────────────────────
sh "$SCRIPT" >/dev/null 2>&1 && rc=0 || rc=$?
if [ "$rc" -eq 2 ]; then
    ok "no argument exits 2 with usage"
else
    bad "no argument exits 2 with usage" "exit $rc"
fi

# ── the python lane is covered by the same reader ────────────────────────────────
mkdir -p "$WORK/pylock/opt/venv"
printf 'numpy==2.4.6\n' > "$WORK/pylock/opt/venv/.txresbench-env-lock.txt"
if sh "$SCRIPT" "$WORK/pylock" 2>/dev/null | grep -q 'numpy==2.4.6'; then
    ok "the python recipe's lock path is read by the same script"
else
    bad "the python recipe's lock path is read by the same script" "not found"
fi

if [ "$fails" -ne 0 ]; then
    echo "env_lock_of_test.sh: $fails FAILURE(S)"
    exit 1
fi
echo "env_lock_of_test.sh: PASS"
