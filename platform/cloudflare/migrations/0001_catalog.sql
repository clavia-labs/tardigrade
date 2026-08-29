CREATE TABLE catalog_sources (
  source_url TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  revision TEXT NOT NULL,
  refreshed_at REAL NOT NULL,
  active_generation TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE catalog_providers (
  source_url TEXT NOT NULL,
  generation TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  provider_id TEXT NOT NULL,
  name TEXT NOT NULL,
  api TEXT,
  npm TEXT,
  env_json TEXT NOT NULL,
  PRIMARY KEY (source_url, generation, provider_id)
) WITHOUT ROWID;

CREATE INDEX catalog_providers_order ON catalog_providers (source_url, generation, ordinal);

CREATE TABLE catalog_models (
  source_url TEXT NOT NULL,
  generation TEXT NOT NULL,
  provider_ordinal INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  name TEXT,
  metadata_json TEXT NOT NULL,
  PRIMARY KEY (source_url, generation, provider_id, model_id)
) WITHOUT ROWID;

CREATE INDEX catalog_models_order ON catalog_models (source_url, generation, provider_ordinal, ordinal);
