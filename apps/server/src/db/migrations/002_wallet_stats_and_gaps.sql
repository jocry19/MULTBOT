-- Additive wallet statistics (merged with ON CONFLICT … + EXCLUDED), creator dump tracking and
-- ingest gap bookkeeping (periods with incomplete data are excluded from research).

ALTER TABLE wallets
  ADD COLUMN sum_return      DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN sum_return_sq   DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN sum_hold_sec    DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN sum_entry_sol   DOUBLE PRECISION NOT NULL DEFAULT 0;

ALTER TABLE creators
  ADD COLUMN quick_dumps INTEGER NOT NULL DEFAULT 0;

CREATE TABLE data_gaps (
  id          BIGSERIAL PRIMARY KEY,
  source      TEXT NOT NULL,            -- e.g. ws:pump
  gap_start   TIMESTAMPTZ NOT NULL,
  gap_end     TIMESTAMPTZ NOT NULL,
  reason      TEXT NOT NULL,
  backfilled  BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX data_gaps_range_idx ON data_gaps (gap_start, gap_end);
