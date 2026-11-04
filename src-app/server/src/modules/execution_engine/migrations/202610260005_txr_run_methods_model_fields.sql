-- execution_engine module — the produced-model fields of `txr_run_methods`
-- (the reconcile growth GAP-B/GAP-C of PROV-EE-3's `TxrProducedModel`,
-- recorded by this node's DRIFT-1 ITEM-7 #1): a method row becomes a produced
-- model record when ITEM-9's finalize writes `model_out_digest` + `model_dir`
-- (X1's `/model` tree) and adds
--   `size_bytes` — the produced tree's byte size from the SAME walk that
--   computed `model_out_digest` (model-store DEC-7: the engine computes it);
--   `trained_on_patients` — the training cohort the model was fit on;
--   `own_auc` — the run's own-data cross-check AUC computed at finalize over
--   the run's predictions vs the training outcome (null when the outcome or
--   the data does not allow it).
-- All three are nullable on purpose: a method row carries them only from
-- finalize on, and the `produced_models` seam exposes a row as a produced
-- model only when the record is COMPLETE (digest + dir + both env digests +
-- `trained_on_patients` + `size_bytes`), so a half-written record from an
-- interrupted finalize is never presented as a saved artifact.

ALTER TABLE txr_run_methods ADD COLUMN trained_on_patients INTEGER;
ALTER TABLE txr_run_methods ADD COLUMN size_bytes INTEGER;
ALTER TABLE txr_run_methods ADD COLUMN own_auc REAL;
