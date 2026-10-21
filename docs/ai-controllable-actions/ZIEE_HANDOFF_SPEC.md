# ZIEE_HANDOFF_SPEC — what the `ziee` chat app must build to connect + drive CytoAnalyst

> **Audience:** the `ziee` chat app team (separate repo, `ziee-ai/ziee`). This is a precise,
> implementable spec, not a design pitch — the design record (with rationale) is
> [`ARCHITECTURE.md`](./ARCHITECTURE.md) in this same directory; the exact cyto-side wire
> contract is [`../../.lifecycle/ai-mcp/CONTRACT.md`](../../.lifecycle/ai-mcp/CONTRACT.md). Read
> those first if anything here is ambiguous — they are the source of truth for the cyto side.
>
> **Status:** cyto ships **Slice 1** (backend MCP exposure + one-time-code pairing, direct-HTTP
> transport only) now. Sections 1–5 and 7 of this spec are needed for Slice 1 to be usable
> end-to-end. Section 6 (reverse-tunnel relay) is a **later** slice — cyto's pairing UX degrades
> gracefully without it (desktop-cyto-behind-NAT + remote-ziee just isn't connectable yet).
>
> **Non-goals of this doc:** it does not ask ziee to build anything CytoAnalyst-specific. Every
> endpoint/convention below is a generic "pairable MCP source" contract — a second app that
> implements the same three endpoints (`/api/mcp`, `/api/mcp/pair/start`, `/api/mcp/pair/exchange`)
> should work with the exact same ziee-side code.

---

## 0. Actors and vocabulary

| Term | Meaning |
|---|---|
| **cyto** | CytoAnalyst — the app being controlled. Owns the MCP *server*. Never runs an LLM. |
| **ziee** | The chat app — the AI *host*. Owns the LLM, the chat loop, tool approval. This doc's audience. |
| **pairing code** | A short-lived, single-use authorization code cyto mints. Carries no privilege by itself — it's exchanged, never used directly as a credential. |
| **MCP connection** | ziee's existing concept of a registered MCP server (`mcp_servers` table, `transport_type='http'`). A successful pairing produces exactly one of these, `url` = the cyto MCP endpoint. |
| **paired token pair** | The `{access_token, refresh_token, expires_in}` a connection gets from `pair/exchange`. Distinct from ziee's own login session tokens — these authenticate ziee **to cyto**, as the cyto user who paired. |
| **control session** | Cyto-side concept: which one of the user's open cyto browser tabs is being driven. Bound during pairing, not something ziee manages directly (see §4, §9). |

---

## 1. The one-time-code pairing handshake

Two transports carry the same three params (`code`, `url`, `name`) into ziee. In both cases **the
code is the only thing that crosses the wire before exchange — never a token.**

```
code     — one-time, short-TTL, single-use authorization code (opaque string)
url      — the cyto MCP endpoint, e.g. http://127.0.0.1:54123/api/mcp (desktop) or
           https://cyto.example.com/api/mcp (server deploy)
name     — display name to show the user, e.g. "CytoAnalyst"
```

### 1a. Desktop transport — `ziee://connect-mcp` deep link

Both apps are local Tauri desktop apps in the common case. Cyto's "Connect to ziee assistant"
button:
1. Calls its own `POST /api/mcp/pair/start` (authed as the cyto user) → `{code, mcp_url}`.
2. Opens `ziee://connect-mcp?code=<code>&url=<mcp_url>&name=CytoAnalyst` via Tauri's shell-opener
   (falls back to a manual copy-paste UI on platforms/configs where the OS scheme handoff fails).

**What ziee must build — this does not exist in the repo today:**

- Add `tauri-plugin-deep-link` to `src-app/desktop/tauri/Cargo.toml` (it is not currently a
  dependency — the desktop crate today only pulls `tauri-plugin-{opener,dialog,notification,
  updater,decorum}`).
- Register the `ziee` URL scheme:
  - `tauri.conf.json` — add a `plugins.deep-link.schemes: ["ziee"]` (or the plugin's current
    config key) entry. The bundle identifier is already `com.ziee.chat`; keep the scheme lowercase
    `ziee` to match every other `ziee://…` / `ziee-*` naming convention in this repo (see
    `CLAUDE.md`'s Naming Convention section — this is user/operator-facing, so it must be `ziee`,
    not anything `ziee-chat`-flavored).
  - OS-level registration: Linux needs a `.desktop` file `MimeType=x-scheme-handler/ziee;` entry
    (the plugin's Linux backend can generate this at install time — verify it's wired into the
    existing Linux bundling step); macOS/Windows registration is handled by the plugin via
    `Info.plist`/registry keys at bundle time — no manual step expected there.
  - Windows/Linux: a second-instance launch carrying the URL must be forwarded to the *already
    running* app (the plugin's `on_open_url` / single-instance handling) rather than spawning a
    second ziee process — check this against the existing single-instance plugin usage if any.
- Rust-side handler (new, in `src-app/desktop/tauri/src/`): register the deep-link listener at
  startup, parse `connect-mcp` URLs, and forward `{code, url, name}` into the frontend as a Tauri
  event (the plugin's own `deep-link://new-url` event, or re-emit a typed
  `mcp-pairing-request` event — either is fine, just document which one the frontend subscribes
  to). Closest existing precedent for "an external redirect resumes inside this desktop app":
  `src-app/desktop/tauri/src/modules/magic_link/` (one-time-link auth for the tunnel/remote-access
  case) — same *shape* (parse an opaque one-time token out of a URL, hand it to a handler), though
  that module is server-side desktop code answering an inbound magic-link request, not a
  registered URL scheme; use it for structural inspiration, not code reuse.
- Frontend: a listener (wherever the app's top-level Tauri event wiring lives) that, on receiving
  the pairing event, navigates to (or opens) the same `/connect-mcp` flow described in §1b — the
  deep link and the web redirect should converge on ONE frontend code path from this point on, so
  §2–§4 are transport-agnostic.

### 1b. Server/web transport — cross-origin browser redirect

When cyto is a server deployment (or the user is on cyto's web UI rather than its desktop shell),
the deep-link scheme isn't available in a browser tab, so the same three params travel via an
ordinary cross-origin `window.location` redirect — the standard "connect your X" OAuth-adjacent
pattern (both apps are web apps the user is logged into).

```
GET https://<ziee-deployment-origin>/connect-mcp?code=<code>&url=<mcp_url>&name=CytoAnalyst
```

**What ziee must build:**

- A route `/connect-mcp` (any framework-appropriate mount) that:
  1. Requires an authenticated ziee session — if the user isn't logged in, redirect through
     ziee's normal login flow and resume at `/connect-mcp?…` afterward (reuse whatever
     "protected route with post-login continuation" mechanism already gates other authenticated
     routes; this is not a new pattern, just apply the existing one here).
  2. Parses `code`/`url`/`name` from the query string.
  3. Runs the exchange (§2) and the connection-creation + conversation-binding UX (§3–§4).
- **`ziee-deployment-origin` is not fixed** — every ziee deployment has its own domain (self-
  hosted). Cyto needs to know it to redirect there. This is a genuine open item for the *cyto*
  side (an admin- or user-configured "my ziee URL" setting) — nothing ziee needs to build, but
  worth knowing so the ziee team isn't surprised the redirect target is configurable per
  deployment rather than a fixed `ziee.ai` domain.
- This route is **not** the SSO callback pattern (`AuthCallbackPage.tsx`, which delivers a
  *ziee* session token via a URL fragment after ziee-as-identity-provider login) — don't reuse
  that code path. `/connect-mcp` runs entirely inside an *already-authenticated* ziee session and
  talks to a *third-party* token endpoint (cyto's), so the fragment-delivery mechanics don't apply
  here. The one thing worth mirroring from `AuthCallbackPage.tsx` is the discipline: **the code
  must never be persisted or logged past the exchange** (analogous to that page's `history.
  replaceState` scrub of the token fragment) — a one-time code sitting in browser history /
  server access logs is a live authorization until it's used, and the "one-time" property depends
  on it being consumed exactly once.

### Sequence (both transports converge at exchange)

```
   cyto UI                     cyto backend                    ziee (desktop or web)
     │                              │                                  │
     │  click "Connect to ziee"     │                                  │
     ├─ POST /api/mcp/pair/start ─▶ │                                  │
     │  (authed as cyto user U)     │  mint code (short TTL,           │
     │                              │  single-use), bind to U          │
     │ ◀── {code, mcp_url} ─────────┤                                  │
     │                              │                                  │
     │  1a: shell-open              │                                  │
     │    ziee://connect-mcp?code=…&url=…&name=…                      │
     │  ── OR ──                    │                                  │
     │  1b: window.location =       │                                  │
     │    https://<ziee-origin>/connect-mcp?code=…&url=…&name=… ─────▶│
     │                              │                                  │  parse {code,url,name}
     │                              │                                  │  (ensure ziee session live)
     │                              │ ◀── POST {url}/pair/exchange ────┤  body: {"code": "…"}
     │                              │      {code}                      │
     │                              │  validate code: single-use,      │
     │                              │  not expired, bound to U         │
     │                              │  mint access+refresh JWT pair    │
     │                              │  (ziee-auth generate_tokens_     │
     │                              │   with_jti_expiry, same shared   │
     │                              │   SDK crate ziee's own login     │
     │                              │   uses)                          │
     │                              ├── {access_token, refresh_token, ─▶
     │                              │    expires_in} ──────────────────┤  persist as new MCP
     │                              │                                  │  connection (§2)
```

---

## 2. Code exchange

**Endpoint (cyto-owned, per `CONTRACT.md`):** `POST <exchange_url>`, **no permission gate** — the
code itself is the credential.

```
exchange_url = "<mcp_url>/pair/exchange"
```

This is a deliberate **convention**, not a cyto special-case: `mcp_url` is the value carried in
the deep link / redirect (e.g. `http://127.0.0.1:54123/api/mcp`), and the exchange endpoint is
always its sibling path `.../pair/exchange`. Deriving it this way (rather than hard-coding
anything cyto-specific) means the same ziee-side code works unmodified for any future app that
implements this same three-endpoint contract. As a robustness fallback, accept an optional
explicit `exchange_url` query param on the deep link / redirect that overrides the derived value,
for a source that doesn't follow the convention — but derive-by-convention should be the default
path.

**Request:**
```json
POST http://127.0.0.1:54123/api/mcp/pair/exchange
Content-Type: application/json

{ "code": "a1b2c3d4-…" }
```

**Response (200):**
```json
{
  "access_token": "eyJhbGciOi...",
  "refresh_token": "eyJhbGciOi...",
  "expires_in": 86400
}
```
(`expires_in` is seconds; cyto's default access-token lifetime is 24h, mirroring ziee's own
`session_settings.access_token_expiry_hours` default — same shared `ziee-auth` crate, same
defaults.)

**Failure modes to handle:** code already used / expired / unknown → the exchange 4xxs. Surface
this as a clear "connect link expired — click Connect in CytoAnalyst again" error; do **not**
retry the exchange with the same code (it's single-use by design — a retry-on-network-error loop
must re-derive a fresh code by starting the flow over, not resubmit the same `code`).

### Storing the result — extend, don't replace, `mcp_servers`

On success, create (or update, if the user already paired with this exact cyto instance —
dedupe on `url`) a row shaped like ziee's existing `mcp_servers` table:

```
name               = slugified "cytoanalyst" (or derived from `name` param)
display_name       = name param, e.g. "CytoAnalyst"
transport_type     = 'http'
url                = url param (the mcp_url)
user_id            = the ziee user running this flow (never is_system — this is a personal,
                     per-user credential, structurally like a personal MCP server today)
enabled            = true
```

**The credential itself does not fit the existing secret-storage shape.** Today's `mcp_servers`
secret storage (`headers_encrypted` + `headers_secret_keys`, `environment_variables_encrypted` +
`*_secret_keys`) is designed for **static, admin/user-entered** secrets (an API key someone typed
in) — it has no rotation concept. A paired token pair **rotates on every refresh** (§3) and needs
a `expires_at` alongside it. Two reasonable shapes, in order of preference:

1. **A new sibling table**, `mcp_server_paired_tokens` (or similar), keyed `server_id` PK —
   structurally the rotating-token analog of the existing `mcp_server_oauth_configs` table
   (which stores a *static* `client_id`/`client_secret` for the headless `client_credentials`
   grant). Columns: `server_id uuid PK`, `access_token_encrypted`, `refresh_token_encrypted`,
   `expires_at timestamptz`, `created_at`, `updated_at`. Encrypt both token values the same way
   `headers_encrypted` values already are (existing `common::secret` dual-column convention used
   throughout the repo, per `CLAUDE.md`'s BioMCP / web_search / citations sections).
2. Alternatively, extend `mcp_server_oauth_configs` itself with nullable
   `access_token_encrypted` / `refresh_token_encrypted` / `expires_at` columns and an
   `auth_mode` discriminator (`'client_credentials' | 'paired_token'`) — fewer tables, one place
   the HTTP client already looks for a bearer credential.

Either way, the outcome the MCP HTTP client (`src-app/server/src/modules/mcp/client/http.rs`)
needs is unchanged from what it already does for OAuth `client_credentials` servers: attach
`Authorization: Bearer <access_token>` to every request to this server's `url`, refreshing first
if the stored token is within the existing `is_valid()` 30-second safety skew used by
`StoredToken` in `client/auth.rs` today. The only new behavior is that the **refresh call target
and grant shape differ** — see §3 — and that the token pair must be **persisted to the DB**, not
just held in the in-memory `StoredToken` cache that today's `client_credentials` flow uses (a
paired connection must survive a server restart without forcing the user to re-pair).

### 2a. Refreshing the token — reuse cyto's (= ziee's own) session-refresh mechanism

The tokens minted at exchange are **standard `ziee-auth` SDK session tokens** — literally the
same rotating-refresh-token mechanism documented in this repo's own `CLAUDE.md` under
"Session & Token Refresh" (single-use rotation, 30s grace window, jti whitelist, `REFRESH_TOKEN_
REVOKED` on a dead token). Cyto exposes it at the same route path ziee's own frontend already
calls for its own session:

```
POST <cyto-origin>/api/auth/refresh
Content-Type: application/json

{ "refresh_token": "eyJhbGciOi..." }
```
```json
200 {
  "access_token": "eyJhbGciOi...",
  "refresh_token": "eyJhbGciOi...",   // rotated — the OLD refresh_token is now dead
  "expires_in": 86400
}
```
```
401 { "error": { "code": "REFRESH_TOKEN_REVOKED", ... } }   // logged out / admin-revoked (§3)
401 { "error": { "code": "MISSING_REFRESH_TOKEN", ... } }   // malformed/missing body
```

Treat this connection's token exactly like ziee's own session, scoped to one MCP connection
instead of the logged-in user: proactively refresh at ~75% of `expires_in` with a watchdog
covering sleep/suspend (the existing `Auth.store.ts` `refreshSession()` timer + 60s-watchdog +
`visibilitychange`/`online` listeners is the literal template — same pattern, different token
scope), single-flight per connection so concurrent tool calls don't race duplicate refreshes,
and a reactive on-401 retry-once as the backstop (mirrors `setUnauthorizedHandler`). **Do not**
build a second, independent refresh mechanism — this is the same problem ziee already solved for
its own session, applied to N external connections instead of 1.

---

## 3. Identity mapping and revocation

The exchanged token authenticates ziee **as cyto-user-U** (the user who clicked Connect in cyto).
Bind it: `mcp_servers.user_id` = the **ziee** user who ran the pairing flow ↔ this connection's
stored credential authenticates as cyto-user-U. ziee does not need to know or store cyto's
internal user id — the binding is implicit in "this ziee user owns this connection row," and
every call cyto receives is scoped to whatever cyto-user-U can see (cyto enforces that on its
side, per-request, via the forwarded bearer — see `ARCHITECTURE.md` Layer 5).

**Revocation propagates through the refresh chain, not a webhook.** If cyto logs the user out, an
admin revokes their session, or the user's cyto account is disabled, cyto's refresh-token
whitelist (the same jti-whitelist mechanism as ziee's own `revoke_all_for_user`) makes the next
`POST <cyto-origin>/api/auth/refresh` fail with `401 REFRESH_TOKEN_REVOKED`. There is no separate
revocation signal — **detecting this on the next refresh attempt is the mechanism**, so:

- On `REFRESH_TOKEN_REVOKED` (or any refresh failure after retry/backoff), mark the connection
  `enabled = false` (or a dedicated `disconnected` status if the schema grows one) rather than
  deleting the row — preserve `mcp_tool_calls`-equivalent history for this connection.
  Auto-attach/tool-list for this server must stop offering it once disconnected (fails closed,
  not open).
- Surface a clear "CytoAnalyst connection lost — reconnect" affordance that simply re-runs §1
  from scratch (mint a fresh code; the dead token pair is discarded, not resurrected).
- Do **not** treat a single transient network failure as revocation — apply the same
  distinguish-transient-from-terminal judgment ziee's own refresh path already applies (retry/
  backoff before concluding "revoked").

---

## 4. Conversation-binding UX

After a connection is created (§2) and confirmed live (§3), prompt the user to bind it to a
conversation — cyto's action model requires a driving conversation to route `agent_invoke` frames
into (`ARCHITECTURE.md` Layer 3, cyto side), and generically, a freshly-added MCP server is only
useful once it's actually reachable from a chat.

Two entry points, mirroring the **`pendingProjectId`** pattern already documented in this repo's
`CLAUDE.md` (Chat Projects section) — reuse that exact mechanism rather than inventing a second
"pending X on next conversation create" field:

- **"Continue in an existing conversation"** — user picks from a list; ziee attaches the new MCP
  server to that conversation's MCP settings (existing per-conversation `mcp_settings` /
  `disabled_servers` toggle machinery — just ensure the new server isn't in that conversation's
  disabled list).
- **"Start a new conversation"** — set a `pendingMcpServerId` (or reuse/extend `pendingProjectId`
  if a single "pending attachment" slot generalizes cleanly) on the chat store; `NewChatPage`
  reads it on mount, `createConversation` consumes + clears it on both success and error (same
  contract as `pendingProjectId` today), and the created conversation's MCP settings pre-enable
  the new server.

This step is UX polish on top of a connection that already works via direct `tools/list` /
`tools/call` on any conversation with the server enabled — don't block §1–§3 on it, but don't skip
it either: a user who pairs and is dropped back into a conversation with no indication the new
tool is available will reasonably conclude the connect flow did nothing.

---

## 5. Driving cyto — this is an ordinary MCP HTTP server

Nothing about invoking cyto is special-cased. ziee's existing MCP client (`src-app/server/src/
modules/mcp/client/`) already speaks JSON-RPC 2.0 streamable-HTTP to any `transport_type='http'`
server; cyto's `POST /api/mcp` (per `CONTRACT.md`) is exactly that:

```
initialize     → standard MCP handshake
tools/list     → returns exactly 3 tools: list_capabilities, describe_capability, invoke_capability
tools/call     → invoke_capability{action_id, params} does the actual work; the 3-tool surface is
                 intentional (a stable, generic "capability router" — cyto's underlying action
                 catalog can grow without ziee's tool list ever changing shape)
```

Two things worth a deliberate check against the existing client/rendering pipeline, since cyto's
result shapes are richer than a typical stdio tool:

- **Image content blocks.** A `describe_capability`/`invoke_capability` result can carry an MCP
  image content block (`{"type":"image","data":"<base64>","mimeType":"image/png"}`) — cyto's
  later screenshot slice (`ARCHITECTURE.md` Layer 8, descoped from Slice 1 but coming). Confirm
  ziee's `mcp_tool_calls` recording (the byte-strip-to-`{_stripped,_bytes}` convention already
  documented for binary content blocks in this repo's `CLAUDE.md`) and the chat UI's tool-result
  renderer both already handle an image block end-to-end, not just text. If this already works
  for some other MCP server today, no action needed here — just confirm rather than assume.
- **Streamed progress.** Slice 1 exposes only backend (`kind: rest`) actions, which are ordinary
  synchronous request/response — no progress streaming needed yet. Cyto's later **frontend
  actions** slice (puppet actions that run in a user's live browser tab, `ARCHITECTURE.md` Layers
  3–7) are long-running and stream intermediate state via standard MCP `notifications/progress`
  during an in-flight `tools/call`. Not required for Slice 1; worth confirming ziee's MCP client
  forwards `notifications/progress` to the chat UI as intermediate assistant-visible updates
  before that slice lands, since it changes the UX from "spinner, then answer" to "live narration."

`tools/list` is already pre-filtered server-side to what cyto-user-U can see (permission-checked
on cyto's side, per-request, using the bearer this connection presents) — ziee does not need to
do any additional capability filtering; a `tools/call` for something the user lacks permission
for on the cyto side returns an MCP tool error (`isError: true`), not a silent omission.

---

## 6. Reverse-tunnel relay — LATER slice, spec only (not needed for Slice 1)

**Cyto ships direct-HTTP pairing first.** This section is the concrete design for the harder case
so it's ready to build when prioritized — it is explicitly **not** requested for the current
cyto-side slice (cyto's own `DECISIONS.md` DEC-4 / ITEM-23/28 descope this to a named follow-on).

### The problem

Remote ziee (a hosted/server deployment) cannot dial `http://127.0.0.1:<port>/api/mcp` on a
user's desktop cyto — no public IP, behind NAT/firewall. The direct-HTTP transport in §1–§5 only
works when ziee can reach cyto's URL (server-deployed cyto, or same-machine desktop+desktop).

### The move: invert the dial direction

Same principle as cyto's own agent channel (`ARCHITECTURE.md` Layer 3): **the un-dialable side
dials out.** Desktop cyto opens ONE persistent **outbound** connection to a **ziee-hosted relay
endpoint** at pairing time; ziee routes that user's MCP traffic through the tunnel instead of an
HTTP dial. Outbound-only — no inbound hole on the user's desktop, nothing exposed publicly.

### Transport: SSE-down + POST-up (not WebSocket, for v1)

Per `ARCHITECTURE.md`'s transport-decision section: WebSocket is purpose-built full-duplex and
more efficient, but SSE+POST needs no full-duplex, is maximally proxy-compatible, and — the
decisive factor — is **the same transport shape ziee would build anyway** for the down/up split
(no new stack, one abstraction). Build this one first; WebSocket is a documented future upgrade
where path/throughput justify it, not a v1 requirement.

### Endpoints (ziee-owned — this is the "HANDOFF SPEC item" cyto's docs point at)

```
GET  <ziee-origin>/api/mcp-relay/stream?connection_id=<uuid>
     — SSE, authenticated with the connection's paired bearer token (§2). Desktop cyto opens this
       and keeps it open. On connect, ziee binds:  ziee-user-id (from the token) → connection_id
       → this SSE connection, in a per-user-keyed registry.

POST <ziee-origin>/api/mcp-relay/up
     — desktop cyto posts responses/progress/pongs here, authenticated the same way, correlated
       by request_id.
```

This is structurally identical to cyto's own `GET /api/mcp/agent/stream` + `POST /api/mcp/agent/
{progress,result,pong}` (`CONTRACT.md`) — same registry-keyed-by-user shape, same request_id
correlation, same per-request (not per-session) liveness ping-pong. It is also structurally
identical to ziee's own **Realtime Sync** registry (`src-app/server/src/modules/sync/registry.rs`,
documented in this repo's `CLAUDE.md`): a per-user keyed connection pool with a global cap, a
per-user cap, and a bounded per-connection channel depth, poison-recovering mutex. **Fork that
registry's shape** for the relay registry rather than designing a new one — the isolation
guarantee (§7) it already proves is exactly the guarantee the relay needs.

### Framing

```
// ziee → desktop cyto, over the SSE-down stream (one JSON object per `data:`)
{ "type": "mcp_request", "request_id": "<uuid>", "body": { ...raw JSON-RPC 2.0 request... } }
{ "type": "ping",        "request_id": "<uuid>" }

// desktop cyto → ziee, POSTed to /api/mcp-relay/up
{ "type": "mcp_response", "request_id": "<uuid>", "body": { ...raw JSON-RPC 2.0 response... } }
{ "type": "pong",         "request_id": "<uuid>", "status": "processing"|"unknown" }
```

`body` is the **unmodified JSON-RPC envelope** ziee's MCP client would otherwise POST directly to
`<mcp_url>` — the relay is a pure transport substitution, not a protocol translation. ziee's MCP
client dispatch logic for a "relay-mode" connection differs only in *how* the request leaves the
process (write into the per-connection PENDING map + push over the registry's SSE stream, await a
correlated `mcp_response` via a oneshot) — everything above the transport line (JSON-RPC framing,
tool semantics, permission handling) is unchanged from §5.

**Registration / mode selection:** a connection created via §2 needs a `transport_mode` field
(`'direct_http' | 'relay'`) — set at pairing time based on whether the deep-link/redirect params
indicate a reachable `url` vs. a request for relay mode (cyto decides this, since cyto knows
whether it's a server deployment or a NAT'd desktop instance; the simplest signal is: server cyto
always requests direct-HTTP, desktop cyto offers a "connect over relay" option when direct dial
would fail). ziee's MCP dispatch branches on this field: `direct_http` → POST straight to `url`
(§5 as written today); `relay` → look up the connection's `connection_id` in the relay registry,
fall through the framing above.

**Liveness reuses cyto's own per-request model** (`ARCHITECTURE.md` Layer 7): ping only an
*outstanding* request that's gone quiet, no idle heartbeat; `pong{unknown}` (page/process
reconnected mid-request) fails that one request immediately rather than hanging.

**Fallback path (works without ziee building any of this):** cyto's own docs note a generic-
tunnel fallback (Cloudflare Tunnel / ngrok / Tailscale Funnel) that exposes an authenticated
public cyto URL any vanilla MCP client — including ziee's existing direct-HTTP path — can dial
with zero ziee-side relay code. That's a legitimate stopgap; this section is for the "ziee-native,
no third-party tunnel dependency" version.

---

## 7. Multi-user isolation requirements

These apply to **both** the direct-HTTP connection (§2–§5, needed now) and the relay (§6, needed
later) — stated together because they're the same property at two transport layers:

- **Per-connection, per-user credential.** Each `mcp_servers` row (+ its paired-token row, §2) is
  owned by exactly one ziee `user_id`. A tool call made in user A's conversation must resolve to
  user A's stored bearer — never a different user's, never a fallback/shared credential.
- **Relay registry keyed by ziee-user-id, never by `connection_id` alone.** A relay frame destined
  for user A's tunnel must be structurally unroutable to user B's — the registry lookup path
  should make "wrong user" a type error / an empty-lookup, not a runtime check that can be
  forgotten at a call site. This is exactly the guarantee ziee's own sync registry already proves
  today (per `CLAUDE.md`: "an `agent_invoke` routes to THAT user's control connection — a frame
  cannot reach another user's window," cyto's own language for the identical property on its
  side) — hold the relay to the same bar.
- **Target user is derived from server-side auth context, never a client-supplied field.** The
  conversation → connection → user chain must resolve from the authenticated ziee session /
  conversation ownership, not from any id the caller (including the LLM's tool-call arguments)
  supplies.
- **Caps.** Mirror the sync registry's shape (`512` global / `12` per-user / bounded per-
  connection channel depth) for the relay registry rather than leaving it unbounded — a runaway
  or malicious desktop-cyto instance shouldn't be able to exhaust the relay.
- **Revocation is per-connection.** Killing one user's paired connection (§3) must not affect any
  other user's connections, even to the same cyto instance (two different ziee users pairing with
  the same cyto deployment get two independent connection rows, two independent token pairs, and
  — in relay mode — two independent tunnel registrations).

---

## Appendix A — endpoint quick reference (cyto side, from `CONTRACT.md`)

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /api/mcp` | bearer (paired token) | JSON-RPC 2.0: `initialize`/`tools/list`/`ping`/`tools/call` |
| `POST /api/mcp/pair/start` | cyto user session | mint `{code, mcp_url}` |
| `POST /api/mcp/pair/exchange` | code (no bearer) | `{code}` → `{access_token, refresh_token, expires_in}` |
| `POST /api/auth/refresh` | refresh_token | standard `ziee-auth` rotating refresh (shared SDK, same mechanism as ziee's own login) |

## Appendix B — what's cyto's job vs. ziee's job

| | Owner |
|---|---|
| Mint pairing code, open deep link / redirect | cyto |
| Register `ziee://` scheme, handle deep link | **ziee** (§1a) |
| Host `/connect-mcp` authenticated landing route | **ziee** (§1b) |
| Call `pair/exchange`, persist connection + rotating token pair | **ziee** (§2) |
| Refresh loop, revocation handling | **ziee** (§2a, §3) |
| Conversation-binding prompt | **ziee** (§4) |
| MCP JSON-RPC client (already exists — verify image/progress handling) | **ziee** (§5, mostly done) |
| Relay/broker endpoints + registry (later slice) | **ziee** (§6) |
| Outbound tunnel client, transport-mode selection | cyto |
| Everything permission/authorization-related | cyto (every call re-authorizes against cyto's own RBAC using the forwarded bearer — ziee never needs its own copy of cyto's permission model) |

## Appendix C — open questions for the ziee team

1. **Token-pair storage shape** (§2): new sibling table vs. extending `mcp_server_oauth_configs`
   with an `auth_mode` discriminator — pick whichever fits the existing secret-storage/encryption
   plumbing with less churn; both are sketched above, neither is mandated.
2. **`pendingMcpServerId` vs. generalizing `pendingProjectId`** (§4): worth a single "pending
   attachment" abstraction if a third such flow is anticipated, otherwise a parallel field is
   simpler — a judgment call for whoever implements it.
3. **Second-instance deep-link forwarding on Linux/Windows** (§1a): depends on whether the desktop
   app already has single-instance enforcement wired up elsewhere; if not, this flow is the reason
   to add it.
4. **Relay registration auth** (§6): specified here as "the connection's paired bearer token,"
   which requires the relay's authenticate step to validate against cyto's `/api/mcp` the same way
   any bearer-authenticated call would (or against cached validity) — confirm this composes
   cleanly with however connection validity is already checked elsewhere before treating it as
   final.
