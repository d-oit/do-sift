-- 0013: synthesis call log (issue #123, plan 038 — EXT-03).
-- Every billable synthesis call leaves one append-only row: which provider and
-- model answered, what the call actually cost at the verified price, and how
-- the usage was measured (provider-reported or estimated).
--
-- Why a separate table: `usage_ledger` is an accounting primitive with a
-- reservation/settlement lifecycle and daily caps; this is an audit trail for
-- "what did we call, with what, and for how much". Widening the ledger would
-- make an aggregate answer questions it cannot (which model, at which price),
-- and would make the settlement row's token counts ambiguous between
-- reservation maxima and actuals.
--
-- Rows are append-only. `tenant_id` is denormalized from the caller's runtime
-- binding and written in the same statement as the rest, so a row can never be
-- filed under a tenant the caller was not scoped to.
CREATE TABLE synthesis_calls (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  owner_id TEXT NOT NULL,
  request_id TEXT,
  answer_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  -- Provider-reported (`0`) or locally estimated (`1`) token counts.
  estimated INTEGER NOT NULL CHECK (estimated IN (0, 1)),
  input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  -- Micro-USD integers: money is never a float in the database.
  input_cost_micro_usd INTEGER NOT NULL CHECK (input_cost_micro_usd >= 0),
  output_cost_micro_usd INTEGER NOT NULL CHECK (output_cost_micro_usd >= 0),
  total_cost_micro_usd INTEGER NOT NULL CHECK (total_cost_micro_usd >= 0),
  -- The pricing revision the cost was computed from, so a price change is
  -- visible in history instead of silently rewriting past costs.
  price_input_per_1m_micro_usd INTEGER NOT NULL CHECK (price_input_per_1m_micro_usd >= 0),
  price_output_per_1m_micro_usd INTEGER NOT NULL CHECK (price_output_per_1m_micro_usd >= 0),
  -- What happened: a completed call, or a call that failed (no usage/cost).
  outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'failed')),
  failure_kind TEXT CHECK (failure_kind IS NULL OR failure_kind IN ('rate-limited', 'timeout', 'http', 'aborted', 'unknown')),
  created_at TEXT NOT NULL,
  created_day TEXT NOT NULL
);

CREATE INDEX idx_synthesis_calls_tenant_owner_day
  ON synthesis_calls(tenant_id, owner_id, created_day DESC, id DESC);
CREATE INDEX idx_synthesis_calls_request ON synthesis_calls(tenant_id, request_id);
