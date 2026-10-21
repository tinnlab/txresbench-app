# Runtime feature flags (Admin Console epic #40)

## Problem

Today all feature-gating in CytoAnalyst is **compile-time only**:

- the cargo `saas` feature (`#[cfg(feature = "saas")]`) links modules in or out,
- `#[distributed_slice(MODULE_ENTRIES)]` self-registration decides what a binary carries,
- `CORE_MODULE_BLOCKLIST` splits desktop vs server,
- `seed_only_enabled` is an **ENV config** (sandbox/processors), not admin-togglable.

There is **no runtime, admin-togglable feature flag** — an operator cannot turn a
capability on or off for the deployment, or for one account, without a rebuild/redeploy.

## Goal

A self-contained `features` subsystem that adds a **runtime, admin-togglable feature
flag** layer, consulted by other modules via one guard helper. Concretely:

1. A `feature_flags` table holding a **global** default per flag plus optional
   **per-account overrides**.
2. A runtime guard helper `is_feature_enabled(pool, flag_key, account_id?)` resolving
   **per-account override → global default → compiled default**.
3. A `features::manage` admin permission (Tier-0 deferred this here).
4. Admin REST: `GET /api/admin/features` (list flags + effective state, optional
   `?account_id=`), `PUT /api/admin/features/{flag_key}` (set global or per-account
   enabled), gated to admins.

This provides the seam the frontend Flags page (#48) binds to, and the runtime seam
other modules will later consult.

## Model

`feature_flags` table:

- `flag_key text NOT NULL` — the flag identifier (e.g. `demo.runtime_flag`).
- `account_id uuid NULL` — NULL is the **global default** row; a non-NULL value is a
  **per-account override**. FK to `accounts(id) ON DELETE CASCADE`.
- `enabled boolean NOT NULL` — the toggle.
- `created_at`, `updated_at timestamptz NOT NULL DEFAULT now()`.
- `UNIQUE (flag_key, account_id)` — at most one global row and one row per account per
  flag. (Postgres treats NULLs as distinct in a UNIQUE index, so uniqueness of the
  **global** row (account_id IS NULL) is additionally enforced by a partial unique
  index `WHERE account_id IS NULL`.)

## Flag registry (compiled defaults)

Known flags are enumerated in a compiled **registry** (`FlagRegistry`) so that a flag
with **no row** resolves to a well-defined compiled default rather than an error, and
`GET /api/admin/features` can list every known flag even before any row exists. Each
registry entry has `key`, `description`, and `default_enabled`. The table is seeded
empty; the registry is the source of truth for "what flags exist" and their fallback.

## Resolution precedence (the core invariant)

`is_feature_enabled(pool, flag_key, account_id)`:

1. If `account_id` is `Some` and a row `(flag_key, account_id)` exists → its `enabled`.
2. Else if a **global** row `(flag_key, NULL)` exists → its `enabled`.
3. Else → the registry's `default_enabled` for `flag_key` (compiled default); an
   unknown flag not in the registry resolves to `false` (fail-closed), never an error.

On a DB **error** at any layer the guard fails **closed** (returns `false`), rather than
falling through to a more-permissive layer — a transient error must never bypass an
explicit per-account deny by serving a possibly-`true` global default. Only a genuine
absence of a row (not an error) falls through. This preserves "a flag check never breaks
a request" while never granting a feature on error.

A per-account override MUST NOT change the global default, and setting the global
default MUST NOT change any per-account override (independent rows).

## Non-negotiables (invariants)

- **INV-1**: `is_feature_enabled` resolves **per-account override → global default →
  compiled default** — all three layers, in that precedence order.
- **INV-2**: a flag with **no row** returns the **compiled default**, never an error.
- **INV-3**: setting a **per-account** flag does not change the **global** default, and
  setting the **global** default does not change any **per-account** override.
- **INV-4**: the admin endpoints are gated — an admin may list and set flags (global +
  per-account); a **non-admin** gets **401** (unauthenticated) / **403** (authenticated
  without `features::manage`) on every route.
- **INV-5**: the `UNIQUE (flag_key, account_id)` constraint prevents duplicate
  `(flag, account)` rows (a second write to the same pair UPDATES, never inserts a
  duplicate).

## Permission

`features::manage` — admin-only, held via the Administrators group `*` wildcard /
`is_admin` short-circuit (like `admin::accounts` / `jobs::settings::manage`). NOT
granted to the Users group by any migration.

## API shape (mirrors jobs/sandbox settings routes)

- `GET /api/admin/features[?account_id=<uuid>]` → `{ flags: [{ flag_key, description,
  default_enabled, global_enabled: bool|null, account_enabled: bool|null, effective:
  bool }], account_id: uuid|null }`. `effective` is the resolved value for the given
  `account_id` (or the global effective value when `account_id` absent).
- `PUT /api/admin/features/{flag_key}` body `{ enabled: bool, account_id?: uuid }` →
  upserts the `(flag_key, account_id-or-NULL)` row and returns the updated flag view.
  A `flag_key` not in the registry → 404 (`UNKNOWN_FLAG`); a non-existent `account_id`
  → 404 (FK / existence check).

## Scope

Backend subsystem + one demonstration consumer of the helper. Retrofitting every
module to consult flags is explicitly OUT of scope (the helper + a demonstration is the
deliverable). The frontend Flags page is #48, out of scope here (generated FE types
via `just openapi-regen` are in scope so #48 can bind).
