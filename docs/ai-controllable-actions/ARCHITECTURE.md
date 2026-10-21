# AI-Controllable Actions — Architecture (design record)

> Design captured from the live design conversation (2026-07-16, live5 + human).
> This is the durable record so a compacted context / fresh session can reconstruct
> the full design. Status: **design agreed, implementation NOT started.** The
> `feat/ai-mcp` lifecycle (slice 1) is paused at Phase 4 pending re-plan around this.

## North star

**Every user action in the app is AI-controllable** — through the *same* definition
a human uses. An action is declared once and is drivable by a human (button / command
palette) *and* by an AI (via MCP), with:
- a **mandatory permission gate** (we never expose an action the user lacks permission for),
- a **completeness gate** in `npm run check` (new code/module/UI/extension cannot add an
  action that escapes the registry or omits a permission),
- a **read-before-write / stale-state guard** (co-drive safety), and
- a **Claude skill** so agents build this way by default.

The MCP server is just **one consumer** of the action registry — not the point. The point
is the registry + engine + gate.

CytoAnalyst is the **exposer**; **ziee chat** (separate app) is the AI host (owns the LLM,
chat loop, approval UX). Cyto never runs an LLM/chat/approval panel — it answers tool calls
and lets the AI drive its live UI.

## Two catalogs, one uniform MCP surface

```
  ziee LLM
     │  MCP: list_capabilities / describe_capability / invoke_capability  (POST /api/mcp)
     ▼
┌──────────────────────── CYTO BACKEND ────────────────────────┐
│  MCP handler                                                  │
│    merged catalog = OpenAPI catalog  ⊕  Frontend-action cat.  │
│    per-user permission filter (principal_holds) on BOTH       │
│    invoke router by entry.kind:                               │
│      kind=rest      → loopback + forwarded JWT → real route   │
│      kind=frontend  → AGENT CHANNEL ↓ (await result)          │
│  Agent channel:  PENDING: request_id → oneshot<Result>        │
│                  control-session registry: user → conn_id     │
│    down:  SSE  GET /api/mcp/agent/stream   (frame to conn_id) │
│    up:    POST /api/mcp/agent/result       (fulfills oneshot) │
└───────────────────────────────────────────────────────────────┘
     ▲ progress*/result{request_id,…,logs}    │ agent_invoke{request_id,action_id,params,expected_token}
     │                                          ▼
┌──────────────────────── CYTO FRONTEND (controlled session) ──┐
│  ENGINE (subscribes agent stream, runs action, streams back) │
│    action registry:   action_id → run(params, ctx)  (global) │
│    ctx: read/subscribe/waitFor ANY store · call methods ·    │
│         ctx.instance(Store,view_id) · progress/log · signal  │
│  store instance directory: view_id → store (mount/unmount)   │  ← world-model reads via ctx.instances
│  <ScatterPlot view_id="v2">  legend checkbox ── store method ─┼─┐ same method the AI action calls
└───────────────────────────────────────────────────────────────┘ ┘
```

**Backend actions come from OpenAPI; frontend actions come from a compile-time collector.**
Both feed one uniform capability surface; the AI never learns whether a capability runs in
the server or the browser (routed by `kind`).

## Actions are a STANDALONE first-class primitive — NOT a store concern (CORRECTION 2026-07-16)

Do **not** embed AI-action metadata in a store (no `ai:` block on `defineLocalStore` — that
pollutes the store, forces one-action-per-store, and wrongly assumes actions are atomic).
An action maps to an *intent* ("cluster cells and color the scatter by cluster") that is
**async, non-atomic, and spans multiple stores**, completing when state converges — not on a
single `set()`.

`defineAction` is standalone. Its `run(params, ctx)` is an async, possibly long-running
function. **`ctx`** gives it: reactive read of ANY store; **subscribe/await** on store changes
(`ctx.waitFor`); call store methods; resolve per-instance stores by id (`ctx.instance`);
stream **progress/logs** to the LLM (`ctx.progress`/`ctx.log`); and a cancel `ctx.signal`.
Stores stay PURE state; the store runtime only keeps a per-instance directory
(`view_id → store`) that `ctx.instance/instances` resolves. The action is the single home for
orchestration — a human button and the AI both invoke it via `runAction(id)` (no duplication);
a thin mutation action just delegates to the store's one method.

```ts
// NON-ATOMIC, MULTI-STORE action — coordinates Jobs + a per-instance ScatterPlot store, awaits a job
defineAction({
  id: 'analysis.clusterAndColorScatter', title: 'Cluster cells and color a scatter by cluster',
  permission: Permissions.StudiesUse, mutating: true,        // permission MANDATORY (sole authz for FE)
  params: z.object({ view_id: z.string(), resolution: z.number().default(1.0) }),
  run: async ({ view_id, resolution }, ctx) => {
    const jobId = await ctx.stores.Jobs.startClustering({ resolution })   // reuse store method
    ctx.progress(`clustering started (${jobId})`)                          // streamed to the LLM
    const job = await ctx.waitFor(ctx.stores.Jobs, s => s.byId(jobId),     // SUBSCRIBE + AWAIT (non-atomic)
                                  j => j.status !== 'running', { signal: ctx.signal })
    if (job.status === 'failed') return ctx.fail(job.error)
    ctx.instance(ScatterPlotStore, view_id).setColorBy('cluster', job.result.labels)  // different store
    return { nClusters: job.result.nClusters }
  },
})

// THIN mutation action — delegates to the store's single method (no logic duplication)
defineAction({
  id: 'scatter.setGroupVisibility', permission: Permissions.StudiesUse, mutating: true, stateful: true,
  params: z.object({ view_id: z.string(), groups: z.array(z.string()), visible: z.boolean() }),
  run: ({ view_id, groups, visible }, ctx) =>
    ctx.instance(ScatterPlotStore, view_id).setGroupVisibility(groups, visible),
})
```

**`ctx` surface:** `ctx.stores.X` (reactive read + call methods) · `ctx.instance(Store,id)` /
`ctx.instances(Store)` · `ctx.waitFor(store, selector, predicate, {signal})` (subscribe + await
convergence) · `ctx.progress()` / `ctx.log()` (stream) · `ctx.signal` (cancel) · `ctx.fail()`.

Stores stay pure — the checkbox calls `ScatterPlotStore.for(view_id).setGroupVisibility(...)`
directly; the action calls the SAME method via `ctx.instance`. One implementation, two callers.

## Layer 1 — authoring + compile-time collection (the "frontend compiler")

`defineAction` is the single declaration. Metadata (id/title/permission/params/mutating/
stateful/read) is **statically extractable** (for the manifest); the `run(params, ctx)` handler
is **runtime**. Actions are `kind: 'global'` (registered at module load); a per-instance TARGET
is reached at runtime via `ctx.instance(Store, view_id)` — there is NO per-instance action
registration.

A **collector** (`scripts/collect-actions.mjs`, ts-morph / TS compiler API) scans the source
for every `defineAction`, converts the Zod `params` → JSON Schema, and emits a **committed**
`frontend-actions.json`: `id → {title, kind, mutating, stateful, permission, params_schema}`.
This is the frontend's "OpenAPI."

**The gate** (`check:action-manifest`, part of `npm run check`) fails on: missing permission;
a permission not in the known `Permissions` set; invalid schema; stale manifest (golden-parity
vs source, mirrors the openapi.json/types.ts parity gate); or a UI element referencing an
unknown action id. This is exactly how "no action escapes the registry / no permission-less
action" is enforced — a lint + manifest-coverage discipline (full static proof of "every
onClick is an action" isn't decidable; authoring actions AS registered ids + a coverage check
is the shippable form). An explicit `internal: true` escape hatch allows a genuinely
ephemeral UI-only handler to skip AI exposure — a recorded exception, not a silent bypass.

## Layer 2 — manifest → backend catalog

The backend embeds `frontend-actions.json` (`include_str!`) and builds a
`FrontendActionCatalog` — the exact parallel of `ziee_control_mcp::catalog::init_from_openapi`,
just `init_from_manifest`. `list_capabilities` merges BOTH catalogs and filters BOTH by the
caller's permissions; `invoke_capability` routes by `kind`.

**Two populations, two sources** (DOMAIN_AUDIT S1). The committed manifest carries only the
**app-owned** shell actions (navigation / projects / datasets / panes / jobs / provenance):
those ship with the binary, so a compile-time artifact is the right shape for them. The
**view-scoped** actions a declarative processor declares in its own `ui/<view>.yaml` `actions:`
are NOT baked in — `server/src/modules/mcp/view_spec_actions.rs` reads them at RUNTIME from
`<data_root>/processors/`, the same folder the extension registry scans, gated to the packages
that actually loaded. The merged catalog is rebuilt whenever that registry is republished
(boot, the reload endpoint, or the live fs watcher), so **a processor package dropped in at
runtime contributes AI capabilities without a server rebuild**. Baking them in previously made
the AI capability set a compile-time snapshot over a runtime-discovered registry — and put one
domain's assay vocabulary ("Add %hemoglobin metric", "Add TSS enrichment metric") in the server
binary.

The collector still *collects* view_spec actions so its gates (global id uniqueness against
every `defineAction`, known-permission, instance-shape) keep running over them at build time;
it just no longer *emits* them. On the server side a view_spec action declaring no `permission`
is dropped fail-closed rather than advertised ungated.

## Layer 3 — the duplex channel (backend controls frontend)

A frontend action is an **RPC over a split transport** (SSE is one-way; cyto's `sync` is
deliberately payload-free and must NOT be polluted):

- **Down:** a *dedicated* SSE `GET /api/mcp/agent/stream` (gated `mcp::use`). The controlled
  frontend session subscribes; the backend pushes an `agent_invoke` frame to that specific
  connection via a `user → control-conn-id` registry (bound at pairing — "this window is the
  one ziee drives").
- **Up:** the engine POSTs progress + the final result (actions are NON-ATOMIC — `ctx.progress`
  streams intermediate frames): `POST /api/mcp/agent/progress` (0..n, relayed to the LLM as MCP
  progress) then `POST /api/mcp/agent/result` (once, resolves the call).
- **Correlation:** a pending-map whose entry carries a progress sink + a final oneshot:

```rust
let (tx, rx) = oneshot();  PENDING.insert(request_id, Entry{ progress_sink, done: tx });
agent_stream.send(control_conn, agent_invoke{request_id, action_id, params, expected_token});
// progress POSTs → PENDING[id].progress_sink (streamed to the LLM); result POST → done.send(out)
let out = timeout(WALL_CLOCK, rx).await;  PENDING.remove(&request_id);  out
```

Wall-clock cap is generous (orchestration actions run for a while); cancellation flows the other
way (an MCP cancel → `agent_cancel{request_id}` frame → `ctx.signal` aborts the frontend `run`).

## Layer 4 — instance addressing (how a live "v2" gets reached)

**The action is global; the INSTANCE is a runtime `view_id` param resolved via `ctx`.** There is
NO per-instance action registration and NO `useAction`. Instead:
- Per-instance STORES register in a store-runtime **instance directory** (`view_id → store`) on
  mount, removed on unmount (a store concern, not an action concern).
- An action reaches the target with `ctx.instance(ScatterPlotStore, view_id)` (one live store) or
  `ctx.instances(ScatterPlotStore)` (all live ones, for the world-model reads).
- The SAME store method serves the human UI (checkbox calls it directly) and the AI (the action
  calls it via `ctx.instance`). One implementation.

```tsx
function ScatterPlot({ view_id }) {
  const s = useScatterPlot(view_id)   // reactive read; the per-instance store auto-joins the
                                      // instance directory on mount, leaves on unmount
  // <Checkbox onChange={g => ScatterPlotStore.for(view_id).setGroupVisibility([g], v)} />
}
```

Read-actions (`views.list`, `view.describe`, `selection.get`) use `ctx.instances(...)` +
`ctx.stores.X` to serve the **AI's world model**, so it resolves "the scatter plot" and "three
groups" against reality before acting. Reads are first-class, not just writes.

## Layer 5 — permission, enforced where it can't be bypassed

- **Backend actions** self-authorize: forwarded JWT hits the real route's `RequirePermissions`.
- **Frontend actions have NO route backstop** → the backend is authoritative: BEFORE relaying
  `agent_invoke`, it checks the caller against the manifest's declared permission via
  `principal_holds`; lacks it → `NOT_PERMITTED`, **never relayed**. `tools/list` is pre-filtered.
  The engine re-checks as defense-in-depth but is NEVER the gate.
- **Trust boundary distinction:** permission = trust → backend-enforced (puppet never trusted).
  Staleness (Layer 6) = correctness → engine-enforced (that's where the ground-truth version is).

## Layer 6 — read-before-write / stale-state guard (co-drive safety) — the Claude-Code-mtime analog

Optimistic concurrency. **Every addressable entity** (view instance, selection, config section)
carries a `version` that bumps on **every** mutation — human click, AI action, OR data reload:

```ts
setGroupVisibility(g, v) { …mutate…; this.version++ }   // legend click AND AI go through here
```

- **Reads stamp it:** `view.describe('v2')` → `{ …, _state_token: 'v2@17' }`.
- **Writes must present it:** `scatter.setGroupVisibility('v2', {…, expected: 'v2@17'})`. The
  engine compares `expected` vs the live version BEFORE dispatching:
  - match → apply, bump to `v2@18`, return new token.
  - mismatch → **reject, don't apply:** `STALE_STATE: v2 changed (was v2@17, now v2@19); re-read view.describe('v2') and retry`.
  - missing-but-required → `READ_REQUIRED`.
- The AI's loop becomes Claude Code's Read-before-Edit: `describe → (fresh?) → write`; on
  STALE → re-read → re-plan. Tool descriptions encode the discipline so the LLM follows it.

**Why this IS the co-drive safety property:** the human unchecks group B mid-plan → bumps
`v2`'s version → the AI's next write is STALE → forced to re-read, sees B hidden, reconciles.
A stale AI can never silently clobber a concurrent human edit. That's why the version bumps on
ALL sources.

**Gone / replaced instance:** instance ids are **UUIDs, never reused**. Write to a closed
`v2` → registry has no `v2` → `NOT_FOUND: call views.list` (the "file deleted" analog). A new
plot is `v7`, never a reused `v2`, so a stale handle can't hit the wrong thing.

**Atomicity:** the frontend engine is single-threaded (JS event loop) → check-and-apply is
atomic within a tick, no TOCTOU. Backend actions get the same guarantee from REST optimistic
concurrency the route already owns (`If-Match`/`updated_at` → `409 Conflict`, relayed as STALE).

**Folded into `defineAction`:** `mutating + stateful` ⇒ the engine/gate require a valid
`expected` token; read-actions always return one. Declared once, enforced uniformly.

**The full per-write spine:** permission-checked (backend, trust) → state-token-checked
(engine, correctness) → schema-validated → applied → new token + logs returned.

## Layer 7 — liveness (PER-REQUEST, not per-session) + reconnect

Liveness is a property of an OUTSTANDING REQUEST, not the session. Ping-pong exists only to
answer "are you still working on request X?" — so there is **zero ping-pong when no request is
in flight** (no idle heartbeat). This also makes ping-pong's two jobs precise: detect a dead
frontend fast, AND distinguish "slow compute" from "dead" for a quiet long action.

**Per-request protocol** (keyed by `request_id`):
```
backend  agent_invoke{request_id} ─▶ frontend starts work
  progress{request_id} frames reset the quiet timer (implicit liveness)
  quiet for T (~3–5s, no progress) → ping{request_id} ─▶
     ◀ pong{request_id, processing}  → reset timer, keep waiting
     ◀ pong{request_id, unknown}     → client lost it (e.g. reloaded) → FAIL NOW (FRONTEND_RELOADED)
     …no pong in ~2 intervals / conn closed → FAIL (FRONTEND_UNRESPONSIVE)…
     ◀ result{request_id, …}         → done; per-request loop ends
```
- **`progress` is implicit liveness** — a long action that streams progress is never pinged; the
  ping is only a fallback when a request goes quiet.
- **Reload detection is instant, not timeout-based** — the reconnected page answers `pong{unknown}`
  for the orphaned request → immediate fail (missed pings / dropped conn are the hard-crash backstop).
- A pending request never false-times-out on genuine long work (pong/processing keeps it alive) and
  fails FAST when the frontend is gone.

**How the engine knows an in-flight action is alive (answering a ping):** the engine keeps a
per-request **execution record** while `run` is in flight —
`request_id → { promise, status: running|awaiting, lastActivity, currentWait }`. Ping → record
present ⇒ `pong{processing,…}`; absent (reloaded / already finished) ⇒ `pong{unknown}`. The
author writes nothing special.
- **"promise pending" ≠ alive.** An async `run` parked at an `await` could be legitimately
  waiting or hung forever on a never-true condition. Because EVERY outside touch goes through
  `ctx`, the engine always knows WHAT it waits on + WHEN it last advanced: `ctx.progress` bumps
  `lastActivity`; `ctx.waitFor(store,sel,pred)` sets `currentWait` and bumps `lastActivity` each
  time the watched store changes + the predicate re-evaluates (an advancing dependency reads
  alive, a frozen one does not). So pong carries `processing{waitingOn:"job J done", sinceMs}` —
  real detail, not a bare boolean; a long-stalled wait is visible and the LLM can cancel via
  `ctx.signal`.
- **Hangs are BOUNDED, not guessed:** `ctx.waitFor(pred, {timeout})` (and an optional action-level
  deadline) THROW when a condition doesn't hold in time → `run` fails cleanly → a failed
  `result{request_id}` is posted → the request ends. "Still working" is never unbounded.
- **This is why `ctx` is the mandated async seam:** a bare `await fetch()` that bypasses `ctx` is
  opaque → the engine can only say `processing{waitingOn:opaque, sinceMs}` with limited patience.
  The convention/gate/skill steer every long wait through `ctx.waitFor`/`ctx.stores` precisely so
  liveness stays observable.

**`session_id` is ROUTING ONLY (no heartbeat):** it answers "which connection is the controlled
window" (user → current conn), set via `hello{session_id}` on connect, dropped on connection
close, rebound on reload. Persisted in **`sessionStorage`** (per-tab, survives reload), gated to a
real reload via `navigation.type === 'reload'` so a `window.open`'d tab (inherits a COPY of
sessionStorage) gets a fresh id, not a hijacked binding (split-chat pop-out lesson). Reload does
NOT require re-clicking Connect (the ziee↔cyto MCP pairing/token is untouched).
- Dispatch when there is **no live connection** for the session → fail fast `FRONTEND_NOT_CONNECTED`
  (nothing to ping); frontend tools also drop from `tools/list`. Backend/REST actions STILL work
  (graceful degradation; AI tells the user to reopen the window).

**In-flight action across a reload (honest limit):** a mid-`run` action's JS dies with the page —
we can't resume arbitrary frontend code. Detected via `pong{unknown}` (or ping timeout) → the
pending fails `FRONTEND_RELOADED: re-read state before retrying`. The AI re-orients via a
world-model read; any backend side effect already kicked off (a started job) is re-discoverable
there (re-attach) — WHY actions stream progress + lean on server-persisted state, not ephemeral
page state.

## Layer 8 — visual reads (LLM sees a screenshot)

A screenshot is a permission-gated **frontend read-action** returning an MCP **image content
block** (`{type:'image', data:'<base64>', mimeType:'image/png'}`) — the LLM is multimodal; the
image rides the normal result channel + state-token stamp.

- **Capture:** a plot IS a canvas → `canvas.toBlob/toDataURL('image/png')` (high-fidelity,
  everywhere; WebGL needs `preserveDrawingBuffer:true` or in-frame capture). Whole-window/DOM →
  **Tauri native window capture on desktop** (primary target; includes WebGL), `html2canvas` web
  fallback (chosen by a `__TAURI__` predicate). Wait a settled frame (`requestAnimationFrame`)
  before capturing.
- **Targeted vs full-window:** `view.screenshot(view_id)` (that plot only) vs `ui.screenshot()`
  (whole window). Default to targeted — smaller and no incidental capture of unrelated panels.
- **Two tiers (cost):** images are token-expensive, so offer BOTH `view.describe` (cheap,
  structured — groups/visible/colorBy/ranges) and `view.screenshot`; tool descriptions steer the
  model to describe-first and screenshot only for genuinely visual/spatial verification.
- **Size:** base64 PNG downscaled to ~1568px longest edge + size-capped (the 1 MB result cap
  becomes image-aware — PNG for plots, JPEG for dense imagery).
- **Privacy/egress:** a screenshot sends the user's on-screen pixels to the LLM. Not a privilege
  escalation (the AI acts AS the user), but it IS data egress and a full-window grab can catch
  unrelated sensitive content. So: mandatory permission like every action; prefer targeted
  capture; full-window warrants a stricter gate + co-drive transparency ("the assistant took a
  screenshot").

## Layer 9 — AI presents ON the screen (tours / highlights / annotations)

The inverse of Layer 8: the AI presents onto the UI. **Principle: the AI drives a registered,
DECLARATIVE presentation vocabulary — never arbitrary HTML/JSX/code** (that would be an injection
hole + break the registered-actions model + carry untrusted LLM output into the DOM).

- Built-in **overlay layer** + ephemeral session-scoped **OverlayStore**; permission-gated
  presentation actions write declarative data to it, a renderer maps it to SAFE kit components:
  `ui.showTour(steps:[{target,title,body,action?}])`, `ui.highlight(anchor,{label?})`,
  `view.annotate(view_id,{shape,at,label})`, `ui.banner/toast(text)`, `ui.clearOverlays()`.
- **Targeting = stable anchors, not raw selectors.** Elements expose `tour-id` anchors (sibling
  of the testid registry); the world-model read `ui.anchors()` lists them with descriptions, so
  the AI grounds a target (`ui.highlight('clustering.resolution')`). Plot annotations target DATA
  coordinates (the plot resolves to screen space).
- **Interactivity / co-drive (killer use case):** a tour step's `action?` references a REGISTERED
  action id → "click to run clustering" points at the permission-gated `analysis.cluster`;
  user OR AI can trigger it. The AI TEACHES the scientist through the live UI. A step targeting an
  action the user lacks permission for is skipped — a tour can never trick the user into an
  unregistered/forbidden op.
- **Safety + lifecycle:** untrusted LLM text rendered as TEXT (no HTML/script); interactive
  affordances are registered permission-gated actions only; overlays are ephemeral (cleared on
  dismiss/nav/`clearOverlays`, re-issue replaces — idempotent), render only in the controlled
  window, and carry no staleness token (presentation, not domain mutation).
- **Richer content (optional extension):** an AI-composed summary panel uses a FIXED widget
  vocabulary (`text|table|stat|action-link`) via params — a constrained declarative "artifact"
  surface, text-sanitized, still no arbitrary code.

## Deployment — multi-user server is the GENERAL case; desktop = N=1

Design for the multi-user server; desktop falls out as one user, one window, localhost. The
actions/channel/liveness/staleness model is byte-identical — only scoping + a few transport/UX/ops
concerns change.

**Isolation (structural, keyed by user — same guarantee cyto's `sync` proves):**
- MCP connection = per-user bearer; every invoke re-authorizes as that user (forwarded JWT for
  backend, `principal_holds` for frontend).
- Agent channel = **per-user-keyed** SSE registry; an `agent_invoke` routes to THAT user's control
  connection — a frame cannot reach another user's window. User A's AI can never drive/read/
  screenshot user B.
- Runtime state (`OverlayStore`, instance directory, plot stores) lives in the BROWSER per session
  → naturally isolated; the backend holds only per-user routing + per-user PENDING.
- The action **manifest is GLOBAL** (one vocabulary for the app); only the **permission filter** is
  per-user. No per-user catalog.

So the three primitives (per-user token · per-user SSE audience · per-user permission filter)
generalize unchanged; desktop is N=1 on localhost.

**Pairing — same one-time-code handshake, different transport:** desktop = `ziee://` deep-link;
server/web = cross-origin **browser redirect** (both are web apps the user is logged into — an
OAuth-style "connect your X" flow). Identity binds ziee-user-U ↔ cyto-user-U via U's token;
revocation propagates through cyto's refresh-token whitelist (logout/admin-revoke → ziee refresh
fails → connection dies).

**Multi-window control (mandatory on server):** a user has many tabs → exactly ONE is the
controlled window (the paired session_id). Per-tab indicator + "take control" (one at a time). AI
actions/overlays/screenshots render ONLY in the controlled window; close it → `FRONTEND_NOT_CONNECTED`.
Desktop = the one window always holds control.

**Server ops (not needed on desktop):** per-user caps + rate-limit on the agent channel (cap
concurrent in-flight agent requests/user, wall-clock, output size — reuse sync's `12/user · 512
global` shape) so a runaway AI can't exhaust the server; the `mcp::use` grant IS the admin on/off
(revoke per group); an `mcp_tool_calls`-style **audit log** of AI-driven actions per user for
accountability.

**Transport-agnostic (protocol) — but reachability picks the pipe:** MCP=HTTP, agent channel=
SSE-down+POST-up. When cyto is reachable (server deploy) ziee dials it directly. When cyto is
**desktop-behind-NAT and ziee is REMOTE**, ziee CANNOT dial `127.0.0.1` → invert the transport
(next section). Build for multi-user server; desktop is the degenerate instance.

### Desktop cyto + REMOTE ziee — reverse-tunnel transport

Remote ziee cannot dial a desktop's localhost MCP (NAT/firewall/no public IP). Same move as the
browser agent channel: **the un-dialable side dials OUT.** Cyto stays the MCP *server* semantically;
the transport is reversed.

- At pairing, desktop cyto opens ONE persistent **outbound** connection (WebSocket/HTTP2) to
  **ziee's MCP-relay endpoint** and registers "cyto's MCP server for user U." Outbound is what
  NAT/firewalls allow → no inbound hole, nothing exposed publicly.
- MCP flows `U's ziee conversation → ziee relay → [U's outbound tunnel] → desktop cyto MCP → back up`.
- **Layers with the agent channel:** a frontend invoke traverses TWO reverse channels —
  `remote ziee ─tunnel(internet)─▶ desktop cyto backend ─local SSE agent channel─▶ cyto webview`.
  On desktop the inner hop is localhost; the tunnel only spans the internet gap. Same NAT reason,
  composed.
- **Security:** outbound-only (no inbound holes / public exposure); per-user authenticated tunnel
  (relay keys by user → isolation holds); permission model UNCHANGED (tunnel is just transport —
  every request still hits `mcp::use` + forwarded-JWT re-auth). **Data stays local** — only MCP
  protocol I/O (tool calls/results/screenshots) crosses to ziee; datasets never leave the desktop
  unless a result includes them (compute+data local, AI orchestration remote — a privacy win).
  The relay sees that I/O = same trust as using ziee at all.
- **Who builds it:** ziee hosts the **relay/broker** (accept outbound tunnels + route MCP through
  them) — a HANDOFF-SPEC item. Cyto builds the outbound tunnel client + serving MCP over the reverse
  transport; the pairing flow picks transport by reachability (direct HTTP vs reverse tunnel).
- **Fallbacks (no ziee relay):** a generic tunnel (Cloudflare Tunnel/ngrok/Tailscale Funnel) → an
  authenticated public cyto URL a vanilla MCP client dials (works w/o ziee cooperation, but exposes
  cyto → auth must be airtight); or same-LAN/Tailscale → ziee reaches cyto's private IP directly.

**Tunnel transport — WS vs HTTP/2 vs SSE+POST.** The requirement is that the RELAY initiates
requests TOWARD the dialer (cyto). **HTTP/2 alone does NOT solve this** — its model is
client-initiates-streams, and Server Push is deprecated + only primes responses, never arbitrary
server→client requests. So HTTP/2 needs a bidi pattern on top. Options:
- **WebSocket (`wss://`)** — purpose-built full-duplex; relay pushes requests, cyto sends responses/
  progress/pongs, multiplexed by `request_id`; binary frames (screenshots, no base64). `tokio-
  tungstenite`. Best efficiency; rare proxy blocks the Upgrade.
- **HTTP/2 gRPC-style bidi single stream** — true duplex but PATH-FRAGILE (a buffering proxy breaks
  full-duplex); only worth it if gRPC end-to-end. Skip unless already gRPC.
- **SSE-down + POST-up** — no full-duplex needed → max proxy compatibility, and IDENTICAL to the
  backend↔browser agent channel we already build → one transport abstraction, no new stack; binary
  → base64 (already done for MCP image blocks).

**Default: SSE-down + POST-up** (reuse the agent-channel transport, max compatibility), with
**WebSocket as an efficiency upgrade** where the path supports it + binary throughput matters. Skip
HTTP/2-bidi/gRPC and HTTP/2 server-push. Transport is a detail behind the tunnel abstraction — MCP
semantics / `request_id` multiplexing / isolation / permission are unchanged + swappable. (All TLS;
WS is an HTTP/1.1 Upgrade — RFC 8441 WS-over-HTTP/2 support is uneven, don't rely on it.)

## Pairing / one-click connect (desktop-first)

Both apps are local Tauri desktop apps. One button in Cyto ("Connect to ziee assistant"):
1. Cyto mints a **one-time authorization code** (short-lived, single-use) — NO token in the URL.
2. Cyto opens `ziee://connect-mcp?code=…&name=CytoAnalyst&url=http://127.0.0.1:<port>/api/mcp`
   (desktop: shell-opener; web: scheme-navigate; manual-copy fallback via a `__TAURI__` predicate).
3. Ziee exchanges the code at a Cyto endpoint (`POST /api/mcp/pair/exchange`) for the
   access+refresh pair (reuses `ziee-auth` `generate_tokens_with_jti_expiry` + refresh rotation
   so ziee keeps the connection alive long-term), registers Cyto's MCP server, and prompts the
   user to pick/create a conversation to control Cyto. Also establishes the **control-session
   binding** (which Cyto window the AI drives).

Secrets never ride an OS-logged deep-link URL (one-time-code exchange, not token-in-URL).

**The ziee side is a SEPARATE repo** (main `ziee`) — handled via a precise handoff SPEC
(deep-link scheme + payload, the exchange call, the add-MCP-server payload, the conversation-bind
UX). Cyto side is built here.

## Co-drive via sync (already real today)

Cyto's domain stores already `on('sync:<entity>', reload)` (Studies/StudyDetail/Jobs/Users).
The MCP invoke deliberately does NOT forward `X-Sync-Connection-Id`, so AI-driven REST mutations
(a different connection) are NOT self-suppressed → they fan out to the user's open Cyto UI →
it refetches and updates LIVE. The scientist watches the AI's changes land. As the workbench
adds persisted plot/selection state with sync + frontend actions, the AI drives those the same way.

## Backend MCP exposure — SDK-provided (confirmed true)

`ziee-control-mcp` (SDK) turns the backend OpenAPI into MCP capability: `init_from_openapi`
builds the op catalog (route + request schema + required permission); `tools::tool_list()`
exposes `list/describe/invoke_capability`; invoke dispatches to the real route over loopback
with the forwarded JWT. Apps add only a thin JSON-RPC handler. So `create study`, `update user`,
etc. are drivable the moment they're a route — no per-endpoint tool authoring. This half is a
solved capability; the cyto exposure module (the thin handler) is small glue.

## Decisions locked so far

- Home: **cyto-first, promote to SDK later** (human choice). Foundation is framework-shaped
  (`defineAction`/engine/collector/gate) but proven in cyto first.
- Handshake: **one-time-code exchange** (not token-in-URL).
- Channel: **dedicated agent SSE (down) + POST progress/result (up)**, request_id correlated;
  do NOT reuse the payload-free `sync`. Channel STREAMS progress (non-atomic actions).
- Liveness: **PER-REQUEST ping-pong, not per-session** — ping{request_id} only when an outstanding
  request goes quiet; NO idle heartbeat; `pong{unknown}` on a reconnected page = instant orphan-fail.
  `session_id` is ROUTING-only (which connection is the controlled window), rebound on reload.
- Actions: **standalone first-class primitive (`defineAction` + `run(params, ctx)`), NOT embedded
  in stores.** Stores stay pure state. Actions are **async, non-atomic, multi-store** — `ctx`
  gives reactive multi-store read/subscribe/`waitFor`, method calls, `ctx.instance` resolution,
  progress/log streaming, and cancel. Channel **streams** progress frames + a final result.
- Instance model: **action is global + permissioned (compile-time); INSTANCE reached via runtime
  `ctx.instance(Store, view_id)` from a store-runtime directory (view_id = UUID, never reused).**
  No per-instance action registration / `useAction`.
- Staleness: **version-stamped entities + state token + read-before-write**, engine-enforced (FE)
  / REST-OCC (backend).
- Permission: **mandatory on every action, backend-authoritative for FE actions, gate-checked**.
- Ziee side: **handoff spec**, not built here.

## Phasing (each its own feature-lifecycle; sequencing TBD with orchestrator)

- **Slice 1 — `feat/ai-mcp` (current, paused at Phase 4):** backend MCP exposure + one-click
  pairing (cyto side) + co-drive-via-sync proof + the ziee-side handoff spec. The connectivity spine.
- **Slice 2 — command/action registry:** `defineAction` + collector + manifest + backend
  `FrontendActionCatalog` + the human command palette + register cyto's existing actions.
- **Slice 3 — puppet engine + channel:** the duplex agent channel + frontend engine + instance
  registry/directory + `useAction` + world-model reads + the stale-state guard + MCP projection
  of frontend actions.
- **Slice 4 — completeness gate:** `check:action-manifest` in `npm run check` (parity + mandatory
  real-permission + registration + UI-references-a-real-action lint).
- **Slice 5 — Claude skill `ai-controllable-actions`:** binding agent guidance; wired as a
  mandatory feature-lifecycle sub-check (register every action + audit AI-drivability).

## Open questions for the human / orchestrator

- Exact slice sequencing + whether slices 2–5 stay on `feat/ai-mcp` (cyto-first, "we can do it
  here") or fan to their own branches; likely needs orchestrator (live6) allocation since this
  outgrows a single lane.
- Whether the Claude skill lands in this branch or as slice 5.
- Multi-window: which Cyto window is "the controlled session" when several are open (pairing
  binds one; UX for switching).
