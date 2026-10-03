-- Learning samples are stored with the trade they come from (prediction + outcome), so the learning
-- engine can be rebuilt from the database after every restart.
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS learning JSONB;
ALTER TABLE live_trades ADD COLUMN IF NOT EXISTS learning JSONB;

-- Live ledger baseline for the balance-mismatch breaker (on-chain balance vs recorded results).
CREATE TABLE IF NOT EXISTS balance_checks (
  id                BIGSERIAL PRIMARY KEY,
  ts                TIMESTAMPTZ NOT NULL DEFAULT now(),
  wallet            TEXT NOT NULL,
  onchain_lamports  NUMERIC(30,0) NOT NULL,
  expected_lamports NUMERIC(30,0),
  matched           BOOLEAN NOT NULL,
  note              TEXT
);
CREATE INDEX IF NOT EXISTS balance_checks_ts ON balance_checks (ts DESC);
