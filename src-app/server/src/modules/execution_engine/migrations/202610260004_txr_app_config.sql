-- execution_engine module — `txr_app_config`: the sticky E-screen analysis
-- configuration singleton (PROV-EE-8, single row id = 1). `config` is TEXT
-- JSON carrying the serialized `TxrAppConfig` — the last-used `RunConfig` and
-- the last input summary (patients / predict patients / markers counts) so
-- "Start → … → E" restores the last-used settings without re-parsing files.
-- `config` is NULL before the first PUT (the GET then answers
-- `config: null, last_input_summary: null` — an honest "never configured"
-- value). The row is upserted, never deleted.

CREATE TABLE txr_app_config (
    id INTEGER NOT NULL,
    config TEXT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT txr_app_config_singleton CHECK (id = 1),
    CONSTRAINT txr_app_config_pkey PRIMARY KEY (id)
);
