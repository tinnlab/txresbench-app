-- Abandon a verified object-store migration (#65) — add the `abandoned` terminal phase.
--
-- THE GAP (#65): once an auto (config-switch) migration reaches `verified`, a subsequent
-- `PUT /admin/infra/object-store` to revert to the old store is refused 409 ("migration not yet
-- retired"), because `migration_repo::latest_unretired` returns every un-retired auto migration and
-- the config-change guard blocks while one exists. `failed` is deliberately INCLUDED in
-- `latest_unretired` (a genuine copy-failure's config already advanced to NEW while OLD still holds
-- data, so it MUST keep the dual-read fallback), so `failed` cannot mark an abandon; and `retired`
-- means "re-proved NEW ⊇ OLD and released OLD" — the opposite of abandon. So abandon needs its OWN
-- terminal phase that `latest_unretired` EXCLUDES (clearing the 409 + stopping boot-resume) without
-- corrupting the genuine-failure or retired semantics.
--
-- `abandoned` — the operator abandoned a verified migration and reverted the primary to the intact
--               OLD store (an atomic `swap_object_store` back to old). `verify_error` carries a
--               fixed-vocabulary reason. NO blob is deleted on this path (the old store was never
--               deleted; the new store's copy is left in place); it simply returns the primary to
--               the intact old store. Excluded from `latest_unretired` so the store is reconfigurable.
--
-- DATA-SAFETY note: this only WIDENS the phase CHECK to accept a new value; it changes no existing
-- row and deletes nothing. Backward-compatible (every existing phase still satisfies the new
-- constraint). The boot reaper (`copying`/`verifying` only) and the single-active partial index
-- (`pending`/`copying`/`verifying`) are unaffected by the new terminal value. Applied in BOTH build
-- profiles (a migration cannot be cfg-gated); only the saas routes/orchestrator that write it are
-- saas-gated (cargo flag). Idempotent.

ALTER TABLE public.object_store_migration
    DROP CONSTRAINT IF EXISTS object_store_migration_phase_check;

ALTER TABLE public.object_store_migration
    ADD CONSTRAINT object_store_migration_phase_check
    CHECK (phase IN ('pending','copying','verifying','verified','failed','retired','abandoned'));
