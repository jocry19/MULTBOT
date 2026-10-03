-- MULTBOT initial schema.
--
-- Conventions
--   * every market datum carries `ts` (when it happened on-chain) AND `available_at` (when this system
--     could know it). Research and backtests filter on `available_at <= decision_time` (no look-ahead).
--   * SOL amounts in analytics tables are DOUBLE PRECISION in SOL; raw token amounts are NUMERIC(40,0);
--     on-chain lamport amounts are BIGINT.
--   * paper_* and live_* data live in separate tables and are never mixed.
--   * high-volume time series are partitioned by day (see ensure_daily_partition).

-- ---------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------

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
  -- concurrent creation by another worker
  NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (immutable ledger)', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------
-- System / configuration
-- ---------------------------------------------------------------------------------------------

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE settings_audit (
  id          BIGSERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  key         TEXT NOT NULL,
  old_value   JSONB,
  new_value   JSONB NOT NULL,
  actor       TEXT NOT NULL
);

CREATE TABLE system_state (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE bot_activity (
  id          BIGSERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  level       TEXT NOT NULL,
  category    TEXT NOT NULL,
  message     TEXT NOT NULL,
  data        JSONB
);
CREATE INDEX bot_activity_ts_idx ON bot_activity (ts DESC);
CREATE INDEX bot_activity_category_idx ON bot_activity (category, ts DESC);

CREATE TABLE notifications (
  id          BIGSERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  level       TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  read        BOOLEAN NOT NULL DEFAULT false,
  data        JSONB
);
CREATE INDEX notifications_ts_idx ON notifications (ts DESC);

CREATE TABLE auth_sessions (
  id          TEXT PRIMARY KEY,           -- sha256 of the session token (token itself is never stored)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  ip          TEXT,
  user_agent  TEXT
);

-- ---------------------------------------------------------------------------------------------
-- Tokens & creators
-- ---------------------------------------------------------------------------------------------

CREATE TABLE tokens (
  mint              TEXT PRIMARY KEY,
  name              TEXT,
  symbol            TEXT,
  uri               TEXT,
  decimals          SMALLINT,
  token_program     TEXT,
  creator           TEXT,
  bonding_curve     TEXT,
  quote_mint        TEXT,
  is_mayhem_mode    BOOLEAN NOT NULL DEFAULT false,
  is_cashback       BOOLEAN NOT NULL DEFAULT false,
  total_supply      NUMERIC(40,0),
  created_at        TIMESTAMPTZ,              -- on-chain creation time
  created_slot      BIGINT,
  create_signature  TEXT,
  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  available_at      TIMESTAMPTZ NOT NULL,
  source            TEXT NOT NULL,            -- live | backfill | discovered
  complete_at       TIMESTAMPTZ,              -- bonding curve completed
  migrated_at       TIMESTAMPTZ,
  amm_pool          TEXT,
  mint_authority    TEXT,
  freeze_authority  TEXT,
  authorities_checked_at TIMESTAMPTZ,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tokens_creator_idx ON tokens (creator);
CREATE INDEX tokens_created_at_idx ON tokens (created_at DESC);
CREATE INDEX tokens_amm_pool_idx ON tokens (amm_pool) WHERE amm_pool IS NOT NULL;
CREATE TRIGGER tokens_touch BEFORE UPDATE ON tokens FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE token_metadata_history (
  id            BIGSERIAL PRIMARY KEY,
  mint          TEXT NOT NULL REFERENCES tokens (mint) ON DELETE CASCADE,
  ts            TIMESTAMPTZ NOT NULL,
  available_at  TIMESTAMPTZ NOT NULL,
  field         TEXT NOT NULL,
  old_value     TEXT,
  new_value     TEXT
);
CREATE INDEX token_metadata_history_mint_idx ON token_metadata_history (mint, ts);

-- Latest derived state per token (denormalised, rebuilt continuously by the MarketIndexer).
CREATE TABLE token_state (
  mint                TEXT PRIMARY KEY,
  venue               TEXT NOT NULL,
  last_trade_at       TIMESTAMPTZ,
  price_sol           DOUBLE PRECISION,
  market_cap_sol      DOUBLE PRECISION,
  liquidity_sol       DOUBLE PRECISION,
  ath_price_sol       DOUBLE PRECISION,
  bonding_progress    DOUBLE PRECISION,
  volume_sol_5m       DOUBLE PRECISION,
  volume_sol_1h       DOUBLE PRECISION,
  volume_sol_24h      DOUBLE PRECISION,
  buys_5m             INTEGER,
  sells_5m            INTEGER,
  trades_total        INTEGER,
  unique_traders      INTEGER,
  holders             INTEGER,
  top10_share         DOUBLE PRECISION,
  price_change_5m     DOUBLE PRECISION,
  price_change_1h     DOUBLE PRECISION,
  discovery_score     DOUBLE PRECISION,
  discovery_reasons   JSONB NOT NULL DEFAULT '[]'::jsonb,
  features            JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX token_state_last_trade_idx ON token_state (last_trade_at DESC);
CREATE INDEX token_state_discovery_idx ON token_state (discovery_score DESC NULLS LAST);

CREATE TABLE creators (
  address             TEXT PRIMARY KEY,
  tokens_created      INTEGER NOT NULL DEFAULT 0,
  tokens_completed    INTEGER NOT NULL DEFAULT 0,
  tokens_rugged       INTEGER NOT NULL DEFAULT 0,
  first_created_at    TIMESTAMPTZ,
  last_created_at     TIMESTAMPTZ,
  stats               JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------------------------
-- Market data (partitioned by day)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE market_trades (
  signature               TEXT NOT NULL,
  event_index             SMALLINT NOT NULL,
  slot                    BIGINT NOT NULL,
  ts                      TIMESTAMPTZ NOT NULL,
  available_at            TIMESTAMPTZ NOT NULL,
  mint                    TEXT NOT NULL,
  venue                   TEXT NOT NULL,
  pool                    TEXT,
  trader                  TEXT NOT NULL,
  is_buy                  BOOLEAN NOT NULL,
  sol_amount              BIGINT NOT NULL,       -- lamports into/out of the curve or pool, excl. fees
  token_amount            NUMERIC(40,0) NOT NULL,
  fee_lamports            BIGINT NOT NULL DEFAULT 0,
  fee_bps                 INTEGER,
  price_sol               DOUBLE PRECISION NOT NULL,  -- marginal price after the trade, SOL per whole token
  market_cap_sol          DOUBLE PRECISION,
  virtual_sol_reserves    BIGINT,
  virtual_token_reserves  NUMERIC(40,0),
  real_sol_reserves       BIGINT,
  real_token_reserves     NUMERIC(40,0),
  ix_name                 TEXT,
  source                  TEXT NOT NULL,
  PRIMARY KEY (signature, event_index, ts)
) PARTITION BY RANGE (ts);
CREATE INDEX market_trades_mint_ts_idx ON market_trades (mint, ts);
CREATE INDEX market_trades_trader_ts_idx ON market_trades (trader, ts);
CREATE INDEX market_trades_available_idx ON market_trades (available_at);

-- 1-minute bars per token: OHLC + flow. Used for charts and volume history.
CREATE TABLE volume_snapshots (
  mint              TEXT NOT NULL,
  ts                TIMESTAMPTZ NOT NULL,     -- bucket start
  available_at      TIMESTAMPTZ NOT NULL,     -- bucket end + ingestion delay
  open_price        DOUBLE PRECISION NOT NULL,
  high_price        DOUBLE PRECISION NOT NULL,
  low_price         DOUBLE PRECISION NOT NULL,
  close_price       DOUBLE PRECISION NOT NULL,
  buy_volume_sol    DOUBLE PRECISION NOT NULL,
  sell_volume_sol   DOUBLE PRECISION NOT NULL,
  buys              INTEGER NOT NULL,
  sells             INTEGER NOT NULL,
  unique_buyers     INTEGER NOT NULL,
  unique_sellers    INTEGER NOT NULL,
  PRIMARY KEY (mint, ts)
) PARTITION BY RANGE (ts);

CREATE TABLE liquidity_snapshots (
  mint                  TEXT NOT NULL,
  ts                    TIMESTAMPTZ NOT NULL,
  available_at          TIMESTAMPTZ NOT NULL,
  venue                 TEXT NOT NULL,
  pool                  TEXT,
  liquidity_sol         DOUBLE PRECISION NOT NULL,   -- real SOL/quote reserves backing the price
  virtual_sol_reserves  BIGINT,
  real_sol_reserves     BIGINT,
  real_token_reserves   NUMERIC(40,0),
  market_cap_sol        DOUBLE PRECISION,
  PRIMARY KEY (mint, ts)
) PARTITION BY RANGE (ts);

CREATE TABLE token_snapshots (
  mint          TEXT NOT NULL,
  ts            TIMESTAMPTZ NOT NULL,
  available_at  TIMESTAMPTZ NOT NULL,
  age_sec       INTEGER NOT NULL,
  venue         TEXT NOT NULL,
  price_sol     DOUBLE PRECISION,
  market_cap_sol DOUBLE PRECISION,
  liquidity_sol DOUBLE PRECISION,
  holders       INTEGER,
  features      JSONB NOT NULL,
  PRIMARY KEY (mint, ts)
) PARTITION BY RANGE (ts);

CREATE TABLE holders (
  mint              TEXT NOT NULL,
  owner             TEXT NOT NULL,
  balance           NUMERIC(40,0) NOT NULL,
  first_acquired_at TIMESTAMPTZ,
  last_change_at    TIMESTAMPTZ NOT NULL,
  source            TEXT NOT NULL,            -- trades | rpc
  PRIMARY KEY (mint, owner)
);
CREATE INDEX holders_owner_idx ON holders (owner);

-- ---------------------------------------------------------------------------------------------
-- Wallet intelligence
-- ---------------------------------------------------------------------------------------------

CREATE TABLE wallets (
  address             TEXT PRIMARY KEY,
  first_seen_at       TIMESTAMPTZ NOT NULL,
  last_seen_at        TIMESTAMPTZ NOT NULL,
  trade_count         INTEGER NOT NULL DEFAULT 0,
  buy_count           INTEGER NOT NULL DEFAULT 0,
  sell_count          INTEGER NOT NULL DEFAULT 0,
  tokens_traded       INTEGER NOT NULL DEFAULT 0,
  volume_sol          DOUBLE PRECISION NOT NULL DEFAULT 0,
  realized_pnl_sol    DOUBLE PRECISION NOT NULL DEFAULT 0,
  closed_positions    INTEGER NOT NULL DEFAULT 0,
  winning_positions   INTEGER NOT NULL DEFAULT 0,
  early_entries       INTEGER NOT NULL DEFAULT 0,  -- buys within the first 60s of a token
  tokens_created      INTEGER NOT NULL DEFAULT 0,
  sol_balance         DOUBLE PRECISION,
  sol_balance_at      TIMESTAMPTZ,
  cluster_id          BIGINT,
  stats               JSONB NOT NULL DEFAULT '{}'::jsonb,
  labels              TEXT[] NOT NULL DEFAULT '{}',
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX wallets_realized_pnl_idx ON wallets (realized_pnl_sol DESC);
CREATE INDEX wallets_cluster_idx ON wallets (cluster_id) WHERE cluster_id IS NOT NULL;

-- Per wallet per token position accounting, built from market_trades.
CREATE TABLE wallet_positions (
  address           TEXT NOT NULL,
  mint              TEXT NOT NULL,
  tokens_bought     NUMERIC(40,0) NOT NULL DEFAULT 0,
  tokens_sold       NUMERIC(40,0) NOT NULL DEFAULT 0,
  cost_sol          DOUBLE PRECISION NOT NULL DEFAULT 0,
  proceeds_sol      DOUBLE PRECISION NOT NULL DEFAULT 0,
  buys              INTEGER NOT NULL DEFAULT 0,
  sells             INTEGER NOT NULL DEFAULT 0,
  first_buy_at      TIMESTAMPTZ,
  first_buy_age_sec INTEGER,
  last_trade_at     TIMESTAMPTZ NOT NULL,
  closed_at         TIMESTAMPTZ,
  realized_pnl_sol  DOUBLE PRECISION,
  PRIMARY KEY (address, mint)
);
CREATE INDEX wallet_positions_mint_idx ON wallet_positions (mint);

CREATE TABLE wallet_events (
  id            BIGSERIAL PRIMARY KEY,
  address       TEXT NOT NULL,
  ts            TIMESTAMPTZ NOT NULL,
  available_at  TIMESTAMPTZ NOT NULL,
  type          TEXT NOT NULL,
  mint          TEXT,
  data          JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX wallet_events_address_idx ON wallet_events (address, ts DESC);
CREATE INDEX wallet_events_mint_idx ON wallet_events (mint, ts DESC);

CREATE TABLE wallet_clusters (
  id            BIGSERIAL PRIMARY KEY,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  method        TEXT NOT NULL,
  size          INTEGER NOT NULL,
  members       TEXT[] NOT NULL,
  features      JSONB NOT NULL DEFAULT '{}'::jsonb,
  stats         JSONB NOT NULL DEFAULT '{}'::jsonb,
  active        BOOLEAN NOT NULL DEFAULT true
);

-- ---------------------------------------------------------------------------------------------
-- Events, features, regimes, research samples
-- ---------------------------------------------------------------------------------------------

CREATE TABLE events (
  id                BIGSERIAL PRIMARY KEY,
  event_uid         TEXT NOT NULL UNIQUE,        -- deterministic id → duplicate prevention
  type              TEXT NOT NULL,
  mint              TEXT,                        -- NULL for market-wide events
  ts                TIMESTAMPTZ NOT NULL,
  available_at      TIMESTAMPTZ NOT NULL,
  severity          DOUBLE PRECISION NOT NULL,   -- contextual abnormality (e.g. robust z-score)
  direction         SMALLINT NOT NULL DEFAULT 0, -- +1 / -1 / 0
  detector          TEXT NOT NULL,
  detector_version  INTEGER NOT NULL DEFAULT 1,
  context           JSONB NOT NULL DEFAULT '{}'::jsonb,   -- values at detection (pre-event state)
  outcome           JSONB,                                -- filled once horizons have elapsed
  outcome_complete  BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX events_mint_ts_idx ON events (mint, ts DESC);
CREATE INDEX events_type_ts_idx ON events (type, ts DESC);
CREATE INDEX events_ts_idx ON events (ts DESC);
CREATE INDEX events_pending_outcome_idx ON events (ts) WHERE outcome_complete = false;

CREATE TABLE features (
  name          TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,           -- base | context | derived | discovered
  expression    TEXT NOT NULL,
  description   TEXT,
  version       INTEGER NOT NULL DEFAULT 1,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  stats         JSONB NOT NULL DEFAULT '{}'::jsonb,   -- distribution + information value
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE market_regimes (
  ts            TIMESTAMPTZ PRIMARY KEY,
  available_at  TIMESTAMPTZ NOT NULL,
  window_sec    INTEGER NOT NULL,
  metrics       JSONB NOT NULL,
  levels        JSONB NOT NULL,          -- dimension → low|normal|high|extreme
  label         TEXT NOT NULL
);

-- Decision points with causal features and realistic forward outcomes (research dataset).
CREATE TABLE research_samples (
  id            BIGSERIAL,
  mint          TEXT NOT NULL,
  ts            TIMESTAMPTZ NOT NULL,          -- decision time
  available_at  TIMESTAMPTZ NOT NULL,
  trigger       TEXT NOT NULL,                 -- periodic | age:<sec> | event:<type>
  event_id      BIGINT,
  age_sec       INTEGER NOT NULL,
  venue         TEXT NOT NULL,
  features      JSONB NOT NULL,
  regime        JSONB,
  outcome       JSONB,                         -- per-horizon realistic net returns
  labeled_at    TIMESTAMPTZ,
  PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);
CREATE INDEX research_samples_unlabeled_idx ON research_samples (ts) WHERE labeled_at IS NULL;
CREATE INDEX research_samples_mint_idx ON research_samples (mint, ts);

-- ---------------------------------------------------------------------------------------------
-- Strategies, discovery, backtests
-- ---------------------------------------------------------------------------------------------

CREATE TABLE strategies (
  id                  TEXT PRIMARY KEY,           -- e.g. S-000147
  seq                 BIGSERIAL UNIQUE,
  name                TEXT NOT NULL,
  family              TEXT NOT NULL,
  origin              TEXT NOT NULL,              -- discovered | evolved | manual
  parent_strategy_id  TEXT REFERENCES strategies (id),
  status              TEXT NOT NULL,
  status_reason       TEXT,
  current_version_id  TEXT,
  live_enabled        BOOLEAN NOT NULL DEFAULT false,
  live_enabled_at     TIMESTAMPTZ,
  paper_enabled       BOOLEAN NOT NULL DEFAULT true,
  discovery_run_id    BIGINT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX strategies_status_idx ON strategies (status);
CREATE TRIGGER strategies_touch BEFORE UPDATE ON strategies FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE strategy_versions (
  id                  TEXT PRIMARY KEY,           -- e.g. S-000147@1.2
  strategy_id         TEXT NOT NULL REFERENCES strategies (id) ON DELETE CASCADE,
  version             TEXT NOT NULL,
  major               INTEGER NOT NULL,
  minor               INTEGER NOT NULL,
  spec                JSONB NOT NULL,
  spec_hash           TEXT NOT NULL,
  parent_version_id   TEXT REFERENCES strategy_versions (id),
  change_summary      TEXT,
  status              TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (strategy_id, version),
  UNIQUE (strategy_id, spec_hash)
);

ALTER TABLE strategies
  ADD CONSTRAINT strategies_current_version_fk FOREIGN KEY (current_version_id) REFERENCES strategy_versions (id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE strategy_status_history (
  id            BIGSERIAL PRIMARY KEY,
  strategy_id   TEXT NOT NULL REFERENCES strategies (id) ON DELETE CASCADE,
  version_id    TEXT,
  from_status   TEXT,
  to_status     TEXT NOT NULL,
  reason        TEXT,
  actor         TEXT NOT NULL,
  ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
  evidence      JSONB
);
CREATE INDEX strategy_status_history_idx ON strategy_status_history (strategy_id, ts DESC);

CREATE TABLE strategy_results (
  id                    BIGSERIAL PRIMARY KEY,
  strategy_version_id   TEXT NOT NULL REFERENCES strategy_versions (id) ON DELETE CASCADE,
  kind                  TEXT NOT NULL,   -- in_sample | out_of_sample | walk_forward | backtest | paper | live | rolling
  period_start          TIMESTAMPTZ,
  period_end            TIMESTAMPTZ,
  computed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  metrics               JSONB NOT NULL,
  evidence              JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX strategy_results_version_idx ON strategy_results (strategy_version_id, kind, computed_at DESC);

CREATE TABLE discovery_runs (
  id                  BIGSERIAL PRIMARY KEY,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at         TIMESTAMPTZ,
  status              TEXT NOT NULL,     -- running | done | failed | insufficient_data
  config              JSONB NOT NULL,
  dataset             JSONB NOT NULL DEFAULT '{}'::jsonb,
  hypotheses_tested   INTEGER NOT NULL DEFAULT 0,
  survivors           INTEGER NOT NULL DEFAULT 0,
  summary             JSONB NOT NULL DEFAULT '{}'::jsonb,
  error               TEXT
);

CREATE TABLE hypotheses (
  id              BIGSERIAL PRIMARY KEY,
  run_id          BIGINT NOT NULL REFERENCES discovery_runs (id) ON DELETE CASCADE,
  conditions      JSONB NOT NULL,
  horizon_sec     INTEGER NOT NULL,
  n_train         INTEGER NOT NULL,
  mean_train      DOUBLE PRECISION NOT NULL,
  p_value         DOUBLE PRECISION NOT NULL,
  q_value         DOUBLE PRECISION,
  n_test          INTEGER,
  mean_test       DOUBLE PRECISION,
  walk_forward    JSONB,
  verdict         TEXT NOT NULL,          -- survived | rejected
  reject_reason   TEXT,
  strategy_id     TEXT REFERENCES strategies (id)
);
CREATE INDEX hypotheses_run_idx ON hypotheses (run_id, verdict);

CREATE TABLE backtests (
  id                    BIGSERIAL PRIMARY KEY,
  strategy_version_id   TEXT NOT NULL REFERENCES strategy_versions (id) ON DELETE CASCADE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at           TIMESTAMPTZ,
  status                TEXT NOT NULL,    -- running | done | failed
  config                JSONB NOT NULL,
  period_start          TIMESTAMPTZ,
  period_end            TIMESTAMPTZ,
  metrics               JSONB,
  equity_curve          JSONB,
  cost_breakdown        JSONB,
  regime_breakdown      JSONB,
  error                 TEXT
);
CREATE INDEX backtests_version_idx ON backtests (strategy_version_id, created_at DESC);

CREATE TABLE backtest_trades (
  backtest_id     BIGINT NOT NULL REFERENCES backtests (id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  mint            TEXT NOT NULL,
  decision_ts     TIMESTAMPTZ NOT NULL,
  entry_ts        TIMESTAMPTZ,
  exit_ts         TIMESTAMPTZ,
  entry_price     DOUBLE PRECISION,
  exit_price      DOUBLE PRECISION,
  gross_pnl_sol   DOUBLE PRECISION NOT NULL,
  net_pnl_sol     DOUBLE PRECISION NOT NULL,
  net_return      DOUBLE PRECISION NOT NULL,
  costs           JSONB NOT NULL,
  exit_reason     TEXT,
  failed          BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (backtest_id, seq)
);

-- ---------------------------------------------------------------------------------------------
-- Signals, paper trading, live trading (strictly separated)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE signals (
  id                    TEXT PRIMARY KEY,
  mode                  TEXT NOT NULL CHECK (mode IN ('paper', 'live')),
  idempotency_key       TEXT NOT NULL UNIQUE,
  strategy_id           TEXT NOT NULL REFERENCES strategies (id),
  strategy_version_id   TEXT NOT NULL REFERENCES strategy_versions (id),
  mint                  TEXT NOT NULL,
  event_id              BIGINT,
  ts                    TIMESTAMPTZ NOT NULL,
  decision              TEXT NOT NULL,      -- ENTER | NO_TRADE
  reasons               JSONB NOT NULL,
  expected              JSONB,
  features              JSONB
);
CREATE INDEX signals_ts_idx ON signals (ts DESC);
CREATE INDEX signals_strategy_idx ON signals (strategy_id, ts DESC);

CREATE TABLE paper_trades (
  id                    TEXT PRIMARY KEY,
  idempotency_key       TEXT NOT NULL UNIQUE,
  signal_id             TEXT REFERENCES signals (id),
  strategy_id           TEXT NOT NULL REFERENCES strategies (id),
  strategy_version_id   TEXT NOT NULL REFERENCES strategy_versions (id),
  event_id              BIGINT,
  mint                  TEXT NOT NULL,
  status                TEXT NOT NULL,       -- OPEN | CLOSED | FAILED
  decision_ts           TIMESTAMPTZ NOT NULL,
  opened_at             TIMESTAMPTZ,
  closed_at             TIMESTAMPTZ,
  position_size_sol     DOUBLE PRECISION NOT NULL,
  token_qty             NUMERIC(40,0),
  expected_entry_price  DOUBLE PRECISION,
  entry_price           DOUBLE PRECISION,
  exit_price            DOUBLE PRECISION,
  gross_entry_sol       DOUBLE PRECISION,
  gross_exit_sol        DOUBLE PRECISION,
  entry_slippage_sol    DOUBLE PRECISION NOT NULL DEFAULT 0,
  exit_slippage_sol     DOUBLE PRECISION NOT NULL DEFAULT 0,
  entry_fees_sol        DOUBLE PRECISION NOT NULL DEFAULT 0,
  exit_fees_sol         DOUBLE PRECISION NOT NULL DEFAULT 0,
  entry_rent_sol        DOUBLE PRECISION NOT NULL DEFAULT 0,
  exit_rent_refund_sol  DOUBLE PRECISION NOT NULL DEFAULT 0,
  priority_fees_sol     DOUBLE PRECISION NOT NULL DEFAULT 0,
  network_fees_sol      DOUBLE PRECISION NOT NULL DEFAULT 0,
  mev_impact_sol        DOUBLE PRECISION NOT NULL DEFAULT 0,
  gross_pnl_sol         DOUBLE PRECISION,
  net_pnl_sol           DOUBLE PRECISION,
  net_return            DOUBLE PRECISION,
  max_runup             DOUBLE PRECISION,
  max_drawdown          DOUBLE PRECISION,
  exit_reason           TEXT,
  failed_reason         TEXT,
  features              JSONB,
  expected              JSONB,
  actual                JSONB,
  regime                JSONB,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX paper_trades_status_idx ON paper_trades (status);
CREATE INDEX paper_trades_strategy_idx ON paper_trades (strategy_id, closed_at DESC);
CREATE INDEX paper_trades_mint_idx ON paper_trades (mint);
CREATE TRIGGER paper_trades_touch BEFORE UPDATE ON paper_trades FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE live_trades (
  id                    TEXT PRIMARY KEY,
  idempotency_key       TEXT NOT NULL UNIQUE,
  signal_id             TEXT REFERENCES signals (id),
  strategy_id           TEXT NOT NULL REFERENCES strategies (id),
  strategy_version_id   TEXT NOT NULL REFERENCES strategy_versions (id),
  event_id              BIGINT,
  wallet                TEXT NOT NULL,
  mint                  TEXT NOT NULL,
  status                TEXT NOT NULL,       -- OPENING | OPEN | CLOSING | CLOSED | FAILED
  decision_ts           TIMESTAMPTZ NOT NULL,
  opened_at             TIMESTAMPTZ,
  closed_at             TIMESTAMPTZ,
  position_size_sol     DOUBLE PRECISION NOT NULL,
  token_qty             NUMERIC(40,0),
  token_decimals        SMALLINT,
  expected_entry_price  DOUBLE PRECISION,
  entry_price           DOUBLE PRECISION,
  expected_exit_price   DOUBLE PRECISION,
  exit_price            DOUBLE PRECISION,
  gross_entry_sol       DOUBLE PRECISION,
  gross_exit_sol        DOUBLE PRECISION,
  entry_slippage_sol    DOUBLE PRECISION NOT NULL DEFAULT 0,
  exit_slippage_sol     DOUBLE PRECISION NOT NULL DEFAULT 0,
  entry_fees_sol        DOUBLE PRECISION NOT NULL DEFAULT 0,
  exit_fees_sol         DOUBLE PRECISION NOT NULL DEFAULT 0,
  entry_rent_sol        DOUBLE PRECISION NOT NULL DEFAULT 0,
  exit_rent_refund_sol  DOUBLE PRECISION NOT NULL DEFAULT 0,
  priority_fees_sol     DOUBLE PRECISION NOT NULL DEFAULT 0,
  network_fees_sol      DOUBLE PRECISION NOT NULL DEFAULT 0,
  mev_impact_sol        DOUBLE PRECISION NOT NULL DEFAULT 0,
  gross_pnl_sol         DOUBLE PRECISION,
  net_pnl_sol           DOUBLE PRECISION,
  net_return            DOUBLE PRECISION,
  max_runup             DOUBLE PRECISION,
  max_drawdown          DOUBLE PRECISION,
  entry_signature       TEXT,
  exit_signature        TEXT,
  exit_reason           TEXT,
  failed_reason         TEXT,
  features              JSONB,
  expected              JSONB,
  actual                JSONB,
  regime                JSONB,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX live_trades_status_idx ON live_trades (status);
CREATE INDEX live_trades_strategy_idx ON live_trades (strategy_id, closed_at DESC);
CREATE INDEX live_trades_mint_idx ON live_trades (mint);
CREATE TRIGGER live_trades_touch BEFORE UPDATE ON live_trades FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Every on-chain transaction attempt of the live engine.
CREATE TABLE orders (
  id                      TEXT PRIMARY KEY,
  idempotency_key         TEXT NOT NULL UNIQUE,
  live_trade_id           TEXT REFERENCES live_trades (id),
  kind                    TEXT NOT NULL,     -- buy | sell | transfer
  mint                    TEXT,
  status                  TEXT NOT NULL,
  provider                TEXT NOT NULL,
  input_amount            NUMERIC(40,0),
  min_output_amount       NUMERIC(40,0),
  quote                   JSONB,
  validation              JSONB,
  simulation              JSONB,
  cost_estimate           JSONB,
  signature               TEXT UNIQUE,
  last_valid_block_height BIGINT,
  attempts                INTEGER NOT NULL DEFAULT 0,
  sent_at                 TIMESTAMPTZ,
  confirmed_at            TIMESTAMPTZ,
  slot                    BIGINT,
  result                  JSONB,
  error                   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX orders_status_idx ON orders (status);
CREATE INDEX orders_trade_idx ON orders (live_trade_id);
CREATE TRIGGER orders_touch BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- On-chain history of the bot wallet (deposits, withdrawals, swaps, fees).
CREATE TABLE transactions (
  signature           TEXT PRIMARY KEY,
  wallet              TEXT NOT NULL,
  slot                BIGINT NOT NULL,
  ts                  TIMESTAMPTZ,
  type                TEXT NOT NULL,      -- deposit | withdrawal | swap_buy | swap_sell | other
  status              TEXT NOT NULL,      -- success | failed
  sol_change_lamports BIGINT NOT NULL,
  fee_lamports        BIGINT NOT NULL,
  token_mint          TEXT,
  token_change        NUMERIC(40,0),
  counterparty        TEXT,
  order_id            TEXT REFERENCES orders (id),
  live_trade_id       TEXT REFERENCES live_trades (id),
  raw                 JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX transactions_wallet_ts_idx ON transactions (wallet, slot DESC);

-- Immutable, hash-chained trading ledger (live money only).
CREATE TABLE ledger_entries (
  id            BIGSERIAL PRIMARY KEY,
  ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
  entry_type    TEXT NOT NULL,       -- TRADE_OPEN | TRADE_CLOSE | TRADE_FAILED | DEPOSIT | WITHDRAWAL | ADJUSTMENT
  trade_id      TEXT,
  signature     TEXT,
  data          JSONB NOT NULL,
  prev_hash     TEXT NOT NULL,
  hash          TEXT NOT NULL UNIQUE
);
CREATE INDEX ledger_entries_trade_idx ON ledger_entries (trade_id);
CREATE TRIGGER ledger_entries_immutable BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Learning
-- ---------------------------------------------------------------------------------------------

CREATE TABLE learning_updates (
  id                    BIGSERIAL PRIMARY KEY,
  ts                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  mode                  TEXT NOT NULL CHECK (mode IN ('paper', 'live')),
  trade_id              TEXT NOT NULL,
  strategy_version_id   TEXT,
  prediction            JSONB NOT NULL,
  actual                JSONB NOT NULL,
  prediction_error      DOUBLE PRECISION,
  decision_quality      TEXT NOT NULL,   -- good | acceptable | poor
  outcome_quality       TEXT NOT NULL,   -- win | loss | flat
  attribution           JSONB NOT NULL DEFAULT '{}'::jsonb,
  action                TEXT,            -- none | recalibrate | retest | flag_regime | flag_execution
  UNIQUE (mode, trade_id)
);
CREATE INDEX learning_updates_version_idx ON learning_updates (strategy_version_id, ts DESC);

CREATE TABLE learning_state (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------------------------
-- German tax documentation (no tax advice — documentation only)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE fx_rates (
  pair        TEXT NOT NULL,            -- e.g. SOL/EUR
  ts          TIMESTAMPTZ NOT NULL,     -- minute bucket
  rate        DOUBLE PRECISION NOT NULL,
  source      TEXT NOT NULL,
  PRIMARY KEY (pair, ts)
);

CREATE TABLE tax_lots (
  id              BIGSERIAL PRIMARY KEY,
  asset           TEXT NOT NULL,        -- 'SOL' or token mint
  acquired_at     TIMESTAMPTZ NOT NULL,
  quantity        NUMERIC(40,12) NOT NULL,
  remaining       NUMERIC(40,12) NOT NULL,
  cost_eur        DOUBLE PRECISION,     -- NULL = unknown (e.g. deposit without declared cost basis)
  cost_sol        DOUBLE PRECISION,
  fees_eur        DOUBLE PRECISION NOT NULL DEFAULT 0,
  source          TEXT NOT NULL,        -- trade | deposit | manual
  signature       TEXT,
  live_trade_id   TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tax_lots_asset_idx ON tax_lots (asset, acquired_at, id);

CREATE TABLE tax_disposals (
  id              BIGSERIAL PRIMARY KEY,
  asset           TEXT NOT NULL,
  disposed_at     TIMESTAMPTZ NOT NULL,
  quantity        NUMERIC(40,12) NOT NULL,
  proceeds_eur    DOUBLE PRECISION,
  proceeds_sol    DOUBLE PRECISION,
  cost_basis_eur  DOUBLE PRECISION,
  fees_eur        DOUBLE PRECISION NOT NULL DEFAULT 0,
  gain_eur        DOUBLE PRECISION,
  holding_days_min INTEGER,
  holding_days_max INTEGER,
  allocations     JSONB NOT NULL,       -- [{lotId, qty, costEur, acquiredAt}]
  signature       TEXT,
  live_trade_id   TEXT,
  kind            TEXT NOT NULL,        -- sale | swap | fee
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tax_disposals_asset_idx ON tax_disposals (asset, disposed_at);
