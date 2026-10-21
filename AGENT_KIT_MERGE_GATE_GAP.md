# agent-kit merge-gate gap — staging worktree never inits submodules

`agent-kit/lifecycle/merge-gate.mjs` stages the candidate merge with
`git worktree add --detach <staging> <base>` (`merge-gate.mjs` ~line 280) and then runs the C1
(`cargo clean -p <pkg> && cargo check`) and C3 (`just openapi-regen` → generated-parity) gates against
that staging tree — but it **never inits the git submodules in the staging worktree**. A fresh
`git worktree add` checks out the superproject's tree with **empty submodule directories**, so for any
app whose crates path-depend on a submodule (cyto's `cytoanalyst` crate path-depends on `sdk/crates/*`),
the staged `sdk/` is empty and C1/C3 both die on missing path-deps — the gate silently degrades (C1
FAILs on "can't find sdk/crates/…", or SKIPs when `MERGE_CARGO_DIR` is also mis-set). **Proposed upstream
fix:** immediately after the `git worktree add --detach` succeeds (before `gateMergeAndP2C5`/`gateC1`/
`gateC3`), run `git -C <staging> submodule update --init --recursive` (or, to stay cheap, a configurable
`MERGE_SUBMODULES` list from `app.config`, defaulting to all submodules) so the staged tree is buildable
exactly as the real merge/CI tree is. This is app-agnostic (a no-op for apps with no submodules) and is
the single missing step between merge-gate.mjs and a working cyto backend gate. Until it lands, cyto uses
the local `scripts/verify-backend-merge.sh` wrapper (which performs this init) as its backend merge gate;
the paired `app.config` fix (`MERGE_CARGO_DIR=src-app/server`, cyto's cargo root — previously `src-app`,
which has no `Cargo.toml`, so C1 SKIPped) is cyto-local and correct regardless.
