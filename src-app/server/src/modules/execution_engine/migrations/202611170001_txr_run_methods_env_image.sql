-- execution_engine module — what a method row records about its environment
-- image beyond the two file hashes (`env_base_digest` / `env_layer_digest`):
--   `env_method_version` — the environment's method version (the method
--     list entry's, which can differ from the catalogue's `version`);
--   `env_arch` — the chip type the image is built for (amd64 | arm64);
--   `env_layer_tag` / `env_base_tag` — the immutable publish tags of the two
--     files, when the list named them.
-- Written at the running patch from the plan's image (a reuse run: the saved
-- model's own image). All nullable: rows from before this migration, and an
-- image the list did not name, read as "not recorded". Nothing is
-- back-filled.

ALTER TABLE txr_run_methods ADD COLUMN env_method_version TEXT;
ALTER TABLE txr_run_methods ADD COLUMN env_arch TEXT;
ALTER TABLE txr_run_methods ADD COLUMN env_layer_tag TEXT;
ALTER TABLE txr_run_methods ADD COLUMN env_base_tag TEXT;
