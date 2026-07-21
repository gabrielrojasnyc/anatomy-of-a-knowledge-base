CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE embeddings (
  id            bigserial PRIMARY KEY,
  source        text NOT NULL,
  source_id     text NOT NULL,
  kind          text NOT NULL,
  title         text,
  content       text NOT NULL,
  raw           jsonb,
  metadata      jsonb NOT NULL DEFAULT '{}',
  authored_at   timestamptz,
  content_hash  text NOT NULL,
  embedding     vector(384),
  tsv           tsvector GENERATED ALWAYS AS
                (to_tsvector('english', coalesce(title,'') || ' ' || content)) STORED,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, source_id)
);

CREATE INDEX embeddings_hnsw ON embeddings
  USING hnsw (embedding vector_cosine_ops);
CREATE INDEX embeddings_tsv ON embeddings USING gin (tsv);
CREATE INDEX embeddings_source ON embeddings (source);

CREATE TABLE sources (
  name         text PRIMARY KEY,
  config       jsonb NOT NULL DEFAULT '{}',
  last_synced  timestamptz
);

CREATE TABLE projects (
  name        text PRIMARY KEY,
  description text NOT NULL DEFAULT ''
);

CREATE TABLE project_sources (
  project text NOT NULL REFERENCES projects(name) ON DELETE CASCADE,
  source  text NOT NULL REFERENCES sources(name) ON DELETE CASCADE,
  PRIMARY KEY (project, source)
);

CREATE TABLE token_idf (
  token text PRIMARY KEY,
  doc_count int NOT NULL,
  idf real NOT NULL
);
