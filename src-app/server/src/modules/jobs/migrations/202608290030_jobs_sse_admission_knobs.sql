-- #54 (per-module admin-settings coverage), jobs module — promote the hardcoded SSE +
-- admission-control operational knobs onto the existing `job_settings` singleton so an
-- admin can VIEW + CHANGE them without a code release. These were bare `const`s / an
-- implicit axum default with no admin surface:
--   sse_keep_alive_secs  ← routes.rs   KeepAlive::default()  (axum implicit 15s heartbeat)
--   sse_max_clients      ← runtime.rs  MAX_SSE_CLIENTS       (256; per-job SSE OOM guard)
--   admission_wait_secs  ← admission.rs ADMISSION_WAIT        (15s detached-admit budget)
--   admission_poll_ms    ← admission.rs ADMISSION_POLL        (250ms admit poll interval)
-- Plus `updated_by` — the audit column stamped from the acting admin on every PUT (mirrors
-- #41 billing INV-4; the established `*_by` audit idiom).
--
-- Defaults EXACTLY equal the compiled constants so a deployment that never PUTs is
-- byte-identical to today (read-at-use falls back to the same numbers on any DB error).
-- Bounds are enforced twice — a DB CHECK here AND the Rust `validate_*` (a typed 422 before
-- the write) — mirroring the existing `job_settings_*_check` + `billing_settings_*_bounds`
-- idioms. The bounds are guardrails: an admin must not be able to set a HANG
-- (admission_wait) or an OOM (sse_max_clients) — see DECISIONS.md DEC-3.
--
-- jobs is a NON-saas module compiled in both profiles; a migration cannot be cfg-gated, so
-- this plain .sql applies in both builds (as 202608280020 does for billing).

ALTER TABLE public.job_settings
    ADD COLUMN IF NOT EXISTS sse_keep_alive_secs bigint  NOT NULL DEFAULT 15,
    ADD COLUMN IF NOT EXISTS sse_max_clients     integer NOT NULL DEFAULT 256,
    ADD COLUMN IF NOT EXISTS admission_wait_secs bigint  NOT NULL DEFAULT 15,
    ADD COLUMN IF NOT EXISTS admission_poll_ms   bigint  NOT NULL DEFAULT 250,
    ADD COLUMN IF NOT EXISTS updated_by          uuid;

ALTER TABLE public.job_settings
    -- SSE heartbeat: 1..=300 s. 0 disables the heartbeat (proxies drop the idle stream);
    -- >300 s exceeds common proxy idle timeouts and silently breaks streaming.
    DROP CONSTRAINT IF EXISTS job_settings_sse_keep_alive_bounds,
    ADD  CONSTRAINT job_settings_sse_keep_alive_bounds
         CHECK (sse_keep_alive_secs BETWEEN 1 AND 300),
    -- SSE subscriber cap (OOM guard): 1..=4096 (16× the 256 default, still bounded).
    DROP CONSTRAINT IF EXISTS job_settings_sse_max_clients_bounds,
    ADD  CONSTRAINT job_settings_sse_max_clients_bounds
         CHECK (sse_max_clients BETWEEN 1 AND 4096),
    -- Detached-admit wait budget: 1..=60 s (the module's own invariant: a longer wait is a
    -- hang wearing a queue's clothes).
    DROP CONSTRAINT IF EXISTS job_settings_admission_wait_bounds,
    ADD  CONSTRAINT job_settings_admission_wait_bounds
         CHECK (admission_wait_secs BETWEEN 1 AND 60),
    -- Admit poll interval: 10..=10000 ms AND strictly less than the wait budget, so at
    -- least two attempts fit inside the budget (admission.rs invariant).
    DROP CONSTRAINT IF EXISTS job_settings_admission_poll_bounds,
    ADD  CONSTRAINT job_settings_admission_poll_bounds
         CHECK (admission_poll_ms BETWEEN 10 AND 10000
                AND admission_poll_ms < admission_wait_secs * 1000);
