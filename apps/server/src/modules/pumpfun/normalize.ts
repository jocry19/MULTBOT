import type {
  CurveCompleted,
  DataSource,
  LiquidityChanged,
  MarketEvent,
  MarketTrade,
  PoolCreated,
  TokenCreated,
  TokenMigrated,
} from "../../domain/market.js";
import { DEFAULT_PUBKEY, PUMP_TOKEN_DECIMALS, PUMP_TOKEN_TOTAL_SUPPLY, WSOL_MINT } from "./constants.js";
import { curvePriceSol, poolPriceSol } from "./curve.js";
import type { DecodedEvent, FieldValue } from "./events.js";
import type { ParsedEvent } from "./logParser.js";

export interface PoolInfo {
  pool: string;
  baseMint: string;
  quoteMint: string;
  baseDecimals: number;
}

export interface NormalizeContext {
  signature: string;
  slot: number;
  /** When the data became available to us (ms). */
  availableAt: number;
  source: DataSource;
  /** PumpSwap pool → mint lookup. Unknown pools yield `unresolvedPools`. */
  lookupPool: (pool: string) => PoolInfo | undefined;
}

export interface NormalizeResult {
  events: MarketEvent[];
  /** AMM pools referenced by trades that could not be mapped to a mint yet. */
  unresolvedPools: string[];
  /** Events skipped on purpose (non-SOL quote, zero amounts …). */
  skipped: number;
}

const big = (v: FieldValue | undefined): bigint => (typeof v === "bigint" ? v : 0n);
const str = (v: FieldValue | undefined): string | null => (typeof v === "string" ? v : null);
const bool = (v: FieldValue | undefined): boolean => v === true;
const tsMs = (v: FieldValue | undefined): number => Number(big(v)) * 1000;

function isSolQuote(quoteMint: string | null): boolean {
  return quoteMint === null || quoteMint === DEFAULT_PUBKEY || quoteMint === WSOL_MINT;
}

function feeBps(fee: bigint, amount: bigint): number | null {
  if (amount <= 0n) return null;
  return Math.round((Number(fee) / Number(amount)) * 10_000);
}

/** Convert decoded Anchor events of one transaction into normalised market events. */
export function normalizeEvents(parsed: ParsedEvent[], ctx: NormalizeContext): NormalizeResult {
  const events: MarketEvent[] = [];
  const unresolved = new Set<string>();
  let skipped = 0;

  // Pools created in the same transaction (migration) are resolvable immediately.
  const localPools = new Map<string, PoolInfo>();
  for (const { event } of parsed) {
    if (event.name === "CreatePoolEvent") {
      const pool = str(event.data.pool);
      const baseMint = str(event.data.base_mint);
      const quoteMint = str(event.data.quote_mint);
      if (pool && baseMint && quoteMint) {
        localPools.set(pool, { pool, baseMint, quoteMint, baseDecimals: Number(event.data.base_mint_decimals ?? 6) });
      }
    }
  }
  const lookup = (pool: string) => localPools.get(pool) ?? ctx.lookupPool(pool);

  for (const { event, index } of parsed) {
    const base = { signature: ctx.signature, slot: ctx.slot, availableAt: ctx.availableAt, source: ctx.source };
    switch (event.name) {
      case "CreateEvent":
        events.push({ kind: "create", data: toCreate(event, base) });
        break;
      case "TradeEvent": {
        const t = toCurveTrade(event, index, base);
        if (t) events.push({ kind: "trade", data: t });
        else skipped++;
        break;
      }
      case "CompleteEvent":
        events.push({
          kind: "complete",
          data: {
            ...base,
            ts: tsMs(event.data.timestamp),
            mint: str(event.data.mint) ?? "",
            bondingCurve: str(event.data.bonding_curve) ?? "",
            user: str(event.data.user) ?? "",
          } satisfies CurveCompleted,
        });
        break;
      case "CompletePumpAmmMigrationEvent":
        events.push({
          kind: "migrate",
          data: {
            ...base,
            ts: tsMs(event.data.timestamp),
            mint: str(event.data.mint) ?? "",
            pool: str(event.data.pool) ?? "",
            solAmount: big(event.data.sol_amount),
            tokenAmount: big(event.data.mint_amount),
            poolMigrationFee: big(event.data.pool_migration_fee),
          } satisfies TokenMigrated,
        });
        break;
      case "CreatePoolEvent": {
        const p: PoolCreated = {
          ...base,
          ts: tsMs(event.data.timestamp),
          pool: str(event.data.pool) ?? "",
          baseMint: str(event.data.base_mint) ?? "",
          quoteMint: str(event.data.quote_mint) ?? "",
          baseDecimals: Number(event.data.base_mint_decimals ?? 6),
          quoteDecimals: Number(event.data.quote_mint_decimals ?? 9),
          baseAmount: big(event.data.pool_base_amount),
          quoteAmount: big(event.data.pool_quote_amount),
          coinCreator: str(event.data.coin_creator),
          creator: str(event.data.creator) ?? "",
          isMayhemMode: bool(event.data.is_mayhem_mode),
        };
        events.push({ kind: "pool", data: p });
        break;
      }
      case "BuyEvent":
      case "SellEvent": {
        const pool = str(event.data.pool);
        if (!pool) {
          skipped++;
          break;
        }
        const info = lookup(pool);
        if (!info) {
          unresolved.add(pool);
          break;
        }
        const t = toAmmTrade(event, index, info, base);
        if (t) events.push({ kind: "trade", data: t });
        else skipped++;
        break;
      }
      case "DepositEvent":
      case "WithdrawEvent": {
        const pool = str(event.data.pool) ?? "";
        const info = lookup(pool);
        const deposit = event.name === "DepositEvent";
        const baseAmt = big(deposit ? event.data.base_amount_in : event.data.base_amount_out);
        const quoteAmt = big(deposit ? event.data.quote_amount_in : event.data.quote_amount_out);
        const poolBase = big(event.data.pool_base_token_reserves);
        const poolQuote = big(event.data.pool_quote_token_reserves);
        const l: LiquidityChanged = {
          ...base,
          eventIndex: index,
          ts: tsMs(event.data.timestamp),
          pool,
          mint: info?.baseMint ?? null,
          kind: deposit ? "deposit" : "withdraw",
          user: str(event.data.user) ?? "",
          baseAmount: baseAmt,
          quoteAmount: quoteAmt,
          lpSupplyAfter: big(event.data.lp_mint_supply),
          poolBaseAfter: deposit ? poolBase + baseAmt : poolBase - baseAmt,
          poolQuoteAfter: deposit ? poolQuote + quoteAmt : poolQuote - quoteAmt,
        };
        events.push({ kind: "liquidity", data: l });
        break;
      }
      default:
        break;
    }
  }
  return { events, unresolvedPools: [...unresolved], skipped };
}

type Base = { signature: string; slot: number; availableAt: number; source: DataSource };

function toCreate(event: DecodedEvent, base: Base): TokenCreated {
  const d = event.data;
  const quoteMint = str(d.quote_mint);
  return {
    ...base,
    ts: tsMs(d.timestamp),
    mint: str(d.mint) ?? "",
    name: str(d.name) ?? "",
    symbol: str(d.symbol) ?? "",
    uri: str(d.uri) ?? "",
    creator: str(d.creator) ?? str(d.user) ?? "",
    user: str(d.user) ?? "",
    bondingCurve: str(d.bonding_curve) ?? "",
    tokenProgram: str(d.token_program),
    quoteMint: quoteMint === DEFAULT_PUBKEY ? null : quoteMint,
    isMayhemMode: bool(d.is_mayhem_mode),
    isCashback: bool(d.is_cashback_enabled),
    virtualSolReserves: big(d.virtual_sol_reserves),
    virtualTokenReserves: big(d.virtual_token_reserves),
    realTokenReserves: big(d.real_token_reserves),
    tokenTotalSupply: big(d.token_total_supply) || PUMP_TOKEN_TOTAL_SUPPLY,
  };
}

/** Bonding-curve trade. TradeEvent reserves are the curve state AFTER the trade. */
function toCurveTrade(event: DecodedEvent, index: number, base: Base): MarketTrade | null {
  const d = event.data;
  if (!isSolQuote(str(d.quote_mint))) return null;
  const solAmount = big(d.sol_amount);
  const tokenAmount = big(d.token_amount);
  if (solAmount <= 0n || tokenAmount <= 0n) return null;
  const vSol = big(d.virtual_sol_reserves);
  const vTok = big(d.virtual_token_reserves);
  const holderRewards = big(d.holder_rewards);
  const creatorFee = big(d.creator_fee);
  // Holder-reward coins report the creator fee in holder_rewards; avoid double counting.
  const fees =
    big(d.fee) + creatorFee + big(d.buyback_fee) + (holderRewards > 0n && holderRewards !== creatorFee ? holderRewards : 0n);
  const priceSol = curvePriceSol({ virtualSolReserves: vSol, virtualTokenReserves: vTok });
  return {
    ...base,
    eventIndex: index,
    ts: tsMs(d.timestamp),
    mint: str(d.mint) ?? "",
    venue: "pump_curve",
    pool: null,
    trader: str(d.user) ?? "",
    isBuy: bool(d.is_buy),
    solAmount,
    tokenAmount,
    feeLamports: fees,
    feeBps: feeBps(fees, solAmount),
    priceSol,
    marketCapSol: priceSol * (Number(PUMP_TOKEN_TOTAL_SUPPLY) / 10 ** PUMP_TOKEN_DECIMALS),
    virtualSolReserves: vSol,
    virtualTokenReserves: vTok,
    realSolReserves: big(d.real_sol_reserves),
    realTokenReserves: big(d.real_token_reserves),
    tokenDecimals: PUMP_TOKEN_DECIMALS,
    tokenSupply: PUMP_TOKEN_TOTAL_SUPPLY,
    ixName: str(d.ix_name),
    mayhemMode: bool(d.mayhem_mode),
  };
}

/**
 * PumpSwap trade. Event pool reserves are the state BEFORE the swap; we derive the post-trade state.
 * Only SOL-quoted pools are considered.
 */
function toAmmTrade(event: DecodedEvent, index: number, info: PoolInfo, base: Base): MarketTrade | null {
  if (info.quoteMint !== WSOL_MINT) return null;
  const d = event.data;
  const isBuy = event.name === "BuyEvent";
  const baseAmount = big(isBuy ? d.base_amount_out : d.base_amount_in);
  const quoteAmount = big(isBuy ? d.quote_amount_in : d.quote_amount_out);
  if (baseAmount <= 0n || quoteAmount <= 0n) return null;
  const virtualQuote = typeof d.virtual_quote_reserves === "bigint" ? d.virtual_quote_reserves : 0n;
  const poolBase = big(d.pool_base_token_reserves);
  const poolQuote = big(d.pool_quote_token_reserves);
  const quoteDeltaInPool = isBuy ? big(d.quote_amount_in_with_lp_fee) || quoteAmount : big(d.quote_amount_out_without_lp_fee) || quoteAmount;
  const baseAfter = isBuy ? poolBase - baseAmount : poolBase + baseAmount;
  const quoteAfter = (isBuy ? poolQuote + quoteDeltaInPool : poolQuote - quoteDeltaInPool) + virtualQuote;
  const fees = big(d.lp_fee) + big(d.protocol_fee) + big(d.coin_creator_fee) + big(d.buyback_fee);
  const supply = typeof d.base_supply === "bigint" && d.base_supply > 0n ? d.base_supply : null;
  const priceSol = poolPriceSol({ baseReserves: baseAfter, quoteReserves: quoteAfter, baseDecimals: info.baseDecimals, baseSupply: supply ?? 0n });
  return {
    ...base,
    eventIndex: index,
    ts: tsMs(d.timestamp),
    mint: info.baseMint,
    venue: "pump_amm",
    pool: info.pool,
    trader: str(d.user) ?? "",
    isBuy,
    solAmount: quoteAmount,
    tokenAmount: baseAmount,
    feeLamports: fees,
    feeBps: feeBps(fees, quoteAmount),
    priceSol,
    marketCapSol: supply ? priceSol * (Number(supply) / 10 ** info.baseDecimals) : null,
    virtualSolReserves: quoteAfter,
    virtualTokenReserves: baseAfter,
    realSolReserves: quoteAfter - virtualQuote,
    realTokenReserves: baseAfter,
    tokenDecimals: info.baseDecimals,
    tokenSupply: supply,
    ixName: str(d.ix_name),
    mayhemMode: false,
  };
}
