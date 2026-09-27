-- PumpSwap pools can be quoted in tokens other than SOL (USDC, other memecoins, …).
-- Record each pool's quote mint so only SOL-quoted pools are ever treated as SOL markets,
-- and provide a purge for data that was ingested from non-SOL pools as if it were SOL-quoted.

ALTER TABLE tokens ADD COLUMN IF NOT EXISTS amm_quote_mint TEXT;

-- Safe backfill: SOL-quoted curve tokens migrate into WSOL pools; tokens first seen through an AMM
-- trade or CreatePool event (decimals known, no create) only got there via a verified WSOL pool.
UPDATE tokens SET amm_quote_mint = 'So11111111111111111111111111111111111111112'
 WHERE amm_pool IS NOT NULL AND amm_quote_mint IS NULL
   AND ((created_at IS NOT NULL AND (quote_mint IS NULL OR quote_mint = 'So11111111111111111111111111111111111111112'))
        OR (created_at IS NULL AND decimals IS NOT NULL));

-- Known non-SOL quote from the create event.
UPDATE tokens SET amm_quote_mint = quote_mint
 WHERE amm_pool IS NOT NULL AND amm_quote_mint IS NULL
   AND quote_mint IS NOT NULL AND quote_mint <> 'So11111111111111111111111111111111111111112';

/**
 * Remove all market data of one mint (used for non-SOL-quoted markets) and back out its
 * contribution to the incremental wallet statistics. Paper/live trades and the ledger are kept.
 */
CREATE OR REPLACE FUNCTION purge_token_market_data(p_mint TEXT) RETURNS VOID AS $$
BEGIN
  UPDATE wallets w SET
    trade_count = GREATEST(0, w.trade_count - x.n),
    buy_count   = GREATEST(0, w.buy_count - x.buys),
    sell_count  = GREATEST(0, w.sell_count - x.sells),
    volume_sol  = GREATEST(0, w.volume_sol - x.vol)
  FROM (SELECT trader, count(*)::int AS n,
               count(*) FILTER (WHERE is_buy)::int AS buys,
               count(*) FILTER (WHERE NOT is_buy)::int AS sells,
               COALESCE(sum(sol_amount), 0)::float8 / 1e9 AS vol
          FROM market_trades WHERE mint = p_mint GROUP BY trader) x
  WHERE w.address = x.trader;

  UPDATE wallets w SET
    tokens_traded     = GREATEST(0, w.tokens_traded - p.cnt),
    early_entries     = GREATEST(0, w.early_entries - p.early),
    sum_entry_sol     = GREATEST(0, w.sum_entry_sol - p.entry),
    closed_positions  = GREATEST(0, w.closed_positions - p.closed),
    winning_positions = GREATEST(0, w.winning_positions - p.wins),
    realized_pnl_sol  = w.realized_pnl_sol - p.pnl,
    sum_return        = w.sum_return - p.sret,
    sum_return_sq     = GREATEST(0, w.sum_return_sq - p.sret2),
    sum_hold_sec      = GREATEST(0, w.sum_hold_sec - p.hold)
  FROM (SELECT address, count(*)::int AS cnt,
               count(*) FILTER (WHERE first_buy_age_sec IS NOT NULL AND first_buy_age_sec <= 60)::int AS early,
               COALESCE(sum(cost_sol / GREATEST(buys, 1)), 0) AS entry,
               count(*) FILTER (WHERE closed_at IS NOT NULL)::int AS closed,
               count(*) FILTER (WHERE closed_at IS NOT NULL AND realized_pnl_sol > 0)::int AS wins,
               COALESCE(sum(realized_pnl_sol) FILTER (WHERE closed_at IS NOT NULL), 0) AS pnl,
               COALESCE(sum(proceeds_sol / cost_sol - 1) FILTER (WHERE closed_at IS NOT NULL AND cost_sol > 0), 0) AS sret,
               COALESCE(sum((proceeds_sol / cost_sol - 1) ^ 2) FILTER (WHERE closed_at IS NOT NULL AND cost_sol > 0), 0) AS sret2,
               COALESCE(sum(EXTRACT(EPOCH FROM closed_at - first_buy_at)) FILTER (WHERE closed_at IS NOT NULL AND first_buy_at IS NOT NULL), 0) AS hold
          FROM wallet_positions WHERE mint = p_mint GROUP BY address) p
  WHERE w.address = p.address;

  DELETE FROM wallet_positions WHERE mint = p_mint;
  DELETE FROM wallet_events WHERE mint = p_mint;
  DELETE FROM holders WHERE mint = p_mint;
  DELETE FROM market_trades WHERE mint = p_mint;
  DELETE FROM volume_snapshots WHERE mint = p_mint;
  DELETE FROM liquidity_snapshots WHERE mint = p_mint;
  DELETE FROM token_snapshots WHERE mint = p_mint;
  DELETE FROM research_samples WHERE mint = p_mint;
  DELETE FROM events WHERE mint = p_mint;
  DELETE FROM token_state WHERE mint = p_mint;
END;
$$ LANGUAGE plpgsql;

SELECT purge_token_market_data(mint) FROM tokens
 WHERE amm_quote_mint IS NOT NULL AND amm_quote_mint <> 'So11111111111111111111111111111111111111112';
