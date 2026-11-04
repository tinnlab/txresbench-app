-- execution_engine module — `txr_runs.estimate`: the run's estimate facts
-- (PROV-MC-6's response shape stored on the run — CONS-EE-9b, ITEM-9's
-- "estimate store").
--
-- The original four migrations spell no estimate column while PROV-EE-3's run
-- detail carries `estimate {total_seconds, schedule_seconds,
-- estimate_quality}` (the F header's "about 7 minutes left" source). The
-- field lands as an ADDITIVE nullable TEXT JSON column (the
-- applied-files-immutable rule; migration `0005` is the same growth on
-- `txr_run_methods`). NULL = the estimate was never computed (a legacy row or
-- the create-time compute failed — the estimate is a display fact, never a
-- run failure).

ALTER TABLE txr_runs ADD COLUMN estimate TEXT;
