# CytoAnalyst → ziee SDK — Friction / Gap Log

**Purpose:** this is the *whole point* of building CytoAnalyst in parallel with the SDK
extraction. Every entry is a real friction point discovered by actually consuming the SDK
as app #2 — something missing, a ziee-domain concept leaking into an SDK crate, an awkward
boundary, or a crate not yet extracted. This log tells **live1** what to extract / fix next.
(Coordination is via the human, not direct.)

- **SDK pinned at:** `70b10ae1` (bumped from `6cf9426` for the **FileAccessPolicy seam** — `ziee-file`
  authorized every mounted route on a bare `files.user_id`, so a member removed from an org kept
  download, enumeration, token-mint and DELETE on files they had uploaded into that org's dataset;
  confirmed by executing it, not by reading. Ownership is no longer authorization: the policy is a
  REQUIRED constructor argument, so omitting it is a compile error rather than an inherited default)
  (bumped from `8ef05c2` for #2 G-AUTHEVT: the injectable in-tx UserCreatedHook) (bumped from `b1d390f`, which was bumped from `2208047`, in turn bumped from `c29601dd` for the
  streaming byte read — see "G-STREAM" at the bottom. Previously `79378b5`, bumped from `e2fce04a2`
  when the batteries + infra crates landed — see the "SDK batteries audit" section for what got fixed).
- **Legend:** severity = friction to a *fresh app author*. LEAK = an SDK crate names an
  app-domain concept. MISSING = capability an app needs that the SDK doesn't provide yet.
- Status: `open` / `worked-around` (app has a local shim) / `fixed` (live1 landed it).

---

## SDK batteries audit (bumped to `79378b5`) — what got FIXED + 3 NEW gaps

live1 landed `sdk-batteries` + `sdk-fe-batteries` + infra crates. CytoAnalyst re-audited and
**migrated off its workarounds to the SDK-provided versions** (dogfooding proof the fixes work).
All verified: fresh-cluster boot → setup → login → `/auth/me` (DefaultIdentityResolver) → user/
group CRUD → 401/403 gating, all green.

### ✅ FIXED + adopted
| Gap | SDK now provides | CytoAnalyst change |
|---|---|---|
| **G1** no default resolver / turnkey auth | `ziee_auth::auth::{DefaultIdentityResolver, NoopAuthEventSink, NoopAuthSyncSink, mount_auth}` | deleted `identity.rs` (CytoIdentityResolver) + my no-op sinks; alias `RequirePermissions` → `DefaultIdentityResolver`; `install_auth_layers` uses SDK sinks |
| **G2** no config loader | `ServerConfig::{load_from, load, validate_jwt_secret}` (CONFIG_FILE discovery + weak-secret refusal) | `config.rs` is now a 6-line wrapper over `load_from`/`load` |
| **G3** embedded_pg path leak | `embedded_pg::resolve_embedded_paths` + inline defaults | now optional (kept explicit dev dirs for data-location control) |
| **G4/G5** no build.rs helpers | `ziee-build-support` crate (`compose_merged_migrations`, `worktree_db`, `provision_build_db`) | `build.rs` calls `compose_merged_migrations` (was a ~60-line inline copy) |
| **G7** rate-limit ConnectInfo foot-gun | `ziee_framework::serve` (connect-info + graceful shutdown) | `lib.rs` uses `serve()`; deleted the manual `into_make_service_with_connect_info` |
| **FE-2** hard-coded token, no setter | `setAuthToken` / `setAuthTokenProvider` (default still reads `auth-storage`) | frontend unchanged — the default keeps working; setter available if needed |
| **FE-1 / FE-3** router / kit Tailwind | (partial — `sdk-fe-batteries`) | not re-audited yet; current frontend works as-is |

### 🔴 NEW gaps found during the batteries audit

#### N-1 — `ziee-notification` migration FK-references `conversations` (chat) · LEAK · HIGH · worked-around
`sdk/crates/ziee-notification/migrations/202607144180_notification_fkeys.sql` references
`public.conversations` — a **ziee-domain (chat) table**. Any app that merges this migration but
has no chat schema fails to migrate (`relation "public.conversations" does not exist`). The
extracted `ziee-notification` infra crate must not depend on a domain table.
**Repro:** globbing all `sdk/crates/*/migrations` into an app that lacks `conversations` →
boot fails. **Ask:** drop the `conversations` FK from the notification migration (or move that
FK to a ziee-side side-table, like the `workflow_run_id` decision).

#### N-2 — `compose_merged_migrations` globs ALL crates under a root; can't scope to app deps · MISSING · MED · worked-around
`ziee_build_support::compose_merged_migrations(merged, roots)` globs `<root>/*/migrations` for
EVERY crate under `sdk/crates`, regardless of which the app links. CytoAnalyst depends only on
`ziee-auth`, but the glob now also pulls in `ziee-file` + `ziee-notification` (→ N-1 breakage).
An app must hand-scope: I call `compose_merged_migrations` for my own modules, then explicitly
copy only `ziee-auth/migrations`. **Ask:** a variant that takes explicit crate migration dirs
(the app's actual schema-bound deps), or filter by linked crates.

#### N-3 — `mount_auth` doesn't compose with `build_api_router`'s `api_prefix` nesting · MISSING · MED · worked-around
`ziee_auth::auth::mount_auth` nests `/auth` at the router level it's called on + layers the auth
extensions there. But the framework's standard `build_api_router` already nests every module
route under `/api`, so calling `mount_auth` on that result puts auth at `/auth` (not `/api/auth`),
AND its extensions would only cover the auth sub-router (not the user routes that need the
resolver for `RequirePermissions`). So the turnkey `mount_auth` only fits apps that build+nest
their router by hand, NOT the module-system + `build_api_router` path. CytoAnalyst kept a thin
`AuthModule` (registers `auth_routes::<DefaultIdentityResolver>()`) + `install_auth_layers`
instead. **Ask:** a `mount_auth` that composes with `build_api_router` (e.g. an auth *module*
the app registers, or a `build_api_router` hook), so the batteries reach the standard path.

### ⏳ Watching for: test-infra extraction (harness / gallery)
Not in `sdk/main` yet (`79378b5` has no test-harness/gallery crate). When it lands, audit
CytoAnalyst's (currently absent) test suite + gallery against it and adopt.

---

## Discovered during Phase-0 investigation (before writing app code)

### G1 — No default `IdentityResolver` impl ships in the SDK · MISSING · MED · open
`ziee_framework::permissions::IdentityResolver` is the injected identity seam that
`auth_routes<R>` / `RequirePermissions<R,_>` are generic over — but **no crate provides a
concrete impl**. Every app must hand-write `authenticate()` + `load_groups()` +
`active_group_permissions()`, even though a correct impl is 100% expressible over
ziee-auth's already-shipped `UserRepository::{get_by_id,get_user_groups}` + `JwtService::{
extract_token_from_header,validate_access_token}` + `User`/`Group`. ziee's own resolver
(`ZieeIdentityResolver`, ~90 lines) only differs by reaching a global `Repos`.
**Ask:** ship `ziee_auth::DefaultIdentityResolver` (constructed from a `PgPool` +
`Arc<JwtService>`) that any app installs directly; keep the trait for apps with exotic
identity. Without it, the JWT-extraction + active-user + inactive-user-403 logic is copied
verbatim per app and can silently drift from ziee-auth's intended contract.
_Impact on CytoAnalyst:_ must write `src/identity.rs` (step 5). Worked-around once written.

### G2 — No config-file loader in the SDK · MISSING · LOW-MED · open
`ziee_core::config::ServerConfig` derives `Deserialize` but the SDK ships no
`ServerConfig::load_from(path)`, no config-file search/precedence, no env-var expansion
(`ZIEE_*` overrides), and no weak-`jwt.secret` refusal. ziee has all of this in its app-side
`Config::load_from`. A fresh app re-implements YAML load + validation.
**Ask:** a thin `ziee_framework::config::load_server_config(path) -> ServerConfig` with the
env-override + weak-secret-refusal behavior ziee already documents in CLAUDE.md.

### G3 — `embedded_pg` requires paths an SDK-absent `resolve_paths` was meant to fill · LEAK+MISSING · MED · open
`ziee_framework::embedded_pg` hard-`expect()`s `postgresql.embedded.installation_dir` and
`data_dir` with the panic message *"filled by `Config::resolve_paths`"* — but
`Config::resolve_paths` is a **ziee-app-side** function that does not exist in the SDK, and
`ServerConfig` has no `app.data_dir` field to derive them from. So the SDK's embedded-PG
boot contract references a symbol only ziee has, and a fresh app must hard-code both dirs in
YAML or re-implement resolution. The panic string is a literal domain leak.
**Ask:** either (a) default the two dirs to a temp/config-relative path inside `embedded_pg`
when unset, or (b) add an SDK `resolve_embedded_paths(&mut ServerConfig, data_dir)` and scrub
the ziee-specific symbol name from the panic message.
_Impact on CytoAnalyst:_ dev.yaml sets both dirs explicitly (worked-around).

### G4 — No build-DB provisioning helper for app modules that use `query!` · MISSING · MED · open
sqlx compile-time `query!` verification needs a migrated build DB. ziee's
`build_helper/worktree_db.rs` (FNV-1a per-worktree keying → `CREATE DATABASE` → migrate) is
duplicated **verbatim** inside `ziee-auth/build.rs`, and any app module wanting `query!`
must copy it a third time. The SDK exposes none of it for build scripts.
**Ask:** `ziee_framework::build_support::provision_build_db(migrations_dir) -> String` (the
per-worktree-isolated URL) callable from an app's `build.rs`.
_Impact on CytoAnalyst:_ the stub `dataset` module uses **runtime-checked** queries
(`query_as` + `FromRow`, no `query!`) to stay build-DB-free — but that forfeits compile-time
SQL verification, a real downgrade an app shouldn't have to accept.

### G5 — No migration-merge helper for `build.rs` · MISSING · MED · open
Composing `migrations-merged/` (glob each module's `migrations/` ∪ `sdk/crates/*/migrations/`,
basename-collision-guard, version-sort) is ~60 lines of app-side `build.rs` boilerplate every
SDK consumer must copy from ziee. The model (decision N7 "module-owned migrations, build.rs
composes them") is an SDK contract, so its implementation should be SDK-provided.
**Ask:** `ziee_framework::build_support::compose_merged_migrations(module_roots, out_dir)`.
_Impact on CytoAnalyst:_ copied into `src-app/server/build.rs` (worked-around).

### G6 — Gap between `skeleton-server` and a real app has no template · MISSING · HIGH (onboarding) · open
The handoff says "start from `skeleton-server`", but skeleton-server boots framework-only with
a **lazy, never-connected** pool and shows none of: config-file load, embedded-PG boot +
migrations, auth mount, `--generate-openapi` CLI, a module with a repository/migrations, or a
frontend. The only *real* reference is ziee's own server crate — a ~20k-line monolith you must
reverse-engineer. There is nothing in between, so a fresh app author reconstructs the entire
boot spine by reading ziee. This is the single biggest dogfooding friction so far.
**Ask:** an `examples/minimal-app` that boots embedded PG + mounts auth + one CRUD module with
its own migrations + wires `--generate-openapi` + a minimal `@ziee/framework` UI. That example
IS the copy-start the handoff assumes exists. (CytoAnalyst's `src-app/server` is effectively
becoming that reference — its boot spine should be upstreamed.)

---

## Discovered during implementation

### G7 — `apply_rate_limit_layer` has an unenforced `ConnectInfo` requirement · LEAK(impl-contract) · MED · worked-around
The SDK's `apply_rate_limit_layer` installs a tower-governor `GovernorLayer` with a
`PeerIpKeyExtractor`, which reads `ConnectInfo<SocketAddr>` from each request. But that
extension only exists if the app serves with
`app.into_make_service_with_connect_info::<SocketAddr>()`. A fresh app that copies the
obvious `axum::serve(listener, app)` boots fine and then returns **`Unable To Extract
Key!`** (tower-governor's raw error) on *every* request — with no hint that the rate-limit
layer is the cause. ziee's own boot path knows to use `_with_connect_info`, but that
knowledge lives only in ziee, not in the SDK's layer contract.
**Ask:** either (a) an SDK `serve(listener, router, &config)` helper that wires connect-info
+ graceful shutdown correctly, or (b) `apply_rate_limit_layer` should document/assert the
requirement (and ideally the layer would fall back to a non-IP key rather than erroring the
request when ConnectInfo is absent).
_Impact on CytoAnalyst:_ first real boot returned "Unable To Extract Key!" on GET /datasets;
fixed by switching main.rs to `into_make_service_with_connect_info::<SocketAddr>()`.

### G1 (confirmed in the concrete) — mounting "free" auth cost ~230 lines + 2 trait impls
Step 5 quantified G1. To get login/register working, CytoAnalyst had to hand-write:
- `src/identity.rs` — the `CytoIdentityResolver` (~110 lines, near-verbatim ziee's).
- `src/modules/auth/mod.rs` — an `AuthModule` that mounts `auth_routes::<R>()` +
  `auth_admin_routes::<R>()`, PLUS **two trait impls** (`NoopEventSink: AuthEventSink`,
  `NoopSyncSink: AuthSyncSink`) required by `AuthContext::new`, PLUS an `install_auth_layers`
  that layers `Extension<Arc<JwtService>>` + `Extension<AuthContext>` + `Extension<Arc<R>>`
  onto the router, PLUS the `set_trust_forwarded_headers` + session-settings seed in `init`.
- main.rs: construct `JwtService::try_new` + call `install_auth_layers` at the right point.
It all WORKS (register→JWT, /me resolves Users-group perms, RequirePermissions 401/403/200),
and it's mechanical — which is exactly why the SDK should own it. **Ask (concrete):**
`ziee_auth::DefaultIdentityResolver`, `ziee_auth::NoopAuthEventSink` / `NoopAuthSyncSink`, and
an `AuthModule`/`mount_auth::<R>(pool, jwt, cfg)` an app registers in one line. That would
collapse ~230 lines of copy-from-ziee to ~5.

## Frontend (Step 6) — `@ziee/framework` + `@ziee/kit`

The UI shell **builds** (`vite build`: 3662 modules, 149 KB CSS with kit tokens scanned,
401 KB JS) — the packages are genuinely consumable by a fresh app. Gaps found:

### FE-1 — No router in the SDK · MISSING · MED · worked-around
`@ziee/framework` gives module registration + `order`-sorted component rendering only. ALL
routing (react-router `BrowserRouter`, a `Routes` store, the `CreateModuleOptions.routes`
declaration-merge, layout/guard grouping) is hand-rolled app code (~200 lines in app#1's
`src/modules/router/`). **Ask:** ship an optional `@ziee/framework/router` (or document that
routing is app-owned). CytoAnalyst used react-router directly in `App.tsx` to stay minimal.

### FE-2 — Hard-coded auth-token storage contract, no `setAuthToken` · LEAK · HIGH · worked-around
`getAuthToken()` in `@ziee/framework/api-client/core` hard-codes `localStorage['auth-storage']`
+ shape `{ state: { token } }`. There is **no setter**. The only way to authenticate is to make
a zustand-`persist` store named EXACTLY `auth-storage` exposing a `token` field. Any deviation
→ every request silently goes out unauthenticated, invisibly from the ApiClient surface.
**Ask:** an explicit `setAuthToken(token)` / injectable token provider. (FE-2b: the `Stores.X`
proxy also requires a `RegisteredStores` declaration-merge per store; we used the raw zustand
store to avoid it.)

### FE-3 — Kit token layer + Tailwind wiring undocumented · MISSING(docs) · MED · worked-around
The kit ships `@ziee/kit/styles/tokens.css` (good) but there's no Tailwind preset / config and
no documented `@source` line. Tailwind v4 only auto-scans the app tree, so the kit's component
classes (in `node_modules/@ziee/kit`) need an explicit `@source ".../@ziee/kit/src/**/*.tsx"`
or components render unstyled. app#1 sidesteps this by inlining its OWN token copy instead of
consuming the kit's. **Ask:** a documented CSS entry (`@import "@ziee/kit/styles/tokens.css"` +
the `@source` glob) or a Tailwind v4 preset the kit exports.

### FE-4 — Packages are workspace-source only (private, 0.0.0, main=src/index.ts) · MISSING · MED · open
`@ziee/framework` + `@ziee/kit` are `private`, `version 0.0.0`, and export raw `.ts` (no build
/ dist). They're consumable only inside a monorepo workspace (tsconfig `paths` + npm-workspace
symlinks). A standalone app that isn't in the SDK's workspace can't `npm install @ziee/kit`.
**Ask:** publishable builds (dist + real versions) or a documented "vendor the SDK as a
workspace" story (which is what CytoAnalyst does — the submodule packages ARE the workspace).

### FE-5 — App must hand-write the typed `ApiClientType` · MISSING · LOW-MED · worked-around
`createApiClient<TClient>(ApiEndpoints)` is type-erased; the app supplies `TClient`. The
generated `ApiEndpointParameters`/`Responses` exist, but turning them into a callable
`NS.method(params)` client hits `void`-parameter friction. app#1 has a bespoke mapped type; a
fresh app copies it or (like CytoAnalyst) hand-writes an interface for the endpoints it uses.
**Ask:** emit the `ApiClientType` mapped type into the generated `types.ts`.

### FE-6 — `vite.config.ts` reference is ziee-entangled · MISSING(template) · LOW · worked-around
app#1's config carries `root:'src'`, a custom `outDir`, Tauri env, and 5 ziee-only plugins. A
fresh app needs only `react()` + `tailwindcss()` + the `/api` proxy — but must reverse-engineer
that from the entangled reference. Pairs with FE (minimal-app example) from the backend list.

### FE-10 — the OpenAPI→ApiClient pipeline is JSON-only; no binary/streaming responses · MISSING · MED-HIGH · design-only
Surfaced designing CytoAnalyst's data viz (see `docs/DATA_STORAGE_REDESIGN.md` §3.4.1). The SDK's
`ApiClient` (`createApiClient`/`callAsync`) always does `JSON.parse`, and `emit_ts` only emits JSON
response types. A data app that must stream **binary** (`application/octet-stream` — raw
little-endian typed arrays for embeddings, sparse gene columns, 500k-cell scatters, read back with
`new Float32Array(arrayBuffer)`) can't use the generated client: `JSON.parse` on binary bytes fails,
and `types.ts` has no type for a binary body. (No Arrow/columnar framing needed — the endpoint kind
already fixes the shape, so the wire is just the bytes; see §2·Q2.)
**Asks (two parts):**
1. `emit_ts` should read each response's **media type** and emit a `responseType`
   (`json | arraybuffer | stream`) + map a `format:binary`/octet response to `ArrayBuffer` /
   `ReadableStream`, not `unknown`. (Also: confirm aide emits a correct binary response — media type +
   `format:binary` — for `Bytes`/a custom `OperationOutput`, so the spec + golden parity stay valid.)
2. `callAsync` should **branch on response kind** (`.json()` vs `.arrayBuffer()`/`response.body` for
   progressive chunks) instead of always `JSON.parse`, reusing the same token/base-URL/401 path.
Then one generated `ApiClient` handles binary endpoints natively. **Worked around** for now by a thin
purpose-built streaming client (fetch + reuse `getAuthToken`/`getBaseUrl` → `response.arrayBuffer()`)
alongside the JSON `ApiClient` — the OpenAPI still lists the endpoints (docs), but the JSON client
doesn't own their bodies. Note the workaround is now dependency-free (just `.arrayBuffer()`, no
`apache-arrow` decoder). CytoAnalyst is the first SDK app with a heavy binary data plane, so this is a
real extraction signal, not a nicety.

## Desktop (Step 7) — `ziee-desktop-harness`

The Tauri desktop app **builds AND boots end-to-end** (validated under xvfb): embedded PG →
merged migrations → **"Loaded 2 modules"** (linkme registers across the lib→desktop crate
boundary ✓) → `ServerBoot` binds an ephemeral port → **owner 'admin' provisioned** → **main
window created** → the embedded server serves (`/api/datasets` 200, `/api/auth/me` 401). The
harness (`ServerBoot` seam + `spawn_boot_then_window` + `SingleUserStrategy`) is genuinely
consumable by a second app — a full desktop shell was ~5 small files. Gaps:

### D-1 — ziee-auth can't create an admin; single-user owner needs raw SQL · LEAK/MISSING · MED · worked-around
The harness `SingleUserStrategy` routes owner *creation* back to the app (by design — admin CRUD
stays app-side), and `owner_missing()` is `!has_admin()` (checks `is_admin = true`). But
ziee-auth's `UserRepository::create(...)` takes no `is_admin` and there is no `set_admin`, so
the ONLY way to provision the required admin owner is a raw `UPDATE users SET is_admin = true`.
The app is forced to hand-write SQL against ziee-auth's own schema — a leaky boundary.
**Ask:** either a `UserRepository::create_admin(...)` / an `is_admin` param, or move the whole
single-user owner *creation* into the harness (it already owns the mint + lookup half).

### D-2 — No SDK helper to build the desktop `ServerConfig` · MISSING · LOW-MED · worked-around
The desktop must hand-construct the entire nested `ServerConfig` in code (embedded-PG block +
`installation_dir`/`data_dir` under the OS home, pool config, ephemeral HTTP port, and a
generate-and-persist JWT secret). ~80 lines of boilerplate every desktop app copies. **Ask:** a
`ziee_desktop_harness::desktop_server_config(app_data_dir)` builder (pairs with backend G2/G3).

### D-3 — Frontend↔desktop base-URL wiring is app-owned + undocumented · MISSING · MED · worked-around
The webview is loaded from the Tauri asset protocol (`tauri://localhost`), so `window.location.
origin` is NOT the API origin. The SPA must detect `window.__TAURI__`, call the app's
`get_server_port` IPC command, and build `http://127.0.0.1:<port>` — otherwise every API call
404s against the asset protocol. The SDK ApiClient's `getBaseUrl`/`setBaseUrlResolver` supports
this, but the detect-Tauri-and-invoke logic + the `get_server_port` command are entirely
app-owned with no SDK helper or documentation. (CytoAnalyst implemented both.)

## Frontend shell port (setup/auth/sidebar/settings/theme)

Ported ziee's whole UI shell into CytoAnalyst — it **works end-to-end** (login → slot-driven
sidebar → settings Profile/General/Users/User-Groups/Sessions, real backend data, theme).
The slot-driven module system is genuinely reusable (delete-a-module-dir cleanly removes its
routes + sidebar/settings entries). Gaps:

### FE-7 — The entire UI shell is app-owned copy-paste; no SDK starter · MISSING · HIGH · worked-around
`@ziee/framework` ships the *mechanism* (module registry, slots, stores, sync client,
api-client transport) but **no reusable shell**. The App bootstrap, `ThemeProvider`, router
module, `layouts/app-layout` (the sidebar + all 7 slot definitions), `layouts/blank`, the
settings shell, `core/permissions`, and `AppErrorBoundary` are ALL app-owned — a second app
copies ~40 files verbatim from ziee and strips domain. This is the single biggest frontend
onboarding cost. **Ask:** ship a `@ziee/shell` package (or an `examples/minimal-ui`) with the
themed shell + slot-based sidebar + settings scaffold + router, so an app fills slots instead
of copying the scaffolding. (Frontend twin of backend gap G6/minimal-app.)

### FE-8 — Over-copy hazard: no shell-only boundary in components/core · MISSING · MED · worked-around
ziee's `components/` + `core/` mix shell infra (ErrorBoundary, ThemeProvider, permissions)
with domain-heavy shared widgets (Plate rich-text editor, streamdown markdown, codemirror)
that pull ~15 heavy deps (platejs, streamdown, shiki, mermaid, pdfjs). Copying "the shell"
drags them in; the fresh app must hunt down + delete the editor/markdown files. No clean
"shell vs domain-widgets" split. **Ask:** separate the domain widgets from the shell infra.

### FE-9 — Realtime sync subscribe handler is app-side (~700 lines) · MISSING · MED · open
`@ziee/framework::sync` ships the registry/audience/extractor primitives, but the mountable
`GET /api/sync/subscribe` SSE handler + the concrete `SyncEntity`/`SyncAction` wire enums are
app-side (~700 lines in ziee). A fresh app that wants cross-device sync ports/rebuilds the
whole module. CytoAnalyst left it unmounted → the SDK sync client retries `/api/sync/subscribe`
(benign 404). **Ask:** an SDK-mountable `sync_routes()` + a generic entity seam. (Follow-up:
port a minimal CytoAnalyst sync module — Dataset/User/Group/Profile/Session entities.)

### Observation — SDK boot works end-to-end (positive signal)
Everything else in the Step 1–4 spine worked on the first clean build: module discovery via
`#[distributed_slice(MODULE_ENTRIES)]`, `build_api_router`, embedded-Postgres bring-up +
merged-migration run (3 auth + 1 dataset migration applied), and OpenAPI→types.ts codegen
(emitted `Dataset`/`CreateDatasetRequest`/`UploadStubResponse` + the typed `ApiEndpoints`
map). The SDK's platform layer is genuinely consumable by a second app — the gaps above are
ergonomic (missing helpers / undocumented contracts), not structural.

---

## Re-audit log — SDK pin bump `79378b5 → 4f9cb2f` (2026-07-14)

On the bump, re-audited CytoAnalyst against the new SDK surface and migrated OFF
copied-from-ziee code onto SDK packages. **FE `npm run build` green + backend
`cargo check` green** at the new pin.

### ADOPTED — `@ziee/shell` (addresses FE-8: shell vs domain-widgets split)
The SDK now ships `@ziee/shell` — the reusable, slot-driven shell infra with
**zero domain widgets** (no Plate/streamdown/codemirror): `ThemeProvider` +
accent presets + `useTheme` + `themeColor`, `AppErrorBoundary`, `Loading`,
`LazyComponentRenderer`/`WidgetRenderer`, `DivScrollY`, `BlankLayout` (component),
`usePrefetchModules`, and the `AppShell` bootstrap body. CytoAnalyst **deleted
~13 hand-copied files** and imports them instead; `App.tsx` collapsed to
`<AppShell authStore={useAuthStore}/>`. Every prior diff vs the copies was just
the SDK reading app stores through generic typed-proxy seams
(`ConfigClient{themePreference,accentPreset,setThemePreference}` /
`Auth{user,permissions}` / `AppLayout{nativeScroll?}`), which CytoAnalyst's
stores already satisfy — so the swap was mechanical. **This is the FE-8 fix
landing: the shell is now cleanly separable from domain widgets.**

### ADOPTED — `@ziee/framework/permissions`
`Can`/`usePermission`/`evaluatePermission`/`hasPermission`/`hasPermissionNow`
moved into the framework as an opt-in subpath export (reads the app's `Auth`
store via `authStoreProxy`). CytoAnalyst **deleted the 5 copied impl files**;
`@/core/permissions` is now a thin app barrel re-exporting the SDK runtime while
retaining the app's `Permissions`-enum-narrowed `PermissionExpr` TYPE (app glue,
not copied logic — the 22 import sites are untouched).

### ADOPTED — `@ziee/framework/router`
The SDK router is now **app-agnostic**: `createRouterModule({ loginPath,
homePath, fallback, permissionGate })` injects the app's knobs; the generic
`RouterComponent` owns layout/guard grouping + route collection. CytoAnalyst's
entire `modules/router/*` (RouterComponent + stores + types, ~5 files) collapsed
to **one `createRouterModule()` call** + a small injected `permissionGate` that
renders the app's kit `Result` 403 panel. NOTE: the SDK's `LayoutDefinition`
dropped the generic param + `mergeOptions` (layouts are now `{ component }`);
migrated the app's 3 layout defs accordingly.

### ADOPTED — N-2 `compose_merged_migrations_from(app_roots, sdk_crate_dirs)`
Replaced CytoAnalyst's hand-rolled `build.rs` ziee-auth copy loop (~25 lines)
with the new scoped SDK call. Merges the app's module migrations + ONLY the SDK
crates it links (`ziee-auth`), never blind-globbing `sdk/crates`. Merged set
verified: 3 auth + 1 dataset migration.

### FIXED upstream — N-1 (notification FK leak)
`ziee-notification`'s migration no longer FK-references `conversations` — infra
crates now apply on a bare DB. CytoAnalyst is unaffected either way (it never
links `ziee-notification`), but the leak that forced the original build.rs
workaround is gone.

### AVAILABLE, deferred — N-3 turnkey `AuthModule` (ziee-auth `module` feature)
The SDK now ships a turnkey `AuthModule` (`#[distributed_slice(MODULE_ENTRIES)]`,
`DefaultIdentityResolver`, registers `/api/auth/*` via `build_api_router` +
installs resolver/JWT/AuthContext at whole-app router level, order `i32::MAX`).
It is a **clean drop-in for CytoAnalyst's hand-written `modules/auth/mod.rs` +
`install_auth_layers`** (~100 lines). Deferred to a separately-verified
follow-up because auth is critical (wants a register/login/403 boot smoke, not
just `cargo check`). Enable ziee-auth's `module` feature → delete the app's auth
module + the `install_auth_layers` call in `lib.rs`.

### NEW observation — `@ziee/shell` pins `typescript ~6.0.3` (LOW · DX)
Adding `@ziee/shell` bumped the workspace TypeScript to 6.0.3, which **deprecates
`baseUrl`** (TS5101, error-level). A consuming app must add
`"ignoreDeprecations": "6.0"` (done) or migrate its `paths` to baseUrl-free form.
Also: `@ziee/shell` has no default entry in an app's tsconfig `paths` (resolves
via the node_modules workspace symlink) — added an explicit mapping for parity
with kit/framework. **Ask:** ship a shared `@ziee/config` tsconfig base (the
`sdk-devconfig`/`@ziee/config` commit exists on this pin — evaluate adopting it
so TS-version + compilerOption drift is owned by the SDK, not each app).

### ADOPTED — N-3 turnkey `AuthModule` (follow-up to the entry above; 2026-07-14)
Done + boot-smoke-verified. Enabled ziee-auth `features = ["module"]`, DELETED the
app's hand-written `modules/auth/mod.rs` (AuthModule + `install_auth_layers`, ~90
lines), and dropped the `install_auth_layers` call from `lib.rs::build_app`. The
turnkey module now self-registers via `MODULE_ENTRIES` (order `i32::MAX`), mounts
`/api/auth/*`, and layers the resolver/JWT/AuthContext over every module's routes.
`lib.rs` still builds a `JwtService` for `BootParts` (desktop mints tokens with it;
same secret ⇒ interoperable). `modules/permissions.rs` (RequirePermissions →
`DefaultIdentityResolver` alias) is unchanged — the turnkey uses the same resolver,
so the `Extension<Arc<DefaultIdentityResolver>>` type matches.
**Boot smoke (fresh embedded PG):** `/auth/me` no-token → 401; **`/users` no-token
→ 401 (the resolver reaches the non-auth USER module — the core N-3 property, not a
500/404)**; setup/admin → 201 + JWT; `/auth/me` w/ token → 200; `/users` w/ admin
token → 200. Startup log: "Loaded 4 modules" (app/dataset/user + turnkey auth).
Net: CytoAnalyst now carries ZERO hand-written auth wiring — auth is 100% SDK.

---

## Lifecycle-readiness audit — what CytoAnalyst needs for `/feature-lifecycle` (2026-07-14)

Audited the ziee feature-lifecycle skill (`.claude/skills/feature-lifecycle/SKILL.md` +
`.claude/lifecycle/{lifecycle-check,merge-gate}.mjs` + `preflight.sh`) against CytoAnalyst.
CytoAnalyst currently has **none** of the lifecycle infra (no `.claude/`, no justfile, no
`npm run check`, no `tests/`, no gallery, no e2e). Categorized the gaps by what's actually
blocked:

### ✅ Category A — extracted on our pin (4f9cb2f); CytoAnalyst just needs to WIRE it
- **Backend integration harness — `ziee-test-harness` IS extracted + app-neutral.** The crate
  names only a `HarnessApp` seam (never `ziee`): impl `type Options` + `template_db_base` +
  `migration_dirs` + `plan_spawn` once and you get per-worktree template DBs + spawned-server
  isolation. → unblocks `tier: integration` tests. **Not blocked.**
- **Gallery — `@ziee/gallery` IS extracted + app-neutral** (peer-deps only). → unblocks the
  A7 boot/runtime canary + gate:ui/runtime-health surface. **Not blocked** (needs a gallery
  entry + per-module `gallery.tsx` + fixtures built).
- **`@ziee/config`** (dev-config + design-token gate tooling) is on the pin → can back a
  `npm run check` + a shared tsconfig base.

### 🔧 Category B — CytoAnalyst-local, wire-able now (real work, no external dep)
- Add `.claude/skills/feature-lifecycle/` + `.claude/lifecycle/*` (absent entirely today).
- Add a `justfile` (`openapi-regen`, `check`, `test`) — CytoAnalyst already runs the raw
  commands; the gates shell out to `just`.
- Add `npm run check` (ui) — tsc + lint. **Caveat:** blocked by the ~35 PRE-EXISTING FE tsc
  errors (`.desktop`/gallery/sync debt); the frontend gate line `npm run check (ui): PASS`
  can't be produced until those are cleared. The app is vite-build-gated today, not tsc-clean.

### 🔴 Category C — the REAL blockers (feed to the workstreams)
- **C-1 · Lifecycle scripts are ziee-hardcoded; no `app.config` seam.** `merge-gate.mjs`
  hard-codes `cargo clean -p ziee` + `cargo check -p ziee --tests` (C1), the
  `src-app/desktop/ui/*` generated paths + `just openapi-regen` (C3); `preflight.sh`
  hard-codes the `hub-seed` presence check (a ziee-only module CytoAnalyst lacks) and iterates
  `for ws in src-app/ui src-app/desktop/ui` (CytoAnalyst has no `desktop/ui`). For a non-ziee
  app these gates FAIL or mis-fire. ziee's `.claude/lifecycle` is a real dir with NO
  `.claude/app.config` — the parameterization seam described for agent-kit does not exist in the
  mainline scripts yet. **Ask (agent-kit workstream):** give the lifecycle scripts the SAME
  app-neutral extraction `ziee-test-harness` got — an `app.config` (cargo package name, FE
  workspace list, hub-seed present y/n, openapi-regen recipe, desktop y/n) the three scripts
  read, instead of literal `ziee`/`desktop/ui`/`hub-seed`. CytoAnalyst is the proof a second app
  needs this. NOT a test-infra gap — an agent-kit gap.
- **C-2 · E2E / Playwright harness is NOT extracted.** The SDK has no playwright/e2e package or
  crate (packages = config/framework/gallery/kit/shell only); ziee's ~83k-LOC e2e suite +
  `playwright.config.ts` + global-setup + docker orchestration + `app-setup-submit`-style
  selectors are all app-side. The lifecycle **mandates ≥1 `tier: e2e` test for any UI-touching
  diff** + an A10 `[negative-perm]` e2e. So **any UI feature is blocked** under the lifecycle
  until the e2e harness is extracted. **This is the test-infra blocker** — specifically the E2E
  layer (the backend integration harness + gallery are already done). **Ask (live1):** extract a
  `@ziee/e2e` (Playwright config base + global-setup + docker/db bring-up + the setup/login
  fixtures) with an app seam, mirroring the `HarnessApp` pattern.

### Bottom line
More is unblocked than assumed: the **backend integration harness + gallery are extracted**.
The two hard blockers are **(C-1)** the lifecycle scripts aren't app-parameterized (agent-kit)
and **(C-2)** the E2E/Playwright harness isn't extracted (live1 test-infra). **Backend-only**
features could run the lifecycle as soon as B is wired + C-1 is fixed; **any UI** feature waits
on C-2. Recommend pre-wiring Category A/B for backend work while C-1/C-2 land.

---

## SDK survey — new since our pin `4f9cb2f → 82201f6` (2026-07-14, same day)

Fetched; 8 new commits. **Both lifecycle test-infra items I flagged now have SDK answers:**

- **C-2 ADDRESSED upstream — `@ziee/test-e2e` (new package, commit `0174b83`).** The E2E
  harness I flagged as not-extracted is now a package: `createGlobalSetup`/`createGlobalTeardown`
  (per-run **Postgres-docker bring-up** + server/UI warmup + first-run-setup hook + cross-session
  teardown), `definePlaywrightPreset`/`defineDesktopPreset` (web + Tauri), a generic Postgres
  port allocator, and i18n-safe `byTestId`/role/label selectors — the FULL stack, not
  gallery-only. App-neutral over ONE `E2EConfig` seam (`dockerComposeTemplate`,
  `containerNamePrefix`, `uiBuild`, `serverWarmup`, `firstRun`, `testDir`…), mirroring the
  `HarnessApp` pattern. **To consume:** CytoAnalyst supplies a docker-compose template +
  `E2EConfig` + specs. → the lifecycle's mandatory `tier: e2e` + A10 negative-perm are now
  buildable. (Peer dep: `@playwright/test`.)
- **More shell reuse — `@ziee/shell` B-1 (commit `925940d`).** The shell now exports `AppLayout`
  + sidebar slots (`SidebarNavItem/ToolItem/ActionItem/WidgetItem`) + `SettingsPageContainer`.
  CytoAnalyst still hand-copies `modules/layouts/app-layout/*` + `SettingsPageContainer.tsx` —
  adoptable. NOTE the platform seam: the shell `AppLayout` takes `LeftSidebar` +
  `SidebarToggleButton` as PROPS (the app injects them at its own `@/`-import site so the
  desktop `.desktop.tsx` override still swaps) — so the app keeps only those two leaves + its
  slot fills.
- **`ziee-test-harness` `fixtures` feature (`d932e4b`)** — 4 generic auth/sync mocks; helps
  CytoAnalyst's future integration tests.
- **`ziee-file-http` `file_routes<R>()` (`7a80e94`)** — store-generic file HTTP handlers;
  relevant when CytoAnalyst builds dataset upload (currently a stub).
- **4 sandbox crates (`c008950`)** — `sandbox-{guest-agent,seccomp,vm-launcher,vm-protocol}`.
  Relevant to CytoAnalyst's vision (R/Python compute runs in the SDK sandbox); watch as the rest
  of `ziee-sandbox` lands.

### Updated lifecycle-readiness status
- Backend integration harness (`ziee-test-harness`): ✅ extracted.
- Gallery / runtime-health (A7): ✅ extracted (`@ziee/gallery`).
- **E2E harness (was C-2): ✅ NOW extracted (`@ziee/test-e2e`).** The test-infra blocker is
  effectively resolved at the SDK level — remaining work is CONSUMING it (E2EConfig +
  compose template + specs), not waiting.
- **C-1 (lifecycle scripts `-p ziee`/`hub-seed`/`desktop/ui` hard-coding → need an `app.config`
  seam): STILL OPEN.** Not in this SDK repo — it lives in `ziee-ai/agent-kit` (the lifecycle
  scripts' home). This is now the single remaining hard blocker to running `/feature-lifecycle`
  in CytoAnalyst; feed it to the agent-kit workstream.

---

## Lifecycle wiring progress + remaining gaps to START features (2026-07-14)

Acted on the readiness audit. Bumped pin → `82201f6` and wired the backend path:

### ✅ Done + verified this pass
- **Backend integration harness — WIRED + GREEN.** Consumed `ziee-test-harness`: a
  `HarnessApp` impl (`tests/common`) + a thin `TestServer` + a first `tests/auth` test
  (setup→JWT→`/auth/me`→gated `/users`), running through a REAL spawned server + REAL Postgres
  (`:54321`, per-test DB clone, ephemeral port, clean teardown). `just test` → `1 passed`.
  **Dogfood result: the `HarnessApp` seam consumed cleanly by a 2nd app — no friction.**
- **`justfile`** with the recipe NAMES the lifecycle gates call (`test`/`check`/`openapi-regen`).

### 🚦 Remaining gaps to start NEW features — split by type
**Backend features: effectively UNBLOCKED now.** Module + integration tests + `just test` all
work today. The only missing piece is the FORMAL lifecycle gate (C-1 below); backend work can
proceed under an informal plan→test→implement loop immediately.

**Frontend features: blocked on 3 things**
- **F-A · `npm run check` (tsc) is not green.** The ported FE carries pre-existing type debt:
  7 DEAD `.desktop` files importing the non-existent `@ziee/desktop`/`@ziee/ui-core` (CytoAnalyst
  has no localOverridePlugin, so they're never swapped in — pure dead code), a missing
  `@/dev/gallery/support`, unwired sync types (`SyncAction`/`SyncEntity`, FE-9), and enum
  mismatches (`ProfileRead`). The lifecycle FE gate requires tsc-clean. → a cleanup pass (mostly
  deletions + a minimal sync-types stub).
- **F-B · E2E harness not wired.** `@ziee/test-e2e` is extracted (good), but CytoAnalyst must
  supply `E2EConfig` + a docker-compose template + a `playwright.config.ts` (via
  `definePlaywrightPreset`) + specs, and RUNNING needs docker + Playwright browsers. The
  lifecycle MANDATES ≥1 `tier: e2e` + an A10 negative-perm e2e for any UI diff.
- **F-C · Gallery (A7 boot canary) not built.** `@ziee/gallery` is extracted; CytoAnalyst needs
  a gallery entry + per-module `gallery.tsx` + fixtures for the runtime-health pass.

**Both — the formal gate (external):**
- **C-1 (unchanged) · lifecycle scripts hard-coded to ziee.** `merge-gate.mjs` (`-p ziee`,
  `desktop/ui`) + `preflight.sh` (`hub-seed`, `desktop/ui`) need an `app.config` seam. Lives in
  `ziee-ai/agent-kit`. Until it lands, the formal phase gates + pre-push hook can't run in
  CytoAnalyst (the phase VALIDATOR `lifecycle-check.mjs` is mostly app-neutral and could be
  copied for backend-only work). **Single remaining hard blocker to the FORMAL lifecycle.**

### Recommendation
Start **backend** features now (informal lifecycle + `just test`) — the data-storage module is
backend-heavy and the dogfooding sweet spot. Do a **FE-readiness pass** (clear F-A, wire F-B/F-C)
before the first UI feature. Raise **C-1** with the agent-kit workstream.

---

## FE-readiness pass — B-1 + F-A + F-B DONE & verified (2026-07-14)

Bumped pin → `82201f6`. Then:

### ✅ Shell B-1 adopted (`@ziee/shell` AppLayout/slots/SettingsPageContainer)
AppLayout.tsx is now a thin binding wrapper over the shell's generic AppLayout
(injecting cyto's LeftSidebar + SidebarToggleButton); slot types + Slots merge
come from @ziee/shell; SettingsPageContainer repointed. **Net −2,256 lines.**

### ✅ F-A — `npm run check` (tsc) GREEN (was ~35 errors)
Deleted 7 dead `.desktop` files (no localOverridePlugin in cyto → never swapped;
imported the non-existent @ziee/desktop) + 7 copied ziee module `gallery.tsx`;
fixed `ProfileRead`→`ProfileEdit` (backend only has profile::edit); recreated
core/sync/types.ts with EXPLICIT `sync:<entity>` keys (backend emits no
SyncEntity yet). Added `npm run check` script, folded into `just check`.

### ✅ F-B — E2E wired via `@ziee/test-e2e`, first spec GREEN
CytoAnalyst's web model = two servers (embedded-PG backend + `vite preview`
proxy). A native `playwright.config.ts` (two webServers) + `tests/e2e/smoke.spec.ts`
drive setup/login → `/settings/general` → the shell B-1 AppLayout, with rigorous
runtime-health (zero JS errors; failed-request allow-list). `1 passed`.

**DOGFOOD gap — @ziee/test-e2e presets don't fit the embedded-PG two-server web
model.** `definePlaywrightPreset` assumes a per-run Postgres DOCKER container;
`defineDesktopPreset` assumes ONE webServer. CytoAnalyst (embedded PG + a
proxying preview) is neither, so it needs a bespoke native config. **Ask:** a
third preset (or a `webServer[]` + no-docker option) for the "embedded-DB backend
+ proxying preview" web app — CytoAnalyst is the proof it's a real shape.

### 🔴 Remaining before feature dev
- **F-C · Gallery / A7 boot canary NOT built.** `@ziee/gallery` is extracted but
  is a full framework (needs an app gallery entry + per-surface stories + a
  mock-API cassette). Not blocking basic FE dev (the e2e smoke already gives
  runtime-health), but it's the broader backend-free render-every-surface canary.
- **C-1 (unchanged) · lifecycle scripts hard-coded to ziee** (agent-kit) — the
  only hard blocker to the FORMAL /feature-lifecycle gates.

### Non-SDK findings (CytoAnalyst's own gaps)
- **No home page** — `/` renders blank after login (the AppLayout is only reached
  via `/settings/*`). A real first-surface to build.
- App rendered in mobile-Sheet mode at 1280px headless — a `useWindowSize`
  initial-measurement quirk to check when building responsive surfaces.

### Dev-env readiness verdict
Backend features: **ready** (harness + `just test` green). Frontend features:
**ready** (tsc green + e2e green + B-1 adopted); F-C (gallery) is an enhancement,
C-1 gates only the FORMAL lifecycle.

---

## C-1 RESOLVED — agent-kit consumed as a submodule (2026-07-14)

The lifecycle-script hard-coding blocker is closed. `ziee-ai/agent-kit` (current
main `fd8b58a`) ships the de-ziee-ified scripts: `preflight.sh` / `merge-gate.mjs`
/ `lifecycle-check.mjs` now read a plain `.claude/app.config` (KEY=value, every
key optional → unset skips) instead of hard-coding `ziee`/`hub-seed`/`desktop/ui`.

CytoAnalyst now consumes it exactly like ziee: `agent-kit` git submodule +
`.claude/lifecycle`→`../agent-kit/lifecycle` + `.claude/skills/<skill>` symlinks +
a cyto `.claude/app.config` (cargo package `cytoanalyst`/`cytoanalyst-desktop`,
one FE workspace `src-app/ui`, `just openapi-regen`; hub-seed/pgvector keys
omitted). Pre-push hook installed.

**Verified:** `preflight.sh` exits 0 — SKIPS the ziee-only build-seed + submodule
checks, runs cyto's own; the pre-push `merge-gate --verify-head` ran on push and
passed. **The formal 8-phase /feature-lifecycle is now available in CytoAnalyst.**

### Dev-env readiness — FINAL
- Backend features: ✅ ready (integration harness + `just test` green).
- Frontend features: ✅ ready (tsc + e2e green; shell B-1 adopted).
- Formal lifecycle: ✅ **now runnable** (agent-kit consumed; preflight + merge-gate
  + pre-push all verified).
- Only remaining ENHANCEMENT: F-C gallery/A7 (@ziee/gallery is extracted +
  fully-tooled; needs an app gallery entry + stories + mock cassette — not
  blocking, the e2e smoke already covers runtime-health).

---

## F-C DONE — @ziee/gallery + A7 runtime-health wired & GREEN (2026-07-14)

CytoAnalyst is the **first app to consume `@ziee/gallery` via `mountGallery`** (ziee
still uses its pre-extraction inline `dev/gallery`), so this is a real dogfood.

Wired: `src/gallery.html` (standalone entry, prod-excluded) → `src/dev/gallery/main.tsx`
(`mountGallery(GalleryConfig)` with the app DI — @ziee/shell ThemeProvider/ErrorBoundary/
Loading/LazyComponentRenderer, `@ziee/framework/router` useRoutesStore, ApiEndpoints,
loadModules, accent presets, ConfigClient setters) + a mock-API `cassette.ts` +
`gallery.config.json` + npm scripts + `just gallery` / `gallery-runtime`.

**Verified:** A7 runtime-health = 9 pages × 3 states × 2 themes = **54 cells, 0 gating
HIGH** (no crashes/console-errors/contrast/failed-requests); tsc + prod build green;
gallery symbols absent from `dist`.

### Dogfood gaps found (for the @ziee/gallery workstream)
- **No `mountGallery` example anywhere in the SDK.** The `GalleryConfig` DI surface is
  large (~20 fields); a consuming app reconstructs the boot from `mount.tsx`/`config.ts`.
  **Ask:** ship an `examples/gallery-min` (a working `main.tsx` + `gallery.html` + a tiny
  cassette) — CytoAnalyst's is a candidate to upstream.
- **`GalleryPage` renders only `config.stories`**, not per-module `gallery.tsx` `stories`
  (assembled but not auto-rendered). Surprising; document or auto-fold.
- `gate:ui` assumes `lint:guardrails`/`lint:colors` + a `playwright.visual.config.ts`;
  an app without them must set `lintCmds:[]` + omit visual (CytoAnalyst did). The
  `gallery:runtime` A7 canary stands alone without any of that.

### FE-READINESS CHECKLIST — COMPLETE
F-A (tsc green) ✅ · F-B (e2e green) ✅ · F-C (gallery/A7 green) ✅. Plus backend
harness ✅, shell B-1 ✅, formal lifecycle (agent-kit/C-1) ✅. **Dev env fully ready.**

---

## sandbox + rootfs modules (feat/sandbox-rootfs, live5) — 2026-07-14

Dogfood gaps found while building the `sandbox` (bwrap-isolated analysis exec) +
`rootfs` (docker-built + embedded) modules on the SDK. APPEND-ONLY.

- **`ServerConfig` silently ignores app-specific top-level YAML keys.** Confirmed
  in `ziee-core/src/config.rs` (`ignores_extra_app_specific_keys` test): an app
  cannot add a `sandbox:`/`memory:`-style config section through the standard
  `ServerConfig::load*` path — extra keys are dropped by serde. Consequence: a
  module that wants an operator on/off toggle or tuning block has no first-class
  seam; it must either self-enable from runtime signals (what the sandbox does —
  embedded-asset-present + host-probe) or the app must plumb its own monolithic
  `Config` and inject it via the `ModuleContext.app_config` `Any` slot + downcast.
  **Ask (for live1):** a documented app-config extension seam — either a typed
  `#[serde(flatten)] extra: BTreeMap<String, serde_yaml::Value>` escape hatch on
  `ServerConfig`, or a first-class "module config sections" registry — so modules
  get operator-facing config without each app hand-rolling `app_config` downcasts.
  (Blessed by the orchestrator: the sandbox SELF-ENABLES, no config flag.)

- **No turnkey host-side sandbox module in the SDK.** The SDK ships sandbox
  PRIMITIVES (`sandbox-seccomp` policy + `build_bpf`, `sandbox-vm-protocol`,
  `sandbox-guest-agent`, `sandbox-vm-launcher`) but NO reusable host crate for the
  bwrap argv builder / probes / cgroup scope / squashfuse mount / resource-limits
  singleton. CytoAnalyst mirrored ziee's `code_sandbox` in-app (Linux-only slice).
  **Ask:** consider extracting a `ziee-sandbox` host crate (argv builder + probes +
  cgroup + a `SandboxBackend` seam) so app #3 doesn't re-port it. `sandbox-seccomp`
  IS consumed as-is (good — it's the one already-shared piece).

- **No build-DB provisioning helper (restates G4 in a new context).** The sandbox
  settings repository had to use runtime `query_as` (not the `query!` macro) for
  the singleton, same as `dataset`. Not new, but reconfirmed for a settings-table
  module.

- **Sync is an extensible seam but the app-side subscribe route + FE `initSync`
  aren't turnkey.** `ziee_framework::sync` provides `SyncEntityKind` + `publish` +
  `Audience`, but a fresh app still has `/api/sync/subscribe` UNMOUNTED (the e2e
  smoke flags it as FE-9) until it wires the mount + FE loop. The sandbox settings
  PUT therefore emits through a no-op seam this round (wired at merge with live8's
  sync landing). **Ask:** a one-call "mount sync" helper (route + a default FE
  `initSync`) so realtime isn't per-app boilerplate.
## Notification feature = SDK contribution (study-management, live8, 2026-07-14)

**User directive:** notifications should be a FIRST-CLASS SDK feature where each module
contributes its own notification `kind` + how to RENDER it (the user will refine the API
design directly in a live session; the shape below is a working proposal, kept easy to adjust).

### Shipped (PROPOSED) in the vendored `sdk/`
- **`ziee-notification` crate promoted to a self-registering, build-DB-free module** (feature
  `module`): the former ziee-chat-specific FK columns (`scheduled_task_id`/`workflow_run_id`/
  `conversation_id`) are replaced by ONE generic **`payload jsonb`** column — kind-specific
  data (e.g. `{study_id, share_id}`) rides `payload`, so the SDK schema knows no domain.
  Adds: runtime-`query_as` repository (no build DB, mirrors dataset), `NotificationModule`
  (MODULE_ENTRIES) mounting REST list/unread-count/kinds/read/read-all/delete gated
  `notifications::read`, `create_and_emit` producer seam, a **pluggable `set_sync_emitter`**
  seam (the crate never names the app's concrete `SyncEntity::Notification`), a
  `NOTIFICATION_KINDS` `#[distributed_slice]` per-module kind registry, and a prune loop.
- **`@ziee/framework/notification`**: the FE renderer-registry SEAM —
  `registerNotificationKind(kind, {render, actions})` + `getNotificationRenderer` +
  `AppNotification`/renderer types. The inbox dispatches on `kind`; unknown → generic fallback.

### CytoAnalyst dogfoods it
The `study` module contributes kinds `study_share_invite` / `study_transfer_invite` (backend
`NOTIFICATION_KINDS` + FE `registerNotificationKind` with Accept/Decline actions).

### Dogfood gap found → proposed SDK promotion
- The notification **store + bell + toast SHELL** are currently app-side
  (`src/modules/notification/`), NOT in the SDK, because the framework package has no
  kit-having UI home and a `@ziee/framework → @ziee/kit` dep would invert the layering.
  **Ask:** give the SDK a UI home (e.g. a `@ziee/notification-ui` package or `@ziee/shell`
  slot) so the bell+inbox+toast+store can move into the SDK — the user wants the SDK to ship
  the shell, not just the seam. CytoAnalyst's `Notifications.store.ts` + `NotificationBell.tsx`
  are candidates to upstream.
- **Generic-payload schema change** diverges from `sdk/main`'s notification migration —
  coordinate through the user (live1 owns SDK extraction); not a silent fork.

---

## G8 — Generic ENTITY-EXTENSION registry (study-extensions dogfood, 2026-07-15)

`feat/study-extensions` (live5) built a **study extension system** — a registry so
future sub-modules (samples, upload, clustering, embedding, viz…) plug into a study,
register cleanup, and render nav, with ZERO study-core changes. It is a near-verbatim
re-implementation of ziee's Chat-Projects **extension** pattern, applied to a different
parent entity. That duplication is the SDK signal.

### What was built app-side (candidate to promote to the SDK)
- **Backend**: `study/core/extension/registry.rs` — a `#[distributed_slice] STUDY_EXTENSIONS`
  of `{name, order, factory: fn(PgPool)->Arc<dyn StudyExtension>}` + a `trait StudyExtension`
  (required `name()`; default-`Ok(())` hooks `register_routes` / `on_study_deleted` /
  `on_study_duplicated` / `collect_summary` / `initialize`) + a `StudyExtensionRegistry`
  (folds routes, fans each hook over ONE shared `&mut Transaction`, aggregates summaries) +
  a `once_cell` global singleton + `auto_register` (collect slice → sort_by_key(order) →
  factory). A shared `lifecycle::delete_study_with_extensions` is the single delete
  chokepoint firing `on_study_deleted` in-tx.
- **Frontend**: `study/core/extensions/{types,registry,slots,index}` — a `STUDY_SLOTS`
  (`study_nav`/`detail_panels`/`card_tags`) per-feature registry (name-keyed Map, per-slot
  sorted getters, `<StudyExtensionSlot>` reactively `evaluatePermission`-filtered) +
  `study/extensions/index.ts` eager `import.meta.glob('../../*/study-extension/extension.tsx')`
  auto-discovery.

### The SDK gap
This is the THIRD instance of the SAME shape (ziee: `project`, `chat`; cyto: `study`).
The registry/trait/slice/singleton/auto-register skeleton is 100% domain-agnostic — only
the entity name + the hook set differ. **Ask:** the SDK should ship a GENERIC
`EntityExtensionRegistry<Hooks>` (backend `ziee-framework`) + a generic FE slot-registry
factory (`@ziee/framework`), so a new "X-extension" seam is a few lines of config, not a
copy of ~250 lines. The hook set (delete/duplicate/initialize/routes/summary) generalizes
to any owner-scoped aggregate root.

### One divergence worth upstreaming into the pattern itself
ziee's project pattern is **cascade-only** (no `on_project_deleted`; it leans on
`ON DELETE CASCADE`). The study version adds an in-transaction **`on_study_deleted`** hook
because a module must clean up FILES/ARTIFACTS in the file/results store, not just DB rows
a cascade drops. The generic SDK registry should offer an optional in-tx delete hook, not
assume cascade suffices — file-owning extensions need it.

### Coordination note (not an SDK gap, but recorded)
live8's `feat/study-admin` also touches `modules/study` (admin delete path). The delete
chokepoint is `study::lifecycle::delete_study_with_extensions` — live8's admin-delete MUST
call it so cleanup fires there too (see `.lifecycle/study-extensions/BASE.md`).

---

## GAP (2026-07-17): `@ziee/kit` barrel omitted IDE-frame primitives — P6 workbench-shell

**Surfaced by:** P6 `feat/workbench-shell` (the IDE-style workbench dock frame). The kit
already VENDORS these primitives — token-clean (`data-slot` + kit tokens), just not exported
from the public barrel (`packages/kit/src/index.ts`):
`ResizablePanelGroup`/`ResizablePanel`/`ResizableHandle` (`./shadcn/resizable`),
`Collapsible`/`CollapsibleTrigger`/`CollapsibleContent` (`./shadcn/collapsible`),
`Slider` (`./shadcn/slider`), `useIsMobile` (`./hooks/use-mobile`).

**Resolution (SHIPPED):** SDK `cyto` commit `35a6560` — 8-line additive re-export from the
barrel, per the existing menubar/context-menu re-export precedent. Pushed to origin sdk
`cyto` (`029f14a..35a6560`, clean FF); cyto main re-pinned to it. No API/behavior change,
purely widening the public surface to already-shipped components.

**Upstream ask:** these are generic IDE/workbench primitives (resizable docks, collapsible
rails, sliders, responsive hook) — they belong in the kit barrel for ALL consumers, so this
should promote from `cyto` → sdk `main` on the next merge-back so the chat app gets them too.

---

## GAP (2026-08-11): `ziee-auth` hard-codes `NoopAuthSyncSink` — no app can wire auth realtime sync

**Surfaced by:** `fix/sync-fanout-rest` (the sync publish/subscribe parity sweep). Three
CytoAnalyst frontend subscriptions (`sync:profile`, `sync:session_settings`, and — before
this branch wired it app-side — `sync:session`) had no publisher that could ever reach the
wire, so cross-device convergence for those surfaces silently did not exist.

**The blocker.** `ziee-auth` publishes correctly and in the right places:

| call site | entity | audience | origin |
|---|---|---|---|
| `src/auth/http/handlers.rs:719` (`logout`) | `Session`/Update | `owner(user_id)` | `origin.0` |
| `src/auth/http/handlers.rs:867` (`update_profile`) | `Profile`/Update | `owner(updated_user.id)` | `origin.0` |
| `src/auth/http/session_settings.rs:73` | `SessionSettings`/Update | `perm::<SessionSettingsRead>()` | `origin.0` |
| `src/auth/http/handlers.rs:2055/2140/2208/2266` | `AuthProvider`/{Create,Update,Delete,Update} | `perm::<AuthProvidersRead>()` | `origin.0` |

…and all seven are DROPPED, because `AuthModule::init` (`src/auth/module.rs:114-119`)
constructs its one `AuthContext` with `Arc::new(NoopAuthSyncSink)` and the module is
registered at link time through a fixed `MODULE_ENTRIES` constructor. `AuthContext::new` is
called in exactly two places in the whole tree (that line and a test), and the context is
layered as an `Extension` from inside `register_routes`, so an app-level `app.layer(...)`
cannot override it (the inner layer wins). There is no injection point of any kind.

**Asked for:** a process-global setter mirroring the one `ziee-notification` already ships
and CytoAnalyst already uses successfully —
`ziee_notification::set_sync_emitter(Arc::new(|user_id, action, id, origin| { … }))`,
installed from `src-app/server/src/lib.rs:101`. The equivalent
`ziee_auth::set_auth_sync_emitter(...)` (or an `AuthSyncSink` slot on `ModuleContext`) would
let an app map `AuthSyncEntity` → its own concrete `SyncEntity` exactly as it already does
for notifications. `NoopAuthSyncSink` stays the default, so nothing changes for an app that
does not opt in.

**Note for whoever takes it:** `AuthSyncEntity::AuthProvider` has NO counterpart in
CytoAnalyst's `SyncEntity` enum, so wiring the sink also needs either an `AuthProvider`
variant app-side or a documented drop for that one variant.

**Meanwhile, in CytoAnalyst:** `profile` and `session_settings` are named entries in
`src-app/ui/src/core/sync/syncChannelParity.test.ts`'s `ALLOW_LIST`, each pointing here.
The acting device is served for `profile` by a LOCAL echo
(`modules/profile/stores/Profile.store.ts`); only cross-device is missing. `session` was
wired app-side instead (`modules/user/handlers.rs` now calls `publish_session_to_users` on
group-membership and group-permission edits), which is where it belonged anyway — the app
owns user/group admin, not the SDK.

---

## RESOLVED (2026-08-11): `ziee-auth` accepts an app-supplied `AuthSyncSink` — and refuses to boot without a declaration

**Resolves** the `NoopAuthSyncSink` gap filed above the same day. SDK `cyto` commit
`32219df` (clean FF `2d7546d..32219df`); CytoAnalyst re-pinned to it in the paired
commit.

**Not the shape that was asked for, and deliberately.** The ask above was
`ziee_auth::set_auth_sync_emitter(...)` mirroring `ziee_notification::set_sync_emitter`,
with "`NoopAuthSyncSink` stays the default, so nothing changes for an app that does not
opt in". That default is the bug. The whole cost of this gap was that doing nothing
produced a no-op that reads as working code at every call site — the same disease the
notification emitter still carries (`events.rs::emit` is `if let Some(e) = EMITTER.get()`,
i.e. an unregistered app silently drops every inbox notification; not touched here, filed
below).

What shipped instead:

```rust
pub enum AuthSyncWiring {            // no Default, no fallback
    Live(Arc<dyn AuthSyncSink>),
    Inert { reason: &'static str },  // the old no-op, but somebody chose it and said why
}
ziee_auth::auth::install_auth_sync_sink(sink)      // → Live
ziee_auth::auth::declare_auth_sync_inert("<why>")  // → Inert
```

`AuthModule::init` calls `resolve_auth_sync(declared_auth_sync())` and returns
`AuthSyncNotDeclared` when nothing was declared. Its `Display` names BOTH calls and lists
the publishes being dropped, and `initialize_modules` formats it into the boot failure. So
a missing declaration is a startup error with instructions, never a dead channel.
A second declaration does not replace the first and is reported at `warn`.

**Also closed:** `cargo check --workspace` in the SDK resolves every member with default
features and no member enables `ziee-auth/module`, so `module.rs` — the whole turnkey
`AuthModule`, its tests, and now this seam — was compiled by NOTHING in that repo; the
first thing to see it was a consumer's build, i.e. after the push. And `npm test` at the
SDK root had never run (no `test` script; the step exited 1 and aborted `just check`).
The SDK justfile now runs `cargo test -p ziee-auth --features module` and
`npm test --workspaces --if-present` (config 4, framework 2 + 25, gallery 40, kit 102 + 14).

**In CytoAnalyst:** `modules/sync/auth_sink.rs` maps `AuthSyncEntity` → `SyncEntity` and
`lib.rs` + `openapi.rs` declare before `initialize_modules`. The `profile` and
`session_settings` ALLOW_LIST entries in `syncChannelParity.test.ts` are **deleted** — both
channels are held to the both-ends rule again.

`AuthSyncEntity::AuthProvider` (the note attached to the original entry) got the app-side
`SyncEntity::AuthProvider` variant it needed, so the mapping is total and a new SDK auth
entity fails to compile here rather than being dropped. It is allow-listed **publish-only**:
this app mounts the admin provider ENDPOINTS (they arrive with `auth_admin_routes`) but
ships no admin provider UI, and the one provider store it has reads the PUBLIC list for the
anonymous login page — which holds no SSE stream, so subscribing there would be a listener
that can never fire for the `perm::<AuthProvidersRead>()` audience. Net: two allowances
removed, one added, and the new one is app-side-fixable rather than blocked on the SDK.

**Still open, same species, NOT fixed here:** `ziee_notification::set_sync_emitter` drops
silently when unregistered (`crates/ziee-notification/src/events.rs:40`). CytoAnalyst does
register it, so nothing is broken today — but the next consumer that forgets gets exactly
the bug this entry is about. The `AuthSyncWiring` shape is the template if anyone takes it.

---

## GAP (2026-08-11): `@ziee/kit`'s `Table` has no narrow-container layout — and adopting one would silently disarm the guards that measured the problem

**Not fixed. Enumerated and declined, with the blocker below.** Recording it because the
next person to look at the ~21px scroll on the QC metrics grid will re-derive the same
analysis otherwise.

**The measurement.** The declarative QC metrics grid (`packages/qc/ui/qc.yaml:501`,
rendered by `TableRenderer` at `modules/workbench/extensions/widgets/renderers.tsx:1123`)
is **305px inside a 284px content box** at the workbench right region's default 300px pane
— columns `[60, 60, 138, 48]`. The 138 is the heading "Aggregation" (114px of min-content)
against 88px of actual controls. `TableHead` is `whitespace-nowrap`, so the column's
MINIMUM is its heading text. The kit's own `overflow-x-auto` turns that into a ~21px
scroll rather than a clip. The sibling `criteriaTable`
(`packages/cell-filter/ui/cell-filter.yaml:250`) measures 284px `[119, 117, 48]` — it
fits, and only because it already folded three mutually-exclusive columns into one.

**Why the cheap closes are all wrong**, priced before this branch and re-confirmed:
`truncate` cannot cap a column's MINIMUM (`overflow:hidden` clips at the used width and
leaves min-content alone), so only `max-width` works — and that IS ellipsis, i.e. a column
whose name the user cannot read. Mid-word breaking is worse and taller. Widening the pane
trades 21px of scroll for less room everywhere else. The kit DOES ship the `max-width`
close as `col.ellipsis` (`table.tsx::headerMayShrink`, pinned by
`table-header-shrink.test.tsx` against the literal string `'Aggregation'`), and the
declarative `TableRenderer` has no path to forward it from YAML — but that plumbing gap is
**not worth closing**, because it would only make the wrong fix reachable.

**What was proposed: a stacked per-row layout, opt-in.** Opt-in is mandatory, not a
preference — ziee's CSV/XLSX viewers (`file/viewers/tabular/DelimitedTable.tsx`,
`XlsxBody.tsx`) render unbounded dynamic columns in a comparably narrow drawer and a grid
is exactly the point there.

**The blocker: two of the QC surface's own guards go VACUOUSLY GREEN under a headerless
table, rather than red.** Measured, not reasoned — the predicates below were run verbatim
against a columnar DOM and a stacked one:

| guard | columnar | stacked (no `thead`) |
|---|---|---|
| `modality-symmetry.spec.ts:89-96` — no column heading may say "modality" (`[...querySelectorAll('thead th')].map(text).filter(h => h.includes('modality'))` → `toEqual([])`) | finds `["modality"]`, **FAILS** (correct) | finds `[]`, **PASSES** |
| `metrics-table-error-geometry.spec.ts:65,190` — the error band must be wider than the widest column (`widestColumn: columns.length ? Math.max(...columns) : -1`) | real comparison | `widestColumn` degrades to **-1**; `msg.w > -1` holds for any width, incl. 0 |
| `tableRowControls.test.tsx:245,328` — `headerColumnCount() === TABLE.columns.length` | 5 vs 5, passes | **0 vs 5, FAILS loudly** (recoverable) |
| `metrics-table-error-geometry.spec.ts:228` — the first `th`'s text must be non-empty | passes | `''`, **FAILS loudly** (recoverable) |

A mode whose adoption disarms the guards that measured the problem it claims to fix cannot
be adopted by the same change that introduces it. And an opt-in mode with no adopter is
dead code — the kit would ship a layout that has never been rendered at a real width
against real content.

`tableRowControls.test.tsx`'s fold assertion is the sharper half: its subject is "a
multi-part control folds into ONE grid box of its row, not three columns". In a stacked
layout there are no columns, so the alternative it rules out does not exist and the
invariant is not re-expressible — it becomes unassertable, not merely broken.

**What the stacked mode would support / disable / cannot express**, if someone takes this
on with the guards rewritten FIRST (in a separate change, with the negative controls
proved before the layout exists):

| capability | verdict in stacked mode |
|---|---|
| `${testid}-row-<key>` / `-detail` / `-empty` / `-toolbar` / `-search` / `-root` testids | **must be preserved** — 20+ e2e specs across both repos count off these |
| `renderRowDetail` | **supportable** — every stacked row is already full width |
| column chooser | **supportable** — it filters `view.visibleColumns`, which a stacked renderer also consumes |
| sort | **disabled in v1** — the affordance lives in the header row; a toolbar "sort by" control is new UI |
| virtualization | **disabled in v1** — same reason `renderRowDetail` already forces the plain path: the virtualizer measures one fixed-height `<tr>` per index |
| cell selection + TSV copy | **disabled in v1** — cell addressing is column-grid semantics |
| `thead th` counts | **unreachable by definition** — the column-header row is the thing being removed |
| positional `td` indices | **unreachable by definition** |
| `th` findable by text | **unreachable by definition** — the label moves into each row's cell |

**The cheapest honest close that needs no kit change** and is a product decision, not an
engineering one: shorten the heading. "Aggregation" → "Agg." takes the column's 114px
min-content to roughly 40px and the grid to ~231px, inside the 284px box with room to
spare. It breaks none of the four guards above (`modality-symmetry` matches on
"modality"; the geometry spec reads the FIRST heading, "Metric"; the fold test counts
columns, unchanged). It is a chosen, stable abbreviation rather than a machine truncation —
but it is still a word the reader has to expand, so it wants a human's sign-off, not an
agent's.

**Exit condition for this entry:** it is removed when either (a) the guards above are
re-expressed against a layout-independent invariant and a stacked mode lands with a real
adopter, or (b) the heading is shortened and the residual scroll goes to zero.
## GAP: `ziee-test-harness`'s `SyncProbe` is behind an all-or-nothing `fixtures` flag

**Date:** 2026-08-11 · **Round:** sync audience + dead-event-space ·
**Status: CLOSED 2026-08-12** — landed on `cyto` as `9c8b219` + `6f94b29` (pin
`f27fa7f` → `6f94b29`). The narrow `sync-probe` feature asked for below now exists,
alongside `auth-mocks`, with `fixtures = ["sync-probe", "auth-mocks"]` preserving the
old meaning exactly. Measured: `--features sync-probe` resolves **209** crates,
`--features fixtures` **359** — the 150-crate docker/HTTP-mock tail is now opt-out.
`src-app/server/tests/common/sync_probe.rs` is DELETED and
`crate::common::sync_probe` is a re-export of the SDK type.

Two corrections to what this entry originally claimed, both found while closing it:
- The mirror had OUTGROWN the drop-in. It had gained `expect_event_for` (an
  id-narrowed `expect_event`), which the SDK lacked; that went upstream rather than
  being lost.
- **"which the SDK version does not need because it is already tested upstream" was
  FALSE.** `ziee-test-harness` had no test for `parse_sse_frame` at all, so deleting
  the mirror on that belief would have dropped the coverage silently. Four decode
  tests went upstream with the method. Frame decoding is the probe's only pure logic
  and everything rests on it — a decoder that quietly returned `None` would make
  `expect_silence` pass unconditionally, i.e. a test tool that reports success no
  matter what the server did.

A mutation also showed the split itself could rot: dropping `sync-probe` from
`fixtures` left `cargo check --features fixtures` GREEN, because nothing inside the
crate references the fixtures. Two `compile_error!`s now hold the umbrella promise at
the definition site.

<details><summary>Original entry (as filed)</summary>

**Status when filed:** OPEN, worked around in-app

`ziee-test-harness` ships exactly the SSE probe an app needs to assert realtime behaviour
— `fixtures::sync_probe::SyncProbe`, with `open` / `connection_id()` / `expect_event` /
`expect_silence`. `connection_id()` is the part an app cannot reasonably reimplement
*casually*: without it a test can assert that a frame ARRIVED, but not that the acting
connection was correctly SKIPPED, which is the half that catches a fan-out stamping
`origin` on the wrong recipient.

**The blocker is packaging, not the code.** All fixtures sit behind ONE cargo flag:

```toml
fixtures = ["dep:serde_json", "dep:tokio-stream", "dep:testcontainers",
            "dep:wiremock", "dep:jsonwebtoken", "dep:base64", "dep:rsa",
            "reqwest/stream", "tokio/macros"]
```

`sync_probe` itself needs only `serde_json` + `tokio-stream` + `reqwest/stream`. The other
four are for the OAuth/LDAP/Apple mocks. Turning the flag on to obtain an SSE reader adds
`testcontainers` (a docker client) and `wiremock` (an HTTP mock server) to this
workspace's `Cargo.lock` — neither is otherwise present — for a dev-dependency that exists
to be cheap.

**Asked for:** a narrower `sync-probe` feature (`["dep:serde_json", "dep:tokio-stream",
"reqwest/stream"]`) that `fixtures` also implies, so `fixtures = ["sync-probe", …]` keeps
today's behaviour and an app can opt into the probe alone. Splitting the auth mocks
(`oauth`/`ldap`/`apple`) the same way would be a bonus, not a requirement.

**Meanwhile, in CytoAnalyst:** `src-app/server/tests/common/sync_probe.rs` mirrors the SDK
type's surface, built on `reqwest::Response::chunk()` so it needs no new features at all.
It is a deliberate drop-in: when the narrower flag lands, the file is deleted and the
`use crate::common::sync_probe::SyncProbe` imports become
`use ziee_test_harness::fixtures::sync_probe::SyncProbe`. It also has three unit tests of
its own frame decoding, which the SDK version does not need because it is already tested
upstream.

</details>

---

## G-STREAM — a raw-body escape hatch, and a share-on-failure fallback (SDK `2208047`)

**Severity:** MISSING (capability) + a real DEFECT. **Status:** `fixed` on branch `cyto`;
needs promoting to `main` so the `chat` app gets it too.

Found while making the visualization read its data progressively. The server has always
streamed artifact bytes (`Body::from_stream`; a 134 MB shard costs one 64 KiB buffer) — the
buffering was purely client-side, so "the wire is progressive and only the client waits" was
true for every app on this transport, not just this one.

### 1. MISSING — no raw-body escape hatch on `performCall`

`performCall` parses on content-type and `application/octet-stream` falls into the
`response.blob()` arm; the `Response` never escapes. So there was no way to obtain a body a
decoder could work on a PREFIX of — the capability is not expressible at the app splice,
because the app never sees the `Response`.

**Landed:** an optional `responseType: 'stream'` threaded through `performCall`, returning
`response.body` AFTER the `!response.ok` block and BEFORE the parse switch. Purely ADDITIVE —
every existing call keeps the parse switch and no consumer contract changes.

### 2. DEFECT — `isolate` SHARES a value it cannot clone

In-flight GET coalescing hands a joiner `existing.promise.then(isolate)`, and `isolate`
`structuredClone`s the value **and, on failure, returned the SHARED value**. A `ReadableStream`
is not structured-cloneable, so two callers received the SAME stream: the first `getReader()`
locks it and the second throws `TypeError: locked`.

Reachable today, not hypothetically — two overlapping reads of one array DO issue two identical
un-ranged GETs. And the shape is worse than the symptom: silently sharing a value that was
supposed to be isolated is the same silent-degradation class this work exists to remove, and it
would bite any non-cloneable value, not only streams.

**Landed:** `isolate` HARD-FAILS on a non-cloneable value instead of sharing it.

### 3. NOT needed — `noCoalesce` already existed

Worth recording because it saved a second mechanism: the transport already carries a
`noCoalesce` flag, consumed by the `joinable` predicate, with **zero callers anywhere** — an
unused escape hatch. The app passes the flag that was already there rather than adding a
parallel one. A stream term was added to the existing `joinable` predicate beside SSE.

### Secondary, benign, recorded so it is not rediscovered

`netRequestStart/End` accounting ends when the promise settles, which for a stream is at
HEADERS rather than body-complete — so a background-prefetch gate that reads it will
under-count in-flight work. Not fixed; not load-bearing for this app.

---

## G-AUTHEVT — no in-tx user-creation hook on `ziee-auth` create fns · RESOLVED · HIGH · landed

**Discovered by:** accounts-epic item **A5** (auto-create exactly one personal account on every
user-creation path). External blocker **#2** in `.lifecycle/accounts/GRAPH.md`.

> **RESOLVED (2026-08).** The clean seam described below LANDED on `ziee-auth` (SDK `main`): a
> process-wide `install_user_created_hook(Arc<dyn UserCreatedHook>)` fired INSIDE the creation
> transaction at all five user-INSERT paths (register, LDAP, OAuth, admin-create, first-run), with
> an Err rolling the whole creation back and a genuine Noop default. CytoAnalyst now installs
> `PersonalAccountHook` (`modules/account/hook.rs`) at boot, which provisions the personal account
> atomically via `AccountRepository::ensure_personal_account_in_tx`. The lazy-ensure backstop below
> is **retained** — it self-heals users created before the hook landed (and any bypass path) on
> their next authenticated request. The three synchronous app-side ensure sites remain as a
> harmless idempotent belt. The original gap analysis is kept below for the record.

### The gap

CytoAnalyst's tenancy invariant (AC-INV-1) is *"every user has exactly one `personal` account,
auto-created as a co-transaction with user creation."* The clean realization is a signup hook that
fires INSIDE the SDK's create transaction so the personal account + owner membership commit
atomically with the user row — the Supabase Basejump `AFTER INSERT ON auth.users` trigger, in SDK
terms. `ziee-auth` does not expose one:

- The create fns (`create_local_user_with_default_group`, `provision_external_user_atomic`,
  `create_external_user_with_link`) live in `sdk/crates/ziee-auth` and the app has **no** call-site
  to them for the turnkey paths — local `register`, LDAP first-login, OAuth first-login, and
  link-account are all served by the turnkey `AuthModule`'s own routes, so there is no app seam to
  chain an ensure onto.
- The one event that WOULD let the app hook creation — `UserEvent::Created` — is dropped today: the
  turnkey `AuthModule` installs a `NoopAuthEventSink` (`auth/context.rs`; `auth/module.rs`), and the
  event is only ever fired on the local-register path anyway.

So the app cannot make the personal account commit atomically with the user on the SDK-owned paths.

### The clean seam we're waiting on

An in-tx `install_user_created_hook(Arc<dyn UserCreatedHook>)` on `ziee-auth` — mirroring the
existing `install_auth_sync_sink` (`ziee-auth` `lib.rs`) — invoked INSIDE each create fn's
transaction with the new user's `(id, username)`. Once it lands, the register/LDAP/OAuth/link-account
personal-account creation becomes a true co-transaction and the app-side interim below can retire.

### The interim workaround A5 shipped (correct WITHOUT the fix)

- **Synchronous ensure** at the THREE app-owned creation sites the app DOES control:
  `user/handlers.rs::create_user`, `app/handlers.rs::setup_admin`, desktop `commands.rs::ensure_owner`
  — each calls A1's idempotent `AccountRepository::ensure_personal_account` right after the SDK create.
- **A global lazy-ensure backstop** middleware (`modules/account/backstop.rs`) over every
  authenticated request: on the first sighting of a user this process lifetime it ensures their
  personal account, covering the SDK-turnkey-owned paths (register/LDAP/OAuth/link-account) and
  self-healing any pre-existing user. Best-effort, never gates, never fails the request; one DB touch
  per user per process (a process-local ensured-set).

This is a **boundary input awaiting the SDK fix, NOT a descope** (A5 DEC-8): A5 is correct today (the
backstop covers every path); the SDK hook only lets the interim sync-ensure sites + backstop retire.
