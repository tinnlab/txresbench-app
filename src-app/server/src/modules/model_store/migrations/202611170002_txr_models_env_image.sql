-- model_store module — what a saved model records about the environment
-- image it was trained in, beside the two file hashes (`env_base_digest` /
-- `env_layer_digest`): the environment's method version, the chip type
-- (amd64 | arm64) and the two files' publish tags. A reuse binds the two
-- recorded files (a model always runs in the image it was trained in); these
-- facts name it in the model details and let a record of the other chip type
-- be refused before any download. Copied from the training run's method row
-- at save, and from the `.txr` header's `env` at import.
--
-- All nullable: models saved before this migration, imported files from an
-- older app, and pretrained records without them read as "not recorded".
-- Nothing is back-filled.

ALTER TABLE txr_models ADD COLUMN env_method_version TEXT;
ALTER TABLE txr_models ADD COLUMN env_arch TEXT;
ALTER TABLE txr_models ADD COLUMN env_layer_tag TEXT;
ALTER TABLE txr_models ADD COLUMN env_base_tag TEXT;
