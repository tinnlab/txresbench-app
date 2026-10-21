#!/usr/bin/env bash
#
# check-aggregate.sh — run EVERY leg of an aggregate gate, then report ALL of them.
#
# ── WHY THIS EXISTS (#287) ──────────────────────────────────────────────────────
# `just check` is the one command a person runs to ask "is the tree healthy?". It was
# nine sequential recipe lines, and `just` — like `make` — runs each line as a separate
# command and ABORTS ON THE FIRST NON-ZERO EXIT. Line 2 (`npm run check`) was red on
# main, so SEVEN of the nine legs were unreachable: `check-py`, `check-packages`,
# `check-coercion`, `check-processor-versions`, `check-invariants`, `check-r-regime` and
# the ui build never ran at all. The aggregate answered a question about TWO of its nine
# legs while presenting itself as answering about nine.
#
# That is worse than a missing gate, because it is indistinguishable from a working one.
# Two of the hidden legs had caught real defects in the days before this was written
# (`check-processor-versions` blocked a behaviour change at an unbumped version;
# `check-invariants` was itself red in a way the recipe could never reveal).
#
# ── THE PRINCIPLE (docs/design/aggregate-gate-reporting.md §2) ──────────────────
#   An aggregate gate runs every leg it names and reports every leg's result. A leg's
#   failure changes the aggregate's VERDICT; it never changes which legs RUN.
#
# The verdict and the traversal are two different things, and abort-on-first-failure
# conflates them. This script separates them: each leg runs with its failure CONTAINED,
# the exit codes are COLLECTED, and the aggregate's own exit code is derived at the end
# from the collected set. Running everything must NOT turn a failing aggregate into a
# passing one — that would be strictly worse than aborting — and the summary must NAME
# which legs failed and which passed, because a bare "something failed" just repeats the
# original defect one level up.
#
# ── WHAT THIS SCRIPT DOES NOT DO ────────────────────────────────────────────────
# It knows NOTHING about any particular leg. The leg list lives in the `check:` recipe
# in the justfile, which is where a reader looks to learn what `just check` checks (and
# which an existing pytest parses). Legs are read from stdin, run in the order given,
# never reordered and never parallelized.
#
# ── THE FLOOR (docs/design/derived-guards.md §2) ────────────────────────────────
# A runner that reads zero legs and reports success is the same vacuous green this whole
# script exists to remove, so `--min-legs N` fails closed when fewer than N legs were
# read — a leg quietly dropped from the recipe, or a heredoc that stops expanding,
# reddens instead of shrinking the gate silently.
#
# ── USAGE ───────────────────────────────────────────────────────────────────────
#   scripts/check-aggregate.sh [--label NAME] [--min-legs N] [--controls-leg NAME] <<'LEGS'
#   <leg-name> <shell command …>
#   <leg-name> <shell command …>
#   LEGS
#
# One leg per line: the first whitespace-delimited token is the leg's NAME, the rest of
# the line is a shell command handed to `bash -c`. Blank lines and `#` comments are
# ignored. `--controls-leg NAME` marks the leg that verifies THIS runner: if it fails,
# the summary says so loudly, because every other result in that run is then unverified.
#
# Exit 0 = every leg passed.  1 = at least one leg FAILED (named in the summary).
# 2 = the aggregate could not be run correctly (no legs, floor breach, bad usage) —
# deliberately distinct from a leg failure, the same split `check-guard-integrity.sh`
# uses.
#
# NOTE: `set -e` is deliberately ABSENT. Containing each leg's failure is the entire
# point; an errexit here would restore the defect.

set -uo pipefail

# ── THE ENVIRONMENT IS PART OF THE GATE ─────────────────────────────────────────
# `bash` sources $BASH_ENV before every non-interactive script, and $SHELLOPTS /
# $BASHOPTS are applied before the first line runs. Either can make every leg a no-op
# that this runner then faithfully reports as PASS — an aggregate that ran ten legs and
# executed nothing. This repo already names that threat one level down: `check-py`
# invokes pytest as `env -u PYTEST_ADDOPTS …` precisely because a gate an env var can
# redirect is weakenable from outside the diff.
#
# So: refuse loudly here, and strip the same variables from every leg below. Refusing
# rather than silently unsetting is deliberate — if something in this environment set
# BASH_ENV, the operator needs to know, not to have it quietly removed.
# Only BASH_ENV and ENV are checked here: bash sets SHELLOPTS/BASHOPTS as ordinary shell
# variables on EVERY invocation, so testing those would refuse every honest run. They are
# still stripped from each leg below, where the distinction does not arise.
#
# Honest limit: an INHERITED `SHELLOPTS=noexec` cannot be detected from inside a script it
# has already disabled — but it equally disables `just`, `bash`, and everything else on the
# box, so it is "the attacker controls your shell", not a gap in this gate.
for poisoned in BASH_ENV ENV; do
  if [ -n "${!poisoned:-}" ]; then
    echo "check-aggregate: refusing to run with \$$poisoned set ('${!poisoned}')." >&2
    echo "  bash sources it before every leg, so it can turn each gate into a no-op that" >&2
    echo "  this runner would then report as PASS — ten legs run, nothing executed." >&2
    echo "  Unset it and re-run." >&2
    exit 2
  fi
done

LABEL='aggregate'
MIN_LEGS=0
CONTROLS_LEG=''

usage() {
  echo "usage: $0 [--label NAME] [--min-legs N] [--controls-leg NAME]   # legs on stdin"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --label)        shift; [ $# -gt 0 ] || { echo "check-aggregate: --label needs a value" >&2; exit 2; }; LABEL="$1" ;;
    --label=*)      LABEL="${1#*=}" ;;
    --min-legs)     shift; [ $# -gt 0 ] || { echo "check-aggregate: --min-legs needs a value" >&2; exit 2; }; MIN_LEGS="$1" ;;
    --min-legs=*)   MIN_LEGS="${1#*=}" ;;
    --controls-leg) shift; [ $# -gt 0 ] || { echo "check-aggregate: --controls-leg needs a value" >&2; exit 2; }; CONTROLS_LEG="$1" ;;
    --controls-leg=*) CONTROLS_LEG="${1#*=}" ;;
    -h|--help)      usage; exit 0 ;;
    *)              echo "check-aggregate: unknown argument '$1'" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

case "$MIN_LEGS" in
  ''|*[!0-9]*) echo "check-aggregate: --min-legs must be a non-negative integer, got '$MIN_LEGS'" >&2; exit 2 ;;
esac
# ...and BOUNDED. A digits-only check alone accepts a value past 2^63-1, at which point
# `[ "$n" -lt "$MIN_LEGS" ]` errors instead of comparing — and because `set -e` is
# deliberately absent (above), the floor would then be SKIPPED and the run would go green
# over any leg set at all. A floor that fails open is worse than none, so the range is
# checked too. No aggregate has ten thousand legs.
if [ "${#MIN_LEGS}" -gt 4 ]; then
  echo "check-aggregate: --min-legs '$MIN_LEGS' is out of range (max 9999)." >&2
  echo "  A value this large cannot be compared as an integer by the shell, and an" >&2
  echo "  uncomparable floor silently stops being a floor." >&2
  exit 2
fi

# ── read the leg definitions ────────────────────────────────────────────────────
names=()
cmds=()
lineno=0
while read -r name cmd || [ -n "${name:-}" ]; do
  lineno=$((lineno + 1))
  [ -n "$name" ] || continue
  case "$name" in '#'*) continue ;; esac
  if [ -z "$cmd" ]; then
    echo "check-aggregate: leg '$name' (stdin line $lineno) declares no command." >&2
    echo "  A leg line is '<name> <shell command …>'; a name on its own would run nothing" >&2
    echo "  and report PASS, which is the vacuous green this runner exists to remove." >&2
    exit 2
  fi
  # The SAME vacuous green, one character over. `bash -c '# just check-invariants'` runs
  # nothing and exits 0, so an INLINE `#` — the natural way somebody temporarily mutes a
  # leg — would report the leg PASS while the leg COUNT stays put, defeating the floor too.
  # A commented-out leg must be DELETED (which the floor then catches), never muted in place.
  case "$cmd" in
    '#'*)
      echo "check-aggregate: leg '$name' (stdin line $lineno) has a commented-out command." >&2
      echo "  '$cmd' runs nothing and exits 0, so the leg would be reported PASS having" >&2
      echo "  executed no gate at all. Delete the leg line instead — the --min-legs floor" >&2
      echo "  is what makes that removal visible." >&2
      exit 2
      ;;
  esac
  # Duplicate names defeat the floor by construction: swapping one leg for a second copy of
  # another keeps the COUNT identical while silently dropping a real gate, which is exactly
  # the shrunken set INV-4 exists to refuse.
  for prior in ${names[@]+"${names[@]}"}; do
    if [ "$prior" = "$name" ]; then
      echo "check-aggregate: duplicate leg name '$name' (stdin line $lineno)." >&2
      echo "  Leg names must be unique: a duplicate keeps the leg COUNT while replacing a" >&2
      echo "  real gate, so the --min-legs floor would never notice the gate that vanished." >&2
      exit 2
    fi
  done
  names+=("$name")
  cmds+=("$cmd")
done

n=${#names[@]}

if [ "$n" -eq 0 ]; then
  echo "check-aggregate [$LABEL]: NO LEGS — read zero leg definitions on stdin." >&2
  echo "  Reporting success over an empty set is the vacuous green this runner exists" >&2
  echo "  to remove, so this is a hard failure. Check the caller's heredoc." >&2
  exit 2
fi

# A `--controls-leg` that names no leg silently disables the "results are unverified"
# banner — and two recipes now rely on that banner as the property that replaced their
# controls-first ABORT. A typo or a leg rename must not quietly remove it.
if [ -n "$CONTROLS_LEG" ]; then
  controls_found=0
  for nm in "${names[@]}"; do
    [ "$nm" = "$CONTROLS_LEG" ] && controls_found=1
  done
  if [ "$controls_found" -eq 0 ]; then
    echo "check-aggregate [$LABEL]: --controls-leg '$CONTROLS_LEG' names no declared leg." >&2
    echo "  Legs read: ${names[*]}" >&2
    echo "  Left unchecked this silently disables the 'every other result above is" >&2
    echo "  unverified' banner, which is the property that replaced the controls-first abort." >&2
    exit 2
  fi
fi

if [ "$n" -lt "$MIN_LEGS" ]; then
  echo "check-aggregate [$LABEL]: LEG FLOOR BREACHED — read $n leg(s), floor is $MIN_LEGS." >&2
  echo "  Legs read: ${names[*]}" >&2
  echo "  A leg has been dropped from the caller, or its heredoc stopped expanding. Do" >&2
  echo "  NOT lower the floor to go green — the floor is what makes a shrinking gate" >&2
  echo "  visible (docs/design/derived-guards.md §2)." >&2
  exit 2
fi

# ── run every leg, in order, with its failure contained ─────────────────────────
rcs=()
secs=()
failed=0

for i in "${!names[@]}"; do
  idx=$((i + 1))
  printf '\n────── %s: leg %d/%d — %s ──────\n' "$LABEL" "$idx" "$n" "${names[$i]}"
  printf '$ %s\n\n' "${cmds[$i]}"
  start=$SECONDS
  env -u BASH_ENV -u ENV -u SHELLOPTS -u BASHOPTS bash -c "${cmds[$i]}" </dev/null
  rc=$?
  elapsed=$((SECONDS - start))
  rcs+=("$rc")
  secs+=("$elapsed")
  if [ "$rc" -ne 0 ]; then
    failed=$((failed + 1))
    printf '\n────── %s: leg %d/%d — %s: FAIL (exit %d, %ds) ──────\n' "$LABEL" "$idx" "$n" "${names[$i]}" "$rc" "$elapsed"
  else
    printf '\n────── %s: leg %d/%d — %s: PASS (%ds) ──────\n' "$LABEL" "$idx" "$n" "${names[$i]}" "$elapsed"
  fi
done

# ── the summary: every leg, named, with its own verdict ─────────────────────────
printf '\n════════ %s — SUMMARY (%d legs, all of them ran) ════════\n' "$LABEL" "$n"
failed_names=()
for i in "${!names[@]}"; do
  if [ "${rcs[$i]}" -eq 0 ]; then
    verdict='PASS'
  else
    verdict="$(printf 'FAIL(%d)' "${rcs[$i]}")"
    failed_names+=("${names[$i]}")
  fi
  printf '  %-9s %-28s %ds\n' "$verdict" "${names[$i]}" "${secs[$i]}"
done

if [ "$failed" -eq 0 ]; then
  printf '\n%s: PASS — %d/%d legs passed.\n' "$LABEL" "$n" "$n"
  exit 0
fi

printf '\nFAILED LEGS (%d of %d): %s\n' "$failed" "$n" "${failed_names[*]}"
if [ -n "$CONTROLS_LEG" ]; then
  for fn in "${failed_names[@]}"; do
    if [ "$fn" = "$CONTROLS_LEG" ]; then
      printf '\n!! this gate'"'"'s own integrity control FAILED — every other result above is unverified.\n'
      printf '   %s is the leg that establishes this gate can be trusted to report at all;\n' "$CONTROLS_LEG"
      printf '   with it red, a PASS above means only "the command exited 0", not "the gate holds".\n'
      break
    fi
  done
fi
printf '\n%s: FAIL — %d/%d legs passed, %d failed.\n' "$LABEL" "$((n - failed))" "$n" "$failed"
exit 1
