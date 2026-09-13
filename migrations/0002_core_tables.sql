-- 0002: core owner-scoped tables (CORE-03, ADR 0003).
-- Every table carries owner_id and repositories filter on it by construction.
-- Provenance columns (canonical/original URL, content hash, fetched/published
-- times) are stored before any merge or synthesis.
CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  canonical_url TEXT NOT NULL,
  original_url TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  published_at TEXT,
  published_origin TEXT CHECK (published_origin IN ('page-metadata','provider','domain-policy','user')),
  title TEXT,
  raw_mime TEXT,
  raw_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_documents_owner ON documents(owner_id, canonical_url);

CREATE TABLE passages (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  document_id TEXT NOT NULL REFERENCES documents(id),
  heading TEXT,
  excerpt TEXT NOT NULL,
  extraction_status TEXT NOT NULL CHECK (extraction_status IN ('ok','partial','failed')),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_passages_owner ON passages(owner_id, document_id);

CREATE TABLE requests (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  mode TEXT NOT NULL CHECK (mode IN ('search','answer')),
  question TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','completed','failed')),
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_requests_owner ON requests(owner_id, status);

CREATE TABLE answers (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  request_id TEXT NOT NULL REFERENCES requests(id),
  blocks_json TEXT NOT NULL,
  evidence_only INTEGER NOT NULL,
  cache_key TEXT,
  usage_input_tokens INTEGER,
  usage_output_tokens INTEGER,
  usage_model TEXT,
  usage_estimated INTEGER,
  prompt_revision TEXT NOT NULL DEFAULT 'p0',
  policy_revision TEXT NOT NULL DEFAULT 'p0',
  model_revision TEXT NOT NULL DEFAULT 'm0',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_answers_owner_cache ON answers(owner_id, cache_key);

CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  answer_id TEXT NOT NULL REFERENCES answers(id),
  rating TEXT NOT NULL CHECK (rating IN ('up','down','report')),
  comment TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_feedback_answer ON feedback(owner_id, answer_id);

CREATE TABLE episodes (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  question TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL CHECK (outcome IN ('completed','denied','failed','timeout')),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_episodes_owner ON episodes(owner_id, created_at);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','leased','done','dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_jobs_status ON jobs(status, lease_until);

CREATE TABLE usage_ledger (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  request_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('reservation','settlement')),
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  search_calls INTEGER NOT NULL DEFAULT 0,
  fetches INTEGER NOT NULL DEFAULT 0,
  day TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open','settled','expired')),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_usage_owner_day ON usage_ledger(owner_id, day);
