# @txresbench/config

Shared dev-config + design-token quality-gate tooling for txresbench-SDK apps. Extend the
configs so every app gets consistent linting, type-checking, and design-token
enforcement instead of re-inventing them (the documented root cause of UI drift).

Pairs with `@txresbench/kit` (`@txresbench/kit/styles`) — the lints here enforce the kit's
semantic tokens and component contracts.

## What it ships

| Export | What | How to consume |
|---|---|---|
| `@txresbench/config/biome` (`biome.base.json`) | Biome linter + formatter preset (generic rules, formatter, JS style, globals) | `"extends": ["@txresbench/config/biome"]` (or a relative path) in your `biome.json`; add your own `noRestrictedImports` / plugins |
| `@txresbench/config/tsconfig` (`tsconfig.base.json`) | Strict TS compilerOptions base | `"extends": "@txresbench/config/tsconfig"`; add app `paths`/`include`/`references` |
| `@txresbench/config/syncpack` | Shared version policy (`typescript` `~`, else `^`, one version everywhere) + `defineSyncpack()` | `.syncpackrc.mjs` → `export default defineSyncpack({ source, versionGroups })` |
| `@txresbench/config/check` (`txresbench-check` bin) | Composable gate: `tsc + biome guardrail + design-token lints + design-spec (+ kit-manifest)` | `"check": "txresbench-check --root=src ..."` |
| `@txresbench/config/lint/*` (+ `txresbench-lint-*` / `txresbench-design-spec` / `txresbench-kit-manifest` bins) | The individual parameterized lints/generators | run directly with `--root=<dir>` etc. |

## Design-contract lints (parameterized over the app's src dir)

Each lint takes `--root=<dir>` (repeatable) so it scans **your** tree:

- `txresbench-lint-colors` — no hardcoded colors (raw Tailwind hues, arbitrary color values,
  inline `style` color props); use the kit's semantic token classes.
- `txresbench-lint-settings-field` — settings form controls must live in a kit `Field`/`FormField`.
- `txresbench-lint-adjacent-inline` — adjacent inline pills need a horizontal gap.
- `txresbench-lint-logical-direction` — new/changed code uses RTL-safe logical direction
  utilities (`ps/pe`, `ms/me`, `start/end`); diff-scoped, parameterized via `--path-include`.
- `txresbench-lint-tooltip-placement` — peer buttons in a group share one tooltip side (advisory).
- `txresbench-design-spec` — generate/`--check` `DESIGN_SYSTEM.md` from the shadcn CSS token
  source (`--css`, `--out`, `--app-name`).
- `txresbench-kit-manifest` — generate/`--check` the kit's `KIT_MANIFEST.md` from its barrel
  (`--barrel`, `--out`, `--tsconfig-dir`).

Design-guardrail lints that encode a **curated, app-specific opinion** (e.g. an
action-word→icon map) are NOT shipped here — they stay with the app.

## Example: a new app's `check` script

```json
{
  "scripts": {
    "check": "txresbench-check --root=src --css src/index.css --design-out DESIGN_SYSTEM.md --no-kit-manifest"
  }
}
```
