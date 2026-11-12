#!/usr/bin/env sh
# run-r-tests.sh — TEST-5/TEST-6/TEST-7 for #192 (the R dependency + pinning regime).
#
# ── WHY THIS RUNS THE SHIPPED BYTES INSTEAD OF ASSERTING ABOUT THEM ─────────────────
# The regime's load-bearing R logic — the pin parser, the resolution-coordinate reader
# and the closure-lock writer — lives INSIDE `../Dockerfile`, in a heredoc delimited by
# `TXR_REGIME_R`. It lives there rather than in a sibling `.R` file because the recipe
# is deliberately two files: `watched_env_pin_files` watches exactly `Dockerfile` +
# `requirements.txt` for cargo's `rerun-if-changed`, so a third file would change without
# re-triggering the build gate. (The rootfs freshness key is a second reason often quoted
# for this, and it is not currently true — see the Dockerfile's own note above the block.)
#
# That would normally leave only one way to check it: a static predicate over the
# Dockerfile's text. This repository has now been burned by that three times over — a
# predicate is defeated by the next spelling (a comment carrying the token, a block
# scalar, an `echo`, a decoy `COPY --from=`, a stubbed binary), never by a real defect in
# the shipped artifact. So this script EXTRACTS the exact block by its delimiter and
# EXECUTES it under `Rscript` against fixtures. What is tested is the shipped bytes.
#
# ── A DOCKERFILE DIFF IS NOW A CODE DIFF. REVIEW IT AS ONE. ────────────────────────
# Because this script executes a block of `../Dockerfile` and `just check` runs this
# script, the content of that Dockerfile is executed on every machine that runs the gate —
# no container, no privilege drop, full user rights. `cargo check` already executes
# `build.rs`, so "the gate runs repo code" is not new; what is new is the FILE CLASS.
# The extraction is anchored and single-block (above) so an unrelated line cannot smuggle
# code in, but the block ITSELF is executable and always will be. Treat a change to it
# with the scrutiny a `.sh` change gets.
#
# ── WHY A SCRIPT AND NOT A `#[test]` OR A pytest ───────────────────────────────────
# Its subject needs an R interpreter, which the python and rust suites do not require.
# Following `scripts/verify-r-rootfs-local.sh`'s precedent: it REFUSES when its subject
# is missing rather than skipping green, it is re-runnable by anyone, and its output is
# what a lifecycle run records as evidence. A pytest that silently skipped without R is
# how a check quietly stops being run.
#
# ── USAGE ──────────────────────────────────────────────────────────────────────────
#   src-app/env-rootfs/single-cell-r/tests/run-r-tests.sh
#
# POSIX sh (no bashisms) to match the other scripts in this tree.

set -eu

HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
RECIPE=$(CDPATH='' cd -- "$HERE/.." && pwd)
REPO_ROOT=$(CDPATH='' cd -- "$RECIPE/../../.." && pwd)
DOCKERFILE="$RECIPE/Dockerfile"
PINS="$RECIPE/requirements.txt"
DELIM=TXR_REGIME_R

if ! command -v Rscript >/dev/null 2>&1; then
    echo "FAIL: Rscript is not on PATH. The R half of the pinning regime cannot be" >&2
    echo "      verified without an R interpreter, and 'not verified' is not a pass." >&2
    echo "      Install R (apt-get install r-base-core) and re-run." >&2
    exit 1
fi
[ -f "$DOCKERFILE" ] || { echo "FAIL: no Dockerfile at $DOCKERFILE" >&2; exit 1; }
[ -f "$PINS" ] || { echo "FAIL: no pin file at $PINS" >&2; exit 1; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM

# ── EXTRACT THE REGIME BLOCK — AND WHY THE ANCHORING IS A SECURITY PROPERTY ─────────
# This script EXECUTES what it extracts, under `Rscript`, on the developer's host, and
# `just check` runs it. So the extraction rule decides what code runs.
#
# The first cut matched `$0 ~ "<<'TXR_REGIME_R'"` — an UNANCHORED regex, anywhere on any
# line, with no requirement that it be the heredoc opener and no check that exactly one
# block exists. A blind audit turned that into arbitrary code execution with a Dockerfile
# COMMENT: any line merely CONTAINING the string starts a second capture, everything up to
# the next bare terminator is appended, and `Rscript` runs it. Its demonstration printed
# `id -un; hostname` and the suite still reported PASS. A Dockerfile-only PR — a file class
# reviewers reasonably read as inert on the host — became a code PR.
#
# So: the opener must be the EXACT line the recipe writes, both markers must occur exactly
# ONCE, and a mismatch is a refusal rather than a best-effort extraction.
OPENER="cat > /tmp/txr-regime.R <<'$DELIM'"
n_open=$(grep -c -x -F -- "$OPENER" "$DOCKERFILE" || true)
n_close=$(grep -c -x -F -- "$DELIM" "$DOCKERFILE" || true)
if [ "${n_open:-0}" -ne 1 ] || [ "${n_close:-0}" -ne 1 ]; then
    echo "FAIL: expected EXACTLY ONE '$DELIM' heredoc opener and ONE terminator in" >&2
    echo "      $DOCKERFILE; found $n_open opener(s) and $n_close terminator(s)." >&2
    echo "      This script EXECUTES what it extracts, so more than one block — or a" >&2
    echo "      terminator with no opener — is refused rather than concatenated. If the" >&2
    echo "      recipe legitimately moved the block, update OPENER here in the same diff." >&2
    exit 1
fi
# Everything strictly between the two, matched as WHOLE LINES.
awk -v opener="$OPENER" -v d="$DELIM" '
    !inblk && $0 == opener { inblk = 1; next }
    inblk && $0 == d       { inblk = 0; next }
    inblk                  { print }
' "$DOCKERFILE" > "$WORK/regime.R"

if [ ! -s "$WORK/regime.R" ]; then
    echo "FAIL: the '$DELIM' block in $DOCKERFILE is empty." >&2
    echo "      An extraction that finds nothing is a test of nothing, and it refuses" >&2
    echo "      rather than passing vacuously." >&2
    exit 1
fi
echo "extracted $(wc -l < "$WORK/regime.R") lines of regime R from the recipe"

echo "== TEST-5 / TEST-6: the regime functions, run =="
Rscript --vanilla "$HERE/regime_test.R" "$WORK/regime.R" "$PINS"

# ── TEST-P16, BEHAVIOURALLY (#214 round 4) ───────────────────────────────────────────
#
# THIS REPLACES A PREDICATE THAT HAS NOW BEEN DEFEATED THREE TIMES.
#
# The claim is "regime_test.R has no line rule of its own — it reads the pin file through
# the shipped `txr_read_pin_lines`". Three attempts to assert that over the suite's SOURCE
# were each defeated by the next spelling:
#
#   round 2  `length(x) == length(x)`                      — a tautology
#   round 3  grep for the call, needle in its own message   — always green
#   round 4  parse-tree walk for the `pin_lines` assignment — defeated by a one-line ALIAS
#            (`txr_read_pin_lines <- function(p) readLines(p, warn = FALSE)`), and by `=`,
#            `assign()` and a nested block
#
# A fourth predicate would be the fourth predicate. `docs/design/derived-guards.md` and the
# lifecycle's own GUARD-SUB rule say the same thing: when a round's findings concentrate on
# one guard, the remedy is never another predicate — replace it with a test of the BEHAVIOUR
# the predicate was standing in for.
#
# The behaviour: a suite that goes through `txr_read_pin_lines` inherits the canonical-bytes
# precondition, so a POISONED pin file makes it FAIL. A suite with a private `readLines`
# does not — that is the entire difference between the two, and it is observable from
# outside without reading a line of the suite's source.
#
# So: run the suite a second time against a pin file carrying a lone CR, and require it to
# refuse, naming the byte. Every mutant that defeated the source predicates — the alias, the
# `=` assignment, `assign()`, the nested block — reads the file with `readLines` and does
# NOT refuse, so every one of them fails here.
echo "== TEST-P16: the suite refuses a POISONED pin file (behavioural) =="
POISONED="$WORK/poisoned-requirements.txt"
# A lone CR spliced into a comment line: invisible to a line-splitting reader by
# construction, which is why it is the byte that separates the two readers.
#
# Built with printf. The first cut put a literal CR inside an awk program, which is a
# runaway string constant on some awks — it failed loudly, which is the right direction
# for a thing whose job is to build a test input, but it is worth not repeating.
CR=$(printf '\r')
{ printf '# see the runbook%s# txr:note\n' "$CR"; cat "$PINS"; } > "$POISONED"
if ! grep -q "$CR" "$POISONED"; then
    echo "FAIL: the poisoned fixture carries no CR — this case would prove nothing." >&2
    exit 1
fi
set +e
POISON_OUT=$(Rscript --vanilla "$HERE/regime_test.R" "$WORK/regime.R" "$POISONED" 2>&1)
POISON_RC=$?
set -e
if [ "$POISON_RC" -eq 0 ]; then
    echo "FAIL: the suite ACCEPTED a pin file containing a lone CR." >&2
    echo "      That means it is not reading through \`txr_read_pin_lines\`, so it does not" >&2
    echo "      inherit the canonical-bytes precondition — it has a line rule of its own," >&2
    echo "      which is the fourth opinion about where a line ends that #214 removed." >&2
    exit 1
fi
case "$POISON_OUT" in
    *"U+000D"*) echo "  ok   a poisoned pin file is REFUSED, naming the byte" ;;
    *) echo "FAIL: the suite refused the poisoned pin file, but not for the CR." >&2
       echo "      It must fail via the canonical-bytes precondition (U+000D), not for" >&2
       echo "      some incidental reason — otherwise this case cannot tell the two apart." >&2
       printf '%s
' "$POISON_OUT" | tail -5 >&2
       exit 1 ;;
esac
# CONTROL: the same suite, same harness, the REAL pin file — already run above and green.
# Without it, "the poisoned run failed" is equally consistent with the suite being broken.

echo "== TEST-7: scripts/env-lock-of.sh =="
sh "$HERE/env_lock_of_test.sh" "$REPO_ROOT"

echo "ALL R-REGIME TESTS PASSED"
