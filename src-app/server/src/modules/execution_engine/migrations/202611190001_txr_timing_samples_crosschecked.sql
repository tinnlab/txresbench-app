-- execution_engine module — the calibration sample's cross-check marker
-- (crosschecked-chances): a TRAIN-mode method that learns is now fitted
-- three more times to check its chances, so a run measured after this change
-- carries ~3x the old one-fit cost in `measured_ms`.
--
-- `crosschecked = 1` tags exactly those samples (the engine writes the flag
-- from the method's own facts: `fitted` on the catalogue row). The rows
-- written before this migration (and every row the old code writes) default
-- to 0 — they measure the old cost and a train-mode median for a method that
-- learns must not mix them in. They are NEVER deleted (this table is the
-- estimate's memory; deleting would lose the evidence the absent/reuse-mode
-- numbers still use), only ignored by that one selector.
--
-- The estimate engine never multiplies a tagged sample: the folds it
-- measured are already in the seconds (the sample is the real total, not a
-- reference base).

ALTER TABLE txr_timing_samples ADD COLUMN crosschecked INTEGER NOT NULL DEFAULT 0;
