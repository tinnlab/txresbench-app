---
name: ai-controllable-actions
description: >
  Binding rule for ALL user-facing actions in CytoAnalyst: every action a human
  can trigger must be registered as a permissioned `defineAction` so it is
  ALSO drivable by the AI agent (command palette + MCP `list_capabilities`/
  `describe_capability`/`invoke_capability`) — never a one-off inline
  onClick/handler that only the human path can reach. Covers global actions,
  instance actions (`useAction` + the stale-state guard), and the mandatory
  `npm run check` sub-checks (`action-refs-lint` + `action-coverage`) that
  enforce it. Use whenever you add, wire, or review any user-triggered
  mutation or navigation in the UI.
---

# AI-Controllable Actions

CytoAnalyst's north star (`docs/ai-controllable-actions/ARCHITECTURE.md`): **every
user action in the app is AI-controllable through the same definition a human
uses.** An action is declared ONCE via `defineAction` and is drivable by a human
(a button, the command palette) AND by the AI agent (MCP `invoke_capability`) —
never two parallel code paths for "the human way" and "the AI way." This skill is
the binding checklist for shipping that correctly. It is a **mandatory
feature-lifecycle sub-check** (see the last section) — not optional guidance.

## Register every user action as a permissioned `defineAction`

Every interactive affordance that mutates state or navigates — a button, a menu
item, a form submit — that you add or touch MUST be backed by a `defineAction`
call (`src/core/actions/defineAction.ts`), not a bare inline `onClick`. Rules:

- **Delegate to the existing store action — never duplicate logic.** A
  `defineAction`'s `run(params, ctx)` calls the SAME `Stores.<X>.<method>(...)`
  a human-triggered handler would call. The action is a thin, permissioned,
  AI-invokable WRAPPER around the real mutation, not a second implementation of
  it. Mirror `src/core/actions/builtin/appActions.ts` for the shape.
- **`permission` is MANDATORY and must be a REAL permission.** Every
  `defineAction` declares a `permission: Permissions.X` value that actually
  exists in the generated `Permissions` enum (`src/api-client/types.ts`) and
  that actually gates the underlying store action / REST call. Never leave it
  blank, never invent a string that isn't a real permission —
  `scripts/collect-actions.mjs --check` (part of `npm run check`) hard-fails on
  a missing or unknown permission. This is the SAME permission a human would
  need to see/click the affordance — the action registry never exposes
  something the user couldn't already do by hand.
- **`params` is a zod schema, not `unknown`/`any`.** It is both the runtime
  validation for `runAction(id, params)` and the source the manifest collector
  converts to JSON Schema for the MCP tool's input schema — an AI caller reads
  this schema to know what to pass. Use concrete field-level zod types (no
  bare `z.record(z.unknown())` catch-alls).
- **Set `mutating` honestly.** A read-only action (e.g. a future world-model
  read) is `mutating: false`; anything that changes state or navigates is
  `mutating: true`. This flag feeds the stale-state guard on instance actions
  (below) and any future approval-flow policy.
- **Register at module load, import for the side effect once.** Follow the
  existing pattern: define the actions in a `builtin/*Actions.ts` file, then
  import that file for its side effect from exactly one place (see
  `src/modules/actions/module.tsx`) — don't scatter `defineAction` calls across
  component files.

## Verify AI-drivability: command palette + MCP

A `defineAction` registration is not "done" until it is reachable from BOTH
surfaces a human and an AI actually use:

- **Command palette (human surface).** The action must appear in the ⌘/Ctrl-K
  palette (`modules/command-palette/`), permission-filtered via
  `hasPermissionNow` — a user who lacks the action's permission must NOT see it
  listed. If you registered an action but it doesn't show up in the palette
  when you have the permission, something is wrong (a missing import, a typo'd
  `permission`, or the palette's registry read is stale) — fix it before moving
  on, don't assume registration alone is sufficient.
- **MCP surface (AI surface).** The SAME action must be visible to an MCP
  client via `list_capabilities`, fully described via `describe_capability`
  (title, permission, params JSON Schema), and actually invokable via
  `invoke_capability` (`src-app/server/src/modules/mcp/handlers.rs`) — routed
  through the agent channel to the frontend engine. A permission a user lacks
  must make the action absent from `list_capabilities` for that user, and
  `invoke_capability` must refuse it server-side too (defense in depth — never
  rely on the frontend filter alone).
- **Both surfaces read the SAME registry.** If a palette entry and an MCP
  capability ever diverge (one shows an action the other doesn't, for the same
  user/permission state), that is a bug in the shared registry/manifest
  plumbing, not something to special-case per surface.

## Instance actions: `useAction` + the stale-state guard

A GLOBAL action (`kind: 'global'`) has no target beyond its params — app
navigation, "create a study." An INSTANCE action (`kind: 'instance'`) targets
one specific live UI instance (a specific open view, pane, or visualization) and
carries extra obligations:

- **Register the instance with `useAction(view_id, handlers)`.** A component
  that owns a live, addressable instance (mounted more than once, or
  addressable by an AI agent independent of which one currently has focus)
  registers its action handlers via the `useAction` hook keyed by a stable
  `view_id`, with mount/unmount lifecycle cleanup — never a bare module-global
  handler for something that can exist N times.
- **World-model reads before writes.** The AI discovers what instances exist
  and their current state via the read-kind actions (`views.list` /
  `view.describe` / `selection.get`) BEFORE invoking a mutating instance
  action — read-before-write, not "guess the `view_id` and mutate blind."
- **The stale-state guard is mandatory for `mutating + stateful` instance
  actions.** Every instance carries a `version` that bumps on each mutation
  (the `versioned` per-instance store helper); every read returns a
  `_state_token` reflecting that version. A mutating+stateful action REQUIRES
  an `expected` token matching the instance's CURRENT version — a mismatch is
  rejected as `STALE_STATE` (the AI must re-read and retry), never silently
  applied against state the AI's last read didn't reflect. Backend mutating
  REST ops the action delegates to should use the equivalent optimistic
  concurrency (`If-Match`/409) where the route supports it, relayed to the
  agent as `STALE_STATE`.
- **Don't build a parallel non-atomic path.** The versioned-store + expected-
  token check happens in ONE place (the engine), enforced for every
  mutating+stateful instance action uniformly — never bolt a bespoke
  staleness check onto one component's handler.

## Audit for un-registered actions

Before you consider action-related work done, run the two completeness checks
(both are chained into `npm run check` — see below):

```bash
cd src-app/ui
node scripts/action-refs-lint.mjs      # HARD-fail: every action="..."/runAction('...')
                                        # reference must name a REGISTERED action id
node scripts/action-coverage.mjs       # advisory, allowlist-aware: an opted-in file's
                                        # inline onClick must not bypass the registry
```

- **`action-refs-lint.mjs`** scans `src/**` for every `<ActionButton
  action="X">` (incl. `action={'X'}`) and `runAction('X', ...)` reference,
  loads the REAL registered action ids (the same esbuild-import technique
  `collect-actions.mjs` uses to read `getActionRegistry()`), and HARD-FAILS on
  any referenced id that is not registered — catching a renamed/deleted/
  typo'd action id before it ships as a dead button. A dynamically-computed id
  (`action={someVar}`) is not statically decidable and is reported as skipped,
  not failed.
- **`action-coverage.mjs`** is the advisory half (DEC-6: a repo-wide "every
  onClick is an action" hard-fail isn't statically decidable). It only checks
  files listed in `scripts/action-coverage-allowlist.txt` (opt-in, seeded
  empty) for a `<Button onClick={...}>` that directly calls a
  `Stores.<X>.<method>(...)` — i.e. a store mutation that bypassed the action
  registry entirely. As you migrate a directory onto the actions model, add it
  to the allowlist so this check starts enforcing there.
- **When you touch a UI surface that has affordances but no actions yet**,
  register them (per the first section above) rather than adding another
  inline handler — that is exactly the gap this skill exists to close.

## Mandatory feature-lifecycle sub-check

This is not optional polish — it is wired into the gate every UI-touching
feature must pass:

- `npm run check` in `src-app/ui` chains `tsc --noEmit` →
  `collect-actions.mjs --check` (manifest drift + permission validity) →
  `action-refs-lint.mjs` (dangling reference hard-fail) → `action-coverage.mjs`
  (allowlist-aware advisory check). A feature branch that adds a UI action
  without registering it, or leaves a dangling `action="..."` reference, FAILS
  `npm run check` — the same gate the feature-lifecycle Phase 8 test run
  requires green for any frontend-touching diff.
- Any feature-lifecycle plan (`.lifecycle/<feature>/PLAN.md`) that adds a new
  user-facing button/menu-item/form-submit MUST include registering it as a
  `defineAction` as a plan ITEM, and its TESTS.md coverage must include running
  `npm run check` (which now covers this skill's rules) among the recorded
  gate results.
- If you are unsure whether something needs to be a registered action: if a
  human can click/trigger it AND it does something more than pure local UI
  state (open a dropdown, toggle a tab), it needs one. When in doubt, register
  it — an unnecessary action registration is a much smaller mistake than an
  AI-invisible affordance the agent can never drive.
