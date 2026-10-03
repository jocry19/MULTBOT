-- SOLARBITER schema. Money amounts on-chain are NUMERIC raw integers (lamports / token base units).
-- Auditability: trades, execution attempts, transactions, risk events, strategy versions/parameters
-- and the tax ledger can never be deleted; tax rows and strategy parameters can never be changed.

-- ---------------------------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION forbid_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'rows of % are append-only (delete forbidden)', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'rows of % are immutable', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Creates the daily partition of a range-partitioned table (idempotent).
CREATE OR REPLACE FUNCTION ensure_daily_partition(parent TEXT, day DATE) RETURNS VOID AS $$
DECLARE
  part TEXT := parent || '_' || to_char(day, 'YYYYMMDD');
BEGIN
  IF to_regclass(part) IS NULL THEN
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
      part, parent, to_char(day, 'YYYY-MM-DD') || ' 00:00:00+00', to_char(day + 1, 'YYYY-MM-DD') || ' 00:00:00+00'
    );
  END IF;
EXCEPTION WHEN duplicate_table THEN
  NULL; -- concurrent creation
END;
$$ LANGUAGE plpgsql;

-- Drops whole day partitions older than a cutoff (retention without table bloat).
CREATE OR REPLACE FUNCTION drop_daily_partitions_before(parent TEXT, cutoff DATE) RETURNS INTEGER AS $$
DECLARE
  r RECORD;
  dropped INTEGER := 0;
  suffix TEXT;
BEGIN
  FOR r IN
    SELECT c.relname FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.relname = parent
  LOOP
    suffix := right(r.relname, 8);
    IF suffix ~ '^\d{8}$' AND to_date(suffix, 'YYYYMMDD') < cutoff THEN
      EXECUTE format('DROP TABLE IF EXISTS %I', r.relname);
      dropped := dropped + 1;
    END IF;
  END LOOP;
  RETURN dropped;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------
-- users, sessions, settings, system state
-- ---------------------------------------------------------------------------------------------
CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,             -- scrypt$N$r$p$salt$hash
  role          TEXT NOT NULL DEFAULT 'admin',
  disabled      BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,             -- SHA-256 of the session token; the token itself is never stored
  user_id     BIGINT NOT NULL REFERENCES users (id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  ip          TEXT,
  user_agent  TEXT
);
CREATE INDEX sessions_expires ON sessions (expires_at);

CREATE TABLE settings (
  id          INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT NOT NULL DEFAULT 'system'
);

CREATE TABLE settings_audit (
  id          BIGSERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor       TEXT NOT NULL,
  old_value   JSONB,
  new_value   JSONB NOT NULL
);
CREATE TRIGGER settings_audit_immutable BEFORE UPDATE OR DELETE ON settings_audit FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- bot state, live gate, emergency stop, breakers, live level … (source of truth for control)
CREATE TABLE system_state (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- structured decision / system log (what the dashboard "Logs" page shows)
CREATE TABLE system_events (
  id          BIGSERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  level       TEXT NOT NULL,                -- debug | info | success | warning | error | critical
  category    TEXT NOT NULL,
  message     TEXT NOT NULL,
  data        JSONB
);
CREATE INDEX system_events_ts ON system_events (ts DESC);
CREATE INDEX system_events_category ON system_events (category, ts DESC);

CREATE TABLE notifications (
  id          BIGSERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  type        TEXT NOT NULL,
  severity    TEXT NOT NULL,
  title       TEXT NOT NULL,
  message     TEXT NOT NULL,
  data        JSONB,
  read        BOOLEAN NOT NULL DEFAULT false,
  webhook_delivered BOOLEAN
);
CREATE INDEX notifications_ts ON notifications (ts DESC);

-- ---------------------------------------------------------------------------------------------
-- wallets, tokens, pools, watchlist
-- ---------------------------------------------------------------------------------------------
CREATE TABLE wallets (
  address               TEXT PRIMARY KEY,
  label                 TEXT NOT NULL DEFAULT 'bot',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_balance_lamports NUMERIC(30,0),
  last_balance_at       TIMESTAMPTZ,
  token_balances        JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE tokens (
  mint             TEXT PRIMARY KEY,
  symbol           TEXT NOT NULL,
  name             TEXT NOT NULL DEFAULT '',
  decimals         SMALLINT NOT NULL,
  program          TEXT,
  mint_authority   TEXT,
  freeze_authority TEXT,
  allowlisted      BOOLEAN NOT NULL DEFAULT false,
  denylisted       BOOLEAN NOT NULL DEFAULT false,
  safe             BOOLEAN NOT NULL DEFAULT false,
  safety_reasons   JSONB NOT NULL DEFAULT '[]'::jsonb,
  checked_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER tokens_touch BEFORE UPDATE ON tokens FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE pools (
  address      TEXT PRIMARY KEY,
  dex          TEXT NOT NULL,
  kind         TEXT NOT NULL,
  program_id   TEXT NOT NULL,
  label        TEXT NOT NULL,
  mint_a       TEXT NOT NULL,
  mint_b       TEXT NOT NULL,
  decimals_a   SMALLINT NOT NULL,
  decimals_b   SMALLINT NOT NULL,
  vault_a      TEXT,
  vault_b      TEXT,
  fee_rate     DOUBLE PRECISION NOT NULL,
  tvl_usd      DOUBLE PRECISION NOT NULL DEFAULT 0,
  extra        JSONB NOT NULL DEFAULT '{}'::jsonb,
  active       BOOLEAN NOT NULL DEFAULT true,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX pools_mints ON pools (mint_a, mint_b);
CREATE TRIGGER pools_touch BEFORE UPDATE ON pools FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE watchlist (
  id          BIGSERIAL PRIMARY KEY,
  mint        TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (mint)
);

-- ---------------------------------------------------------------------------------------------
-- market data: quotes, fee market, FX
-- ---------------------------------------------------------------------------------------------
CREATE TABLE quotes (
  id              TEXT NOT NULL,
  ts              TIMESTAMPTZ NOT NULL,
  slot            BIGINT,
  kind            TEXT NOT NULL,           -- firm | screen
  source          TEXT NOT NULL,
  input_mint      TEXT NOT NULL,
  output_mint     TEXT NOT NULL,
  input_amount    NUMERIC(40,0) NOT NULL,
  output_amount   NUMERIC(40,0) NOT NULL,
  min_output      NUMERIC(40,0),
  slippage_bps    INTEGER,
  price           DOUBLE PRECISION,
  price_impact    DOUBLE PRECISION,
  fee_rates       JSONB NOT NULL DEFAULT '[]'::jsonb,
  route           JSONB NOT NULL DEFAULT '[]'::jsonb,
  latency_ms      INTEGER,
  opportunity_id  TEXT,
  purpose         TEXT,                     -- ladder | verify | requote | final
  PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);
CREATE INDEX quotes_opportunity ON quotes (opportunity_id);

CREATE TABLE priority_fees (
  id          BIGSERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  slot        BIGINT,
  p25         BIGINT NOT NULL,
  p50         BIGINT NOT NULL,
  p75         BIGINT NOT NULL,
  p90         BIGINT NOT NULL,
  max         BIGINT NOT NULL,
  samples     INTEGER NOT NULL,
  scope       TEXT NOT NULL DEFAULT 'global'   -- micro-lamports per CU
);
CREATE INDEX priority_fees_ts ON priority_fees (ts DESC);

CREATE TABLE fx_rates (
  pair        TEXT NOT NULL,
  ts          TIMESTAMPTZ NOT NULL,
  price       DOUBLE PRECISION NOT NULL,
  source      TEXT NOT NULL,
  PRIMARY KEY (pair, ts)
);

-- ---------------------------------------------------------------------------------------------
-- strategy versions (every result is attributable to exactly one version)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE strategy_versions (
  id               TEXT PRIMARY KEY,          -- strategy_v1, strategy_v2 …
  version          INTEGER NOT NULL UNIQUE,
  parent_id        TEXT REFERENCES strategy_versions (id),
  status           TEXT NOT NULL,             -- candidate | validated | active | retired | rolled_back | rejected
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by       TEXT NOT NULL,             -- seed | optimizer | user
  training_from    TIMESTAMPTZ,
  training_to      TIMESTAMPTZ,
  validation_from  TIMESTAMPTZ,
  validation_to    TIMESTAMPTZ,
  oos_from         TIMESTAMPTZ,
  oos_to           TIMESTAMPTZ,
  performance      JSONB NOT NULL DEFAULT '{}'::jsonb,
  drawdown_eur     DOUBLE PRECISION,
  notes            TEXT,
  activated_at     TIMESTAMPTZ,
  retired_at       TIMESTAMPTZ
);
CREATE TRIGGER strategy_versions_no_delete BEFORE DELETE ON strategy_versions FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TABLE strategy_parameters (
  id                   BIGSERIAL PRIMARY KEY,
  strategy_version_id  TEXT NOT NULL REFERENCES strategy_versions (id),
  key                  TEXT NOT NULL,
  value                JSONB NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (strategy_version_id, key)
);
CREATE TRIGGER strategy_parameters_immutable BEFORE UPDATE OR DELETE ON strategy_parameters FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- opportunities (all of them, including rejected ones) + aggregated screening rejections
-- ---------------------------------------------------------------------------------------------
CREATE TABLE opportunities (
  id                          TEXT NOT NULL,
  ts                          TIMESTAMPTZ NOT NULL,
  slot                        BIGINT,
  mode                        TEXT NOT NULL,
  strategy_type               TEXT NOT NULL,
  strategy_version_id         TEXT,
  route                       JSONB NOT NULL,       -- mint path
  route_dexes                 TEXT[] NOT NULL,
  input_mint                  TEXT NOT NULL,
  output_mint                 TEXT NOT NULL,
  token_mint                  TEXT NOT NULL,
  source_dex                  TEXT NOT NULL,
  destination_dex             TEXT NOT NULL,
  input_amount                NUMERIC(40,0) NOT NULL,
  output_amount               NUMERIC(40,0) NOT NULL,
  size_eur                    DOUBLE PRECISION NOT NULL,
  sol_eur                     DOUBLE PRECISION NOT NULL,
  gross_profit                NUMERIC(40,0) NOT NULL,
  gross_profit_percent        DOUBLE PRECISION NOT NULL,
  dex_fees                    NUMERIC(40,0) NOT NULL,
  network_fee                 NUMERIC(40,0) NOT NULL,
  priority_fee                NUMERIC(40,0) NOT NULL,
  jito_tip                    NUMERIC(40,0) NOT NULL,
  price_impact                DOUBLE PRECISION NOT NULL,
  expected_slippage           NUMERIC(40,0) NOT NULL,
  execution_probability       DOUBLE PRECISION NOT NULL,
  expected_failure_cost       NUMERIC(40,0) NOT NULL,
  safety_buffer               NUMERIC(40,0) NOT NULL,
  expected_net_profit         NUMERIC(40,0) NOT NULL,
  expected_net_profit_percent DOUBLE PRECISION NOT NULL,
  expected_net_profit_eur     DOUBLE PRECISION NOT NULL,
  quote_age_ms                INTEGER NOT NULL,
  latency_estimate_ms         INTEGER NOT NULL,
  atomic                      BOOLEAN NOT NULL,
  status                      TEXT NOT NULL,
  rejection_reason            TEXT,
  rejection_detail            TEXT,
  costs                       JSONB,
  size_ladder                 JSONB NOT NULL DEFAULT '[]'::jsonb,
  decision_log                JSONB NOT NULL DEFAULT '[]'::jsonb,
  legs                        JSONB NOT NULL DEFAULT '[]'::jsonb,
  features                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);
CREATE INDEX opportunities_ts ON opportunities (ts DESC);
CREATE INDEX opportunities_status ON opportunities (status, ts DESC);
CREATE INDEX opportunities_reason ON opportunities (rejection_reason, ts DESC);

-- screening-level rejections are far too many to store one by one; they are counted per minute
CREATE TABLE no_trade_stats (
  bucket          TIMESTAMPTZ NOT NULL,
  reason          TEXT NOT NULL,
  strategy_type   TEXT NOT NULL,
  count           INTEGER NOT NULL,
  PRIMARY KEY (bucket, reason, strategy_type)
);

-- ---------------------------------------------------------------------------------------------
-- execution: paper, live, attempts, transactions, fees, Jito
-- ---------------------------------------------------------------------------------------------
CREATE TABLE paper_trades (
  id                     TEXT PRIMARY KEY,
  opportunity_id         TEXT NOT NULL,
  strategy_version_id    TEXT,
  shadow                 BOOLEAN NOT NULL DEFAULT false,
  ts_detected            TIMESTAMPTZ NOT NULL,
  ts_executed            TIMESTAMPTZ,
  ts_closed              TIMESTAMPTZ,
  latency_ms             INTEGER NOT NULL,
  size_eur               DOUBLE PRECISION NOT NULL,
  sol_eur                DOUBLE PRECISION NOT NULL,
  input_lamports         NUMERIC(40,0) NOT NULL,
  detected_output        NUMERIC(40,0) NOT NULL,     -- output at detection (firm quote)
  expected_output        NUMERIC(40,0) NOT NULL,     -- detection output minus predicted slippage
  min_output             NUMERIC(40,0) NOT NULL,     -- guard enforced by the transaction
  simulated_output       NUMERIC(40,0),              -- output of the re-quote after latency
  slippage_lamports      NUMERIC(40,0),
  fees                   JSONB NOT NULL,             -- base, priority, jito, rent
  predicted_net          NUMERIC(40,0) NOT NULL,
  realized_net           NUMERIC(40,0),
  realized_net_eur       DOUBLE PRECISION,
  success                BOOLEAN,
  failure_reason         TEXT,
  prediction_error_bps   DOUBLE PRECISION,
  route                  JSONB NOT NULL,
  simulation             JSONB,                      -- shadow: real simulateTransaction result
  status                 TEXT NOT NULL,              -- OPEN | CLOSED | FAILED
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX paper_trades_ts ON paper_trades (ts_detected DESC);
CREATE TRIGGER paper_trades_no_delete BEFORE DELETE ON paper_trades FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TABLE live_trades (
  id                     TEXT PRIMARY KEY,
  opportunity_id         TEXT NOT NULL,
  strategy_version_id    TEXT,
  live_level             SMALLINT NOT NULL,
  ts_detected            TIMESTAMPTZ NOT NULL,
  ts_submitted           TIMESTAMPTZ,
  ts_confirmed           TIMESTAMPTZ,
  size_eur               DOUBLE PRECISION NOT NULL,
  sol_eur                DOUBLE PRECISION NOT NULL,
  input_lamports         NUMERIC(40,0) NOT NULL,
  predicted_output       NUMERIC(40,0) NOT NULL,
  min_output             NUMERIC(40,0) NOT NULL,
  sol_delta              NUMERIC(40,0),              -- actual wallet SOL change incl. all fees
  token_dust             JSONB,
  fees                   JSONB NOT NULL DEFAULT '{}'::jsonb,
  predicted_net          NUMERIC(40,0) NOT NULL,
  realized_net           NUMERIC(40,0),
  realized_net_eur       DOUBLE PRECISION,
  prediction_error_bps   DOUBLE PRECISION,
  status                 TEXT NOT NULL,              -- BUILDING | SIMULATED | SUBMITTED | CONFIRMED | FAILED | REJECTED
  failure_reason         TEXT,
  signature              TEXT,
  bundle_id              TEXT,
  via                    TEXT,                       -- jito | rpc
  route                  JSONB NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX live_trades_ts ON live_trades (ts_detected DESC);
CREATE TRIGGER live_trades_touch BEFORE UPDATE ON live_trades FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER live_trades_no_delete BEFORE DELETE ON live_trades FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TABLE execution_attempts (
  id                     TEXT PRIMARY KEY,
  idempotency_key        TEXT NOT NULL UNIQUE,
  mode                   TEXT NOT NULL,
  opportunity_id         TEXT,
  live_trade_id          TEXT REFERENCES live_trades (id),
  paper_trade_id         TEXT REFERENCES paper_trades (id),
  stage                  TEXT NOT NULL,              -- quote | build | simulate | sign | submit | confirm | done
  status                 TEXT NOT NULL,              -- DETECTED | SIMULATED | SUBMITTED | CONFIRMED | FAILED | REJECTED
  via                    TEXT,
  signature              TEXT UNIQUE,
  bundle_id              TEXT,
  last_valid_block_height BIGINT,
  cu_limit               INTEGER,
  cu_price_micro_lamports BIGINT,
  priority_fee_lamports  BIGINT,
  jito_tip_lamports      BIGINT,
  simulation             JSONB,
  checks                 JSONB,
  error                  TEXT,
  slot                   BIGINT,
  submitted_at           TIMESTAMPTZ,
  confirmed_at           TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER execution_attempts_touch BEFORE UPDATE ON execution_attempts FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER execution_attempts_no_delete BEFORE DELETE ON execution_attempts FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TABLE transactions (
  signature          TEXT PRIMARY KEY,
  ts                 TIMESTAMPTZ,
  slot               BIGINT,
  type               TEXT NOT NULL,                  -- arbitrage | deposit | withdrawal | other
  status             TEXT NOT NULL,                  -- Detected | Simulated | Submitted | Confirmed | Failed | Rejected
  wallet             TEXT NOT NULL,
  sol_change_lamports NUMERIC(40,0),
  fee_lamports       NUMERIC(40,0),
  token_changes      JSONB NOT NULL DEFAULT '{}'::jsonb,
  route              JSONB,
  input_desc         TEXT,
  output_desc        TEXT,
  profit_lamports    NUMERIC(40,0),
  live_trade_id      TEXT REFERENCES live_trades (id),
  raw                JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX transactions_ts ON transactions (ts DESC);
CREATE TRIGGER transactions_no_delete BEFORE DELETE ON transactions FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TABLE fees (
  id               BIGSERIAL PRIMARY KEY,
  ts               TIMESTAMPTZ NOT NULL DEFAULT now(),
  mode             TEXT NOT NULL,
  kind             TEXT NOT NULL,                    -- base | priority | jito | dex | rent_locked
  amount_lamports  NUMERIC(40,0) NOT NULL,
  eur              DOUBLE PRECISION,
  live_trade_id    TEXT,
  paper_trade_id   TEXT,
  signature        TEXT
);
CREATE INDEX fees_ts ON fees (ts DESC);

CREATE TABLE jito_bundles (
  bundle_id       TEXT PRIMARY KEY,
  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
  live_trade_id   TEXT REFERENCES live_trades (id),
  tip_lamports    BIGINT NOT NULL,
  tip_account     TEXT NOT NULL,
  status          TEXT NOT NULL,                     -- submitted | Pending | Landed | Failed | Invalid | timeout
  landed_slot     BIGINT,
  error           TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER jito_bundles_touch BEFORE UPDATE ON jito_bundles FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- learning, risk
-- ---------------------------------------------------------------------------------------------
CREATE TABLE learning_metrics (
  id                   BIGSERIAL PRIMARY KEY,
  ts                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind                 TEXT NOT NULL,              -- score | model:<name> | insight | oos | walk_forward | gate
  strategy_version_id  TEXT,
  value                JSONB NOT NULL
);
CREATE INDEX learning_metrics_kind ON learning_metrics (kind, ts DESC);

CREATE TABLE risk_events (
  id          BIGSERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind        TEXT NOT NULL,          -- breaker_open | breaker_close | limit | downgrade | emergency_stop | emergency_release | live_pause | rollback
  severity    TEXT NOT NULL,
  breaker     TEXT,
  mode        TEXT,
  message     TEXT NOT NULL,
  data        JSONB
);
CREATE INDEX risk_events_ts ON risk_events (ts DESC);
CREATE TRIGGER risk_events_immutable BEFORE UPDATE OR DELETE ON risk_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- tax ledger (documentation for German tax reporting — not tax advice)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE tax_lots (
  id              BIGSERIAL PRIMARY KEY,
  asset           TEXT NOT NULL,                 -- mint (SOL = wrapped SOL mint)
  acquired_at     TIMESTAMPTZ NOT NULL,
  quantity        NUMERIC(40,0) NOT NULL,        -- raw units
  remaining       NUMERIC(40,0) NOT NULL,
  cost_eur        DOUBLE PRECISION,              -- NULL = unknown (deposit without declared cost basis)
  source          TEXT NOT NULL,                 -- swap | deposit | manual
  signature       TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tax_lots_asset ON tax_lots (asset, acquired_at);

CREATE TABLE tax_transactions (
  id                     BIGSERIAL PRIMARY KEY,
  ts                     TIMESTAMPTZ NOT NULL,
  signature              TEXT NOT NULL,
  wallet_address         TEXT NOT NULL,
  chain                  TEXT NOT NULL DEFAULT 'solana',
  kind                   TEXT NOT NULL,          -- swap | deposit | withdrawal | fee
  asset_in               TEXT,
  amount_in              NUMERIC(40,0),
  asset_in_decimals      SMALLINT,
  asset_out              TEXT,
  amount_out             NUMERIC(40,0),
  asset_out_decimals     SMALLINT,
  eur_value              DOUBLE PRECISION,
  eur_price              DOUBLE PRECISION,       -- SOL/EUR used
  eur_price_ts           TIMESTAMPTZ,
  fees                   NUMERIC(40,0),
  fee_currency           TEXT,
  fee_eur                DOUBLE PRECISION,
  acquisition_value_eur  DOUBLE PRECISION,
  disposal_value_eur     DOUBLE PRECISION,
  realized_pnl_eur       DOUBLE PRECISION,
  dex                    TEXT,
  route                  JSONB,
  live_trade_id          TEXT,
  lot_details            JSONB,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tax_transactions_ts ON tax_transactions (ts);
CREATE TRIGGER tax_transactions_immutable BEFORE UPDATE OR DELETE ON tax_transactions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
