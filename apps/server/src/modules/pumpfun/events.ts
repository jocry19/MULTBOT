import { createHash } from "node:crypto";
import { BorshReader } from "./borsh.js";

/**
 * Schema-driven decoder for Pump.fun / PumpSwap Anchor events.
 *
 * Pump appends new fields to events over time. Decoding is therefore prefix-tolerant: the first
 * `required` fields must be present, later fields are decoded while bytes remain. Unknown trailing
 * bytes (a newer program version) are ignored and counted, so layout drift is visible in metrics.
 *
 * Field lists follow the published program interface (IDL) of
 *   pump      6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
 *   pump_amm  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
 */

export type FieldType =
  | "u8"
  | "u16"
  | "u64"
  | "i64"
  | "u128"
  | "i128"
  | "bool"
  | "string"
  | "pubkey"
  | "shareholders";

export interface EventSchema {
  name: string;
  program: "pump" | "pump_amm";
  fields: readonly (readonly [string, FieldType])[];
  /** Number of leading fields that must decode for the event to be valid. */
  required: number;
}

export type FieldValue = bigint | number | boolean | string | { address: string; shareBps: number }[];

export interface DecodedEvent {
  name: string;
  program: "pump" | "pump_amm";
  data: Record<string, FieldValue>;
  /** Bytes left over after the known fields (non-zero → program added fields we don't know yet). */
  unknownTrailingBytes: number;
}

const PUMP_EVENTS: EventSchema[] = [
  {
    name: "CreateEvent",
    program: "pump",
    required: 8,
    fields: [
      ["name", "string"],
      ["symbol", "string"],
      ["uri", "string"],
      ["mint", "pubkey"],
      ["bonding_curve", "pubkey"],
      ["user", "pubkey"],
      ["creator", "pubkey"],
      ["timestamp", "i64"],
      ["virtual_token_reserves", "u64"],
      ["virtual_sol_reserves", "u64"],
      ["real_token_reserves", "u64"],
      ["token_total_supply", "u64"],
      ["token_program", "pubkey"],
      ["is_mayhem_mode", "bool"],
      ["is_cashback_enabled", "bool"],
      ["quote_mint", "pubkey"],
      ["virtual_quote_reserves", "u64"],
      ["creator_fee_bps", "u64"],
      ["is_holder_reward", "bool"],
    ],
  },
  {
    name: "TradeEvent",
    program: "pump",
    required: 10,
    fields: [
      ["mint", "pubkey"],
      ["sol_amount", "u64"],
      ["token_amount", "u64"],
      ["is_buy", "bool"],
      ["user", "pubkey"],
      ["timestamp", "i64"],
      ["virtual_sol_reserves", "u64"],
      ["virtual_token_reserves", "u64"],
      ["real_sol_reserves", "u64"],
      ["real_token_reserves", "u64"],
      ["fee_recipient", "pubkey"],
      ["fee_basis_points", "u64"],
      ["fee", "u64"],
      ["creator", "pubkey"],
      ["creator_fee_basis_points", "u64"],
      ["creator_fee", "u64"],
      ["track_volume", "bool"],
      ["total_unclaimed_tokens", "u64"],
      ["total_claimed_tokens", "u64"],
      ["current_sol_volume", "u64"],
      ["last_update_timestamp", "i64"],
      ["ix_name", "string"],
      ["mayhem_mode", "bool"],
      ["cashback_fee_basis_points", "u64"],
      ["cashback", "u64"],
      ["buyback_fee_basis_points", "u64"],
      ["buyback_fee", "u64"],
      ["shareholders", "shareholders"],
      ["quote_mint", "pubkey"],
      ["quote_amount", "u64"],
      ["virtual_quote_reserves", "u64"],
      ["real_quote_reserves", "u64"],
      ["holder_rewards_bps", "u64"],
      ["holder_rewards", "u64"],
    ],
  },
  {
    name: "CompleteEvent",
    program: "pump",
    required: 4,
    fields: [
      ["user", "pubkey"],
      ["mint", "pubkey"],
      ["bonding_curve", "pubkey"],
      ["timestamp", "i64"],
      ["quote_mint", "pubkey"],
    ],
  },
  {
    name: "CompletePumpAmmMigrationEvent",
    program: "pump",
    required: 8,
    fields: [
      ["user", "pubkey"],
      ["mint", "pubkey"],
      ["mint_amount", "u64"],
      ["sol_amount", "u64"],
      ["pool_migration_fee", "u64"],
      ["bonding_curve", "pubkey"],
      ["timestamp", "i64"],
      ["pool", "pubkey"],
      ["quote_mint", "pubkey"],
    ],
  },
];

const AMM_EVENTS: EventSchema[] = [
  {
    name: "BuyEvent",
    program: "pump_amm",
    required: 16,
    fields: [
      ["timestamp", "i64"],
      ["base_amount_out", "u64"],
      ["max_quote_amount_in", "u64"],
      ["user_base_token_reserves", "u64"],
      ["user_quote_token_reserves", "u64"],
      ["pool_base_token_reserves", "u64"],
      ["pool_quote_token_reserves", "u64"],
      ["quote_amount_in", "u64"],
      ["lp_fee_basis_points", "u64"],
      ["lp_fee", "u64"],
      ["protocol_fee_basis_points", "u64"],
      ["protocol_fee", "u64"],
      ["quote_amount_in_with_lp_fee", "u64"],
      ["user_quote_amount_in", "u64"],
      ["pool", "pubkey"],
      ["user", "pubkey"],
      ["user_base_token_account", "pubkey"],
      ["user_quote_token_account", "pubkey"],
      ["protocol_fee_recipient", "pubkey"],
      ["protocol_fee_recipient_token_account", "pubkey"],
      ["coin_creator", "pubkey"],
      ["coin_creator_fee_basis_points", "u64"],
      ["coin_creator_fee", "u64"],
      ["track_volume", "bool"],
      ["total_unclaimed_tokens", "u64"],
      ["total_claimed_tokens", "u64"],
      ["current_sol_volume", "u64"],
      ["last_update_timestamp", "i64"],
      ["min_base_amount_out", "u64"],
      ["ix_name", "string"],
      ["cashback_fee_basis_points", "u64"],
      ["cashback", "u64"],
      ["buyback_fee_basis_points", "u64"],
      ["buyback_fee", "u64"],
      ["virtual_quote_reserves", "i128"],
      ["can_boost", "bool"],
      ["base_supply", "u64"],
      ["holder_rewards_bps", "u64"],
      ["holder_rewards", "u64"],
    ],
  },
  {
    name: "SellEvent",
    program: "pump_amm",
    required: 16,
    fields: [
      ["timestamp", "i64"],
      ["base_amount_in", "u64"],
      ["min_quote_amount_out", "u64"],
      ["user_base_token_reserves", "u64"],
      ["user_quote_token_reserves", "u64"],
      ["pool_base_token_reserves", "u64"],
      ["pool_quote_token_reserves", "u64"],
      ["quote_amount_out", "u64"],
      ["lp_fee_basis_points", "u64"],
      ["lp_fee", "u64"],
      ["protocol_fee_basis_points", "u64"],
      ["protocol_fee", "u64"],
      ["quote_amount_out_without_lp_fee", "u64"],
      ["user_quote_amount_out", "u64"],
      ["pool", "pubkey"],
      ["user", "pubkey"],
      ["user_base_token_account", "pubkey"],
      ["user_quote_token_account", "pubkey"],
      ["protocol_fee_recipient", "pubkey"],
      ["protocol_fee_recipient_token_account", "pubkey"],
      ["coin_creator", "pubkey"],
      ["coin_creator_fee_basis_points", "u64"],
      ["coin_creator_fee", "u64"],
      ["cashback_fee_basis_points", "u64"],
      ["cashback", "u64"],
      ["buyback_fee_basis_points", "u64"],
      ["buyback_fee", "u64"],
      ["virtual_quote_reserves", "i128"],
      ["can_boost", "bool"],
      ["base_supply", "u64"],
      ["holder_rewards_bps", "u64"],
      ["holder_rewards", "u64"],
    ],
  },
  {
    name: "CreatePoolEvent",
    program: "pump_amm",
    required: 16,
    fields: [
      ["timestamp", "i64"],
      ["index", "u16"],
      ["creator", "pubkey"],
      ["base_mint", "pubkey"],
      ["quote_mint", "pubkey"],
      ["base_mint_decimals", "u8"],
      ["quote_mint_decimals", "u8"],
      ["base_amount_in", "u64"],
      ["quote_amount_in", "u64"],
      ["pool_base_amount", "u64"],
      ["pool_quote_amount", "u64"],
      ["minimum_liquidity", "u64"],
      ["initial_liquidity", "u64"],
      ["lp_token_amount_out", "u64"],
      ["pool_bump", "u8"],
      ["pool", "pubkey"],
      ["lp_mint", "pubkey"],
      ["user_base_token_account", "pubkey"],
      ["user_quote_token_account", "pubkey"],
      ["coin_creator", "pubkey"],
      ["is_mayhem_mode", "bool"],
      ["creator_fee_bps", "u64"],
      ["can_edit_creator_fee", "bool"],
      ["is_holder_reward", "bool"],
    ],
  },
  {
    name: "DepositEvent",
    program: "pump_amm",
    required: 13,
    fields: [
      ["timestamp", "i64"],
      ["lp_token_amount_out", "u64"],
      ["max_base_amount_in", "u64"],
      ["max_quote_amount_in", "u64"],
      ["user_base_token_reserves", "u64"],
      ["user_quote_token_reserves", "u64"],
      ["pool_base_token_reserves", "u64"],
      ["pool_quote_token_reserves", "u64"],
      ["base_amount_in", "u64"],
      ["quote_amount_in", "u64"],
      ["lp_mint_supply", "u64"],
      ["pool", "pubkey"],
      ["user", "pubkey"],
      ["user_base_token_account", "pubkey"],
      ["user_quote_token_account", "pubkey"],
      ["user_pool_token_account", "pubkey"],
    ],
  },
  {
    name: "WithdrawEvent",
    program: "pump_amm",
    required: 13,
    fields: [
      ["timestamp", "i64"],
      ["lp_token_amount_in", "u64"],
      ["min_base_amount_out", "u64"],
      ["min_quote_amount_out", "u64"],
      ["user_base_token_reserves", "u64"],
      ["user_quote_token_reserves", "u64"],
      ["pool_base_token_reserves", "u64"],
      ["pool_quote_token_reserves", "u64"],
      ["base_amount_out", "u64"],
      ["quote_amount_out", "u64"],
      ["lp_mint_supply", "u64"],
      ["pool", "pubkey"],
      ["user", "pubkey"],
      ["user_base_token_account", "pubkey"],
      ["user_quote_token_account", "pubkey"],
      ["user_pool_token_account", "pubkey"],
    ],
  },
];

export function eventDiscriminator(name: string): Uint8Array {
  return createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);
}

const discriminatorIndex = new Map<string, EventSchema>();
for (const schema of [...PUMP_EVENTS, ...AMM_EVENTS]) {
  discriminatorIndex.set(`${schema.program}:${Buffer.from(eventDiscriminator(schema.name)).toString("hex")}`, schema);
}

export const EVENT_SCHEMAS: readonly EventSchema[] = [...PUMP_EVENTS, ...AMM_EVENTS];

function readField(r: BorshReader, type: FieldType): FieldValue {
  switch (type) {
    case "u8":
      return r.u8();
    case "u16":
      return r.u16();
    case "u64":
      return r.u64();
    case "i64":
      return r.i64();
    case "u128":
      return r.u128();
    case "i128":
      return r.i128();
    case "bool":
      return r.bool();
    case "string":
      return r.string();
    case "pubkey":
      return r.pubkey();
    case "shareholders":
      return r.vec((x) => ({ address: x.pubkey(), shareBps: x.u16() }), 64);
  }
}

export class EventDecodeError extends Error {
  constructor(
    message: string,
    readonly eventName?: string,
  ) {
    super(message);
    this.name = "EventDecodeError";
  }
}

/**
 * Decode an event payload (8-byte discriminator + borsh data).
 * Returns null if the discriminator is not a known event of `program` (e.g. other emitters).
 * Throws EventDecodeError if a known event is malformed.
 */
export function decodeEvent(program: "pump" | "pump_amm", payload: Uint8Array): DecodedEvent | null {
  if (payload.length < 8) return null;
  const key = `${program}:${Buffer.from(payload.subarray(0, 8)).toString("hex")}`;
  const schema = discriminatorIndex.get(key);
  if (!schema) return null;
  const r = new BorshReader(payload.subarray(8));
  const data: Record<string, FieldValue> = {};
  let decoded = 0;
  for (const [name, type] of schema.fields) {
    if (r.remaining === 0) break;
    const before = r.position;
    try {
      data[name] = readField(r, type);
      decoded++;
    } catch (err) {
      if (decoded < schema.required) {
        throw new EventDecodeError(`${schema.name}: field ${name} at ${before}: ${(err as Error).message}`, schema.name);
      }
      // trailing field of a different layout version — stop here
      break;
    }
  }
  if (decoded < schema.required) {
    throw new EventDecodeError(`${schema.name}: only ${decoded}/${schema.required} required fields present`, schema.name);
  }
  return { name: schema.name, program: schema.program, data, unknownTrailingBytes: r.remaining };
}
