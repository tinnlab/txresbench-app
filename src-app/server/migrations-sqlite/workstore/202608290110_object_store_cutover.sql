-- Live hot-cutover state (#64) — extends the #61 `object_store_migration`
-- table so a LIVE, no-restart cutover of the process-global object-store
-- handle is recorded and survives a restart — SQLite dialect port (ITEM-9,
-- sqlite-store) of
-- `src/modules/workstore/migrations/202608290110_object_store_cutover.sql`.
--
-- #61 applied cutover only at the boot/construction seam; this column
-- records that a migration was ALSO activated live (the handle swapped to
-- DualRead(new, old) without a restart), so the boot path can re-establish
-- the correct primary after a process restart. DATA-SAFETY note (unchanged):
-- this column records STATE only; it never moves or deletes a blob. The old
-- store is retained as the dual-read fallback + rollback target and is
-- deleted ONLY by the separate, explicitly-confirmed manual retire step
-- (INV-5), never automatically.
--
-- SQLite port notes (ITEM-9, DEC-8 type map): `boolean` -> INTEGER 0/1
-- (the `cutover … DEFAULT false` port is `DEFAULT 0`; the partial-index
-- predicate `cutover = true` becomes `cutover = 1`); the
-- `ADD COLUMN IF NOT EXISTS` softener is dropped (partial re-runs cannot
-- exist — the ITEM-8 convention); no `public.` prefix.

ALTER TABLE object_store_migration
    -- TRUE once the live cutover has been applied for this migration (the
    -- handle was swapped to DualRead(new, old) with no restart). Only ever
    -- set on a `verified` migration (the activation guard, INV-3). Boot
    -- re-establishes DualRead for the latest verified+cutover row.
    ADD COLUMN cutover INTEGER NOT NULL DEFAULT 0;

-- Fast "the migration to re-establish at boot" lookup: the newest verified
-- row that was cut over live but not yet retired.
CREATE INDEX IF NOT EXISTS object_store_migration_cutover_idx
    ON object_store_migration (created_at DESC)
    WHERE phase = 'verified' AND cutover = 1;
