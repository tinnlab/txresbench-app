#!/usr/bin/env bash
# e2e-processors-preflight.sh — the LOUD precondition gate for the real-compute
# processor tier (`just e2e-processors`).
#
# WHY IT FAILS INSTEAD OF SKIPPING
# --------------------------------
# The failure mode this exists to kill: `CYTO_E2E_REAL_COMPUTE` unset made the
# real-compute specs vanish (2 excluded outright by the config `grepInvert`, the
# rest silently `test.skip`ped). A broken compute layer and a working one produced
# the SAME green output, for months. So every precondition here is a hard FAIL with
# a remediation line — never a skip, never a warning that scrolls past.
#
# WHY THE LAST CHECK IS AN EXECUTION CANARY
# -----------------------------------------
# Checks 1-6 are necessary but NOT sufficient: bwrap can be installed, the image can
# be present and schema-correct, and execution can still fail (a masked /proc in a
# container, userns disabled by an LSM, a FUSE mount that won't allow_other). Check 7
# therefore RUNS the scientific interpreter inside a real bwrap sandbox against the
# real image. It asserts the CAPABILITY, not the syntax of the capability — if the
# canary passes, the tier can genuinely run.
#
# Exit 0 = this host can run the tier. Any non-zero = it cannot, and the output says
# exactly what to install/enable.
#
# On success the last line is the resolved squashfs path (seam 1).
#
# ── MULTI-ENV (E5 / #193) ───────────────────────────────────────────────────────
# Two additive flags. Neither changes the default invocation, because the LAST LINE of
# this script is a load-bearing contract: `justfile` reads it with `| tail -1` in three
# places and assigns it straight to `CYTO_ENV_ROOTFS_SQUASHFS`, so a diagnostic printed
# last would be consumed as a path.
#
#   --env <id>   preflight THAT env's artifact instead of the derived default. Prefers a
#                LOCALLY BUILT artifact (scripts/build-env-rootfs-local.sh) and falls
#                back to the fetch cache, so an env that exists only as a recipe — never
#                published, which is every env but one while #80 stands — is reachable.
#                ** ITS LAST LINE IS NOT A BARE PATH. ** It is that env's seam assignment,
#                `env 'CYTO_ENV_ROOTFS_SQUASHFS__<id>=<path>'`, because a bare path is
#                only consumable through the UN-suffixed variable, which `seam_serves`
#                associates with the DEPLOYMENT DEFAULT — so feeding `--env X`'s output to
#                the default call sites would ask for X and be refused. Mutually exclusive
#                with --seams. The default (no-flag) invocation still prints a bare path.
#
#   --seams      after the host checks, prove EVERY locally staged env can execute under
#                bwrap and print one `env '<seam>=<path>'` assignment per line, with the
#                last line the full prefix for all of them. Use it as a command prefix.
#
# The per-env canary under `--seams` runs `jq`, and that choice is not arbitrary: jq is
# the one binary EVERY env image in this tree must carry (a converter wrapper parses
# /inputs/params.json with it — see scripts/lib/env-image-verify.sh), so it is a
# per-env capability probe that names no analysis domain. The default single-env canary
# below stays as it is, because it proves more for the env the e2e tier actually uses.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SEAM_KEY_BASE=CYTO_ENV_ROOTFS_SQUASHFS
fails=0
WANT_ENV=""
SEAMS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --env)
      [ $# -ge 2 ] || { echo "e2e-processors-preflight: --env needs an <env-id>" >&2; exit 2; }
      case "$2" in -*) echo "e2e-processors-preflight: --env got the flag '$2', not an env id" >&2; exit 2 ;; esac
      WANT_ENV="$2"; shift 2 ;;
    --seams) SEAMS=1; shift ;;
    *) echo "e2e-processors-preflight: unknown argument: $1" >&2; exit 2 ;;
  esac
done
# MUTUALLY EXCLUSIVE, and said so rather than silently resolved. `--seams` exits inside
# its own block, so the `--env` emission below was unreachable when both were given: a
# caller who named ONE env got the prefix for ALL of them, with the `--env` argument
# quietly demoted to "which env the canary probes". Two flags that answer the same
# question ("what should the last line be?") must not be silently ranked.
if [ -n "$WANT_ENV" ] && [ "$SEAMS" = "1" ]; then
  echo "e2e-processors-preflight: --env and --seams are mutually exclusive." >&2
  echo "  --env <id> emits ONE env's seam assignment; --seams emits every staged env's." >&2
  exit 2
fi
ok()   { printf '  \033[32mOK\033[0m    %s\n' "$*" >&2; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*" >&2; fails=$((fails+1)); }
hint() { printf '        ↳ %s\n' "$*" >&2; }

echo "== e2e-processors preflight ==" >&2

# ── 1-3. host tools ──────────────────────────────────────────────────────────
for bin in bwrap squashfuse; do
  if command -v "$bin" >/dev/null 2>&1; then ok "$bin present ($(command -v $bin))"
  else
    bad "$bin NOT FOUND"
    hint "sudo apt install bubblewrap squashfuse fuse3   (or your distro's equivalent)"
  fi
done
if command -v fusermount3 >/dev/null 2>&1 || command -v fusermount >/dev/null 2>&1; then
  ok "fusermount present"
else
  bad "fusermount/fusermount3 NOT FOUND"
  hint "sudo apt install fuse3"
fi

# ── 4. unprivileged user namespaces + a fresh /proc ──────────────────────────
if unshare -Urpf --mount-proc true 2>/dev/null; then
  ok "unprivileged userns + fresh /proc mount"
else
  bad "cannot create a user namespace with a fresh /proc"
  hint "sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0"
  hint "in a container: relaunch with --security-opt systempaths=unconfined"
  hint "or run: bash scripts/dev-sandbox-bootstrap.sh"
fi

# ── 5. fuse allow_other (squashfuse mounts must be readable by the sandbox uid) ─
if grep -qE '^[[:space:]]*user_allow_other' /etc/fuse.conf 2>/dev/null; then
  ok "/etc/fuse.conf user_allow_other enabled"
else
  bad "/etc/fuse.conf lacks user_allow_other"
  hint "bash scripts/dev-sandbox-bootstrap.sh   (adds it with sudo)"
fi

# ── 6. the env image (seam 1) ────────────────────────────────────────────────
# A LOCALLY BUILT artifact and a FETCHED one land in the same cache directory under the
# same name, so this one resolver covers both. That is the whole reason
# `build-env-rootfs-local.sh` reuses `fetch-env-rootfs.sh`'s layout.
resolve_env_path() {
  # $1 = env id (may be empty ⇒ the derived default)
  if [ -n "$1" ]; then
    bash "$ROOT/scripts/fetch-env-rootfs.sh" "$1" --print-path
  else
    bash "$ROOT/scripts/fetch-env-rootfs.sh" --print-path
  fi
}

SQUASHFS="${CYTO_ENV_ROOTFS_SQUASHFS:-}"
if [ -n "$WANT_ENV" ]; then
  # An explicit --env overrides an ambient seam: the caller named an env, and silently
  # preflighting a DIFFERENT one because a variable happened to be exported is the same
  # substitution this epic exists to prevent, one layer up.
  #
  # FAIL-CLOSED. The first version assigned this and then fell into the `-z` branch
  # below, which re-resolves the DERIVED DEFAULT — so a resolver that failed with no
  # stdout would have made `--env X` silently preflight some other env and report OK.
  # That is the substitution the comment above claims to prevent, reintroduced two lines
  # under it. The status is captured (this script runs `set -uo pipefail`, not `-e`, so
  # a command substitution's failure is otherwise discarded) and an empty result dies.
  if ! SQUASHFS="$(resolve_env_path "$WANT_ENV")" || [ -z "$SQUASHFS" ]; then
    echo "== preflight FAILED: could not resolve an artifact path for env '$WANT_ENV' ==" >&2
    echo "   Refusing to fall back to the derived default: you named an env, and" >&2
    echo "   preflighting a different one would report OK about the wrong image." >&2
    exit 1
  fi
elif [ -z "$SQUASHFS" ]; then
  SQUASHFS="$(resolve_env_path "")"
fi
# CONTENT-VERIFY THE DEFAULT PATH TOO. `--env` routes through the verified emitter, and
# `--seams` does; the default single-env path did not, so the same cache was trusted by
# one invocation and refused by another. A caller who dropped the flag got the weaker
# answer with nothing saying so — and this is the path `just e2e-processors`, the tier
# this script exists for, actually takes.
#
# It does NOT hard-fail when the sidecar is absent: a cache populated before sidecars
# existed is a legitimate, common state, and turning tier 7 red for it would be a
# regression for a real artifact. A MISMATCH is a refusal; an ABSENCE is a stated gap.
verify_default_artifact() {
  _side="${SQUASHFS%.squashfs}.sha256"
  if [ ! -s "$_side" ]; then
    ok "env image present, content identity NOT on file (no $(basename "$_side")) —"
    printf '        ↳ %s
' "this artifact predates the sidecar; re-run \`just env-rootfs\` (a cache" >&2
    printf '        ↳ %s
' "hit) or \`just env-rootfs-local --env <id>\` to record one, and this" >&2
    printf '        ↳ %s
' "check becomes real. Proceeding: absence is a gap, not a mismatch." >&2
    return 0
  fi
  command -v sha256sum >/dev/null 2>&1 || { ok "env image present (sha256sum absent; not verified)"; return 0; }
  _want="$(tr -d ' 	
' < "$_side")"
  if ! _raw="$(sha256sum "$SQUASHFS")"; then
    bad "could not hash $SQUASHFS — reported as the I/O failure it is, not as a mismatch"
    return 1
  fi
  if [ "${_raw%% *}" != "$_want" ]; then
    bad "the env image at $SQUASHFS does NOT match its recorded content identity"
    hint "recorded ${_want}"
    hint "on disk  ${_raw%% *}"
    hint "those are not the bytes this cache slot was recorded for; the sandbox resolves"
    hint "this seam BY NAME, so a job would mount them anyway. Re-stage before running."
    return 1
  fi
  ok "env image present and matches its recorded content identity ($SQUASHFS)"
  return 0
}

if [ -s "$SQUASHFS" ]; then
  verify_default_artifact || true
else
  bad "env image MISSING at $SQUASHFS"
  hint "just env-rootfs      # one-time ~300 MB pull, ~5 s; cached under .cyto-cache/"
  hint "it needs a GitHub credential with read:packages (gh auth login, or \$GITHUB_TOKEN)"
fi

# Bail before the canary if anything above failed — the canary's output would just
# be noise on top of a known-missing dependency.
if [ "$fails" -gt 0 ]; then
  echo >&2
  echo "== preflight FAILED ($fails problem(s)) — the real-compute tier cannot run on this host ==" >&2
  echo "   Fix the items above and re-run. This is deliberately a FAILURE, not a skip:" >&2
  echo "   a silently-skipped compute tier is indistinguishable from a passing one." >&2
  exit 1
fi

# ── 7. EXECUTION CANARY — prove the sandbox really runs the science stack ────
# The BANNER must say which probe actually ran. Under --env the canary is the weaker,
# env-agnostic one, and the source comments said so scrupulously while the emitted text —
# the half a reader actually sees — still claimed "running the interpreter" and then
# "this host can run the real-compute processor tier". Stating the weaker thing honestly
# is INV-3's rule applied to this script's own output.
if [ -n "$WANT_ENV" ]; then
  echo "  ..    capability canary: running jq inside bwrap (env-agnostic probe, because" >&2
  echo "        --env may name any env; it proves this host can EXECUTE this rootfs," >&2
  echo "        not that the env's scientific stack imports)" >&2
else
  echo "  ..    execution canary: running the interpreter inside bwrap" >&2
fi
canary_root="$(mktemp -d)"; canary_ws="$(mktemp -d)"
pw="$(mktemp)"; gr="$(mktemp)"
printf 'analyst:x:1001:1001::/home/analyst:/bin/sh\n' > "$pw"
printf 'analyst:x:1001:\n' > "$gr"
canary_cleanup() {
  (fusermount -u "$canary_root" 2>/dev/null || fusermount3 -u "$canary_root" 2>/dev/null) || true
  rm -rf "$canary_root" "$canary_ws" "$pw" "$gr"
}
trap canary_cleanup EXIT

if ! squashfuse "$SQUASHFS" "$canary_root" 2>/dev/null; then
  bad "squashfuse could not mount $SQUASHFS"
  hint "the file may be truncated — re-run: just env-rootfs"
  exit 1
fi
ok "squashfuse mounted the env image"

# WHICH canary? The default one below runs the DEFAULT env's scientific interpreter, and
# that is the right, stronger probe for the env the e2e tier actually uses. It is also
# specific to that env: run it against another env's rootfs and it fails on a correct
# image. So under `--env <id>` — where the caller has named an env that may be any of
# them — the probe is the ENV-AGNOSTIC one (`jq`, the single binary every env image in
# this tree must carry, per scripts/lib/env-image-verify.sh), the same probe `--seams`
# uses. Weaker, and honest about being weaker: it proves the host can execute THIS
# rootfs under bwrap, which is what the flag claims.
# NO `eval` HERE, deliberately. An earlier version wrapped this in `eval` to interpolate
# the chosen command, which made the shell re-parse arguments the FIRST parse had already
# expanded — so `--ro-bind "$canary_root/usr" /usr` was word-split and globbed a second
# time. `canary_root`/`canary_ws`/`pw`/`gr` all come from `mktemp`, which honours TMPDIR,
# so a TMPDIR containing a space produced `bwrap: Can't find source path /tmp/sp` and the
# script then blamed the HOST — "the sandbox could not execute the science stack", with
# userns and /proc hints — for a host that was fine. A false diagnosis is worse than a
# failure. The command is passed as positional arguments instead, which never re-parses.
run_canary() {
  # Mirrors modules::sandbox::sandbox.rs build_bwrap_argv: /usr + /opt bound RO, a
  # writable workspace at /home/analyst, --clearenv, PATH with the venv first.
  bwrap \
  --clearenv --unshare-user --uid 1001 --gid 1001 \
  --unshare-uts --unshare-ipc --unshare-net --new-session --die-with-parent \
  --ro-bind "$canary_root/usr" /usr --ro-bind-try "$canary_root/opt" /opt \
  --ro-bind "$pw" /etc/passwd --ro-bind "$gr" /etc/group \
  --symlink usr/bin /bin --symlink usr/sbin /sbin \
  --symlink usr/lib /lib --symlink usr/lib64 /lib64 \
  --dev /dev --proc /proc --tmpfs /tmp \
  --bind "$canary_ws" /home/analyst --chdir /home/analyst \
  --setenv HOME /home/analyst --setenv USER analyst \
  --setenv PATH /opt/venv/bin:/usr/local/bin:/usr/bin:/bin \
  --setenv LANG C.UTF-8 --setenv OMP_NUM_THREADS 1 \
  --setenv OPENBLAS_NUM_THREADS 1 --setenv MKL_NUM_THREADS 1 \
  "$@" 2>&1
}

# WHICH canary? The default one runs the DEFAULT env's scientific interpreter — the right,
# stronger probe for the env the e2e tier actually uses, and specific to that env. Under
# `--env <id>` the caller may have named ANY env, so the probe is the ENV-AGNOSTIC one
# (`jq`, the single binary every env image in this tree must carry). Weaker, and honest
# about being weaker: it proves this host can execute THIS rootfs under bwrap.
#
# `canary_rc` is captured on the SAME line as each assignment, not after the if/else — a
# `$?` read after the branch would be the branch's status, not bwrap's.
if [ -n "$WANT_ENV" ]; then
  canary_out="$(run_canary sh -c 'printf "CANARY_OK "; jq --version')"; canary_rc=$?
else
  canary_out="$(run_canary python -c 'import scanpy, anndata, numpy, sys; print("CANARY_OK", sys.version.split()[0], numpy.__version__)')"; canary_rc=$?
fi

if [ "$canary_rc" -eq 0 ] && printf '%s' "$canary_out" | grep -q CANARY_OK; then
  ok "canary executed in-sandbox: $(printf '%s' "$canary_out" | grep CANARY_OK)"
else
  bad "the sandbox could not execute the science stack (exit $canary_rc)"
  printf '        ↳ output: %s\n' "$(printf '%s' "$canary_out" | tail -5)" >&2
  hint "this host has bwrap + the image but cannot RUN — check the /proc + userns hints above"
  exit 1
fi

if [ -n "$WANT_ENV" ]; then
  echo "== preflight PASSED for env '$WANT_ENV' — host tools OK and this rootfs EXECUTES ==" >&2
  echo "   (NOT the full real-compute claim: only the env-agnostic probe ran. Run without" >&2
  echo "    --env for the tier's own interpreter canary.)" >&2
else
  echo "== preflight PASSED — this host can run the real-compute processor tier ==" >&2
fi

# ── 8. MULTI-ENV (E5 / #193) ─────────────────────────────────────────────────
# Only under --seams, so the default last-line contract is untouched.
if [ "$SEAMS" = "1" ]; then
  echo "== multi-env: proving every LOCALLY STAGED env executes under bwrap ==" >&2
  assigns=""
  staged_count=0
  # The env set is DERIVED from the recipe tree by the local-loop script, never listed
  # here. `--print-seam` emits one `env '<key>__<id>=<path>'` per STAGED env and fails
  # loudly when nothing is staged.
  # PASS THE REAL REASON THROUGH. This used to assert "no env is locally staged", which
  # is only ONE of the ways --print-seam refuses — it also refuses when a staged
  # artifact's content does not match the sha256 the loop recorded for it, which is a
  # substituted rootfs, not a missing one. Printing the underlying message and then
  # asserting a different cause is the false-diagnosis failure this branch already fixed
  # once in the canary; a reader who trusts the last line goes and rebuilds nothing.
  if ! raw_seams="$(bash "$ROOT/scripts/build-env-rootfs-local.sh" --print-seam 2>&1)"; then
    printf '%s\n' "$raw_seams" >&2
    echo "== preflight FAILED: --seams could not obtain a trustworthy seam for every env ==" >&2
    echo "   The reason is printed immediately above — it is either 'nothing staged' or a" >&2
    echo "   staged artifact whose content does not match what the loop recorded for that" >&2
    echo "   env. Both are fixed by: scripts/build-env-rootfs-local.sh --all" >&2
    exit 1
  fi
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    # `env 'KEY=VALUE'` → KEY / VALUE, without eval. The value is a path that may itself
    # contain '='-free characters only; splitting on the FIRST '=' is what the kernel does.
    kv="${line#env \'}"; kv="${kv%\'}"
    key="${kv%%=*}"; path="${kv#*=}"
    # Strip the KNOWN PREFIX, not everything up to the last `__`. `env_image.rs`'s
    # ENV_SEAM_SUFFIX docs explicitly retract the claim that a doubled separator cannot
    # occur in a well-formed id — `a__b` is legal — and say the prefix is stripped as a
    # whole precisely because it is fixed-length. `${key##*__}` reintroduced the wrong
    # reason that comment warns about, truncating such an id in every diagnostic here.
    env_id="${key#${SEAM_KEY_BASE}__}"
    if [ ! -s "$path" ]; then
      bad "staged artifact for '$env_id' is missing or empty at $path"
      exit 1
    fi
    m="$(mktemp -d)"
    if ! squashfuse "$path" "$m" 2>/dev/null; then
      bad "squashfuse could not mount '$env_id' at $path"
      rmdir "$m" 2>/dev/null || true
      exit 1
    fi
    # The per-env capability probe. `jq` is the binary EVERY env image must carry, so
    # this names no analysis domain — and it RUNS, which is the only thing that can tell
    # a present-but-unloadable binary from a working one.
    out="$(bwrap \
      --unshare-uts --unshare-ipc --unshare-net --new-session --die-with-parent \
      --ro-bind "$m/usr" /usr --ro-bind-try "$m/opt" /opt \
      --symlink usr/bin /bin --symlink usr/sbin /sbin \
      --symlink usr/lib /lib --symlink usr/lib64 /lib64 \
      --dev /dev --tmpfs /tmp --chdir / \
      --setenv PATH /opt/venv/bin:/usr/local/bin:/usr/bin:/bin \
      --setenv LANG C.UTF-8 \
      -- /bin/sh -c 'jq --version' 2>&1)"
    rc=$?
    (fusermount -u "$m" 2>/dev/null || fusermount3 -u "$m" 2>/dev/null) || true
    rmdir "$m" 2>/dev/null || true
    if [ "$rc" -ne 0 ]; then
      bad "'$env_id' is staged but cannot EXECUTE under bwrap (exit $rc): $out"
      exit 1
    fi
    ok "$env_id executes in-sandbox ($out) — $path"
    # Accumulated as SHELL-QUOTED assignments so a path containing a space survives; the
    # earlier version rebuilt the prefix by word-splitting a joined string, which would
    # have silently truncated exactly such a path.
    assigns="$assigns '$key=$path'"
    staged_count=$((staged_count + 1))
  done <<EOF
$raw_seams
EOF
  # ANTI-VACUITY, floored against the RECIPE TREE rather than against what happens to be
  # staged. The subject list comes from `--print-seam`, which enumerates only artifacts
  # already in the cache — so it is blind to a DELETED artifact, and a floor of `>= 1`
  # let this print "multi-env PASSED" over a single env while the caller's next line
  # `eval`s a prefix that stages only half of what the tier needs. The recipe tree is the
  # one source that is not blind to a missing artifact, so that is what it is compared to.
  recipe_count="$(find "$ROOT/src-app/env-rootfs" -mindepth 2 -maxdepth 2 -name Dockerfile \
    2>/dev/null | grep -c . || true)"
  if [ "$recipe_count" -lt 1 ]; then
    echo "== preflight FAILED: no env recipe discovered — this check would range over nothing ==" >&2
    exit 1
  fi
  if [ "$staged_count" -ne "$recipe_count" ]; then
    echo "== preflight FAILED: $staged_count of $recipe_count declared env(s) are staged ==" >&2
    echo "   --seams claims to cover EVERY env; emitting a partial prefix would leave the" >&2
    echo "   tier without an artifact for the rest, and the seam would then refuse those" >&2
    echo "   jobs by name mid-run. Stage them all first:" >&2
    echo "       scripts/build-env-rootfs-local.sh --all" >&2
    exit 1
  fi
  echo "== multi-env PASSED — all $staged_count declared env(s) staged and executable ==" >&2
  # The LAST LINE under --seams is the whole command prefix, on one line:
  #     env 'CYTO_ENV_ROOTFS_SQUASHFS__<a>=/path/a' 'CYTO_ENV_ROOTFS_SQUASHFS__<b>=/path/b'
  # NOTE the `env` form and not `export`. The seam key embeds the env id, every id in
  # this tree contains '-', and '-' is not legal in a shell identifier — so neither
  # `export KEY=v` nor the `KEY=v cmd` assignment prefix can set these at all. `env(1)`
  # is the only form that works, and it is inherited by grandchildren.
  echo "env$assigns"
  exit 0
fi

# Under `--env <id>` the last line is the per-env SEAM ASSIGNMENT, not a bare path.
# A bare path is only usable through `CYTO_ENV_ROOTFS_SQUASHFS`, which `seam_serves`
# associates with the DEPLOYMENT DEFAULT when no `_ENV` companion is set — so consuming
# `--env X`'s output the way the justfile consumes the default output would ask for X and
# be refused (`ENV_IMAGE_STAGED_ENV_MISMATCH`). Fail-closed, but useless. Emitting the
# assignment makes the flag actually work, and the default invocation is untouched.
if [ -n "$WANT_ENV" ]; then
  # ROUTED THROUGH THE VERIFIED EMITTER, not built here. This used to print the seam line
  # itself from the path `fetch-env-rootfs.sh --print-path` returned — which is a
  # FILENAME, not a verified artifact — so it bypassed `--print-seam`'s content check
  # entirely. Demonstrated: against a cache slot holding another env's bytes,
  # `--print-seam` refused while `--env <id>` printed "preflight PASSED" and emitted that
  # env's seam key pointing at the other env's rootfs. Two consumers of one cache must not
  # disagree about whether its contents are trustworthy, so there is now one path.
  if ! seam_line="$(bash "$ROOT/scripts/build-env-rootfs-local.sh" --print-seam --env "$WANT_ENV" 2>&1)"; then
    printf '%s\n' "$seam_line" >&2
    echo "== preflight FAILED: no trustworthy seam for env '$WANT_ENV' ==" >&2
    echo "   The reason is printed immediately above." >&2
    exit 1
  fi
  printf '%s\n' "$seam_line"
  exit 0
fi
echo "$SQUASHFS"
