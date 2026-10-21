# SDK lazification — what this branch actually bought, measured

Every number here was produced on this branch vs `origin/main`, same commands,
same machine. Where something was **not** measured, it says so.

## Bundle: no win. Slightly negative.

Built both sides (`npm run build`, `main` in a detached worktree):

| | `origin/main` | `feat/sdk-lazification` | delta |
|---|---|---|---|
| entry JS (gzip) | 352.99 kB | **355.04 kB** | **+2.05 kB** |
| total (gzip) | 1533.1 kB | **1535.5 kB** | **+2.4 kB** |
| emitted assets | 119 | 118 | −1 |

**Why there is no win, and why that was expected.** The `Stores` shim
(`src-app/ui/src/core/stores.ts`) keeps every store eagerly registered, and
`Stores.X` is a *synchronous registry lookup* — it structurally forces a store to
be loaded before it can be read. Whole-store laziness requires retiring the
global, which is the multi-week Option-B migration (41 store files, 105
consumers, 411 call sites). The +2 kB is the lazy machinery itself, present and
inert.

Ziee's measured entry-chunk result (632.6 kB → 16.9 kB gzip) came from Option B,
**not** from adopting the SDK line. Do not read "adopted the lazy refactor" as a
delivered perf win.

## The actual biggest lever is NOT the stores

The critical path is what `index.html` modulepreloads. Measured on this branch:

| chunk | gzip | share of critical path |
|---|---|---|
| **`Viz`** | **549 kB** | **48%** |
| entry `index` | 343 kB | 30% |
| everything else (10 chunks) | ~260 kB | 22% |

**`Viz` is larger than the entry chunk, and the entry statically imports it** —
verified by grepping the built entry for the `Viz` chunk hash (2 references). So
~549 kB gzip of visualization code is downloaded on **every** page load,
including the login screen, on a surface that cannot render a chart.

`@ziee/viz` has **zero dynamic imports** and **10 static VALUE imports** (plus 4
type-only, which are erased and free):

| # | site |
|---|---|
| 1 | `src/gpu-parity.tsx:11` |
| 2 | `modules/visualization/adapter/autosave.ts:26` |
| 3 | `modules/visualization/module.tsx:16` — via `@ziee/viz/core`, a **different** specifier |
| 4 | `modules/workbench/gallery.tsx:7` |
| 5 | `modules/visualization/adapter/VisualizationPage.tsx:29` |
| 6 | `modules/workbench/core/spec/schema.ts:13` |
| 7 | `modules/workbench/extensions/canvas/installCanvasWidgets.ts:21` |
| 8 | `modules/workbench/extensions/canvas/viz.tsx:17` |
| 9 | `modules/workbench/extensions/canvas/canvasBinding.ts:29` |
| 10 | `modules/workbench/extensions/canvas/CanvasView.tsx:21` |

`schema.ts` sits on the module-registration path, which is why the chunk lands in
the entry.

> **CORRECTION.** An earlier revision of this document claimed "8 static import
> sites … three value imports" and named only 6, 7 and 10. That was wrong: the
> grep behind it matched only single-line `import … from '@ziee/viz'` and missed
> every MULTI-LINE import ending in `} from '@ziee/viz'`. Deferring only those
> three would have left **seven** static value imports in place, kept the 549 kB
> chunk eager, and produced no movement in the re-measure — the exact
> "defeated by two lines in a barrel" failure this section cites. Caught by a
> blind audit of this branch.

This is the same shape as ziee's own biggest wins, which were also not stores:
deferring Streamdown/shiki/KaTeX bought **−150.5 kB gzip**, and a later round
found `LazyDatePicker` defeated by *two lines in a barrel*, costing 24.6 kB gzip
on the preloaded path.

### Recommended order for the next piece of work

1. **Make `Viz` lazy** — defer **all ten** value imports above (not a subset:
   any one left static on a boot-reachable path keeps the whole chunk eager).
   Biggest lever. Re-measure against the table above, using the modulepreload set
   in `dist/index.html` as ground truth — not the import count, and not whether a
   chunk merely exists.
2. **Audit the barrels** — build with `INEFFECTIVE_DYNAMIC_IMPORT` surfaced.
   Every one of ziee's blockers traced to a barrel re-export, and this app has
   the same ones (`kit/index.ts`, `api-client/index.ts`, `stores/index.ts`).
3. **Only then Option B**, incrementally — admin stores first, since they are
   read solely on settings pages.

## What the branch DID buy

Not bytes — correctness and transport:

- in-flight GET coalescing, chunk-load recovery, sync 429 backoff, the
  permission-scoped module prefetch (all free on the pointer move)
- a **token-revocation epoch** on the sync stream, so a logout ends an
  already-open SSE stream instead of it living to the token's `exp`
- an authz fix: `op_available` gated on only the *first* required permission.
  **Scoped honestly after audit:** this was an over-*advertisement* of
  capabilities, not a live invocation hole — `invoke_rest` forwards the caller's
  bearer to the loopback route, whose `RequirePermissions` already enforces
  ALL-of. And no `RequirePermissions<(…)>` in the tree currently declares more
  than one permission (121 sites, zero multi), so old and new behave identically
  today. The fix is still correct; it is not a patched vulnerability.
- the SDK's own `routesSeam` hole closed (nothing in `packages/` called `.set()`
  while two call sites called `.get()`, which throws — an app using the shipped
  router boot-crashed)
- the kit fixes that `cyto` carried and `chat` lacked (dark-mode-invisible text,
  white borders, tab stacking)

## E2E: zero regressions, verified two independent ways

`tests/e2e/{workstore,datasets,command-palette,jobs}`, `--workers=2`, identical
subset both sides:

| | branch | `origin/main` |
|---|---|---|
| failed | 21 | 21 |
| passed | 17 | 17 |

**Spec-by-spec `comm` diff: the failing sets are IDENTICAL** — zero specs fail on
the branch that pass on main, and zero the reverse. Not a count match; the same
set. Independently corroborated by a second pairing over 15 spec files
(18 failed / 2 passed on *both* sides, test-for-test).

Boot proof: `tests/e2e/project/projects-crud.spec.ts` — **1 passed (11.9s)** —
login → projects → CRUD against a real backend and built SPA, exercising all
three runtime seams at once. `smoke.spec.ts` reaches the shell AppLayout with
nav, sidebar and command palette rendered; its one JS error
(`GET /api/processors/packages: Authorization header is missing`) fires at
module-evaluation time from `workbench/module.tsx:53` with no auth gate, is
present on `main` too, and `main` additionally has a second error the branch does
not.

### Caveats, stated rather than buried

- **No full e2e suite completed on either side, and the reason is UNKNOWN.**
  An earlier revision of this document blamed memory starvation ("3 GB RAM,
  swap consumed by a shared vLLM tenant"). **That was wrong.** `free -g` reports
  GIGABYTES; 3023 was misread as megabytes. Measured properly: `MemTotal
  3023.5 GB`, `MemAvailable 660.0 GB` — the box has 3 TiB of RAM. Postgres was
  using 9 of 200 connections and load was 37 on 192 cores, so neither memory,
  connections, nor CPU was constrained. The late runs did degrade into login
  timeouts, but **no cause was established** and it must not be recorded as
  environmental. Swap is genuinely exhausted (8 GB total, 0 free), which on a
  3 TiB box is not obviously meaningful.
- **`@acceptance`-tagged specs were excluded from every run** (they need a
  sandbox-executable host). An excluded test is not a passed test.
- 17 tests self-skipped and are reported as skipped, not as passes.

## Not measured

- Runtime boot timing (FCP, interactive) on either side — **not measured**.

## Boot requests: measured, and also no win

Logged-out boot on the branch:

```
api 2 · distinct 2 · duplicates 0 · assets 79 · last request 1207 ms
GET /api/app/setup/status
GET /api/processors/packages
```

**GET coalescing has nothing to coalesce on this path** — two API calls, zero
duplicates. It is genuinely wired (unconditional in `callAsync`), it simply has
no work to do here.

**Boot-chain parallelization is NOT adopted.** Ziee's `/auth/me` 360 ms → 62 ms
came from an app-side change (`bootSessionVerify` called from the auth module's
`initialize()`); this app has no such file and still issues `/auth/me` from
`AuthGuard`'s mount effect (`AuthGuard.tsx:24`). That win is unclaimed.

79 asset requests on a login screen is the bundle story again — the 549 kB `Viz`
chunk is among them.

## Known-open, deliberately not fixed here

- `DefaultIdentityResolver::authenticate` never checks the token epoch, so a
  logged-out user's access token still works on REST until `exp`. The SDK's own
  `jwt_extractor` documents that every route-gating caller MUST verify it — the
  default resolver violates its own stated invariant. **An SDK bug; report
  upstream.**
- `access_token_exp` is likewise `None`, so an expired-but-unrevoked token's sync
  stream has a far-future deadline.
- The next `just openapi-regen` will break ~63 `Permissions` importers: the new
  SDK splits `types.ts` into four files. It does **not** fire on the pointer
  bump, only on a regen.
