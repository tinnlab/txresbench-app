-- model_store module — `txr_models.conversions`: the risk→probability
-- conversions a saved model carries from its training run (the package's
-- `model.conversions`, contract 2.0 `model.schema.json`): a JSON object, key
-- = the outcome or `outcome@horizon`, value = `{kind, a, b, mu, sd, n, rate}`.
-- The save flow copies the training run's `output/<method>/conversions.json`;
-- a `.txr` import copies the header's `conversions`; resolve hands the map to
-- the engine, which applies it in a predict-only reuse run.
--
-- `'{}'` = no conversion saved: every row saved before this column (the
-- reuse then reports no chances with a note saying so), and models of methods
-- that write their own probability.

ALTER TABLE txr_models ADD COLUMN conversions TEXT NOT NULL DEFAULT '{}';
