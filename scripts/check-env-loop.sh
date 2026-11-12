#!/usr/bin/env bash
# check-env-loop.sh — the BEHAVIOURAL tier for E5 / #193.
#
# TEST-1 [acceptance INV-1] · TEST-5 [acceptance INV-4] · TEST-6 [acceptance INV-5] ·
# TEST-7 · TEST-8 · TEST-9 · TEST-12.
#
# (TEST-12, not TEST-10: TEST-10 is the local-registry end-to-end in
# `env_image_oci_test.rs`. TEST-N is a PER-FEATURE namespace, so an id reused inside one
# feature binds a recorded PASS to the wrong test — the A11 hazard, one level in.)
#
# ── WHY A SCRIPT AND NOT A `#[test]` ────────────────────────────────────────────────
# Every claim below is about what a SHELL does — whether a variable can be exported,
# whether a script refuses, whether a tool was invoked, what a recipe's last line is.
# Asserting those from Rust would mean re-implementing the shell's own answer and then
# trusting the reimplementation. The Rust tier owns the runtime claims (which artifact
# `provide()` mounts); this tier owns the shell ones, and each runs the real thing.
#
# ── EXIT-CODE DISCIPLINE ────────────────────────────────────────────────────────────
# Every command's status is captured DIRECTLY into a variable — never read through a
# pipe, where `$?` is the last stage's status and a real failure reads as a pass. Where
# an exact code is the claim (a refusal is 2, a dry run is 0), the exact code is
# asserted, not merely "non-zero": `verify-r-rootfs-local.sh` was rewritten for exactly
# that reason after "any non-zero means refused" reported PASS for a probe that never
# ran.
#
# ── NO SILENT SKIPS ─────────────────────────────────────────────────────────────────
# A missing tool is a loud non-zero exit naming the tool (DEC-6). This file contains no
# path that exits 0 without having asserted something.
#
# ── HOW IT IS RUN (this was the gap a blind audit found) ────────────────────────────
# The first version of this file was wired to NOTHING: it was the only executable proof
# of five of this feature's tests and its sole reference outside itself was a line in a
# runbook. Exists + self-consistent is not "used" — a regression in the loop's refusal or
# derivation behaviour would have been caught by no gate at all. So:
#
#   just check-guards        -> runs this with --fast (no docker, no staged artifacts)
#   just check-env-loop      -> runs it in full (needs docker + bwrap + staged artifacts)
#
# `--fast` covers every assertion that needs no container runtime and no built image, so
# the cheap gate is never "absent", only narrower — and it says which sections it skipped
# rather than reporting a full pass. The file is also named `check-*` so
# `scripts/check-guard-integrity.sh` PINS its bytes; an un-pinned gate can be gutted in a
# diff nobody reads.
#
# USAGE: bash scripts/check-env-loop.sh [--fast]
FAST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --fast) FAST=1; shift ;;
    *) echo "check-env-loop: unknown argument: $1" >&2; exit 2 ;;
  esac
done

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_ROOT="$ROOT/src-app/env-rootfs"
LOOP="$ROOT/scripts/build-env-rootfs-local.sh"
PUBLISH="$ROOT/scripts/publish-env-rootfs.sh"
PREFLIGHT="$ROOT/scripts/e2e-processors-preflight.sh"

pass_n=0
fail_n=0
CURRENT="(none)"
tcase() { CURRENT="$1"; printf '\n== %s ==\n' "$1"; }
ok()   { pass_n=$((pass_n + 1)); printf '  PASS  %s\n' "$*"; }
bad()  { fail_n=$((fail_n + 1)); printf '  FAIL  [%s] %s\n' "$CURRENT" "$*" >&2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [ "$FAST" = "0" ]; then
  for t in docker unsquashfs squashfuse bwrap sha256sum; do
    command -v "$t" >/dev/null 2>&1 || {
      echo "FAIL: \`$t\` is required and is not on PATH. This tier refuses rather than" >&2
      echo "  skipping: a self-test that no-ops on an under-tooled box is a green signal" >&2
      echo "  certifying nothing, which is the failure class this epic exists to remove." >&2
      echo "  (Use --fast to run only the assertions that need no container runtime.)" >&2
      exit 1
    }
  done
fi

# The two scripts under test must EXIST and be readable before anything reads them.
# Without this, a rename makes `grep -vE ... "$f"` return empty, the no-literal loop below
# ranges over nothing, and the harness reports PASS for a file that is gone.
for f in "$LOOP" "$PUBLISH" "$PREFLIGHT"; do
  [ -r "$f" ] || { echo "FAIL: $f is missing or unreadable — every assertion about it" >&2
                   echo "  would range over nothing and report clean." >&2; exit 1; }
done

# The env set, DERIVED from the recipe tree exactly as the scripts under test derive it.
# Nothing below names an env.
mapfile -t ENV_IDS < <(find "$ENV_ROOT" -mindepth 2 -maxdepth 2 -name Dockerfile \
  -exec dirname {} \; 2>/dev/null | while read -r d; do basename "$d"; done | sort)
# ANTI-VACUITY FLOOR. Derivation is blind to deletion: a reader that stopped seeing the
# recipes would make every loop below range over nothing and report a clean run. The
# floor is 2 because this whole item is about telling two envs apart.
if [ "${#ENV_IDS[@]}" -lt 2 ]; then
  echo "FAIL: derived ${#ENV_IDS[@]} env recipe(s) under $ENV_ROOT; this tier needs >= 2." >&2
  echo "  Either the tree lost a recipe, or this reader has drifted from it. Refusing to" >&2
  echo "  report a pass over an empty set." >&2
  exit 1
fi
FIRST_ENV="${ENV_IDS[0]}"
# The loop's image tag is `txresbench-env-local-<id>:schema<N>-<arch>`; both components are
# derived here the same way it derives them, so this file types neither.
SCHEMA_V="$(grep -E 'const ROOTFS_SCHEMA_VERSION' \
  "$ROOT/src-app/server/src/modules/rootfs/version.rs" | grep -oE '[0-9]+' | tail -1)"
case "$(uname -m)" in
  x86_64|amd64)  ARCH_V=amd64 ;;
  aarch64|arm64) ARCH_V=arm64 ;;
  *)             ARCH_V="$(uname -m)" ;;
esac
ARCH_V="${TXR_ENV_ARCH:-$ARCH_V}"
[ -n "$SCHEMA_V" ] || { echo "FAIL: cannot read ROOTFS_SCHEMA_VERSION" >&2; exit 1; }
printf 'derived %d env recipe(s): %s\n' "${#ENV_IDS[@]}" "${ENV_IDS[*]}"

# ── TEST-9 — the seam variable cannot be `export`ed (ITEM-7) ────────────────────────
# Run, never read. Each of the three forms is EXERCISED and its outcome observed.
#
# HONEST SPLIT, because it affects how much this section is worth: the first three
# assertions are properties of BASH and env(1), not of anything this branch ships — they
# would pass with the whole feature deleted. That is deliberate; they establish the
# PREMISE that makes ITEM-7 a real hazard rather than a story, and a premise that stopped
# holding is exactly what should turn this red. The feature-specific assertions are the
# last three (the loop's own emitted line: its key, its path, and that executing it sets
# that key to that path).
tcase "TEST-9 — the per-env seam key is not a shell identifier"
SEAM_KEY_BASE=TXR_ENV_ROOTFS_SQUASHFS
SEAM_KEY="${SEAM_KEY_BASE}__$FIRST_ENV"
# A PRECONDITION, not an assertion. It exercises nothing — it is a property of a string —
# so counting it as a PASS inflated every mode's total by one and let a banner report it
# as tested behaviour. It stays as a guard against this section going vacuous, and it
# FAILS loudly if the premise ever stops holding.
case "$FIRST_ENV" in
  *-*) echo "  ....  precondition: the derived id '$FIRST_ENV' contains '-', so the claim below is live" ;;
  *)   bad "the derived env id '$FIRST_ENV' has no '-', so this whole section proves
        nothing about the shipped ids. If every id lost its hyphen, delete this section
        rather than letting it pass vacuously." ;;
esac

bash -c "export $SEAM_KEY=/x" >/dev/null 2>&1
rc=$?
if [ "$rc" -ne 0 ]; then ok "bash refuses \`export $SEAM_KEY=...\` (exit $rc)"
else bad "bash ACCEPTED \`export $SEAM_KEY=...\`; the ITEM-7 hazard no longer holds and the
        runbook/loop guidance around it should be revisited rather than left in place"; fi

# EXACT code, per this file's own exit-code discipline. `-ne 0` was satisfied by any
# failure from any cause; the CLAIM is specifically that the shell cannot parse the word
# as an assignment and therefore treats it as a COMMAND NAME it cannot find — which is
# 127, and nothing else. (Asserting the mechanism, not merely the disappointment.)
bash -c "$SEAM_KEY=/x true" >/dev/null 2>&1
rc=$?
if [ "$rc" -eq 127 ]; then
  ok "bash parses \`$SEAM_KEY=... cmd\` as a COMMAND NAME and cannot find it (exit 127)"
else
  bad "the assignment-prefix form exited $rc, not the 127 that means 'parsed as a command
        name'. Either the hazard changed shape or this probe stopped measuring it."
fi

# The working form, and it must reach a GRANDCHILD — a prefix that only reached the
# direct child would be useless to `just`, which spawns through a shell.
# `grep -F -x`, matching the rule this file states for its sibling assertion: the derived
# env id is interpolated here, and a recipe directory containing `.` or `[` would make a
# basic regexp over- or under-match and report a spurious FAIL about a working env(1) form.
got="$(env "$SEAM_KEY=/marker-value" bash -c 'bash -c printenv' 2>/dev/null | grep -c -F -x "$SEAM_KEY=/marker-value")"
if [ "$got" = "1" ]; then ok "\`env '$SEAM_KEY=...' cmd\` works and reaches a grandchild"
else bad "the env(1) form did NOT reach a grandchild (found $got matches); the loop's
        emitted invocation would not work"; fi

# And the line the LOOP EMITS is that working form — proved by EXECUTING it, not by
# matching its text. A test that grepped for `env '` would pass on a line that names the
# wrong path or the wrong key.
if [ "$FAST" = "1" ]; then
  echo "  ....  (--fast) skipping the emitted-seam-line check: it needs a staged artifact"
else
emitted="$("$LOOP" --print-seam 2>/dev/null | head -1)"
if [ -z "$emitted" ]; then
  bad "the loop emitted no seam line (nothing staged?). Build first: $LOOP --all"
else
  emitted_kv="${emitted#env \'}"; emitted_kv="${emitted_kv%\'}"
  emitted_key="${emitted_kv%%=*}"; emitted_path="${emitted_kv#*=}"
  # THE SUBJECT IS NOT DERIVED FROM THE FIXTURE. The first version parsed the key out of
  # the very line under test and then only checked that running the line set THAT key —
  # so `env 'TOTALLY_WRONG_KEY=/no/such/path'` passed, while the comment claimed the
  # check caught "a line that names the wrong path or the wrong key". Both halves are now
  # compared against independently-derived expectations: SEAM_KEY, built at the top of
  # this file from the derived env id, and the file actually existing on disk.
  if [ "$emitted_key" = "$SEAM_KEY" ]; then
    ok "the emitted key is the seam key derived independently ($SEAM_KEY)"
  else
    bad "the loop emitted key '$emitted_key' but the derived seam key is '$SEAM_KEY'"
  fi
  if [ -s "$emitted_path" ]; then ok "the emitted path is an existing non-empty artifact"
  else bad "the loop emitted path '$emitted_path', which is not an existing non-empty file"; fi
  # `grep -F -x`: the path is interpolated from a checkout/cache directory that may
  # legitimately contain a BRE metacharacter (`[`, `*`, `\`), which would make a basic
  # regexp fail or error and produce a spurious FAIL about a correct seam line.
  seen="$(eval "$emitted printenv" 2>/dev/null | grep -c -F -x "$emitted_key=$emitted_path")"
  if [ "$seen" = "1" ]; then ok "executing the emitted line sets $emitted_key to that exact path"
  else bad "executing the loop's emitted seam line did not set $emitted_key=$emitted_path (found $seen)"; fi
fi
fi

# ── TEST-6 — derive, never name (INV-5), and the two derivations agree ──────────────
tcase "TEST-6 — no env-name literal, and both scripts derive the same set"
named=0
for f in "$LOOP" "$PUBLISH"; do
  # Comment-stripped, exactly as `both_publishers_derive_the_env_set_rather_than_naming_one`
  # does it: both files EXPLAIN the retired literal in prose, and a guard that cannot
  # tell an explanation from a re-introduction is a guard the next comment defeats.
  code="$(grep -vE '^[[:space:]]*#' "$f")"
  # ANTI-VACUITY: an unreadable or all-comment file yields an empty `code`, the inner
  # loop then finds nothing, and this reports "names no env" about a file it never read.
  if [ -z "$code" ]; then
    bad "$(basename "$f") has no non-comment source — the no-literal check below would
        range over nothing and report clean"
    continue
  fi
  for id in "${ENV_IDS[@]}"; do
    if printf '%s' "$code" | grep -qF -- "$id"; then
      named=$((named + 1))
      bad "$(basename "$f") names the env '$id' in CODE — the env set is DATA, derived
        from the recipe tree; a named env is the one that gets used while the others are
        silently skipped"
    fi
  done
done
# Counted LOCALLY, not off the global tally: reading `fail_n` here would have made this
# assertion report on whatever an earlier section did.
[ "$named" -eq 0 ] && ok "neither $(basename "$LOOP") nor $(basename "$PUBLISH") names any of: ${ENV_IDS[*]}"

# BEHAVIOURAL cross-check: the candidate list each script prints when it REFUSES must be
# the tree's. Two scripts that each derive correctly can still derive DIFFERENTLY; only
# running both and diffing catches that, and a third textual copy of the predicate could
# not.
loop_cands="$("$LOOP" 2>&1 >/dev/null | sed -n 's/.*--env \(.*\)$/\1/p' | sort | tr '\n' ' ')"
pub_cands="$(sh "$PUBLISH" --dry-run 2>&1 >/dev/null | sed -n 's/^  \([a-z0-9._-]*\)$/\1/p' | sort | tr '\n' ' ')"
tree_cands="$(printf '%s\n' "${ENV_IDS[@]}" | sort | tr '\n' ' ')"
if [ "$loop_cands" = "$tree_cands" ]; then ok "the loop's refusal lists exactly the tree: $loop_cands"
else bad "the loop's refusal list '$loop_cands' != the tree '$tree_cands'"; fi
if [ "$pub_cands" = "$tree_cands" ]; then ok "the publisher's refusal lists exactly the tree: $pub_cands"
else bad "the publisher's refusal list '$pub_cands' != the tree '$tree_cands'"; fi

# ── TEST-7 — the publisher's exit codes, exactly ───────────────────────────────────
tcase "TEST-7 — publish refuses (2) with no --env, and dry-runs (0) per env"
sh "$PUBLISH" --dry-run >/dev/null 2>&1
rc=$?
if [ "$rc" -eq 2 ]; then ok "no --env with ${#ENV_IDS[@]} recipes exits exactly 2"
else bad "expected exit 2 from a bare publish, got $rc"; fi

for id in "${ENV_IDS[@]}"; do
  out="$(sh "$PUBLISH" --env "$id" --dry-run 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then bad "publish --env $id --dry-run exited $rc"; continue; fi
  # It must plan a PER-ENV repo and BOTH tags — a plan that moved one shared tag would
  # publish one env over another.
  if printf '%s' "$out" | grep -q "txresbench-env/$id" \
     && printf '%s' "$out" | grep -q 'moving    : schema' \
     && printf '%s' "$out" | grep -q 'immutable : schema'; then
    ok "publish --env $id --dry-run exits 0 and plans a per-env repo with both tags"
  else
    bad "publish --env $id --dry-run exited 0 but its plan is missing the per-env repo or a tag"
  fi
done

# ── TEST-1 + TEST-5 — the whole loop with NO credential, and NO registry tool ──────
if [ "$FAST" = "1" ]; then
  echo
  echo "  ....  (--fast) skipping TEST-1/TEST-5/TEST-8: they run a real docker build and"
  echo "        mount staged artifacts. Run \`just check-env-loop\` for the full tier."
else
tcase "TEST-1/TEST-5 — the loop runs credential-free and touches no registry tool"
STUBS="$WORK/stubs"; mkdir -p "$STUBS"
CALLS="$WORK/registry-calls.log"; : > "$CALLS"
for t in oras cosign gh; do
  cat > "$STUBS/$t" <<STUB
#!/bin/sh
echo "$t \$*" >> "$CALLS"
exit 97
STUB
  chmod +x "$STUBS/$t"
done

# POSITIVE CONTROL FIRST. "Zero invocations" is satisfied vacuously by a stub that was
# never on PATH, a stub that is not executable, or a log path nothing can write. So prove
# the mechanism fires BEFORE relying on its silence.
PATH="$STUBS:$PATH" oras whoami >/dev/null 2>&1
rc=$?
if [ "$rc" -eq 97 ] && [ "$(wc -l < "$CALLS")" -eq 1 ]; then
  ok "control: the stubs are on PATH, fire, and record (exit 97, 1 line logged)"
else
  bad "control FAILED (exit $rc, $(wc -l < "$CALLS") lines) — the emptiness assertion below
        would have been vacuous, so the whole no-credential claim is unproven"
fi
: > "$CALLS"

# Scrub every credential channel `fetch-env-rootfs.sh` documents, and point HOME at an
# empty dir so a real `gh` config cannot be found either.
mkdir -p "$WORK/home"
loop_out="$WORK/loop.out"
env -u GITHUB_TOKEN -u GH_TOKEN -u GHCR_TOKEN -u GHCR_USER -u GITHUB_ACTOR \
    HOME="$WORK/home" \
    PATH="$STUBS:$PATH" \
    TXR_ENV_ROOTFS_CACHE="$WORK/cache" \
    sh "$LOOP" --env "$FIRST_ENV" > "$loop_out" 2>&1
rc=$?
if [ "$rc" -eq 0 ]; then ok "the full loop completed (exit 0) with every credential channel unset"
else bad "the loop exited $rc with credentials scrubbed; tail: $(tail -5 "$loop_out" | tr '\n' ' ')"; fi

staged="$(tail -1 "$loop_out")"
if [ -s "$staged" ]; then ok "it staged a real artifact: $staged ($(wc -c < "$staged") bytes)"
else bad "the loop's last line '$staged' is not an existing non-empty file — it reported
        success without producing the artifact"; fi

if [ ! -s "$CALLS" ]; then ok "no registry tool (oras/cosign/gh) was invoked at any point"
else bad "the loop invoked a registry tool, so it is NOT credential-free: $(tr '\n' ';' < "$CALLS")"; fi

# INV-4's other half: publishing still needs what it always needed. The contrast is the
# claim — the local loop's plan has no registry step; the publisher's does.
pub_plan="$(sh "$PUBLISH" --env "$FIRST_ENV" --dry-run 2>&1)"
# SCOPE, stated because it would otherwise read as more than it is: a dry run prints
# PLAN TEXT, so this compares two ECHOED plans and cannot distinguish "publishing still
# needs a registry" from "the dry-run branch still prints two strings". It is a
# CORROBORATING contrast, not the proof. The proof of INV-4/INV-1 is the PATH-stub
# emptiness check above, which has a positive control and observes real invocations.
if printf '%s' "$pub_plan" | grep -q 'oras push' && printf '%s' "$pub_plan" | grep -q 'cosign sign'; then
  ok "contrast (plan text only): the publisher still PLANS oras push + cosign sign, while
        the loop invoked neither — the load-bearing evidence is the stub check above"
else
  bad "the publish plan no longer prints oras push / cosign sign; the contrast this
        assertion draws has stopped being drawable — re-derive it"
fi

# ── TEST-12 — the SUBSTITUTION GUARD is exercised, not merely present ─────────────
# The label check is what stops `--reuse-image` staging one env's rootfs under another
# env's key, and the loop's own header calls it "the only substitution guard there is" —
# because every other verification leg is env-agnostic by design. It was added in a fix
# round and then read by NOTHING: deleting `--label` from the docker build, or downgrading
# the mismatch `die` to a `log`, left every gate green. A guard nothing exercises is a
# guard the next refactor deletes.
#
# The full loop above has already built and labelled FIRST_ENV, so this costs one
# `docker image inspect` and two refusals.
tcase "TEST-12 — --reuse-image refuses a cross-env image, and accepts its own"
SECOND_ENV="${ENV_IDS[1]}"
built_tag="txresbench-env-local-$FIRST_ENV:schema$SCHEMA_V-$ARCH_V"
if ! docker image inspect "$built_tag" >/dev/null 2>&1; then
  bad "the loop's own build tag '$built_tag' is absent, so this section could not run.
        Stage first: $LOOP --all"
else
  lbl="$(docker image inspect --format '{{index .Config.Labels "com.txresbench.env"}}' "$built_tag" 2>/dev/null)"
  if [ "$lbl" = "$FIRST_ENV" ]; then
    ok "the loop labels what it builds (com.txresbench.env=$lbl on $built_tag)"
  else
    bad "the image the loop built carries com.txresbench.env='$lbl', not '$FIRST_ENV' —
        the ONLY artifact-side evidence binding bytes to an env is absent or wrong"
  fi

  # THE REFUSAL. Staging FIRST_ENV's image as SECOND_ENV must fail, naming both.
  #
  # ISOLATED CACHE, and this is not hygiene — it is the point. This probe deliberately
  # ATTEMPTS the substitution, so if the guard under test is ever broken the attempt
  # SUCCEEDS and writes one env's bytes into the other env's cache slot. Against the
  # repository cache that corrupts the developer's real artifacts, and the next thing to
  # notice is the Rust acceptance test failing with two identical digests — which is
  # exactly what happened while this test was being written. A test that can damage the
  # thing it is testing must run against its own copy.
  sub_out="$(TXR_ENV_ROOTFS_CACHE="$WORK/subcache" \
    sh "$LOOP" --env "$SECOND_ENV" --reuse-image "$built_tag" 2>&1)"
  sub_rc=$?
  # ── THE PREFIX HAZARD, and why this is not two `grep -qF` calls ────────────────
  # The shipped ids are `<x>` and `<x>-<suffix>`: FIRST_ENV is a strict PREFIX of
  # SECOND_ENV. So `grep -qF "$FIRST_ENV"` is satisfied by any line mentioning only
  # SECOND_ENV — and this run's ROUTINE header lines (`── <id> ──`, `recipe : …`,
  # `stage : …`) already mention it several times. Both greps therefore collapsed to
  # `sub_rc -ne 0`, and a refusal naming only the requested env would have reported
  # "naming both". Measured: 7 matches for the short id, 5 of them inside the long one.
  #
  # The Rust twin defeats this by REMOVING the requested id from the message and
  # requiring the staged id to survive; the shell tier now does the same, over the
  # REFUSAL LINE only rather than the whole transcript, so routine progress output
  # cannot satisfy it either.
  # The refusal BLOCK, not one line: the message names the staged env on its first line
  # and the requested env on its second, so a `head -1` had only half of it. Taken from
  # the FAIL marker to the end, which still EXCLUDES the routine progress header (`── <id>
  # ──`, `recipe : …`, `stage : …`) that precedes it — and that exclusion is the whole
  # point, since those lines mention the requested id and would satisfy the check on their
  # own.
  refusal_line="$(printf '%s\n' "$sub_out" | sed -n '/FAIL: --reuse-image/,$p')"
  # TWO confounders removed, not one. The Rust twin removes the requested id because one
  # shipped id is a PREFIX of the other; the shell tier has a second source of the same
  # substring that the Rust tier does not — the IMAGE TAG (`txresbench-env-local-<id>:…`),
  # which the refusal quotes back and which embeds FIRST_ENV verbatim. A mutation that
  # deleted the staged env from the message still passed with only the first removal,
  # because the tag supplied it. Both are stripped, and what must SURVIVE is the staged
  # env id appearing on its own account.
  # LITERAL removal, not sed. The ids and the tag are DERIVED (a recipe directory name),
  # and interpolating them into a `s///` makes sed abort on `[`, `|`, `*` or `\` —
  # measured — leaving `residue` empty, so the assertion then reports the alarming "was
  # NOT refused naming both" about a perfectly good refusal. Same hazard that moved two
  # greps in this file to `-F`; awk with the pattern in a VARIABLE removes literally.
  residue="$(printf '%s' "$refusal_line" | awk -v a="$SECOND_ENV" -v b="$built_tag" '
      { s=$0
        while ((i = index(s, a)) > 0) s = substr(s,1,i-1) substr(s,i+length(a))
        while ((i = index(s, b)) > 0) s = substr(s,1,i-1) substr(s,i+length(b))
        print s }')"
  if [ "$sub_rc" -ne 0 ] && [ -n "$refusal_line" ] \
     && printf '%s' "$refusal_line" | grep -qF "$SECOND_ENV" \
     && printf '%s' "$residue" | grep -qF "$FIRST_ENV"; then
    ok "staging '$FIRST_ENV''s image as '$SECOND_ENV' is REFUSED (exit $sub_rc), and the
        refusal names the STAGED env independently of the requested one"
  else
    bad "staging '$FIRST_ENV''s image as '$SECOND_ENV' was NOT refused naming both (exit
        $sub_rc, refusal line: '${refusal_line:-<none>}'). This is the silent
        substitution the whole epic exists to close: a job would mount the wrong rootfs
        and fail as though the ANALYSIS were broken."
  fi

  # THE UNLABELLED CASE, which TEST-12 previously never reached: every image it passed
  # was one the loop itself had built and labelled, so it always landed in the MISMATCH
  # arm. The empty-label arm is the one that matters most in practice — an unlabelled
  # image is *every* image not built by this loop — and it was exercised by nothing, so
  # replacing its refusal with a fallthrough kept every gate green. Any image without the
  # label serves as the probe; one is derived from what docker already has locally rather
  # than named here.
  unlabelled="$(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null \
    | grep -v '^txresbench-env-local-' | grep -v '<none>' | head -1)"
  if [ -z "$unlabelled" ]; then
    bad "no unlabelled image available locally to probe the empty-label refusal with —
        this assertion could not run, which is a gap, not a pass"
  else
    ul_out="$(TXR_ENV_ROOTFS_CACHE="$WORK/ulcache" \
      sh "$LOOP" --env "$FIRST_ENV" --reuse-image "$unlabelled" 2>&1)"; ul_rc=$?
    if [ "$ul_rc" -ne 0 ] && printf '%s' "$ul_out" | grep -qF "carries no"; then
      ok "an UNLABELLED image ($unlabelled) is refused for '$FIRST_ENV' (exit $ul_rc)"
    else
      bad "an unlabelled image was NOT refused (exit $ul_rc). That is every image this
          loop did not build, so it is the widest substitution vector there is."
    fi
  fi

  # CONTROL. Without it, "the cross-env case failed" is indistinguishable from
  # "--reuse-image is broken", and the assertion above would pass with the label
  # comparison deleted and replaced by an unconditional refusal.
  ctl_out="$(TXR_ENV_ROOTFS_CACHE="$WORK/ctlcache" sh "$LOOP" --env "$FIRST_ENV" --reuse-image "$built_tag" 2>&1)"
  ctl_rc=$?
  if [ "$ctl_rc" -eq 0 ]; then
    ok "control: the SAME env's own labelled image is still accepted (exit 0)"
  else
    bad "control FAILED: '$FIRST_ENV''s own image was refused for '$FIRST_ENV' (exit
        $ctl_rc) — so the refusal above proves nothing about env matching.
        output: $(printf '%s' "$ctl_out" | tail -3 | tr '\n' ' ')"
  fi
fi

# ── TEST-13 — the CONTENT VERIFICATION is exercised, not merely present ───────────
# The sha256 re-check in --print-seam is what stands between an overwritten cache slot and
# a seam the runtime serves BY NAME — the loop's header calls it load-bearing, and it was
# added because a blind audit demonstrated that hole end to end. It then shipped read by
# NOTHING: deleting the mismatch refusal left every gate green. That is the third time on
# this branch that a guard added in a fix round arrived unexercised, which is why this
# section exists.
tcase "TEST-13 — a substituted cache slot is refused, and an honest one is not"
cv_cache="$WORK/cvcache"; mkdir -p "$cv_cache"
if ! TXR_ENV_ROOTFS_CACHE="$cv_cache" sh "$LOOP" --all >/dev/null 2>&1; then
  bad "could not stage into an isolated cache; TEST-13 could not run"
else
  # CONTROL FIRST: an honest cache must emit one line per env. Without it, "the
  # substituted cache was refused" is indistinguishable from "--print-seam always fails".
  honest="$(TXR_ENV_ROOTFS_CACHE="$cv_cache" sh "$LOOP" --print-seam 2>/dev/null)"; h_rc=$?
  h_n="$(printf '%s' "$honest" | grep -c "$SEAM_KEY_BASE" || true)"
  if [ "$h_rc" -eq 0 ] && [ "$h_n" -eq "${#ENV_IDS[@]}" ]; then
    ok "control: an honest cache emits one verified seam per env (${#ENV_IDS[@]})"
  else
    bad "control FAILED: an honest cache gave rc=$h_rc with $h_n seam line(s); the refusal
        below would prove nothing"
  fi
  # THE SUBSTITUTION: env B's bytes into env A's slot, leaving A's sidecar intact.
  cp "$cv_cache/${ENV_IDS[1]}-schema$SCHEMA_V-$ARCH_V.squashfs" \
     "$cv_cache/${ENV_IDS[0]}-schema$SCHEMA_V-$ARCH_V.squashfs"
  sub="$(TXR_ENV_ROOTFS_CACHE="$cv_cache" sh "$LOOP" --print-seam 2>&1)"; s_rc=$?
  if [ "$s_rc" -ne 0 ] && printf '%s' "$sub" | grep -qF "does NOT match"; then
    ok "a cache slot holding another env's bytes is REFUSED by --print-seam (exit $s_rc)"
  else
    bad "a substituted cache slot was NOT refused (exit $s_rc). The runtime resolves this
        seam BY NAME, so a job declaring '${ENV_IDS[0]}' would mount '${ENV_IDS[1]}''s
        rootfs and fail as though the analysis were broken."
  fi
  # NOTHING may reach stdout when any env fails, or a caller reading through a pipe gets a
  # silently PARTIAL prefix on exactly this corruption.
  #
  # THE SUBSTITUTED ENV MUST BE THE LAST ONE ITERATED, and that is the whole assertion.
  # --print-seam walks the sorted env list, so corrupting the FIRST env makes it die
  # before any line is produced — stdout is then empty whether the output is buffered or
  # written as it goes, and the assertion holds with the buffering deleted. Proven by
  # mutation. Corrupting the LAST env is the only arrangement where an unbuffered
  # implementation would have already emitted the earlier envs' lines, so it is the only
  # one that discriminates.
  # Restore the first env, which the assertion above deliberately corrupted, so that the
  # ONLY failing env below is the last one.
  TXR_ENV_ROOTFS_CACHE="$cv_cache" sh "$LOOP" --env "${ENV_IDS[0]}" >/dev/null 2>&1 || true
  cp "$cv_cache/${ENV_IDS[0]}-schema$SCHEMA_V-$ARCH_V.squashfs" \
     "$cv_cache/${ENV_IDS[$(( ${#ENV_IDS[@]} - 1 ))]}-schema$SCHEMA_V-$ARCH_V.squashfs"
  sub_stdout="$(TXR_ENV_ROOTFS_CACHE="$cv_cache" sh "$LOOP" --print-seam 2>/dev/null || true)"
  if [ -z "$sub_stdout" ]; then
    ok "a --print-seam failing on the LAST env emits NO partial prefix for the earlier ones"
  else
    bad "--print-seam emitted '$sub_stdout' on stdout while failing on a later env — a
        caller piping to tail -1 gets a partial prefix and loses the status"
  fi
  # And the consumer round 4 found bypassing this check must now inherit it — asserted
  # against the env that is CURRENTLY corrupted, which after the stdout probe above is the
  # LAST one, not the first. Pointing it at the first env silently turned this into a
  # check that an HONEST artifact is accepted, which is a different (and already covered)
  # claim; the harness caught the mix-up by failing, which is what it is for.
  last_env="${ENV_IDS[$(( ${#ENV_IDS[@]} - 1 ))]}"
  TXR_ENV_ROOTFS_CACHE="$cv_cache" bash "$PREFLIGHT" --env "$last_env" >/dev/null 2>&1
  pf_sub_rc=$?
  if [ "$pf_sub_rc" -ne 0 ]; then
    ok "the preflight's --env path inherits the refusal (it no longer resolves around it)"
  else
    bad "the preflight's --env path still emits a seam for '$last_env', whose cache slot
        holds another env's bytes"
  fi
fi

# ── TEST-8 — tier-7 preflight: the last-line contract, and multi-env ───────────────
tcase "TEST-8 — the preflight's last-line contract, and its --seams mode"
pf_out="$WORK/preflight.out"
bash "$PREFLIGHT" > "$pf_out" 2>/dev/null
rc=$?
if [ "$rc" -eq 0 ]; then
  last="$(tail -1 "$pf_out")"
  # `justfile` assigns this straight to TXR_ENV_ROOTFS_SQUASHFS in three places, so a
  # diagnostic printed last would be consumed as a path.
  if [ -s "$last" ]; then ok "default mode's last line is an existing artifact: $last"
  else bad "default mode's last line '$last' is not an existing file — the three
        \`| tail -1\` call sites in the justfile would get a non-path"; fi
else
  bad "the preflight exited $rc in default mode; this host cannot run the tier, so the
        last-line contract is untested here (that is a gap, not a pass)"
fi

seams_out="$WORK/seams.out"
bash "$PREFLIGHT" --seams > "$seams_out" 2>/dev/null
rc=$?
if [ "$rc" -eq 0 ]; then
  prefix="$(tail -1 "$seams_out")"
  n_assign="$(printf '%s' "$prefix" | grep -o "TXR_ENV_ROOTFS_SQUASHFS__" | wc -l)"
  # COMPARED TO THE DERIVED TREE, not to itself. The first version counted assignments
  # out of the emitted prefix and then compared the arrived count back to that same
  # number, so a --seams that emitted ONE of two envs reported "emitted 1" and "sets all
  # 1" — both PASS — under a section titled multi-env. `${#ENV_IDS[@]}` was already in
  # scope, with its own floor of >= 2, and is the only count blind to nothing.
  if [ "$n_assign" -eq "${#ENV_IDS[@]}" ]; then
    ok "--seams emitted one assignment for EACH of the ${#ENV_IDS[@]} derived env(s)"
  else
    bad "--seams emitted $n_assign assignment(s) for ${#ENV_IDS[@]} derived env(s) — a
        partial prefix leaves the tier without an artifact for the rest"
  fi
  # The `--env <id>` PATH, exercised for the first time here. Its mutual exclusion, its
  # fail-closed resolution and its per-env last line had NO caller and no gate anywhere in
  # the tree — an INV-2 mechanism upheld by code nothing runs, which is the same
  # exists-but-unused shape two earlier rounds already found twice on this branch.
  for probe_env in "${ENV_IDS[@]}"; do
    pe_out="$(bash "$PREFLIGHT" --env "$probe_env" 2>/dev/null)"; pe_rc=$?
    pe_last="$(printf '%s\n' "$pe_out" | tail -1)"
    if [ "$pe_rc" -ne 0 ]; then
      bad "--env $probe_env exited $pe_rc"
    elif printf '%s' "$pe_last" | grep -qF "env '${SEAM_KEY_BASE}__${probe_env}=" \
         && printf '%s' "$pe_last" | grep -qF "/${probe_env}-schema"; then
      # BOTH halves. Asserting only the KEY prefix left the PATH unchecked, so a
      # preflight that resolved the wrong artifact — the exact fail-open its own resolver
      # comment says it closed — would emit `__<b>=<a's path>` and this reported PASS: a
      # live cross-env substitution passing in the tier whose whole subject is
      # substitution. The artifact filename embeds the env id, so the path is checkable.
      ok "--env $probe_env emits THAT env's seam KEY pointing at THAT env's artifact"
    else
      bad "--env $probe_env's last line is '$pe_last' — it must carry THAT env's seam key
        AND that env's own artifact path. A bare path is unusable (the un-suffixed
        variable is associated with the deployment default); a key pointing at another
        env's artifact is the substitution itself."
    fi
  done
  # …and the two flags must refuse to be combined rather than silently ranking each other.
  bash "$PREFLIGHT" --seams --env "$FIRST_ENV" >/dev/null 2>&1
  if [ $? -eq 2 ]; then ok "--seams and --env are refused together (exit 2)"
  else bad "--seams --env was accepted; one of the two flags is being silently ignored"; fi

  # And it must WORK: execute the emitted prefix and count the variables that arrive.
  arrived="$(eval "$prefix printenv" 2>/dev/null | grep -c '^TXR_ENV_ROOTFS_SQUASHFS__')"
  if [ "$arrived" -eq "${#ENV_IDS[@]}" ]; then
    ok "executing the emitted prefix sets all ${#ENV_IDS[@]} seam variable(s)"
  else
    bad "the emitted prefix set $arrived of ${#ENV_IDS[@]} seam variables when run"
  fi
else
  bad "the preflight exited $rc under --seams"
fi

fi   # end of the non---fast sections

# ── result ─────────────────────────────────────────────────────────────────────────
mode_label="full"; [ "$FAST" = "1" ] && mode_label="fast"
printf '\n== check-env-loop (%s): %d passed, %d failed ==\n' "$mode_label" "$pass_n" "$fail_n"

# ANTI-VACUITY on the run itself: a harness that asserted nothing must not exit 0.
#
# The floor is the EXACT count each mode produces, not a comfortable number below it. It
# was 12 while the full run produced 19 — so seven assertions could have been deleted and
# the floor would still have reported a clean run, which is precisely the deletion-blindness
# the floor exists to prevent. When you ADD an assertion, raise the number here; that edit
# is the point, because it is the one a reviewer sees.
# DERIVED, not typed. Part of the count is data-dependent: the TEST-7 loop emits one `ok`
# per discovered env recipe. A literal 10/21 was therefore only correct for exactly two
# recipes — adding a third (a legitimate change touching nothing in this file) turned
# `just check-guards` RED with the message "an assertion was deleted", and, worse, a third
# recipe PLUS a deleted assertion netted back to the literal and passed clean. A typed
# constant over a derived quantity, in the file whose thesis is derive-never-name.
#
# The fixed part is BASE; the variable part is one per env. When you ADD an assertion,
# raise BASE — that edit is the point, because it is the one a reviewer sees.
# TWO coefficients, because there are two kinds of assertion here and the count is
# FIXED + PER_ENV x N. The previous formula had a single per-env term while full mode had
# grown a SECOND loop over the env list (the publish dry-runs, and the --env preflight
# probes), so `BASE + N` happened to equal the truth only at N = 2. With a third recipe —
# a legitimate change touching nothing in this file — the run produced 28 against an
# expected 27 and reddened `just check-env-loop` accusing the author of deleting an
# assertion; and a third recipe PLUS a genuinely deleted assertion netted back to 27 and
# passed clean. That is the same constant-over-a-derived-quantity defect the comment below
# says was fixed by replacing a literal 21 — the literal had been replaced by a formula
# with the wrong coefficient, which is the same mistake wearing arithmetic.
#
# FAST MODE IS VERIFIED AT N = 3 BY MEASUREMENT, not just at the N this tree happens to
# ship: with a third recipe directory present it produced 10 = 7 + 1x3 and exited 0.
# Checking a formula only at the value where the WRONG one also worked would have proved
# nothing, which is exactly how the previous coefficient survived.
#
# FULL MODE's coefficient is established by ENUMERATION, not measurement, and that is
# stated rather than glossed: its per-env sites are the publish dry-run loop and the
# --env preflight-probe loop, two of them. It cannot be measured at N = 3 here because
# full mode BUILDS every discovered recipe, so a dummy third directory fails the build
# rather than the count. If you add a third real recipe, re-measure and correct this.
#
# When you add a FIXED assertion, raise FIXED. When you add a LOOP over ENV_IDS, raise
# PER_ENV. Both edits are the point: they are what a reviewer sees.
if [ "$FAST" = "1" ]; then FIXED=7; PER_ENV=1; else FIXED=27; PER_ENV=2; fi
EXPECTED=$(( FIXED + PER_ENV * ${#ENV_IDS[@]} ))
if [ "$pass_n" -ne "$EXPECTED" ] && [ "$fail_n" -eq 0 ]; then
  echo "FAIL: $pass_n assertions passed in $mode_label mode but exactly $EXPECTED were" >&2
  echo "  expected (FIXED $FIXED + $PER_ENV per each of the ${#ENV_IDS[@]} derived env recipe(s))." >&2
  echo "  A clean run with the wrong count means a section exited early or an assertion" >&2
  echo "  was deleted. An exit code is not evidence that the tests ran." >&2
  exit 1
fi
[ "$fail_n" -eq 0 ] || exit 1
exit 0
