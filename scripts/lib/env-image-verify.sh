# shellcheck shell=bash
#
# env-image-verify.sh — BEHAVIOURAL verification of a built env image.
#
# ── WHY THIS EXISTS (#196 R7) ───────────────────────────────────────────────────
# The guarantee "every env image can run `jq`, so a converter wrapper can parse
# params.json" was asserted by pattern-matching the RECIPE SOURCE:
#
#     assert!(src.contains(" jq "), ...)
#
# A COMMENT satisfied that. Proved on the shipped recipe, not hypothetically: deleting
# `jq` from the real apt line left the assertion TRUE, because three comment lines above
# it mention ` jq ` (`single-cell/Dockerfile:20,30,131`). The guard stayed green while the
# binary went missing from the image.
#
# The repair was then attempted three times as successively better source matching —
# strip comment lines, then handle `;#`, then `)#` and backtick-`#`. Every finding was
# real and every fix was correct, which is precisely the problem: deciding whether a `#`
# opens a comment means tokenising the shell, so the evasion space is unbounded and a
# zero-finding round is unreachable by construction. That is the `feature-lifecycle`
# phase-7 ABORT signature, and its remedy is explicitly *not another predicate*.
#
# So the guarantee moved to where it cannot be spelled around: the BUILT ARTIFACT.
# A comment does not install a binary and does not execute. Every spelling — the ones
# found and the ones not yet found — is covered by construction, because none of them put
# `jq` in the image.
#
# ── THE TWO TIERS, AND WHY THERE ARE TWO ───────────────────────────────────────
# A truly behavioural check needs a built image, which the default `cargo test` gate
# cannot afford (the shipped image is ~287 MB and a build pulls a full scientific stack).
# So the guarantee is tiered, and the tiers are stated rather than blurred:
#
#   AUTHORITATIVE (this file, `txr_verify_image_runs_jq`) — runs in the IMAGE-BUILD path
#     (`publish-env-rootfs.sh`, immediately after `docker build`). It EXECUTES `jq` inside
#     the image. This is the assertion that actually holds the property.
#
#   CONSUMER (this file, `txr_verify_rootfs_has_jq`) — runs in the FETCH path
#     (`fetch-env-rootfs.sh`), inside the squashfuse probe that already verifies the
#     schema marker and the interpreter. It asserts the binary is present in the artifact
#     actually received. Presence rather than execution, because the mounted rootfs's
#     dynamic loader is not the host's.
#
#     **BEST-EFFORT, and that is stated because a blind verifier proved it.** This tier is
#     SKIPPED — with a WARN, never a failure — on four paths, all inherited from the
#     pre-existing schema check it sits inside: squashfuse absent; the mount failing; a
#     cache HIT (the pull, and so the probe, never runs); and `--offline`. A jq-less image
#     can therefore pass the fetch path. It is defence-in-depth for the consumer, NOT the
#     thing that holds the property — the publish tier above is. Do not read a green fetch
#     as a verified image.
#
#   LOCAL FEEDBACK (E3, `verify-r-rootfs-local.sh`) — `command -v jq` inside the built
#     rootfs, arriving with the second recipe. It answers "is jq in this image?" WITHOUT a
#     publish, which the authoritative tier cannot do.
#
#     **These two are TIERS, not rivals, and neither subsumes the other — do not delete
#     one as redundant.** The publish check cannot run without a publish path; the local
#     check cannot stop a bad image reaching a registry. The AUTHORITATIVE one is the
#     publish check above: it is what holds the guarantee, because it is the one standing
#     between a jq-less image and the registry.
#
#   TRIPWIRE (`env_image.rs::every_env_recipe_source_mentions_jq_tripwire`) — the fast gate.
#     Deliberately weak, and its doc names its own holes. It catches the honest mistake
#     early; it does not hold the property, and it no longer claims to.
#
# This mirrors the shape a sibling branch used the same week after six evasions of an AST
# import-scan: move the guarantee to "run the real thing and observe it", demote the
# static scan to a tripwire whose docstring names what it cannot see.

# `jq` must EXECUTE inside the built image. $1 = a docker image reference.
# Returns 0 on success; prints an actionable diagnosis and returns 1 otherwise.
txr_verify_image_runs_jq() {
  _img="$1"
  if ! command -v docker >/dev/null 2>&1; then
    echo "[env-image] WARN: docker not on PATH — skipping the behavioural jq check" >&2
    return 0
  fi
  if _out="$(docker run --rm --entrypoint jq "$_img" --version 2>&1)"; then
    echo "[env-image] verified BEHAVIOURALLY: jq runs in $_img ($_out)" >&2
    return 0
  fi
  cat >&2 <<EOF
[env-image] FAIL: \`jq\` does not run in the built image $_img.

  A converter wrapper parses params.json with it, so an image without jq fails every
  such job at RUN time, inside a user's sandbox, far from this build.

  This is checked by RUNNING it, not by reading the Dockerfile: the source-text form of
  this check was satisfied by a COMMENT mentioning jq while the binary was absent
  (#196). Add jq to the recipe's install line — a comment will not satisfy this.

  docker said: $_out
EOF
  return 1
}

# `jq` must be PRESENT and executable in a mounted rootfs. $1 = the mount point.
# Presence, not execution: the image's loader is not the host's, so running it here would
# fail on a perfectly good image (the same reason the sibling /opt/venv check tests the
# symlink rather than executing python).
txr_verify_rootfs_has_jq() {
  _root="$1"
  for _p in usr/bin/jq bin/jq usr/local/bin/jq; do
    if [ -x "$_root/$_p" ] || [ -f "$_root/$_p" ]; then
      echo "[env-rootfs] verified: jq present in the received image (/$_p)" >&2
      return 0
    fi
  done
  echo "[env-rootfs] FAIL: no jq binary in the pulled image — a converter wrapper cannot" >&2
  echo "  parse params.json. Checked /usr/bin, /bin, /usr/local/bin. This reads the" >&2
  echo "  ARTIFACT, so no recipe comment can satisfy it (#196)." >&2
  return 1
}
