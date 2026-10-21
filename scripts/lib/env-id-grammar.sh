# shellcheck shell=bash
#
# env-id-grammar.sh — the env-id grammar, for the SHELL readers.
#
# ── WHY (#196 R7) ───────────────────────────────────────────────────────────────
# The shell readers derive env ids from the manifests with an indentation-exact awk
# block reader (no YAML dependency — DEC-1: "a gate a transitive dep bump can break is a
# worse gate"). That reader cannot see several LEGAL YAML shapes: a flow map
# `- {id: x, env: y}`, a deeper-indented list, a quoted key `"env":`, a folded scalar, an
# anchor/alias. A blind audit showed those either vanish from the derived vocabulary or
# derive GARBAGE — a folded scalar yields the id `>-`, an alias yields `*E`.
#
# Both outcomes were SILENT, and no floor could see them: a floor is a minimum, and a
# MISSED ADDITION is invisible to a minimum by construction. That is the mirror image of
# the §4 deletion blind spot, in the direction §4 does not cover.
#
# Validating the derived id makes the whole class LOUD without parsing YAML: a shape the
# reader mis-parses produces something that is not a legal env id, and we refuse instead
# of building an OCI reference out of it.
#
# ── SINGLE-SOURCING ─────────────────────────────────────────────────────────────
# The grammar's home is `src-app/server/src/modules/sandbox/env_id.rs::is_valid_env_id`,
# which `build.rs` `#[path]`-includes so the runtime and the build lint cannot drift.
# Shell cannot include Rust, so this file is the shell arm of the same grammar — and the
# drift is prevented the way this repo already prevents it for the publish workflow: by a
# PARITY TEST that runs both implementations over one shared table of cases
# (`env_script_derivation_test::the_shell_env_id_grammar_matches_the_rust_one`).
# Change one and the parity test fails; there is no silent mirror.

# Whether $1 is a valid env id: a non-empty OCI repository path component made of
# lowercase alphanumerics plus `.`, `_`, `-`. Mirrors `is_valid_env_id` exactly.
# The character class is SPELLED OUT rather than written as the ranges `a-z0-9`, because
# a range in a `case` glob is collation-dependent: with `globasciiranges` off under a
# UTF-8 locale, bash accepts `MixedCase`/`UPPER`/`B` where Rust rejects them. Not reachable
# with bash's defaults, but a latent divergence between two implementations of one grammar
# is exactly what the parity test exists to prevent — so the class is made locale-proof
# rather than left depending on a shell option nobody sets deliberately.
cyto_is_valid_env_id() {
  case "$1" in
    "") return 1 ;;
    *[!abcdefghijklmnopqrstuvwxyz0123456789._-]*) return 1 ;;
    *) return 0 ;;
  esac
}
