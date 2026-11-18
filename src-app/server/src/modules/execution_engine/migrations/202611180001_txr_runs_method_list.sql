-- execution_engine module — the method list a run took at its start.
--   `method_list_sequence` — the `sequence` of the signed method list
--     (`method_list`) the run's plans, facts and images came from. A run takes
--     ONE snapshot of the current list at its start and keeps it to the end,
--     so this is the list of every method row of the run.
-- Nullable: rows from before this migration, and rows not made by a run
-- start (seeded or replayed ones), read as "not recorded". Nothing is
-- back-filled.

ALTER TABLE txr_runs ADD COLUMN method_list_sequence INTEGER;
