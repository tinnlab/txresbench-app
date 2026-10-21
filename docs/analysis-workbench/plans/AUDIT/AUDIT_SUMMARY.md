# FINAL-plan audit — consolidated findings

Four blind whole-platform audits ran over the 11 FINAL plans (282 items):
`cross-part-consistency.md`, `completeness-vs-design.md`, `scope-and-reuse.md`,
`global-sequence.md`. Overall: the plan set is **coherent, complete, in-scope,
and buildable** — the five intended ownership carve-ups are honored, scope is
clean (no distributed arm built, no seam closed), all 10 major design
capabilities have owned homes, and the effective land-order graph is acyclic
(6 build waves). The findings below are the reconciliation backlog before
implementation — they are seam/naming defects, not architectural holes.

## Must-fix (ranked)

- **A1 [HIGH] — the outputs-manifest field vocabulary diverges FOUR ways.** The
  `/outputs/manifest.json` contract is co-owned by P3 (writes it), P1 (ingests
  it), P2 (types it), P4 (records provenance from it), and each FINAL names
  different fields: P1 `output_id`/`datatype` (array), P3 `id`/`kind` under a
  `produces` key, P2 `id`/`type`, P4 `output_slot`. As written they won't
  serde-deserialize against one struct. **Resolution:** one canonical
  `OutputsManifest` struct owned by **P3** (the writer) and imported by P1/P2/P4;
  pick one field set — recommend `{ outputs: [{ id, datatype, path, layout,
  role }] }` — and make every part reference it. This is the linchpin seam of
  the whole compute→catalog→provenance chain.
- **A2 [SIGNIFICANT] — the AI/MCP host substrate is owned by no P1–P11 part.**
  chat + mcp-host + tool-approval + ai-providers is an XL prerequisite for the
  headline AI-assisted capability; P9 owns only the registry→tools GENERATOR
  that sits on top of it. Both the completeness and sequence audits flag it.
  **Resolution:** add an explicit **P0 platform-bootstrap** owner (port ziee's
  `chat`/`mcp` or land the SDK Tier-1 `mcp` registry) and schedule it in Wave 1
  in parallel, or it silently becomes the Wave-5 critical path.

## Should-fix (MEDIUM)

- **A3 — SchemaForm (form-from-JSON-schema renderer) is double-built** by P5 and
  P6. Resolution: **P6 owns** the renderer (it's a shell/host panel); P5 only
  defines the schema type the contribution declares.
- **A4 — the registry→MCP generator is double-owned** by P5 and P9. Resolution:
  **P9 owns** the generator; P5 owns the registry it reads. (P5 exposes the
  contribution metadata; P9 projects it to MCP tools/resources.)
- **A5 — `SyncEntity` name collision:** P1 emits `::Artifact`, another part uses
  `::AnalysisResult` for the same row. Resolution: one name — `::Artifact`
  (matches the P1-owned `artifacts` table).
- **A6 — conformance-battery package-cycle risk:** P7 ITEM-8 (publish the
  view-kind conformance battery) vs P5 ITEM-31 (it lives in `@cyto/workbench-api`).
  Resolution: the battery's TYPES live in `@cyto/workbench-api` (P5); P7 provides
  the concrete test-suite that imports them — no cycle.
- **A7 — P1/P4 stale-base reuse claim:** both ground "ziee-file is not a server
  dep / raw upload is greenfield" on the analysis-workflow tree, which is BEHIND
  main. Main tip `63520fb` already adopted ziee-file as a real server dep with
  dataset multipart upload (P2/P10/P11 correctly assume it exists). Re-ground P1
  ITEM-* + P4 ITEM-5 against main so the upload wiring isn't rebuilt.

## Minor / MVP-noop (track, not blocking)

- **A8 — annotation-artifact producer unowned:** the lasso→annotate write-back
  loop is wired in P6/P5/P8 facades but no part owns the concrete
  annotation-artifact producer. Assign to P11 (or a small P8 item).
- **A9 — Tier-3 precompute is routing-only** (noop for MVP) and
  `on_study_duplicated` may no-op the provenance copy — both acceptable for the
  first slice; note as known deferrals.

## The one intentionally-open boundary
- **scatter view-kind (P7 viz ↔ P11 embedding)** — the sole cross-part boundary
  the plans openly leave for a build-time decision. Recommend **P7 owns the
  scatter view-kind** (it's a generic plot type); P11's embedding module merely
  registers a default binding to it.

## Verdict
COHERENT / COMPLETE / IN-SCOPE / BUILDABLE with **2 must-fix** (A1 HIGH manifest
schema, A2 substrate owner) + **5 should-fix** dedup/naming/re-ground items. None
require re-planning a part — they are cross-part reconciliation edits to the
FINAL docs.
