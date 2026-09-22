-- Question log, doubling as the rate limiter.
--
-- Decision 7 identified a public URL with an LLM behind it as an unbounded
-- cost surface, and noted that a rate limit is cost control rather than
-- authentication. With a hard $20 monthly cap that stops being a nicety.
--
-- Database-backed rather than in-memory because the deployment target is
-- serverless: an in-process Map resets on every cold start, so it would limit
-- a warm instance and wave through everything else -- worse than useless,
-- because it would look like protection.
--
-- The same rows carry measured spend per question, so cost is observed rather
-- than inferred from the Console after the fact.
CREATE TABLE IF NOT EXISTS ask_log (
  ask_id            bigserial PRIMARY KEY,
  asked_at          timestamptz NOT NULL DEFAULT now(),
  -- Hashed, not stored raw: rate limiting needs to tell callers apart, not
  -- identify them, and the brief puts identity management out of scope.
  client_hash       text        NOT NULL,
  question          text        NOT NULL,
  model             text,
  ok                boolean     NOT NULL DEFAULT false,
  refused           boolean     NOT NULL DEFAULT false,
  tool_calls        integer,
  claim_count       integer,
  citation_count    integer,
  compose_attempts  integer,
  elapsed_ms        integer,
  input_tokens      integer,
  output_tokens     integer,
  cache_read_tokens integer,
  cost_usd          numeric(10, 6),
  error             text
);

-- The rate-limit lookup: recent rows for one caller.
CREATE INDEX IF NOT EXISTS ix_ask_log_client_time ON ask_log (client_hash, asked_at DESC);
-- The spend lookup: everything in a window, regardless of caller.
CREATE INDEX IF NOT EXISTS ix_ask_log_time ON ask_log (asked_at DESC);
