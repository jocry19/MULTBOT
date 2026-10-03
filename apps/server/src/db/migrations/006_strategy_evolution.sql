-- Strategy evolution: a version can run as a paper "challenger" next to the strategy's current version.
ALTER TABLE strategy_versions ADD COLUMN IF NOT EXISTS challenger_since TIMESTAMPTZ;
-- promoted | retired | recommended (outperformed a live-enabled version; waits for the user)
ALTER TABLE strategy_versions ADD COLUMN IF NOT EXISTS challenger_outcome TEXT;
ALTER TABLE strategy_versions ADD COLUMN IF NOT EXISTS challenger_reason TEXT;
CREATE INDEX IF NOT EXISTS strategy_versions_challengers ON strategy_versions (strategy_id) WHERE challenger_since IS NOT NULL;

CREATE TABLE IF NOT EXISTS evolution_runs (
  id            BIGSERIAL PRIMARY KEY,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  status        TEXT NOT NULL,          -- running | done | failed | insufficient_data
  dataset       JSONB NOT NULL DEFAULT '{}'::jsonb,
  examined      INTEGER NOT NULL DEFAULT 0,
  proposed      INTEGER NOT NULL DEFAULT 0,
  summary       JSONB NOT NULL DEFAULT '{}'::jsonb,
  error         TEXT
);
