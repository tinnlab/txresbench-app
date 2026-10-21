-- Object-store data MIGRATION state (#61 §2) — persists a copy+verify migration so it
-- survives a restart and is resumable, and so the admin surface can show live progress +
-- the verify status + the confirm-before-retire step.
--
-- DATA-SAFETY note: this table records the STATE of a migration; it never itself moves or
-- deletes a blob. The engine (`migration_engine.rs`) only ever COPIES source→dest and
-- content-hash-VERIFIES; the SOURCE is deleted only by the separate, explicitly-confirmed
-- retire step, and only after a full re-verify proves every source blob is safe in dest.
--
-- `phase` lifecycle (never skips backwards into a terminal state silently):
--   pending    — created (a switch or a manual start); may await a cost_ack (cross-cloud).
--   copying    — the background copy+verify pass is running.
--   verifying  — a final full re-verify pass (retire pre-check) is running.
--   verified   — every blob copied AND content-verified in the destination; cutover is safe,
--                the source is retained (dual-read fallback) until an explicit retire.
--   failed     — a content-hash mismatch (or IO error) halted the move; stay on the old
--                store (auto-rollback). `verify_error` carries a fixed-vocabulary category.
--   retired    — the operator explicitly confirmed retirement; the source has been released.
--
-- pgcrypto (gen_random_uuid) is already enabled by 202608290080. Applied in BOTH build
-- profiles (a migration cannot be cfg-gated); only the ROUTES that read/write it are
-- saas-gated.

CREATE TABLE IF NOT EXISTS public.object_store_migration (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The two ends (non-secret descriptors, for display + the estimate/cost-gate).
    src_backend    text NOT NULL,               -- 'local' | 's3'
    src_provider   text,                         -- 's3' | 'gcs' | NULL (local)
    src_bucket     text,
    dst_backend    text NOT NULL,
    dst_provider   text,
    dst_bucket     text,
    -- Lifecycle.
    phase          text NOT NULL DEFAULT 'pending'
                     CHECK (phase IN ('pending','copying','verifying','verified','failed','retired')),
    -- Progress (bounded counters, not a per-blob list).
    blobs_total    bigint NOT NULL DEFAULT 0,
    blobs_done     bigint NOT NULL DEFAULT 0,
    bytes_total    bigint NOT NULL DEFAULT 0,
    bytes_done     bigint NOT NULL DEFAULT 0,
    -- Cost-gate (INV-7): a large cross-cloud move requires an explicit operator go-ahead.
    cross_cloud    boolean NOT NULL DEFAULT false,
    cost_ack       boolean NOT NULL DEFAULT false,
    -- A fixed-vocabulary failure category (NEVER a raw error / credential).
    verify_error   text,
    -- Whether this migration was started automatically (a config switch) or manually.
    auto_started   boolean NOT NULL DEFAULT false,
    -- Audit.
    created_by     uuid,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

-- At most ONE RUNNING migration at a time — a second start cannot race a copy in flight.
-- `verified` is NOT counted as running: it is a completed copy awaiting the operator's manual
-- retire of the old store, so it must not block a fresh migration indefinitely. `failed`/
-- `retired` are unconstrained history.
CREATE UNIQUE INDEX IF NOT EXISTS object_store_migration_one_active
    ON public.object_store_migration ((true))
    WHERE phase IN ('pending','copying','verifying');

-- Newest-first lookup for "the current migration" the status endpoint shows.
CREATE INDEX IF NOT EXISTS object_store_migration_created_at_idx
    ON public.object_store_migration (created_at DESC);
